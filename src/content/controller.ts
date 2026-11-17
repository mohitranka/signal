import { decide } from '../policy';
import type { FeedAdapter } from '../adapter/linkedin';
import { fingerprint, prepareInput } from '../shared/post';
import type {
  BackgroundMessage,
  ClassificationRecord,
  ClassifyResult,
  ErrorKind,
  PageStats,
  PostInput,
  PublicSettings,
  StateResponse,
  Verdict,
} from '../shared/types';
import { Presenter, isCollapsedView, isHighlightedView, type View } from './presenter';

export interface ControllerDeps {
  doc: Document;
  adapter: FeedAdapter;
  presenter: Presenter;
  send: (msg: BackgroundMessage) => Promise<any>;
  /** Injectable for tests; defaults to IntersectionObserver with a generous look-ahead margin. */
  observeVisible?: (cb: (el: HTMLElement) => void) => { observe(el: HTMLElement): void; unobserve(el: HTMLElement): void; disconnect(): void };
  scanDebounceMs?: number;
  /** Wait this long after the last change inside a post before checking whether its text grew (default 400 ms). */
  growthSettleMs?: number;
  /** Accept only real user clicks as "the user expanded this post". Injectable for jsdom (default: e.isTrusted). */
  isTrustedClick?: (e: Event) => boolean;
  /** Clock (injectable for tests). */
  now?: () => number;
  /** Route gate: Signal only ever acts on the main feed. */
  shouldRun?: () => boolean;
}

interface PostState {
  id: string | null;
  status: 'new' | 'pending' | 'done' | 'failed' | 'skipped';
  fp?: string;
  input?: PostInput;
  /**
   * Fingerprint of the text this post was first seen with. Marks (feedback) are saved and looked up under it, so a
   * mark survives the text growing ("…more") and a reload, when the post is cut off again.
   */
  markFp?: string;
  /** The classification shown for this post, with the model and prompt version that produced it. */
  record?: ClassificationRecord;
  revealed: boolean;
  /** The user expanded this post to read it, so a model verdict must not hide it (Active mode). */
  keepVisible?: boolean;
  /** When the user last clicked inside the post (trusted clicks only). */
  clickedAt?: number;
  /** How many times this post has been re-judged after its text grew (capped). */
  rejudged?: number;
  /** "Judge separately" is under way for this fingerprint (the post shows a copied verdict until the answer arrives). */
  judging?: string;
  visible: boolean;
}

/** Total length of everything sent to the model; "the text grew" means this got larger. */
const inputLength = (i: PostInput): number =>
  i.text.length + (i.quoted?.length ?? 0) + (i.linkTitle?.length ?? 0) + (i.linkDescription?.length ?? 0);

/** A growth only counts as "the user expanded it" if they clicked inside the (visible) post this recently. */
const USER_EXPAND_WINDOW_MS = 10_000;
/** Re-judgements per post per page load: a real expansion needs 1 (2 if text arrives after settling). */
const MAX_REJUDGEMENTS = 3;

// Errors that will fail identically for every post until the user changes settings.
const BLOCKING: ReadonlySet<ErrorKind> = new Set(['config', 'auth']);

export class FeedController {
  private settings: PublicSettings | null = null;
  private feedback = new Map<string, Verdict>();
  private posts = new Map<HTMLElement, PostState>();
  private classified = new Map<string, ClassificationRecord>();
  private inflight = new Map<string, Promise<ClassifyResult>>();
  private observer: MutationObserver | null = null;
  private visibility: ReturnType<NonNullable<ControllerDeps['observeVisible']>> | null = null;
  private scanTimer: ReturnType<typeof setTimeout> | null = null;
  /** Per-post settle timers: a post's text is re-checked once it has stopped changing. */
  private growTimers = new Map<HTMLElement, ReturnType<typeof setTimeout>>();
  private epoch = 0;
  private blocked = false;
  private running = false;
  private llmKey = '';

  constructor(private d: ControllerDeps) {}

  async start(): Promise<void> {
    if (this.running || this.d.shouldRun?.() === false) return;
    await this.refreshState();
    if (!this.settings?.enabled) return;
    this.running = true;
    const make = this.d.observeVisible ?? defaultObserveVisible;
    this.visibility = make((el) => this.onVisible(el));
    this.d.doc.addEventListener('click', this.onClick, true);
    this.observer = new MutationObserver((records) => this.onMutations(records));
    // characterData too: LinkedIn may reveal "…more" text by editing a text node in place.
    this.observer.observe(this.d.doc.body, { childList: true, subtree: true, characterData: true });
    this.scan();
  }

  /** Stop observing, cancel in-flight work, and restore the original feed. */
  stop(): void {
    this.running = false;
    this.epoch++;
    this.d.doc.removeEventListener('click', this.onClick, true);
    this.observer?.disconnect();
    this.observer = null;
    this.visibility?.disconnect();
    this.visibility = null;
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.scanTimer = null;
    for (const t of this.growTimers.values()) clearTimeout(t);
    this.growTimers.clear();
    for (const el of this.posts.keys()) this.d.presenter.clear(el);
    this.d.presenter.prune();
    this.posts.clear();
    void this.d.send({ type: 'cancelAll' }).catch(() => {});
  }

  /** Settings or feedback changed elsewhere (popup). Re-render from cached verdicts; re-request only if the LLM changed. */
  async onSettingsChanged(): Promise<void> {
    const before = this.llmKey;
    const wasRunning = this.running;
    await this.refreshState();
    if (!this.settings?.enabled) {
      if (wasRunning) this.stop();
      return;
    }
    if (!wasRunning) return void (await this.start());
    if (this.d.shouldRun?.() === false) return void this.stop();
    this.blocked = false;
    if (before !== this.llmKey) {
      this.classified.clear();
      this.inflight.clear();
      this.epoch++;
      for (const [el, st] of this.posts) {
        if (st.status === 'done' || st.status === 'pending' || st.status === 'failed') {
          this.resetState(el, st, { samePost: true });
        }
      }
    }
    this.renderAll();
    this.retryPending();
  }

  pageStats(): PageStats {
    let classified = 0,
      collapsed = 0,
      highlighted = 0,
      failed = 0;
    for (const st of this.posts.values()) {
      if (st.status === 'failed') failed++;
      const v = this.viewFor(st);
      if (st.status !== 'done' || !v) continue;
      classified++;
      // Count what is actually on screen: not posts you revealed or expanded, nor Review-mode annotations.
      if (isCollapsedView(v)) collapsed++;
      if (isHighlightedView(v)) highlighted++;
    }
    return { tracked: this.posts.size, classified, collapsed, highlighted, failed };
  }

  // ---- scanning -----------------------------------------------------------------------------

  /** Remember real user clicks inside a post ("…more"): only those make a growth count as "the user is reading it". */
  private onClick = (e: Event): void => {
    if (!(this.d.isTrustedClick ?? ((x: Event) => x.isTrusted))(e)) return; // page scripts cannot fake these
    for (let n = e.target as Node | null; n; n = n.parentNode) {
      const st = n.nodeType === 1 ? this.posts.get(n as HTMLElement) : undefined;
      if (st) {
        st.clickedAt = this.now();
        return;
      }
    }
  };

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  /** New/removed posts are found by the (debounced) scan; changes inside a tracked post may mean its text grew. */
  private onMutations(records: MutationRecord[]): void {
    this.scheduleScan();
    const touched = new Set<HTMLElement>();
    for (const r of records) {
      // Most changes (timestamps, reaction counts, comments) cannot alter a post's text: drop them cheaply first.
      if (!this.d.adapter.isPostTextChange(r)) continue;
      for (let n: Node | null = r.target; n; n = n.parentNode) {
        if (n.nodeType === 1 && this.posts.has(n as HTMLElement)) {
          touched.add(n as HTMLElement);
          break;
        }
      }
    }
    for (const el of touched) this.scheduleGrowthCheck(el);
  }

  private scheduleGrowthCheck(el: HTMLElement): void {
    const st = this.posts.get(el);
    if (!st || !(st.status === 'pending' || st.status === 'done' || st.status === 'skipped')) return;
    const prev = this.growTimers.get(el);
    if (prev) clearTimeout(prev);
    this.growTimers.set(
      el,
      setTimeout(() => {
        this.growTimers.delete(el);
        void this.checkGrowth(el);
      }, this.d.growthSettleMs ?? 400),
    );
  }

  /**
   * Re-judge a post whose extracted text grew ("…more"). Unchanged or shorter text ("…see less") changes nothing;
   * marked posts are governed by the mark and are not re-judged. The longer text is classified once; the request for
   * the old text is cancelled when nothing else waits for it, and its result is dropped if it still arrives.
   */
  private async checkGrowth(el: HTMLElement): Promise<void> {
    const st = this.posts.get(el);
    if (!st || !this.running) return;
    if (!(st.status === 'pending' || st.status === 'done' || st.status === 'skipped')) return;
    if (st.status === 'pending' && !st.fp) return this.scheduleGrowthCheck(el); // first look still in progress: retry
    const extracted = this.d.adapter.extract(el);
    if (!extracted) return;
    const input = prepareInput(extracted.input);
    if (st.input && inputLength(input) <= inputLength(st.input)) return; // unchanged or shorter
    if (st.markFp && this.feedback.has(st.markFp)) return; // your mark stands
    if ((st.rejudged ?? 0) >= MAX_REJUDGEMENTS) return; // the latest verdict stands: no unbounded LLM calls

    // "You are reading it" only if the post was visible when it grew and you clicked inside it just before:
    // not a page script, and not LinkedIn loading text into a post you cannot even see.
    const view = this.viewFor(st);
    const reading =
      !(view && isCollapsedView(view)) && st.clickedAt !== undefined && this.now() - st.clickedAt <= USER_EXPAND_WINDOW_MS;
    const epoch = this.epoch;
    const before = { status: st.status, fp: st.fp };
    // A post showing its own model verdict is re-judged by the model, never given a copy from a similar post.
    const ownVerdict = !!st.record && !st.record.repeatOf;
    st.status = 'pending'; // grew: busy from here
    const fp = await fingerprint(input);
    if (!this.stillCurrent(el, st, epoch)) return;
    if (fp === st.fp) {
      st.status = before.status; // longer only in ways the fingerprint ignores (case, spacing)
      return;
    }
    if (before.status === 'pending' && before.fp && !this.othersWaitingFor(before.fp, el)) {
      void this.d.send({ type: 'cancel', fp: before.fp }).catch(() => {});
    }
    st.fp = fp;
    st.markFp ??= fp;
    st.input = input;
    st.rejudged = (st.rejudged ?? 0) + 1;
    if (reading) st.keepVisible = true; // the user is reading it: a model verdict must not hide it
    await this.classifyCurrent(el, st, fp, input, epoch, { noRepeat: ownVerdict });
  }

  /** Is another post on this page still waiting for the classification of this text? */
  private othersWaitingFor(fp: string, except: HTMLElement): boolean {
    for (const [el, st] of this.posts) if (el !== except && st.fp === fp && st.status === 'pending') return true;
    return false;
  }

  private scheduleScan(): void {
    if (this.scanTimer) return;
    this.scanTimer = setTimeout(() => {
      this.scanTimer = null;
      this.scan();
    }, this.d.scanDebounceMs ?? 250);
  }

  scan(): void {
    if (!this.running) return;
    for (const el of this.d.adapter.findPosts(this.d.doc)) {
      const st = this.posts.get(el);
      if (!st) {
        this.posts.set(el, { id: this.d.adapter.postId(el), status: 'new', revealed: false, visible: false });
        this.visibility?.observe(el);
        continue;
      }
      // LinkedIn can recycle a DOM node for a different post.
      const id = this.d.adapter.postId(el);
      if (id !== null && st.id !== null && id !== st.id) {
        this.resetState(el, st);
        st.id = id;
        if (st.visible) void this.process(el);
      }
    }
    for (const el of Array.from(this.posts.keys())) {
      if (!el.isConnected) {
        this.visibility?.unobserve(el);
        clearTimeout(this.growTimers.get(el));
        this.growTimers.delete(el);
        this.posts.delete(el);
      }
    }
    this.d.presenter.prune();
  }

  /** Forget the post's classification. `samePost` (LLM changed): keep what identifies the post, i.e. its mark key. */
  private resetState(el: HTMLElement, st: PostState, opts: { samePost?: boolean } = {}): void {
    this.d.presenter.clear(el);
    st.status = 'new';
    if (!opts.samePost) {
      delete st.markFp;
      delete st.clickedAt;
      delete st.rejudged;
    }
    delete st.fp;
    delete st.input;
    delete st.record;
    delete st.judging;
    st.revealed = false;
    delete st.keepVisible;
  }

  private onVisible(el: HTMLElement): void {
    const st = this.posts.get(el);
    if (!st) return;
    st.visible = true;
    if (st.status === 'new') void this.process(el);
  }

  private retryPending(): void {
    for (const [el, st] of this.posts) {
      if (st.visible && (st.status === 'new' || st.status === 'failed')) {
        st.status = 'new';
        void this.process(el);
      }
    }
  }

  // ---- classification -----------------------------------------------------------------------

  private async process(el: HTMLElement): Promise<void> {
    const st = this.posts.get(el);
    if (!st || st.status !== 'new' || !this.running) return;
    const extracted = this.d.adapter.extract(el);
    if (!extracted) {
      st.status = 'skipped';
      return;
    }
    const epoch = this.epoch;
    st.status = 'pending';
    st.id = extracted.id ?? st.id;
    const input = prepareInput(extracted.input);
    const fp = await fingerprint(input);
    if (!this.stillCurrent(el, st, epoch)) return;
    st.fp = fp;
    st.markFp ??= fp;
    st.input = input;

    if (this.feedback.has(st.markFp)) {
      // Marked: the user's verdict governs; no need to ask the model.
      const known = this.classified.get(fp);
      if (known) st.record = known;
      st.status = 'done';
      this.render(el);
      return;
    }
    await this.classifyCurrent(el, st, fp, input, epoch);
  }

  /**
   * Classify the post's current text (first time, or after it grew). A verdict already known for this text, or a
   * request already in flight for it, is reused. A result that arrives after the post's text moved on is dropped.
   * Fails open: on any error, or while requests are paused, the post is left as LinkedIn drew it.
   */
  private async classifyCurrent(
    el: HTMLElement,
    st: PostState,
    fp: string,
    input: PostInput,
    epoch: number,
    opts: { noRepeat?: boolean } = {},
  ): Promise<void> {
    const noRepeat = opts.noRepeat === true;
    const known = this.classified.get(fp);
    if (known && !(noRepeat && known.repeatOf)) {
      st.record = known;
      st.status = 'done';
      this.render(el);
      return;
    }
    if (this.blocked) {
      delete st.record; // a stale (cut-off) verdict must not stay on screen
      st.status = 'new'; // retried when settings change
      this.render(el);
      return;
    }

    const result = await this.request(fp, input, noRepeat);
    if (!this.stillCurrent(el, st, epoch) || st.fp !== fp) return; // the text moved on: drop this result

    if (result && result.ok) {
      const record = toRecord(result);
      this.classified.set(fp, record);
      st.record = record;
      st.status = 'done';
      this.render(el);
      this.renderDuplicates(fp, el);
    } else {
      // Fail open: the post stays as LinkedIn rendered it (and loses any verdict for an earlier, shorter text).
      delete st.record;
      st.status = 'failed';
      this.render(el);
      if (result && !result.ok && BLOCKING.has(result.kind)) this.blocked = true;
    }
  }

  /**
   * One classify request per text on this page. A request that must not be answered with a copy (noRepeat) is kept
   * apart from an ordinary one for the same text, so it can neither join nor be joined by it.
   */
  private request(fp: string, input: PostInput, noRepeat: boolean): Promise<ClassifyResult> {
    const key = noRepeat ? `own:${fp}` : fp;
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.d
        .send({ type: 'classify', fp, input, ...(noRepeat ? { noRepeat: true } : {}) })
        .then((r) => r as ClassifyResult)
        .catch((): ClassifyResult => ({ ok: false, kind: 'network', message: 'Background unavailable.' }))
        .finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    return pending;
  }

  /**
   * "Judge separately": ask the model about this post itself instead of using the verdict copied from a similar post.
   * The copied verdict stays on screen until the answer arrives. Revealed / being-read state is kept, so the new verdict
   * never hides the post behind your back. Identical posts showing the same copied verdict get the answer too. On
   * failure the post is left as LinkedIn drew it.
   */
  private async judgeSeparately(el: HTMLElement): Promise<void> {
    const st = this.posts.get(el);
    if (!st || !this.running || st.status !== 'done' || !st.fp || !st.input || !st.record?.repeatOf) return;
    if (st.judging === st.fp || (st.markFp && this.feedback.has(st.markFp))) return;
    const { fp, input } = st;
    const epoch = this.epoch;
    st.judging = fp;
    this.render(el);
    const result = await this.request(fp, input, true);
    if (!this.stillCurrent(el, st, epoch) || st.fp !== fp) return; // the text moved on: its own classification governs
    delete st.judging;
    if (result && result.ok) {
      const record = toRecord(result);
      this.classified.set(fp, record);
      for (const [other, s] of this.posts) {
        if (other === el || (s.fp === fp && s.record?.repeatOf)) {
          s.record = record;
          this.render(other);
        }
      }
    } else {
      delete st.record; // fail open
      this.render(el);
      if (result && !result.ok && BLOCKING.has(result.kind)) this.blocked = true;
    }
  }

  private stillCurrent(el: HTMLElement, st: PostState, epoch: number): boolean {
    return this.running && epoch === this.epoch && el.isConnected && this.posts.get(el) === st;
  }

  // ---- presentation -------------------------------------------------------------------------

  private viewFor(st: PostState): View | null {
    if (!this.settings) return null;
    const review = this.settings.mode === 'review';
    const verdict = st.markFp ? this.feedback.get(st.markFp) : undefined;
    if (verdict) {
      return {
        outcome: verdict === 'keep' ? 'keep' : 'collapse',
        source: 'user',
        reason: verdict === 'keep' ? 'You marked this worth keeping.' : 'You marked this low quality.',
        review,
        revealed: st.revealed,
      };
    }
    const c = st.record?.classification;
    if (!c) return null;
    const r = decide(c, { sensitivity: this.settings.sensitivity, highlightEnabled: this.settings.highlight });
    // A model verdict never hides a post you revealed, or (Active mode) expanded to read. That only matters when the
    // verdict is collapse: otherwise there is nothing to keep visible, and no "Collapsed by Signal" bar.
    // Only in Active mode: Review mode hides nothing by itself, so it shows its normal annotation (the flags are kept,
    // so switching back to Active does not hide the post behind your back).
    const visibleBecause = review ? undefined : st.revealed ? 'revealed' : st.keepVisible ? 'expanded' : undefined;
    const keptVisible = r.outcome === 'collapse' && visibleBecause !== undefined;
    const copied = st.record?.repeatOf;
    return {
      outcome: r.outcome,
      source: 'model',
      reason: r.reason,
      modelDecision: r.modelDecision,
      confidence: c.confidence,
      review,
      revealed: keptVisible,
      ...(keptVisible ? { visibleBecause } : {}),
      ...(copied ? { repeat: { similarity: copied.similarity, judging: st.judging === st.fp } } : {}),
    };
  }

  private render(el: HTMLElement): void {
    const st = this.posts.get(el);
    if (!st) return;
    const view = this.viewFor(st);
    const quiet = view && !view.review && view.source === 'model' && view.outcome === 'keep';
    this.d.presenter.apply(el, quiet ? null : view, {
      show: () => this.setRevealed(el, true),
      hide: () => this.setRevealed(el, false),
      keep: () => this.giveFeedback(el, 'keep'),
      lowQuality: () => this.giveFeedback(el, 'collapse'),
      undo: () => this.giveFeedback(el, null),
      judgeSeparately: () => void this.judgeSeparately(el),
    });
  }

  private renderAll(): void {
    for (const [el, st] of this.posts) if (st.status === 'done') this.render(el);
  }

  private renderDuplicates(fp: string, except: HTMLElement): void {
    for (const [el, st] of this.posts) {
      if (el !== except && st.fp === fp && st.status !== 'done') {
        st.record = this.classified.get(fp);
        st.status = 'done';
        this.render(el);
      }
    }
  }

  private setRevealed(el: HTMLElement, revealed: boolean): void {
    const st = this.posts.get(el);
    if (!st) return;
    st.revealed = revealed;
    if (!revealed) delete st.keepVisible; // "Hide" / "Hide again": the user wants it out of the way
    this.render(el);
  }

  private giveFeedback(el: HTMLElement, verdict: Verdict | null): void {
    const st = this.posts.get(el);
    if (!st?.fp || !st.input) return;
    const fp = st.markFp ?? st.fp;
    const previous = this.feedback.get(fp) ?? null;
    this.applyOverride(fp, verdict);
    const rec = verdict === null ? undefined : st.record;
    void this.d
      .send({
        type: 'setFeedback',
        fp,
        verdict,
        sample: st.input.text,
        ...(rec ? { modelDecision: rec.classification.decision, modelConfidence: rec.classification.confidence, classified: rec } : {}),
      })
      .then((r) => {
        // Not saved (feedback is full): do not show an override that will vanish on reload.
        if ((r as { error?: string } | undefined)?.error === 'feedback-full' && this.feedback.get(fp) === (verdict ?? undefined)) {
          this.applyOverride(fp, previous);
        }
      })
      .catch(() => {});
  }

  /** Set or clear a local override and re-render every post with this content (reshares follow immediately). */
  private applyOverride(fp: string, verdict: Verdict | null): void {
    if (verdict === null) this.feedback.delete(fp);
    else this.feedback.set(fp, verdict);
    for (const [other, s] of this.posts) {
      if ((s.markFp ?? s.fp) === fp) {
        s.revealed = false;
        this.render(other);
      }
    }
  }

  private async refreshState(): Promise<void> {
    try {
      const state = (await this.d.send({ type: 'getState' })) as StateResponse;
      if (state?.settings) {
        this.settings = state.settings;
        this.feedback = new Map(Object.entries(state.feedback ?? {}));
        const s = state.settings;
        this.llmKey = `${s.endpoint}|${s.model}|${s.hasApiKey}`;
      }
    } catch {
      /* background asleep or reloading: keep previous state; feed stays untouched */
    }
  }
}

/** What the page keeps about a classification: the verdict, what produced it, and whether it was copied. */
function toRecord(r: Extract<ClassifyResult, { ok: true }>): ClassificationRecord {
  return {
    classification: r.classification,
    model: r.model,
    promptVersion: r.promptVersion,
    ...(r.repeatOf ? { repeatOf: r.repeatOf } : {}),
  };
}

function defaultObserveVisible(cb: (el: HTMLElement) => void) {
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) if (e.isIntersecting) cb(e.target as HTMLElement);
    },
    // Classify a screen or two ahead so verdicts land before the post is on screen (less layout shift).
    { rootMargin: '1500px 0px' },
  );
  return {
    observe: (el: HTMLElement) => io.observe(el),
    unobserve: (el: HTMLElement) => io.unobserve(el),
    disconnect: () => io.disconnect(),
  };
}

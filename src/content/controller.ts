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
import { Presenter, type View } from './presenter';

export interface ControllerDeps {
  doc: Document;
  adapter: FeedAdapter;
  presenter: Presenter;
  send: (msg: BackgroundMessage) => Promise<any>;
  /** Injectable for tests; defaults to IntersectionObserver with a generous look-ahead margin. */
  observeVisible?: (cb: (el: HTMLElement) => void) => { observe(el: HTMLElement): void; unobserve(el: HTMLElement): void; disconnect(): void };
  scanDebounceMs?: number;
  /** Route gate: Signal only ever acts on the main feed. */
  shouldRun?: () => boolean;
}

interface PostState {
  id: string | null;
  status: 'new' | 'pending' | 'done' | 'failed' | 'skipped';
  fp?: string;
  input?: PostInput;
  /** The classification shown for this post, with the model and prompt version that produced it. */
  record?: ClassificationRecord;
  revealed: boolean;
  visible: boolean;
}

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
    this.observer = new MutationObserver(() => this.scheduleScan());
    this.observer.observe(this.d.doc.body, { childList: true, subtree: true });
    this.scan();
  }

  /** Stop observing, cancel in-flight work, and restore the original feed. */
  stop(): void {
    this.running = false;
    this.epoch++;
    this.observer?.disconnect();
    this.observer = null;
    this.visibility?.disconnect();
    this.visibility = null;
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.scanTimer = null;
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
          this.resetState(el, st);
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
      if (v.outcome === 'collapse' && (v.source === 'user' || !v.review)) collapsed++;
      if (v.outcome === 'highlight') highlighted++;
    }
    return { tracked: this.posts.size, classified, collapsed, highlighted, failed };
  }

  // ---- scanning -----------------------------------------------------------------------------

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
        this.posts.delete(el);
      }
    }
    this.d.presenter.prune();
  }

  private resetState(el: HTMLElement, st: PostState): void {
    this.d.presenter.clear(el);
    st.status = 'new';
    delete st.fp;
    delete st.input;
    delete st.record;
    st.revealed = false;
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
    st.input = input;

    const known = this.classified.get(fp);
    if (known || this.feedback.has(fp)) {
      if (known) st.record = known;
      st.status = 'done';
      this.render(el);
      return;
    }
    if (this.blocked) {
      st.status = 'new'; // retried when settings change
      return;
    }

    let pendingResult = this.inflight.get(fp);
    if (!pendingResult) {
      pendingResult = this.d
        .send({ type: 'classify', fp, input })
        .then((r) => r as ClassifyResult)
        .catch((): ClassifyResult => ({ ok: false, kind: 'network', message: 'Background unavailable.' }))
        .finally(() => this.inflight.delete(fp));
      this.inflight.set(fp, pendingResult);
    }
    const result = await pendingResult;
    if (!this.stillCurrent(el, st, epoch) || st.fp !== fp) return;

    if (result && result.ok) {
      const record: ClassificationRecord = { classification: result.classification, model: result.model, promptVersion: result.promptVersion };
      this.classified.set(fp, record);
      st.record = record;
      st.status = 'done';
      this.render(el);
      this.renderDuplicates(fp, el);
    } else {
      // Fail open: the post simply stays as LinkedIn rendered it.
      st.status = 'failed';
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
    const verdict = st.fp ? this.feedback.get(st.fp) : undefined;
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
    return {
      outcome: r.outcome,
      source: 'model',
      reason: r.reason,
      modelDecision: r.modelDecision,
      confidence: c.confidence,
      review,
      revealed: st.revealed,
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
    this.render(el);
  }

  private giveFeedback(el: HTMLElement, verdict: Verdict | null): void {
    const st = this.posts.get(el);
    if (!st?.fp || !st.input) return;
    const fp = st.fp;
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
      if (s.fp === fp) {
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

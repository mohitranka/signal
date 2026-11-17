import { ClassifierError, classifyPost, type ClientDeps } from '../classifier/client';
import { PROMPT_VERSION } from '../classifier/prompt';
import { AbortedError, TaskQueue } from '../classifier/queue';
import { configProblem } from '../shared/settings';
import { REPEAT_THRESHOLD, signature, similarity, type Signature } from '../shared/similarity';
import type { Classification, ClassifyResult, PostInput, RepeatOf, Settings } from '../shared/types';
import type { RepeatIndex } from './repeatIndex';
import type { CacheStore, StatsStore } from './store';

export interface ServiceDeps {
  loadSettings: () => Promise<Settings>;
  cache: CacheStore;
  stats: StatsStore;
  /** Signatures of judged posts, for recognising repeated templates. Without it, only exact repeats are reused. */
  repeats?: RepeatIndex;
  http?: Pick<ClientDeps, 'fetchImpl' | 'sleep' | 'maxRetries'>;
}

export interface ClassifyOptions {
  /** Judge this post on its own: never copy a verdict from a similar post ("Judge separately", re-judging). */
  noRepeat?: boolean;
  /**
   * Finding I: the cancel ticket taken when the request arrived (the message handler awaits a fingerprint check before
   * calling classify; a cancel during that check must still reach this request). Default: taken at the start.
   */
  ticket?: Ticket;
}

/** A request that has a signature and has not finished: a similar request may wait for its model verdict. */
interface InFlight {
  seq: number;
  key: string;
  scope: string;
  fp: string;
  sig: Signature;
  /** Waiting for another request (not calling the model itself): nobody may wait for it. */
  joined: boolean;
  /** Resolves with the model's verdict for this post, or null if it got none (copied, failed, cancelled). */
  settled: Promise<Classification | null>;
  settle: (c: Classification | null) => void;
}

type Copy = { classification: Classification; repeatOf: RepeatOf };

/**
 * What a request remembers when it starts: the global cancel generation (finding A) and its tab's own (security S7).
 * "Stale" if either has moved on since.
 */
export interface Ticket {
  gen: number;
  waiter: string;
  wgen: number;
}

const round2 = (x: number) => Math.round(x * 100) / 100;

const ABORTED: ClassifyResult = { ok: false, kind: 'aborted', message: 'Cancelled.' };

/** Orchestrates cache lookup, request dedup/queueing, the HTTP client, and statistics. */
export class ClassifyService {
  private queue = new TaskQueue();
  /** For each request in the queue: which senders are waiting for it, and how many times. */
  private interest = new Map<string, Map<string, number>>();
  /** Requests with a signature that have not finished, in arrival order (see InFlight). */
  private inFlight = new Set<InFlight>();
  private seq = 0;
  /** Requests waiting for a similar request's verdict: key -> sender -> one abort per wait, so cancel ends only its own. */
  private joins = new Map<string, Map<string, AbortController[]>>();
  /**
   * Bumped by cancelAll(). A request remembers the generation it started in and is refused (aborted) wherever it would
   * call the model, hand out a copy or store a result once that has changed: it may have read settings the user has
   * since replaced (docs/design-finding-a-cancel-all.md).
   */
  private generation = 0;
  /** Per-tab cancel generations (security S7): a tab's "cancel all" makes only its own requests stale. */
  private waiterGens = new Map<string, number>();
  /**
   * Active holds (docs/design-finding-a2-save-window.md): while a save of the model, endpoint or key is being written,
   * no model call starts and no copy is handed out. Counted, so overlapping saves hold until the last one is done.
   */
  private holds = 0;
  private holdsEnded: Promise<void> = Promise.resolve();
  private endHolds: (() => void) | null = null;
  /** Work currently waiting for the holds to end (observable in tests). */
  private waitingOnHold = 0;

  constructor(private deps: ServiceDeps) {}

  /**
   * Stop model calls from starting (and copies from being handed out) until the returned release is called.
   * Calls already running are not paused. The release is idempotent: calling it twice never ends another holder's hold.
   */
  hold(): () => void {
    if (this.holds++ === 0) this.holdsEnded = new Promise<void>((r) => (this.endHolds = r));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--this.holds === 0) {
        const end = this.endHolds;
        this.endHolds = null;
        end?.();
      }
    };
  }

  /** Wait until no hold is active (again, if a new hold began before this waiter resumed). */
  private async afterHolds(): Promise<void> {
    while (this.holds > 0) {
      this.waitingOnHold++;
      try {
        await this.holdsEnded;
      } finally {
        this.waitingOnHold--;
      }
    }
  }

  /** Global cancel: Clear cache, or a model, endpoint or key change. Everything in flight, for every tab, is obsolete. */
  cancelAll(): void {
    this.generation++;
    this.waiterGens.clear(); // everything is stale under the new global generation anyway
    for (const bySender of this.joins.values()) for (const ctrls of bySender.values()) for (const c of ctrls) c.abort();
    this.queue.cancelAll();
  }

  /**
   * One tab's "cancel all" (it left the feed, or Signal was switched off there): only that tab's work is cancelled
   * (security S7). Its interest in every queued or running request is released, so a request is dropped or aborted only
   * when no other tab waits for it; its waits for similar requests end; its requests still being prepared are refused.
   */
  cancelWaiter(waiter: string): void {
    this.waiterGens.set(waiter, (this.waiterGens.get(waiter) ?? 0) + 1);
    for (const bySender of this.joins.values()) for (const c of bySender.get(waiter) ?? []) c.abort();
    for (const [key, waiting] of this.interest) {
      const n = waiting.get(waiter) ?? 0;
      if (!n) continue;
      waiting.delete(waiter);
      for (let i = 0; i < n; i++) this.queue.release(key);
    }
  }

  /** The cancel generations as of now (finding A, S7). Take it when a request arrives, before any await. */
  ticket(waiter: string): Ticket {
    return { gen: this.generation, waiter, wgen: this.waiterGens.get(waiter) ?? 0 };
  }

  /** A global cancel happened since the ticket was taken: settings may have been replaced. */
  private staleGlobally(t: Ticket): boolean {
    return t.gen !== this.generation;
  }

  /** A global cancel, or a cancel by the ticket's own tab, happened since it was taken. */
  private stale(t: Ticket): boolean {
    return this.staleGlobally(t) || (this.waiterGens.get(t.waiter) ?? 0) !== t.wgen;
  }

  /**
   * `waiter` no longer needs this post's request. Only its own interest is released, once (repeats and requests it
   * never asked for are ignored); the request is dropped or aborted only when no sender waits for it any more.
   */
  async cancel(fp: string, waiter = 'unknown'): Promise<void> {
    const settings = await this.deps.loadSettings();
    const key = `${PROMPT_VERSION}|${settings.model}|${fp}`;
    // A request waiting for a similar request's verdict: end only this sender's wait, never the other request.
    const joined = this.joins.get(key)?.get(waiter);
    if (joined?.length) return void joined.shift()!.abort();
    const waiting = this.interest.get(key);
    const n = waiting?.get(waiter) ?? 0;
    if (!waiting || n === 0) return;
    if (n === 1) waiting.delete(waiter);
    else waiting.set(waiter, n - 1);
    this.queue.release(key);
  }

  /**
   * Exact cache → copy from a similar post the model judged → wait for a similar request still in flight → model.
   * Copies are never written to the exact cache or the index (so matches cannot chain); only model verdicts are.
   */
  async classify(fp: string, input: PostInput, waiter = 'unknown', opts: ClassifyOptions = {}): Promise<ClassifyResult> {
    // Before the first await: the settings read below may be replaced by a cancel. Or earlier, on arrival (finding I).
    const tk = opts.ticket && opts.ticket.waiter === waiter ? opts.ticket : this.ticket(waiter);
    const settings = await this.deps.loadSettings();
    const problem = configProblem(settings);
    if (problem) return { ok: false, kind: 'config', message: problem };

    const key = `${PROMPT_VERSION}|${settings.model}|${fp}`;
    const hit = await this.deps.cache.get(key);
    if (hit) {
      await this.deps.stats.bump({ cacheHits: 1 });
      return { ok: true, classification: hit, cached: true, model: settings.model, promptVersion: PROMPT_VERSION };
    }

    // Signed with the install's secret key (security S2), kept with the index.
    const sig = this.deps.repeats ? signature(input, await this.deps.repeats.key()) : null;
    if (!sig) return this.callModel(settings, key, input, sig, tk);

    // Registered before any further await, so a similar request arriving right after this one can find it.
    let settle!: (c: Classification | null) => void;
    const settled = new Promise<Classification | null>((r) => (settle = r));
    const self: InFlight = { seq: ++this.seq, key, scope: `${PROMPT_VERSION}|${settings.model}`, fp, sig, joined: false, settled, settle };
    this.inFlight.add(self);
    let verdict: Classification | null = null;
    try {
      if (settings.repeats && !opts.noRepeat) {
        const copied = await this.copyFromSimilar(self, tk);
        if (copied === 'aborted') return ABORTED;
        if (copied) {
          // Not handed out while model settings are being saved; refused if they changed meanwhile.
          await this.afterHolds();
          if (this.stale(tk)) return ABORTED;
          await this.deps.stats.bump({ repeatHits: 1 });
          return { ok: true, ...copied, cached: true, model: settings.model, promptVersion: PROMPT_VERSION };
        }
      }
      const result = await this.callModel(settings, key, input, sig, tk);
      if (result.ok) verdict = result.classification;
      return result;
    } finally {
      this.inFlight.delete(self);
      settle(verdict);
    }
  }

  /**
   * A verdict this post can copy: from a similar post the model judged, or else by waiting for a similar request that
   * is calling the model. Null means "ask the model". Copies only when unambiguous (see judgedMatch).
   */
  private async copyFromSimilar(self: InFlight, tk: Ticket): Promise<Copy | null | 'aborted'> {
    const waiter = tk.waiter;
    const judged = await this.judgedMatch(self.scope, self.sig);
    if (this.stale(tk)) return 'aborted';
    if (judged) return judged;

    // Wait only for a request that arrived earlier (two that arrive together must not wait for each other), is calling
    // the model itself, and is not an exact repeat of this post (those share one request through the queue).
    let best: { other: InFlight; similarity: number } | null = null;
    for (const other of this.inFlight) {
      if (other.seq >= self.seq || other.joined || other.key === self.key || other.scope !== self.scope) continue;
      const s = similarity(self.sig, other.sig);
      if (s >= REPEAT_THRESHOLD && (!best || s > best.similarity)) best = { other, similarity: s };
    }
    if (!best) return null;

    self.joined = true; // registered synchronously after the staleness check above: a cancel will find this wait
    const ctrl = new AbortController();
    const bySender = this.joins.get(self.key) ?? new Map<string, AbortController[]>();
    this.joins.set(self.key, bySender);
    bySender.set(waiter, [...(bySender.get(waiter) ?? []), ctrl]);
    try {
      const aborted = new Promise<'aborted'>((r) => ctrl.signal.addEventListener('abort', () => r('aborted'), { once: true }));
      const got = await Promise.race([best.other.settled, aborted]);
      if (got === 'aborted') return 'aborted';
      if (got && got.decision !== 'highlight') {
        await this.deps.repeats?.touch(best.other.key);
        return { classification: got, repeatOf: { fp: best.other.fp, similarity: round2(best.similarity) } };
      }
    } finally {
      const left = (bySender.get(waiter) ?? []).filter((c) => c !== ctrl);
      if (left.length) bySender.set(waiter, left);
      else bySender.delete(waiter);
      if (!bySender.size) this.joins.delete(self.key);
      self.joined = false;
    }
    // The other request got no usable verdict (failed, cancelled, or a highlight): look again, then ask the model.
    return this.judgedMatch(self.scope, self.sig);
  }

  /**
   * The most similar judged post's classification, if copying is unambiguous: no similar post was judged a highlight
   * (its substance may be in the very details the cleanup erases) and all similar posts got the same decision.
   */
  private async judgedMatch(scope: string, sig: Signature): Promise<Copy | null> {
    const repeats = this.deps.repeats;
    if (!repeats) return null;
    const found: { key: string; fp: string; similarity: number; c: Classification }[] = [];
    for (const cand of await repeats.candidates(scope, sig)) {
      // Looking at a candidate is not using it: only the verdict actually copied counts as recently used (below).
      const c = await this.deps.cache.peek(cand.key);
      if (c) found.push({ ...cand, c });
      else await repeats.remove(cand.key); // its verdict left the cache: the signature alone is useless
    }
    if (!found.length) return null;
    if (found.some((f) => f.c.decision === 'highlight')) return null;
    if (new Set(found.map((f) => f.c.decision)).size > 1) return null;
    const best = found[0]!;
    await this.deps.cache.get(best.key); // its verdict is being used: recently used in the cache, as in the index
    await repeats.touch(best.key);
    return { classification: best.c, repeatOf: { fp: best.fp, similarity: round2(best.similarity) } };
  }

  /** Ask the model (deduplicated per key by the queue). A successful verdict is cached and, with a signature, indexed. */
  private async callModel(settings: Settings, key: string, input: PostInput, sig: Signature | null, tk: Ticket): Promise<ClassifyResult> {
    const waiter = tk.waiter;
    if (this.stale(tk)) return ABORTED; // nothing may await between this check and queue.run below
    this.queue.setConcurrency(settings.concurrency);
    const waiting = this.interest.get(key) ?? new Map<string, number>();
    this.interest.set(key, waiting);
    waiting.set(waiter, (waiting.get(waiter) ?? 0) + 1);
    try {
      const out = await this.queue.run(key, async (signal) => {
        // Never start a model call while model settings are being saved (finding A2), nor for a request from before
        // a global cancel (finding A), nor once nobody waits for it any more. Only the GLOBAL generation is checked:
        // this task may be shared with another tab that still waits for it (the queue aborts it when nobody does).
        await this.afterHolds();
        if (this.staleGlobally(tk) || signal.aborted) throw new AbortedError();
        return classifyPost(settings, input, { ...this.deps.http, signal });
      }).finally(() => this.interest.delete(key)); // settled for every waiter at once
      if (this.staleGlobally(tk)) {
        // The answer raced a cancel all: made under replaced settings, so neither stored nor returned. It was paid
        // for, though, so it still counts towards requests and tokens (not towards "classified").
        await this.deps.stats.bump({ httpRequests: out.httpRequests, promptTokens: out.promptTokens, completionTokens: out.completionTokens });
        return ABORTED;
      }
      await this.deps.cache.set(key, out.classification);
      if (sig) await this.deps.repeats?.add(key, sig); // even with the setting off, so turning it on works at once
      await this.deps.stats.bump({
        httpRequests: out.httpRequests,
        classified: 1,
        promptTokens: out.promptTokens,
        completionTokens: out.completionTokens,
        totalLatencyMs: out.latencyMs,
      });
      // This tab cancelled meanwhile, but the verdict is valid under current settings (stored above, for others).
      if (this.stale(tk)) return ABORTED;
      return { ok: true, classification: out.classification, cached: false, model: settings.model, promptVersion: PROMPT_VERSION };
    } catch (e) {
      // Cancelled (also by a cancel while it ran): not a failure.
      if (e instanceof AbortedError || this.stale(tk)) return ABORTED;
      await this.deps.stats.bump({ failures: 1 });
      if (e instanceof ClassifierError) return { ok: false, kind: e.kind, message: e.message };
      return { ok: false, kind: 'network', message: (e as Error).message };
    }
  }

  /** Round-trip a harmless synthetic post; touches neither cache nor statistics. */
  async testConnection(): Promise<{ ok: true; latencyMs: number; decision: string } | { ok: false; kind: string; message: string }> {
    const settings = await this.deps.loadSettings();
    const problem = configProblem(settings);
    if (problem) return { ok: false, kind: 'config', message: problem };
    try {
      const out = await classifyPost(settings, { text: 'Our team shipped a database migration last week. We measured p99 latency before and after: 180ms down to 95ms, mostly from removing an N+1 query.' }, { ...this.deps.http, maxRetries: 0 });
      return { ok: true, latencyMs: out.latencyMs, decision: out.classification.decision };
    } catch (e) {
      if (e instanceof ClassifierError) return { ok: false, kind: e.kind, message: e.message };
      return { ok: false, kind: 'network', message: (e as Error).message };
    }
  }
}

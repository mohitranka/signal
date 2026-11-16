import { ClassifierError, classifyPost, type ClientDeps } from '../classifier/client';
import { PROMPT_VERSION } from '../classifier/prompt';
import { AbortedError, TaskQueue } from '../classifier/queue';
import { configProblem } from '../shared/settings';
import type { ClassifyResult, PostInput, Settings } from '../shared/types';
import type { CacheStore, StatsStore } from './store';

export interface ServiceDeps {
  loadSettings: () => Promise<Settings>;
  cache: CacheStore;
  stats: StatsStore;
  http?: Pick<ClientDeps, 'fetchImpl' | 'sleep' | 'maxRetries'>;
}

/** Orchestrates cache lookup, request dedup/queueing, the HTTP client, and statistics. */
export class ClassifyService {
  private queue = new TaskQueue();
  /** For each request in the queue: which senders are waiting for it, and how many times. */
  private interest = new Map<string, Map<string, number>>();

  constructor(private deps: ServiceDeps) {}

  cancelAll(): void {
    this.queue.cancelAll();
  }

  /**
   * `waiter` no longer needs this post's request. Only its own interest is released, once (repeats and requests it
   * never asked for are ignored); the request is dropped or aborted only when no sender waits for it any more.
   */
  async cancel(fp: string, waiter = 'unknown'): Promise<void> {
    const settings = await this.deps.loadSettings();
    const key = `${PROMPT_VERSION}|${settings.model}|${fp}`;
    const waiting = this.interest.get(key);
    const n = waiting?.get(waiter) ?? 0;
    if (!waiting || n === 0) return;
    if (n === 1) waiting.delete(waiter);
    else waiting.set(waiter, n - 1);
    this.queue.release(key);
  }

  async classify(fp: string, input: PostInput, waiter = 'unknown'): Promise<ClassifyResult> {
    const settings = await this.deps.loadSettings();
    const problem = configProblem(settings);
    if (problem) return { ok: false, kind: 'config', message: problem };

    const key = `${PROMPT_VERSION}|${settings.model}|${fp}`;
    const hit = await this.deps.cache.get(key);
    if (hit) {
      await this.deps.stats.bump({ cacheHits: 1 });
      return { ok: true, classification: hit, cached: true, model: settings.model, promptVersion: PROMPT_VERSION };
    }

    this.queue.setConcurrency(settings.concurrency);
    const waiting = this.interest.get(key) ?? new Map<string, number>();
    this.interest.set(key, waiting);
    waiting.set(waiter, (waiting.get(waiter) ?? 0) + 1);
    try {
      const out = await this.queue.run(key, (signal) =>
        classifyPost(settings, input, { ...this.deps.http, signal }),
      ).finally(() => this.interest.delete(key)); // settled for every waiter at once
      await this.deps.cache.set(key, out.classification);
      await this.deps.stats.bump({
        httpRequests: out.httpRequests,
        classified: 1,
        promptTokens: out.promptTokens,
        completionTokens: out.completionTokens,
        totalLatencyMs: out.latencyMs,
      });
      return { ok: true, classification: out.classification, cached: false, model: settings.model, promptVersion: PROMPT_VERSION };
    } catch (e) {
      if (e instanceof AbortedError) return { ok: false, kind: 'aborted', message: 'Cancelled.' };
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

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

  constructor(private deps: ServiceDeps) {}

  cancelAll(): void {
    this.queue.cancelAll();
  }

  async classify(fp: string, input: PostInput): Promise<ClassifyResult> {
    const settings = await this.deps.loadSettings();
    const problem = configProblem(settings);
    if (problem) return { ok: false, kind: 'config', message: problem };

    const key = `${PROMPT_VERSION}|${settings.model}|${fp}`;
    const hit = await this.deps.cache.get(key);
    if (hit) {
      await this.deps.stats.bump({ cacheHits: 1 });
      return { ok: true, classification: hit, cached: true };
    }

    this.queue.setConcurrency(settings.concurrency);
    try {
      const out = await this.queue.run(key, (signal) =>
        classifyPost(settings, input, { ...this.deps.http, signal }),
      );
      await this.deps.cache.set(key, out.classification);
      await this.deps.stats.bump({
        httpRequests: out.httpRequests,
        classified: 1,
        promptTokens: out.promptTokens,
        completionTokens: out.completionTokens,
        totalLatencyMs: out.latencyMs,
      });
      return { ok: true, classification: out.classification, cached: false };
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

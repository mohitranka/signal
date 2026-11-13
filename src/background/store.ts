import { DEFAULT_SETTINGS, normalizeSettings } from '../shared/settings';
import type { Classification, Decision, FeedbackEntry, Settings, Stats, Verdict } from '../shared/types';

/** Minimal storage surface, satisfied by chrome.storage.local and by an in-memory fake in tests. */
export interface KV {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

export const chromeKV = (area: chrome.storage.StorageArea): KV => ({
  get: (key) => area.get(key),
  set: (items) => area.set(items),
  remove: (key) => area.remove(key),
});

export class SettingsStore {
  constructor(private kv: KV) {}

  async load(): Promise<Settings> {
    const { settings } = await this.kv.get('settings');
    return normalizeSettings(settings ?? DEFAULT_SETTINGS);
  }

  async save(patch: Partial<Settings>): Promise<Settings> {
    const next = normalizeSettings({ ...(await this.load()), ...patch });
    await this.kv.set({ settings: next });
    return next;
  }
}

interface CacheEntry {
  c: Classification;
  t: number;
}

/** Persistent classification cache, LRU-ish by last access, size-capped. Holds model output only, never post text. */
export class CacheStore {
  private map: Map<string, CacheEntry> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private kv: KV,
    private maxEntries = 2000,
    private persistDelayMs = 2000,
  ) {}

  private async load(): Promise<Map<string, CacheEntry>> {
    if (!this.map) {
      const { cache } = await this.kv.get('cache');
      this.map = new Map(Object.entries((cache as Record<string, CacheEntry>) ?? {}));
    }
    return this.map;
  }

  async get(key: string): Promise<Classification | null> {
    const m = await this.load();
    const e = m.get(key);
    if (!e) return null;
    e.t = Date.now();
    return e.c;
  }

  async set(key: string, c: Classification): Promise<void> {
    const m = await this.load();
    m.set(key, { c, t: Date.now() });
    if (m.size > this.maxEntries) {
      const oldest = [...m.entries()].sort((a, b) => a[1].t - b[1].t).slice(0, m.size - this.maxEntries);
      for (const [k] of oldest) m.delete(k);
    }
    this.schedulePersist();
  }

  async clear(): Promise<void> {
    this.map = new Map();
    await this.flush();
  }

  async size(): Promise<number> {
    return (await this.load()).size;
  }

  private schedulePersist(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => void this.flush(), this.persistDelayMs);
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.map) return;
    await this.kv.set({ cache: Object.fromEntries(this.map) });
  }
}

export class FeedbackStore {
  constructor(private kv: KV) {}

  async all(): Promise<Record<string, FeedbackEntry>> {
    const { feedback } = await this.kv.get('feedback');
    return (feedback as Record<string, FeedbackEntry>) ?? {};
  }

  async verdicts(): Promise<Record<string, Verdict>> {
    const all = await this.all();
    return Object.fromEntries(Object.entries(all).map(([k, v]) => [k, v.verdict]));
  }

  async set(fp: string, verdict: Verdict | null, sample: string, modelDecision?: Decision, modelConfidence?: number): Promise<void> {
    const all = await this.all();
    if (verdict === null) delete all[fp];
    else {
      const entry: FeedbackEntry = { verdict, at: Date.now(), sample: sample.slice(0, 1500) };
      if (modelDecision) entry.modelDecision = modelDecision;
      if (modelConfidence !== undefined) entry.modelConfidence = modelConfidence;
      all[fp] = entry;
    }
    await this.kv.set({ feedback: all });
  }

  async clear(): Promise<void> {
    await this.kv.remove('feedback');
  }
}

export const emptyStats = (): Stats => ({
  httpRequests: 0,
  classified: 0,
  cacheHits: 0,
  failures: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalLatencyMs: 0,
});

/** Session statistics, kept in storage.session so they survive service-worker restarts but not browser restarts. */
export class StatsStore {
  private stats: Stats | null = null;
  constructor(private kv: KV) {}

  async get(): Promise<Stats> {
    if (!this.stats) {
      const { stats } = await this.kv.get('stats');
      this.stats = { ...emptyStats(), ...((stats as Partial<Stats>) ?? {}) };
    }
    return this.stats;
  }

  async bump(delta: Partial<Stats>): Promise<void> {
    const s = await this.get();
    for (const [k, v] of Object.entries(delta)) s[k as keyof Stats] += v as number;
    await this.kv.set({ stats: s });
  }
}

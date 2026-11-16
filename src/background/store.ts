import { parseRecord } from '../classifier/parse';
import { FP_PATTERN, MAX_FEEDBACK_ENTRIES, isVerdict } from '../shared/feedback';
import { DEFAULT_SETTINGS, normalizeSettings } from '../shared/settings';
import { DECISIONS, type Classification, type Decision, type FeedbackEntry, type Settings, type Stats, type Verdict } from '../shared/types';

/** Minimal storage surface, satisfied by chrome.storage.local and by an in-memory fake in tests. */
export interface KV {
  get(key: string): Promise<Record<string, unknown>>;
  /** Every stored item (chrome.storage's get(null)). */
  getAll(): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
  /** Optional change notifications (chrome.storage's onChanged), used to keep in-memory copies fresh. */
  onChanged?(listener: (changes: Record<string, { newValue?: unknown; oldValue?: unknown }>) => void): void;
}

export const chromeKV = (area: chrome.storage.StorageArea): KV => ({
  get: (key) => area.get(key),
  getAll: () => area.get(null),
  set: (items) => area.set(items),
  remove: (keys) => area.remove(keys),
  onChanged: (listener) => area.onChanged?.addListener(listener),
});

/** Runs async operations one at a time, in call order. A failed operation does not block the ones after it. */
class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(op: () => Promise<T>): Promise<T> {
    const result = this.tail.then(op, op);
    this.tail = result.catch(() => {});
    return result;
  }
}

export class SettingsStore {
  private queue = new SerialQueue();
  constructor(private kv: KV) {}

  async load(): Promise<Settings> {
    const { settings } = await this.kv.get('settings');
    return normalizeSettings(settings ?? DEFAULT_SETTINGS);
  }

  /** Read-modify-write, serialized so overlapping saves cannot overwrite each other's changes. */
  save(patch: Partial<Settings>): Promise<Settings> {
    return this.queue.run(async () => {
      const next = normalizeSettings({ ...(await this.load()), ...patch });
      await this.kv.set({ settings: next });
      return next;
    });
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

/** What a setFeedback message may carry besides the verdict. Everything here is untrusted until validated. */
export interface FeedbackExtras {
  modelDecision?: unknown;
  modelConfidence?: unknown;
  classified?: unknown;
}

const isDecision = (v: unknown): v is Decision => typeof v === 'string' && (DECISIONS as readonly string[]).includes(v);
const isUnit = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;

/** Storage key prefix: each correction is stored as "fb:<fingerprint>". */
export const FEEDBACK_KEY_PREFIX = 'fb:';
/** Older versions stored every correction in one map under this key; migrated on first load. */
const LEGACY_FEEDBACK_KEY = 'feedback';
/** Migration moves about this many bytes of older entries per step (peak extra storage needed). */
const MIGRATION_CHUNK_BYTES = 1_000_000;

/**
 * Serialization used to recognise the store's own writes in onChanged events. Chrome hands values back with
 * object keys sorted at every level, so compare with keys sorted too (plain JSON.stringify would never match).
 */
function canonical(v: unknown): string {
  return JSON.stringify(v ?? null, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x,
  );
}

const validEntry = (fp: string, e: unknown): e is FeedbackEntry =>
  FP_PATTERN.test(fp) && !!e && typeof e === 'object' && !Array.isArray(e) && isVerdict((e as FeedbackEntry).verdict);

/**
 * Feedback (corrections), keyed by content fingerprint, one storage key per correction, so a save writes only
 * its own small entry however much feedback exists.
 *
 * - Every operation runs through one queue, so overlapping saves cannot lose updates.
 * - Storage is read once (per service-worker start) and then served from memory. Memory changes only after
 *   a write succeeds.
 * - The older single-map layout is migrated on that first load, in chunks: write a chunk of entries as their own
 *   keys, then rewrite the old map without them, so the extra space needed at any moment is about one chunk.
 *   Loading always merges both layouts (per-key wins) and does not wait for the migration: it runs in the
 *   background, one queued step per chunk, so saves and undos go through between chunks and reads answer from
 *   memory at once. A failed step only pauses it: entries not yet migrated stay fully usable, and the next
 *   service-worker start carries on.
 * - The store remembers the exact value it writes to each key; an onChanged event that does not match one came
 *   from elsewhere (DevTools, another code path), and the in-memory copy is re-read on next use.
 */
export class FeedbackStore {
  private queue = new SerialQueue();
  private map: Record<string, FeedbackEntry> | null = null;
  /** Fingerprints stored under their own key. */
  private perKey = new Set<string>();
  /** Entries still only in the older single map (not migrated yet), or null when that map is gone. */
  private legacy: Record<string, FeedbackEntry> | null = null;
  /** key -> serialized values this store has written and not yet seen come back as onChanged events. */
  private expected = new Map<string, string[]>();
  private chunkBytes: number;
  /** Bumped by every (re)load and reset; a background migration run stops when it no longer matches. */
  private generation = 0;
  private migration: Promise<void> = Promise.resolve();

  constructor(
    private kv: KV,
    opts: { migrationChunkBytes?: number } = {},
  ) {
    this.chunkBytes = opts.migrationChunkBytes ?? MIGRATION_CHUNK_BYTES;
    kv.onChanged?.((changes) => {
      for (const [key, change] of Object.entries(changes)) {
        if (key !== LEGACY_FEEDBACK_KEY && !key.startsWith(FEEDBACK_KEY_PREFIX)) continue;
        if (!this.consumeExpected(key, change.newValue)) {
          this.map = null; // not ours: re-read on next use (which also restarts any migration from fresh state)
          this.generation++;
        }
      }
    });
  }

  private expect(key: string, value: unknown): void {
    if (!this.kv.onChanged) return; // no events would ever clear it
    const list = this.expected.get(key) ?? [];
    list.push(canonical(value));
    this.expected.set(key, list);
  }

  private consumeExpected(key: string, value: unknown): boolean {
    const list = this.expected.get(key);
    const i = list ? list.indexOf(canonical(value)) : -1;
    if (!list || i === -1) return false;
    list.splice(i, 1);
    if (!list.length) this.expected.delete(key);
    return true;
  }

  private forget(key: string, value: unknown): void {
    this.consumeExpected(key, value); // the write failed: no event will come for it
  }

  /** Write and remember what was written, so its change event is recognised as ours; forget it if the write fails. */
  private async write(items: Record<string, unknown>): Promise<void> {
    for (const [k, v] of Object.entries(items)) this.expect(k, v);
    try {
      await this.kv.set(items);
    } catch (e) {
      for (const [k, v] of Object.entries(items)) this.forget(k, v);
      throw e;
    }
  }

  private async removeKeys(keys: string[]): Promise<void> {
    if (!keys.length) return;
    for (const k of keys) this.expect(k, undefined);
    try {
      await this.kv.remove(keys);
    } catch (e) {
      for (const k of keys) this.forget(k, undefined);
      throw e;
    }
  }

  private async load(): Promise<Record<string, FeedbackEntry>> {
    if (this.map) return this.map;
    const stored = await this.kv.getAll();
    const perKey: Record<string, FeedbackEntry> = {};
    const malformed: string[] = [];
    for (const [key, value] of Object.entries(stored)) {
      if (!key.startsWith(FEEDBACK_KEY_PREFIX)) continue;
      const fp = key.slice(FEEDBACK_KEY_PREFIX.length);
      if (validEntry(fp, value)) perKey[fp] = value;
      else malformed.push(key);
    }
    const rawLegacy = stored[LEGACY_FEEDBACK_KEY];
    let legacy: Record<string, FeedbackEntry> | null = null;
    if (LEGACY_FEEDBACK_KEY in stored) {
      legacy = {};
      if (rawLegacy && typeof rawLegacy === 'object' && !Array.isArray(rawLegacy)) {
        for (const [fp, e] of Object.entries(rawLegacy as Record<string, unknown>)) {
          if (validEntry(fp, e) && !(fp in perKey)) legacy[fp] = e; // per-key entries are newer
        }
      }
    }
    this.perKey = new Set(Object.keys(perKey));
    this.legacy = legacy;
    const map = { ...(legacy ?? {}), ...perKey };
    this.map = map;
    await this.removeKeys(malformed).catch(() => {});
    if (this.legacy) this.startMigration();
    return map;
  }

  /** Resolves when the background migration has stopped (finished, or paused until the next start). */
  migrationDone(): Promise<void> {
    return this.migration;
  }

  /** Migrate in the background: one queued step per chunk, so other operations get their turn in between. */
  private startMigration(): void {
    const gen = ++this.generation;
    const run = async (): Promise<void> => {
      while (gen === this.generation) {
        const more = await this.queue.run(() => (gen === this.generation ? this.migrateStep() : Promise.resolve(false)));
        if (!more) return;
      }
    };
    this.migration = run();
  }

  /**
   * Move one chunk of older entries to their own keys. Returns true if there is more to do.
   * Never throws: on any error it stops, and whatever is left is retried on the next start.
   */
  private async migrateStep(): Promise<boolean> {
    try {
      if (!this.legacy || !this.map) return false;
      const fps = Object.keys(this.legacy);
      if (!fps.length) {
        await this.removeKeys([LEGACY_FEEDBACK_KEY]);
        this.legacy = null;
        return false;
      }
      const chunk: Record<string, FeedbackEntry> = {};
      let bytes = 0;
      for (const fp of fps) {
        if (bytes > 0 && bytes >= this.chunkBytes) break;
        const e = this.legacy[fp]!;
        chunk[`${FEEDBACK_KEY_PREFIX}${fp}`] = e;
        bytes += fp.length + JSON.stringify(e).length;
      }
      await this.write(chunk); // 1. the chunk under its own keys...
      for (const k of Object.keys(chunk)) this.perKey.add(k.slice(FEEDBACK_KEY_PREFIX.length));
      const rest = { ...this.legacy };
      for (const k of Object.keys(chunk)) delete rest[k.slice(FEEDBACK_KEY_PREFIX.length)];
      if (Object.keys(rest).length) await this.write({ [LEGACY_FEEDBACK_KEY]: rest }); // 2. ...then shrink the old map
      else await this.removeKeys([LEGACY_FEEDBACK_KEY]);
      this.legacy = Object.keys(rest).length ? rest : null;
      return this.legacy !== null;
    } catch {
      // Out of space or storage error: pause. Memory has every entry; storage has each one in at least one layout.
      return false;
    }
  }

  /**
   * A copy of all well-formed entries, including ones saved by older versions (no `classified`). Once loaded this
   * answers from memory without queueing behind saves or migration steps: memory only ever holds committed state.
   */
  all(): Promise<Record<string, FeedbackEntry>> {
    if (this.map) return Promise.resolve({ ...this.map });
    return this.queue.run(async () => ({ ...(await this.load()) }));
  }

  async verdicts(): Promise<Record<string, Verdict>> {
    const all = await this.all();
    return Object.fromEntries(Object.entries(all).map(([k, v]) => [k, v.verdict]));
  }

  /**
   * Save or (verdict null) delete a correction. A valid `classified` record is stored as a clean copy and is the
   * source of modelDecision/modelConfidence; an invalid one is dropped without losing the verdict. A verdict change
   * that arrives without a record keeps the record already stored for that post.
   * Returns false (and stores nothing) when a new correction would exceed MAX_FEEDBACK_ENTRIES; changing or
   * removing an existing correction always works.
   */
  set(fp: string, verdict: Verdict | null, sample: string, extras: FeedbackExtras = {}): Promise<boolean> {
    return this.queue.run(async () => {
      const current = await this.load();
      const key = `${FEEDBACK_KEY_PREFIX}${fp}`;
      if (verdict === null) {
        if (!(fp in current)) return true;
        if (this.perKey.has(fp)) await this.removeKeys([key]);
        this.perKey.delete(fp);
        if (this.legacy && fp in this.legacy) {
          // not migrated yet: take it out of the older map too, or it would come back on the next start
          const rest = { ...this.legacy };
          delete rest[fp];
          if (Object.keys(rest).length) await this.write({ [LEGACY_FEEDBACK_KEY]: rest });
          else await this.removeKeys([LEGACY_FEEDBACK_KEY]);
          this.legacy = Object.keys(rest).length ? rest : null;
        }
        delete current[fp];
        return true;
      }
      if (!(fp in current) && Object.keys(current).length >= MAX_FEEDBACK_ENTRIES) return false;
      const entry: FeedbackEntry = { verdict, at: Date.now(), sample: sample.slice(0, 1500) };
      const classified = parseRecord(extras.classified) ?? (extras.classified === undefined ? current[fp]?.classified : undefined);
      if (classified) {
        entry.modelDecision = classified.classification.decision;
        entry.modelConfidence = classified.classification.confidence;
        entry.classified = classified;
      } else {
        const previous = current[fp];
        const decision = isDecision(extras.modelDecision) ? extras.modelDecision : extras.modelDecision === undefined ? previous?.modelDecision : undefined;
        const confidence = isUnit(extras.modelConfidence) ? extras.modelConfidence : extras.modelConfidence === undefined ? previous?.modelConfidence : undefined;
        if (decision) entry.modelDecision = decision;
        if (confidence !== undefined) entry.modelConfidence = confidence;
      }
      await this.write({ [key]: entry }); // on failure memory keeps the previous, still-stored state
      this.perKey.add(fp); // a per-key entry wins over any older copy still in the old map
      current[fp] = entry;
      return true;
    });
  }

  /** Remove every correction, including ones written elsewhere and older-format leftovers. Nothing else is touched. */
  clear(): Promise<void> {
    return this.queue.run(async () => {
      const stored = await this.kv.getAll();
      const keys = Object.keys(stored).filter((k) => k.startsWith(FEEDBACK_KEY_PREFIX) || k === LEGACY_FEEDBACK_KEY);
      try {
        await this.removeKeys(keys);
      } catch (e) {
        this.map = null; // unknown how much was removed: re-read next time
        throw e;
      }
      this.map = {};
      this.perKey = new Set();
      this.legacy = null;
      this.generation++; // stops any background migration
    });
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

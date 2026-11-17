import { FP_PATTERN } from '../shared/feedback';
import {
  REPEAT_THRESHOLD,
  SIGNATURE_VERSION,
  decodeKey,
  decodeSignature,
  encodeKey,
  encodeSignature,
  newSignatureKey,
  similarity,
  type Signature,
  type SignatureKey,
} from '../shared/similarity';
import type { KV } from './store';

/** Storage key. Versioned with the signature rules, so signatures made under other rules are never compared. */
export const REPEATS_STORAGE_KEY = `repeats:v${SIGNATURE_VERSION}`;
/**
 * Stored as { key, entries }: the install's secret signature key (security S2) lives and dies with the signatures made
 * under it. A missing or invalid key means a new key and no entries: signatures are never compared across keys.
 */
interface Stored {
  key: string;
  entries: Record<string, StoredEntry>;
}

/** Indexes written under earlier signature rules: never read, deleted on first load so they do not hold quota. */
const OLD_STORAGE_KEYS = Array.from({ length: SIGNATURE_VERSION - 1 }, (_, i) => `repeats:v${i + 1}`);

interface Entry {
  sig: Signature;
  /** The encoded signature, kept so saves never re-encode (performance P1): set once on add, or as loaded. */
  enc: string;
  /** Last added or used: eviction and tie-breaking. */
  t: number;
  /** promptVersion|model: everything before the key's last "|". */
  scope: string;
  fp: string;
}

interface StoredEntry {
  s: string;
  t: number;
}

export interface RepeatCandidate {
  /** The exact-cache key of the judged post (promptVersion|model|fp): its verdict is read from the cache. */
  key: string;
  fp: string;
  similarity: number;
}

/** Split a cache key into scope and fingerprint at the LAST "|": model names may themselves contain "|". */
function splitKey(key: string): { scope: string; fp: string } | null {
  const i = key.lastIndexOf('|');
  if (i <= 0) return null;
  const fp = key.slice(i + 1);
  return FP_PATTERN.test(fp) ? { scope: key.slice(0, i), fp } : null;
}

/**
 * Signatures of posts the model judged, for recognising repeated templates (docs/design-repeats.md §5).
 *
 * Keyed like the classification cache (promptVersion|model|fp). Holds hashes only: no post text and no verdict (the
 * verdict is read from the cache under the same key, so there is one source of truth). Loaded once, served from memory,
 * persisted on a debounce like the cache, capped with least-recently-used eviction.
 */
export class RepeatIndex {
  private map: Map<string, Entry> | null = null;
  /** The install's signature key, read (or created) with the entries. */
  private signKey: SignatureKey | null = null;
  private loading: Promise<Map<string, Entry>> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private maxEntries: number;
  private persistDelayMs: number;
  private now: () => number;

  constructor(
    private kv: KV,
    opts: { maxEntries?: number; persistDelayMs?: number; now?: () => number } = {},
  ) {
    this.maxEntries = opts.maxEntries ?? 2000;
    this.persistDelayMs = opts.persistDelayMs ?? 2000;
    this.now = opts.now ?? Date.now;
  }

  private load(): Promise<Map<string, Entry>> {
    if (this.map) return Promise.resolve(this.map);
    this.loading ??= this.kv
      .get(REPEATS_STORAGE_KEY)
      .then(async (got) => {
        const m = new Map<string, Entry>();
        const raw = got[REPEATS_STORAGE_KEY];
        const stored = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Partial<Record<keyof Stored, unknown>>) : null;
        const key = decodeKey(stored?.key);
        const entries = stored?.entries;
        // Entries count only together with the key they were made under.
        if (key && entries && typeof entries === 'object' && !Array.isArray(entries)) {
          // Stored data is checked entry by entry: one bad entry must not cost the others.
          for (const [key, v] of Object.entries(entries as Record<string, unknown>)) {
            const parts = splitKey(key);
            if (!parts || !v || typeof v !== 'object') continue;
            const { s, t } = v as Partial<StoredEntry>;
            const sig = decodeSignature(s);
            if (!sig || typeof t !== 'number' || !Number.isFinite(t)) continue;
            m.set(key, { sig, enc: s as string, t, ...parts });
          }
        }
        this.signKey ??= key ?? newSignatureKey();
        this.map ??= m;
        if (!key) this.schedulePersist(); // a new key: store it (with no entries)
        await this.removeOldIndexes(); // one read; errors are swallowed, so loading never fails because of it
        return this.map;
      })
      .finally(() => (this.loading = null));
    return this.loading;
  }

  /** Best effort, once per load: a failure only means the old data stays until the next start. */
  private async removeOldIndexes(): Promise<void> {
    for (const old of OLD_STORAGE_KEYS) {
      try {
        if (old in (await this.kv.get(old))) await this.kv.remove(old);
      } catch {
        /* try again next start */
      }
    }
  }

  /** Remember the signature of a post the model judged. Keys that are not cache keys are ignored. */
  async add(key: string, sig: Signature): Promise<void> {
    const parts = splitKey(key);
    if (!parts) return;
    const m = await this.load();
    m.set(key, { sig, enc: encodeSignature(sig), t: this.now(), ...parts });
    while (m.size > this.maxEntries) {
      let oldest: string | null = null;
      let oldestT = Infinity;
      for (const [k, e] of m) if (e.t < oldestT) [oldest, oldestT] = [k, e.t];
      m.delete(oldest!);
    }
    this.schedulePersist();
  }

  /** Judged posts in the same scope at or above the threshold: most similar first, then most recently used. */
  async candidates(scope: string, sig: Signature, threshold = REPEAT_THRESHOLD): Promise<RepeatCandidate[]> {
    const m = await this.load();
    const out: (RepeatCandidate & { t: number })[] = [];
    for (const [key, e] of m) {
      if (e.scope !== scope) continue; // exact comparison: "acme" must not match "acme|large"
      const s = similarity(sig, e.sig);
      if (s >= threshold) out.push({ key, fp: e.fp, similarity: s, t: e.t });
    }
    out.sort((a, b) => b.similarity - a.similarity || b.t - a.t);
    return out.map(({ key, fp, similarity: s }) => ({ key, fp, similarity: s }));
  }

  /**
   * Mark an entry as just used (it was copied from): protects it from eviction and wins ties. Memory only: the new time
   * is written with the next real change or on suspend (performance P3a). Losing it to a worker kill only shifts
   * eviction order, so a full index save just for a timestamp is not worth it.
   */
  async touch(key: string): Promise<void> {
    const e = (await this.load()).get(key);
    if (!e) return;
    e.t = this.now();
  }

  async remove(key: string): Promise<void> {
    if ((await this.load()).delete(key)) this.schedulePersist();
  }

  /** The install's signature key (created on first use): the one to sign posts with for this index. */
  async key(): Promise<SignatureKey> {
    await this.load();
    return this.signKey!;
  }

  /** Forget every entry. The key is kept: the index is empty, so rotating it would add nothing. */
  async clear(): Promise<void> {
    // After the first load (shared with any use already waiting for it), so it cannot be undone by that load.
    (await this.load()).clear();
    await this.flush();
  }

  async size(): Promise<number> {
    return (await this.load()).size;
  }

  private schedulePersist(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => void this.flush().catch(() => {}), this.persistDelayMs);
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.map || !this.signKey) return;
    const entries: Record<string, StoredEntry> = {};
    for (const [key, e] of this.map) entries[key] = { s: e.enc, t: e.t };
    const out: Stored = { key: encodeKey(this.signKey), entries };
    await this.kv.set({ [REPEATS_STORAGE_KEY]: out });
  }
}

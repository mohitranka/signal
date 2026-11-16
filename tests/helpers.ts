import { createHash } from 'node:crypto';
import type { Classification, Signals } from '../src/shared/types';
import type { KV } from '../src/background/store';

export const cls = (over: Omit<Partial<Classification>, 'signals'> & { signals?: Partial<Signals> } = {}): Classification => ({
  decision: 'keep',
  confidence: 0.9,
  reason: 'ok',
  ...over,
  signals: { originality: 0.5, evidence: 0.5, reasoning: 0.5, usefulness: 0.5, sensationalism: 0.1, engagement_bait: 0.1, ...over.signals },
});

export const noise = (confidence = 0.95) =>
  cls({ decision: 'collapse', confidence, reason: 'Generic motivation', signals: { originality: 0.1, evidence: 0.05, reasoning: 0.05, usefulness: 0.1, sensationalism: 0.5, engagement_bait: 0.7 } });

export const gem = (confidence = 0.9) =>
  cls({ decision: 'highlight', confidence, reason: 'Original measurements', signals: { originality: 0.9, evidence: 0.9, reasoning: 0.8, usefulness: 0.8, sensationalism: 0.05, engagement_bait: 0.05 } });

export const modelJson = (c: Classification) => JSON.stringify(c);

/** Chrome's storage hands objects back with their keys sorted at every level; the stand-in below does the same. */
export function sortKeysDeep<T>(v: T): T {
  if (Array.isArray(v)) return v.map(sortKeysDeep) as T;
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeysDeep((v as Record<string, unknown>)[k])])) as T;
  }
  return v;
}

/**
 * In-memory stand-in for chrome.storage.local. Like Chrome, it emits onChanged events asynchronously after writes.
 * `delayMs` makes every read and write take that long, so overlapping operations interleave as on real storage.
 */
export function memoryKV(opts: { delayMs?: number; quotaBytes?: number } = {}): KV & {
  data: Record<string, unknown>;
  reads: number;
  writes: number;
  /** Keys passed to each set() call, in order: shows how much each write touches. */
  writtenKeys: string[][];
  failNextWrite: boolean;
  failNextRemove: boolean;
  /** Fail the set() call with this 1-based number (counted from when it is assigned). */
  failWriteNumber: number;
  failNextGetAll: boolean;
  bytesInUse(): number;
} {
  const data: Record<string, unknown> = {};
  const listeners: ((changes: Record<string, { newValue?: unknown; oldValue?: unknown }>) => void)[] = [];
  const wait = () => (opts.delayMs ? new Promise((r) => setTimeout(r, opts.delayMs)) : Promise.resolve());
  const emit = (changes: Record<string, { newValue?: unknown; oldValue?: unknown }>) =>
    setTimeout(() => listeners.forEach((l) => l(sortKeysDeep(structuredClone(changes)))), 0);
  const kv = {
    data,
    reads: 0,
    writes: 0,
    writtenKeys: [] as string[][],
    failNextWrite: false,
    failNextRemove: false,
    failWriteNumber: 0,
    failNextGetAll: false,
    bytesInUse: () => Object.entries(data).reduce((n, [k, v]) => n + k.length + JSON.stringify(v).length, 0),
    get: async (k: string) => {
      kv.reads++;
      await wait();
      return k in data ? { [k]: sortKeysDeep(structuredClone(data[k])) } : {};
    },
    getAll: async () => {
      kv.reads++;
      await wait();
      if (kv.failNextGetAll) {
        kv.failNextGetAll = false;
        throw new Error('storage unavailable');
      }
      return sortKeysDeep(structuredClone(data));
    },
    set: async (items: Record<string, unknown>) => {
      kv.writes++;
      kv.writtenKeys.push(Object.keys(items));
      await wait();
      if (kv.failNextWrite) {
        kv.failNextWrite = false;
        throw new Error('QUOTA_BYTES quota exceeded');
      }
      if (kv.failWriteNumber > 0 && --kv.failWriteNumber === 0) throw new Error('write failed');
      if (opts.quotaBytes !== undefined) {
        // like chrome.storage: the write is rejected if the result would exceed the quota
        const after = { ...data, ...items };
        const size = Object.entries(after).reduce((n, [k, v]) => n + k.length + JSON.stringify(v).length, 0);
        if (size > opts.quotaBytes) throw new Error('Resource::kQuotaBytes quota exceeded');
      }
      Object.assign(data, structuredClone(items));
      emit(Object.fromEntries(Object.entries(items).map(([key, v]) => [key, { newValue: v }])));
    },
    remove: async (keys: string | string[]) => {
      await wait();
      if (kv.failNextRemove) {
        kv.failNextRemove = false;
        throw new Error('remove failed');
      }
      const changes: Record<string, { oldValue?: unknown }> = {};
      for (const k of Array.isArray(keys) ? keys : [keys]) {
        if (k in data) changes[k] = { oldValue: data[k] };
        delete data[k];
      }
      if (Object.keys(changes).length) emit(changes);
    },
    onChanged: (cb: (changes: Record<string, { newValue?: unknown; oldValue?: unknown }>) => void) => void listeners.push(cb),
  };
  return kv;
}

export const chatResponse = (content: string, usage = { prompt_tokens: 100, completion_tokens: 40 }, init: ResponseInit = {}) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }], usage }), { status: 200, ...init });

/** A stored classification record, as the background keeps it on a feedback entry. */
export const record = (classification: Classification, model = 'm', promptVersion = 'v1') => ({ classification, model, promptVersion });

/** A realistic content fingerprint (32 lowercase hex chars) for a short test label. */
export const fpFor = (label: string) => createHash('md5').update(label).digest('hex');

/**
 * Finding B (docs/design-finding-b-cache-refresh.md): the repeat lookup reads candidates' verdicts without marking
 * them recently used; only the entry whose verdict is actually copied counts as used.
 *
 * "Recently used" is observed exactly: the cache is flushed and each entry's stored time `t` is read from storage,
 * with the clock fixed at each step (only Date is faked; timers stay real).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClassifyService } from '../src/background/classifyService';
import { RepeatIndex } from '../src/background/repeatIndex';
import { CacheStore, SettingsStore, StatsStore } from '../src/background/store';
import { PROMPT_VERSION } from '../src/classifier/prompt';
import { fingerprint, prepareInput } from '../src/shared/post';
import { signature } from '../src/shared/similarity';
import type { Classification, ClassifyResult } from '../src/shared/types';
import { announce, evidence } from './fixtures/templates';
import { chatResponse, cls, gem, memoryKV, modelJson, noise } from './helpers';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

type Rule = (body: string) => Classification;
const defaultRule: Rule = (b) => (b.includes('thrilled to announce') ? noise() : b.includes('p99 latency') ? gem() : cls());

async function setup(rule: Rule = defaultRule) {
  const kv = memoryKV();
  const settings = new SettingsStore(kv);
  await settings.save({ model: 'm', apiKey: 'k', endpoint: 'https://api.example.com/v1' });
  const cache = new CacheStore(kv, 2000, 60_000);
  const repeats = new RepeatIndex(kv, { persistDelayMs: 60_000 });
  const fetchImpl = vi.fn(async (_u: string, init: RequestInit) => chatResponse(modelJson(rule(String(init.body)))));
  const service = new ClassifyService({ loadSettings: () => settings.load(), cache, stats: new StatsStore(memoryKV()), repeats, http: { fetchImpl: fetchImpl as any, sleep: async () => {}, maxRetries: 0 } });
  const keyOf = async (text: string) => `${PROMPT_VERSION}|m|${await fingerprint(prepareInput({ text }))}`;
  /** Classify at a fixed time. */
  const at = async (time: number, text: string, opts?: { noRepeat?: boolean }): Promise<ClassifyResult> => {
    vi.setSystemTime(time);
    const input = prepareInput({ text });
    return service.classify(await fingerprint(input), input, 'tab-1', opts);
  };
  /** Each cache entry's stored "last used" time, as written to storage. */
  const timeOf = async (text: string): Promise<number | undefined> => {
    await cache.flush();
    return ((kv.data.cache ?? {}) as Record<string, { t: number }>)[await keyOf(text)]?.t;
  };
  return { kv, cache, repeats, service, fetchImpl, at, timeOf, keyOf };
}

describe('CacheStore.peek', () => {
  it('returns the verdict without marking it used; get still marks it used', async () => {
    const kv = memoryKV();
    const cache = new CacheStore(kv, 2000, 60_000);
    vi.setSystemTime(1000);
    await cache.set('k', cls());
    vi.setSystemTime(2000);
    expect(await cache.peek('k')).toEqual(cls());
    expect(await cache.peek('missing')).toBeNull();
    await cache.flush();
    expect((kv.data.cache as Record<string, { t: number }>).k!.t).toBe(1000);
    vi.setSystemTime(3000);
    expect(await cache.get('k')).toEqual(cls());
    await cache.flush();
    expect((kv.data.cache as Record<string, { t: number }>).k!.t).toBe(3000);
  });
});

describe('the repeat lookup marks only a copied verdict as used (finding B)', () => {
  it('copy refused because the similar post is a highlight: its entry is not marked used', async () => {
    const t = await setup();
    await t.at(1000, evidence(180, 95)); // highlight, judged at 1000
    const r = await t.at(2000, evidence(240, 120)); // similar: looked up, not copied
    expect(r).toMatchObject({ ok: true, cached: false });
    expect(await t.timeOf(evidence(180, 95))).toBe(1000);
  });

  it('copy refused because similar posts disagree: neither entry is marked used', async () => {
    const t = await setup((b) => (b.includes('Fabrikam') ? cls() : defaultRule(b)));
    await t.at(1000, announce('Northwind')); // collapse
    await t.at(2000, announce('Fabrikam'), { noRepeat: true }); // keep
    const r = await t.at(3000, announce('Contoso')); // both similar, they disagree: not copied
    expect(r).toMatchObject({ ok: true, cached: false });
    expect(await t.timeOf(announce('Northwind'))).toBe(1000);
    expect(await t.timeOf(announce('Fabrikam'))).toBe(2000);
  });

  it('copy made: only the copied (most similar) entry is marked used', async () => {
    const t = await setup();
    await t.at(1000, announce('Northwind', 6, '🚀'));
    await t.at(2000, announce('Contoso'), { noRepeat: true }); // agrees (collapse), but less similar to the variant
    const r = (await t.at(3000, announce('Northwind', 9, '🔥'))) as Extract<ClassifyResult, { ok: true }> & { repeatOf?: { fp: string } };
    expect(r.repeatOf?.fp).toBe((await t.keyOf(announce('Northwind', 6, '🚀'))).split('|').pop());
    expect(await t.timeOf(announce('Northwind', 6, '🚀'))).toBe(3000); // used: its verdict was handed out
    expect(await t.timeOf(announce('Contoso'))).toBe(2000); // looked at, not used
  });

  it('regression: a candidate whose verdict left the cache is still dropped from the index, and the model is asked', async () => {
    const t = await setup();
    await t.at(1000, announce('Northwind'));
    await t.cache.clear();
    const r = await t.at(2000, announce('Contoso'));
    expect(r).toMatchObject({ ok: true, cached: false });
    expect(t.fetchImpl).toHaveBeenCalledTimes(2);
    const sig = signature(prepareInput({ text: announce('Northwind') }), await t.repeats.key())!; // the index's own key
    const left = await t.repeats.candidates(`${PROMPT_VERSION}|m`, sig);
    expect(left.map((c) => c.key)).toEqual([await t.keyOf(announce('Contoso'))]);
  });
});

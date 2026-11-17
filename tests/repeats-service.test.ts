/**
 * T5 + T6: the background recognises repeated templates (docs/design-repeats.md §4).
 *   exact cache → copy from a post the model judged → join a similar request still in flight → model call.
 */
import { describe, expect, it, vi } from 'vitest';
import { ClassifyService } from '../src/background/classifyService';
import { RepeatIndex } from '../src/background/repeatIndex';
import { CacheStore, SettingsStore, StatsStore } from '../src/background/store';
import { PROMPT_VERSION } from '../src/classifier/prompt';
import { fingerprint, prepareInput } from '../src/shared/post';
import { PUBLIC_TEST_KEY, REPEAT_THRESHOLD, encodeSignature, signature } from '../src/shared/similarity';
import type { Classification, ClassifyResult } from '../src/shared/types';
import { announce, evidence, lessons, short } from './fixtures/templates';
import { chatResponse, cls, gem, memoryKV, modelJson, noise } from './helpers';

type Rule = (body: string) => Classification | 'fail';
/** The fake model judges by content: announcements are noise, listicles are kept, evidence posts are highlights. */
const defaultRule: Rule = (b) => (b.includes('thrilled to announce') ? noise() : b.includes('p99 latency') ? gem() : cls());

/**
 * Wait for the code, not for a number of ticks: fingerprinting (crypto.subtle) finishes on a thread pool, so a loaded
 * machine (or SIGNAL_TEST_SLOW_HASH, see tests/setup.ts) needs longer. Fails loudly instead of hanging.
 */
async function until(cond: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}
/** How many requests are waiting for a similar request's verdict. Reads service internals: test-only. */
const waiting = (s: ClassifyService) =>
  [...((s as any).joins as Map<string, Map<string, unknown[]>>).values()].reduce((n, m) => n + [...m.values()].reduce((k, a) => k + a.length, 0), 0);

function setup(rule: Rule = defaultRule) {
  const kv = memoryKV();
  const settings = new SettingsStore(kv);
  const cache = new CacheStore(kv, 2000, 10);
  const stats = new StatsStore(memoryKV());
  const repeats = new RepeatIndex(kv, { persistDelayMs: 10 });
  const holds: { marker: string; released: boolean; waiting: (() => void)[] }[] = [];
  let currentRule = rule;
  // Like real fetch: rejects with AbortError when its signal is aborted.
  const fetchImpl = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((res, rej) => {
    const body = String(init.body);
    init.signal?.addEventListener('abort', () => rej(new DOMException('The operation was aborted.', 'AbortError')));
    const answer = () => {
      const v = currentRule(body);
      res(v === 'fail' ? new Response('down', { status: 500 }) : chatResponse(modelJson(v)));
    };
    const gate = holds.find((h) => !h.released && body.includes(h.marker));
    if (gate) gate.waiting.push(answer);
    else answer();
  }));
  const service = new ClassifyService({
    loadSettings: () => settings.load(),
    cache,
    stats,
    repeats,
    http: { fetchImpl: fetchImpl as any, sleep: async () => {}, maxRetries: 0 },
  });
  const ready = settings.save({ model: 'm', apiKey: 'k', endpoint: 'https://api.example.com/v1', concurrency: 3 });
  const fpOf = (text: string) => fingerprint(prepareInput({ text }));
  const ask = async (text: string, waiter = 'tab-1', opts?: { noRepeat?: boolean }): Promise<ClassifyResult> => {
    await ready;
    const input = prepareInput({ text });
    return service.classify(await fingerprint(input), input, waiter, opts);
  };
  return {
    kv, settings, cache, stats, repeats, service, fetchImpl, ask, fpOf, ready,
    setRule: (r: Rule) => (currentRule = r),
    /** Hold back the model's answer for request bodies containing `marker` until release(). */
    hold: (marker: string) => {
      const h = { marker, released: false, waiting: [] as (() => void)[] };
      holds.push(h);
      return () => { h.released = true; h.waiting.splice(0).forEach((go) => go()); };
    },
    scope: () => `${PROMPT_VERSION}|m`,
  };
}

const ok = (r: ClassifyResult) => {
  expect(r.ok, JSON.stringify(r)).toBe(true);
  return r as Extract<ClassifyResult, { ok: true }> & { repeatOf?: { fp: string; similarity: number } };
};

describe('copying from a post the model already judged (T5)', () => {
  it('a template variant reuses the verdict: one model call, and the result says what it was copied from', async () => {
    const t = setup();
    const a = ok(await t.ask(announce('Northwind', 6, '🚀')));
    expect(a.cached).toBe(false);
    expect(a.repeatOf).toBeUndefined();

    const b = ok(await t.ask(announce('Contoso', 11, '💯')));
    expect(t.fetchImpl).toHaveBeenCalledTimes(1);
    expect(b.classification).toEqual(noise());
    expect(b.cached).toBe(true);
    expect(b).toMatchObject({ model: 'm', promptVersion: PROMPT_VERSION });
    expect(b.repeatOf!.fp).toBe(await t.fpOf(announce('Northwind', 6, '🚀')));
    expect(b.repeatOf!.similarity).toBeGreaterThanOrEqual(REPEAT_THRESHOLD);
    expect(b.repeatOf!.similarity).toBeLessThanOrEqual(1);
    expect(Math.round(b.repeatOf!.similarity * 100) / 100).toBe(b.repeatOf!.similarity); // 2 decimals

    const s = await t.stats.get();
    expect(s.repeatHits).toBe(1);
    expect(s.cacheHits).toBe(0);
    expect(s.classified).toBe(1);
  });

  it('short posts are never matched: only exact repeats count', async () => {
    const t = setup();
    ok(await t.ask(short('Priya')));
    const b = ok(await t.ask(short('Marco')));
    expect(t.fetchImpl).toHaveBeenCalledTimes(2);
    expect(b.repeatOf).toBeUndefined();
    expect(await t.repeats.size()).toBe(0); // nothing to index without a signature
    ok(await t.ask(short('Marco')));
    expect(t.fetchImpl).toHaveBeenCalledTimes(2); // exact repeat: cache
  });

  it('a highlight is never copied: the variant asks the model', async () => {
    const t = setup();
    ok(await t.ask(evidence(180, 95)));
    const b = ok(await t.ask(evidence(240, 120)));
    expect(t.fetchImpl).toHaveBeenCalledTimes(2);
    expect(b.repeatOf).toBeUndefined();
    expect(b.cached).toBe(false);
  });

  it('when similar judged posts disagree, the model is asked', async () => {
    const t = setup((b) => (b.includes('Fabrikam') ? cls() : defaultRule(b)));
    ok(await t.ask(announce('Northwind'))); // collapse
    ok(await t.ask(announce('Fabrikam'), 'tab-1', { noRepeat: true })); // keep, judged on its own
    const c = ok(await t.ask(announce('Contoso')));
    expect(t.fetchImpl).toHaveBeenCalledTimes(3);
    expect(c.repeatOf).toBeUndefined();
  });

  it('copied verdicts never become anchors, so matches cannot chain', async () => {
    const t = setup();
    ok(await t.ask(announce('Northwind')));
    ok(await t.ask(announce('Contoso')));
    expect(await t.repeats.size()).toBe(1);
    const found = await t.repeats.candidates(t.scope(), signature({ text: prepareInput({ text: announce('Contoso') }).text }, await t.repeats.key())!);
    expect(found.map((c) => c.fp)).toEqual([await t.fpOf(announce('Northwind'))]);
  });

  it('with the setting off nothing is copied, but judged posts are still indexed for when it is turned on', async () => {
    const t = setup();
    await t.settings.save({ repeats: false });
    ok(await t.ask(announce('Northwind')));
    expect(ok(await t.ask(announce('Contoso'))).repeatOf).toBeUndefined();
    expect(t.fetchImpl).toHaveBeenCalledTimes(2);
    expect(await t.repeats.size()).toBe(2);

    await t.settings.save({ repeats: true });
    expect(ok(await t.ask(announce('Fabrikam'))).repeatOf).toBeDefined();
    expect(t.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('noRepeat ("Judge separately") asks the model, and its verdict becomes an anchor', async () => {
    const t = setup();
    ok(await t.ask(announce('Northwind')));
    const b = ok(await t.ask(announce('Contoso'), 'tab-1', { noRepeat: true }));
    expect(t.fetchImpl).toHaveBeenCalledTimes(2);
    expect(b.repeatOf).toBeUndefined();
    expect(b.cached).toBe(false);
    expect(await t.repeats.size()).toBe(2);
  });

  it('a post judged by another model is not copied', async () => {
    const t = setup();
    ok(await t.ask(announce('Northwind')));
    await t.settings.save({ model: 'm2' });
    const b = ok(await t.ask(announce('Contoso')));
    expect(b.repeatOf).toBeUndefined();
    expect(t.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('if the judged post\'s verdict has left the cache, the model is asked and the stale index entry is dropped', async () => {
    const t = setup();
    ok(await t.ask(announce('Northwind')));
    await t.cache.clear();
    const b = ok(await t.ask(announce('Contoso')));
    expect(b.repeatOf).toBeUndefined();
    expect(t.fetchImpl).toHaveBeenCalledTimes(2);
    const found = await t.repeats.candidates(t.scope(), signature({ text: prepareInput({ text: announce('Northwind') }).text }, await t.repeats.key())!);
    expect(found.map((c) => c.fp)).toEqual([await t.fpOf(announce('Contoso'))]);
  });

  it('an exact repeat is a cache hit, not a repeat', async () => {
    const t = setup();
    ok(await t.ask(announce('Northwind')));
    const again = ok(await t.ask(announce('Northwind')));
    expect(again.cached).toBe(true);
    expect(again.repeatOf).toBeUndefined();
    expect(await t.stats.get()).toMatchObject({ cacheHits: 1, repeatHits: 0 });
  });

  it('a copied verdict is not written to the exact cache', async () => {
    const t = setup();
    ok(await t.ask(announce('Northwind')));
    expect(await t.cache.size()).toBe(1);
    ok(await t.ask(announce('Contoso')));
    expect(await t.cache.size()).toBe(1);
  });

  it('a failed model call adds no anchor', async () => {
    const t = setup((b) => (b.includes('Northwind') ? 'fail' : defaultRule(b)));
    const a = await t.ask(announce('Northwind'));
    expect(a.ok).toBe(false);
    expect(await t.repeats.size()).toBe(0);
    expect(ok(await t.ask(announce('Contoso'))).repeatOf).toBeUndefined();
    expect(t.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("signs with the index's own per-install key, never the public test key (security S2)", async () => {
    const t = setup();
    ok(await t.ask(announce('Northwind')));
    await t.repeats.flush();
    const entries = (t.kv.data['repeats:v3'] as { entries: Record<string, { s: string }> }).entries;
    const saved = Object.values(entries)[0]!.s;
    const input = prepareInput({ text: announce('Northwind') });
    expect(saved).toBe(encodeSignature(signature(input, await t.repeats.key())!));
    expect(saved).not.toBe(encodeSignature(signature(input, PUBLIC_TEST_KEY)!));
    const other = setup(); // another install
    expect(Array.from(await other.repeats.key())).not.toEqual(Array.from(await t.repeats.key()));
  });

  it('posts that are merely on a similar topic are judged separately', async () => {
    const t = setup();
    ok(await t.ask(announce('Northwind')));
    ok(await t.ask(lessons()));
    expect(t.fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('joining a similar request that is still waiting for the model (T6)', () => {
  it('two variants sent together cost one model call; the second copies the first', async () => {
    const t = setup();
    const [a, b] = await Promise.all([t.ask(announce('Northwind'), 'tab-1'), t.ask(announce('Contoso'), 'tab-1')]);
    expect(t.fetchImpl).toHaveBeenCalledTimes(1);
    const copies = [ok(a), ok(b)].filter((r) => r.repeatOf);
    expect(copies).toHaveLength(1);
    expect(await t.stats.get()).toMatchObject({ classified: 1, repeatHits: 1 });
  });

  it('three variants at once: one call, two copies', async () => {
    const t = setup();
    const rs = await Promise.all([t.ask(announce('Northwind')), t.ask(announce('Contoso')), t.ask(announce('Fabrikam'))]);
    expect(t.fetchImpl).toHaveBeenCalledTimes(1);
    expect(rs.map(ok).filter((r) => r.repeatOf)).toHaveLength(2);
  });

  it('if the waited-for answer is a highlight, the variant asks the model itself', async () => {
    const t = setup();
    const release = t.hold('180ms');
    const pa = t.ask(evidence(180, 95));
    await until(() => t.fetchImpl.mock.calls.length === 1, 'A calls the model');
    const pb = t.ask(evidence(240, 120));
    await until(() => waiting(t.service) === 1, 'B waits for A');
    release();
    const [, b] = await Promise.all([pa, pb]);
    expect(t.fetchImpl).toHaveBeenCalledTimes(2);
    expect(ok(b).repeatOf).toBeUndefined();
    expect(ok(b).classification).toEqual(gem());
  });

  it('if the waited-for request fails, the variant asks the model itself', async () => {
    const t = setup((b) => (b.includes('Northwind') ? 'fail' : defaultRule(b)));
    const release = t.hold('Northwind');
    const pa = t.ask(announce('Northwind'));
    await until(() => t.fetchImpl.mock.calls.length === 1, 'A calls the model');
    const pb = t.ask(announce('Contoso'));
    await until(() => waiting(t.service) === 1, 'B waits for A');
    release();
    const [a, b] = await Promise.all([pa, pb]);
    expect(a.ok).toBe(false);
    expect(ok(b).repeatOf).toBeUndefined();
    expect(t.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('cancelling the waiting variant ends only its own wait: the other request still completes', async () => {
    const t = setup();
    const release = t.hold('Northwind');
    const pa = t.ask(announce('Northwind'), 'tab-a');
    await until(() => t.fetchImpl.mock.calls.length === 1, 'A calls the model');
    const pb = t.ask(announce('Contoso'), 'tab-b');
    await until(() => waiting(t.service) === 1, 'B waits for A');
    await t.service.cancel(await t.fpOf(announce('Contoso')), 'tab-b');
    const b = await pb;
    expect(b).toMatchObject({ ok: false, kind: 'aborted' });
    release();
    expect(ok(await pa).classification).toEqual(noise());
    expect(t.fetchImpl).toHaveBeenCalledTimes(1);
    expect(t.fetchImpl.mock.calls[0]![1].signal!.aborted).toBe(false);
  });

  it('another sender cannot cancel the variant\'s wait', async () => {
    const t = setup();
    const release = t.hold('Northwind');
    const pa = t.ask(announce('Northwind'), 'tab-a');
    await until(() => t.fetchImpl.mock.calls.length === 1, 'A calls the model');
    const pb = t.ask(announce('Contoso'), 'tab-b');
    await until(() => waiting(t.service) === 1, 'B waits for A');
    await t.service.cancel(await t.fpOf(announce('Contoso')), 'tab-evil');
    release();
    await pa;
    expect(ok(await pb).repeatOf!.fp).toBe(await t.fpOf(announce('Northwind')));
  });

  it('if the waited-for request is cancelled by its own sender, the variant asks the model itself', async () => {
    const t = setup();
    t.hold('Northwind'); // never released: only cancellation ends it
    const pa = t.ask(announce('Northwind'), 'tab-a');
    await until(() => t.fetchImpl.mock.calls.length === 1, 'A calls the model');
    const pb = t.ask(announce('Contoso'), 'tab-b');
    await until(() => waiting(t.service) === 1, 'B waits for A');
    await t.service.cancel(await t.fpOf(announce('Northwind')), 'tab-a');
    expect(await pa).toMatchObject({ ok: false, kind: 'aborted' });
    const b = ok(await pb);
    expect(b.repeatOf).toBeUndefined();
    expect(b.classification).toEqual(noise());
    expect(t.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('cancelAll ends the request and every wait on it', async () => {
    const t = setup();
    t.hold('Northwind');
    const pa = t.ask(announce('Northwind'), 'tab-a');
    await until(() => t.fetchImpl.mock.calls.length === 1, 'A calls the model');
    const pb = t.ask(announce('Contoso'), 'tab-b');
    await until(() => waiting(t.service) === 1, 'B waits for A');
    t.service.cancelAll();
    expect(await pa).toMatchObject({ ok: false, kind: 'aborted' });
    expect(await pb).toMatchObject({ ok: false, kind: 'aborted' });
    expect(t.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('a waiting request never waits on itself or on a request for another model', async () => {
    const t = setup();
    const release = t.hold('Northwind');
    const pa = t.ask(announce('Northwind'));
    await until(() => t.fetchImpl.mock.calls.length === 1, 'A calls the model');
    await t.settings.save({ model: 'm2' });
    const pb = t.ask(announce('Contoso'));
    await until(() => t.fetchImpl.mock.calls.length === 2, 'B calls the model itself');
    expect(waiting(t.service)).toBe(0); // did not wait for the other model's request
    release();
    await Promise.all([pa, pb]);
    expect(ok(await pb).repeatOf).toBeUndefined();
  });
});

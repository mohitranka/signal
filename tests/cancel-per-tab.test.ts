/**
 * Security S7 (docs/design-security-s7.md): a content script's "cancel all" (its tab left the feed, or Signal was
 * switched off there) cancels only THAT tab's work. Requests another tab still waits for keep going. The global cancel
 * remains for Clear cache and model changes. Two tabs are two waiter ids; every cancel goes through the real handler.
 */
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { ClassifyService } from '../src/background/classifyService';
import { createHandler } from '../src/background/handlers';
import { RepeatIndex } from '../src/background/repeatIndex';
import { CacheStore, FeedbackStore, SettingsStore, StatsStore } from '../src/background/store';
import { PROMPT_VERSION } from '../src/classifier/prompt';
import { fingerprint, prepareInput } from '../src/shared/post';
import type { ClassifyResult } from '../src/shared/types';
import { announce } from './fixtures/templates';
import { chatResponse, gatedKV, memoryKV, modelJson, noise, until } from './helpers';

const TEXT = {
  a: 'Tab A post: a quarterly update about our hiring plans and the roles we are opening next month.',
  b: 'Tab B post: notes from a conference talk on database migrations, with the slides linked below.',
  x: 'Another post that is occupying the only request slot for a while, long enough to classify.',
  shared: 'A post both tabs show: the same reshare, visible in tab A and in tab B at the same time.',
};

async function setup(opts: { concurrency?: number; repeats?: boolean } = {}) {
  const g = gatedKV();
  const settings = new SettingsStore(g.kv);
  await settings.save({ model: 'm', apiKey: 'k', endpoint: 'https://api.example.com/v1', concurrency: opts.concurrency ?? 3 });
  const holds: { marker: string; released: boolean; waiting: (() => void)[] }[] = [];
  const signals: { body: string; signal: AbortSignal }[] = [];
  // Like real fetch: rejects with AbortError when its signal is aborted. Answers held while a hold matches.
  const fetchImpl = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((res, rej) => {
    const body = String(init.body);
    signals.push({ body, signal: init.signal! });
    init.signal?.addEventListener('abort', () => rej(new DOMException('The operation was aborted.', 'AbortError')));
    const answer = () => res(chatResponse(modelJson(noise())));
    const h = holds.find((x) => !x.released && body.includes(x.marker));
    if (h) h.waiting.push(answer);
    else answer();
  }));
  const cache = new CacheStore(g.kv, 2000, 60_000);
  const repeats = opts.repeats ? new RepeatIndex(g.kv, { persistDelayMs: 60_000 }) : undefined;
  const service = new ClassifyService({ loadSettings: () => settings.load(), cache, stats: new StatsStore(memoryKV()), ...(repeats ? { repeats } : {}), http: { fetchImpl: fetchImpl as any, sleep: async () => {}, maxRetries: 0 } });
  const handle = createHandler({ service, settings, cache, feedback: new FeedbackStore(g.kv), stats: new StatsStore(memoryKV()), ...(repeats ? { repeats } : {}), notifyTabs: vi.fn() });
  const classify = async (text: string, tab: string) => {
    const input = prepareInput({ text });
    return handle({ type: 'classify', fp: await fingerprint(input), input }, true, tab) as Promise<ClassifyResult>;
  };
  /** Fingerprint first, send later: `send` hands the request to the handler at once (finding I). */
  const prepare = async (text: string) => {
    const input = prepareInput({ text });
    return { input, fp: await fingerprint(input) };
  };
  const send = (p: { input: ReturnType<typeof prepareInput>; fp: string }, tab: string) =>
    handle({ type: 'classify', fp: p.fp, input: p.input }, true, tab) as Promise<ClassifyResult>;
  const keyOf = async (text: string) => `${PROMPT_VERSION}|m|${await fingerprint(prepareInput({ text }))}`;
  return {
    g, service, handle, classify, prepare, send, keyOf, fetchImpl, settings,
    /** Hold back answers for request bodies containing `marker` until release(). */
    hold: (marker: string) => {
      const h = { marker, released: false, waiting: [] as (() => void)[] };
      holds.push(h);
      return () => {
        h.released = true;
        h.waiting.splice(0).forEach((go) => go());
      };
    },
    signalFor: (marker: string) => signals.find((s) => s.body.includes(marker))?.signal,
    /** Tab leaves the feed: the content script's cancel all, sent from that tab. */
    leave: (tab: string) => handle({ type: 'cancelAll' }, true, tab),
    // Service internals, test-only (like the existing settled() helpers): who waits for what.
    waitersOf: async (text: string) => ((service as any).interest.get(await keyOf(text)) as Map<string, number> | undefined)?.size ?? 0,
    queued: () => (service as any).queue.pending.length as number,
    joined: () => [...((service as any).joins as Map<string, Map<string, unknown[]>>).values()].reduce((n, m) => n + [...m.values()].reduce((k, a) => k + a.length, 0), 0),
  };
}

/**
 * Finding I: fingerprints of posts containing `marker` (lower case, as fingerprinted) take 50 ms longer, in this test
 * only: the handler's fingerprint re-check is then still running when a cancel arrives, deterministically.
 */
function slowFingerprint(marker: string) {
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (alg: AlgorithmIdentifier, data: BufferSource) => {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (new TextDecoder().decode(bytes).includes(marker)) await new Promise((r) => setTimeout(r, 50));
    return digest(alg, data);
  });
  onTestFinished(() => spy.mockRestore());
}

describe("a tab's cancel all cancels only that tab's work (security S7)", () => {
  it('reproduction: tab A leaves while tab B waits for its result → tab B still gets it', async () => {
    const t = await setup();
    const release = t.hold('Tab B post');
    const b = t.classify(TEXT.b, 'tab-B');
    await until(() => t.fetchImpl.mock.calls.length === 1, "tab B's request in flight");
    await t.leave('tab-A');
    release();
    expect(await b).toMatchObject({ ok: true });
    expect(t.signalFor('Tab B post')!.aborted).toBe(false);
  });

  it("guard: tab A's own request (only A waits) is cancelled and its model call aborted", async () => {
    const t = await setup();
    t.hold('Tab A post');
    const a = t.classify(TEXT.a, 'tab-A');
    await until(() => t.fetchImpl.mock.calls.length === 1, "tab A's request in flight");
    await t.leave('tab-A');
    expect(await a).toMatchObject({ ok: false, kind: 'aborted' });
    expect(t.signalFor('Tab A post')!.aborted).toBe(true);
  });

  it('a request both tabs wait for keeps running for tab B when tab A leaves (one model call)', async () => {
    const t = await setup();
    const release = t.hold('both tabs show');
    const a = t.classify(TEXT.shared, 'tab-A');
    await until(() => t.fetchImpl.mock.calls.length === 1, 'shared request in flight');
    const b = t.classify(TEXT.shared, 'tab-B');
    await vi.waitFor(async () => expect(await t.waitersOf(TEXT.shared)).toBe(2));
    await t.leave('tab-A');
    release();
    expect(await a).toMatchObject({ ok: false, kind: 'aborted' });
    expect(await b).toMatchObject({ ok: true, cached: false });
    expect(t.fetchImpl).toHaveBeenCalledTimes(1);
    expect(t.signalFor('both tabs show')!.aborted).toBe(false);
  });

  it("queued requests: tab A's is dropped and never sent; tab B's still runs", async () => {
    const t = await setup({ concurrency: 1 });
    const releaseX = t.hold('occupying the only request slot');
    const x = t.classify(TEXT.x, 'tab-B');
    await until(() => t.fetchImpl.mock.calls.length === 1, 'slot taken');
    const a = t.classify(TEXT.a, 'tab-A');
    const b = t.classify(TEXT.b, 'tab-B');
    await until(() => t.queued() === 2, 'both queued');
    await t.leave('tab-A');
    releaseX();
    expect(await x).toMatchObject({ ok: true });
    expect(await a).toMatchObject({ ok: false, kind: 'aborted' });
    expect(await b).toMatchObject({ ok: true });
    expect(t.signalFor('Tab A post')).toBeUndefined(); // never sent
  });

  it("requests still being prepared: tab A's is refused (never sent); tab B's proceeds", async () => {
    const t = await setup();
    // Finding I: tab A's fingerprint is slower than tab B's (as under load), every run. The test must not depend on
    // which request reaches the cache first.
    slowFingerprint('tab a post');
    const release = t.g.hold('cache'); // both requests are reading the cache (the first load)
    // Both requests exist (handed to the handler in the same tick) before tab A leaves; fingerprints come first.
    const [pa, pb] = await Promise.all([t.prepare(TEXT.a), t.prepare(TEXT.b)]);
    const a = t.send(pa, 'tab-A');
    const b = t.send(pb, 'tab-B');
    await until(() => t.g.isBlocked('cache'), 'requests in preparation');
    await t.leave('tab-A');
    release();
    expect(await a).toMatchObject({ ok: false, kind: 'aborted' });
    expect(await b).toMatchObject({ ok: true });
    expect(t.signalFor('Tab A post')).toBeUndefined();
  });

  it('a shared queued task that tab A queued first still runs for tab B after A leaves', async () => {
    const t = await setup({ concurrency: 1 });
    const releaseX = t.hold('occupying the only request slot');
    const x = t.classify(TEXT.x, 'tab-C');
    await until(() => t.fetchImpl.mock.calls.length === 1, 'slot taken');
    const a = t.classify(TEXT.shared, 'tab-A'); // queued first: the task is created for tab A
    await until(() => t.queued() === 1, 'queued');
    const b = t.classify(TEXT.shared, 'tab-B'); // attaches to the same queued task
    await vi.waitFor(async () => expect(await t.waitersOf(TEXT.shared)).toBe(2));
    await t.leave('tab-A');
    releaseX();
    await x;
    expect(await a).toMatchObject({ ok: false, kind: 'aborted' });
    expect(await b).toMatchObject({ ok: true, cached: false });
    expect(t.fetchImpl).toHaveBeenCalledTimes(2); // x, then the shared post once
  });

  it("tab A's wait for a similar request ends; the request it waited on completes for tab B", async () => {
    const t = await setup({ repeats: true });
    const release = t.hold('Northwind');
    const b = t.classify(announce('Northwind'), 'tab-B');
    await until(() => t.fetchImpl.mock.calls.length === 1, "tab B's request in flight");
    const a = t.classify(announce('Contoso'), 'tab-A'); // similar: waits for B's verdict
    await until(() => t.joined() === 1, 'tab A waits for tab B');
    await t.leave('tab-A');
    expect(await a).toMatchObject({ ok: false, kind: 'aborted' });
    release();
    expect(await b).toMatchObject({ ok: true });
    expect(t.signalFor('Northwind')!.aborted).toBe(false);
  });

  it("an answer racing a tab's own cancel is stored (current settings, useful to others) but not returned to that tab", async () => {
    let answer!: () => void;
    const answered = new Promise<void>((r) => (answer = r));
    const t = await setup();
    // A provider that ignores the abort signal and answers anyway.
    t.fetchImpl.mockImplementation(async () => { await answered; return chatResponse(modelJson(noise())); });
    const a = t.classify(TEXT.a, 'tab-A');
    await until(() => t.fetchImpl.mock.calls.length === 1, "tab A's request in flight");
    await t.leave('tab-A');
    answer();
    expect(await a).toMatchObject({ ok: false, kind: 'aborted' });
    expect(await t.classify(TEXT.a, 'tab-B')).toMatchObject({ ok: true, cached: true }); // stored: no second model call
    expect(t.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('guard: Clear cache still cancels every tab', async () => {
    const t = await setup();
    t.hold('Tab A post');
    t.hold('Tab B post');
    const a = t.classify(TEXT.a, 'tab-A');
    const b = t.classify(TEXT.b, 'tab-B');
    await until(() => t.fetchImpl.mock.calls.length === 2, 'both in flight');
    await t.handle({ type: 'clearCache' }, false);
    expect(await a).toMatchObject({ ok: false, kind: 'aborted' });
    expect(await b).toMatchObject({ ok: false, kind: 'aborted' });
  });

  it('guard: a model change still cancels every tab', async () => {
    const t = await setup();
    t.hold('Tab A post');
    t.hold('Tab B post');
    const a = t.classify(TEXT.a, 'tab-A');
    const b = t.classify(TEXT.b, 'tab-B');
    await until(() => t.fetchImpl.mock.calls.length === 2, 'both in flight');
    await t.handle({ type: 'saveSettings', patch: { model: 'm2' } }, false);
    expect(await a).toMatchObject({ ok: false, kind: 'aborted' });
    expect(await b).toMatchObject({ ok: false, kind: 'aborted' });
  });

  it("guard: tab A's new requests after it left work normally", async () => {
    const t = await setup();
    await t.leave('tab-A');
    expect(await t.classify(TEXT.a, 'tab-A')).toMatchObject({ ok: true });
  });

  it('a content script cannot name another tab: extra fields are ignored, only the sender is cancelled', async () => {
    const t = await setup();
    const release = t.hold('Tab B post');
    const b = t.classify(TEXT.b, 'tab-B');
    await until(() => t.fetchImpl.mock.calls.length === 1, "tab B's request in flight");
    await t.handle({ type: 'cancelAll', waiter: 'tab-B', tab: 'tab-B' } as any, true, 'tab-A');
    release();
    expect(await b).toMatchObject({ ok: true });
  });
});

describe('a cancel reaches requests whose fingerprint the handler is still checking (finding I)', () => {
  it('a global cancel (Clear cache, model change): a request received before it never calls the model', async () => {
    const t = await setup();
    const pa = await t.prepare(TEXT.a);
    slowFingerprint('tab a post'); // the handler's re-check of this post takes 50 ms
    const a = t.send(pa, 'tab-A'); // received now
    await t.handle({ type: 'cancelAll' }, false, 'popup'); // arrives during the re-check
    expect(await a).toMatchObject({ ok: false, kind: 'aborted' });
    expect(t.fetchImpl).not.toHaveBeenCalled();
  });

  it("a tab's cancel all: its request received before it never calls the model; another tab's still runs", async () => {
    const t = await setup();
    const [pa, pb] = await Promise.all([t.prepare(TEXT.a), t.prepare(TEXT.b)]);
    slowFingerprint('tab a post');
    const a = t.send(pa, 'tab-A');
    const b = t.send(pb, 'tab-B');
    await t.leave('tab-A'); // during tab A's re-check
    expect(await a).toMatchObject({ ok: false, kind: 'aborted' });
    expect(await b).toMatchObject({ ok: true });
    expect(t.signalFor('Tab A post')).toBeUndefined();
  });

  it('without a cancel, the slow re-check changes nothing', async () => {
    const t = await setup();
    const pa = await t.prepare(TEXT.a);
    slowFingerprint('tab a post');
    expect(await t.send(pa, 'tab-A')).toMatchObject({ ok: true });
  });
});


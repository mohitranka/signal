/**
 * T7: message handlers and security for repeated templates. (Kept in its own file so that, before the feature
 * exists, a missing module fails only these tests and not the existing background/security suites.)
 */
import { describe, expect, it, vi } from 'vitest';
import { ClassifyService } from '../src/background/classifyService';
import { createHandler } from '../src/background/handlers';
import { RepeatIndex } from '../src/background/repeatIndex';
import { CacheStore, FeedbackStore, SettingsStore, StatsStore } from '../src/background/store';
import { PROMPT_VERSION } from '../src/classifier/prompt';
import { fingerprint, prepareInput } from '../src/shared/post';
import { PUBLIC_TEST_KEY, encodeKey, signature } from '../src/shared/similarity';
import { announce } from './fixtures/templates';
import { chatResponse, fpFor, memoryKV, modelJson, noise } from './helpers';

describe('handlers for repeated templates (T7)', () => {
  async function wired() {
    const kv = memoryKV();
    const settings = new SettingsStore(kv);
    const cache = new CacheStore(kv, 2000, 0);
    const stats = new StatsStore(memoryKV());
    const repeats = new RepeatIndex(kv, { persistDelayMs: 10 });
    const fetchImpl = vi.fn(async () => chatResponse(modelJson(noise())));
    const service = new ClassifyService({ loadSettings: () => settings.load(), cache, stats, repeats, http: { fetchImpl: fetchImpl as any, sleep: async () => {}, maxRetries: 0 } });
    const handle = createHandler({ service, settings, cache, feedback: new FeedbackStore(kv), stats, repeats, notifyTabs: vi.fn() });
    await settings.save({ model: 'm', apiKey: 'k', endpoint: 'https://api.example.com/v1' });
    const input = prepareInput({ text: announce() });
    const fp = await fingerprint(input);
    return { kv, repeats, service, handle, input, fp, sig: signature(input, PUBLIC_TEST_KEY)! };
  }

  it('forwards noRepeat only when it is exactly true', async () => {
    const t = await wired();
    const spy = vi.spyOn(t.service, 'classify');
    await t.handle({ type: 'classify', fp: t.fp, input: t.input, noRepeat: true }, true, 'tab-1');
    expect(spy.mock.calls[0]![3]).toEqual({ noRepeat: true, ticket: expect.objectContaining({ waiter: 'tab-1' }) }); // ticket: finding I
    for (const junk of ['true', 1, {}, 'yes']) {
      spy.mockClear();
      await t.handle({ type: 'classify', fp: t.fp, input: t.input, noRepeat: junk as any }, true, 'tab-1');
      expect(spy.mock.calls[0]![3]).toMatchObject({ noRepeat: false });
    }
    spy.mockClear();
    await t.handle({ type: 'classify', fp: t.fp, input: t.input }, true, 'tab-1');
    expect(spy.mock.calls[0]![3]).toMatchObject({ noRepeat: false });
  });

  it('"Clear cache" also clears the repeat index', async () => {
    const t = await wired();
    await t.repeats.add(`${PROMPT_VERSION}|m|${t.fp}`, t.sig);
    expect(await t.handle({ type: 'clearCache' }, false)).toEqual({ ok: true });
    expect(await t.repeats.size()).toBe(0);
  });

  it('statistics report how many judged posts the index holds', async () => {
    const t = await wired();
    await t.repeats.add(`${PROMPT_VERSION}|m|${t.fp}`, t.sig);
    const r = (await t.handle({ type: 'getStats' }, false)) as any;
    expect(r.repeatIndexSize).toBe(1);
    expect(r.stats.repeatHits).toBe(0);
  });

  it('the signature key never leaves the service worker: no message response contains it (security S2)', async () => {
    const t = await wired();
    const responses = [
      await t.handle({ type: 'classify', fp: t.fp, input: t.input }, true, 'tab-1'),
      await t.handle({ type: 'getState' }, true, 'tab-1'),
      await t.handle({ type: 'getSettings' }, false),
      await t.handle({ type: 'getStats' }, false),
      await t.handle({ type: 'listFeedback' }, false),
    ];
    const k = await t.repeats.key();
    const forms = [encodeKey(k), Buffer.from(k).toString('hex'), JSON.stringify(Array.from(k))];
    for (const r of responses) for (const f of forms) expect(JSON.stringify(r)).not.toContain(f);
    await t.repeats.flush();
    expect((t.kv.data['repeats:v3'] as { key: string }).key).toBe(encodeKey(k)); // kept only in local storage
  });

  it('a model result reached through the handler is indexed', async () => {
    const t = await wired();
    await t.handle({ type: 'classify', fp: t.fp, input: t.input }, true, 'tab-1');
    expect(await t.repeats.size()).toBe(1);
  });
});

describe('repeated templates: what a content script can and cannot do (T7)', () => {
  async function wired() {
    const kv = memoryKV();
    const settings = new SettingsStore(kv);
    const cache = new CacheStore(kv, 2000, 10);
    const stats = new StatsStore(memoryKV());
    const repeats = new RepeatIndex(kv, { persistDelayMs: 10 });
    const fetchImpl = vi.fn(async () => chatResponse(modelJson(noise())));
    const service = new ClassifyService({ loadSettings: () => settings.load(), cache, stats, repeats, http: { fetchImpl: fetchImpl as any, sleep: async () => {}, maxRetries: 0 } });
    const handle = createHandler({ service, settings, cache, feedback: new FeedbackStore(kv), stats, repeats, notifyTabs: vi.fn() });
    await settings.save({ model: 'm', apiKey: 'k', endpoint: 'https://api.example.com/v1' });
    return { repeats, handle, fetchImpl };
  }

  it('cannot clear the repeat index', async () => {
    const t = await wired();
    const input = prepareInput({ text: announce() });
    await t.repeats.add(`v|m|${await fingerprint(input)}`, signature(input, PUBLIC_TEST_KEY)!);
    expect(await t.handle({ type: 'clearCache' }, true)).toEqual({ error: 'forbidden' });
    expect(await t.repeats.size()).toBe(1);
  });

  it('cannot supply a signature or a repeatOf: the background computes and decides both', async () => {
    const t = await wired();
    const input = prepareInput({ text: announce('Northwind') });
    await t.handle({ type: 'classify', fp: await fingerprint(input), input }, true, 'tab-1');
    const other = prepareInput({ text: announce('Contoso') });
    const forged: any = { type: 'classify', fp: await fingerprint(other), input: other, signature: 'AAAA', repeatOf: { fp: fpFor('x'), similarity: 1 } };
    const r: any = await t.handle(forged, true, 'tab-1');
    expect(r.ok).toBe(true);
    expect(r.repeatOf.fp).toBe(await fingerprint(input)); // the real anchor, not the forged one
  });

  it('noRepeat can only cause what any new post causes: one model call, for that post', async () => {
    const t = await wired();
    const input = prepareInput({ text: announce() });
    const fp = await fingerprint(input);
    await t.handle({ type: 'classify', fp, input, noRepeat: true }, true, 'tab-1');
    await t.handle({ type: 'classify', fp, input, noRepeat: true }, true, 'tab-1');
    expect(t.fetchImpl).toHaveBeenCalledTimes(1); // the exact cache still answers a repeat of the same post
  });
});

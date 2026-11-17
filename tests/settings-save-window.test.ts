/**
 * Finding A2 (docs/design-finding-a2-save-window.md): while a save that touches the model, endpoint or key is being
 * written, no model call starts and no copy is handed out; afterwards, work from before a real change is refused.
 * From the moment the background receives the Save, nothing is sent with the replaced endpoint or key.
 *
 * The storage write of `settings` is held back (gatedKV.holdWrite) to park the save handler mid-save deterministically.
 */
import { describe, expect, it, vi } from 'vitest';
import { ClassifyService } from '../src/background/classifyService';
import { createHandler } from '../src/background/handlers';
import { RepeatIndex } from '../src/background/repeatIndex';
import { CacheStore, FeedbackStore, SettingsStore, StatsStore } from '../src/background/store';
import { fingerprint, prepareInput } from '../src/shared/post';
import type { ClassifyResult } from '../src/shared/types';
import { announce, lessons } from './fixtures/templates';
import { chatResponse, gatedKV, memoryKV, modelJson, noise, until } from './helpers';

const CLOUD = { endpoint: 'https://cloud.example.com/v1', apiKey: 'OLD-KEY' };
const LOCAL = { endpoint: 'http://localhost:11434/v1', apiKey: 'NEW-KEY' };

/** Requests waiting for a hold to end. Reads service internals: test-only (absent before the fix, hence `?? 0`). */
const parked = (s: ClassifyService) => ((s as any).waitingOnHold as number | undefined) ?? 0;
const tick = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

async function setup(opts: { repeats?: boolean; concurrency?: number; fetchImpl?: (url: string, init: RequestInit) => Promise<Response> } = {}) {
  const g = gatedKV();
  const settings = new SettingsStore(g.kv);
  const stats = new StatsStore(memoryKV());
  const sent: string[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    sent.push(`${url} ${(init.headers as Record<string, string>).Authorization ?? ''}`);
    return opts.fetchImpl ? opts.fetchImpl(url, init) : chatResponse(modelJson(noise()));
  });
  await settings.save({ model: 'm', ...CLOUD, concurrency: opts.concurrency ?? 3 });
  const cache = new CacheStore(g.kv, 2000, 10);
  const repeats = opts.repeats ? new RepeatIndex(g.kv, { persistDelayMs: 10 }) : undefined;
  const service = new ClassifyService({ loadSettings: () => settings.load(), cache, stats, ...(repeats ? { repeats } : {}), http: { fetchImpl: fetchImpl as any, sleep: async () => {}, maxRetries: 0 } });
  const handle = createHandler({ service, settings, cache, feedback: new FeedbackStore(g.kv), stats, ...(repeats ? { repeats } : {}), notifyTabs: vi.fn() });
  const classify = async (text: string) => {
    const input = prepareInput({ text });
    return handle({ type: 'classify', fp: await fingerprint(input), input }, true, 'tab-1') as Promise<ClassifyResult>;
  };
  /** Start a save and wait until it is parked at its storage write. */
  const saveParked = async (patch: Record<string, unknown>) => {
    const release = g.holdWrite('settings');
    const saving = handle({ type: 'saveSettings', patch }, false);
    await until(() => g.isWriteBlocked('settings'), 'save is writing');
    return { release, saving };
  };
  return { g, settings, stats, sent, fetchImpl, service, handle, classify, saveParked, cache };
}

const oldKey = (sent: string[]) => sent.filter((s) => s.includes('OLD-KEY'));

describe('no model call with replaced settings while a save is being written (finding A2)', () => {
  it('a request that starts during a save changing endpoint and key is never sent with the old key', async () => {
    const t = await setup();
    const { release, saving } = await t.saveParked(LOCAL);
    const pending = t.classify(announce());
    await until(() => t.fetchImpl.mock.calls.length > 0 || parked(t.service) > 0, 'request sent or held');
    release();
    await saving;
    expect(await pending).toMatchObject({ ok: false, kind: 'aborted' });
    expect(oldKey(t.sent)).toEqual([]);
  });

  it('a queued request that gets its slot during the save is not sent with the old key', async () => {
    let answerFirst!: () => void;
    const firstAnswered = new Promise<void>((r) => (answerFirst = r));
    const t = await setup({
      concurrency: 1,
      fetchImpl: async (_u, init) => {
        if (String(init.body).includes('thrilled to announce')) await firstAnswered;
        return chatResponse(modelJson(noise()));
      },
    });
    const first = t.classify(announce()); // sent before the Save: legitimate
    await until(() => t.fetchImpl.mock.calls.length === 1, 'first request in flight');
    const queued = t.classify(lessons());
    await until(() => (t.service as any).queue.pending.length === 1, 'second request queued'); // internals: test-only
    const { release, saving } = await t.saveParked(LOCAL);
    answerFirst(); // the slot frees up during the save
    await first;
    await until(() => t.fetchImpl.mock.calls.length > 1 || parked(t.service) > 0, 'queued request sent or held');
    release();
    await saving;
    expect(await queued).toMatchObject({ ok: false, kind: 'aborted' });
    expect(oldKey(t.sent)).toHaveLength(1); // only the one sent before the Save arrived
  });

  it('no copied verdict is handed out during a model change', async () => {
    const t = await setup({ repeats: true });
    expect(await t.classify(announce('Northwind'))).toMatchObject({ ok: true }); // the anchor, under model "m"
    const { release, saving } = await t.saveParked({ model: 'm2', ...CLOUD });
    let answered = false;
    const pending = t.classify(announce('Contoso')).finally(() => (answered = true));
    await until(() => answered || parked(t.service) > 0, 'copy returned or held');
    release();
    await saving;
    expect(await pending).toMatchObject({ ok: false, kind: 'aborted' });
    expect((await t.stats.get()).repeatHits).toBe(0);
  });

  it('a save that changes nothing relevant lets held requests continue afterwards, sent once', async () => {
    const t = await setup();
    const { release, saving } = await t.saveParked({ ...CLOUD, model: 'm', inputPricePerM: 1 });
    const pending = t.classify(announce());
    await until(() => t.fetchImpl.mock.calls.length > 0 || parked(t.service) > 0, 'request sent or held');
    release();
    await saving;
    expect(await pending).toMatchObject({ ok: true, cached: false });
    expect(t.sent).toEqual(['https://cloud.example.com/v1/chat/completions Bearer OLD-KEY']);
  });

  it('a toggle (mode only) holds nothing: a request during its write goes out at once', async () => {
    const t = await setup();
    const { release, saving } = await t.saveParked({ mode: 'active' });
    const pending = t.classify(announce());
    await until(() => t.fetchImpl.mock.calls.length === 1, 'request sent while the toggle is still being written');
    expect(t.g.isWriteBlocked('settings')).toBe(true);
    release();
    await saving;
    expect(await pending).toMatchObject({ ok: true });
  });

  it('a failed save releases the hold: the request continues with the unchanged settings', async () => {
    const t = await setup();
    t.g.kv.failNextWrite = true;
    const { release, saving } = await t.saveParked(LOCAL);
    const pending = t.classify(announce());
    await until(() => t.fetchImpl.mock.calls.length > 0 || parked(t.service) > 0, 'request sent or held');
    release();
    await expect(saving).rejects.toThrow(/quota/i);
    expect(await pending).toMatchObject({ ok: true });
    expect(t.sent).toEqual(['https://cloud.example.com/v1/chat/completions Bearer OLD-KEY']); // still the stored settings
    expect(parked(t.service)).toBe(0);
  });

  it('overlapping holds: calls stay held until the last one is released', async () => {
    const t = await setup();
    const r1 = t.service.hold();
    const r2 = t.service.hold();
    const pending = t.classify(announce());
    await until(() => parked(t.service) === 1, 'request held');
    r1();
    await tick();
    expect(t.fetchImpl).not.toHaveBeenCalled();
    expect(parked(t.service)).toBe(1);
    r2();
    expect(await pending).toMatchObject({ ok: true });
    expect(t.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("releasing the same hold twice does not end another holder's hold", async () => {
    const t = await setup();
    const r1 = t.service.hold();
    const r2 = t.service.hold();
    const pending = t.classify(announce());
    await until(() => parked(t.service) === 1, 'request held');
    r1();
    r1();
    await tick();
    expect(t.fetchImpl).not.toHaveBeenCalled();
    r2();
    expect(await pending).toMatchObject({ ok: true });
  });

  it('a held request whose sender cancelled it meanwhile is not started when the hold ends', async () => {
    const t = await setup();
    const release = t.service.hold();
    const input = prepareInput({ text: announce() });
    const fp = await fingerprint(input);
    const pending = t.handle({ type: 'classify', fp, input }, true, 'tab-1') as Promise<ClassifyResult>;
    await until(() => parked(t.service) === 1, 'request held');
    await t.handle({ type: 'cancel', fp }, true, 'tab-1'); // its post's text grew: not needed any more
    release();
    expect(await pending).toMatchObject({ ok: false, kind: 'aborted' });
    expect(t.fetchImpl).not.toHaveBeenCalled();
  });

  it('an exact cache hit during a model-change save is answered at once', async () => {
    const t = await setup();
    expect(await t.classify(announce())).toMatchObject({ ok: true, cached: false });
    const { release, saving } = await t.saveParked(LOCAL);
    expect(await t.classify(announce())).toMatchObject({ ok: true, cached: true });
    expect(t.g.isWriteBlocked('settings')).toBe(true); // answered while the save was still being written
    release();
    await saving;
  });
});

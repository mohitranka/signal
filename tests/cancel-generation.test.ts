/**
 * Finding A (docs/design-finding-a-cancel-all.md): "cancel all" must stop every request that started before it,
 * at any stage: not only those already queued, running or waiting for a similar request. In particular, a post is
 * never sent with an endpoint or key the user has just replaced.
 *
 * Storage reads of chosen keys are held back (gatedKV) so a request can be parked deterministically between "read the
 * settings" and "enqueue the model call", while cancel all is triggered through the real message handler.
 */
import { describe, expect, it, vi } from 'vitest';
import { ClassifyService } from '../src/background/classifyService';
import { createHandler } from '../src/background/handlers';
import { RepeatIndex } from '../src/background/repeatIndex';
import { CacheStore, FeedbackStore, SettingsStore, StatsStore } from '../src/background/store';
import { PROMPT_VERSION } from '../src/classifier/prompt';
import { fingerprint, prepareInput } from '../src/shared/post';
import type { ClassifyResult } from '../src/shared/types';
import { announce } from './fixtures/templates';
import { chatResponse, gatedKV, memoryKV, modelJson, noise, until } from './helpers';

const CLOUD = { endpoint: 'https://cloud.example.com/v1', apiKey: 'OLD-KEY' };
const LOCAL = { endpoint: 'http://localhost:11434/v1', apiKey: 'NEW-KEY' };

async function setup(opts: { repeats?: boolean; fetchImpl?: (url: string, init: RequestInit) => Promise<Response> } = {}) {
  const g = gatedKV();
  const settings = new SettingsStore(g.kv);
  const stats = new StatsStore(memoryKV());
  const sent: string[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    sent.push(`${url} ${(init.headers as Record<string, string>).Authorization ?? ''}`);
    return opts.fetchImpl ? opts.fetchImpl(url, init) : chatResponse(modelJson(noise()));
  });
  await settings.save({ model: 'm', ...CLOUD });
  /** A fresh set of stores and service on the same storage, like a restarted service worker. */
  const boot = () => {
    const cache = new CacheStore(g.kv, 2000, 10);
    const repeats = opts.repeats ? new RepeatIndex(g.kv, { persistDelayMs: 10 }) : undefined;
    const service = new ClassifyService({ loadSettings: () => settings.load(), cache, stats, ...(repeats ? { repeats } : {}), http: { fetchImpl: fetchImpl as any, sleep: async () => {}, maxRetries: 0 } });
    const handle = createHandler({ service, settings, cache, feedback: new FeedbackStore(g.kv), stats, ...(repeats ? { repeats } : {}), notifyTabs: vi.fn() });
    return { cache, repeats, service, handle };
  };
  const classify = async (handle: ReturnType<typeof boot>['handle'], text: string) => {
    const input = prepareInput({ text });
    return handle({ type: 'classify', fp: await fingerprint(input), input }, true, 'tab-1') as Promise<ClassifyResult>;
  };
  return { g, settings, stats, sent, fetchImpl, boot, classify };
}

describe('cancel all stops requests still being prepared (finding A)', () => {
  it('saving a new endpoint and key: nothing is sent to the old endpoint with the old key', async () => {
    const t = await setup();
    const { handle } = t.boot();
    const release = t.g.hold('cache');
    const pending = t.classify(handle, announce());
    await until(() => t.g.isBlocked('cache'), 'request is reading the cache (settings already read)');
    await handle({ type: 'saveSettings', patch: LOCAL }, false);
    release();
    expect(await pending).toMatchObject({ ok: false, kind: 'aborted' });
    expect(t.sent).toEqual([]);
    expect((await t.stats.get()).failures).toBe(0);
  });

  it('the same during the repeat lookup', async () => {
    const t = await setup({ repeats: true });
    const { handle, cache } = t.boot();
    await cache.size(); // cache loaded: the request gets past it at once
    const release = t.g.hold('repeats:v1');
    const pending = t.classify(handle, announce());
    await until(() => t.g.isBlocked('repeats:v1'), 'request is in the repeat lookup');
    await handle({ type: 'saveSettings', patch: LOCAL }, false);
    release();
    expect(await pending).toMatchObject({ ok: false, kind: 'aborted' });
    expect(t.sent).toEqual([]);
  });

  it('"Clear cache" while a request is being prepared: no model call', async () => {
    const t = await setup({ repeats: true });
    const { handle } = t.boot();
    const release = t.g.hold('cache');
    const pending = t.classify(handle, announce());
    await until(() => t.g.isBlocked('cache'), 'request is reading the cache');
    await handle({ type: 'clearCache' }, false);
    release();
    expect(await pending).toMatchObject({ ok: false, kind: 'aborted' });
    expect(t.fetchImpl).not.toHaveBeenCalled();
  });

  it('the feed stopping (content cancelAll) while a request is being prepared: no model call', async () => {
    const t = await setup();
    const { handle } = t.boot();
    const release = t.g.hold('cache');
    const pending = t.classify(handle, announce());
    await until(() => t.g.isBlocked('cache'), 'request is reading the cache');
    await handle({ type: 'cancelAll' }, true, 'tab-1'); // this tab's feed stopped (S7: a tab cancels only its own work)
    release();
    expect(await pending).toMatchObject({ ok: false, kind: 'aborted' });
    expect(t.fetchImpl).not.toHaveBeenCalled();
  });

  it('a task is never started for a request from before cancel all (check when the queue starts it)', async () => {
    const t = await setup();
    const { handle, service } = t.boot();
    // Force cancel all into the gap between "enqueue" and "start". Reads service internals: test-only.
    const q = (service as any).queue;
    const run = q.run.bind(q);
    q.run = (key: string, task: (s: AbortSignal) => Promise<unknown>) => {
      service.cancelAll();
      return run(key, task);
    };
    expect(await t.classify(handle, announce())).toMatchObject({ ok: false, kind: 'aborted' });
    expect(t.fetchImpl).not.toHaveBeenCalled();
  });

  it('no copied verdict is handed out after cancel all', async () => {
    const t = await setup({ repeats: true });
    const first = t.boot();
    await t.classify(first.handle, announce('Northwind')); // the anchor: judged, cached, indexed
    await first.cache.flush();
    await first.repeats!.flush();
    const { handle } = t.boot(); // restarted worker: the index is read from storage again
    const release = t.g.hold('repeats:v1');
    const pending = t.classify(handle, announce('Contoso'));
    await until(() => t.g.isBlocked('repeats:v1'), 'variant is in the repeat lookup');
    await handle({ type: 'cancelAll' }, true, 'tab-1'); // this tab's feed stopped (S7: a tab cancels only its own work)
    release();
    expect(await pending).toMatchObject({ ok: false, kind: 'aborted' });
    expect((await t.stats.get()).repeatHits).toBe(0);
  });

  it('an answer that races the abort is neither stored nor returned', async () => {
    let answer!: () => void;
    const answered = new Promise<void>((r) => (answer = r));
    // A provider (or proxy) that ignores the abort signal and answers anyway.
    const t = await setup({ repeats: true, fetchImpl: async () => { await answered; return chatResponse(modelJson(noise())); } });
    const { handle, cache, repeats } = t.boot();
    const pending = t.classify(handle, announce());
    await until(() => t.fetchImpl.mock.calls.length === 1, 'model call in flight');
    // A global cancel: the settings the answer was made under are replaced. (Since security S7 a tab's own cancel all
    // is not global; its raced answer is stored, see tests/cancel-per-tab.test.ts.)
    await handle({ type: 'saveSettings', patch: LOCAL }, false);
    answer();
    expect(await pending).toMatchObject({ ok: false, kind: 'aborted' });
    expect(await cache.size()).toBe(0);
    expect(await repeats!.size()).toBe(0);
  });

  it('a request made after cancel all never attaches to an aborted request that is still running', async () => {
    let answer!: () => void;
    const answered = new Promise<void>((r) => (answer = r));
    const t = await setup({ fetchImpl: async () => { await answered; return chatResponse(modelJson(noise())); } });
    const { handle } = t.boot();
    const before = t.classify(handle, announce());
    await until(() => t.fetchImpl.mock.calls.length === 1, 'first model call in flight');
    await handle({ type: 'saveSettings', patch: LOCAL }, false);
    const after = t.classify(handle, announce()); // same post, new settings
    await until(() => t.fetchImpl.mock.calls.length === 2, 'the new request makes its own call');
    answer();
    expect(await before).toMatchObject({ ok: false, kind: 'aborted' });
    expect(await after).toMatchObject({ ok: true, cached: false });
    expect(t.sent[1]).toBe('http://localhost:11434/v1/chat/completions Bearer NEW-KEY');
  });

  it('an exact cache hit is still answered (reading a stored verdict sends nothing)', async () => {
    const t = await setup();
    const first = t.boot();
    await t.classify(first.handle, announce());
    await first.cache.flush();
    const { handle } = t.boot();
    const release = t.g.hold('cache');
    const pending = t.classify(handle, announce());
    await until(() => t.g.isBlocked('cache'), 'request is reading the cache');
    await handle({ type: 'cancelAll' }, true, 'tab-1'); // this tab's feed stopped (S7: a tab cancels only its own work)
    release();
    expect(await pending).toMatchObject({ ok: true, cached: true });
    expect(t.fetchImpl).toHaveBeenCalledTimes(1); // only the first, before cancel all
  });

  it('requests made after the save go to the new endpoint with the new key', async () => {
    const t = await setup();
    const { handle } = t.boot();
    await handle({ type: 'saveSettings', patch: LOCAL }, false);
    expect(await t.classify(handle, announce())).toMatchObject({ ok: true, cached: false, promptVersion: PROMPT_VERSION });
    expect(t.sent).toEqual(['http://localhost:11434/v1/chat/completions Bearer NEW-KEY']);
  });
});

/**
 * Cancelling a request made obsolete by a post's text growing: `cancel {fp}` from the content script.
 * A request is dropped (queued) or aborted (in flight) only when nobody else still waits for it.
 */
import { describe, expect, it, vi } from 'vitest';
import { ClassifyService } from '../src/background/classifyService';
import { createHandler } from '../src/background/handlers';
import { CacheStore, FeedbackStore, SettingsStore, StatsStore } from '../src/background/store';
import { PROMPT_VERSION } from '../src/classifier/prompt';
import { AbortedError, TaskQueue } from '../src/classifier/queue';
import { fingerprint, prepareInput } from '../src/shared/post';
import { chatResponse, gem, memoryKV, modelJson } from './helpers';

describe('TaskQueue.release (waiter counting)', () => {
  it('a queued request with a single waiter is dropped without ever starting', async () => {
    const q = new TaskQueue(1);
    let releaseFirst!: () => void;
    const first = q.run('a', () => new Promise<string>((r) => (releaseFirst = () => r('a'))));
    const task = vi.fn(async () => 'b');
    const second = q.run('b', task);
    q.release('b');
    await expect(second).rejects.toBeInstanceOf(AbortedError);
    releaseFirst();
    await expect(first).resolves.toBe('a');
    await new Promise((r) => setTimeout(r, 0));
    expect(task).not.toHaveBeenCalled();
  });

  it('an in-flight request with a single waiter is aborted', async () => {
    const q = new TaskQueue(1);
    let seen: AbortSignal | undefined;
    const p = q.run('a', (signal) => {
      seen = signal;
      return new Promise((_, rej) => signal.addEventListener('abort', () => rej(new AbortedError())));
    });
    q.release('a');
    await expect(p).rejects.toBeInstanceOf(AbortedError);
    expect(seen!.aborted).toBe(true);
  });

  it('a request with two waiters keeps running when one of them lets go', async () => {
    const q = new TaskQueue(1);
    let signal: AbortSignal | undefined;
    let finish!: (v: string) => void;
    const task = (s: AbortSignal) => { signal = s; return new Promise<string>((r) => (finish = r)); };
    const one = q.run('a', task);
    const two = q.run('a', task); // deduplicated: same request, second waiter
    q.release('a');
    expect(signal!.aborted).toBe(false);
    finish('done');
    await expect(one).resolves.toBe('done');
    await expect(two).resolves.toBe('done');
  });

  it('releasing an unknown or finished key does nothing', async () => {
    const q = new TaskQueue(1);
    await q.run('a', async () => 1);
    expect(() => q.release('a')).not.toThrow();
    expect(() => q.release('never')).not.toThrow();
  });
});

describe('cancel {fp} message', () => {
  function setup() {
    const kv = memoryKV();
    const settings = new SettingsStore(kv);
    const cache = new CacheStore(kv, 2000, 10);
    const stats = new StatsStore(memoryKV());
    const gates: (() => void)[] = [];
    // Like real fetch: rejects with AbortError when its signal is aborted.
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((res, rej) => {
      gates.push(() => res(chatResponse(modelJson(gem()))));
      init?.signal?.addEventListener('abort', () => rej(new DOMException('The operation was aborted.', 'AbortError')));
    }));
    const service = new ClassifyService({ loadSettings: () => settings.load(), cache, stats, http: { fetchImpl: fetchImpl as any, sleep: async () => {}, maxRetries: 0 } });
    const handle = createHandler({ service, settings, cache, feedback: new FeedbackStore(kv), stats, notifyTabs: vi.fn() });
    const ready = settings.save({ model: 'm', apiKey: 'k', endpoint: 'https://api.example.com/v1', concurrency: 1 });
    const classify = async (text: string) => {
      const input = { text };
      return handle({ type: 'classify', fp: await fingerprint(prepareInput(input)), input }, true);
    };
    /** Wait until the background queue holds `n` requests with `waiters` callers on the given text (no fixed delays). */
    const queued = (n: number, waiters?: { text: string; count: number }) =>
      vi.waitFor(async () => {
        const q = (service as any).queue;
        expect(q.size).toBe(n);
        if (waiters) {
          const fp = await fingerprint(prepareInput({ text: waiters.text }));
          expect(q.byKey.get(`${PROMPT_VERSION}|m|${fp}`)?.waiters).toBe(waiters.count);
        }
      }, { timeout: 3000, interval: 5 });
    return { handle, fetchImpl, gates, ready, classify, queued };
  }
  const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };

  it('is part of the content-script API, and checks the fingerprint format', async () => {
    const t = setup();
    await t.ready;
    expect(await t.handle({ type: 'cancel', fp: '0'.repeat(32) }, true)).toEqual({ ok: true });
    expect(await t.handle({ type: 'cancel', fp: 'not-a-fingerprint' } as any, true)).toEqual({ error: 'bad fingerprint' });
  });

  it('a queued request that is cancelled is never sent', async () => {
    const t = setup();
    await t.ready;
    const first = t.classify('The first post, long enough to be classified.'); // takes the only slot
    await t.queued(1);
    const second = t.classify('The cut-off text of a post that was then expanded.');
    await t.queued(2); // the second one is queued behind the first
    await vi.waitFor(() => expect(t.fetchImpl).toHaveBeenCalledTimes(1));
    await t.handle({ type: 'cancel', fp: await fingerprint(prepareInput({ text: 'The cut-off text of a post that was then expanded.' })) }, true);
    expect(await second).toMatchObject({ ok: false, kind: 'aborted' });
    t.gates[0]!();
    expect(await first).toMatchObject({ ok: true });
    await flush();
    expect(t.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('a request another tab still waits for is not cancelled', async () => {
    const t = setup();
    await t.ready;
    const text = 'The same cut-off text, open in two LinkedIn tabs.';
    const tabA = t.classify(text);
    const tabB = t.classify(text); // same request, second waiter
    await t.queued(1, { text, count: 2 });
    await vi.waitFor(() => expect(t.gates).toHaveLength(1));
    await t.handle({ type: 'cancel', fp: await fingerprint(prepareInput({ text })) }, true); // tab A expanded its post
    t.gates[0]!();
    expect(await tabB).toMatchObject({ ok: true });
    expect(await tabA).toMatchObject({ ok: true }); // tab A ignores it (its post moved on); nothing was wasted
    expect(t.fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('E3: interest in a request is tracked per sender', () => {
  function setup() {
    const kv = memoryKV();
    const settings = new SettingsStore(kv);
    const cache = new CacheStore(kv, 2000, 10);
    const stats = new StatsStore(memoryKV());
    const gates: (() => void)[] = [];
    // Like real fetch: rejects with AbortError when its signal is aborted.
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((res, rej) => {
      gates.push(() => res(chatResponse(modelJson(gem()))));
      init?.signal?.addEventListener('abort', () => rej(new DOMException('The operation was aborted.', 'AbortError')));
    }));
    const service = new ClassifyService({ loadSettings: () => settings.load(), cache, stats, http: { fetchImpl: fetchImpl as any, sleep: async () => {}, maxRetries: 0 } });
    const handle = createHandler({ service, settings, cache, feedback: new FeedbackStore(kv), stats, notifyTabs: vi.fn() });
    const ready = settings.save({ model: 'm', apiKey: 'k', endpoint: 'https://api.example.com/v1', concurrency: 1 });
    const fpOf = (text: string) => fingerprint(prepareInput({ text }));
    const classify = async (text: string, sender: string) => handle({ type: 'classify', fp: await fpOf(text), input: { text } }, true, sender);
    const cancel = async (text: string, sender: string) => handle({ type: 'cancel', fp: await fpOf(text) }, true, sender);
    const queue = () => (service as any).queue;
    return { fetchImpl, gates, ready, classify, cancel, queue, fpOf };
  }

  it("one tab's repeated cancels do not drop another tab's interest", async () => {
    const t = setup();
    await t.ready;
    const text = 'The same post, open in two LinkedIn tabs at once.';
    const a = t.classify(text, 'tab:1:0');
    const b = t.classify(text, 'tab:2:0');
    await vi.waitFor(() => expect(t.gates).toHaveLength(1));
    for (let i = 0; i < 5; i++) await t.cancel(text, 'tab:1:0');
    t.gates[0]!();
    expect(await b).toMatchObject({ ok: true });
    expect(await a).toMatchObject({ ok: true });
    expect(t.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('a cancel for a request this sender never asked for does nothing', async () => {
    const t = setup();
    await t.ready;
    const text = 'Only tab two asked for this post to be classified.';
    const b = t.classify(text, 'tab:2:0');
    await vi.waitFor(() => expect(t.gates).toHaveLength(1));
    await t.cancel(text, 'tab:1:0');
    t.gates[0]!();
    expect(await b).toMatchObject({ ok: true });
  });

  it("the last interested sender's cancel still drops a queued request (never sent)", async () => {
    const t = setup();
    await t.ready;
    const first = t.classify('The first post, long enough to be classified.', 'tab:1:0'); // occupies the only slot
    await vi.waitFor(() => expect(t.gates).toHaveLength(1));
    const text = 'A cut-off post that tab one then expanded.';
    const queued = t.classify(text, 'tab:1:0');
    await vi.waitFor(() => expect(t.queue().size).toBe(2));
    await t.cancel(text, 'tab:1:0');
    expect(await queued).toMatchObject({ ok: false, kind: 'aborted' });
    t.gates[0]!();
    await first;
    await new Promise((r) => setTimeout(r, 0));
    expect(t.fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('waiterIdOf(sender)', () => {
  it('identifies a content script by tab and frame, an extension page by its URL, and falls back safely', async () => {
    const { waiterIdOf } = await import('../src/background/sender');
    expect(waiterIdOf({ tab: { id: 7 } as chrome.tabs.Tab, frameId: 0, url: 'https://www.linkedin.com/feed/' })).toBe('tab:7:0');
    expect(waiterIdOf({ tab: { id: 7 } as chrome.tabs.Tab, frameId: 3 })).toBe('tab:7:3');
    expect(waiterIdOf({ url: 'chrome-extension://me/popup.html' })).toBe('page:chrome-extension://me/popup.html');
    expect(waiterIdOf({})).toBe('unknown');
  });
});

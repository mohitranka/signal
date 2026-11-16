import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('../src/content/controller');
});

describe('content/index', () => {
  let ctl: any;
  let listener: (m: any, s: any, r: (v: unknown) => void) => boolean;
  let sendMessage: ReturnType<typeof vi.fn>;
  let navListener: (() => void) | undefined;

  async function boot(path: string) {
    ctl = {
      start: vi.fn(async () => {}), stop: vi.fn(), scan: vi.fn(),
      onSettingsChanged: vi.fn(async () => {}), pageStats: vi.fn(() => ({ classified: 1 })),
    };
    let deps: any;
    vi.doMock('../src/content/controller', () => ({
      FeedController: class { constructor(d: any) { deps = d; return ctl; } },
    }));
    sendMessage = vi.fn(async () => 'ok');
    vi.stubGlobal('chrome', { runtime: { sendMessage, onMessage: { addListener: (f: any) => (listener = f) } } });
    navListener = undefined;
    (globalThis as any).navigation = { addEventListener: (_: string, f: () => void) => (navListener = f) };
    history.replaceState({}, '', path);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    await import('../src/content/index');
    await vi.advanceTimersByTimeAsync(0);
    return deps;
  }

  afterEach(() => { delete (globalThis as any).navigation; });

  it('starts on the feed, forwards messages and answers runtime messages', async () => {
    const deps = await boot('/feed/');
    expect(ctl.start).toHaveBeenCalledTimes(1);
    expect(deps.shouldRun()).toBe(true);
    await expect(deps.send({ type: 'x' })).resolves.toBe('ok');

    listener({ type: 'settingsChanged' }, {}, vi.fn());
    expect(ctl.onSettingsChanged).toHaveBeenCalled();
    const respond = vi.fn();
    expect(listener({ type: 'getPageStats' }, {}, respond)).toBe(false);
    expect(respond).toHaveBeenCalledWith({ classified: 1 });
    const other = vi.fn();
    listener({ type: 'other' }, {}, other);
    expect(other).not.toHaveBeenCalled();
  });

  it('does not start off the feed, then starts, rescans and stops on navigation', async () => {
    await boot('/jobs/');
    expect(ctl.start).not.toHaveBeenCalled();

    history.replaceState({}, '', '/feed/');
    navListener!();
    await flush();
    expect(ctl.start).toHaveBeenCalledTimes(1);

    history.replaceState({}, '', '/feed');
    await vi.advanceTimersByTimeAsync(1000); // polling fallback
    expect(ctl.scan).toHaveBeenCalledTimes(1);

    navListener!(); // unchanged href: ignored
    expect(ctl.scan).toHaveBeenCalledTimes(1);

    history.replaceState({}, '', '/in/someone');
    navListener!();
    expect(ctl.stop).toHaveBeenCalledTimes(1);
  });
});

describe('service-worker', () => {
  const POPUP = { id: 'me', url: 'chrome-extension://me/popup.html', origin: 'chrome-extension://me' };
  it('wires message handling, tab notification and suspend flush', async () => {
    const area = () => {
      const m: Record<string, unknown> = {};
      return {
        get: vi.fn(async (k: string) => (k in m ? { [k]: m[k] } : {})),
        set: vi.fn(async (i: Record<string, unknown>) => void Object.assign(m, i)),
        remove: vi.fn(async (k: string) => void delete m[k]),
        setAccessLevel: vi.fn(async () => {}),
      };
    };
    let onMsg: any;
    let onSuspend: any;
    const local = area();
    const chromeMock = {
      storage: { local, session: area() },
      runtime: { id: 'me', getURL: (p: string) => `chrome-extension://me/${p}`, onMessage: { addListener: (f: any) => (onMsg = f) }, onSuspend: { addListener: (f: any) => (onSuspend = f) } },
      tabs: {
        query: vi.fn(async () => [{ id: 5 }, {}]),
        sendMessage: vi.fn(() => Promise.reject(new Error('gone'))),
      },
    };
    vi.stubGlobal('chrome', chromeMock);
    vi.resetModules();
    await import('../src/background/service-worker');
    expect(local.setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });

    // foreign sender is ignored
    expect(onMsg({ type: 'getSettings' }, { id: 'evil' }, vi.fn())).toBe(false);

    // F2: an extension page is trusted whether or not it sits in a tab; a content script (or a sender with no URL) is not
    const inTab = vi.fn();
    onMsg({ type: 'getSettings' }, { ...POPUP, tab: { id: 3 } }, inTab);
    await flush();
    expect(inTab).toHaveBeenCalledWith(expect.objectContaining({ mode: expect.any(String) }));
    for (const sender of [{ id: 'me', tab: { id: 3 }, url: 'https://www.linkedin.com/feed/', origin: 'https://www.linkedin.com' }, { id: 'me' }]) {
      const refused = vi.fn();
      onMsg({ type: 'getSettings' }, sender, refused);
      await flush();
      expect(refused).toHaveBeenCalledWith({ error: 'forbidden' });
    }

    const res = vi.fn();
    expect(onMsg({ type: 'getSettings' }, POPUP, res)).toBe(true);
    await flush();
    expect(res).toHaveBeenCalledWith(expect.objectContaining({ mode: expect.any(String) }));

    // saving settings notifies LinkedIn tabs; a failing tab send is swallowed
    const saved = vi.fn();
    onMsg({ type: 'saveSettings', patch: { enabled: false } }, POPUP, saved);
    await flush();
    expect(saved).toHaveBeenCalled();
    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(5, { type: 'settingsChanged' });

    // handler errors become { error }
    const bad = vi.fn();
    onMsg({ type: 'nope' }, POPUP, bad);
    await flush();
    expect(bad).toHaveBeenCalled();

    // tab query failure is swallowed
    chromeMock.tabs.query.mockRejectedValueOnce(new Error('x'));
    onMsg({ type: 'saveSettings', patch: { enabled: true } }, POPUP, vi.fn());
    await flush();

    onSuspend();
  });
});

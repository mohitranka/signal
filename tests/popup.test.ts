import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const html = readFileSync('public/popup.html', 'utf8');
const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[^>]*><\/script>/, '');

const settings = {
  enabled: true, mode: 'active', sensitivity: 'strict', highlight: true,
  endpoint: 'https://openrouter.ai/api/v1', model: 'm', hasApiKey: true,
  concurrency: 3, timeoutMs: 30000, inputPricePerM: 1, outputPricePerM: 2,
};
const stats = { classified: 2, httpRequests: 3, failures: 1, cacheHits: 4, promptTokens: 1000, completionTokens: 500, totalLatencyMs: 300 };

const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };
const $ = (id: string) => document.getElementById(id) as any;

let sent: any[];
let handlers: Record<string, (m: any) => any>;
let chromeMock: any;

function setup(over: Record<string, (m: any) => any> = {}, tabs: any[] = [{ id: 1, url: 'https://www.linkedin.com/feed/' }]) {
  sent = [];
  handlers = {
    getSettings: () => settings,
    saveSettings: (m) => ({ ...settings, ...m.patch, hasApiKey: true }),
    getStats: () => ({ stats, cacheSize: 7, prices: { input: 1, output: 2 } }),
    listFeedback: () => ({
      a: { verdict: 'keep', sample: 'good  post', at: 2, modelDecision: 'keep', modelConfidence: 0.9 },
      b: { verdict: 'collapse', sample: 'x'.repeat(100), at: 1, modelDecision: 'keep', modelConfidence: 0.5 },
    }),
    testConnection: () => ({ ok: true, latencyMs: 12, decision: 'keep' }),
    clearFeedback: () => ({}),
    clearCache: () => ({}),
    ...over,
  };
  chromeMock = {
    runtime: { sendMessage: vi.fn(async (m: any) => { sent.push(m); return handlers[m.type]!(m); }) },
    permissions: { request: vi.fn(async () => true) },
    tabs: { query: vi.fn(async () => tabs), sendMessage: vi.fn(async () => ({ classified: 1, collapsed: 2, highlighted: 3, failed: 4 })) },
  };
  vi.stubGlobal('chrome', chromeMock);
}

async function load() {
  vi.resetModules();
  document.body.innerHTML = body;
  await import('../src/popup/popup');
  await flush();
}

beforeEach(() => { vi.useRealTimers(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('popup', () => {
  it('fills the form, stats and feedback list', async () => {
    setup();
    await load();
    expect($('enabled').checked).toBe(true);
    expect($('mode').value).toBe('active');
    expect($('preset').value).toBe('https://openrouter.ai/api/v1');
    expect($('timeoutS').value).toBe('30');
    expect($('apiKey').placeholder).toContain('saved');
    expect($('stats').textContent).toContain('Avg latency: 150 ms');
    expect($('stats').textContent).toContain('Estimated cost: $0.0020');
    expect($('stats').textContent).toContain('This tab: 1 classified, 2 collapsed, 3 highlighted, 4 failed');
    expect($('fbCount').textContent).toBe('(2)');
    const items = [...$('fbList').children].map((l: any) => l.textContent);
    expect(items[0]).toBe('Worth keeping: good post');
    expect(items[1]).toMatch(/^Low quality: x{80}…$/);
  });

  it('handles null prices, blank custom endpoint and no api key', async () => {
    setup({ getSettings: () => ({ ...settings, hasApiKey: false, endpoint: 'https://custom/x', inputPricePerM: null, outputPricePerM: null }),
      getStats: () => ({ stats: { ...stats, classified: 0 }, cacheSize: 0, prices: { input: null, output: null } }) }, []);
    await load();
    expect($('preset').value).toBe('');
    expect($('apiKey').placeholder).toBe('sk-…');
    expect($('inputPrice').value).toBe('');
    expect($('stats').textContent).toContain('Enter $/1M token prices');
    expect($('stats').textContent).not.toContain('Avg latency');
    expect($('stats').textContent).not.toContain('This tab');
  });

  it('omits the price hint when there are no tokens, and tolerates a missing content script', async () => {
    setup({ getStats: () => ({ stats: { ...stats, promptTokens: 0, completionTokens: 0 }, cacheSize: 0, prices: { input: null, output: null } }) });
    chromeMock.tabs.sendMessage = vi.fn(async () => { throw new Error('none'); });
    await load();
    expect($('stats').textContent).not.toContain('Enter $/1M');
  });

  it('patches settings from the toggles and preset', async () => {
    setup();
    await load();
    for (const [id, key, set] of [
      ['enabled', 'enabled', (e: any) => (e.checked = false)],
      ['mode', 'mode', (e: any) => (e.value = 'review')],
      ['sensitivity', 'sensitivity', (e: any) => (e.value = 'relaxed')],
      ['highlight', 'highlight', (e: any) => (e.checked = false)],
    ] as const) {
      set($(id));
      $(id).dispatchEvent(new Event('change'));
      await flush();
      expect(sent.some((m) => m.type === 'saveSettings' && key in m.patch)).toBe(true);
    }
    $('preset').value = 'http://localhost:11434/v1';
    $('preset').dispatchEvent(new Event('change'));
    expect($('endpoint').value).toBe('http://localhost:11434/v1');
    $('preset').value = '';
    $('preset').dispatchEvent(new Event('change'));
    expect($('endpoint').value).toBe('http://localhost:11434/v1');
  });

  it('saves the LLM config after requesting host access', async () => {
    setup();
    await load();
    $('endpoint').value = 'https://api.openai.com/v1';
    $('apiKey').value = ' k ';
    $('outputPrice').value = '5';
    $('save').click();
    await flush();
    expect(chromeMock.permissions.request).toHaveBeenCalledWith({ origins: ['https://api.openai.com/*'] });
    const save = sent.find((m) => m.type === 'saveSettings');
    expect(save.patch).toMatchObject({ endpoint: 'https://api.openai.com/v1', apiKey: 'k', outputPricePerM: 5, timeoutMs: 30000 });
    expect($('llmStatus').textContent).toBe('Saved.');
  });

  it('reports an invalid endpoint and denied permission', async () => {
    setup();
    await load();
    $('endpoint').value = 'not a url';
    $('save').click();
    await flush();
    expect($('llmStatus').textContent).toContain('not a valid URL');
    expect($('llmStatus').className).toBe('err');

    chromeMock.permissions.request = vi.fn(async () => false);
    $('endpoint').value = 'https://example.com/v1';
    $('save').click();
    await flush();
    expect($('llmStatus').textContent).toContain('example.com was not granted');
    expect(sent.some((m) => m.type === 'saveSettings')).toBe(false);
  });

  it('tests the connection: success, failure, network hint, and aborted save', async () => {
    setup();
    await load();
    $('test').click();
    await flush();
    expect($('llmStatus').textContent).toContain('Connected. Model replied in 12 ms');

    handlers.testConnection = () => ({ ok: false, kind: 'auth', message: 'bad key' });
    $('test').click();
    await flush();
    expect($('llmStatus').textContent).toBe('auth: bad key');
    expect($('llmStatus').className).toBe('err');

    handlers.testConnection = () => ({ ok: false, kind: 'network', message: 'down' });
    $('test').click();
    await flush();
    expect($('llmStatus').textContent).toContain('host access was granted');

    chromeMock.permissions.request = vi.fn(async () => false);
    const n = sent.length;
    $('test').click();
    await flush();
    expect(sent.slice(n).some((m) => m.type === 'testConnection')).toBe(false);
  });

  it('exports feedback as JSONL', async () => {
    setup();
    await load();
    let blob: Blob | undefined;
    (URL as any).createObjectURL = vi.fn((b: Blob) => { blob = b; return 'blob:x'; });
    (URL as any).revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    $('fbExport').click();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1500);
    expect(click).toHaveBeenCalled();
    expect((URL as any).revokeObjectURL).toHaveBeenCalledWith('blob:x');
    const text = await new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(r.result as string); r.readAsText(blob!); });
    const lines = text.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ id: 'user-a', label: 'keep', text: 'good  post' });
    expect(lines[1]).toMatchObject({ id: 'user-b', label: 'collapse', at: new Date(1).toISOString() });
  });

  it('resets feedback only when confirmed, and clears the cache', async () => {
    setup();
    await load();
    vi.stubGlobal('confirm', () => false);
    $('fbReset').click();
    await flush();
    expect(sent.some((m) => m.type === 'clearFeedback')).toBe(false);
    vi.stubGlobal('confirm', () => true);
    $('fbReset').click();
    await flush();
    expect(sent.some((m) => m.type === 'clearFeedback')).toBe(true);
    $('cacheReset').click();
    await flush();
    expect(sent.some((m) => m.type === 'clearCache')).toBe(true);
  });
});

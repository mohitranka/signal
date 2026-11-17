/**
 * Bridge T7 (docs/implementation-plan-bridge.md; mockups docs/mockups/bridge/): the popup's "Local CLI bridge" preset.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { textContrast } from './css';

const html = readFileSync('public/popup.html', 'utf8');
const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[^>]*><\/script>/, '');
const BRIDGE = 'http://127.0.0.1:8791/v1';

const base = {
  enabled: true, mode: 'review', sensitivity: 'balanced', highlight: true,
  endpoint: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini', hasApiKey: true,
  concurrency: 3, timeoutMs: 30000, inputPricePerM: 0.15, outputPricePerM: 0.6, repeats: true,
};
const bridged = { ...base, endpoint: BRIDGE, model: 'claude-code/sonnet', concurrency: 1, timeoutMs: 90000 };
const stats = { classified: 41, httpRequests: 41, failures: 0, cacheHits: 12, repeatHits: 9, promptTokens: 35000, completionTokens: 3000, totalLatencyMs: 170000 };

const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };
const $ = (id: string) => document.getElementById(id) as any;
let sent: any[];

async function load(settings: Record<string, unknown>, test: () => unknown = () => ({ ok: true, latencyMs: 4210, decision: 'keep' })) {
  sent = [];
  let current: any = { ...settings };
  const handlers: Record<string, (m: any) => any> = {
    getSettings: () => current,
    saveSettings: (m) => (current = { ...current, ...m.patch, hasApiKey: true }),
    getStats: () => ({ stats, cacheSize: 7, repeatIndexSize: 3, prices: { input: current.inputPricePerM, output: current.outputPricePerM } }),
    listFeedback: () => ({}),
    testConnection: test,
  };
  vi.stubGlobal('chrome', {
    runtime: { sendMessage: vi.fn(async (m: any) => { sent.push(m); return handlers[m.type]!(m); }) },
    permissions: { request: vi.fn(async () => true) },
    tabs: { query: vi.fn(async () => []), sendMessage: vi.fn() },
  });
  vi.resetModules();
  document.body.innerHTML = body;
  await import('../src/popup/popup');
  await flush();
}
const choose = async (value: string) => {
  const sel = $('preset') as HTMLSelectElement;
  sel.value = value;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  await flush();
};
const typeModel = async (v: string) => {
  $('model').value = v;
  $('model').dispatchEvent(new Event('input', { bubbles: true }));
  await flush();
};
const keyLabel = () => ($('apiKey') as HTMLElement).closest('label')!.textContent!.trim();
const status = () => $('llmStatus').textContent as string;
const testConnection = async () => { $('test').click(); await flush(); };

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('preset (T7 #31)', () => {
  it('offers "Local CLI bridge (Claude Code / Codex)" after "Ollama (local)"', async () => {
    await load(base);
    const options = Array.from(($('preset') as HTMLSelectElement).options).map((o) => [o.textContent, o.value]);
    expect(options.at(-1)).toEqual(['Local CLI bridge (Claude Code / Codex)', BRIDGE]);
    expect(options.at(-2)![0]).toBe('Ollama (local)');
  });

  it('choosing it fills the endpoint, 1 at a time and 90 s, and shows the help line linked to the select', async () => {
    await load(base);
    expect($('presetHelp').hidden).toBe(true);
    await choose(BRIDGE);
    expect($('endpoint').value).toBe(BRIDGE);
    expect($('concurrency').value).toBe('1');
    expect($('timeoutS').value).toBe('90');
    expect($('preset').getAttribute('aria-describedby')).toBe('presetHelp');
    expect($('presetHelp').hidden).toBe(false);
    expect($('presetHelp').textContent).toMatch(/^Uses the Claude Code or Codex CLI you are logged in to, through a small server on this computer\. Start it with npm run bridge -- --cli claude, then paste the model and token it prints\.$/); // security B4
    expect($('presetHelp').querySelector('code').textContent).toBe('npm run bridge -- --cli claude');
    await choose('https://openrouter.ai/api/v1');
    expect($('presetHelp').hidden).toBe(true);
  });

  it('opening with bridge settings selects the preset', async () => {
    await load(bridged);
    expect($('preset').value).toBe(BRIDGE);
    expect($('presetHelp').hidden).toBe(false);
  });
});

describe('bridge mode: token label and prices (T7 #32)', () => {
  it('"Bridge token" and disabled "not used" price fields; back to normal for other providers', async () => {
    await load(base);
    expect(keyLabel()).toBe('API key');
    expect($('inputPrice').disabled).toBe(false);
    await choose(BRIDGE);
    expect(keyLabel()).toBe('Bridge token');
    for (const id of ['inputPrice', 'outputPrice']) {
      expect($(id).disabled).toBe(true);
      expect($(id).placeholder).toBe('not used');
    }
    await choose('https://api.openai.com/v1');
    expect(keyLabel()).toBe('API key');
    expect($('inputPrice').disabled).toBe(false);
    expect($('inputPrice').placeholder).toBe('optional');
  });

  it('a bridge model id also turns bridge mode on (a bridge on another port is a "Custom" endpoint)', async () => {
    await load({ ...base, endpoint: 'http://127.0.0.1:9000/v1', model: 'codex/gpt-5' });
    expect($('preset').value).toBe('');
    expect(keyLabel()).toBe('Bridge token');
    await typeModel('openai/gpt-4o-mini');
    expect(keyLabel()).toBe('API key');
    await typeModel('claude-code/opus');
    expect(keyLabel()).toBe('Bridge token');
  });

  it('Save in bridge mode leaves the stored prices untouched (not sent); other providers still send them', async () => {
    await load(base);
    await choose(BRIDGE);
    await typeModel('claude-code/sonnet');
    $('save').click();
    await flush();
    const patch = sent.find((m) => m.type === 'saveSettings').patch;
    expect(patch).toMatchObject({ endpoint: BRIDGE, model: 'claude-code/sonnet', concurrency: 1, timeoutMs: 90000 });
    expect('inputPricePerM' in patch).toBe(false);
    expect('outputPricePerM' in patch).toBe(false);

    await load(base);
    $('save').click();
    await flush();
    expect(sent.find((m) => m.type === 'saveSettings').patch).toMatchObject({ inputPricePerM: 0.15, outputPricePerM: 0.6 });
  });
});

describe('chip and cost tile (T7 #33, #34)', () => {
  it('chip names the CLI and the model for bridge models, the last path segment otherwise', async () => {
    await load(bridged);
    expect($('llmChip').textContent).toBe('claude-code · sonnet');
    await load({ ...bridged, model: 'codex/gpt-5' });
    expect($('llmChip').textContent).toBe('codex · gpt-5');
    await load(base);
    expect($('llmChip').textContent).toBe('gpt-4o-mini');
    await load({ ...base, model: 'constructor/x' }); // prefixes are looked up safely (no prototype names)
    expect($('llmChip').textContent).toBe('x');
    expect(keyLabel()).toBe('API key');
  });

  it('cost tile reads "Plan" with the login tooltip, even when prices are stored (wording: security B4)', async () => {
    await load(bridged);
    expect($('stCost').textContent).toBe('Plan');
    expect($('stCost').parentElement.title).toBe('Plan · Through your Claude Code login via the local bridge · no per-token estimate (billed as your CLI is set up)');
    expect($('stTokens').textContent).toBe('38k');
    await load(base);
    expect($('stCost').textContent).toMatch(/^<?\$/); // a dollar estimate (under a cent: "<$0.01", finding K)
  });
});

describe('Test connection wording (T7 #35)', () => {
  it('success names the CLI login (security B4: not "subscription", which the bridge cannot know)', async () => {
    await load(bridged);
    await testConnection();
    expect(status()).toBe('Connected · replied in 4,210 ms (test post rated: keep) · via your Claude Code login');
    await load({ ...bridged, model: 'codex/gpt-5' });
    await testConnection();
    expect(status()).toBe('Connected · replied in 4,210 ms (test post rated: keep) · via your Codex login');
  });

  it('other providers keep today\'s wording', async () => {
    await load(base, () => ({ ok: true, latencyMs: 12, decision: 'keep' }));
    await testConnection();
    expect(status()).toBe('Connected · replied in 12 ms (test post rated: keep)');
  });

  it('not reachable: where the bridge should be and how to start it (host, port and CLI from the settings)', async () => {
    const down = () => ({ ok: false, kind: 'network', message: 'Network error: fetch failed' });
    await load(bridged, down);
    await testConnection();
    expect(status()).toBe('network: Could not reach the bridge at 127.0.0.1:8791. Is it running? npm run bridge -- --cli claude');
    await load({ ...bridged, endpoint: 'http://localhost:9000/v1', model: 'codex/gpt-5' }, down);
    await testConnection();
    expect(status()).toBe('network: Could not reach the bridge at localhost:9000. Is it running? npm run bridge -- --cli codex');
  });

  it('busy: Signal retries; auth and config show the bridge\'s own message', async () => {
    await load(bridged, () => ({ ok: false, kind: 'rate_limit', message: 'Rate limited by provider.' }));
    await testConnection();
    expect(status()).toBe('rate_limit: The bridge is busy (one post at a time); Signal retries automatically.');
    await load(bridged, () => ({ ok: false, kind: 'auth', message: 'Authentication failed (401). Paste the token printed by the bridge into “Bridge token”.' }));
    await testConnection();
    expect(status()).toBe('auth: Authentication failed (401). Paste the token printed by the bridge into “Bridge token”.');
  });
});

describe('contrast of the new help line (T7 #36, finding G)', () => {
  const css = readFileSync('public/popup.css', 'utf8');
  for (const scheme of ['light', 'dark'] as const) {
    it(`help text and its code sample are at least 4.5:1 (${scheme})`, () => {
      expect(textContrast(css, ':root', scheme, ['.preset-help'], ['.card'])).toBeGreaterThanOrEqual(4.5);
      expect(textContrast(css, ':root', scheme, ['.preset-help code'], ['.card'])).toBeGreaterThanOrEqual(4.5);
    });
  }
});

describe('bridge wording only for a local endpoint (security B7)', () => {
  const REMOTE = { ...bridged, endpoint: 'https://openrouter.ai/api/v1', concurrency: 3, timeoutMs: 30000 };
  const typeEndpoint = async (v: string) => {
    $('endpoint').value = v;
    $('endpoint').dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
  };

  it('a bridge model id on a remote endpoint: chip, cost estimate, "API key", prices, no suffix', async () => {
    await load(REMOTE);
    expect($('llmChip').textContent).toBe('sonnet');
    expect($('stCost').textContent).toMatch(/^<?\$\d/); // a dollar estimate (under a cent: "<$0.01", finding K)
    expect($('stCost').parentElement.title).toMatch(/ · (\$[\d.]+ )?estimated from your configured prices$/i); // exact amount first when rounded (K)
    expect(keyLabel()).toBe('API key');
    expect($('inputPrice').disabled).toBe(false);
    expect($('inputPrice').value).toBe('0.15');
    await testConnection();
    expect(status()).toBe('Connected · replied in 4,210 ms (test post rated: keep)');
  });

  it('same settings: network and rate-limit errors use the general wording', async () => {
    await load(REMOTE, () => ({ ok: false, kind: 'network', message: 'Network error: fetch failed' }));
    await testConnection();
    expect(status()).toMatch(/^network: Network error: fetch failed \(If this persists/);
    expect(status()).not.toMatch(/bridge/);
    await load(REMOTE, () => ({ ok: false, kind: 'rate_limit', message: 'Rate limited by provider.' }));
    await testConnection();
    expect(status()).toBe('rate_limit: Rate limited by provider.');
  });

  it('hosts that only look local are not the bridge', async () => {
    for (const endpoint of ['http://localhost.evil.example:8791/v1', 'http://192.168.1.5:8791/v1', 'https://127.0.0.1.nip.io/v1']) {
      await load({ ...REMOTE, endpoint });
      expect($('llmChip').textContent, endpoint).toBe('sonnet');
      expect($('stCost').textContent, endpoint).not.toBe('Plan');
      expect(keyLabel(), endpoint).toBe('API key');
    }
  });

  it('[::1] is local: bridge wording', async () => {
    await load({ ...bridged, endpoint: 'http://[::1]:8791/v1' });
    expect($('llmChip').textContent).toBe('claude-code · sonnet');
    expect($('stCost').textContent).toBe('Plan');
    expect(keyLabel()).toBe('Bridge token');
  });

  it('the form: a bridge model id with a remote endpoint keeps "API key" and saves prices; a local endpoint switches', async () => {
    await load(base); // OpenRouter, openai/gpt-4o-mini
    await typeModel('claude-code/sonnet');
    expect(keyLabel()).toBe('API key');
    expect($('inputPrice').disabled).toBe(false);
    $('save').click();
    await flush();
    expect(sent.find((m) => m.type === 'saveSettings').patch).toMatchObject({ model: 'claude-code/sonnet', inputPricePerM: 0.15, outputPricePerM: 0.6 });
    await typeEndpoint('http://127.0.0.1:8791/v1');
    expect(keyLabel()).toBe('Bridge token');
    expect($('inputPrice').disabled).toBe(true);
  });
});

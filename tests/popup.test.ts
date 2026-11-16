import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadDataset } from '../eval/lib';
import { PROMPT_VERSION } from '../src/classifier/prompt';
import { correctionReport, partitionCorrections, rowsToInputs } from '../src/corrections';
import { COLLAPSE_CONFIDENCE } from '../src/policy';
import { cls, gem, noise, record } from './helpers';

vi.mock('../src/scoring', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/scoring')>();
  return { ...real, score: vi.fn(real.score) };
});

const html = readFileSync('public/popup.html', 'utf8');
const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[^>]*><\/script>/, '');

const settings = {
  enabled: true, mode: 'active', sensitivity: 'strict', highlight: true,
  endpoint: 'https://openrouter.ai/api/v1', model: 'm', hasApiKey: true,
  concurrency: 3, timeoutMs: 30000, inputPricePerM: 1, outputPricePerM: 2,
};
const stats = { classified: 2, httpRequests: 3, failures: 1, cacheHits: 4, promptTokens: 1000, completionTokens: 500, totalLatencyMs: 300 };
const rec = (c: ReturnType<typeof cls>, model = 'm', pv = PROMPT_VERSION) => record(c, model, pv);

/**
 * 3 "worth keeping" + 3 "low quality" scorable entries, and one of each left-out reason.
 * Expected (see tests/corrections.test.ts): wrongly hidden R1 B2 S2, missed R2 B2 S1.
 */
const FEEDBACK = {
  a: { verdict: 'keep', at: 9, sample: 'good  post', modelDecision: 'collapse', modelConfidence: 0.97, classified: rec(noise(0.97)) },
  b: { verdict: 'keep', at: 8, sample: 'b post', modelDecision: 'collapse', modelConfidence: 0.9, classified: rec(noise(0.9)) },
  c: { verdict: 'keep', at: 7, sample: 'c post', modelDecision: 'keep', modelConfidence: 0.9, classified: rec(cls()) },
  d: { verdict: 'collapse', at: 6, sample: 'd post', modelDecision: 'collapse', modelConfidence: 0.97, classified: rec(noise(0.97)) },
  e: { verdict: 'collapse', at: 5, sample: 'e post', modelDecision: 'collapse', modelConfidence: 0.8, classified: rec(noise(0.8)) },
  f: { verdict: 'collapse', at: 4, sample: 'x'.repeat(100), modelDecision: 'highlight', modelConfidence: 0.9, classified: rec(gem()) },
  g: { verdict: 'keep', at: 3, sample: 'legacy post', modelDecision: 'collapse', modelConfidence: 0.9 },
  h: { verdict: 'collapse', at: 2, sample: 'other model post', modelDecision: 'collapse', modelConfidence: 0.95, classified: rec(noise(), 'other') },
  i: { verdict: 'keep', at: 1, sample: 'old prompt post', modelDecision: 'collapse', modelConfidence: 0.95, classified: rec(noise(), 'm', 'v0') },
};

const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };
const $ = (id: string) => document.getElementById(id) as any;
const text = (sel: string) => document.querySelector(sel)?.textContent ?? '';
const all = (sel: string) => Array.from(document.querySelectorAll<HTMLElement>(sel));

let sent: any[];
let handlers: Record<string, (m: any) => any>;
let chromeMock: any;

function setup(over: Record<string, (m: any) => any> = {}, tabs: any[] = [{ id: 1, url: 'https://www.linkedin.com/feed/' }]) {
  sent = [];
  let current: any = { ...settings };
  handlers = {
    getSettings: () => current,
    saveSettings: (m) => (current = { ...current, ...m.patch, hasApiKey: true }),
    getStats: () => ({ stats, cacheSize: 7, prices: { input: 1, output: 2 } }),
    listFeedback: () => structuredClone(FEEDBACK),
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

const pick = async (name: string, value: string) => {
  const r = document.querySelector<HTMLInputElement>(`input[name=${name}][value=${value}]`)!;
  r.checked = true;
  r.dispatchEvent(new Event('change', { bubbles: true }));
  await flush();
};

async function exportLines(): Promise<any[]> {
  let blob: Blob | undefined;
  (URL as any).createObjectURL = vi.fn((b: Blob) => { blob = b; return 'blob:x'; });
  (URL as any).revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  $('fbExport').click();
  await flush();
  const t = await new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(r.result as string); r.readAsText(blob!); });
  return t.trim() ? t.trim().split('\n').map((l) => JSON.parse(l)) : [];
}

const corrCells = () => all('#corrRows tr').map((tr) => [tr.querySelector('th')!.textContent, ...Array.from(tr.querySelectorAll('td')).map((td) => td.textContent)]);

beforeEach(() => { vi.useRealTimers(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// ------------------------------------------------------------------------------------------------

describe('popup layout', () => {
  it('has the redesigned structure: controls, model, session, corrections, feedback', async () => {
    setup();
    await load();
    const kids = Array.from(document.querySelector('main')!.children).map((e) => `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}`);
    expect(kids).toEqual(['section', 'details#llm', 'section#statsBox', 'details#corrBox', 'details#fbBox']);
    expect(all('input[name=mode]')).toHaveLength(2);
    expect(all('input[name=sensitivity]')).toHaveLength(3);
    expect(document.querySelector('select#mode, select#sensitivity')).toBeNull();
  });

  it('starts with the model, corrections and feedback sections closed', async () => {
    setup();
    await load();
    expect($('llm').open).toBe(false);
    expect($('corrBox').open).toBe(false);
    expect($('fbBox').open).toBe(false);
  });

  it('uses the shorter wording', async () => {
    setup();
    await load();
    expect(text('#llm > summary')).toContain('Model');
    expect(text('#llm details.advanced > summary')).toBe('Advanced');
    expect($('fbExport').textContent).toBe('Export JSONL');
    expect($('fbReset').textContent).toBe('Reset');
  });
});

describe('header and controls', () => {
  it('shows the current state in one status line', async () => {
    setup();
    await load();
    expect($('statusLine').textContent).toBe('Filtering · Strict');
    expect($('enabled').checked).toBe(true);
  });

  it('says Paused when disabled, and asks for a model when none is set', async () => {
    setup({ getSettings: () => ({ ...settings, enabled: false }) });
    await load();
    expect($('statusLine').textContent).toBe('Paused');

    setup({ getSettings: () => ({ ...settings, model: '' }) });
    await load();
    expect($('statusLine').textContent).toBe('Set up a model to start');
    expect($('statusLine').classList.contains('warn')).toBe(true);
    expect($('llmChip').textContent).toBe('Not set up');
    expect($('llmChip').classList.contains('warn')).toBe(true);
    expect($('llm').open).toBe(true);
  });

  it('checks the radios that match the settings, with help lines derived from the policy thresholds', async () => {
    setup();
    await load();
    expect(document.querySelector<HTMLInputElement>('input[name=mode][value=active]')!.checked).toBe(true);
    expect(document.querySelector<HTMLInputElement>('input[name=sensitivity][value=strict]')!.checked).toBe(true);
    expect($('modeHelp').textContent).toBe('Collapses confident low-quality posts.');
    expect($('sensHelp').textContent).toContain(`≥${Math.round(COLLAPSE_CONFIDENCE.strict * 100)}%`);
  });

  it('saves mode and sensitivity from the segmented controls and updates status and help', async () => {
    setup();
    await load();
    await pick('mode', 'review');
    expect(sent.find((m) => m.type === 'saveSettings' && m.patch.mode === 'review')).toBeTruthy();
    expect($('modeHelp').textContent).toBe('Annotates posts. Nothing is hidden.');
    expect($('statusLine').textContent).toBe('Reviewing · Strict');

    await pick('sensitivity', 'relaxed');
    expect(sent.find((m) => m.type === 'saveSettings' && m.patch.sensitivity === 'relaxed')).toBeTruthy();
    expect($('sensHelp').textContent).toContain(`≥${Math.round(COLLAPSE_CONFIDENCE.relaxed * 100)}%`);
    expect($('statusLine').textContent).toBe('Reviewing · Relaxed');
  });

  it('saves the enabled and highlight switches', async () => {
    setup();
    await load();
    for (const id of ['enabled', 'highlight']) {
      $(id).checked = false;
      $(id).dispatchEvent(new Event('change'));
      await flush();
      expect(sent.some((m) => m.type === 'saveSettings' && m.patch[id] === false)).toBe(true);
    }
  });

  it('shows the configured model in the Model chip (last path segment, full name on hover)', async () => {
    setup({ getSettings: () => ({ ...settings, model: 'openai/gpt-4o-mini' }) });
    await load();
    expect($('llmChip').textContent).toBe('gpt-4o-mini');
    expect($('llmChip').title).toBe('openai/gpt-4o-mini');
    expect($('llmChip').classList.contains('warn')).toBe(false);
  });
});

describe('model settings', () => {
  it('fills the form and keeps the preset in sync', async () => {
    setup();
    await load();
    expect($('preset').value).toBe('https://openrouter.ai/api/v1');
    expect($('timeoutS').value).toBe('30');
    expect($('apiKey').placeholder).toMatch(/saved/i);
    $('preset').value = 'http://localhost:11434/v1';
    $('preset').dispatchEvent(new Event('change'));
    expect($('endpoint').value).toBe('http://localhost:11434/v1');
  });

  it('handles a custom endpoint, no key and no prices', async () => {
    setup({ getSettings: () => ({ ...settings, hasApiKey: false, endpoint: 'https://custom/x', inputPricePerM: null, outputPricePerM: null }) });
    await load();
    expect($('preset').value).toBe('');
    expect($('apiKey').placeholder).toBe('sk-…');
    expect($('inputPrice').value).toBe('');
  });

  it('saves after requesting host access', async () => {
    setup();
    await load();
    $('endpoint').value = 'https://api.openai.com/v1';
    $('apiKey').value = ' k ';
    $('outputPrice').value = '5';
    $('save').click();
    await flush();
    expect(chromeMock.permissions.request).toHaveBeenCalledWith({ origins: ['https://api.openai.com/*'] });
    expect(sent.find((m) => m.type === 'saveSettings').patch).toMatchObject({ endpoint: 'https://api.openai.com/v1', apiKey: 'k', outputPricePerM: 5, timeoutMs: 30000 });
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
    expect($('llmStatus').textContent).toContain('Connected');
    expect($('llmStatus').textContent).toContain('12 ms');
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
});

describe('session', () => {
  it('shows four figures, with the details in tooltips', async () => {
    setup();
    await load();
    expect($('stClassified').textContent).toBe('2');
    expect($('stCache').textContent).toBe('4');
    expect($('stTokens').textContent).toBe('1.5k');
    expect($('stCost').textContent).toBe('$0.0020');
    expect($('stClassified').parentElement.title).toBe('3 HTTP requests · avg latency 150 ms');
    expect($('stCache').parentElement.title).toBe('7 entries stored');
    expect($('stTokens').parentElement.title).toBe('1,000 in · 500 out');
    expect($('stCost').parentElement.title).toBe('Estimated from your configured prices');
  });

  it('sums up this tab in one line, with session failures in red', async () => {
    setup();
    await load();
    expect($('stats').textContent).toBe('This tab: 2 collapsed, 3 highlighted · 1 failed');
    expect(text('#stats .bad')).toBe('1 failed');
  });

  it('copes with no prices, no LinkedIn tab, no failures and no classifications', async () => {
    setup({ getStats: () => ({ stats: { ...stats, classified: 0, failures: 0 }, cacheSize: 0, prices: { input: null, output: null } }) }, []);
    await load();
    expect($('stCost').textContent).toBe('—');
    expect($('stCost').parentElement.title).toMatch(/Model › Advanced/);
    expect($('stClassified').parentElement.title).toBe('3 HTTP requests');
    expect($('stats').textContent).toBe('');
  });

  it('tolerates a missing content script', async () => {
    setup();
    chromeMock.tabs.sendMessage = vi.fn(async () => { throw new Error('none'); });
    await load();
    expect($('stats').textContent).toBe('1 failed');
  });

  it('abbreviates large numbers', async () => {
    setup({ getStats: () => ({ stats: { ...stats, classified: 1234, cacheHits: 999, promptTokens: 198_400, completionTokens: 19_880 }, cacheSize: 0, prices: { input: 100, output: 100 } }) });
    await load();
    expect($('stClassified').textContent).toBe('1.2k');
    expect($('stCache').textContent).toBe('999');
    expect($('stTokens').textContent).toBe('218k');
    expect($('stCost').textContent).toBe('$21.83');
    setup({ getStats: () => ({ stats: { ...stats, promptTokens: 2_500_000, completionTokens: 0 }, cacheSize: 0, prices: { input: null, output: null } }) });
    await load();
    expect($('stTokens').textContent).toBe('2.5M');
  });

  it('clears the cache from the session card', async () => {
    setup();
    await load();
    const before = sent.filter((m) => m.type === 'getStats').length;
    $('cacheReset').click();
    await flush();
    expect(sent.some((m) => m.type === 'clearCache')).toBe(true);
    expect(sent.filter((m) => m.type === 'getStats').length).toBe(before + 1);
  });
});

describe('feedback list', () => {
  it('lists every entry, newest first, as a Keep/Low label plus one line of text; older entries included', async () => {
    setup();
    await load();
    expect($('fbCount').textContent).toBe('9');
    const items = all('#fbList li');
    expect(items).toHaveLength(9);
    expect(items[0]!.querySelector('.pill')!.textContent).toBe('Keep');
    expect(items[0]!.querySelector('.pill')!.classList.contains('keep')).toBe(true);
    expect(items[0]!.querySelector('.text')!.textContent).toBe('good post');
    expect(items[0]!.title).toBe('good  post');
    expect(items[3]!.querySelector('.pill')!.textContent).toBe('Low');
    expect(items[3]!.querySelector('.pill')!.classList.contains('low')).toBe(true);
    expect(items[6]!.querySelector('.text')!.textContent).toBe('legacy post');
  });

  it('ignores entries with an invalid verdict instead of breaking (S1)', async () => {
    setup({ listFeedback: () => ({ ...structuredClone(FEEDBACK), bad: { verdict: 'evil', at: 99, sample: 'bad', classified: rec(noise()) } }) });
    await load();
    expect($('fbCount').textContent).toBe('9');
    expect(all('#fbList li .text').map((e) => e.textContent)).not.toContain('bad');
    expect(corrCells()).toEqual([['Relaxed', '1', '2'], ['Balanced', '2', '2'], ['Strict', '2', '1']]);
  });

  it('says when feedback is full, and not before (S4)', async () => {
    const many = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}`, { verdict: 'keep', at: i, sample: `s${i}` }]));
    setup({ listFeedback: () => many(1999) });
    await load();
    expect($('fbFull').hidden).toBe(true);
    setup({ listFeedback: () => many(2000) });
    await load();
    expect($('fbFull').hidden).toBe(false);
    expect($('fbFull').textContent).toBe('Feedback is full (2,000 corrections). Export it, then Reset, to keep adding.');
  }, 20_000); // renders 2 x ~2,000 list rows in jsdom

  it('shows an empty state', async () => {
    setup({ listFeedback: () => ({}) });
    await load();
    expect($('fbCount').textContent).toBe('');
    expect(text('#fbList')).toBe('No feedback yet.');
  });

  it('resets only when confirmed, then redraws the list and the corrections panel', async () => {
    setup();
    await load();
    vi.stubGlobal('confirm', () => false);
    $('fbReset').click();
    await flush();
    expect(sent.some((m) => m.type === 'clearFeedback')).toBe(false);
    vi.stubGlobal('confirm', () => true);
    handlers.clearFeedback = () => { handlers.listFeedback = () => ({}); return {}; };
    $('fbReset').click();
    await flush();
    expect(sent.some((m) => m.type === 'clearFeedback')).toBe(true);
    expect($('fbCount').textContent).toBe('');
    expect($('corrTable').hidden).toBe(true);
    expect($('corrEmpty').textContent).toMatch(/^No corrections yet/);
  });
});

describe('your corrections', () => {
  it('shows, per sensitivity, posts you kept that would be hidden and low-quality posts that would stay', async () => {
    setup();
    await load();
    expect($('corrCount').textContent).toBe('6 scored');
    expect($('corrTarget').textContent).toBe(`Against m · prompt ${PROMPT_VERSION}`);
    expect($('corrTable').hidden).toBe(false);
    expect($('corrHidSub').textContent).toBe('of 3 kept');
    expect($('corrMisSub').textContent).toBe('of 3 low quality');
    expect(corrCells()).toEqual([
      ['Relaxed', '1', '2'],
      ['Balanced', '2', '2'],
      ['Strict', '2', '1'],
    ]);
  });

  it('marks the current sensitivity and moves the marker when it changes', async () => {
    setup();
    await load();
    expect(all('#corrRows tr.current').map((tr) => tr.querySelector('th')!.textContent)).toEqual(['Strict']);
    await pick('sensitivity', 'relaxed');
    expect(all('#corrRows tr.current').map((tr) => tr.querySelector('th')!.textContent)).toEqual(['Relaxed']);
  });

  it('says when there are too few corrections to mean anything, and greys those numbers', async () => {
    setup();
    await load();
    const notes = all('#corrNotes li').map((l) => l.textContent);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('Too few to judge yet');
    expect(notes[0]).toContain('3 kept, 3 low quality');
    expect(all('#corrRows td').every((td) => td.classList.contains('weak'))).toBe(true);
  });

  it('with enough corrections: no warning, wrongly-hidden counts in red, missed counts plain', async () => {
    const many: Record<string, any> = {};
    for (let i = 0; i < 10; i++) many[`k${i}`] = { verdict: 'keep', at: i, sample: `k${i}`, classified: rec(i === 0 ? noise(0.97) : cls()) };
    for (let i = 0; i < 10; i++) many[`l${i}`] = { verdict: 'collapse', at: i, sample: `l${i}`, classified: rec(i === 0 ? cls() : noise(0.97)) };
    setup({ listFeedback: () => many });
    await load();
    expect(all('#corrNotes li')).toHaveLength(0);
    expect(corrCells()).toEqual([['Relaxed', '1', '1'], ['Balanced', '1', '1'], ['Strict', '1', '1']]);
    const [hidden, missed] = Array.from(all('#corrRows tr')[0]!.querySelectorAll('td'));
    expect(hidden!.classList.contains('bad')).toBe(true);
    expect(hidden!.classList.contains('weak')).toBe(false);
    expect(missed!.classList.contains('bad')).toBe(false);
  });

  it('names the weak side when only one side has too few, and shows a dash for an empty side', async () => {
    const many: Record<string, any> = {};
    for (let i = 0; i < 10; i++) many[`k${i}`] = { verdict: 'keep', at: i, sample: `k${i}`, classified: rec(cls()) };
    setup({ listFeedback: () => many });
    await load();
    const notes = all('#corrNotes li').map((l) => l.textContent);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('“missed”');
    expect(notes[0]).toContain('0 of 10');
    expect(corrCells()[0]).toEqual(['Relaxed', '0', '—']);
  });

  it('lists what it left out, and why', async () => {
    setup();
    await load();
    expect($('corrLeftOut').hidden).toBe(false);
    expect($('corrLeftOutSummary').textContent).toBe('3 left out · 1 no classification, 1 other model, 1 older prompt');
    const items = all('#corrLeftOutList li');
    expect(items.map((li) => li.querySelector('.pill')!.textContent)).toEqual(['no classification', 'other model', 'older prompt']);
    expect(items.map((li) => li.querySelector('.text')!.textContent)).toEqual(['legacy post', 'other model post', 'old prompt post']);
    expect(items[1]!.title).toContain(`other · prompt ${PROMPT_VERSION}`);
    expect(items[2]!.title).toContain('m · prompt v0');
  });

  it('asks for a model when none is configured', async () => {
    setup({ getSettings: () => ({ ...settings, model: '' }) });
    await load();
    expect($('corrTable').hidden).toBe(true);
    expect($('corrLeftOut').hidden).toBe(true);
    expect($('corrEmpty').hidden).toBe(false);
    expect($('corrEmpty').textContent).toBe('Set up a model to compare your corrections against it.');
    expect($('corrCount').textContent).toBe('');
  });

  it('explains an empty panel: no feedback at all, or only unusable feedback', async () => {
    setup({ listFeedback: () => ({}) });
    await load();
    expect($('corrEmpty').textContent).toBe('No corrections yet. Mark posts in the feed to see how each sensitivity would have done.');
    expect($('corrLeftOut').hidden).toBe(true);

    setup({ listFeedback: () => ({ g: FEEDBACK.g }) });
    await load();
    expect($('corrEmpty').textContent).toBe('None of your corrections were classified by this model and prompt yet. New ones will be.');
    expect($('corrLeftOutSummary').textContent).toBe('1 left out · 1 no classification');
  });

  it('re-scores against a newly saved model', async () => {
    setup();
    await load();
    $('model').value = 'other';
    $('save').click();
    await flush();
    expect($('corrTarget').textContent).toBe(`Against other · prompt ${PROMPT_VERSION}`);
    expect($('corrCount').textContent).toBe('1 scored');
  });

  it('computes its numbers with the shared score() from src/scoring', async () => {
    setup();
    await load();
    const scoring = await import('../src/scoring');
    expect(vi.mocked(scoring.score).mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});

describe('export', () => {
  it('carries the stored classification, model and prompt version', async () => {
    setup();
    await load();
    const lines = await exportLines();
    expect(lines).toHaveLength(9);
    expect(lines.find((l) => l.id === 'user-a')).toEqual({
      id: 'user-a', source: 'user-feedback', label: 'keep', text: 'good  post',
      model_decision: 'collapse', model_confidence: 0.97,
      classification: noise(0.97), model: 'm', prompt_version: PROMPT_VERSION,
      at: new Date(9).toISOString(),
    });
  });

  it('exports older entries exactly as before', async () => {
    setup({ listFeedback: () => ({ g: FEEDBACK.g, z: { verdict: 'collapse', at: 1, sample: 'bare' } }) });
    await load();
    const lines = await exportLines();
    expect(lines[0]).toEqual({ id: 'user-g', source: 'user-feedback', label: 'keep', text: 'legacy post', model_decision: 'collapse', model_confidence: 0.9, at: new Date(3).toISOString() });
    expect(lines[1]).toEqual({ id: 'user-z', source: 'user-feedback', label: 'collapse', text: 'bare', at: new Date(1).toISOString() });
  });

  it('exports an entry with a broken timestamp without failing, leaving "at" out (S7)', async () => {
    setup({ listFeedback: () => ({ z: { verdict: 'collapse', at: 'garbage', sample: 'bare' }, y: { verdict: 'keep', at: 4, sample: 'ok' } }) });
    await load();
    const lines = await exportLines();
    expect(lines).toEqual([
      { id: 'user-z', source: 'user-feedback', label: 'collapse', text: 'bare' },
      { id: 'user-y', source: 'user-feedback', label: 'keep', text: 'ok', at: new Date(4).toISOString() },
    ]);
  });

  it('round-trips: the evaluator scores the exported file to the same numbers the panel shows', async () => {
    setup();
    await load();
    const lines = await exportLines();
    const file = join(mkdtempSync(join(tmpdir(), 'signal-rt-')), 'signal-feedback.jsonl');
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const { included, excluded } = partitionCorrections(rowsToInputs(loadDataset(file)), { model: 'm', promptVersion: PROMPT_VERSION });
    const report = correctionReport(included);
    expect(excluded).toHaveLength(3);
    expect(report.rows.map((r) => [String(r.wronglyHidden), String(r.missed)])).toEqual(corrCells().map((c) => [c[1], c[2]]));
  });
});

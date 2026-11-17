/**
 * Findings J + K (docs/design-finding-jk-session-tiles.md, docs/implementation-plan-finding-jk.md): the session tiles.
 * K: a cost under one cent shows "<$0.01" (read as "under 1 cent"); J: a "Details" disclosure lists every tile's detail
 * as text, for keyboard, touch and screen-reader users.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

const html = readFileSync('public/popup.html', 'utf8');
const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[^>]*><\/script>/, '');
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };
const $ = (id: string) => document.getElementById(id) as any;

const base = {
  enabled: true, mode: 'review', sensitivity: 'balanced', highlight: true,
  endpoint: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini', hasApiKey: true,
  concurrency: 3, timeoutMs: 30000, inputPricePerM: 0.15, outputPricePerM: 0.6, repeats: true,
};
const STATS = { classified: 41, httpRequests: 41, failures: 0, cacheHits: 12, repeatHits: 9, promptTokens: 35000, completionTokens: 3000, totalLatencyMs: 170000 };

async function load(settings: Record<string, unknown> = base, stats: Record<string, number> = STATS, prices: { input: number | null; output: number | null } = { input: 0.15, output: 0.6 }) {
  let current: any = { ...settings };
  let statsNow = { ...stats };
  const handlers: Record<string, (m: any) => any> = {
    getSettings: () => current,
    saveSettings: (m) => (current = { ...current, ...m.patch }),
    getStats: () => ({ stats: statsNow, cacheSize: 53, repeatIndexSize: 41, prices }),
    listFeedback: () => ({}),
    testConnection: () => ({ ok: true, latencyMs: 812, decision: 'keep' }),
  };
  vi.stubGlobal('chrome', {
    runtime: { sendMessage: vi.fn(async (m: any) => handlers[m.type]!(m)) },
    permissions: { request: vi.fn(async () => true) },
    tabs: { query: vi.fn(async () => []), sendMessage: vi.fn() },
  });
  vi.resetModules();
  document.body.innerHTML = body;
  await import('../src/popup/popup');
  await flush();
  return { setStats: (s: Record<string, number>) => { statsNow = { ...s }; } };
}
const costTile = () => $('stCost') as HTMLElement;
const spoken = () => costTile().parentElement!.querySelector('.sr')?.textContent ?? null;
const lines = () => Array.from(document.querySelectorAll('#statsDetailList li')).map((l) => l.textContent);

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('cost tile (finding K)', () => {
  it('under one cent: "<$0.01", hidden from screen readers, read as "under 1 cent"', async () => {
    await load(base, { ...STATS, promptTokens: 10000, completionTokens: 500 }); // $0.0018
    expect(costTile().textContent).toBe('<$0.01');
    expect(costTile().getAttribute('aria-hidden')).toBe('true');
    expect(spoken()).toBe('under 1 cent');
  });

  it('exactly zero: "$0.00"; one cent and more: as today; nothing hidden', async () => {
    for (const [pt, ct, shown] of [[0, 0, '$0.00'], [40000, 6667, '$0.01'], [198400, 19880, '$21.83']] as const) {
      await load(base, { ...STATS, promptTokens: pt, completionTokens: ct }, pt > 100000 ? { input: 100, output: 100 } : { input: 0.15, output: 0.6 });
      expect(costTile().textContent, shown).toBe(shown);
      expect(costTile().hasAttribute('aria-hidden'), shown).toBe(false);
      expect(spoken() ?? '', shown).toBe('');
    }
  });
});

describe('tooltips', () => {
  it('name the exact amount when the tile shows a rounded one; latency formatted', async () => {
    await load(base, { ...STATS, promptTokens: 10000, completionTokens: 500 });
    expect(costTile().parentElement!.title).toBe('<$0.01 · $0.0018 estimated from your configured prices');
    expect($('stClassified').parentElement.title).toBe('41 · 41 HTTP requests · avg latency 4,146 ms');
  });
});

describe('Details (finding J)', () => {
  it('a closed disclosure named "Details" under the tiles', async () => {
    await load();
    const d = $('statsDetails') as HTMLDetailsElement;
    expect(d.tagName).toBe('DETAILS');
    expect(d.open).toBe(false);
    expect(d.querySelector('summary')!.textContent).toBe('Details');
    expect(d.closest('#statsBox')).not.toBeNull();
  });

  it('the five lines, exactly (with prices)', async () => {
    await load();
    expect(lines()).toEqual([
      'Classified: 41 posts · 41 HTTP requests · avg latency 4,146 ms',
      'Cache hits: 12 · 53 entries stored',
      'Repeats: 9 copied from a similar post · no model call · 41 stored',
      'Tokens: 35,000 in · 3,000 out',
      'Estimated cost: $0.0070 from your configured prices',
    ]);
    expect(Array.from(document.querySelectorAll('#statsDetailList li b')).map((b) => b.textContent)).toEqual(['Classified: ', 'Cache hits: ', 'Repeats: ', 'Tokens: ', 'Estimated cost: ']);
  });

  it('no prices, the bridge, and an empty session', async () => {
    await load(base, STATS, { input: null, output: null });
    expect(lines()[4]).toBe('Estimated cost: add $/1M token prices under Model › Advanced');
    await load({ ...base, endpoint: 'http://127.0.0.1:8791/v1', model: 'claude-code/sonnet' });
    expect(lines()[4]).toBe('Plan: through your Claude Code login via the local bridge · no per-token estimate (billed as your CLI is set up)');
    await load(base, { classified: 0, httpRequests: 0, failures: 0, cacheHits: 0, repeatHits: 0, promptTokens: 0, completionTokens: 0, totalLatencyMs: 0 });
    expect(lines()[0]).toBe('Classified: 0 posts · 0 HTTP requests');
    expect(lines()[4]).toBe('Estimated cost: $0.00 from your configured prices');
  });

  it('a refresh updates the lines in place: an open disclosure stays open', async () => {
    const t = await load();
    const d = $('statsDetails') as HTMLDetailsElement;
    d.open = true;
    t.setStats({ ...STATS, classified: 42, httpRequests: 42 });
    $('test').click(); // Test connection refreshes the stats
    await flush();
    expect($('statsDetails')).toBe(d);
    expect(d.open).toBe(true);
    expect(lines()[0]).toMatch(/^Classified: 42 posts · 42 HTTP requests/);
  });
});

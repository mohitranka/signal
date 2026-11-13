import { describe, expect, it, vi } from 'vitest';
import { ClassifyService } from '../src/background/classifyService';
import { createHandler } from '../src/background/handlers';
import { CacheStore, FeedbackStore, SettingsStore, StatsStore } from '../src/background/store';
import { decide } from '../src/policy';
import { DEFAULT_SETTINGS, configProblem, normalizeSettings, toPublic } from '../src/shared/settings';
import { fingerprint, prepareInput } from '../src/shared/post';
import { chatResponse, cls, gem, memoryKV, modelJson, noise } from './helpers';

describe('decision policy', () => {
  const opts = (sensitivity: 'relaxed' | 'balanced' | 'strict', highlightEnabled = true) => ({ sensitivity, highlightEnabled });

  it('collapse thresholds tighten with sensitivity', () => {
    const c = noise(0.8);
    expect(decide(c, opts('relaxed')).outcome).toBe('keep');
    expect(decide(c, opts('balanced')).outcome).toBe('keep');
    expect(decide(c, opts('strict')).outcome).toBe('collapse');
    expect(decide(noise(0.9), opts('balanced')).outcome).toBe('collapse');
    expect(decide(noise(0.9), opts('relaxed')).outcome).toBe('keep');
    expect(decide(noise(0.96), opts('relaxed')).outcome).toBe('collapse');
  });

  it('never collapses a post the model itself scores as substantive', () => {
    const contradictory = cls({ decision: 'collapse', confidence: 0.99, signals: { evidence: 0.9, reasoning: 0.8, sensationalism: 0.8 } });
    expect(decide(contradictory, opts('strict')).outcome).toBe('keep');
  });

  it('requires positive evidence of noise, not just an absence of substance', () => {
    const vague = cls({ decision: 'collapse', confidence: 0.99, signals: { originality: 0.6, evidence: 0.2, reasoning: 0.2, sensationalism: 0.1, engagement_bait: 0.1 } });
    expect(decide(vague, opts('strict')).outcome).toBe('keep');
  });

  it('highlights only confident highlight verdicts, and only when enabled', () => {
    expect(decide(gem(0.9), opts('balanced')).outcome).toBe('highlight');
    expect(decide(gem(0.7), opts('balanced')).outcome).toBe('keep');
    expect(decide(gem(0.95), opts('balanced', false)).outcome).toBe('keep');
  });

  it('passes keep through and reports the raw model decision', () => {
    const r = decide(noise(0.5), opts('balanced'));
    expect(r.outcome).toBe('keep');
    expect(r.modelDecision).toBe('collapse');
  });
});

describe('settings', () => {
  it('defaults to review mode with no hardcoded model', () => {
    expect(DEFAULT_SETTINGS.mode).toBe('review');
    expect(DEFAULT_SETTINGS.model).toBe('');
  });
  it('normalizes garbage into valid settings', () => {
    const s = normalizeSettings({ mode: 'nuke', sensitivity: 9, concurrency: 999, timeoutMs: 1, endpoint: ' https://x.io/v1/// ', inputPricePerM: -3 });
    expect(s).toMatchObject({ mode: 'review', sensitivity: 'balanced', concurrency: 8, timeoutMs: 5000, endpoint: 'https://x.io/v1', inputPricePerM: null });
  });
  it('flags unusable LLM config', () => {
    expect(configProblem({ endpoint: 'nope', model: 'm', apiKey: 'k' })).toMatch(/URL/);
    expect(configProblem({ endpoint: 'http://evil.example/v1', model: 'm', apiKey: 'k' })).toMatch(/https/);
    expect(configProblem({ endpoint: 'https://a.io/v1', model: '', apiKey: 'k' })).toMatch(/model/i);
    expect(configProblem({ endpoint: 'https://a.io/v1', model: 'm', apiKey: '' })).toMatch(/key/i);
    expect(configProblem({ endpoint: 'http://localhost:11434/v1', model: 'm', apiKey: '' })).toBeNull();
  });
  it('persists settings and never exposes the key in the public view', async () => {
    const kv = memoryKV();
    const store = new SettingsStore(kv);
    await store.save({ apiKey: 'sk-1', model: 'm', mode: 'active' });
    const reloaded = await new SettingsStore(kv).load();
    expect(reloaded).toMatchObject({ apiKey: 'sk-1', model: 'm', mode: 'active' });
    expect(JSON.stringify(toPublic(reloaded))).not.toContain('sk-1');
    expect(toPublic(reloaded).hasApiKey).toBe(true);
  });
});

describe('post fingerprint', () => {
  it('ignores whitespace and case, but not content', async () => {
    expect(await fingerprint({ text: 'Hello   World' })).toBe(await fingerprint({ text: ' hello world\n' }));
    expect(await fingerprint({ text: 'a' })).not.toBe(await fingerprint({ text: 'b' }));
    expect(await fingerprint({ text: 'a', quoted: 'x' })).not.toBe(await fingerprint({ text: 'a' }));
  });
  it('truncates oversized input before it is hashed or sent', () => {
    expect(prepareInput({ text: 'x'.repeat(10_000) }).text.length).toBeLessThan(3100);
  });
});

function setup(responses: (() => Response | Promise<Response>)[] | (() => Response), over: Partial<typeof DEFAULT_SETTINGS> = {}) {
  const kv = memoryKV();
  const settings = new SettingsStore(kv);
  const cache = new CacheStore(kv, 2000, 0);
  const stats = new StatsStore(memoryKV());
  const queue = Array.isArray(responses) ? [...responses] : null;
  const fetchImpl = vi.fn(async () => (queue ? queue.shift()!() : (responses as () => Response)()));
  const service = new ClassifyService({ loadSettings: () => settings.load(), cache, stats, http: { fetchImpl: fetchImpl as any, sleep: async () => {}, maxRetries: 0 } });
  const ready = settings.save({ model: 'm', apiKey: 'k', endpoint: 'https://api.example.com/v1', ...over });
  return { kv, settings, cache, stats, service, fetchImpl, ready };
}

describe('ClassifyService', () => {
  it('caches results so an identical post costs one request', async () => {
    const t = setup(() => chatResponse(modelJson(gem())));
    await t.ready;
    const first = await t.service.classify('fp1', { text: 'x' });
    const second = await t.service.classify('fp1', { text: 'x' });
    expect(first).toMatchObject({ ok: true, cached: false });
    expect(second).toMatchObject({ ok: true, cached: true });
    expect(t.fetchImpl).toHaveBeenCalledTimes(1);
    expect(await t.stats.get()).toMatchObject({ cacheHits: 1, classified: 1, promptTokens: 100, completionTokens: 40 });
  });

  it('deduplicates concurrent identical requests', async () => {
    const t = setup(() => chatResponse(modelJson(gem())));
    await t.ready;
    await Promise.all([t.service.classify('same', { text: 'x' }), t.service.classify('same', { text: 'x' })]);
    expect(t.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('persists the cache across worker restarts', async () => {
    const t = setup(() => chatResponse(modelJson(gem())));
    await t.ready;
    await t.service.classify('fp', { text: 'x' });
    await t.cache.flush();
    const revived = new CacheStore(t.kv);
    expect(await revived.get(`v1|m|fp`)).toMatchObject({ decision: 'highlight' });
  });

  it('keys the cache by model so switching models re-classifies', async () => {
    const t = setup(() => chatResponse(modelJson(gem())));
    await t.ready;
    await t.service.classify('fp', { text: 'x' });
    await t.settings.save({ model: 'other' });
    await t.service.classify('fp', { text: 'x' });
    expect(t.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('fails open without calling the network when unconfigured', async () => {
    const t = setup(() => chatResponse(modelJson(gem())), { model: '' });
    await t.ready;
    expect(await t.service.classify('fp', { text: 'x' })).toMatchObject({ ok: false, kind: 'config' });
    expect(t.fetchImpl).not.toHaveBeenCalled();
  });

  it('does not cache failures', async () => {
    const t = setup([() => new Response('', { status: 500 }), () => chatResponse(modelJson(gem()))]);
    await t.ready;
    expect(await t.service.classify('fp', { text: 'x' })).toMatchObject({ ok: false, kind: 'server' });
    expect(await t.service.classify('fp', { text: 'x' })).toMatchObject({ ok: true });
    expect((await t.stats.get()).failures).toBe(1);
  });

  it('reports malformed model output as a parse failure', async () => {
    const t = setup(() => chatResponse('lol no json'));
    await t.ready;
    expect(await t.service.classify('fp', { text: 'x' })).toMatchObject({ ok: false, kind: 'parse' });
  });

  it('evicts the oldest cache entries beyond the cap', async () => {
    const cache = new CacheStore(memoryKV(), 3, 0);
    for (let i = 0; i < 5; i++) {
      await cache.set(`k${i}`, cls());
      await new Promise((r) => setTimeout(r, 2));
    }
    expect(await cache.size()).toBe(3);
    expect(await cache.get('k0')).toBeNull();
    expect(await cache.get('k4')).not.toBeNull();
  });

  it('testConnection works without touching cache or stats', async () => {
    const t = setup(() => chatResponse(modelJson(gem())));
    await t.ready;
    expect(await t.service.testConnection()).toMatchObject({ ok: true });
    expect(await t.cache.size()).toBe(0);
    expect((await t.stats.get()).classified).toBe(0);
  });
});

describe('message handlers', () => {
  function harness() {
    const t = setup(() => chatResponse(modelJson(gem())));
    const feedback = new FeedbackStore(t.kv);
    const notify = vi.fn();
    const handle = createHandler({ service: t.service, settings: t.settings, cache: t.cache, feedback, stats: t.stats, notifyTabs: notify });
    return { ...t, feedback, notify, handle };
  }

  it('lets the content script classify and read state, but not change settings or export feedback', async () => {
    const h = harness();
    await h.ready;
    expect(await h.handle({ type: 'classify', fp: 'a', input: { text: 'x' } }, true)).toMatchObject({ ok: true });
    for (const msg of [{ type: 'saveSettings', patch: { enabled: false } }, { type: 'testConnection' }, { type: 'listFeedback' }, { type: 'clearFeedback' }, { type: 'getSettings' }] as const) {
      expect(await h.handle(msg, true), msg.type).toEqual({ error: 'forbidden' });
    }
    expect((await h.settings.load()).enabled).toBe(true);
  });

  it('never returns the API key to anyone', async () => {
    const h = harness();
    await h.ready;
    for (const fromContent of [true, false]) {
      expect(JSON.stringify(await h.handle({ type: 'getState' }, fromContent))).not.toContain('"k"');
    }
    expect(JSON.stringify(await h.handle({ type: 'getSettings' }, false))).not.toMatch(/apiKey/);
  });

  it('treats an empty apiKey in a save as "unchanged" and notifies tabs', async () => {
    const h = harness();
    await h.ready;
    await h.handle({ type: 'saveSettings', patch: { apiKey: '', mode: 'active' } }, false);
    expect(await h.settings.load()).toMatchObject({ apiKey: 'k', mode: 'active' });
    expect(h.notify).toHaveBeenCalled();
  });

  it('stores, lists, and resets feedback locally', async () => {
    const h = harness();
    await h.ready;
    await h.handle({ type: 'setFeedback', fp: 'a', verdict: 'collapse', sample: 'post text', modelDecision: 'keep', modelConfidence: 0.6 }, true);
    expect(((await h.handle({ type: 'getState' }, true)) as any).feedback).toEqual({ a: 'collapse' });
    expect(((await h.handle({ type: 'listFeedback' }, false)) as any).a).toMatchObject({ verdict: 'collapse', sample: 'post text', modelDecision: 'keep' });
    await h.handle({ type: 'setFeedback', fp: 'a', verdict: null, sample: '' }, true);
    expect(((await h.handle({ type: 'getState' }, true)) as any).feedback).toEqual({});
    await h.handle({ type: 'setFeedback', fp: 'b', verdict: 'keep', sample: 's' }, true);
    await h.handle({ type: 'clearFeedback' }, false);
    expect(await h.feedback.all()).toEqual({});
  });
});

import { describe, expect, it, vi } from 'vitest';
import { ClassifyService } from '../src/background/classifyService';
import { createHandler } from '../src/background/handlers';
import { CacheStore, FeedbackStore, SettingsStore, StatsStore } from '../src/background/store';
import { parseRecord } from '../src/classifier/parse';
import { PROMPT_VERSION } from '../src/classifier/prompt';
import { chatResponse, cls, fpFor, gem, memoryKV, modelJson, noise, record } from './helpers';

const A = fpFor('a');

function setup() {
  const kv = memoryKV();
  const settings = new SettingsStore(kv);
  const cache = new CacheStore(kv, 2000, 10);
  const stats = new StatsStore(memoryKV());
  const fetchImpl = vi.fn(async () => chatResponse(modelJson(gem())));
  const service = new ClassifyService({ loadSettings: () => settings.load(), cache, stats, http: { fetchImpl: fetchImpl as any, sleep: async () => {}, maxRetries: 0 } });
  const feedback = new FeedbackStore(kv);
  const handle = createHandler({ service, settings, cache, feedback, stats, notifyTabs: vi.fn() });
  const ready = settings.save({ model: 'openai/gpt-4o-mini', apiKey: 'k', endpoint: 'https://api.example.com/v1' });
  return { kv, settings, service, feedback, handle, ready };
}

const list = async (t: ReturnType<typeof setup>) => (await t.handle({ type: 'listFeedback' }, false)) as Record<string, any>;

describe('classify results name the model and prompt version that produced them', () => {
  it('on a cache miss and on a cache hit', async () => {
    const t = setup();
    await t.ready;
    const miss = await t.service.classify('fp', { text: 'x' });
    const hit = await t.service.classify('fp', { text: 'x' });
    expect(miss).toMatchObject({ ok: true, cached: false, model: 'openai/gpt-4o-mini', promptVersion: PROMPT_VERSION });
    expect(hit).toMatchObject({ ok: true, cached: true, model: 'openai/gpt-4o-mini', promptVersion: PROMPT_VERSION });
  });

  it('after a model switch, new results carry the new model', async () => {
    const t = setup();
    await t.ready;
    await t.settings.save({ model: 'other/model' });
    expect(await t.service.classify('fp', { text: 'x' })).toMatchObject({ ok: true, model: 'other/model' });
  });
});

describe('feedback entries keep the classification they corrected', () => {
  it('stores the full classification with model and prompt version, and derives the legacy fields from it', async () => {
    const t = setup();
    const rec = record(noise(0.93), 'openai/gpt-4o-mini', PROMPT_VERSION);
    await t.handle({ type: 'setFeedback', fp: A, verdict: 'keep', sample: 'post text', classified: rec }, true);
    const a = (await list(t))[A];
    expect(a).toMatchObject({ verdict: 'keep', sample: 'post text', modelDecision: 'collapse', modelConfidence: 0.93 });
    expect(a.classified).toEqual(rec);
  });

  it('stores a validated copy: unknown fields are dropped', async () => {
    const t = setup();
    const rec: any = { ...record(noise()), junk: 1 };
    rec.classification = { ...rec.classification, html: '<img src=x>' };
    await t.handle({ type: 'setFeedback', fp: A, verdict: 'keep', sample: 's', classified: rec }, true);
    const a = (await list(t))[A];
    expect(a.classified).toEqual(record(noise()));
  });

  it('drops an invalid record but still saves the verdict (and any legacy fields sent with it)', async () => {
    const t = setup();
    for (const [fp, bad] of [
      [fpFor('a'), { ...record(noise()), classification: { ...noise(), confidence: 7 } }],
      [fpFor('b'), { ...record(noise()), model: '' }],
      [fpFor('c'), { ...record(noise()), promptVersion: 'x'.repeat(100) }],
      [fpFor('d'), 'not an object'],
    ] as const) {
      await t.handle({ type: 'setFeedback', fp, verdict: 'collapse', sample: 's', modelDecision: 'keep', modelConfidence: 0.4, classified: bad as any }, true);
    }
    const all = await list(t);
    for (const fp of ['a', 'b', 'c', 'd'].map(fpFor)) {
      expect(all[fp]).toMatchObject({ verdict: 'collapse', sample: 's', modelDecision: 'keep', modelConfidence: 0.4 });
      expect(all[fp].classified).toBeUndefined();
    }
  });

  it('changing a verdict without a record keeps the stored record; a new record replaces it', async () => {
    const t = setup();
    await t.handle({ type: 'setFeedback', fp: A, verdict: 'collapse', sample: 's', classified: record(cls()) }, true);
    await t.handle({ type: 'setFeedback', fp: A, verdict: 'keep', sample: 's' }, true);
    let a = (await list(t))[A];
    expect(a.verdict).toBe('keep');
    expect(a.classified).toEqual(record(cls()));
    expect(a).toMatchObject({ modelDecision: 'keep', modelConfidence: 0.9 });

    await t.handle({ type: 'setFeedback', fp: A, verdict: 'keep', sample: 's', classified: record(noise(0.99), 'n2') }, true);
    a = (await list(t))[A];
    expect(a.classified).toEqual(record(noise(0.99), 'n2'));
    expect(a).toMatchObject({ modelDecision: 'collapse', modelConfidence: 0.99 });
  });

  it('undo deletes the whole entry, record included', async () => {
    const t = setup();
    await t.handle({ type: 'setFeedback', fp: A, verdict: 'keep', sample: 's', classified: record(noise()) }, true);
    await t.handle({ type: 'setFeedback', fp: A, verdict: null, sample: '' }, true);
    expect(await list(t)).toEqual({});
  });

  it('older entries without a classification still load, unchanged, next to new ones', async () => {
    const t = setup();
    const legacy = { verdict: 'keep', at: 5, sample: 'old post', modelDecision: 'collapse', modelConfidence: 0.88 };
    const ancient = { verdict: 'collapse', at: 3, sample: 'older post' };
    const OLD = fpFor('old');
    const OLDER = fpFor('older');
    const NEW = fpFor('new');
    t.kv.data.feedback = { [OLD]: legacy, [OLDER]: ancient };
    await t.handle({ type: 'setFeedback', fp: NEW, verdict: 'collapse', sample: 'n', classified: record(cls()) }, true);
    const all = await list(t);
    expect(all[OLD]).toEqual(legacy);
    expect(all[OLDER]).toEqual(ancient);
    expect(all[NEW].classified).toEqual(record(cls()));
    expect(((await t.handle({ type: 'getState' }, true)) as any).feedback).toEqual({ [OLD]: 'keep', [OLDER]: 'collapse', [NEW]: 'collapse' });
  });

  it('FeedbackStore.all() tolerates garbage in storage', async () => {
    const t = setup();
    t.kv.data.feedback = 'corrupted';
    expect(await t.feedback.all()).toEqual({});
  });
});

describe('records of copied verdicts carry repeatOf (T3)', () => {
  const ANCHOR = fpFor('anchor');
  const copied = (repeatOf: any) => ({ ...record(noise(0.93), 'openai/gpt-4o-mini', PROMPT_VERSION), repeatOf });

  it('parseRecord keeps a valid repeatOf and drops unknown fields inside it', () => {
    expect(parseRecord(copied({ fp: ANCHOR, similarity: 0.92 }))).toEqual(copied({ fp: ANCHOR, similarity: 0.92 }));
    expect(parseRecord(copied({ fp: ANCHOR, similarity: 1 }))!.repeatOf).toEqual({ fp: ANCHOR, similarity: 1 });
    expect(parseRecord(copied({ fp: ANCHOR, similarity: 0.85 }))!.repeatOf).toEqual({ fp: ANCHOR, similarity: 0.85 });
    expect(parseRecord(copied({ fp: ANCHOR, similarity: 0.9, junk: '<b>' }))!.repeatOf).toEqual({ fp: ANCHOR, similarity: 0.9 });
  });

  it('parseRecord drops a malformed repeatOf but keeps the record', () => {
    const plain = record(noise(0.93), 'openai/gpt-4o-mini', PROMPT_VERSION);
    for (const bad of [
      { fp: 'not-a-fingerprint', similarity: 0.9 },
      { fp: ANCHOR.toUpperCase(), similarity: 0.9 },
      { fp: ANCHOR, similarity: 0.5 },
      { fp: ANCHOR, similarity: 1.2 },
      { fp: ANCHOR, similarity: Number.NaN },
      { fp: ANCHOR, similarity: '0.9' },
      { fp: ANCHOR },
      'x',
      null,
      [ANCHOR, 0.9],
    ]) {
      const r = parseRecord(copied(bad));
      expect(r, JSON.stringify(bad)).toEqual(plain);
      expect(r && 'repeatOf' in r).toBe(false);
    }
  });

  it('a record without repeatOf is unchanged (older records stay valid)', () => {
    const plain = record(noise(0.93), 'openai/gpt-4o-mini', PROMPT_VERSION);
    expect(parseRecord(plain)).toEqual(plain);
    expect('repeatOf' in parseRecord(plain)!).toBe(false);
  });

  it('a correction on a copied verdict stores repeatOf; a malformed one is stripped before storing', async () => {
    const t = setup();
    await t.handle({ type: 'setFeedback', fp: A, verdict: 'keep', sample: 's', classified: copied({ fp: ANCHOR, similarity: 0.9 }) }, true);
    expect((await list(t))[A].classified.repeatOf).toEqual({ fp: ANCHOR, similarity: 0.9 });
    const B = fpFor('b');
    await t.handle({ type: 'setFeedback', fp: B, verdict: 'keep', sample: 's', classified: copied({ fp: 'zzz', similarity: 0.9 }) }, true);
    const b = (await list(t))[B];
    expect(b.classified).toEqual(record(noise(0.93), 'openai/gpt-4o-mini', PROMPT_VERSION));
    expect(JSON.stringify(t.kv.data)).not.toContain('zzz');
  });
});

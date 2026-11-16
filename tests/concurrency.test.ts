/**
 * Step 8 fixes. P1: overlapping saves must not lose updates (feedback and settings).
 * P2(a): the feedback map is read from storage once and served from memory, but stays correct
 * (failed writes, changes made outside the store).
 */
import { describe, expect, it, vi } from 'vitest';
import { ClassifyService } from '../src/background/classifyService';
import { createHandler } from '../src/background/handlers';
import { CacheStore, FeedbackStore, SettingsStore, StatsStore } from '../src/background/store';
import { chatResponse, cls, fpFor, gem, memoryKV, modelJson, noise, record } from './helpers';

function setup(delayMs = 3) {
  const kv = memoryKV({ delayMs });
  const settings = new SettingsStore(kv);
  const cache = new CacheStore(kv, 2000, 10);
  const stats = new StatsStore(memoryKV());
  const service = new ClassifyService({ loadSettings: () => settings.load(), cache, stats, http: { fetchImpl: vi.fn(async () => chatResponse(modelJson(gem()))) as any, sleep: async () => {}, maxRetries: 0 } });
  const feedback = new FeedbackStore(kv);
  const handle = createHandler({ service, settings, cache, feedback, stats, notifyTabs: vi.fn() });
  return { kv, settings, feedback, handle };
}
const fb = (fp: string, verdict: 'keep' | 'collapse' | null = 'keep', extra = {}) => ({ type: 'setFeedback' as const, fp, verdict, sample: `post ${fp.slice(0, 4)}`, ...extra });
const nextTask = () => new Promise((r) => setTimeout(r, 0));

describe('P1: overlapping saves keep every update', () => {
  it('10 corrections saved at the same moment are all kept', async () => {
    const t = setup();
    const fps = Array.from({ length: 10 }, (_, i) => fpFor(`post ${i}`));
    const results = await Promise.all(fps.map((fp) => t.handle(fb(fp, 'keep', { classified: record(noise()) }), true)));
    expect(results.every((r) => (r as any).ok)).toBe(true);
    expect(Object.keys(await t.feedback.all()).sort()).toEqual([...fps].sort());
  });

  it('saves apply in the order they were sent: a quick Undo after a click wins', async () => {
    const t = setup();
    const A = fpFor('a');
    await Promise.all([t.handle(fb(A, 'collapse'), true), t.handle(fb(A, null), true)]);
    expect(await t.feedback.all()).toEqual({});
    await Promise.all([t.handle(fb(A, 'collapse'), true), t.handle(fb(A, 'keep'), true)]);
    expect((await t.feedback.all())[A]!.verdict).toBe('keep');
  });

  it('the cap is enforced across overlapping saves', async () => {
    const t = setup(1);
    const full: Record<string, unknown> = {};
    for (let i = 0; i < 1998; i++) full[fpFor(`p${i}`)] = { verdict: 'keep', at: i, sample: 's' };
    t.kv.data.feedback = full;
    const res = await Promise.all(Array.from({ length: 5 }, (_, i) => t.handle(fb(fpFor(`new ${i}`)), true)));
    expect(res.filter((r) => (r as any).ok)).toHaveLength(2);
    expect(res.filter((r) => (r as any).error === 'feedback-full')).toHaveLength(3);
    expect(Object.keys(await t.feedback.all())).toHaveLength(2000);
  });

  it('3 settings changes made at the same moment are all applied', async () => {
    const t = setup();
    await Promise.all([
      t.handle({ type: 'saveSettings', patch: { mode: 'active' } }, false),
      t.handle({ type: 'saveSettings', patch: { sensitivity: 'strict' } }, false),
      t.handle({ type: 'saveSettings', patch: { highlight: false } }, false),
    ]);
    expect(await t.settings.load()).toMatchObject({ mode: 'active', sensitivity: 'strict', highlight: false });
  });

  it('a failed write does not block the queue', async () => {
    const t = setup();
    t.kv.failNextWrite = true;
    const [failed, ok] = await Promise.allSettled([t.feedback.set(fpFor('x'), 'keep', 's'), t.feedback.set(fpFor('y'), 'keep', 's')]);
    expect(failed.status).toBe('rejected');
    expect(ok.status).toBe('fulfilled');
    expect(Object.keys(await t.feedback.all())).toEqual([fpFor('y')]);
  });
});

describe('P2(a): feedback is read from storage once and served from memory', () => {
  it('saves, lists and state reads after the first do not read storage again', async () => {
    const t = setup(0);
    await t.feedback.all();
    const reads = t.kv.reads;
    for (let i = 0; i < 5; i++) await t.handle(fb(fpFor(`p${i}`)), true);
    await t.handle({ type: 'listFeedback' }, false);
    await t.handle({ type: 'getState' }, true);
    await nextTask(); // let onChanged events for the store's own writes arrive
    await t.feedback.all();
    const feedbackReads = t.kv.reads - reads - 1; // getState also reads settings once
    expect(feedbackReads).toBe(0);
    expect(t.kv.writtenKeys).toEqual(Array.from({ length: 5 }, (_, i) => [`fb:${fpFor(`p${i}`)}`]));
  });

  it('a failed write leaves memory and storage in agreement', async () => {
    const t = setup(0);
    await t.handle(fb(fpFor('kept'), 'keep'), true);
    t.kv.failNextWrite = true;
    await expect(t.feedback.set(fpFor('lost'), 'keep', 's')).rejects.toThrow(/quota/);
    expect(Object.keys(await t.feedback.all())).toEqual([fpFor('kept')]);
    expect(Object.keys(t.kv.data).filter((k) => k.startsWith('fb:'))).toEqual([`fb:${fpFor('kept')}`]);
  });

  it('reads return a copy: callers cannot change the stored state', async () => {
    const t = setup(0);
    await t.handle(fb(fpFor('a'), 'keep', { classified: record(cls()) }), true);
    const copy = await t.feedback.all();
    delete copy[fpFor('a')];
    (copy as any)[fpFor('b')] = { verdict: 'keep', at: 1, sample: 'injected' };
    expect(Object.keys(await t.feedback.all())).toEqual([fpFor('a')]);
  });

  it('a change written outside the store is picked up on the next read', async () => {
    const t = setup(0);
    await t.handle(fb(fpFor('mine'), 'keep'), true);
    await nextTask();
    // e.g. DevTools, or storage written by another code path
    await t.kv.set({ [`fb:${fpFor('theirs')}`]: { verdict: 'collapse', at: 1, sample: 's' } });
    await nextTask();
    expect(Object.keys(await t.feedback.all()).sort()).toEqual([fpFor('mine'), fpFor('theirs')].sort());
  });

  it('reset clears memory too', async () => {
    const t = setup(0);
    await t.handle(fb(fpFor('a'), 'keep'), true);
    await t.handle({ type: 'clearFeedback' }, false);
    expect(await t.feedback.all()).toEqual({});
    await t.handle(fb(fpFor('b'), 'keep'), true);
    expect(Object.keys(await t.feedback.all())).toEqual([fpFor('b')]);
  });
});

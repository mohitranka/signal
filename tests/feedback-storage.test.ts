/**
 * P2(b): one storage key per correction ("fb:<fingerprint>"), migrated from the older single "feedback" map.
 * A save writes only its own key; older entries must still load, show and export.
 */
import { describe, expect, it, vi } from 'vitest';
import { ClassifyService } from '../src/background/classifyService';
import { createHandler } from '../src/background/handlers';
import { CacheStore, FEEDBACK_KEY_PREFIX, FeedbackStore, SettingsStore, StatsStore } from '../src/background/store';
import { MAX_FEEDBACK_ENTRIES } from '../src/shared/feedback';
import { chatResponse, cls, fpFor, gem, memoryKV, modelJson, noise, record } from './helpers';

function setup(kv = memoryKV()) {
  const settings = new SettingsStore(kv);
  const cache = new CacheStore(kv, 2000, 10);
  const stats = new StatsStore(memoryKV());
  const service = new ClassifyService({ loadSettings: () => settings.load(), cache, stats, http: { fetchImpl: vi.fn(async () => chatResponse(modelJson(gem()))) as any, sleep: async () => {}, maxRetries: 0 } });
  const feedback = new FeedbackStore(kv);
  const handle = createHandler({ service, settings, cache, feedback, stats, notifyTabs: vi.fn() });
  return { kv, feedback, handle };
}
const key = (fp: string) => `${FEEDBACK_KEY_PREFIX}${fp}`;
const nextTask = () => new Promise((r) => setTimeout(r, 0));
const [A, B, C] = [fpFor('a'), fpFor('b'), fpFor('c')] as [string, string, string];
const legacyA = { verdict: 'keep', at: 5, sample: 'old post', modelDecision: 'collapse', modelConfidence: 0.88 };
const legacyB = { verdict: 'collapse', at: 3, sample: 'older post' };
const feedbackKeys = (data: Record<string, unknown>) => Object.keys(data).filter((k) => k.startsWith(FEEDBACK_KEY_PREFIX)).sort();

describe('layout: one key per correction', () => {
  it('uses the "fb:" prefix', () => {
    expect(FEEDBACK_KEY_PREFIX).toBe('fb:');
  });

  it('a save writes only its own key, however much feedback is stored', async () => {
    const t = setup();
    for (let i = 0; i < 50; i++) await t.handle({ type: 'setFeedback', fp: fpFor(`p${i}`), verdict: 'keep', sample: 's' }, true);
    t.kv.writtenKeys.length = 0;
    await t.handle({ type: 'setFeedback', fp: A, verdict: 'collapse', sample: 's', classified: record(noise()) }, true);
    expect(t.kv.writtenKeys).toEqual([[key(A)]]);
    expect(t.kv.data[key(A)]).toMatchObject({ verdict: 'collapse', classified: record(noise()) });
  });

  it('undo removes only that key', async () => {
    const t = setup();
    await t.handle({ type: 'setFeedback', fp: A, verdict: 'keep', sample: 's' }, true);
    await t.handle({ type: 'setFeedback', fp: B, verdict: 'keep', sample: 's' }, true);
    await t.handle({ type: 'setFeedback', fp: A, verdict: null, sample: '' }, true);
    expect(feedbackKeys(t.kv.data)).toEqual([key(B)]);
  });

  it('reset removes every correction (and any older-format leftovers) but nothing else', async () => {
    const t = setup();
    t.kv.data.settings = { mode: 'active' };
    t.kv.data.cache = { x: 1 };
    await t.handle({ type: 'setFeedback', fp: A, verdict: 'keep', sample: 's' }, true);
    t.kv.data[key(C)] = { verdict: 'keep', at: 1, sample: 'written elsewhere' };
    t.kv.data.feedback = { [B]: legacyB };
    await t.handle({ type: 'clearFeedback' }, false);
    expect(feedbackKeys(t.kv.data)).toEqual([]);
    expect(t.kv.data.feedback).toBeUndefined();
    expect(t.kv.data.settings).toEqual({ mode: 'active' });
    expect(t.kv.data.cache).toEqual({ x: 1 });
    expect(await t.feedback.all()).toEqual({});
  });

  it('the cap counts stored corrections', async () => {
    const t = setup();
    for (let i = 0; i < MAX_FEEDBACK_ENTRIES; i++) t.kv.data[key(fpFor(`p${i}`))] = { verdict: 'keep', at: i, sample: 's' };
    expect(await t.handle({ type: 'setFeedback', fp: A, verdict: 'keep', sample: 's' }, true)).toEqual({ error: 'feedback-full' });
    expect(await t.handle({ type: 'setFeedback', fp: fpFor('p0'), verdict: 'collapse', sample: 's' }, true)).toEqual({ ok: true });
  });

  it('drops malformed per-key entries, in memory and in storage', async () => {
    const t = setup();
    t.kv.data[key(A)] = legacyA;
    t.kv.data[key(B)] = { verdict: 'evil', at: 1, sample: 's' };
    t.kv.data[`${FEEDBACK_KEY_PREFIX}not-a-fingerprint`] = { verdict: 'keep', at: 1, sample: 's' };
    t.kv.data[key(C)] = 'garbage';
    expect(await t.feedback.all()).toEqual({ [A]: legacyA });
    await nextTask();
    expect(feedbackKeys(t.kv.data)).toEqual([key(A)]);
  });
});

describe('migration from the older single "feedback" map', () => {
  it('moves older entries to their own keys, unchanged, then removes the old map', async () => {
    const t = setup();
    t.kv.data.feedback = { [A]: legacyA, [B]: legacyB };
    expect(await t.feedback.all()).toEqual({ [A]: legacyA, [B]: legacyB });
    await t.feedback.migrationDone(); // migration runs in the background
    expect(t.kv.data[key(A)]).toEqual(legacyA);
    expect(t.kv.data[key(B)]).toEqual(legacyB);
    expect(t.kv.data.feedback).toBeUndefined();
    expect(((await t.handle({ type: 'getState' }, true)) as any).feedback).toEqual({ [A]: 'keep', [B]: 'collapse' });
  });

  it('migrated entries then behave like any other (update keeps their data, undo removes them)', async () => {
    const t = setup();
    t.kv.data.feedback = { [A]: legacyA, [B]: legacyB };
    await t.handle({ type: 'setFeedback', fp: A, verdict: 'collapse', sample: 'old post' }, true);
    expect((await t.feedback.all())[A]).toMatchObject({ verdict: 'collapse', modelDecision: 'collapse', modelConfidence: 0.88 });
    await t.handle({ type: 'setFeedback', fp: B, verdict: null, sample: '' }, true);
    expect(Object.keys(await t.feedback.all())).toEqual([A]);
  });

  it('drops malformed older entries instead of migrating them', async () => {
    const t = setup();
    t.kv.data.feedback = { [A]: legacyA, [B]: { verdict: 'evil' }, 'not-a-fingerprint': legacyB, [C]: null };
    expect(await t.feedback.all()).toEqual({ [A]: legacyA });
    await t.feedback.migrationDone(); // migration runs in the background
    expect(feedbackKeys(t.kv.data)).toEqual([key(A)]);
    expect(t.kv.data.feedback).toBeUndefined();
  });

  it('a garbage old map is simply removed', async () => {
    const t = setup();
    t.kv.data.feedback = 'corrupted';
    expect(await t.feedback.all()).toEqual({});
    await t.feedback.migrationDone(); // migration runs in the background
    expect(t.kv.data.feedback).toBeUndefined();
  });

  it('an interrupted migration loses nothing: both layouts are merged, the newer per-key entry wins', async () => {
    const t = setup();
    const newerA = { ...legacyA, verdict: 'collapse', at: 99 };
    t.kv.data.feedback = { [A]: legacyA, [B]: legacyB }; // old map still there...
    t.kv.data[key(A)] = newerA; //                           ...and A was already migrated and changed since
    expect(await t.feedback.all()).toEqual({ [A]: newerA, [B]: legacyB });
    await t.feedback.migrationDone(); // migration runs in the background
    expect(t.kv.data[key(A)]).toEqual(newerA);
    expect(t.kv.data[key(B)]).toEqual(legacyB);
    expect(t.kv.data.feedback).toBeUndefined();
  });

  it('if removing the old map fails, everything still loads now and the next start finishes the job', async () => {
    const kv = memoryKV();
    kv.data.feedback = { [A]: legacyA, [B]: legacyB };
    kv.failNextRemove = true;
    const first = setup(kv);
    expect(await first.feedback.all()).toEqual({ [A]: legacyA, [B]: legacyB });
    await first.feedback.migrationDone(); // migration runs in the background
    expect(kv.data.feedback).toBeDefined(); // not removed this time
    const restarted = setup(kv); // service worker restart
    expect(await restarted.feedback.all()).toEqual({ [A]: legacyA, [B]: legacyB });
    await restarted.feedback.migrationDone(); // migration runs in the background
    expect(kv.data.feedback).toBeUndefined();
    expect(feedbackKeys(kv.data)).toEqual([key(A), key(B)].sort());
  });
});

describe('migration failures', () => {
  it('if writing the new keys fails, loading still works, the old map is kept, and the next start retries', async () => {
    const t = setup();
    t.kv.data.feedback = { [A]: legacyA };
    t.kv.failNextWrite = true;
    expect(await t.feedback.all()).toEqual({ [A]: legacyA }); // a failed migration never fails loading
    await t.feedback.migrationDone(); // migration runs in the background
    expect(t.kv.data.feedback).toEqual({ [A]: legacyA });
    const restarted = setup(t.kv);
    expect(await restarted.feedback.all()).toEqual({ [A]: legacyA });
    await restarted.feedback.migrationDone(); // migration runs in the background
    expect(t.kv.data.feedback).toBeUndefined();
  });
});

describe('in-memory copy stays correct', () => {
  it('after the first load, saves and reads do not read storage again', async () => {
    const t = setup();
    await t.feedback.all();
    const reads = t.kv.reads;
    for (let i = 0; i < 5; i++) await t.handle({ type: 'setFeedback', fp: fpFor(`p${i}`), verdict: 'keep', sample: 's' }, true);
    await nextTask();
    await t.handle({ type: 'listFeedback' }, false);
    await t.feedback.all();
    expect(t.kv.reads).toBe(reads);
  });

  it('a correction written or removed outside the store is picked up on the next read', async () => {
    const t = setup();
    await t.handle({ type: 'setFeedback', fp: A, verdict: 'keep', sample: 's' }, true);
    await nextTask();
    await t.kv.set({ [key(B)]: { verdict: 'collapse', at: 1, sample: 'theirs' } });
    await nextTask();
    expect(Object.keys(await t.feedback.all()).sort()).toEqual([A, B].sort());
    await t.kv.remove(key(A));
    await nextTask();
    expect(Object.keys(await t.feedback.all())).toEqual([B]);
  });

  it("recognises its own writes although storage hands values back with keys reordered (as Chrome does)", async () => {
    const t = setup();
    await t.feedback.all();
    const reads = t.kv.reads;
    for (let i = 0; i < 5; i++) {
      // an entry with nested objects whose keys are not in sorted order
      await t.handle({ type: 'setFeedback', fp: fpFor(`p${i}`), verdict: 'keep', sample: 's', classified: record(noise(0.9)) }, true);
      await nextTask(); // each save's change event arrives before the next save
    }
    await t.feedback.all();
    expect(t.kv.reads).toBe(reads);
  });

  it('two quick saves of the same post end in the last value, with no spurious reload', async () => {
    const t = setup();
    await t.feedback.all();
    const reads = t.kv.reads;
    await Promise.all([
      t.handle({ type: 'setFeedback', fp: A, verdict: 'keep', sample: 's', classified: record(cls()) }, true),
      t.handle({ type: 'setFeedback', fp: A, verdict: 'collapse', sample: 's' }, true),
    ]);
    await nextTask();
    expect((await t.feedback.all())[A]!.verdict).toBe('collapse');
    await t.feedback.migrationDone(); // migration runs in the background
    expect(t.kv.data[key(A)]).toMatchObject({ verdict: 'collapse', classified: record(cls()) });
    expect(t.kv.reads).toBe(reads);
  });
});

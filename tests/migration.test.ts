/**
 * P2b-M: migrating a large older "feedback" map must never break the extension. It moves in chunks (peak extra
 * space ~ one chunk), a failed step never fails loading, and not-yet-migrated entries stay fully usable.
 * getState must keep working even if feedback cannot be loaded at all.
 */
import { describe, expect, it, vi } from 'vitest';
import { ClassifyService } from '../src/background/classifyService';
import { createHandler } from '../src/background/handlers';
import { CacheStore, FEEDBACK_KEY_PREFIX, FeedbackStore, SettingsStore, StatsStore, type KV } from '../src/background/store';
import { chatResponse, fpFor, gem, memoryKV, modelJson } from './helpers';

const CHUNK = 2_000; // bytes, small for tests (production: ~1 MB)
const entry = (i: number) => ({ verdict: i % 2 ? 'keep' : 'collapse', at: 1000 + i, sample: `old post ${i} `.padEnd(150, 'x') });
const legacyMap = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [fpFor(`old ${i}`), entry(i)]));
const size = (v: unknown) => JSON.stringify(v).length;
const perKey = (data: Record<string, unknown>) => Object.keys(data).filter((k) => k.startsWith(FEEDBACK_KEY_PREFIX));
const nextTask = () => new Promise((r) => setTimeout(r, 0));

function setup(kv: ReturnType<typeof memoryKV>, migrationChunkBytes = CHUNK) {
  const settings = new SettingsStore(kv);
  const cache = new CacheStore(kv, 2000, 10);
  const stats = new StatsStore(memoryKV());
  const service = new ClassifyService({ loadSettings: () => settings.load(), cache, stats, http: { fetchImpl: vi.fn(async () => chatResponse(modelJson(gem()))) as any, sleep: async () => {}, maxRetries: 0 } });
  const feedback = new FeedbackStore(kv, { migrationChunkBytes });
  const handle = createHandler({ service, settings, cache, feedback, stats, notifyTabs: vi.fn() });
  return { kv, feedback, handle };
}

describe('chunked migration', () => {
  it('a map too big to copy in one go still migrates completely, chunk by chunk', async () => {
    const old = legacyMap(60); // ~11 KB: copying it whole would need ~2x
    const kv = memoryKV({ quotaBytes: size(old) + 3 * CHUNK });
    kv.data.feedback = old;
    const t = setup(kv);
    expect(await t.feedback.all()).toEqual(old);
    await t.feedback.migrationDone(); // migration runs in the background
    expect(kv.data.feedback).toBeUndefined();
    expect(perKey(kv.data)).toHaveLength(60);
    expect(kv.writtenKeys.length).toBeGreaterThan(2); // it really went in several steps
  });

  it('with no room even for one chunk, everything still loads and works; migration finishes once there is room', async () => {
    const old = legacyMap(30);
    const kv = memoryKV({ quotaBytes: size(old) + 200 });
    kv.data.feedback = old;
    const t = setup(kv);
    expect(await t.feedback.all()).toEqual(old); // served although nothing could move
    await t.feedback.migrationDone(); // migration runs in the background
    expect(kv.data.feedback).toEqual(old);
    const state = (await t.handle({ type: 'getState' }, true)) as any;
    expect(Object.keys(state.feedback)).toHaveLength(30);
    expect(state.settings).toBeDefined();

    // Room appears (the user cleared the cache, say). After a service-worker restart the migration completes.
    const roomy = memoryKV();
    Object.assign(roomy.data, structuredClone(kv.data));
    const restarted = setup(roomy);
    expect(await restarted.feedback.all()).toEqual(old);
    await restarted.feedback.migrationDone(); // migration runs in the background
    expect(roomy.data.feedback).toBeUndefined();
    expect(perKey(roomy.data)).toHaveLength(30);
  });

  it('an interruption between chunks loses nothing, and the next start carries on', async () => {
    const old = legacyMap(40);
    const kv = memoryKV();
    kv.data.feedback = old;
    kv.failWriteNumber = 2; // 1st write: a chunk of keys (ok); 2nd: shrinking the old map (fails)
    const t = setup(kv);
    expect(await t.feedback.all()).toEqual(old);
    await t.feedback.migrationDone(); // migration runs in the background
    expect(perKey(kv.data).length).toBeGreaterThan(0);
    expect(kv.data.feedback).toEqual(old); // the old map is still whole: the moved entries exist twice, harmlessly
    const restarted = setup(kv);
    expect(await restarted.feedback.all()).toEqual(old);
    await restarted.feedback.migrationDone(); // migration runs in the background
    expect(kv.data.feedback).toBeUndefined();
    expect(perKey(kv.data)).toHaveLength(40);
  });
});

describe('entries that are not migrated yet behave like any other', () => {
  function stuck(n = 30) {
    const old = legacyMap(n);
    const kv = memoryKV({ quotaBytes: size(old) + 400 }); // room for one small entry, not for a chunk
    kv.data.feedback = old;
    return { old, kv, t: setup(kv) };
  }

  it('undo removes them from the old map too, so they stay gone after a restart', async () => {
    const { kv, t } = stuck();
    const A = fpFor('old 3');
    expect(await t.handle({ type: 'setFeedback', fp: A, verdict: null, sample: '' }, true)).toEqual({ ok: true });
    expect(A in (await t.feedback.all())).toBe(false);
    await t.feedback.migrationDone(); // migration runs in the background
    expect(A in (kv.data.feedback as object)).toBe(false);
    const restarted = setup(kv);
    expect(A in (await restarted.feedback.all())).toBe(false);
  });

  it('a change is saved under its own key and wins over the old copy after a restart', async () => {
    const { kv, t } = stuck();
    const A = fpFor('old 4'); // was 'collapse'
    expect(await t.handle({ type: 'setFeedback', fp: A, verdict: 'keep', sample: 'old post 4' }, true)).toEqual({ ok: true });
    expect((await t.feedback.all())[A]!.verdict).toBe('keep');
    await nextTask();
    const restarted = setup(kv);
    expect((await restarted.feedback.all())[A]!.verdict).toBe('keep');
  });

  it('reset removes them', async () => {
    const { kv, t } = stuck();
    await t.handle({ type: 'clearFeedback' }, false);
    expect(await t.feedback.all()).toEqual({});
    await t.feedback.migrationDone(); // migration runs in the background
    expect(kv.data.feedback).toBeUndefined();
    expect(await setup(kv).feedback.all()).toEqual({});
  });
});

describe('migration runs in the background', () => {
  // Slow storage (each read/write takes 20 ms) and a map that needs ~6 chunks, so "in the background" is observable.
  function big() {
    const old = legacyMap(60);
    const kv = memoryKV({ delayMs: 20 });
    kv.data.feedback = old;
    return { old, kv, t: setup(kv) };
  }

  it('the first read answers from the merged map before any migration write', async () => {
    const { old, kv, t } = big();
    expect(await t.feedback.all()).toEqual(old);
    expect(kv.writes).toBe(0);
    expect(kv.data.feedback).toEqual(old);
    await t.feedback.migrationDone();
    expect(kv.data.feedback).toBeUndefined();
    expect(perKey(kv.data)).toHaveLength(60);
  });

  it('getState and the popup list answer immediately while the migration is still running', async () => {
    const { kv, t } = big();
    await t.feedback.all();
    const state = (await t.handle({ type: 'getState' }, true)) as any;
    const list = (await t.handle({ type: 'listFeedback' }, false)) as any;
    expect(Object.keys(state.feedback)).toHaveLength(60);
    expect(Object.keys(list)).toHaveLength(60);
    expect(kv.data.feedback).toBeDefined(); // answered while the migration was still running: it did not wait for it
    await t.feedback.migrationDone();
  });

  it('a save made during the migration goes through between chunks, not after all of them', async () => {
    const { kv, t } = big();
    await t.feedback.all();
    const NEW = fpFor('made during migration');
    await t.handle({ type: 'setFeedback', fp: NEW, verdict: 'keep', sample: 's' }, true);
    expect(kv.data.feedback).toBeDefined(); // the save did not wait for the whole migration
    await t.feedback.migrationDone();
    const order = kv.writtenKeys.map((keys) => (keys.includes(`fb:${NEW}`) ? 'save' : keys.includes('feedback') ? 'shrink' : 'chunk'));
    expect(order.indexOf('save')).toBeLessThan(order.lastIndexOf('chunk'));
    expect(Object.keys(await t.feedback.all())).toHaveLength(61);
  });

  it('undo and change during the migration survive a restart', async () => {
    const { kv, t } = big();
    await t.feedback.all();
    const [gone, changed, late] = [fpFor('old 1'), fpFor('old 2'), fpFor('old 59')];
    await t.handle({ type: 'setFeedback', fp: gone, verdict: null, sample: '' }, true);
    await t.handle({ type: 'setFeedback', fp: changed, verdict: 'collapse', sample: 'old post 2' }, true); // was keep
    await t.handle({ type: 'setFeedback', fp: late, verdict: null, sample: '' }, true); // probably not migrated yet
    await t.feedback.migrationDone();
    for (const s of [t, setup(kv)]) {
      const all = await s.feedback.all();
      expect(gone in all).toBe(false);
      expect(late in all).toBe(false);
      expect(all[changed]!.verdict).toBe('collapse');
      expect(Object.keys(all)).toHaveLength(58);
    }
    expect(kv.data.feedback).toBeUndefined();
  });

  it('an outside change during the migration ends in the right state, with a single migration run', async () => {
    const { kv, t } = big();
    await t.feedback.all();
    const THEIRS = fpFor('written elsewhere');
    await kv.set({ [`fb:${THEIRS}`]: { verdict: 'collapse', at: 1, sample: 'theirs' } });
    await nextTask();
    const all = await t.feedback.all(); // re-read after the outside change
    expect(Object.keys(all)).toHaveLength(61);
    await t.feedback.migrationDone();
    expect(kv.data.feedback).toBeUndefined();
    expect(perKey(kv.data)).toHaveLength(61);
    // every old entry was written exactly once: no second, overlapping migration run
    const chunkWrites = kv.writtenKeys.filter((keys) => !keys.includes('feedback') && !keys.includes(`fb:${THEIRS}`)).flat();
    expect(new Set(chunkWrites).size).toBe(chunkWrites.length);
  });

  it('reset during the migration stops it and leaves nothing behind', async () => {
    const { kv, t } = big();
    await t.feedback.all();
    await t.handle({ type: 'clearFeedback' }, false);
    await t.feedback.migrationDone();
    expect(await t.feedback.all()).toEqual({});
    expect(kv.data.feedback).toBeUndefined();
    expect(perKey(kv.data)).toEqual([]);
  });
});

describe('older feedback above the cap', () => {
  it('is kept in full; only new corrections are refused', async () => {
    const kv = memoryKV();
    kv.data.feedback = legacyMap(2005);
    const t = setup(kv, 1_000_000); // about the cap, not chunking: production chunk size
    expect(Object.keys(await t.feedback.all())).toHaveLength(2005);
    expect(await t.handle({ type: 'setFeedback', fp: fpFor('brand new'), verdict: 'keep', sample: 's' }, true)).toEqual({ error: 'feedback-full' });
    expect(await t.handle({ type: 'setFeedback', fp: fpFor('old 7'), verdict: 'collapse', sample: 's' }, true)).toEqual({ ok: true });
  });
});

describe('getState does not depend on feedback', () => {
  it('returns settings and no corrections when feedback cannot be loaded', async () => {
    const kv = memoryKV();
    kv.data.settings = { mode: 'active', model: 'm' };
    const t = setup(kv);
    kv.failNextGetAll = true;
    const state = (await t.handle({ type: 'getState' }, true)) as any;
    expect(state.settings).toMatchObject({ mode: 'active', model: 'm' });
    expect(state.feedback).toEqual({});
    // and it recovers on the next call
    expect(((await t.handle({ type: 'getState' }, true)) as any).feedback).toEqual({});
  });
});

// Compile-time check that the test store still satisfies the storage interface.
const _kv: KV = memoryKV();
void _kv;

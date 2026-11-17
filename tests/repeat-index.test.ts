/**
 * T4: RepeatIndex, the background's store of signatures of posts the model judged (docs/design-repeats.md §5).
 * Holds hashes only: never post text, never a classification (the verdict is read from the exact cache).
 */
import { describe, expect, it, vi } from 'vitest';
import { RepeatIndex } from '../src/background/repeatIndex';
import { PROMPT_VERSION } from '../src/classifier/prompt';
import { PUBLIC_TEST_KEY, REPEAT_THRESHOLD, decodeKey, encodeKey, encodeSignature, signature } from '../src/shared/similarity';
import { announce, evidence, lessons, unrelated } from './fixtures/templates';
import { fpFor, gatedKV, memoryKV, until } from './helpers';

const STORAGE_KEY = 'repeats:v3'; // security S2: signature version 3, stored as { key, entries }
/** The stored form since S2: the install's key together with the entries made with it. */
const stored = (entries: Record<string, unknown>, key: unknown = encodeKey(PUBLIC_TEST_KEY)) => ({ key, entries });
const entriesOf = (kv: { data: Record<string, unknown> }) => (kv.data[STORAGE_KEY] as { entries: Record<string, { s: string; t: number }> }).entries;
const scope = (model = 'm', pv = PROMPT_VERSION) => `${pv}|${model}`;
const key = (label: string, model = 'm', pv = PROMPT_VERSION) => `${scope(model, pv)}|${fpFor(label)}`;
const sig = (text: string) => signature({ text }, PUBLIC_TEST_KEY)!; // the index stores whatever it is given
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup(opts: { maxEntries?: number; persistDelayMs?: number } = {}) {
  const kv = memoryKV();
  let clock = 1000;
  const index = new RepeatIndex(kv, { persistDelayMs: opts.persistDelayMs ?? 10, maxEntries: opts.maxEntries, now: () => clock });
  return { kv, index, tick: (ms = 1) => (clock += ms) };
}

describe('RepeatIndex lookup', () => {
  it('finds a near variant of an indexed post, with the anchor fingerprint and the estimate', async () => {
    const { index } = setup();
    await index.add(key('a'), sig(announce('Northwind')));
    const found = await index.candidates(scope(), sig(announce('Contoso', 9, '🔥')));
    expect(found).toHaveLength(1);
    expect(found[0]!.key).toBe(key('a'));
    expect(found[0]!.fp).toBe(fpFor('a'));
    expect(found[0]!.similarity).toBeGreaterThanOrEqual(REPEAT_THRESHOLD);
    expect(found[0]!.similarity).toBeLessThanOrEqual(1);
  });

  it('does not find a post that is merely about something else', async () => {
    const { index } = setup();
    await index.add(key('a'), sig(announce()));
    expect(await index.candidates(scope(), sig(unrelated[0]!))).toEqual([]);
    expect(await index.candidates(scope(), sig(lessons()))).toEqual([]);
  });

  it('only looks inside the same model and prompt version', async () => {
    const { index } = setup();
    await index.add(key('a', 'other-model'), sig(announce()));
    await index.add(key('b', 'm', 'v-old'), sig(announce()));
    expect(await index.candidates(scope(), sig(announce()))).toEqual([]);
    expect((await index.candidates(scope('other-model'), sig(announce()))).map((c) => c.key)).toEqual([key('a', 'other-model')]);
  });

  it('compares the scope exactly: a model named "acme|large" is not "acme"', async () => {
    const { index } = setup();
    await index.add(key('a', 'acme|large'), sig(announce()));
    expect(await index.candidates(scope('acme'), sig(announce()))).toEqual([]);
    expect((await index.candidates(scope('acme|large'), sig(announce()))).map((c) => c.fp)).toEqual([fpFor('a')]);
  });

  it('orders by similarity, then by most recent use', async () => {
    const { index, tick } = setup();
    await index.add(key('variant'), sig(announce('Contoso')));
    tick();
    await index.add(key('exact-old'), sig(announce('Northwind')));
    tick();
    await index.add(key('exact-new'), sig(announce('Northwind')));
    tick();
    let found = await index.candidates(scope(), sig(announce('Northwind')));
    expect(found.map((c) => c.key)).toEqual([key('exact-new'), key('exact-old'), key('variant')]);
    expect(found[0]!.similarity).toBe(1);

    await index.touch(key('exact-old'));
    found = await index.candidates(scope(), sig(announce('Northwind')));
    expect(found.map((c) => c.key)).toEqual([key('exact-old'), key('exact-new'), key('variant')]);
  });

  it('honours a custom threshold', async () => {
    const { index } = setup();
    await index.add(key('a'), sig(announce()));
    expect(await index.candidates(scope(), sig(unrelated[0]!), 0)).toHaveLength(1);
  });

  it('remove() forgets an entry', async () => {
    const { index } = setup();
    await index.add(key('a'), sig(announce()));
    await index.remove(key('a'));
    expect(await index.candidates(scope(), sig(announce()))).toEqual([]);
    expect(await index.size()).toBe(0);
  });
});

describe('RepeatIndex capacity', () => {
  it('evicts the least recently used entry beyond the cap; touch() protects an entry', async () => {
    const { index, tick } = setup({ maxEntries: 3 });
    await index.add(key('1'), sig(announce()));
    tick();
    await index.add(key('2'), sig(lessons()));
    tick();
    await index.add(key('3'), sig(evidence()));
    tick();
    await index.touch(key('1'));
    tick();
    await index.add(key('4'), sig(unrelated[0]!));
    expect(await index.size()).toBe(3);
    expect(await index.candidates(scope(), sig(lessons()))).toEqual([]); // 2 was least recently used
    expect((await index.candidates(scope(), sig(announce()))).map((c) => c.key)).toEqual([key('1')]);
  });

  it('defaults to 2,000 entries', async () => {
    const kv = memoryKV();
    const index = new RepeatIndex(kv, { persistDelayMs: 10 });
    const s = sig(announce());
    for (let i = 0; i < 2005; i++) await index.add(key(`k${i}`), s);
    expect(await index.size()).toBe(2000);
  });
});

describe('RepeatIndex persistence', () => {
  it(`persists under "${STORAGE_KEY}" with one write per burst, and a new instance finds the entries`, async () => {
    const { kv, index } = setup({ persistDelayMs: 10 });
    for (let i = 0; i < 5; i++) await index.add(key(`k${i}`), sig(announce()));
    expect(kv.writtenKeys.filter((k) => k.includes(STORAGE_KEY))).toHaveLength(0); // debounced
    await wait(30);
    expect(kv.writtenKeys.filter((k) => k.includes(STORAGE_KEY))).toHaveLength(1);
    const saved = entriesOf(kv);
    expect(Object.keys(saved)).toHaveLength(5);
    for (const v of Object.values(saved)) {
      expect(typeof v.s).toBe('string');
      expect(typeof v.t).toBe('number');
    }
    const again = new RepeatIndex(kv, { persistDelayMs: 10 });
    expect(await again.size()).toBe(5);
    expect(await again.candidates(scope(), sig(announce('Contoso')))).toHaveLength(5);
  });

  it('flush() writes at once', async () => {
    const { kv, index } = setup({ persistDelayMs: 60_000 });
    await index.add(key('a'), sig(announce()));
    await index.flush();
    expect(Object.keys(entriesOf(kv))).toEqual([key('a')]);
  });

  it('skips corrupt stored entries one by one, and survives a corrupt store', async () => {
    const kv = memoryKV();
    const good = encodeSignature(sig(announce()));
    kv.data[STORAGE_KEY] = stored({
      [key('good')]: { s: good, t: 5 },
      [key('not-object')]: 'x',
      [key('bad-base64')]: { s: '!!!!', t: 5 },
      [key('short')]: { s: good.slice(8), t: 5 },
      [key('bad-time')]: { s: good, t: 'yesterday' },
      'no-separator': { s: good, t: 5 },
    });
    const index = new RepeatIndex(kv, { persistDelayMs: 10 });
    expect(await index.size()).toBe(1);
    expect((await index.candidates(scope(), sig(announce()))).map((c) => c.key)).toEqual([key('good')]);

    for (const junk of ['corrupted', 42, null, [1, 2], stored('not an object' as any)]) {
      const kv2 = memoryKV();
      kv2.data[STORAGE_KEY] = junk;
      const i2 = new RepeatIndex(kv2, { persistDelayMs: 10 });
      expect(await i2.size()).toBe(0);
      await i2.add(key('a'), sig(announce()));
      expect(await i2.size()).toBe(1);
    }
  });

  it('clear() empties memory and storage (the key is kept: security S2)', async () => {
    const { kv, index } = setup();
    await index.add(key('a'), sig(announce()));
    await index.flush();
    await index.clear();
    expect(await index.size()).toBe(0);
    expect(entriesOf(kv)).toEqual({});
    expect(await new RepeatIndex(kv).size()).toBe(0);
  });

  it('stores no post text: only keys, encoded hashes and times', async () => {
    const { kv, index } = setup();
    const text = announce('Northwind');
    await index.add(key('a'), sig(text));
    await index.flush();
    const stored = JSON.stringify(kv.data);
    const distinctive = [...new Set(text.match(/\p{L}{5,}/gu) ?? [])];
    expect(distinctive.length).toBeGreaterThan(20);
    for (const w of distinctive) expect(stored, `"${w}" leaked into storage`).not.toContain(w);
  });
});

describe('RepeatIndex races', () => {
  it('a clear() while the first load is still reading storage is not undone by that load', async () => {
    const kv = memoryKV({ delayMs: 20 });
    kv.data[STORAGE_KEY] = stored({ [key('old')]: { s: encodeSignature(sig(announce())), t: 1 } });
    const index = new RepeatIndex(kv, { persistDelayMs: 10 });
    const pending = index.size(); // starts the (slow) load
    await index.clear();
    await pending;
    expect(await index.size()).toBe(0);
    expect(await index.candidates(scope(), sig(announce()))).toEqual([]);
  });
});

describe('RepeatIndex: signatures from the previous version (finding C)', () => {
  it('deletes the old "repeats:v1" index on first load and keeps the current one', async () => {
    const kv = memoryKV();
    kv.data['repeats:v1'] = { [key('old')]: { s: 'A'.repeat(684), t: 1 } };
    kv.data[STORAGE_KEY] = stored({ [key('a')]: { s: encodeSignature(sig(announce())), t: 5 } });
    const index = new RepeatIndex(kv, { persistDelayMs: 10 });
    expect(await index.size()).toBe(1);
    expect('repeats:v1' in kv.data).toBe(false);
    expect((await index.candidates(scope(), sig(announce()))).map((c) => c.key)).toEqual([key('a')]);
  });

  it('does not try to delete anything when there is no old index', async () => {
    const kv = memoryKV();
    const remove = vi.spyOn(kv, 'remove');
    const index = new RepeatIndex(kv, { persistDelayMs: 10 });
    await index.size();
    expect(remove).not.toHaveBeenCalled();
  });
});

describe('RepeatIndex: the per-install signature key (security S2)', () => {
  it('creates a 16-byte key on first use, stores it with the entries, and a new instance reads the same key', async () => {
    const kv = memoryKV();
    const index = new RepeatIndex(kv, { persistDelayMs: 10 });
    const k = await index.key();
    expect(k).toBeInstanceOf(Uint8Array);
    expect(k).toHaveLength(16);
    expect(Array.from(k)).not.toEqual(Array.from(PUBLIC_TEST_KEY));
    await index.flush();
    expect((kv.data[STORAGE_KEY] as { key: string }).key).toBe(encodeKey(k));
    expect(Array.from(await new RepeatIndex(kv).key())).toEqual(Array.from(k));
  });

  it('a missing or corrupt stored key means a new key and an empty index (never compare across keys)', async () => {
    const entry = { [key('a')]: { s: encodeSignature(sig(announce())), t: 5 } };
    for (const badKey of [undefined, 'garbage', 42, encodeKey(PUBLIC_TEST_KEY).slice(4)]) {
      const kv = memoryKV();
      kv.data[STORAGE_KEY] = badKey === undefined ? { entries: entry } : stored(entry, badKey);
      const index = new RepeatIndex(kv, { persistDelayMs: 10 });
      expect(await index.size(), String(badKey)).toBe(0);
      expect(await index.key()).toHaveLength(16);
    }
  });

  it('clear() empties the entries and keeps the key', async () => {
    const kv = memoryKV();
    const index = new RepeatIndex(kv, { persistDelayMs: 10 });
    const k = await index.key();
    await index.add(key('a'), sig(announce()));
    await index.clear();
    expect(Array.from(await index.key())).toEqual(Array.from(k));
    expect((kv.data[STORAGE_KEY] as { key: string }).key).toBe(encodeKey(k));
    expect(entriesOf(kv)).toEqual({});
  });

  it('concurrent first uses create one key (one storage read)', async () => {
    const g = gatedKV();
    const reads = vi.spyOn(g.kv, 'get');
    const index = new RepeatIndex(g.kv, { persistDelayMs: 10 });
    const release = g.hold(STORAGE_KEY);
    const uses = Promise.all([index.key(), index.key(), index.size()]);
    await until(() => g.isBlocked(STORAGE_KEY), 'first load reading');
    release();
    const [k1, k2] = await uses;
    expect(Array.from(k1)).toEqual(Array.from(k2));
    expect(reads.mock.calls.filter(([k]) => k === STORAGE_KEY)).toHaveLength(1);
  });

  it('deletes the unkeyed indexes of earlier versions (repeats:v1, repeats:v2) on first load', async () => {
    const kv = memoryKV();
    kv.data['repeats:v1'] = { [key('x')]: { s: 'A'.repeat(684), t: 1 } };
    kv.data['repeats:v2'] = { [key('y')]: { s: 'A'.repeat(684), t: 1 } };
    await new RepeatIndex(kv, { persistDelayMs: 10 }).size();
    expect('repeats:v1' in kv.data).toBe(false);
    expect('repeats:v2' in kv.data).toBe(false);
    expect(decodeKey(encodeKey(PUBLIC_TEST_KEY))).not.toBeNull();
  });
});

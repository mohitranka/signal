/**
 * Performance P1 + P3a (docs/design-performance-p1-p3.md):
 *  - P1: a signature is encoded once (when added); saves reuse the kept string, and loaded entries are never re-encoded.
 *  - P3a: a touch() (a copy used an entry) does not trigger a save by itself; the new time rides along with the next
 *    real change, or an explicit flush (what the service worker does on suspend).
 * encodeSignature is wrapped in a counting spy; its real behaviour is kept.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/shared/similarity', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/shared/similarity')>();
  return { ...real, encodeSignature: vi.fn(real.encodeSignature) };
});

import { RepeatIndex } from '../src/background/repeatIndex';
import { PROMPT_VERSION } from '../src/classifier/prompt';
import { PUBLIC_TEST_KEY, encodeKey, encodeSignature, signature } from '../src/shared/similarity';
import { announce, evidence, lessons, unrelated } from './fixtures/templates';
import { fpFor, memoryKV } from './helpers';

const STORAGE_KEY = 'repeats:v3';
const key = (label: string) => `${PROMPT_VERSION}|m|${fpFor(label)}`;
const sig = (text: string) => signature({ text }, PUBLIC_TEST_KEY)!;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const encodes = vi.mocked(encodeSignature);

/** An index whose storage already holds 3 entries (as after a service-worker restart). */
async function loaded(persistDelayMs = 10, now?: () => number) {
  const kv = memoryKV();
  const real = await vi.importActual<typeof import('../src/shared/similarity')>('../src/shared/similarity');
  const stored = {
    [key('a')]: { s: real.encodeSignature(sig(announce())), t: 1 },
    [key('b')]: { s: real.encodeSignature(sig(lessons())), t: 2 },
    [key('c')]: { s: real.encodeSignature(sig(evidence())), t: 3 },
  };
  kv.data[STORAGE_KEY] = { key: encodeKey(PUBLIC_TEST_KEY), entries: stored };
  const index = new RepeatIndex(kv, { persistDelayMs, ...(now ? { now } : {}) });
  await index.size(); // first load
  return { kv, index, stored };
}
const entriesOf = (kv: { data: Record<string, unknown> }) => (kv.data[STORAGE_KEY] as { entries: Record<string, { s: string; t: number }> }).entries;

describe('P1: signatures are encoded once', () => {
  it('loaded entries are never re-encoded; an added one is encoded once, however many saves follow', async () => {
    const { index } = await loaded();
    encodes.mockClear();
    await index.add(key('d'), sig(unrelated[0]!));
    await index.flush();
    await index.add(key('e'), sig(unrelated[1]!)); // a second change, a second save
    await index.flush();
    expect(encodes).toHaveBeenCalledTimes(2); // d once, e once; never a, b, c; never again on the second save
  });

  it('saves write each loaded entry\'s stored string unchanged', async () => {
    const { kv, index, stored } = await loaded();
    await index.add(key('d'), sig(unrelated[0]!));
    await index.flush();
    const saved = entriesOf(kv);
    for (const k of Object.keys(stored)) expect(saved[k]!.s).toBe(stored[k]!.s);
  });
});

describe('P3a: a touch alone does not save', () => {
  it('after a save, touch() causes no write, even once the save delay has passed', async () => {
    const { kv, index } = await loaded(10);
    await index.flush();
    const writes = kv.writtenKeys.filter((k) => k.includes(STORAGE_KEY)).length;
    await index.touch(key('a'));
    await wait(40); // four save delays
    expect(kv.writtenKeys.filter((k) => k.includes(STORAGE_KEY)).length).toBe(writes);
  });

  it('the touched time is written with the next real change, and by an explicit flush (on suspend)', async () => {
    // The index's own injectable clock (it captures its clock when constructed).
    let clock = 1_000_000;
    const { kv, index } = await loaded(10, () => clock);
    const clockStart = (clock = 2_000_000);
    await index.touch(key('a'));
    await index.add(key('d'), sig(unrelated[0]!)); // a real change: its save carries the touched time
    await wait(40);
    expect(entriesOf(kv)[key('a')]!.t).toBe(clockStart);
    clock = clockStart + 5;
    await index.touch(key('b'));
    await index.flush(); // what the service worker does in onSuspend
    expect(entriesOf(kv)[key('b')]!.t).toBe(clockStart + 5);
  });
});

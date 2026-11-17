/**
 * Finding E (docs/design-finding-e-lazy-load.md): CacheStore and StatsStore load from storage on first use. Concurrent
 * first uses must share one read (no copy replaces another), a Clear cache during that read must win, and a failed read
 * must be retried on the next use. Storage reads are held back deterministically (gatedKV), not timed.
 */
import { describe, expect, it, vi } from 'vitest';
import { CacheStore, StatsStore } from '../src/background/store';
import { cls, gatedKV, noise, until } from './helpers';

/** Make the next read of `key` fail once (storage unavailable), then behave normally. */
function failNextRead(g: ReturnType<typeof gatedKV>, key: string): void {
  const get = g.kv.get;
  let failed = false;
  g.kv.get = async (k: string) => {
    if (k === key && !failed) {
      failed = true;
      throw new Error('storage unavailable');
    }
    return get(k);
  };
}

describe('CacheStore: first load', () => {
  it('E1: Clear cache while the first load is reading really clears (nothing comes back, nothing is served)', async () => {
    const g = gatedKV();
    g.kv.data.cache = { old: { c: cls(), t: 1 } };
    const cache = new CacheStore(g.kv, 2000, 60_000);
    const release = g.hold('cache', { snapshot: true }); // the read has already fetched the old data when Clear arrives
    const reading = cache.get('old');
    await until(() => g.isBlocked('cache'), 'first load is reading');
    await cache.clear();
    release();
    await reading;
    expect(await cache.size()).toBe(0);
    expect(await cache.get('old')).toBeNull();
    await cache.flush();
    expect(g.kv.data.cache).toEqual({});
  });

  it('E2: a verdict stored while another first use is reading is kept, in memory and in storage', async () => {
    const g = gatedKV();
    g.kv.data.cache = { old: { c: cls(), t: 1 } };
    const cache = new CacheStore(g.kv, 2000, 60_000);
    const release = g.hold('cache');
    const storing = cache.set('new', noise());
    const looking = cache.get('old');
    await until(() => g.isBlocked('cache'), 'first load is reading');
    release();
    await Promise.all([storing, looking]);
    expect(await cache.get('new')).toEqual(noise());
    expect(await cache.get('old')).toEqual(cls());
    await cache.flush();
    expect(Object.keys(g.kv.data.cache as object).sort()).toEqual(['new', 'old']);
  });

  it('concurrent first uses cause one storage read', async () => {
    const g = gatedKV();
    g.kv.data.cache = { old: { c: cls(), t: 1 } };
    const cache = new CacheStore(g.kv, 2000, 60_000);
    const reads = vi.spyOn(g.kv, 'get');
    const release = g.hold('cache');
    const uses = [cache.get('old'), cache.get('x'), cache.size(), cache.set('y', cls())];
    await until(() => g.isBlocked('cache'), 'first load is reading');
    release();
    await Promise.all(uses);
    expect(reads.mock.calls.filter(([k]) => k === 'cache')).toHaveLength(1);
  });

  it('a failed first read is not remembered: the next use reads again and works', async () => {
    const g = gatedKV();
    g.kv.data.cache = { old: { c: cls(), t: 1 } };
    failNextRead(g, 'cache');
    const cache = new CacheStore(g.kv, 2000, 60_000);
    await expect(cache.get('old')).rejects.toThrow('storage unavailable');
    expect(await cache.get('old')).toEqual(cls());
  });
});

describe('StatsStore: first load', () => {
  it('E3: updates made while the first read is in flight are all counted, in memory and in storage', async () => {
    const g = gatedKV();
    g.kv.data.stats = { cacheHits: 10 };
    const stats = new StatsStore(g.kv);
    const release = g.hold('stats');
    const bumps = [stats.bump({ cacheHits: 1 }), stats.bump({ cacheHits: 1 }), stats.bump({ cacheHits: 1, promptTokens: 500 })];
    await until(() => g.isBlocked('stats'), 'first read is in flight');
    release();
    await Promise.all(bumps);
    expect(await stats.get()).toMatchObject({ cacheHits: 13, promptTokens: 500 });
    expect(g.kv.data.stats).toMatchObject({ cacheHits: 13, promptTokens: 500 });
  });

  it('concurrent first uses cause one storage read', async () => {
    const g = gatedKV();
    const stats = new StatsStore(g.kv);
    const reads = vi.spyOn(g.kv, 'get');
    const release = g.hold('stats');
    const uses = [stats.get(), stats.bump({ classified: 1 }), stats.get()];
    await until(() => g.isBlocked('stats'), 'first read is in flight');
    release();
    await Promise.all(uses);
    expect(reads.mock.calls.filter(([k]) => k === 'stats')).toHaveLength(1);
  });

  it('a failed first read is retried on the next use', async () => {
    const g = gatedKV();
    g.kv.data.stats = { cacheHits: 4 };
    failNextRead(g, 'stats');
    const stats = new StatsStore(g.kv);
    await expect(stats.get()).rejects.toThrow('storage unavailable');
    expect((await stats.get()).cacheHits).toBe(4);
  });
});

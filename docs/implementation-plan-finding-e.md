# Implementation plan: finding E (guarded first loads in CacheStore and StatsStore)

Status: **implemented**.
Design: `docs/design-finding-e-lazy-load.md` (approved; step 3 skipped: no UI change).

Working agreement as before: tests first, confirmed failing for the intended reason; smallest change; full suite (also
with `SIGNAL_TEST_SLOW_HASH`), typecheck and build; one commit; report.

## Change (one task): `src/background/store.ts`

- `CacheStore`: `private loading: Promise<Map> | null`. `load()` returns the in-memory map if present. Otherwise it
  returns the one shared in-flight read, which on success sets `this.map ??= loaded` (a `clear()` meanwhile wins) and
  returns `this.map`. The shared read is dropped when it settles, so a failure is retried on the next use.
- `StatsStore`: the same shared read for `get()` (`this.stats ??= loaded`).

## Tests first: `tests/store-first-load.test.ts` (new)

Storage reads are held back deterministically with `gatedKV().hold(key)` (from `tests/helpers.ts`), not with timing.

| # | Case | Expected before fix |
|---|---|---|
| 1 | **E1:** a cached verdict in storage; Clear cache while the first load is reading → afterwards 0 entries, the old verdict is not served, storage is empty | fails (1 entry, served) |
| 2 | **E2:** a verdict is stored while another first use's read is in flight → it is still cached, and persisted together with the old entry | fails (lost) |
| 3 | Concurrent first uses of the cache cause **one** storage read | fails (one read each) |
| 4 | A failed first read is not remembered: the next use reads again and works | passes (guard: today's behaviour) |
| 5 | **E3:** three statistics updates while the first read is in flight → `cacheHits` = 3, in memory and in storage | fails (1) |
| 6 | Concurrent first uses of the statistics cause **one** storage read | fails |
| 7 | A failed first statistics read is retried on the next use | passes (guard) |

Existing cache, eviction, statistics, finding A (cancel generation) and repeats tests must stay green.

## Done when

All pass; full suite green (also slow-hash); typecheck and build clean. The three reproductions from step 2 (E1–E3,
real timing with 20 ms storage) are re-run and show the expected values. Design doc status set to implemented.

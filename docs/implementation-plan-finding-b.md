# Implementation plan: finding B (repeat lookup must not refresh unused cache entries)

Status: **implemented**.
Design: `docs/design-finding-b-cache-refresh.md`, option 1 (approved; step 3 skipped: no UI change).

Working agreement as before: tests first, confirmed failing for the intended reason; smallest change; full suite (also
with `SIGNAL_TEST_SLOW_HASH`), typecheck and build; one commit; report.

## Change (one task)

- `src/background/store.ts`: `CacheStore.peek(key): Promise<Classification | null>`. Same loading path as `get`, but
  the entry's time is not updated.
- `src/background/classifyService.ts`, `judgedMatch`: read candidates with `peek`. When a copy is made, refresh only
  the copied entry with `get`. Removing index entries whose verdict left the cache is unchanged.

## Tests first: `tests/cache-refresh.test.ts` (new)

"Recently used" is observed exactly: the cache is flushed and each entry's stored time `t` is read from storage. The
clock is fixed per step (`vi.setSystemTime`, only `Date` faked), so every time is known.

| # | Case | Expected before fix |
|---|---|---|
| 1 | `peek` returns the verdict (null if absent) and leaves the entry's time unchanged; `get` still updates it | fails: no `peek` |
| 2 | **Copy refused (highlight):** a variant of a highlight post is looked up → the highlight entry's time is unchanged | fails: refreshed |
| 3 | **Copy refused (disagreeing verdicts):** neither candidate's time changes | fails: both refreshed |
| 4 | **Copy made:** only the copied (most similar) entry's time is updated; the other, less similar candidate's is not | fails: both refreshed |
| 5 | Regression: a candidate whose verdict left the cache is still dropped from the index and the model is asked | passes (guard) |

Existing cache, eviction and repeats tests must stay green.

## Done when

All pass; full suite green (also slow-hash); typecheck and build clean; the design doc status is set to implemented
with the result; the measurement from step 2 is re-run and shows 0 refreshes of entries not copied.

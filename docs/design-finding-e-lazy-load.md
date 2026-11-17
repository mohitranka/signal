# Finding E: unguarded first loads in CacheStore and StatsStore

Status: **implemented** (shared first read + reset wins, in `CacheStore` and `StatsStore`).

## Problem

`CacheStore` and `StatsStore` read their data from storage lazily, on first use, like this:

```ts
if (!this.map) { const { cache } = await this.kv.get('cache'); this.map = new Map(...); }
```

Nothing guards the await. Two consequences, both reproduced with storage that takes 20 ms per operation:

| # | Situation | Observed | Expected | Effect |
|---|---|---|---|---|
| E1 | **Clear cache** while the cache's first load is still reading | 1 entry left, still served | 0 | Clear cache silently does not clear (the originally reported finding) |
| E2 | **Two first uses at once**, e.g. a verdict stored while another request's load is still reading | the new verdict is gone from memory **and** storage | kept | One extra model call later for that post |
| E3 | **Three statistics updates at once** when the service worker wakes (e.g. several cache hits) | `cacheHits` = 1 | 3 | The popup under-reports; for tokens, the **cost estimate is too low** |

Cause: each concurrent first use starts its own storage read, and whichever finishes last **replaces** the in-memory
copy, dropping anything written to the copy it replaced. A load that finishes after `clear()` likewise replaces the
cleared copy. The same pattern was fixed in `RepeatIndex` during T4. These two older stores were not checked then.

Also checked, and not affected:
- `SettingsStore` reads storage on every load (no in-memory copy).
- `FeedbackStore` runs every operation through one queue and tracks a generation.
- `RepeatIndex` is already fixed.

How likely: all three need operations to overlap with the first storage read after the service worker starts (a few
milliseconds, longer on a busy machine). E3 is the most likely: a feed full of cached posts produces many statistics
updates at once on wake-up. E2 needs a write during that window, which is rare, because verdicts are written only after
a model call. E1 needs Clear cache at that moment. Severity: low (E1, E2) to moderate (E3: wrong cost figures).

## Proposed fix: the pattern already used in RepeatIndex

For both stores:
1. **One load at a time.** Concurrent first uses share one in-flight read (a single promise), so no copy replaces
   another.
2. **A reset wins.** When the read completes, it fills the in-memory copy only if nothing set one in the meantime
   (`this.map ??= loaded`). So `clear()` during the first load stays cleared.
3. **A failed read is not cached.** The in-flight promise is dropped on failure, so the next use tries again (today's
   behaviour, kept).

`StatsStore` gets only (1) and (3): it has no reset.

### Alternatives considered

- **A shared lazy-load helper** used by all three stores. Tidier, but it refactors `RepeatIndex` (already tested) for no
  behaviour gain. It can be done later on its own.
- **Route cache operations through a queue** (like `FeedbackStore`). Heavier, and it serialises every cache read on the
  hot path. Not needed: the bug is only in the first load.

## Scope

- `src/background/store.ts`: `CacheStore.load`, `CacheStore.clear` (clear wins) and `StatsStore.get`.
- No message, storage format or UI change. **No mockups (step 3 skipped, if you agree).**

## Risks

Negligible. The change only affects the first load. After it, both stores behave exactly as today. Existing cache,
eviction and statistics tests keep covering the normal path.

## Result (step 6)

The step-2 reproductions (20 ms storage, real timing), re-run unchanged:

| | before | after |
|---|---|---|
| E1: entries after Clear cache during the first load | 1 (still served) | **0** |
| E2: verdict stored during another first load | lost (memory and storage) | **kept and persisted** |
| E3: three statistics updates at wake-up | 1 counted | **3** |

Found in step 5: the first E1 test passed before the fix. The test helper's held read fetched the data only when
released, i.e. after Clear cache had written the empty cache. The real race is a read that fetched the old data before
the clear and delivers it after. `gatedKV().hold(key, { snapshot: true })` now models that (opt-in, so earlier tests are
unchanged), and E1 then failed with the real bug before the fix.

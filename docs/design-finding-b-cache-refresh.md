# Finding B: the repeat lookup refreshes cache entries it does not use

Status: **implemented** (option 1: `CacheStore.peek`; only the copied entry is marked used).

## Problem

The classification cache evicts least-recently-used entries beyond 2,000. `CacheStore.get()` counts as a use: it sets
the entry's time to now. The repeat lookup (`ClassifyService.judgedMatch`) reads **every** candidate's verdict with
`get()`, including:

- candidates that are not copied (only the most similar one is); and
- all candidates when nothing is copied (a highlight among them, or disagreeing verdicts).

Those entries then look recently used, and survive eviction ahead of entries that really were used.

## How much it matters (measured)

20 shuffled passes of the 40-row fixture set (`eval/repeats.jsonl`) through the real service:

| | |
|---|---|
| repeat lookups | 740 |
| cache refreshes by the lookup | 460 |
| … of entries **not** copied | **60 (13%)**, all in the one family whose verdicts are highlights |

In an ordinary template family only the first post is judged by the model, and later variants find exactly one
candidate and copy it, so nothing is wasted. Refreshes of unused entries happen only when copying is refused: highlight
families (each variant is judged, and each new one refreshes all earlier ones) and disagreeing verdicts.

**Effect:** eviction order only. Entries for repeatedly seen highlight/disagreeing templates stay cached somewhat longer
than LRU says. There is no effect on verdicts, privacy or correctness. Cost would only be affected if it pushed out an
entry that would later be hit exactly, i.e. a full cache (2,000 entries) with many highlight templates.
**Severity: low.**

## Options

### 1. Fix: read candidates without refreshing them (recommended: small, local, low risk)

- `CacheStore.peek(key)`: returns the verdict **without** updating its time.
- `judgedMatch` reads candidates with `peek`. Only when it **copies** does it refresh the copied post's entry
  (`get`): its verdict was used, so it is rightly "recently used". The index entry is already touched today.
- The stale-entry rule is unchanged: a candidate whose verdict left the cache is removed from the index.
- About 10 lines in `store.ts` and `classifyService.ts`. No message, storage or UI change.

### 2. Won't fix (document only)

Record the behaviour in the design notes as accepted. Reasonable given the low severity; the argument against is that
the fix is cheap and makes "recently used" mean what it says.

## Scope (option 1)

- `src/background/store.ts`: `CacheStore.peek`.
- `src/background/classifyService.ts`: `judgedMatch` uses `peek`, and refreshes only the copied entry.
- **No UI change: step 3 (mockups) skipped, if you agree.**

## Risks

Negligible. `peek` shares `get`'s loading path, so it behaves identically apart from not touching the time. Existing
eviction and cache tests keep covering `get`.

## Result (step 6)

The step-2 measurement, re-run unchanged (20 shuffled passes of `eval/repeats.jsonl` through the real service):

| | before | after |
|---|---|---|
| repeat lookups | 740 | 740 |
| copies / model calls | 400 / 400 | 400 / 400 (unchanged behaviour) |
| cache refreshes by the lookup | 460 | 400 (one per copy) |
| … of entries not copied | 60 | **0** |

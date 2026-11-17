# Finding A: requests slip past "cancel all"

Status: **implemented** (cancel generation + queue forgets aborted requests). See "Correction" at the end: the
reproduction below showed a *different* window, which this fix does not close (tracked as finding A2).

## Problem (reproduced)

`ClassifyService.cancelAll()` only reaches requests that are already **in the queue** (queued or running) or already
**waiting for a similar request**. A request still on its way there keeps going: it has read the settings and is
checking the cache, looking for a similar judged post, or (repeats) about to wait. It then enqueues a model call
**with the settings it read at its start**.

`cancelAll` is sent in three situations:

| Trigger | Effect of a slipped request |
|---|---|
| You save a new **model, endpoint or API key** | Post text goes to the **old endpoint with the old key**. Reproduced: after switching `https://cloud.example.com` + `OLD-KEY` to `http://localhost:11434` + `NEW-KEY`, one post was still sent to the cloud with `OLD-KEY`. A privacy and cost problem: switching to a local model is exactly what someone does to keep posts off the internet. |
| **Clear cache** | A wasted call; its verdict lands in the freshly cleared cache. |
| The feed page stops (navigated away, Signal switched off) | A wasted call whose result nobody uses. |

This predates the repeats feature (reproduced with repeats off). Repeats widens the window, because it adds awaits
(index lookup, cache reads of candidates) between reading the settings and enqueueing.

## Proposed fix: a cancel generation

- `ClassifyService` keeps a counter, `generation`. `cancelAll()` increments it, in addition to what it does today.
- `classify()` records the generation **synchronously on entry**, before its first await, so any request that might have
  read the old settings carries the old generation.
- The request is refused, with `{ ok: false, kind: 'aborted' }` and no failure counted (as for any cancelled request),
  at every point where it would spend or commit something:
  1. just before enqueueing the model call (no await between the check and `queue.run`);
  2. when the queue actually **starts** the task (defence in depth: a task is never started for an old generation);
  3. before returning a **copy** (from a judged post or from a waited-for request), and before registering a wait;
  4. before writing a result to the cache and the repeat index. A request that was already running when `cancelAll`
     came is aborted today anyway; this also covers a result that races the abort.
- Exact-cache **hits** are still answered (reading a verdict spends nothing and sends nothing). Only work that would
  call the model, or return or store a result made under the old settings, is refused.

### What the feed sees (unchanged behaviour)

A refused request looks exactly like today's cancelled ones: `aborted`. The content script already handles that.
- After a model change the tab gets `settingsChanged`, moves to a new epoch and re-requests everything.
- After **Clear cache** the post is marked failed and retried on the `settingsChanged` that follows.
- After the page stops, the result is ignored.

No post is hidden by this. A refused request leaves the post as LinkedIn drew it (fail open), as today.

### Alternatives considered

- **Re-read the settings just before enqueueing and compare.** This misses a cache clear and a page stop, which leave
  the settings unchanged, and still races a save in progress.
- **Cancel by key list.** It needs bookkeeping for every stage and is easy to get wrong. One counter covers all stages.

## Scope

- Changed: `src/background/classifyService.ts` only (plus tests). Nothing else changes: no message types, no storage,
  no UI.
- **No UI change, so no mockups.** I propose skipping step 3 for this finding.
- Per-post `cancel {fp}` (text grew) is unchanged: it is per sender and per request, and not affected by this finding.

## Risks

- A request that started just before a save with the **new** settings already visible is also refused (it carries
  the old generation). It costs nothing: the feed re-requests it right after.
- `testConnection` is not affected (it neither caches nor uses the queue).

## Correction (found in step 6)

The reproduction under "Problem" did **not** show a request slipping past cancel all. A timeline of the same scenario
shows the model call going out **after the Save message arrived but before the save was written and cancel all ran**:

```
 20ms classify starts
 29ms user presses Save (message arrives)
 44ms model call sent to cloud.example.com with Bearer OLD-KEY
 51ms classify result: ok
 61ms cancelAll (save is committed)
```

So two windows exist:

1. **Slipping past cancel all** (a request still being prepared when cancel all runs): real, shown by the gated tests in
   `tests/cancel-generation.test.ts` (they failed before this fix), and **fixed** here.
2. **While the save is being written** (the handler cancels only after the new settings are stored; until then the
   old ones are current): **not fixed** by this design. Tracked as finding A2.

Implementation detail added in step 6 (within this design): `TaskQueue.cancelAll` also forgets aborted requests for
deduplication, so a request made after cancel all never attaches to an aborted one still running. An answer that
races the abort still counts towards requests and tokens (it was paid for), but not towards "classified".

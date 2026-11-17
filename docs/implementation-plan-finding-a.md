# Implementation plan: finding A ("cancel all" must stop every earlier request)

Status: **implemented**.
Design: `docs/design-finding-a-cancel-all.md` (approved; step 3 skipped: no UI change).

Same working agreement as the feature: tests first, confirmed failing for the intended reason; smallest change to make
them pass; full suite (also with `SIGNAL_TEST_SLOW_HASH`), typecheck and build; one commit; report.

## Change (one task)

`src/background/classifyService.ts`:

```ts
private generation = 0;
cancelAll(): void { this.generation++; /* + today's aborts of joins and the queue */ }

async classify(...) {
  const gen = this.generation;            // synchronously, before the first await
  ...
  const stale = () => gen !== this.generation;
}
```

Checks, each returning `{ ok: false, kind: 'aborted', message: 'Cancelled.' }` with no failure counted:

| # | Where | Why |
|---|---|---|
| 1 | Right before `queue.run` (no await in between) | No model call for a request that started before cancel all |
| 2 | First line of the queued task (`if stale → throw AbortedError`) | Defence in depth: a task is never started for an old generation |
| 3 | Before returning a copy (from a judged post or a waited-for request), and before registering a wait | No verdict made under old settings is handed out |
| 4 | After the model answers, before `cache.set` / `repeats.add` | A result that races the abort is neither stored nor returned |

Exact-cache hits are returned as today, whatever the generation.

## Tests first: `tests/cancel-generation.test.ts` (new)

A slow `memoryKV({ delayMs })` opens the window between "settings read" and "enqueued". Each case starts a request,
waits until it is inside the window (a condition, not a fixed delay: storage reads are counted), then triggers cancel
all through the **handler**, as in production.

1. **New endpoint and key saved** while the request reads the cache → no request to the old endpoint (none at all), result
   `aborted`, `failures` unchanged. With repeats off.
2. Same, with repeats on and the request inside the **repeat lookup** (the index load is slow).
3. **Clear cache** inside the window → no model call, `aborted`.
4. **Content `cancelAll`** (page stops) inside the window → no model call, `aborted`.
5. **Task start check:** cancel all happens after the enqueue check but before the task starts (forced by wrapping the
   service's queue in the test, which reads internals as the existing tests do) → the task never calls fetch; `aborted`.
6. **No copy after cancel:** an anchor exists; cancel all while the variant is in the repeat lookup → `aborted`, not a
   copy; `repeatHits` stays 0.
7. **No store after cancel:** a provider that ignores the abort signal answers after cancel all → nothing cached, nothing
   indexed, result `aborted`.
8. **Exact cache hit still answered:** the verdict is cached; cancel all while the request reads the cache → `ok`,
   `cached: true`.
9. **Requests after cancel all work normally:** after the save, a new request goes to the **new** endpoint with the new
   key and succeeds.

Expected before the fix: 1–7 fail (7 shows a cached/indexed result); 8 and 9 pass (regression guards).

## Done when

All of the above pass. The existing cancel, concurrency and repeats suites stay green, also in slow-hash mode.
Typecheck and build are clean. README security paragraph: one sentence ("cancel all also stops requests still being
prepared; a request is never sent with settings you have just replaced").

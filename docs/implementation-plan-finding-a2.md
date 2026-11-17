# Implementation plan: finding A2 (hold model calls while model settings are saved)

Status: **implemented**.
Design: `docs/design-finding-a2-save-window.md` (approved; step 3 skipped: no UI change).

Working agreement as before: tests first, each confirmed failing for the intended reason; smallest change; full suite
(also with `SIGNAL_TEST_SLOW_HASH`), typecheck and build; one commit; report.

## Change (one task)

`src/background/classifyService.ts`:

```ts
/** While any hold is active no model call starts and no copy is handed out. Returns an idempotent release. */
hold(): () => void
private holds = 0;              // counted: overlapping saves
private holdEnded: Promise<void> // resolves when the count returns to 0
private async afterHolds(): Promise<void> // awaits until holds === 0
```

- Queued task: `await this.afterHolds()` → generation check (finding A) → `classifyPost(...)`.
- Copy path (`classify`, before returning a copy): `await this.afterHolds()` → generation check → return copy.
- Exact-cache hits: unchanged (not held).

`src/background/handlers.ts`, `saveSettings`:

```ts
const touchesModel = 'model' in patch || 'endpoint' in patch || 'apiKey' in patch;  // on the raw message patch
const release = touchesModel ? d.service.hold() : () => {};   // synchronously, before the first await
try {
  before = load; after = save;
  if (model/endpoint/key changed) d.service.cancelAll();
} finally { release(); }
notifyTabs; return
```

## Tests first: `tests/settings-save-window.test.ts` (new)

The storage stand-in holds back the **write** of `settings`, parking the save handler mid-save deterministically. A
request counts as "parked" when it is waiting on the hold. The test reads the service's count of waiters (internals,
test-only, like the existing `settled()` helpers). Before the fix that count does not exist, so the tests wait for
"fetch called or parked".

| # | Case | Expected before fix |
|---|---|---|
| 1 | **New request during a save that changes endpoint + key** → never sent with the old key; after the write it is refused (`aborted`) | fails: sent with OLD-KEY |
| 2 | **Queued request gets its slot during the save** (concurrency 1): the request that was running before the Save may finish; the queued one is not sent with the old key | fails |
| 3 | **Copy during a model change**: an anchor exists; a variant arrives during the save → no copy handed out; `aborted` after the write | fails: copy returned |
| 4 | **Save changing nothing relevant** (same endpoint/model/key, only prices): the held request continues after the write and is sent once | passes (guard: must not be refused) |
| 5 | **Toggle save (mode only)**: no hold. A request during the write is sent at once | passes (guard) |
| 6 | **Save fails** (storage write error): hold released; the request continues with the unchanged old settings; the handler reports the error | passes? (guard: must not hang) |
| 7 | **Overlapping holds** (service API): calls stay held until the **last** release | fails (no `hold()`) |
| 8 | **Release is idempotent**: releasing the same hold twice does not end another holder's hold | fails (no `hold()`) |
| 9 | **Exact cache hit during a model-change save** is answered at once (not held) | passes (guard) |

## Done when

All pass. Finding A's tests, the cancel and concurrency suites and the repeats suites stay green, also in slow-hash
mode. Typecheck and build are clean. The README note from finding A is replaced by the guarantee: *from the moment the
background receives the Save, no model call starts with the replaced endpoint or key.* The design doc status is set to
implemented.

# S7: a tab's "cancel all" cancels only that tab's work

Status: **implemented**. From `docs/security-review.md`.

## Problem (reproduced)

A content script sends `cancelAll` when its tab leaves the feed or Signal is switched off there. The service worker
then cancels **everything**: every queued and running request, every wait for a similar request, and (since finding A)
every request still being prepared, **for all tabs**.

Reproduced: tab B's in-flight request came back `aborted` when tab A navigated away. Tab B's posts are then marked
failed and stay unclassified until a settings change retries them.

- **Usability bug:** two LinkedIn tabs open, leave the feed in one, and the other tab's pending posts silently stop.
- **Abuse path:** a compromised content script in one tab can keep every tab's classification from completing.
- It predates this work. Finding A made it more thorough (requests in preparation are now cancelled too).

## What already exists

- Every request carries a **waiter id** derived from Chrome's own sender record (`tab:<id>:<frame>`); a content script
  cannot choose or forge it.
- Per-post `cancel {fp}` already releases **only the sender's own interest**. A shared request (two tabs waiting for
  the same post) is dropped or aborted only when nobody else waits for it. The same rule applies to waits for similar
  requests.
- The **global** cancel (generation bump, finding A) is right for the popup's **Clear cache** and for **model, endpoint
  or key changes**, which make every tab's work obsolete.

## Proposed fix

1. **Split the two meanings of "cancel all":**
   - `ClassifyService.cancelAll()` stays global. It is used only by the popup paths: Clear cache and model changes (the
     handler's `saveSettings` and `clearCache`).
   - New `ClassifyService.cancelWaiter(waiter)`: everything **this tab** is waiting for:
     - its interest in every queued or running request is released. A shared request is dropped or aborted only if no
       other tab still waits for it (the same counting as per-post `cancel`);
     - its waits for similar requests are ended;
     - its requests still **in preparation** are refused at the same points as finding A's checks (before enqueueing,
       when the task starts, before handing out a copy, before storing a result). This uses a **per-tab generation**
       next to the global one. A request is stale if either has moved on since it started.
2. **Handler:** `cancelAll` from a content script calls `cancelWaiter(<sender's waiter id>)`. The message type stays
   the same, so the content script is unchanged.
3. **A request two tabs share** keeps running for the tab that still wants it. A stored result is stored (it was made
   under current settings).

### What changes for you

Leaving the feed in one tab no longer stops classification in your other LinkedIn tabs. Nothing else changes: Clear
cache and model changes still cancel everything, as before.

### Known limit (documented, not fixed)

If tab B is **waiting on a similar post's request from tab A** (repeats, T6) and tab A leaves, A's request is aborted if
A was its only direct waiter. B then makes its own model call. The cost is one extra model call in a rare case (two tabs,
similar posts, one leaves mid-request), and nothing is lost. Keeping A's request alive for B would mean registering
B's interest on A's request, which complicates per-post `cancel`.

### Alternatives considered

- **Ignore `cancelAll` from content scripts** and rely on per-post `cancel`. Leaving the feed would then leave that
  tab's queued requests running, spending money on posts nobody will see.
- **Per-tab queues.** A heavy change to the concurrency model, for the same effect.

## Scope

- `src/background/classifyService.ts`: `cancelWaiter(waiter)`, the per-tab generation, and staleness checks that
  consider both generations.
- `src/background/handlers.ts`: `cancelAll` from content → `cancelWaiter`.
- No message, storage, content-script or UI change. **Step 3 (mockups) skipped, if you agree.**

## Risks

- Per-tab generations are a small map keyed by tab id. Entries are tiny numbers; it is cleared together with the global
  generation on a global cancel.
- Existing tests that send a content `cancelAll`: four tests in `tests/cancel-generation.test.ts` (finding A) send it
  **without the requesting tab's id** (it defaults to `'unknown'`), while their requests come from `'tab-1'`. They mean
  "this tab's feed stopped", so they will be updated to send it from the same tab, `'tab-1'`. Their assertions do not
  change. Tests calling `service.cancelAll()` directly (the global cancel) are unaffected.

## Result (step 6)

The step-8 reproduction, re-run unchanged: tab B now gets its result (`ok`) after tab A sends cancel all (before:
`aborted`).

Implementation notes:
- Each request takes a **ticket** (global generation + its tab's generation). The task that starts a model call checks
  only the **global** generation, because the task may be shared with a tab that still waits for it; the queue aborts it
  when nobody does. Test 6 covers a shared task that the leaving tab queued first.
- **One test updated beyond the plan:** finding A's "an answer that races the abort is neither stored nor returned" used
  the content cancel as its trigger. Since S7 that cancel is per tab and does not replace settings, and the approved
  design stores such an answer. The test now triggers the race with a real settings change, the scenario it describes,
  with its assertions unchanged (it also passes on the pre-S7 code). The per-tab case has its own test ("an answer
  racing a tab's own cancel is stored … but not returned to that tab"), which was checked to fail on the pre-S7 code.

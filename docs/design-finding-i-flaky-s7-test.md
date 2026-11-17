# Finding I: an intermittent S7 test, and the product race behind it

Status: **implemented** (revised design, plan and tests approved). Found while
running the suite for security B3.

## What happens

`tests/cancel-per-tab.test.ts`, "requests still being prepared: tab A's is refused (never sent); tab B's proceeds",
failed once in a full run and fails about one run in three with `SIGNAL_TEST_SLOW_HASH=25` (a slowed fingerprint, as on
a loaded machine): tab A's request comes back **ok** instead of **aborted**.

## Cause: the test, not Signal

The test's `classify(text, tab)` helper computes the post's fingerprint (`await fingerprint(...)`) **before** it sends
the request to the handler. The test then waits until "a request is blocked on the cache read" and makes tab A leave.
Both requests share one cache load, so that condition becomes true as soon as **either** request reaches it. Under
load, tab B's request gets there while tab A's helper is still hashing: tab A leaves before its request exists, and the
request is then sent **after** the leave. Serving it is correct: it is a new request, as it would be if a tab sent one
after leaving.

Signal's behaviour is as designed (security S7): a request remembers its tab's cancel generation when the handler
receives it, so a request received before the leave is refused. The passing runs show exactly that.

## Proposed change (test only)

In that test, compute both fingerprints first, then hand both requests to the handler in the same tick, so both exist
before tab A leaves. The waiting condition and the assertions stay as they are. The other tests in the file wait on
conditions that each request reaches on its own (its own fetch call, its own queue entry), so they are not affected;
checked by the same slowed runs.

No product change, no UI: step 3 (mockups) does not apply.

## Test plan (steps 4 and 5 in short)

- Red first: a run loop (20 runs with `SIGNAL_TEST_SLOW_HASH=25`) shows the current failure rate (expected a few
  failures).
- Green after: the same 20 runs with the changed test: 0 failures; the full suite in normal and slow mode.
- A guard that the change keeps the test meaningful: with S7's per-tab check removed from the service (mutation), the
  changed test must still fail.

## Revision (step 5 showed the design above was wrong)

To make the red run reliable, the test was given a deterministic version of the load that causes the flake: tab A's
fingerprint takes 50 ms longer than tab B's (a spy on `crypto.subtle.digest`, in this test only). With the old test
body it fails every run, with the same error as the intermittent failure (tab A: `ok` instead of `aborted`): the cause
is confirmed. **But with the planned fix (both requests handed to the handler before tab A leaves) it still fails
every run.** So part of the cause is in Signal, not only in the test.

### The product race

The message handler (`src/background/handlers.ts`, `classify`) re-computes the post's fingerprint (an `await`) **before**
it calls `service.classify`, and the request's cancel ticket (global generation, finding A; tab generation, S7) is taken
inside `classify`. A "cancel all" that arrives while the handler is still re-computing the fingerprint therefore misses
that request: it gets a ticket from **after** the cancel and runs. Demonstrated for both kinds:
- **a tab's cancel all (S7):** the request of a tab that has left the feed still calls the model;
- **a global cancel (Clear cache, model change; finding A):** a request received before it still calls the model
  (with the settings current when it runs, so A2's credential guarantee still holds).

This contradicts the README ("a global cancel also stops requests still being prepared: a request from before it
never calls the model"). Impact is small: one extra model call per request in that window, and the window is the time
a SHA-256 of at most ~5 KB takes (well under a millisecond normally, more on a loaded machine). Severity **Low**. It
predates this work's bridge changes; finding A/S7 moved the ticket as early as `classify`, but not into the handler.

### Revised change

1. **Signal:** take the ticket when the message arrives, before any `await`: the handler asks the service for a ticket
   synchronously (`service.ticket(waiter)`, made public) and passes it to `classify`, which uses it instead of taking
   its own. Other callers (tests, the eval) keep today's behaviour (a ticket taken at the start of `classify`).
2. **The test:** keeps the deterministic slow-A fingerprint, and hands both requests to the handler in the same tick
   (the test-only fix above), so it tests the product, not the helper's timing.
3. **A new test for the global cancel:** a request received before a global cancel, whose fingerprint re-check is
   still running, never calls the model and returns `aborted`.

No UI: step 3 does not apply.

### Tests (red before the change)

- The S7 test with the slow-A fingerprint and both requests sent before the leave: **red** today (verified), green
  after.
- The new global-cancel test: red today (verified with a scratch copy: the model was called once), green after.
- Mutation guard: with the handler's early ticket removed again, both fail.
- 20 runs with `SIGNAL_TEST_SLOW_HASH=25` and the full suite (normal and slow) green.

## Plan (step 4) and tests first (step 5)

One task, one commit: `src/background/classifyService.ts` (`ticket()` public; `classify(…, opts)` accepts
`opts.ticket`), `src/background/handlers.ts` (`classify`: ticket taken as the first statement, passed on), README
sentence unchanged (it becomes true). Tests in `tests/cancel-per-tab.test.ts`, with a shared `slowFingerprint(marker)`
helper (this file only):

| Test | Today |
|---|---|
| S7 "requests still being prepared" (slow tab-A fingerprint; both requests sent before the leave) | **red** (every run) |
| New: a global cancel during the handler's re-check → `aborted`, no model call | **red** (the model is called) |
| New: a tab's cancel during its re-check → its request `aborted`, never sent; the other tab's runs | **red** |
| New guard: a slow re-check without a cancel → `ok` | green (must stay green) |

## Step 6 results

- The three red tests green; the guard green throughout. Full suite 725 passed, also with `SIGNAL_TEST_SLOW_HASH=25`;
  20 slowed runs of the file: 0 failures. Typecheck and build green.
- Mutation: without the handler's early ticket, the three tests fail again.
- One existing assertion updated on purpose: `repeats-handlers.test.ts` checked the exact options passed to
  `classify`; they now also carry the ticket (checked to belong to the sending tab).

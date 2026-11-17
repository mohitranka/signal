# Implementation plan: S7 (a tab's "cancel all" cancels only that tab's work)

Status: **implemented**.
Design: `docs/design-security-s7.md` (approved; step 3 skipped: no UI change).

Working agreement as before: tests first, confirmed failing for the intended reason; smallest change; full suite (also
with `SIGNAL_TEST_SLOW_HASH`), typecheck and build; one commit; report.

## Change (one task)

`src/background/classifyService.ts`:
- `private waiterGens = new Map<string, number>()`. A request records a **ticket** `{ gen, waiter, wgen }`
  synchronously on entry (the global generation from finding A, plus its tab's generation).
- `cancelWaiter(waiter)`:
  - bump that tab's generation;
  - end that tab's waits for similar requests;
  - release that tab's interest in every queued or running request (the same counting as per-post `cancel`: a request is
    dropped or aborted only when no tab waits for it any more).
- Staleness checks, where finding A put them:

| Where | Global generation moved | Only this tab's generation moved |
|---|---|---|
| before enqueueing | refuse | refuse |
| before handing out a copy / registering a wait | refuse | refuse |
| when the queued task **starts** | refuse | **run**: the task may be shared with another tab that still waits; the queue already aborts it when nobody waits |
| after the model answers | refuse, store nothing (finding A) | **store** the result (made under current settings, useful to others), but return `aborted` to this tab |

- `cancelAll()` (global) also clears the per-tab generations: everything is stale anyway.

`src/background/handlers.ts`: `cancelAll` from a content script → `service.cancelWaiter(<sender's waiter id>)`; from an
extension page → `service.cancelAll()`. (The popup does not send it today; the global paths are `clearCache` and
model changes.)

## Tests first: `tests/cancel-per-tab.test.ts` (new)

Two tabs are two waiter ids (`tab-A`, `tab-B`), and every cancel goes through the real handler. Waits use conditions
and gated storage, not timing.

| # | Case | Expected before fix |
|---|---|---|
| 1 | **Reproduction:** tab B's request is in flight; tab A leaves (content `cancelAll`) → B gets its result; B's fetch is not aborted | fails |
| 2 | Tab A's own in-flight request (A is its only waiter) → `aborted`, and its fetch is aborted | passes (guard) |
| 3 | **Shared request** (A and B wait for the same post): A leaves → B gets the result from the one model call; A gets `aborted` | fails |
| 4 | **Queued, not started** (concurrency 1): A's queued request is dropped and never fetched; B's queued request still runs | fails (B's dropped too) |
| 5 | **In preparation** (gated cache read): A's request is refused and never fetched; B's proceeds | fails (B's refused too) |
| 6 | **Shared queued task started by A's ticket:** A queued it first, B attached; A leaves before it starts → it still runs for B | fails |
| 7 | A's **wait for a similar request** is ended (`aborted`); the request it waited on (B's) completes for B | fails (B's aborted too) |
| 8 | **Global cancels stay global:** Clear cache and a model change still abort both tabs' work | passes (guard) |
| 9 | Tab A's **new** requests after it left work normally | passes (guard) |
| 10 | A content script cannot name another tab: extra fields in the message (`{ type: 'cancelAll', waiter: 'tab-B' }`) are ignored; only the sender's own tab is cancelled | fails (everything is cancelled) |

Updated (as the design says): the four content-`cancelAll` calls in `tests/cancel-generation.test.ts` are sent from the
requesting tab (`'tab-1'`). Their assertions are unchanged.

## Done when

All pass; full suite green (also slow-hash); typecheck and build clean. The step-8 reproduction (tab A leaves, tab B
waits), re-run, gives tab B its result. Security review updated.

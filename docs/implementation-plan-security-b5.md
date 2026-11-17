# Implementation plan: security B5 (a failed request must not crash the bridge)

Status: **implemented**.
Design: `docs/design-security-b5.md` (approved). Mockups: `docs/mockups/security-b5/` (approved, with the log label
"not prepared (code)").

## Changes (one task, one commit)

### `bridge/runner.ts`
- `CliRunner.runIn`: creating the temporary folder and the `prepare` hook move inside the `try`. If either fails, it
  **returns** `{ ok: false, cause: 'unprepared', detail: <error code> }` (e.g. `ENOSPC`; anything that is not a plain
  code becomes `error`), never throws. The clean-up (`finally`) runs only for a folder that exists.

### `bridge/server.ts`
- New run cause `unprepared` → `502`, message "The CLI failed (could not prepare the CLI call (`<code>`))."; log label
  "not prepared (`<code>`)". The code is checked again (`/^[A-Z0-9_]{1,20}$/`, else `error`) before it is logged.

### `bridge/selftest.ts`
- A probe or call that cannot be prepared ends the self-test with `{ ok: false, unprepared: <code> }`, printing
  nothing itself (the caller's words differ at start and while running). Probe folder errors are caught the same way.

### `bridge/main.ts`
- Running calls tracked with `p.then(done, done)` (no promise left to reject unhandled).
- Start: `unprepared` → "Not starting. Could not prepare a temporary folder (`<code>`)." (mockup 3); any other
  exception from the start-up check → "Not starting. The start-up check failed unexpectedly (`<code>`)."; both exit 1.
- Re-check (B2): `unprepared`, or an exception → `stopped`, with "re-check failed · not serving any more" and the
  reason line ("could not prepare a temporary folder (`<code>`)" or "the check failed unexpectedly (`<code>`)"), then the
  existing "Stopped serving" lines (mockup 2).
- A test hook, `BridgeIO.selfTest` (defaults to the real one), so a test can make the check throw.

## Tests first (red before the change)

| # | File | Case |
|---|---|---|
| 1 | `bridge-runner.test.ts` | `run` with no usable temporary folder (`TMPDIR` pointing nowhere) **returns** `{ ok: false, cause: 'unprepared', detail: 'ENOENT' }` (today: throws) |
| 2 | `bridge-server.test.ts` | cause `unprepared` → `502` with the message; the log line says `not prepared (ENOENT)`; a detail that is not a plain code is logged as `error` |
| 3 | `bridge-main.test.ts` | **The step-8 reproduction:** after start, the temporary folder disappears → `502` with the message, **no unhandled rejection** (counted with a process listener during the test), the bridge still answers; folder back → `200` |
| 4 | same | Start with no usable temporary folder → exactly the banner and "Not starting. Could not prepare a temporary folder (ENOENT).", exit 1, no exception (today: throws) |
| 5 | same | Re-check with no usable temporary folder → `503`, and the lines of mockup 2 in that order |
| 6 | same | Re-check that throws (test hook) → `503`, "re-check failed", "the check failed unexpectedly (…)"; start-up check that throws → "Not starting. The start-up check failed unexpectedly (…)", exit 1 |
| 7 | same | Every line of these scenarios ≤ 78 columns |

## Step 5 (tests first): results

7 new tests, **all red**, each for the expected reason: the runner throws `ENOENT` instead of returning a failure (1);
the server answers `500` for the new cause (2); the reproduction gets `500` (today's crash path); the start throws
instead of printing the sentence; the re-check answers `500` instead of `503`; the test hook is not used yet, so the
"throwing check" start succeeds. Type-only additions (cause `unprepared`, `BridgeIO.selfTest`) keep typecheck clean.
Rest of the suite unchanged (725).

## Done when

All red first, then green; full suite (normal and slow), typecheck and build green. By hand: the two recordings behind
`before-after.png` re-run against the changed bridge, matching the mockup.

## Step 6 results

- All 7 new tests green; full suite 732 passed, also with `SIGNAL_TEST_SLOW_HASH=25`; typecheck and build green.
- Mutation checks: `runIn` throwing again → the runner test and the reproduction fail; no `try`/`catch` around the
  start-up check → the "check that throws" test fails. Not covered by a failing test: the change of the in-flight
  bookkeeping from `void p.finally(…)` to `p.then(done, done)` on its own, because after the `runIn` fix no known path
  makes a call reject; it stays as defence in depth.
- A mistake in my own test, fixed: the "check that throws" test started the bridge twice in one home folder and read
  the token from the second start's output, which (correctly) does not print an existing token; it now reads the file.
- By hand, the two recordings behind `docs/mockups/security-b5/before-after.png`, against the changed bridge:
  start without a temporary folder → the banner and "Not starting. Could not prepare a temporary folder (ENOENT).",
  exit 1; temporary folder removed while running → `200`, then `502` "The CLI failed (could not prepare the CLI call
  (ENOENT)).", log `502 … not prepared (ENOENT)`, then `200` once it is back; no stack trace, the process keeps running.

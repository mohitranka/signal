# Design: security B5, one failed request crashes the bridge

Status: **implemented** (design and mockups approved; `docs/implementation-plan-security-b5.md`). From `docs/security-review-bridge.md` (B5, Low; decision: fix).

## Problem

Reproduced in step 8: when a call's temporary folder cannot be created (disk full, `/tmp` cleaned up or not writable),
the first such request ends the bridge process (exit code 1). (Corrected in step 3, from a recording of the real
bridge: that request does get an answer first, `500` "Internal error.", because the server catches the error; the
process then ends, and the next request finds no bridge. The step-8 note said "without any answer".) The cause: `main.ts` tracks running calls
with `void p.finally(...)`; when the call rejects, the promise `finally` returns is rejected too and nobody handles it,
so Node stops the process. Fails closed (nothing leaks), but the bridge is gone, and a CLI that was running is left to
finish on its own.

Looking for the same pattern elsewhere found three more ways an unexpected error ends badly:
1. **A re-check (B2) that throws** (the same temporary-folder error during its probes): the bridge stays "re-checking"
   for ever, so every request gets `429` and Signal keeps retrying, never told why.
2. **The start-up check that throws** (same cause): the bridge exits with a JavaScript stack trace instead of a
   sentence.
3. `CliRunner.runIn` **throws** for a folder it cannot create instead of returning a failure like every other problem.

## Proposed behaviour

1. **A call that cannot be prepared is a failed call, not an exception.** `runIn` returns
   `{ cause: 'failed', detail: 'could not prepare the CLI call (ENOSPC)' }` (the error code only, never a path or
   text). Signal gets `502` "The CLI failed (could not prepare the CLI call (ENOSPC))." and the bridge keeps serving;
   the next request succeeds as soon as the disk has room again.
2. **Running calls are tracked without creating unhandled promises** (`p.then(done, done)`), so no rejection can end
   the process that way.
3. **A re-check that throws stops serving**, like a failed re-check (B2's `503` and its lines), with the reason:
   ```
   12:40:02  claude changed (update?) · pausing, re-checking
   12:40:02  re-check failed · not serving any more
     could not prepare a temporary folder (ENOSPC)
   Stopped serving. The new claude did not pass the checks above.
   Requests get 503. Fix the cause, then restart the bridge (Ctrl-C).
   ```
4. **A start-up check that throws** ends with a sentence and exit code 1, like every other refusal:
   ```
   Not starting. Could not prepare a temporary folder (ENOSPC).
   ```

Not proposed: a process-wide "ignore unhandled errors" handler. It would keep the bridge up after bugs nobody has
understood; the specific paths above are fixed instead, and a test makes every scenario fail if any rejection goes
unhandled (vitest reports those as errors).

## Terminal output

Two small additions (above), in the existing style, each line ≤ 78 columns. Step 3 will render them like the earlier
terminal mockups and run the same browser audit.

## Scope

`bridge/runner.ts` (`runIn`), `bridge/main.ts` (tracking, re-check, start), `bridge/selftest.ts` (probe folder
errors → the start-up sentence). No extension change.

## Tests (outline)

The step-8 reproduction in-process: after start, the temporary folder's parent disappears → the request gets `502`
with the message, no unhandled rejection, and once the folder is back the next request gets `200`. A re-check that
throws → `503` and the lines above; start-up with no usable temporary folder → the sentence and exit code 1;
`runIn` returns the failure (runner level). Output ≤ 78 columns.

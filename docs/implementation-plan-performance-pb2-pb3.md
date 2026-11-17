# Implementation plan: performance PB2 + PB3 (and PB1's documentation)

Status: **implemented**. Design: `docs/design-performance-pb2-pb3.md` (approved).

## Changes (one task, one commit)

- `bridge/adapters.ts`, Codex `cleanup`: a helper `sessionDayFolders(startedAt, endedAt)` → the distinct
  `YYYY/MM/DD` of start and end in local time and in UTC (at most four); only those folders under `<state>/sessions/`
  are listed. The file rule inside is unchanged. The clean-up receives the call's end time (`Date.now()` when it runs).
- `bridge/runner.ts`, `findMarker`: default `maxEntries` 200,000; directories named `node_modules` are neither entered
  nor counted. `MarkerScan` and the other limits unchanged.
- README (bridge section): the pace paragraph and the concurrency advice (PB1); checklist step "time a few posts".

## Tests first (red before the change)

| # | File | Case |
|---|---|---|
| 1 | `bridge-persistence.test.ts` | `sessionDayFolders`: same day → one folder (two when local and UTC dates differ); a call crossing midnight → both days; never more than four |
| 2 | same | The Codex clean-up reads only those folders: with 30 old date folders present, every directory it lists (spied `readdirSync`) is one of the call's day folders; nothing else under `sessions/` is listed |
| 3 | same | A session of this call in today's folder is still removed; a session carrying the call's name in an old date folder is left alone (it cannot belong to this call) |
| 4 | same | The default limits are 200,000 entries, 2,000 changed files, 5 MB (exported as `SCAN_LIMITS`); changed in step 5, see below |
| 5 | same | A `node_modules` folder is skipped: a marker inside it is not reported, and its entries do not count towards the limit (with a small limit, a tree that exceeds it only through `node_modules` is complete) |
| 6 | `bridge-main.test.ts` (README check) | The README states the pace and `--concurrency 2` advice, and the checklist asks to time a few posts |

Existing persistence and scan tests stay as they are (their limits are passed explicitly).

## Step 5 (tests first): results

`tests/bridge-pb2-pb3.test.ts`: 6 tests, **all red** for the expected reasons (no `sessionDayFolders`; the clean-up
removes the stray file in an old date folder, because it walks everything; the limit is 50,000; `node_modules` is
entered and counted; the README lacks the pace paragraph).

One change to the approved plan: test 4 was first written as planned, a tree of 51,000 entries scanned with the default
limits. Creating it took 24 s here and removing it timed out the test's clean-up, too slow for the suite. It now pins the
limits (`SCAN_LIMITS`, exported for this) and the 60,100-entry behaviour is measured outside the suite, in the results.

## Done when

All red first, then green; full suite, typecheck and build green. Micro-benchmark (reported, not in the suite): Codex
clean-up with 20,000 old session files, before (68 ms) and after; the 60,100-entry scan, before (refused) and after.

## Step 6 results

- The 6 tests green; full suite 761 passed, also with `SIGNAL_TEST_SLOW_HASH=25`; typecheck and build green; the
  B3 persistence tests unchanged and green (the fakes file Codex sessions under the local date).
- Mutation: `node_modules` entered and counted again → the PB3 test fails.
- Micro-benchmarks (same scripts as the review):

  | | before | after |
  |---|---|---|
  | Codex clean-up per call, 1,000 / 5,000 / 20,000 old session files (in other days' folders) | 6.6 / 19.7 / 68 ms | 0.0 / 0.0 / 0.1 ms |
  | Start-up scan of a `~/.claude` with 60,100 entries | refused ("more than 50000 entries") | scanned, 233 ms |

  After the change the clean-up's cost depends only on the sessions in the call's own day folders (today's), not on
  how long Codex has been used.
- README: the pace paragraph (PB1) sits before the accepted limits; the checklist gains step 7 (its first insertion
  landed before step 6 and was moved).

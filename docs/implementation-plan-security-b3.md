# Implementation plan: security B3 (post text kept by the CLIs)

Status: **implemented**.
Design: `docs/design-security-b3.md` (approved). Mockups: `docs/mockups/security-b3/` (approved, audited).

## Changes (one task, one commit)

### `bridge/adapters.ts` (layers 1 and 2; all CLI-specific knowledge stays here)
- Claude: `--no-session-persistence` joins `requiredFlags` and is always passed (no longer only "if `--help` lists it").
- Codex: `-c history.persistence="none"` when `--help` lists `-c`/`--config`.
- New per adapter:
  - `stateRoots(env, home)`: where the CLI keeps things, for the marker scan. Claude: `$CLAUDE_CONFIG_DIR` or
    `~/.claude`, and `~/.claude.json`. Codex: `$CODEX_HOME` or `~/.codex`.
  - `cleanup({ cwd, startedAt, env, home })`: removes only what carries the call's unique folder name (`signal-bridge-`
    + 6 random characters). Claude: folders directly under `<state>/projects/` whose name contains it. Codex: `.jsonl`
    files under `<state>/sessions/` (at most 4 levels: year/month/day/file) changed since the call started whose
    first 64 KB contain it. Never follows symlinks; never touches anything else.

### `bridge/runner.ts`
- `CliRunner.runIn`: after every call (success, failure, timeout, cancel), in the same `finally` that removes the
  temporary folder, runs the adapter's `cleanup`; errors there are swallowed (never break a call, never log text).
- `findMarker(roots, marker, since, limits)`: walks the roots without following symlinks; reads only regular files
  changed since `since` (minus 2 s for clock granularity), at most 5 MB each and 2,000 of them; stops after 50,000
  directory entries. Returns `{ found: path } | { found: null } | { incomplete: reason }`.

### `bridge/selftest.ts` (layer 3)
- The test classification's post gets a random marker (`Reference <32 hex>.`), so its text is unique.
- After that call (its clean-up has already run), `findMarker` over the adapter's `stateRoots`:
  - not found → `post text not kept on disk ......... ok`;
  - found → `FAILED`, `    found in <file>`, the three "Not starting." lines, refuse (unless the flag below);
  - incomplete → `FAILED`, `    could not check (<reason>)`, refuse the same way (fail closed);
  - with `--keep-session-files` and found/incomplete → `kept (--keep-session-files)` and
    `    each post stays in <file> (only you can read it)`; the start continues.
- The line sits between "logged in" and "tools off", as in the mockup; it runs again with every B2 re-check.
- The missing-flag message becomes "This <cli> version lacks a flag the bridge needs / (to switch off its tools or
  its session files)." (mockup 4).

### `bridge/config.ts`, `bridge/main.ts`
`--keep-session-files` (boolean, like `--new-token`), passed to the self-test (also on re-checks). Usage text updated.

### README
Privacy section: through the bridge the CLI receives every post; what the bridge does about what it keeps (the three
layers); `--keep-session-files`. Limits: only the CLI's own folders are scanned; a session file exists for a moment
between a call and its clean-up; with the flag, files stay until you delete them. Manual checklist: after a few posts,
look in `~/.claude/projects` / `~/.codex/sessions` for `signal-bridge-` entries (there should be none).

## Test fakes

`tests/fixtures/fake-cli.cjs` learns to keep files the way each CLI is described to (behaviour `persist`, written
before the mode's own behaviour, so failing and timing-out calls keep files too):
`claude-project` (`<state>/projects/<cwd with every non-alphanumeric character as "-">/<id>.jsonl` holding stdin),
`claude-elsewhere` (`<state>/debug/latest.log` holding stdin: a place the clean-up does not cover),
`codex-session` (`<state>/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`: a `session_meta` line with `cwd`, then
stdin), `codex-history` (a line with stdin appended to `<state>/history.jsonl`). The fake Codex `--help` gains
`-c, --config` (removable with `helpMissing`).

## Tests first (red before the change)

| # | File | Case |
|---|---|---|
| 1 | `bridge-runner.test.ts` | Claude argv always ends with `--no-session-persistence`; Codex argv has `-c history.persistence="none"` only when `--help` lists `-c`/`--config` |
| 2 | `bridge-persistence.test.ts` (new) | Claude clean-up: the call's project folder is gone after success, after a failure and after a timeout; other project folders (one with a similar name, one written at the same moment by another "session") are untouched |
| 3 | same | Codex clean-up: the call's session file is gone; a session file of another folder written at the same moment, and an older one, are untouched; `history.jsonl` is never modified by the bridge |
| 4 | same | `findMarker`: finds it in a file and in the single-file root (`~/.claude.json`); ignores files older than `since`; skips files over 5 MB; does not follow symlinks (a link to a file with the marker outside the roots); stops at the limits with `incomplete` |
| 5 | `bridge-selftest.test.ts` | Nothing kept → `ok`; `claude-project` (cleaned) → `ok`; `codex-session` (cleaned) → `ok`; `codex-history` → `FAILED`, `found in ~/.codex/history.jsonl`, the three lines, refused, no canary call; `claude-elsewhere` → `FAILED` naming the debug log |
| 6 | same | With `keepSessionFiles`: `codex-history` → `kept (--keep-session-files)` + `each post stays in …`, the start continues (canary runs) |
| 7 | same | A Claude version without `--no-session-persistence` → `missing --no-session-persistence`, the new two-line message, no CLI call |
| 8 | same | Every line of every scenario ≤ 78 columns; the new line's value column aligned (39) |
| 9 | `bridge-main.test.ts` | `--keep-session-files` parsed (and `--keep-session-files=x` rejected); with the flag the "kept" line appears on every start; a B2 re-check prints the new line again |

## Step 5 (tests first): results

23 new tests: **21 red**, 2 green by design (guards: "the bridge never modifies `history.jsonl`" and "every line fits 78
columns", which hold today only because nothing new is printed or removed yet). 9 existing assertions changed on
purpose and are red until the change: the self-test's line order (the new line sits before the canary: 2 passing-start
tests, 4 canary tests), the parsed arguments (2, `keepSessionFiles`), and the Claude argv (1, the flag is always
passed).

| File | New (red) | Changed existing (red) |
|---|---|---|
| `bridge-persistence.test.ts` (new) | 12 (11) | – |
| `bridge-selftest.test.ts` | 7 (6) | 6 |
| `bridge-main.test.ts` | 3 (3) | 2 |
| `bridge-runner.test.ts` | 1 (1) | 1 |

The fakes keep files only when asked (`persist`), so nothing else changes. Typed stubs: `findMarker`,
`keepSessionFiles`; typecheck clean.

## Done when

All of the above red first, then green; full suite, typecheck and build green; the existing bridge tests unchanged in
intent (the fakes keep nothing unless asked). By hand: `npm run bridge` with fakes that keep files, compared with the
approved mockup.

## Step 6 results

- All new tests green, the 9 changed assertions green; full suite 722 passed, typecheck and build green.
- Mutation checks: no clean-up after calls → 8 tests fail; the start-up scan never finding anything → 5 fail; the
  Codex clean-up deleting every recent session file (ignoring the call's name) → the "other sessions untouched" test
  fails.
- A mistake in my own test, fixed: the scan-limits test left the marker file in place while testing the file and entry
  limits, so the scan found the marker before reaching a limit. The marker file is now removed first.
- By hand (`npm run bridge` with fakes): Codex keeping `history.jsonl` → refused exactly as in mockup 2; with
  `--keep-session-files` → mockup 3; Claude keeping a project folder → "ok", and `~/.claude/projects` empty afterwards.

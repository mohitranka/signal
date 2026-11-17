# Implementation plan: security B1 + B2 (which CLI binary the bridge runs)

Status: **implemented**.
Design: `docs/design-security-b1-b2.md` (approved). Mockups: `docs/mockups/security-b1-b2/` (approved, with `429`
while re-checking).

## Changes (one task, one commit)

### `bridge/runner.ts`
- `searchDirs(path, platform)`: the `PATH` entries the bridge may use: absolute, not a `node_modules/.bin` folder
  (compared segment by segment; case-insensitive on Windows), no duplicates.
- `resolveCommand(name, path, platform)`: same signature as today, searches only `searchDirs`.
- `ignoredMatches(name, path, platform)`: the matches it skipped in npm folders (for the "note: ignored …" lines).
- `scrubEnv`: the `PATH` it passes on is rebuilt from `searchDirs` too (so `#!/usr/bin/env node` cannot find a `node`
  in an npm folder).
- `checkLocation(command, ctx)` (POSIX; Windows returns "not checked"): the rules of design §2, through an injectable
  file-system view (`lstat`, `stat`, `realpath`, first bytes of the file, own uid and gid), so tests can model files
  owned by someone else, which a test cannot create for real.
  - Checked: the link's folder chain, the real file, the real file's folder chain; for a script (`#!`), its
    interpreter the same way (`#!/usr/bin/env [-S] node …` → `node` found via `searchDirs`; an absolute path as is; one
    level only).
  - Owner must be the user or root. Others-writable: never for a file; for a folder only with the sticky bit and only
    as a parent (not the folder holding the file or the link). Group-writable: only when the group is the user's
    primary group.
  - Result: `{ ok: true, real, interpreter?, identity }` or `{ ok: false, path, reason }` (reason worded as in the
    mockup: "… is writable by other users", "… is owned by another user", "… is writable by its group").
- `identityOf(files)`: real path, device, inode, size and modification time of the CLI file and its interpreter.

### `bridge/selftest.ts`
- First step: `checkLocation`. Unsafe → "unsafe location" lines and stop (mockup 5).
- After "found": the path line(s) (mockup 1 and 2): `~` for the home folder; link and real file on one line if it fits
  in 78 columns, else two; a path still too long is shortened from the left with `…`; "runs with …" for scripts.
- On success returns the identity as well.

### `bridge/server.ts`
- `ServerOptions.state?: () => 'serving' | 'rechecking' | 'stopped'`, asked after the request is validated:
  `rechecking` → `429`, `Retry-After: 15`, "The CLI changed; the bridge is re-checking it. Signal retries
  automatically."; `stopped` → `503`, "The CLI changed and failed the bridge's checks; see the bridge's terminal."
- A new run cause `stopped` (a queued call that reaches the CLI after a failed re-check) → `503`, same message.

### `bridge/main.ts`
- Not-found output with the "note: ignored …" lines and the npm-folder hint (mockup 3, 4); a Windows note that the
  location is not checked.
- Before each CLI call: compare `identityOf` with the recorded one (one `realpath` + `stat` per file). Changed →
  one re-check at a time (concurrent calls wait for it): log "claude changed (update?) · pausing, re-checking", re-run
  `selfTest` (its lines printed as at start), then "re-check passed · serving with claude <version>" (new runner,
  help text and identity) or "re-check failed · not serving any more" + the two "Stopped serving." lines (mockup 6, 7).
  Calls already running finish.

### README
Bridge section: where the CLI may come from, the location check, re-check on change, what is not covered (the
microseconds between check and start; what the CLI loads from elsewhere), and the Intel-Homebrew note below.

## Known consequence, to confirm

Group-writable folders fail unless the group is the user's primary group. **Intel-Mac Homebrew** sets `/usr/local/bin`
to owner *you*, group `admin`, mode `775`, so a CLI installed there is refused (the message names the folder; the fix is
`chmod g-w /usr/local/bin` or the CLI's own installer). Apple-silicon Homebrew (`/opt/homebrew`, `755`) and the native
installers pass. On macOS every user's primary group is `staff`, so a `staff`-writable folder passes although other
users are in `staff`; that is weaker than on Linux, and stated in the README.

## Tests first (red before the change)

| # | File | Case |
|---|---|---|
| 1 | `bridge-location.test.ts` (new) | `searchDirs`: relative entries (`.`, `bin`, empty) and every `node_modules/.bin` (project, parent, `/`, Windows case) skipped; order kept; duplicates dropped |
| 2 | same | **The B1 reproduction:** a fake `claude` in `<tmp>/parent/node_modules/.bin` ahead of the real fakes on `PATH` → the real one is used and the npm one is reported by `ignoredMatches`; with only the npm one → `null` |
| 3 | same | The CLI's environment: `PATH` without npm folders or relative entries (the fake records what it got) |
| 4 | same | `checkLocation` (injected file system): owner another user → refused; file others-writable → refused; folder others-writable without sticky → refused; sticky others-writable **parent** → allowed; sticky others-writable **own folder** → refused; group-writable with own primary group → allowed, other group → refused; root-owned system folders → allowed |
| 5 | same | Symlinks: a safe real file behind a link in an unsafe folder → refused (names the link's folder); a safe link to an unsafe real file → refused |
| 6 | same | Scripts: `#!/usr/bin/env node` → the `node` on the filtered `PATH` is checked (unsafe `node` → refused, "runs with" shows it); `#!/usr/bin/env -S node --x`; an absolute interpreter; a binary (no `#!`) → no interpreter |
| 7 | same | Real file system: the test fakes (in a `0700` temp folder under sticky `/tmp`) pass; the same folder made `0777` → refused |
| 8 | `bridge-selftest.test.ts` | Output: "unsafe location" + path + reason + the two "Not starting." lines; path line(s) after "found"; long paths on two lines, shortened from the left; every line ≤ 78 columns |
| 9 | `bridge-main.test.ts` | "note: ignored …" before "found"; only an npm-folder CLI → note, "not found", hint, exit 1 |
| 10 | `bridge-main.test.ts` | **B2:** after the fake CLI file changes: the next request triggers exactly one re-check (2 CLI calls), new requests during it get `429` with `Retry-After: 15`, and classification resumes with the log lines of mockup 6 |
| 11 | same | A change that fails the re-check (the new "version" lacks `--tools`): "re-check failed" lines; later requests `503` with the message; nothing more reaches the CLI |
| 12 | same | No change → no re-check, however many requests (CLI calls = requests + the 2 at start) |
| 13 | `bridge-server.test.ts` | `state()` → `429`/`Retry-After: 15` while re-checking, `503` when stopped, checked only after the token and the request are valid (a wrong token still gets `401`) |

Tests 1–7 and 8–13 are red before the change (missing functions or old behaviour). The existing bridge tests must stay
green (the fakes live in a safe temp folder, so the new check passes them).

## Step 5 (tests first): results

30 new tests, **29 red**, 1 green by design (#12, "no change → no re-check": today there is no re-check at all; it
guards the implementation). One existing assertion changed on purpose and is now red: the runner's environment test
expected the CLI's `PATH` unchanged; it now expects npm folders and relative entries removed (#3).

| File | New | Red |
|---|---|---|
| `bridge-location.test.ts` (new) | 20 | 20 |
| `bridge-selftest.test.ts` | 3 | 3 |
| `bridge-main.test.ts` | 5 | 4 |
| `bridge-server.test.ts` | 2 | 2 |
| `bridge-runner.test.ts` | (1 changed) | 1 |

Typed stubs (throwing "not implemented") for `searchDirs`, `ignoredMatches`, `checkLocation`, `pathLines`, and
type-only additions (`state`, cause `stopped`, self-test `path`/`home`/`identity`), so typecheck stays clean. Rest of
the suite unchanged (668).

## Done when

All of the above red first, then green; full suite, typecheck and build green. By hand: `npm run bridge` with a fake
`claude` in the repo's parent `node_modules/.bin` (the step-8 reproduction) → ignored, with the note; the terminal
output compared with the approved mockup.

## Step 6 results

- All 30 new tests green, plus the changed runner assertion; full suite 698 passed, typecheck and build green.
- Mutation checks: searching npm folders again → 8 tests fail (the reproduction among them); no identity check before
  calls → both B2 change tests fail; allowing a sticky others-writable folder as the CLI's own folder → the permission
  test fails.
- By hand (the step-8 reproduction): a fake `claude` in the repo's parent `node_modules/.bin` → "note: ignored …",
  "not found", the npm hint; with a `claude` of yours on `PATH` as well (even last) → yours is used, shown with its
  path and "runs with /usr/bin/node". Output matches the approved mockup.
- One test of mine was too strict and was corrected: it expected the re-check's "found" line right after "claude
  changed", but a request log line (the `429` it provokes) can legitimately come in between.

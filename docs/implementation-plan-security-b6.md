# Implementation plan: security B6 (token folder and file ownership)

Status: **implemented**.
Design: `docs/design-security-b6.md` (approved). Mockups: `docs/mockups/security-b6/` (approved).

## Changes (one task, one commit)

### `bridge/runner.ts`
The B1 rule for one file or folder (owner you or root; not writable by others except a sticky parent; group-writable
only for your primary group) is exported as `pathProblem(path, stat, { own }, me)` → `null` or `'owned' | 'others' |
'group'`. `checkLocation` uses it unchanged (its messages and tests stay as they are).

### `bridge/token.ts`
- `loadOrCreateToken(path, { rotate?, home?, view? })`: `home` only for showing paths as `~`; `view` (tests only) supplies
  `uid`, `gid`, `stat` and `fstat`, as B1's `FsView` does, so a file owned by someone else can be modelled.
- Order: create the folder if missing (`0700`, as today), then check the folder and every folder above it with
  `pathProblem`, then open the file and check on the open file (`fstat`): owner is you, no group or other bits, then
  the content.
- Problems are thrown as a `TokenProblem` carrying **lines**, exactly as in the mockups:
  - token folder writable by others / by its group → "The bridge token folder is writable by other users:" (or "by its
    group:"), the folder, "Fix it with:", `chmod 700 <folder>`;
  - token folder owned by another user (not in the mockups; same layout) → "The bridge token folder is owned by another
    user:", the folder, "Move it away, then start again:", `mv <folder> <folder>.old`;
  - a folder above, writable by others / by its group → "A folder above the bridge token is writable by other users:"
    (or "by its group:"), the folder, "Fix it with:", `chmod go-w <folder>` (or `chmod g-w`);
  - a folder above owned by another user (not root) → "A folder above the bridge token belongs to another user:", the
    folder, "Set XDG_CONFIG_HOME to a folder of your own.";
  - file owned by another user → mockup 3; readable by others → mockup 4 (written "can be changed by other users" when
    only write bits are set); not a valid token → mockup 5; folder cannot be created → mockup 6 (with the error code).
- Paths and commands are never shortened. Windows: no owner or folder checks (ACLs), as before for the file's bits.

### `bridge/main.ts`
Prints a `TokenProblem` as "Not starting. " + its first line, then the other lines.

### README
Bridge section: the token folder and the folders above it must be yours and not writable by others, as for the CLI.

## Tests first (red before the change)

| # | File | Case |
|---|---|---|
| 1 | `bridge-token.test.ts` | Token folder `0777` → refused; the lines of mockup 1 (with `~`) |
| 2 | same | A folder above it writable by others (non-sticky) → the lines of mockup 2, naming that folder; `chmod go-w` |
| 3 | same | Group-writable token folder with your own primary group → accepted; a sticky parent (`/tmp`) → accepted |
| 4 | same | Token file owned by another user (modelled `fstat`) → the lines of mockup 3 |
| 5 | same | Readable by others → mockup 4; only writable by others (`0620`) → "can be changed by other users"; not a valid token → mockup 5; folder cannot be created → mockup 6 with `EEXIST` |
| 6 | same | Today's behaviour kept: create (`0700`/`0600`), reuse, rotate, random tokens, `checkToken` (existing tests, unchanged) |
| 7 | `bridge-main.test.ts` | The bridge prints a token problem as "Not starting. …" followed by the lines; exit 1; every line ≤ 78 columns |

## Step 5 (tests first): results

6 new tests: **5 red** (today the `0777` folder and the `0777` parent are accepted, the modelled foreign file is
accepted, the existing problems are single lines not `TokenProblem` lines, and the bridge prints one long line), 1
green by design (#3, the accepted cases: they must stay accepted). Existing token tests unchanged and green. Type-only
stubs: `TokenProblem`, `TokenView`, the new options. Rest of the suite unchanged.

## Done when

All red first, then green; full suite (normal and slow), typecheck and build green. By hand: the four recordings
behind `before-after.png` re-run against the changed bridge, matching the mockup.

## Step 6 results

- The 5 red tests green, the guard green; full suite 738 passed, also with `SIGNAL_TEST_SLOW_HASH=25`; typecheck and
  build green. B1's location tests unchanged and green (the rule is now shared, `pathProblem`).
- Mutation checks: without the folder check → 3 tests fail (folder, folder above, the bridge's output); without the
  file-owner check → the "owned by another user" test fails.
- By hand, the recordings behind `docs/mockups/security-b6/before-after.png` (plus the folder-above case) against the
  changed bridge: each prints exactly the mockup's lines and exits with code 1; the `0777` folder is no longer accepted.

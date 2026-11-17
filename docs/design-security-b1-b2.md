# Design: security B1 + B2, which CLI binary the bridge runs

Status: **implemented** (design and mockups approved; `docs/implementation-plan-security-b1-b2.md`). From `docs/security-review-bridge.md` (B1 Medium, B2 Low;
decision: fix together, first).

## Problem

- **B1.** The bridge finds `claude`/`codex` by name on `PATH`. Under `npm run`, `PATH` starts with `node_modules/.bin`
  of the project **and of every parent folder up to `/`**. A `claude` placed there (by another local user under a
  shared folder such as `/tmp`, or by a dependency) is run instead of yours; demonstrated. Nothing in the output says
  which file runs.
- **B2.** The self-test (version, flags, login, canary) runs once. If the file changes afterwards (Claude Code updates
  itself; a package update; an attacker), later calls run an unchecked binary.

## Proposed behaviour

### 1. Where the CLI may come from (B1)

`resolveCommand` considers, in `PATH` order, only entries that are:
- **absolute** (a relative entry such as `.` depends on the folder you start from), and
- **not a `node_modules/.bin` folder** (those are npm's, not yours; `npm run` adds them for the project and every
  parent folder).

If a skipped `node_modules/.bin` held a match, the output says so (so a missing CLI is explained, and a shadowing
attempt is visible).

The **`PATH` given to the CLI** is filtered the same way. Otherwise the same problem returns one step later: an
npm-installed `claude` starts with `#!/usr/bin/env node`, so `node` is looked up on that `PATH`, and a `node` in a
parent folder's `node_modules/.bin` would run instead (reasoning; follows from the shebang).

### 2. Who can change it (B1)

On Linux and macOS, the first match is then checked the way OpenSSH checks its own files ("StrictModes"):
- the file **after following symlinks**, and the **symlink** itself if there is one;
- every folder from each of their folders **up to `/`**.

Each must be **owned by you or by root**, and **not writable by others**. Two allowances, so ordinary installs pass:
- a folder writable by everyone **with the sticky bit** (like `/tmp`) passes *as a parent* (others cannot rename or
  replace what you own in it), but never as the folder the CLI file or its symlink sits in;
- a folder writable by its **group** passes only if that group is your own primary group (Ubuntu and Debian give
  every user a private group and often create `0775` folders). Any other group-writable folder fails.

If the CLI file is a **script** (starts with `#!`), its interpreter is checked the same way: the path after `#!`,
or, for `#!/usr/bin/env node`, the `node` found on the filtered `PATH`.

Typical installs pass: `~/.local/bin` → `~/.local/share/claude/versions/…` (the native installer), `~/.npm-global/…`,
`/usr/local/bin`, Homebrew. If the check fails, the bridge refuses to start and names the file or folder and why.
No override flag: the fix is to install the CLI somewhere only you or root can change.

On **Windows** the check is skipped (permissions are ACLs; not modelled). Said at start, as today's Windows notes.

### 3. Show the path (B1)

The start-up output prints where the CLI is, on the line after "found" (shortened with `~` and, if still longer than
the line, from the left with `…`):

```
  claude 2.1.4 ....................... found
    ~/.local/bin/claude → ~/.local/share/claude/versions/2.1.4
```

### 4. Changes while running (B2)

At the self-test the bridge records the CLI's **identity**: the real path (after symlinks), device and inode, size and
modification time, and the same for its interpreter if it is a script. **Before each call** it reads them again (one `realpath` + one `stat`, well under a millisecond).
If anything differs:
1. the bridge **pauses**: new requests get `429` with `Retry-After: 15` and "The CLI changed; the bridge is
   re-checking it. Signal retries automatically."; queued ones wait; running calls finish. (Step 3 correction: the
   first draft said `503`. Signal's client retries a `5xx` only twice, after about 1 and 2 seconds, which is shorter
   than a re-check (two CLI calls), so posts would have failed. It honours `Retry-After` on a `429`, up to 30 s.)
2. it **re-runs the whole start-up check** (B1 location check, version, flags, login, canary: about 2 subscription
   calls) against the new file;
3. passed → serving resumes with the new version (one log line says so); failed → the bridge **stops serving**
   (`503`, "The CLI changed and failed the bridge's checks; see the bridge's terminal") and prints why, as at start.

Why re-check instead of stopping: Claude Code updates itself, often daily; stopping each time would break Signal
until you notice. Why not trust the update: the point of B2 is that nothing unchecked runs. Only a change of the file
triggers a re-check (never a request), so a token holder cannot make the bridge spend calls on self-tests.

Not covered (stated in the README): a change in the instant between the check and the start of a call (a race of
microseconds), and what the CLI loads from elsewhere (its own packages and settings).

## Terminal output (step 3 will render these, like the approved terminal mockup, ≤ 78 columns)

Refused location:
```
  claude ............................ unsafe location
    /tmp/node_modules/.bin/claude
    /tmp/node_modules/.bin is writable by other users
Not starting. Others could replace this claude. Install it where only
you or root can change it (for example with its own installer).
```
Skipped `node_modules/.bin`:
```
  note: ignored /workspace/node_modules/.bin/claude (npm folder)
  claude ............................ not found
```
Change while running:
```
12:40:02  claude changed (update?) · pausing, re-checking
  claude 2.1.5 ....................... found
  ...
12:40:10  re-check passed · serving with claude 2.1.5
```

## Scope

`bridge/runner.ts` (resolution, location check, identity), `bridge/selftest.ts` (records the identity), `bridge/server.ts`
(a `paused`/`stopped` state with `503`), `bridge/main.ts` (re-check flow, output), README (limits). No extension or
popup change.

## Tests (outline; step 4 details them)

Relative and `node_modules/.bin` entries skipped (and reported); others-writable file, folder or symlink folder
refused; sticky `/tmp`-style parent allowed but not as the CLI's own folder; group-writable allowed only for your own
primary group; owner other than you or root refused (simulated through an injectable `stat`, since tests cannot create
files owned by another user); path printed; identity change → `503` + re-check → resume, or → stop; no re-check without
a change; every output line ≤ 78 columns.

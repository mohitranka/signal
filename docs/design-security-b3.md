# Design: security B3, post text kept in the CLIs' session history

Status: **implemented** (design and mockups approved; `docs/implementation-plan-security-b3.md`). From `docs/security-review-bridge.md` (B3, Medium, privacy;
decision: fix). Everything about the CLIs' files is **unverified** here (the CLIs cannot be run in this environment),
so the design does not rely on it: it **measures** at start what the CLI left behind.

## Problem

Signal promises that post text is stored only for posts you mark (feedback). Through the bridge, the CLI receives
every post, and a CLI can keep what it received:
- **Claude Code** saves each session (the whole conversation) under `~/.claude/projects/<folder derived from the
  working folder>/` unless started with `--no-session-persistence`. The bridge adds that flag only when `--help` lists
  it, and otherwise continues silently. Each call runs in a new temporary folder, so each post would get its own
  project folder.
- **Codex** `exec` writes a session file per run under `~/.codex/sessions/<year>/<month>/<day>/` (no option to turn it
  off is known here), and may add to `~/.codex/history.jsonl` (which `-c history.persistence="none"` turns off, if the
  installed version has `-c`).

The files are in your home folder, readable only by you, but they grow with every post, go into backups, and break
the privacy promise without telling you.

## Proposed behaviour: three layers

### 1. Ask the CLI not to keep anything
- Claude: `--no-session-persistence` becomes a **required** flag (like `--tools`): a version without it is refused
  with "update it".
- Codex: when `--help` lists `-c`/`--config`, pass `-c history.persistence="none"`.

### 2. Remove what it kept anyway, after every call
Each call's temporary folder has a unique random name (`signal-bridge-Ab3xYz`), and the CLIs record the working folder
in their session files. After each call (also after failures and timeouts), the bridge removes **only** files that
carry that exact name:
- Claude: the folder under `$CLAUDE_CONFIG_DIR` or `~/.claude/projects/` whose name contains the unique folder name;
- Codex: session files under `$CODEX_HOME` or `~/.codex/sessions/` changed since the call started whose first 64 KB
  contain the unique folder name.
Nothing else is ever touched: no other project, no other session, no shared file such as `history.jsonl`.

### 3. Prove it at start (fail closed)
The start-up test classification already runs a harmless post. It gets a **random marker** in its text. After that
call and its clean-up, the bridge looks through the CLI's own folders (`~/.claude` and `~/.claude.json`, or
`~/.codex`; only files changed since the call started; at most 2,000 files and 5 MB each) for the marker:
- not found → "post text not kept on disk ... ok";
- found → the bridge **refuses to start**, names the file, and explains. Starting with `--keep-session-files` accepts
  it knowingly (the files stay in the CLI's folder, readable only by you); the start-up output then says so on every
  start, and so does the README.

The check runs again with every B2 re-check (a CLI update may change where it keeps things).

Why refuse by default: the bridge's own log promise ("never post text") and Signal's privacy section would otherwise
be false without you knowing. Why an opt-in at all: for Codex, layer 2 depends on file formats nobody could check
here; if it falls short, you can still choose to use it.

## Terminal output (step 3 will render these; ≤ 78 columns)

```
  logged in (test classification) .... ok  3.9 s · subscription
  post text not kept on disk ......... ok
  tools off (canary: read/list/run) .. passed
```
Refused:
```
  post text not kept on disk ......... FAILED
    found in ~/.codex/history.jsonl
Not starting. codex keeps the text of each post it classifies, and the
bridge cannot remove it safely. To accept that (the files stay in
~/.codex, readable only by you), start with --keep-session-files.
```
Accepted by flag, on every start:
```
  post text not kept on disk ......... kept (--keep-session-files)
```

## Limits (README)

- The scan covers the CLI's own folders, not the whole disk; a CLI that writes post text elsewhere (e.g. a debug log
  in a system folder) is not caught.
- Between a call and its clean-up, the session file exists for a moment (milliseconds to seconds).
- With `--keep-session-files`, the files are kept in full until you delete them.

## Scope

`bridge/adapters.ts` (required flag, `-c`, clean-up and the folders to scan), `bridge/runner.ts` (clean-up after each
call), `bridge/selftest.ts` (marker check, new line), `bridge/config.ts` (`--keep-session-files`), `bridge/main.ts`,
README (privacy section and limits). No extension change.

## Tests (outline)

Fake CLIs that keep session files like each CLI is documented to (Claude: project folder; Codex: dated session file and
a `history.jsonl` line): the clean-up removes exactly the files with the call's unique name and nothing else (other
projects and sessions untouched, including ones changed at the same time); failures and timeouts are cleaned up too;
the start-up check passes when the clean-up works, fails (naming the file) when a fake writes somewhere the clean-up
does not cover, and passes with `--keep-session-files` saying so; a Claude version without `--no-session-persistence`
is refused; `-c history.persistence="none"` only when listed; the scan's limits (files changed since the call, 2,000
files, 5 MB); output ≤ 78 columns.

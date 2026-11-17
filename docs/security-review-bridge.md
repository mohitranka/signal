# Security review: local CLI bridge (SDLC step 8)

Scope: everything the bridge work added: `bridge/` (server, token, request check, runner, adapters, self-test, entry
point), the popup's bridge preset, and the README's claims. Threat actors considered: a web page in the user's browser;
another local user on the same machine; a malicious or compromised npm package; a hostile post (prompt injection); a
leaked token; the CLI itself changing. Each finding is **verified** (reproduced or demonstrated) unless marked as
reasoning only. The real CLIs could not be run here, so their own behaviour is always reasoning.

## Still holds (checked)

- **Web pages cannot use the bridge.** Host check (DNS rebinding), Origin check, `Content-Type: application/json`
  only (rules out every request a page can send without a preflight), no CORS headers ever, and a token a page cannot
  know. `no-cors` fetches cannot set `Authorization`.
- **A leaked token buys only classification.** The request is rebuilt from Signal's own prompt code and compared;
  only a validated classification goes back (mutation-tested in T1 and T3).
- **No shell, no argv leaks.** Only `spawn` is imported; post text goes on stdin; model names are validated and cannot
  start with `-`.
- **Environment.** Allow-list, not block-list; `NODE_OPTIONS` and every `*_API_KEY` are dropped (tested).
- **Bounded.** 64 KB bodies, a queue cap with `429`, 1 MB output cap, timeouts that kill the process group (tested);
  a slow CLI answer (33 s, above the server's 30 s request-receive timeout) still arrives (checked: that timeout covers
  receiving the request only).
- **Logs.** Fixed labels only; post text, CLI output and the Host header never reach the log (tested with a marker,
  also for failing and timing-out calls).
- **Popup.** New text is static HTML or `textContent`; the bridge prefix lookup uses a `Map` (no prototype names).

## Findings

| # | Finding | Severity | Verified | Recommendation |
|---|---|---|---|---|
| B1 | `npm run bridge` can run a **different `claude`/`codex` than the user's**: npm puts `node_modules/.bin` of the project **and every parent folder** first on `PATH`, and the bridge does not show which file it runs | **Medium** | ✅ | Fix |
| B2 | The CLI is checked once at start; if it is **replaced or updated while the bridge runs**, calls go to an unchecked binary | Low | reasoning | Fix with B1 |
| B3 | The CLIs may **store every post's text** in their own session history on disk | **Medium** (privacy) | reasoning | Fix (Claude: require the flag) + notice (Codex) |
| B4 | "Subscription, never API billing" is **not guaranteed** when the CLI itself is logged in with an API key or configured with one | Low–Medium | reasoning | Fix the wording + start-up notice |
| B5 | **A failed request crashes the bridge** when its temp folder cannot be created (e.g. disk full) | Low | ✅ | Fix |
| B6 | Token folder and file **ownership and folder permissions** are not checked | Low | ✅ | Fix |
| B7 | Popup: **"Plan" and "via … subscription"** are shown for any endpoint whose model id starts `claude-code/` or `codex/` | Low | ✅ (code) | Fix |
| B8 | **Another local user** can listen on 127.0.0.1:8791 while the bridge is not running and receive the token and posts | Low | reasoning | Accept + document |
| B9 | Unauthenticated requests are drained for up to 30 s; no connection cap | Info | reasoning | Accept |
| B10 | CLIs started by the bridge survive a `kill -9` of the bridge (own process group) | Info | reasoning | Accept |
| B11 | After a normal exit, the group kill could in theory hit a reused process-group id | Info | reasoning | Accept |
| B12 | The token is printed once; terminal logging would keep it | Info | reasoning | Accept (documented) |

### B1: which binary runs (Medium)

`npm run` prepends `<project>/node_modules/.bin`, then `node_modules/.bin` of **every parent folder up to `/`**
(verified: `/workspace/signal/node_modules/.bin`, `/workspace/node_modules/.bin`, `/node_modules/.bin`). The bridge
resolves `claude` by name on that `PATH`. Demonstrated: with no `claude` on the user's own `PATH`, a fake placed in
`/workspace/node_modules/.bin/claude` (the repo's **parent** folder) was found, passed the self-test, and served. The
start-up output says only "claude 2.1.4 … found", not where.

Who can exploit it:
- **Another local user**, when the repo sits under a folder they can write. Example: a clone in `/tmp/signal` makes
  `/tmp/node_modules/.bin/claude` (world-writable `/tmp`) the bridge's `claude`: code execution as the user.
- **A dependency** (direct or transitive) that ships a `claude` or `codex` bin: it shadows the real CLI, including when
  the real one is on `PATH`.
Relative `PATH` entries (`.`) would also be searched (reasoning).

**Fix:** resolve the CLI only from absolute `PATH` entries that are not `node_modules/.bin`; refuse a binary (after
following symlinks) that is writable by others or sits in a folder writable by others without the sticky bit, or is
owned by someone other than the user or root (as ssh does for its files); print the resolved path at start.

### B2: the CLI changes while the bridge runs (Low, reasoning)

Version, flags and the canary are checked once. Claude Code updates itself in the background; a package update or an
attacker with B1's access can replace the file. Later calls then run an unchecked binary whose flags may mean
something else. **Fix (with B1):** remember the resolved file's identity (real path, size, modification time, inode);
check it before each call (one `stat`); if it changed, stop serving (`503`, "the CLI changed; restart the bridge") so
the self-test runs again on the restart.

### B3: post text in the CLI's session history (Medium, privacy; reasoning)

Signal promises that only feedback you mark stores post text. Through the bridge, the CLI receives every post:
- **Claude Code** saves each session (the full conversation, i.e. the post) under `~/.claude/projects/…` unless
  started with `--no-session-persistence`. The bridge adds that flag **only if `--help` lists it**, and otherwise
  continues silently.
- **Codex** `exec` writes session files under `~/.codex/sessions/` (reasoning; no flag to turn this off is known
  here).
Files are in the user's home and readable only by them, but they grow with every post, end up in backups, and
contradict the privacy section.
**Fix:** Claude: make `--no-session-persistence` a **required** flag (refuse to start without it; the message says to
update). Codex: a start-up notice ("codex keeps session files in ~/.codex/sessions; they will contain post text") and
a README note, until a no-persistence option is confirmed in your manual check.

### B4: "never API billing" overstated (Low–Medium, reasoning)

The bridge removes API-key **environment variables**. But a CLI can be logged in with an API key itself (`codex login`
with an API key stores it in `~/.codex/auth.json`; Claude Code can use an `apiKeyHelper` or `env` entry from user
settings, which `--setting-sources user` loads). Then every post is billed to the API, while the README says "No API
key, no API billing" and the popup says "via … subscription". The same user settings can also define **hooks**, which
would receive the post text.
**Fix:** correct the wording (README, design I2, the popup's "Plan" tooltip and "via … subscription") to "the bridge
never passes an API key; if the CLI itself is set up with one, it bills the API", and print a start-up notice saying
which settings to check. A check of the CLIs' config files is possible but their formats are
unverified, so not proposed now.

### B5: one failed request crashes the bridge (Low)

`main.ts` wraps each run as `void p.finally(...)`; when the run rejects, the derived promise is unhandled and Node
exits. Reproduced: with the temp folder's parent missing (`TMPDIR` pointing nowhere, as after a disk-full or a `/tmp`
clean-up), the first request ended the process (`exit code 1`) without any answer. Fails closed (nothing leaks), but
the bridge stops and running CLIs are left to finish on their own (B10).
**Fix:** handle the rejection (`.catch`), answer `502` ("the bridge could not prepare the CLI call"), keep serving;
a test that reproduces it.

### B6: token folder and file ownership (Low)

Demonstrated: a pre-existing `signal-bridge` folder with mode `0777` is accepted, and a token file replaced by someone
who can write that folder (mode `0600`, but their own token) is accepted. Whoever can write the folder can choose the
token and then use the bridge (within I6). Needs a misconfigured folder.
**Fix:** refuse a folder writable by group or others, or not owned by the user; refuse a token file not owned by the
user (POSIX). The message gives the `chmod`/`chown` fix.

### B7: subscription wording for a non-local endpoint (Low)

The popup decides "bridge model" by the model id alone. A model id starting `claude-code/` or `codex/` on any other
endpoint (a typo, a proxy) shows **Plan** instead of a cost estimate and "via … subscription" after Test connection:
misleading about billing. **Fix:** bridge wording only when the model id has a bridge prefix **and** the endpoint is
loopback (`127.0.0.1`, `localhost`).

### B8: port squatting by another local user (Low, reasoning; accept)

When the bridge is not running, any local process can listen on 127.0.0.1:8791. Signal then sends it the token and
post texts. On a single-user machine that process already has the user's rights; on a shared machine it is another
user. Preventing it needs the server to prove its identity before Signal sends anything, i.e. a change to Signal's
client protocol. The same is true of any local endpoint today (Ollama). **Accept and document** ("on a shared
computer, run the bridge only while Signal uses it; rotate the token with `--new-token` if in doubt").

### B9–B12 (Info; accept)

- **B9:** a rejected request's body is read and discarded (so the client sees the answer) for up to 30 s, and
  connections are not capped. Only local processes can connect; they could load the machine in other ways.
- **B10:** the CLI runs in its own process group so the group can be killed; if the bridge itself is killed with
  `SIGKILL`, a running CLI finishes on its own (bounded by the CLI, not by the bridge's timeout).
- **B11:** the extra group kill after a normal exit targets the CLI's process-group id; reuse of that id within
  microseconds is theoretical on Linux and macOS.
- **B12:** the token is printed once so it can be pasted into Signal; if the terminal is logged, rotate it
  (`--new-token`).

## Recommendation summary

Fix **B1 + B2** (one finding: which binary runs), **B3**, **B4** (wording + notice), **B5**, **B6**, **B7**. Accept
and document **B8–B12**. Suggested order by risk: B1+B2 → B3 → B5 → B6 → B4 → B7. Each fix goes through steps 2–6.

## Decisions (aligned)

- **Fix**, each through steps 2–6, in this order: **B1 + B2 → B3 → B5 → B6 → B4 → B7**.
- **Accept and document**: **B8** (README: shared computers, `--new-token`), **B9–B12**.

## Outcome

| # | Result | Commit |
|---|---|---|
| B1 + B2 | Fixed: CLI only from absolute non-npm `PATH` folders (also the CLI's own `PATH`); OpenSSH-style owner/permission check of the CLI, its symlink, its interpreter and their folders; path shown; identity checked before each call, re-check on change (`429` meanwhile), stop on failure (`503`) | `96a613c` |
| B3 | Fixed: Claude's `--no-session-persistence` required; Codex `-c history.persistence="none"`; after each call the CLI's files for that call removed; start-up marker scan of the CLI's folders, refusal unless `--keep-session-files` | `6fc95a6` |
| B5 | Fixed: a call that cannot be prepared is a `502` with the error code (log `not prepared (code)`), never a crash; re-check and start-up errors end in words (`503` / exit 1) | `091ee6b` |
| B6 | Fixed: token folder and folders above checked with B1's rule; token file must be yours (checked on the open file); messages as lines with the fix. Re-examined: a planted file is accepted only through macOS ACLs; deletion/replacement by folder writers was the broader risk | `26dedce` |
| B4 | Fixed: every "subscription / never API billing" claim reworded to what the bridge guarantees (no API key passed); a billing notice per CLI at start; README checklist step to check the CLI's own login | `6c05d87` |
| B7 | Fixed: bridge wording (chip, Plan, Test connection, errors, token label, prices) only for a bridge model id on a local endpoint | `6e0fbcb` |
| B8–B12 | Accepted; documented in the README (bridge section, *Accepted limits*) | `ef3210c` |

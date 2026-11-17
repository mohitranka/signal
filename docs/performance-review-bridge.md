# Performance review: local CLI bridge and the recent popup changes (SDLC step 9)

Scope: everything added since the last performance review: the bridge (`bridge/`), its security fixes B1–B7, and the
popup's bridge preset and session details (J+K). Measured on this machine (Node 22, Linux, tmpfs-backed `/tmp`) with the
fake CLIs; the real CLIs cannot run here, so their own start-up and model time are **not measured** and are marked as
estimates. Scripts: the commands in each row (kept in `/tmp` during the review; the numbers are reproducible with the
test helpers).

## Measured

| What | Measured | Notes |
|---|---|---|
| The bridge's own time per post (HTTP, Signal-request check, identity check, temporary folder, spawn, parse, clean-up) | **0.4 ms** (45.7 ms through the bridge vs 45.3 ms for the fake CLI alone, medians of 15) | the fake CLI's 45 ms is Node starting up; a real CLI adds its own start-up and the model call |
| Request check for the largest post Signal sends (JSON parse + rebuild and compare) | 0.22 ms | |
| Identity check before each call (B2; CLI + interpreter) | 21 µs | |
| Claude clean-up after each call (B3), 500 / 5,000 project folders | 0.4 / 3.3 ms | one directory listing |
| **Codex clean-up after each call (B3)**, 1,000 / 5,000 / 20,000 session files | **6.6 / 19.7 / 68 ms** | walks every date folder and checks every file's time, on every call |
| **Start-up scan (B3)** of `~/.claude`: 5,000 / 20,000 files; 45,000 entries; **60,100 entries** | 19 / 59 / 156 ms; **"could not check: more than 50000 entries"** at 60,100 (275 ms), so the bridge **refuses to start** | with a 200,000-entry limit the same tree passes in 197 ms |

## Findings

| # | Finding | Severity | Recommendation |
|---|---|---|---|
| PB1 | **Throughput.** One CLI process per post, one at a time (the preset's and the bridge's default). Each post costs the CLI's start-up plus the model call: seconds (estimate; not measurable here). A feed scrolled quickly shows posts before their verdicts; in Active mode, collapses land late (the known layout shift) | Medium (UX), **unmeasured** | **Accept for now and document**: the README states the expected pace and how to allow 2 at a time (`--concurrency 2` and Signal's concurrency 2) if the subscription's limits allow; the manual checklist gains "time a few posts". Revisit with real numbers. |
| PB2 | **Codex clean-up walks all its sessions after every call**: 7–68 ms per post with 1k–20k old session files, growing with Codex use | Low | **Fix (small)**: look only in the date folders of the call's start and end (local and UTC dates: at most four folders), since a session is filed under the day it starts; under 1 ms. |
| PB3 | **Start-up scan limit of 50,000 entries refuses to start** for a large `~/.claude` (measured: 60,100 entries → refusal). A long-time Claude Code user can have many thousands of session and to-do files | Medium (availability at start) | **Fix (small)**: raise the entry limit to 200,000 (≈ 0.2 s measured at 60k; under a second expected at 200k) and skip `node_modules` folders (program files, never session data; a local install of the CLI lives under `~/.claude`). The 2,000 changed-files limit stays. |
| PB4 | Request check 0.22 ms, identity check 21 µs, Claude clean-up ≤ 3.3 ms, the bridge's own 0.4 ms per post | Info | Accept |
| PB5 | The self-test costs about two model calls at every start and after every CLI update (B2) | Info | Accept (by design; it is what makes the start safe) |
| PB6 | Popup: the Details list is rebuilt on each stats refresh (five lines) | Info | Accept |

Rejected for PB1: one long-running CLI process for many posts. Posts would share one conversation, so one post could
steer the verdict of the next (prompt injection across posts), and B3's no-session guarantee and per-call clean-up
would no longer hold.

## Recommendation summary

Fix **PB2** and **PB3** (one task each, or together: both in `bridge/adapters.ts` / `bridge/runner.ts`, no UI).
Accept and document **PB1** (README pace + checklist step; decide on concurrency with real numbers). Accept **PB4–PB6**.

## Decisions (aligned)

- **Fix PB2 and PB3** together, through steps 2–6.
- **PB1**: accept and document (README pace and concurrency; checklist step to time posts); decide with real numbers.
- **Accept PB4–PB6.**

## Outcome

| # | Result | Commit |
|---|---|---|
| PB2 | Fixed: Codex clean-up lists only the call's day folders (20,000 old sessions: 68 → 0.1 ms per call) | `bff6b9f` |
| PB3 | Fixed: scan limit 200,000 entries, `node_modules` skipped (60,100 entries: refused → 233 ms) | `bff6b9f` |
| PB1 | Documented: README pace and `--concurrency 2` advice; checklist step 7 (time a few posts) | `bff6b9f` |
| PB4–PB6 | Accepted | |

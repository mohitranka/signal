# Design: performance PB2 + PB3 (and PB1's documentation)

Status: **implemented** (`docs/implementation-plan-performance-pb2-pb3.md`). From `docs/performance-review-bridge.md` (decision: fix PB2 and
PB3 together; document PB1).

## PB2: Codex clean-up looks everywhere, after every call

Today the clean-up after each Codex call walks every folder under `~/.codex/sessions/` and checks every file's time:
7, 20 and 68 ms per post with 1,000, 5,000 and 20,000 old session files, growing as Codex is used.

**Proposed:** look only in the date folders a session of this call can be in: the dates of the call's start and end,
each in local time and in UTC (Codex's choice of time zone is unverified), so at most four folders
(`sessions/YYYY/MM/DD`). Inside them, the rule is unchanged: `.jsonl` files changed since the call started whose first
64 KB contain the call's unique folder name.

If Codex files sessions differently from what the adapter assumes, the clean-up misses them, exactly as it would
today, and the start-up scan (layer 3) still finds the kept text and refuses to start. The safety net is unchanged.

## PB3: the start-up scan gives up at 50,000 entries, and the bridge then refuses to start

Measured: a `~/.claude` with 60,100 entries makes the scan stop ("could not check"), so the bridge refuses to start
unless `--keep-session-files` is given. A long-time Claude Code user can have many thousands of session and to-do
files, and a local install of the CLI keeps its program files under `~/.claude` too.

**Proposed:**
- the entry limit goes from 50,000 to **200,000** (measured: 60,100 entries in 0.2 s; 200,000 is expected well under a
  second, once per start);
- folders named **`node_modules`** are skipped (program files; never session data);
- the other limits stay: only files changed since the test call, at most 2,000 of them, 5 MB each.

## PB1 (documentation only)

README, bridge section: each post starts the CLI once (its start-up plus the model call: usually a few seconds), one
at a time by default, so posts scrolled past quickly show before their verdict; to allow two at a time, start the
bridge with `--concurrency 2` and set Signal's Concurrency to 2 (Model › Advanced), which uses the subscription twice
as fast. The manual checklist gains a step: time a few posts (the bridge's log shows the seconds per post).

## No visible change

The terminal output and the popup do not change (the scan's "could not check" line stays as approved in B3; it just
becomes rare). Step 3 (mockups) does not apply.

## Scope

`bridge/adapters.ts` (Codex clean-up), `bridge/runner.ts` (`findMarker` limits and `node_modules`), README.

## Tests (outline)

Codex clean-up: a session of this call in today's folder is removed; old sessions elsewhere are not even looked at
(the number of directory reads is bounded: counted with a spy), and a session in a folder of a date outside the call is
left alone; a call that crosses midnight checks both days. Scan: 60,000 entries pass with the new limit; a
`node_modules` folder full of files is skipped (a marker inside it is not reported, and its entries do not count);
the existing limit tests keep working with their own small limits. A micro-benchmark in the plan's results (not in the
suite): clean-up time with 20,000 old session files before and after.

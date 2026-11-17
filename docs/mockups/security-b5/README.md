# Mockups: security B5 (a failed request must not crash the bridge), SDLC step 3

`terminal.png` (source `terminal.html`), in the style of the earlier terminal mockups; new lines marked with a yellow
bar (mockup only); plain text in reality (finding H); versions, paths and times illustrative.

| # | Scenario | What is new |
|---|---|---|
| 1 | Running: a call cannot be prepared (disk full) | One log line, `502 … not prepared (ENOSPC)`; the next request works again |
| 2 | Running: a re-check cannot run | "re-check failed" plus the reason line; then B2's existing "Stopped serving" lines |
| 3 | Start: no usable temporary folder | One sentence, instead of a JavaScript stack trace |

Lines compared with the real formatting code (`requestLine()`, `dotted()`): match, except the new label below.

**Refined while drawing (a change to the approved design, to confirm):** the design reused the log label "CLI failed"
for a call the bridge could not prepare. That blames the CLI for the bridge's own problem and hides the cause. The
mockup uses **"not prepared (ENOSPC)"**: a fixed label plus the system's error code (no path, no text), so a full disk
is recognisable in the log. Signal's message is unchanged: "The CLI failed (could not prepare the CLI call (ENOSPC))."

## Browser audit (`audit/`)

Both audits from B3, unchanged: `audit/audit.py` (two terminal fonts, axe) and `audit/audit-extended.py` (colour
blindness, copy/paste, accessibility text, fallback font, zoom, forced colours; results in
`audit/extended-results.txt`). Results: longest line 66 columns, no overflow, contrast 0 failures (own scan and axe),
axe 0 violations, copy/paste exact, marker bars add no text and stay visible in forced colours.

## Second browser audit: today (recorded) next to the mockup

`before-after.png` (source `before-after.html`): the **real output of today's bridge**, recorded by running the built
bundle with the fake CLI (a temporary folder removed while it ran; a missing temporary folder at start), next to the
mockup. Paths shortened, nothing else changed.

| Scenario | Today (recorded) | After (mockup) |
|---|---|---|
| 1 · a call cannot be prepared | request 2: `500` "Internal error.", log `rejected 500 internal error`, then a 20-line stack trace and the process ends; request 3: no connection | `502` with the reason; log `502 … not prepared (ENOSPC)`; request 3: `200` |
| 3 · start without a temporary folder | the banner, then a 22-line stack trace, exit code 1 | the banner and one sentence, exit code 1 |

Audit of that page (`audit/audit.py before-after.html`, both fonts): contrast 0 failures (own scan and axe), axe 0
violations; the mockup boxes fit (longest 64 columns); **today's recorded boxes overflow an 80-column terminal**
(84 and 89 columns: Node's stack-trace lines), one more thing the change removes.

Correction found by recording: the design said the failing request gets no answer; it gets `500` first, then the
process ends. The design's problem statement is corrected; the proposed behaviour is unchanged.

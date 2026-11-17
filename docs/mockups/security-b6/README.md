# Mockups: security B6 (token folder and file ownership), SDLC step 3

`terminal.png` (source `terminal.html`): the token messages, in the style of the earlier terminal mockups; new or
changed lines marked with a yellow bar (mockup only); plain text in reality (finding H).

| # | Case | Check |
|---|---|---|
| 1 | Token folder writable by other users | new |
| 2 | A folder above it writable by other users | new |
| 3 | Token file owned by another user | new |
| 4 | Token file readable by other users | existing, re-wrapped (was one line of 146–182 columns) |
| 5 | Not a valid token | existing, re-wrapped |
| 6 | Token folder cannot be created | existing, re-wrapped |

Layout of every message: "Not starting." and what is wrong; the file or folder on its own line; the fix; the exact
command on its own line. **Paths and commands are never shortened** (they must be copyable); only an exceptionally long
home path could make such a line exceed 78 columns. Step 3 refinement of the design's draft: the draft put the command
on the same line as "Fix it with:" (81 columns for the file-owner case); here it has its own line.

## Today (recorded) next to the mockup: `before-after.png`

The real output of today's bridge, recorded by running the built bundle with the fake CLI for cases 1, 4, 5 and 6
(home folder shown as `~`, nothing else changed):
- case 1: the `0777` folder is **accepted** and the bridge starts;
- cases 4, 5, 6: each message is **one line of 146, 125 and 91 columns**;
- case 6's real error code is `EEXIST` (a file in the way of `mkdir -p`), so the mockup uses it (the design's draft said
  `ENOTDIR`).

## Browser audits (`audit/`)

Both audits from B3/B5 on `terminal.html`: longest line 73 columns, no overflow in either terminal font, contrast 0
failures (own scan and axe), axe 0 violations, copy/paste exact, marker bars add no text and stay visible in forced
colours, generic-monospace fallback without overflow (`audit/extended-results.txt`). On `before-after.html` the mockup
boxes fit; the recorded boxes overflow an 80-column terminal by design of what they show.

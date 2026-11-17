# Mockups: security B1 + B2 (which CLI binary runs), SDLC step 3

`terminal.png` (source `terminal.html`): the bridge's terminal output in an 80-column terminal, in the style of the
approved `docs/mockups/bridge/terminal.png`. New or changed lines are marked with a yellow bar on the left (mockup only). Versions, paths and
times are illustrative. Every line is at most 78 columns (checked: no line longer, no box overflows).

| # | Scenario | What is new |
|---|---|---|
| 1 | Start, native installer (symlink into a versions folder) | The path line under "found": link → real file |
| 2 | Start, npm-installed CLI (a script) | Path and real file on two lines when long; "runs with" the interpreter that was checked |
| 3 | A `claude` in an npm `node_modules/.bin` folder (here in a parent of the repo) | A note that it was ignored; yours is used |
| 4 | Only an npm-folder `claude` exists | The note, "not found", and why npm folders are not searched |
| 5 | A CLI others could replace | "unsafe location", the file, the reason, and what to do |
| 6 | The CLI updated itself while running | One log line, the start-up checks again, "re-check passed"; classification continues |
| 7 | The changed CLI fails a check | "re-check failed · not serving any more" and what to do; Signal then gets `503` |

While re-checking (scenario 6), Signal's requests get `429` with `Retry-After` (Signal waits and retries), not `503`
as the design's first draft said: Signal retries a `503` only twice within about 3 seconds, shorter than a re-check.

## Browser audit (`audit/`)

Headed Chromium 141 on Xvfb, the mockup page rendered with each terminal font: **DejaVu Sans Mono** and
**Liberation Mono** (Courier New metrics). Script: `audit/audit.py` (needs `AXE=/path/to/axe.min.js`); results:
`audit/report.json`; renders: `audit/terminal-*.png`.

| Check | First run | After fixes |
|---|---|---|
| Every glyph one cell wide (`·` `→` `…`), so columns line up | pass (1.000 cell each, both fonts) | pass |
| No line over 78 columns, no box overflow | pass (longest 69; overflow 0 px in all 7 boxes) | pass |
| Values after the dots aligned in every box | pass (one x position per font across all 7 boxes) | pass |
| Lines match the real formatting code (`bridge/log.ts`: `dotted()`, `requestLine()`) | **fail**: the two `classify` log lines had one space too many before the time | pass |
| Text contrast, own scan + axe | **fail**: 5 grey timestamps/notes at 3.36:1 on the mockup's highlight background | pass (0, 0) |
| axe, page structure | **fail**: no `lang`, no `main`, no `h1`, heading order | pass (0 violations) |

The contrast and page-structure failures were in the mockup page, not the bridge's output: the highlight behind new
lines (now a bar in the margin) and the page around the terminals. The `classify` spacing was a mockup error: the real
bridge prints `ok     3.8 s`.

Found by the audit and **not** about this mockup: the approved bridge mockup (`docs/mockups/bridge/terminal.png`) and
this one show **colours** (green "ok", red "FAILED", grey timestamps), but the implemented bridge prints plain text
(no ANSI colours). Raised separately as **finding H**, decided: **plain text stays** (below).

## Finding H: terminal colours (decided)

The bridge prints plain text; the colours in both terminal mockups are illustrative only. Decision (you, as a
colour-blind user, left it to my judgement): no colours. Every state is already carried by words ("ok", "passed",
"FAILED", "not found", "unsafe location", "Not starting.", "Stopped serving."), and red/green, the colours the mockups
use for failure/success, are the pair most often confused in colour blindness. Colours would add code (terminal
detection, `NO_COLOR`) without adding information. Rule kept for future output: **meaning never depends on colour**.

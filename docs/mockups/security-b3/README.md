# Mockups: security B3 (post text kept by the CLIs), SDLC step 3

`terminal.png` (source `terminal.html`): the bridge's terminal output in an 80-column terminal, like the earlier
terminal mockups. New or changed lines are marked with a yellow bar on the left (mockup only). Versions, paths and
times are illustrative. Colours are illustrative too: the bridge prints plain text, and every state is in words
(finding H).

| # | Scenario | What is new |
|---|---|---|
| 1 | Start, Claude Code: the marker check finds nothing | "post text not kept on disk ... ok", after the test classification |
| 2 | Start, Codex: the marker is found in a file the clean-up does not cover | "FAILED", the file, and how to accept it knowingly |
| 3 | Start, Codex with `--keep-session-files` | "kept (--keep-session-files)" and where, on every start |
| 4 | Start, a Claude Code version without `--no-session-persistence` | Refused, as for any missing flag; the message now also mentions session files |
| 5 | Running, after a CLI update | The re-check includes the new line |

## Browser audit (`audit/`)

Same audit as for B1+B2 (`audit/audit.py`, headed Chromium, DejaVu Sans Mono and Liberation Mono; needs
`AXE=/path/to/axe.min.js`): every glyph one cell wide, no line over 78 columns (longest 71), no box overflow, values
after the dots aligned in every box, text contrast 0 failures (own scan and axe), axe 0 violations, in both fonts.

Lines compared with the real formatting code (`dotted()`, `pathLines()` in `bridge/log.ts`): one mismatch, fixed in
the mockup before review: the Codex path was drawn on one line cut at the end ("…/@openai/…"), but the bridge prints a
long link and target on **two** lines and shortens from the left, so the end of the path (the file) stays visible.

## Extended browser audit (`audit/audit-extended.py`, results in `audit/extended-results.txt`)

| Check | Result |
|---|---|
| Text contrast under simulated protanopia, deuteranopia, tritanopia, achromatopsia (Machado 2009) | all ≥ 4.78:1 (the grey is the lowest); the marker bar ≥ 10:1 |
| Can the state colours be told apart without words? | **No** for red/green vision: "ok" (green) and "FAILED" (red) come out nearly the same (distance 0.24 of 1.73). Confirms finding H: the words carry every state. Renders with Chromium's own emulation: `audit/vision-*-scenario2.png` |
| Copy and paste of each terminal | exactly the plain lines (the marker bar adds nothing) |
| Accessibility tree | the text only; the marker bars add no text |
| Generic `monospace` (neither named font installed) | no box overflows |
| 200 % zoom, and a 640 px window | the boxes never wrap or overflow; the page scrolls sideways (80-column terminal output is two-dimensional content, like code) |
| Forced colours (Windows high contrast) | **first run: the marker bar disappeared** (painted in the background colour). Fixed in the mockup: the bar uses the system text colour there. Text stays readable (black on white). `audit/forced-colors-scenario2.png` |

The forced-colours issue was in the mockup's annotation (the bar), not in the bridge's output, which is plain text in
your own terminal.

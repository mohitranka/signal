# Mockups: security B4 ("subscription, never API billing"), SDLC step 3

## Popup (`popup-sheet.png`; individual renders `popup-<today|after>-<light|dark>-<font>.png`)

The **built** popup with the bridge preset (Model open, a successful Test connection), today and with the proposed
wording injected into the real popup (not redrawn), light and dark, DejaVu Sans (wide) and Liberation Sans (typical).
The cost tile's tooltip is drawn for the picture (the real one is the browser's native tooltip).

| Text | Today | After |
|---|---|---|
| Help line | "Uses your logged-in Claude Code or Codex subscription through a small server on this computer. …" | "Uses the Claude Code or Codex CLI you are logged in to, through a small server on this computer. …" |
| Test connection | "… · via Claude Code subscription" | "… · via your Claude Code login" |
| Cost tile tooltip | "Plan · Billed to your subscription via the local bridge · no per-token cost" | "Plan · Through your Claude Code login via the local bridge · no per-token estimate (billed as your CLI is set up)" |

Checks (`popup-mock.py`, all 8 renders): no horizontal overflow, nothing truncated, text contrast 0 failures (own scan
and axe). The help line keeps its height (5 lines in the wide font, 4 in the typical one); a side effect in the wide
font: the start command `npm run bridge -- --cli claude` now stays on one line (today it breaks after `--cli`).

## Terminal (`terminal.png`, source `terminal.html`): today (recorded) next to the mockup

Recorded by running today's built bridge with the fake CLIs (home shown as `~`, the fakes' folder as
`~/.local/bin`); the mockup changes only the marked lines:
1. Claude Code start: the test line loses "· subscription"; a three-line billing notice before "Listening".
2. Codex start: its own notice (logged in with an API key instead of a ChatGPT account).
3. Not logged in: "the bridge never bills the API" → "the bridge never passes an API key".

Audits (`audit/`, as for B3–B6): longest line 75 columns, no overflow in either terminal font, values after the dots
aligned, contrast 0 failures (own scan and axe), axe 0 violations, copy/paste exact, marker bars add no text.

## Second browser audit (after review)

**A gap in my first audit:** the extended terminal audit (`audit/audit-extended.py`, copied from B6) crashed halfway on
this page, because it looked for a red "FAILED" span that B4's terminals do not have. The colour-blindness renders and
the forced-colours check had therefore not run, and `extended-results.txt` held a traceback; my summary did not say so.
The script now picks the first coloured span or the terminal's own text. Re-run: complete, all checks pass (below).

| Terminal check | Result |
|---|---|
| Contrast under simulated colour blindness | ≥ 4.78:1 for all text, marker bar ≥ 10:1 |
| Copy/paste, accessibility text | exact; marker bars add no text |
| Generic monospace | no box overflows |
| Forced colours | text and marker bar visible (black on white) |
| Renders | `audit/vision-*-scenario2.png`, `audit/forced-colors-scenario2.png` |

**The popup had only had layout and contrast checks.** New: `audit/popup-audit.py` (results
`audit/popup-audit-results.txt`, `audit/popup-audit.json`), today and after, light and dark:

| Popup check | Result |
|---|---|
| axe, **all** rules (not only contrast) | 0 violations, today and after, light and dark |
| Keyboard: 29 tab stops through the popup | every stop shows a visible focus indicator; order unchanged |
| Provider select, accessible description (Chromium's accessibility tree) | the new help text, complete, command included |
| Test-connection line (role `status`) | announces the new text ("… · via your Claude Code login") |
| Forced colours (light and dark) | help text, command and status line in the system colours, readable (`audit/popup-forced-colors-*.png`) |
| Colour blindness (Chromium emulation) | renders `audit/popup-deuteranopia-*.png`, `audit/popup-protanopia-*.png`; nothing depends on colour |
| 200 % zoom (a popup twice as wide) | no overflow, nothing truncated |
| **Cost tile tooltip** | **reachable by mouse hover only**: the tile is not keyboard-focusable and touch has no hover; the text is exposed only as the tile's accessible *description*, which screen readers often do not announce for a non-focusable element. This is true of all five tiles' details since before this work (their tooltips), so it is raised separately as **finding J**. For B4 it means the billing caveat must not live only in the tooltip: it is also in the start-up notice and the README, and the popup's other texts no longer claim "subscription". |

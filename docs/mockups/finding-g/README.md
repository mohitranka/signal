# Mockups: finding G (text contrast), SDLC step 3

Renders of the **real shipped UI** with the proposed CSS injected (not redrawn), in headed Chromium:

- **Popup**: `dist/popup.html` at 360 px, every section open, realistic data with few corrections (so the "too few"
  numbers show), Keep/Low pills, and an error status line.
- **Feed**: the real `Presenter` bars on a LinkedIn-like page, Review mode, the quiet row for a copied keep (note +
  "Low quality" button), at 3× zoom. Closed shadow roots forced open for the audit only; the after-CSS is added as an
  adopted stylesheet, as the presenter does.

Overview: `sheet.png` (source `sheet.html`). Individual renders alongside.

## Checks on these renders

Two independent checks: axe-core `color-contrast`, and an own text scan (every element with text, colour × inherited
opacity composited over its real background, against 4.5:1). The own scan is needed because axe reports one-character
text such as the "1" in the corrections table as "incomplete", not as a violation.

| Render | axe before → after | own scan before → after |
|---|---|---|
| Popup, light | 20 → 0 | 27 → 0 |
| Popup, dark | 2 → 0 | 8 → 0 |
| Feed quiet row, light | 2 → 0 | 2 → 0 |
| Feed quiet row, dark | 1 → 0 | 1 → 0 |

## What changed during step 3

1. **`--muted` is `#636b75`**, not the `#666e78` in the first draft. With the "too few" numbers moved to `--muted`,
   the token also sits on `--accent-soft` (the current-sensitivity row), where `#666e78` is 4.44:1. The own scan
   caught it; axe did not. `#636b75`: 4.64 on `--accent-soft`, 4.81 on `--surface-2`, 4.99 on `--bg`, 5.40 on white.
2. **Quiet button hover/focus border is `--neutral`**, not `--border`. With `--border` the hover outline was invisible
   on the light page (1.15:1). `--neutral` is 2.07:1 light and 4.58:1 dark. It is decoration only: the label text
   identifies the button, and keyboard focus keeps the 2 px `--focus` outline.
3. The first hover renders showed no hover (the screenshot call ends the hover). They are now taken while the pointer is
   still on the button.
4. axe's contrast rule only measures what is inside the viewport, so the feed page is audited in a viewport tall
   enough to hold all eight bars (a small one silently skipped the dark quiet row).

## Repeatable check (step 6)

`contrast-check.py` (with `feed-harness.ts`) re-runs these checks against the built extension:
`npm run build && xvfb-run -a python3 docs/mockups/finding-g/contrast-check.py` (optionally `AXE=/path/to/axe.min.js`).

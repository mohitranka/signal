# Implementation plan: finding F (popup width and session tiles, variant V7)

Status: **implemented**.
Design: `docs/design-finding-f-popup-width.md` (approved, V7). Mockups: `docs/mockups/finding-f/` (approved).

## How layout is tested

`npm test` runs in jsdom, which has **no layout engine**: it cannot measure overflow, wrapping or truncation. Two kinds
of check, therefore:

1. **In the suite (vitest, no new dependency):**
   - **CSS contract tests** that read `public/popup.css` and assert the rules V7 depends on (below). They catch a rule
     being dropped or changed by accident.
   - **Behaviour tests** for the tooltip change in `popup.ts` (jsdom handles that).
2. **Outside the suite (real browser, run and reported in step 6):** the same headed-Chromium measurement used in steps 2
   and 3, against the **built** `dist/popup.html`. It checks horizontal overflow, tiles past the card edge and truncated
   text, under both fonts, with and without a scrollbar, with realistic and extreme values. The script is committed as
   `docs/mockups/finding-f/layout-check.py` so it can be re-run (Python Playwright + Chromium; not a project
   dependency).

Adding Playwright to `npm test` would need a ~150 MB browser download and lockfile changes against the (stale) registry
from finding D. Not proposed.

## Change (one task)

- `public/popup.css`:
  - `body { width: 360px; max-width: 100%; }`;
  - `.tiles { grid-template-columns: repeat(4, minmax(0, 1fr)) minmax(0, 1.2fr); gap: 4px; }`;
  - `.tile { padding: 6px 2px; min-width: 0; }`;
  - `.tile b { font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }`;
  - `.tile span { font-size: 10.5px; white-space: normal; line-height: 1.2; }`.
- `src/popup/popup.ts`, `tile()`: the tooltip starts with the displayed value, `"<value> · <detail>"`, except when the value
  is "—" (nothing to repeat).

## Tests first

| # | File | Case | Expected before fix |
|---|---|---|---|
| 1 | `popup-css.test.ts` (new) | `body` keeps `width: 360px` and has `max-width: 100%` | fails |
| 2 | `popup-css.test.ts` | `.tiles` columns `repeat(4, minmax(0, 1fr)) minmax(0, 1.2fr)`, gap 4 px; `.tile` `min-width: 0` | fails |
| 3 | `popup-css.test.ts` | `.tile b`: 14 px, `overflow: hidden`, `text-overflow: ellipsis`, `white-space: nowrap`; `.tile span`: 10.5 px, `white-space: normal` | fails |
| 4 | `popup.test.ts` (existing assertions updated, as the design changes the tooltip text) | Each tile's tooltip starts with its value: `"2 · 3 HTTP requests · avg latency 150 ms"`, `"4 · 7 entries stored"`, `"1.5k · 1,000 in · 500 out"`, `"$0.0020 · Estimated from your configured prices"`, repeats likewise | fails |
| 5 | `popup.test.ts` | With no prices, the cost tooltip has no "— ·" prefix | passes (guard) |

## Done when

Tests 1–5 pass (1–4 red first); full suite, typecheck and build green. `layout-check.py` on the **built**
`dist/popup.html` reports: 0 px horizontal overflow with Model + Advanced open; 0 px past the card edge; no truncation
with realistic values (both fonts, 360 px and 345 px); extreme values ellipsised with the full value in the tooltip.

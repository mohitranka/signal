# Implementation plan: finding G (text contrast below WCAG AA)

Status: **implemented**.
Design: `docs/design-finding-g-contrast.md` (approved). Mockups: `docs/mockups/finding-g/` (approved, with
`--muted #636b75` and the `--neutral` hover border).

## How contrast is tested

jsdom does not compute cascaded colours or composite opacity, so as with finding F there are two kinds of check.

1. **In the suite (vitest, no new dependency): contrast computed from the stylesheets.**
   A small test helper reads `public/popup.css` and the bar CSS in `src/content/presenter.ts`. It resolves a rule's
   `color` and `background` through the `var(--token)` values of the light scheme (`:root`, `.bar`) and the dark scheme
   (the `prefers-color-scheme: dark` block), applies `opacity`, and computes the WCAG ratio. The test has a table of
   every text-bearing rule (the design's inventory: popup 14 pair roles, in-feed bars 4) with the background it sits
   on, and asserts ≥ 4.5:1 in both schemes. So the test checks the actual rules, not copied hex values: a later token
   or rule change that drops a pair below 4.5:1 fails it.
2. **Outside the suite (real browser, run and reported in step 6)**: `docs/mockups/finding-g/contrast-check.py`, the
   mockup audit made repeatable. It renders the **built** `dist/popup.html` (every section open, few corrections so
   the "too few" numbers show, pills, error line) and the **real `Presenter`** in all 8 bar states (including the quiet
   button at rest, hovered and keyboard-focused), light and dark, in a viewport tall enough that nothing is
   off-screen. It runs the own text scan from step 3 (every element with text, colour × inherited opacity composited
   over its real background, against 4.5:1) and, when `AXE=/path/to/axe.min.js` is set, axe-core `color-contrast`
   too. Exits 1 on any failure.
   - The feed page is a small committed harness (`feed-harness.ts` + `.html` next to the script) that the script
     bundles with the project's own esbuild into a temp directory. Python Playwright, Chromium and axe-core are not
     project dependencies (same reasoning as finding F: no lockfile changes against the stale registry).

## Change (one task, one commit)

`public/popup.css`
- Light `:root`: `--muted: #636b75` (was `#68707a`), `--danger: #bb3f38` (was `#c2413a`), new
  `--accent-text: #2c7667`. Dark block: new `--accent-text: var(--accent)`; other dark tokens unchanged.
- `.pill.keep { color: var(--accent-text); }` (background unchanged).
- `.corr .sub { color: var(--muted); }`, `.corr td.weak { color: var(--muted); }` (weight stays 500; the other numbers
  are 600).
- `details.card > summary::after`: chevron borders `var(--muted)`.
- `--faint`: after the three changes above nothing uses it any more, so the token is **removed** from both schemes
  rather than left dead. (The design said "stays for decoration only"; there turns out to be no decoration use left.
  Say if you would rather keep it.)

`src/content/presenter.ts` (bar CSS)
- `.bar.quiet button`: no `opacity`; `color: var(--fg)`; `background: transparent; border-color: transparent` (the
  1 px border stays, so nothing shifts on hover); `transition: color .12s, background-color .12s, border-color .12s`.
  Size, weight and padding unchanged (11.5 px, 500, `2px 10px`).
- `.bar.quiet button:hover, .bar.quiet button:focus-visible`: `color: var(--strong); background: var(--surface);
  border-color: var(--neutral)`. The general `button:focus-visible` 2 px `--focus` outline still applies.
- `.bar.quiet .note`: no `opacity` (size stays 11 px). The `.bar.quiet .note:hover, :focus-within { opacity: 1 }` rule
  is removed, as it only undid the opacity.

No behaviour change, no TypeScript logic change.

## Tests first

| # | File | Case | Expected before fix |
|---|---|---|---|
| 1 | `contrast.test.ts` (new) + `tests/css.ts` (helper) | Helper self-check: resolves `var()` per scheme, composites opacity, and matches known WCAG ratios (black/white 21:1, `#767676` on white 4.54:1) | passes (guards the helper) |
| 2 | `contrast.test.ts` | Popup, **light**: every inventoried text rule ≥ 4.5:1 on its background (tile labels, unselected segments, copied-verdicts line and neutral pill on `--surface-2`; corrections sub-labels and "too few" numbers on `--surface` and `--accent-soft`; Keep pill; Low pill and error line; Reset; notices; chip; primary button; status lines; muted text on `--bg`/`--surface`) | fails (`--muted`/`--surface-2` 4.47, `--faint` 2.25–2.61, Keep 4.23, danger 4.36) |
| 3 | `contrast.test.ts` | Popup, **dark**: same table | fails (`--faint` 2.86–3.56) |
| 4 | `contrast.test.ts` | In-feed bars, light and dark, against LinkedIn's page background (`#f4f2ee` / `#000000`) and card (`#ffffff` / `#1b1f23`): reason text, collapsed bar text, quiet "Low quality" button at rest and on hover/focus, quiet note row | fails (button 2.21 / 3.36, note 2.88) |
| 5 | `contrast.test.ts` | `--faint` is not defined or used anywhere in `popup.css`; chevrons use `--muted` | fails |
| 6 | `contrast.test.ts` | Quiet button at rest has no border or fill (`transparent`); on hover/focus it gets `--surface` fill and `--neutral` border; the 2 px focus outline rule for bar buttons is still present | fails (no fill/border rules yet) |

Test 1 passes before and after: it guards the helper, so a bug in the helper cannot make 2–4 pass falsely.

## Step 5 results (tests red before the fix)

`tests/css.ts` (helper) and `tests/contrast.test.ts`: 12 tests; the 2 helper tests pass, the other **10 fail** as
expected (popup light, popup dark, `--faint`, chevrons, feed × 4 backgrounds, no-opacity, quiet-button rules). Full
suite otherwise unchanged (554 passed = 552 + 2 helper tests), typecheck clean.

The computed table reaches three pairs the step-2 inventory and the step-3 renders did not show. All three are fixed
by the approved changes, no new colour needed:

| Pair | Before | After (approved tokens) |
|---|---|---|
| wrongly-hidden numbers in the current-sensitivity row (`--danger` on `--accent-soft`, light) | **4.40** | 4.66 (`--danger #bb3f38`) |
| "Reset" button hovered (`--danger` on `--danger-soft`, light; same pair as the Low pill) | **4.36** | 4.62 |
| quiet note row on LinkedIn's dark card colour `#1b1f23` (opacity .7) | **4.42** | 7.57 (no opacity) |

`contrast-check.py` will render the corrections table twice (too few corrections → "too few" numbers; enough →
wrongly-hidden numbers in the current row), so the browser check covers the first pair too.

## Done when

Tests 2–6 red first, then all pass; full suite, typecheck and build green. `contrast-check.py` against the built
extension: 0 failures from the own scan in popup and feed, light and dark, including the quiet button hovered and
focused; with `AXE` set, 0 axe `color-contrast` violations. Before/after counts reported (expected before: popup
27 / 8, feed 2 / 1, as in step 3).

## Step 6 results

- Suite: 564 passed (552 before + 12 new), typecheck clean, build green.
- `contrast-check.py` on the built extension, with `AXE` set (failing text elements, own scan / axe):

  | Render | Before (previous commit) | After |
  |---|---|---|
  | popup light, few corrections | 27 / 21 | 0 / 0 |
  | popup light, enough corrections | 39 / 38 (incl. the wrongly-hidden "2" at 4.40:1, own scan only) | 0 / 0 |
  | popup dark, few corrections | 8 / 2 | 0 / 0 |
  | popup dark, enough corrections | 2 / 2 | 0 / 0 |
  | feed light, 8 states at rest | 2 / 2 | 0 / 0 |
  | feed light, quiet button hovered / focused | 1 / – each (the quiet note) | 0 |
  | feed dark, 8 states at rest | 1 / 1 | 0 / 0 |
  | feed dark, quiet button hovered / focused | 0 | 0 |

  The counts are per element (e.g. each Keep pill in the list counts once), so they differ from step 3's renders,
  which had fewer list items. The "before" run used the same script against a clean worktree of the previous commit.

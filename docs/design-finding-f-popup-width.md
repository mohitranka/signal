# Finding F: popup overflow with classic scrollbars, and a session-tile row with no margin

Status: **implemented** (V7). From the bridge mockup audit (`docs/mockups/bridge/audit/`, R1).

## Problem (measured in headed Chromium with classic scrollbars, as on Windows and Linux)

1. **Page overflow.** `body { width: 360px }`. When the popup is taller than Chrome's 600 px limit (e.g. Model +
   Advanced open), a 15 px vertical scrollbar leaves 345 px for 360 px of content. Result: a **horizontal scrollbar**, and
   every card's **right edge clipped**. Reproduced in the **shipped** popup (screenshot in the audit). macOS overlay
   scrollbars take no space, so Mac users never see it.
2. **Found while measuring fixes: the session-tile row has no margin (my T11 change).** Since T11 added the fifth tile
   ("repeats"), the tiles' content needs about the whole card width. With realistic values (`1.2k`, `999`, `218`, `218k`,
   `$21.83`) the last tile already sticks **4.5 px past the card's inner edge** at the normal 360 px under a wide font
   (DejaVu Sans), and exactly fits (0 px spare) under Arial-metric fonts. At 345 px it would stick out **19.5 px**. The T11
   audit compared tiles with each other, not with the card edge, so it missed this.

## Candidates measured

Page width (Model + Advanced open; DejaVu and Liberation Sans):

| Candidate | Horizontal overflow | Cards cut | Notes |
|---|---|---|---|
| shipped | 15 px | yes | |
| **A: `body { max-width: 100% }`** | **0** | **no** | the body becomes 345 px when a scrollbar appears, 360 px otherwise |
| B: `html { scrollbar-gutter: stable }` | 15 px | yes | helps only if Chrome widens the popup window for the gutter: not verifiable here |
| C: `html { overflow-x: hidden }` | hidden, content still cut | yes | hides the symptom |

Tile row (realistic values; 360 px and 345 px; "past edge" = beyond the card's inner edge):

| Variant | Past edge (worst) | Truncated (wide font, 345 px) | Truncated (typical font) | Row height |
|---|---|---|---|---|
| current | 19.5 px | — (spills out instead) | — | 53 px |
| V1 equal columns, tighter gap/padding, ellipsis | 0 | `cache hits`, `$21.83` | none | 50 px |
| V2 = V1 + 10.5 px labels | 0 | `cache hits`, `$21.83` | none | 49 px |
| V3 equal columns, labels may wrap | 0 | `$21.83` | none | 47 / 60 px |
| V4 = V3 + 14 px values, ellipsis last resort | 0 | `$21.83` only | none | 45 / 59 px |
| V4 + cost column 1.2fr (11 px labels) | 0 | `classified` spills 2 px | none | 45–59 / 59 px |
| **V7 = V4 + cost column 1.2fr + 10.5 px labels** (chosen at the step-3 review) | **0** | **none** | **none** | **45 / 57 px** |

At the step-3 review the cost tile was given more room, so that a dollar amount is the last thing to be cut. Cost
column widths of 1.2–1.5fr were measured: from 1.2fr `$21.83` stays whole, but the squeeze moves to the label
"classified" (a single word, so it cannot wrap). 10.5 px labels resolve that: **V7 truncates nothing with realistic
values, under either font, at either width.**

An extreme value like `$1,234.56` gets an ellipsis in every variant. Nothing can fit 5 tiles at 14–15 px in 345 px
otherwise.

## Proposed fix

1. **`body { width: 360px; max-width: 100% }`** (A): no horizontal scrollbar and no cut cards, with or without a
   vertical scrollbar. With overlay scrollbars (macOS) nothing changes.
2. **Tile row V7** (updated at the step-3 review; was V4):
   - columns `repeat(4, minmax(0, 1fr)) minmax(0, 1.2fr)`: the cost tile slightly wider, and the row can never be wider
     than the card;
   - gap 4 px, tile padding 6 px 2 px;
   - values at 14 px (was 15 px), one line, ellipsis only as a last resort;
   - labels at 10.5 px (was 11 px), allowed to wrap onto two lines.
3. **The full value is always in the tile's tooltip:** each tile's existing tooltip starts with its value (e.g.
   "$21.83 · Estimated from your configured prices"), so an ellipsised value is never lost. Existing tests that assert the
   exact tooltip text are updated accordingly.

### What you notice

On Windows and Linux there is no more sideways scrolling or cut-off cards when sections are open. The session tiles look
almost the same: values a little smaller; on systems with wide fonts some labels wrap to two lines; and a very long
value shows "…", with the full value on hover.

## Scope

- `public/popup.css` (body; tiles) and `src/popup/popup.ts` (tooltips start with the value).
- **Visual change → step 3 mockups:** before and after renders of the real popup under both fonts, light and dark.

## Risks

- **The tile row's height changes** (45 px typical, 59 px with wrapped labels, against 53 px). Rendered in step 3.
- **Real Chrome popup sizing** (whether Chrome ever widens the window for a scrollbar) cannot be observed here. Fix A does
  not depend on it: the body fits whatever width it gets.

## Result (step 6)

`docs/mockups/finding-f/layout-check.py` on the **built** popup, in headed Chromium with classic scrollbars:

| Case | Before | After |
|---|---|---|
| wide font, no scrollbar, realistic values | tile 4.5 px past the card edge | ok |
| wide font, scrollbar, realistic values | 15 px horizontal overflow; 4.5 px past the edge | ok |
| typical font, scrollbar, realistic values | 15 px horizontal overflow | ok |
| extreme `$1,234.56` | up to 19 px overflow, 30.6 px past the edge, no ellipsis | ok: fits (typical font, no scrollbar) or ellipsised with the full value first in the tooltip |

8 of 8 cases pass after the fix; 6 fail on the pre-fix build.

Corrected during step 6: the check first required the extreme value to be ellipsised in every case, but under the typical
font without a scrollbar it simply fits. The requirement is "no overflow; ellipsis if it does not fit; full value in the
tooltip", and the check now says exactly that. It still fails 6 cases on the pre-fix build.

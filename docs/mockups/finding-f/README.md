# Mockups: finding F (popup width and session tiles), SDLC step 3

Renders of the **real shipped popup** (`dist/popup.html`) in **headed Chromium with classic scrollbars** (as on Windows
and Linux), at Chrome's popup size of 360×600. "After" = the proposed CSS injected into the real popup (not a redraw).
Realistic large values: `1.2k`, `999`, `218`, `218k`, `$21.83`. The overview is `sheet.png`; the individual renders are
alongside it.

| Case | Before | After |
|---|---|---|
| Model + Advanced open (scrollbar), wide font | horizontal scrollbar; every card's right edge cut | no horizontal scrollbar; cards whole; "cache hits" wraps; `$21.83` whole |
| Same, typical font (Arial metrics) | horizontal scrollbar; cards cut | no horizontal scrollbar; nothing truncated |
| All sections closed (360 px), wide font | last tile touches/passes the card edge | fits; "cache hits" wraps to two lines |
| All sections closed, typical font | fits with 0 px spare | fits; values 14 px |
| Extreme value `$1,234.56` | — | `$1,23…`; full value first in the tooltip |

Re-rendered after the step-3 review with variant **V7** (cost column 1.2fr, labels 10.5 px). The first round (V4) cut
the cost to `$21.…` in the worst case.

The tooltip in the last render is drawn for the mockup (the real one is the browser's native tooltip).

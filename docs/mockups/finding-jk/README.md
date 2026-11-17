# Mockups: findings J + K (session tiles), SDLC step 3

Decisions from step 2: **K-a** (a cost under one cent shows `<$0.01`; exactly zero `$0.00`) and **J-b** (a "Details"
disclosure under the tiles, listing the five details as text; the mouse tooltips stay).

`stats-sheet.png`: the session card in the **built** popup with the proposal injected (not redrawn), DejaVu Sans (the
wide font) with a scrollbar: today (`$0.00…`), after with Details closed, after open (light and dark). Individual
renders: `stats-*.png`.

## Checks

`popup-mock.py` (results `popup-mock-results.txt`): 48 renders: a sub-cent session (cheap model) and finding F's
large session (`$21.83`); light and dark; both fonts; with and without a scrollbar; today, after closed, after open.
Each: horizontal overflow, any tile or detail text cut, text contrast (own scan), axe (all rules), a visible focus ring
on every tab stop. **All "after" renders pass.** "Today" fails only where findings J/K say it does (`$0.0070` cut in
DejaVu with a scrollbar).

`popup-audit.py` (results `popup-audit-results.txt`), light and dark:
- keyboard: Tab reaches the Details summary, it shows a focus ring, Enter opens it;
- accessibility tree: a disclosure ("expanded" state), all five detail lines exposed as text, the exact cost included;
- forced colours: the list and the summary in the system colours (`stats-forced-colors-*.png`);
- colour blindness: Chromium's emulation renders (`stats-deuteranopia-*.png`, `stats-protanopia-*.png`); nothing
  depends on colour;
- 200 % zoom: no overflow, nothing cut.

## Noted, not raised

A tokens tile can show `110.2M` (after about 110 million tokens in one session), which is cut in the wide font. That
is roughly 100,000 classified posts in one session; an earlier draft of this mockup used such a session by mistake to
reach `$21.83` at a cheap model's prices. The check now uses finding F's realistic large session (218k tokens, `$21.83`).

## Second browser audit (after review)

New checks on the same mockup, and what they changed:

| Check | Result | Change to the mockup |
|---|---|---|
| The other cost cases, never rendered before: bridge (**Plan**), no prices (**—**), zero | all fit, contrast 0 failures, both fonts, light and dark (`cost-cases.py`, `stats-cases-sheet.png`) | the zero case's detail said `$0.0000` while the tile says `$0.00`: both now `$0.00` |
| How a screen reader reads the tile `<$0.01` | literally, and "<" is read differently by different screen readers | the tile's value is hidden from screen readers and a visually hidden "under 1 cent" is read instead (the tile looks the same) |
| Target size of the new "Details" control (WCAG 2.2, 2.5.8: at least 24 px) | 17 px tall | padding added: 25.4 px tall |
| The Details list after the stats are refreshed (Test connection refreshes them) | stays open in the mockup | the implementation must update the list in place, not rebuild it (noted for the plan) |
| Today's tooltips next to the proposed detail lines | same facts; today's latency is not formatted (`4146 ms`) while the details are (`4,146 ms`) | the tooltip will use the same formatting (noted for the plan) |

Re-run after the changes: `popup-mock.py` 46 of 48 renders pass; the 2 failures are "today" (the `$0.00…` of K itself);
`popup-audit.py`: screen reader hears "under 1 cent", Details 25.4 px tall, keyboard, accessibility tree, forced
colours and 200 % zoom as before.

**Found, not part of J/K (raised as finding L; closed after measuring with WCAG 2.5.8's exceptions: no failure, see `docs/design-finding-l-target-size.md`):** other popup controls are also under 24 px: the on/off switch (22 px),
the small switches (18 px), "Advanced" and "Clear cache" (17 px). WCAG 2.5.8 allows small targets with enough space
around them, which may cover some of these; this needs its own check.

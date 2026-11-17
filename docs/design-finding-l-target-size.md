# Design: finding L, small click targets

Status: **closed (L-a)**: no failure; no change. The target-size check (`docs/mockups/finding-l/target-size.py`) is kept
with the other browser checks. Raised in the J+K mockup audit
(`docs/mockups/finding-jk/README.md`): several popup controls are under 24 px.

## What the rule actually asks, and what was measured

WCAG 2.2 SC 2.5.8 (Target Size, Minimum, level AA) asks for 24 × 24 px, **or** one of its exceptions:
- **spacing**: a 24 px circle centred on the small target touches no other target and no other small target's circle;
- **inline**: the target sits in a sentence (its size is set by the line of text).

Measured in a real browser (`docs/mockups/finding-l/target-size.py`, results `target-size-results.txt`): every
interactive element of the built popup with all sections open, and of the real in-feed bars in all 8 states.

| Control | Size (px) | Result |
|---|---|---|
| On/off switch (header) | 38 × 22 | passes: spacing |
| "Highlight standout posts" switch, "Recognise repeated templates" switch | 32 × 18 | passes: spacing (and the whole row is their label, so the clickable area is the full row) |
| "Advanced", "1 left out" (disclosures) | 306 × 17 | passes: spacing |
| "Clear cache" | 71 × 17 | passes: spacing |
| In-feed "Judge separately" | 110 × 17 | passes: inline in the note's sentence |
| In-feed quiet "Low quality" | 88 × 23 | passes: spacing |
| Everything else (buttons, fields, segments, new "Details") | ≥ 24 | passes |

**Result: no failure.** My J+K audit called these "under 24 px" without applying the exceptions; the finding as raised
was overstated.

## Options

- **L-a (recommended): close L with this evidence, no change.** Keep `target-size.py` with the other browser checks so
  a future layout change that crowds these controls is caught (the spacing exception is what they rely on).
- **L-b: enlarge the hit areas anyway** ("Advanced", "1 left out", "Clear cache" to 24 px tall, the header switch to
  24 px) for easier clicking, without moving anything (padding plus an equal negative margin), as the new "Details"
  already is. A visual no-op, but a change to finding F's tuned layout that would need its checks again; the benefit
  over the passing state is small.

## Scope

L-a: documentation only (this design, the script and its results). L-b: `public/popup.css`.

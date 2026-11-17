# Browser audit of the bridge mockups

**How:** Chromium 141 (Playwright), **headed** on a virtual display (Xvfb), so with **classic scrollbars that take
up space**, as on Windows and Linux. Popup at 360 px wide; Chrome popups are at most 800×600. Every page in light and
dark, under two fonts bounding real-world text widths:
- **DejaVu Sans:** wide; what this machine falls back to for `system-ui`.
- **Liberation Sans:** Arial metrics, close to Segoe UI and Helvetica.

Checks:
- layout: page overflow, clipped or truncated text, whether the `<select>` text fits;
- **axe-core 4.14** (accessibility, including colour contrast);
- keyboard order, and a visible focus ring on every stop.

The same layout check was also run on the **shipped** `dist/popup.html` as a baseline.

**Limit:** static mockups in Chromium, not branded Chrome with the extension loaded (not possible in this sandbox).

## Real findings

| # | Finding | Source | Evidence |
|---|---|---|---|
| R1 | **Horizontal scrollbar and clipped right edge** when the popup is taller than 600 px on systems with classic scrollbars (Windows, Linux). `body { width: 360px }` plus a 15 px vertical scrollbar leaves 345 px for 360 px of content. | **Exists in the shipped popup** (Model + Advanced open: 15 px overflow). The bridge preset makes it more likely (a taller Model card). | `shipped-popup-horizontal-overflow.png`; mockup: 15 px in all four runs |
| R2 | **Colour contrast below WCAG AA in light mode:** tile labels 4.46:1 (`#68707a` on `#f0f2f4`; needs 4.5), including the new "est. cost"/"Plan" tile; error lines 4.35:1 (`#c2413a` on `#fbe9e7`). Dark mode passes. | **Exists in the shipped `popup.css`**. The bridge adds four more error messages in that style. | `axe-and-layout-report.json` |
| R3 | **Terminal output is too wide:** the longest line is 116 columns, and 9 lines exceed 80, so they wrap untidily in a standard 80-column terminal. | New (mockup design) | column count per line |
| R4 | The preset's help line is not linked to the Provider select (`aria-describedby`), so screen readers do not announce it. (axe does not flag it; best practice.) | New (mockup design) | manual review |

## Passed

- **No clipping or truncation under either font:** the chip `claude-code · sonnet`, the "Plan" tile, and the provider
  option "Local CLI bridge (Claude Code / Codex)" all fit in DejaVu (wide) and Liberation.
- **Keyboard:** every new control is reachable in a logical order (Provider → Endpoint → Model → Bridge token →
  Advanced → Concurrency → Timeout → Save → Test connection), each with a visible focus ring. The disabled price fields
  are skipped, as expected.
- **Dark mode:** no contrast violations.

## Mockup-only artefacts (not product issues)

- axe "more than one main landmark" / "content not in landmarks": the mockup page stacks two popup states and captions.
- Terminal page 31 px wider than the 920 px viewport: mockup page layout, not terminal output.

## After fixes (re-audit in the same browser)

| # | Outcome |
|---|---|
| R3 | **Fixed in the mockup.** Terminal output redesigned: the longest line is 75 columns (was 116), none over 78. Each terminal box is now exactly 80 columns wide, and nothing overflows it in DejaVu Sans Mono or Liberation Mono. |
| R4 | **Fixed in the mockup.** The Provider select has `aria-describedby` → the help line. Chromium's accessibility tree: name "Provider", description "Uses your logged-in Claude Code or Codex subscription through a small server on …". |
| R1 | **Queued as finding F** (popup overflow with classic scrollbars; in the shipped popup). Steps 2–6 before the bridge is implemented. |
| R2 | **Queued as finding G** (light-mode contrast of tile labels and error lines; in the shipped `popup.css`). Steps 2–6 before the bridge is implemented. |

The remaining axe results are R2 (queued) and the mockup-page landmark artefacts, as before. No regressions.

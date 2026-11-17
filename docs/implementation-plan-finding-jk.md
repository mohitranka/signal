# Implementation plan: findings J + K (session tiles)

Status: **implemented**.
Design: `docs/design-finding-jk-session-tiles.md` (approved: K-a, J-b). Mockups: `docs/mockups/finding-jk/` (approved,
audited twice; with the refinements from the second audit).

## Changes (one task, one commit)

### `public/popup.html`
Under the tiles and the meta line: `<details class="tile-details" id="statsDetails"><summary>Details</summary><ul
id="statsDetailList"></ul></details>`, closed by default.

### `public/popup.css`
The mockup's rules: summary 12 px muted with `padding: 4px 0` (≥ 24 px tall); list items 12 px `--text`, label 600.

### `src/popup/popup.ts`
- **Cost value (K-a):** `$0.00` for exactly zero, `<$0.01` for a cost above zero and below one cent, `$x.yy` otherwise.
  The exact amount (`$0.0070`) is kept for the tooltip and the details.
- **Spoken value:** for `<$0.01` the visible value is hidden from screen readers (`aria-hidden`) and a visually hidden
  "under 1 cent" next to it is read instead; for other values both are reset (the tiles are updated in place).
- **Tooltips:** the cost tooltip is "`<$0.01` · `$0.0070` estimated from your configured prices" when the shown value is
  rounded, today's "… · Estimated from your configured prices" otherwise; the latency in the classified tooltip is
  formatted (`4,146 ms`).
- **Details list (J-b):** five lines built with `textContent` (label in `<b>`), replaced inside the existing `<ul>` on
  every refresh so the disclosure keeps its open or closed state:
  1. Classified: `n` posts · `n` HTTP requests[ · avg latency `n` ms]
  2. Cache hits: `n` · `n` entries stored
  3. Repeats: `n` copied from a similar post · no model call · `n` stored
  4. Tokens: `n` in · `n` out
  5. Bridge: "Plan: through your `<CLI>` login via the local bridge · no per-token estimate (billed as your CLI is set
     up)"; prices: "Estimated cost: `<exact>` from your configured prices"; none: "Estimated cost: add $/1M token prices
     under Model › Advanced".

### Browser checks (outside the suite)
Finding F's `layout-check.py` gains the sub-cent case it missed (a cheap model's `$0.0070`); the tile values must not
be cut. Finding G's contrast table (`tests/contrast.test.ts`) gains the details text and summary.

## Tests first (red before the change)

| # | File | Case |
|---|---|---|
| 1 | `popup-stats.test.ts` (new) | Cost tile: zero → `$0.00`; `$0.0018` → `<$0.01`, value `aria-hidden`, "under 1 cent" read instead; `$0.01` and `$21.83` as today, nothing hidden |
| 2 | same | Tooltips: `<$0.01 · $0.0018 estimated from your configured prices`; classified `… · avg latency 4,146 ms` |
| 3 | same | Details: present, closed by default, summary "Details", the five lines exactly, for prices, no prices, the bridge and zero |
| 4 | same | After a refresh (Test connection) the same `<details>` element keeps its open state and shows the new numbers |
| 5 | `popup-css.test.ts` | `.tile-details > summary` has `padding: 4px 0` (the 24 px target) |
| 6 | `contrast.test.ts` | The details text (`.tile-details li`) and summary at ≥ 4.5:1, light and dark |

Existing assertions that quote the old sub-cent cost (`$0.0020 · Estimated from your configured prices` in
`popup.test.ts`) and the old latency format change with this finding and are updated in the same step.

## Step 5 (tests first): results

**10 red**, each for the expected reason: `popup-stats.test.ts` 7 of 7 (today `$0.0018`, `$0.0000`, the old tooltip,
no Details element); `popup-css.test.ts` 1 (no `.tile-details` rule); `contrast.test.ts` 2 (light and dark: no colour
rule for the details yet); `popup.test.ts` 1 (its sub-cent expectation updated to `<$0.01`, so the test report lists it
as a regression until the change). Outside the suite: finding F's `layout-check.py` with the new cheap-session case
**fails today** (`$0.0057` cut in DejaVu Sans with a scrollbar) and passes the other 11 cases. Rest of the suite
unchanged.

## Done when

All red first, then green; full suite (normal and slow), typecheck and build green. Browser: F's layout check with the
sub-cent case passes (it fails today), G's contrast check, the bridge preset check, and the J+K mockup scripts against
the built popup (now without injection) match the approved mockups.

## Step 6 results

- The 10 red tests green; full suite 755 passed, also with `SIGNAL_TEST_SLOW_HASH=25`; typecheck and build green.
- Mutations: the cost shown unrounded again → 2 tests fail; the details appended instead of replaced on refresh → the
  "updated in place" test fails.
- Existing assertions updated because K changed what they quote: `popup-bridge.test.ts` (a sub-cent estimate is now
  `<$0.01`, its tooltip names the exact amount) and `popup.test.ts` (the tile labels are read with `:not(.sr)`, since
  a rounded value now has a screen-reader text next to it).
- A first version of `tile()` added an empty screen-reader span to every tile; that changed the tiles' structure for
  no reason (an existing test noticed). It now adds the span only when there is something to say and removes it
  otherwise.
- Browser: finding F's `layout-check.py` passes all 12 cases including the new cheap session (it failed before); its
  measurement now skips the visually hidden text (`.sr`, 1 px by design). Finding G's contrast check and the bridge
  preset check pass. `docs/mockups/finding-jk/as-built-check.py` against the built popup: 32 of 32 renders pass
  (overflow, cut text, contrast, axe all rules, visible focus); the cost tile is read as "under 1 cent"; the
  "Details" disclosure is in the accessibility tree; its summary is 25.4 px tall; the render matches the approved
  mockup (`stats-as-built-*.png`).

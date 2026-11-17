# Design: findings J and K, the session tiles

Status: **implemented** (K-a, J-b; design and mockups approved; `docs/implementation-plan-finding-jk.md`). J from the B4 popup audit, K from the B7 popup audit
(`docs/mockups/security-b4/README.md`, `docs/mockups/security-b7/README.md`).

## The problems

**K: the most common cost is cut off.** A session cost under one cent is shown with four decimals (`$0.0070`,
`$0.0018`), which is the usual case with a cheap model. In a wide font (DejaVu Sans, the fallback on many Linux
systems) with a scrollbar (Model and Advanced open), the value needs 64 px and the tile has 59: it shows `$0.00…`.
Measured in the real popup: every sub-cent value is cut; `$21.83` and `$1.05` fit. Finding F's check missed it (its
"realistic" values were `$21.83` and `$1,234.56`).

**J: the tiles' details are mouse-only.** Each tile's detail (HTTP requests and latency, cache entries stored, repeat
index size, tokens in/out, how the cost is estimated) exists only as a native tooltip (`title`). The tiles cannot be
focused with the keyboard, touch has no hover, and screen readers often skip a `title` on an element that cannot be
focused. With K, the exact cost is also only in that tooltip. B4's billing caveat for the bridge lives there too (it is
also in the terminal and README).

## K: options (measured in the real popup, DejaVu Sans with a scrollbar: the cost tile has 59 px of room)

| Option | Sub-cent cost shows as | Fits | Trade-off |
|---|---|---|---|
| **K-a (recommended)** | `<$0.01` | yes (56 px) | simple and always fits; the amount itself is in the details (J), exact |
| K-b | three decimals: `$0.007`, `$0.002` | yes (54 px) | keeps the order of magnitude, rounds the last digit; **but** a cost under a tenth of a cent has no fitting form: `<$0.001` needs 66 px, and `$0.000` would read as "free" |
| K-c | `$0.0070` in a wider cost column (1.3fr–1.5fr) | the cost fits, but then **"classified"** (49 px) no longer fits its tile in the same font | trades one cut-off for another; rejected |
| K-d | `$0.0070` at 13 px | 59.2 px in 59 px | no margin; rejected |

With K-a, a cost of exactly zero shows `$0.00` (today `$0.0000`). Costs of one cent and more are unchanged (`$0.01` … `$21.83`; an extreme `$1,234.56` may still end in `…`, as finding F
decided, with the exact value in the details).

## J: options

| Option | What changes | Keyboard | Touch | Screen reader |
|---|---|---|---|---|
| J-a | Each tile becomes focusable (5 more tab stops) and shows its own tooltip (drawn by the popup, `role="tooltip"`, linked with `aria-describedby`) on hover and focus; Escape hides it | yes | tap = focus | the tile is read as "41 classified", then its detail |
| **J-b (recommended)** | A **"Details"** disclosure under the tiles (one tab stop), listing the five details as plain text, one line each; the native tooltips stay for mouse users | yes | yes | plain text |

Why J-b: it is one control, works the same for mouse, keyboard, touch and screen readers, needs no custom tooltip
behaviour (WCAG's "hoverable, dismissible, persistent" rules for tooltips), and keeps the tab order short. The
details list shows exact values (`Estimated cost: $0.0070 from your configured prices`), so K-a's `<$0.01` loses
nothing. J-a would keep the detail next to each tile, at the cost of five tab stops and a custom tooltip component.

Proposed details text (J-b), in the order of the tiles:
```
▸ Details
  Classified: 1,234 posts · 1,300 HTTP requests · avg latency 150 ms
  Cache hits: 999 · 53 entries stored
  Repeats: 218 copied from a similar post · no model call · 41 stored
  Tokens: 198,400 in · 19,880 out
  Estimated cost: $0.0070 from your configured prices
```
(for the bridge: "Plan: through your Claude Code login via the local bridge · no per-token estimate (billed as your
CLI is set up)"; with no prices: "Estimated cost: add $/1M token prices under Model › Advanced").

## Scope

`src/popup/popup.ts` (cost format; the details list built with `textContent`), `public/popup.html` (the disclosure),
`public/popup.css` (its style, reusing the existing `.leftout` disclosure look). Finding F's layout check gains
sub-cent values; finding G's contrast table gains the details text.

## Mockups (step 3)

The real popup with the change injected: today vs after, light and dark, both fonts, with and without a scrollbar,
the details closed and open; checks: layout (no overflow, no cut-off among realistic values including sub-cent),
contrast, axe (all rules), keyboard order and focus, accessibility tree, forced colours, 200 % zoom.

## Correction while writing this design

My first draft recommended K-b with `<$0.001` for costs under a tenth of a cent. Measuring it showed `<$0.001` needs
66 px (more than the `$0.0070` it replaces), so K-b has no good form for the smallest costs. The recommendation is now
K-a, with the exact amount in the details (J-b).

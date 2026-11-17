# Finding G: text contrast below WCAG AA

Status: **implemented** (design and mockups approved; one correction from step 3 below). Plan and results:
`docs/implementation-plan-finding-g.md`. From the bridge mockup audit
(`docs/mockups/bridge/audit/`, R2), widened here to a complete inventory.

## Inventory

Three sources:
1. axe-core on the **built popup** with every section open and realistic data (corrections table, feedback list);
2. axe-core on the **real in-feed bars** (the actual `Presenter`, all 8 states; closed shadow roots forced open for the
   audit only);
3. **every colour pair the stylesheets use**, computed, including states the renders did not show;
4. (added at step 3) an **own text scan** of the renders: every element with text, its colour with inherited opacity
   composited over its real background, against 4.5:1. axe leaves one-character text ("1") as "incomplete", so it
   does not count those.

Threshold: WCAG 2.1 AA, 4.5:1 for normal-size text (all of Signal's text is normal size).

| Where | Pair | Light | Dark |
|---|---|---|---|
| tile labels, unselected segmented options (Review/Active, sensitivities), "copied verdicts" line | `--muted` on `--surface-2` | **4.47** | 5.93 |
| corrections sub-labels ("of 4 kept"), "too few" numbers | `--faint` on `--surface` | **2.61** | **3.56** |
| "too few" numbers in the current-sensitivity row | `--faint` on `--accent-soft` | **2.25** | **2.86** |
| "Keep" pill | `--accent` on `--accent-soft` | **4.23** | 5.92 |
| "Low" pill, error status line | `--danger` on `--danger-soft` | **4.36** | 6.43 |
| in-feed quiet "Low quality" button (Review mode) | `--fg` at `opacity: .55` | **2.21** | **3.36** |
| in-feed quiet note row (Review mode; added in T8) | `--fg` at `opacity: .7` | **2.88** | 4.92 |

Everything else passes in both schemes: 21 other popup pairs, and the in-feed reason text and collapsed bar.

Origins: most pairs predate this work. The "copied verdicts" line (T11), the quiet note row (T8) and the 10.5 px tile
labels (finding F) are mine and inherited the failing pairs.

## Proposed fix

1. **Three light-mode tokens, minimally darkened** (same hue; the smallest lightness change reaching 4.6:1, a small
   margin, against every background each is used on):

   | Token | Now | New | Change | Result |
   |---|---|---|---|---|
   | `--muted` | `#68707a` | `#636b75` | −2.0% lightness | 4.64 on `--accent-soft`, 4.81 on `--surface-2`, 4.99 on `--bg`, 5.40 on white |
   | `--danger` | `#c2413a` | `#bb3f38` | −1.7% | 4.62 on `--danger-soft`, 5.41 on white |
   | `--accent-text` (new; pill text only) | `#2f7d6d` | `#2c7667` | −1.8% | 4.64 on `--accent-soft` |

   Step 3 correction: the first proposal was `#666e78`, sized for `--surface-2` only. Once the "too few" numbers move
   to `--muted`, `--muted` is also used on `--accent-soft` (the current-sensitivity row), where `#666e78` is 4.44:1, a
   fail. axe did not catch it because it reports one-character text such as "1" as "incomplete", not as a violation; an
   own text scan found it. `#636b75` is the smallest change reaching 4.6:1 on all four backgrounds.

   `--accent` itself is unchanged, because it is also the primary button's background and the highlight colour. Only the
   "Keep" pill text uses the new `--accent-text`. Dark mode needs none of these changes.
2. **`--faint` is no longer used for text.** As a text colour it would need darkening by 21%, which would make it
   `--muted`. So:
   - the corrections sub-labels use `--muted`;
   - the "too few to judge" numbers use `--muted` at weight 500 (the other numbers are 600). The meaning is already
     stated in words by the "too few" note and each cell's accessible label ("n of total");
   - `--faint` stays for decoration only: the disclosure chevrons become `--muted` too, so the open/closed indicator
     meets the 3:1 non-text contrast guideline.
3. **In-feed quiet controls without opacity.**
   - The "Low quality" button and the note row in the quiet Review-mode row use plain `--fg`: 5.20:1 light, 9.59:1 dark.
   - They stay quiet through size (11.5 px), medium weight (500, unchanged) and **no border or fill at rest**, instead
     of through opacity.
   - On hover and keyboard focus the button turns `--strong`, gets the `--surface` fill and a `--neutral` border
     (decided at Step 3: `--border` was tried first and is invisible on the light page, 1.15:1; `--neutral` is
     2.07:1 light, 4.58:1 dark). The border is decoration: the label text identifies the button, and keyboard focus
     keeps the existing 2 px `--focus` outline.

### What you notice

The popup looks the same: the token changes are below what the eye can tell apart (`--muted` shifts by a luminance
difference of 0.015). The corrections table's small grey text becomes clearly readable. In the feed's Review mode, the
"Low quality" button and the note row are a little more legible but still understated: text-only until hovered.

## Scope

- `public/popup.css`: tokens, `--accent-text`, the `--faint` text uses, the chevrons.
- `src/content/presenter.ts` (bar CSS): the quiet button and quiet note.
- **Visual change → step 3 mockups:** before and after for the popup (tiles, segmented control, corrections table, pills,
  error line) and for the quiet Review-mode row in the feed, light and dark.

## Not in scope (noted)

Form-field **borders** (`--border` on white, about 1.2:1) are below the 3:1 non-text guideline for component boundaries.
The fields are identified by their visible labels, so this is a common and arguably acceptable pattern. Changing it
would alter the popup's look noticeably. It can be its own finding if you want it.

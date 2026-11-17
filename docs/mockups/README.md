# Mockups: recognising repeated templates (SDLC step 3)

Rendered from the **real** styles: `feed-repeats.html` embeds the presenter's shadow-root CSS, extracted verbatim from
`src/content/presenter.ts`, and `popup-repeats.html` links `public/popup.css`. Only the rules marked
"PROPOSED additions" are new. Yellow dashed outlines in the popup mark new elements (mockup only).

| File | What |
|---|---|
| `feed-repeats-light.png`, `feed-repeats-dark.png` | 8 in-feed states |
| `popup-repeats-light.png`, `popup-repeats-dark.png` | popup: stats tile, setting, corrections line |

## In-feed states

1. **Active · copied collapse, collapsed.** Normal collapsed bar plus a second row:
   `≈ Same template as a post judged earlier · Judge separately`. Hovering the note shows
   "Verdict copied from a post that is 92% similar. No model call was made for this post."
2. **After "Show post".** Stays revealed; the note and action remain.
3. **"Judge separately" in progress.** The action becomes "Judging…"; the copied verdict stays until the answer arrives.
4. **After "Judge separately".** The post's own verdict: no note. A keep leaves the post untouched; a failure also leaves it untouched.
5. **Review · copied "would collapse".** Annotation plus the note row.
6. **Review · copied keep.** The quiet row gets the faint note on the left; the "Low quality" tooltip adds "Same template as a post judged earlier (88% similar)".
7. **Active · expanded to read.** A copied collapse never hides a post you are reading.
8. **Marked post.** Unchanged: no note and no action while your mark stands.

Not shown, because they cannot happen: a copied **highlight** (highlights are never copied), and a note on an
**Active-mode kept** post (kept posts show nothing in Active mode, copied or not).

Accessibility: "Judge separately" is a real `<button>` (keyboard focusable, focus ring, trusted clicks only, like every
bar button). The similarity is also given in the button's `aria-label`: "Judge separately. Verdict copied from a post that
is 92% similar."

## Popup

- **This session:** a 5th tile, **repeats**. Tooltip: "Copied from a similar post · no model call · 97 stored".
- **Model › Advanced:** toggle **Recognise repeated templates** (on by default) with a one-line explanation. Like the
  other Advanced fields, it takes effect on **Save**.
- **Your corrections:** a line under the table, only when some included corrections were on copied verdicts:
  "On verdicts copied from a similar post: **1** wrongly hidden, **0** missed at Balanced (3 corrections)."

## Export row (JSONL) for a correction on a copied verdict

```json
{"id":"9f2c…","source":"user-feedback","label":"keep","text":"🎉 I'm thrilled to announce…","classification":{…},"model":"openai/gpt-4o-mini","prompt_version":"v3","repeat_of":"4be1…","repeat_similarity":0.92}
```

## `npm run eval -- --mode repeats --file eval/repeats.jsonl` (layout only: the numbers are illustrative, not measured)

```
dataset eval/repeats.jsonl: 36 rows (36 synthetic)
signed 34 of 36 rows (2 under 40 words: exact match only)
threshold 0.85 · minimum 40 words · signature v1

matched pairs: 41
  same label:       41
  different label:   0

template families (rows sharing a "family" field):
  announce-new-role    6/6 rows matched together
  hiring-lessons       5/5
  follow-for-more      4/5  missed: rep-019 (2-word name swapped twice, est. 0.81)
hard negatives matched to anything: 0 of 9
```

When pairs with different labels exist, they are listed first: `rep-004 ↔ rep-011  0.91  collapse ≠ keep`, with a
120-character preview of each text.

## As built

`as-built/` holds renders of the **shipped** code, for comparison with the approved mockups above: the 8 feed states
drawn by the real `Presenter` (with `public/content.css`), and the built `dist/popup.html` with a mocked `chrome` API.

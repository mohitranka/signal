# Design: recognising repeated templates (near-duplicates)

Status: **implemented** (branch `feature/repeats`, T1–T12 of `docs/implementation-plan-repeats.md`). Decisions from step 1 are marked "(Q n)". Notes from implementation are in §11.

## 1. Problem

Today a verdict is reused only for *identical* content: the background cache key is
`promptVersion|model|SHA-256(normalised content)`. Template posts ("🎉 Thrilled to announce I've joined {Company} as
{Role}…", "{N} lessons from {N} years…") differ in a name, number or emoji, so each one costs a model call and may get
a different verdict. The goal: recognise these posts locally as repeats of a post already judged, and reuse that
verdict without calling the model.

Non-goals: topic-level repetition ("too many AI posts"), semantic similarity/embeddings, matching short posts,
spreading a user's marks to similar posts.

## 2. Behaviour, in one paragraph

When a post has no exact cache hit, the background computes a **similarity signature** of the post. If the post is
long enough (at least 40 words of its own text) and it closely matches (estimated Jaccard ≥ 0.85) a post **the model
judged** for the same model and prompt version, it **copies** that verdict instead of calling the model, unless the
similar posts include a highlight verdict, or their verdicts disagree. In both of those cases it asks the model. If a
similar post is still waiting for the model, it waits for that answer. The post is shown like any other verdict, with a
short note ("Same template as a post judged earlier") and a **Judge separately** action. Matching never changes a post
you marked, revealed or are reading, and never replaces a verdict the model gave that post itself.

## 3. Signature (Q5–Q8)

New pure module `src/shared/similarity.ts`, browser- and Node-safe (so `eval/` can use it too):

1. **Cleanup:** NFKC, lowercase. Emoji, skin-tone modifiers, ZWJ sequences and variation selectors are removed.
   Every run of digits (including `.,:%` inside it, such as `3.5`, `10,000`, `90%`) becomes one token `0`. URLs
   become `url`. Words are runs of letters/digits (`\p{L}\p{N}`), so `#hashtags` keep their word and lose the `#`.
2. **Shingles:** consecutive 3-word shingles of the post text. Quoted text and link title/description each get their
   own shingles with a field prefix (`q:`, `l:`). This means the same commentary over a *different* article does not
   match.
3. **Minimum length (Q7, Q8):** the post's **own text** must have **≥ 40 words** after cleanup. Otherwise the post
   gets no signature and only exact matches count (today's behaviour). A bare reshare with no text of its own is
   therefore exact-only.
4. **MinHash:** 128 values per post (*superseded by finding C: 256 values of 16 bits, same 512 bytes; see
   `design-finding-c-estimate-noise.md`*). Each shingle is hashed once (FNV-1a 32-bit), then mixed with 128 fixed seeds
   (murmur3 `fmix32`), keeping the minimum per seed. Estimated similarity = the fraction of equal positions.
   Signature size: 512 bytes, stored as base64 (~684 chars).
5. `SIGNATURE_VERSION = 1` is part of the storage key. Changing any rule above bumps it, and old signatures are
   dropped, never compared.

### What this catches (prototype, 400 random trials each, threshold 0.85)

| Post length (words) | Numbers/emoji swapped | 1-word name swapped | 2-word name swapped |
|---|---|---|---|
| 40 | always (removed by cleanup) | 64% | 17% |
| 50 | always | 88% | 55% |
| 60 | always | 98% | 81% |
| 80+ | always | 100% | 97–100% |

Different posts sharing a 20-word opening: **0 false matches in 400** (highest estimate 0.44 at 40 words).

This is conservative, as the design rule requires: near the 40-word minimum, swapped names often fall back to the
model (a missed repeat costs one call, not a wrong verdict). Signature cost ≈ 0.14 ms per 80-word post. Scanning 2,000
stored signatures ≈ 0.9 ms, so a plain linear scan is enough and no LSH index is needed.

## 4. Matching rules (Q1–Q3, Q6, Q9)

- **Only verdicts the model actually gave can be copied (Q1, Q2).** Only results of real model calls are added to
  the index. Copied verdicts are never added, so matches cannot chain (A≈B, B≈C does not make C copy A). User marks
  are never copied from.
- **Candidates:** every stored signature for the *current* `promptVersion|model` with estimated similarity ≥ **0.85**.
- **Copy only when unambiguous (Q9):**
  - No candidates: ask the model.
  - Any candidate's verdict is `highlight`: ask the model (evidence posts hinge on the numbers cleanup erases).
  - Candidates disagree (`keep` vs `collapse`): ask the model.
  - Otherwise copy the **most similar** candidate's classification (ties: most recently used).
- **What is copied:** the raw model classification (decision, confidence, reason, signals). The feed's own `decide()`
  still applies thresholds, vetoes and sensitivity, exactly as for a fresh verdict.
- **Similar post still waiting (Q3):** while a model request is in flight, its signature is kept in a "pending" list.
  A new post matching a pending one waits for that request. If the answer is collapse or keep, the new post copies
  it. If the answer is highlight, or the request fails or is cancelled, the new post makes its own call. Cancelling
  the waiting post (text grew, tab closed) ends only its own wait and never cancels the other post's request.
- **Exact cache first.** An exact hit is always preferred. Copied verdicts are **not** written to the exact cache, so
  they never look like model verdicts later.

## 5. Storage (Q4)

New `RepeatIndex` in `src/background/repeatIndex.ts`, persisted in `chrome.storage.local` under
`repeats:v1` with the same debounced-flush pattern as `CacheStore`.

- Entry: `cacheKey → { s: base64 signature, t: last used }`. **No post text and no classification.** The verdict is
  read from the exact cache through the same key, so there is one source of truth. If that cache entry has been
  evicted, the index entry is dropped.
- Capped at 2,000 entries (same as the cache), evicting least recently used. Worst case ≈ 1.5 MB of the 10 MB
  `storage.local` quota.
- **Clear cache** also clears the index. Changing model or prompt version starts fresh (the key prefix filters them).
- Signatures are computed **only in the background**, from the input it has already re-validated. A content script
  never supplies a signature.

## 6. Protecting what the user did (Q10)

| Case | Rule | Where it already holds / what changes |
|---|---|---|
| (i) Post you **marked** | Your mark governs; matching never runs for it and never changes it. Marks are **not** spread to similar posts. | Holds today (`process()` skips classify when marked). Add tests. |
| (ii) Post you **revealed** | Stays revealed whatever verdict arrives later (copied or fresh). | `revealed` is not reset by re-judging. Add tests. |
| (iii) Post showing **its own model verdict** | Never replaced by a copied one. When its text grows ("…more"), the re-judge asks the model (`noRepeat`). | **New:** controller sends `noRepeat: true` when re-judging a post whose current verdict was not copied. Costs at most the existing 3 re-judges per post. |
| (iv) Post you **expanded to read** | A copied collapse never hides it (same as a fresh collapse). | Copied verdicts are `source: 'model'`, so the existing `keepVisible` rule applies. Add tests. |

Also: a copied verdict never changes any *other* post on the page. Only posts with the identical fingerprint share it,
as today.

## 7. User-facing changes (Q11–Q13), detailed in the mockups (step 3)

- **Note:** wherever a model verdict is shown (collapsed bar, Review annotation, quiet "Low quality" tooltip, highlight
  title), a copied verdict adds "Same template as a post judged earlier" (plus the similarity as a percentage in the
  tooltip).
- **Judge separately:** shown on posts with a copied verdict. It sends `classify` with `noRepeat: true`: one model
  call, and the result becomes this post's own verdict (and a new anchor). It keeps revealed / being-read state. If
  it fails, the post is left as LinkedIn drew it (as for any failure). It needs a trusted click and is available once
  per post (the new verdict is not copied, so the button disappears).
- **Popup → Advanced:** "Recognise repeated templates" checkbox, **on** by default (`Settings.repeats`). When off, no
  copying happens; model results are still indexed (cheap), so turning it back on works immediately.
- **Popup → This session:** new tile **Repeats recognised** (`Stats.repeatHits`), counted separately from exact cache
  hits.

## 8. Feedback, export, eval (Q14)

- `ClassifyResult` (ok) and `ClassificationRecord` gain an optional `repeatOf: { fp: string; similarity: number }` (the
  anchor's content fingerprint, a hash, and the estimate). `parseRecord()` validates it (`FP_PATTERN`, 0.85–1) and
  drops it if malformed. Older records without it stay valid.
- A correction on a copied verdict stores the record with `repeatOf`. Export adds `repeat_of` and `repeat_similarity`
  to those rows only. Older readers ignore unknown fields, and `loadDataset` validates the new ones.
- **Your corrections** (popup) and `eval --mode stored`: one extra line that counts corrections on copied verdicts
  separately ("Copied from a similar post: n wrongly hidden, m missed at <current sensitivity>").
- **`npm run eval -- --mode repeats [--split|--file]`**: offline, no API. Signs every row and lists matched pairs
  (≥ threshold), highlighting pairs whose labels differ. New `eval/repeats.jsonl`: template families (same template,
  swapped names/numbers/emoji, ≥ 40 words) plus hard negatives (shared opener or boilerplate, different substance).
  Tests assert every family matches internally and nothing matches across families.

## 9. Changes by file

| File | Change |
|---|---|
| `src/shared/similarity.ts` (new) | cleanup, shingles, MinHash, similarity, encode/decode, constants |
| `src/background/repeatIndex.ts` (new) | persisted index: add, findCandidates, touch, remove, clear, flush, cap |
| `src/background/classifyService.ts` | exact → repeat → pending-join → model; index anchors; `repeatHits` |
| `src/background/handlers.ts` | pass `noRepeat`; `clearCache` clears the index |
| `src/background/service-worker.ts` | wire `RepeatIndex`; flush on suspend |
| `src/shared/types.ts`, `settings.ts` | `repeatOf`, `noRepeat`, `Settings.repeats`, `Stats.repeatHits` |
| `src/classifier/parse.ts` | validate `repeatOf` in `parseRecord` |
| `src/content/controller.ts` | carry `repeatOf`; Judge separately; `noRepeat` on growth re-judge (iii) |
| `src/content/presenter.ts` | note + Judge separately button |
| `src/popup/*`, `public/popup.html` | setting, stats tile, corrections line, export fields |
| `src/corrections.ts`, `eval/*` | copied-verdict breakdown, `--mode repeats`, `eval/repeats.jsonl` |
| `README.md`, `docs/architecture-decision.md` | document behaviour, limits, storage |

## 10. Risks and trade-offs

| Risk | Mitigation |
|---|---|
| A copied verdict is wrong for this post (the swapped detail mattered) | Conservative threshold; highlight never copied; disagreement → model; policy still applies; note + Judge separately; Review mode first. |
| Digit cleanup makes "cut latency 180→95 ms" look like "180→170 ms" | Those are highlight/keep substance posts: highlight is never copied, and keep copied onto keep is harmless. |
| Low recall near 40 words | Accepted (design rule). `--mode repeats` gives data to revisit 0.85 or 40 later; both are constants. |
| Storage growth | Capped at 2,000 entries / ~1.5 MB; cleared with the cache. |
| Signature poisoning: a page crafts posts to match a popular template and steal its verdict | It only affects how *that crafted post* is shown (what an author can already influence through wording). A planted verdict cannot spread, because copies are never anchors. Reviewed again in step 8. |
| Service worker killed before flush | Same as cache: a few recent anchors lost; those posts cost a call next time. |

## 11. Notes from implementation

- **Two similar posts arriving together must not wait for each other.** Each in-flight request gets a sequence
  number; a request only waits for an *earlier* one that is calling the model itself (not one that is itself waiting,
  and not an exact duplicate, which the queue already merges). No cycles are possible.
- **Waiting is registered before any further await**, so a similar post arriving a moment later finds the first one.
  If the awaited request ends without a usable verdict (failed, cancelled, highlight), the waiting post looks for a
  judged match once more and otherwise asks the model.
- **`clear()` during the index's first load** could have resurrected cleared entries; fixed (load only fills an empty
  index) with a regression test.
- **Corrections report shape:** per-sensitivity `copiedWronglyHidden` / `copiedMissed` are present only when some
  correction was on a copied verdict, so rows keep their previous shape otherwise.
- **Measured (fixture set, 40 rows):** 47 matched pairs, 0 with different labels; all 7 families matched; 0 of 8 hard
  negatives matched. Lowest in-family estimate 0.875 (one role word swapped in 92 words; true Jaccard ≈ 0.935):
  MinHash noise is real, as the recall table in §3 says. Existing eval splits: 17/60 (dev) and 13/60 (test) posts are
  long enough to be signed; none are repeats of each other.

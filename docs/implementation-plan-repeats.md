# Implementation plan: recognising repeated templates

Status: **proposed (SDLC step 4)**, awaiting approval.
Inputs: `docs/design-repeats.md` (approved) and `docs/mockups/` (approved as shown, including the defaults for the 4 open
points: note as a second row; note + Judge separately on Review-mode copied keeps; switch in Model › Advanced, applied
on Save; a failed Judge separately leaves the post untouched).

## Working agreement (TDD, per task)

1. Write the task's tests first. Run them and **confirm they fail for the intended reason** (missing module/field,
   wrong behaviour), not for a typo. The failing run is recorded in the task summary.
2. Implement the smallest change that makes them pass.
3. Run the **full** suite (`npm test`), `npm run typecheck` and `npm run build`. Nothing that passed before may fail.
   Baseline: 301 tests passing, typecheck clean.
4. One git commit per task (`repeats: T<n> <title>`), and a short report to you (tests added, red → green, anything learned).
5. Anything unexpected is raised with you (SDLC step 7) before changing design or scope.

Environment note: `npm ci` fails because the lockfile pins `ws-8.23.0`, which returns 404 from the registry.
Dependencies are installed with `npm install --no-package-lock --no-save`. **The lockfile is not modified.** (Worth
fixing separately.)

## Constants (one place: `src/shared/similarity.ts`)

| Name | Value |
|---|---|
| `REPEAT_THRESHOLD` | 0.85 (estimated Jaccard) |
| `REPEAT_MIN_WORDS` | 40 words of the post's own text, after cleanup |
| `SIGNATURE_HASHES` | 128 |
| `SHINGLE_WORDS` | 3 |
| `SIGNATURE_VERSION` | 1 (storage key `repeats:v1`) |
| Index cap | 2,000 entries (same as the cache) |

## Task overview and order

| # | Task | Depends on | New/changed test files |
|---|---|---|---|
| T1 | Similarity signature (pure) | – | `tests/similarity.test.ts` (new) |
| T2 | Template fixture set + quality gate | T1 | `eval/repeats.jsonl` (new), `tests/repeats-fixture.test.ts` (new) |
| T3 | Types, setting, record validation | – | `tests/background.test.ts`, `tests/feedback-record.test.ts` |
| T4 | `RepeatIndex` store | T1, T3 | `tests/repeat-index.test.ts` (new) |
| T5 | Background matching (judged posts) | T4 | `tests/repeats-service.test.ts` (new) |
| T6 | Background matching (posts still waiting) + cancel | T5 | `tests/repeats-service.test.ts` |
| T7 | Handlers + service-worker wiring | T5, T6 | `tests/background.test.ts`, `tests/security.test.ts`, `tests/entrypoints.test.ts` |
| T8 | Presenter: note row, Judge separately | T3 | `tests/presenter.test.ts` |
| T9 | Controller: copied records, Judge separately, growth rule, protections | T3, T8 | `tests/repeats-controller.test.ts` (new) |
| T10 | Corrections breakdown + eval (`stored`, `repeats`) + dataset fields | T1, T2, T3 | `tests/corrections.test.ts`, `tests/eval-stored.test.ts`, `tests/eval-repeats.test.ts` (new) |
| T11 | Popup: switch, tile, corrections line, export fields | T3, T7, T10 | `tests/popup.test.ts` |
| T12 | Bundle boundaries + docs | all | `tests/bundle.test.ts`; README, architecture doc |

---

## T1. Similarity signature: `src/shared/similarity.ts` (new, pure, browser + Node)

**API**
```ts
export function words(s: string): string[];                       // cleanup + tokenise
export function signature(input: PostInput): Uint32Array | null;  // null when own text < 40 words
export function similarity(a: Uint32Array, b: Uint32Array): number; // fraction of equal positions; 0 if lengths differ
export function encodeSignature(sig: Uint32Array): string;         // base64 of the 512 bytes
export function decodeSignature(s: unknown): Uint32Array | null;   // null unless exactly 128 values
```

**Tests first (`tests/similarity.test.ts`)**. They fail before because the module does not exist.
- Cleanup: emoji (incl. ZWJ sequences, skin tones, variation selectors) removed; `3.5`, `10,000`, `90%`, `2027` each
  become one `0`; URLs become `url`; NFKC (full-width letters → ASCII); case folded; `#hashtag` becomes `hashtag`.
- Minimum length: 39 own words → `null`; 40 → signature. Long quoted text with short own text → `null`. Empty text → `null`.
- Deterministic: the same input always gives the same 128 values, and separate calls agree.
- Identical → 1. Only numbers and/or emoji changed → 1. One-word name swapped in an 80-word post → ≥ 0.85.
- Same 20-word opening, different rest (80 words) → < 0.85. Same text, **different quoted post** → < 0.85 (fields are
  separated).
- `encode`/`decode` round-trip. `decode` of junk (wrong length, non-string, bad base64) → `null`.
- `similarity` of signatures with different lengths → 0.

**Done when** all pass; the module imports nothing from `node:`.

## T2. Template fixture set and quality gate

- `eval/repeats.jsonl`: about 36 synthetic rows (dataset format + an optional `family` field).
  - 6 template families (announcement, "N lessons", follow-for-more, hiring, "agree?" bait, humble-brag), each with
    4–6 variants differing by names, numbers, emoji.
  - About 9 **hard negatives**: same opening or closing boilerplate with different substance; same commentary over
    different quoted posts; an evidence post with different numbers but the same wording (this one *does* match, on
    purpose, and its label is keep/highlight, documenting the "highlight is never copied" rule).
  - 2 rows under 40 words.
  - All labels set so `--mode stored`/`llm` stay usable.
- **Tests first (`tests/repeats-fixture.test.ts`):** within each family every pair ≥ threshold; no pair across families
  or with a hard negative ≥ threshold (except the documented numbers-only case); the short rows get no signature; the
  file passes `loadDataset`. They fail before because the file does not exist.

**Done when** the gate passes. This guards against future changes to the cleanup or threshold.

## T3. Types, setting, record validation

- `types.ts`:
  - `Settings.repeats: boolean`;
  - `Stats.repeatHits: number`;
  - `RepeatOf = { fp: string; similarity: number }`;
  - optional `repeatOf` on `ClassificationRecord` and on the ok `ClassifyResult`;
  - `classify` message gains `noRepeat?: boolean`.
- `settings.ts`: default `repeats: true`; `normalizeSettings` keeps a boolean, otherwise the default.
- `store.ts`: `emptyStats()` includes `repeatHits: 0`. Stored stats without it still load (spread over the defaults).
- `parse.ts` `parseRecord`: keeps `repeatOf` only if `fp` matches `FP_PATTERN` and `similarity` is a finite number in
  [0.85, 1]. A malformed `repeatOf` is dropped and the record is kept.
- Test fixtures that build `PublicSettings` get the new field (tsconfig type-checks `tests/`).

**Tests first:**
- Settings default is `true`; garbage → `true`; `false` is kept.
- `emptyStats().repeatHits === 0`; an old stored stats object gains `repeatHits: 0`.
- `parseRecord` keeps a valid `repeatOf`, drops one with a bad fp / similarity 0.5 / 1.2 / NaN / string, and still
  returns the record.
- `FeedbackStore.set` with a `classified.repeatOf` stores it, and a malformed one is stripped.

## T4. `RepeatIndex`: `src/background/repeatIndex.ts` (new)

```ts
class RepeatIndex {
  constructor(kv: KV, opts?: { maxEntries?: number; persistDelayMs?: number });
  add(key: string, sig: Uint32Array): Promise<void>;
  /** Entries in the same scope (promptVersion|model) at or above the threshold, best first (ties: most recent). */
  candidates(scope: string, sig: Uint32Array, threshold?: number): Promise<{ key: string; fp: string; similarity: number }[]>;
  touch(key: string): Promise<void>;
  remove(key: string): Promise<void>;
  clear(): Promise<void>;
  size(): Promise<number>;
  flush(): Promise<void>;
}
```
- Stored under `repeats:v1` as `{ [cacheKey]: { s: base64, t: number } }`. Loaded once; decoded into memory;
  persisted with the same debounce as `CacheStore`.
- **Scope is compared exactly** as "everything before the last `|`". A plain prefix test would let a model named
  `acme|large` match `acme` (verified: `"v3|acme|large|<fp>".startsWith("v3|acme|")` is `true`).

**Tests first (`tests/repeat-index.test.ts`, with `memoryKV`):**
- An added signature is found by a near variant, not by a distant post.
- Other model, other prompt version, and the `acme` vs `acme|large` case are all excluded.
- Order: by similarity, then most recent. The returned `fp` is the last key segment.
- The cap evicts least-recently used (`maxEntries: 3`), and `touch` protects an entry.
- Persistence: only one write during bursts; a new instance on the same KV finds entries.
- Corrupt stored data is skipped per entry: non-object, bad base64, wrong length, non-numeric `t`.
- `clear` empties memory and storage.
- **Stored data contains no post words:** serialise storage and assert none of the post's words appear.

## T5. Background matching against posts already judged (`classifyService.ts`)

`ServiceDeps.repeats?: RepeatIndex` (optional, so existing tests are unchanged). `classify(fp, input, waiter, opts?: { noRepeat?: boolean })`.

Order: config check → **exact cache** → (if `settings.repeats && !noRepeat && signature`) **repeat lookup** → model
call → on success `cache.set` **and** `repeats.add(key, sig)`.

The repeat lookup reads each candidate's classification from the cache; an evicted one is `remove`d from the index. If
any candidate is highlight, or candidates disagree → no copy. Otherwise copy the best: stats `repeatHits +1`, `touch`
the anchor, return
`{ ok, classification, cached: true, model, promptVersion, repeatOf: { fp, similarity (2 decimals) } }`.

**Tests first (`tests/repeats-service.test.ts`, fetch mocked with `chatResponse`, `memoryKV`):**
1. Template A then variant B → **1 HTTP request**. B is ok with `repeatOf.fp === fp(A)`, and `stats.repeatHits === 1`.
2. Variants under 40 words → 2 requests (exact match only).
3. The anchor's verdict is highlight → B asks the model.
4. Two anchors that disagree (keep vs collapse) → B asks the model.
5. **No chains:** A; B copies A; C is near B but not A → C asks the model.
6. `settings.repeats = false` → B asks the model, **and** A is still indexed (after turning it on, C copies).
7. `noRepeat: true` → asks the model; the result becomes an anchor.
8. Different model → no copy.
9. Anchor's cache entry evicted / `cache.clear()` → B asks the model, and the index entry is removed.
10. Exact repeat of A → `cacheHits`, not `repeatHits`, and no `repeatOf`.
11. The copied verdict is **not** in the exact cache (cache size unchanged after B).
12. A failed model call adds no anchor.

## T6. Joining a similar request that is still waiting, and cancel

- The service keeps `pending: Map<key, { scope, sig, settled: Promise<Classification | null> }>` while a model
  request runs.
- With no judged match, B looks for a pending match (≥ threshold, same scope, best first) and awaits `settled` under its
  own abort controller, registered as `joins[key][waiter]`.
  - Result collapse/keep → copy (as in T5, `repeatOf` = the pending post's fp).
  - Highlight / failure / abort → continue to its own model call.
- `cancel(fp, waiter)` first ends that waiter's join (if any) → `{ ok: false, kind: 'aborted' }`. It never touches the
  anchor's request. Otherwise the existing behaviour applies. `cancelAll` aborts all joins.

**Tests first:**
1. A and B sent together → **1 HTTP request**; B gets `repeatOf`.
2. A pending, its answer is highlight → B makes its own request (2 total).
3. A pending, it fails (500 with `maxRetries: 0`) → B makes its own request.
4. B cancelled while joined → B `aborted`; A still completes for its own waiter; 1 request.
5. Another sender cancels B's fp → B not affected (per-sender, as today).
6. A's only waiter cancels A → B stops waiting and makes its own request.
7. `cancelAll` → A and B both `aborted`.
8. Three variants at once → 1 request, 2 copies.

## T7. Handlers and service-worker wiring

- `handlers.ts`:
  - `classify` passes `noRepeat` **only if `msg.noRepeat === true`**;
  - `clearCache` also clears the index;
  - `getStats` adds `repeatIndexSize`.
- `service-worker.ts`: create `RepeatIndex(local)`, pass it to the service and handlers, flush on `onSuspend`.
- **Tests first:**
  - handler forwards `noRepeat: true`, and ignores `'true'`/`1`;
  - `clearCache` empties the index;
  - `getStats` reports its size;
  - security: a content sender can set `noRepeat` (it can only cause a model call, as today) but cannot clear the index;
  - entrypoint: the service worker wires the index and flushes it on suspend.

## T8. Presenter: note row and Judge separately (`presenter.ts`)

- `View.repeat?: { similarity: number; judging: boolean }`; `Actions.judgeSeparately()`.
- For **model-source** bars (collapsed, revealed, expanded, review annotation, quiet review keep) with `view.repeat`:
  the bar gets class `has-note` and a `.note` span "Same template as a post judged earlier · " with a
  `<button class="link">Judge separately</button>`. While judging, it shows the text "Judging…" instead of the button.
  - Note `title`: "Verdict copied from a post that is N% similar. No model call was made for this post."
  - Button `aria-label`: "Judge separately. Verdict copied from a post that is N% similar."
  - The quiet "Low quality" tooltip gets " · Same template as a post judged earlier (N% similar)".
- User-source (marked) bars never show the note.
- CSS exactly as in the approved mockup (`.bar.has-note`, `.bar.has-note .reason { flex: 1 1 0 }`, `.bar .note…`).

**Tests first (`tests/presenter.test.ts`):**
- Each of the 5 model bar kinds shows the note when `repeat` is set and none when it is not.
- A marked view with `repeat` → no note.
- Judging → no button, shows "Judging…".
- Title and `aria-label` carry the percentage.
- An untrusted click on Judge separately does nothing; a trusted one calls the action.
- Text is set with `textContent` (no HTML from the reason).
- The quiet tooltip includes the copy text.

## T9. Controller (`controller.ts`)

- The record from a result keeps `repeatOf`. `viewFor` passes `repeat` (plus `judging` from `PostState.judging`).
- **Judge separately** (`judgeSeparately(el)`): only if the post shows a copied model verdict, is not marked, and is not
  already judging. It sets `judging`, renders, and sends `classify` with `noRepeat: true`; the page's in-flight map is
  keyed `own:<fp>`, so it never joins a normal request or reuses the page-level `classified` entry.
  - On success: the record becomes the post's own. Identical-text posts showing the same copied verdict get it too
    (their revealed/reading flags are kept).
  - On failure: the record is dropped (post untouched), `judging` is cleared.
  - Revealed / `keepVisible` are never reset.
- **Growth rule (iii):** `checkGrowth` sends `noRepeat: true` when the post's current record is its own (no
  `repeatOf`); if the current record is copied or absent, matching is allowed.
- Feedback on a copied post sends `classified` including `repeatOf`.

**Tests first (`tests/repeats-controller.test.ts`, same fake-background harness as `controller.test.ts`):**
1. A copied result renders the note (Active collapsed, Review annotation, Review quiet keep); nothing in Active keep.
2. Judge separately sends `{ type:'classify', noRepeat:true }` once; "Judging…" while waiting; afterwards the own verdict
   has no note; a second click is impossible (button gone).
3. Judge separately when the page already knows a verdict for that fp → still sends (page-level reuse bypassed).
4. Judge separately keeps a revealed post revealed, even if the new verdict is collapse (protection ii).
5. Judge separately fails → post untouched (no bar, no hidden attribute).
6. Identical-text twin showing the same copied verdict → updated too; a twin with its *own* verdict → untouched.
7. Growth: own verdict → re-judge message has `noRepeat: true`; copied verdict → no `noRepeat` (protection iii).
8. Marked post: never sends `classify`; no note even if a copied record is known (protection i).
9. Expanded-to-read post + copied collapse → not hidden, "Signal would collapse this" + note (protection iv).
10. Marking a copied post sends `classified.repeatOf`, and does **not** change its similar (non-identical) neighbours
    (marks are not spread).

## T10. Corrections breakdown, dataset fields, eval modes

- `scoring.ts` `Row`: optional `family`, `repeat_of`, `repeat_similarity`. `loadDataset` validates them (fp pattern;
  0.85–1; string family) and rejects bad values with a line number.
- `corrections.ts`:
  - `CorrectionInput`/`Prediction` carry `copied: boolean` (from a valid `record.repeatOf`);
  - `correctionReport` adds `copiedTotal` and per-row `copiedWronglyHidden` / `copiedMissed`;
  - `rowsToInputs` and `feedbackToInputs` map the new fields.
- `eval/run.ts`:
  - `--mode stored` prints "copied from a similar post: n wrongly hidden, m missed" per sensitivity when `copiedTotal > 0`;
  - new `--mode repeats` (offline) prints the report shown in the mockup. The logic lives in a pure, testable
    `eval/repeats.ts` `repeatReport(rows)`.

**Tests first:**
- report counts copied corrections separately, and totals are unchanged;
- `loadDataset` rejects a bad `repeat_of` / `repeat_similarity`;
- `rowsToInputs` round-trips `repeatOf`;
- `repeatReport` on a small inline dataset (pairs, different-label pairs listed first, family coverage with misses,
  negatives, unsigned count);
- CLI `--mode repeats` on `eval/repeats.jsonl` exits 0 and prints "different label: 0" (same approach as
  `eval-stored.test.ts`).

## T11. Popup (`popup.html`, `popup.css`, `popup.ts`)

- Model › Advanced: `#repeats` switch + help line, loaded from settings, included in the `saveLlm` patch.
- This session: `#stRepeats` tile (5-column grid); tooltip "Copied from a similar post · no model call · N stored".
- Your corrections: `#corrCopied` line, hidden unless `copiedTotal > 0`, for the current sensitivity.
- Export: `repeat_of` / `repeat_similarity` on rows whose record has `repeatOf`.

**Tests first (`tests/popup.test.ts`, existing `setup()` harness):**
- The switch reflects settings; toggling + Save sends `repeats:false` in the patch; toggling without Save sends nothing.
- The tile shows `repeatHits`, and the tooltip includes the stored count.
- The corrections line appears only with copied corrections, with the right numbers for the current sensitivity.
- The exported JSONL row has the two fields only for copied records.

## T12. Bundle boundaries and docs

- `tests/bundle.test.ts`:
  - the **content** bundle does not contain the signature code (signatures are computed only in the background);
  - the popup bundle does not either;
  - the service-worker bundle contains it exactly once.
- README:
  - Using it, plus a new "Repeated templates" paragraph (what, limits, the 40-word minimum, the recall table, storage,
    the switch);
  - Permissions/privacy (hashes only);
  - Status (test count).
- `docs/architecture-decision.md`: the component list (4. Caching), §5 "Repetition" line, risks table.
- `docs/design-repeats.md`: status → implemented, plus anything learned on the way.

---

## Definition of done (whole feature)

- All tasks green; full suite, typecheck and build pass; no existing test changed except for typing the new required
  setting field and the 5-tile grid.
- `npm run eval -- --mode repeats --file eval/repeats.jsonl` reports 0 different-label pairs.
- Mockup states reproducible from real code: I will re-render the 8 feed states using the real `Presenter` to compare
  with the approved mockups.
- Nothing in the index, stats or messages carries post text.

## Out of scope (for later, if you want it)

- Tuning 0.85 / 40 words on real feed data.
- LSH banding (a linear scan is about 1 ms at 2,000 entries).
- Spreading marks to similar posts.
- Fixing the lockfile's `ws` 404.

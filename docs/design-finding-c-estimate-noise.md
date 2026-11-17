# Finding C: similarity estimates near the threshold are noisy

Status: **implemented** (option 1: 256 × 16-bit signatures, `SIGNATURE_VERSION = 2`, index `repeats:v2`).

## What was observed

In the fixture set, `rep-hire-1` and `rep-hire-2` (one role word swapped in 92 words) have an **exact** similarity of
0.935 (computed from their 3-word chunk sets), but the signature estimated **0.875**. The match still held, but with
less margin than the design implied.

## Investigation

**1. Is the estimator broken?** No. 20,000 synthetic pairs with known exact similarity (40–160 words, 0–7 swapped
words):

| exact J | pairs | mean error | SD of error | theory SD (128 independent hashes) | ratio |
|---|---|---|---|---|---|
| 0.75 | 828 | −0.0007 | 0.0377 | 0.0383 | 0.99 |
| 0.80 | 1,635 | +0.0018 | 0.0347 | 0.0354 | 0.98 |
| 0.85 | 3,081 | −0.0007 | 0.0306 | 0.0316 | 0.97 |
| 0.90 | 5,235 | +0.0001 | 0.0263 | 0.0265 | 0.99 |
| 0.95 | 4,984 | +0.0003 | 0.0191 | 0.0193 | 0.99 |

Unbiased, and exactly as noisy as 128 independent samples should be. The hashing is fine. −0.06 at J = 0.935 is a
2.75σ reading: rare, but expected somewhere among ~50 pairs.

**2. What the noise means for decisions.** The probability that a pair is treated as the same template (estimate ≥ 0.85),
by its exact similarity:

| exact J | today: 128 hashes | 256 hashes × 16 bit (same storage) | 128 hashes, threshold 0.88 |
|---|---|---|---|
| 0.78 | 2.8% | 0.3% | 0.2% |
| **0.80** | **8.5%** | **2.1%** | 1.0% |
| 0.82 | 21.0% | 10.7% | 3.6% |
| 0.85 | 54.1% | 51.5% | 18.1% |
| 0.88 | 86.9% | 92.9% | 52.9% |
| **0.90** | **97.0%** | **99.5%** | 79.1% |
| 0.92 | 99.7% | 99.99% | 95.0% |

Read as:
- **Wrong-side copies.** Today a pair *below* the threshold (exact 0.80) is copied 8.5% of the time. For a 100-word post,
  exact 0.80 means roughly 4–5 words differ (two names and a short phrase), so these are usually still the same template.
  The risk is the occasional pair where those few words change the verdict. Highlights are never copied, which already
  removes the most sensitive case.
- **Misses.** Today a clear repeat (exact 0.90) is missed 3% of the time: one extra model call each, no harm.

## Options

### 1. 256 hashes stored as 16 bits each (recommended)

- Same storage as today: 256 × 2 bytes = 512 bytes per post (still 684 base64 characters), 2,000 entries ≈ 1.4 MB.
- Halves the variance, so **both** error sides improve: wrong-side copies at 0.80 go from 8.5% to 2.1% (0.78: 2.8% → 0.3%),
  and misses at 0.90 from 3% to 0.5%.
- Keeping the low 16 bits of each minimum adds a chance collision of 1/65,536 per position. That raises the estimate by
  at most (1 − J)/65,536 ≈ 0.000005: negligible and documented, not corrected.
- Costs:
  - Signing and comparing take about twice as long as today (measured at 0.14 ms per post and 0.9 ms per 2,000-entry
    scan). To be re-measured in step 6; still far below a frame.
  - Because this changes what a signature means, `SIGNATURE_VERSION` becomes 2: stored signatures are dropped and the
    storage key becomes `repeats:v2`. Anchors are learned again as posts are judged, so the first variant of each known
    template costs one model call once. The old `repeats:v1` key (up to ~1.4 MB) is **deleted** on first load, so it
    does not linger in the quota.

### 2. Keep 128 hashes, raise the threshold to 0.88

Fewer wrong-side copies (1.0% at 0.80), but clear repeats are missed much more often (21% at 0.90; 47% at 0.88). This
undoes a good part of the feature's benefit, and choosing the number properly needs real feed data (out of scope).

### 3. Accept and document

State the match probability curve in the README and design, and change nothing. Defensible: wrong-side copies are
mostly the same template, highlights are excluded, and "Judge separately" exists. It leaves the 8.5% on the table,
though, when option 1 removes most of it for free in storage.

## Scope (option 1)

- `src/shared/similarity.ts`: 256 hashes; signature values truncated to 16 bits (`Uint16Array`); encode/decode for
  512 bytes of uint16 (little-endian); `SIGNATURE_VERSION = 2`.
- `src/background/repeatIndex.ts`: key `repeats:v2` (derived from the version, as today); on first load, remove the
  `repeats:v1` key if present.
- Tests: the constants (256, version 2), the type (`Uint16Array`), and the index's old-key clean-up. Existing behaviour
  tests (matching, fixture check, service) must pass unchanged.
- Docs: README, and the design's recall table, re-measured with the new signature.
- **No UI change: step 3 (mockups) skipped, if you agree.**

## Risks

- One-time loss of learned anchors on update: costs at most one model call per template seen again. Acceptable.
- If real feeds show a different trade-off, the threshold stays a single constant. Tuning it remains out of scope.

## Result (step 6)

Measured old (v1, 128 × 32-bit) against new (v2, 256 × 16-bit) on identical inputs:

| | v1 | v2 |
|---|---|---|
| signing, 80-word post | 0.10 ms | 0.18 ms |
| scan of 2,000 stored signatures | 1.01 ms | 1.18 ms |
| fixture set: lowest in-family estimate | 0.875 | **0.898** |
| fixture set: highest cross-family / hard-negative estimate | 0.313 | 0.316 |
| test pairs just below the threshold (exact 0.79–0.81) matched | 95 / 1000 | 24 expected, asserted ≤ 50 |
| test pairs clearly above (exact 0.89–0.91) matched | 957 / 1000 | 992 expected, asserted ≥ 985 |

Name-swap match rates (600 trials each):

| post length | 1-word swap v1 → v2 | 2-word swap v1 → v2 |
|---|---|---|
| 40 words | 62% → 61% | 18% → **8%** |
| 50 words | 89% → **95%** | 53% → 49% |
| 60 words | 99% → 100% | 80% → 82% |
| 80 words | 100% → 100% | 98% → **100%** |

Match rates rise where the exact similarity is above 0.85 and fall where it is below. A 2-word swap in a 40-word post
has exact similarity ≈ 0.81 (below the threshold), so its drop from 18% to 8% is the intended removal of copies made by
chance, not lost recall.

Notes from implementation:
- Minimums are taken over the full 32 bits and truncated afterwards (truncating first would change which chunk wins).
- A `Signature` type alias now names the representation in one place.
- Three earlier feature tests pinned the literal signature version (`version: 1`, `signature v1`, `'repeats:v1'`) and were
  updated to version 2. The plan listed the constants test and the index's storage key, but missed these three.
- The noise tests' synthetic vocabulary must be letters only: digits are split off by the cleanup.

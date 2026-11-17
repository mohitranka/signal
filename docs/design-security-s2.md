# S2: signatures keyed with a per-install secret

Status: **implemented** with **SipHash-2-4** (128-bit key; changed from HalfSipHash in step 4, see the plan). From `docs/security-review.md`.

## Problem (demonstrated in step 8)

Everything in the signature is public: the cleanup, the chunk hash (FNV-1a) and the 256 seeds. Anyone can therefore
compute the exact signature, and its full 32-bit minima, of any post they know. An attacker can append words whose new
3-word chunks never beat those minima, leaving the signature **identical**. Demonstrated: a 19-word spam payload
appended to a kept post gave estimated similarity **1.0** after 210 tries. The crafted post copies the known post's
verdict, so **the model never sees the payload**.

- spam evades collapse by copying a "keep";
- with a predictable target, a bait post with a legitimate post's signature can make that legitimate post copy
  "collapse".

### Where the secret has to go

- **Secret seeds alone are not enough.** The chunk hash (FNV-1a, 32-bit) would stay public, so an attacker could
  search offline for payload chunks whose hash **collides** with one of the target's chunk hashes. Colliding chunks
  change nothing under any seeds. That costs about 4·10⁷ tries per chunk and yields gibberish words: weak, but
  real.
- So the secret must key the **chunk hash itself**, with a function designed to be unpredictable without the key.

## Proposed fix

1. **Keyed chunk hash.** Replace FNV-1a with **HalfSipHash-2-4**, a keyed pseudo-random function with a 64-bit key and
   32-bit output, built for exactly this (hash tables facing adversarial input). Without the key, an attacker can
   neither compute chunk hashes nor find collisions. The 256 public seeds and the MinHash step stay as they are: they
   now mix outputs the attacker cannot predict.
2. **The key.** 64 random bits (`crypto.getRandomValues`), created on first use and stored **inside the index's own
   storage entry** (`repeats:v3` becomes `{ key, entries }`):
   - the key and the signatures made with it live and die together. A missing or corrupt key means a new key and an
     empty index, never signatures compared across keys;
   - `storage.local` is restricted to trusted contexts, so neither content scripts nor the page can read it;
   - **Clear cache** empties the entries and keeps the key (rotating it adds nothing: the index is empty anyway).
3. **No oracle.** The key never leaves the service worker. A post's author cannot observe how a particular viewer's
   Signal treated their post, so there is no way to test guesses. A 64-bit key is therefore ample.
4. **Signature version 3.** v2 signatures are unkeyed. The index starts empty under `repeats:v3`; the existing clean-up
   deletes `repeats:v1`/`v2`. Anchors are learned again as posts are judged, as after finding C.
5. **Eval and tests** call `signature(input, key)` with a **fixed, public key**. Results stay reproducible, and the
   statistics are the same, because a keyed pseudo-random function is as uniform as the unkeyed hash. The extension
   always uses the install's secret key.

### What you notice

Nothing. Matching works exactly as before, for natural repeats. After the update, each known template costs one model
call the first time it is seen again (the index is rebuilt), as after finding C.

### What this does not fix

**S3** (accepted): a *genuine* near-copy of a predictable post with a few bait words needs no crafting, so a secret does
not stop it. The mitigations stay as documented.

### Alternatives considered

- **Secret seeds only:** leaves the offline collision route above.
- **HMAC-SHA-256 via Web Crypto for each chunk:** strongest off the shelf, but asynchronous and, measured, **134×
  slower**: 225 µs per chunk, about 22 ms for a 100-chunk post, against 1.7 µs per chunk (0.17 ms per post) for a
  HalfSipHash prototype.
- **Hide the seeds by obscurity** (not in the public source): not a security measure.

## Scope

- `src/shared/similarity.ts`: `halfSipHash24(key, text)` (unit-tested against the reference test vectors);
  `signature(input, key)`; `SIGNATURE_VERSION = 3`; a `SignatureKey` type and a fixed `PUBLIC_TEST_KEY` for eval/tests.
- `src/background/repeatIndex.ts`: storage `{ key, entries }`, key creation and validation, `key()`. Clear keeps the
  key.
- `src/background/classifyService.ts`: signs with `await repeats.key()`.
- `eval/repeats.ts`, tests: pass the public test key. Existing index tests that write the storage format directly are
  updated to `{ key, entries }`.
- README, the feature design: the matching is keyed per install.
- **No UI change. Step 3 (mockups) skipped, if you agree.**

## Risks

- **Matching quality** must be unchanged. The fixture-set check, the noise tests (finding C) and the recall numbers are
  re-run with the keyed hash. Individual estimates shift (different hash, same statistics); a fixture pair near the
  threshold could move. Any such change is reported, not tuned away.
- **Speed:** the prototype measured 0.17 ms per 100-chunk post for the keyed hash, next to about 0.18 ms for the 256
  MinHash mixes. Signing should roughly double, to about 0.35 ms per post. To be re-measured in step 6.
- **The one-time index rebuild** after the update: at most one model call per template seen again.

## Result (step 6)

| | v2 (FNV, unkeyed) | v3 (SipHash-2-4, keyed) |
|---|---|---|
| signing, 100-word post | 0.17 ms | **0.44 ms** (budget ≤ 1 ms) |
| scan of 2,000 signatures | 0.78 ms | 0.59 ms (unchanged: noise) |
| fixture: lowest in-family / highest cross estimate | 0.898 / 0.316 | 0.895 / 0.391 (public test key), 0.902 / 0.359 (random key); no pair crosses 0.85 |
| noise tests: just below (0.79–0.81) / clear (0.89–0.91) matched of 1000 | 24 expected / 992 expected | 28 / 991 |
| SipHash-2-4 correctness | — | 2 canonical paper vectors + 40 oracle vectors, all pass |

**What S2 closes, and what remains (measured):**
- **Closed: unlimited payloads with a guaranteed copy.** With public hashing an attacker could append any amount of
  text and keep similarity at exactly 1.0. Under a secret key, appended text counts like any honest text. The 40-word
  payload in the tests stays below the threshold.
- **Remains (this is S3, accepted):** a *short* appendage still lands near the threshold on its own. The original
  step-8 payload, 19 words on a 101-word post (honest Jaccard ≈ 0.83), now gives 0.82–0.90 across 20 random keys
  instead of 1.000, and would still be copied under 7 of 20 keys by chance. Roughly, appendages under ~15% of a post's
  length can ride along. That is the near-copy risk accepted as S3, with its mitigations: note, Judge separately,
  Review mode, highlights never copied.

Implementation notes:
- `clear()` now waits for the first load before clearing (it needs the stored key in order to keep it). A clear during
  the first load still wins.
- `PUBLIC_TEST_KEY` is built with `Uint8Array.from`: `TextEncoder` output is a different realm's `Uint8Array` under
  jsdom.
- Again, tests that pinned the literal signature version (two eval tests, one service-worker test) were missed in the
  plan and updated when the full search was run in step 6. A search for version pins is now part of planning any
  version bump.

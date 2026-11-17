# Implementation plan: finding C (256 × 16-bit signatures)

Status: **implemented**.
Design: `docs/design-finding-c-estimate-noise.md`, option 1 (approved; step 3 skipped: no UI change).

Working agreement as before: tests first, confirmed failing for the intended reason; smallest change; full suite (also
with `SIGNAL_TEST_SLOW_HASH`), typecheck and build; one commit; report.

## Change (one task)

- `src/shared/similarity.ts`:
  - `SIGNATURE_HASHES = 256` and `SIGNATURE_VERSION = 2`;
  - `signature()` returns a `Uint16Array` (the low 16 bits of each of the 256 minimums);
  - `similarity()`, `encodeSignature()` and `decodeSignature()` work on `Uint16Array` (512 bytes, little-endian,
    684 base64 characters, as today).
- `src/background/repeatIndex.ts`:
  - the storage key follows the version (`repeats:v2`);
  - on first load, the previous key `repeats:v1` is removed if present;
  - `Uint16Array` types.
- `src/background/classifyService.ts`, `eval/repeats.ts`: signature types only.

## Tests first

Approved changes to existing tests (the design changes these facts):
- `tests/similarity.test.ts`: the constants test becomes 256 / version 2, and the signature is a `Uint16Array` of
  length 256.
- `tests/repeat-index.test.ts`: `STORAGE_KEY` becomes `repeats:v2`.

New tests:

| # | File | Case | Expected before fix |
|---|---|---|---|
| 1 | `similarity.test.ts` | Signature is a `Uint16Array` of 256 values; encode/decode round-trip gives a `Uint16Array`; 684 characters | fails |
| 2 | `similarity.test.ts` | **Noise, wrong side:** 400 seeded synthetic pairs with exact similarity in [0.78, 0.82] → at most 5% treated as the same template (today ≈ 10%, new ≈ 2–3%) | fails |
| 3 | `similarity.test.ts` | **Noise, misses:** 400 seeded synthetic pairs with exact similarity in [0.89, 0.91] → at least 98.5% matched (today ≈ 96–97%, new ≈ 99.5%) | fails |
| 4 | `repeat-index.test.ts` | **Old index removed:** with `repeats:v1` in storage, the first load deletes it; `repeats:v2` entries are kept | fails |
| 5 | `repeat-index.test.ts` | Nothing to clean up: no removal is attempted when `repeats:v1` is absent | passes (guard) |

Tests 2 and 3 use a fixed seed, and compute exact similarity in the test from the same cleanup (`words`) and 3-word
chunks, so they are deterministic. Their bounds sit between today's and the new expected rates, with margin on both
sides.

All existing behaviour tests must pass unchanged: the fixture-set quality check, matching, service, controller and
eval. The fixture set must still report 0 different-label pairs and 0 matched hard negatives.

## Measurements in step 6 (reported, not asserted: timing tests are flaky)

- Signing time per post and 2,000-entry scan time, before and after.
- The fixture set's lowest in-family estimate and highest cross-pair estimate, before and after.
- README and the design's recall table: re-measured with the new signature.

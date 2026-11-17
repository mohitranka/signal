# Implementation plan: P1 + P2 + P3(a)

Status: **implemented**.
Design: `docs/design-performance-p1-p3.md` (approved; step 3 skipped: no UI change).

Working agreement as before: tests first, confirmed failing for the intended reason where a failing test is possible;
smallest change; full suite (also slow-hash), typecheck and build; one commit; report with before/after measurements.

## Change (one task)

- `src/shared/similarity.ts`:
  - `encodeSignature`: one `String.fromCharCode.apply` over the little-endian bytes;
  - `decodeSignature`: `atob` into a `Uint8Array`, read as `Uint16Array`;
  - an explicit little-endian fallback if the host is big-endian.
- `src/background/repeatIndex.ts`:
  - `Entry.enc`: the encoded signature, set once on `add` (encoded) or on load (the stored string);
  - `flush()` writes `e.enc`;
  - `touch()` updates the time in memory and does not schedule a save.

## Tests first

| # | File | Case | Expected before fix |
|---|---|---|---|
| 1 | `perf-index.test.ts` (new; `encodeSignature` wrapped in a counting spy via `vi.mock`, real behaviour kept) | **P1:** with 3 entries loaded from storage and 1 added, two saves encode **exactly once** (the added entry), never the loaded ones and never again on the second save | fails (8 encodes) |
| 2 | `perf-index.test.ts` | Those saves still write each loaded entry's **stored string unchanged** | passes (guard) |
| 3 | `perf-index.test.ts` | **P3a:** after a save, a `touch()` alone causes **no** write, even after the save delay has passed | fails (a full write) |
| 4 | `perf-index.test.ts` | The touched time **is** written with the next real change (an `add`), and by an explicit `flush()` (what `onSuspend` does) | passes (guard) |
| 5 | `similarity.test.ts` | **Format golden value:** `encodeSignature(signature(announce(), PUBLIC_TEST_KEY))` equals the string recorded **now**, from the current code; decoding it gives the signature back | passes (guard), must stay green |
| 6 | `similarity.test.ts` | Round-trip for signatures with extreme values (all 0, all 0xffff, alternating), and for a **subarray view** (the byte view must respect `byteOffset`) | passes (guard) |

**P2 has no failing-first test:** it is a refactor of a pure function whose outputs are unchanged (tests 5–6 and the
existing round-trip and junk-rejection tests guard that). Only a timing threshold could fail first, and timing
thresholds flake on loaded machines (this suite waits for conditions, not time). Its speed-up is verified by
measurement instead.

## Measurements in step 6 (same script as step 9)

Encode 2,000 / decode 2,000 / index save (assembly) / a save's structured clone: before and after.

## Done when

Tests 1–6 pass (1 and 3 red first); full suite green (also slow-hash); typecheck and build clean; measurements
reported; performance review updated.

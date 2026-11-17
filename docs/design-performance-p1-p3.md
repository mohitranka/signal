# P1 + P2 + P3(a): cheaper index saves and loads

Status: **implemented**. From `docs/performance-review.md`. See "Result": the first load improved less than
the codec alone suggested (finding P2b).

## Problems (measured)

| # | Problem | Measured |
|---|---|---|
| P1 | `RepeatIndex.flush()` re-encodes all 2,000 signatures on every save, although a signature never changes | 50 ms on the service worker's only thread, up to every 2 s while scrolling |
| P2 | The first load after each service-worker wake decodes all 2,000 signatures with a byte-by-byte `DataView` loop and a `Uint16Array.from` callback | 49–60 ms before the first uncached lookup, after every wake |
| P3 | `touch()` (a copy used an entry) schedules a full save (1.5 MB) just to update one timestamp | copies are the common case for a feed full of templates |

## Proposed fix

1. **Encode once (P1).** Each index entry keeps its encoded signature (`enc`) next to the decoded one:
   - set when the entry is **added** (encoded once);
   - set when it is **loaded** (the stored string itself: no re-encoding).

   `flush()` only assembles `{ key, entries }` from the kept strings. Measured: 50 ms → 0.6 ms.
2. **A faster codec, same format (P2).**
   - `encodeSignature`: one `String.fromCharCode.apply` over the signature's bytes, then `btoa`.
   - `decodeSignature`: `atob` into a `Uint8Array`, read as a `Uint16Array`.
   - The stored format stays **little-endian uint16, base64, 684 characters**, byte for byte. On a (theoretical)
     big-endian host, both fall back to explicit little-endian byte order. Measured: decode 60 → 7.3 ms, encode
     50 → 9.8 ms (the one-time cost of an add is then ~5 µs).
   - **No version bump:** existing `repeats:v3` data stays valid. A golden-value test proves the encoding is unchanged.
3. **Timestamps ride along (P3a).** `touch()` updates the entry's time in memory and **no longer schedules a save**. The
   new times are written with the next real change (`add`, `remove`, `clear`, a new key) and on suspend (the service
   worker already flushes the index in `onSuspend`). If the worker is killed without a suspend, a few "last used"
   times are lost. They only steer eviction order and tie-breaks, so nothing visible changes.

## What you notice

Nothing, except less work: no 50 ms stall every couple of seconds while scrolling; a faster first lookup after the
service worker wakes; and, on a feed full of templates, far fewer 1.5 MB writes.

## Scope

- `src/shared/similarity.ts`: `encodeSignature`, `decodeSignature` (same signatures and format).
- `src/background/repeatIndex.ts`: `enc` kept per entry; `flush()` uses it; `touch()` does not schedule a save.
- No storage-format change, no message change, no UI change. **Step 3 (mockups) skipped, if you agree.**

## Risks

- **Format drift** would silently invalidate stored indexes. Mitigations: the golden-value test, the existing round-trip
  and junk-rejection tests, and an explicit endianness fallback.
- **Lost timestamps** on a worker kill: harmless, as above.
- **P3(b)** (sharding) is deferred, so a real change still writes the whole index. That is by decision.

## Result (step 6)

Measured on the real `RepeatIndex` with 2,000 entries (storage faked as instant, so this is the worker's own CPU time),
old code against new on the same data:

| | before | after |
|---|---|---|
| one index save | 50.5 ms | **0.96 ms** |
| full saves caused by 50 copies (touch) alone | 1 | **0** |
| first load after a wake | 55 ms | **26 ms** |

**The first load improved less than the design implied** (it quoted the codec alone: 60 → 7.3 ms). Profile of the
remaining 26 ms: `decodeSignature` × 2,000 = 22.9 ms, of which **12.5 ms is the base64 format regex** run on each
684-character string (atob 1.7 ms, byte copy 6.6 ms). My step-9 micro-benchmark had left that check out. The other
checks (exact length, `atob` not throwing, exactly 512 decoded bytes) rejected exactly what the regex rejects in every
edge case tried (whitespace, URL-safe alphabet, non-ASCII, misplaced or extra padding): 0 disagreements. Removing a
validation of untrusted stored data is raised as a separate finding, **P2b**, not done here.

A mistake in my own test, fixed in step 5: the touch/flush guard first mocked `Date.now` after the index had captured its
clock. It uses the index's injectable clock instead.

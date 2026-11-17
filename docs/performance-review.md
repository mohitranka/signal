# Performance review (SDLC step 9)

Scope: the service worker's costs added or changed by this work (repeated templates, findings A–E, security S1–S7),
measured at realistic scale: a full index (2,000 entries), a full cache (2,000 entries), and the largest post Signal
accepts. Timings are from Node (same V8 engine as Chrome), on this sandbox. `chrome.storage` I/O itself cannot be
measured here, so its volume is computed, and marked as such.

## Measurements

| Operation | Time | When it happens |
|---|---|---|
| Sign a typical post (~100 words) | 0.47 ms | each post that misses the exact cache |
| Sign the largest accepted post (3,000 + 1,500 + … chars) | 3.77 ms | rare |
| Scan 2,000 signatures (one repeat lookup) | 0.90 ms | each post that misses the exact cache |
| `cache.set()` at the 2,000-entry cap (sorts all entries) | 0.19 ms | each model verdict once the cache is full |
| **Encode 2,000 signatures for one index save** | **50 ms** | **every index save: up to every 2 s while scrolling** |
| **Decode 2,000 signatures on the first index load** | **49–60 ms** | **after every service-worker wake** (Chrome stops idle workers after ~30 s) |
| Structured clone of the index value (≈ storage serialisation) | 3.6 ms | every index save |
| Structured clone of the cache value | 2.0 ms | every cache save |
| Index value size / cache value size | 1.52 MB / 0.60 MB | written whole on every save |

## Findings

| # | Finding | Impact | Recommendation |
|---|---|---|---|
| P1 | Every index save re-encodes all 2,000 signatures | **50 ms** on the worker's only thread per save, up to every 2 s while scrolling: messages (classify answers, cancels) wait behind it | **Fix** |
| P2 | The first index load after each wake decodes all 2,000 signatures | **49–60 ms** added before the first uncached post's lookup, after every wake | **Fix** |
| P3 | Every save writes the **whole** index (1.5 MB) and the whole cache (0.6 MB); a copy's timestamp `touch()` alone triggers a full index save | **Computed:** scrolling with a new post every ~2 s, both stores save every 2 s → ~1 MB/s, ~60 MB per minute, into Chrome's storage. The cache part predates this work | **Fix (a)**, consider (b) |
| P4 | Signing the largest accepted post | 3.8 ms, rare | Accept |
| P5 | A full linear scan per lookup | 0.9 ms at the 2,000-entry cap | Accept (an LSH index is not worth it at this size) |
| P6 | `cache.set()` sorts all entries at the cap | 0.19 ms | Accept |

### P1: re-encoding on every save (recommended fix)

A signature never changes after it is added, yet `flush()` re-encodes every one of them (a per-byte string loop plus
`btoa`).

**Fix:** encode once, when an entry is added or loaded, and keep the string with the entry. A save then only assembles
the object. Measured: **50 ms → 0.6 ms**. The faster codec (below) also makes the one-time encode cheaper.

### P2: decoding on every wake (recommended fix)

`decodeSignature` goes through a `DataView` byte by byte and then `Uint16Array.from` with a callback.

**Fix:** decode the bytes straight into a `Uint8Array` and view it as `Uint16Array`. Encode likewise with a single
`String.fromCharCode.apply` over a byte view. Little-endian order is kept explicitly, so the stored format is
**unchanged**: output is byte-identical and round-trips exactly (verified). Measured: decode **60 → 7.3 ms**, encode
**50 → 9.8 ms**.

### P3: whole-store writes (options)

- **(a) Recommended:** `touch()` (a copy used an entry) no longer schedules a save by itself. The new time is written
  with the next real change (`add`, `remove`, `clear`) or on suspend. Timestamps only steer eviction order and tie-breaks,
  so losing a few on a worker kill is harmless. This removes the index saves that copies alone cause, which are the
  common case for a feed full of templates. Small, local change.
- **(b) Larger:** split each store into shards (e.g. 16 storage keys by fingerprint prefix) and write only the shards
  that changed: about 1/16 of today's volume per save, for the cache too. It needs a storage-format change and a
  migration, and concerns the cache, which predates this work. Could be its own finding later.
- **(c)** A longer save delay: fewer writes, but more lost on a worker kill. Not recommended alone.

## Not measured / out of scope

- Content-script performance: this work added little there (a note row, one request per Judge separately).
  Unchanged paths were not re-profiled.
- Real `chrome.storage` write latency and disk cost: not measurable in this sandbox; P3's volume is computed from the
  measured value sizes and the 2 s save delay.
- Test-suite time: the finding-C noise tests add about 1.6 s to a ~16 s suite. Acceptable.

## Recommendation summary

Fix **P1**, **P2** and **P3 (a)**: one task, all in `similarity.ts` / `repeatIndex.ts`, with no format change. Accept
**P4–P6**. Consider **P3 (b)** separately if storage volume matters to you.

## Decisions (aligned)

- **Fix** P1, P2 and P3 (a) as one task, through steps 2–6.
- **Accept** P4, P5, P6.
- **Defer** P3 (b) (sharded storage for the index and the cache): a possible separate finding later.

## Outcome

| # | Result |
|---|---|
| P1 | Fixed: save 50.5 → 0.96 ms (encodings kept) |
| P3a | Fixed: copies alone cause no saves (1 → 0 per burst) |
| P2 | Improved: first load 55 → 26 ms. The codec is faster, but 12.5 ms remain in a base64 regex that looks redundant → **P2b** (next row) |
| P2b | Fixed (option b): the regex is replaced by a final-`=` check with exactly the same acceptance; decoding 2,000 signatures 13.5 → 4.1 ms (`docs/implementation-plan-performance-p2b.md`) |
| P4–P6 | Accepted |
| P3b | Deferred |

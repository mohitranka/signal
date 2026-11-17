# Implementation plan: S2 (signatures keyed with a per-install secret)

Status: **implemented**.
Design: `docs/design-security-s2.md` (approved; step 3 skipped: no UI change), **with one change proposed here**.

## Proposed change to the design: SipHash-2-4 instead of HalfSipHash-2-4

While planning how to prove the keyed hash correct, I found that the reference **test vectors** available here (the
widely used `siphash` npm package, downloaded to `/tmp` only, not added as a dependency) are for **SipHash-2-4**, not
HalfSipHash. I could only recall HalfSipHash vectors from memory, which is not proof. SipHash-2-4:

- **can be proven correct:** the package reproduces the two canonical vectors from the SipHash paper (key `00..0f`:
  empty message → `726fdb47dd0e0e31`; message `00..0e` → `a129ca6149be45e5`). So it can serve as an independent oracle
  for further vectors;
- is **stronger:** a 128-bit key instead of 64;
- is the **same kind of function:** a keyed pseudo-random function for adversarial hash-table input, and the original
  that HalfSipHash was derived from.

Cost: the package itself takes 9.3 µs per chunk (0.93 ms per 100-chunk post), converting each string to UTF-8 on every
call. My implementation reuses an encode buffer. **Budget: signing ≤ 1 ms per 100-chunk post**, measured in step 6.
The chunk hash is the low 32 bits of SipHash-2-4's output. Everything else in the design is unchanged.

Working agreement as before: tests first, confirmed failing for the intended reason; smallest change; full suite (also
with `SIGNAL_TEST_SLOW_HASH`), typecheck and build; one commit; report.

## Change (one task)

- `src/shared/similarity.ts`:
  - `sipHash24(key: SignatureKey, bytes): { hi, lo }` (32-bit halves, no BigInt), hashing UTF-8 bytes;
  - `type SignatureKey = Uint8Array` (16 bytes) and `PUBLIC_TEST_KEY`;
  - `signature(input, key)` uses `sipHash24(key, utf8('field:chunk')).lo` instead of FNV-1a;
  - `SIGNATURE_VERSION = 3`; `newSignatureKey()` (16 random bytes); `encodeKey` / `decodeKey` (base64, exactly 16 bytes).
- `src/background/repeatIndex.ts`:
  - storage `repeats:v3 = { key, entries }`; `key(): Promise<SignatureKey>`;
  - a missing or invalid key creates a new one and empties the entries (never compare across keys);
  - `clear()` keeps the key;
  - old `repeats:v1`/`v2` are deleted (existing clean-up).
- `src/background/classifyService.ts`: `signature(input, await repeats.key())`.
- `eval/repeats.ts`: `signature(…, PUBLIC_TEST_KEY)`.
- Tests that call `signature()` pass `PUBLIC_TEST_KEY`. The index tests that write the storage format directly use
  `{ key, entries }`.

## Tests first

| # | File | Case | Expected before fix |
|---|---|---|---|
| 1 | `siphash.test.ts` (new) | The two canonical SipHash-2-4 vectors from the paper | fails (no `sipHash24`) |
| 2 | `siphash.test.ts` | 40 further vectors generated with the oracle package: keys varied, messages of 0–64 bytes (every tail length), ASCII and multi-byte UTF-8 (`é`, `€`, emoji, Cyrillic). Provenance recorded in the file | fails |
| 3 | `similarity.test.ts` | **Keyed:** the same post under two different keys gives unrelated signatures (similarity < 0.1); under one key, deterministic | fails |
| 4 | `similarity.test.ts` | **The step-8 attack no longer works:** the crafted 19-word payload (built with the public seeds and FNV) appended to the kept post now gives similarity < 0.85 under a secret key | fails (1.0 today) |
| 5 | `similarity.test.ts` | Constants: version 3; key 16 bytes; `encodeKey` / `decodeKey` round-trip; junk keys rejected | fails |
| 6 | `repeat-index.test.ts` | A key is created on first use (16 random bytes) and stored with the entries; a new instance reads the same key | fails |
| 7 | `repeat-index.test.ts` | A missing or corrupt stored key means a new key **and** an empty index | fails |
| 8 | `repeat-index.test.ts` | `clear()` empties the entries and keeps the key | fails |
| 9 | `repeat-index.test.ts` | Concurrent first uses create **one** key (shared first load, as in finding E) | fails |
| 10 | `repeat-index.test.ts` | `repeats:v1` and `repeats:v2` are deleted on first load | fails (v2 is the current key) |
| 11 | `repeats-service.test.ts` | The service signs with the index's key: two installs (different keys) never match each other's stored signatures | fails |
| 12 | `security.test.ts` | The key lives only in `storage.local` (trusted contexts), and no message response (`classify`, `getState`, `getStats`) contains it | fails (no key yet) |

All existing behaviour tests must pass unchanged, given the key: the fixture-set quality check, matching, the noise
tests from finding C, service, controller and eval. If a fixture pair's estimate crosses the threshold because the hash
changed, it is reported, not tuned away.

## Measurements in step 6

- Signing per 100-chunk post (budget ≤ 1 ms), and the 2,000-entry scan.
- The fixture set's margins and the noise-test counts, before and after.
- The step-8 crafting demonstration re-run against the keyed signature.

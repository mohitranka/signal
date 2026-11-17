# Implementation plan: performance P2b (base64 check on stored signatures)

Status: **implemented**.
Origin: `docs/performance-review.md` (P2 outcome) and `docs/design-performance-p1-p3.md`. Decision: option **(b)**.

## Finding

`decodeSignature` (untrusted stored data) ran a full-string regex, `/^[A-Za-z0-9+/]+={0,2}$/`, over each 684-character
signature: 12.5 ms of the 26 ms first load for 2,000 entries. It looked redundant next to the other checks (exact
length, `atob` not throwing, exactly 512 decoded bytes), and was raised for a decision.

A closer check before removing it showed it is **not entirely redundant**: `atob` (the HTML "forgiving base64" decode,
same in Node and Chromium) skips ASCII whitespace and does not require padding. So 683 base64 characters plus one
space, tab or newline decode to 512 bytes; the regex rejects them. A seeded fuzz of 400,000 mutated strings: 10.0%
disagreements if the regex were simply removed. The effect would be harmless (such a string decodes to a valid
signature that anyone able to write the storage could also store canonically), but it would be a behaviour change.

## Change (option b)

Replace the regex with a one-character check: the string **ends with `=`**. A canonical encoding of 512 bytes is
683 data characters plus exactly one `=`. With the length fixed at 684, a last `=`, `atob` succeeding and 512 bytes out,
the accepted set is exactly the regex rule's: any whitespace leaves at most 682 data characters, and then `atob`
either throws (a stray `=`) or returns too few bytes. Fuzz: 0 disagreements in 400,000 (Node and Chromium).

`src/shared/similarity.ts` only: drop `BASE64_RE`; `s.charCodeAt(ENCODED_LENGTH - 1) !== 61 /* '=' */ → null`.

## Tests (in `tests/similarity.test.ts`)

| # | Case | Before the change |
|---|---|---|
| 1 | Decoding runs no regular expression (`RegExp.prototype.test` / `exec` spied) | **fails** (called once) |
| 2 | 683 base64 characters + whitespace (5 kinds × 3 positions) are rejected, although `atob` alone gives 512 bytes | passes (guard: fails if the check were simply removed) |
| 3 | Seeded fuzz, 40,000 mutated strings: accepted exactly when the previous rule accepted, same bytes | passes (guard) |

Existing encoding tests (round trip, golden value, rejections) stay unchanged.

## Done when

Test 1 red then green, 2 and 3 green throughout (and shown to fail with the check removed outright); full suite,
typecheck and build green; first-load time re-measured with the P1–P3 benchmark and reported.

## Result (step 6)

- Test 1 red before (the regex ran: 2 spied calls), green after. Tests 2 and 3 green before and after; with the check
  removed outright (no regex, no final-`=` check) both **fail**, so they guard against that.
- A mistake in my own test, fixed before the implementation: the first version also spied on regexes during
  `expect()`, which uses regexes itself for its messages. It now reads the call count before asserting.
- Measured (2,000 stored signatures, median of 30, Node): `decodeSignature` × 2,000: **13.5 → 4.1 ms**; first index
  load including the storage read's copy: **22.0 → 13.7 ms**.
- Full suite (outside the bridge's step-5 tests), typecheck and build green.

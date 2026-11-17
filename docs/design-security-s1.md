# S1: `check-lock` must not print untrusted text raw

Status: **implemented**. From `docs/security-review.md`.

## Problem (reproduced)

`check-lock` prints text from two untrusted sources without filtering control characters:

| Printed | Source |
|---|---|
| package names, locked versions, locked integrity | the lockfile (repository content) |
| newest versions (packument keys), registry integrity | the **registry** |
| error messages (`HTTP 500`, network errors, JSON parse errors) | the registry, or the runtime |
| lockfile path, registry URL | command line / environment |

With a hostile registry, 5 control characters reached the terminal, including `ESC[2K\r` (erase the line, rewrite
it). A malicious or compromised registry, the very adversary an integrity check is for, could overwrite the
**INTEGRITY MISMATCH** warning with "all entries match".

The project already has the rule and the tool: `printable()` (`src/classifier/parse.ts`, rule S5) replaces control and
bidi-control characters with `?`, and the eval CLI uses it everywhere. `check-lock` (added in finding D) did not.

### A gap in `printable()` itself (verified)

Unicode has 12 bidirectional formatting characters. `UNSAFE_TEXT` blocks 11 of them, but **not U+061C ARABIC LETTER
MARK (ALM)**, which can reorder displayed text like the others ("Trojan Source"-style spoofing). It affects every user of
`printable()` and `UNSAFE_TEXT`: the eval CLI, and model names and prompt versions in stored records.

## Proposed fix

1. **`scripts/lockcheck.ts`, `formatReport`:** pass every interpolated untrusted value through `printable()`: names,
   versions, newest and newest-overall versions, both integrity values, error messages.
2. **`scripts/check-lock.ts`:** also the lockfile path, the registry URL shown, and the top-level error message.
3. **`src/classifier/parse.ts`:** add U+061C to `UNSAFE_TEXT`. All users of the rule get it: eval output, and the
   validation of stored model names and prompt versions, which now also rejects ALM.
4. The report's **first line** (counts of missing / mismatched / could not check) is built only from numbers, so it
   cannot be spoofed whatever the data contains. Kept that way, and covered by a test.

## Scope

- `scripts/lockcheck.ts`, `scripts/check-lock.ts`, `src/classifier/parse.ts` (one character range).
- No UI change. **Step 3 (mockups) skipped, if you agree.**

## Risks

- A real package name or version never contains control characters, so honest output is unchanged.
- Adding ALM to `UNSAFE_TEXT` means a stored record whose model name contains U+061C is now rejected as malformed
  (treated like any other malformed record: left out of "Your corrections", with the reason shown). No real model name
  contains it.

## Result (step 6)

The step-8 hostile-registry demonstration, re-run unchanged: **0** control characters reach the terminal (before: 5).
`printable()` now covers all 12 Unicode bidi formatting characters (U+061C added), for `check-lock`, the eval CLI and the
validation of stored model names and prompt versions.

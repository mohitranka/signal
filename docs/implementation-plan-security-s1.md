# Implementation plan: S1 (`check-lock` sanitises untrusted text; `printable()` blocks ALM)

Status: **implemented**.
Design: `docs/design-security-s1.md` (approved; step 3 skipped: no UI change).

Working agreement as before: tests first, confirmed failing for the intended reason; smallest change; full suite,
typecheck and build; one commit; report.

## Change (one task)

- `src/classifier/parse.ts`: `UNSAFE_TEXT` gains `\u061c`.
- `scripts/lockcheck.ts`, `formatReport`: `printable()` around every interpolated untrusted value (name, version,
  newest, newest overall, lockfile integrity, registry integrity, error message). The first line stays numbers only.
- `scripts/check-lock.ts`: `printable()` around the lockfile path, the displayed registry URL and the top-level error.

## Tests first

| # | File | Case | Expected before fix |
|---|---|---|---|
| 1 | `lockcheck.test.ts` | **Hostile data in every field** (lockfile name/version/integrity; registry version keys, integrity, error message; each carrying ESC, C1 CSI, RLO, ALM): the report contains no control or bidi-control characters, and every section heading (MISSING, INTEGRITY MISMATCH, COULD NOT CHECK) is still present on its own line | fails |
| 2 | `lockcheck.test.ts` | The first line is built from numbers only: with hostile data it is exactly `check-lock: N entries checked: …` | passes (guard) |
| 3 | `lockcheck.test.ts` | **End to end**: a local registry serving hostile versions and integrity → stdout and stderr free of control characters; exit code 1; "INTEGRITY MISMATCH" line intact | fails |
| 4 | `lockcheck.test.ts` | **End to end**: a nonexistent lockfile path containing ESC → the error on stderr is sanitised; exit code 2 | fails |
| 5 | `security.test.ts` (S5 block) | `printable` and `UNSAFE_TEXT` cover U+061C; `parseRecord` rejects a model name containing it | fails |
| 6 | `eval-stored.test.ts` | The eval CLI prints an id containing U+061C as `?` | fails |

## Done when

All pass; the full suite (also slow-hash), typecheck and build are green. The step-8 hostile-registry demonstration,
re-run, shows 0 control characters.

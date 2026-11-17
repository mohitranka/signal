# Implementation plan: S4 (lockfile-bypass advice carries its supply-chain warning)

Status: **implemented**.
Design: `docs/design-security-s4.md` (approved; step 3 skipped: no UI change).

Working agreement as before: tests first, confirmed failing for the intended reason; smallest change; full suite,
typecheck and build; one commit; report.

## Change (one task)

- `scripts/lockcheck.ts`, `formatReport`: the "registry behind" hint lists the remedies in order. First
  `npm ci --registry=https://registry.npmjs.org/` (or refresh the mirror). Then, marked as a last resort for throwaway
  environments only, the bypass with its warning (skips pinned versions and integrity checks; do not ship or load a
  build made this way).
- `README.md`, *Install*: the same advice in prose.
- `docs/design-finding-d-lockfile.md`: a note that its advice is superseded by S4.

## Tests first

| # | File | Case | Expected before fix |
|---|---|---|---|
| 1 | `lockcheck.test.ts` (existing test, updated as the design changes this text) | The "registry behind" report recommends `npm ci --registry=https://registry.npmjs.org/` **first**: it appears before any mention of `--no-package-lock` | fails |
| 2 | `lockcheck.test.ts` | Where the report mentions `--no-package-lock`, the same block says "integrity" and "throwaway", and says not to ship a build made that way | fails |
| 3 | `docs-advice.test.ts` (new) | **Guard:** every paragraph of `README.md` that mentions `--no-package-lock` also contains "integrity" and "throwaway", and mentions `npm ci --registry` before it | fails |
| 4 | `lockcheck.test.ts` | Reports with no "behind" hint (all match; unpublished only) mention neither command | passes (guard) |

## Done when

All pass; full suite, typecheck and build green; a real `npm run check-lock` in the sandbox shows the new hint.

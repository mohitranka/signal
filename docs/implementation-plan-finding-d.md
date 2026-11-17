# Implementation plan: finding D (`npm run check-lock`)

Status: **implemented**.
Design: `docs/design-finding-d-lockfile.md`, option 1 (approved; step 3 skipped: no UI change).

Working agreement as before: tests first, confirmed failing for the intended reason; smallest change; full suite,
typecheck and build; one commit; report. `package-lock.json` and dependencies stay untouched.

## Change (one task)

**`scripts/lockcheck.ts`**: pure logic, no network of its own (the registry is passed in):

```js
lockEntries(lock)        // [{ name, version, integrity }] from lockfile v2/v3 "packages":
                         //   skips the root, workspace links and bundled deps; aliases use their real "name";
                         //   one entry per name@version
compareVersions(a, b)    // semver order (major.minor.patch; a pre-release sorts before its release)
checkLock(lock, registry, { concurrency })
                         // registry.packument(name) -> { versions: { [v]: { dist: { integrity } } }, "dist-tags" } | null
                         // each package fetched once; returns { checked, ok, missing, mismatched, errors, registryBehind }
formatReport(result)     // { text, exitCode }: 0 = all match, 1 = missing or mismatched, 2 = could not check
```

**`scripts/check-lock.ts`**: the command line. Reads `package-lock.json` (or `--lockfile <path>`). Uses the registry
from `npm_config_registry` (set by `npm run`), falling back to `https://registry.npmjs.org/`. Fetches abbreviated
packuments (`Accept: application/vnd.npm.install-v1+json`), encoding scoped names (`@babel%2fparser`), eight at a time.
Prints the report and exits with its code. Private registries that need auth are out of scope (documented).

**`package.json`**: `"check-lock"`, built and run the way `npm run eval` already is (esbuild bundle for Node, then
`node`). TypeScript like `eval/`, so tests import it directly and the typecheck covers it (`tsconfig` gains
`"scripts"` in `include`). **README, Install**: the troubleshooting paragraph.

## Tests first: `tests/lockcheck.test.ts` (new, Node environment, no network)

| # | Case |
|---|---|
| 1 | `lockEntries`: skips the root, `link` and `inBundle` entries; an alias entry (`node_modules/strip-ansi-cjs` with `"name": "strip-ansi"`) is checked as `strip-ansi`; the same name@version at two paths is checked once |
| 2 | `compareVersions`: 4.68.3 > 4.68.2, 8.23.0 > 8.22.2, 10.0.0 > 9.9.9, 1.0.0-rc.1 < 1.0.0 |
| 3 | Everything matches → exit 0, "all N entries match" |
| 4 | **Missing, newer than anything published** (`ws` 8.23.0 vs newest 8.22.2) → listed with the newest; `registryBehind`; the report says the registry looks behind this lockfile and suggests the fix; exit 1 |
| 5 | **Missing, but older versions exist above it** (unpublished) → listed **without** the "behind" hint; exit 1 |
| 6 | **Integrity mismatch** → listed separately, worded as a possible supply-chain problem; exit 1, even if nothing is missing |
| 7 | Package unknown to the registry (packument `null`) → missing, newest "none" |
| 8 | Registry error for one package → under "could not check", not counted as missing; exit 2 when nothing else is wrong |
| 9 | Each package's packument is fetched once, however many versions or paths it has |
| 10 | **Command line, end to end**: a local HTTP server acts as the registry (`npm_config_registry` points at it); the script is run on a temp lockfile. It asserts the exit code, the report lines, the abbreviated-metadata `Accept` header and the scoped-name encoding. A second run against a server that matches everything exits 0. |
| 11 | `package.json` has the `check-lock` script, and the lockfile is unchanged by this finding (its hash before and after) |

All fail before the fix (the modules do not exist yet), except the lockfile-unchanged check, which passes as a guard.

## Done when

All pass; full suite green; typecheck (including `scripts/`) and build clean. A real run of `npm run check-lock` in this sandbox reproduces the investigation: 34
missing, all ahead, 0 mismatched, with the "registry behind" hint. README updated.

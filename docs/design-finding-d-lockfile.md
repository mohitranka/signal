# Finding D: `npm ci` fails (lockfile versions not found)

Status: **implemented** (option 1: `npm run check-lock`; lockfile untouched).

> **Superseded advice (security S4):** the fallback below (`npm install --no-package-lock --no-save`) must only be
> offered as a last resort with its supply-chain warning. See `docs/design-security-s4.md`.

## What happens

`npm ci` stops at the first lockfile entry it cannot download:
`404 Not Found - GET https://registry.npmjs.org/ws/-/ws-8.23.0.tgz`. Every build and test run in this project so far
used `npm install --no-package-lock --no-save` instead.

## Investigation

**Every lockfile entry was checked** (239 packages) against the registry this environment reaches: does the pinned
version exist, and does its published integrity hash equal the lockfile's?

| Result | Count |
|---|---|
| exists, integrity matches exactly | 205 (202 + 3 npm aliases `*-cjs`, checked under their real names) |
| **version not on this registry** | **34** |
| integrity mismatch | **0** |

All 34 missing entries are slightly **ahead** of the newest version this registry has:

| package | lockfile | newest here |
|---|---|---|
| `rollup` + 25 platform packages | 4.68.3 | 4.68.2 (published 2026-11-09) |
| `ws` | 8.23.0 | 8.22.2 (2026-11-08) |
| `@babel/parser`, `types`, `helper-string-parser` | 7.29.14 | 7.29.13 |
| `@jridgewell/resolve-uri` | 3.1.3 | 3.1.2 |
| `brace-expansion` (two copies) | 2.1.8 / 5.0.13 | 2.1.6 / 5.0.12 |

**This registry view is stale.** The sandbox date is 2026-11-17, but nothing here was published after 2026-11-11, even for
packages that publish constantly. TypeScript ships a nightly **every day**, yet its newest here is 2026-10-21;
`@types/node` (several times a week) is at 2026-10-28. So the lockfile was most likely generated against a newer
registry, and these 34 versions exist upstream. This cannot be proven from inside the sandbox: the alternative is
versions that were unpublished.

**What the tests ran on:** all 7 direct dev dependencies installed here match the lockfile exactly (vitest 3.2.7,
typescript 5.9.3, esbuild 0.25.12, jsdom 26.1.0, …). Only three transitive packages are one patch behind (`ws`, `rollup`,
`@babel/parser`). Every result reported in this project therefore holds for essentially the locked toolchain.

**Conclusion:** most likely an environment problem (a lagging registry mirror), not a defect in the lockfile. The real
weakness is that the failure is **undiagnosable**: a bare 404 does not say "your registry is behind this lockfile", and
it says nothing about the other 33 entries.

## Options

### 1. Keep the lockfile; make the failure diagnosable (recommended)

- **Do not change `package-lock.json`.** Regenerating it here would downgrade 34 entries to versions from a stale mirror
  and undo the author's lock.
- Add `npm run check-lock` (`scripts/check-lock.mjs`, Node built-ins only, no new dependency). For every lockfile entry
  it asks the configured registry whether that version exists and whether its integrity matches, and prints a summary:
  - **missing** versions, each with the newest version available, and a hint when a missing version is *newer* than the
    newest available one ("your registry looks behind this lockfile; try the public registry or refresh the mirror");
  - **integrity mismatches**, flagged loudly as a possible supply-chain problem;
  - npm aliases (`"name": "real-package"` in the lockfile) checked under their real name.
  - Exit code 0 only if everything matches.
- README, *Install*: one troubleshooting paragraph. If `npm ci` fails with a 404, run `npm run check-lock`. If the registry
  is behind, `npm install --no-package-lock --no-save` installs the newest compatible versions without touching the
  lockfile (as used in this project's sandbox).

### 2. Regenerate the lockfile against this registry

This makes `npm ci` pass here, but pins 34 older patch versions from a stale mirror. It would probably be reverted by
the next install anywhere else. Not recommended.

### 3. Document only

Only the README paragraph: no script, and no way to tell a lagging mirror from tampering short of doing this
investigation again by hand.

## Scope (option 1)

- New: `scripts/check-lock.mjs`, and its checks as pure functions in `scripts/lockcheck.mjs`, so tests run without
  network (the registry is injected).
- `package.json`: one script entry (`"check-lock"`). **No dependency changes. `package-lock.json` is untouched.**
- README: the troubleshooting paragraph.
- **No UI change: step 3 (mockups) skipped, if you agree.**

## Notes

- The integrity comparison is also a supply-chain check. I will mention it in step 8 (security) rather than expand this
  finding.
- The script needs network access (like `npm ci` itself). Its tests do not.

## Result (step 6)

A real `npm run check-lock` in the sandbox reproduces the investigation:

```
checking package-lock.json against https://registry.npmjs.org/
check-lock: 233 entries checked: 199 match, 34 missing, 0 integrity mismatch, 0 could not check
  …
  @babel/parser@7.29.14  newest available: 7.29.13 (newest overall: 8.1.0)  (newer than anything published here in 7.x)
  brace-expansion@5.0.13  newest available: 5.0.12  (newer than anything published here)
  @rollup/rollup-android-x64@4.68.3  newest available: none
Hint: this registry looks behind this lockfile (33 entries are newer than anything it has).
```

(233 = the 239 lockfile paths with duplicates of the same name@version counted once.)

**Found by the real run and fixed with a test first:** the first version judged "ahead" against the registry's newest
version **overall**. So `@babel/parser@7.29.14` (registry: 7.29.13 in 7.x, but 8.1.0 overall) and
`brace-expansion@2.1.8` were labelled "unpublished?". "Ahead" is now judged within the locked version's release line
(same major; same minor for 0.x, as `^` ranges do). The report names the newest overall when it lies in another line.
33 of 34 are now "ahead"; the 34th is a package this registry does not know at all (most likely published after the
snapshot).

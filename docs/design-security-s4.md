# S4: no lockfile bypass without a supply-chain warning

Status: **implemented**. From `docs/security-review.md`.

## Problem

When the registry is behind the lockfile (finding D), two user-facing places suggest a workaround with no warning:

| Where | Text today |
|---|---|
| README, *Install* | "…or install the newest compatible versions without changing the lockfile: `npm install --no-package-lock --no-save`" |
| `check-lock`'s hint | "…install the newest compatible versions instead: npm install --no-package-lock --no-save" |

`--no-package-lock` ignores the lockfile's pinned versions **and its integrity hashes**, installing whatever is newest
in each range at that moment. That includes a version published minutes ago by a compromised maintainer account, a
common way npm supply-chain attacks spread. The lockfile exists precisely to prevent that. The advice presents the bypass
as an equal alternative.

(`docs/design-finding-d-lockfile.md` also describes it as advice. The other mentions in `docs/` are records of what this
project did in its sandbox.)

## Proposed fix

**Order of remedies, in both places:**
1. **Use an up-to-date registry**, keeping the lockfile's guarantees:
   `npm ci --registry=https://registry.npmjs.org/`, or refresh or repoint the mirror.
2. **Only as a last resort**, the bypass, with the warning stated plainly: it skips the lockfile's pinned versions and
   integrity checks; use it only in a throwaway environment; never ship, publish or load into your browser a build made
   that way; return to `npm ci` once the registry has caught up.

**`check-lock`'s hint** becomes, after the existing "registry looks behind" line:

```
Fix: use an up-to-date registry, which keeps the lockfile's integrity checks:
  npm ci --registry=https://registry.npmjs.org/    (or refresh your mirror)
Last resort, throwaway environments only: npm install --no-package-lock --no-save
  skips the lockfile's pinned versions and integrity checks, so a newly published malicious version could be
  installed. Do not ship or load a build made this way.
```

**README, *Install*:** the same two-step advice, in prose.

**`docs/design-finding-d-lockfile.md`:** a one-line note that the advice was superseded by S4, pointing here.

**A guard test** keeps it that way: any user-facing mention of `--no-package-lock` (README, `check-lock` output) must
sit in the same paragraph or block as the words "integrity" and "throwaway".

## Alternatives considered

- **Remove the bypass from the advice entirely.** Cleaner, but people stuck behind a lagging corporate mirror will
  find it anyway, without the warning. Better to state it with the risk.
- **A `check-lock --installed` mode** that lists what a bypass install actually put into `node_modules` compared with
  the lockfile. Useful for judging exposure afterwards, but it is a new feature, not needed to fix S4. It can be
  proposed separately.

## Scope

- `README.md`, `scripts/lockcheck.ts` (hint text only), `docs/design-finding-d-lockfile.md` (note).
- The existing test that asserts the old hint (`tests/lockcheck.test.ts`: "…install…--no-package-lock…") is updated,
  as this design changes that text.
- No code behaviour change, no UI change. **Step 3 (mockups) skipped, if you agree.**

## Result (step 6)

`check-lock`'s hint and the README now give `npm ci --registry=https://registry.npmjs.org/` first, and the bypass only as
a last resort with its warning. A guard test (`tests/docs-advice.test.ts`) fails if the README ever mentions
`--no-package-lock` without "integrity", "throwaway" and the `npm ci --registry` remedy before it.

Noted during step 5: one end-to-end `check-lock` test timed out once (5 s) in a combined run and could not be
reproduced in 9 further runs (256–612 ms). Those tests now allow 20 s, because they start a Node process. The tool's own
missing fetch timeout is S6(a).

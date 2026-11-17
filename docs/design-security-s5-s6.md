# S5 + S6: `check-lock` transport trust and hardening

Status: **implemented**. From `docs/security-review.md`.

Both are in `scripts/check-lock.ts` / `scripts/lockcheck.ts`, so they are designed together.

## S5: plain-`http` registries (and disabled TLS checks) are trusted

Over `http`, anyone on the network path can rewrite registry responses, so an "all entries match" report proves
nothing. The same holds over `https` when TLS certificate checking is switched off (`NODE_TLS_REJECT_UNAUTHORIZED=0`,
sometimes set to get past corporate proxies).

**Fix:**
- The registry counts as **unauthenticated** if its URL is `http:` and its host is not the local machine (`localhost`,
  `127.0.0.1`, `[::1]`), or if `NODE_TLS_REJECT_UNAUTHORIZED` is `0`.
- In that case a prominent warning is printed **before** the report: "responses can be forged in transit, so a clean
  result proves nothing".
- The exit code is at least **2** ("could not check"), even if everything matched. An integrity check that cannot be
  trusted must not pass a CI gate.
- Local registries (a test server, a local mirror on the same machine) are unaffected.

## S6: hardening

| # | Problem | Fix |
|---|---|---|
| a | No timeout: a registry that stalls hangs the tool (one end-to-end test timed out once in S4, possibly this) | Every request is aborted after a timeout, 30 s by default, `--timeout-ms <n>` to change it. A timed-out package is listed under "could not check", not "missing" |
| b | Package names from the lockfile go into the URL after replacing only the first `/`: a crafted name can reach other paths on the registry host | Names are validated **before** any request: npm's naming rule, legacy uppercase allowed (real packages such as `JSONStream` have it), an optional single `@scope/`, at most 214 characters. An invalid name is listed under "could not check: invalid package name" and is **never requested** |
| c | `versions[version]` is a normal property lookup: a lockfile version named `constructor` counts as published (verified) | `Object.hasOwn`. The packument's `versions` must be a plain object |
| d | A registry could return a non-string integrity value; today that counts as "matches" | A non-string integrity, when the lockfile has one, is reported as an **integrity mismatch**, shown through `printable(String(…))` |

### Not addressed (noted)

**Response size:** a hostile registry could send a huge body. The tool is a developer command with a timeout (S6a), not
a service. Left as is.

## Scope

- `scripts/lockcheck.ts`: name validation (S6b), `Object.hasOwn` and a plain-object check (S6c), the integrity type
  (S6d), the "could not check" reasons.
- `scripts/check-lock.ts`: the timeout and `--timeout-ms` (S6a); the unauthenticated-registry warning and exit code (S5).
- README: one sentence each for the warning and `--timeout-ms`.
- **No UI change: step 3 (mockups) skipped, if you agree.**

## Risks

- A CI job that deliberately uses a plain-`http` internal registry will now get exit code 2. That is intended (the check
  cannot be trusted there), and the message says why.
- Name validation must not reject real names. It is checked against all 196 names in this project's lockfile, and
  legacy uppercase is allowed.

## Result (step 6)

- **S6b demonstrated before the fix:** a lockfile entry named `../../-/user/org.couchdb.user:admin` made `check-lock`
  request `/..%2f../-/user/org.couchdb.user:admin` (the registry's user-account endpoint). Now such a name is reported
  as invalid and never requested.
- **S6a:** a registry that never answers now gives "could not check … timed out after 300 ms" (exit 2) in well under a
  second with `--timeout-ms 300`. Before, it hung until it was killed.
- **S5:** with `NODE_TLS_REJECT_UNAUTHORIZED=0` (or remote plain http), a `WARNING:` comes first and the exit code is 2,
  even when everything matches.
- A real run against the public `https` registry is unchanged (no warning; 233 checked, 34 missing, exit 1).

Test update within the design: S1's hostile-data test used a hostile package **name** for its missing-version case.
Under S6 that name is rejected before any request, so the test now uses a validly named package with hostile
version/integrity strings (keeping the coverage of hostile registry version keys), plus the hostile name as a separate
entry, reported under "could not check".

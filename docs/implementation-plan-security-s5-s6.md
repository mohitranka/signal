# Implementation plan: S5 + S6 (`check-lock` transport trust and hardening)

Status: **implemented**.
Design: `docs/design-security-s5-s6.md` (approved; step 3 skipped: no UI change).

Working agreement as before: tests first, confirmed failing for the intended reason; smallest change; full suite,
typecheck and build; one commit; report.

## Change (one task)

`scripts/lockcheck.ts` (pure):
- `isValidPackageName(name)`: letters (legacy uppercase allowed), digits, `-._~`; not starting with `.` or `_`; an
  optional single `@scope/`; 1–214 characters.
- `checkLock`:
  - an invalid name → "could not check: invalid package name", **not requested**;
  - a packument whose `versions` is not a plain object → "could not check: malformed registry response";
  - version lookup with `Object.hasOwn`;
  - a non-string registry integrity → mismatch (shown as `printable(String(value))`).
- `registryTrust(url, env)` → `null` (trusted) or the reason: plain `http` to a non-local host, or
  `NODE_TLS_REJECT_UNAUTHORIZED=0`. Local: `localhost`, `127.0.0.1`, `[::1]`.
- `formatReport(result, { untrusted?: string })`: with a reason, a `WARNING:` block comes first, and the exit code is at
  least 2.

`scripts/check-lock.ts`:
- `--timeout-ms <n>` (positive integer, default 30000); each request carries `AbortSignal.timeout(n)`. A timeout becomes
  "timed out after n ms".
- Passes `registryTrust(registry, process.env)` to `formatReport`.

README, *Install* paragraph: the warning and `--timeout-ms`, one sentence each.

## Tests first (in `tests/lockcheck.test.ts`)

| # | Case | Expected before fix |
|---|---|---|
| 1 | `isValidPackageName`: accepts `ws`, `@babel/parser`, `JSONStream`, `lodash.merge`, `a-b_c~d`, and all 196 names in this project's lockfile; rejects `''`, `../x`, `a/b`, `@a/b/c`, `@/x`, `x y`, `%2e%2e`, `.hidden`, `_private`, 215 characters | fails (missing) |
| 2 | An invalid name in the lockfile is reported under "could not check" and **never requested** | fails |
| 3 | Versions `constructor` and `__proto__` (never published) are reported missing, not ok | fails |
| 4 | A packument whose `versions` is an array or a string → "could not check: malformed registry response" | fails |
| 5 | A non-string registry integrity (a number, an object) is reported as an integrity mismatch | fails |
| 6 | `registryTrust`: plain `http` to a remote host → reason; `http://localhost`, `127.0.0.1`, `[::1]` → trusted; `https` → trusted; `https` with `NODE_TLS_REJECT_UNAUTHORIZED=0` → reason | fails (missing) |
| 7 | `formatReport` with an untrusted registry: the warning comes first; "all entries match" only appears after it; exit code 2, also when entries are missing | fails |
| 8 | **End to end:** a registry that never answers + `--timeout-ms 300` → "could not check … timed out", exit 2, finishes in well under the test's time limit | fails (hangs until the test limit) |
| 9 | **End to end:** `NODE_TLS_REJECT_UNAUTHORIZED=0` with a registry that matches everything → the warning, exit 2 | fails (exit 0) |
| 10 | **End to end:** an invalid name in the lockfile never reaches the registry (server log) and is reported | fails |

## Done when

All pass; full suite, typecheck and build green; a real `npm run check-lock` in the sandbox (public `https` registry)
still gives the same report as before (no warning; 34 missing).

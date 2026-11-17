# Implementation plan: local CLI bridge

Status: **implemented** (T1–T8). The real-CLI manual checklist (README, design §11) is for you to run.
Design: `docs/design-bridge.md` (approved). Mockups: `docs/mockups/bridge/` (approved, with: "Plan" cost tile, chip
`claude-code · sonnet`, "Bridge token" label and disabled price fields, token printed in full once, output ≤ 78
columns, `aria-describedby` on the Provider select). Findings F and G, which the design queued before this work, are done.

## 0. Ground rules for this work

- **No real CLI here.** Every test uses **fake CLIs**: small Node scripts named `claude` and `codex`, put first on
  `PATH` in a temp folder. The flags and output formats they mimic are the ones the design lists as **unverified**. All
  CLI-specific knowledge (flags, output parsing, login-error wording) sits in **one adapter table**
  (`bridge/adapters.ts`), so a correction after your manual check (design §11) is a one-file change.
- **Fake CLIs are steered by a file next to them** (`behaviour.json`), not by environment variables: the bridge
  scrubs the environment (I2), so an env switch would not reach them. They also record what they received (argv,
  stdin, environment, working folder, open file listing) to a log next to them, so the tests can check I1, I2 and I7.
- **Node built-ins only** (design §4). No new dependency, no lockfile change (the stale registry, finding D).
- Bridge tests run in vitest's `node` environment, on a real `127.0.0.1` socket with a random port.
- Platforms: **Linux and macOS**. On Windows the bridge runs only if the CLI resolves to a `.exe` (running `.cmd`
  shims needs a shell, which I7 forbids), and a timeout kills only the CLI process, not its children (design §12 limit).
  It says so at startup.

## 1. Layout

```
bridge/
  main.ts        entry: arguments, token, self-test, server, Ctrl-C cleanup          (npm run bridge -- …)
  config.ts      argument parsing and limits
  token.ts       create / load / rotate the token file; constant-time check
  request.ts     "is this exactly Signal's request?" → PostInput, or a reason (I6)
  server.ts      node:http server: Host, Origin, routing, token, body, model, queue, responses (I3–I5, I8)
  adapters.ts    per-CLI table: argv, stdin, output parsing, version/help probe, login-error detection
  runner.ts      spawn without a shell, scrubbed env, fresh temp folder, caps, timeout, process-group kill (I1, I2, I7, I8)
  selftest.ts    startup checks: version + flags, login, tool canary (fail closed)
  log.ts         terminal output (≤ 78 columns) and per-request log lines without post text (I9)
```

`package.json`: `"bridge": "esbuild bridge/main.ts --bundle --platform=node --format=esm --outfile=.eval-build/bridge.mjs
--log-level=warning && node .eval-build/bridge.mjs"` (same pattern as `eval` and `check-lock`). `tsconfig.json`
includes `bridge`. The bridge imports Signal's own `src/classifier/prompt.ts`, `src/shared/post.ts`,
`src/classifier/parse.ts` and `src/classifier/queue.ts` (design §4).

## 2. Decisions inside the approved design (say if you disagree)

| # | Decision | Why |
|---|---|---|
| D1 | The bridge **returns only the validated classification**: the CLI's text goes through Signal's own `parseClassification`, and the response content is that clean object re-serialised (decision, confidence, reason ≤ 200 chars, six signals). Anything else → `502`. | Design §6.4 says output is validated; returning the cleaned object also means a manipulated CLI answer can never carry anything but a classification back. |
| D2 | Request check order: Host → Origin → method/path (`OPTIONS` → `204`, unknown path `404`, wrong method `405`) → token → `Content-Type: application/json` (`415`) → body ≤ 64 KB (`413`) → JSON → model → messages. | Preflights carry no token, so `OPTIONS` comes before the token check, and still gets no CORS headers. The `Content-Type` check also blocks the "simple" form/text requests a web page can send without a preflight. |
| D3 | A request with **no `Origin`** is allowed (curl, for testing); a token is still required. Any `chrome-extension://` origin is allowed. | As designed (I5). Pinning one extension id would need the user to look it up; not proposed. |
| D4 | **Client gone → work cancelled.** If Signal aborts (cancel all, navigation), the queued job is dropped or the running CLI's process group is killed. | Saves subscription quota; the design's timeout already kills process groups. |
| D5 | `429` carries `Retry-After` between 1 and 30 s (estimated from recent call times and queue position). | Signal's client retries only when `Retry-After` ≤ 30 s. |
| D6 | Error bodies are OpenAI-shaped `{"error":{"message":…}}`, so Signal's existing error line shows them: 401 "Paste the token printed by the bridge into “Bridge token”."; 400 "This bridge serves claude-code/sonnet; set Model to that."; 400 "Not a Signal classification request."; 502 / 504 short causes without CLI output. | Matches mockup B; no popup logic needed for these. |
| D7 | Arguments: `--cli claude|codex` (required), `--model` (default `sonnet` for claude; **required** for codex, whose default model name the bridge cannot know), `--port` (8791), `--concurrency` (1, max 4), `--queue` (8, max 64), `--timeout` seconds (60, max 300), `--new-token` (rotate). Model names: letters, digits, `. _ : - [ ]`, ≤ 64 chars. | Bounded values; model names go into argv and into the served id. |
| D8 | Token file: `$XDG_CONFIG_HOME/signal-bridge/token` (else `~/.config/…`; `%APPDATA%\signal-bridge\token` on Windows). Folder `0700`, file `0600`, created exclusively. **If the file is readable by others, the bridge refuses to start** and prints the `chmod` fix (POSIX). Token: 32 random bytes, base64url (43 characters). Comparison: SHA-256 of both, then `timingSafeEqual`. | I4, fail closed. |
| D9 | Environment allow-list for the CLI: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_*`, `TZ`, `TMPDIR`/`TMP`/`TEMP`, `XDG_*`, `DBUS_SESSION_BUS_ADDRESS` (Linux keyring), proxy and CA variables (`HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`), the CLIs' own folders (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`), and on Windows `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `SystemRoot`, `PATHEXT`. Everything else is dropped, including every `*_API_KEY`, `ANTHROPIC_*`, `OPENAI_*`, `AWS_*`, `GOOGLE_*` and `CLAUDE_CODE_USE_*`. | I2 by allow-list, not block-list. |
| D10 | Canary (design §6.3), sent through the **same path as a real post** (a `PostInput` inside Signal's prompt): the temp folder holds `CANARY.txt` (secret A) and a randomly named file (secret B). The post asks the model to read `CANARY.txt`, list the folder and read every file, and to create `ran.txt` by running a command. **Fail** if the answer contains A, B or the random file name, or if any new file appears in the folder. | Read, list and run/write each leave distinct evidence. |
| D11 | Self-test output and CLI error text: during the self-test only (a fixed harmless post, no user data), the first line of the CLI's stderr may be shown, passed through Signal's `printable()` and cut to 70 characters. While serving, CLI stderr is **never** printed (I9). | Useful for "not logged in" without ever printing post text. |

**Limits stated in the README** (not fixable in the bridge): the canary is strong evidence, not proof (a model that
declines to use an available tool would pass it; the flags are the primary control); user-level CLI settings (for
example an API-key helper in Claude Code's user settings) are outside the bridge's control; Windows as above.

## 3. Tasks (one commit each, tests first)

### T1 Request validation: `bridge/request.ts` (I6)
| # | Test | Red before |
|---|---|---|
| 1 | The exact body Signal's client sends (`buildMessages` for text only, with `quoted`, with link title/description, at the `LIMITS` edges) is accepted and yields the same `PostInput` | module missing |
| 2 | Rejected: other system prompt (one character changed), extra or missing message, roles swapped, user text outside the template, template with extra text after `</post_json>` | same |
| 3 | Rejected: post not in Signal's normalised form (`prepareInput(x)` ≠ x: too long, extra whitespace), extra keys, non-string fields, `text` missing | same |
| 4 | `model` ≠ served id → reason names the served id; `temperature`, `max_tokens`, `response_format` accepted and ignored | same |

### T2 Token: `bridge/token.ts` (I4)
| # | Test | Red before |
|---|---|---|
| 5 | First start creates the folder `0700` and file `0600` with 43 base64url characters (32 bytes); a second start reads the same token and reports "not new" | missing |
| 6 | File readable by group/others → refuses, naming the file and the fix; `--new-token` replaces it (still `0600`) | missing |
| 7 | `checkToken`: right token true; wrong, empty, longer, shorter, non-ASCII → false, never throws; uses `timingSafeEqual` on digests | missing |

### T3 HTTP server with a stub runner: `bridge/server.ts` (I3, I4, I5, I8; D2–D6)
| # | Test | Red before |
|---|---|---|
| 8 | Listens on `127.0.0.1` only (address check) | missing |
| 9 | Host `evil.example`, `127.0.0.1:<other port>`, missing Host → `403`; `localhost:<port>` and `127.0.0.1:<port>` accepted | missing |
| 10 | Origin `https://www.linkedin.com` / `null` → `403`; `chrome-extension://abc` and no Origin accepted | missing |
| 11 | **No `Access-Control-*` header on any response**, including `OPTIONS` (`204`) and errors | missing |
| 12 | `404` other paths, `405` other methods, `401` missing/wrong token (message D6), `415` non-JSON content type, `413` over 64 KB (connection not read to the end), `400` bad JSON / wrong model / not Signal's request | missing |
| 13 | Success: OpenAI shape, `content` = re-serialised validated classification, `usage` from the runner; runner text that is not a classification → `502`; runner timeout → `504`; runner failure → `502` with a short cause | missing |
| 14 | Bounded: with concurrency 1 and queue 2, the 4th concurrent request gets `429` with `Retry-After` in [1, 30]; the queue drains in order afterwards | missing |
| 15 | Client disconnects: a queued job never starts; a running job's abort signal fires | missing |
| 16 | **End to end with Signal's real client** (`classifyPost` from `src/classifier/client.ts`, Node `fetch`) against the server: classification and token counts arrive; with a wrong token Signal's error reads "Authentication failed (401). Paste the token…" | missing |

### T4 CLI runner and adapters: `bridge/runner.ts`, `bridge/adapters.ts` (I1, I2, I7, I8)
| # | Test | Red before |
|---|---|---|
| 17 | Claude argv (from the fake's log) is exactly the design's: `-p --output-format json --model <m> --system-prompt <Signal prompt> --tools "" --strict-mcp-config --mcp-config {"mcpServers":{}} --setting-sources user` (+ no-session flag when `--help` lists it); Codex: `exec --json --model <m> --sandbox read-only --skip-git-repo-check --cd <tmp> -` | missing |
| 18 | **Post text never in argv**; stdin carries it (Claude: the user message; Codex: Signal's prompt, then the user message). A post containing `$(touch pwned)` and `; rm -rf` creates nothing (no shell) | missing |
| 19 | Environment: with `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_BASE_URL`, `AWS_SECRET_ACCESS_KEY` and a random `FOO` set in the bridge's environment, the fake sees none of them; it sees `PATH` and `HOME` | missing |
| 20 | Working folder: a fresh **empty** temp folder per call, different each call, deleted afterwards (also after a failure or timeout) | missing |
| 21 | Timeout kills the **process group**: a fake that starts a sleeping grandchild leaves no process behind; result "timeout" | missing |
| 22 | Output over 1 MB (stdout or stderr) → process killed, result "output too large" | missing |
| 23 | Parsing: Claude JSON (`result`, `is_error`, `usage` incl. cache tokens); Codex JSONL in both known event shapes (`item.completed`/`agent_message` + `turn.completed` usage, and the older `msg` shape); non-zero exit, empty or garbled output → failure with a short cause; "not logged in" wording → `login` cause | missing |

### T5 Startup self-test and terminal output: `bridge/selftest.ts`, `bridge/log.ts` (I1, I9)
| # | Test | Red before |
|---|---|---|
| 24 | Version found and all required flags in `--help` → "ok"; a missing flag → refuses naming it ("missing --tools") | missing |
| 25 | Login probe: fake answers → ok with time; fake reports not logged in → refuses with the `claude login` / `codex login` hint and the "API key is ignored on purpose" line | missing |
| 26 | Canary (D10): clean fake → passed. Fakes that (a) read `CANARY.txt`, (b) list the folder, (c) write `ran.txt` → each **FAILED** with the matching reason, bridge does not listen | missing |
| 27 | Terminal output of each mockup scenario: every line ≤ 78 columns; token printed in full only when newly created, otherwise only its location | missing |
| 28 | **Logs never contain post text** (I9): serve requests whose posts contain a unique marker, including failing and timing-out ones, with a fake that echoes its input to stderr; the marker appears nowhere in the bridge's output | missing |

### T6 Entry point and npm script: `bridge/main.ts`, `bridge/config.ts`
| # | Test | Red before |
|---|---|---|
| 29 | Argument parsing: defaults, bounds, `--cli` required, codex requires `--model`, bad model names rejected, unknown flags rejected with usage | missing |
| 30 | Smoke test: `npm run bridge` (built bundle) with the fake Claude on `PATH` starts, serves one classification over HTTP, and on SIGINT exits 0 with its temp folders removed | missing |

### T7 Popup (`public/popup.html`, `public/popup.css`, `src/popup/popup.ts`), per the approved mockups
| # | Test | Red before |
|---|---|---|
| 31 | Provider has the option "Local CLI bridge (Claude Code / Codex)" (value `http://127.0.0.1:8791/v1`, added after "Ollama (local)"); choosing it fills the endpoint, concurrency 1 and timeout 90 s, and shows the help line (start command in `<code>`, built with DOM, no HTML parsing) linked by `aria-describedby` | missing |
| 32 | Bridge mode (preset chosen, or model starting `claude-code/` / `codex/`): the key label reads "Bridge token"; price fields are disabled with "not used", and **Save leaves stored prices untouched** (not sent) | missing |
| 33 | Chip: `claude-code · sonnet` for bridge models (other models unchanged: last path segment) | missing |
| 34 | Cost tile: "Plan", tooltip "Plan · Billed to your subscription via the local bridge · no per-token cost"; tokens tile unchanged | missing |
| 35 | Test connection in bridge mode: success ends "· via Claude Code subscription" / "· via Codex subscription"; `network` → "Could not reach the bridge at 127.0.0.1:8791. Is it running? npm run bridge -- --cli claude" (host, port and CLI taken from the settings); `rate_limit` → "The bridge is busy (one post at a time); Signal retries automatically."; `auth` / `config` show the bridge's own message (D6) | missing |
| 36 | Contrast (finding G's test): the help line and its `<code>` added to the computed table, ≥ 4.5:1 light and dark | missing |

Browser checks after T7 (outside the suite, reported): finding F's `layout-check.py` and finding G's
`contrast-check.py` on the built popup, plus a render with the bridge preset selected compared to the approved mockup.
Deviation from the mockup, to confirm: the mockup had a `.tile.sub` rule (13 px value) for the cost tile; after finding
F, "Plan" fits at the normal 14 px, so no special rule is added.

### T8 Documentation
README section: what the bridge is, how to start it, the Signal settings, the terms-of-service note (design §10), the
manual checklist (design §11), the limits (§2 above). `docs/design-bridge.md` status → implemented. No test (docs),
except that the README's start command matches the npm script name (an existing docs test pattern,
`docs-advice.test.ts`).

## 3b. Step 5 (tests first): where the tests are

| File | Plan items | Tests | Red before |
|---|---|---|---|
| `tests/bridge-request.test.ts` | T1 #1–4 | 13 | 13 |
| `tests/bridge-token.test.ts` | T2 #5–7 | 13 | 13 |
| `tests/bridge-server.test.ts` | T3 #8–16 | 17 | 17 |
| `tests/bridge-runner.test.ts` | T4 #17–23 | 18 | 17 (the "no shell anywhere" source scan passes on the stubs; it guards later code) |
| `tests/bridge-selftest.test.ts` | T5 #24–27 | 13 | 13 |
| `tests/bridge-main.test.ts` | T5 #27–28 (start-up output, logs), T6 #29–30, T8 README | 13 | 13 |
| `tests/popup-bridge.test.ts` | T7 #31–36 | 14 | 13 (today's wording for other providers passes: a guard) |

Shared: `tests/bridge-helpers.ts` (fakes on `PATH`, Signal's exact body, raw HTTP with settable Host/Origin) and
`tests/fixtures/fake-cli.cjs` (the fake `claude`/`codex`). `bridge/*.ts` exist as **typed stubs that throw "not
implemented"**, so each test loads and fails on its own (instead of whole files failing to import), and typecheck is
clean.

Small choices made while writing the tests (within the plan): the preset's help line is static HTML in
`popup.html`, shown or hidden by the script (no HTML built at run time); `--port 0` means "any free port" (used by the
tests); a CLI missing from `PATH` and a port already in use exit with code 1, bad arguments with code 2.

## 4. Done when

All tests above red first, then green; full suite, typecheck and build green; no lockfile change. Browser checks after
T7 pass. The manual checklist (design §11) is handed to you, since only you can run the real CLIs.

## Step 6 results

| Task | Commit | Tests |
|---|---|---|
| T1 request validation | `b8f3d73` | 13 |
| T2 token | `a48cf54` | 13 |
| T3 HTTP server | `4f13554` | 17 |
| T4 runner and adapters | `7e78215` | 18 |
| T5 self-test | `0e56dbd` | 13 |
| T6 entry point | `1eef989` | 13 (incl. the README check, green with T8) |
| T7 popup | `b4c0adc` | 14 |
| T8 README | (this commit) | – |

Suite: 668 passed (also with `SIGNAL_TEST_SLOW_HASH=25`), typecheck and build green, no lockfile change. Mutation
checks (code deliberately broken, tests must fail): removing the rebuilt-request comparison (3 T1 tests fail), the
process-group kill (the grandchild test fails), the environment allow-list (both environment tests fail).

Browser checks on the built popup: finding F `layout-check.py` 8/8, finding G `contrast-check.py` 0 failures (own scan
and axe), and `docs/mockups/bridge/as-built/check.py` with the bridge preset (light/dark × two fonts: no overflow or
truncation, contrast 0, axe 0, help line is the select's accessible description); the render matches the approved
mockup.

Mistakes in my own tests, found while implementing and fixed:
- The CORS test expected `204` for a preflight from a web origin, contradicting D2 (Origin is checked first, so it gets
  `403`; still no CORS headers). Now follows D2.
- The smoke test read the token as soon as "Listening" appeared, before the token line was printed (a race). It now
  waits for the last start-up line.
- The "no shell" source scan also matched `RegExp.prototype.exec`. It now checks what is imported from
  `child_process` (only `spawn`) and that `shell: true` never appears.

Found by running `npm run bridge` by hand with the fake CLI: the self-test values were one column left of the mockup's
alignment. Fixed, with a test pinning the column. Also fixed in the README: the repeat index key is `repeats:v3` (since
security S2), not `repeats:v2`.

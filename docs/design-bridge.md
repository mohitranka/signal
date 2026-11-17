# Design: local CLI bridge (classify with a Claude or ChatGPT subscription)

Status: **implemented** (design approved in step 2, mockups in step 3; plan and results: `docs/implementation-plan-bridge.md`). Step-1 answers: the recommendations, accepted as given (Q1–Q10).

## 1. Goal

A small server on the user's own machine. It receives Signal's classification requests and answers them by running
the user's **already logged-in** Claude Code CLI (`claude`) or Codex CLI (`codex`), so a Claude or ChatGPT
**subscription** classifies posts: no API key, no API billing.

## 2. What cannot be verified here (read first)

Neither CLI is installed in this build environment, and no subscription login is possible here. Therefore:
- **The CLI flag names and output formats below come from their documentation as I know it, and are unverified.** The
  bridge checks them at startup (§6) and refuses to run if they are missing.
- **Whether each CLI can really run with every tool disabled cannot be confirmed here.** The bridge proves it at
  startup with a canary test (§6.3) before it serves anything. If a CLI fails that test, the bridge refuses that CLI.
  **Codex may fail it:** its read-only sandbox still lets it *read* files. In that case Codex is unsupported until a
  tool-free mode is found.
- Tests use **fake CLIs** (small scripts on `PATH` that mimic each CLI's output and behaviour). Real-CLI verification is
  a manual checklist for the user (§11).

## 3. Invariants (hard rules; each has tests)

| # | Invariant |
|---|---|
| I1 | **No tools.** The CLI runs with every built-in tool disabled, no MCP servers, no project settings, in a fresh empty temporary folder, with no session saved. The bridge refuses to start unless the startup self-test (§6) proves it. |
| I2 | **No API key from the bridge.** `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and similar are **removed** from the CLI's environment. (Reworded by security B4: this does not make billing a subscription if the CLI itself is logged in with, or configured with, an API key; the bridge says so at start.) |
| I3 | **Local only.** Listens on `127.0.0.1` only. Requests whose `Host` is not `127.0.0.1:<port>` / `localhost:<port>` are rejected (DNS rebinding). |
| I4 | **Token.** Every request needs `Authorization: Bearer <token>`: 32 random bytes, created on first start, stored in a file readable only by the user, compared in constant time. |
| I5 | **Not for web pages.** Requests with an `Origin` other than `chrome-extension://…` are rejected. No CORS headers are ever sent, so a page's preflight fails as well. |
| I6 | **Classification only.** The bridge accepts only Signal's own request shape. It parses out the post (`PostInput`, re-validated with Signal's size limits) and **rebuilds the prompt itself** from Signal's own prompt code. Any other prompt is rejected, so a leaked token cannot turn the subscription into a general-purpose proxy. |
| I7 | **No shell, no argv leaks.** The CLI is started with an argument array (never a shell). Post text goes in on **stdin**, never on the command line (visible to other local users via `ps`). |
| I8 | **Bounded.** One CLI process at a time by default (`--concurrency`), a short queue (`--queue`), then `429` with `Retry-After`. A per-call timeout kills the whole process group. CLI output is capped (1 MB). |
| I9 | **Private logs.** Logs carry counts, timings and errors only: never post text, prompts or model output. |

## 4. Architecture

```
Signal (service worker) --HTTP, OpenAI chat-completions shape--> bridge (127.0.0.1:8791) --spawn, stdin--> claude | codex
          ^  token in the existing "API key" field                      |  validates, queues, rebuilds prompt
          +-------------- { choices: [{ message: { content } }], usage } +  parses CLI output, returns JSON
```

- **In this repo**, under `bridge/`, in TypeScript with no dependencies (Node built-ins only), built and run the way
  `npm run eval` and `check-lock` are: `npm run bridge -- --cli claude [--model sonnet] [--port 8791]`.
- It reuses Signal's code: `src/classifier/prompt.ts` (the prompt, `PROMPT_VERSION`), `src/shared/post.ts` (`LIMITS`,
  `isPostInput`, `prepareInput`), `src/classifier/parse.ts` (`printable`) and `src/classifier/queue.ts` (the queue).

## 5. HTTP API (what Signal already speaks)

- `POST /v1/chat/completions`: the only endpoint. The request body is what `src/classifier/client.ts` sends
  (`model`, `messages: [system, user]`, `temperature`, `max_tokens`, optional `response_format`). Checks, in order:
  1. Host (I3);
  2. Origin (I5);
  3. token (I4);
  4. body ≤ 64 KB, JSON;
  5. `model` must equal the bridge's model id (§7);
  6. the messages must be **exactly** Signal's: the system message equals the current prompt, and the user message
     matches Signal's template with a valid `PostInput` inside (I6).

  The response is an OpenAI-shaped `choices[0].message.content`, with `usage` when the CLI reports tokens.
- Errors use Signal's existing handling:
  - `401` bad or missing token → the popup says "Authentication failed";
  - `400` wrong model or not a Signal request (with a short reason);
  - `429` queue full, with `Retry-After` → Signal's retry logic honours it;
  - `502` CLI failed or returned no usable text;
  - `504` CLI timed out.
- `OPTIONS`: `204` with **no** CORS headers.
- Any other path or method: `404` / `405`.

## 6. Running the CLIs safely

### 6.1 Claude Code (flags to verify, §2)
`claude -p --output-format json --model <m> --system-prompt <Signal prompt> --tools "" --strict-mcp-config
--mcp-config '{"mcpServers":{}}' --setting-sources user` (plus a no-session-persistence flag if the installed version has
one). The post message comes in on stdin. The JSON result gives the text (`result`), `is_error`, and `usage` (input/output
tokens).

### 6.2 Codex (flags to verify, §2)
`codex exec --json --model <m> --sandbox read-only --skip-git-repo-check --cd <tmp> -` (the prompt comes in on stdin:
Signal's instructions, then the post message). Codex has no flag to replace its system prompt, so Signal's instructions
go first in the prompt. The JSONL events give the final agent message and the token usage. The sandbox stops writes and
network access, but **not reads**, so §6.3 decides whether Codex is usable.

### 6.3 Startup self-test (fail closed)
Before listening:
1. **Version and flags:** run `<cli> --version` and `--help`. Every flag the bridge needs must appear, or it exits
   with a clear message.
2. **Login:** one tiny classification of a fixed harmless post. It must return parseable text. If it fails, the message
   suggests `claude login` / `codex login`.
3. **Tool canary:** a fresh temp folder holds `CANARY.txt` with a random secret. The CLI is asked (exactly as an injected
   post would try) to read that file, list the folder and run a command. If the secret, the file listing or the command's
   output appears in its answer, **tools are not off: the bridge exits** and names the CLI.

This costs about 2 subscription calls per start.

### 6.4 Each call
A fresh empty temp folder (deleted afterwards), a scrubbed environment (I2: a minimal allow-list of `PATH`, `HOME`, locale
and the CLI's own config variables), stdin with the prompt, stdout and stderr capped, a timeout (default 60 s) that kills
the process group, and exit status plus output validated before anything is returned.

## 7. Model identity and caching

The bridge serves one CLI and one model, named `claude-code/<model>` or `codex/<model>` (e.g. `claude-code/sonnet`). Signal
uses the model string in its cache keys, so verdicts from different CLIs or models never mix. A request naming another
model gets `400` with "this bridge serves claude-code/sonnet; set Model to that" (visible through Test connection).

## 8. Extension changes (small)

- Popup → Model → Provider: a new preset, **"Local CLI bridge (Claude Code / Codex)"**. It fills
  `http://127.0.0.1:8791/v1` and prompts for the bridge's token in the existing API-key field and the model id it prints.
- Host permission: already optional for `http://127.0.0.1/*`, and requested on Save as today. **No manifest change.**
- Cost: for models named `claude-code/…` or `codex/…`, the popup's cost tile shows **"subscription"** instead of a dollar
  estimate. Tokens are still shown if the CLI reports them.
- Timeout: CLI calls are slow (seconds). The preset sets Signal's timeout to 90 s and concurrency to 1, to match the
  bridge's queue.

## 9. User experience

```
$ npm run bridge -- --cli claude --model sonnet
Signal bridge: checking claude 2.x … flags ok · login ok · tools off (canary passed)
Listening on http://127.0.0.1:8791/v1 · model claude-code/sonnet · 1 at a time
In Signal: Provider "Local CLI bridge", API key = <token printed once; stored in ~/.config/signal-bridge/token>
```

Ctrl-C stops it. Starting at login is out of scope.

## 10. Terms of service (README note, like LinkedIn's)

Anthropic's and OpenAI's consumer terms may limit automated or programmatic use of a subscription, and the CLIs' own
terms may too. They cannot be checked from this environment. The README will say so plainly, with the same "use at your
own discretion" framing as the LinkedIn note, and will advise checking the current terms.

## 11. Manual verification checklist (for the user, real CLIs)

1. `npm run bridge -- --cli claude`: the self-test passes (or names which flag or check failed).
2. In Signal: the preset, the token, Save, Test connection → "Connected".
3. Scroll the feed in Review mode: verdicts arrive; `usage` appears in the popup; the cost tile says "subscription".
4. Try Codex the same way: expect either success, or a refusal naming the canary check (then Codex is unsupported).

## 11b. Before implementation: findings F and G (from the mockup audit)

The browser audit (`docs/mockups/bridge/audit/`) found two issues in the **shipped** popup that the bridge's popup
changes would aggravate. They go through steps 2–6 as findings, after this design and its mockups are approved and
before the bridge is implemented:
- **F:** horizontal scrollbar and a clipped right edge when the popup is taller than 600 px on systems with classic
  scrollbars (Windows, Linux).
- **G:** light-mode contrast below WCAG AA for tile labels (4.46:1) and error lines (4.35:1).

## 12. Out of scope

Auto-start at login; several CLIs at once; remote access; Windows-specific process-group handling beyond Node's
defaults (noted as a limit); any non-classification use.

## 13. Risks

| Risk | Mitigation |
|---|---|
| CLI flags differ from these docs / change between versions | Startup probe; clear failure naming the flag; flags kept in one table in code |
| Tools not fully disabled (prompt injection reads files or runs commands) | I1 + canary self-test, fail closed; per-call empty temp dir; Codex possibly unsupported |
| Subscription usage caps / slowness | 1 at a time, queue + 429, long timeout; the popup shows failures |
| ToS | README note; the user's decision |
| A local malware process with the user's rights | Out of scope: it can already use the CLIs directly |

# Signal

*Keep the insight. Lose the noise.*

A personal Chrome extension that classifies posts in your LinkedIn feed with an LLM **you** configure, collapses confident low-quality posts (hype, doomposting, engagement bait, generic thought leadership), and subtly highlights genuinely insightful ones. No backend, no account, no telemetry.

Design rule: **a wrongly hidden good post costs more than a missed bad one.** Anything uncertain, or any failure, leaves the post exactly as LinkedIn rendered it.

> **Read this first: LinkedIn's terms.** The LinkedIn User Agreement (§8.2, checked 2026-11-13) prohibits using "browser plugins and add-ons" to "scrape or copy the Services" and to "overlay or otherwise modify the Services or their appearance". Signal reads post text and alters the feed's appearance, so it plausibly falls under both. It is personal and unpublished, but that does not make it compliant. The practical risk is account restriction. Use it at your own discretion.

## Status (honest summary)

| | |
|---|---|
| Extension builds and loads as MV3 | Builds (`dist/`). **Not yet loaded into a real Chrome by me**: no browser was available to the build environment. |
| LinkedIn selectors | Written from public reference implementations and hand-made fixtures. **Not verified against a live feed.** Expect to touch `src/adapter/linkedin.ts` on first use. |
| Automated tests | 552 pass (`npm test`, also with `SIGNAL_TEST_SLOW_HASH`), typecheck clean. |
| Classification quality with a real LLM | **Not measured.** No API key/model was available to the build. Only a keyword baseline was run (below). Run `npm run eval` before trusting active mode. |
| Browser-level E2E smoke test | **Not done.** See "Known limitations". |

## Install

Requires Node 20+ and Chrome 116+.

```bash
npm install
npm run build          # outputs dist/
```

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select the `dist/` folder.
3. Pin the Signal icon, open it, expand **LLM provider** (next section).
4. Open `https://www.linkedin.com/feed/`. It starts in **Review mode**: posts Signal would collapse or highlight get a thin annotation (`Signal: would collapse 93%` plus the reason), posts it would keep get only a faint **Low quality** button (hover it for the verdict), and nothing is hidden.
5. Use review mode for a few days, correct mistakes with **Low quality / Worth keeping**, then open **Your corrections** in the popup to see how each sensitivity would have treated the posts you corrected. Switch to **Active** when the numbers (and the "would collapse" annotations) are ones you agree with.

After code changes: `npm run build`, then click reload on the extension card. `npm run dev` rebuilds on change.

**If `npm ci` fails with `404 Not Found`** for a package version, run `npm run check-lock`. It checks every lockfile entry against your configured registry and says which versions are missing, whether your registry looks **behind** this lockfile (a lagging mirror or snapshot; the usual cause), and whether any integrity hash differs from the registry's (a possible supply-chain problem: do not install until that is explained). If the registry is behind, point npm at an up-to-date registry, which keeps the lockfile's integrity checks: `npm ci --registry=https://registry.npmjs.org/` (or refresh your mirror). Only as a last resort, in a throwaway environment: `npm install --no-package-lock --no-save` installs the newest versions in range while skipping the lockfile's pinned versions and integrity checks, so a newly published malicious version could be installed; do not ship, publish or load into your browser a build made this way, and go back to `npm ci` once the registry has caught up. The check needs network access (each request times out after 30 s; change it with `npm run check-lock -- --timeout-ms <ms>`); registries that require authentication are not supported. Over plain `http` to another machine, or with TLS certificate checks switched off (`NODE_TLS_REJECT_UNAUTHORIZED=0`), responses can be forged in transit, so the report starts with a warning and never exits 0.

## LLM setup

Signal speaks the OpenAI chat-completions protocol (`POST {endpoint}/chat/completions`). You bring the endpoint, model and key. Nothing is preconfigured: the model field starts empty on purpose.

| Provider | Endpoint | Key | Notes |
|---|---|---|---|
| OpenRouter | `https://openrouter.ai/api/v1` | OpenRouter key | Pick any model that follows JSON instructions. |
| OpenAI | `https://api.openai.com/v1` | API key | **API billing is separate from a ChatGPT subscription**; a subscription gives no API credit. |
| Ollama (local) | `http://localhost:11434/v1` | leave blank | Run `OLLAMA_ORIGINS='chrome-extension://*' ollama serve` or Ollama may reject the extension's origin. Small local models will be noticeably worse at this task; verify with `npm run eval`. |
| Other | any OpenAI-compatible base URL | as required | vLLM, LiteLLM, etc. Non-local endpoints must be `https://`. |
| Local CLI bridge | `http://127.0.0.1:8791/v1` | the token the bridge prints | Classifies with your logged-in **Claude Code** or **Codex** CLI, normally your Claude or ChatGPT **subscription**; see *Local CLI bridge* below. |

Click **Save**: Chrome asks permission to contact that host (the extension requests it on demand rather than at install). Then **Test connection**.

Pick a cheap, fast model. Each uncached post sends roughly 0.9–1k input tokens (the instruction prompt is ≈760 tokens; chars/4 estimate) and gets ≈60–120 tokens back. Enter your model's $/1M-token prices in the popup to get a running cost estimate. Results are cached per `(prompt version, model, post content)` so repeated or reshared content is never paid for twice, and changing the model starts fresh. Long posts that are the same template as one already judged (a name, number or emoji swapped) reuse that verdict without a model call; see *Repeated templates* below.

## Local CLI bridge (Claude Code / Codex subscription)

> **Terms.** Anthropic's and OpenAI's consumer terms may limit automated or programmatic use of a subscription, and the CLIs' own terms may too. They could not be checked from the environment this was built in. Check the current terms; use it at your own discretion.

A small server on your own computer (`bridge/`, Node built-ins only) that answers Signal's requests by running your already logged-in `claude` or `codex` CLI. The bridge never passes an API key; billing is whatever your CLI is logged in with (a subscription, normally).

```bash
npm run bridge -- --cli claude                  # model defaults to sonnet → serves claude-code/sonnet
npm run bridge -- --cli codex --model gpt-5     # codex needs --model
# options: --port 8791  --concurrency 1 (max 4)  --queue 8 (max 64)  --timeout 60 (s, max 300)  --new-token
```

On the first start it prints a token once (kept in `~/.config/signal-bridge/token`, readable only by you; `%APPDATA%\signal-bridge\token` on Windows). The bridge refuses to start, naming the file or folder and the command that fixes it, if the token file is not yours or others could read or change it, or if its folder or any folder above it could be changed by other users (the same rule as for the CLI below; not checked on Windows). In Signal → **Model**, choose **Local CLI bridge (Claude Code / Codex)** (it sets concurrency 1 and a 90 s timeout), set **Model** to the id the bridge prints (e.g. `claude-code/sonnet`) and paste the token into **Bridge token**; Save, Test connection. The cost tile shows **Plan** (no per-token cost); stored prices are kept for other providers.

What it guarantees (each has tests; `docs/design-bridge.md`):
- **No tools.** The CLI runs with every built-in tool off, no MCP servers, no project settings, in a fresh empty temporary folder per call, removed afterwards. Before serving anything, the bridge checks the CLI's version and flags, makes one test classification, and runs a **canary**: a post that asks the CLI to read a secret file, list the folder and create a file. If any of that happens, the bridge refuses to start. Expect this from Codex, whose read-only sandbox can still read files: then Codex is unsupported.
- **No API key from the bridge.** The CLI gets an allow-listed environment: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and every other variable not on the list never reach it. If the CLI itself is logged in with an API key (Codex), or Claude Code's settings supply one (an `apiKeyHelper` or an API key in `~/.claude/settings.json`), that account is billed; the bridge says so at every start. Those settings, and any hooks in them (which would receive each post), are yours, not the bridge's.
- **Local and Signal-only.** It listens on `127.0.0.1`, checks the `Host` header (DNS rebinding), needs the token (constant-time check), rejects web-page origins and never sends CORS headers, and accepts only Signal's own classification request, rebuilt from Signal's prompt code and compared exactly, so a leaked token cannot use your subscription for anything else. Only the validated classification goes back.
- **Your CLI, checked, and only while unchanged.** The CLI is looked up only in absolute `PATH` folders that are not npm's `node_modules/.bin` (which `npm run` adds for the project and every parent folder; a match skipped there is shown as a note), and the CLI's own `PATH` is filtered the same way. The CLI file, its symlink, its interpreter (`#!/usr/bin/env node` → the `node` it would run) and every folder up to `/` must be owned by you or root and not writable by others (a sticky folder like `/tmp` only as a parent; group-writable only for your own primary group), or the bridge refuses to start and says which file or folder and why. The path is printed at start. Before each call the bridge checks the CLI is still the same file (path, inode, size, time); after an update it pauses (Signal gets `429` and retries), runs all start-up checks again, and resumes, or stops serving (`503`) if they fail. Not covered: a change in the instant between that check and the start of a call, and what the CLI loads from elsewhere (its packages, its settings). On an Intel Mac, Homebrew's `/usr/local/bin` is group-writable by `admin` and is refused (`chmod g-w /usr/local/bin`, or use the CLI's own installer); on macOS every user's primary group is `staff`, so a `staff`-writable folder passes although other users are in it. Windows: the location is not checked (ACLs).
- **Post text not kept by the CLI** (the CLI receives every post, and CLIs keep session history). Claude Code must support `--no-session-persistence` (always passed; older versions are refused); Codex gets `-c history.persistence="none"` when it has `-c`. After every call (also failed or timed-out ones) the bridge removes what the CLI kept of it: only entries named after that call's unique temporary folder (Claude: its folder under `~/.claude/projects/`; Codex: its session files under `~/.codex/sessions/`), nothing else. At start (and after a CLI update) it proves this: the test classification carries a random marker, and the bridge searches the CLI's own folders (`~/.claude`, `~/.claude.json`; `~/.codex`; files changed since, at most 2,000 of up to 5 MB) for it. Found (e.g. in Codex's `history.jsonl`, which is shared with your own use and never edited by the bridge) → the bridge refuses to start and names the file; `--keep-session-files` accepts that knowingly and says so on every start. Limits: only the CLI's own folders are searched; a session file exists for a moment between a call and its clean-up; with `--keep-session-files` the files stay until you delete them.
- **No shell; post text on stdin** (never on the command line, where other local users could see it).
- **Bounded.** One call at a time by default, a short queue, then `429` with `Retry-After` (Signal retries); a timeout and Signal's cancel kill the CLI's whole process group; output is capped at 1 MB.
- **Private logs.** One line per request (time, outcome, duration, tokens, queue): never post text, prompts or model output.

Limits: the CLIs' flags and output formats come from their documentation and could not be run here; the bridge checks the flags at every start and refuses to run if one is missing (`bridge/adapters.ts` holds all CLI-specific details). The canary is strong evidence that tools are off, not proof (a model that chose not to use an available tool would pass it); the flags are the primary control. Settings in your own CLI configuration (for example an API-key helper in Claude Code's user settings) are outside the bridge's control. **Windows:** supported only when the CLI is a `.exe` (a `.cmd` shim would need a shell), and a timeout stops the CLI but not processes it started. A start costs about two subscription calls (the test classification and the canary).

Pace (performance review, PB1): each post starts the CLI once (its start-up plus the model call, usually a few seconds), one at a time by default, so posts you scroll past quickly show before their verdict arrives (in Active mode a collapse can land a moment later). To allow two at a time, start the bridge with `--concurrency 2` and set Signal's **Concurrency** to 2 (Model › Advanced); this uses your subscription twice as fast, within its own limits.

Accepted limits (security review of the bridge, B8–B12): **on a shared computer**, while the bridge is not running, another user could listen on its port and receive what Signal sends there (the token and posts); run the bridge only while you use it and rotate the token with `--new-token` if in doubt (B8). A CLI already running when the bridge is killed with `kill -9` finishes on its own (B10). The token is printed once so you can paste it; if your terminal output is logged, rotate it with `--new-token` (B12). Rejected requests are read and discarded for up to 30 s, and connections are not capped: only local processes can connect (B9).

Manual check with the real CLIs (not possible in the build environment):
1. `npm run bridge -- --cli claude`: the self-test passes, or names the flag or check that failed.
2. In Signal: the preset, the model id, the token, Save, **Test connection** → "Connected … · via your Claude Code login".
3. Scroll the feed in Review mode: verdicts arrive, tokens count up, the cost tile says **Plan**, the bridge logs one line per post.
4. `npm run bridge -- --cli codex --model <model>`: expect either success or a refusal naming the canary check (or the post-text check).
5. Check how your CLI itself is logged in (its own login status or settings): with a subscription, not an API key, if you want subscription billing.
6. After a few posts: no `signal-bridge-` entries in `~/.claude/projects` (Claude) or in the session files under `~/.codex/sessions` (Codex).
7. Time a few posts: the bridge's log shows the seconds per post (the pace above).

## Using it

- **Popup**: on/off switch and a one-line status; Review / Active and Relaxed / Balanced / Strict as segmented controls (each with a one-line explanation); highlight on/off; **Model** (provider, endpoint, model, key; concurrency, timeout and prices under *Advanced*; Save and Test connection); **This session** (classified, cache hits, repeats, tokens, estimated cost; details on hover; this tab's collapsed/highlighted counts; clear cache); **Your corrections** (below); **Feedback** (list, Export JSONL, Reset). Light and dark follow the system theme.
- **Your corrections**: for each sensitivity, how many posts you marked *Worth keeping* it would have collapsed (**wrongly hidden**), and how many you marked *Low quality* it would have left up (**missed**), computed locally by the same `decide()` the feed uses and the same `score()` the evaluator uses (`src/corrections.ts`, `src/scoring.ts`). It only scores corrections classified by your current model and prompt version, lists the ones it left out and why (no stored classification, other model, older prompt), and says when a side has fewer than 10 corrections and is too few to judge.
- **Collapsed post**: a compact bar — "Post collapsed", the reason, **Show post**, **Worth keeping**. After revealing: **Hide again**.
- **Highlighted post**: a restrained green left edge; hover for the reason. No badges.
- **Expanded post** ("…more"): judged again on its full text, once (at most 3 re-judgements per post per page load). A post you revealed, or expanded to read (you clicked in it while it was visible), is never hidden by the new verdict (it shows "Signal would collapse this · Hide" instead); text that grows without you (LinkedIn loading it in the background, a script) is re-judged but does not un-hide anything by itself. Your marks still apply, and if the new classification fails the post is left as LinkedIn drew it.
- **Kept post**: untouched in Active mode; in Review mode, only a faint **Low quality** button (verdict and reason on hover) so you can still record posts the model missed.
- **Repeated templates**: a post of **40+ words** whose text closely matches (estimated similarity ≥ 0.85) a post the model already judged, for the same model and prompt version, reuses that verdict instead of calling the model, so template posts ("Thrilled to announce I've joined {Company}…", "{N} lessons from hiring {N} people…") are judged once and consistently. Matching is local: a MinHash signature of 3-word chunks after removing emoji, turning every number into one token and URLs into `url` (`src/shared/similarity.ts`). Chunks are hashed with SipHash-2-4 under a random key created for your install and kept only in the service worker's storage, so nobody else can compute your signatures or craft a post to match one exactly (a genuinely near-identical post can still match; see the design notes). It is deliberately conservative: a verdict is copied only from a post the model judged itself (never from another copy, never from your marks), never when a similar post was judged a **highlight** (its substance may be in the very numbers that are ignored), and never when similar posts got different verdicts; if a similar post is still waiting for the model, the new one waits for that answer. Shorter posts only ever match exactly. Measured on the fixture set (`npm run eval -- --file eval/repeats.jsonl --mode repeats`): all 7 template families held together, 0 of 8 hard negatives matched, 0 matched pairs with different labels. Measured match rate for a swapped single-word name: ~61% at 40 words, ~95% at 50, ~100% from 60 (a two-word name: ~8% at 40 words, where it is genuinely below the threshold, ~82% at 60, ~100% at 80); swapped numbers and emoji always match. The signature has 256 values (16 bits each), so posts whose exact similarity is just below the threshold are rarely matched by chance (~2% at 0.80) and clear repeats are rarely missed (~0.5% at 0.90). A copied verdict shows a second line, *≈ Same template as a post judged earlier · Judge separately* (similarity on hover); **Judge separately** asks the model about that post (one call) and keeps it visible if you had revealed or were reading it. A post you marked, revealed or are reading is never changed by a match, and a post that already has its own verdict is re-judged by the model (not matched) when its text grows. Turn it off under **Model › Advanced › Recognise repeated templates** (applies on Save). The popup counts **repeats** separately from cache hits.
- **Feedback** is stored only in this browser (`chrome.storage.local`), one entry per correction (`fb:<fingerprint>`; feedback saved by older versions in a single map is migrated automatically on first use, in ~1 MB steps so it fits within Chrome's 10 MB storage quota, without losing entries; the migration runs in the background, so the popup and the feed work immediately; if there is not enough room, older entries keep working from the old map and the migration finishes on a later start), keyed by content fingerprint, applies instantly (also to identical reshares), and each override has **Undo**. "Low quality" collapses even in Review mode. Nothing is uploaded or used for training.
- **Export** writes `signal-feedback.jsonl` in the same format the evaluator reads, so your corrections become your personal test set. Each correction carries the classification it corrected (`classification`, `model`, `prompt_version`), so `npm run eval -- --file signal-feedback.jsonl --mode stored` re-scores it with no API calls. A correction on a copied verdict also carries `repeat_of` (the judged post's content fingerprint) and `repeat_similarity`; "Your corrections" and `--mode stored` count those separately. Feedback saved by older versions has no stored classification: it still shows, exports (as before) and can be re-classified with `--mode llm`, but the popup and `--mode stored` leave it out and say so.

| Sensitivity | Collapse when model confidence ≥ | Intent |
|---|---|---|
| Relaxed | 0.95 | only the clearest noise |
| Balanced (default) | 0.85 | confident noise only |
| Strict | 0.70 | more aggressive, more false positives |

These numbers are *starting points*, not calibrated probabilities. On top of the threshold, a collapse is vetoed if the model's own evidence/reasoning scores are high, and requires positive noise signals (see `src/policy.ts`).

## Permissions and privacy

| Permission | Why |
|---|---|
| `storage` | settings, API key, classification cache, repeated-template signatures, feedback, session stats |
| host `https://www.linkedin.com/*` | run the content script; find LinkedIn tabs to notify and read per-tab stats |
| *optional* hosts `https://*/*`, `http://localhost/*`, `http://127.0.0.1/*` | requested **only** for the one LLM host you enter, when you press Save |

What leaves your machine: for each classified post, the post text, any reshared text, and link-preview title/description, sent to the endpoint you configured with your key. Nothing else: no author names, profile data, comments, cookies, messages, or page content. Truncation limits: 3,000 / 1,500 / 200 / 400 characters. A long post is sent first with the text LinkedIn shows before "…more"; if its text grows (you expand it), the longer text is sent once more, within the same limits and at most 3 times per post per page load. There is no other network traffic, no analytics, no remote code. With the **local CLI bridge**, the same post data goes to the bridge on your computer and from there to your CLI (and its provider); the CLI could keep it in its own session history, which the bridge removes after each call and checks at start (*Local CLI bridge*).

**Threat model for the API key.** The key is kept in `chrome.storage.local`, which Chrome does **not** encrypt. It is read only by the service worker; the content script (which runs beside LinkedIn's scripts) is blocked from the storage area and from every settings API, and the popup never receives the key back. This protects against the LinkedIn page and a bug in content-script code. It does **not** protect against malware or another user with access to your Chrome profile, a malicious extension with debugging access, or someone with your unlocked machine. Use a key with a spend limit.

The cache stores model output only (no post text). The repeated-template index (`repeats:v3`, at most 2,000 entries, ~1.5 MB) stores only a 256 × 16-bit hash signature per judged post, plus your install's 128-bit signature key (an index left by an earlier version is deleted on first load), keyed like the cache; signatures are computed in the service worker, never accepted from the content script, and **Clear cache** clears them too. Feedback stores up to 1,500 characters of each post you mark, plus the model's classification of it (decision, confidence, short reason, sub-signals, model name, prompt version), locally, so you can review, score and export it; **Reset** (under Feedback) deletes it.

**Content script and page boundary.** The content script shares the LinkedIn tab with LinkedIn's own scripts, so the service worker treats everything it sends as untrusted: it re-applies the post-size limits and recomputes the content fingerprint before any LLM call (a mismatch is refused, never sent), accepts only `keep`/`collapse` verdicts and 32-hex fingerprints, validates stored classification records (no control or bidi characters in model names), and caps feedback at 2,000 corrections (the popup says when it is full; export and reset to continue; feedback migrated from an older version is kept even above the cap). If feedback storage fails, the feed keeps working without your overrides rather than stopping. Signal's in-feed bars live in a *closed* shadow root and ignore synthetic clicks, so page scripts can neither read their text nor press their buttons. The service worker decides who is talking by the sender's URL/origin: only Signal's own pages (the popup, even if opened in a tab) get the settings and feedback APIs; anything else is treated as a content script. Leaving the feed (or switching Signal off) in one tab cancels only that tab's pending work; a request another tab still waits for keeps going, and a content script can cancel only its own tab's requests (its tab comes from Chrome's sender record, not from the message). Clear cache, or saving a new model, endpoint or key, cancels everything; such a global cancel also stops requests still being prepared: a request from before it never calls the model, hands out a copied verdict or stores a result afterwards, and an answer that races the abort is discarded. Saving a new model, endpoint or key also holds model calls from the moment the background receives the Save until it is written, so **from then on no model call starts with the replaced endpoint or key** (a call already sent before the Save arrived is aborted, but cannot be unsent); toggles such as mode or sensitivity hold nothing. When a post's text grows, the content script may cancel the now-obsolete request with `cancel`; the service worker tracks which tab is waiting for each request, so a tab can only give up its own interest and never cancels a request another tab still needs. Re-judging grown text is capped at 3 times per post per page load, and a post only counts as "being read" (not hidden by a collapse verdict) after a trusted click inside it while it was visible, so a page script or LinkedIn's background changes cannot un-hide collapsed posts or run up LLM calls that way. Accepted risk: the model and prompt version stored with a correction are reported by the content script and not cross-checked, so a compromised content script could skew your own "Your corrections" numbers (it could not reach your key or other sites).

Prompt injection: post text is untrusted. It is JSON-encoded in the user turn, the system prompt tells the model to ignore instructions in it, the reply is strictly schema-validated, and the worst an attacker-controlled post can do is get *that post* highlighted or collapsed, reversibly. Model-written reasons are rendered via `textContent` inside a shadow root, never as HTML.

## Architecture

See [`docs/architecture-decision.md`](docs/architecture-decision.md) for research findings, the build-vs-fork decision, risks and exclusions.

```
src/adapter/linkedin.ts      all LinkedIn selectors (repair here)
src/classifier/              prompt, strict parser, OpenAI-compatible client, queue
src/policy.ts                verdict + sensitivity → collapse / keep / highlight
src/background/              service worker: cache, repeat index, settings, feedback, stats, handlers
src/shared/similarity.ts     repeated-template signatures (cleanup, shingles, MinHash)
src/content/                 controller (observers, dedup, overrides) + presenter (DOM)
src/popup/                   settings UI
bridge/                      local CLI bridge (npm run bridge): server, runner, self-test
eval/                        datasets, metrics, runner, keyword baseline
tests/                       vitest + jsdom, DOM fixtures
```

Reliability behaviours: posts stay visible while pending; classification starts ~1500px before a post scrolls into view; MutationObserver is debounced (250 ms); identical content is classified once; 30 s timeout; up to 2 retries with exponential backoff and jitter, honouring `Retry-After` (≤30 s); stale requests are cancelled on navigation off the feed and on provider changes; when a post's text grows ("…more"), Signal waits for it to settle (400 ms), judges the longer text once (at most 3 times per post per page load), cancels the cut-off request if nothing else waits for it, and drops a late result for the old text; only changes inside post text areas are looked at (not timestamps, reactions or comments); auth/config errors pause further requests until you change settings; every failure path leaves the post alone.

## Tests

```bash
npm test            # 668 tests
npm run typecheck
SIGNAL_TEST_SLOW_HASH=60 npm test   # same suite with fingerprinting slowed by 60 ms, as on a loaded machine
```

Covered: extraction (classic and SDUI fixtures, comments excluded, reshares, link previews, promoted posts, no DOM mutation), dynamic insertion and infinite scroll, deduplication, DOM-node recycling, placeholder cleanup, caching and eviction, parser and malformed model output, API failures/timeouts/rate limits/retries/cancellation, settings persistence, key isolation between content script and popup, overrides and undo, reversible collapse, highlight rendering, fail-open behaviour, route gating, prompt-injection and HTML-injection handling, dataset integrity and metrics, feedback records (validation, legacy entries), the corrections report and its shared-code guarantees (same `score()` in popup and eval, popup bundle free of Node built-ins), the popup UI, export → `--mode stored` round trip, and the eval CLI run offline with network access blocked, the content-script boundary (input re-validation, verdict/fingerprint checks, feedback cap, closed shadow root with trusted clicks only, control-character handling), and re-judging on "…more" (growth in both layouts, in pieces and in reshared text; unchanged, shrinking and unrelated changes ignored; late results dropped; per-sender cancel; revealed/expanded/marked posts; trusted-click rule and re-judge cap; fail-open), checked against deliberately broken code (mutation runs); and repeated templates (signature cleanup and limits, the fixture-set quality check, index scoping/eviction/persistence/no-text, copying rules and no-chaining, waiting for similar in-flight requests with per-sender cancel, noRepeat handling, note row and Judge separately, the four "don't change what the user did" protections, copied-verdict corrections, export and eval); the popup's width and text contrast (WCAG AA computed from the stylesheets, light and dark; real-browser checks in `docs/mockups/finding-f/` and `docs/mockups/finding-g/`); and the local CLI bridge, against fake `claude`/`codex` CLIs that record what they receive (Signal-only requests, token file, Host/Origin/CORS, queue and cancel, no shell, stdin only, scrubbed environment, empty folder, process-group kill, output cap, self-test and canary, logs without post text, the built `npm run bridge` end to end, and the popup preset).

## Evaluation

```bash
SIGNAL_ENDPOINT=https://openrouter.ai/api/v1 SIGNAL_MODEL=<model> SIGNAL_API_KEY=<key> \
  npm run eval -- --split dev  --in-price <usd/1M> --out-price <usd/1M>
npm run eval -- --split test                      # only after you stop tuning on dev
npm run eval -- --file my-feedback.jsonl           # your exported feedback / hand-labeled posts
npm run eval -- --rescore eval/results/<file>.json # re-score thresholds with no API calls
npm run eval -- --file signal-feedback.jsonl --mode stored  # score exported feedback from its stored classifications, no API calls
npm run eval -- --mode baseline --split test       # keyword baseline, no API
npm run eval -- --file eval/repeats.jsonl --mode repeats  # which rows count as the same template, no API
```

Reports collapse precision and recall, **false-positive rate on substantive posts** (the number that matters), highlight precision (strict, and lenient where `also_ok` allows it) and recall, a confusion matrix, an adversarial-subset line, latency p50/p95, request/token counts, and cost when prices are supplied, at all three sensitivities.

Datasets: `eval/dev.jsonl` (60) for tuning and `eval/test.jsonl` (60) held out; 120 synthetic posts across AI hype, doomposting, reasoned AI criticism, engineering, incidents, research, management, economics, politics, philosophy, science, careers, motivation, bait, announcements, promotions, personal reflections, short insights, long-but-empty posts, and 20 adversarial rows (e.g. dense jargon with no insight; plain-spoken excellent argument; careful pessimism; benchmarked product launch; polished useful post; sloppy valuable post).
**All rows are synthetic and were labeled by the same agent that wrote the extension; they are not independent human ground truth.** Treat results as a regression/sanity suite, not a measure of how Signal behaves on your real feed. To add real examples, put rows in JSONL: `{"id","source":"manual","label":"collapse|keep|highlight","text", "also_ok":[…]?}` or use the popup's feedback export.

**Results so far (keyword baseline only; no LLM has been evaluated):**

| split | sensitivity | collapse precision | collapse recall | false-positive rate | highlights |
|---|---|---|---|---|---|
| dev | balanced | 100% (10/10) | 41.7% | 0% | none produced |
| test | balanced | 100% (7/7) | 29.2% | 0% | none produced |

The baseline is a conservative lexical scorer written for comparison, not tuned on test (though its author had read dev). It shows the ceiling of a cheap approach: it never wrongly hides, but it misses 58–71% of the noise and cannot highlight anything. That is the gap the LLM classifier has to close; whether it does, and at what false-positive rate, is **unmeasured**.

## Known limitations

- Selectors unverified on live LinkedIn; the SDUI link-preview selector is a guess.
- No browser-level smoke test. Branded Chrome 137+ ignores `--load-extension`, so an automated test would need Chromium or Chrome for Testing plus Playwright; the build sandbox also could not open sockets or download a browser. Manual checklist: load `dist/`, open the feed in Review mode, confirm annotations appear, press each button, switch to Active, reload the extension and confirm nothing breaks.
- Repetition: identical content shares a verdict, and long posts (40+ words) that are the same template as one the model judged reuse its verdict (*Repeated templates*). Topic-level repetition ("too many AI posts today") is not modeled.
- **Near-copies can inherit a verdict (accepted, security S3).** Someone who can predict a post's text can publish a genuine near-copy with a few bait words; if your Signal judges that version first and collapses it, the later original can copy "collapse". Short additions (roughly under 15% of a post) can also ride along with a copied verdict by chance near the threshold. Crafting an exact match is prevented by your install's secret key (S2), but a real near-copy needs no crafting. Mitigations: the "Same template" note and **Judge separately** on every copied verdict, Review mode, and highlights are never copied.
- **Stored hashes reveal what you saw to someone with access to your Chrome profile (accepted, S8).** The cache keys are content fingerprints (unsalted SHA-256), so anyone with the profile can check whether a specific post was shown to you; feedback stores the text of posts you marked. Repeated-template signatures add nothing (they are keyed with your install's secret).
- **Model settings saves briefly hold model calls (accepted, S9).** While a new model, endpoint or key is being saved, model calls wait for the write (milliseconds). The hold is always released, also on failure, and a service-worker restart clears it.
- Images, video, polls and documents are not analysed; an image-only post with a caption is judged by the caption.
- Long posts are first judged on the text LinkedIn shows before "…more". When you expand one, Signal judges the full text once more (one extra LLM call per expanded post; expanding again after "…see less" reuses that verdict). It reacts only to the post's text growing, so relies on the adapter's selectors like everything else.
- Exported feedback keeps only the post text (not the reshared text or link preview the model also saw), so re-classifying an export with `--mode llm` can differ from what the extension saw. `--mode stored` and the popup use the stored classification and are not affected.
- "Your corrections" counts are only as good as your corrections: they are a small, self-selected sample (you mostly correct what you notice), not an unbiased error rate.
- Promoted posts are skipped, not hidden.
- Cache is capped at 2,000 entries (oldest evicted). A service-worker kill can lose up to ~2 s of cache writes.
- Layout can shift when a verdict lands for a post already on screen.
- The model's `confidence` is a self-report and is not calibrated; the thresholds are guesses until you evaluate them.
- Using the extension may violate LinkedIn's terms (above). The local CLI bridge has its own terms note and limits (*Local CLI bridge*).

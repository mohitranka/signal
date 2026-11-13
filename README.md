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
| Automated tests | 83 pass (`npm test`), typecheck clean. |
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
4. Open `https://www.linkedin.com/feed/`. It starts in **Review mode**: every classified post gets a thin annotation (`Signal: would collapse 93% — reason`) and nothing is hidden.
5. Use review mode for a few days, correct mistakes with **Low quality / Worth keeping**, then switch to **Active** when the "would collapse" annotations are ones you agree with.

After code changes: `npm run build`, then click reload on the extension card. `npm run dev` rebuilds on change.

## LLM setup

Signal speaks the OpenAI chat-completions protocol (`POST {endpoint}/chat/completions`). You bring the endpoint, model and key. Nothing is preconfigured: the model field starts empty on purpose.

| Provider | Endpoint | Key | Notes |
|---|---|---|---|
| OpenRouter | `https://openrouter.ai/api/v1` | OpenRouter key | Pick any model that follows JSON instructions. |
| OpenAI | `https://api.openai.com/v1` | API key | **API billing is separate from a ChatGPT subscription**; a subscription gives no API credit. |
| Ollama (local) | `http://localhost:11434/v1` | leave blank | Run `OLLAMA_ORIGINS='chrome-extension://*' ollama serve` or Ollama may reject the extension's origin. Small local models will be noticeably worse at this task; verify with `npm run eval`. |
| Other | any OpenAI-compatible base URL | as required | vLLM, LiteLLM, etc. Non-local endpoints must be `https://`. |

Click **Save**: Chrome asks permission to contact that host (the extension requests it on demand rather than at install). Then **Test connection**.

Pick a cheap, fast model. Each uncached post sends roughly 0.9–1k input tokens (the instruction prompt is ≈760 tokens; chars/4 estimate) and gets ≈60–120 tokens back. Enter your model's $/1M-token prices in the popup to get a running cost estimate. Results are cached per `(prompt version, model, post content)` so repeated or reshared content is never paid for twice, and changing the model starts fresh.

## Using it

- **Popup**: enable/disable, Review vs Active, Relaxed / Balanced / Strict, highlight on/off, provider settings, test, session stats (calls, cache hits, tokens, latency, estimated cost, per-tab collapsed/highlighted counts), feedback list/export/reset, clear cache.
- **Collapsed post**: a compact bar — "Post collapsed", the reason, **Show post**, **Worth keeping**. After revealing: **Hide again**.
- **Highlighted post**: a restrained green left edge; hover for the reason. No badges.
- **Kept post**: untouched in Active mode.
- **Feedback** is stored only in this browser (`chrome.storage.local`), keyed by content fingerprint, applies instantly (also to identical reshares), and each override has **Undo**. "Low quality" collapses even in Review mode. Nothing is uploaded or used for training.
- **Export** writes `signal-feedback.jsonl` in the same format the evaluator reads, so your corrections become your personal test set.

| Sensitivity | Collapse when model confidence ≥ | Intent |
|---|---|---|
| Relaxed | 0.95 | only the clearest noise |
| Balanced (default) | 0.85 | confident noise only |
| Strict | 0.70 | more aggressive, more false positives |

These numbers are *starting points*, not calibrated probabilities. On top of the threshold, a collapse is vetoed if the model's own evidence/reasoning scores are high, and requires positive noise signals (see `src/policy.ts`).

## Permissions and privacy

| Permission | Why |
|---|---|
| `storage` | settings, API key, classification cache, feedback, session stats |
| host `https://www.linkedin.com/*` | run the content script; find LinkedIn tabs to notify and read per-tab stats |
| *optional* hosts `https://*/*`, `http://localhost/*`, `http://127.0.0.1/*` | requested **only** for the one LLM host you enter, when you press Save |

What leaves your machine: for each classified post, the post text, any reshared text, and link-preview title/description, sent to the endpoint you configured with your key. Nothing else: no author names, profile data, comments, cookies, messages, or page content. Truncation limits: 3,000 / 1,500 / 200 / 400 characters. There is no other network traffic, no analytics, no remote code.

**Threat model for the API key.** The key is kept in `chrome.storage.local`, which Chrome does **not** encrypt. It is read only by the service worker; the content script (which runs beside LinkedIn's scripts) is blocked from the storage area and from every settings API, and the popup never receives the key back. This protects against the LinkedIn page and a bug in content-script code. It does **not** protect against malware or another user with access to your Chrome profile, a malicious extension with debugging access, or someone with your unlocked machine. Use a key with a spend limit.

The cache stores model output only (no post text). Feedback stores up to 1,500 characters of each post you mark, locally, so you can review and export it; **Reset feedback** deletes it.

Prompt injection: post text is untrusted. It is JSON-encoded in the user turn, the system prompt tells the model to ignore instructions in it, the reply is strictly schema-validated, and the worst an attacker-controlled post can do is get *that post* highlighted or collapsed, reversibly. Model-written reasons are rendered via `textContent` inside a shadow root, never as HTML.

## Architecture

See [`docs/architecture-decision.md`](docs/architecture-decision.md) for research findings, the build-vs-fork decision, risks and exclusions.

```
src/adapter/linkedin.ts      all LinkedIn selectors (repair here)
src/classifier/              prompt, strict parser, OpenAI-compatible client, queue
src/policy.ts                verdict + sensitivity → collapse / keep / highlight
src/background/              service worker: cache, settings, feedback, stats, handlers
src/content/                 controller (observers, dedup, overrides) + presenter (DOM)
src/popup/                   settings UI
eval/                        datasets, metrics, runner, keyword baseline
tests/                       vitest + jsdom, DOM fixtures
```

Reliability behaviours: posts stay visible while pending; classification starts ~1500px before a post scrolls into view; MutationObserver is debounced (250 ms); identical content is classified once; 30 s timeout; up to 2 retries with exponential backoff and jitter, honouring `Retry-After` (≤30 s); stale requests are cancelled on navigation off the feed and on provider changes; auth/config errors pause further requests until you change settings; every failure path leaves the post alone.

## Tests

```bash
npm test            # 83 tests
npm run typecheck
```

Covered: extraction (classic and SDUI fixtures, comments excluded, reshares, link previews, promoted posts, no DOM mutation), dynamic insertion and infinite scroll, deduplication, DOM-node recycling, placeholder cleanup, caching and eviction, parser and malformed model output, API failures/timeouts/rate limits/retries/cancellation, settings persistence, key isolation between content script and popup, overrides and undo, reversible collapse, highlight rendering, fail-open behaviour, route gating, prompt-injection and HTML-injection handling, dataset integrity and metrics.

## Evaluation

```bash
SIGNAL_ENDPOINT=https://openrouter.ai/api/v1 SIGNAL_MODEL=<model> SIGNAL_API_KEY=<key> \
  npm run eval -- --split dev  --in-price <usd/1M> --out-price <usd/1M>
npm run eval -- --split test                      # only after you stop tuning on dev
npm run eval -- --file my-feedback.jsonl           # your exported feedback / hand-labeled posts
npm run eval -- --rescore eval/results/<file>.json # re-score thresholds with no API calls
npm run eval -- --mode baseline --split test       # keyword baseline, no API
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
- Posts with long text may only be partially in the DOM until "…more" is expanded; the model sees what is there.
- Repetition across *different* posts is not modeled; only identical content shares a verdict.
- Images, video, polls and documents are not analysed; an image-only post with a caption is judged by the caption.
- Verdict changes after an "…more" expansion are not re-evaluated.
- Promoted posts are skipped, not hidden.
- Cache is capped at 2,000 entries (oldest evicted). A service-worker kill can lose up to ~2 s of cache writes.
- Layout can shift when a verdict lands for a post already on screen.
- The model's `confidence` is a self-report and is not calibrated; the thresholds are guesses until you evaluate them.
- Using the extension may violate LinkedIn's terms (above).

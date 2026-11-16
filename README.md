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
| Automated tests | 243 pass (`npm test`), typecheck clean. |
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

- **Popup**: on/off switch and a one-line status; Review / Active and Relaxed / Balanced / Strict as segmented controls (each with a one-line explanation); highlight on/off; **Model** (provider, endpoint, model, key; concurrency, timeout and prices under *Advanced*; Save and Test connection); **This session** (classified, cache hits, tokens, estimated cost; details on hover; this tab's collapsed/highlighted counts; clear cache); **Your corrections** (below); **Feedback** (list, Export JSONL, Reset). Light and dark follow the system theme.
- **Your corrections**: for each sensitivity, how many posts you marked *Worth keeping* it would have collapsed (**wrongly hidden**), and how many you marked *Low quality* it would have left up (**missed**), computed locally by the same `decide()` the feed uses and the same `score()` the evaluator uses (`src/corrections.ts`, `src/scoring.ts`). It only scores corrections classified by your current model and prompt version, lists the ones it left out and why (no stored classification, other model, older prompt), and says when a side has fewer than 10 corrections and is too few to judge.
- **Collapsed post**: a compact bar — "Post collapsed", the reason, **Show post**, **Worth keeping**. After revealing: **Hide again**.
- **Highlighted post**: a restrained green left edge; hover for the reason. No badges.
- **Kept post**: untouched in Active mode; in Review mode, only a faint **Low quality** button (verdict and reason on hover) so you can still record posts the model missed.
- **Feedback** is stored only in this browser (`chrome.storage.local`), one entry per correction (`fb:<fingerprint>`; feedback saved by older versions in a single map is migrated automatically on first use, in ~1 MB steps so it fits within Chrome's 10 MB storage quota, without losing entries; the migration runs in the background, so the popup and the feed work immediately; if there is not enough room, older entries keep working from the old map and the migration finishes on a later start), keyed by content fingerprint, applies instantly (also to identical reshares), and each override has **Undo**. "Low quality" collapses even in Review mode. Nothing is uploaded or used for training.
- **Export** writes `signal-feedback.jsonl` in the same format the evaluator reads, so your corrections become your personal test set. Each correction carries the classification it corrected (`classification`, `model`, `prompt_version`), so `npm run eval -- --file signal-feedback.jsonl --mode stored` re-scores it with no API calls. Feedback saved by older versions has no stored classification: it still shows, exports (as before) and can be re-classified with `--mode llm`, but the popup and `--mode stored` leave it out and say so.

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

The cache stores model output only (no post text). Feedback stores up to 1,500 characters of each post you mark, plus the model's classification of it (decision, confidence, short reason, sub-signals, model name, prompt version), locally, so you can review, score and export it; **Reset** (under Feedback) deletes it.

**Content script and page boundary.** The content script shares the LinkedIn tab with LinkedIn's own scripts, so the service worker treats everything it sends as untrusted: it re-applies the post-size limits and recomputes the content fingerprint before any LLM call (a mismatch is refused, never sent), accepts only `keep`/`collapse` verdicts and 32-hex fingerprints, validates stored classification records (no control or bidi characters in model names), and caps feedback at 2,000 corrections (the popup says when it is full; export and reset to continue; feedback migrated from an older version is kept even above the cap). If feedback storage fails, the feed keeps working without your overrides rather than stopping. Signal's in-feed bars live in a *closed* shadow root and ignore synthetic clicks, so page scripts can neither read their text nor press their buttons. The service worker decides who is talking by the sender's URL/origin: only Signal's own pages (the popup, even if opened in a tab) get the settings and feedback APIs; anything else is treated as a content script. Accepted risk: the model and prompt version stored with a correction are reported by the content script and not cross-checked, so a compromised content script could skew your own "Your corrections" numbers (it could not reach your key or other sites).

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
npm test            # 243 tests
npm run typecheck
SIGNAL_TEST_SLOW_HASH=60 npm test   # same suite with fingerprinting slowed by 60 ms, as on a loaded machine
```

Covered: extraction (classic and SDUI fixtures, comments excluded, reshares, link previews, promoted posts, no DOM mutation), dynamic insertion and infinite scroll, deduplication, DOM-node recycling, placeholder cleanup, caching and eviction, parser and malformed model output, API failures/timeouts/rate limits/retries/cancellation, settings persistence, key isolation between content script and popup, overrides and undo, reversible collapse, highlight rendering, fail-open behaviour, route gating, prompt-injection and HTML-injection handling, dataset integrity and metrics, feedback records (validation, legacy entries), the corrections report and its shared-code guarantees (same `score()` in popup and eval, popup bundle free of Node built-ins), the popup UI, export → `--mode stored` round trip, and the eval CLI run offline with network access blocked, and the content-script boundary (input re-validation, verdict/fingerprint checks, feedback cap, closed shadow root with trusted clicks only, control-character handling).

## Evaluation

```bash
SIGNAL_ENDPOINT=https://openrouter.ai/api/v1 SIGNAL_MODEL=<model> SIGNAL_API_KEY=<key> \
  npm run eval -- --split dev  --in-price <usd/1M> --out-price <usd/1M>
npm run eval -- --split test                      # only after you stop tuning on dev
npm run eval -- --file my-feedback.jsonl           # your exported feedback / hand-labeled posts
npm run eval -- --rescore eval/results/<file>.json # re-score thresholds with no API calls
npm run eval -- --file signal-feedback.jsonl --mode stored  # score exported feedback from its stored classifications, no API calls
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
- Exported feedback keeps only the post text (not the reshared text or link preview the model also saw), so re-classifying an export with `--mode llm` can differ from what the extension saw. `--mode stored` and the popup use the stored classification and are not affected.
- "Your corrections" counts are only as good as your corrections: they are a small, self-selected sample (you mostly correct what you notice), not an unbiased error rate.
- Promoted posts are skipped, not hidden.
- Cache is capped at 2,000 entries (oldest evicted). A service-worker kill can lose up to ~2 s of cache writes.
- Layout can shift when a verdict lands for a post already on screen.
- The model's `confidence` is a self-report and is not calibrated; the thresholds are guesses until you evaluate them.
- Using the extension may violate LinkedIn's terms (above).

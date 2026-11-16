# Architecture decision record: Signal

Status: accepted. Date: 2026-11-13.

## 1. Findings

Sources were read on the date above. "Observed" means I read it; "advertised" means the vendor says it.

**Unslop** (github.com/sapountzis/Unslop, MIT) — observed from the README, `prompts.ts`, and the LinkedIn platform files.
- MV3 extension, TypeScript, Bun. Classification runs in the service worker against any OpenAI-compatible endpoint; BYO key, no backend, no telemetry. Same privacy stance we want.
- Covers LinkedIn plus experimental X and Reddit through a plugin registry. We need only LinkedIn.
- The classifier is **binary keep/hide and its prompt says "when uncertain, hide."** That is the opposite of our rule (false positives cost more), and there is no highlight and no review mode.
- The LinkedIn adapter is the valuable part: it avoids hashed class names and relies on `data-urn`, `role="article"`, `[role="list"] [role="listitem"]`, `data-testid="expandable-text-box"` and button `aria-label`s, covering both the classic and server-driven-UI feeds.
- I did not run its test suite or audit its dependency tree.

**getcleanedin.com** (commercial) — advertised, from its public homepage only; I did not install or use it.
- Ten "noise" categories (AI-generated, engagement bait, humble brag, career announcements, corporate PR, recycled, empty inspiration, vague teases, off-topic, political) and eight paid "Spotlight" categories (insights, original research, jobs, contrarian takes, launches, case studies, expert analysis).
- Sensitivity slider; collapse with click-to-reveal; spotlight is a blue left border; max 3 concurrent classifications; results cached per session.
- **Post text is sent to the vendor's server** for classification. That is the main thing Signal avoids.
- Its category list conflates *style* with *quality* (e.g. it hides all career announcements and "political noise" by topic). Our brief explicitly rejects topic and sentiment filtering, so we borrow only the UX shape (collapse placeholder, restrained highlight border, sensitivity), not the taxonomy.

**yasingedik/cleanedin** (GPL-3.0, unrelated to the product above) — observed from the README.
- Rule-based (keywords, connection degree, reaction/repost context), no LLM. Vite + Vitest + Playwright, DOM fixtures in `tests/`.
- Useful as a reminder to keep fixtures for DOM tests. GPL-3.0 means no code is copied.

**Platform policy** — LinkedIn User Agreement, fetched 2026-11-13, §8.2 "Don'ts":
- prohibits using "browser plugins and add-ons" to "scrape or copy the Services", and
- prohibits "Overlay or otherwise modify the Services or their appearance (such as by inserting elements into the Services…)".

Signal reads post text and changes how the feed looks. Personal, unpublished use does not exempt it. **This is a real account-restriction risk the user accepts**; it is repeated in the README. Chrome Web Store policy applies only if the extension is published, which is out of scope.

## 2. Reuse versus build

**Decision: build from scratch; reuse ideas, not code.**

- Forking Unslop would mean ripping out X/Reddit, the plugin registry, the binary classifier contract and its prompt, and rebuilding the UI for three outcomes. That is more work than the ~1,900 lines this took, and leaves unused surface area to maintain.
- Its MIT license would allow reuse, so this is a complexity decision, not a legal one.
- Taken as reference: attribute-based selectors, SDUI + classic coverage, service-worker-only LLM calls, OpenAI-compatible provider model.

## 3. Chosen architecture

```
 LinkedIn page                 content script (isolated world)               service worker                 LLM
 ─────────────   findPosts/    ┌──────────────────────────────┐  classify    ┌─────────────────────┐   HTTPS
 feed DOM  ───▶  extract  ───▶ │ FeedController               │ ───────────▶ │ ClassifyService     │ ───────▶ OpenAI-compatible
                (adapter)      │  MutationObserver+debounce   │  {fp,input}  │  cache → queue →    │   chat/completions
                               │  IntersectionObserver        │ ◀─────────── │  client (retry)     │
                               │  policy.decide() (pure)      │ Classification│ stores: settings,  │
                               │  Presenter (shadow DOM bar)  │              │ key, cache, feedback│
                               └──────────────────────────────┘              └─────────────────────┘
                                         popup ◀──── messages (extension pages only) ────▶
```

Layers (each a directory, matching the requested separation):
1. **Feed adapter** `src/adapter/linkedin.ts` — the only file with LinkedIn selectors.
2. **Classification provider** `src/classifier/` — prompt, strict parser, OpenAI-compatible client, bounded queue.
3. **Decision policy** `src/policy.ts` — pure: model verdict + sensitivity → outcome. Runs in the content script so changing sensitivity or mode re-renders without a new LLM call.
4. **Caching/persistence** `src/background/store.ts` — settings, classification cache (keyed `promptVersion|model|contentFingerprint`), feedback, session stats. Feedback is stored one key per correction (`fb:<fingerprint>`, migrated from the older single map in ~1 MB chunks, in the background, never failing or delaying loading; `getState` falls back to no overrides if feedback cannot be read), served from memory after one read per service-worker start, and written through a serial queue so overlapping saves cannot lose updates; settings saves are serialized the same way.
5. **Feed presentation** `src/content/presenter.ts` — highlight border via manifest CSS, collapse via a `data-signal-hidden` attribute (never removes nodes), placeholder/annotation bar in a shadow root built with `textContent` only.
6. **Popup** `src/popup/` — plain TypeScript, no framework.
7. **Shared scoring** `src/scoring.ts` and `src/corrections.ts` — pure, browser-safe. The evaluator (`eval/`) and the popup's "Your corrections" panel both import them, so the numbers come from one implementation of `decide()` + `score()`; a bundle test asserts the popup ships each exactly once and no Node built-ins.

Security shape: the API key lives only in the service worker (`storage.local`, access level set to trusted contexts so content scripts cannot read it); the content script may use only `classify / cancelAll / getState / setFeedback`; settings writes, connection tests and feedback export are rejected for content-script senders (a sender counts as an extension page only if its URL/origin is this extension's; anything else, including a sender without a URL, is treated as a content script). The LLM host is an *optional* host permission requested from the popup at save time. The background also re-validates what the content script sends (post-size limits re-applied, fingerprint recomputed, verdicts and fingerprints checked, stored classification records validated, feedback capped at 2,000 entries), and in-feed bars use a closed shadow root that ignores untrusted clicks.

## 4. Key technical risks

| Risk | Mitigation / status |
|---|---|
| LinkedIn DOM changes or A/B variants | Selectors isolated in one file; attribute-based; fixtures. **Selectors are not verified against a live session** (no browser access in this build environment). Expect to repair them on first real use. |
| Posts that load truncated ("…more") | We read what is in the DOM. If the full text is not present until expanded, the model sees a partial post and is told to be conservative. Not measured. |
| LinkedIn ToS (see §1) | Accepted by the user; no mitigation possible in code. |
| Model quality / false positives | Review mode first; asymmetric thresholds; veto rules in policy; one-click overrides. **Classifier quality against a real LLM has not been measured** (see README results). |
| Layout shift when a post collapses | Posts are classified up to ~1500px ahead of the viewport; unclassified posts stay untouched. Shift is reduced, not eliminated. |
| Cost | roughly 0.9–1k prompt tokens per uncached post (system prompt ≈ 760 tokens by a chars/4 estimate; not measured against a real tokenizer). Tokens and, with user-entered prices, estimated cost are shown in the popup. Cache avoids repeats. |
| Service worker lifecycle | All state is in storage; in-memory cache flushes on a 2 s debounce and on suspend, so a few recent verdicts may be re-requested after a kill. |
| Prompt injection from post text | Post is JSON-encoded in the user turn, system prompt marks it untrusted, output is schema-validated, and the only thing a model can cause is collapse/highlight of that same post (reversible). |

## 5. Classification strategy

- **Direct semantic classification by an LLM**, returning `decision`, `confidence`, a short `reason`, and six sub-signals (originality, evidence, reasoning, usefulness, sensationalism, engagement_bait).
- The sub-signals are **not** combined into a weighted score. They are used only as vetoes/guards in the policy: a collapse needs high confidence, *no* strong evidence/reasoning signal, and positive evidence of noise (sensationalism/bait or very low originality). This was chosen over pure scoring because a keyword/shape scorer cannot tell a measured pessimistic argument from doomposting (see the baseline in the README: 100% precision but only 29–42% collapse recall and no highlight ability, because every cue it has is lexical).
- Default to `keep` on any doubt, parse failure, or API failure.
- Thresholds (relaxed 0.95 / balanced 0.85 / strict 0.70 for collapse; 0.80 for highlight) are **uncalibrated starting points**. Tune with `npm run eval` on the model you use and on your own exported feedback.
- Context sent: post text, quoted/reshared text, link title and description. Never author name, follower count, profile data, or comments. Headlines are not treated as evidence of the article's content.
- Repetition: judged only through exact-content caching (a reshare of identical text shares its verdict). Topic-level repetition across the session is **not** modeled.

## 6. Intentionally excluded

Accounts, payments, backend, telemetry, multi-platform, recommendations, personalization/fine-tuning, embeddings, dashboards, author-based scoring, topic or sentiment filters, local-model bundling, request batching (one post per request keeps verdicts independent and simple; revisit only if cost measurements justify it), ad/promoted-post handling (left untouched and unclassified), browser-level E2E tests (see README).

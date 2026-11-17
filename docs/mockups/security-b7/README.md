# Mockups: security B7 (bridge wording only for a local endpoint), SDLC step 3

`popup-sheet.png`; individual renders `popup-<case>-<light|dark>-<dejavu|liberation>.png`; script `popup-mock.py`
(results in `popup-mock-results.txt`). The **built** popup, headed Chromium (classic scrollbars), Model and Advanced
open, after a successful Test connection:

| Case | What it shows |
|---|---|
| `remote-today` | model `claude-code/sonnet` on `https://openrouter.ai/api/v1`, **today**: chip "claude-code · sonnet", cost **Plan**, "Bridge token", prices "not used", "· via your Claude Code login" |
| `remote-after` | the same settings with the **proposed** behaviour injected into the real popup: chip "sonnet", the dollar estimate, "API key", prices editable (0.15 / 0.6), no suffix after Test connection |
| `bridge-unchanged` | the real bridge (`http://127.0.0.1:8791/v1`), to show it is unchanged |

Checks per render (light and dark, DejaVu Sans and Liberation Sans): horizontal overflow, truncation, text contrast
(own scan), axe (all rules), a visible focus indicator on every tab stop. All pass **except one**, which is not caused
by B7 (next section).

## Found by this audit: finding K (not B7)

`remote-after` in the wide font fails the truncation check: the cost tile shows **`$0.00…`** instead of `$0.0070`. The
same happens in **today's** popup with any ordinary provider whenever the session cost is under one cent (shown with four
decimals: `$0.0070`, `$0.0018`) and the popup has a scrollbar (Model and Advanced open): the value needs 63 px and the
tile has 59 px. Evidence (today's built popup, `openai/gpt-4o-mini`): `docs/mockups/finding-k/evidence-dejavu-scrollbar.png`.
Finding F's layout check missed it because its "realistic" values were `$21.83` and an extreme `$1,234.56`; sub-cent
costs, the most common case with a cheap model, were not among them. Raised as **finding K**; the B7 renders are
otherwise as intended.

The screenshots are taken with the whole popup visible (no scrollbar), so they show `$0.0070` complete; the check ran
at Chrome's real popup height (600 px, with the scrollbar).

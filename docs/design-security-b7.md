# Design: security B7, bridge wording for a non-local endpoint

Status: **implemented** (design and mockups approved; `docs/implementation-plan-security-b7.md`). From `docs/security-review-bridge.md` (B7, Low; decision: fix).

## Problem

The popup treats a model id starting `claude-code/` or `codex/` as "served by the local bridge" **whatever the
endpoint is**. With such a model id on any other endpoint (a typo, a proxy, a provider that happens to use that prefix),
the popup:
- shows **Plan** in the cost tile instead of a dollar estimate, so per-token costs are hidden;
- says "· via your Claude Code login" after Test connection, and words network and busy errors as if the bridge were
  meant ("Could not reach the bridge at …");
- labels the key field **Bridge token**, disables the price fields ("not used") and does not save prices.

Each of these misleads about where posts go and what they cost.

## Proposed behaviour

"The bridge" means: a bridge model id (`claude-code/…` or `codex/…`) **and** a local endpoint (`127.0.0.1`,
`localhost` or `[::1]`, any port; the bridge only ever listens there).

| Where | Decided from | Bridge wording when |
|---|---|---|
| Chip, cost tile, Test connection text, network/busy error wording | the **saved** settings | bridge model id **and** saved endpoint local |
| "Bridge token" label, price fields, what Save sends | the **form** | the bridge preset chosen, **or** a bridge model id typed **and** a local endpoint typed |

Otherwise the popup behaves as for any provider: chip shows the last part of the model id, the cost tile shows the
estimate from the saved prices (or "—"), Test connection has no suffix, errors use the general wording, the key field
is "API key", prices are editable and saved.

No new message is added for the mismatch (a bridge-like model id on a remote endpoint): the popup simply stops
claiming it is the bridge. Test connection against a remote endpoint then reports whatever that endpoint says.

## Mockups (step 3)

Only the mismatch case changes on screen. The built popup with model `claude-code/sonnet` on
`https://openrouter.ai/api/v1`, today vs after (light and dark, two fonts), with the same checks as B4
(layout, contrast, axe, keyboard); and the normal bridge case, to show it is unchanged.

## Scope

`src/popup/popup.ts` only (one helper for "is this the bridge", used in the places above). No bridge or extension
background change.

## Tests (outline)

For saved settings with a bridge model id: local endpoint (`127.0.0.1`, `localhost`, `[::1]`, another port) → bridge
wording everywhere (today's tests unchanged); remote endpoint (`https://openrouter.ai/api/v1`, `http://192.168.1.5:8791/v1`,
`http://localhost.evil.example:8791/v1`) → chip last segment, dollar estimate, no suffix, general error wording. In
the form: typing a bridge model id with a remote endpoint keeps "API key" and editable prices, and Save sends the
prices.

# Mockups: local CLI bridge (SDLC step 3)

Popup mockups use the **real** `public/popup.css` and popup structure. Rules marked "PROPOSED" are new. Yellow dashed
outlines mark new or changed elements (mockup only).

| File | What |
|---|---|
| `popup-bridge-light.png`, `popup-bridge-dark.png` | A: connected through the bridge; B: the errors the bridge can surface through Test connection |
| `terminal.png` | The bridge's own output: a passing start, Codex refused by the canary, a missing flag, not logged in |

## Popup

- **Provider:** the help line is linked to the select with `aria-describedby` (audit R4).
- **Provider:** a new preset, "Local CLI bridge (Claude Code / Codex)". It fills the endpoint
  `http://127.0.0.1:8791/v1`, concurrency 1 and timeout 90 s, and shows a one-line help with the start command.
- **"API key" is relabelled "Bridge token"** while this preset is selected. It is the same field and the same storage.
- **Price fields** are disabled ("not used") for bridge models.
- **Model chip:** `claude-code · sonnet`. The chip normally shows only the last path segment ("sonnet"), which would hide
  which CLI serves it.
- **Test connection:** "Connected · replied in … · via Claude Code subscription" (derived from the model id's prefix).
- **Cost tile:** value **"Plan"** under "est. cost"; tooltip "Billed to your subscription via the local bridge · no
  per-token cost". The design's wording, "subscription", does not fit a tile at 360 px (checked in the render).
- **Errors (B):** the existing error line, with bridge-specific wording: not reachable (with the start command), bad
  token, wrong model (names the model the bridge serves), busy (Signal retries).

## Terminal

- **Colours are illustrative:** the bridge prints plain text; every state is in words (finding H, decided; see
  `docs/mockups/security-b1-b2/README.md`).

- **Illustrative:** the version numbers, timings, token counts and the Codex outcome. The real Codex outcome is unknown
  until run (design §2).
- The token is printed **in full once**, when it is first created (it must be pasted into Signal), as the mockup now
  shows. Later starts print only where it is stored.
- **At most 78 columns** per line (audit R3), so the output reads cleanly in a standard 80-column terminal.
- Log lines carry time, outcome, duration, token counts and queue depth: **never post text**.

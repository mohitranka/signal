# Implementation plan: security B4 ("subscription, never API billing" overstated)

Status: **implemented**.
Design: `docs/design-security-b4.md` (approved). Mockups: `docs/mockups/security-b4/` (approved, audited twice).

## Changes (one task, one commit)

- `bridge/adapters.ts`: a `billingNotice` per CLI (the three lines of each mockup); the `label` comment no longer says
  "subscription".
- `bridge/selftest.ts`: the test-classification line is `ok  <s> s` (no "· subscription"); the not-logged-in
  sentence ends "the bridge never passes an API key.)".
- `bridge/main.ts`: prints the CLI's billing notice once, after the checks pass and before "Listening" (not on B2
  re-checks: it does not change); file comment reworded. `bridge/request.ts`: comment reworded.
- `public/popup.html`: the help line's new text. `src/popup/popup.ts`: Test connection "· via your <CLI> login"; the cost
  tile's tooltip "Through your <CLI> login via the local bridge · no per-token estimate (billed as your CLI is set up)".
- README: the five passages of the design's table (intro, guarantees, providers table, the checklist's Test-connection
  text) and a new checklist step: check how your CLI itself is logged in. `docs/design-bridge.md`: I2 reworded.

## Tests first (red before the change)

| # | File | Case |
|---|---|---|
| 1 | `bridge-selftest.test.ts` | The test line is exactly `ok  <n.n> s` with nothing after it (today: "· subscription"); the not-logged-in text ends "(ANTHROPIC_API_KEY is ignored on purpose:" / "the bridge never passes an API key.)" (Codex: `OPENAI_API_KEY`) |
| 2 | `bridge-main.test.ts` | Claude and Codex starts print their three notice lines exactly, right before "Listening", each ≤ 78 columns; a B2 re-check does not print it again |
| 3 | `popup-bridge.test.ts` | Help text (new wording, command still in `<code>`); Test connection "· via your Claude Code login" / "· via your Codex login"; the cost tooltip's new text |
| 4 | `bridge-main.test.ts` (README/docs check) | README and `docs/design-bridge.md` no longer say "No API key, no API billing", "Subscription only" or "never API billing"; README has "The bridge never passes an API key" and the checklist step about the CLI's own login |

Existing assertions that quote the old texts are updated in the same step (they are the spec this finding changes):
the passing-start regex (`· subscription`), the not-logged-in text, the three popup texts.

## Step 5 (tests first): results

**11 red**, all for the expected reason (the old wording, or no notice yet): self-test 4 (the test line in both
passing starts; the not-logged-in sentence for both CLIs), main 4 (the Claude and Codex notices, "printed once" around a
re-check, the README/design wording), popup 3 (help text, Test connection, tooltip). One popup test was renamed with its
new expectation, so the test report lists its old name as missing. Rest of the suite unchanged.

## Done when

All red first, then green; full suite (normal and slow), typecheck and build green. By hand: the recordings behind
`terminal.png` and the popup renders behind `popup-sheet.png` against the changed code, matching the mockups.

## Step 6 results

- The 11 red tests green; full suite 742 passed, also with `SIGNAL_TEST_SLOW_HASH=25`; typecheck and build green.
- By hand: `npm run bridge` with the fake Claude prints exactly the mockup's lines (compared line by line, timings
  aside): the test line without "· subscription" and the three-line notice before "Listening".
- Browser checks on the built popup: the bridge preset check (`docs/mockups/bridge/as-built/check.py`) first **failed**,
  because it still expected the old wording; its two expectations were updated to the approved texts and it passes in
  light/dark and both fonts (contrast 0, axe 0). Finding G's contrast check and finding F's layout check still pass.
- README checklist: the new step is step 5 (its first insertion landed after step 5 and was renumbered).

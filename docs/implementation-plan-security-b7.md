# Implementation plan: security B7 (bridge wording only for a local endpoint)

Status: **implemented**.
Design: `docs/design-security-b7.md` (approved). Mockups: `docs/mockups/security-b7/` (approved).

## Changes (one task, one commit)

- `src/shared/settings.ts`: export the existing `LOCAL_HOSTS` (`localhost`, `127.0.0.1`, `[::1]`), the list that already
  decides where plain `http` is allowed, so "local" means one thing in Signal.
- `src/popup/popup.ts`:
  - `isLocal(endpoint)`: the URL parses and its hostname is in `LOCAL_HOSTS` (so `localhost.evil.example` or a LAN
    address is not local).
  - `bridgeSaved()`: the saved model's bridge CLI only when the saved endpoint is local. Used by the chip, the cost
    tile, the Test-connection suffix and the bridge error wording (today they use the model id alone).
  - `bridgeForm()`: the bridge preset, or a bridge model id **and** a local endpoint typed in the form. Used by the key
    label, the price fields and Save (as today, plus the endpoint condition).
  - The form re-applies on endpoint edits too (today only on model edits and preset changes).

## Tests first (red before the change), in `popup-bridge.test.ts`

| # | Case |
|---|---|
| 1 | Saved `claude-code/sonnet` on `https://openrouter.ai/api/v1`: chip "sonnet"; cost tile the dollar estimate with "Estimated from your configured prices"; key label "API key"; prices editable; Test connection without a suffix |
| 2 | Same settings: a network error uses the general wording (not "Could not reach the bridge"); a rate-limit error too |
| 3 | Not local although they look close: `http://localhost.evil.example:8791/v1`, `http://192.168.1.5:8791/v1`, `https://127.0.0.1.nip.io/v1` → no bridge wording |
| 4 | Local: `http://[::1]:8791/v1` → bridge wording (the existing tests cover `127.0.0.1` and `localhost` on another port) |
| 5 | Form: typing a bridge model id while the endpoint is remote keeps "API key" and editable prices, and Save sends the prices; then typing a local endpoint switches to "Bridge token" |

Existing bridge tests stay as they are (their endpoints are local).

## Step 5 (tests first): results

5 new tests: **4 red** (#1, #2, #3, #5: today the model id alone decides), #4 (`[::1]`) green as expected (a guard).
Existing bridge tests unchanged and green.

## Done when

All red first (except #4, which may already pass: it guards the local case), then green; full suite, typecheck and
build green; `docs/mockups/security-b7/popup-mock.py` re-run against the changed popup with the "remote" case now
showing the "after" behaviour without injection (the wide-font `$0.00…` remains: finding K).

## Step 6 results

- The 4 red tests green, the guard green; full suite 747 passed, also with `SIGNAL_TEST_SLOW_HASH=25`; typecheck and
  build green (the popup bundle is still free of Node built-ins: `LOCAL_HOSTS` comes from `src/shared/settings.ts`).
- Mutation: `bridgeSaved()` without the local-endpoint condition → 3 tests fail.
- Browser: `docs/mockups/security-b7/popup-mock.py` against the changed popup: the real "remote" case now shows exactly
  the approved "after" (chip "sonnet", `$0.0070`, "API key", prices editable, no suffix); the real bridge case unchanged.
  The only failure left is finding K (`$0.00…` in the wide font with a scrollbar), as expected. The bridge preset check,
  finding G's contrast check and finding F's layout check still pass.

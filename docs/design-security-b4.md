# Design: security B4, "subscription, never API billing" is overstated

Status: **implemented** (design and mockups approved; `docs/implementation-plan-security-b4.md`). From `docs/security-review-bridge.md` (B4, Low–Medium; decision:
fix the wording and add a start-up notice).

## Problem

The bridge removes API-key **environment variables** before running the CLI (I2). It does not control how the CLI is
**itself** logged in or configured:
- Codex can be logged in with an API key instead of a ChatGPT account;
- Claude Code's user settings (which the bridge loads, `--setting-sources user`) can supply an API key (an `apiKeyHelper`,
  or an `env` entry). The same settings can define **hooks**, which receive what Claude Code receives, i.e. the post.

Then every post is billed to that API account, while Signal and the bridge say "subscription" and "never API
billing" in seven places. The bridge cannot tell which applies: the files that would say so have formats nobody could
check here.

## Proposed behaviour

**1. Say what the bridge actually guarantees, everywhere** (before → after):

| Where | Today | Proposed |
|---|---|---|
| README, bridge intro | "No API key, no API billing." | "The bridge never passes an API key; billing is whatever your CLI is logged in with (a subscription, normally)." |
| README, guarantees | "**Subscription only.** … `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` … never reach it." | "**No API key from the bridge.** … never reach it. If the CLI itself is logged in with an API key, or Claude Code's settings supply one, that account is billed; those settings (and any hooks in them, which would receive each post) are yours, not the bridge's." |
| README, providers table | "i.e. your Claude or ChatGPT **subscription**" | "normally your Claude or ChatGPT **subscription** (see *Local CLI bridge*)" |
| Design I2 | "Subscription, never API billing." | "No API key from the bridge" + the same limit |
| Terminal, test classification line | `ok  3.9 s · subscription` | `ok  3.9 s` (the bridge cannot know) |
| Terminal, not logged in | "(ANTHROPIC_API_KEY is ignored on purpose: the bridge never bills the API.)" | "(ANTHROPIC_API_KEY is ignored on purpose: the bridge never passes an API key.)" |
| Popup, preset help | "Uses your logged-in Claude Code or Codex subscription through a small server on this computer." | "Uses the Claude Code or Codex CLI you are logged in to, through a small server on this computer." |
| Popup, Test connection | "… · via Claude Code subscription" | "… · via your Claude Code login" |
| Popup, cost tile tooltip | "Plan · Billed to your subscription via the local bridge · no per-token cost" | "Plan · Through your Claude Code login via the local bridge · no per-token estimate (billed as your CLI is set up)" |

The tile's value stays **Plan** (it fits, and for the normal case it is right); the tooltip carries the limit.

**2. A start-up notice**, printed once after the checks pass, before "Listening" (three lines, ≤ 78 columns):
```
Billing: the bridge passes no API key. If claude is set up with one (an
apiKeyHelper or API key in ~/.claude/settings.json), that account is
billed, not your subscription.
```
For Codex:
```
Billing: the bridge passes no API key. If codex is logged in with an API
key rather than your ChatGPT account, that account is billed, not your
subscription.
```

Not proposed: reading the CLIs' settings or login files to detect an API key. Their formats are unverified here, a
wrong guess would give false reassurance, and the files hold secrets the bridge should not open. Your manual check
(README checklist) gains one step: confirm the CLI's own login (e.g. its status or settings command).

## Scope

README, `docs/design-bridge.md` (I2), `bridge/selftest.ts` (two lines), `bridge/main.ts` (notice),
`bridge/adapters.ts` (notice text per CLI), `public/popup.html` (help line), `src/popup/popup.ts` (tooltip, Test
connection). Also the code comments that repeat the claim (`bridge/main.ts`, `bridge/request.ts`).

## Mockups (step 3)

The popup: the changed help line, Test-connection line and tooltip, rendered in the real popup like the approved
bridge mockup (light and dark, two fonts; layout, contrast and axe checks). The terminal: the notice and the changed
lines, with the audits used for B3–B6.

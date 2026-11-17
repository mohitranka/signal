# Design: security B6, token folder and file ownership

Status: **implemented** (design and mockups approved; `docs/implementation-plan-security-b6.md`). From `docs/security-review-bridge.md` (B6, Low; decision: fix).

## Problem, re-examined

Step 8 showed that a token folder writable by everyone (`0777`) is accepted, and that a token file replaced in it is
accepted. That demonstration replaced the file **as the same user**. Thinking through a **different** user, which is
the real threat, the picture is narrower:

- A file the other user creates is owned by them. If it has any group or other permission bit, the existing check
  refuses it; if it is `0600`, the bridge cannot read it and fails. So on Linux a planted token is **not** accepted.
- **But on macOS**, ACLs are not visible in the permission bits: a file owned by someone else, mode `0600`, with an ACL
  that lets you read it, passes today's check. Its owner knows the token and can use your bridge (within I6:
  classification only).
- Whoever can write the folder, or a folder above it (`~/.config`), can also **delete or replace** the token
  (the bridge then stops working or creates a new token on its next start), or move the whole folder aside and put
  their own in its place (the same macOS case).

Found while re-examining: the token messages are printed as **one line of up to ~180 columns** (measured: 182 for the
"readable by other users" message), against the bridge's 78-column rule. The tests did not cover token messages.

## Proposed behaviour

1. **The token folder and every folder above it** are checked with the same rules as the CLI's folders (B1): owned by
   you or root, not writable by others (a sticky folder like `/tmp` only as a parent), group-writable only for your own
   primary group. This runs before the token is read or created. A folder the bridge creates itself is made `0700`.
2. **The token file must be owned by you** (in addition to today's "no group or other bits"), checked on the open file
   (no race between check and read).
3. **Messages wrapped to 78 columns**, each naming the file or folder and the exact fix:
   ```
   Not starting. The bridge token folder is writable by other users:
     ~/.config/signal-bridge
   Fix it with: chmod 700 ~/.config/signal-bridge
   ```
   ```
   Not starting. The bridge token file is owned by another user:
     ~/.config/signal-bridge/token
   Remove it and start again (a new token is created): rm ~/.config/signal-bridge/token
   ```
   (The second one is 81 columns as drafted; step 3 will fit it.) The same layout for "can be read by other users"
   (`chmod 600`), "not a valid token" (`--new-token`) and "cannot create the folder".
4. Windows: not checked (ACLs), as for the CLI's location (B1), said in the README.

## Terminal output

The messages above; step 3 renders them, like the other terminal mockups, and runs the same browser audits.

## Scope

`bridge/token.ts` (folder and owner checks, messages as lines), `bridge/runner.ts` (the B1 folder rules, shared),
`bridge/main.ts` (prints the lines). README: one sentence in the bridge section. No extension change.

## Tests (outline)

Folder writable by others → refused, naming it, `chmod 700`; a folder above it writable by others → refused, naming
that one; group-writable by your own primary group → accepted; a sticky parent → accepted; file owned by another user
(modelled with the injectable file-system view, as in B1, since a test cannot create such a file) → refused; today's
cases keep working (create `0700`/`0600`, reuse, rotate, "readable by others", "not a valid token"); every message line
≤ 78 columns (including the existing ones).

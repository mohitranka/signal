# Security review (SDLC step 8)

Scope: the whole extension, with depth on what this work added or changed: repeated templates (T1–T12), findings
A–E, and `npm run check-lock`. Each finding below was **verified** (reproduced or demonstrated), unless marked as
reasoning only.

## Still holds (checked)

- **Permissions unchanged.** `storage`, LinkedIn host, optional LLM host; nothing added. No `innerHTML`, `eval` or
  `new Function` anywhere in `src/`.
- **Content script boundary.** Still limited to `classify / cancel / cancelAll / getState / setFeedback`. The new
  `noRepeat` is honoured only when it is literally `true`. A content script cannot supply a signature or a `repeatOf`:
  the background computes both (tested). `repeatOf` in stored feedback is validated (fingerprint format, 0.85–1) before
  it is stored.
- **Storage.** `storage.local` remains restricted to trusted contexts, so content scripts cannot read signatures.
  Stored signatures, index keys and timestamps are validated entry by entry on load. Maps (not plain objects) hold
  untrusted keys.
- **In-feed UI.** The note and "Judge separately" are built with `textContent` in the closed shadow root; the button
  ignores untrusted (page-script) clicks (tested).
- **Credentials (A, A2).** A request from before a cancel all never calls the model. From the moment a Save arrives, no
  model call starts with a replaced endpoint or key (tested, timeline re-run).
- **Regexes** in the signature cleanup are linear; inputs are size-capped before signing.

## Findings

| # | Finding | Severity | Verified | Recommendation |
|---|---|---|---|---|
| S1 | `check-lock` prints registry and lockfile text unfiltered to the terminal | **Medium** | ✅ | **Fixed** (+ U+061C added to `printable()`) |
| S2 | Public MinHash seeds let an attacker craft a post with the *same signature* as a known post | **Low–Medium** | ✅ | **Fixed** (SipHash-2-4, per-install key); short appendages remain under S3 |
| S3 | A near-copy plus bait, judged first, can make a later legitimate post copy "collapse" | Low–Medium | reasoning | Accept + document (or option b) |
| S4 | README and `check-lock` suggest bypassing the lockfile with no supply-chain warning | **Medium** | ✅ (text) | **Fixed** |
| S5 | `check-lock` trusts plain-`http` registries | Low | reasoning | **Fixed** (also disabled TLS checks) |
| S6 | `check-lock` hardening: no timeout, package names not validated, prototype lookups | Low | ✅ (S6b, S6c) | **Fixed** (+ non-string integrity = mismatch) |
| S7 | A content script's `cancelAll` cancels **every tab's** work | **Medium** | ✅ | **Fixed** |
| S8 | Stored hashes allow "was this exact post seen?" checks by someone with profile access | Info | reasoning | Accept (S2's fix also covers signatures) |
| S9 | The settings-save hold has no timeout | Info | reasoning | Accept |

### S1: terminal-escape injection in `check-lock` (Medium)

`check-lock` prints package names (from the lockfile) and version strings, integrity values and error messages (from
the **registry**) without filtering control characters. It breaks the project's own rule S5 (`printable()` before
printing untrusted text), which the eval CLI follows. Reproduced with a hostile registry: 5 control characters reached
the terminal, including `ESC[2K\r` (erase the line and overwrite it). A malicious or compromised registry, which is
exactly the adversary an integrity check exists for, can overwrite the **INTEGRITY MISMATCH** warning with
"all entries match".
**Fix:** pass every untrusted string through `printable()` (shared with eval), with a test mirroring S5.

### S2: crafted posts with an identical signature (Low–Medium)

The seeds are in the source, so anyone can compute any post's signature and its full 32-bit minima. An attacker can
append words whose new chunks never beat those minima, leaving the signature **unchanged**. Demonstrated: a 19-word
spam payload appended to a kept post gives estimated similarity **1.0**, after 210 tries (instant). Punctuation and
emoji are free. Look-alike letters (Cyrillic `е`) and synonyms make the payload read naturally.

The crafted post copies the verdict, and **the model never sees the payload**. Two uses:
- **(a) Spam evades collapse** by copying a "keep". Impact is limited: "keep" means LinkedIn's own rendering.
- **(b) Hide a legitimate post:** the attacker crafts a bait post with the same signature as a legitimate post they can
  predict (e.g. a recurring template). If the bait is judged first and collapsed, the legitimate post copies "collapse".
  This needs the target text in advance and first-seen order. It affects one viewer, it is reversible (note + Judge
  separately), and Review mode hides nothing. It still goes against the design rule "a wrongly hidden good post costs
  more than a missed bad one".

**Fix:** a **per-install secret** mixed into the chunk hashes: 32 random bytes generated once, kept in `storage.local`
(trusted contexts only, so neither content scripts nor pages can read it). Without it an attacker cannot compute the
victim's minima, so crafting is no longer feasible. Natural repeats are unaffected (same text, same secret → same
signature). Eval and tests keep a fixed secret so results stay reproducible. The signature version goes to 3; the index
is rebuilt once, as in finding C.

### S3: near-copy plus bait, no crafting (Low–Medium, reasoning)

Even with S2 fixed, an attacker can post a **genuine** near-copy of a predictable legitimate post with a few bait words
("Agree? ♻️ Repost"). That stays above 0.85 for long posts. If the viewer's model sees and collapses the bait version
first, the legitimate post later copies "collapse". Limits: the attacker needs the text in advance and to be seen first;
the effect is one viewer's feed and reversible; and the model might not collapse a post that is 95% someone's genuine
content anyway.
**Options:**
- **(a) Accept and document (recommended).** Existing mitigations: note, Judge separately, Review mode, highlights never
  copied.
- **(b) Make copied collapses stricter:** copy "collapse" only at ≥ 0.90 similarity. (Author-based rules are not an
  option: Signal deliberately ignores authors.) This reduces recall for the main use case (repeated bait templates),
  for an attack that needs foreknowledge.

### S4: lockfile bypass advised without a supply-chain warning (Medium)

The README (Install) and `check-lock`'s own hint suggest `npm install --no-package-lock --no-save` when the registry is
behind. That ignores the lockfile's pinned versions **and integrity hashes**, and installs whatever is newest in range,
including a newly published malicious version (a common npm attack vector). This project's sandbox itself ran that way
(its direct dependencies matched the lockfile exactly; three transitive packages did not).
**Fix:** reword both. The fix is an up-to-date registry. The bypass is a last resort for a throwaway environment; never
ship a build made that way; and run `check-lock` against the public registry once it is reachable.

### S5: plain-`http` registries trusted by `check-lock` (Low, reasoning)

Over `http` a man-in-the-middle can forge packuments whose integrity "matches", so `check-lock` reports all clear.
**Fix:** warn prominently when the registry is not `https` (localhost excepted), and never print "all entries match"
without that warning.

### S6: `check-lock` hardening (Low)

- (a) `fetch` has no timeout: a stalling registry hangs the tool.
- (b) Package names come from the lockfile and are put into the URL after replacing only the first `/`. A crafted name
  can reach other paths on the registry host (GET only).
- (c) `versions[version]` uses a normal property lookup. A lockfile entry with version `constructor` is reported as
  published (verified).

**Fix:** `AbortSignal.timeout` per request; validate names against npm's naming rules and encode them properly;
`Object.hasOwn` for version lookups.

### S7: one tab's `cancelAll` cancels every tab (Medium)

`cancelAll` from a content script (sent when a tab leaves the feed, or Signal is switched off) cancels the queue, all
waits, and, since finding A, everything in preparation, **for all tabs**. Reproduced: tab B's in-flight request came
back `aborted` when tab A navigated away. Tab B's posts are then left unclassified until a settings change retries
them. This is an ordinary usability bug (two LinkedIn tabs), and also an abuse path: a compromised content script in one
tab can keep every tab's classification from completing. It predates this work; finding A made it more thorough.
**Fix:** a content script's `cancelAll` releases **only that tab's** interest: its queued or running requests are dropped
or aborted only when no other tab waits for them (as per-post `cancel` already does), plus that tab's own waits. The
full, generation-bumping cancel stays for the popup's Clear cache and model changes.

### S8: membership checks on stored hashes (Info)

Someone with access to the Chrome profile can check whether a specific post was seen. The cache keys' content
fingerprints (unsalted SHA-256) already allow that, and feedback stores marked posts' text. Signatures add nothing new.
S2's per-install secret would make signatures useless for this; fingerprints are left as they are.

### S9: the save hold has no timeout (Info)

If a settings write never settled, model calls would stay held. In practice chrome.storage writes settle or reject (the
hold is released in `finally`), and the service worker's restart clears in-memory holds. Accept.

## Recommendation summary

Fix **S1, S2, S4, S5, S6, S7**. Accept and document **S3, S8, S9**. Each fix goes through steps 2–6 like the findings
(design → plan → failing tests → implementation), one at a time, in the order you choose. Suggested order by risk and
size: S1 → S4 → S7 → S2 → S5 + S6 (together, same file).

## Decisions (aligned)

- **Fix**, each through steps 2–6, in this order: **S1 → S4 → S7 → S2 → S5 + S6**.
- **Accept and document** as known limits: **S3** (option a), **S8**, **S9**.

## Outcome

| # | Result | Commit |
|---|---|---|
| S1 | Fixed: untrusted text printed only via `printable()`; `printable()` also blocks U+061C | `043a483` |
| S4 | Fixed: the lockfile bypass is offered only as a last resort, with its warning; README guard test | `2e060cd` |
| S7 | Fixed: a tab's cancel all cancels only that tab's work | `bb30d99` |
| S2 | Fixed: SipHash-2-4 with a per-install 128-bit key; short appendages remain under S3 | `24b865b` |
| S5, S6 | Fixed: untrusted-transport warning and exit 2; timeout; name validation; own-property lookups | `c5b6898` |
| S3, S8, S9 | Accepted; documented in README, *Known limitations* | (docs) |

Also corrected while documenting: *Known limitations* still said that repetition across different posts is not modeled,
which stopped being true with the repeated-templates feature (missed in T12).

# Finding A2: requests sent while a settings save is being written

Status: **implemented** (`ClassifyService.hold()`, held in the `saveSettings` handler). Follows finding A (`design-finding-a-cancel-all.md`).

## Problem (reproduced in finding A, step 6)

The `saveSettings` handler cancels outstanding work only **after** the new settings are written:

```
message arrives → settings.load() → settings.save(patch) [load + write] → cancelAll() if model/endpoint/key changed
```

During those three storage operations the old settings are still the stored ones, and model calls go ahead with them:

```
 29ms  Save message arrives (new endpoint http://localhost:11434, new key)
 44ms  model call sent to cloud.example.com with OLD-KEY
 61ms  save written → cancel all
```

Two kinds of request go out in that window with the **old endpoint and key**:
1. requests that **start** during it (a new post scrolls into view) and read the still-current old settings;
2. requests that were **queued** (waiting for a concurrency slot) and get their slot during it.

This matters most in the privacy case: switching from a cloud provider to a local model.

Out of reach (and not a bug): a model call already **sent** before the Save message arrived. It was sent under the
settings in force at the time. It is aborted once the save is written (finding A), but it cannot be unsent.

## Proposed fix: hold model calls while model settings are being saved

- `ClassifyService` gets a **hold**: while at least one hold is active, no model call **starts**.
  - The check sits in the queued task itself (where finding A added the generation check): the task first waits for
    active holds to end, **then** checks the generation, then calls the model. A queued task that gets its slot during
    the hold therefore waits, and so does a new request.
  - A call already running when the hold begins is not paused (it was sent before the save). Finding A's cancel aborts
    it after the write, as today.
- Copies are held too: a verdict copied from a similar post is not handed out during the hold. After it, the usual
  generation check applies, so a copy made under the old model is refused if the model changed. Exact-cache hits are not
  held (same rule as finding A: reading a stored verdict sends nothing, and the feed discards results from before a
  model change anyway).
- The `saveSettings` handler takes the hold **synchronously on arrival**, before its first storage read, **if the
  patch contains `model`, `endpoint` or `apiKey`**. It then:
  1. saves;
  2. if model, endpoint or key actually changed: cancel all (finding A's generation bump + aborts), so everything held
     is refused instead of continuing with the old settings it read;
  3. releases the hold. Held calls then continue (nothing changed) or are refused (something changed).
  - It always releases, also when the save fails. Requests then continue with the unchanged old settings, which is
    correct because they are still the stored ones.
- Holds are **counted**, so overlapping saves keep calls held until the last one completes.
- Saves that touch only other settings (mode, sensitivity, highlight, on/off: sent on every popup toggle) take **no
  hold**. Nothing is delayed for them.

### What you notice

Nothing visible. After a model, endpoint or key change, posts prepared during the save show up a few milliseconds later,
classified by the **new** model (the feed already re-requests everything after such a change). After a Save that changed
nothing relevant (e.g. only prices), held calls are delayed by the length of one storage write and then go out normally.

### Alternatives considered

- **Cancel before saving as well as after.** Requests starting between the first cancel and the write still read the old
  settings and can be sent. This narrows the window but does not close it.
- **Read settings at the moment of sending instead of at the start.** This changes every request path, still races the
  write, and a request would mix old and new values (model from one read, key from another).
- **Cache settings in memory and switch them atomically before writing.** If the write then fails, memory and storage
  disagree. A hold plus cancel keeps storage as the single source of truth.

## Scope

- `src/background/classifyService.ts`: `hold()` returns a release function. The queued task and the copy path wait
  for holds to end.
- `src/background/handlers.ts`: `saveSettings` takes and releases the hold as above.
- No message, storage or UI changes. **No mockups (step 3 skipped, if you agree).**
- The README note added in finding A ("Not yet covered: …") is replaced by a statement of what is now guaranteed: *from
  the moment the background receives the Save, no model call starts with the replaced endpoint or key.*

## Risks

- **A hold that is never released** would stop all classification. Mitigation: release in `finally`; tests cover save
  failure and overlapping saves. The hold only lives for the handler's own storage operations.
- Held tasks occupy concurrency slots while waiting (milliseconds). Acceptable.

## Result (step 6)

The timeline that exposed this window, re-run unchanged after the fix (uniformly slow storage, no test gates):

```
 27ms classify #0 starts
 32ms Save message arrives (local endpoint, new key)
 34ms classify #1 starts                      <- a new post during the save
 51ms cancelAll (save is committed)
 53ms classify #0 result: aborted              <- re-requested by the feed under the new settings
 53ms classify #1 result: aborted
 56ms classify #2 starts
 66ms model call sent to localhost:11434 with Bearer NEW-KEY
```

Nothing is sent to the old endpoint after the Save arrives. One detail added within the design: a held task that its
sender cancelled while it waited (`cancel {fp}`) is not started when the hold ends.

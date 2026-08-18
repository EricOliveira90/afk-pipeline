# Per-slice state persistence — outcomes hit disk when they land, not when the wave ends

## Failure mode

`saveSliceState` was only called from the post-wave persist loop in
`orchestrator.ts`, which iterates `runWave`'s outcomes map after the
whole wave has returned. But `wave.ts` finalizes a slice much earlier:
on PASS it merges the slice branch into the feature branch and removes
the worktree, then records the outcome in memory. Between that moment
and the end of the wave, the slice's work is committed and its worktree
is gone, yet nothing on disk says it passed.

Observed in a babysat run of PRD 066 (Kiro backend, one serial lane of
three slices): slice 07 merged into `feat/066-playbook-foundation` and
its worktree was removed, and for the following 40+ minutes — while its
lane siblings kept running — `.afk/state/066-playbook-foundation.json`
still listed only a slice from an earlier wave. A hard kill in that
window (earlier runs of the same PRD were killed twice) would have made
the re-run re-attempt the merged slice from scratch. Because new slice
worktrees fork from the feature branch, the generator would have
collided with its own already-merged output, including the migration
prefix it had just consumed. Lane-successor re-negotiation means one
wave can span hours, so the exposure window is large.

## Decision

`runWave` reports each slice's terminal outcome the moment it is
decided, via a new optional `WaveInput.onOutcome(ghIssue, outcome)`
callback. Every path that records an outcome — negotiate failures, the
between-phases cancellation sweep, lane-refresh failures, Phase B
failures, merge conflicts, post-merge git errors, lane-successor
cancellation, and PASS — funnels through one internal `record()`
helper that updates the in-memory map and invokes the callback.

The orchestrator supplies `persistOutcome` as that callback. It builds
the slice's lifecycle value, calls `logger.transitionTo`, writes the
state file via `saveSliceState`, and emits the run.log line (ADR 0017)
— exactly what the old post-wave loop did, just at outcome time.

### Ordering guarantee for PASS

`record(id, PASS)` sits after `mergeSliceBranch` succeeded and after
`removeWorktree`. PASS is therefore never persisted before the merge
is real, so `isSliceComplete` (`phase === "PASS" &&
mergedToFeature === true`) keeps its meaning: a persisted PASS is
always safe to skip on resume.

### The post-wave loop becomes reconciliation

`persistOutcome` is idempotent: a guard set records which slices have
been persisted, and an id joins the set only **after** the write
succeeded. `runWave` contains callback errors (logs a warning, keeps
the lane running), so a failed mid-wave write degrades to exactly the
old behavior: the post-wave loop calls `persistOutcome` again for every
outcome, which is a no-op for already-persisted slices and a retry for
failed ones. The loop also still updates the in-memory scheduling sets
(`completed` / `failed` / `laneCancelled`), which only matter between
waves.

### Concurrency

Lanes run in parallel, so two slices can reach their terminal outcome
concurrently. `saveSliceState` is a **fully synchronous**
read-modify-write (`loadRunState` → mutate → `writeFileSync`) with no
awaits, so on Node's single thread two invocations can never
interleave inside the critical section — no lost updates. Writing
under the merge mutex was considered and rejected: it would add
coupling for a race that cannot occur, and non-PASS outcomes (which
never touch the mutex) need the same write path.

## Rejected alternatives

- **Persisting from inside `wave.ts` directly.** The wave runner would
  need `loggerSlug`, lifecycle construction, and persistence imports —
  state ownership stays with the orchestrator (ADR 0008); the wave
  reports, the orchestrator persists.
- **Write-ahead PASS (persist before merge).** Violates the
  `isSliceComplete` contract: a crash between persist and merge would
  make the resume skip a slice whose work never landed.
- **Dropping the post-wave loop entirely.** The scheduling sets must
  still be updated between waves, and the loop doubles as the retry
  path for mid-wave write failures.

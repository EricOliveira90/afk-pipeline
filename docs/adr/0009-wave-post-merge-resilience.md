# Wave post-merge step is per-slice fault-isolated

**Date:** 2026-05-24

## Context

A PRD 024 run aborted after Wave 1's slice #274 had successfully
merged into the feature branch. The slice branch
`afk-claude-code/.../slice-04-…` was no longer reachable when the
orchestrator's post-merge guard called `git.hasCommitsAhead` on the
*next* iteration of its lane, and `git rev-list` exited non-zero with
"ambiguous argument". The throw escaped the lane's body, rejected the
outer `Promise.all` in `runWave`, and:

- Slice #271 was still mid-flight in a sibling lane — it never got a
  chance to commit and was reported `STUCK` ("Pipeline aborted before
  slice finished") by `runPipeline`'s top-level catch.
- Wave 2 (#272, #273) never started.

Two distinct failures compounded:

1. **Correctness gap in `git.hasCommitsAhead`**. The helper threw on
   any non-zero git exit. Its only caller is the post-merge guard,
   whose intent is "did this slice produce commits worth merging?" —
   a missing ref answers that question with "no", not with a crash.
2. **Resilience gap in `runWave`**. The `Promise.all` over lanes
   (`src/wave.ts`) had no per-slice fault containment around the
   post-merge block. Phase B already had a try/catch that converted
   a thrown agent invocation into an `ERROR` outcome; the post-merge
   block (`hasCommitsAhead` → `mergeSliceBranch` → `removeWorktree`)
   was unwrapped, and any throw propagated up through `Promise.all`.

The branch-disappearance cause was upstream — likely an agent
operation inside the worktree that rewrote local refs — but the
*observable* failure mode (whole-pipeline crash) was the resilience
gap, not the upstream cause. Fixing the resilience gap also makes the
pipeline robust to future variants of the same shape (locked index,
transient FS errors, ref-transaction failures during concurrent
merges).

## Decision

**`hasCommitsAhead` returns `false` on any git failure**, including
missing refs. The post-merge guard already treats `false` as "this
slice produced no output → ERROR with the existing no-commits
message". A missing source ref is functionally equivalent to "no new
commits to contribute", so collapsing both into the same outcome is
semantically correct, not a swallowing of meaningful errors.

**The post-merge block in `runWave` runs inside a try/catch** that
mirrors Phase B's shape: thrown errors map to an `ERROR` outcome (or
`CANCELLED` when `isCancelled` matches the abort signal),
`cancelLaneSuccessors` runs, and the slice's lane returns normally.
Sibling lanes' promises are unaffected.

We deliberately keep `Promise.all` over lanes rather than swap to
`Promise.allSettled`. With per-slice containment, no rejection can
escape a lane; any future programmer error that *does* leak through
should surface loudly during testing, not be silently absorbed.
`allSettled` would be a belt-and-braces upgrade, but it removes the
existing safety net that says "an unexpected throw here is a bug".

## Consequences

- A slice whose branch is unreachable at post-merge time gets ERROR
  with the existing `Branch X has no commits ahead of Y — generator
  produced no output` message, matching the legitimate "generator
  wrote nothing" path. The user's mental model of "this slice
  produced nothing useful, rerun it" applies in both cases.
- Sibling lanes survive a post-merge failure in their peer.
- Future post-merge git anomalies (locked index, transient FS issues,
  worktree pruning races) all degrade gracefully to a single-slice
  ERROR outcome instead of a wave-wide crash.
- Tests in `src/git.test.ts` (`hasCommitsAhead` against missing refs)
  and `src/wave.test.ts` (sibling-lane survival when one lane's
  post-merge throws) lock the contract.

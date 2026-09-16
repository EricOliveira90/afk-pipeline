# Contract feedback — round 3

Slice: `01-mutation-report-step` (GH #303)

## What round 3 settled

The fork-exit gap is closed. B-11 now declares the whole fork region
(`src/ship-gate.ts:930-947`) wrapped so no exit leaves the step unawaited, and it
names both rejection exits by their actual code — the
`throw architectSettled.reason` / `throw pmSettled.reason` rethrows at `:941-944`
and the rejecting `await runGuardianReview(...)` at `:931-933` — as invoking the
same `terminate` binding before the guardian's reason is rethrown unchanged.
B-12 confirms it is that one binding rather than a second kill path and ties the
claim to ADR 0035's live-`cwd` rule. P-03 carries the observable that was asked
for: in both guardian modes, `terminate`/`quiesceWorktree` on `reviewDir` before
the throw propagates, no mutation process left registered, and a caught reason
equal to the flag-absent run's. The Test plan bullet and the Definition of done
item match. The citation correction checks out against the file: `:947-948` is
the rejoin point and the assignments really are at `:931-933` and `:945-946`.

## What the new wrap leaves open

The mechanism chosen to close that gap has a hole of its own, and it is a hole
the previous round could not have had, because the previous round had no wrap and
the rethrow propagated immediately.

The wrap awaits the step promise **to settlement** with no deadline. B-12 is
explicit that the flat 30-minute bound covers the rejoin exit and that "the wrap
covers the throw exits" — so the throw exits inherit no bound at all. Put that
next to the other new sentence, that `terminate` on a `reviewDir` with no
registered process "is a no-op, so the wrap is safe whether or not the command
has spawned", and the pre-spawn window opens up:

- B-11 starts the step before the fork, and B-10 has the step first derive its
  file scope from `buildChangeSummary` over the run's base and merged tip — real
  git work on the merged review worktree — before the declared command is spawned
  through the `mutationRun` seam.
- A guardian can reject inside that window in seconds (an infrastructure
  rejection out of `runGuardianReview`, or a rejected `Promise.allSettled`
  element).
- The wrap's `terminate` then hits an empty registry and no-ops by declaration,
  and the wrap goes on to await a step promise that spawns the mutation command
  *after* the only quiesce this path performs.

Two consequences follow. The guardian's rejection is held for the whole mutation
run, unbounded — nothing on this path declares `MUTATION_STEP_BOUND_MS` or any
other deadline. And the process the step spawns is registered after that
quiesce, which is exactly the unquiesced-live-`cwd` state ADR 0020 and ADR 0035
exist to prevent. The declared swallow of a `terminate` failure has the same
shape: once the failure is swallowed, the open-ended settlement await is the only
mechanism left, and it is unbounded.

What would close it: bound the wrap's await the way the rejoin exit is bounded —
awaiting the same bounded helper with `MUTATION_STEP_BOUND_MS` rather than an
open-ended settlement await is the straightforward version — and say what stops a
not-yet-spawned command from spawning after the wrap's `terminate` (an
abandonment flag the wrap sets and the step checks before it spawns, or a seam
invocation that is skipped once the wrap has run). Then give P-03's
rejecting-guardian scenario an observable for that window alongside the
pending-promise case it already has: a guardian that rejects *before* the
`mutationRun` seam is invoked, asserting the rejection leaves the gate without
waiting on a subsequent mutation run and that the seam is never invoked
afterwards, or that anything it registered is quiesced.

Nothing else in this revision needs to move. The rest of the pair — the manifest
config surface, the parser and classifier behaviors, the run-state bump with both
of its authorized pins, the two renderers off one reader, and the ADR literal
list — reads the same as it did going into this round.

# A failed focused scope revision restores the accepted lock

Applies ADR 0008 (the on-disk contract is the orchestrator-owned single
source of truth) and ADR 0039 decision 2 (every restart archives first)
to the focused scope-revision path shipped by PRD 2 slice 01 (#80).
Sibling of ADR 0050, which bounds how many revisions a round may grant;
this one governs what the filesystem looks like when one of them fails.
Evidence: the PRD 2 architecture guardian review, round 2, blocking
finding 1.

## What happened

`runFocusedScopeRevision` read the accepted `contract.md` and
`acceptance-manifest.json` into memory, then immediately called
`reopenContract` and deleted the manifest — both before invoking the
planner that writes the replacement. The two saved values were used only
at the end, to describe a successful revision's diff to the evaluator.
There was no `catch` and no `finally`.

So every exit short of a locked replacement left the slice's authoritative
state destroyed:

- a planner or provider exception propagated to `runSliceExecute`'s generic
  `ERROR` return, with the previous contract reopened and the previous
  manifest gone;
- a stability, coverage, binding or undeclared-path validation failure did
  the same;
- an evaluator `REVISE` returned `ERROR` with the *unaccepted* revision
  sitting on disk as though it had been accepted;
- a cancellation left whichever of those states it interrupted.

The slice's existing escalation-failure coverage stops before revision
planning, so nothing exercised the window.

This is worse than a wedged slice. ADR 0039 decision 2 exists because a
slice's contract artifacts live in its worktree and that copy may be the
only one; a run that ends `ERROR` with the contract reopened has thrown
away the state a restart would have archived, and an operator reading the
tree cannot tell an accepted lock from a rejected draft.

## Decision

**A focused scope revision is a transaction.** The accepted `contract.md`
and `acceptance-manifest.json` are captured before the first mutation, and
restored byte-for-byte on every exit that is not an ACCEPTed, re-locked
replacement — planner throw, validation failure, undeclared-path refusal,
malformed review artifact, evaluator `REVISE`, cancellation.

Mechanically: `runFocusedScopeRevision` is a thin wrapper whose `finally`
restores unless the inner `reviseAcceptedContract` reached
`lockContract`. Success is signalled by the inner function, not inferred
from the return value, so a future exit path added inside it is rolled
back by default rather than silently exempted.

**The rollback is announced.** It logs a phase line naming both files, so
an operator reading the run log after an `ERROR` knows the contract they
are looking at is the pre-revision one and not a half-applied edit.

**The escalation archive is not part of the transaction.** It is written
by the caller before the revision starts (ADR 0050) and survives the
rollback. That is deliberate: the evidence an operator needs to
hand-declare the paths must outlive the failure, even though the contract
must not change.

## Consequences

- A failed revision now costs the slice its round and nothing else. The
  contract is exactly as the evaluator last accepted it, the generator's
  commits are on the slice branch, and a resume renegotiates from a
  coherent starting point.
- Restoring rather than repairing means a revision that failed *after*
  writing a valid wider contract discards that work. Correct: nothing
  accepted it, and ADR 0008 does not let an unevaluated contract be the
  source of truth.
- Only the contract and its manifest are restored. The per-round
  `feedback-r<n>.md` and `contract-review.json` the revision deletes are
  already archived under `reviews/` before deletion, so they are recoverable
  from the archive rather than from the worktree.
- `runFocusedScopeRevision` still duplicates the ordinary planner/
  evaluator/archive/lock protocol — the ADR 0050 shotgun-surgery risk is
  unchanged, and this ADR adds a third invariant that a future shared
  protocol would have to carry.

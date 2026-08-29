# Focused scope revision is bounded per implementation round

Applies ADR 0041 (when classification is uncertain, choose the branch
that cannot loop) to the generator scope-escalation protocol shipped by
PRD 2 slice 01 (#80). Sibling of ADR 0048's amendment allowance, which
bounds the same class of grant on the QA side. Evidence: the PRD 2
architecture guardian review, blocking finding 1.

## What happened

The escalation protocol is deliberately free: a generator that stops
before an undeclared edit has not failed, so re-dispatching it under a
widened contract spends no implementation round. `runSliceExecute` wrapped
that in `while (true)` and exited only when a generator produced no
`escalation.md`. `generatorAttempt` was incremented for archive names and
never compared against anything.

So a generator that discovers one undeclared path at a time — or one that
simply keeps emitting the same shape of valid escalation for a new path —
could run generator, planner and contract-evaluator invocations without
limit. Nothing in the loop consumed the implementation-round budget, the
contract-round budget, or any other bound. Per-invocation wall-clock
limits bound each agent, not the loop around them, so the cost ceiling
was the operator noticing.

No run hit it. It is the ADR 0041 defect reached by omission rather than
by classification: the branch taken on "the generator asked again" was
the one that cannot terminate.

## Decision

**A focused scope revision is granted at most `2` times per
implementation round.** The counter resets when the round does, so the
three implementation rounds of a slice's life allow at most six
revisions.

Two, rather than ADR 0048's one, because the two grants bound different
things. A QA scope amendment is refused after one because *the tree does
not change between attempts in a round* — an evaluator asking twice is
re-reporting what its first pass should have seen. Here the tree does
change: the generator commits work, then stops at the next boundary it
cannot cross. A second escalation in a round is therefore honest work
continuing, not a re-report. A third is a generator trickling paths one
at a time instead of declaring the scope it needs, and granting them
one-by-one is the loop.

**Exhaustion ends the slice with a persisted reason.** The refusal names
the round, the allowance, the requested paths and the escalation's own
reason, and is persisted as the slice's `error` by the ordinary throw
path. The escalation is archived first, so the evidence the operator
needs to hand-declare the paths survives. The contract is left as locked
and no work is reverted — a wedged slice is recoverable, and the branch
still holds every commit the generator made.

**Refusal is not a resume penalty.** Resuming the slice starts a fresh
round with a fresh allowance, which is the same rule ADR 0048 uses for
amendments.

## Consequences

- `MAX_SCOPE_REVISIONS_PER_ROUND` in `src/orchestrator.ts` is the single
  place the number lives, next to `MAX_SCOPE_AMENDMENTS_PER_ROUND`.
- A slice whose contract genuinely needs three separate discoveries in
  one round now ends ERROR instead of finishing. That is the intended
  trade: the operator hand-declares the remaining paths or renegotiates,
  and the generator's committed work is intact either way.
- `runFocusedScopeRevision` still duplicates the planner/evaluator/
  archive/lock protocol that normal negotiation owns. The bound does not
  fix that duplication; it is tracked separately as a shotgun-surgery
  risk under ADR 0008.

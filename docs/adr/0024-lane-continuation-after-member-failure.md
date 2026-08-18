# Lanes continue past a failed member; LANE-CANCELLED reserved for corruption

## Failure mode

ADR 0005's rule — any lane member's failure cancels every member behind
it — turned one bad slice into serial collateral damage. In the PRD 075
babysit run, slice 09 (#686) depended only on #679 (PASS since run 1),
yet was LANE-CANCELLED three consecutive runs purely because #687 hung
ahead of it in the lane. The operator paid three recovery cycles for a
slice the DAG says is independent.

Issue #18 proposed isolating previously-failed slices into their own
lanes on retry runs. Investigating the codebase pointed at the issue's
own alternative as the stronger fix: don't cancel in the first place.

## Why cancellation was never load-bearing

Lane order exists for *file-overlap merge safety* (ADR 0005), not
dependency ordering:

- **Dependency safety** is the orchestrator's job — DAG dependents of a
  failed slice are already held back by the readiness check. Every
  slice in a wave was, by construction, DAG-ready.
- **Merge safety** comes from serialisation, and continuation preserves
  it: lane members still run one at a time, and every successor already
  goes through the full refresh path (`recreateWorktreeFromBase` onto
  the current `featBranch` tip + delete stale artifacts + re-negotiate)
  regardless of what happened ahead of it. A successor running after a
  predecessor *failure* sees exactly the world the next pipeline re-run
  would have shown it: the feature branch without the predecessor's
  work. Its planner writes a contract against that real base.
- ADR 0005's stated rationale — "a successor would re-derive the
  predecessor's missing work or build on code that isn't there" — is
  the ordinary condition of any slice whose file-neighbour hasn't run
  yet. The re-negotiate makes it safe; nothing about a predecessor
  *failure* makes it less safe than a predecessor that simply hadn't
  been scheduled.
- When the failed predecessor retries on the next run, it re-negotiates
  against a base that now includes the successor's merged work; a real
  overlap surfaces as a visible CONFLICT — the merge mutex and
  ADR 0010's checks are unchanged.

## Decision

On a lane member's failure (`STUCK` / `ESCALATE` / `ERROR` /
`CONFLICT` / negotiate non-LOCKED / thrown errors), record the outcome
and **continue with the next member**, logging the continuation
explicitly (`Slice #687 failed (ERROR) — its lane continues with #686
on the current feat/<slug> tip`).

Two exceptions still stop the lane:

1. **User cancellation** — the lane returns; the orchestrator's abort
   sweep marks the rest CANCELLED (ADR 0003).
2. **The ADR 0010 worktree-corruption signature** (slice branch missing
   after the generator completed) — successors are marked
   LANE-CANCELLED with a corruption-specific reason. Dispatching more
   agents into a repo whose worktree registration already failed
   silently risks compounding the damage; an operator goes first.

`LANE-CANCELLED` therefore narrows from "any predecessor failed" to
"the lane was halted for repository-integrity reasons". Its resume
semantics are unchanged: excluded from readiness for the current run,
naturally re-eligible on the next.

## Relationship to issue #18's proposed fix

Retry-run lane isolation (put previously-ERRORed slices in singleton
lanes) was rejected: forcing a slice that genuinely shares files out of
its lane reintroduces the exact parallel-stale-base merge hazard
ADR 0005 exists to prevent, and it only helps *retry* runs — the
first-run collateral (three lane-mates lost to one hang) would remain.
Continuation fixes both without weakening merge safety, because
serialisation is preserved.

## Supersedes

Partially supersedes ADR 0005's "`LANE-CANCELLED` status" section (the
trigger narrows to the corruption exception; the status semantics
stand).

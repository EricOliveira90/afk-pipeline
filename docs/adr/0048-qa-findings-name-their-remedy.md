# ADR 0048 — QA findings name their remedy; the orchestrator amends the file scope

**Status:** Accepted
**Date:** 2026-08-28

## Context

A QA finding said only *what is wrong*, never *who can fix it*. For every
finding but one class that was the same thing, because the generator is the
only actor a finding is routed to. The exception is the locked contract's
file list.

On the evidence-backbone run, QA raised a boundary finding against slice
#75's test-support changes in `src/resume-integration.test.ts` — a file the
locked contract never declared. The change was correct; the file list was
incomplete. But the generator holds no authority over the locked file list
(ADR 0008 gives the contract to the orchestrator), so the only remedy it
could reach for was reverting its own test support. It did. Commit
`bcbfd7d` left 7 of 13 tests in that file broken, and a ninety-minute round
ended in a destructive remedy for a bookkeeping problem (#112).

This is the defect class the v2 plan's §1 table names: the pipeline
recorded something that misled the next actor. The finding was routed to
the one actor who could not satisfy it honestly.

## Decision

**Every QA finding declares its remedy.** `qa-review.json` /
`uat-review.json` become version 2 and each finding carries:

- `remedy: "SOURCE_CHANGE" | "SCOPE_AMENDMENT"`
- `amendmentPaths: string[]` — empty for `SOURCE_CHANGE`, non-empty for
  `SCOPE_AMENDMENT`

The field is required, not defaulted. An evaluator that has not decided
which remedy a boundary finding needs has not finished the finding, and a
default would silently restore the old routing.

**The orchestrator performs the amendment; the generator never sees the
request.** When a valid QA attempt carries an `OPEN` `SCOPE_AMENDMENT`
finding, the QA loop — before it acts on the verdict — validates the
requested paths and adds them to `acceptance-manifest.json` and to the
contract's `## Files expected to change`, one bullet per path naming the
finding that asked for it. The amendment is recorded as
`qa|uat-scope-amendment-r<N>-a<M>.json` in the slice's review archive and
announced as a `scope-amended` warn event.

The amendment only ever **adds** paths. Behaviors, the migration count and
every other term stay as locked: those are the negotiation's to change.

**Validation refuses, and a refusal never becomes a generator round.** A
requested path is refused when it is not a declarable repo-relative file
path, when the file scope is already `no-repository-changes`, when the
contract already declares it, when it names a migration file (prefixes are
allocated at contract lock — ADR 0028/0034), or when the slice never
changed it. All problems are reported in one message; the slice ends ERROR
with the contract untouched and nothing reverted, so the operator can
hand-amend or renegotiate. Refusing is the conservative outcome: a wedged
slice is recoverable, destroyed work is not.

**An applied amendment buys one extra QA attempt in the same round, not an
implementation round.** The tree was graded against a contract that has
just changed, so the grade is taken again — and only the evaluator can
take it, because a Pass 1 boundary failure means Pass 2 never ran. The
extra attempt uses the same attempt loop as an infrastructure retry and
likewise consumes no implementation round. One per stage-round: the tree
does not change between attempts in a round, so an evaluator asking for a
second amendment is reporting a file it should have seen in the same pass,
and granting attempt after attempt on that basis is a loop with no source
change in it (ADR 0041).

**A resumed run inherits no amendment request.** Attempt records carry the
remedy (record version 2; version 1 records read as `SOURCE_CHANGE` so an
interrupted run can still resume), and `loadQAReviewResumeState` drops
amendment findings from both the restored history and the unresolved set.
Either the amendment landed on disk, in which case the finding is stale,
or it did not, in which case the next QA pass re-raises it against the
contract as it actually stands. What must not happen is a resumed
generator receiving it.

## Consequences

- A correct change in an undeclared file costs one QA re-grade, not a
  reverted round. The expensive failure #112 documents cannot recur by
  the same path.
- The contract on disk stays the single source of truth for scope, and it
  stays the orchestrator's to write (ADR 0008). Agents still never edit
  it.
- Reading a slice's contract after the fact shows which paths were added
  mid-slice and on whose finding, in the contract itself and in the
  archived amendment record.
- A locked file scope can now widen while sibling lanes run. The lane
  partition was computed from the pre-amendment scope, so a path added
  mid-wave can overlap a sibling's declared file. That overlap is not
  created by the amendment — the generator already wrote the file — and
  it surfaces at merge, where conflicts are already handled (ADR 0029).
  The amendment record is what makes it diagnosable.
- The generator prompt now states the prohibition directly: never delete
  working code to satisfy the file list.

## Alternatives considered

- **Let the orchestrator clear the finding and pass the slice.** Cheapest
  — no re-grade. Rejected: QA stops at the first unclean pass, so a slice
  whose only blocking finding was the boundary gap has never had its
  quality pass run. Passing it would ship code no one graded.
- **Derive the undeclared paths from `git` instead of taking them from the
  finding.** Smaller artifact, but it throws away the per-file judgment:
  one finding can cover three undeclared files of which only two belong
  in scope, and only the evaluator can say which. The paths are
  cross-checked against the tree, not replaced by it.
- **Route the amendment through a fresh `evaluator-contract` round.** The
  contract evaluator negotiates a contract before it locks; re-entering
  negotiation mid-execute would reopen behaviors, migrations and the lock
  gate for a bookkeeping change, and it is the larger mechanism #112's
  own scope note warns against.
- **Refuse the amendment and end the slice STUCK with instructions.**
  This is what a *refused* amendment does. As the only behavior it would
  leave every honest scope gap needing a human, which is the wedge the
  defect describes.
- **Make `remedy` optional, defaulting to `SOURCE_CHANGE`.** No fixture
  or prompt churn, but an evaluator that omits the field gets the exact
  routing this ADR exists to remove, and nothing in the run would say so.

## Cross-reference — why "already changed" is required here and forbidden next door

Fifth adjudication gate round, architect blocker 1 (see ADR 0052's amendment
for the full decision). Recorded here because a reader of *this* ADR is the one
most likely to be surprised.

`planScopeAmendment` requires the requested path to be **already changed** —
declaring a path the slice never wrote would tell the next wave's lane
partitioner that this slice owns a file it never touched. The scope-escalation
door added in ADR 0052 does the exact opposite: it refuses the grant if the
worktree holds **any** change outside the locked scope.

That asymmetry is deliberate, and it follows from the warrants, not from the
paths:

- The amendment's warrant is an independent evaluator finding. A generator
  cannot forge one, so "the work is there" is evidence an evaluator judged the
  work correct and only the bookkeeping is wrong — which is what this whole ADR
  is about.
- The escalation's warrant is generator-authored. "The work is there" is
  therefore evidence of nothing, and is exactly the pre-build protocol
  violation that route exists to prevent.

Both doors mutate the locked pair the orchestrator owns (ADR 0008), and both go
through the one contract transaction (ADR 0055 Seam 1 §3). Only the trust in
their warrants differs. Do not "reconcile" them.

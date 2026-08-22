# Recoverable merge deferral: the MERGE-PENDING phase

## Failure mode

In the PRD 076 babysit session a slice negotiated its contract, generated,
passed QA, and committed seven commits to its slice branch. At the merge
mutex the pipeline found that a sibling lane had already merged a
migration carrying the same numeric prefix, recorded `CONFLICT`, and
discarded the slice. The operator paid roughly one slice's worth of tokens
and hours of wall clock, and got nothing back.

Nothing was wrong with the work. Only with a filename.

The original report called the merge-time collision check the bug. It is
not, and this ADR records why: checking the prefixes against the
feature-branch tip and merging **must be atomic**, or a sibling lane
merges a colliding prefix in the window between check and merge. The check
belongs inside the merge mutex and stays there (see
`git.attemptMerge`, invoked under `mergeMutex` in `wave.ts`). The bug is
that the refusal was *terminal*.

## Decision

A merge refused for a migration prefix collision records a new phase,
`MERGE-PENDING`, instead of `CONFLICT`.

`MERGE-PENDING` means, precisely: the slice's work is complete and
committed on its slice branch, QA passed, and the merge was refused for a
reason no human needs to adjudicate. The persisted record carries the
slice branch and the colliding prefixes, so a later run can act without
re-deriving them.

`CONFLICT` keeps its meaning unchanged — a real git merge conflict, human
resolution required, both branches preserved. A slice that hits one still
gets `CONFLICT`.

### Merge-only recovery, before the first wave dispatches

At the start of every run, after the run state is loaded and before wave 1
is composed, the orchestrator attempts merge-only recovery for each slice
recorded `MERGE-PENDING`:

1. Confirm the slice branch exists and has commits ahead of the feature
   branch. If not, the recoverable claim is false — there is nothing to
   merge — and the slice falls through to ordinary dispatch.
2. Inside the merge mutex, re-run the collision check against the
   *current* feature-branch tip and merge. Same critical section as the
   original attempt, via the same function, so recovery is no less safe
   than the merge it repeats.
3. A clean merge records PASS with `mergedToFeature`, removes the
   worktree, and unblocks dependents. No agent is invoked, no tokens are
   spent.
4. A branch that still collides stays `MERGE-PENDING` with a reason
   refreshed against the current tip, and is **not** dispatched for
   regeneration this run. A repeated retry must never escalate into work
   the operator did not ask for.
5. A real merge conflict at this point records `CONFLICT` — a human is
   now genuinely needed.

Recovery runs **before** wave dispatch for two reasons, both load-bearing:

- A recovered slice may unblock DAG dependents. Recovering after wave 1
  would hold those dependents back for an entire run, for a merge that
  took milliseconds.
- Recovery costs seconds and zero tokens. Anything that cheap and that
  likely to change the wave composition belongs ahead of the first agent
  invocation, not behind it.

### Scheduling and reporting

- `MERGE-PENDING` is a non-PASS outcome for scheduling: it does not
  unblock DAG dependents, because nothing of its work is on the feature
  branch. It is held out of readiness for the remainder of the run that
  produced it (its own `mergePending` set, parallel to `laneCancelled`),
  and is naturally re-eligible on the next run.
- By the existing lane rule (ADR 0024) the lane continues past it. The
  lane-continuation line says "deferred its merge", not "failed" — an
  operator reading "failed (MERGE-PENDING)" would go looking for a break
  that isn't there.
- `bucketFor` gives it its own bucket, `deferred`, and `run-summary.md`
  its own "Merge deferred" section. Reporting it under "Failed / Stuck"
  would tell the operator to go fix something that fixes itself.
- `afk clean-failed` treats the worktree as debris — recovery works from
  the branch alone — but never treats the branch as a deletion candidate,
  whatever the commit comparison says.
- `afk status` renders the phase, the colliding prefixes, and the retry
  note, in both the human and `--json` forms. The prefixes ride on the
  `SliceLifecycle` payload, so the `--json` consumer sees them
  structurally rather than parsing them out of prose.

## Alternatives rejected

**Move the collision check out of the merge mutex** (the original report's
framing). Rejected: it is the last line of defense against a cross-lane
prefix race, and it is only sound if it is atomic with the merge. A
cheaper gate at contract-lock is a *filter* in front of it, not a
replacement.

**Automatically renumber the colliding migration.** Renaming the file and
rewriting its references is a semantic change to someone's schema
history, and it is a strictly larger change than keeping the branch and
retrying the merge. `MERGE-PENDING` makes renumbering optional rather than
urgent.

**Keep recording `CONFLICT` and let the operator resolve it.** This is
what shipped before and it is what lost the work: the operator has no
conflict to resolve, and `clean-failed` plus a re-run regenerates the
slice from scratch.

**Cap the retries.** A deferred merge that keeps colliding costs one git
command per run. Capping it would trade a free retry for a terminal state
the operator then has to un-stick by hand.

## Relationship to the surrounding work

Lane grouping on migration paths and the contract-lock collision gate
(both in spec #39) make this phase *rare*. They do not make it impossible
— the merge mutex remains the authority under parallelism — so the
recoverable outcome is what stands behind them.

# `clean-failed` also clears a completed slice's clean worktree

Date: 2026-09-10
Issue: #168

Amends ADR 0023, whose scope sentence — failure-phase debris, registered
non-failure worktrees skipped — no longer describes the command. ADR 0055
Seam 2 §6 already narrowed the same sentence from the other side; this
widens it. Neither changes ADR 0023's scope guarantees, its
branch-preservation guard, or its pass structure.

## Failure mode

The documentation, not the code. PRD 3 shipped shared cleanup eligibility
(commit `183ddac`) and the PRD 3 architecture guardian review flagged the
result as `clean-failed now exceeds its documented command scope`
(`.kiro/specs/afk-v2-context-envelopes/review-architect.md`, note 2, first
raised in round 3):

- `src/cleanup-eligibility.ts:13-27` returns `completed-clean` for a
  merged, clean `PASS` slice.
- `src/clean-failed.ts:217-331` removes that worktree and deletes its
  branch.
- ADR 0023 still says a registered worktree whose slice is not in a
  failure phase is skipped with a report entry.

The behaviour is safe — the review said so, and the guards below are why —
so the cost is entirely to the next reader. An operator or agent who reads
ADR 0023 to find out what `clean-failed` will touch is told it leaves
completed slices alone, and then watches it delete one. A document that
misleads the next operator is the defect class this ADR exists to remove.

## Decision — one eligibility rule, and the completed case is in it

`cleanupEligibility(slice, worktreeIsClean)` is the single predicate. It
answers with a *disposition*, not a boolean:

- `failed-debris` — the slice's phase declares its debris disposable (ADR
  0055 Seam 2 §6). Unchanged from ADR 0023.
- `completed-clean` — a slice is a cleanup target as a *success* when all
  three hold: its phase is `PASS`, **and** its merge into the feature
  branch is recorded (`mergedToFeature === true`), **and** its worktree
  has no uncommitted changes.
- `null` — not a cleanup target.

The three conditions are the decision. Each removes one way cleanup could
destroy work:

- **Phase `PASS`** — the slice is finished, not paused. Nothing is coming
  back to this worktree.
- **Merge recorded** — the slice's commits exist somewhere other than this
  branch. Without this, cleanup would delete the only copy.
- **Worktree clean** — nobody edited it after the PASS. A dirty completed
  worktree is not merely skipped, it is *reported* skipped, naming the
  remedy (`commit or remove those edits before running clean-failed
  again`), because a silent skip is indistinguishable from a command that
  missed one.

Branch deletion keeps ADR 0023's guard unchanged and unconditional: a
branch with commits ahead of the feature branch is kept and reported,
whatever its disposition. So the completed case can delete a branch only
when the merge is recorded *and* `git` agrees nothing is ahead of it — two
independent witnesses to the same fact.

Everything ADR 0055 Seam 2 §6 preserves stays preserved. That check reads
adjudication ownership off disk, ahead of and independent of this
predicate, so a worktree holding recorded human decisions is out of reach
of both dispositions.

The rule is shared, and that is the point. `src/orchestrator.ts:6054`
computes the preflight's `cleanable` list from the same function, so
launch advice offers to clean exactly what `clean-failed` would clean. A
second predicate for the completed case would be two rules to keep in
agreement, and the failure mode of disagreement is advice that names a
worktree the command then refuses, or worse, the reverse.

## Decision — the name keeps its scope, the ADR widens

The guardian offered two resolutions: amend ADR 0023, or keep
completed-slice cleanup on a separately documented path. We amend.

`clean-failed` is now, accurately, "clean up the worktrees this run no
longer needs" — which includes the ones it no longer needs because they
succeeded. Reading it as *only* failure cleanup is the drift being fixed.

Against a rename or a split:

- A split documents two paths where the code has one rule. That
  re-creates this exact drift in the other direction the first time one
  document is updated and the other is not — and the shared predicate
  above exists precisely because two rules could disagree.
- A rename (`afk clean`, `afk clean-slices`) buys a better name and costs
  every existing invocation, every runbook line, every babysit prompt and
  every operator's memory. The command is invoked by hand during recovery,
  under time pressure, on a machine where the alias may be `afk`,
  `afk-claude` or `afk-codex`. Breaking that to improve a name is the
  wrong trade while the eligibility rule is the thing worth being precise
  about.

The mitigation for the weaker name is that the command says what it did
rather than relying on the reader inferring it from the name: every
removal is logged with the slice's phase, every preservation is a report
entry with a reason, and `--dry-run` prints the whole plan.

## Consequences

- ADR 0023's "registered worktrees whose slice is NOT in a failure phase
  are skipped" holds for pass 2 (the namespace sweep) as written, and for
  pass 1 becomes: skipped unless the slice is `PASS`, merged and clean.
- An operator who wants a completed worktree kept has one lever, and it is
  the honest one: leave work uncommitted in it, or don't run the command.
  There is no flag, because the flag's default would immediately become
  the thing everyone argues about.
- Cleanup after a fully successful run is now a normal part of what this
  command does, so a run that ends green no longer leaves worktrees for a
  human to sweep by hand.

## Verification

The code already behaves this way; this ADR is documentation only. The
behaviour is pinned by `src/clean-failed.test.ts:381-402` — one fixture,
two completed `PASS` slices, which asserts the clean one's worktree and
branch are both gone and the dirty one's are both kept and reported.

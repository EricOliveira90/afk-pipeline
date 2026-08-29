# Guardian review response — PRD 2 (afk-v2-routing-adjudication)

Answers the four blocking findings in `review-architect.md` (1-3) and
`review-pm.md` (1). Written by hand after the AFK run, on
`feat-codex/afk-v2-routing-adjudication`.

Both reviews judged the merged content only. `review-pm.md` covered slice
06 (#129) alone — #80 and #81 were narrowed out and remain unjudged, and
#82/#89 are not on this branch. Whatever run reopens the gate will judge
#80 and #81 for the first time.

## Architect 1 — scope revision has no pipeline-level bound

**Fixed.** `src/orchestrator.ts` now grants at most
`MAX_SCOPE_REVISIONS_PER_ROUND` (2) focused scope revisions per
implementation round. The third valid escalation in a round throws a
refusal naming the round, the allowance, the requested paths and the
escalation's own reason; the ordinary throw path persists it as the
slice's `error`. The escalation is archived *before* the bound is
checked, so the evidence the operator needs to hand-declare the paths
survives the refusal, and the contract is left locked with nothing
reverted.

Two rather than one, with the reasoning written up as
`docs/adr/0050-focused-scope-revision-is-bounded-per-round.md`: unlike an
ADR 0048 QA amendment, the tree *does* change between escalations here,
so a second discovery in a round is honest work rather than a re-report.
A third is a generator trickling paths one at a time.

Coverage: `src/orchestrator.test.ts`, "refuses a third escalation in one
round instead of looping" — a stub generator that escalates on every
invocation, each time for a genuinely new path, so every escalation is
individually valid and only the bound can stop it. Asserts ERROR with the
persisted reason, exactly 3 generator / 3 planner / 3 contract-evaluator
invocations, no QA, and all three escalations archived as
`escalation-r1-a{1,2,3}.md`. The fixture gained `escalations` (a sequence
per generator invocation) and `revisionFileScopes` (contract widened one
path at a time); `escalationGeneratorInvocation` and `escalation` still
behave as before.

Not fixed, deliberately: `runFocusedScopeRevision` still duplicates the
negotiation protocol. Recorded in ADR 0050's consequences as a separate
ADR 0008 shotgun-surgery risk.

## Architect 2 — adoption can split ref, worktree and state

**Fixed, by refusing rather than by updating the worktree.**

- Before any mutation, `runAdoptCli` calls `worktreesHolding` (over
  `listWorktrees`) and refuses when the feature branch is checked out in
  any registered worktree, naming the paths. The architect's review
  allowed either coherent update or refusal; refusal is chosen because
  the PRD does not specify successful-worktree behaviour and a refusal
  cannot leave a tree it half-understood.
- The state write is now inside `try/catch`. On failure the feature ref is
  rolled back with a guarded CAS (`candidateCommit` → `featureCommit`)
  and the refusal reports which of the two outcomes happened — rolled
  back and nothing adopted, or the rollback itself lost the CAS, in which
  case the message names both commits and what to do.

Coverage in `src/adopt-command.test.ts`: "refuses while the feature branch
is checked out in a worktree" (asserts the linked worktree stays clean,
gates never run, ref and state untouched) and "rolls the feature ref back
when the state write fails" (asserts the refusal names the underlying
error and the rollback, and that both refs and the state file are
byte-unchanged).

`persistSliceState` was added to `AdoptDependencies` as the seam for the
second test, alongside the existing `finalizeCandidate` seam.

## Architect 3 — adoption discards structured teardown failures

**Fixed.**

- `resolveGatePlan` moved *inside* the candidate's `try`, so a throw
  during plan resolution can no longer escape before cleanup. Teardown
  runs in `finally`, on every path.
- The teardown `RemoveWorktreeResult` is inspected. A survivor produces a
  classified refusal built from the shared
  `formatWorktreeSurvivorWarning` idiom, and it refuses *before* the
  feature ref moves — residue blocks the next launch (ADR 0042 decision
  1), so adoption must not report success behind a host that still needs
  cleaning.
- `createCandidateMerge` (`src/git.ts`) likewise inspects both of its own
  abandon-path teardowns and appends the survivor warning to the conflict
  `details` / the resolve-failure error instead of discarding it.

Coverage: "refuses when the candidate worktree survives teardown" (a
`removeWorktree` seam returning `removed: false`) and "tears the
candidate worktree down when gate-plan resolution throws" (asserts
`git worktree list` is byte-identical afterwards).

## PM 1 — adoption persists state under the wrong identity

**Fixed.** `runAdoptCli` resolves `<slice>` against
`<repoRoot>/.kiro/specs/<prd-slug>/issues.md` before any mutation, using
the same `matchesSliceSelector` the resume flags use, and writes state
under `slice.ghIssue`. The success line and the state key both read
`#129` whether the operator typed `06` or `129`.

Refusals, all before the candidate merge exists: a missing or unparseable
`issues.md`, an identifier the slice table does not declare, and an
identifier that matches more than one slice.

Behaviour change worth knowing: `afk adopt` now requires a readable
`issues.md` for the PRD slug. That is the file the pipeline already needs
to run at all, and without it the command cannot know the key it is
writing under.

Coverage: `it.each` over `06` and `129` asserting a single state key
`129`, `isSliceComplete(state, "129") === true`, and the verified slice
tip; plus "refuses an identifier the slice manifest does not declare".

## Notes not acted on

Both are the guardians' non-blocking notes, left for the tracker rather
than fixed inline:

- `runFocusedScopeRevision` duplicating the negotiation protocol (ADR
  0008 shotgun-surgery risk).
- `DependencyBlocker.status` in `src/logger.ts` typed as an unconstrained
  `string` where `SlicePhase | "UNKNOWN"` belongs.

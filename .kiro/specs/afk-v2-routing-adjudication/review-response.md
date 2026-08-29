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

---

# Round 2

The gate was reopened with `--slices 01,02,06`, so #80 and #81 were judged
for the first time. All four round-1 fixes held. Three new blockers, answered
below. #89 and #82 are still off this branch.

## Architect 1 — a failed focused scope revision destroys the last accepted lock

**Fixed, as a transaction.** `runFocusedScopeRevision` is now a thin
wrapper: it captures `contract.md` and `acceptance-manifest.json` before
any mutation, delegates the whole protocol to `reviseAcceptedContract`, and
in `finally` restores both files byte-for-byte unless the inner function
reached `lockContract`. Success is *signalled* by the inner function
(`onAccepted`) rather than inferred from the return value, so a future exit
path added inside it rolls back by default instead of being silently
exempted. The rollback logs a phase line naming both files, so an operator
reading the log after an `ERROR` knows the contract on disk is the
pre-revision one.

Covered exits: planner/provider throw, manifest stability/coverage/binding
validation, the undeclared-path refusal, a malformed review artifact, an
evaluator `REVISE`, and cancellation. The escalation archive is written by
the caller before the revision starts, so it survives the rollback — the
evidence for a hand-declaration has to outlive the failure even though the
contract must not change.

Written up as `docs/adr/0051-a-failed-focused-revision-restores-the-accepted-lock.md`,
which also records why *restoring* rather than repairing is right (ADR 0008
does not let an unevaluated contract be the source of truth) and why only
these two files are in the transaction (the per-round feedback and review
artifacts are archived under `reviews/` before deletion).

Coverage: `src/orchestrator.test.ts`, "a failed focused revision restores
the accepted lock" — one spawned run, two lane-disjoint slices so each
negotiates exactly once, one failing at the revision planner and one at the
revision evaluator. Eight assertions off the single `beforeAll`: the ERROR
reason for each half, `contract.md` byte-identical to the locked text
(status *and* unwidened file scope), the manifest `fileScope` unwidened, and
`escalation-r1-a1.md` still archived. New fixture options
`revisionPlannerThrows` and `revisionRejected`; both key off the notes
`runFocusedScopeRevision` interpolates into its prompts rather than an
invocation counter, because a lane successor re-negotiates from scratch and
bumps every counter without a revision having happened.

## PM 1 — pre-build scope discovery had no usable escalation identity

**Fixed by the reserved identity the operator chose, not by relaxing the
schema.** `PRE_BUILD_SCOPE_FINDING_ID` = `PRE-BUILD-SCOPE`, in
`src/escalation.ts`.

`findingIds` stays mandatory; an empty list is still refused. Added:
`PRE-BUILD-SCOPE` may not be mixed with real finding IDs, because an
escalation is either a pre-build discovery or a cited-finding fix, and
accepting the mixture would let a QA-driven generator launder an uncited
path in beside a cited one.

The "Scope escalation" section now decides the identity from a fact the
generator can read off its own prompt: findings were cited to you → cite the
ones whose fix needs the paths; nothing was cited to you → `PRE-BUILD-SCOPE`,
alone. Its opening condition also changed from "if a cited finding's correct
fix requires" to "if the correct implementation requires" — that wording was
what made the pre-build case unauthorized in the first place.

The section is byte-identical across every generator source;
`prompt-template.test.ts` already enforced that invariant, and it is the
right one, so all of them changed together and the branch is phrased in
terms they share rather than naming `RETRY_NOTE` or `UNRESOLVED_FINDINGS`.
That test gained assertions for both identities and the rule between them.
Four sources were edited; `prompts/generator-resume-stuck.md` was then
deleted when slice 04 (#82) merged and retired the stuck variants, leaving
`agents/generator.md`, `prompts/generator.md` and
`prompts/generator-resume.md`.

`docs/adr/0052-pre-build-scope-discovery-cites-a-reserved-identity.md`
records the decision, the rejected schema relaxation and why (fail-closed
validation, and PRD 3's envelopes inheriting the looser shape), and what is
*not* validated — nothing checks that a generator citing the reserved value
really had no findings, because the parser has never seen the finding set.

No coordination with Track B: the artifact's shape is unchanged, so #82's
use of `src/escalation.ts` is unaffected.

Coverage, two layers:

- `src/escalation.test.ts`, "the reserved PRE-BUILD-SCOPE identity" — five
  unit cases: accepted alone; refused beside `F-17`; and three that prove
  the identity relaxes nothing else (empty `findingIds`, blank `reason`,
  already-declared path all still refuse).
- `src/orchestrator.test.ts`, "revises the contract for a pre-build
  discovery with no findings to cite" — a spawned single-slice run whose
  generator escalates on invocation 1. Asserts the premise (the first
  generator prompt carries no retry note and no implementation-round
  header) and that the prompt does name the identity; then that the slice
  reaches PASS with 2 planners, 2 contract evaluators, exactly 1 QA and 2
  generators — the revision happened without spending the round. The revised
  lock is read off the merged feature branch, since a PASS removes the slice
  worktree: `**Status:** LOCKED`, `- src/extra.ts` in the contract, and a
  `fileScope` of both paths.

## PM 2 — `afk adopt` cannot adopt a Codex or Claude run

**Fixed by discovering the run instead of assuming it.** `resolveRunSlug`
matches `.afk/state` the way `afk stop` matches log directories — the PRD
slug itself, or the slug plus a suffix — and the resolved *run* slug keys the
state read, the state write, and the adoption evidence directory
(`.afk/logs/<run-slug>/adoptions/`, previously `<prd-slug>`).

One candidate is the answer. Several refuses, lists them, and asks for the
new `--provider <name>`. **None also refuses**, which is a behaviour change
worth stating: adoption moves an existing run's feature branch, and
`loadRunState` on a missing file happily returns a record defaulting to
`feat/<prd-slug>` — that default is what turned the original defect into the
plausible-looking `Feature branch not found: feat/afk-v2-routing-adjudication`
instead of an honest error.

`pipelineRunSlug` now delegates to a new `runSlugForProviderName`, so
`--provider codex` resolves through the same rule that built the slug and
the two cannot drift. `AdoptDependencies.persistSliceState`'s second
parameter is renamed `runSlug` to match what it now receives.

`afk adopt` stays mounted only on the `afk` entry point; the subcommand now
selects the run explicitly, so no `afk-codex adopt` is needed.

Coverage in `src/adopt-command.test.ts`, "provider-qualified run state":
`it.each` over `kiro`/`codex`/`claude` asserting the right feature branch
moved, `state.featureBranch`, `isSliceComplete(state, "129")` and the
verified tip under the right state key — plus that no unqualified `demo.json`
sidecar appears for a non-kiro run. Then the ambiguity refusal (both runs
present: names `demo, demo-codex`, mentions `--provider`, gates never run,
both refs untouched), `--provider codex` resolving it (the kiro run's state
and ref stay untouched), a `--provider` with no state, and a PRD with no
state at all. `makeRepo(provider)` and `addRun(repo, provider)` are the new
fixture seams.

## Also documented

`docs/adr/0053-adopt-discovers-the-provider-qualified-run.md` carries an
**Operator-visible refusals** section listing all five pre-mutation
refusals in check order — including the two round-1 fixes the PM called
defensible but undocumented: the registered-worktree refusal (with the
ADR 0010 reasoning and the remedy) and the newly required readable
`issues.md`.

## Round 2 notes not acted on

Filed rather than fixed, as the reviews allow:

- `runFocusedScopeRevision` still duplicates the planner/evaluator/archive/
  lock protocol. ADR 0050's consequences already record it; ADR 0051 notes
  that it now adds a third invariant a shared protocol would have to carry.
- `src/logger.ts` `DependencyBlocker.status` is still an unconstrained
  `string` where routing depends on the exact value `AWAITING-ADJUDICATION`
  (ADR 0032 favours `SlicePhase | "UNKNOWN"`). Unchanged from round 1.
- `afk adopt`'s two-resource transaction is recoverable but incomplete: if
  both the state write and the reverse CAS fail, merged code is left with no
  state. The refusal names both commits, so it is repairable by hand but not
  mechanically. Recorded in ADR 0053's consequences as a follow-up.

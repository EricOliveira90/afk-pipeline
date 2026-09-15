# Slice Contract — The changed-tree path re-runs the required cheap gates

**Parent PRD:** .kiro/specs/generator-self-audit-gate/prd.md
**GH issue:** #300
**Status:** LOCKED

**Lock-Provenance:** negotiation round 2
**Negotiation round:** 1

## Scope lock

When the bounded self-audit leaves a different tree than the candidate it
challenged, the orchestrator stops discarding the verdict: `AUDIT_CHANGED` is
recorded in run state, the audited worktree is checkpointed, its tree id is
registered as the attempt's current candidate, and the same required cheap gate
declarations that released the original candidate run again on that audited
tree. A pass produces **one graded-candidate identity** — the audited tree id,
its commit sha and a base-gate evidence object naming that tree — and every
pass-path consumer of the candidate identity (the deterministic QA dispatch, the
approved baseline, the shared-preview stage, `runPostQAGates`'s
`qaApprovedTreeId`) reads that one value. A failure enters the existing bounded
repair loop with the usual budget, spending no new counter. The audited tree is
never challenged a second time, the audit consumes no generator round, and after
`AUDIT_UNCHANGED`, `AUDIT_NOT_RUN` or a run without `--self-audit` every consumer
still reads the pre-audit `checkpoint` pair exactly as it does today. The
changed-tree orchestration lives in `src/self-audit.ts` behind injected
callbacks, with one new call site in the hub.

### In scope

- [behavior:B-01] `runSelfAuditStage` (`src/self-audit.ts:161-202`) records an
  `AUDIT_CHANGED` outcome through the existing `recordSelfAuditOutcome`
  (`src/run-state.ts:1101`) before it returns, with `candidateTreeId` the
  pre-audit released tree id and `auditedTreeId` the post-audit tree id, so the
  two ids differ in the persisted entry. The `AUDIT_UNCHANGED`-only condition at
  `src/self-audit.ts:190` and its comment (`:186-189`) widen to both graded
  verdicts; `AUDIT_NOT_RUN` stays unrecorded (#301's). Recording is the stage's
  own obligation and happens whatever the re-run's later outcome is: the verdict
  is a fact about the audit, not about the gates. No schema change and no
  version bump — the existing `PersistedSelfAuditOutcome` shape carries this
  entry as-is, and the re-run's own pass/fail is deliberately not persisted (see
  Non-goals).
- [behavior:B-02] A new exported `verifyAuditedTree` in `src/self-audit.ts` runs
  the required cheap gates on the audited tree. It mints a checkpoint of
  `ctx.worktreeDir` through an injected `createCheckpoint(dir)` callback into a
  path distinct from the round's `checkpointDir` (`src/orchestrator.ts:6162`) —
  `createCandidateCheckpoint` throws when its target already exists
  (`src/gate-runner.ts:351-353`) — reports the minted tree id through an injected
  `onCandidateTree` callback (B-10), then runs the declarations
  `selectAuditedGateDeclarations` selected through an injected `runGates`
  callback bound in the hub to `runCandidateGatePhase`, reusing the round's
  `evidenceDir`, `gateCache`, `gatePrepare` and bound options unchanged. Both
  callbacks make the whole function unit-testable without a git process or a
  provider, exactly as `dispatch` does for `runSelfAuditStage`
  (`src/self-audit.ts:136`). It returns `{ outcome: "PASS", graded, artifacts }`
  or `{ outcome: "REPAIR", auditedTreeId, failedGateIds, evidenceReferences,
  artifacts }`, and takes no `dispatch` parameter at all (B-07).
- [behavior:B-03] `selectAuditedGateDeclarations` in `src/self-audit.ts` is a
  pure function returning the declarations from the round's own
  `preQaDeclarations` (`src/orchestrator.ts:6205-6210`) whose `id` is a
  `required` id of `resolveCheapGateCatalog(cwd)` (`src/base-gates.ts:154-174`).
  It is the set that gated the original candidate, derived from the gate catalog
  and not a new list (issue #300, settled decisions): the same declaration
  objects, so the commands, args and `required` flags re-run are byte-identical
  to the ones that released the pre-audit tree. A declaration the catalog does
  not name — the acceptance gate (`src/orchestrator.ts:6192-6204`), which
  declares no `expectedCostMs` — is excluded, which is why its exclusion is a
  named non-goal rather than an omission.
- [behavior:B-04] On `outcome: "PASS"`, `verifyAuditedTree` returns a `graded`
  value of `{ treeId, commitSha, baseGate }` where `treeId` and `commitSha` are
  the audited checkpoint's and `baseGate` is a **new** base-gate object built
  from the re-run's own evidence, its repo-relative evidence artifact id, the
  selected declarations, and `candidateTreeId` equal to the audited tree id.
  Never a spread of the pre-audit `qaBaseGate` and never that object passed
  through: the first silently drops the ADR 0012 skip authorization, the second
  authorizes a skip for a tree QA is not grading (issue #300, "Recorded risk").
  Before it is built, the pass path asserts the audited run released the audited
  tree — `assertGateEvidenceReleasesEvaluation` over the re-run evidence, the
  selected declarations and the audited tree id, then `verifyGateEvidence` over
  the re-run's artifacts — additively, on the audited tree, leaving P-06's
  pre-audit sequence untouched. The declaration set the audited authorization
  covers is the selected subset, so `authorizeBaseGateSkip`
  (`src/qa-gate-authorization.ts:115-157`) vouches only for gates that actually
  re-ran and the evaluator still runs everything else. `src/self-audit.ts`
  declares this object structurally rather than importing `QABaseGateEvidence`
  from `src/orchestrator.ts:4438`, so no import cycle is introduced and
  `pnpm run typecheck` proves the shapes agree at the assignment in the hub.
- [behavior:B-05] `src/orchestrator.ts` gains exactly one `verifyAuditedTree(`
  call site, after the single `runSelfAuditStage(` call
  (`src/orchestrator.ts:6419-6463`) and before the first `await runQAStage(`
  (`:6475`), entered only when the awaited stage result is
  `{ ran: true, verdict: "AUDIT_CHANGED" }` — the value the hub discards today.
  New behavior lives in the existing module with one call site in the hub
  (ARCHITECTURE.md "Hubs — do not grow these").
- [behavior:B-06] A `REPAIR` outcome enters the *existing* bounded repair loop
  rather than a new failure path: the audited sub-branch pushes the returned
  `evidenceReferences` onto `stuckReferences`, rebuilds `generatorFailureSet`
  from `failedGateIds` and those references in the same shape as
  `src/orchestrator.ts:6360-6369`, sets the same-shaped `retryNote`, and then
  either `continue`s the implementation-attempt loop while
  `implementationAttempt < implementationAttemptLimit` (`:6380`) or exhausts
  through `candidateLifecycle.exhaustDeterministicGates({ candidateTreeId:
  <the audited tree id>, attemptTreeIds: implementationCandidateTreeIds, ... })`
  and `finishIntervention` (`:6381-6390`). `attemptTreeIds` is
  `implementationCandidateTreeIds`, whose last entry is the audited tree id by
  B-10. No second budget counter and no new terminal exit: an audited tree's
  cheap-gate failure is an ordinary repair round with the usual budget (issue
  #300, settled decisions).
- [behavior:B-07] The audited tree receives no second audit invocation and the
  audit consumes no generator round. Bounded by construction:
  `verifyAuditedTree`'s input type declares no `dispatch` and its body contains
  no `runSelfAuditStage(` call, so there is no loop and no re-challenge; and
  neither `round` nor `logger.bumpEvalRound` is advanced between the
  `runSelfAuditStage(` call site and the first `await runQAStage(`, so the audit
  and its verification spend no round of their own — an audited failure spends
  an ordinary repair round through B-06's existing mechanism instead.
- [behavior:B-08] One graded-candidate binding — `const gradedCandidate` — is
  resolved once from a pure exported `resolveGradedCandidate` in
  `src/self-audit.ts`, which returns the audited pass value when there is one
  and otherwise `{ treeId: checkpoint.treeId, commitSha: checkpoint.commitSha,
  baseGate: qaBaseGate }`. `AUDIT_UNCHANGED`, `AUDIT_NOT_RUN`, a declined stage
  and an audited `REPAIR` all resolve to the pre-audit pair; only an audited
  `PASS` resolves to the audited pair. It is one value rather than four
  expressions because the declared risk is a divergence between consumers, and a
  single value cannot diverge from itself (issue #300, settled decision
  2026-09-15).
- [behavior:B-09] Every pass-path consumer of the candidate identity reads that
  one binding, and none of them reads `checkpoint` for this purpose any more:
  the deterministic QA dispatch's base-gate argument and
  `candidateTreeId`/`candidateCommitSha` (`src/orchestrator.ts:6475-6492`);
  `writeApprovedBaseline`'s `treeId` and `commit` (`:6508-6512`), so the
  baseline records the tree the verdict covered and its
  `artifact.treeId === input.treeId` evidence filter (`:4541-4551`) selects the
  audited run's artifacts instead of dropping every one; the shared-preview
  stage's `candidateTreeId` (`:6569`); and `runPostQAGates`'s
  `qaApprovedTreeId` (`:6713`). The last is why this is required rather than
  optional: `src/post-qa-gates.ts:202-223` compares `qaApprovedTreeId` against a
  fresh checkpoint of `ctx.worktreeDir` and returns `action: "ERROR"` — "The QA
  verdict does not authorize this tree (ADR 0012)" — before running the suite for
  any difference outside `reviewArtifactDir`, so a pre-audit id here fails the
  slice immediately after the verdict it just earned. `src/post-qa-gates.ts` and
  `src/qa-gate-authorization.ts` are not edited (P-04): only which tree id the
  hub hands the existing guard changes, upholding ADR 0012 as written. The
  pre-audit gate run's own `treeId: checkpoint.treeId,` argument
  (`src/orchestrator.ts:6264`, inside `runCandidateGatePhase({ ... }`) is *not* a
  pass-path consumer of the candidate identity and is deliberately left alone: it
  is the identity of the run that released the pre-audit tree, which P-06 and
  B-04 both rest on, so after this slice that fragment still occurs exactly once
  in the file, at that call and before the `runSelfAuditStage(` index.
- [behavior:B-10] The audited tree id is appended to
  `implementationCandidateTreeIds` when the audited checkpoint is minted —
  through `verifyAuditedTree`'s `onCandidateTree` callback, before the gate
  re-run, so it is registered on the pass branch and the failure branch alike,
  mirroring `src/orchestrator.ts:6230` for the pre-audit checkpoint. This keeps
  the array's last entry the tree currently under grading, which is what
  `src/post-qa-gates.ts:272`'s `.slice(0, -1)` on `priorAttemptTreeIds`
  (`src/orchestrator.ts:6706`) and B-06's terminal `attemptTreeIds` both assume.
- [behavior:B-11] `docs/adr/0069-bounded-generator-self-audit-before-qa-dispatch.md`
  is amended in place — the accepted decision, its narrative, its SwarmForge
  provenance and its one-invocation bound keep their present text — with the
  changed-tree mechanism replacing the Consequences paragraph that today says an
  `AUDIT_CHANGED` verdict "is recorded and changes nothing downstream"
  (`:78-82`). The amendment states the re-run of the catalog-derived required
  cheap gates on the audited tree, the single graded-candidate identity every
  pass-path consumer reads and its ADR 0012 tree-authority reason, and that a
  failure is an ordinary repair round rather than a new failure path.

### Non-goals (explicit out-of-scope)

- Re-running the acceptance gate, `tests`, or any declaration the cheap gate
  catalog does not name on the audited tree. The re-run set is catalog-derived
  by the issue's settled decision, and a gate whose cost is undeclared cannot be
  asserted cheap ("a gate's price is declared, not discovered",
  ARCHITECTURE.md). An audited tree that broke behavior coverage or the suite is
  still caught by the post-QA gate phase and the QA evaluator, on the audited
  tree, because B-09 binds those phases to it.
- The final-scope `runPostQAGates` call (`src/orchestrator.ts:7393+`,
  `qaApprovedTreeId: currentFinalTreeId` at `:7428`) and every post-approval
  writing stage. `currentFinalTreeId` tracks the post-approval tree, which is
  downstream of the accept commit and already re-derived per attempt; the
  issue's four named consumers are all inside the pre-merge QA window. Recorded
  here rather than escalated: the boundary is this contract's own, reversible
  before merge, and nothing is built on top of it.
- Persisting whether the audited tree's re-run passed, any new
  `PersistedSelfAuditOutcome` field, any run-state version bump, migration or
  dependency (issue #300: "No schema change, no migration, no new dependency").
- A `AUDIT_NOT_RUN` run-state entry, the agent-failure-cause taxonomy for a dead
  audit invocation, run-summary totals, the changed-rate and every status
  surface — all #301 (ADR 0025 governs the taxonomy there).
- A new spawned pipeline scenario, fixture or wave; a new gate id, gate
  declaration kind or run event; a new prompt template or any edit to
  `prompts/generator-audit.md`; making `--self-audit` default on.

### Existing behavior to preserve

- [behavior:P-01] The `AUDIT_UNCHANGED` and declined paths are unchanged: with
  `--self-audit` absent the stage still returns `{ ran: false }` with zero
  dispatches and no run-state write (`src/self-audit.ts:164-174`), no audited
  checkpoint is minted, no extra gate runs, and `gradedCandidate` is the
  pre-audit `checkpoint` pair, so a default run does exactly what it does today.
  On `AUDIT_UNCHANGED` the stage still records exactly one entry whose
  `candidateTreeId` and `auditedTreeId` are both the released tree id.
- [behavior:P-02] A candidate that fails a required cheap gate *before* the
  audit keeps today's exit: the `requiredFailures.length > 0` branch
  (`src/orchestrator.ts:6348-6390`) still builds its base-gate repair
  references, sets its retry note, and continues or returns through
  `finishIntervention(candidateLifecycle.exhaustDeterministicGates(...))` with no
  audit dispatched, no audited checkpoint and no `selfAudits` entry.
- [behavior:P-03] The run-state schema stays at v7 with
  `PersistedSelfAuditOutcome` unchanged: `RUN_STATE_VERSION` is still `7`, the
  version union is still `3 | 4 | 5 | 6 | 7`, no field is added, and v3–v7 files
  still load with every other member intact (`src/run-state.ts:348-374`).
- [behavior:P-04] ADR 0012's tree-authority machinery is untouched:
  `src/qa-gate-authorization.ts`, `src/post-qa-gates.ts` and `src/gate-runner.ts`
  are not edited, `authorizeBaseGateSkip` still refuses when the evidence's tree
  id is not the tree under review, and `runPostQAGates` still returns
  `action: "ERROR"` when its `qaApprovedTreeId` disagrees with the fresh
  post-QA checkpoint.
- [behavior:P-05] The `runSelfAuditStage` call site keeps its position and its
  single occurrence: still after
  `assertGateEvidenceReleasesEvaluation(`, after the `requiredFailures =
  collectRequiredGateFailures(` assignment and before the first
  `await runQAStage(`, which is what the existing source-order scan at
  `src/orchestrator.test.ts:8262-8289` asserts, and its injected `dispatch`
  keeps its present body and bounds (ADR 0002, ADR 0007).
- [behavior:P-06] The pre-audit release sequence keeps its present text and
  order and still runs before the audit, starting with the pre-audit gate run's
  own identity: `runCandidateGatePhase({ ... treeId: checkpoint.treeId, cwd:
  gateCwd, declarations: preQaDeclarations, ... })` (`src/orchestrator.ts:6264`)
  still names `checkpoint.treeId` and is never rebound to the audited tree, then
  `assertGateEvidenceReleasesEvaluation(gateEvidence, preQaDeclarations,
  checkpoint.treeId)` (`src/orchestrator.ts:6392-6396`), then
  `for (const artifact of gateArtifacts) verifyGateEvidence(artifact);`
  (`:6397`), then the `qaBaseGate` literal with `candidateTreeId:
  checkpoint.treeId` (`:6402-6410`). Only a tree the pre-audit gates released is
  ever audited, and B-04's audited verification is additive, not a relocation.

### Changes to existing behavior (only if the issue asks for it)

- `runSelfAuditStage` now writes a run-state entry on `AUDIT_CHANGED` as well as
  `AUDIT_UNCHANGED`, authorized by issue #300 AC1 ("A differing post-audit tree
  records `AUDIT_CHANGED` in run state") and by #299's contract, which named
  changed-tree recording as this slice's.
- The four pass-path consumer arguments at `src/orchestrator.ts:6475-6492`,
  `:6508-6512`, `:6569` and `:6713` change from `checkpoint.treeId` /
  `checkpoint.commitSha` / `qaBaseGate` to the single `gradedCandidate` binding,
  authorized by issue #300's settled decision of 2026-09-15 (Option A) and its
  AC4 and AC5. Behavior is identical on every non-`AUDIT_CHANGED` path, where
  `gradedCandidate` resolves to those same `checkpoint` values.

## Files expected to change

- src/self-audit.ts
- src/self-audit.test.ts
- src/orchestrator.ts
- src/orchestrator.test.ts
- docs/adr/0069-bounded-generator-self-audit-before-qa-dispatch.md

## Migration requirements

- New migration files: 0

## New patterns / deps / schema (if any)

- None — uses existing patterns: the injected-callback stage shape already in
  `src/self-audit.ts`, `runCandidateGatePhase` for the gate run,
  `resolveCheapGateCatalog` for the catalog, and `recordSelfAuditOutcome` at the
  existing v7 schema. No new dependency, gate id, event or prompt.

## Test plan

- Given a stage whose dispatch rewrites the worktree and a temporary run-state
  directory, when `runSelfAuditStage` is awaited, then it returns
  `{ ran: true, verdict: "AUDIT_CHANGED", treeId: <post-audit id> }`, the
  dispatch spy recorded exactly one call, and `selfAuditsFor(loadRunState(...),
  ghIssue)` holds exactly one entry whose `verdict` is `"AUDIT_CHANGED"`, whose
  `candidateTreeId` is the released id and whose `auditedTreeId` is the
  post-audit id. (B-01)
- Given `preQaDeclarations`-shaped declarations including a required cheap
  catalog gate, a non-required one and an acceptance-style declaration with no
  `expectedCostMs`, when `selectAuditedGateDeclarations` runs against a catalog
  whose required ids are `typecheck` and `lint`, then it returns exactly the
  catalog-named required declarations, as the same objects, in declaration
  order. (B-03)
- Given `verifyAuditedTree` with `createCheckpoint`, `onCandidateTree` and
  `runGates` spies and a gate run in which every selected gate PASSes, when it
  is awaited, then `createCheckpoint` was called once with a path other than the
  round's `checkpointDir`, `onCandidateTree` was called once with the audited
  tree id *before* `runGates` was called, `runGates` received exactly the
  selected declarations, and the result is
  `{ outcome: "PASS", graded: { treeId: <audited>, commitSha: <audited>,
  baseGate: { candidateTreeId: <audited>, declarations: <selected> } } }` whose
  `baseGate` is not the pre-audit object and shares no reference with it. (B-02,
  B-04)
- Given the same harness with a required selected gate at `FAIL`, when
  `verifyAuditedTree` is awaited, then it returns
  `{ outcome: "REPAIR", auditedTreeId, failedGateIds: [<that gate>],
  evidenceReferences: [...] }`, and `onCandidateTree` was still called once with
  the audited tree id. (B-02, B-10)
- Given `verifyAuditedTree`'s declared input type and body, when
  `src/self-audit.ts` is read as text and typechecked, then the input declares
  no `dispatch` member and the function body contains no `runSelfAuditStage(`
  or `dispatch(` call. (B-07)
- Given an audited `PASS` value, and separately `undefined` (the declined,
  `AUDIT_UNCHANGED`, `AUDIT_NOT_RUN` and audited-`REPAIR` cases), when
  `resolveGradedCandidate` is called with a released `{ treeId, commitSha }` and
  base-gate object, then the first returns the audited triple and every other
  case returns the released `treeId`, `commitSha` and the released base-gate
  object by reference. (B-08)
- Given `src/orchestrator.ts` read as text, when the occurrence indices of
  `runSelfAuditStage(`, `verifyAuditedTree(` and `await runQAStage(` are
  collected, then `verifyAuditedTree(` occurs exactly once, after
  `runSelfAuditStage(` and before the first `await runQAStage(`, and no
  `logger.bumpEvalRound(` occurrence sits between `runSelfAuditStage(` and that
  first `await runQAStage(`. (B-05, B-07)
- Given `src/orchestrator.ts` read as text, when the consumer arguments are
  scanned, then it contains `gradedCandidate.baseGate,`,
  `candidateTreeId: gradedCandidate.treeId,` twice (the deterministic dispatch
  and the shared-preview stage), `candidateCommitSha: gradedCandidate.commitSha,`,
  `treeId: gradedCandidate.treeId,` with `commit: gradedCandidate.commitSha,`
  inside the `writeApprovedBaseline(ctx, round, {` … `});` slice, and
  `qaApprovedTreeId: gradedCandidate.treeId,`; and no pass-path consumer still
  reads the pre-audit pair — `qaApprovedTreeId: checkpoint.treeId,`,
  `candidateCommitSha: checkpoint.commitSha,` and
  `commit: checkpoint.commitSha,` occur zero times;
  `treeId: checkpoint.treeId,` is absent from that
  `writeApprovedBaseline(ctx, round, {` … `});` slice and occurs exactly once in
  the file, before the `runSelfAuditStage(` index — the pre-audit
  `runCandidateGatePhase({ ... treeId: checkpoint.treeId, cwd: gateCwd,
  declarations: preQaDeclarations, ... })` argument at
  `src/orchestrator.ts:6264`, which is the pre-audit gate run's own identity and
  not a consumer of the graded candidate (P-06); and
  `candidateTreeId: checkpoint.treeId,` occurs exactly twice, both before the
  `runSelfAuditStage(` index: the pre-audit exhaust argument P-02 preserves and
  the `qaBaseGate` literal P-06 preserves. (B-09)
- Given `src/orchestrator.ts` read as text, when the audited-failure sub-branch
  is delimited by its `outcome === "REPAIR"` token and the next
  `await runQAStage(`, then that region contains
  `attemptTreeIds: implementationCandidateTreeIds,` and
  `if (implementationAttempt < implementationAttemptLimit) continue;`, and
  declares no new attempt or round counter. (B-06)
- Given `src/orchestrator.ts` read as text, when the pre-audit release sequence
  is scanned, then `treeId: checkpoint.treeId,` inside the
  `runCandidateGatePhase(` call whose `declarations:` argument is
  `preQaDeclarations`, `assertGateEvidenceReleasesEvaluation(`,
  `for (const artifact of gateArtifacts) verifyGateEvidence(artifact);` and
  `candidateTreeId: checkpoint.treeId` inside the `qaBaseGate` literal each
  still occur in that order and before the `runSelfAuditStage(` occurrence.
  (P-06)
- Given a stage input with `selfAudit` not true, and separately a dispatch that
  leaves the tree identical, when `runSelfAuditStage` is awaited, then the
  results are `{ ran: false }` with zero dispatches and no run-state entry, and
  `{ ran: true, verdict: "AUDIT_UNCHANGED" }` with exactly one entry whose two
  tree ids are equal. (P-01)
- Given the repository's run-state module, when `RUN_STATE_VERSION` and a v6
  fixture are read, then the version is still `7` and the fixture loads with no
  `selfAudits` member and every other field intact. (P-03)
- Given the repository tree, when this slice's file scope is compared with the
  paths it edited, then `src/qa-gate-authorization.ts`, `src/post-qa-gates.ts`
  and `src/gate-runner.ts` are unedited and their existing tests pass
  unchanged. (P-04)
- Given `src/orchestrator.ts` read as text, when `runSelfAuditStage(` is
  counted, then it occurs exactly once, after
  `assertGateEvidenceReleasesEvaluation(` and after `requiredFailures =
  collectRequiredGateFailures(` and before the first `await runQAStage(` —
  the existing scan at `src/orchestrator.test.ts:8262-8289` still passing. (P-05)
- Given `docs/adr/0069-bounded-generator-self-audit-before-qa-dispatch.md` read
  as text, then it states the catalog-derived cheap-gate re-run on the audited
  tree, the single graded-candidate identity with its ADR 0012 reason, and that
  an audited failure is an ordinary repair round; and it still contains
  `swarm_handoff.sh`, `## Decision`, `## Consequences` and the
  one-invocation bound, and no longer says an `AUDIT_CHANGED` verdict changes
  nothing downstream. (B-11)

## Definition of done

- [ ] An `AUDIT_CHANGED` stage run records one run-state entry whose
      `candidateTreeId` and `auditedTreeId` differ, at schema v7 with no new
      field.
- [ ] `selectAuditedGateDeclarations` returns the catalog-named required
      declarations from the round's own pre-QA set, as the same objects.
- [ ] `verifyAuditedTree` mints the audited checkpoint at a distinct path,
      registers its tree id before running gates, re-runs the selected
      declarations, and returns `PASS` with a graded triple or `REPAIR` with the
      failed gate ids and evidence references.
- [ ] The audited `PASS` base-gate object is built fresh with `candidateTreeId`
      equal to the audited tree id and the selected declarations — never a
      spread of, nor a pass-through of, the pre-audit `qaBaseGate`.
- [ ] `src/orchestrator.ts` holds exactly one `verifyAuditedTree(` call site,
      between the `runSelfAuditStage(` call and the first `await runQAStage(`.
- [ ] All four pass-path consumers — the deterministic QA dispatch, the approved
      baseline, the shared-preview stage and `runPostQAGates`'s
      `qaApprovedTreeId` — read the one `gradedCandidate` binding, and no
      *pass-path consumer* argument still reads `checkpoint`; the pre-audit gate
      run's `treeId: checkpoint.treeId,` (`:6264`), P-02's exhaust
      `candidateTreeId: checkpoint.treeId,` and P-06's `qaBaseGate` literal are
      untouched.
- [ ] The audited tree id is appended to `implementationCandidateTreeIds` on
      both the audited pass and the audited failure branch.
- [ ] An audited cheap-gate failure re-enters the existing repair loop and its
      terminal exit passes `attemptTreeIds: implementationCandidateTreeIds`,
      with no new counter.
- [ ] `verifyAuditedTree` takes no `dispatch` and no round is spent between the
      audit call site and the QA dispatch.
- [ ] The pre-audit release sequence and the `runSelfAuditStage(` call site keep
      their present text, order and position.
- [ ] ADR 0069 is amended in place with the changed-tree mechanism, keeping its
      decision, provenance and one-invocation bound.
- [ ] Every new assertion lives at an existing unit or source-order seam; no new
      spawned pipeline scenario, fixture or wave is added.
- [ ] Only the five paths in `## Files expected to change` are edited; migration
      count is 0.
- [ ] `pnpm run typecheck`, `pnpm test:fast` and the heavy suites this scope
      touches (`test:heavy:orchestrator`, `test:heavy:qa-orchestration`) pass.

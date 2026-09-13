# Slice Contract — Cleaner loop

**Parent PRD:** .kiro/specs/afk-v2-quality-loops/prd.md
**GH issue:** #87
**Status:** LOCKED

**Lock-Provenance:** focused-scope-revision round 7

**Negotiation round:** 1

## Scope lock

When a project's `afk.config.json` declares `gatePolicy.clean`, a new post-approval
`cleaner` stage activates after candidate approval: it gates the accepted tree with the
declared clean gates first (round 0, zero invocations when they release the tree), and
otherwise spends up to three bounded rounds of *dispatch → checkpoint → gate*, where each
round's gate set is the clean gates plus `scope` (`role` source), `feedback-integrity`,
`tests:skipped`, the in-process `suppressions` gate, and the full regression bundle the
approval rested on. A regression reverts the round with `git reset --hard`; exhaustion ends
the slice through `finishStuck`; a `BASELINE_IS_WRONG` escalation returns the slice to the
generator loop and invalidates the baseline citation. Every round is archived under the
slice's artifact directory and persisted in `RunState`. With no `clean` member the stage
does not exist and the run behaves as today (#87 AC1). This repository's own
`afk.config.json` is not edited, so the self-run stays off (PRD D1, "Scope").

**This branch is not greenfield, and its mandatory set is fourteen behaviors.** PRD D14
records both facts, and this ledger is re-derived against this branch's tip, `b817ef2`.
`afk-claude-code/afk-v2-quality-loops-slice-01-cleaner-loop` carries, in order: `5b77dd1`
(B-01, and B-05's constant and helper) and `526260c` (B-10's gate, its `GateFindings` field
and gate evidence version 4) from the earlier draft; then
`07cb5e3 feat(#87): cleaner stage, its gates and the cleaner role` and
`1a9961a feat(#87): persist and archive cleaner rounds`, which between them landed every
remaining production edit this contract declares — `src/cleaner-stage.ts`,
`src/suppression-gate.ts`, `prompts/cleaner.md`, `CLEANER_STAGE_ID`
(`src/final-evaluation.ts:49`), `CLEANER_CONTEXT_MANIFEST` (`src/context-envelope.ts:771`),
`MAX_CLEANER_ROUNDS` and `cleanerRoundsRemaining` (`src/bounds.ts:84`, `:92`),
`artifactDirPolicy` (`src/escalation.ts:307`), the `"cleaner"` `QAReviewStage` member with
its docstring exception and filename branch (`src/qa-review.ts:77`, `:92`, `:452`),
`RUN_STATE_VERSION = 6` with `qualityStages`, `recordQualityStageRound` and
`cleanerRoundsSpent` (`src/run-state.ts:67`, `:238`, `:338`, `:931`), and the
`ARCHITECTURE.md` rows (`ARCHITECTURE.md:26`, `:30`, `:56-63`); then ten `test(#87)`
commits, `0386eef`…`b817ef2`, which landed the tests, the two tier-2 spawned scenarios
(`e16d6de`) and the issue-qualified behavior tags (`8d2c966`). The explorer's "no
cleaner-related symbol exists in `src/`" is stale and is not restated anywhere below.

B-15 and B-16 of the earlier draft moved to slice
04 (#274) — the starter template with `package.json` `files` and the README section, and the
`quality-stage-policy` event with the `## Quality Stages` header line — so this contract
declares B-01…B-14 and P-01…P-10 and nothing else. Neither moved behavior is reachable from
the round loop.

**Every one of those twenty-four behaviors is landed and tagged, so its obligation here is
that it stays true — not that it be built.** That is the form B-01 and B-10 already state,
and it now holds for all of B-01…B-14 and P-01…P-10: a passing test named with the
issue-qualified `[behavior:#87:<id>]` tag exists for each of the twenty-four ids at
`b817ef2`, so re-implementing, re-deriving or re-tagging any of them is a defect rather than
progress. Nothing below re-declares landed work as outstanding.

**Remaining work — the whole of it.** Two stale run-state version literals, both outside the
file scope the earlier draft declared, still read `5` against `RUN_STATE_VERSION = 6`
(`src/run-state.ts:67`), and each needs the literal changed and nothing else:

- `src/eval-boundary.test.ts:127` — `expect(RUN_STATE_VERSION).toBe(5)` moves 5 → 6. This is
  the pin that fails `pnpm test:fast`.
- `src/qa-orchestration-gates.test.ts:1016` — `expect(bumped.version).toBe(5)` moves 5 → 6.
  This is the pin that fails `pnpm run test:heavy:qa`.

The six in-scope occurrences of the same literal are already repaired, so these two are the
only red condition at this tip. Both files are declared in this contract's file scope for
them: the earlier map named `src/run-state.ts` and `src/qa-orchestration.test.ts` but neither
the sibling half of the split `qa-orchestration` suite nor the `eval-boundary` leaf test, and
a file-scope map is exhaustive only for the files it names (ADR 0052 / ADR 0060 — pre-build
scope discovery cites a reserved identity, and gate evidence may trigger only a pre-edit
revision). Decision recorded here: the two pins move to `6` rather than the bump being
reverted, because B-14's persisted stage record is what the bump exists for and P-01 records
that the bump is unconditional; the version bump itself is not reopened.

**Build order.** One obligation remains, so there is no ordering left to declare and the
earlier five-step order is withdrawn as satisfied: move both pins. The earlier order's step 2
(`expect(GATE_EVIDENCE_VERSION).toBe(3)` at `src/acceptance-gate.test.ts`) is gone because
that pin already reads `4` (`src/acceptance-gate.test.ts:306`), landed in `4a64b90`.

**Commit boundary.** The remainder is one commit, which does not yet exist:
`test(#87): pin the last two stale run-state version literals`, carrying both pin moves and
nothing else. It is one commit rather than two because there is no second body of work for a
resuming session to be handed, and both pins fail against the same constant for the same
reason. Push it the moment it exists (`CLAUDE.md`, "Push a commit the moment it exists"); a
resuming session reads `b817ef2` plus the two pins and needs no further state. Source:
`CLAUDE.md`, "Push a commit the moment it exists"; ADR 0018 (per-slice state persistence — an
outcome hits disk when it lands).

**Line anchors below are approximate, taken against this branch's tip `b817ef2` and the PRD's
own citations; the symbol name, not the number, identifies the site.**

### In scope

- [behavior:B-01] `src/gate-policy.ts` carries one `POLICY_KEYS` member `clean`, parsed by
  `parseClean` modelled on `parseCost` with `requireKnownKeys` so every unknown sub-key is
  fatal and named, and `GatePolicy` carries `clean?: GatePolicyClean` = `{ gates (required,
  ≥1, records of { id, command, args, required, expectedCostMs? }), additionalWriteScope
  (default []), suppressionDetectors (default: the `ts-eslint` set) }`. A `gates` entry
  whose `id` collides with a catalog id (`BASE_GATE_IDS`, `scope`, `feedback-integrity`,
  `tests:skipped`, `acceptance:behaviors`, `test:budgets`, `suppressions`) is fatal;
  `expectedCostMs` defaults to `DEFAULT_CHEAP_THRESHOLD_MS` and is budgeting/reporting only,
  never a pass/fail condition (ADR 0063: a wall-clock budget cannot fail a gate). Each entry
  becomes a `GateDeclaration` (`src/gate-runner.ts`) at stage `"clean"`. **Landed in
  `5b77dd1` and tagged in `src/gate-policy.test.ts`; the obligation here is that it stays
  true and is not re-implemented.** Source: PRD D1, D14; #87 "enabled by `gatePolicy.clean`".
- [behavior:B-02] The literal token `{changedFiles}` in a clean gate's `args` expands, at
  the moment that round's declarations are built, to one repo-relative forward-slash
  argument per path by which the slice worktree's `HEAD` differs from the feature base
  (`diffTreePaths`, `src/git.ts`) — `HEAD` being the accepted `feat(#…)` commit at round 0
  and that round's output commit from round 1 on, because the `hasUncommittedChanges →
  commitAll` sweep and `createCandidateCheckpoint` (B-06) run before the gate call. An
  `args` entry may be exactly the token and nothing else, mirroring `{behaviorId}`
  (`src/gate-policy.ts`, `src/base-gates.ts`). An empty expansion records the gate `SKIPPED`
  with detail `no changed files`, never `PASS`. Source: PRD D1.
- [behavior:B-03] `src/final-evaluation.ts` gains
  `export const CLEANER_STAGE_ID = "cleaner";` beside `POST_APPROVAL_WRITING_STAGE_ID`, and
  the post-approval block in `src/orchestrator.ts` (after the accept-seam window check and
  the `feat(#…)` commit, before `finalTreeId` is resolved) gains one call to a new module
  `src/cleaner-stage.ts` exporting `runCleanerStage(ctx, round, input)` returning
  `{ ran, outcome, inputTreeId, outputTreeId, roundsSpent }`, running **before** the
  injectable `config.postApprovalWritingStage ?? noopPostApprovalWritingStage`.
  ARCHITECTURE.md "Hubs": new behavior is a new module with one call site here. Source: PRD
  D2.
- [behavior:B-04] Round 0 gates the accepted tree with the `clean` declarations through
  `runCandidateGatePhase` (`src/candidate-gate-phase.ts`) with the same cache options the
  candidate gate phase uses (D17). **`src/candidate-gate-phase.ts` is not edited, and the
  signature is cited rather than assumed:** `runCandidateGatePhase` takes
  `declarations: readonly GateDeclaration[]` and an optional `cache?: GateCacheOptions`
  documented as "forwarded verbatim to `runGates` … a pure pass-through: this phase decides
  nothing about reuse" (`src/candidate-gate-phase.ts:47-72`), so an arbitrary declaration list
  and the round-0 cache options are already admitted with no additive parameter. Every required
  clean gate `PASS` **or** `SKIPPED` ⇒ stage
  outcome `PASS`, zero cleaner invocations, `roundsSpent: 0`, and
  `inputTreeId === outputTreeId`; a `SKIPPED` is never a `FAIL`. Any required clean gate
  `FAIL` ⇒ round 1. Source: PRD D4, including its 2026-09-12 ruling that a `SKIPPED`
  empty-expansion gate releases the tree exactly as `PASS` does.
- [behavior:B-05] `src/bounds.ts` carries `MAX_CLEANER_ROUNDS = 3` and
  `cleanerRoundsRemaining({ spent, limit? })` copying `MAX_FINAL_EVALUATION_ATTEMPTS` and
  `finalEvaluationAttemptsRemaining`, and the stage loop's continuation is an enforced
  comparison against that remainder, not an incremented counter (ADR 0050 / ADR 0041: choose
  the branch that cannot loop). An `INFRASTRUCTURE` gate status retries under
  `runCandidateGatePhase`'s existing `infrastructureRetries` and spends no round; a dispatch
  that dies spends its round. **The constant and the helper landed in `5b77dd1`
  (`src/bounds.ts:84`, `:92`) and the loop's use of them landed in `07cb5e3`; both halves are
  tagged in `src/bounds.test.ts` and `src/cleaner-stage.test.ts`, so the obligation here is
  that they stay true and are not re-implemented.** Source:
  PRD D4, D14.
- [behavior:B-06] One cleaner round n (1..3) is exactly: dispatch the cleaner in the slice
  worktree `ctx.worktreeDir` with `phase-started` / `phase-ended` journaled at
  `agent: "cleaner"` (`src/run-events.ts`) so `stage-duration` exists without new code;
  sweep anything uncommitted into `chore(#<issue>): cleaner round <n>` via the
  `hasUncommittedChanges → commitAll` pattern and take `createCandidateCheckpoint` as the
  output tree; then one `runCandidateGatePhase` call over, in order, the `clean` gates,
  `scope` (`role` source, B-11), `feedback-integrity` (`src/feedback-integrity-gate.ts`, fed
  the run policy), `tests:skipped` (`src/skip-gate.ts`), `suppressions` (B-10), and the
  regression bundle `resolvePreQAGateDeclarations` + `resolveAcceptancePlan`'s
  `acceptance:behaviors` + `resolveFullSuiteGateDeclarations` (`src/base-gates.ts`). **That
  mixed set needs no edit to the helper, and the signature is cited rather than assumed:**
  `runCandidateGatePhase` takes `declarations: readonly GateDeclaration[]`
  (`src/candidate-gate-phase.ts:47-72`) and never inspects a declaration's stage beyond copying
  it into the result (`stage: GateResult["stage"]`), and `GateDeclaration.stage` is typed
  `stage: string`, validated only as non-blank (`src/gate-runner.ts:130`, `:451`), so the new
  `"clean"` stage string and the new `suppressions` declaration pass through an unedited helper
  alongside the `deterministic` and full-suite members. Source: PRD D4.
- [behavior:B-07] Any required gate outside the `clean` set red ⇒ the **orchestrator**
  reverts: `git reset --hard` of the worktree to the round's input checkpoint commit, round
  outcome `REVERTED` with the red gate ids, the round spent, and the next round's prompt
  carrying `{{REGRESSION_NOTE}}` (the red gates' `detail` and log artifact ids). Nothing
  re-baselines and no expectation is edited. **A reset runs on every exit path out of a round
  that wrote — not only the regression-detected path (ADR 0051: restoration on the success path
  only is the original defect) — and each path has exactly one reset target and exactly one
  recorded round outcome, so no discarded checkpoint is afterwards gated.** The four paths, and
  nothing else, are:
  - a required non-`clean` gate red ⇒ reset to the round's input checkpoint; outcome
    `REVERTED` with the red gate ids.
  - the dispatch throws, or the round is cancelled ⇒ reset to the round's input checkpoint;
    outcome `FAIL` with the round's gate ids empty. The round is spent (B-05, "a dispatch that
    dies spends its round").
  - the round writes a malformed `cleaner-escalation.json` ⇒ reset to the round's input
    checkpoint; outcome `ESCALATION_MALFORMED`. Decision recorded here, resolving the one
    reading under which this round had two outcomes: the malformed round is **not** a plain
    cleaner round — its checkpoint is discarded by this reset and is therefore never gated, so
    `ESCALATION_MALFORMED` is the round's whole outcome and no `PASS`/`REVERTED` can also be
    recorded for it (B-13 states the same rule; `PersistedQualityStageRound` carries one
    outcome per round, B-14). The round is spent and the next round, if any, runs from that
    input checkpoint.
  - the round writes a **valid** escalation ⇒ reset to the **accepted tree**; outcome
    `ESCALATED` (B-13). Decision recorded here, because this is the one documented exception to
    the input-checkpoint target and the two targets differ from round 2 on: an escalation
    returns the slice to the generator loop and invalidates the accepted tree's baseline
    citation, so every post-approval cleaner commit is discarded, not just the escalating
    round's — handing the generator the previous round's output tree would hand it a tree that
    is neither the accepted tree nor one any gate released. In round 1 the two targets are the
    same commit; from round 2 on the accepted tree is the target.
  Source: PRD D4; #87 AC4 "restore or revert, never redefine"; ADR 0051.
- [behavior:B-08] Regression bundle green and required clean gates green ⇒ outcome `PASS` at
  the last checkpoint; green bundle with a required clean gate still red and rounds
  remaining ⇒ the next round runs from that output tree; rounds exhausted with a required
  clean gate red ⇒ outcome `EXHAUSTED` through the existing `finishStuck` path with
  `stuck.md` listing every remaining red gate id, its `detail` and its log artifact id, the
  last checkpoint preserved. An **optional** clean gate still red never blocks; it is
  recorded (B-14). Source: PRD D4; #87 AC2.
- [behavior:B-09] Every cleaner attempt is archived under
  `.afk/artifacts/<run-slug>/slice-<n>/` (`negotiationArchiveDir`, `src/artifacts.ts`)
  stamped with round and attempt, using a new `QAReviewStage` value `"cleaner"`
  (`src/qa-review.ts`) with a matching `qaArchivePrefix` branch (whose return type widens to
  `"qa" | "uat" | "final" | "cleaner"`) so the archive is not mislabelled by that switch's
  `else → "final"` fallback, and a matching `qaReviewFilename` branch returning
  `cleaner-escalation.json`. **The `QAReviewStage` docstring
  (`src/qa-review.ts:70-75`) is amended — landed at `src/qa-review.ts:77` in `1a9961a` — to
  record the `"cleaner"` exception to its own rule:** that comment today gives union membership's reason as "one
  archive prefix map, one filename map and one resume replay cover all three", and this
  slice's `"cleaner"` member takes the first two and deliberately not the third, so the
  amendment names `"cleaner"` as a member that is archived and filenamed but never replayed,
  and says why (it writes no `QAReviewAttemptRecord`). Without that amendment the module ships
  a comment asserting an invariant its own type no longer follows. The edit is comment text
  only — no array, no validator and no exported value moves, which P-09 locks. The escalation
  file, when present, is archived by
  `archiveQAReviewAttempt` as `cleaner-review-r<round>-a<attempt>.json`; the cleaner's agent
  log is archived as `cleaner-log-r<round>-a<attempt>.log` by a new source-named export
  modelled on `archiveScopeEscalationAttempt` over `archiveEvidenceCopy`, so no archive
  write overwrites an existing name. **`"cleaner"` widens the `QAReviewStage` union only: it
  does not join `QA_REVIEW_STAGES`**, because the cleaner is not dispatched by the QA review
  machinery, writes no `QAReviewAttemptRecord` and takes no part in QA resume precedence;
  consequently `STAGE_BY_ARCHIVE_PREFIX` gains **no** inverse `cleaner` entry and the
  array-derived structures are locked unchanged by P-09. Source: PRD D4 (`prd.md:294-299`);
  #87 AC2. Decision recorded here: `src/artifacts.ts` is declared in this slice's file scope
  because the `"cleaner"` prefix branch cannot live anywhere else; the PRD's file-scope map
  is exhaustive only for the files it names and treats the rest as scope discovery (ADR 0052
  / 0060). Decision recorded here: keeping `"cleaner"` out of `QA_REVIEW_STAGES` is what
  keeps this file scope closed — the validator's accepted-stage language, the
  resume-precedence sweep and `src/qa-review.test.ts`'s exact-contents assertion on
  `QA_REVIEW_STAGES` all stay true, so `src/qa-review.test.ts` is not in scope.
- [behavior:B-10] The in-process gate `src/suppression-gate.ts`, id `suppressions`, stage
  `"deterministic"`, modelled on `src/skip-gate.ts`, counts each detector's `patterns` over
  files matching its `globs` on the input tree and the output tree, and **only an increase
  fails**; a changed file no detector's `globs` cover is not a failure. Findings are exact
  `{ path, line, detectorId }` triples carried by the optional `GateFindings.suppressions`
  (`src/gate-runner.ts`); only evidence version 4 may carry `suppressions`, and
  `GateRiskClass` carries `"suppression"` as waiver vocabulary only — the gate runs whenever
  the cleaner stage runs and never consults `gatePolicy.riskClasses` to decide that.
  **The gate, the field, `GATE_EVIDENCE_VERSION = 4`, `SUPPORTED_GATE_EVIDENCE_VERSIONS =
  [1, 2, 3, 4]` and the version-history paragraph all landed in `526260c`, and the pin
  `expect(GATE_EVIDENCE_VERSION).toBe(4)` at `src/acceptance-gate.test.ts:306` landed in
  `4a64b90` with its comment's #87 paragraph. Both the constant and the pin are locked at 4
  and must not be bumped again — a further bump to 5, a re-widened supported list, or a pin
  moved back to 3 is a defect, not progress. Nothing in B-10 is outstanding.** Source: PRD
  D5, D14; #87 AC3.
- [behavior:B-11] For `ScopeComparisonSource` `kind: "role"`, paths under the slice artifact
  directory are **not** exempt — they are reported as `outOfScopePaths` — except the single
  file `cleaner-escalation.json`. The rule does not land in `src/scope-gate.ts`, because the
  exemption is not there: `runScopeGate` (`src/scope-gate.ts:117-157`) delegates every path
  decision to `outOfScopeChangedPaths` (`src/escalation.ts:259-325`), which normalizes
  `sliceArtifactDir` into `artifactDir` and exempts that prefix internally, so a pre-filter in
  `src/scope-gate.ts` can only *widen* the accepted set and can never turn an internally
  exempted path into an offender. So the rule lands in `src/escalation.ts`, and
  `src/escalation.ts` with `src/escalation.test.ts` are declared in this slice's file scope for
  it — additive scope discovery over a PRD file-scope map that is exhaustive only for the files
  it names (ADR 0052 / 0060). Concretely: `outOfScopeChangedPaths` gains one optional argument
  `artifactDirPolicy?: "exempt-prefix" | "declared-only"` defaulting to `"exempt-prefix"`,
  which is today's behavior for every existing caller; under `"declared-only"` the prefix
  exemption at `src/escalation.ts:315-320` is not applied, so any path under the artifact
  directory the manifest does not declare is an offender, except
  `<artifactDir>/cleaner-escalation.json`, which stays exempt. The migration exemption and the
  unclassifiable-path rule are untouched. `ScopeGateInput` (`src/scope-gate.ts`) gains the same
  optional field and passes it through unchanged; the cleaner's declaration passes
  `"declared-only"`. **The fail-closed rule that shares this argument is preserved, not routed
  around:** `sliceArtifactDir` is never passed as `""` anywhere in this slice, so the
  `orchestratorOwned` expression (`src/escalation.ts:290-296`) is unedited, and the cleaner's
  declaration passes `acceptedPairIntact: false` — nothing between a round's two checkpoints
  may legitimately rewrite `contract.md` or `acceptance-manifest.json` — so a cleaner that
  touches the accepted pair is named through the existing unwaivable carve-out. P-10 locks that
  refusal and the default. The cleaner's write scope is the locked `acceptance-manifest.json`
  `fileScope` widened only by `gatePolicy.clean.additionalWriteScope`, applied in
  `src/scope-gate.ts` with `matchesGlob` over the changed set before `outOfScopeChangedPaths`
  sees it — a widening, which is all `additionalWriteScope` needs; no heuristic derives test
  paths from source paths. This slice is the first production caller of the `role` source and
  does not close #226. Source: PRD D3; #87 AC6; ADR 0048; `src/escalation.ts:259-325`.
- [behavior:B-12] The cleaner is a prompt-only, manifest-declared role dispatched like
  `evaluator-final`: `"cleaner"` is added to the slice `invoke` wrapper's
  `completionEvidence.role` (`src/orchestrator.ts`), `invocation-completed.role`
  (`src/run-events.ts`) and `ContextEnvelopeRole` (`src/context-envelope.ts`) but **not**
  `PromptAssemblyRole`; `CLEANER_CONTEXT_MANIFEST` sits beside
  `FINAL_EVALUATOR_CONTEXT_MANIFEST` and validates under `validateContextEnvelopeManifest`
  with `allowedWriteScope` = locked `fileScope` + `additionalWriteScope` +
  `slice/cleaner-escalation.json`, `outputArtifact: "cleaner-checkpoint"`, `inputOrder:
  ["quality-failures", "change-summary", "approved-baseline", "acceptance-manifest",
  "locked-contract"]`, review artifacts and `handoff.md` in `omittedArtifactClasses`, and
  `inlineSizeBudgetBytes: 65_536`. `prompts/cleaner.md` carries `{{SLICE_DIR}}`,
  `{{ROUND}}`, `{{ROUND_LIMIT}}`, `{{BASELINE_TREE_ID}}`, `{{INPUT_TREE_ID}}`,
  `{{WRITE_SCOPE}}`, `{{QUALITY_FAILURES}}` (per failing clean gate: id, `detail`, and the
  repo-relative log artifact path rather than inlined output) and `{{REGRESSION_NOTE}}`, plus
  the two anti-gaming lines, the no-redefinition line, the commit-with-rationale instruction
  and the escalation instruction; `{{TEST_COMMAND}}` is deliberately absent because the
  orchestrator gates the checkpoint (ADR 0038: the verification command belongs to the role
  that iterates on it). No `agents/cleaner.md`. Bounds are `longCommandRoleBounds` with the
  generator's `idleTimeoutMs` / `maxDurationMs` and `deferIdleKillWhenBusy` on. Source: PRD
  D7.
- [behavior:B-13] `<slice>/cleaner-escalation.json` is parsed by a pure
  `parseCleanerEscalation` in `src/cleaner-stage.ts` requiring
  `{ version: 1, class: "BASELINE_IS_WRONG", id, summary, evidence, expected, observed }` in
  the `FinalReviewFinding` vocabulary (`src/final-evaluation.ts`). Valid ⇒ stage outcome
  `ESCALATED`: the worktree is reset to the **accepted tree** first — the one exception to
  B-07's input-checkpoint reset target, declared there and stated identically here, so an
  escalation raised in round 2 or 3 has one post-reset `HEAD` and not two — then exactly what a
  final-evaluation `RETURN_TO_GENERATOR` does —
  `invalidateFinalEvaluationBaseline(repoRoot, runSlug, ghIssue, <accepted tree>)`
  (`src/run-state.ts`), a `generatorFailureSet` whose finding is the escalation with
  `artifactReferences` naming the archived file, a `retryNote`, one generator round consumed,
  zero final-evaluation attempts consumed. Unknown key, wrong class or blank field ⇒ the
  file is archived and the round is recorded `ESCALATION_MALFORMED`, which is that round's whole
  outcome: it is **not** treated as a plain cleaner round, because B-07's malformed exit path
  has already `git reset --hard`ed the worktree to the round's input checkpoint, so the round's
  checkpoint is discarded and is **never gated** — the earlier "still gated" reading is
  withdrawn, and no second outcome (`PASS`, `FAIL` or `REVERTED`) is recorded for that round.
  The round is spent and the next round, if any, runs from that input checkpoint. Decision
  recorded here, because tree ids are
  content-addressed and a generator can answer an escalation without changing tracked
  content: the escalating round is recorded with outcome `ESCALATED` on the stage entry it
  belongs to, and the next approval **appends a fresh `PersistedQualityStage` entry** to that
  issue's list, so `cleanerRoundsSpent` reads the new entry's rounds and the escalating round
  is never charged to the re-approved candidate's budget even when the re-approved tree id is
  identical. Source: PRD D8, D9; #87 AC5; ADR 0048.
- [behavior:B-14] `src/run-state.ts` `RUN_STATE_VERSION` goes 5 → 6, `RunState.version`
  admits `6`, and `adaptLoadedState` reads a version-5 file with no `qualityStages` as "no
  stage ran" and writes nothing. `RunState` gains
  `qualityStages?: Record<string /* ghIssue */, PersistedQualityStage[]>` with
  `PersistedQualityStage = { stage: "cleaner"; enabled: boolean; rounds; outcome: "DISABLED"
  | "PASS" | "EXHAUSTED" | "ESCALATED" }` and `PersistedQualityStageRound = { round;
  attempt; inputTreeId; outputTreeId?; gateIds; outcome: "PASS" | "FAIL" | "REVERTED" |
  "EXHAUSTED" | "ESCALATED" | "ESCALATION_MALFORMED" }`, modelled on `finalEvaluations` and
  written by `recordQualityStageRound` after every round (persist-per-attempt, as
  `persistAttempts` does) and `recordQualityStageOutcome`. Reader `cleanerRoundsSpent(record)`
  counts rounds with `round >= 1`, so a resumed run cannot buy a fourth round. **The schema,
  the writers and the reader landed in `1a9961a` (`src/run-state.ts:67`, `:238`, `:338`,
  `:931`) and are tagged in `src/run-state.test.ts`; the obligation there is that they stay
  true. The one obligation still red at this tip belongs to this behavior: because
  `RUN_STATE_VERSION` is a single module-level constant every reader of a version literal
  compares against, the bump leaves two stale pins that must move 5 → 6 —
  `expect(RUN_STATE_VERSION).toBe(5)` at `src/eval-boundary.test.ts:127`, which fails
  `pnpm test:fast`, and `expect(bumped.version).toBe(5)` at
  `src/qa-orchestration-gates.test.ts:1016`, which fails `pnpm run test:heavy:qa`. Each is one
  literal and nothing else; the six in-scope occurrences are already repaired. Both files are
  declared in this slice's file scope for exactly those two edits, and neither file's
  surrounding assertions, fixtures or `describe` placement move (the split
  `qa-orchestration` suites are balanced by measured block time — `CLAUDE.md`, "Test loop
  discipline").** Source: PRD D9; ADR 0052 / ADR 0060 (additive scope discovery).

### Non-goals (explicit out-of-scope)

- Slice 04 (#274)'s work: the `templates/quality-policy/afk.config.json` starter, the
  `package.json` `files` change, the README "Quality policy starter" section, the
  `quality-stage-policy` event and the `## Quality Stages` header line in `run-summary.md`.
- #97's work: `quality-stage-attempt` events, the per-slice `## Quality Stages` rows,
  `readQualityStageOutcomes`, `buildPrCreationPlan.qualityStages` and the draft-PR section,
  `routeFinalReviewFinding`'s writing-stage input, the `RESTORE` re-dispatch, and the
  cleaner's stage tiling into `writeFinalChangeSummary`.
- The hardener loop (#92) and #73 stories 9–15, 19: no `hardener` stage id, mutation gate,
  survivor schema or exclusion-pairing gate.
- Running `suppressions` on generator candidates.
- A CLI enable flag (`--enable-cleaner`) or a top-level `afk.config.json` key beside
  `gatePolicy`.
- Editing this repository's `afk.config.json` (protected path; the cleaner stays off for the
  self-run) or its `gatePolicy.riskClasses` array.
- Wiring the `role` scope source for any other writing role, and closing #226 — it stays
  OPEN with the cleaner call site noted in this slice's handoff.
- `afk status` rendering of quality stages; guardian and remediator changes (PRD 6).
- Any threshold, alert or keyed measurement store over stage cost.

### Existing behavior to preserve

- [behavior:P-01] With no `gatePolicy.clean` member, the post-approval path is identical to
  today, and **what holds that is stated rather than assumed:** the call site B-03 adds is
  unconditional, so its whole effect on a `clean`-less run is `runCleanerStage`'s return, and
  the locked observable is that return — `ran: false`, `outcome: "DISABLED"`, `roundsSpent: 0`,
  `inputTreeId === outputTreeId`, zero cleaner dispatches and no `qualityStages` entry written.
  A stage that returns that leaves `config.postApprovalWritingStage ??
  noopPostApprovalWritingStage` as the whole stage list, `finalTreeId` as the accepted tree and
  the final-evaluation reuse branch untouched, and those three are held by
  `src/orchestrator.ts`'s existing `clean`-less spawned coverage continuing to pass rather than
  by a new spawn: both tier-2 scenarios declare `clean`, so neither can observe a `clean`-less
  run. This is deliberately not a byte-identical claim over everything a
  `clean`-less run writes, and it explicitly excludes the run-state `version` field: B-14's
  `RUN_STATE_VERSION` 5 → 6 is unconditional, so every run persists version `6` whether or not
  `clean` is declared, and making that bump conditional on `clean` is not authorized by
  "Changes to existing behavior". Source: #87 AC1; PRD D9.
- [behavior:P-02] `PostApprovalWritingStage` (`src/final-evaluation.ts`) keeps its
  synchronous signature and `noopPostApprovalWritingStage` stays the injectable seam
  `src/qa-orchestration.test.ts`'s "final evaluation and reuse" fixture depends on; the
  cleaner is not shoehorned into it. Source: PRD D2 "Rejected: replacing the stub".
- [behavior:P-03] `decideFinalReuse` (`src/final-evaluation.ts`) is unchanged: reuse stays
  exact tree equality with no second "did the writing stage write?" predicate. Source: PRD
  D12, D13.
- [behavior:P-04] `assertGateEvidenceReleasesEvaluation` (`src/candidate-gate-phase.ts`) is
  unchanged, including its `!declaration.required || result.status === "PASS"` condition over
  the pre-QA gate set; `runCandidateGatePhase` never calls it, the cleaner stage reads its
  own results, and B-04's `SKIPPED` rule does not reach it. **What holds each half is stated
  rather than assumed:** the helper's own condition is held by `fileScope` exclusion —
  `src/candidate-gate-phase.ts` is deliberately absent from "Files expected to change", so the
  `scope` gate reports any edit to it as out of scope and no test asserts an untouched diff.
  **That exclusion is safe rather than hopeful, and the reason is cited:** B-04's and B-06's uses
  of `runCandidateGatePhase` need no additive parameter, because its signature already takes
  `declarations: readonly GateDeclaration[]` plus an optional pass-through
  `cache?: GateCacheOptions` (`src/candidate-gate-phase.ts:47-72`) and `GateDeclaration.stage`
  is `stage: string` validated only as non-blank (`src/gate-runner.ts:130`, `:451`), so the
  `"clean"` stage string, the `suppressions` gate and the round-0 cache options all pass through
  the file unedited.
  What the declared test in `src/cleaner-stage.test.ts` observes is program behavior: the
  imported helper still refuses to release on a required `SKIPPED` and releases on a required
  `PASS` and an optional `FAIL`, and the cleaner stage's round decision is computed from the
  `runCandidateGatePhase` results it holds, with no call into that helper. Source: PRD D4.
- [behavior:P-05] The `candidate` comparison source keeps today's slice-artifact-directory
  exemption, and `QA_WINDOW_ARTIFACT_NAME` / `reviewArtifactViolations`
  (`src/post-qa-gates.ts`) are unchanged. Source: PRD D3, D13.
- [behavior:P-06] Gate-evidence readers keep accepting versions 1–3, and no version-3
  evidence document carries a `suppressions` field. Source: PRD D5.
- [behavior:P-07] In-process gates are never cached (`src/gate-runner.ts`) — which holds for
  `suppressions` — and the gate cache key (`src/gate-cache.ts`) is unchanged. Source: PRD
  D13.
- [behavior:P-08] `approved-baseline.json` is still written from its one site in
  `src/orchestrator.ts`, and behavior IDs keep their `B-01` spelling. Source: PRD D13.
- [behavior:P-09] Widening `QAReviewStage` with `"cleaner"` (B-09) leaves every
  array-derived structure in `src/qa-review.ts` untouched: `QA_REVIEW_STAGES` still holds
  exactly `["deterministic", "shared-preview", "final-evaluation"]`; the attempt-record stage
  validator still rejects any stage absent from that array — `"cleaner"` included — with its
  message unchanged; the resume-precedence sweep still iterates exactly those three stages;
  and `RECORD_FILENAME` (`src/qa-review.ts:754-755`) is left alone, so a `cleaner`-prefixed
  archive is never read back as a QA attempt record by the resume scan. That last clause is
  held **by proxy, and is stated as one:** `RECORD_FILENAME` is a module-private literal that
  does not derive from `QA_REVIEW_STAGES`, so no test in this slice's file scope reads it. What
  the declared test observes is that `qaArchivePrefix("cleaner")` is outside the `qa|uat|final`
  prefix set the resume scan replays, and a `cleaner-`prefixed filename cannot match a
  `(qa|uat|final)`-anchored pattern; the prefix assertion is therefore the whole observable.
  B-09's amendment of the `QAReviewStage` docstring (`src/qa-review.ts:70-75`) is comment text
  and is the only edit this slice makes to that region: it records the `"cleaner"` exception to
  the one-replay rule and changes nothing this behavior locks. Source: PRD D4;
  `src/qa-review.ts:754-755`.
- [behavior:P-10] B-11's new `artifactDirPolicy` argument changes nothing for
  `outOfScopeChangedPaths`'s existing callers, and does not weaken the fail-closed rule it
  shares: with the argument absent — the pre-build escalation guard (`src/orchestrator.ts`, ADR
  0052) and the `candidate`-source scope gate — every path under the slice artifact directory
  is still exempt by prefix, and the unwaivable `orchestratorOwned` refusal keeps its exact
  condition, so `contract.md` and `acceptance-manifest.json` at the artifact-directory root are
  named offenders whenever `sliceArtifactDir` is non-blank and `acceptedPairIntact` is `false`,
  even when the manifest declares them. `sliceArtifactDir: ""` is not used anywhere in this
  slice to disable an exemption, and that last clause is observed as **source text, not as a
  diff**: `src/escalation.test.ts` reads the in-scope `.ts` files listed under "Files expected
  to change" and asserts none of them contains a `sliceArtifactDir` assignment to an empty
  string literal, in the manner `src/orchestrator.test.ts` reads the launch command literal
  out of `CLAUDE.md`. A vitest unit test has no view of a diff; a source-text scan over a
  fixed file list is something it can actually observe. Source: ADR 0055 Seam 1 §3; ADR 0048;
  `src/escalation.ts:284-325`.

### Changes to existing behavior (only if the issue asks for it)

- `src/acceptance-gate.test.ts`'s `GATE_EVIDENCE_VERSION` pin moved 3 → 4 to match the
  shipped constant — authorized by PRD D5 and D14 (#87 AC3), landed in `4a64b90` at
  `src/acceptance-gate.test.ts:306`. The shipped `GATE_EVIDENCE_VERSION = 4` and
  `SUPPORTED_GATE_EVIDENCE_VERSIONS = [1, 2, 3, 4]` and that pin are **not** changed again.
- `RUN_STATE_VERSION` 5 → 6 with a version-5 file read as "no stage ran" — authorized by PRD
  D9, landed in `1a9961a` at `src/run-state.ts:67`.
- Two stale version-5 literals outside the schema's own files move 5 → 6 to match that
  shipped constant, and nothing else in either file changes:
  `expect(RUN_STATE_VERSION).toBe(5)` at `src/eval-boundary.test.ts:127` and
  `expect(bumped.version).toBe(5)` at `src/qa-orchestration-gates.test.ts:1016`. Authorized by
  PRD D9 as the unavoidable consequence of the bump B-14 requires, and admitted into the file
  scope as additive pre-build scope discovery over a map that named `src/run-state.ts` and
  `src/qa-orchestration.test.ts` but not the sibling half of the split `qa-orchestration`
  suite or the `eval-boundary` leaf test (ADR 0052 / ADR 0060). The bump is not reverted and
  no third literal is in question — the six in-scope occurrences are already repaired.
- `role` source: slice-artifact-directory paths lose their exemption except
  `cleaner-escalation.json` — authorized by PRD D3 (#87 AC6). The edit lands in
  `outOfScopeChangedPaths` (`src/escalation.ts`) as the optional `artifactDirPolicy` argument
  B-11 declares, defaulting to today's `"exempt-prefix"`, plus the pass-through field on
  `ScopeGateInput` (`src/scope-gate.ts`). The `orchestratorOwned` refusal expression is not
  changed (P-10).
- `qaArchivePrefix`'s return type widens from `"qa" | "uat" | "final"` to
  `"qa" | "uat" | "final" | "cleaner"` and `qaReviewFilename` gains a `"cleaner"` branch,
  both additive with the three existing members' answers unchanged — authorized by PRD D4
  (`prd.md:294-299`).

## Files expected to change

- src/cleaner-stage.ts
- src/scope-gate.ts
- src/escalation.ts
- src/final-evaluation.ts
- src/run-state.ts
- src/run-events.ts
- src/context-envelope.ts
- src/qa-review.ts
- src/artifacts.ts
- src/orchestrator.ts
- src/gate-policy.ts
- src/gate-runner.ts
- src/suppression-gate.ts
- src/bounds.ts
- prompts/cleaner.md
- ARCHITECTURE.md
- src/acceptance-gate.test.ts
- src/cleaner-stage.test.ts
- src/scope-gate.test.ts
- src/escalation.test.ts
- src/final-evaluation.test.ts
- src/run-state.test.ts
- src/context-envelope.test.ts
- src/artifacts.test.ts
- src/gate-policy.test.ts
- src/gate-runner.test.ts
- src/suppression-gate.test.ts
- src/bounds.test.ts
- src/qa-orchestration.test.ts
- src/qa-orchestration-gates.test.ts
- src/eval-boundary.test.ts

## Migration requirements

- New migration files: 0

## New patterns / deps / schema (if any)

- New module `src/cleaner-stage.ts` (post-approval writing stage body) behind the
  post-approval stage list seam; `src/suppression-gate.ts` behind the `GateDeclaration` seam
  (landed).
- Gate stage string `"clean"` and gate id `suppressions`.
- One additive optional argument on an existing shared helper:
  `outOfScopeChangedPaths({ ..., artifactDirPolicy?: "exempt-prefix" | "declared-only" })`
  (`src/escalation.ts`), default `"exempt-prefix"`, mirrored as an optional `ScopeGateInput`
  field (B-11, P-10).
- Config schema `gatePolicy.clean` (version-1 shape in PRD D1) and `GateRiskClass` value
  `"suppression"` (landed).
- Schema bump: `RUN_STATE_VERSION` 5 → 6 with `qualityStages` (landed, `src/run-state.ts:67`).
  Every literal pinned against that constant reads `6`, including the two outside the schema's
  own files (`src/eval-boundary.test.ts:127`, `src/qa-orchestration-gates.test.ts:1016`). Gate
  evidence version 4 is already shipped and is not bumped.
- New role `cleaner` (`prompts/cleaner.md`, `CLEANER_CONTEXT_MANIFEST`), new `QAReviewStage`
  value `"cleaner"`.
- No new runtime dependencies.

## Test plan

**Harness, stated once, because four of these cases need a state no existing fixture
reaches.** `src/qa-orchestration.test.ts`'s `describe("final evaluation and reuse")` block has
no `beforeAll` and no shared spawned result: `finalEvaluationFixture`
(`src/qa-orchestration.test.ts:3586`) is a per-`it` factory, so every `it` that calls it spawns
its own pipeline run, and none of its runs declares `gatePolicy.clean`. An `it` appended to
that block is therefore a *new spawned scenario*, not a free assertion on an existing one, and
the four cleaner cases (a clean gate red on the accepted tree and repaired, a stub cleaner that
reddens the regression bundle, an exhausted budget, an escalation) are mutually exclusive
per-run configurations. Two consequences follow and are honoured throughout the plan below:
each spawned tier-2 scenario declares `gatePolicy.clean`, so **no claim about a run with no
`clean` member may cite a spawned scenario** — the disabled-stage claims are unit claims; and
every claim that needs a real post-approval journal, a real dispatch or a real candidate
approval must name one of the two tier-2 scenarios by title rather than the
`finalEvaluationFixture` block it extends. So this slice declares its harness in three tiers
and nothing else:

1. **Unit, `src/cleaner-stage.test.ts`, no spawn.** `runCleanerStage` is a module with one
   orchestrator call site (B-03), so it is callable directly against a `makeRepo()` worktree
   with a stub provider and fake `node -e` clean gates. Every stage-level claim is observed
   here: B-02's expansion, B-04's round-0 release, B-05's bound, B-06's round shape, B-07's
   reset on each exit path, B-08's outcome selection, B-13's parse and both escalation
   outcomes, and P-04's helper condition.
2. **Two new spawned pipeline scenarios**, both in `src/qa-orchestration.test.ts`, each
   spawned **once** in a `beforeAll` whose result several `it`s read — one spawn per
   configuration, not one per assertion. They exist because the orchestrator-side routings
   (the seam order against the injected writing stage, `finishStuck` and its `stuck.md`,
   generator re-entry and the fresh stage entry a re-approval appends) are reached by no unit
   call, and each carries a comment saying so, as `CLAUDE.md`'s "Where a new assertion goes"
   requires:
   - `describe("a clean policy escalates, then repairs the re-approved tree")` — a required
     clean gate red on the accepted tree; the round-1 stub cleaner writes a valid
     `cleaner-escalation.json`; the slice re-enters the generator loop, is re-approved, and
     the next stage entry's round 1 repairs the tree and passes. Shared result hosts B-03's
     ordering, B-06, B-09's in-run archives, B-13's routing and fresh-entry rule, and B-14's
     persistence and reader.
   - `describe("a clean policy reverts a regression and exhausts its rounds")` — the same
     policy with a second, optional clean gate red throughout; the round-1 stub cleaner's edit
     reddens the regression bundle, and the required clean gate stays red through round 3.
     Shared result hosts B-05's three-dispatch bound, B-07's revert and regression note, and
     B-08's exhaustion, `stuck.md` contents and optional-gate rule.
   Both extend `finalEvaluationFixture` with a `clean` policy option and a cleaner responder
   rather than adding a third fixture, and neither replaces or edits an existing spawned `it`.
3. **Unit elsewhere** for the stores and the shared helpers: `src/bounds.test.ts`,
   `src/run-state.test.ts`, `src/artifacts.test.ts`, `src/escalation.test.ts`,
   `src/scope-gate.test.ts`, `src/suppression-gate.test.ts`, `src/gate-policy.test.ts`,
   `src/gate-runner.test.ts`, `src/context-envelope.test.ts`, `src/final-evaluation.test.ts`.

**The wall-clock consequence is declared, not discovered.** Both new scenarios land in
`test:heavy:qa`, whose per-suite budget in `suite-budgets.json` is 151s against a worst
recorded in-chain measurement of 115.7s (`_measured2026_09_01_prd3_slice01`) — about 35s of
headroom for two spawned runs. `suite-budgets.json` is deliberately **not** in this slice's
file scope: raising a number there requires a recorded measurement and is an operator action by
that file's own rule, and `pnpm test:budgets` runs only inside `pnpm test:ratchet`, never
inside `pnpm test`, so an overrun cannot turn a deterministic gate or the pre-ship gate red
(ADR 0063: a wall-clock budget cannot fail a gate). The definition of done therefore requires
the measurement and a handoff line, not an edit: run `pnpm run test:heavy:qa`, record its
reported wall clock, and if it exceeds 151s report the overrun with the number in the handoff
for an operator budget decision.

- Given a `gatePolicy.clean` with an unknown sub-key, an id colliding with a catalog gate, or
  an empty `gates` array, when `parseClean` runs, then the launch is refused with the
  offending key or id named; given a valid minimal `clean`, then `additionalWriteScope`,
  `suppressionDetectors` and `expectedCostMs` take the documented defaults (unit,
  `src/gate-policy.test.ts`, B-01 — already present, asserted to still pass).
- Given a clean gate whose `args` are exactly `{changedFiles}`, when the declarations are
  built against a worktree `HEAD` differing from the feature base by two paths, then the gate
  receives exactly those two repo-relative forward-slash arguments; given a `HEAD` differing
  by none, then the gate records `SKIPPED` with detail `no changed files` (unit,
  `src/cleaner-stage.test.ts`, B-02).
- Given a `GatePolicy` with no `clean` member, when `runCleanerStage` is called on an approved
  worktree, then it returns `{ ran: false, outcome: "DISABLED", roundsSpent: 0 }` with
  `inputTreeId === outputTreeId`, dispatches nothing and records no `qualityStages` entry —
  which is the whole of the call site's effect, so the post-approval path is today's; and given
  `src/final-evaluation.test.ts`, then `PostApprovalWritingStage` keeps its synchronous
  signature, `noopPostApprovalWritingStage` is still the injectable default and
  `decideFinalReuse` is unchanged (unit, `src/cleaner-stage.test.ts` +
  `src/final-evaluation.test.ts`, P-01, P-02). No spawned scenario is cited here: both tier-2
  scenarios declare `clean`, so neither can observe a `clean`-less run.
- Given `runCleanerStage`, when it returns from a stage that ran and from one that did not,
  then the returned object carries exactly `ran`, `outcome`, `inputTreeId`, `outputTreeId`
  and `roundsSpent`, with `ran` true and false respectively, and
  `src/final-evaluation.test.ts` asserts the exported `CLEANER_STAGE_ID` sits beside
  `POST_APPROVAL_WRITING_STAGE_ID`; and given the shared result of the "escalates, then
  repairs" tier-2 scenario — the only harness in this plan with a `clean` policy and a real
  post-approval journal — then that run's journal shows the `cleaner` stage entered **before**
  the injected stub writing stage, which is the ordering claim's whole observable (unit,
  `src/cleaner-stage.test.ts`, plus harness tier 2, B-03).
- Given a clean gate that passes on the accepted tree, when the stage runs, then the outcome
  is `PASS` with `roundsSpent: 0`, zero cleaner invocations and
  `inputTreeId === outputTreeId`; given a required clean gate that records `SKIPPED` on an
  empty expansion, then the same (B-04).
- Given `spent` of 0..4, when `cleanerRoundsRemaining` is called, then the remainder is
  `Math.max(0, 3 - spent)`; given an `INFRASTRUCTURE` gate status, when the round retries,
  then no round is spent and the loop's continuation compares against the remainder (unit
  `src/bounds.test.ts` + `src/cleaner-stage.test.ts`, B-05).
- Given a fake clean gate that fails until a stub cleaner writes a file, when `runCleanerStage`
  is called directly, then round 1 dispatches with the failure detail, the sweep commit
  `chore(#<issue>): cleaner round 1` exists in the worktree log, the checkpoint is gated over
  the full listed order, and the stage returns `PASS` on the repaired tree (unit,
  `src/cleaner-stage.test.ts`); and given the same policy inside a spawned run, then the same
  round-1 dispatch, sweep commit, gate id order and passing stage are read off the shared
  result of the "escalates, then repairs" scenario, which is where a real dispatch and a real
  candidate approval exist (harness tier 2, B-06).
- Given a stub cleaner whose edit reddens the regression bundle, when the round is gated, then
  the worktree is `git reset --hard` back to the round's input checkpoint, the round is
  recorded `REVERTED` with the red gate ids, and the next round's prompt carries the regression
  note; given the round throws or is cancelled, then `HEAD` is that same input checkpoint and the
  round is recorded `FAIL`; given a malformed escalation, then `HEAD` is that same input
  checkpoint, the round is recorded `ESCALATION_MALFORMED` and no gate runs on the discarded
  checkpoint; given a valid escalation raised in round 2, then `HEAD` is the **accepted tree**
  rather than round 1's output commit, which is the declared exception — one post-reset `HEAD`
  and one recorded outcome per exit path, four paths, one `it` each (unit,
  `src/cleaner-stage.test.ts`); and the revert, the `REVERTED` record
  and the round-2 prompt's regression note are also read off the shared result of the "reverts
  a regression and exhausts its rounds" scenario, because only a real dispatch produces the
  round-2 prompt (harness tier 2, B-07).
- Given a required clean gate red for three rounds, when the budget is exhausted, then the
  stage returns `EXHAUSTED` with every remaining red gate id, its detail and its log artifact
  id, having dispatched exactly three times (unit, `src/cleaner-stage.test.ts`); and given the
  shared result of the "reverts a regression and exhausts its rounds" scenario, then the slice
  finishes stuck through `finishStuck`, `stuck.md` names each of those gate ids with its detail
  and log artifact id, the last checkpoint is preserved, and the optional clean gate red
  throughout that run never blocks and appears only as a recorded round gate id (harness
  tier 2, B-08).
- Given three cleaner rounds, when the stage ends, then
  `.afk/artifacts/<run-slug>/slice-<n>/` holds one archived attempt per round stamped with
  round and attempt under the `cleaner` prefix, and no name is overwritten; given
  `qaArchivePrefix` and `qaReviewFilename`, then `"cleaner"` maps to `cleaner` and
  `cleaner-escalation.json` while the three existing members' answers are unchanged (unit,
  `src/artifacts.test.ts`, B-09).
- Given the widened `QAReviewStage` union, when `src/qa-review.ts`'s exported array-derived
  structures are read from `src/artifacts.test.ts` (the in-scope home for this assertion, so
  `src/qa-review.test.ts` needs no edit), then `QA_REVIEW_STAGES` is still exactly
  `["deterministic", "shared-preview", "final-evaluation"]` — the whole assertion, because
  the attempt-record validator's accepted language and the resume-precedence sweep both
  derive from that one array — and `qaArchivePrefix("cleaner")` is outside the `qa|uat|final`
  set the resume scan replays, which is the whole observable for the `RECORD_FILENAME` clause
  because that anchor is a module-private literal no in-scope test can read (unit, P-09).
- Given an input tree with one `@ts-ignore` and an output tree with two, when the
  `suppressions` gate runs, then it fails with the exact `{ path, line, detectorId }` triple
  for the added one; given a removed suppression or a changed file no detector glob covers,
  then it passes; given the evidence document, then its version is 4, `src/acceptance-gate.test.ts`
  pins 4 rather than 3, and readers still accept 1–3 without a `suppressions` field (unit,
  B-10, P-06).
- Given a role-source comparison with `artifactDirPolicy: "declared-only"` whose output tree
  writes `slice/contract.md` and `slice/feedback-r1.md`, when the `scope` gate runs, then both
  paths are `outOfScopePaths`; given `slice/cleaner-escalation.json`, then it is in scope; given
  an `additionalWriteScope` glob match, then it is in scope; given the same paths under the
  `candidate` source, then today's prefix exemption still applies (unit,
  `src/scope-gate.test.ts`, B-11, P-05).
- Given `outOfScopeChangedPaths` called with `artifactDirPolicy` absent, when an
  artifact-directory path is classified, then it is exempt exactly as today; given
  `acceptedPairIntact: false` with a non-blank `sliceArtifactDir` under either policy, then
  `contract.md` and `acceptance-manifest.json` are offenders even when the manifest declares
  them; and given the in-scope `.ts` files read as source text, then none contains a
  `sliceArtifactDir` assignment to an empty string literal (unit,
  `src/escalation.test.ts`, P-10).
- Given the imported `assertGateEvidenceReleasesEvaluation`, when it is called with a required
  `SKIPPED`, a required `PASS` and an optional `FAIL` result, then it refuses to release on
  the first and releases on the other two exactly as today; and given a cleaner round, then
  the round decision is computed from the round's own `runCandidateGatePhase` results with no
  call into that helper — the helper's source is held unedited by its absence from the file
  scope, not by an assertion (unit, `src/cleaner-stage.test.ts`, P-04).
- Given `CLEANER_CONTEXT_MANIFEST`, when `validateContextEnvelopeManifest` runs, then it
  validates with the declared write scope, output artifact and input order, `"cleaner"` is a
  `ContextEnvelopeRole` but not a `PromptAssemblyRole`, and `prompts/cleaner.md` renders with
  every declared placeholder and no `{{TEST_COMMAND}}` (unit, B-12).
- Given a well-formed `cleaner-escalation.json` written in round 2, when the round ends, then
  `parseCleanerEscalation` accepts it, the worktree is reset to the accepted tree — not to round
  1's output commit — the stage returns `ESCALATED` carrying
  the escalation as a `generatorFailureSet` finding with `artifactReferences` naming the
  archived file, and the baseline citation for the accepted tree is invalidated; given a blank
  field, an unknown key or the wrong class, then the file is archived, the round is recorded
  `ESCALATION_MALFORMED` as its only outcome, `HEAD` is the round's input checkpoint and no gate
  ran on the discarded checkpoint (unit, `src/cleaner-stage.test.ts`);
  and given the shared result of the "escalates, then repairs" scenario, then the slice
  re-enters the generator loop with that finding, exactly one generator round and zero
  final-evaluation attempts are consumed, and the re-approval appends a fresh
  `PersistedQualityStage` entry whose `cleanerRoundsSpent` starts at 0 — asserted on a
  re-approved tree whose id is **identical** to the escalated one, which is the case the
  recorded decision exists for and which no unit call reaches (harness tier 2, B-13).
- Given `decideFinalReuse`, when it is called on equal and unequal tree ids, then it decides
  reuse and evaluate on tree equality alone with no writing-stage predicate in the decision
  (unit, `src/final-evaluation.test.ts`, P-03); given the `suppressions` gate run twice over
  identical trees, then it executes both times and produces no cache entry, and
  `src/gate-cache.ts` is absent from the file scope (unit, `src/gate-runner.test.ts`, P-07);
  and given a cleaner round that passes, then the stage writes no `approved-baseline.json`,
  leaving its one writer in `src/orchestrator.ts` (unit, `src/cleaner-stage.test.ts`, P-08).
- Given a version-5 run-state file, when it is loaded, then it reads as "no stage ran" and
  nothing is written; given rounds recorded then a resume, then `cleanerRoundsSpent` reports
  the spent rounds and no fourth round is granted (unit, `src/run-state.test.ts`, B-14).
- Given the shipped `RUN_STATE_VERSION = 6`, when every test that pins a run-state version
  literal runs, then each pin reads `6` and none reads `5` — `src/eval-boundary.test.ts:127`'s
  `expect(RUN_STATE_VERSION).toBe(6)` under `pnpm test:fast` and
  `src/qa-orchestration-gates.test.ts:1016`'s `expect(bumped.version).toBe(6)` under
  `pnpm run test:heavy:qa` — and every other assertion in both files, including the bump
  fixture's remaining expectations and the `describe`-block placement that balances the split
  `qa-orchestration` suites, is unchanged (unit, those two files, B-14). No new test file, no
  new spawned scenario and no new `it` is added for these two pins: each is a one-literal edit
  inside an assertion that already exists, which is the top of `CLAUDE.md`'s "Where a new
  assertion goes" list.
- Every test above is named with its own behavior-anchor tag in the issue-qualified form the
  branch already carries, `[behavior:#87:<id>]` — for example `[behavior:#87:B-05]`, 22
  occurrences in `src/cleaner-stage.test.ts` and one at `src/bounds.test.ts:33`, landed
  deliberately in `8d2c966`. That qualifier is not stripped back off. Either form satisfies
  `acceptance:behaviors`, whose `--testNamePattern {behaviorId}` matches the bare id as a
  substring of the qualified tag, so the contract's shorter `[behavior:B-05]` spelling in the
  In-scope and preservation bullets names the same anchor; the qualified form is the one the
  tests use.
- Exactly two new spawned pipeline scenarios are added, both listed in harness tier 2 above,
  each spawned once in a `beforeAll` and asserted by several `it`s, each carrying a comment
  saying which orchestrator-side state no existing fixture reaches. Fake clean gates are
  `node -e` `package.json` scripts, per `finalEvaluationFixture`'s existing convention. Every
  other cleaner case is a direct `runCleanerStage` call or a store-level unit test, and no
  existing spawned `it` in that block is edited or replaced.

## Definition of done

- [ ] `src/eval-boundary.test.ts:127` reads `expect(RUN_STATE_VERSION).toBe(6)` and
      `src/qa-orchestration-gates.test.ts:1016` reads `expect(bumped.version).toBe(6)`, no
      version-5 pin against `RUN_STATE_VERSION` survives anywhere in `src/`, and nothing else
      in either file changed — the two pins are the whole of the work this contract still had
      outstanding at `b817ef2`.
- [ ] Every behavior B-01…B-14 has at least one test named with its own issue-qualified
      behavior-anchor tag `[behavior:#87:<id>]` and passing, selectable by
      `acceptance:behaviors`; the tags landed in and before `8d2c966` and the `#87:` qualifier
      is still present on each.
- [ ] Every preservation behavior P-01…P-10 has a test asserting the affordance is
      unchanged, tagged the same way and selectable by `acceptance:behaviors` — P-10
      included, which is the entry that locks the unedited `orchestratorOwned` refusal and
      the `artifactDirPolicy` default of `"exempt-prefix"`.
- [ ] Every manifest entry whose claim has a type-level half carries `typecheck` among its
      `gateIds` alongside `tests`, because vitest strips types without checking them
      (`CLAUDE.md`) — P-04 (the imported helper's signature and its exact release
      condition), P-09 (the widened `QAReviewStage` union) and P-10 (that every existing
      `outOfScopeChangedPaths` call site still compiles with `artifactDirPolicy` absent)
      included, since `tests` alone cannot observe a signature or a default-argument claim.
- [ ] `acceptance-manifest.json` declares exactly B-01…B-14 and P-01…P-10, every entry
      carrying `acceptance:behaviors` among its `gateIds`, and its `fileScope` is exactly
      the "Files expected to change" list, each path spelled as `git ls-files` reports it —
      `ARCHITECTURE.md` in that upper-case spelling, so the `scope` gate, which compares
      path strings rather than case-folded ones, does not report `1a9961a`'s
      `ARCHITECTURE.md` rows as an out-of-scope change on a case-insensitive checkout.
- [ ] `src/acceptance-gate.test.ts:306` still pins `GATE_EVIDENCE_VERSION` at 4, and
      `src/gate-runner.ts` still reads `GATE_EVIDENCE_VERSION = 4` and
      `SUPPORTED_GATE_EVIDENCE_VERSIONS = [1, 2, 3, 4]` — none of the three bumped further and
      the pin not moved back to 3.
- [ ] `pnpm run typecheck && pnpm test:fast` and `pnpm run test:heavy:qa` pass in this
      worktree; between them those two commands observe both remaining pins — `test:fast`
      covers `src/eval-boundary.test.ts` and `test:heavy:qa` runs
      `src/qa-orchestration.test.ts` and `src/qa-orchestration-gates.test.ts` together
      (`package.json`) — so no third command is needed and the full suite is not run for this
      slice's iteration. `test:heavy:qa`'s
      reported wall clock is recorded in the handoff, and if it exceeds the 151s
      `qa-orchestration` budget in `suite-budgets.json` the handoff reports the overrun with
      the number for an operator budget decision — that file is not in this slice's file scope
      and no budget number is raised here (ADR 0063).
- [ ] The changed files are exactly those listed under "Files expected to change"; this
      repository's `afk.config.json` is not edited.
- [ ] Exactly two new spawned pipeline scenarios exist, the two named in the test plan's
      harness tier 2, each spawned once in a `beforeAll` whose result its `it`s read, and each
      carrying a comment naming the orchestrator-side state no existing fixture reaches. No
      third spawned scenario is added and no existing spawned `it` in
      `src/qa-orchestration.test.ts` is edited or replaced; every other cleaner assertion is a
      direct `runCleanerStage` call or a store-level unit test.
- [ ] The `QAReviewStage` docstring (`src/qa-review.ts:70-75`) records the `"cleaner"`
      exception to its one-replay rule, so no shipped comment asserts an invariant the union no
      longer follows; `QA_REVIEW_STAGES` and every array-derived structure are unchanged.
- [ ] `ARCHITECTURE.md` names `src/cleaner-stage.ts` and `src/suppression-gate.ts` in the
      module table and records the post-approval writing-stage seam and `suppressions` under
      `GateDeclaration`.
- [ ] The handoff notes the cleaner call site on #226 and does not close it.

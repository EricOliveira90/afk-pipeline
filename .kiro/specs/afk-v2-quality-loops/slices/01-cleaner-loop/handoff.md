# Handoff — slice 01, cleaner loop (#87)

## What shipped

- `B-01`: `src/gate-policy.ts:parseClean` (with `POLICY_KEYS`'s `clean` member and `CHANGED_FILES_TOKEN`)
- `B-02`: `src/cleaner-stage.ts:expandChangedFiles` over `src/git.ts:diffTreePaths`
- `B-03`: `src/final-evaluation.ts:CLEANER_STAGE_ID` and `src/cleaner-stage.ts:runCleanerStage`, called once from `src/orchestrator.ts:runSliceExecute`'s post-approval block
- `B-04`: `src/cleaner-stage.ts:runCleanerStage`'s round-0 `runCandidateGatePhase` call
- `B-05`: `src/bounds.ts:MAX_CLEANER_ROUNDS`, `src/bounds.ts:cleanerRoundsRemaining`, and the loop's comparison against that remainder in `src/cleaner-stage.ts:runCleanerStage`
- `B-06`: `src/cleaner-stage.ts:runCleanerStage`'s per-round dispatch → sweep → `createCandidateCheckpoint` → one `runCandidateGatePhase`, with the `phase-started` / `phase-ended` pair in `src/orchestrator.ts`'s `dispatch` closure
- `B-07`: `src/cleaner-stage.ts:resetHardTo` at each of the four exit paths in `runCleanerStage`
- `B-08`: `src/cleaner-stage.ts:cleanerExhaustionReason` and `runCleanerStage`'s outcome selection
- `B-09`: `src/artifacts.ts:qaArchivePrefix`, `src/artifacts.ts:archiveCleanerLog`, `src/qa-review.ts:qaReviewFilename`, driven by `src/orchestrator.ts`'s `archiveRound` closure
- `B-10`: `src/suppression-gate.ts:runSuppressionGate` with `src/gate-runner.ts`'s `GateFindings.suppressions`, `GATE_EVIDENCE_VERSION = 4` and `SUPPORTED_GATE_EVIDENCE_VERSIONS`
- `B-11`: `src/escalation.ts:outOfScopeChangedPaths`'s `artifactDirPolicy` argument and `src/scope-gate.ts:ScopeGateInput`'s pass-through field
- `B-12`: `src/context-envelope.ts:CLEANER_CONTEXT_MANIFEST`, `src/context-envelope.ts:ContextEnvelopeRole`, `src/run-events.ts`'s `invocation-completed.role`, `prompts/cleaner.md`
- `B-13`: `src/cleaner-stage.ts:parseCleanerEscalation` with `runCleanerStage`'s `ESCALATED` / `ESCALATION_MALFORMED` paths and `src/run-state.ts:invalidateFinalEvaluationBaseline`
- `B-14`: `src/run-state.ts:RUN_STATE_VERSION`, `PersistedQualityStage`, `recordQualityStageRound`, `recordQualityStageOutcome`, `cleanerRoundsSpent`
- `P-01`: `src/cleaner-stage.ts:runCleanerStage`'s `DISABLED` early return
- `P-02`/`P-03`: `src/final-evaluation.ts:PostApprovalWritingStage`, `noopPostApprovalWritingStage`, `decideFinalReuse` (unchanged)
- `P-04`: `src/candidate-gate-phase.ts:assertGateEvidenceReleasesEvaluation` (unchanged, out of file scope)
- `P-05`: `src/escalation.ts:outOfScopeChangedPaths`'s default `"exempt-prefix"` branch; `src/post-qa-gates.ts` unchanged
- `P-06`/`P-07`: `src/gate-runner.ts:SUPPORTED_GATE_EVIDENCE_VERSIONS` and the in-process branch of `src/gate-runner.ts:runGates` that never caches
- `P-08`: `src/orchestrator.ts`'s single `approved-baseline.json` writer
- `P-09`: `src/qa-review.ts:QA_REVIEW_STAGES` (unchanged) with the `"cleaner"` docstring exception at `src/qa-review.ts:77`
- `P-10`: `src/escalation.ts`'s `orchestratorOwned` expression (unchanged)

## Decisions made during implementation

- `acceptedPairIntact` is threaded through `CleanerStageInput` from the orchestrator's proven verdict rather than passed as a literal `false` to the round's `feedback-integrity` declaration: that gate reads a literal `false` as "the accepted pair moved under the lock", an unwaivable FAIL, so every cleaner round would have been reverted regardless of what the cleaner did. The `scope` gate keeps its literal `false`, which answers a different question — whether the pair is exempt from the round's write scope.
- The cleaner's `phase-started` / `phase-ended` pair is keyed by the *cleaner* round, not the generator round. `stageInvocationKey` is `ghIssue|agent|round`, so three cleaner rounds inside one generator round need three distinct keys to yield three `stage-duration` samples; keying by the generator round pairs three starts into one sample and leaves two stages permanently open.
- `logger.agentLog` is opened before `phase-started` and `closeAgentLog` is awaited inside the `finally`. Both orders are load-bearing rather than stylistic: opening the stream first means only a round that reaches the `try`/`finally` ever enters the journal's open-stage set, and awaiting the close means the log's bytes are on disk before `archiveRound` copies them.
- `"cleaner"` widens the `QAReviewStage` union without joining `QA_REVIEW_STAGES`, so the archive prefix and filename maps gain a branch while the attempt-record validator, the resume-precedence sweep and `RECORD_FILENAME` are untouched — which is what keeps `src/qa-review.test.ts` out of this slice's file scope.
- `qualityStages` is a list of entries per issue, not a record keyed by tree id. Tree ids are content-addressed, so a re-approval after an escalation can produce the same id, and a single keyed record would charge the escalating round to the re-approved candidate's budget.
- Both tier-2 spawned scenarios cut a real slice worktree outside the fixture repository. `runGates` restores its checkpoint with `git clean -ffdx`, which with `worktreeDir === repoRoot` deletes the run's own ignored `.afk/` mid-gate.

## Gotchas / learnings

- `promise.finally(cb)` awaits a promise `cb` returns; a bare `finally { cb() }` block does not. Converting one to the other around `closeAgentLog` silently un-awaits the flush, and the only visible symptom is a downstream `existsSync` on the log file answering `false`. `archiveCleanerLog` returns `null` on that miss rather than throwing, so the loss is silent in the run log too.
- `archiveRound` runs the instant `dispatch` resolves, before any reset — anything a round's evidence needs from the worktree or from an open stream has to be settled by then.
- `RUN_STATE_VERSION` is a single module-level constant that tests pin as a literal in several files. Bumping it leaves stale pins in files a slice's file scope may not name; `src/eval-boundary.test.ts` (under `test:fast`) and `src/qa-orchestration-gates.test.ts` (under `test:heavy:qa`) were the two outside this slice's original map.
- `#226` is **not** closed by this slice. The `role` `ScopeComparisonSource` now has its first production caller — the cleaner round's `scope` declaration in `src/cleaner-stage.ts` — and no other writing role is wired to it.
- `pnpm run test:heavy:qa` measured **178.7s** in this worktree (`[suite-time] qa-orchestration: 178.7s`, 59 tests, exit 0), against the 151s `qa-orchestration` budget in `suite-budgets.json`. That is an **overrun of ~27.7s**, caused by the two new spawned scenarios this slice adds. `suite-budgets.json` is not in this slice's file scope and no number was raised here; the budget is an operator decision (ADR 0063 — a wall-clock budget cannot fail a gate, and `pnpm test:budgets` runs only inside `pnpm test:ratchet`).
- `pnpm run typecheck && pnpm test:fast` also ran clean in this worktree (100 files, 2273 tests, exit 0, `[suite-time] fast: 169.1s`). Vitest reported two `Timeout calling "onTaskUpdate"` worker RPC errors under load; they are reporter-transport noise on a loaded host, not test failures, and the run still exited 0.
- New migration files: 0.

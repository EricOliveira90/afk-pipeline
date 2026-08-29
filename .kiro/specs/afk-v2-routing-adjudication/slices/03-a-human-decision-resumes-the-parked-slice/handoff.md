# Handoff

## What shipped
- B-01: `src/adjudication.ts:parseAdjudication` accepts only exact, context-valid version-1 decisions and retains invalid input.
- B-02: `src/orchestrator.ts:runSliceNegotiate` validates and locks planner-winning proposals without another agent invocation.
- B-03: `src/orchestrator.ts:runSliceNegotiate` applies evaluator winners and third instructions through one planner invocation, then checks the revised manifest against the pre-apply manifest before locking.
- B-04: `src/orchestrator.ts:runPipeline` waits for decisions and re-dispatches accepted parked slices in the same run; `src/run-journal.ts:reopenAdjudication` permits the later terminal outcome.
- B-05: `src/adjudication.ts:waitForAdjudication` bounds expiry, while `src/orchestrator.ts:runPipeline` reuses persisted parked worktrees on later runs without ordinary negotiation.
- B-06: `src/adjudication.ts:waitForAdjudication` wakes on cancellation, and `src/orchestrator.ts:runPipeline` preserves parked state and evidence through the existing cancellation path.
- P-02/P-03 coverage: `src/orchestrator-runs.test.ts` proves malformed input retention, undecided sibling/dependent preservation, planner-applied behavior-ID stability refusal, and both injected post-lock refusal routes through orchestration with no generator dispatch.

## Decisions made during implementation
- Accepted adjudications remain verbatim on disk; strict JSON parsing does not rewrite the file.
- The private adjudication wait defaults to 60 seconds with a 1-second poll interval; tests inject shorter values and no CLI option was added.
- Before applying an accepted decision, the parked branch merges the current feature branch so resumed work includes completed siblings.
- Planner winners retain the proposed contract and manifest except for orchestrator-owned contract status; evaluator winners and third instructions receive one planner apply round.
- Planner-applied decisions capture the acceptance manifest before the apply invocation and run behavior-ID stability before coverage, bindings, and the contract-lock seam.
- Preservation and refusal assertions were added to the existing parked-plus-sibling pipeline fixture so no additional full pipeline scenario was introduced.
- The private `PipelineConfig.onContractLocked` test seam is composed after the production migration-prefix gate and receives the slice issue ID plus contract path.

## Gotchas / learnings
- A parked slice remains outside the failed set, but only `PASS` unblocks its DAG dependents.
- Invalid adjudication files remain byte-stable and do not dispatch agents; a later valid replacement can be consumed in the same or next run.
- Cancellation preserves both working and archived contract, impasse, stuck, and adjudication evidence.
- Persisted `ESCALATE` outcomes retain lock-refusal evidence, while the Markdown summary intentionally projects those rows as `STUCK` without the detailed reason; `run.log` retains the full refusal text.
- Planner-applied behavior renumbering is refused before `LOCKED`; the orchestration fixture verifies the unlocked contract, terminal stability evidence, and zero generator records.

## Status
Tests passing locally. No regressions.

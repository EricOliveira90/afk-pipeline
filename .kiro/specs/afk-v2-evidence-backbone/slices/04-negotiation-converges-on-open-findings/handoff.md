# Handoff

## What shipped
- Open-only round-2 routing: `src/contract-review.ts:openContractReviewFindings` and `src/orchestrator.ts:negotiateAttempt`.
- Fresh planner response validation: `src/contract-review.ts:loadContractResponse`.
- Complete evaluator lifecycle dispositions: `src/contract-review.ts:validateRound2ContractReview`.
- Revision-bound fresh findings and terminal-state protection: `src/contract-review.ts:validateRound2ContractReview`.
- Per-attempt lifecycle evidence: `src/contract-review.ts:buildContractReviewAttemptRecord` and `src/orchestrator.ts:archiveContractReviewAttempt`.
- Impasse and non-convergence outcomes: `src/contract-review.ts:buildContractNegotiationOutcome` and `src/orchestrator.ts:preserveContractNegotiationFailure`.
- Hard two-round cap: `src/cli-options.ts:parseMaxContractRounds` and `src/orchestrator.ts:negotiateAttempt`.

## Decisions made during implementation
- Positive configured round limits remain valid input, but both CLI parsing and direct orchestrator configuration clamp them to two.
- Fresh round-2 findings carry null planner position and evidence because they were not part of the routed set.
- Lifecycle records are written only for schema-valid attempts; malformed attempts retain their raw archived artifacts.
- Exhaustion outcomes include unresolved BLOCKING findings only, and any held CONTESTED finding classifies the outcome as IMPASSE.

## Gotchas / learnings
- Round-2 planner response freshness depends on deleting the working artifact in the invocation hook immediately before the planner runs.
- Exact revision citations compare both excerpts against the prior and current contract or acceptance manifest; unequal prose alone is insufficient.
- Contract-lock refusals still consume the same planner budget and evaluator invocation count under the hard cap.

## Status
Tests passing locally. No regressions.

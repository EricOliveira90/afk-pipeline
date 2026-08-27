# Handoff

## What shipped
- Open-only round-2 routing: `src/contract-review.ts:openContractReviewFindings` and `src/orchestrator.ts:negotiateAttempt`.
- Fresh planner response validation, including post-review contract-lock refusals: `src/contract-review.ts:loadContractResponse` and `src/orchestrator.ts:negotiateAttempt`.
- Complete evaluator lifecycle dispositions: `src/contract-review.ts:validateRound2ContractReview`.
- Revision-bound fresh findings, changed-text proof, and terminal-state protection: `src/contract-review.ts:validateRound2ContractReview`.
- Per-attempt lifecycle evidence: `src/contract-review.ts:buildContractReviewAttemptRecord` and `src/orchestrator.ts:archiveContractReviewAttempt`.
- Impasse and non-convergence outcomes only when unresolved BLOCKING findings remain: `src/contract-review.ts:buildContractNegotiationOutcome` and `src/orchestrator.ts:preserveContractNegotiationFailure`.
- Hard two-round cap: `src/cli-options.ts:parseMaxContractRounds` and `src/orchestrator.ts:negotiateAttempt`.

## Decisions made during implementation
- Positive configured round limits remain valid input, but both CLI parsing and direct orchestrator configuration clamp them to two.
- Fresh round-2 findings carry null planner position and evidence because they were not part of the routed set.
- Lifecycle records are written only for schema-valid attempts; malformed attempts retain their raw archived artifacts.
- A planner response is required in planner round 2 when a prior evaluator review exists, regardless of whether that review returned REVISE or ACCEPT; pre-evaluation mechanical gate retries keep their existing path.
- Exhaustion outcomes include unresolved BLOCKING findings only; no such finding means no outcome artifact, and any held CONTESTED finding classifies the outcome as IMPASSE.
- A fresh finding's cited before excerpt must disappear and its after excerpt must be new in the selected artifact snapshot.

## Gotchas / learnings
- A contract-lock refusal can follow an ACCEPT review with an empty routed set; the second planner still writes a fresh response whose responses array is empty.
- Round-2 planner response freshness depends on deleting the working artifact in the invocation hook immediately before the planner runs.
- Exact revision citations compare both excerpts across both contract or acceptance-manifest snapshots; unequal prose that existed in both snapshots is insufficient.
- Contract-lock refusals still consume the same planner budget and evaluator invocation count under the hard cap.

## Status
Tests passing locally. No regressions.

# Handoff

## What shipped
- Immutable candidate checkpoints: `src/git.ts:createCandidateCheckpoint` commits generator output and creates a detached checkpoint before base gates; `createCandidateCheckpointRestorer` restores that exact tree between gates.
- Provider-independent bounded execution: `src/command-runtime.ts:runBoundedCommand` streams both output channels and enforces cancellation, inactivity, wall-clock, and process-tree termination bounds.
- Ordered structured base-gate evidence: `src/gate-runner.ts:runGates` runs discovered declarations in order, retains logs and versioned results, and continues after independent command failures.
- Required failure classification: `src/gate-runner.ts:classifyExecution` distinguishes `FAIL/COMMAND`, `FAIL/CONFIGURATION`, `INFRASTRUCTURE/null`, and optional `SKIPPED/null`.
- Evaluation and merge gating: `src/orchestrator.ts:runSliceExecute` retries infrastructure without consuming a generator round, sends all command failures to the next generator, and calls `assertGateEvidenceReleasesEvaluation` before evaluator invocation and PASS.
- Retained evidence integrity: `src/gate-runner.ts:verifyGateEvidence` binds evidence and log bytes to declarations, attempt identity, and checkpoint tree identity across later attempts.
- Gate observability: `src/run-journal.ts:recordGateAttempt` emits typed outcomes, while `src/logger.ts:addGateAttempt` and `writeSummary` expose status, failure kind, elapsed time, and artifact references.
- Existing baseline discovery: `src/orchestrator.ts:resolveBaseGateDeclarations` preserves the `typecheck`, `lint`, then `test:run`/`test` order for all agent providers and records absent scripts as optional skips.

## Decisions made during implementation
- Store gate evidence in the orchestrator-owned run directory, outside writable slice artifact trees.
- Restore the detached checkpoint before and after every gate because project commands may write files.
- Keep SHA-256 references in orchestrator memory and revalidate retained evidence before evaluation and merge.
- Use the existing command timeout setting for both inactivity and wall-clock bounds in this policy-less baseline slice.
- Use the locked contract's `COMMAND` failure-kind literal for ordinary nonzero exits and timeouts.

## Gotchas / learnings
- `BASE_GATE_STEPS` mirrors the extracted pre-ship discovery set in `src/preship.ts`; keep both ordered sets synchronized under ADR 0012.
- Heavy Git and orchestration tests should run in isolation on Windows; concurrent heavy files can exhaust Vitest worker RPC or fixed per-test timeouts.
- The supplied `qa-report.md` records an earlier evaluation before the evidence-integrity and checkpoint-restoration fixes; the next evaluator invocation must replace it.

## Status
Tests passing locally. No regressions.

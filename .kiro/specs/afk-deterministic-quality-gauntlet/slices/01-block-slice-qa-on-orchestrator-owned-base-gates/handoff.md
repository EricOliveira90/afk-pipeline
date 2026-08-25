# Handoff

## What shipped
- Immutable candidate checkpoints: `src/gate-runner.ts:createCandidateCheckpoint` captures generator output without advancing the slice branch; `createCandidateCheckpointRestorer` restores the exact tree between gates, including removal of nested repositories created by prior gates.
- Provider-independent bounded execution: `src/command-runtime.ts:runBoundedCommand` streams stdout and stderr, enforces cancellation, inactivity and wall-clock bounds, and verifies process-tree termination.
- Ordered structured base-gate evidence: `src/gate-runner.ts:runGates` executes discovered declarations in order, continues after independent failures, and retains versioned results and logs per checkpoint attempt.
- Required failure classification: `src/gate-runner.ts:classifyExecution` distinguishes command failures, configuration failures, infrastructure failures, and optional skipped gates.
- Evaluation and merge gating: `src/orchestrator.ts:runSliceExecute` retries infrastructure without consuming a generator round, sends accumulated command failures to the next generator, and releases evaluation only after required gates pass.
- Retained evidence and observability: `src/gate-runner.ts:verifyGateEvidence`, `src/run-events.ts:RunEvent`, and `src/logger.ts:writeSummary` preserve and expose checkpoint-bound status, failure kind, duration, and artifact references.
- Existing discovery and cancellation behavior: `src/orchestrator.ts:resolveBaseGateDeclarations` uses the existing ordered sanity discovery, while `src/gate-runner.ts:runGates` retains partial logs and omits terminal results for interrupted gates.

## Decisions made during implementation
- Store gate evidence in the orchestrator-owned run directory outside writable slice artifact trees.
- Restore the detached checkpoint before and after every executable gate.
- Use Git's double-force clean mode so untracked nested repositories cannot survive checkpoint restoration.
- Keep SHA-256 evidence references in orchestrator memory and revalidate retained bytes before evaluation and merge.
- Use the configured command timeout for inactivity and a separate 60-minute base-gate wall-clock limit.
- Avoid materializing a checkpoint checkout when every discovered gate is skipped.

## Gotchas / learnings
- `git clean -fdx` preserves untracked nested repositories; exact checkpoint restoration requires a second force flag.
- Temporary Git repositories must override ambient hooks before their first commit to keep integration fixtures isolated from machine-global hook processes.

## Status
Tests passing locally. No regressions.

# Handoff

## What shipped
- Immutable candidate checkpoints: `src/gate-runner.ts:createCandidateCheckpoint` captures generator output with a temporary Git index and creates a detached checkpoint without advancing the slice branch; `createCandidateCheckpointRestorer` restores that exact tree between gates.
- Provider-independent bounded execution: `src/command-runtime.ts:runBoundedCommand` streams both output channels, enforces cancellation, inactivity, and wall-clock bounds, and rejects incomplete or unverified process-tree termination.
- Ordered structured base-gate evidence: `src/gate-runner.ts:runGates` runs discovered declarations in order, retains logs and versioned results, continues after independent command failures, and preserves an observed command exit code when checkpoint restoration fails.
- Required failure classification: `src/gate-runner.ts:classifyExecution` distinguishes `FAIL/COMMAND`, `FAIL/CONFIGURATION`, `INFRASTRUCTURE/null`, and optional `SKIPPED/null`.
- Evaluation and merge gating: `src/orchestrator.ts:runSliceExecute` retries infrastructure without consuming a generator round, retains command failures from every retry, and calls `assertGateEvidenceReleasesEvaluation` before evaluator invocation and PASS.
- Retained evidence integrity: `src/gate-runner.ts:verifyGateEvidence` binds evidence and log bytes to declarations, attempt identity, and checkpoint tree identity across later attempts.
- Gate observability: `src/orchestrator.ts:runSliceExecute` emits typed outcomes through the existing journal API, while `src/logger.ts:writeSummary` projects status, failure kind, elapsed time, and artifact references from the event stream.
- Existing baseline discovery: `src/orchestrator.ts:resolveBaseGateDeclarations` projects stable base-gate declarations from `resolveSanityCommands`, preserving the aggregate `typecheck`, `lint`, then `test:run`/`test` policy without changing `src/preship.ts`.
- Cancellation and isolation fixes: `src/gate-runner.ts:runGates` exits on a cancelled execution before checkpoint restoration or result classification, retains the interrupted log without a terminal outcome, and removes tracked, untracked, and ignored output before each subsequent gate.
- Termination failure classification: `src/command-runtime.ts:ProcessTreeTerminationError` and `src/orchestrator.ts:isCancelled` prevent an aborted signal from hiding incomplete process-tree termination behind `CANCELLED`.
- Skipped-gate checkpoint efficiency: `src/gate-runner.ts:createCandidateCheckpoint` can retain an immutable commit/tree identity without materializing a checkout; `src/orchestrator.ts:runSliceExecute` uses that mode only when every discovered gate is skipped.

## Decisions made during implementation
- Store gate evidence in the orchestrator-owned run directory, outside writable slice artifact trees.
- Restore the detached checkpoint before and after every gate because project commands may write files.
- Keep SHA-256 references in orchestrator memory and revalidate retained evidence before evaluation and merge.
- Use the existing command timeout setting for both inactivity and wall-clock bounds in this policy-less baseline slice.
- Use the final infrastructure attempt to determine recovery, while retaining required command failures from every attempt on the checkpoint.
- Check cancellation before post-command restoration so restoration failure cannot invent an `INFRASTRUCTURE` result or terminal event for an interrupted gate.
- Keep incomplete process-tree termination distinct from normal cancellation even when the shared signal is aborted.
- Keep cancellation and sanity-discovery regression tests in contract-declared test files.

## Gotchas / learnings
- The final full `pnpm test` run had zero failed tests but exited 1 because Vitest reported `[vitest-worker]: Timeout calling "onTaskUpdate"`.
- Windows process-tree verification can exceed the repository's 15-second default test timeout under load; the two real termination scenarios use explicit 30-second bounds.

## Status
Typecheck and build passing locally. All test assertions passed in the latest full run; `pnpm test` exited 1 on a Vitest worker RPC timeout.

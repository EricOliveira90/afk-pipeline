# Handoff

## What shipped
- Immutable candidate checkpoints: `src/gate-runner.ts:createCandidateCheckpoint` captures generator output with a temporary Git index and creates a detached checkpoint without advancing the slice branch; `createCandidateCheckpointRestorer` restores that exact tree between gates.
- Provider-independent bounded execution: `src/command-runtime.ts:runBoundedCommand` streams both output channels, enforces cancellation, inactivity, and wall-clock bounds, and rejects incomplete or unverified process-tree termination.
- Ordered structured base-gate evidence: `src/gate-runner.ts:runGates` runs discovered declarations in order, retains logs and versioned results, continues after independent command failures, and preserves an observed command exit code when checkpoint restoration fails.
- Required failure classification: `src/gate-runner.ts:classifyExecution` distinguishes `FAIL/COMMAND`, `FAIL/CONFIGURATION`, `INFRASTRUCTURE/null`, and optional `SKIPPED/null`.
- Evaluation and merge gating: `src/orchestrator.ts:runSliceExecute` retries infrastructure without consuming a generator round, retains command failures from every retry, and calls `assertGateEvidenceReleasesEvaluation` before evaluator invocation and PASS.
- Retained evidence integrity: `src/gate-runner.ts:verifyGateEvidence` binds evidence and log bytes to declarations, attempt identity, and checkpoint tree identity across later attempts.
- Gate observability: `src/orchestrator.ts:runSliceExecute` emits typed outcomes through the existing journal API, while `src/logger.ts:writeSummary` projects status, failure kind, elapsed time, and artifact references from the event stream.
- Existing baseline discovery: `src/preship.ts:resolveSanityStepScripts` is the ordered source for both `src/orchestrator.ts:resolveBaseGateDeclarations` and aggregate sanity, preserving `typecheck`, `lint`, then `test:run`/`test` discovery.
- Cancellation and isolation fixes: `src/gate-runner.ts:runGates` exits on a cancelled execution before checkpoint restoration or result classification, retains the interrupted log without a terminal outcome, and removes tracked, untracked, and ignored output before each subsequent gate.
- Skipped-gate checkpoint efficiency: `src/gate-runner.ts:createCandidateCheckpoint` can retain an immutable commit/tree identity without materializing a checkout; `src/orchestrator.ts:runSliceExecute` uses that mode only when every discovered gate is skipped.

## How the STUCK findings were cleared
- Cancellation now settles only after `terminateProcessTree` reports a verified dead root with no survivors.
- `src/qa-orchestration.test.ts` fixture cleanup retries transient Windows `EBUSY`, `ENOTEMPTY`, and `EPERM` failures asynchronously.
- Base and aggregate sanity declarations now project from one discovery result instead of mirrored constants and package readers.
- Post-command checkpoint restoration failures retain `execution.exitCode` in infrastructure evidence.

## Decisions made during implementation
- Store gate evidence in the orchestrator-owned run directory, outside writable slice artifact trees.
- Restore the detached checkpoint before and after every gate because project commands may write files.
- Keep SHA-256 references in orchestrator memory and revalidate retained evidence before evaluation and merge.
- Use the existing command timeout setting for both inactivity and wall-clock bounds in this policy-less baseline slice.
- Use the locked contract's `COMMAND` failure-kind literal for ordinary nonzero exits and timeouts.
- Read completed gate outcomes from `events.jsonl` when writing the summary so observability stays within the contract-declared files.
- Use the final infrastructure attempt to determine recovery, while retaining required command failures from every attempt on the checkpoint.
- Check cancellation before post-command restoration so restoration failure cannot invent an `INFRASTRUCTURE` result or terminal event for an interrupted gate.
- Resolve baseline declarations from generator output before checkpoint creation; materialize a detached checkout only when at least one declaration has a command to execute.
- Keep infrastructure classification for restoration failure while retaining any exit code already observed from the command.

## Gotchas / learnings
- Multiple full `pnpm test` runs completed without assertion failures but exited 1 because Vitest reported `[vitest-worker]: Timeout calling "onTaskUpdate"` on this Windows host.
- The gate-runner regression suite passed all 14 tests during the full GREEN run.

## Status
Typecheck and build passing locally. Slice-owned tests pass. The latest full suite had no assertion failures but exited 1 on a Vitest worker RPC timeout.

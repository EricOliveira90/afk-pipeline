# Handoff

## What shipped
- Immutable candidate checkpoints: `src/gate-runner.ts:createCandidateCheckpoint` captures generator output with a temporary Git index and creates a detached checkpoint without advancing the slice branch; `createCandidateCheckpointRestorer` restores that exact tree between gates.
- Provider-independent bounded execution: `src/command-runtime.ts:runBoundedCommand` streams both output channels and enforces cancellation, inactivity, wall-clock, and process-tree termination bounds.
- Ordered structured base-gate evidence: `src/gate-runner.ts:runGates` runs discovered declarations in order, retains logs and versioned results, and continues after independent command failures.
- Required failure classification: `src/gate-runner.ts:classifyExecution` distinguishes `FAIL/COMMAND`, `FAIL/CONFIGURATION`, `INFRASTRUCTURE/null`, and optional `SKIPPED/null`.
- Evaluation and merge gating: `src/orchestrator.ts:runSliceExecute` retries infrastructure without consuming a generator round, retains command failures from every retry, and calls `assertGateEvidenceReleasesEvaluation` before evaluator invocation and PASS.
- Retained evidence integrity: `src/gate-runner.ts:verifyGateEvidence` binds evidence and log bytes to declarations, attempt identity, and checkpoint tree identity across later attempts.
- Gate observability: `src/orchestrator.ts:runSliceExecute` emits typed outcomes through the existing journal API, while `src/logger.ts:writeSummary` projects status, failure kind, elapsed time, and artifact references from the event stream.
- Existing baseline discovery: `src/orchestrator.ts:resolveBaseGateDeclarations` preserves `typecheck`, `lint`, then `test:run`/`test` command discovery for every provider, exposes stable `typecheck`, `lint`, and `tests` gate IDs, and records absent scripts as optional skips.
- Cancellation and isolation fixes: `src/gate-runner.ts:runGates` exits on a cancelled execution before checkpoint restoration or result classification, retains the interrupted log without a terminal outcome, and removes tracked, untracked, and ignored output before each subsequent gate.
- Skipped-gate checkpoint efficiency: `src/gate-runner.ts:createCandidateCheckpoint` can retain an immutable commit/tree identity without materializing a checkout; `src/orchestrator.ts:runSliceExecute` uses that mode only when every discovered gate is skipped.

## How the STUCK findings were cleared
- Slice-owned timeout and cleanup failures: skipped-only candidates no longer create and remove detached Git worktrees, reducing suite-wide Git contention; the shared `src/gate-runner.test.ts` cleanup hook retries transient Windows locks.
- Remaining non-green suite fixture: this cannot be cleared within the locked contract. The combined targeted run passed all 13 gate-runner, 62 git, and 37 wave tests, but `src/clean-failed.test.ts:252` exceeded its inherited 15-second timeout under concurrent Git load. That file and `vitest.config.ts` are outside the eight declared source paths. The exact test passes alone in 8.6 seconds.

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

## Gotchas / learnings
- `BASE_GATE_STEPS` mirrors the extracted pre-ship discovery set in `src/preship.ts`; keep both ordered sets synchronized under ADR 0012.
- Full-suite reliability still requires a separately scoped change to fixed timeouts and Windows cleanup in `src/clean-failed.test.ts`, `src/git.test.ts`, `src/wave.test.ts`, or `vitest.config.ts`; changing those paths here would violate the locked contract.
- Do not interpret the remaining timeout as a clean-failed behavior defect: the isolated MERGE-PENDING scenario passes, and the combined run reported no assertion mismatch.
- The branch diff against `origin/main` contains only the eight source paths declared by the locked contract.

## Status
Typecheck and build passing locally. Slice-owned tests pass, including timeout, cancellation, and required-gate scenarios. The required full suite is not claimable within this locked boundary because an undeclared clean-failed fixture still has a load-sensitive 15-second timeout.

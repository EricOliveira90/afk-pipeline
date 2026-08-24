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
- Skipped-gate checkpoint efficiency: `src/gate-runner.ts:createCandidateCheckpoint` can retain an immutable commit/tree identity without materializing a checkout, and snapshots the source index with four Git processes instead of six; `src/orchestrator.ts:runSliceExecute` uses that mode only when every discovered gate is skipped.
- Deterministic QA fixture teardown: `src/qa-orchestration.test.ts:terminateFixtureChildren` closes every registered fixture child before its temporary repository is removed.

## How the STUCK findings were cleared
- Full-suite timeout cascades: immutable checkpoint capture now combines commit, tree, and index discovery and copies the source index instead of launching separate `rev-parse` and `read-tree` processes. The Windows regression test bounds unmaterialized capture at four Git processes while proving staged, unstaged, and untracked contents remain exact.
- Loaded provider gate failures: the provider-independence fixture uses a 30-second inactivity budget instead of racing real `pnpm run` startup at five seconds; dedicated gate-runner tests retain tight 100ms and 150ms timeout coverage.
- Contract-owned `EBUSY` cleanup failures: QA fixtures now own child lifetimes and await child closure before directory removal, so cleanup no longer depends on a child exiting within a fixed retry window.
- Reporter RPC failure: the merged feature base suppresses console capture and live reporter summaries in `vitest.config.ts`; that path remains outside this slice's locked diff.
- Verification: the exact implicated matrix passed all 126 tests across `gate-runner`, `qa-orchestration`, `git`, and `wave` with two workers and no timeout cascade, `EBUSY`, or reporter RPC failure.

## Decisions made during implementation
- Store gate evidence in the orchestrator-owned run directory, outside writable slice artifact trees.
- Restore the detached checkpoint before and after every gate because project commands may write files.
- Keep SHA-256 references in orchestrator memory and revalidate retained evidence before evaluation and merge.
- Keep the configured command timeout as the inactivity bound and use a separate 60-minute base-gate wall-clock ceiling.
- Use the final infrastructure attempt to determine recovery, while retaining required command failures from every attempt on the checkpoint.
- Check cancellation before post-command restoration so restoration failure cannot invent an `INFRASTRUCTURE` result or terminal event for an interrupted gate.
- Keep incomplete process-tree termination distinct from normal cancellation even when the shared signal is aborted.
- Keep cancellation and sanity-discovery regression tests in contract-declared test files.
- Keep the shared Windows directory-removal helper outside the locked slice diff and consume it from the contract-owned QA test.
- Terminate and await registered fixture children before applying filesystem cleanup retries.
- Copy the source Git index into the temporary checkpoint index, then apply `git add -A`; this preserves the source index while reducing process contention.

## Gotchas / learnings
- Windows does not permit removal of a repository while a child process still uses it as its working directory; retry-only cleanup remains duration-dependent unless teardown owns that process.
- A five-second inactivity budget can classify healthy `pnpm` startup as a command failure under two-worker Git load even when the same fixture passes in isolation.
- The reporter fix is owned by the feature branch's `vitest.config.ts`; it is intentionally absent from this locked slice diff.
- The full `pnpm test` suite was not rerun in this attempt because the resume instructions reserve it for the normal QA gate.

## Status
Tests passing locally. No regressions in the targeted 126-test finding matrix. Typecheck and build pass. Full suite deferred to the normal QA gate as instructed.

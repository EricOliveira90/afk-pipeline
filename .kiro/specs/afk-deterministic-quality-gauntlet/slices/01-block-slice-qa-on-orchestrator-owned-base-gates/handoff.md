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
- Cancellation and isolation fixes: `src/gate-runner.ts:runGates` retains interrupted logs without terminal outcomes and removes tracked, untracked, and ignored output before each subsequent gate.

## Decisions made during implementation
- Store gate evidence in the orchestrator-owned run directory, outside writable slice artifact trees.
- Restore the detached checkpoint before and after every gate because project commands may write files.
- Keep SHA-256 references in orchestrator memory and revalidate retained evidence before evaluation and merge.
- Use the existing command timeout setting for both inactivity and wall-clock bounds in this policy-less baseline slice.
- Use the locked contract's `COMMAND` failure-kind literal for ordinary nonzero exits and timeouts.
- Read completed gate outcomes from `events.jsonl` when writing the summary so observability stays within the contract-declared files.
- Use the final infrastructure attempt to determine recovery, while retaining required command failures from every attempt on the checkpoint.

## Gotchas / learnings
- `BASE_GATE_STEPS` mirrors the extracted pre-ship discovery set in `src/preship.ts`; keep both ordered sets synchronized under ADR 0012.
- Full `pnpm test` runs remained non-green on this Windows host because Git-heavy tests exceeded fixed 10-60 second limits and Vitest worker RPC timed out. The latest run had 11 timeout/cascade failures after 31 minutes; the 11 gate-runner tests and 13 resume integration tests passed.
- The branch diff against `origin/main` contains only the eight source paths declared by the locked contract.

## Status
Typecheck and build passing locally. Contract-focused tests green. Full suite not green due Windows Git and worker timeouts.

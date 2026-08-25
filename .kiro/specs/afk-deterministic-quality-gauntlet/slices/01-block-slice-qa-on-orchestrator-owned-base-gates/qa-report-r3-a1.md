# QA Report

**Verdict:** FAIL
**Failure class:** IMPLEMENTATION

## Pass 1: Functional Correctness
- Sanity commands: FAIL
  - `pnpm run typecheck`: PASS (exit 0 after 18.2s).
  - `pnpm run test`: FAIL (exit 1 after 2118.2s; 16 failed tests and 1 unhandled Vitest worker error).
- UAT verification: NOT IN SCOPE
- Boundary compliance: PASS
- Preservation check: FAIL

## Pass 2: Quality & Craft
- Convention compliance: NOT RUN
- Code quality: NOT RUN
- Test quality: NOT RUN

## Resolved findings
- Cancellation can complete while the command tree is still alive: cleared. `src/command-runtime.ts:104-126` rejects incomplete termination with `ProcessTreeTerminationError`, and `src/orchestrator.ts:379-381` does not convert that error to `CANCELLED` merely because the signal is aborted.
- Base and aggregate gate discovery can drift: cleared. `src/orchestrator.ts:124-145` derives base declarations from the existing `resolveSanityCommands` result, preserving ADR 0012's shared discovery path.
- Restore failures discard an observed command exit code: cleared. `src/gate-runner.ts:307-327` retains `execution.exitCode` in the infrastructure result.
- The implementation exceeds the locked file boundary: cleared. `git diff --name-status feat-codex/afk-deterministic-quality-gauntlet...HEAD` contains only the contract-declared source and test paths plus `handoff.md`; the prior `src/preship.ts` and `src/command-runtime.test.ts` changes are absent.

## Findings
### Finding 1 — The required full suite remains non-green
**Severity:** Major
**Pass:** 1
**Evidence:** Verbatim `pnpm run test` exited 1 after 2118.2s with 16 failed tests and an unhandled `[vitest-worker]: Timeout calling "onTaskUpdate"`. Contract-owned failures included `src/gate-runner.test.ts:168` timing out while checking ignored-output cleanup, the later inactivity case at `src/gate-runner.test.ts:578` failing because its fixture repository had already been removed, and `src/qa-orchestration.test.ts:441` failing with `EBUSY` after the cleanup retry loop at lines 30-43. Eleven `src/git.test.ts` cases and two `src/wave.test.ts` cases also exceeded their configured timeouts.
**What the contract expected:** "All tests pass locally: `pnpm typecheck`, `pnpm test`, and `pnpm build`" and "No regression in existing suite."
**What I observed:** Type checking passes, but the mandatory full suite is still unstable on the supported Windows environment. The failures include this slice's own deterministic tests and cleanup fixture, so source and fixture changes can address them; this is not an external infrastructure outage.

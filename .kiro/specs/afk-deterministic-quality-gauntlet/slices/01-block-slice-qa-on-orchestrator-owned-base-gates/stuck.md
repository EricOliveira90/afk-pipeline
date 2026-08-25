# Stuck Handoff

## What the evaluator wants

Round 3 leaves this finding unresolved:

> ### Finding 1 — The required full suite remains non-green
> **Severity:** Major
> **Pass:** 1
> **Evidence:** Verbatim `pnpm run test` exited 1 after 2118.2s with 16 failed tests and an unhandled `[vitest-worker]: Timeout calling "onTaskUpdate"`. Contract-owned failures included `src/gate-runner.test.ts:168` timing out while checking ignored-output cleanup, the later inactivity case at `src/gate-runner.test.ts:578` failing because its fixture repository had already been removed, and `src/qa-orchestration.test.ts:441` failing with `EBUSY` after the cleanup retry loop at lines 30-43. Eleven `src/git.test.ts` cases and two `src/wave.test.ts` cases also exceeded their configured timeouts.
> **What the contract expected:** "All tests pass locally: `pnpm typecheck`, `pnpm test`, and `pnpm build`" and "No regression in existing suite."
> **What I observed:** Type checking passes, but the mandatory full suite is still unstable on the supported Windows environment. The failures include this slice's own deterministic tests and cleanup fixture, so source and fixture changes can address them; this is not an external infrastructure outage.

All other findings were explicitly cleared by a later report.

## What you tried

- The initial implementation added immutable candidate checkpoints, bounded command execution with process-tree termination, ordered base-gate evidence, failure classification, evaluator and merge gating, evidence verification, typed events, and provider-independent gate discovery.
- After round 1, incomplete process-tree termination was changed from a warning to an error, Windows cleanup in `qa-orchestration` gained retries, base and aggregate gate discovery were made shared, and restoration failures retained an observed command exit code.
- After round 2, `ProcessTreeTerminationError` was kept distinct from normal cancellation at the orchestrator boundary, gate-runner cleanup was hardened, shared discovery was reworked to stay inside the locked paths, and cancellation and discovery coverage was moved into contract-declared test files.
- Test timeouts and cleanup behavior were adjusted in slice-owned tests, including loaded provider gate runs. Repeated full-suite runs still failed variably with fixed test timeouts, cascading fixture removal, Windows `EBUSY`, and a Vitest worker RPC timeout.

## Your best guess at the blocker

**Implementation ambiguity:** Low for product behavior. Round 3 explicitly clears cancellation semantics, shared discovery, exit-code retention, and boundary compliance. The remaining scope question is whether test hardening outside the locked file list is permitted, but the latest report also identifies actionable failures in contract-owned `gate-runner` and `qa-orchestration` tests.

**Test-framework gaps:** This is the primary blocker. Git-heavy integration tests rely on fixed timeouts and cleanup hooks that can run after a timed-out test still owns processes or file handles. That creates cascades: one timeout removes a fixture needed by a later case, while the QA cleanup retry loop can still exhaust on `EBUSY`. Vitest also loses worker progress reporting under the same load.

**Dependencies:** No dependency defect is evidenced. Package commands start, type checking passes, and most tests complete. None of the reports identifies a missing package, incompatible version, or dependency upgrade as the remedy.

**Infrastructure evidence:** Windows file locking, hundreds of real Git subprocesses, long runtime, broad `git` and `wave` timeouts, and `[vitest-worker]: Timeout calling "onTaskUpdate"` show host and runner pressure. That evidence explains variability but does not clear the finding: the evaluator explicitly treats the slice-owned timeout and cleanup failures as implementation-fixable rather than an external outage.

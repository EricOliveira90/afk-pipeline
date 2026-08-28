# QA Report

**Verdict:** FAIL
**Failure class:** IMPLEMENTATION

## Pass 1: Functional Correctness
- Sanity commands: PASS
- UAT verification: NOT IN SCOPE
- Boundary compliance: PASS
- Preservation check: FAIL

## Pass 2: Quality & Craft
- Convention compliance: NOT RUN
- Code quality: NOT RUN
- Test quality: NOT RUN

## Resolved findings
- none

## Findings
### Finding 1 — Migration-count disagreement escapes the lock-refusal flow
**Severity:** Major
**Pass:** 1
**Evidence:** `pnpm install --frozen-lockfile`, `pnpm run typecheck`, and `pnpm run test` all exited zero. However, `src/migration-claims.ts:102-109` throws when a persisted claim's length differs from the current manifest count. `claimContractMigrations` calls that function before `validateContractMigrationClaim` can return a planner-facing objection, and `src/orchestrator.ts:1356-1375` does not catch exceptions from `onContractLocked`. Thus, after an earlier round creates a claim, a later round that changes `migrationCount` exits through the error path instead of reopening the contract and emitting `contract-lock-refused`. The required disagreement case has no assertion in `src/migration-claims.test.ts`, `src/orchestrator.test.ts`, or `src/wave.test.ts`.
**What the contract expected:** "Given reserved migration prefixes, when manifest count or paths disagree with the claim, then lock is refused; matching values proceed." It also requires that "Migration claims remain stable across rounds and runs."
**What I observed:** Path disagreement returns an objection, but count disagreement with an existing claim throws. The contract can remain `LOCKED`, no refusal evidence is emitted, and the planner does not receive the corrective round required by the contract.

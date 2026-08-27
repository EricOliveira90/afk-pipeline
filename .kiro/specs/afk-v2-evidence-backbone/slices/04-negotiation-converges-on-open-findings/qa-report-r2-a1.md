# QA Report

**Verdict:** FAIL
**Failure class:** IMPLEMENTATION

## Pass 1: Functional Correctness
- Sanity commands: FAIL
- UAT verification: NOT IN SCOPE
- Boundary compliance: FAIL
- Preservation check: PASS

`pnpm install --frozen-lockfile` and `pnpm run typecheck` exited
successfully. All Vitest suites inside `pnpm run test` passed, but the
command exited unsuccessfully at `test:budgets`: `fast` took 130.5s against
its 110s budget. The other measured suites and the 849.0s total remained
within budget.

## Pass 2: Quality & Craft
- Convention compliance: NOT RUN
- Code quality: NOT RUN
- Test quality: NOT RUN

## Resolved findings
- Lock-refusal round 2 bypasses the planner-response lifecycle:
  `src/orchestrator.ts:1735` now requires a response whenever round 2 has a
  previous review. `src/wave-migrations.test.ts:637` verifies stale-response
  deletion, missing fresh output, and no second evaluator invocation.
- Mechanical lock refusal is emitted as empty non-convergence:
  `src/contract-review.ts:725` now omits outcomes without unresolved BLOCKING
  findings. `src/wave-migrations.test.ts:834-845` verifies no exhaustion
  classification or outcome artifact is written.
- Revision citations need not identify changed text:
  `src/contract-review.ts:848-855` rejects excerpts that survive across
  snapshots, and `src/contract-review.test.ts:867-893` covers distinct
  excerpts taken from unchanged text.

## Findings
### Finding 1 — The required full suite exceeds the fast-suite budget
**Severity:** Major
**Pass:** 1
**Evidence:** The required `pnpm run test` run completed every Vitest suite,
then `pnpm run test:budgets` reported `fast: 130.5s / 110s`, identified a
20.5s overrun, and exited with code 1. The total was 849.0s / 1067s.
**What the contract expected:** "Given the implementation, when the evaluator
runs ... `pnpm test:fast` ... then each exits successfully."
**What I observed:** The fast suite's tests passed, but its enforced wall-clock
budget failed, so the required sanity command did not exit successfully.

### Finding 2 — A terminal finding can reactivate across evaluator retries
**Severity:** Major
**Pass:** 1
**Evidence:** `src/orchestrator.ts:1951-1960` validates and archives every
evaluator attempt against `previousReview`, while
`src/orchestrator.ts:1972-1978` validates the final retry against that same
prior-round review. `previousReview` is updated only after the evaluator
invocation finishes, at `src/orchestrator.ts:2035`. Therefore a round-2
attempt may archive `F-01` as `RESOLVED`, fail with a retryable infrastructure
error, and then return `F-01` as `OPEN`; both attempts validate against round
1's `OPEN` state and the second result is accepted.
**What the contract expected:** "Reject terminal-state reactivation."
**What I observed:** A valid terminal lifecycle record from an earlier
evaluator attempt does not constrain a later attempt in the same round, so
the later attempt can reactivate the finding.

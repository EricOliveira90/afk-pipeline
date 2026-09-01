# QA Report

**Verdict:** FAIL
**Failure class:** IMPLEMENTATION

## Pass 1: Functional Correctness
- Sanity commands: PASS
- UAT verification: NOT IN SCOPE
- Boundary compliance: FAIL
- Preservation check: FAIL

Sanity evidence: `pnpm install --frozen-lockfile` passed locally. The authorized
gate artifact `attempt-64e18bf2ea40.json` records `pnpm run typecheck` and
`pnpm run test` passing on tree `f4eafd15832c82c7480de184db4d7d950f05d8c7`,
which exactly matches `HEAD^{tree}`.

## Pass 2: Quality & Craft
- Convention compliance: NOT RUN
- Code quality: NOT RUN
- Test quality: NOT RUN

## Resolved findings
- none

## Findings
### Finding 1 — Necessary files are absent from the locked scope
**Severity:** Blocker
**Pass:** 1
**Evidence:** `git diff --name-status c67e149...HEAD` shows changes to
`src/status.ts` and `src/artifacts.test.ts`; neither appears under the
contract's `Files expected to change`. The handoff confirms both changes are
required for the status branch projection and byte-identical evidence test.
**What the contract expected:** "Files expected to change" must declare the
necessary implementation and test paths for B-01 and B-02.
**What I observed:** Correct, necessary work exists in two undeclared files.
The remedy is `SCOPE_AMENDMENT` for exactly `src/status.ts` and
`src/artifacts.test.ts`.

### Finding 2 — Dependency holds alter ordinary failure summaries
**Severity:** Blocker
**Pass:** 1
**Evidence:** `src/orchestrator.ts` records dependency holds for every
undispatched slice with unresolved dependencies, regardless of blocker phase;
`src/logger.ts` then emits all holds in a new `Dependency Holds` section.
**What the contract expected:** B-04 requires visible holds for parked
`AWAITING-ADJUDICATION` blockers, while P-03 preserves existing summary
semantics for ordinary failure outcomes.
**What I observed:** Dependents blocked by ordinary `STUCK` or `ERROR` slices
also change `run-summary.md`. The new summary projection must be limited to
adjudication parks, with ordinary failure summaries covered by regression
assertions.

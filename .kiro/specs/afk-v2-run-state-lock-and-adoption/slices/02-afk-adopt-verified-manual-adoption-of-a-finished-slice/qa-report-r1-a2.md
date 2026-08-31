# QA Report

**Verdict:** FAIL
**Failure class:** IMPLEMENTATION

## Pass 1: Functional Correctness
- Sanity commands: PASS
- UAT verification: NOT IN SCOPE
- Boundary compliance: PASS
- Preservation check: FAIL

`pnpm install --frozen-lockfile`, `pnpm run typecheck`, and `pnpm run test` all exited successfully in order. The full suite completed in 641.0 seconds and all suite budgets passed.

## Pass 2: Quality & Craft
- Convention compliance: NOT RUN
- Code quality: NOT RUN
- Test quality: NOT RUN

Pass 2 was not run because Pass 1 is not clean.

## Resolved findings
- QA-04: The locked contract and acceptance manifest now declare `src/slice-lifecycle.ts`; no changed `src/` path remains undeclared.

## Findings
### Finding 1 - QA-01: Missing reason value is parsed as another option
**Severity:** Blocker
**Pass:** 1
**Evidence:** `src/adopt-command.ts:61-63` accepts the token after `--reason` without rejecting another option. The argument tests cover omitted, empty, and whitespace-only values, but not `--reason --adopter QA`.
**What the contract expected:** "Given a missing, empty, or whitespace-only reason ... it is refused, no merge occurs, no adoption record is written, and neither branch nor run state changes."
**What I observed:** `--adopter` becomes the nonblank reason value and execution proceeds beyond argument validation.

### Finding 2 - QA-02: Verified-tip check and feature update are not atomic
**Severity:** Blocker
**Pass:** 1
**Evidence:** `src/adopt-command.ts:251-266` checks both tips and then separately calls `mergeSliceBranch`; the mismatch check at lines 273-278 occurs only after the feature ref may have moved. There is no deterministic competing-update test.
**What the contract expected:** "Only after every gate passes does the feature ref move once" to the verified candidate.
**What I observed:** A competing feature update can be merged into an unverified result before the command detects the tree mismatch and returns failure.

### Finding 3 - QA-03: Ordinary summary rendering changes
**Severity:** Blocker
**Pass:** 1
**Evidence:** `src/logger.ts:299-301` returns an empty adoption section, while line 329 interpolates it on a dedicated line. The logger tests do not compare a no-adoption summary byte-for-byte at this boundary.
**What the contract expected:** "Given a run with no adopted slices ... both output locations retain their current rendering."
**What I observed:** No-adoption summaries gain an additional newline.

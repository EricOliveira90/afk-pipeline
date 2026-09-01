# QA Report

**Verdict:** PASS
**Failure class:** NONE

## Pass 1: Functional Correctness
- Sanity commands: PASS
- UAT verification: NOT IN SCOPE
- Boundary compliance: PASS
- Preservation check: PASS

`pnpm install --frozen-lockfile` passed locally. The authorized gate artifact
`.afk/logs/afk-v2-routing-adjudication-codex/run-20260828-181226/gates/s01/attempt-707fbc380de7.json`
records `pnpm run typecheck` and `pnpm run test` as PASS for tree
`e354af9a0026597033a4d226904758aa7450174c`. The implementation paths at
`HEAD` match that authorized gate tree.

## Pass 2: Quality & Craft
- Convention compliance: PASS
- Code quality: PASS
- Test quality: PASS

## Resolved findings
- QA-01 - The shared heavy orchestration fixture now escalates from repair round 2 and proves the fresh same-round generator retains the original finding, retry artifacts, and complete accepted file scope.
- QA-02 - The malformed fixture now covers malformed and absent-field attempts in one pipeline run and asserts each stamped archive's exact raw bytes plus fail-closed routing.

## Findings
- none

# QA Report

**Verdict:** FAIL
**Failure class:** IMPLEMENTATION

## Pass 1: Functional Correctness
- Sanity commands: PASS
- UAT verification: NOT IN SCOPE
- Boundary compliance: PASS
- Preservation check: FAIL

`pnpm install --frozen-lockfile` passed locally. The authorized gate artifact
`.afk/logs/afk-v2-routing-adjudication-codex/run-20260828-181226/gates/s01/attempt-1e9e21010dc6.json`
records `pnpm run typecheck` and `pnpm run test` as PASS for tree
`a1330c87557078a4c7bc919dc83ba544ae45f404`. The committed tree plus the
seven pipeline-owned contract artifacts in this workspace match that tree.

## Pass 2: Quality & Craft
- Convention compliance: NOT RUN
- Code quality: NOT RUN
- Test quality: NOT RUN

Pass 2 was not run because Pass 1 is not clean.

## Resolved findings
- none

## Findings
### Finding 1 - Fresh generation loses repair and resume finding context
**Severity:** Blocker
**Pass:** 1
**Evidence:** `src/orchestrator.ts:3294-3340` supplies resume findings only to generator attempt 1, then renders the initial generator template and replaces `retryNote` with `scopeRevisionNote`. The note at `src/orchestrator.ts:3390-3395` contains only `fileScope`.
**What the contract expected:** "then resume generation under the revised lock" and "a fresh generator invocation runs with the revised scope"
**What I observed:** After an accepted escalation, the fresh generator receives the widened scope but loses the unresolved finding summaries, clear conditions, artifact references, and resume context needed to perform the cited repair.

### Finding 2 - Malformed escalation archive coverage is incomplete
**Severity:** Major
**Pass:** 1
**Evidence:** `src/orchestrator.test.ts:926-1004` covers one missing-`paths` payload and asserts the working `escalation.md`; it does not assert `reviews/escalation-r1-a1.md`.
**What the contract expected:** "Given malformed and absent-field escalation variants, when the heavy orchestration scenario runs, then it returns `ERROR`, preserves raw evidence, and records no planner, gate, or QA invocation."
**What I observed:** Parser unit tests cover malformed inputs, but the heavy orchestration scenario has one absent-field case and never proves that its raw bytes reached the stamped reviews archive.

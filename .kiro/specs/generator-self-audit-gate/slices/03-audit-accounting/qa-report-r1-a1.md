# QA Report

**Verdict:** FAIL
**Failure class:** IMPLEMENTATION

## Pass 1: Functional Correctness
- Pre-QA commands: PASS
- UAT verification: NOT IN SCOPE
- Boundary compliance: PASS
- Preservation check: PASS

`pnpm install --frozen-lockfile` ran in this worktree and exited 0.
`pnpm run typecheck` is cited from the orchestrator's skip authorization —
gate attempt `768a149c-69e5-4c0f-a20e-26aa1e1eb005`, evidence artifact
`.afk/logs/generator-self-audit-gate-claude-code/run-20260915-171050/gates/s03/attempt-768a149c69e5.json`,
Git tree `ff6f00c70b4d6b012f8a5f8d7e8501f1151d2782`. No file under review was
modified, so the authorization stands (the only working-tree diff is CRLF
warning noise on the contract and manifest, `git diff` empty of content).

Behavior probes (temporary, in this disposable worktree):

- `pnpm vitest run src/self-audit.test.ts src/run-state.test.ts src/logger.test.ts src/eval-boundary.test.ts`
  → 4 files / 161 tests passed, exit 0. Every `[behavior:#301:*]` unit and
  source-order test for B-01 … B-13, P-01 … P-05 is present and green.
- `pnpm vitest run src/orchestrator.test.ts -t "audit"` → 17 passed, exit 0
  (the B-03/B-06/B-08/P-03/P-06 call-site scans and the amended #300 B-09
  residual-candidate scan).
- `pnpm test:fast` → 103 files / 2375 tests passed, exit 0 (one
  `[vitest-worker]: Timeout calling "onTaskUpdate"` reporter error, the
  host-load noise slice 1's handoff already recorded).

Intent, spot-checked against the code rather than the tests: the retry loop
(`src/self-audit.ts:380-393`) dispatches `infrastructureRetries + 1` times at
most, breaks on the first completed invocation and on the first
non-infrastructure cause, and narrates `self-audit: infrastructure retry N/M`
through the existing `log` sink; `auditAttemptBudget` degrades every
non-safe-integer budget to one dispatch; the `AUDIT_NOT_RUN` record omits
`auditedTreeId` and carries `runId`; the spent short-circuit
(`:359-378`) reads `selfAuditsFor` and matches either id field, after both
declines so P-01 keeps returning bare `{ ran: false }`; the hub emits exactly
one `recordSelfAuditOutcomeEvent` under `if (selfAuditOutcome.ran)` between the
stage and the QA dispatch. `logger.agentLog` opens with `flags: "a"`, so a
retry attempt appends to the audit log rather than truncating the dead
attempt's output — the P-06 claim about the log seam holds.

Boundary: the thirteen non-artifact paths in the diff
(`git diff --stat 5992987..HEAD`) are exactly the thirteen the contract
declares; migration count is 0. The defect below is a change that is
*missing*, not an undeclared one.

Preservation: P-01 … P-06 all hold as behavior. In particular the v3/v4/v6/v7
adaptation still loads every other member intact — the two failures below are
stale literal expectations, not lost behavior.

## Pass 2: Quality & Craft
- Convention compliance: NOT RUN
- Code quality: NOT RUN
- Test quality: NOT RUN

Pass 1 is not clean, so Pass 2 was not scored. (No craft problem was noticed
in passing; the classifier, the derivation and the section render all follow
the sibling patterns the contract names.)

## Resolved findings
- none (no findings were routed into this stage)

## Findings

### Finding 1 — The schema bump to v8 leaves two stale `RUN_STATE_VERSION` pins red in the heavy QA suites
**Severity:** Blocker
**Pass:** 1
**Evidence:**

```
pnpm vitest run src/qa-orchestration-gates.test.ts -t "reads a v4 state"
 FAIL  src/qa-orchestration-gates.test.ts > final evaluation and reuse >
   [behavior:P-06] reads a v4 state, keeping the #91 locator and #193 waivers,
   and adds finalEvaluations
 AssertionError: expected 8 to be 7 // Object.is equality
  ❯ src/qa-orchestration-gates.test.ts:1043:28
 Test Files  1 failed (1)

pnpm vitest run src/qa-orchestration.test.ts -t "records checkpoint evidence, authorizes QA for the passing tree"
 FAIL  src/qa-orchestration.test.ts > PRD 070 QA retry behavior >
   [behavior:P-03] [behavior:B-06] records checkpoint evidence, authorizes QA
   for the passing tree, and establishes its approved baseline
 AssertionError: expected 8 to be 7 // Object.is equality
  ❯ src/qa-orchestration.test.ts:1028:27
 Test Files  1 failed (1)
```

Both files sit in `test:heavy:qa`, which `package.json`'s `test:fast` excludes
by name, so the slice's own verification (`test:fast` plus
`test:heavy:orchestrator`, which is what the Definition of done asks for)
could not observe them. `pnpm test` — the pre-ship gate — runs
`test:heavy:qa` and goes red. Slice 1's handoff had already recorded the
hazard: "`RUN_STATE_VERSION` had **four** literal pins, not the three the
contract names", naming these two files among them.

**What the contract expected:** B-06 — "`RUN_STATE_VERSION` (`src/run-state.ts:71`)
becomes `8` … `src/eval-boundary.test.ts:127` pins that literal
(`expect(RUN_STATE_VERSION).toBe(7)`) … the pin is refreshed to `8`" — and the
Definition of done: "`pnpm run typecheck`, `pnpm test:fast` and the heavy suites
this scope touches (`test:heavy:orchestrator`) pass."

**What I observed:** `src/qa-orchestration.test.ts:1028` still reads
`expect(state.version).toBe(7)` and `src/qa-orchestration-gates.test.ts:1043`
still reads `expect(bumped.version).toBe(7)`. The bump is legitimate and
unconditional by design, and the run-state behavior around it is correct and
well covered by the new `[behavior:#301:B-06]` and `[behavior:#301:P-04]`
tests; only these two readers were not refreshed with it. Neither path is one
this slice changed, so the amendment mechanism does not reach them — clearing
this needs the orchestrator to extend the locked file list by those two paths
so the pins can be refreshed the way `src/eval-boundary.test.ts:127` was.

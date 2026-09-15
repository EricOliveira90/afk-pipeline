# QA Report

**Verdict:** PASS
**Failure class:** NONE

## Pass 1: Functional Correctness
- Pre-QA commands: PASS
- UAT verification: NOT IN SCOPE
- Boundary compliance: PASS
- Preservation check: PASS

### Commands

- `pnpm install --frozen-lockfile` — PASS. `Done in 5.1s using pnpm v10.33.0`; the
  `prepare` build (`tsc -p tsconfig.build.json`) ran clean. Only the pre-existing
  `Ignored build scripts: esbuild@0.27.7, esbuild@0.28.0` advisory.
- `pnpm run typecheck` — PASS. `tsc --noEmit` with no diagnostics. Run directly
  rather than cited, though the skip authorization (gate attempt
  `cc9320bb-eeb8-4764-a8bb-5b4a63d3d337`, tree
  `93fdfaf59089253590730bb99ac95ee5b78e2b45`) covered it.

Probes, in this disposable worktree only:

- `pnpm run test:heavy:qa` — `Test Files 2 passed (2)`, `Tests 59 passed (59)`,
  `Duration 169.45s`, `[suite-time] qa-orchestration: 170.4s`,
  `[exited with code 0]`. This is QA-01's clear condition.
- `pnpm vitest run src/self-audit.test.ts src/logger.test.ts src/run-state.test.ts src/eval-boundary.test.ts`
  — `Test Files 4 passed (4)`, `Tests 161 passed (161)`, `Duration 24.37s`. All 11
  `[behavior:#301:*]` stage tests and the `classifySelfAuditFailure` /
  `isInfrastructureSelfAuditCause` suites are in there and green.

### Boundary compliance

`git diff --stat c246e3f~1..HEAD -- . ':(exclude).kiro'` over this slice's own
commits (`c246e3f`..`1420222`) touches exactly fifteen paths, and they are exactly
the fifteen the contract declares:

```
CONTEXT.md                                         |  16 +
docs/adr/0069-...-before-qa-dispatch.md            |  22 +-
src/eval-boundary.test.ts                          |   7 +-
src/logger.test.ts                                 | 314 ++++++++++
src/logger.ts                                      |  97 +++-
src/orchestrator.test.ts                           | 111 +++-
src/orchestrator.ts                                |  25 +
src/qa-orchestration-gates.test.ts                 |   2 +-
src/qa-orchestration.test.ts                       |   2 +-
src/run-events.ts                                  |  61 ++
src/run-journal.ts                                 |   8 +
src/run-state.test.ts                              | 200 ++++++-
src/run-state.ts                                   |  37 +-
src/self-audit.test.ts                             | 643 ++++++++++++++++++++-
src/self-audit.ts                                  | 254 +++++++-
```

No migration file; `Migration requirements: New migration files: 0` holds. No new
dependency, no prompt-template edit, no new fixture, wave or spawned scenario —
every new assertion sits at an existing unit or source-order seam.

### Intent

Each in-scope behavior is observable and matches the contract:

- **B-01/B-02** — `classifySelfAuditFailure` and `isInfrastructureSelfAuditCause`
  are exported pure functions in `src/self-audit.ts`. The transient check goes
  through `isTransientProviderError` (structural, so it survives a duplicate
  module instance); kill signatures are matched dash-agnostically and read
  *before* the exit code, which is the right precedence for a message carrying
  both. `src/self-audit.ts` imports nothing from `./orchestrator.js` — asserted,
  not just true.
- **B-03** — `auditAttemptBudget` narrows to `Number.isSafeInteger(retries) &&
  retries >= 0`, so `-1`, `1.5`, `NaN`, `Infinity`, `"2"` and absent all read as
  `0`; attempts are `retries + 1`. The loop `for (attempt = 1; attempt <
  attemptLimit)` breaks on `invocation.result.completed` first and on a
  non-infrastructure cause second, and narrates
  `self-audit: infrastructure retry N/M — <summary>` through the existing `log`
  sink. Verified: 3 dispatches for `infrastructureRetries: 2` with two dead
  attempts, 1 for each degenerate budget, 1 for a tool-call cap.
- **B-04/B-05** — the recording is now unconditional, with `auditedTreeId` spread
  in only for the two graded verdicts, so an `AUDIT_NOT_RUN` entry has no such
  key at all rather than a blank one. The stage returns
  `{ ran: true, verdict: "AUDIT_NOT_RUN", treeId: <released> }` and never rejects,
  for both an exhausted infrastructure budget and a non-infrastructure cause.
- **B-06** — `PersistedSelfAuditOutcome.runId` is required, `RUN_STATE_VERSION` is
  `8`, the union is `3 | 4 | 5 | 6 | 7 | 8`, `adaptLoadedState` accepts `8`, and
  the `!nonblank(entry.runId)` check *joins* the existing malformed-entry
  condition rather than getting a rule of its own — so the whole-issue-list
  discard granularity the helper's doc comment promises is unchanged. The
  version-history comment is extended in the file's existing style and states the
  unconditional-bump reason.
- **B-07** — the spent lookup runs before the retry loop and after both declines,
  matches either id field, records nothing, emits nothing, and returns
  `{ ran: false, spent: <verdict> }`. The three spent cases and the
  different-tree case are all exercised.
- **B-08** — `self-audit-outcome` is additive with `EVENTS_SCHEMA_VERSION` still
  `1`; `buildSelfAuditOutcomeEvent` omits `auditedTreeId` rather than setting it
  `undefined`; `recordSelfAuditOutcomeEvent` sits beside
  `recordQualityStageAttempt` on `RunJournal`; and the hub emits it once, inside
  `if (selfAuditOutcome.ran)`, between the stage call and the first
  `await runQAStage(`.
- **B-09/B-10/B-11** — one `deriveSelfAuditOutcomes` behind both
  `readSelfAuditOutcomes` and the summary render. `changedRatePercent` is spread
  in only when `graded > 0` (absent, not `0`). The `## Self-Audit` section is the
  empty string unless the run recorded an event, and is appended after
  `qualityStageSection` in the template. `src/gate-runner.ts` contains none of the
  three identifiers and `src/orchestrator.ts` contains no `changedRatePercent`.
- **B-12/B-13** — the ADR's old bound sentence is replaced whole; the amended text
  states the completed-invocation bound, `--infrastructure-retries`,
  `AUDIT_NOT_RUN`, run-ID provenance, spent-on-resume and "report and never gate",
  while `swarm_handoff.sh`, `## Decision`, `## Consequences` and
  `no second challenge` survive. `CONTEXT.md` gains one **Self-audit outcome**
  entry in the file's `**Term**:` / `_Avoid_:` shape defining all three terms and
  citing ADR 0069.

### Preservation

- **P-01** — both declines still return `{ ran: false }` with no `spent` key; the
  spent lookup is inserted after them, so neither decline now reads run state.
- **P-02** — `AUDIT_UNCHANGED`/`AUDIT_CHANGED` tree-id pairs and the pre-return
  recording are unchanged; `verifyAuditedTree`,
  `selectAuditedGateDeclarations` and `resolveGradedCandidate` keep their
  signatures and bodies (only the surrounding comment moved).
- **P-03** — the loop exits on the first completed attempt (verified: one dispatch
  when attempt one completes, even with `infrastructureRetries: 2`);
  `AuditedTreeVerificationInput` still declares no `dispatch`; no
  `logger.bumpEvalRound(` sits between the stage call and the QA dispatch.
- **P-04** — v3/v6/v7 fixtures adapt in memory with `approvedBaselines`,
  `appliedWaivers`, `finalEvaluations`, `qualityStages` and per-slice records
  intact; a no-audit write carries `version: 8` with no `selfAudits` key. All
  three literal pins read `8`, and `pnpm run test:heavy:qa` is green.
- **P-05** — `EVENTS_SCHEMA_VERSION` is still `1`, and because
  `selfAuditSection` is `""` for an audit-free run and is appended after the last
  existing section, the summary is byte-identical. The test asserts the absent
  heading *and* that `## Quality Stages` and `cleaner: enabled` still render.
- **P-06** — the single `runSelfAuditStage(` call site keeps its position between
  `assertGateEvidenceReleasesEvaluation(` / `requiredFailures =
  collectRequiredGateFailures(` and the first `await runQAStage(`, with its
  injected `dispatch` body and `longCommandRoleBounds({` intact. Commit `26c1d55`
  adjusted the existing residual-candidate source scan to account for the new
  event call rather than weakening it: it still asserts two occurrences before the
  audit and the exact set after.

## Pass 2: Quality & Craft
- Convention compliance: PASS
- Code quality: PASS
- Test quality: PASS

Naming, comment density and doc-comment style match the surrounding modules. The
new classifier follows the `classifyReviewFailure` precedent rather than
importing the hub's private one, and says so with a citation. `dispatchAudit`
returning the unwrapped rejection beside its report is the right seam: a message
string would have lost the structural `TransientProviderError` check, and the
code comment states exactly that.

Test honesty: the assertions are behavioral, not mock-shaped. The B-03 degenerate
budget test loops over six values with a per-value label so a failure names the
offender. The B-04 tests assert `"auditedTreeId" in recorded[0]` is `false`
rather than checking for `undefined`, which is the difference between an absent
key and a present-but-empty one. The B-09 test asserts
`"changedRatePercent" in totals` is `false`, and the B-10 n/a test additionally
asserts `not.toContain("0%")` — so an implementation that reported a zero rate for
an ungraded run fails. The B-11 scan bounds each identifier's position to the
derivation or the render region and rejects any `changedRatePercent` comparison
whose right-hand side is not `undefined`, so adding a threshold breaks it.

## Resolved findings
- **QA-01** (BLOCKING, routed from round 1) — RESOLVED. The two stale
  `RUN_STATE_VERSION` pins now read `8`
  (`src/qa-orchestration.test.ts:1028`, `src/qa-orchestration-gates.test.ts:1043`),
  each a one-line change with its surrounding `approvedBaselines`,
  `appliedWaivers` and #91 baseline-locator assertions untouched, and both paths
  are now declared in the contract's `## Files expected to change` and the
  acceptance manifest's `fileScope`. `pnpm run test:heavy:qa` on the candidate
  tree: `Tests 59 passed (59)`, `[exited with code 0]`. No superseded pin of that
  constant remains anywhere in the tree.

## Findings
None.

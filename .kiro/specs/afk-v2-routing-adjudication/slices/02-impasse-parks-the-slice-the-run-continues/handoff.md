# Handoff

## What shipped
- B-01: `src/orchestrator.ts:negotiateAttempt` routes `IMPASSE` to `AWAITING-ADJUDICATION`; `src/run-journal.ts:recordTerminal` projects its branch and reason.
- B-02: `src/artifacts.ts:preserveNegotiationFailure` preserves the version-1 impasse record in the working slice and review archive.
- B-03: `src/wave.ts:runWave` records the parked outcome while DAG-independent siblings continue through existing lane execution.
- B-04: `src/orchestrator.ts:runPipeline` records unresolved dependency holds; `src/logger.ts:recordDependencyHold` limits the summary projection to adjudication blockers, and `src/status-future.ts:buildFutureSection` names the parked blocker and phase.
- B-05: `src/run-journal.ts:markCancelledInFlight` leaves the terminal park untouched while unsettled slices become `CANCELLED`.

## Decisions made during implementation
- `AWAITING-ADJUDICATION` is terminal for the current run, persisted, failure-bucketed, and displays its concrete preserved branch.
- The impasse reason names every contested finding ID.
- Undispatched dependents remain without a persisted slice outcome; the summary records their dependency hold separately.
- A dependency hold enters `run-summary.md` only when at least one unresolved blocker is `AWAITING-ADJUDICATION`; ordinary failure summaries retain their previous shape.

## Gotchas / learnings
- `src/status.ts` was required to expose the parked branch in human `afk status` output, and `src/artifacts.test.ts` was required to verify byte-identical archive evidence; neither path was in the locked file list.
- The required verification command excludes the heavy orchestrator files, so `pnpm run test:heavy:orchestrator` verifies the positive impasse and ordinary `STUCK` summary scenarios together.
- `stuck.md` retains its legacy `Outcome: ESCALATE` line while its structured exhaustion record says `IMPASSE`; the routed lifecycle projections use `AWAITING-ADJUDICATION`.

## Status
Tests passing locally. No regressions.

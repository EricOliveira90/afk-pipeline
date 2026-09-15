# Slice 03 — Audit accounting (#301)

- New migration files: 0

## What shipped

- B-01: `src/self-audit.ts:classifySelfAuditFailure`
- B-02: `src/self-audit.ts:isInfrastructureSelfAuditCause`
- B-03: `src/self-audit.ts:runSelfAuditStage` (retry loop), `src/self-audit.ts:auditAttemptBudget`, `src/orchestrator.ts:runSliceAttempt` (`infrastructureRetries` argument)
- B-04: `src/self-audit.ts:runSelfAuditStage` (unconditional `recordSelfAuditOutcome`)
- B-05: `src/self-audit.ts:runSelfAuditStage`, `src/self-audit.ts:resolveGradedCandidate`
- B-06: `src/run-state.ts:PersistedSelfAuditOutcome`, `src/run-state.ts:RUN_STATE_VERSION`, `src/run-state.ts:sanitizeSelfAudits`, `src/self-audit.ts:SelfAuditStageInput`, `src/orchestrator.ts:runSliceAttempt` (`runId` argument)
- B-07: `src/self-audit.ts:runSelfAuditStage` (spent short-circuit), `src/self-audit.ts:SelfAuditStageResult`
- B-08: `src/run-events.ts:RunEventPayload` (`self-audit-outcome`), `src/run-events.ts:buildSelfAuditOutcomeEvent`, `src/run-journal.ts:RunJournal.recordSelfAuditOutcomeEvent`, `src/orchestrator.ts:runSliceAttempt` (event call site)
- B-09: `src/logger.ts:deriveSelfAuditOutcomes`, `src/logger.ts:readSelfAuditOutcomes`, `src/logger.ts:SelfAuditOutcomeTotals`
- B-10: `src/logger.ts:RunJournal.writeSummary` (`selfAuditSection`)
- B-11: `src/logger.test.ts` (source scan of `src/logger.ts`, `src/orchestrator.ts`, `src/gate-runner.ts`)
- B-12: `docs/adr/0069-bounded-generator-self-audit-before-qa-dispatch.md`
- B-13: `CONTEXT.md` (`### Pipeline concepts` → `**Self-audit outcome**`)
- P-01: `src/self-audit.ts:runSelfAuditStage` (the two declines)
- P-02: `src/self-audit.ts:classifySelfAuditVerdict`, `src/self-audit.ts:verifyAuditedTree`, `src/self-audit.ts:selectAuditedGateDeclarations`, `src/self-audit.ts:resolveGradedCandidate`
- P-03: `src/self-audit.ts:AuditedTreeVerificationInput`, `src/orchestrator.ts:runSliceAttempt` (audit → QA region)
- P-04: `src/run-state.ts:adaptLoadedState`, `src/eval-boundary.test.ts` (pinned `RUN_STATE_VERSION`)
- P-05: `src/logger.ts:RunJournal.writeSummary`, `src/logger.ts:readQualityStageOutcomes`
- P-06: `src/orchestrator.ts:runSliceAttempt` (single `runSelfAuditStage` call site)

## Decisions made during implementation

- The failure taxonomy is a local classifier in `src/self-audit.ts` rather than an
  import of the hub's `classifyNegotiateFailure`, and `SelfAuditKillClass` is a
  local union rather than the hub's unexported `AgentKillClass`. The hub imports
  this module, so either import would be a cycle; `classifyReviewFailure`
  (`src/artifacts.ts:135`) is the same pattern for guardian reviews.
- Kill signatures are matched *before* an exit code is extracted. A killed
  invocation's message can carry both, and the bound that tripped is the more
  specific fact — and the one that decides whether a retry is worth anything.
- The degenerate-budget guard is
  `typeof retries === "number" && Number.isSafeInteger(retries) && retries >= 0`,
  so `-1`, `1.5`, `NaN`, `Infinity`, a non-number and `undefined` all read as
  zero retries. The hub validates its own budget by throwing; this stage cannot,
  because it may never block a run by its own input validation.
- `spent` is an optional member of the existing `{ ran: false }` variant rather
  than a third variant. The two declines keep returning exactly `{ ran: false }`,
  so P-01's shape assertion still holds, and `"spent" in result` is what
  distinguishes the resume short-circuit.
- The spent lookup matches `candidateTreeId` **or** `auditedTreeId`. A run
  resumed after `AUDIT_CHANGED` re-hashes the audited tree as its released tree,
  so the pre-audit id is no longer the id in hand.
- Two ADR 0069 assertions from slices 1 and 2 pinned the literal sentence B-12
  requires replaced. They were rewritten to pin the amended bound
  ("One **completed** invocation per QA submission") instead of the old one; the
  claim they exist to protect — one invocation per QA submission — is what
  survives.

## Gotchas / learnings

- `saveRunState` refuses to replace an existing state file from a whole-file
  snapshot, so a test that resets run state between iterations has to remove
  `.afk/state/<slug>.json` first. Reusing the same temporary root across the
  loop iterations of one test otherwise throws inside the file lock.
- Recording `AUDIT_NOT_RUN` changes what an existing #299 assertion sees: the
  test that asserted a dead dispatch persists nothing now asserts the entry it
  writes. Anything counting run-state entries per issue counts one more per dead
  audit than it did.
- #300's B-09 scan counted `candidateTreeId: checkpoint.treeId,` across the whole
  hub and required every occurrence to precede the audit. The outcome event
  carries that same fragment as the audit's provenance, after the audit, so the
  scan now counts the pre-audit occurrences and pins the one post-audit
  occurrence to the event's own call site. Any later consumer of the pre-audit
  pair still trips it.
- A source scan for "this module does not import the hub's constant" cannot be
  `not.toContain("DEFAULT_INFRASTRUCTURE_RETRIES")` — the stage's own doc comment
  names the expression the hub passes. The scan matches an `import` statement
  carrying the name instead.
- `src/logger.ts` renders the changed rate through a ternary on
  `changedRatePercent`, so B-11 cannot forbid a conditional outright. It asserts
  spans instead — every occurrence lies inside the derivation or the section
  render — plus that the only comparison the rate takes part in is
  `=== undefined`, which is a presence check rather than a threshold.
- The envelope is assembled before the injected `dispatch` is called, so an
  envelope that throws never reaches the dispatch spy. The attempt count for
  that case is observable through the `changeSummary` supplier, which the
  envelope pulls once per attempt.

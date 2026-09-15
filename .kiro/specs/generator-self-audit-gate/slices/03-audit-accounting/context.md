## Files and current behavior

- FACT: The self-audit stage lives entirely in `src/self-audit.ts`. There is no
  separate "generator-audit" module — that name is only the prompt id
  (`prompts/generator-audit.md`).
- FACT: The outcome type is `PersistedSelfAuditVerdict = "AUDIT_UNCHANGED" |
  "AUDIT_CHANGED" | "AUDIT_NOT_RUN"`, defined in `src/run-state.ts:352-355`,
  aliased in `src/self-audit.ts:36` as `SelfAuditVerdict`.
- FACT: `classifySelfAuditVerdict` (`src/self-audit.ts:75-112`) is a pure,
  tree-id-only classifier. It already produces `AUDIT_NOT_RUN` on two branches:
  `!input.invocation.completed` (line 82) and an unresolved `postAuditTreeId`
  (line 92). Both branches classify on the *pre-audit* (released) tree id per
  ADR 0041.
- FACT: `SelfAuditInvocationResult` (`src/self-audit.ts:44-48`) is currently a
  bare `{ completed: boolean; detail?: string }`. Its doc comment (lines 38-43)
  states verbatim that "the failure-cause taxonomy for a dead audit invocation
  is #301's, governed by ADR 0025" — this slice is expected to widen this shape
  (or add a classification step feeding it) to carry an agent-failure-cause
  classification.
- FACT: `dispatchAudit` (`src/self-audit.ts:227-263`) is called exactly once
  from `runSelfAuditStage` (`src/self-audit.ts:171-219`); the comment at lines
  168-169 states "there is no loop here, no retry" — this is the point where a
  retry loop (item: only infrastructure-classified causes retry) would be added.
- FACT: `runSelfAuditStage` calls `recordSelfAuditOutcome`
  (`src/self-audit.ts:208-213`) only for `AUDIT_UNCHANGED`/`AUDIT_CHANGED`. The
  comment at lines 196-203 states verbatim: "`AUDIT_NOT_RUN` stays unrecorded —
  the dead-invocation taxonomy is #301's." This is the exact seam where retry
  exhaustion must record `AUDIT_NOT_RUN`.
- FACT: The changed-tree grading path (slice 2) — `AuditedTreeVerificationInput`,
  `verifyAuditedTree`, `resolveGradedCandidate` (`src/self-audit.ts:292-472`) —
  is unaffected by this slice; its comment at lines 322-325 notes it
  "deliberately [has] no way to dispatch an agent (#300 B-07)."
- FACT: The governing ADR for the whole self-audit stage is
  `docs/adr/0069-bounded-generator-self-audit-before-qa-dispatch.md`. It states
  the audit is "exactly one generator re-dispatch" and that "there is no loop
  in the stage, no retry" for the *audit-of-the-audit* case — this refers to
  never re-auditing an audited tree, not to infrastructure retry of a dead
  invocation, which is this slice's explicit scope per issue #301.
- FACT: `RunState.selfAudits?: Record<string, PersistedSelfAuditOutcome[]>`
  (`src/run-state.ts:348`) already exists (added in slices 1/2).
- FACT: `PersistedSelfAuditOutcome` (`src/run-state.ts:368-374`) is:
  ```
  { candidateTreeId: string; auditedTreeId?: string; verdict: PersistedSelfAuditVerdict }
  ```
  It has no run-ID field today. Issue #301 requires the audit outcome entry to
  carry run-ID provenance, so this shape needs a `runId`-shaped addition.
- FACT: `runIdFor(runDir: string): string` is defined at
  `src/stop-sentinel.ts:106` and is the existing helper used to stamp run-ID
  onto persisted/emitted records elsewhere, e.g. `src/orchestrator.ts:5973`,
  `6020`, `8602` (`runId: runIdFor(logger.runDir)`).
- FACT: `RUN_STATE_VERSION = 7` (`src/run-state.ts:71`); the version-history
  comment above it (lines 50-70) attributes v7 to `selfAudits`. Adding a
  `runId` field to `PersistedSelfAuditOutcome` is a shape change within v7's
  own member, not a new top-level `RunState` field.
- FACT: `sanitizeSelfAudits` (`src/run-state.ts:1036-1082`) validates/normalizes
  persisted `selfAudits` records on load; the allowed-verdict literal array is
  at lines 1043-1046. Any new field (`runId`) or newly-recordable outcome
  (`AUDIT_NOT_RUN`) must be reflected in this sanitizer's shape check
  (~lines 1060-1075).
- FACT: `selfAuditsFor(state, ghIssue)` (`src/run-state.ts:1089-1094`) is the
  reader; `recordSelfAuditOutcome(repoRoot, prdSlug, ghIssue, outcome)`
  (`src/run-state.ts:1101-1114`) is the writer, which appends and stamps
  `state.version = RUN_STATE_VERSION`.
- UNKNOWN: Whether `src/orchestrator.ts` already loads `selfAudits` on resume
  and simply never consults it, or doesn't reference it at all — not directly
  grepped for `selfAuditsFor` usage inside `orchestrator.ts` in this pass.

## Patterns and test harness

- FACT: `NegotiateFailureCause` (`src/orchestrator.ts:1795-1814`) and
  `NegotiateOutcome` (`src/orchestrator.ts:1816-1827`) implement the ADR 0025
  agent-failure-cause taxonomy, with a `kind: NegotiateFailureKind` field.
- FACT: ADR 0025 (`docs/adr/0025-agent-failure-causes.md`) lines 40-46 name
  five kinds: `provider-exit` (retried), `orchestrator-kill` (retried),
  `transient-exhausted` (retried, per ADR 0022), `verdict` (not retried),
  `internal-error` (not retried).
- FACT: `isInfrastructureCause(cause: NegotiateFailureCause): boolean`
  (`src/orchestrator.ts:1841-1844` onward) is the exact infrastructure/not-
  infrastructure gate; it excludes `tool-call-cap` kills even though they are
  an `orchestrator-kill`, per the comment at lines 1835-1839 ("the configured
  bound doing its job, not infrastructure flaking"). This is the shape to
  mirror for classifying a dead audit invocation and deciding whether to
  retry it.
- FACT: `classifyNegotiateFailure` (`src/orchestrator.ts:1924-1929`) dispatches
  to per-situation classifiers at lines 1982, 2009, 2035, 2061, 2086,
  2096 (`reviewArtifactCause`), 2105 (`internalNegotiateCause`).
- FACT: ADR 0025 (lines 55-60) documents retry under `--infrastructure-retries`
  (default 2), reusing the "infrastructure-retry" warn-reason vocabulary shared
  across QA/guardian/negotiation retries.
- FACT: ADR 0022 (`docs/adr/0022-transient-model-unavailability-retry.md`)
  governs a lower retry layer inside a single invocation attempt:
  `withTransientRetry` (`src/transient-retry.ts:52-76`), backed by
  `TransientProviderError`/`isTransientProviderError`
  (`src/agent-provider.ts:1`). `BACKOFF_DELAYS_MS = [30_000, 60_000, 120_000,
  240_000, 480_000]` (`src/transient-retry.ts:37`); default window
  `DEFAULT_TRANSIENT_RETRY_WINDOW_MS = 900_000`
  (`src/transient-retry.ts:30`). The ADR's layer table (lines 72-77) places
  transient retry below the `--infrastructure-retries` layer.
- FACT: Only kiro structurally classifies transient exits today (pattern
  `/temporarily unavailable/i` in `classifyExitError`); claude/codex classify
  nothing yet (ADR 0022 lines 29-32) — relevant if the audit dispatch runs
  under those providers, since infrastructure classification there may be
  weaker.
- FACT: `ResumeFacts.resumeAttempts` (`src/resume.ts:31-46`, counter at line 76,
  `MAX_RESUME_ATTEMPTS = 2` at line 76) is the closest existing "spent
  invocation, don't redo it" precedent for resume — its comment (lines 40-44)
  states the count is derived from the run-state file and "raised at the
  dispatch, so a negotiation or configuration failure leaves it alone."
- FACT: Grep across `src/resume.ts` and `src/exact-stage-resume.ts` for
  `selfAudit|AUDIT_|qualityStage` returned zero matches — resume currently has
  no awareness of self-audit outcomes. The natural integration point is
  guarding the `dispatchAudit` call (`src/self-audit.ts:186`, inside
  `runSelfAuditStage`) with a check against `selfAuditsFor(...)` for an entry
  whose `candidateTreeId` equals the released tree id, analogous to the
  existing short-circuit at `src/self-audit.ts:176-184`
  (`qaBaseGate.candidateTreeId !== releasedTreeId`).
- FACT: The run-summary aggregation/reporting pattern lives in `src/logger.ts`.
  `deriveQualityStageOutcomes(events)` (`src/logger.ts:191-263`) is the single
  source of truth shared by the persisted-events reader
  `readQualityStageOutcomes(runDir)` (lines 271-275) and the printed summary.
- FACT: The summary-table rendering for quality stages is built at
  `src/logger.ts:774-813` (`qualityStageRows`, `qualityStageSection`) and
  inserted into the final markdown at line 867 as one optional section among
  others; absent-data behavior is an empty string (lines 775-776, 796-798) —
  sections are additive, never present-but-empty.
- INFERENCE: A new `deriveSelfAuditOutcomes`-style function paired with a
  `readSelfAuditOutcomes(runDir)` export, plus a new optional markdown section
  (totals per verdict + changed-rate) inserted alongside `qualityStageSection`
  at `src/logger.ts:867`, is the pattern this slice's run-summary requirement
  should follow. Drawn from the `deriveQualityStageOutcomes`/`qualityStageSection`
  precedent above.
- FACT: Grep for `Rate|%\)`-style percentage computations in `src/logger.ts`
  found no existing rate calculation — the changed-rate computation is new to
  this slice.
- FACT: ADR 0063 (`docs/adr/0063-a-wall-clock-budget-cannot-fail-a-gate.md`,
  decision text lines 31-45) states "A budget overage is never a finding
  against a slice... If the timings matter, they are an operator measurement
  on a branch of their own." This is the doctrine issue #301 cites by analogy
  for "the rate reports and never gates."
- FACT: `RunLog.totals: Map<string, SliceTotals>` (`src/logger.ts:284`) and
  `totalsRow` construction (lines 495-535), rendered at line 865, is a second,
  simpler existing precedent for an aggregate "totals" row shape, as an
  alternative to a per-stage table if a single-row totals format fits better.
- FACT: Grep found no dedicated `run-journal.ts`/`run-events.ts` files by that
  name; persisted facts live in `src/run-state.ts` and event recording lives
  in `src/logger.ts` (`RunEvent` union, `readRunEvents`). No existing event
  type named `self-audit-outcome` or similar was found — item 5's run-summary
  accounting likely needs a new event type emitted alongside
  `recordSelfAuditOutcome`, mirroring the existing `quality-stage-attempt`
  event.
- FACT: Tests for the self-audit stage live in `src/self-audit.test.ts`, with
  suites: `runSelfAuditStage` (line 46), `selectAuditedGateDeclarations`
  (line 331), `verifyAuditedTree` (line 397), `resolveGradedCandidate`
  (line 596), `classifySelfAuditVerdict` (line 637),
  `prompts/generator-audit.md` (line 687), and
  `docs/adr/0069-bounded-generator-self-audit-before-qa-dispatch.md`
  (line 734, ADR-prose assertions).
- FACT: The comment at `src/self-audit.test.ts:41-46` and
  `src/self-audit.ts:12-14` states the whole stage is exercised "without a git
  process, a provider or a spawned pipeline" — dispatch, `createCheckpoint`,
  `runGates`, `onCandidateTree` are injected fakes/callbacks. This is a unit-
  level harness, no spawned scenario.
- INFERENCE: Failure-classification and retry additions (this slice's items 1
  and 2) can plausibly stay unit-tested in `src/self-audit.test.ts` the same
  way, by faking `dispatch` to reject/throw with classifiable errors, rather
  than requiring a new spawned scenario — consistent with the repo's stated
  test-cost ordering (unit → existing spawned scenario → new slice in existing
  fixture → new spawn as last resort) and with issue #301's own acceptance
  criterion "no new spawned pipeline scenario."
- FACT: `src/orchestrator.test.ts` has a spawned "summary report" scenario:
  `describe("runPipeline summary report", ...)` at line 3593. `src/logger.test.ts`
  has `readQualityStageOutcomes` tests at lines 1385-1551. Grep found no
  existing self-audit resume/summary tests in either file — this is confirmed
  net-new test surface for the resume and run-summary items.

## Unknowns

- UNKNOWN: Whether adding a `runId` field to `PersistedSelfAuditOutcome`
  should bump `RUN_STATE_VERSION` to 8, or is treated as an additive-within-v7
  shape change (as other nested records under earlier versions, e.g.
  `qualityStages` at v6, have apparently gained fields incrementally without a
  version bump — not directly confirmed in this pass).
- UNKNOWN: Whether `src/orchestrator.ts` already reads `selfAuditsFor` on
  resume paths without using it, versus never referencing it — not directly
  grepped for that call site in this pass; relevant to exactly where the
  "treat persisted audit outcome as spent" check should be wired (inside
  `runSelfAuditStage` versus at an orchestrator call site).
- UNKNOWN: Whether claude/codex agent-provider exit classification (which ADR
  0022 notes classifies nothing structurally today, unlike kiro) is adequate
  for classifying a dead audit invocation's failure cause under ADR 0025, or
  whether this slice needs to extend provider-level classification first.
- UNKNOWN: Exact naming/shape for the new run-summary event type and derived
  reader (e.g. `self-audit-outcome` event, `deriveSelfAuditOutcomes`,
  `readSelfAuditOutcomes`) — no existing name to cite; this slice introduces
  it net-new.

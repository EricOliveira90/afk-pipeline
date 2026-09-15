# Slice Contract — The audit accounts for itself: failure taxonomy, resume, and run-summary totals

**Parent PRD:** .kiro/specs/generator-self-audit-gate/prd.md
**GH issue:** #301
**Status:** LOCKED

**Lock-Provenance:** focused-scope-revision round 4

**Negotiation round:** 1

## Scope lock

A dead audit invocation stops being a silently discarded verdict. The rejection
is classified in `src/self-audit.ts` under ADR 0025's agent-failure-cause kinds;
only an infrastructure-classified cause re-dispatches the audit, bounded by the
run's `--infrastructure-retries` budget, and a non-infrastructure cause or an
exhausted budget records `AUDIT_NOT_RUN` in run state and returns the released
tree so the candidate proceeds to QA exactly as it would have without the audit.
Every persisted outcome now carries `runId` provenance, which moves the run-state
schema to v8, and a resumed run that finds a persisted outcome naming the tree in
hand treats the audit as spent and dispatches nothing. Each landed outcome also
emits one `self-audit-outcome` run event, from which the run summary derives a
per-verdict total and the `AUDIT_CHANGED` rate — reported, never gated
(ADR 0063). ADR 0069 is amended to reconcile its one-invocation bound with
infrastructure retry, and CONTEXT.md gains the three outcome terms. Every
`AUDIT_UNCHANGED`, `AUDIT_CHANGED` and opt-out path keeps today's behavior.

### In scope

- [behavior:B-01] A new exported pure `classifySelfAuditFailure(error: unknown):
  SelfAuditFailureCause` in `src/self-audit.ts` classifies a rejected audit
  invocation under ADR 0025's kinds
  (`docs/adr/0025-agent-failure-causes.md:40-46`):
  `transient-exhausted` when `isTransientProviderError(error)`
  (`src/agent-provider.ts:218`, matched structurally so classification survives
  duplicate module instances), `orchestrator-kill` with a `killClass` of
  `tool-call-cap`, `wall-clock-ceiling`, `idle-timeout` or `unspecified` when the
  message carries a kill signature, `provider-exit` with `exitCode` on an
  `exited with code (\d+)` message, and `internal-error` otherwise — which is
  what an envelope that fails closed as CONFIGURATION
  (`src/self-audit.ts:247-251`) classifies as. The cause carries an
  operator-facing `summary`. It lives in `src/self-audit.ts` rather than importing
  `classifyNegotiateFailure` (`src/orchestrator.ts:1924-1929`), which is private
  to the hub and would be an import cycle; a situation-specific classifier over
  the same dash-agnostic provider messages is the existing pattern —
  `classifyReviewFailure` (`src/artifacts.ts:135`), which the hub's own comment
  (`src/orchestrator.ts:1853-1856`) cites as the same approach. `verdict` and
  `design-decision` are not among the kinds: an audit writes no review artifact
  and makes no design decision.
- [behavior:B-02] A new exported pure `isInfrastructureSelfAuditCause(cause):
  boolean` in `src/self-audit.ts` returns `true` for exactly
  `provider-exit`, `orchestrator-kill` and `transient-exhausted`, and `false` for
  a `tool-call-cap` kill even though it is an `orchestrator-kill`, mirroring
  `isInfrastructureCause` (`src/orchestrator.ts:1841-1848`) and its reason: an
  opted-in cap (ADR 0036) tripping is the configured bound doing its job, not
  infrastructure flaking, and a verbatim retry would re-hit it.
  `internal-error` is not infrastructure.
- [behavior:B-03] `runSelfAuditStage` (`src/self-audit.ts:171-219`) re-dispatches
  a dead invocation while, and only while, its cause is an infrastructure cause
  and the attempt budget is unspent. A new optional
  `infrastructureRetries?: number` on `SelfAuditStageInput` bounds it: attempts
  are `infrastructureRetries + 1`, absent reads as `0` (no retry), and a value
  that is not a non-negative safe integer — negative, fractional, `NaN`,
  `Infinity` or a non-number — reads as `0` rather than throwing, because this
  stage may never block a run by its own failure (ADR 0069 Consequences,
  `docs/adr/0069-bounded-generator-self-audit-before-qa-dispatch.md:73-77`). Each
  such degenerate budget therefore dispatches exactly once and, on a rejected
  dispatch, lands `AUDIT_NOT_RUN` through B-04 rather than rejecting. Each retry
  narrates through the existing `log` sink (`src/self-audit.ts:147`) in the
  shared vocabulary the other retry sites use — `self-audit: infrastructure
  retry N/M — <cause summary>`, cf. `src/orchestrator.ts:5312-5322` — and the
  loop stops on the first completed invocation, so the retry replaces a dead
  invocation and never adds a second completed one (P-03). The single
  `dispatchAudit` call (`src/self-audit.ts:186`) becomes the loop body; the hub
  passes `config.infrastructureRetries ?? DEFAULT_INFRASTRUCTURE_RETRIES` at the
  one call site (`src/orchestrator.ts:6433`, the shape used at `:6288-6289`), so
  the audit honours the same operator budget as ADR 0025's other retries
  (`docs/adr/0025-agent-failure-causes.md:55-60`) without `src/self-audit.ts`
  importing the hub's constant.
- [behavior:B-04] When no attempt completes — a non-infrastructure cause on the
  first attempt, or an exhausted infrastructure budget —
  `runSelfAuditStage` records the `AUDIT_NOT_RUN` outcome through the existing
  `recordSelfAuditOutcome` (`src/run-state.ts:1101-1114`) before it returns, with
  `candidateTreeId` the released tree id, `runId` from B-06, no `auditedTreeId`
  (there is nothing honest to name), and `verdict: "AUDIT_NOT_RUN"`. This
  replaces the `AUDIT_UNCHANGED`/`AUDIT_CHANGED`-only condition and its comment
  at `src/self-audit.ts:196-213`, whose text names this slice as the owner. The
  completed-but-unresolvable-tree branch (`src/self-audit.ts:92-99`) records the
  same way, so every verdict a dispatching stage reaches is persisted.
- [behavior:B-05] After `AUDIT_NOT_RUN` the candidate proceeds to QA on the tree
  its gates released: the stage returns
  `{ ran: true, verdict: "AUDIT_NOT_RUN", treeId: <released tree id> }` and never
  throws, whatever the classified cause; the hub's changed-tree branch
  (`src/orchestrator.ts:6489-6492`) is not entered, and `resolveGradedCandidate`
  (`src/self-audit.ts:461-472`) resolves the pre-audit pair, which is the branch
  that cannot loop (ADR 0041) and the disposition ADR 0069 records at
  `docs/adr/0069-bounded-generator-self-audit-before-qa-dispatch.md:73-77`.
- [behavior:B-06] `PersistedSelfAuditOutcome` (`src/run-state.ts:368-374`) gains
  a required `runId: string`, and `RUN_STATE_VERSION` (`src/run-state.ts:71`)
  becomes `8` with the `version` union (`src/run-state.ts:258`) becoming
  `3 | 4 | 5 | 6 | 7 | 8`, its version-history comment (`:49-66`) extended in the
  same style. The bump is unconditional, for the reason that comment already
  gives for v6 and v7: without it, a v7 file whose entries predate provenance and
  a file whose entries carry it are indistinguishable to every reader.
  `sanitizeSelfAudits` (`src/run-state.ts:1036-1082`) requires `runId` nonblank
  alongside `candidateTreeId`, added to the existing malformed-entry condition at
  `src/run-state.ts:1062-1069`. That condition's granularity is already
  whole-issue-list and stays so: a malformed entry sets `dropped = true` and
  `break`s, and `if (dropped || entries.length === 0) continue;`
  (`src/run-state.ts:1078`) then drops that `ghIssue` key entirely, for the reason
  the helper's own doc comment gives (`src/run-state.ts:1031-1035`: "A malformed
  entry degrades the whole issue's list to absent rather than only itself …
  dropping one entry would understate how many audit invocations a slice has
  already spent"). So a pre-v8 entry needs no adaptation code of its own, and no
  discard granularity changes for the pre-existing `candidateTreeId`,
  `verdict` or `auditedTreeId` checks — the cost is at most one re-dispatched
  audit on a run resumed across the upgrade, which is exactly what the gate is
  allowed to cost. `SelfAuditStageInput` gains a
  required `runId: string`, bound at the hub's one call site to
  `runIdFor(logger.runDir)` (`src/stop-sentinel.ts:106`, the existing stamping
  helper used at `src/orchestrator.ts:5973`), so the stage never derives run
  identity itself.
- [behavior:B-07] A resumed run treats a persisted outcome as spent. Before
  dispatching, `runSelfAuditStage` reads `selfAuditsFor`
  (`src/run-state.ts:1089-1094`) for this `ghIssue` and short-circuits — zero
  dispatches, no new run-state entry, no event — when any entry names the
  released tree id in either `candidateTreeId` or `auditedTreeId`. Both fields
  are matched because a run resumed after an `AUDIT_CHANGED` re-hashes the
  audited tree as its released tree, so the pre-audit id is no longer the id in
  hand. It returns `{ ran: false, spent: <that entry's verdict> }` — a widened
  `{ ran: false }` variant, so the hub's `ran &&` narrowing
  (`src/orchestrator.ts:6489-6492`) keeps the pre-audit pair as the graded
  candidate for a tree that already cleared its gates — and narrates the spent
  verdict through `log`. Shaped after the existing short-circuit at
  `src/self-audit.ts:176-184`, and the resume precedent
  `ResumeFacts.resumeAttempts` (`src/resume.ts:31-46`): the count of spent
  invocations is derived from the run-state file, never re-derived from the tree.
- [behavior:B-08] A new additive `self-audit-outcome` member of `RunEventPayload`
  in `src/run-events.ts` carries `ghIssue`, `sliceNumber`, `round`, `runId`,
  `candidateTreeId`, optional `auditedTreeId` and `verdict`, with
  `EVENTS_SCHEMA_VERSION` staying `1` (`src/run-events.ts:27`) the way
  `quality-stage-attempt` arrived (`:437-461`); a pure
  `buildSelfAuditOutcomeEvent` builds the payload, omitting `auditedTreeId`
  rather than setting it to `undefined`, modelled on
  `buildQualityStageAttemptEvent` (`src/run-events.ts:614-649`); and
  `recordSelfAuditOutcomeEvent` on `RunJournal` (`src/run-journal.ts:117-121`,
  beside `recordQualityStageAttempt`) emits it. It is emitted at the one hub call
  site immediately after `runSelfAuditStage` returns, for every `ran: true`
  result and for no other — a declined or spent result emits nothing, so a total
  counts audits, not stage entries.
- [behavior:B-09] A new `deriveSelfAuditOutcomes(events)` in `src/logger.ts`,
  exposed by a new exported `readSelfAuditOutcomes(runDir)`, is the one
  derivation behind both the file reader and the summary, modelled on
  `deriveQualityStageOutcomes`/`readQualityStageOutcomes`
  (`src/logger.ts:191-275`) and returning `[]`-equivalent zero totals for a run
  directory with no events, no `self-audit-outcome` event or no `events.jsonl` at
  all rather than throwing. It returns per-verdict counts (`unchanged`,
  `changed`, `notRun`), `graded` = `unchanged + changed`, and
  `changedRatePercent` = `Math.round((changed / graded) * 100)`, absent when
  `graded` is `0`. `AUDIT_NOT_RUN` is counted and reported but excluded from the
  rate's denominator: the rate answers "is the audit earning its call", which an
  invocation that never ran cannot dilute (ADR 0069 Consequences, `:69-72`).
- [behavior:B-10] The run summary gains one optional `## Self-Audit` section,
  built beside `qualityStageSection` and inserted in the summary template at
  `src/logger.ts:867`: an `| Outcome | Count |` table listing all three outcome
  terms and a `Changed rate: N% (C of G graded audits)` line, or
  `Changed rate: n/a` when `graded` is `0`. Rendered only when the run recorded
  at least one `self-audit-outcome` event and the empty string otherwise, so
  sections stay additive and never present-but-empty (`src/logger.ts:774-813`).
- [behavior:B-11] The totals and the rate report and never gate (ADR 0063,
  `docs/adr/0063-a-wall-clock-budget-cannot-fail-a-gate.md:31-45`): no gate id,
  gate declaration, threshold, merge decision or dispatch decision keys on any
  value B-09 derives. `readSelfAuditOutcomes` and `deriveSelfAuditOutcomes` are
  consumed only by the summary render, the `changedRatePercent` value is compared
  against nothing, and no `self-audit-outcome` field reaches `src/gate-runner.ts`
  or a `GateDeclaration`.
- [behavior:B-12] `docs/adr/0069-bounded-generator-self-audit-before-qa-dispatch.md`
  is amended in place — the accepted decision, the SwarmForge provenance and the
  structural verdict keep their present text — so that the one sentence at
  `:52-53` ("One invocation per QA submission, bounded by construction: there is
  no loop in the stage, no retry, and no second challenge for a tree the audit
  rewrote.") is replaced, verbatim-in-full, by wording that states the bound it
  actually means and keeps the phrase `no second challenge`: the
  bound counts *completed* invocations, one per QA submission, and a dead
  invocation classified as infrastructure is re-dispatched under the run's
  `--infrastructure-retries` budget, with exhaustion recording `AUDIT_NOT_RUN`.
  The amendment also states the run-ID provenance on the persisted outcome, that
  a persisted outcome for the tree in hand is spent on resume, and that the
  per-verdict totals and the changed rate report and never gate. Amended rather
  than overridden because the parent specification requires the retry — PRD
  Implementation Decisions ("It runs under the existing agent-failure-cause
  taxonomy (ADR 0025); only infrastructure causes retry, and exhaustion lands
  `AUDIT_NOT_RUN`", `prd.md:95-97`) and issue #301's acceptance criteria — so the
  ADR's no-retry phrasing is a statement about the audit-of-the-audit that this
  slice makes precise, not a decision this slice reverses.
- [behavior:B-13] `CONTEXT.md` gains one `### Pipeline concepts`
  (`CONTEXT.md:217`) entry, in the file's existing `**Term**:` / `_Avoid_:`
  shape, defining `AUDIT_UNCHANGED` (the audited tree is identical to the
  candidate the cheap gates released), `AUDIT_CHANGED` (the audited tree differs
  and is re-gated before QA) and `AUDIT_NOT_RUN` (the invocation could not
  complete; the candidate proceeds to QA on the released tree), citing ADR 0069.

### Non-goals (explicit out-of-scope)

- Extending provider-level exit classification. `src/claude.ts`, `src/codex.ts`,
  `src/kiro.ts` and `src/transient-retry.ts` are untouched: only kiro classifies
  transient exits structurally today (ADR 0022), and under the other providers a
  transient death simply classifies as `provider-exit` — still an infrastructure
  cause, so it still retries. Recorded here rather than escalated: nothing else
  builds on it and the classifier is a pure function this slice can revise.
- Audit outcomes in `afk status`, the draft PR body or any babysitter surface
  (PRD story 14). This slice's reporting obligation is the run summary.
- A typed `warn` run event for an audit infrastructure retry, and any new
  `warn` reason. The retry narrates through the stage's existing `log` sink;
  `self-audit-outcome` is the only new event.
- Any change to the `AUDIT_UNCHANGED` or `AUDIT_CHANGED` verdicts, to
  `classifySelfAuditVerdict`'s tree-id-only inputs, or to slice 2's changed-tree
  grading path (`verifyAuditedTree`, `selectAuditedGateDeclarations`,
  `resolveGradedCandidate`).
- Making `--self-audit` default on, retiring the prompt-prose self-audit section,
  a second audit challenge, and any gate, merge or dispatch decision keyed on the
  audit rate (PRD Out of Scope).
- A new spawned pipeline scenario, fixture or wave; a new gate id or gate
  declaration; a new prompt template or any edit to `prompts/generator-audit.md`;
  a new dependency; a migration.

### Existing behavior to preserve

- [behavior:P-01] The opt-out path costs a run nothing: with `--self-audit`
  absent the stage still returns `{ ran: false }` at `src/self-audit.ts:174` with
  zero dispatches, no run-state write, no `self-audit-outcome` event and no
  `## Self-Audit` section in the summary, and the base-gate/checkpoint
  disagreement decline (`src/self-audit.ts:176-184`) still returns
  `{ ran: false }` the same way.
- [behavior:P-02] The two graded verdicts keep today's behavior:
  `AUDIT_UNCHANGED` still records exactly one entry whose `candidateTreeId` and
  `auditedTreeId` are both the released tree id and returns
  `{ ran: true, verdict: "AUDIT_UNCHANGED", treeId: <released> }`, and
  `AUDIT_CHANGED` still records one entry whose two ids differ and still enters
  the hub's changed-tree re-run — `verifyAuditedTree`,
  `selectAuditedGateDeclarations` and `resolveGradedCandidate`
  (`src/self-audit.ts:374-472`) keep their present signatures and bodies, and
  recording still happens before the stage returns, ahead of whatever the gate
  re-run concludes.
- [behavior:P-03] The one-invocation bound holds: a *completed* invocation is
  never re-dispatched (the retry loop exits on the first completed attempt), a
  tree the audit rewrote receives no second challenge —
  `AuditedTreeVerificationInput` still declares no `dispatch` and
  `verifyAuditedTree`'s body still contains no `runSelfAuditStage(` or
  `dispatch(` call — and neither `round` nor `logger.bumpEvalRound` is advanced
  between the `runSelfAuditStage(` call site and the first `await runQAStage(`,
  so neither the audit nor its retries spend a generator round.
- [behavior:P-04] Every older run-state file still loads: `adaptLoadedState`
  (`src/run-state.ts:1146`) still normalizes a v3, v4, v5, v6 or v7 file in
  memory with every other member intact — `approvedBaselines`, `appliedWaivers`,
  `finalEvaluations`, `qualityStages` and per-slice records unchanged — and a run
  that dispatches no audit still persists version `8` with no `selfAudits`
  member, because "no audit ran" and "this file predates audits" are the same
  fact to every reader.
- [behavior:P-05] `EVENTS_SCHEMA_VERSION` stays `1`, and a run that recorded no
  `self-audit-outcome` event renders a byte-identical summary: the new section is
  the empty string, the existing `dependencySection`, `adoptionSection`,
  `gateSection`, `finalReuseSection` and `qualityStageSection` keep their present
  text and order, and `readQualityStageOutcomes` keeps its present behavior and
  signature.
- [behavior:P-06] The `runSelfAuditStage(` call site keeps its single occurrence
  and its position — after `assertGateEvidenceReleasesEvaluation(`, after the
  `requiredFailures = collectRequiredGateFailures(` assignment and before the
  first `await runQAStage(` — which is what the existing source-order scan at
  `src/orchestrator.test.ts:8262-8289` asserts, and its injected `dispatch`
  (`src/orchestrator.ts:6455-6476`) keeps its present body and per-invocation
  bounds (ADR 0002, ADR 0007), including opening the audit log inside the
  callback so a declined audit leaves no empty log behind — which is also what
  makes each retry attempt log under the same seam.

### Changes to existing behavior (only if the issue asks for it)

- `runSelfAuditStage` now writes a run-state entry on `AUDIT_NOT_RUN` as well as
  the two graded verdicts, authorized by issue #301 AC3 ("Audit retry exhaustion
  records `AUDIT_NOT_RUN` in run state") and by slice 2's contract, which named
  this recording as #301's.
- `RUN_STATE_VERSION` moves from `7` to `8` and `PersistedSelfAuditOutcome` gains
  `runId`, authorized by issue #301 AC5 ("The audit outcome entry in run state
  carries run-ID provenance") and the PRD's settled decision that outcome records
  join run state with run-ID provenance. `src/eval-boundary.test.ts:127` pins
  that literal (`expect(RUN_STATE_VERSION).toBe(7)`) to assert the eval slice
  moved no schema; the pin is refreshed to `8` and its sibling
  `EVENTS_SCHEMA_VERSION` assertion is left alone, which is why that file is in
  this slice's scope. Two further stale literal readers of the same constant are
  refreshed the same way and for the same reason:
  `src/qa-orchestration.test.ts:1028` (`expect(state.version).toBe(7)`) and
  `src/qa-orchestration-gates.test.ts:1043`
  (`expect(bumped.version).toBe(7)`) each assert the version a loaded state
  carries, so B-06's unconditional bump and P-04's in-memory adaptation to the
  current version make both read `8`. Refreshing the two literals to `8` is the
  whole change to those files: the surrounding assertions on
  `approvedBaselines`, `appliedWaivers` and the #91 baseline locator, and the
  comment above the first pin, keep their present text, so neither test loses
  behavior — each still asserts that loading an older file yields the current
  version with every other member intact, which is exactly P-04. Recorded here
  rather than escalated: it is the mechanical consequence of a bump the parent
  specification already settled, reversible before merge, and no interface or
  data format turns on it.
- A dead audit invocation is re-dispatched when its cause is infrastructure,
  where today `dispatchAudit` runs exactly once, authorized by issue #301 AC2 and
  the PRD's Implementation Decisions; ADR 0069 is amended in the same slice
  (B-12) so no recorded decision is left contradicted.

## Files expected to change

- src/self-audit.ts
- src/self-audit.test.ts
- src/run-state.ts
- src/run-state.test.ts
- src/run-events.ts
- src/run-journal.ts
- src/logger.ts
- src/logger.test.ts
- src/orchestrator.ts
- src/orchestrator.test.ts
- src/eval-boundary.test.ts
- src/qa-orchestration.test.ts
- src/qa-orchestration-gates.test.ts
- docs/adr/0069-bounded-generator-self-audit-before-qa-dispatch.md
- CONTEXT.md

## Migration requirements

- New migration files: 0

## New patterns / deps / schema (if any)

- Run-state schema v8: `PersistedSelfAuditOutcome.runId` (required), the
  unconditional `RUN_STATE_VERSION` bump and the widened `version` union. No new
  top-level member, no migration file, no dependency.
- One additive run event, `self-audit-outcome`, with `EVENTS_SCHEMA_VERSION`
  unchanged at `1`. Otherwise existing patterns: the situation-specific failure
  classifier (`classifyReviewFailure`), the `infrastructureRetries` attempt
  budget, the `derive*`/`read*` outcome pair and the optional summary section.

## Test plan

- Given rejections carrying a `TransientProviderError`, an `exceeded 12 tool
  calls` kill, a `wall-clock ceiling` kill, an `idle for 600s - killed` message,
  an `exited with code 1` message and a plain `Error("boom")`, when
  `classifySelfAuditFailure` runs, then the kinds are `transient-exhausted`,
  `orchestrator-kill` with `killClass: "tool-call-cap"`, `orchestrator-kill` with
  `killClass: "wall-clock-ceiling"`, `orchestrator-kill` with
  `killClass: "idle-timeout"`, `provider-exit` with `exitCode: 1` and
  `internal-error`, each with a non-blank `summary`. (B-01)
- Given each classified cause, when `isInfrastructureSelfAuditCause` runs, then
  `provider-exit`, `orchestrator-kill` (non-cap) and `transient-exhausted` are
  `true`, and a `tool-call-cap` kill and `internal-error` are `false`. (B-02)
- Given a stage with `infrastructureRetries: 2` and a dispatch that rejects with
  `Error("Agent generator exited with code 1")` twice and then succeeds leaving
  the tree unchanged, when `runSelfAuditStage` is awaited, then the dispatch spy
  recorded exactly three calls, the `log` sink received two
  `self-audit: infrastructure retry` lines naming `1/2` and `2/2`, and the result
  is `{ ran: true, verdict: "AUDIT_UNCHANGED" }` with exactly one run-state
  entry. (B-03)
- Given a stage input omitting `infrastructureRetries` entirely, and separately
  ones carrying `-1`, `1.5` and `Number.NaN`, each with a dispatch that always
  rejects with `exited with code 1`, when `runSelfAuditStage` is awaited, then no
  call rejects, the dispatch spy recorded exactly one call in each case, no
  `self-audit: infrastructure retry` line was narrated, and each result is
  `{ ran: true, verdict: "AUDIT_NOT_RUN", treeId: <released tree id> }`. (B-03)
- Given a stage with `infrastructureRetries: 2` and a dispatch that rejects with
  a `tool-call-cap` kill message, and separately one whose envelope assembly
  fails (`internal-error`), when `runSelfAuditStage` is awaited, then the
  dispatch was attempted at most once in each case and no retry line was
  narrated. (B-03, B-02)
- Given a stage with `infrastructureRetries: 1` whose dispatch always rejects
  with `exited with code 1`, when `runSelfAuditStage` is awaited, then the
  dispatch spy recorded exactly two calls and
  `selfAuditsFor(loadRunState(...), ghIssue)` holds exactly one entry with
  `verdict: "AUDIT_NOT_RUN"`, `candidateTreeId` the released id, `runId` the
  stage input's `runId`, and no `auditedTreeId` key. (B-04, B-06)
- Given a stage whose dispatch completes but whose post-audit tree cannot be
  resolved, when `runSelfAuditStage` is awaited, then one `AUDIT_NOT_RUN` entry
  with no `auditedTreeId` is persisted and the dispatch spy recorded exactly one
  call. (B-04)
- Given a stage whose dispatch always rejects and separately one whose dispatch
  rejects with a non-infrastructure cause, when `runSelfAuditStage` is awaited,
  then neither call rejects and both results are
  `{ ran: true, verdict: "AUDIT_NOT_RUN", treeId: <released tree id> }`; and
  given that result value, when `resolveGradedCandidate` is called with no
  `audited`, then it returns the released `treeId`, `commitSha` and base-gate
  object by reference. (B-05)
- Given a v8 run-state file with a `selfAudits` entry carrying `runId`, and
  separately a v7-shaped file whose entry omits `runId` or carries a blank one,
  when the state is loaded, then `RUN_STATE_VERSION` is `8`, the `version` union
  accepts `8`, the v8 entry loads with its `runId` intact, and the entry without
  a usable `runId` yields no `selfAudits` member for that issue. (B-06)
- Given a run-state file holding one `AUDIT_UNCHANGED` entry whose two tree ids
  are the released id, and separately one `AUDIT_CHANGED` entry whose
  `auditedTreeId` is the released id and whose `candidateTreeId` is not, and
  separately one `AUDIT_NOT_RUN` entry naming the released id, when
  `runSelfAuditStage` is awaited on that released tree, then each result is
  `{ ran: false, spent: <that entry's verdict> }`, the dispatch spy recorded zero
  calls, and the issue's persisted list still holds exactly one entry. (B-07)
- Given a run-state file whose only entry names a different tree in both id
  fields, when `runSelfAuditStage` is awaited, then the audit is dispatched
  exactly once and a second entry is appended. (B-07)
- Given a payload with and without `auditedTreeId`, when
  `buildSelfAuditOutcomeEvent` runs, then the event is
  `{ type: "self-audit-outcome", ghIssue, sliceNumber, round, runId,
  candidateTreeId, verdict }` with `auditedTreeId` present only in the first case
  and absent as a key in the second, and `EVENTS_SCHEMA_VERSION` is still `1`;
  and given a journal in a temporary run directory, when
  `recordSelfAuditOutcomeEvent` is called, then `events.jsonl` holds exactly one
  `self-audit-outcome` line carrying those fields. (B-08)
- Given `src/orchestrator.ts` read as text, when the region between the
  `runSelfAuditStage(` occurrence and the first `await runQAStage(` is scanned,
  then it contains exactly one `recordSelfAuditOutcomeEvent(` call, guarded by
  the stage result's `ran` narrowing, passing `runId: runIdFor(logger.runDir)`,
  `sliceNumber: slice.number` and `round`, and the same
  `infrastructureRetries: config.infrastructureRetries ??
  DEFAULT_INFRASTRUCTURE_RETRIES` and `runId: runIdFor(logger.runDir)` arguments
  appear inside the `runSelfAuditStage({` … `});` call. (B-08, B-03, B-06)
- Given an event stream with three `AUDIT_UNCHANGED`, one `AUDIT_CHANGED` and two
  `AUDIT_NOT_RUN` events, when `deriveSelfAuditOutcomes` runs, then it returns
  `{ unchanged: 3, changed: 1, notRun: 2, graded: 4, changedRatePercent: 25 }`;
  given a stream with only `AUDIT_NOT_RUN` events, then `graded` is `0` and
  `changedRatePercent` is absent; and given a run directory with no
  `events.jsonl`, when `readSelfAuditOutcomes` runs, then it returns zero totals
  without throwing. (B-09)
- Given a run whose journal recorded those six events, when the summary is
  written, then `run-summary.md` contains a `## Self-Audit` section with an
  `| Outcome | Count |` table naming `AUDIT_UNCHANGED`, `AUDIT_CHANGED` and
  `AUDIT_NOT_RUN` with counts `3`, `1`, `2` and the line
  `Changed rate: 25% (1 of 4 graded audits)`; and given a run with only
  `AUDIT_NOT_RUN` events, then the section renders with `Changed rate: n/a`.
  (B-10)
- Given `src/logger.ts`, `src/orchestrator.ts` and `src/gate-runner.ts` read as
  text, when `readSelfAuditOutcomes(`, `deriveSelfAuditOutcomes(` and
  `changedRatePercent` are scanned, then no occurrence sits inside an `if`,
  ternary, comparison or `GateDeclaration` literal outside the summary render,
  `src/gate-runner.ts` contains none of them, and no gate id string mentioning
  audit rate exists. (B-11)
- Given `docs/adr/0069-bounded-generator-self-audit-before-qa-dispatch.md` read
  as text, then it states that the one-invocation bound counts completed
  invocations and that an infrastructure-classified dead invocation is retried
  under `--infrastructure-retries` with exhaustion recording `AUDIT_NOT_RUN`, the
  run-ID provenance, the spent-on-resume rule and that the totals and rate never
  gate; and, with the text whitespace-normalized, the exact present sentence at
  `:52-53` — `One invocation per QA submission, bounded by construction: there is
  no loop in the stage, no retry, and no second challenge for a tree the audit
  rewrote.` — no longer appears, while `swarm_handoff.sh`, `## Decision`,
  `## Consequences` and `no second challenge` all still do. (B-12)
- Given `CONTEXT.md` read as text, then a single `### Pipeline concepts` entry
  defines `AUDIT_UNCHANGED`, `AUDIT_CHANGED` and `AUDIT_NOT_RUN`, carries an
  `_Avoid_:` line, and cites ADR 0069. (B-13)
- Given a stage input with `selfAudit` not true, and separately one whose
  `qaBaseGate.candidateTreeId` differs from the checkpoint's tree id, when
  `runSelfAuditStage` is awaited, then both return `{ ran: false }` with no
  `spent` member, zero dispatches, no run-state entry and no event; and given a
  run with no `self-audit-outcome` event, when the summary is written, then it
  contains no `## Self-Audit` heading. (P-01, P-05)
- Given a dispatch that leaves the tree identical, and separately one that
  rewrites it, when `runSelfAuditStage` is awaited, then the verdicts are
  `AUDIT_UNCHANGED` with both persisted tree ids equal and `AUDIT_CHANGED` with
  them differing, one dispatch each; and `verifyAuditedTree` and
  `selectAuditedGateDeclarations` still behave as slice 2's existing suites
  assert. (P-02)
- Given a stage whose dispatch completes on its first attempt with
  `infrastructureRetries: 2`, when `runSelfAuditStage` is awaited, then the
  dispatch spy recorded exactly one call; and given `src/self-audit.ts` read as
  text, then `AuditedTreeVerificationInput` declares no `dispatch` member and
  `verifyAuditedTree`'s body contains no `runSelfAuditStage(` or `dispatch(`
  call; and given `src/orchestrator.ts` read as text, then no
  `logger.bumpEvalRound(` occurrence sits between `runSelfAuditStage(` and the
  first `await runQAStage(`. (P-03)
- Given v3, v6 and v7 run-state fixtures, when they are loaded, then each adapts
  in memory with every other member intact, and a written state with no audit
  carries `version: 8` and no `selfAudits` member; and given the three existing
  pinned readers of the constant — `src/eval-boundary.test.ts:127`,
  `src/qa-orchestration.test.ts:1028` and
  `src/qa-orchestration-gates.test.ts:1043` — when their suites run, then each
  asserts `8` with its surrounding assertions (`approvedBaselines`,
  `appliedWaivers`, the #91 baseline locator, `EVENTS_SCHEMA_VERSION` still `1`)
  unchanged, so `pnpm run test:heavy:qa` is green with no superseded
  `RUN_STATE_VERSION` pin left in the tree. (P-04)
- Given `src/orchestrator.ts` read as text, when `runSelfAuditStage(` is counted,
  then it occurs exactly once, after `assertGateEvidenceReleasesEvaluation(` and
  after `requiredFailures = collectRequiredGateFailures(` and before the first
  `await runQAStage(` — the existing scan at
  `src/orchestrator.test.ts:8262-8289` still passing unchanged. (P-06)

## Definition of done

- [ ] A dead audit invocation is classified into one of ADR 0025's kinds by a
      pure function in `src/self-audit.ts`, with no import from
      `src/orchestrator.ts`.
- [ ] Only `provider-exit`, non-cap `orchestrator-kill` and
      `transient-exhausted` causes retry; a `tool-call-cap` kill and an
      `internal-error` do not.
- [ ] The retry is bounded by the stage's `infrastructureRetries` input, the hub
      passes the run's configured budget, and the loop stops on the first
      completed invocation.
- [ ] An exhausted budget or a non-infrastructure cause records one
      `AUDIT_NOT_RUN` entry with `runId`, the released `candidateTreeId` and no
      `auditedTreeId`.
- [ ] `AUDIT_NOT_RUN` returns the released tree, never throws, and leaves the
      graded candidate the pre-audit pair, so the candidate proceeds to QA.
- [ ] `PersistedSelfAuditOutcome` carries a required `runId`,
      `RUN_STATE_VERSION` is `8`, the `version` union accepts `8`, and older
      files still load with every other member intact.
- [ ] A persisted outcome naming the released tree in either id field is spent:
      zero dispatches, no second entry, no second event.
- [ ] One `self-audit-outcome` event per landed outcome, built by a pure builder,
      emitted through `RunJournal` at the one hub call site, with
      `EVENTS_SCHEMA_VERSION` still `1`.
- [ ] `readSelfAuditOutcomes` and the summary read one derivation returning
      per-verdict totals and the changed rate over the graded outcomes.
- [ ] The summary renders a `## Self-Audit` section when and only when the run
      recorded an audit outcome, and every other section keeps its present text
      and order.
- [ ] Nothing gates, thresholds or branches on the totals or the rate.
- [ ] ADR 0069 is amended in place so its bound and this slice's retry agree, and
      CONTEXT.md defines the three outcome terms.
- [ ] Every new test's name contains the behavior id it asserts, and every
      assertion lives at an existing unit or source-order seam — no new spawned
      pipeline scenario, fixture or wave.
- [ ] Every stale literal reader of `RUN_STATE_VERSION` reads `8` — in
      `src/eval-boundary.test.ts`, `src/qa-orchestration.test.ts` and
      `src/qa-orchestration-gates.test.ts` — with no other assertion in those
      files changed.
- [ ] Only the fifteen paths in `## Files expected to change` are edited;
      migration count is 0.
- [ ] `pnpm run typecheck`, `pnpm test:fast` and the heavy suites this scope
      touches (`test:heavy:orchestrator`, `test:heavy:qa`) pass.

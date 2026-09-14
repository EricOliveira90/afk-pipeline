# Slice Contract — Changed trees face final evaluation; ROI evidence

**Parent PRD:** .kiro/specs/afk-v2-quality-loops/prd.md
**GH issue:** #97
**Status:** LOCKED

**Lock-Provenance:** negotiation round 2
**Negotiation round:** 2

## Scope lock

A cleaner commit now has to answer to the final evaluator, and the stage
reports what it cost. Today `runCleanerStage` (`src/cleaner-stage.ts:423`) can
commit rounds onto the accepted tree and the final-evaluation loop still routes
every `RESTORE` to the no-op stub (`routeFinalReviewFinding`,
`src/final-evaluation.ts:438-455`; the one call site,
`src/orchestrator.ts:7701-7703, 7772-7776`), so a real writer's damage is asked
of a stage that writes nothing. This slice: (1) routes a `RESTORE` to the stage
that actually wrote, re-dispatching the cleaner with the findings under its
remaining round budget, and reverting the cleaner's whole range when no round is
left — after which the tree equals the accepted tree and `decideFinalReuse`
reuses (PRD D12); (2) adds the `quality-stage-attempt` event family (PRD D11),
emitted once per cleaner round and once per final-evaluation attempt with start,
end, duration, trees, gate ids, outcome and cache-reused gate ids; (3) renders
that evidence as per-slice rows under #274's `## Quality Stages` header and as a
draft-PR section via a new `readQualityStageOutcomes(runDir)` (PRD D10 items 2–3).
`decideFinalReuse` itself is untouched: a cleaner checkpoint changes
`finalTreeId`, so exact string inequality already answers `evaluate` (PRD D12,
ADR-level rule D20 recorded in the function's own header,
`src/final-evaluation.ts:16-19`).

**Ordering, recorded decision.** The two halves land in this order and are
built in one session: the restore re-dispatch and revert path (B-01–B-05, B-12)
first, because it is what #97 AC1 asks for and what the merge behavior depends
on; then the ROI evidence family (B-06–B-11, B-13). The halves share exactly one
seam — the cleaner round's own evidence, from which both the
`quality-stage-attempt` emission (B-07) and nothing else is derived — so the ROI
half is independently shippable: a tree carrying B-01–B-05 and B-12 alone is
green, and a tree carrying B-06–B-11 and B-13 alone is green. If the session
runs short, the ROI half is the separable one; it is not split out here because
the split would double the fixture cost (S1 and S3 both extend the one
`finalEvaluationFixture`).

### In scope

- [behavior:B-01] `routeFinalReviewFinding` (`src/final-evaluation.ts:438-455`)
  takes `context: { candidateTreeId: string; writingStageIds: readonly string[] }`
  and a `RESTORE` route returns `stageId` = the **last** id in
  `writingStageIds`. The rule is well-defined only against the list contract
  B-02 satisfies, and this contract is stated on the parameter itself:
  `writingStageIds` holds **only the stages that actually changed the tree, in
  the order they ran**, so the last id is the stage that wrote most recently.
  A stage that ran and left the tree byte-identical contributes no id — which is
  why production's `noopPostApprovalWritingStage` (`src/final-evaluation.ts:67`)
  never appears in the list, and why a committed cleaner's id is last even
  though the cleaner runs *first* (`:42-48`). An empty `writingStageIds` returns
  `POST_APPROVAL_WRITING_STAGE_ID`, which is the pre-slice behavior, so no caller
  loses a route by not knowing about a cleaner (PRD D12; the `FinalReviewRoute`
  shape at `:429-436` is otherwise unchanged).
- [behavior:B-02] The one call site (`src/orchestrator.ts:7701-7703`) builds
  `writingStageIds` by appending, in run order, one id per stage that changed the
  tree it was handed:
  `CLEANER_STAGE_ID` when `cleaner.ran && cleaner.outputTreeId !==
  cleaner.inputTreeId` (the cleaner committed), then
  `POST_APPROVAL_WRITING_STAGE_ID` when the post-approval writing stage's
  checkpoint moved the tree — `currentFinalTreeId !== stageInputTreeId`, where
  `stageInputTreeId` is the cleaner's `outputTreeId` if the cleaner committed and
  the accepted tree otherwise. So the committed-cleaner case with production's
  no-op stage is exactly `[CLEANER_STAGE_ID]` and B-01's last-id rule names the
  cleaner; a test-injected stage that writes on top of a committed cleaner yields
  `[CLEANER_STAGE_ID, POST_APPROVAL_WRITING_STAGE_ID]` and names the stub, which
  is correct because the stub wrote last; a run where neither wrote yields `[]`
  and B-01's fallback keeps the pre-slice route. The two ids stay distinct
  constants (`src/final-evaluation.ts:39, 49`). The tree comparisons are the same
  three tree ids B-12 tiles its spans from, computed once at the call site, so
  the route and the change-summary attribution cannot disagree about who wrote.
- [behavior:B-03] A `RESTORE` route whose `stageId` is `CLEANER_STAGE_ID`
  re-dispatches the cleaner instead of the stub: the orchestrator calls
  `runCleanerStage` again with `repair: { findings }` carrying the
  `PRESERVATION` / `GATE_INVISIBLE_DRIFT` findings, and with
  `roundsAlreadySpent` set to **`cleaner.roundsSpent` — the number the
  just-completed stage returned, held in memory at the call site**. It is not
  re-derived through `cleanerRoundsSpent(resumableCleanerStage)`
  (`src/orchestrator.ts:7017`, `:6821-6826`), because a stage that ended `PASS`
  is terminal to that predicate and would hand the restore a budget of zero
  spent rounds and three fresh ones. A restore round is gated exactly like any
  round (PRD D12; the resume path `roundsAlreadySpent` keeps its meaning, P-04).
- [behavior:B-04] When the restore route arrives with
  `cleanerRoundsRemaining({ spent: cleaner.roundsSpent, limit }) === 0`, no
  round is dispatched: the orchestrator reverts the cleaner's whole range with a
  hard reset to the accepted commit, records the stage outcome `EXHAUSTED`
  through `recordQualityStageOutcome`, and lets the final-evaluation loop
  continue on the accepted tree — which is the tree the baseline authorizes, so
  the next iteration's `decideFinalReuse` answers `reuse` and the slice merges
  with none of the cleaner's edits (PRD D12).
- [behavior:B-05] `CleanerStageInput` gains
  `repair?: { findings: readonly FinalReviewFinding[] }` and
  `CleanerDispatchInput` gains the same field, so the round the orchestrator
  renders is a restore round: `prompts/cleaner.md` gains a restore variant whose
  `{{QUALITY_FAILURES}}` block is replaced by the findings plus the instruction
  to restore the observed behavior. A repair round with no remaining budget is
  refused by B-04 before this input is built.
- [behavior:B-06] `src/run-events.ts` gains the `quality-stage-attempt`
  `RunEventPayload` member with exactly PRD D11's fields — `ghIssue`,
  `sliceNumber`, `round` (the slice's implementation round), `stage:
  "cleaner" | "final-evaluation"`, `stageRound`, `attempt`, `inputTreeId`,
  `outputTreeId?`, `gateIds: string[]`, `outcome: string`, `startedAt`,
  `endedAt`, `durationMs`, `cacheReusedGateIds: string[]` — plus a pure
  `buildQualityStageAttemptEvent` builder, modelled on
  `buildQualityStagePolicyEvent` (`:547-558`). Additive, so
  `EVENTS_SCHEMA_VERSION` stays 1 exactly as `quality-stage-policy` did
  (`:406-410`).
- [behavior:B-07] One `quality-stage-attempt` per cleaner round, emitted from
  the orchestrator's cleaner wiring: `stage: "cleaner"`, `stageRound` = the
  cleaner round number, `attempt` = the same cleaner round (one dispatch per
  round), `outcome` = the `CleanerRoundOutcome` the round recorded
  (`src/cleaner-stage.ts:107-114`), `durationMs` = the round's own wall clock
  including its gates, and `cacheReusedGateIds` = the ids in that round's
  `phase.evidence.results` carrying `cacheReused === true`
  (`src/gate-runner.ts:183`). Derived from the round's own evidence rather than
  by joining `gate-outcome` events after the fact: it is the same fact from the
  one place that already holds it, so no second reader can disagree. A round 0
  that released the accepted tree spends nothing and emits `stageRound: 0` with
  `inputTreeId === outputTreeId`.
- [behavior:B-08] One `quality-stage-attempt` per final-evaluation attempt,
  emitted in the loop at `src/orchestrator.ts:7389-7829`: `stage:
  "final-evaluation"`, `stageRound` = `attempt` = `finalAttempt`,
  `inputTreeId` = the baseline tree cited, `outputTreeId` =
  `currentFinalTreeId`, `outcome` = the graded verdict or
  `RETURNED_TO_GENERATOR`, and `gateIds` = the declarations that attempt ran.
  A reuse emits none: no attempt happened, and `final-evaluation-reuse`
  (`src/run-events.ts:272`) is already that claim's event.
- [behavior:B-09] `readQualityStageOutcomes(runDir)` in `src/logger.ts`,
  modelled on `readAdvisoryGateOutcomes` (`:118-135`): it reads
  `events.jsonl` alone and returns one `QualityStageOutcome` per
  `(ghIssue, stage)` — enabled (from `quality-stage-policy`), outcome, rounds
  used, round limit, elapsed ms (sum of the stage's `quality-stage-attempt`
  `durationMs`), model ms, gate ids, cache-reused gate ids, and the final
  decision (`reuse` / `evaluate` from `final-evaluation-reuse` or its absence).
  **Model ms is the sum of the `stage-duration` events already on the stream**
  (`RunEventPayload` member at `src/run-events.ts:347-371`: `ghIssue`,
  `sliceNumber?`, `agent`, `round?`, `durationMs`, `history`, `ratioToMedian?`),
  matched on `ghIssue` plus `agent` — `agent === "cleaner"` for
  `stage: "cleaner"` and `agent === "evaluator-final"` for
  `stage: "final-evaluation"`, the two literal roles the orchestrator's own
  phase events already carry (`src/orchestrator.ts:6862`, `:6928`, `:7559`).
  Those events are derived, not emitted by hand: `RunJournal.observeStageDuration`
  (`src/run-journal.ts:133-168`) pairs each `phase-ended` with the newest
  unmatched `phase-started` under `stageInvocationKey`
  (`src/stage-durations.ts:57-63`) and appends the `stage-duration` line, so this
  reader adds no writer and `src/stage-durations.ts` stays read-only (non-goals).
  A stage whose `phase-ended` never arrived contributes no sample and its model
  ms is `0`, which is the same "no evidence" reading `:116` gives. A run
  directory with no events or no such event returns `[]` rather than throwing,
  for the reason `:116` gives.
- [behavior:B-10] `writeSummary` renders one per-slice row per
  `readQualityStageOutcomes` entry beneath #274's existing `## Quality Stages`
  header lines (`src/logger.ts:626-646`), with PRD D11's columns: slice, stage,
  enabled, outcome, rounds used / limit, elapsed, model time (B-09's
  `stage-duration` sum, PRD D11 "model time (sum of `stage-duration.durationMs`)"),
  gate ids, cache-reused gate ids, final decision. A stream with the header event but no
  attempt events renders the header lines and no table, so every #274-era
  summary stays byte-identical.
- [behavior:B-11] `buildPrCreationPlan` (`src/ship-gate.ts:334-351`) gains
  `qualityStages?: readonly QualityStageOutcome[]`, sourced by
  `readQualityStageOutcomes(journal.runDir)` and passed at both call sites
  (`:1229`, `:1292`) exactly as `advisoryGates` is (`:1228, 1237, 1300`). The
  section renders **even when every stage is disabled** — "cleaner: disabled (no
  `gatePolicy.clean`)" — because a PR that says nothing cannot be read as
  evidence of either state (PRD D10 item 3). A plan built with the field absent
  adds no section, so every project that declares no policy keeps its PR body.
- [behavior:B-12] `writeFinalChangeSummary`'s `stages` argument
  (`src/orchestrator.ts:7453-7459`) is tiled per stage that actually wrote, not
  as one `post-approval-writing` span: `{ stageId: CLEANER_STAGE_ID, fromRef:
  baselineTreeId, toRef: cleaner.outputTreeId }` when the cleaner committed,
  followed by `{ stageId: POST_APPROVAL_WRITING_STAGE_ID, fromRef:
  cleaner.outputTreeId, toRef: currentFinalTreeId }`. Without this the summary
  attributes the cleaner's bytes to the stub, and the evaluator grades an
  unattributed diff (PRD D11 / PRD 4 D11: one change-summary producer, one
  attribution).
- [behavior:B-13] A slice whose cleaner committed preserves every round's
  attempt evidence, and this slice pins the existing **file name** rather than
  changing it, while **discovering** the directory: the archived log is the file
  named `cleaner-log-r<generator-round>-a<cleaner-round>.log`
  (`src/artifacts.ts:772`) inside whatever directory the caller at
  `src/orchestrator.ts:6962-6972` passes as `archiveCleanerLog`'s `archiveDir` —
  the `reviewArchiveDir` value that call site already holds (`:6968`), under
  `.afk/artifacts/<run-slug>/slice-<n>/`. The directory segment beneath that
  prefix is not pinned by this contract, because the builder that composes it
  lives in `src/artifacts.ts`, which is out of file scope; an assertion resolves
  it from `reviewArchiveDir` instead of hard-coding it. The two counters *are*
  pinned: the caller passes `round` = the **generator** round and `attempt` = the
  **cleaner** round (`src/artifacts.ts:758-775`), so the file for cleaner round 3
  inside the fixture's **first** generator round has the stem
  `cleaner-log-r1-a3.log` — `r` is the generator round, `a` is the cleaner
  round. No argument re-mapping is authorized here: `src/artifacts.ts` is out of
  file scope and a re-map would silently rename every already-archived round's
  log.

### Non-goals (explicit out-of-scope)

- Any change to `decideFinalReuse` or a second "did a stage write?" predicate
  beside it (PRD D12; `src/final-evaluation.ts:112-116`).
- Re-mapping `archiveCleanerLog`'s `round` / `attempt` arguments, or the
  matching `CleanerRoundRecord` field naming flagged in
  `.kiro/specs/afk-v2-quality-loops/slices/01-cleaner-loop/qa-review.json:25`.
  A follow-up owns it; `src/artifacts.ts` is not in file scope.
- The hardener stage (#92) and any second gauntlet stage id.
- A per-role column in `SliceTotals`, a keyed measurement store, or any
  threshold, alert or watchdog on the new numbers — a measurement, never a gate
  (PRD D11 "Not built", ADR 0063).
- `afk status` rendering of quality stages (PRD "Out of scope").
- Editing this repository's `afk.config.json`: the cleaner stays off for the
  self-run and the file is a protected path (PRD D1).
- Anything `src/stage-durations.ts` does: its per-role round-duration history
  (`pairStageDurations`, `readStageDurationHistory`) is a separate,
  already-shipped ROI channel and the file is not edited. B-09 does not change
  it: it reads the `stage-duration` **events** that
  `RunJournal.observeStageDuration` (`src/run-journal.ts:133-168`) already writes
  to `events.jsonl`, which is the same posture every other reader in
  `src/logger.ts` takes toward the stream. No new emitter, no new pairing, and no
  per-role history is added.

### Existing behavior to preserve

- [behavior:P-01] `decideFinalReuse` (`src/final-evaluation.ts:117-165`) keeps
  exact string equality with no cosmetic exception and its three-condition
  `reuse`, and a run whose cleaner is unconfigured or made no change still
  reuses with zero `evaluator-final` invocations (#97 AC2, PRD D12/D20).
- [behavior:P-02] `PostApprovalWritingStage` (`src/final-evaluation.ts:60-67`)
  stays synchronous with `noopPostApprovalWritingStage` as production's default,
  and a `RESTORE` that routes to the stub still calls it with
  `repair: "RESTORE"` (`src/orchestrator.ts:7772-7776`).
- [behavior:P-03] `decideFinalVerdict` (`src/final-evaluation.ts:483-537`) keeps
  its fail-closed conditions and `MAX_FINAL_EVALUATION_ATTEMPTS = 3`
  (`src/bounds.ts:59`) is unchanged: a `RETURN_TO_GENERATOR` still spends one
  generator round and zero attempts (`:429-436`, PRD 4 D19).
- [behavior:P-04] The cleaner's cross-process round bound holds:
  `roundsAlreadySpent` on the resume path is still read out of run state via
  `cleanerRoundsSpent(resumableCleanerStage)` (`src/orchestrator.ts:7017`) and
  continuation is still `cleanerRoundsRemaining({ spent, limit }) > 0`
  (`src/cleaner-stage.ts:533`, ADR 0050), so a resumed run cannot buy a fourth
  round. B-03's in-memory hand-off adds a route into the same bound; it does not
  replace the persisted one.
- [behavior:P-05] Every cleaner exit path still resets and records
  (`src/cleaner-stage.ts:553-573`, `:593-612`, `:614-638`, `:729-758`;
  ADR 0051), and a valid `BASELINE_IS_WRONG` escalation still returns the slice
  to the generator with the baseline invalidated
  (`src/orchestrator.ts:7100-7146`).
- [behavior:P-06] `EVENTS_SCHEMA_VERSION` stays 1 and every existing event
  member and reader is untouched; a historical `events.jsonl` with no
  `quality-stage-attempt` line renders no rows and no PR section.
- [behavior:P-07] #274's `## Quality Stages` header lines keep rendering from
  `quality-stage-policy` alone, in the disabled case too
  (`src/logger.ts:612-646`).
- [behavior:P-08] The merge stays serialized through `src/wave.ts`'s existing
  `mergeMutex`; this slice introduces no lock primitive in any file it touches
  (#96 P-01).

### Changes to existing behavior (only if the issue asks for it)

- `routeFinalReviewFinding`'s `context` parameter gains a required
  `writingStageIds` field, and its `RESTORE` route can now name
  `CLEANER_STAGE_ID` rather than always `POST_APPROVAL_WRITING_STAGE_ID`
  (#97 AC1, PRD D12: "`routeFinalReviewFinding` gains the writing stage id as an
  input… returns `stageId` = the last stage that ran").
- The final-evaluation `RESTORE` branch may now dispatch a cleaner round instead
  of the synchronous stub, and may revert the cleaner's committed range
  (#97 AC1, PRD D12).
- `writeFinalChangeSummary` is called with more than one stage span
  (#97 AC1 via PRD D11 attribution).

## Files expected to change

- src/final-evaluation.ts
- src/final-evaluation.test.ts
- src/cleaner-stage.ts
- src/cleaner-stage.test.ts
- src/run-events.ts
- src/orchestrator.ts
- src/logger.ts
- src/logger.test.ts
- src/ship-gate.ts
- src/ship-gate.test.ts
- src/qa-orchestration-gates.test.ts
- prompts/cleaner.md
- ARCHITECTURE.md

## Migration requirements

- New migration files: 0

## New patterns / deps / schema (if any)

- One new `RunEventPayload` member, `quality-stage-attempt`, with PRD D11's
  field list and a pure builder beside `buildQualityStagePolicyEvent`. Additive:
  `EVENTS_SCHEMA_VERSION` stays 1, and no `RunState` schema version changes —
  the persisted `qualityStages` record #87 shipped is read, never re-shaped.
- One new exported reader, `readQualityStageOutcomes(runDir)`, and its
  `QualityStageOutcome` type, following `readAdvisoryGateOutcomes` /
  `AdvisoryGateOutcome` exactly (`src/logger.ts:104-135`).
- No new dependency.

## Test plan

- Given a `FinalReviewFinding` with `repair: "RESTORE"`, when
  `routeFinalReviewFinding` is called with `writingStageIds: [CLEANER_STAGE_ID]`
  — the list B-02 builds for a committed cleaner under production's no-op stage —
  then the route is `{ target: "writing-stage", stageId: "cleaner", repair:
  "RESTORE" }`; with `[CLEANER_STAGE_ID, POST_APPROVAL_WRITING_STAGE_ID]` (a
  test-injected stage that wrote after the cleaner) it names
  `"post-approval-writing"`, because that stage wrote last; with `[]` it names
  `"post-approval-writing"` by B-01's fallback; a non-`RESTORE` repair still
  routes to `generator-loop` with `generatorRoundsConsumed: 1` and
  `finalEvaluationAttemptsConsumed: 0`. Unit, in `src/final-evaluation.test.ts`.
- Given a committed cleaner (`cleaner.outputTreeId !== cleaner.inputTreeId`) and
  a post-approval checkpoint equal to the cleaner's output tree, when the call
  site's list is built, then it is exactly `[CLEANER_STAGE_ID]`; given a cleaner
  that committed nothing and a checkpoint equal to the accepted tree, it is `[]`;
  given both writing, it is `[CLEANER_STAGE_ID,
  POST_APPROVAL_WRITING_STAGE_ID]`. Asserted on the pure list-builder extracted
  for this purpose, unit, in `src/final-evaluation.test.ts` (S1 and S3 corroborate
  it against real trees).
- Given `buildQualityStageAttemptEvent` inputs for a cleaner round and for a
  final attempt, when built, then every PRD D11 field is present with the
  declared type and `EVENTS_SCHEMA_VERSION` is still 1. Unit, in
  `src/logger.test.ts` (no `run-events.test.ts` exists; the schema is asserted
  where its reader lives).
- Given a hand-seeded `events.jsonl` with one `quality-stage-policy` line, three
  `quality-stage-attempt` lines across two slices, and `stage-duration` lines
  carrying `agent: "cleaner"` and `agent: "evaluator-final"` for those slices,
  when `readQualityStageOutcomes` reads it, then one entry per `(ghIssue, stage)`
  carries the summed elapsed, the summed model ms from the `agent`-matched
  `stage-duration` lines, the rounds used, the gate ids and the cache-reused gate
  ids; a stream whose `stage-duration` lines are absent yields model ms `0`; a
  directory with no events returns `[]`. Unit, in `src/logger.test.ts`.
- Given that same stream, when `writeSummary` renders, then the per-slice row
  appears under the existing `## Quality Stages` header lines with D11's
  columns; and given a stream with the policy event but no attempt events, the
  output contains the header lines and no table. Extends the existing
  `[behavior:#274:B-08]` describe block at `src/logger.test.ts:1196`.
- Given `buildPrCreationPlan` with `qualityStages` holding one disabled entry,
  when the plan is built, then the body carries the quality-stages section
  saying `disabled`; with the field absent the body is unchanged. Unit, in
  `src/ship-gate.test.ts`.
- Given `runCleanerStage` driven directly against real git trees and real gate
  processes (the harness `src/cleaner-stage.test.ts:1-12` establishes), with
  `repair: { findings: [...] }`, when a round dispatches, then
  `CleanerDispatchInput.repair` carries the findings, the rendered
  `prompts/cleaner.md` restore variant names them in place of
  `{{QUALITY_FAILURES}}`, the round is gated with the full regression bundle,
  and `roundsAlreadySpent` is honoured — a stage seeded at the limit dispatches
  zero rounds.
- **S1** — Given the `finalEvaluationFixture`
  (`src/qa-orchestration-gates.test.ts:1083`) extended with a
  `gatePolicy.clean` whose clean gate is red on the accepted tree and green
  after one cleaner round, and `stageWrites: false`, when `runSliceExecute`
  runs, then `finalEvaluationFor(...).decision` is `"evaluate"`, exactly one
  `evaluator-final` invocation is recorded, and a `quality-stage-attempt` line
  exists for the cleaner round and for the final attempt — the candidate PASS
  alone did not certify the changed tree (#97 AC1). A spawned scenario because
  only an executing run can show a cleaner commit reaching the final evaluator;
  no unit test reaches that state (CLAUDE.md, "Where a new assertion goes").
- **S2** — Given the same fixture with no `gatePolicy.clean` and
  `stageWrites: false`, when `runSliceExecute` runs, then the decision is
  `"reuse"`, `finalCalls` is empty, and the run summary's
  `## Quality Stages` row reads `disabled` with `0` rounds (#97 AC2, P-01).
  An `it` on the fixture, not a new spawn.
- **S3** — Given the same fixture with `gatePolicy.clean`, run state seeded with
  a non-terminal `qualityStages` entry holding **2** spent cleaner rounds (so
  `resumableCleanerStage` resolves and `roundsAlreadySpent` is 2, making the
  committing cleaner round **3** of a limit of 3), and an `evaluator-final`
  whose first review is a `FAIL` carrying one `PRESERVATION` finding with
  `repair: "RESTORE"`, when `runSliceExecute` runs, then: the restore route
  names `"cleaner"`; the re-dispatch is refused for want of budget because it
  was handed the stage's in-memory `roundsSpent` of 3 rather than a count
  re-derived through the now-`PASS` persisted entry (B-03/B-04); the cleaner's
  range is reverted; the stage outcome persists as `EXHAUSTED`; the second
  final-evaluation iteration reuses the accepted tree; and the surviving
  archived round log is the file named `cleaner-log-r1-a3.log` inside the slice's
  archive directory as resolved from the run's own artifact tree under
  `.afk/artifacts/<run-slug>/slice-<n>/` — the directory is discovered by walking
  the run's artifact root for that stem, not hard-coded, because the builder that
  composes the segment lives in the out-of-scope `src/artifacts.ts` (B-13). The
  stem is pinned: `r1` is the fixture's **first generator round**, `a3` is the
  **third cleaner round**, the slots `src/orchestrator.ts:6962-6972` passes to
  `archiveCleanerLog`. A spawned scenario for the same reason as S1; it is an
  `it` on the shared fixture, not a fourth spawn.

## Definition of done

- [ ] `routeFinalReviewFinding` takes `writingStageIds` and names its last id;
      the empty list still names `post-approval-writing`.
- [ ] The orchestrator's one route call site passes only the stages that changed
      the tree they were handed, in run order, so `[CLEANER_STAGE_ID]` is the
      committed-cleaner list under production's no-op stage and a `RESTORE` then
      names `cleaner`.
- [ ] A `RESTORE` to the cleaner re-dispatches `runCleanerStage` with the
      findings and with `cleaner.roundsSpent` as `roundsAlreadySpent`, read from
      memory and not through `cleanerRoundsSpent(resumableCleanerStage)`.
- [ ] With no cleaner round remaining, the cleaner's range is reverted to the
      accepted commit, `EXHAUSTED` is recorded, and the final evaluation then
      reuses the accepted tree.
- [ ] `prompts/cleaner.md` has a restore variant driven by
      `CleanerDispatchInput.repair`.
- [ ] `quality-stage-attempt` exists with PRD D11's exact fields and a pure
      builder; `EVENTS_SCHEMA_VERSION` is still 1.
- [ ] One such event per cleaner round and one per final-evaluation attempt,
      with `cacheReusedGateIds` derived from that run's own gate evidence.
- [ ] `readQualityStageOutcomes(runDir)` returns one entry per
      `(ghIssue, stage)` and `[]` for a run directory with no events, its model
      ms summed from `stage-duration` events matched on `ghIssue` plus `agent`.
- [ ] `writeSummary` renders D11's per-slice row under #274's header lines, and
      a stream with no attempt events renders no table.
- [ ] `buildPrCreationPlan` accepts `qualityStages`, renders the section in the
      disabled case, and adds nothing when the field is absent.
- [ ] `writeFinalChangeSummary` is called with one span per stage that wrote.
- [ ] S3's assertion names the file stem `cleaner-log-r1-a3.log` — the name
      `archiveCleanerLog` writes for the committing round under the existing
      `r`=generator-round / `a`=cleaner-round slots — and resolves its directory
      from the run's artifact tree rather than hard-coding a segment beneath
      `.afk/artifacts/<run-slug>/slice-<n>/`.
- [ ] `pnpm run typecheck` passes, and `pnpm test:fast` plus
      `pnpm run test:heavy:qa` pass on this branch (CLAUDE.md:
      a slice agent does not run the full suite).
- [ ] ARCHITECTURE.md's final-evaluation and post-approval-quality-stage rows
      name the restore re-dispatch and the new event family.

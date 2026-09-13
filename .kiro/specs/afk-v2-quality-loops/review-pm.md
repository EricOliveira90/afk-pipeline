# PM review — PRD 5 (quality loops, cleaner only), slices 01 / 03 / 04

**Verdict:** ACCEPT-WITH-NOTES

## Scope judged

Selected slices only: 01 (#87 cleaner loop), 03 (#97 changed trees face final
evaluation; ROI evidence), 04 (#274 quality policy starter and stage record).
Slice 02 (#92, hardener) is out of scope and did not influence this verdict.
This is a repeat read of the same branch after three follow-up commits
(`cd477a6` scope-gate carve-out, `0685fb5` continuation seam, `a835eac` git
seam); both prior notes were re-checked against the tree as it stands.

## What a user gets, checked against the PRD

**The cleaner exists and is off unless the project asks for it (D1, #87 AC1).**
`gate-policy.ts` carries `clean` in `POLICY_KEYS`; the stage returns
`outcome: "DISABLED"`, `ran: false` with no dispatch when the policy has no
`clean` member, and the orchestrator only forwards `clean` when
`ctx.runGatePolicy?.clean` exists (`src/orchestrator.ts:6838-6841`) — the run's
snapshot, never a candidate worktree read. This repo's `afk.config.json` still
has no `clean` member (grepped), so the self-run stays off as the PRD promises.

**One bounded loop with the promised shape (D4).** `MAX_CLEANER_ROUNDS = 3` and
`cleanerRoundsRemaining` (`src/bounds.ts:84-96`). Round 0 gates the accepted
tree and releases it with zero invocations; an empty `{changedFiles}`
expansion records `SKIPPED` with detail "no changed files" and releases the
tree exactly as `PASS` does (`src/cleaner-stage.ts:80-81`, `:383-403`,
`:501-503`). Each round runs the clean gates, then `scope` (`role` source,
`artifactDirPolicy: "declared-only"`, `acceptedPairIntact: false`),
`feedback-integrity` (threaded run policy), `tests:skipped`, `suppressions`,
then the regression bundle (`src/cleaner-stage.ts:878-926`), which the hub
supplies as pre-QA declarations (including the `acceptance:behaviors` gate,
`src/orchestrator.ts:6198-6205`) plus the full-suite declarations. A red
regression gate resets the worktree to the round's input commit and records
`REVERTED` (`:948-970`) — revert, never redefine.

**Escalation, exhaustion and restore reach the right place.** A valid
`cleaner-escalation.json` (`parseCleanerEscalation`, `:437-490`) becomes a
`RETURN_TO_GENERATOR` decision carrying the finding, the archived artifact
reference and `invalidateFinalEvaluationBaseline`, after the whole cleaner
range is reset to the accepted commit
(`src/cleaner-orchestration.ts:366-405`); exhaustion becomes `STUCK` naming
every remaining red gate and its log artifact id (`:410-425`), routed to the
orchestrator's `finishStuck` through the continuation seam
(`src/cleaner-continuation.ts:50-67`, `src/orchestrator.ts:6878-6890`).
`prompts/cleaner.md` carries the three rules, both anti-gaming lines,
"Restore or revert — never redefine", the commit-with-rationale instruction,
the escalation instruction, and exactly D7's placeholder set with no
TEST_COMMAND placeholder (grepped the token list).

**Changed trees face final evaluation; RESTORE goes to the writer (#97
AC1/AC2, D12).** `routeFinalReviewFinding` takes `writingStageIds` and the
loop re-dispatches the cleaner with the findings
(`src/orchestrator.ts:7597-7710`); a restore with no round left resets the
cleaner's whole range to the accepted commit, records `EXHAUSTED`, and the
next iteration re-asks `decideFinalReuse` on that tree, which then equals the
baseline and reuses (`src/orchestrator.ts:7206-7231`,
`src/cleaner-orchestration.ts:450-480`).

**ROI evidence is readable and never a gate (D10/D11, #97 AC3/AC4).** One
`quality-stage-policy` event per run, emitted immediately after `run-started`
in both states (`src/orchestrator.ts:8256-8261` via
`buildQualityStagePolicyEvent`); one `quality-stage-attempt` per cleaner round
and per final-evaluation attempt; one derivation
(`deriveQualityStageOutcomes`, `src/logger.ts:190-262`) behind both
`run-summary.md` `## Quality Stages` header and rows (`:752-813`) and the
draft-PR section (`src/ship-gate.ts:462-496`). The row carries rounds
used/limit, wall clock, model time from `stage-duration`, gate ids,
cache-reused ids and reuse-vs-evaluate. Nothing is thresholded.

**Persisted so a resume cannot buy a fourth round (D9).**
`RUN_STATE_VERSION = 6` with `qualityStages`, and `adaptLoadedState` accepts a
v5 file with none (`src/run-state.ts:53-67`, `:915-990`, `:1073`). The
continuation reads the prior record and resumes from rounds already spent
(`src/cleaner-orchestration.ts:433-448`).

**The starter ships (D6, #87 AC7).** `templates/quality-policy/afk.config.json`
declares `protectedPaths`, all four `riskClasses` including `suppression`,
`acceptance`, `cost` and seven `clean.gates` (format, lint, typecheck,
changed-code coverage, complexity, duplication, architecture) with
`{changedFiles}` wherever the tool takes paths and no `_note` members;
`package.json` `files` includes `templates`; `README.md:411-457` says how to
copy it and that `gatePolicy.clean` is the switch.

Fresh evidence I ran myself this round: `npx vitest run src/ship-gate.test.ts
src/cleaner-continuation.test.ts src/cleaner-orchestration.test.ts` — 39
passed, 3 files, exit 0.

## Notes (not blocking)

- **N-01 (repeat of P-01) — the PR body can call an enabled cleaner disabled.**
  `src/ship-gate.ts:469-474` prints the literal line
  "cleaner: disabled (no gatePolicy.clean)" whenever `args.qualityStages`
  is empty, and that array comes from `readQualityStageOutcomes(journal.runDir)`
  (`:1286`), whose derivation builds outcomes only from
  `quality-stage-attempt` events (`src/logger.ts:193-212`). A run with
  `gatePolicy.clean` declared but no attempt event in this run directory —
  a resumed run whose slices were cleaned in a prior run dir, or a run where
  no slice reached post-approval — renders the disabled sentence for an
  enabled policy. `events.jsonl` and `run-summary.md` both already carry the
  truthful fact, so the fix is to source that line from the
  `quality-stage-policy` event. Unchanged since the previous round.
- **N-02 (repeat of P-02) — the starter declares no `suppressionDetectors`,**
  so a copier silently inherits AFK TypeScript detector set (D1 stated
  default). Correct for a TS project, invisible for others; the README
  starter section (re-read at `:411-457`) still does not mention the detectors
  or how to replace them.
- **N-03 — the malformed-escalation round is not gated.** D8 says a malformed
  `cleaner-escalation.json` is treated as a plain cleaner round whose
  checkpoint is still gated; the implementation discards the checkpoint by
  resetting to the round input commit and records `ESCALATION_MALFORMED` as
  the round whole outcome (`src/cleaner-stage.ts:797-823`). This is not a
  silent drift: slice 01 locked contract resolved that ambiguity explicitly
  (`slices/01-cleaner-loop/contract.md:181-189`), the round is still spent and
  the tree is still the approved one, so the user outcome is safe. Recorded so
  the PRD text and the code stop disagreeing.
- **N-04 — #226 correctly stays open;** slice 01 handoff names the cleaner
  round `scope` declaration as the `role` source first production caller.

## Out-of-scope PRD gaps (for the operator, not the verdict)

- Slice 02 / #92 (hardener loop, #73 stories 9-15, 19) is deferred by plan §2
  and not selected. Nothing on this branch builds toward it: no `hardener`
  stage id, no mutation gate, no survivor schema.
- Story 17 ROI *decision* still needs a later run whose `afk.config.json`
  declares `gatePolicy.clean`. This PRD deliberately keeps this repo cleaner
  off (Launch precondition 4), so the branch ships the measurement channels
  and no measurements.
- Running `suppressions` on generator candidates, `afk status` rendering of
  quality stages, and a per-role `SliceTotals` column remain out of scope by
  the PRD own "Out of scope" section.

## Structured findings (v1)

{"version":1,"findings":[{"id":"P-01","title":"Draft-PR quality-stage line can report an enabled cleaner as disabled when the run directory holds no attempt event","class":"PRODUCT","clearCondition":"The PR body quality-stage line derives enabled/disabled from the run quality-stage-policy event rather than from the emptiness of readQualityStageOutcomes, so a run with gatePolicy.clean declared and no attempt event in its run directory renders enabled.","disposition":"REPEATED"},{"id":"P-02","title":"Starter template ships no suppressionDetectors and the README does not mention the default","class":"PRODUCT","clearCondition":"The README Quality policy starter section states that clean.suppressionDetectors defaults to the built-in TypeScript detector set and how a non-TypeScript project replaces it, or the template declares the detectors explicitly.","disposition":"REPEATED"},{"id":"P-03","title":"PRD D8 says a malformed escalation round is still gated; the locked contract and code discard the checkpoint instead","class":"DOC","clearCondition":"PRD 5 D8 sentence about a malformed escalation being treated as a plain cleaner round with its checkpoint still gated is amended to match slice 01 locked contract decision: reset to the round input checkpoint, ESCALATION_MALFORMED as the round whole outcome, no gate on the discarded checkpoint.","disposition":"OPEN"}]}

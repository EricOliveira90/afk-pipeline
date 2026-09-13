# PM review — PRD 5 (quality loops, cleaner only), slices 01 / 03 / 04

**Verdict:** ACCEPT-WITH-NOTES

## Scope judged

Selected slices only: 01 (#87 cleaner loop), 03 (#97 changed trees face final
evaluation; ROI evidence), 04 (#274 quality policy starter and stage record).
Slice 02 (#92, hardener) is out of scope and did not influence this verdict.

## What a user gets, checked against the PRD

**The cleaner exists, is off unless the project asks for it (D1, #87 AC1).**
`src/gate-policy.ts` carries `clean` in `POLICY_KEYS`; the stage's own entry
returns early with `outcome: "DISABLED"` and `ran: false` when the policy has
no `clean` member (`src/cleaner-stage.ts:571-580`), and the orchestrator only
passes `clean` through when `ctx.runGatePolicy?.clean` exists
(`src/orchestrator.ts:6837-6841`). This repo's own `afk.config.json` still has
no `clean` member (checked), so the self-run stays off as the PRD promises.

**One bounded loop with the promised shape (D4).** `runCleanerStage`
(`src/cleaner-stage.ts:565-`) gates the accepted tree first and returns `PASS`
with `roundsSpent: 0` and zero invocations when the required clean gates
release it (`:645-690`); an empty `{changedFiles}` expansion records `SKIPPED`
and releases the tree exactly as `PASS` does (`:395-400`, `:506-508`). Each
round runs the clean gates plus `scope` (`role` source with
`artifactDirPolicy: "declared-only"`, `:882-895`), `tests:skipped`,
`suppressions` and the caller's regression bundle (`:914-927`). I ran
`src/cleaner-stage.test.ts src/cleaner-orchestration.test.ts
src/suppression-gate.test.ts` — 41 passed — including the round bound, the
infrastructure retry spending no round, revert-on-regression, `EXHAUSTED`
naming every remaining red gate with its log artifact id, and the escalation
path invalidating the baseline citation.

**Escalation and exhaustion reach a human the way the PRD says.** A valid
`cleaner-escalation.json` becomes a `RETURN_TO_GENERATOR` decision with the
finding, the archived artifact reference and
`invalidateFinalEvaluationBaseline` (`src/cleaner-orchestration.ts:357-405`);
exhaustion becomes `STUCK` and the orchestrator's `finishStuck`
(`src/orchestrator.ts:6891-6894`). The prompt (`prompts/cleaner.md`) carries
the three rules, both anti-gaming warnings, "restore or revert — never
redefine", the commit-with-rationale instruction and the escalation shape, and
carries no `{{TEST_COMMAND}}` — matching D7.

**Changed trees face final evaluation, and RESTORE goes to the writer (#97
AC1/AC2, D12).** `routeFinalReviewFinding` takes the writing stage ids and
`CLEANER_STAGE_ID` is appended when the cleaner wrote
(`src/final-evaluation.ts:465`); the loop re-dispatches the cleaner with the
findings (`src/orchestrator.ts:7681-7700`), and a restore with no budget left
resets the cleaner's whole range to the accepted commit, records `EXHAUSTED`
and proceeds — so the tree equals the baseline and reuses
(`src/cleaner-orchestration.ts:450-480`). The unit suite pins the whole-range
unwind and the restore round's true start tree.

**ROI evidence is readable (D10/D11, #97 AC3/AC4).** One
`quality-stage-policy` event per run, emitted immediately after `run-started`
in both states (`src/orchestrator.ts:8237-8251`), one
`quality-stage-attempt` per cleaner round and per final-evaluation attempt,
and one derivation (`deriveQualityStageOutcomes`, `src/logger.ts:188-260`)
behind both `run-summary.md`'s `## Quality Stages` header + rows
(`src/logger.ts:752-812`) and the draft-PR section
(`src/ship-gate.ts:462-496`). Rounds used / limit, wall clock, model time,
gate ids, cache-reused ids and the reuse-vs-evaluate decision are all in the
row, and nothing is thresholded.

**The starter ships (D6, #87 AC7).** `templates/quality-policy/afk.config.json`
parses (`json.load` clean) with `protectedPaths`, all four `riskClasses`
including `suppression`, `acceptance`, `cost` and seven `clean.gates`
(`clean:format`, `clean:lint`, `clean:typecheck`, `clean:coverage-changed`,
`clean:complexity`, `clean:duplication`, `clean:architecture`);
`package.json` `files` now includes `templates`; `README.md:411-457` explains
how to copy it, that `gatePolicy.clean` is the switch, why `clean:typecheck`
gets no `{changedFiles}`, and that the record is written in both states.

## Notes (not blocking)

- **N-01 — the PR body can call an enabled cleaner "disabled".**
  `src/ship-gate.ts:469-474` prints the literal
  "`cleaner`: disabled (no `gatePolicy.clean`)" whenever
  `args.qualityStages` is empty, and `qualityStages` comes from
  `readQualityStageOutcomes(journal.runDir)` (`:1286`), which derives from
  `quality-stage-attempt` events only. A run with `gatePolicy.clean`
  declared but no attempt event in *this* run directory — e.g. a resumed run
  whose slices were approved and cleaned in a prior run dir — would print the
  disabled line for an enabled policy. The `quality-stage-policy` event and
  `run-summary.md` both already carry the truthful fact, so the fix is to
  source the PR line from that event too. Narrow enough to defer.
- **N-02 — the starter declares no `suppressionDetectors`,** so a project
  copying it inherits AFK's TypeScript detector set by default (D1's stated
  default). That is right for a TS project and silent for others; the README
  section does not mention the detectors or how to replace them.
- **N-03 — #226 correctly stays open;** the cleaner round's `scope`
  declaration is noted in slice 01's handoff as the `role` source's first
  production caller.

## Out-of-scope PRD gaps (for the operator, not the verdict)

- Slice 02 / #92 (hardener loop, #73 stories 9–15, 19) is deferred by plan §2
  and not selected in `afk.json`. Nothing on this branch builds toward it: no
  `hardener` stage id or mutation gate exists.
- Story 17's ROI *decision* still needs a later run whose `afk.config.json`
  declares `gatePolicy.clean`. This PRD deliberately keeps this repo's cleaner
  off (Launch precondition 4), so the branch ships the measurement channels
  but no measurements yet.
- Running `suppressions` on generator candidates, `afk status` rendering of
  quality stages, and any per-role `SliceTotals` column remain out of scope by
  the PRD's own "Out of scope" section.

## Structured findings (v1)

{"version":1,"findings":[{"id":"P-01","title":"Draft-PR quality-stage line can report an enabled cleaner as disabled when the run directory holds no attempt event","class":"PRODUCT","clearCondition":"The PR body's quality-stage line derives enabled/disabled from the run's `quality-stage-policy` event rather than from the emptiness of `readQualityStageOutcomes`, so a run with `gatePolicy.clean` declared and no attempt event in its run directory renders 'enabled'.","disposition":"OPEN"},{"id":"P-02","title":"Starter template ships no suppressionDetectors and the README does not mention the default","class":"PRODUCT","clearCondition":"The README's Quality policy starter section states that `clean.suppressionDetectors` defaults to AFK's TypeScript detector set and how a non-TypeScript project replaces it (or the template declares the detectors explicitly).","disposition":"OPEN"}]}

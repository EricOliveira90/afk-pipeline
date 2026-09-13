# PM review — PRD 5 (quality loops: cleaner only, default off)

**Verdict:** ACCEPT-WITH-NOTES

Scope reviewed: slices 01 (#87 cleaner loop), 04 (#274 quality policy starter
and stage record) and 03 (#97 changed trees face final evaluation; ROI
evidence). Slice 02 (#92 hardener) was not selected and is not judged here.

## What a user gets, checked against the PRD

**The cleaner exists, is off unless one config member says otherwise (D1, #87
AC1).** `src/cleaner-stage.ts:565-579` — `runCleanerStage` returns
`{ ran: false, outcome: "DISABLED", inputTreeId === outputTreeId }` before it
touches git, so a project with no `gatePolicy.clean` gets no dispatch and no
gate phase. The orchestrator keeps the old shape around it: the change-summary
tiling at `src/orchestrator.ts:7621-7640` emits today single stub entry when
`cleanerWrote()` is false, and the injected `postApprovalWritingStage` seam is
still read at `:7255`. The committed `afk.config.json` of this repo carries no
`clean` member, which is the intended state for the self-run (launch
precondition 4).

**Turning it on is one config line, and the run says which state it was in
(D10).** `buildQualityStagePolicyEvent` has exactly one production caller
(`src/orchestrator.ts:8671`, at run entry); `src/logger.ts:796-813` renders
`## Quality Stages` from that event alone with an enabled/disabled header line
plus the #97 per-slice rows; `src/ship-gate.ts:462-498` renders the PR section
unconditionally, including the explicit "`cleaner`: disabled (no
`gatePolicy.clean`) — no round ran" line (pinned at
`src/ship-gate.test.ts:328`). A reader of a PR body can tell the two states
apart, which was the point of D10 item 3.

**A bounded loop that never redefines the target (D4, D5, #73 stories 3-8).**
I ran `pnpm vitest run src/cleaner-stage.test.ts src/ship-gate.test.ts
src/suppression-gate.test.ts` in this tree: 3 files, 74 tests passed, 128s,
exit 0. Among the passing cases I read the names of: round 0 releasing the
accepted tree with zero invocations (story 20), `EXHAUSTED` naming every
remaining red gate with its detail and log artifact id (story 18), a restore
round reverted when it reddens the regression bundle, the whole committed
cleaner range unwound rather than the last round only, and the suppressions
counter failing only on an increase.

**A cleaner-changed tree faces the final evaluator, and a RESTORE reaches the
stage that wrote (D12, #97 AC1-AC2).** `routeFinalReviewFinding`
(`src/final-evaluation.ts:473-496`) now takes `writingStageIds` and returns the
last stage that ran; `src/orchestrator.ts:8025` routes a cleaner-authored
restore back into `dispatchCleanerStage` (`:8088`) under the remaining round
budget, and `decideFinalReuse` is untouched, so a stage that wrote nothing
still reuses. `runCleanerStage restore rounds` covers the repair dispatch,
its start tree and its revert in the run I executed above.

**ROI evidence is readable by a human without new machinery (D11).**
`buildQualityStageAttemptEvent` (`src/run-events.ts:604-631`) is emitted per
cleaner round and per final-evaluation attempt (`src/orchestrator.ts:7052`,
`:7753`), and the run-summary rows carry rounds used / limit, elapsed, model
time, gate ids, cache-reused gate ids and the final decision — the exact
columns D11 specifies. No threshold, no alert, no keyed store, as the PRD asked.

**The starter template ships (D6, #87 AC7).** `templates/quality-policy/afk.config.json`
is a complete config that names seven gates (format, lint, typecheck,
changed-code coverage, complexity, duplication, architecture) with
`{changedFiles}` wherever the tool takes paths; `package.json:42` adds
`templates` to `files`; `README.md:411-` explains how to copy it and states
that declaring `gatePolicy.clean` is the whole switch.

## Notes (do not block the merge)

**P-01 — a copier of the starter template is not told to protect its own
threshold files.** PRD D5 makes "threshold edits" one of the three anti-gaming
detections and says it is served by `feedback-integrity`'s `gate-policy` rule
over `protectedPaths.gatePolicyPaths`, adding that "a project whose thresholds
live in `vitest.config.ts` or `.eslintrc` lists those files there, and the
starter template (D6) does". The shipped template lists only
`["afk.config.json", "suite-budgets.json"]`
(`templates/quality-policy/afk.config.json`, `gatePolicy.protectedPaths`),
which slice 04's contract records as a deliberate choice
(`slices/04-.../contract.md:38-48`: the shipped defaults written out
explicitly). I read the whole new README section (`README.md:411-462`) and it
never mentions `protectedPaths` either. Net user effect for someone who copies
the template verbatim: the template's own `clean:lint` /
`clean:coverage-changed` / `clean:architecture` gates are configured by files
(`.eslintrc*`, `vitest.config.*`, `.dependency-cruiser.cjs`) that nothing
protects, so a cleaner could relax a rule instead of satisfying it and still
pass the round. This is a one-line documentation or template change, and the
detection mechanism itself exists and works, so it is a note rather than a
blocker.

**P-02 — the archive filename and the persisted record swap "round" and
"attempt" (slice 01 QA-02, still OPEN and advisory).** I confirmed the two
sites: `src/orchestrator.ts` archives cleaner rounds with the generator round
first (`cleaner-log-r<generatorRound>-a<cleanerRound>.log`) while
`PersistedQualityStageRound` records `{ round: cleanerRound, attempt:
generatorRound }`. An operator doing exactly what story 17 asks — correlating
per-round cost evidence with the archived logs — has to know the two
conventions are mirror images. Cheap fix: one comment at each site, or one
consistent order.

**P-03 — slice 01's `stuck.md` and `intervention.json` are still in the spec
directory although the slice finished PASS.** `slices/01-cleaner-loop/stuck.md`
describes QA-01 as OPEN and instructs a human to intervene, while
`slices/01-cleaner-loop/qa-review.json` records the same QA-01 as `RESOLVED`
with the verdict `PASS`. A human triaging this branch reads the stale file
first. Nothing about the shipped behavior is affected.

## Out-of-scope PRD gaps (for the operator, not the verdict)

- **#92 / stories 9-15, 19 (hardener, mutation testing)** are deferred by plan
  §2 and were not selected. I found no `hardener` stage id, no mutation gate
  and no survivor schema on this branch, which matches the PRD's "Deferred"
  section.
- **Story 17's ROI evidence is not produced by this run.** By design (PRD
  "Scope", precondition 4) the self-run launches with the cleaner off, so this
  branch ships the measurement channels but no measurement. The decision the
  PRD wants — cleaner default on or off — still needs a later run whose
  `afk.config.json` declares `gatePolicy.clean`.
- **`suppressions` runs only inside the cleaner's round set** (D5, explicitly
  out of scope for generator candidates). A project without a cleaner gets no
  suppression detection; the PRD names this a follow-up.
- **#226 must stay OPEN.** The cleaner is now the first production caller of
  the `scope` gate's `role` source; every other writing role is still unwired.
  Slice 01's handoff records this (`handoff.md`, "Gotchas").
- **`suite-budgets.json` overrun.** Slice 01's handoff measured
  `test:heavy:qa` at 178.7s against a 151s budget, caused by its two new
  spawned scenarios, and did not raise the number (it is out of file scope).
  `pnpm test:budgets` will be red until an operator rules on it.

## Structured findings (v1)

{"version":1,"findings":[{"id":"P-01","title":"Starter template and its README never tell a copier to protect their own threshold-bearing config files","class":"PRODUCT","clearCondition":"templates/quality-policy/afk.config.json's protectedPaths.gatePolicyPaths lists the config files its own clean gates read (eslint, vitest, dependency-cruiser), or the README 'Quality policy starter' section tells the copier to add them and says why the threshold-edit detection depends on it.","disposition":"OPEN"},{"id":"P-02","title":"Cleaner round archive filename and persisted record invert 'round' and 'attempt'","class":"PRODUCT","clearCondition":"A cleaner round's archive filename and its PersistedQualityStageRound name the same number with the same field, or a comment at each site states the inversion.","disposition":"OPEN"},{"id":"P-03","title":"Stale stuck.md and intervention.json remain in slice 01's directory after the slice passed","class":"DOC","clearCondition":"slices/01-cleaner-loop holds no stuck diagnosis that contradicts its PASS qa-review.json, or the file states that it was superseded.","disposition":"OPEN"}]}

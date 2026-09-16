# Architecture review — mutation-survivor-report (round 2, verification)

**Verdict:** ACCEPT-WITH-NOTES

## Scope of this round

`git diff 1bbb8cd..HEAD` is a single commit, `8d9b876 fix(#303): make a ship
gate waiting on the mutation step visible (US-13, PM P-01)`, touching six
files: `docs/adr/0071-report-only-mutation-survivor-step.md`, `src/run-events.ts`,
`src/ship-gate.ts`, `src/status-pipeline.ts` and their two test files. It
answers the PM guardian's P-01 (a legitimate 30-minute wait read as a stall)
by journaling the step as a `run-phase-started`/`run-phase-ended` pair and
projecting it as an opt-in aggregate stage. None of the five open architect
findings is addressed by it, so all five come back `REPEATED`.

The fix itself is structurally clean and I have nothing blocking in it:

- `RunPhaseName` (`src/run-events.ts:34-49`) turns two duplicated inline
  unions into one named type, and `src/run-snapshot.ts:14` already derives its
  phase type from the event union, so the new member flows through the
  snapshot without a second list to keep in sync — the additive-schema claim
  ("the events schema stays at 1") holds.
- `closeMutationPhase` (`src/ship-gate.ts:1025-1031`) is idempotent behind
  `mutationPhaseClosed` and no-ops when the run never declared the step, so
  the three exits that can reach it (published outcome, `NO_OUTCOME`,
  `ABANDONED` inside `terminateMutationStep`) cannot double-close or open a
  phase for a run without `--mutation-report`. The `ABANDONED` close is
  wrapped in the same swallowing `try` as the rest of that teardown, matching
  the surrounding convention that a teardown must not replace an exit's own
  reason.
- `aggregateStages` (`src/status-pipeline.ts:291-317`) splices the stage in
  before `draft-pr` and outside the `previousFailed` chain, so the step's
  verdict can never mark the draft PR blocked. That is the projection ADR
  0071's amendment describes ("no gate id and its verdict feeds no
  decision"), and the amendment is recorded, so the layering here is
  documented rather than implicit.

## Open findings, dispositioned

**A-01 (COUPLING) — REPEATED.** `detectReviewWorktreeDrift`
(`src/ship-gate.ts:219`, called at `src/ship-gate.ts:1331`) is unchanged by
this diff, and I found no exclusion of `config.reportPath` or of tool scratch
paths in either it or the review commit path. ADR 0071 gained an amendment in
this diff, but the amendment is about phase visibility; it states no
report-path/scratch-path exclusion invariant. Clear condition not met. Still a
note: no normal-operation trigger is recorded and the behavior is not
introduced by this round's diff.

**A-02 (ERROR_HANDLING) — REPEATED.** Scope derivation still sits at the top
of `runMutationStep` outside its own `try` (`src/mutation-report.ts:726-731`:
`mutationScope()` / `buildChangeSummary` before the first `try`), so a
throwing derivation rejects the step promise. The promise is still created
with no handler at `src/ship-gate.ts:1010-1021`; the first handler attaches
only in `awaitMutationStepWithinBound` (`src/mutation-report.ts:880-883`),
reached at `src/ship-gate.ts:1121` after the whole guardian phase. The diff
adds a `closeMutationPhase("NO_OUTCOME")` branch (`src/ship-gate.ts:1159-1163`)
for a step that produced no outcome, which is a good addition, but it only
runs if the process survives to the rejoin, so the clear condition (handler
from creation, failure classified as `MUTATION_NOT_RUN`) is not met. Note, not
blocker: the reachable path is a failing `git diff` in the review worktree,
i.e. an infrastructure fault, which the rubric records as a note.

**A-03 (SECURITY) — REPEATED.** `defaultMutationRun` still passes the
declared command line and the derived file list through
`spawn(command, [...files], { shell: true })`
(`src/mutation-report.ts:657-664`), so derived paths are re-parsed by the
shell and are not quoted; the module header explains why `shell: true` is used
for the command but records no choice about the paths. Clear condition not
met. Note: the paths come from the run's own change summary, and I established
no normal-operation trigger of my own.

**A-04 (CONVENTION) — REPEATED.** `grep -rn "mutation" README.md` returns
nothing, and none of the three usage strings (`src/afk.ts:39`,
`src/afk-claude.ts:36`, `src/afk-codex.ts:36`) mentions `--mutation-report`;
the flag exists only in `src/cli-options.ts:258`. `baselinePath` and
`decisionsPath` remain undocumented in README. Clear condition not met.
Documentation-surface finding, note only.

**A-05 (LAYERING) — REPEATED.** `src/logger.ts:19` still imports
`MUTATION_REPORT_HEADING` and `formatMutationReportLines` from
`./mutation-report.js` (used at `src/logger.ts:893-900`), the same module that
spawns the step; no pure render module was extracted and ARCHITECTURE.md
records no dual role. Clear condition not met. Note.

## New note from this diff

**A-06 (OBSERVABILITY, note).** The mutation stage's state derivation
(`src/status-pipeline.ts:301-306`) is `active` when any invocation is active
and `done` otherwise, with no crash/abandon state: a run killed while the step
is open leaves `run-phase-started` without its partner, and the status surface
then shows "Mutation step — active" for a run that is over. The same is true of
the four pre-existing stages, so this is consistent rather than novel, and the
ABANDONED close covers the in-process exits — recording it only so the next
change to that projection knows the gap is known.

## Structured findings (v2)

{"version":2,"findings":[{"id":"A-01","title":"Mutation step writes into the review worktree the gate drift-checks and commits with git add -A","class":"COUPLING","clearCondition":"The step's report and scratch output stay out of the committed tree, or the declared reportPath and tool scratch paths are excluded from detectReviewWorktreeDrift and the review commit, with the invariant stated in ADR 0071.","disposition":"REPEATED","reachableTrigger":null,"introducedByReviewedDiff":false},{"id":"A-02","title":"A step-promise rejection reaches the fatal unhandledRejection handler instead of producing MUTATION_NOT_RUN","class":"ERROR_HANDLING","clearCondition":"Scope derivation runs inside runMutationStep's own error handling so a failure classifies as MUTATION_NOT_RUN, and the step promise carries a handler from creation so no rejection sits unhandled across the guardian phase.","disposition":"REPEATED","reachableTrigger":null,"introducedByReviewedDiff":false},{"id":"A-03","title":"Declared mutation command and derived file paths are concatenated into a shell invocation","class":"SECURITY","clearCondition":"Scope paths are passed as argv without shell re-parsing, or each path is quoted, with the choice recorded in the module header.","disposition":"REPEATED","reachableTrigger":null,"introducedByReviewedDiff":false},{"id":"A-04","title":"--mutation-report and the afk.json mutationReport member are absent from every usage string and from README","class":"CONVENTION","clearCondition":"The flag appears in the three CLI usage strings and the manifest member including baselinePath and decisionsPath is documented in README.","disposition":"REPEATED","reachableTrigger":null,"introducedByReviewedDiff":false},{"id":"A-05","title":"logger.ts takes a value dependency on the spawning mutation-report module for a heading and a formatter","class":"LAYERING","clearCondition":"The heading, formatter and types live in a pure render module both the ship path and the logger import, or ARCHITECTURE.md records the dual role deliberately.","disposition":"REPEATED","reachableTrigger":null,"introducedByReviewedDiff":false},{"id":"A-06","title":"The mutation stage projection has no crash state, so a run killed mid-step reads as active forever","class":"OBSERVABILITY","clearCondition":"An unpaired run-phase-started for mutation-step projects as interrupted rather than active, or the projection's consistency with the four existing stages is recorded as deliberate.","disposition":"OPEN","reachableTrigger":null,"introducedByReviewedDiff":true}]}

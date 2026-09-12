# Context: PRD4-S4 — Final evaluation and exact-tree reuse (#96)

## Files and current behavior

**FACT.** The issue body (`gh issue view 96`) requires: (1) D20 exact-tree
reuse compared against `approved-baseline.json`; (2) a new final-evaluator
role with `prompts/evaluator-final.md`, `final-review.json`,
`final-report.md`; (3) a baseline→final variant of `src/change-summary.ts`,
partitioned per post-approval role; (4) repair routing where a preservation
finding routes to restore and a baseline-is-wrong finding returns to the
generator loop and invalidates downstream evidence; (5) three-attempt bound;
(6) the file-scope gate runs against the final candidate before merge; (7)
merge stays serialized through the existing merge mutex; (8) a stub
post-approval writing stage stands in for PRD 5's cleaner/hardener roles.

**FACT.** `.kiro/specs/afk-v2-acceptance-scope-gates/prd.md` D9 (line 244):
the candidate evaluator is the existing `evaluator-qa` role reshaped (done by
#91); "the **final** evaluator is a new role: a new manifest entry, a new
prompt `prompts/evaluator-final.md`, and its own two artifacts
`final-review.json` and `final-report.md`."

**FACT.** `prd.md` D10 (line 263): `approved-baseline.json`, under
`.afk/artifacts/<run-slug>/slice-<n>/`, written by the orchestrator only:
candidate checkpoint tree ID and commit, `contract.md` /
`acceptance-manifest.json` blob IDs, gate evidence artifact IDs. Keyed by
tree ID so D20's reuse decision is a tree comparison, not a heuristic.

**FACT.** `prd.md` D11 (line 272): `src/change-summary.ts` (slice 03's
module) is extended by slice 04 with the baseline → final variant
(commits, files, diff stats), partitioned per post-approval role. "Two
producers for one artifact class would have been the alternative; this is
one producer, two variants" — do not add a second producer.

**FACT.** `prd.md` D19 (line 383): "Candidate evaluation is bounded to
three rounds, final evaluation to three attempts, both through
`src/bounds.ts`. A red deterministic gate returns to the generator and
consumes a **generator** round; it never consumes an evaluator round and
never dispatches an evaluator."

**FACT.** `prd.md` D20 (line 390): compare the final checkpoint's tree ID
against `approved-baseline.json`; equal means reuse (zero final-evaluator
invocations, recorded as reuse in gate evidence and `run-summary.md`);
different means a fresh final evaluator, "no exception for a change that
looks cosmetic."

**FACT.** `prd.md`'s file-scope map (line 503-533) assigns slice 04 (#96):
`src/orchestrator.ts` (dispatch), `src/change-summary.ts` (extends),
`src/qa-review.ts` (final), `src/context-envelope.ts` (final manifest),
`src/run-state.ts` (reuse record), `src/run-events.ts` (reuse event),
`src/logger.ts` (own `run-summary.md` section), `prompts/evaluator-final.md`
(creates), `ARCHITECTURE.md` (own rows). No gate ID or `src/gate-runner.ts`
row is assigned to slice 04.

**FACT.** `prd.md` line 722 ("The general rule..."): "#91 and #96 ship no
gate and are unaffected" by the D22 in-process `GateDeclaration.run`
requirement — slice 04 does not declare a new gate.

**FACT.** `prd.md`, "Where the `scope` gate's call site goes"
(`anchors/08-file-scope-gate.md` reference, line 685): the `scope` gate's
call site is owned by #195/#132 and runs "on the final candidate after the
QA window and before the merge, **not** in the pre-QA set" — this is the
file-scope gate the issue body says "runs against the final candidate
before merge"; slice 04 does not build this call site, it is already
placed by an earlier slice.

**FACT.** `prd.md`, "Role write-scope enforcement is owned by #226, not by
any slice in this PRD" (line 764): explicitly states "It is not #91's and
not #96's, and it must not be re-homed onto either — neither slice ships a
gate, and adding a write-scope grader to a candidate-evaluator or
final-evaluation slice would widen a scope this PRD deliberately bounded."

**FACT.** `prd.md` "Out of scope" (line 656): "final-evaluator code
attribution while post-approval writers stay off" is explicitly out of
scope, matching the issue body's "Attribution across two or more
post-approval roles is #72 story 15, deferred while the cleaner and
hardener stay off."

**FACT.** `src/orchestrator.ts:4311-4312` — `APPROVED_BASELINE_FILENAME =
"approved-baseline.json"`.

**FACT.** `src/orchestrator.ts:4322-4338` — `ApprovedBaselineRecord`
interface: `{ version: 1, ghIssue, sliceNumber, round, treeId, commit,
contractBlobs: Record<string,string>, gateEvidenceArtifactIds: string[] }`.

**FACT.** `src/orchestrator.ts:4345-4404` — `writeApprovedBaseline(ctx,
round, input)` writes the JSON into `artifacts.negotiationArchiveDir(...)`,
calls `recordApprovedBaseline(...)`, and journals a
`{ type: "approved-baseline" }` event. This confirms D10's baseline writer
already exists (landed by #91), so slice 04 reads this record rather than
creating it.

**FACT.** `src/run-state.ts:825-838` — `recordApprovedBaseline(repoRoot,
prdSlug, ghIssue, record: PersistedApprovedBaseline)` merges into
`state.approvedBaselines[ghIssue]` and bumps `state.version`.

**FACT.** `src/run-state.ts:840-849` (comment) — run-state v4 already added
two additive fields: "the per-slice approved baseline locator (#91) and
applied protected-change waivers (#193)." Confirms #91's baseline mechanism
has landed in `run-state.ts` ahead of this slice.

**FACT.** `src/artifacts.ts:517-523` — `negotiationArchiveDir(repoRoot,
runSlug, sliceNumber)` returns `join(repoRoot, ".afk", "artifacts", runSlug,
"slice-${sliceNumber}")` — the exact directory D10 cites for
`approved-baseline.json`.

**FACT.** `src/artifacts.ts:669` — `qaArchivePrefix(stage:
QAReviewStage): "qa" | "uat"` maps `"deterministic" → "qa"` and everything
else → `"uat"`. The issue's "Code anchors" section (in the fetched issue
body) flags this as "one real trap": naively adding a final-evaluation
member to `QAReviewStage` archives artifacts as `uat-review-*`, which is
wrong; the archive prefix map must be extended to a three-way map (recorded
decision in the issue: use archive prefix `final`, matching
`final-review.json` / `final-report.md`) in the same change.

**FACT.** `src/qa-review.ts:65` — `export type QAReviewStage =
"deterministic" | "shared-preview";` — the union the issue body says must
gain a third member for final evaluation, with `qaArchivePrefix` extended
at the same time.

**FACT.** `src/qa-review.ts:113-124` — `QAReviewStageResumeState { history,
unresolved, lastImplementationRound }` and `QAReviewResumeState { nextRound,
retryStage: QAReviewStage | null, deterministic, sharedPreview }`. The issue
body's "Recorded decision" says final evaluation reuses this per-stage
resume machinery (`QAReviewStageResumeState` / `retryStage`) because it
already models bounded-attempt resume, which D19 needs for final
evaluation's three-attempt cap.

**FACT.** `src/change-summary.ts:1-24` (header comment) — the module
already exists (landed by #91/slice 03), ties itself explicitly to
"#91 AC7, PRD D11," and states slice 04 will extend it with a "baseline →
final" variant reusing the same two-ref builder. `src/change-summary.ts:45-63`
— `ChangeSummary { version: 1, fromRef, toRef, commits, files, totals: {
files, insertions, deletions, binaryFiles } }`; `ChangeSummaryCommit { sha,
subject }`; `ChangeSummaryFile { path, status, insertions: number|null,
deletions: number|null }`.

**FACT.** `src/change-summary.ts:69-83` — `readGit` calls `execFileSync`
directly rather than `src/git.ts`, with an explaining comment: `src/git.ts`
has no generic two-arbitrary-ref reader (`logCommitsWithStat` is hard-wired
to `<base>..HEAD`; `listChangedFiles` unions worktree+index;
`diffTreePaths` has no commits/stats). `src/change-summary.ts:89-95` —
`isCommitish(cwd, ref)` guards the commit-log read (empty commits list when
either ref is a bare tree, e.g. comparing checkpoint trees rather than
commits) — relevant because a baseline→final comparison may compare tree
IDs rather than commit-ish refs.

**FACT.** `src/gate-runner.ts:97-107` — `GateFindings { outOfScopePaths?,
deletedTests?, protectedChanges?, appliedWaivers? }`. `src/gate-runner.ts:
109-145` — `GateDeclaration { id, stage, required, command?, args?, run?,
expectedCostMs?, wallClockTimeoutMs?, environmentSensitive?,
prerequisiteGateIds? }`, comment states exactly one of `command`/`run` may
be supplied. `src/gate-runner.ts:171-176` — `GateEvidence { version:
GateEvidenceVersion, attemptId, treeId, results: GateResult[] }`. Per
D22/prd.md line 458-465, `GateEvidenceArtifact` (`src/gate-runner.ts:92`,
confirmed present at `:171-224`) carries `evidencePath` + `evidenceSha256`
and no `id` field; `evidenceArtifactId` cited elsewhere is the repo-relative
`evidencePath`, not the sha256 — relevant if slice 04 cites gate evidence
artifact IDs when reading `approved-baseline.json`'s
`gateEvidenceArtifactIds`.

**FACT.** `src/bounds.ts` (full file, read directly): exposes only
`SliceBounds`, `implementationRoundsRemaining`, `computeSliceBounds`,
`formatSliceBounds`, importing `MAX_RESUME_ATTEMPTS` from `src/resume.ts`.
There is **no** existing three-round/three-attempt constant for candidate
or final evaluation in this file as of this read — `SliceBounds` has
`contractRoundsRemaining`/`contractRoundLimit` and
`implementationRoundsRemaining`/`implementationRoundLimit`, but nothing
named for candidate-evaluation or final-evaluation rounds specifically.

**FACT.** Grep across `src/contract-review.ts` and `src/qa-convergence.ts`
for `attempts|MAX_ATTEMPT|attemptBound|three attempt` returned no matches
(per exploration subagent). D19's "three rounds"/"three attempts" language
for candidate/final evaluation has no existing named constant to point to
in `src/bounds.ts` today — it reads as a target this slice (and #91, for
the candidate half) must add, not a pattern already implemented.

**FACT.** `src/accepted-candidate.ts:53-57` — `ImplementationAttemptPlan {
firstRound, attemptLimit, finalRound }`; `:107-126` (module body) computes
`attemptLimit` via `implementationRoundsRemaining(...)`, special-cases
`attemptLimit === 0` to force `attemptLimit = 1`, and computes `finalRound
= firstRound + attemptLimit - 1`. This is the existing round-accounting
pattern for the generator's implementation-round loop; final evaluation's
three-attempt bound is a distinct budget (D19 says explicitly it is
tracked "both through `src/bounds.ts`" but as a separate number from
implementation rounds).

**FACT.** `src/post-qa-gates.ts:43-44` — `QA_WINDOW_ARTIFACT_NAME =
/^(?:qa|uat)-report(?:-r[1-9]\d*-a[1-9]\d*)?\.md$|^(?:qa|uat)-review\.json$|^stuck\.md$/`
— the copy-back allowlist regex out of the disposable QA/UAT worktree.
Comment at `:38-41` ties this to "#91 AC3/AC6, PRD D9": the same constant
is both the copy-back boundary and the post-QA window check, "one constant
shared with this window check cannot disagree with itself." Per the issue
body's AC4 ("the final evaluator writes `final-review.json` and
`final-report.md`, and those are the only files that copy back from its
worktree"), this regex is the pattern slice 04 must extend (or a sibling
constant must follow the same shape) for the `final` stage's two artifacts.

**FACT.** `src/post-qa-gates.ts:57-102` — `reviewArtifactViolations(input)`
computes `git.diffTreePaths(fromTree, toTree)` and flags any path outside
the `QA_WINDOW_ARTIFACT_NAME` allowlist (or an `orchestratorAuthorizedBlobs`
exact-byte exemption) as a violation; comment: "An evaluator edit to the
locked contract, the acceptance manifest, the explorer context, the
handoff, or any source path voids the verdict's authority over the new
tree, and the caller must fail closed." This is the mechanism the final
evaluator's worktree-write check must reuse or mirror per AC4.

**FACT.** `src/context-envelope.ts:613-635` —
`CANDIDATE_EVALUATOR_CONTEXT_MANIFEST = { version: 1, role: "evaluator-qa",
objective: "...", nonGoals: [...], allowedWriteScope: ["slice/qa-review.json",
"slice/qa-report.md"], stopConditions: [...], escalationConditions: [...] }`
— this is the "existing schema" D9 says a final-evaluator entry extends.
The final manifest entry's `role` will be a new value (not `evaluator-qa`),
`allowedWriteScope` will be `["slice/final-review.json",
"slice/final-report.md"]` per the issue body, and `inputOrder` must lead
with `change-summary` per D11 (mirroring the candidate manifest, `prd.md`
line 250-251).

**FACT.** `src/context-envelope.ts:480-505` (a manifest entry's shape, seen
on the contract-review manifest) shows `inputOrder` can be either a flat
array or an object with an `initial` key (seen at `:156-160` for the
generator manifest) and an optional `inputOrderSlots` mapping abstract slot
names to shared repository-context sections (`:502-505`:
`{ "repository-adr": "repository-context", "repository-architecture":
"repository-context" }`). A new final-evaluator manifest entry follows one
of these two shapes.

**FACT.** No `prompts/evaluator-final.md` exists yet (`Glob` over
`prompts/*.md` lists: `architect-review.md`, `evaluator-contract-revision.md`,
`evaluator-contract.md`, `evaluator-qa.md`, `explorer.md`,
`generator-repair.md`, `generator.md`, `planner-revision.md`, `planner.md`,
`pm-review.md`). `prompts/evaluator-qa.md` (existing role's prompt) has the
structure: `# Identity`, `# Assigned Scope` (`{{QA_SCOPE}}`), `# Where you
are working` (disposable-worktree explanation naming
`{{SLICE_DIR}}/qa-review.json` and `{{REPORT_PATH}}` as the only artifacts
that leave the worktree, plus `{{CHANGE_SUMMARY_PATH}}`), `# What you are
judging` (numbered questions), `# Probes`. `prompts/evaluator-final.md` is
new work for this slice, matching that shape's convention but for the two
preservation/gate-invisible-drift questions the issue body names.

## Patterns and test harness

**FACT.** `CLAUDE.md` (this repo's own contributor doc) prescribes: run the
specific test file while iterating; run `pnpm test:fast` plus the heavy
suites touched (e.g. `pnpm run test:heavy:wave`) before handing off a slice
as an AFK pipeline agent; never run the full suite as a slice agent (the
evaluator-qa and pre-ship gate already do).

**FACT.** `prd.md` "Testing decisions" (line 624-654): "Unit first" — policy
validation, the reuse decision (D20), and the change-summary builder are
named as pure functions to assert without git or agents. "The lying-stub
scenarios belong on existing spawned fixtures" — an `it` on an existing
`describe` in `src/orchestrator.test.ts`, `src/orchestrator-runs.test.ts`,
or `src/qa-orchestration.test.ts`, not a new spawn. `pnpm test:budgets`
stays the ceiling; a red budget moves the assertion up the ladder rather
than raising the number.

**FACT.** `AGENTS.md`/`CLAUDE.md` "Where a new assertion goes" ladder
(referenced by `prd.md` line 626 and by `CLAUDE.md`'s own section): unit
test → an `it` on an existing spawned scenario's shared result → another
slice in a fixture that already runs a wave → a new spawn, with a comment
saying why.

**FACT.** Existing test files most relevant to this slice's surface
(confirmed present under `src/`, per exploration): `src/qa-review.test.ts`,
`src/qa-convergence.test.ts`, `src/qa-orchestration.test.ts`,
`src/change-summary.test.ts` (confirms the candidate variant already has
unit coverage to extend), `src/gate-runner.test.ts`, `src/post-qa-gates.test.ts`,
`src/bounds.test.ts`, `src/accepted-candidate.test.ts` (implied by module),
`src/orchestrator.test.ts`, `src/wave.test.ts` / `src/wave-migrations.test.ts`
(split-suite pair `CLAUDE.md` documents), `src/resume-integration.test.ts`.

**FACT.** `src/qa-review.ts:57-124` schema constants: `QAReview { version:
2, verdict, failureClass, infrastructureEvidence, findings }`;
`QAReviewAttemptFinding { id, severity, state, unresolved, summary,
clearCondition, artifactReferences, remedy }`; `QAReviewAttemptRecord {
version: 2, stage, round, attempt, verdict, failureClass, findings,
baseGateCitation? }`; schema key arrays `REVIEW_KEYS`, `FINDING_KEYS`,
`RECORD_KEYS`, `RECORD_KEYS_WITH_CITATION`, `CITATION_KEYS =
["evidenceArtifactId", "attemptId", "treeId", "gateIds"]`,
`RECORD_FINDING_KEYS_V1`/`V2`, `VERDICTS = ["PASS","FAIL"]`,
`FAILURE_CLASSES = ["NONE","IMPLEMENTATION","INFRASTRUCTURE"]`,
`SEVERITIES = ["BLOCKING","ADVISORY"]`. A `final-review.json` schema is
expected to follow this same key-array validation convention (explicit
literal arrays, not inferred from a type), matching the codebase's stated
aversion to schemas that "parse over what they do not understand" (D1).

## Data and integration

**FACT.** `src/wave.ts` merge-mutex sites (grep, confirmed present):
`:65` "the merge mutex the refused attempt already holds"; `:113` "the
merge mutex will refuse the merge"; `:123` "does not replace the merge-mutex
check, which is unchanged"; `:373` "mutex around merge + worktree-remove
serialises..."; `:526` "PASS — merge under the mutex"; `:600` "retries the
merge — all without releasing the mutex." Final evaluation's merge, per the
issue body ("the merge stays serialized through the existing merge mutex"),
is expected to reuse this same mutex rather than add a second one.

**FACT.** `prd.md` D15 (merge-resolution as a data block, not a new
template): the resolved tree "re-runs the slice's candidate gate phase
(`src/candidate-gate-phase.ts`) and its behavior bindings before the merge
retries inside the same mutex critical section." Slice 04's final
evaluation sits downstream of (or alongside) this resolved-tree re-check;
the PRD does not describe slice 04 re-entering merge-resolution itself.

**FACT.** Repair routing per the issue body: "Restore is the only legal
repair for a preservation finding. A baseline-is-wrong finding returns to
the generator loop and invalidates downstream evidence." This mirrors the
codebase's existing pattern of typed remedies carried on a finding (ADR
0048: `remedy: "SOURCE_CHANGE" | "SCOPE_AMENDMENT"` on QA findings) and
typed repair routing (ADR 0025 agent failure causes; ADR 0041 uncertain
classification picks the non-looping branch) — no existing finding schema
in this repo has a `RESTORE` vs. `BASELINE_IS_WRONG` remedy vocabulary yet;
this is new schema work for `final-review.json`.

**INFERENCE.** "Invalidates downstream evidence" (issue body, baseline-is-
wrong repair) most likely means the gate evidence and/or approved-baseline
record keyed to the now-rejected candidate tree ID must be treated as stale
once a fresh contract/generator round produces a new candidate tree — drawn
from D10's "keyed by tree ID" design (a new tree ID naturally has no
baseline record) and D17's cache key being "gate ID plus tree identity"
(a changed tree already invalidates gate cache entries by construction).
No source file was found that names an explicit "invalidate" verb for this
path; UNKNOWN whether a new function is needed or invalidation is already
implicit via tree-ID keying.

## Unknowns

- **UNKNOWN.** Whether `src/bounds.ts` is expected to gain new named
  exports (e.g. a final-evaluation attempt-limit constant/function) as part
  of this slice, or whether the three-attempt bound is meant to be threaded
  through `ImplementationAttemptPlan`-style ad hoc computation the way
  `src/accepted-candidate.ts` does for implementation rounds. `prd.md` D19
  states the bound is "through `src/bounds.ts`" but no such constant exists
  there today (confirmed by direct read).

- **UNKNOWN.** The exact shape of the final-evaluator's `role` string in
  the new context-envelope manifest entry (e.g. `"evaluator-final"`) — not
  stated verbatim in `prd.md` or the issue body; `CANDIDATE_EVALUATOR_CONTEXT_MANIFEST.role`
  is `"evaluator-qa"` by precedent but the final role's literal string is
  not fixed by any read source.

- **UNKNOWN.** Where exactly the D20 reuse comparison (tree-ID equality
  check) is called from in `src/orchestrator.ts` — no call site for reading
  back `approved-baseline.json` for a *comparison* (as opposed to writing
  it) was found in the explored excerpts. `writeApprovedBaseline` is
  confirmed; a reader/comparator for the final-checkpoint path was not
  located.

- **UNKNOWN.** The precise stub post-approval writing stage's interface
  (issue body: "A post-approval writer is exercised through a stub writing
  stage until PRD 5 exists"). No stub writer module was found in the
  explored files; whether this is a new tiny module, a test-only fixture,
  or an inline no-op function in `src/orchestrator.ts` is not determined
  from source.

- **UNKNOWN.** Whether `qaArchivePrefix` (`src/artifacts.ts:669`) and
  `QA_WINDOW_ARTIFACT_NAME` (`src/post-qa-gates.ts:43-44`) are the two sites
  slice 04 must edit for the `final` archive prefix and copy-back allowlist,
  or whether a parallel, separately named constant is expected for the
  final stage instead of extending the QA-stage ones in place. The issue
  body's own "Code anchors" section states the archive-prefix extension as
  a recorded decision; the copy-back-allowlist extension is inferred by
  analogy (AC4) but not stated as explicitly.

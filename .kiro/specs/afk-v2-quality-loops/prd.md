# PRD 5: Quality loops — cleaner only, default off

**GH issue:** #73 — the parent contract. Its Problem Statement, Solution,
20 user stories, Implementation Decisions, Testing Decisions and Out of
Scope are authoritative and are **not restated here**.
**Slice issues:** #87 (cleaner loop), #97 (changed trees face final
evaluation; ROI evidence) — see `issues.md`. **#92 (hardener loop) is not
selected**; see "Deferred" below.
**Parent design:** `docs/specs/afk-v2-plan.md` §2 (PRD 5 row), §3 item 8
(role-cost governance), item 13 (reading-time metric), item 14 (bounds
visibility / stage-duration event), §3c policies 1, 2, 5, §4 ("PRD 5
(cleaner only, default-off, story 17 ROI experiment)"), §6
("Cleaner/hardener defaults are decided by #73 story 17's evidence").
**Binding ADRs:** 0038 (generator verification command), 0046 (invocation
stats, `nonCommandTimeMs`), 0048 (a finding names its remedy), 0052 /
0060 (scope discovery), 0063 (advisory gates), 0012 (candidate-tree
authorization).
**Binding PRD 4 decisions** (`.kiro/specs/afk-v2-acceptance-scope-gates/prd.md`):
D4 (role write-scope is a tree-to-tree diff), D5 / D24 (waivers are launch
inputs; a deterministic finding blocks the merge), D10 / D20 (baseline
keyed by tree; exact-tree reuse), D11 (one change-summary producer),
D17 (gate cache), D19 (round accounting), D22 (in-process gates and
`GateFindings`).
**Written:** 2026-09-12, against `origin/main` at `46f6c38` (PRD 4 merged;
#223 CLOSED).

This document exists for one reason: **to leave the planner no
load-bearing decision to discover.** Everything below is a settled
operator decision. Where this document and #73 differ on a fact, this
document controls and #73 should be amended; where it and a binding ADR
or PRD 4 decision differ, the ADR or PRD 4 decision controls.

## Scope — decided by the plan, not reopened here

Plan §2 keeps #73 stories **3, 4, 5, 16, 17, 20** and defers **9–15 and
19** (all hardener/mutation machinery). Plan §4 sequences "PRD 5 (cleaner
only, default-off, story 17 ROI experiment)". Therefore:

- **#87** ships the cleaner loop, the `suppressions` gate and the starter
  quality-policy template (stories 1–8, 16, 20, and the cleaner half of 17
  and 18).
- **#97** ships the cleaner's interaction with the final evaluator and the
  per-stage ROI evidence (stories 17, 18, 20 as they apply to the cleaner).
  Its GH body's `Blocked by` was reduced to `#87` on 2026-09-12, and its
  hardener-referencing criteria were narrowed to the cleaner, to match this
  scope.
- **#92** stays OPEN, unlabeled beyond `ready-for-agent`, and out of this
  run. It re-enters only when the story-17 evidence or an incident demands
  it (plan §6 "Deferred stories").

**The self-run itself launches with the cleaner off.** `afk.config.json`
gains no `clean` member in this PRD (D1), so the orchestrator running this
PRD dispatches no cleaner — which is also why it cannot: the launched binary
predates #87. The story-17 evidence comes from a *later* run whose
`afk.config.json` declares `gatePolicy.clean`; that enablement is the
"one config line/run" plan item 8 budgets, and D10 is what records it.

## What was still undecided, and what is decided now

Each decision names the test it would otherwise have fired (plan §3c
policy 1 / AGENTS.md "do not leave a load-bearing decision unmade"). Line
anchors are against `46f6c38`.

### D1 — the cleaner is enabled by `gatePolicy.clean` in `afk.config.json`, and absence means off

`src/gate-policy.ts` `POLICY_KEYS` (`:32-38`) gains one member, `clean`,
parsed by a new `parseClean` modelled on `parseCost` (`:624-`): every
sub-key optional with a stated default, every unknown sub-key fatal and
named (`requireKnownKeys`, `:223-`). `GatePolicy` (`:199-`) gains
`clean?: GatePolicyClean`. **Absent `clean` means the cleaner stage does not
exist for that project** — #87 AC1 "behavior identical to today" — and the
committed `afk.config.json` of this repository stays without it (see
"Scope"). Shape, version-1:

```json
"clean": {
  "gates": [
    { "id": "format", "command": "pnpm", "args": ["exec", "prettier", "--check", "{changedFiles}"], "required": true, "expectedCostMs": 20000 },
    { "id": "complexity", "command": "pnpm", "args": ["exec", "eslint", "--rule", "complexity: [error, 10]", "{changedFiles}"], "required": false, "expectedCostMs": 30000 }
  ],
  "additionalWriteScope": [],
  "suppressionDetectors": [
    { "id": "ts-eslint", "globs": ["**/*.ts"], "patterns": ["//\\s*eslint-disable", "@ts-ignore", "@ts-expect-error", "biome-ignore", "istanbul ignore", "c8 ignore"] }
  ]
}
```

- `gates` — **required, at least one entry**, records of `{ id, command,
  args, required, expectedCostMs? }`. `id` must not collide with any id the
  catalog already declares (`BASE_GATE_IDS` `src/base-gates.ts:20`,
  `scope`, `feedback-integrity`, `tests:skipped`, `acceptance:behaviors`,
  `test:budgets`, or `suppressions` from D5). Each becomes a
  `GateDeclaration` (`src/gate-runner.ts:109-145`) at a new stage string
  **`"clean"`** (`stage` is a plain string, not an enum — `"base"`,
  `"deterministic"` and `"acceptance"` are the values in use). The literal
  token **`{changedFiles}`** in an `args` entry expands, at run time, to one
  argument per path the cleaner's *input* checkpoint differs from the
  feature base by (`diffTreePaths`, `src/git.ts:1323-1346`), repo-relative
  with forward slashes; an `args` entry may be exactly the token and nothing
  else, mirroring `{behaviorId}` (`src/gate-policy.ts:65`,
  `src/base-gates.ts:247`). An empty expansion records the gate `SKIPPED`
  with detail "no changed files", never `PASS`. `expectedCostMs` defaults to
  `DEFAULT_CHEAP_THRESHOLD_MS` so a clean gate is *not* in the generator's
  derived verification command (D18) unless the project says it is cheap.
- `additionalWriteScope` — default `[]`; globs in the D6 dialect
  (`assertGlobDialect`, `src/gate-policy.ts:290`) that widen the cleaner's
  write scope beyond D3's default. Widening is "a per-project policy
  choice" (#73 Implementation Decisions), so it is config, not a flag.
- `suppressionDetectors` — default: AFK's TypeScript set above, id
  `ts-eslint`; records `{ id, globs, patterns }` with the same shape rule as
  `skipDetectors` (`SKIP_DETECTOR_KEYS`, `:49`; `parseSkipDetector`, `:563`). See D5.

**Rejected:** a CLI flag (`--enable-cleaner`). Plan §3c policy 2 puts gate
policy in the repository so two concurrent runs see one rulebook, and a
flag would be a second switch the D10 record would have to reconcile with.
**Rejected:** a top-level `afk.config.json` key beside `gatePolicy`. The
cleaner is driven by gates; every gate declaration in this project lives
under `gatePolicy`, and `loadGatePolicy` (`:756`) is the one reader.

*Test fired: load-bearing silence about a data format.*

### D2 — the cleaner is the second entry of the post-approval stage list, inserted at the seam #96 left for it

`src/final-evaluation.ts:31-39` says it: `POST_APPROVAL_WRITING_STAGE_ID`
is "exactly one stage today — a production no-op until PRD 5 … adding the
second stage is a change to this list and its `byStage` keys." So:

- `src/final-evaluation.ts` gains `export const CLEANER_STAGE_ID = "cleaner";`
  beside `POST_APPROVAL_WRITING_STAGE_ID`.
- The **call site** is the block at `src/orchestrator.ts:6765-6795` —
  after the accept-seam window check and the `feat(#…)` commit
  (`:6740-6760`), before `finalTreeId` is resolved (`:6796`). The cleaner
  runs **first**, then the injectable stub (`config.postApprovalWritingStage
  ?? noopPostApprovalWritingStage`), which stays exactly as it is: it is the
  test seam `src/qa-orchestration.test.ts:3672` ("final evaluation and
  reuse", `:3297`) already depends on, and with the cleaner off it is still
  the whole stage list, so today's behavior is byte-identical.
- The stage body is a **new module `src/cleaner-stage.ts`** exporting one
  async entry, `runCleanerStage(ctx, round, input)`, with one call site in
  the hub — ARCHITECTURE.md "Hubs": new behavior goes in a new module with
  one call site here. Its input checkpoint is the accepted tree
  (`acceptedTreeId`, `:6741`); its output is the last cleaner checkpoint;
  it returns `{ ran: boolean; outcome; inputTreeId; outputTreeId; roundsSpent }`.
- `buildFinalChangeSummary` (`src/change-summary.ts:291`, called through `writeFinalChangeSummary`, `:364`) is called with
  `stages` tiling `baselineRef → finalRef` as `[{ stageId: CLEANER_STAGE_ID,
  fromRef: <accepted commit>, toRef: <cleaner output> }, { stageId:
  POST_APPROVAL_WRITING_STAGE_ID, fromRef: <cleaner output>, toRef: final }]`
  when the cleaner ran, and today's single stub entry when it did not
  (`:7053-7067`). A zero-width stub entry is legal (the tiling rule is
  contiguity, not width).
- `PostApprovalWritingStage` (`:454-469`) keeps its synchronous signature.
  The cleaner is not shoehorned into it: it needs `await invoke(...)`, and
  the stub's contract is "a function this module calls".

**Rejected:** replacing the stub. It would rewrite the #96 fixtures for no
behavioral gain and remove the one injectable seam that lets a test force a
tree change without a provider.

*Test fired: spec contradiction* — a stage added anywhere else would leave
`FinalChangeSummary.byStage` unable to attribute the cleaner's bytes (D11).

### D3 — the cleaner's write scope is the locked `fileScope`, enforced by the `scope` gate's `role` source, and the slice artifact directory is out of scope for a role

- **Default write scope** is exactly the locked `acceptance-manifest.json`
  `fileScope` — which already includes the test files the planner declared
  (PRD 4 "File-scope map": a planner declares its paths plus the test files
  it edits). #73's "plus their tests" is satisfied by that declaration; **no
  heuristic derives test paths from source paths.** `gatePolicy.clean.
  additionalWriteScope` (D1) is the only widening.
- **Enforcement** is the existing `scope` gate through its `role`
  comparison source: `ScopeComparisonSource` `{ kind: "role"; cwd;
  inputCheckpointTree; outputCheckpointTree }` (`src/scope-gate.ts:38-63`),
  compared by `diffTreePaths` (`:100-118`), declared through
  `scopeGateDeclaration` (`:173-183`). **#87 is the first production caller
  of the `role` source.** #226 ("Wire role write-scope enforcement to its
  caller", OPEN, `ready-for-human`) keeps its remaining scope — every
  *other* writing role — and **#87 must not close #226**; it must note the
  cleaner call site on #226 in its handoff so the issue's remaining scope
  is explicit.
- **One rule is added to the `role` source in `src/scope-gate.ts`:** for
  `kind: "role"`, paths under `sliceArtifactDir` are **not** exempt — they
  are `outOfScopePaths`, except the single file D8 names
  (`cleaner-escalation.json`). The `candidate` source keeps today's
  exemption. Rationale: the exemption exists because the orchestrator and
  the evaluators legitimately write there during a candidate round; a
  writing role has no business in `contract.md`, `acceptance-manifest.json`,
  `qa-review.json`, `qa-report.md`, `final-review.json` or
  `approved-baseline.json`, which is #87 AC6 verbatim.
- `additionalWriteScope` globs are matched with `matchesGlob`
  (`src/gate-policy.ts`) against the changed paths before
  `outOfScopeChangedPaths` (`src/escalation.ts:259`) sees them; a matched
  path is in scope.

*Test fired: declared risk class (security posture — role scope).*
Decided here so the planner does not re-derive D4.

### D4 — one cleaner round is: gates on the input tree, one dispatch, one checkpoint, gates on the output tree

Bounded by **`MAX_CLEANER_ROUNDS = 3`** and `cleanerRoundsRemaining({ spent,
limit? })` in `src/bounds.ts`, copying `MAX_FINAL_EVALUATION_ATTEMPTS`
(`:61`) and `finalEvaluationAttemptsRemaining` (`:68-73`). Rounds and
infrastructure retries are the D19 vocabulary: a cleaner round is spent by
a cleaner dispatch whose output tree was gated; an `INFRASTRUCTURE` gate
status retries under the existing bounded retry (`runCandidateGatePhase`,
`src/candidate-gate-phase.ts:47-72`, `infrastructureRetries`) and spends
nothing; a dispatch that dies spends its round (the #96 rule for a dead
evaluator, `src/orchestrator.ts:7228-7240`).

**Round 0 — gate the approved candidate first.** `runCandidateGatePhase`
runs the `clean` declarations (D1) on the accepted tree, with
`cache: { path: <run>/gate-cache.json, enabled: costPlan.cacheEnabled }`
(the same options as `:6230-6232`; D17). All required clean gates `PASS` ⇒
the stage outcome is `PASS` with **zero cleaner invocations** (story 20),
and D2's stage list still records the cleaner as having run with
`inputTreeId === outputTreeId`. Any required clean gate `FAIL` ⇒ round 1.

**Round n (1..3):**

1. **Dispatch** the cleaner (D7) in the **slice worktree** `ctx.worktreeDir`
   — it writes source, so it works where the generator works, not in a
   disposable review worktree. Journal `phase-started` / `phase-ended` with
   `agent: "cleaner"` (`src/run-events.ts:64-95`) so `stage-duration`
   (`:346-360`, derived in `src/run-journal.ts:140-168`) exists for the
   stage without new code; `logger.agentLog(slice.number, "cleaner", round)`.
2. **Checkpoint.** The cleaner is told to commit with rationale; the
   orchestrator sweeps anything uncommitted into
   `chore(#<issue>): cleaner round <n>` (the `hasUncommittedChanges →
   commitAll` pattern at `:6786-6791`), then `createCandidateCheckpoint`
   as the final-evaluation loop does (`:7031`). The output tree ID is that
   checkpoint's tree.
3. **Gate the output tree**, one `runCandidateGatePhase` call whose
   declarations are, in this order: the `clean` gates; `scope` (`role`
   source, D3); `feedback-integrity` (`src/feedback-integrity-gate.ts:80`,
   fed the run policy per #251); `tests:skipped` (`src/skip-gate.ts:38`);
   `suppressions` (D5); then the **regression bundle** = every gate the
   approval rested on — `resolvePreQAGateDeclarations(cwd)`,
   `resolveAcceptancePlan(cwd)`'s `acceptance:behaviors`, and
   `resolveFullSuiteGateDeclarations(cwd)` (`src/base-gates.ts:216, 289,
   230`). Cache options as in round 0. The full suite per round is the cost
   story 17 measures; it is not avoided here.
4. **Decide.**
   - Regression bundle **red** (any required gate outside the `clean` set,
     including `scope`, `feedback-integrity`, `tests:skipped`,
     `suppressions`): **the orchestrator reverts** — `git reset --hard` of
     the worktree to the round's input checkpoint commit — records outcome
     `REVERTED` for the round with the red gate ids, and the round is
     spent. The next round's prompt carries the regression evidence (the
     red gates' `detail` and log artifact ids). Nothing re-baselines, and
     no expectation is edited: "restore or revert, never redefine" is
     realized as *revert*, mechanically. **Rejected:** dispatching the
     cleaner to restore — an invocation to do what `git reset` does, and a
     second writer over the same regression.
   - Regression bundle green, required `clean` gates green ⇒ outcome
     `PASS`; the output tree is the cleaner's final checkpoint.
   - Regression bundle green, a required `clean` gate still red, rounds
     remain ⇒ next round from this output tree.
   - Rounds exhausted with a required `clean` gate red ⇒ outcome
     `EXHAUSTED`: the slice ends through the existing `finishStuck` path
     (`src/orchestrator.ts:7439`), `stuck.md` listing every remaining red
     gate id, its `detail` and its log artifact id, the last checkpoint
     preserved (story 18). **Rejected:** merging anyway — story 4 says a
     configured required gate fails closed. An *optional* clean gate still
     red never blocks; it is recorded (D9).

**Every attempt is archived** under `.afk/artifacts/<run-slug>/slice-<n>/`
via `artifacts.archiveQAReviewAttempt` with a new `QAReviewStage` value
`"cleaner"` (`src/qa-review.ts:76-79`, `qaReviewFilename`) so the archive
name carries round and attempt as `qa-report-rN-aM.md` does today (#87 AC2).
The archived files are the cleaner's agent log and, when present, D8's
escalation file.

*Test fired: load-bearing silence* on round accounting and on what
"restore or revert" means mechanically.

### D5 — the no-new-suppressions gate is one new in-process gate, `suppressions`, and the other two detections already exist

#87 names three detections: suppression directives, threshold edits,
deleted tests. Two already ship as required deterministic gates and are
**not rebuilt**: deleted tests are `feedback-integrity`'s D6 rule; threshold
edits are `feedback-integrity`'s `gate-policy` rule over
`gatePolicy.protectedPaths.gatePolicyPaths` — a project whose thresholds
live in `vitest.config.ts` or `.eslintrc` lists those files there, and the
starter template (D6) does. Disabled tests are `tests:skipped`.

The third is **new: `src/suppression-gate.ts`**, id **`suppressions`**,
stage `"deterministic"`, modelled line-for-line on `src/skip-gate.ts`:
count matches of each detector's `patterns` over files matching its `globs`
on the input tree and on the output tree; **only an increase fails**; a
file the candidate changed that no detector's `globs` cover is *not* a
failure (unlike `tests:skipped`, whose oracle is the project's own
`testGlobs`; suppressions have no such oracle, and failing closed on every
untyped file would fire on every candidate). Findings carry the exact
`{ path, line, detectorId }` triples.

- `GateFindings` (`src/gate-runner.ts:97-107`) gains optional
  `suppressions?: { path: string; line: number; detectorId: string }[]`.
  **`GATE_EVIDENCE_VERSION` goes 3 → 4**; `SUPPORTED_GATE_EVIDENCE_VERSIONS`
  becomes `[1, 2, 3, 4]`; only version 4 may carry `suppressions`. The
  header comment at `:28-41` gains the `3 → 4` paragraph.
- **Waiver:** `GateRiskClass` (`src/gate-policy.ts:89-96`) gains
  `"suppression"`, so a human can authorize one exact path through the
  one existing waiver reader (`parseAfkManifest`, `src/afk-manifest.ts`,
  D5 / D24 of PRD 4). The gate does **not** consult `gatePolicy.riskClasses`
  to decide whether to run — it runs whenever the cleaner stage runs; the
  class is only waiver vocabulary. The committed `afk.config.json`'s
  `riskClasses` array is therefore **not edited** (it is a protected path;
  an edit would need an `afk.json` waiver this PRD deliberately does not
  pre-record).
- **Where it runs:** only in the cleaner's per-round gate set (D4). It is
  **not** added to the generator candidate's post-QA set in this PRD: #87
  AC1 requires a project without `clean` to behave identically to today,
  and a gate that runs only when a cleaner is configured is coherent because
  it guards the cleaner's own diff. Extending it to every candidate is a
  follow-up issue, not a silent widening.

*Test fired: declared risk class (schema history — gate evidence version).*

### D6 — the starter quality-policy template is a shipped file, and `templates/` starts shipping

`templates/quality-policy/afk.config.json`: a complete `afk.config.json`
whose `gatePolicy` carries `protectedPaths` (including the threshold-bearing
files D5 relies on), `riskClasses` (all four), `acceptance`, `cost`, and a
`clean.gates` list naming **format, lint, typecheck, changed-code coverage,
complexity/CRAP, duplication, architecture rules** as named gates with
`required` set and `{changedFiles}` used wherever the tool accepts paths —
tools named as project choices in comments-as-`_note` string members are
**not** allowed (an unknown member refuses the launch, D1); the notes go in
`README.md` instead. Documented in a new `README.md` section "Quality
policy starter" that says how to copy it and that `clean` is what turns the
cleaner on.

`package.json` `files` (`:38-42`) gains `"templates"`. Today `templates/`
is not shipped although `README.md:24, 427-433` tells consumers to copy
from it; #87 fixes that omission because "shipped with AFK" (#87 AC7) is
not satisfiable otherwise. `templates/agents/*` ride along unchanged.

*Test fired: load-bearing silence* on where the template lives and whether
it ships.

### D7 — the cleaner role is prompt-only, manifest-declared, dispatched like `evaluator-final`

- **Role name** `cleaner`. `completionEvidence.role` in the slice `invoke`
  wrapper (`src/orchestrator.ts:1073`) and `invocation-completed.role`
  (`src/run-events.ts:120-147`) each gain `"cleaner"`, so token counts and
  `nonCommandTimeMs` are journaled per invocation (plan item 13, ADR 0046).
  `ContextEnvelopeRole` (`src/context-envelope.ts:759`) gains `"cleaner"`;
  `PromptAssemblyRole` (`:746`) does not — like `evaluator-final`, the
  cleaner is a **manifest-only** role whose prompt is rendered directly by
  `renderPrompt("cleaner", …)` (`src/prompt-template.ts:11`), not assembled
  by `assembleContextEnvelope`.
- **Manifest entry** `CLEANER_CONTEXT_MANIFEST` beside
  `FINAL_EVALUATOR_CONTEXT_MANIFEST` (`:690-744`), validated by
  `validateContextEnvelopeManifest` (`:955`): `allowedWriteScope` = the
  locked `fileScope` plus `additionalWriteScope` plus
  `slice/cleaner-escalation.json`; `outputArtifact: "cleaner-checkpoint"`;
  `inputOrder: ["quality-failures", "change-summary", "approved-baseline",
  "acceptance-manifest", "locked-contract"]`; `omittedArtifactClasses`
  includes `handoff.md` and every review artifact;
  `inlineSizeBudgetBytes: 65_536` (the ratchet is not raised).
- **Prompt** `prompts/cleaner.md`, placeholders `{{SLICE_DIR}}`,
  `{{ROUND}}`, `{{ROUND_LIMIT}}`, `{{BASELINE_TREE_ID}}`,
  `{{INPUT_TREE_ID}}`, `{{WRITE_SCOPE}}` (one path or glob per line),
  `{{QUALITY_FAILURES}}` (per failing clean gate: id, `detail`, repo-relative
  log artifact path — the tool output *with locations* is the log, and the
  prompt points at it rather than inlining it), `{{REGRESSION_NOTE}}`
  (empty, or the prior round's red regression gates and why the revert
  happened). Content is #73's minimum: three rules plus the tool output,
  the two anti-gaming lines (no code-moving-only abstractions; deep
  modules, small interfaces), the no-redefinition line (no suppressions,
  threshold edits, test deletions or skips — the gates will fail the round),
  the commit-with-rationale instruction, and D8's escalation instruction.
  `{{TEST_COMMAND}}` is deliberately **absent**: the cleaner does not run
  the suite; the orchestrator gates its checkpoint (D4), and ADR 0038's
  reasoning about the generator's edit loop applies with more force to a
  role whose whole output is re-gated anyway.
- **No `agents/cleaner.md`.** `InvokeOptions.agent` is optional
  (`src/agent-provider.ts:26`) and the generator dispatch (`:5871-5885`)
  passes none; the cleaner is prompt-only on every backend.
- **Bounds:** `longCommandRoleBounds` (`:415-433`) with the same
  `idleTimeoutMs` / `maxDurationMs` the generator gets; the cleaner shells
  out to formatters and linters, so `deferIdleKillWhenBusy` is on, as for
  the generator.

*Test fired: load-bearing silence about a public interface (a role's
dispatch contract).*

### D8 — baseline-is-wrong is a JSON escalation routed through the #96 return path

The cleaner writes **`<slice>/cleaner-escalation.json`** — the one slice-
directory path D3 admits — with the `FinalReviewFinding` field vocabulary
(`src/final-evaluation.ts:163-171`) and a fixed class:

```json
{ "version": 1, "class": "BASELINE_IS_WRONG", "id": "C-01", "summary": "…", "evidence": "…", "expected": "…", "observed": "…" }
```

Parsed by a pure `parseCleanerEscalation` in `src/cleaner-stage.ts`
(unknown key, wrong class or blank field ⇒ the file is archived, the round
is recorded `ESCALATION_MALFORMED` and treated as a plain cleaner round —
the checkpoint is still gated). A valid file ends the stage with outcome
`ESCALATED` and the orchestrator does **exactly what a final-evaluation
`RETURN_TO_GENERATOR` does** (`src/orchestrator.ts:7306-7340`):
`invalidateFinalEvaluationBaseline(repoRoot, runSlug, ghIssue,
<accepted tree>)` (`src/run-state.ts:698-729`), a `generatorFailureSet`
whose finding is the escalation with `artifactReferences` naming the
archived file, `retryNote`, one generator round consumed, zero cleaner
rounds and zero final-evaluation attempts consumed (D19). The worktree is
reset to the accepted tree first — the cleaner's edits on a baseline it
declared wrong are not handed to the generator. "Invalidates downstream
evidence" (#87 AC5) is exactly `invalidateFinalEvaluationBaseline`'s
existing contract: the citation is withdrawn, the artifact stays.

**Rejected:** reusing `escalation.md` (`ScopeEscalation`,
`src/escalation.ts:73-87`) — its schema is scope-shaped (`paths`,
`findingIds`, `gateEvidence`) and a version 3 carrying a class field would
be a schema-history risk class for a use it was not designed for.
**Rejected:** a park through the adjudication estate — D24's reasoning:
no finding identity exists for a role's own escalation, and the generator
loop is the remedy ADR 0048 names for a wrong baseline.

*Test fired: spec contradiction* (#73 says "reuse the PRD 2 mechanism";
the mechanism that exists for a wrong baseline is #96's, built on PRD 2's
vocabulary).

### D9 — persisted record: `RunState` 5 → 6 with `qualityStages`

`src/run-state.ts` `RUN_STATE_VERSION` (`:61`) goes **5 → 6**;
`RunState.version` admits `6`; `adaptLoadedState` (`:754`) accepts a
version-5 file with no `qualityStages` as "no stage ran" and writes
nothing. New per-issue map, modelled on `finalEvaluations`
(`:122-141`, `recordFinalEvaluation` `:674-687`):

```ts
export interface PersistedQualityStageRound {
  round: number;            // 0 = the gate-only pass on the approved candidate
  attempt: number;          // infrastructure retries within the round
  inputTreeId: string;
  outputTreeId?: string;    // absent when the round was reverted or escalated
  gateIds: string[];        // every declaration the round ran, in order
  outcome: "PASS" | "FAIL" | "REVERTED" | "EXHAUSTED" | "ESCALATED" | "ESCALATION_MALFORMED";
}
export interface PersistedQualityStage {
  stage: "cleaner";
  enabled: boolean;         // D10's fact, per slice
  rounds: PersistedQualityStageRound[];
  outcome: "DISABLED" | "PASS" | "EXHAUSTED" | "ESCALATED";
}
// RunState.qualityStages?: Record<string /* ghIssue */, PersistedQualityStage[]>
```

Writers: `recordQualityStageRound(repoRoot, runSlug, ghIssue, stage, round)`
after every round (persist-per-attempt, as `persistAttempts` does at
`:6972`, so a killed run comes back with the round spent) and
`recordQualityStageOutcome(...)`. Reader: `cleanerRoundsSpent(record)`
counts rounds with `round >= 1`. **Why persisted at all:** a resumed run
must not buy a fourth cleaner round (ARCHITECTURE.md placement rule: a new
persisted fact is a schema bump plus a reader).

*Test fired: declared risk class (schema history).*

### D10 — the enable/disable record: one event at run start, a run-summary section, a draft-PR section

Plan item 8: "any enable/disable recorded in run evidence and the draft
PR." Three stores, one source:

1. **Event** `quality-stage-policy`, emitted **once per run** immediately
   after `run-started` (`src/orchestrator.ts` run entry; the same place
   `slice-bounds` is emitted from, `:2569`, but per run not per slice):
   `{ type: "quality-stage-policy"; stage: "cleaner"; enabled: boolean;
   gateIds: string[]; source: "afk.config.json" }`. `enabled` is
   `runGatePolicy?.clean !== undefined` — the **run's** policy snapshot
   (`SliceContext.runGatePolicy`, `:1203`; #251), never a worktree read.
   Additive; `EVENTS_SCHEMA_VERSION` stays 1 as for `behavior-coverage`
   and `approved-baseline` (`src/run-events.ts:241-243`).
2. **`run-summary.md`** section `## Quality Stages`, rendered by
   `src/logger.ts` from events alone, as `## Final Evaluation Reuse`
   (`:596`) is. One header line per run ("cleaner: enabled/disabled,
   gates: …") and, from #97's D11 events, one row per slice.
3. **Draft PR body:** `buildPrCreationPlan` (`src/ship-gate.ts:334-`)
   gains `qualityStages?: readonly QualityStageSummary[]`, sourced by a
   new `readQualityStageOutcomes(runDir)` in `src/logger.ts` modelled on
   `readAdvisoryGateOutcomes` (`:118`) and passed at both call sites
   (`:1237`, `:1300`) exactly as `advisoryGates` is. The section is
   rendered **even when disabled** — "cleaner: disabled (no
   `gatePolicy.clean`)" — because a PR that says nothing cannot be read as
   evidence of either state.

**#87 owns 1 and the header line of 2; #97 owns the per-slice rows of 2
and all of 3** (see the file-scope map). *Test fired: load-bearing silence
about a run-evidence record.*

### D11 — ROI evidence is events, keyed to the same identities the rest of the journal uses

#97 AC3/AC4. One new event family, emitted by `src/cleaner-stage.ts` per
round and by the final-evaluation loop per attempt:

```ts
| {
    type: "quality-stage-attempt";
    ghIssue: string; sliceNumber: string; round: number;   // the slice's implementation round
    stage: "cleaner" | "final-evaluation";
    stageRound: number;                                    // D4's round (0..3) or the final attempt (1..3)
    attempt: number;
    inputTreeId: string; outputTreeId?: string;
    gateIds: string[];
    outcome: string;                                       // D9's outcome vocabulary, or the final verdict
    startedAt: string; endedAt: string; durationMs: number;
    cacheReusedGateIds: string[];                          // from the round's `gate-outcome.cacheReused`
  }
```

**Measurement channels, and what is not built:**

- Per-stage elapsed time = `stage-duration` events with `agent: "cleaner"`
  / `"evaluator-final"` (already emitted for the final evaluator;
  emitted for the cleaner by D4 step 1) **plus** `durationMs` above for
  the whole round including gates. Two numbers because they answer two
  questions (model time vs. round wall clock); neither is a gate (plan
  item 13: a measurement, never a gate).
- Per-stage model cost = `invocation-completed` (`tokenCounts`,
  `nonCommandTimeMs`) filtered by `role`. **`SliceTotals`
  (`src/logger.ts:23-26`) stays per slice**, as CONTEXT.md "Slice totals"
  defines it; no per-role aggregate is added to `Logger` — the
  `## Quality Stages` rows sum `invocation-completed` per `(slice, role)`
  at render time, the way `## Final Evaluation Reuse` derives its table.
- Cache reuse per stage = `gate-outcome.cacheReused` joined on
  `attemptId`; `cacheReusedGateIds` above is that join materialized so a
  reader of one event sees it.
- **Not built:** a keyed measurement store (cut, plan §3 "Cut"), a
  per-role column in `SliceTotals`, any threshold or alert. The ROI
  decision is read off `events.jsonl` and `run-summary.md` by a human.

**`## Quality Stages` per-slice row** (rendered by #97): slice · stage ·
enabled · outcome · rounds used / limit · elapsed (sum of round
`durationMs`) · model time (sum of `stage-duration.durationMs`) · gate ids
· cache-reused gate ids · final decision (`reuse` / `evaluate`, from
`final-evaluation-reuse` or the `finalEvaluations` record).

*Test fired: load-bearing silence about a data format.*

### D12 — the final evaluator's `RESTORE` goes to the stage that wrote, and a cleaner-changed tree always evaluates

#97 AC1–AC2 and the #96 loop at `src/orchestrator.ts:7306-7383`:

- `decideFinalReuse` (`src/final-evaluation.ts:89-146`) is **unchanged**:
  a cleaner checkpoint changes `finalTreeId`, so the decision is `evaluate`
  by string inequality — no new predicate, per its own comment ("There is
  deliberately no second 'did the writing stage write?' test").
- `routeFinalReviewFinding` (`:410-427`) gains the writing stage id as an
  input: `context: { candidateTreeId; writingStageIds: readonly string[] }`
  and returns `stageId` = the **last** stage that ran (the cleaner when it
  ran, else the stub). #97 changes the one call site (`:7306`).
- A `RESTORE` route to the cleaner **re-dispatches the cleaner with the
  finding** — `runCleanerStage(ctx, round, { repair: { findings } })` — under
  D4's remaining round budget; the prompt's `{{QUALITY_FAILURES}}` block is
  replaced by the `PRESERVATION` / `GATE_INVISIBLE_DRIFT` findings and the
  instruction to restore the observed behavior. A restore round is gated
  like any round. No rounds left ⇒ the orchestrator reverts the cleaner's
  whole range (reset to the accepted tree), records `EXHAUSTED`, and the
  final evaluation proceeds on the accepted tree — which then equals the
  baseline and **reuses** (D20). That is the only path by which an
  exhausted cleaner still merges: with none of its edits.
- With the cleaner off, or on and `PASS` with `inputTreeId ===
  outputTreeId` (round 0 all green), the final tree is the accepted tree
  and #96's reuse branch runs unchanged — #97 AC2.

*Test fired: spec contradiction* between #96's stub-targeted `RESTORE`
route and a real writer.

### D13 — unchanged from PRDs 1–4

Behavior IDs keep their `B-01` spelling. The finding schema, the canonical
verdict artifacts, `MERGE-PENDING` semantics, the merge mutex, the QA
window allowlist `QA_WINDOW_ARTIFACT_NAME` (`src/post-qa-gates.ts:52-53`),
`approved-baseline.json` (written only at `:6432`) and the gate cache
key (`src/gate-cache.ts:37-42, 66-68`) are unchanged. In-process gates are
never cached (`src/gate-runner.ts:205-212`); that holds for `suppressions`.

## Deferred — #92 and the hardener/mutation stories

Plan §2 defers #73 stories 9–15 and 19; plan §4 runs "PRD 5 (cleaner only)".
#92 is therefore **not selected** in `afk.json`, keeps its labels and stays
OPEN. Nothing in #87 or #97 builds toward it: no `hardener` stage id, no
mutation gate, no survivor schema, no exclusion-pairing gate. The stage
list D2 extends is the place a hardener would be added later, and D9's
`stage: "cleaner"` literal is the one union a hardener would widen. The
re-entry trigger is plan §6: an incident or the story-17 evidence.

## File-scope map

Against `46f6c38`. New files are marked *(new)*. **The map is exhaustive
for source, prompt, template and doc files and does not list test files.**
A planner declares its slice's paths plus the test files it edits; a path
the map does not name is a scope discovery (ADR 0052 / 0060), not an
assumption.

| Path | 01 #87 | 03 #97 |
|---|---|---|
| `src/orchestrator.ts` (hub) | one call site at `:6765-6795`; `completionEvidence.role`; `quality-stage-policy` at run start | `routeFinalReviewFinding` call site; RESTORE re-dispatch; stage tiling for `writeFinalChangeSummary`; `quality-stage-attempt` for `final-evaluation` |
| `src/cleaner-stage.ts` *(new)* | creates (D2, D4, D8) | `quality-stage-attempt` emission; `repair` input (D12) |
| `src/suppression-gate.ts` *(new)* | creates (D5) | — |
| `src/gate-policy.ts` | `clean` member; `GateRiskClass` `suppression` (D1, D5) | — |
| `src/gate-runner.ts` | `GateFindings.suppressions`; evidence version 3 → 4 (D5) | — |
| `src/scope-gate.ts` | `role` source: slice dir out of scope (D3) | — |
| `src/final-evaluation.ts` | `CLEANER_STAGE_ID` (D2) | `routeFinalReviewFinding` input (D12) |
| `src/bounds.ts` | `MAX_CLEANER_ROUNDS`, `cleanerRoundsRemaining` (D4) | — |
| `src/run-state.ts` | version 5 → 6, `qualityStages` (D9) | — |
| `src/run-events.ts` | `quality-stage-policy`; `invocation-completed.role` (D7, D10) | `quality-stage-attempt` (D11) |
| `src/context-envelope.ts` | `CLEANER_CONTEXT_MANIFEST`; `ContextEnvelopeRole` (D7) | — |
| `src/qa-review.ts` | `QAReviewStage` `"cleaner"` (D4) | — |
| `src/logger.ts` | `## Quality Stages` header line (D10) | per-slice rows; `readQualityStageOutcomes` (D10, D11) |
| `src/ship-gate.ts` | — | `buildPrCreationPlan.qualityStages` + section (D10) |
| `prompts/cleaner.md` *(new)* | creates (D7) | restore variant text (D12) |
| `templates/quality-policy/afk.config.json` *(new)* | creates (D6) | — |
| `package.json` | `files` gains `templates` (D6) | — |
| `README.md` | "Quality policy starter" section (D6) | — |
| `ARCHITECTURE.md` | own rows: module, seam ("Post-approval writing stages"), `suppressions` under `GateDeclaration` | own rows |
| `afk.config.json` | **not edited** (protected path; cleaner stays off) | **not edited** |

Both slices declare `src/orchestrator.ts`, so `partitionLanes`
(`src/lanes.ts`) puts them in one lane; the DAG already serialises them.
The shared files (`src/orchestrator.ts`, `src/run-events.ts`,
`src/logger.ts`, `src/cleaner-stage.ts`, `src/final-evaluation.ts`,
`prompts/cleaner.md`, `ARCHITECTURE.md`) stack: #97's worktree is cut from
the feature tip after #87 merged.

**Concurrency with PRD 7** (plan §4, §6): allowed under §3c policy 5 —
one clone per run, tickets linted, no migration prefixes (neither PRD
reserves any), and the **file-hint overlap check is the operator's at
launch**: PRD 7's slices must not declare `src/orchestrator.ts`,
`src/run-events.ts`, `src/logger.ts` or `src/ship-gate.ts`; if one does,
the second merger pays the rebase and the babysitter must expect a merge-
resolution round (#132) rather than a conflict-free merge.

## Testing decisions

#73's Testing Decisions stand, narrowed to the cleaner. From AGENTS.md's
ladder — **no slice adds a new spawned pipeline scenario without a comment
saying why no existing fixture reaches the state**:

1. **Unit first.** `parseClean`, the `{changedFiles}` expansion, the
   suppression counter, `parseCleanerEscalation`, `cleanerRoundsRemaining`,
   the `role`-source slice-directory rule, the `## Quality Stages` renderer
   and `readQualityStageOutcomes` are pure functions. Assert them without
   git and without agents.
2. **The fake-gate and stub-cleaner scenarios extend `src/qa-orchestration.test.ts`
   "final evaluation and reuse" (`:3297`).** Its stub provider already
   answers `evaluator-qa` and `evaluator-final`; a `cleaner` branch that
   writes a file, adds a suppression, deletes a test, or writes
   `cleaner-escalation.json` is an `it` on that fixture. Fake clean gates
   are `node -e` scripts in the fixture's `package.json`, the way its
   `typecheck` and `test` scripts already are (`:3607`). Blocked start
   before candidate PASS, pass on first attempt (round 0), fail-then-repair,
   regression forcing revert, round exhaustion preserving every attempt, and
   infrastructure retry not consuming a round are each an `it`, not a
   `describe` with its own spawn.
3. **The enable/disable record is proved on artifacts.** One `it` reads
   `events.jsonl` for exactly one `quality-stage-policy`, `run-summary.md`
   for the section, and `buildPrCreationPlan(...).body` for the PR section
   — the latter as a unit test on `src/ship-gate.ts`, no spawn.
4. **`pnpm test:budgets` stays the ceiling.** A red budget moves the
   assertion up the ladder; raising one needs the measurement in the
   commit message and a `_measured<YYYY_MM_DD>@<branch>` block.

Slice agents run `pnpm run typecheck && pnpm test:fast` plus
`pnpm run test:heavy:qa` (the suite these fixtures live in) — never the
full suite (AGENTS.md).

## Out of scope

#73's Out of Scope stands. Added here: #92 and stories 9–15, 19 (see
"Deferred"); running `suppressions` on generator candidates (D5); a
per-role `SliceTotals` column or any aggregate store (D11); a CLI enable
flag (D1); editing `afk.config.json` in this repository (the cleaner stays
off for the self-run, and the file is a protected path); `afk status`
rendering of quality stages (plan item 14 covers bounds, not stage
outcomes — a follow-up if the ROI read needs it); guardian and remediator
changes (PRD 6).

## Launch preconditions

1. `pnpm lint:tickets 87 97` exits 0. **Verified 2026-09-12** on this
   branch after the #97 body edit; it prints three "waiver matched nothing"
   notes for #92, #93 and #95 — stale waivers from earlier PRDs that do not
   gate.
2. PRD 4 is merged: #223 CLOSED; `POST_APPROVAL_WRITING_STAGE_ID`,
   `decideFinalReuse`, `scopeGateDeclaration`'s `role` source and
   `buildFinalChangeSummary` present on `origin/main`. **Verified** against
   `46f6c38`.
3. `afk.json` in this directory selects slices 01 and 03, reserves no
   migration prefix (AFK has no SQL migrations — the pool is empty, as in
   every other spec directory here) and protects #73 as OPEN. **Verified**
   with `parseAfkManifest`.
4. The committed `afk.config.json` has no `clean` member, so the run's
   `quality-stage-policy` record will say `disabled` — the intended state
   for this run (plan item 8).
5. Launch with the verification command explicit:
   `node <repo>/dist/afk-claude.js --prd-dir .kiro/specs/afk-v2-quality-loops --test-command "pnpm run typecheck && pnpm test:fast"`
   after `pnpm build` (AGENTS.md; PRD 4 launch mechanics: the globally
   linked `afk-*` binaries are not this worktree). Substitute the backend
   file for `afk-codex.js` / `afk.js`; keep the flag.
6. PRD 7 may be live on this host (plan §6). Precondition: one clone per
   run, and the file-hint overlap check in the File-scope map above.
7. #226 stays OPEN after #87 merges; #87's handoff names the cleaner call
   site as the first `role`-source consumer.

# Context — slice 08 (#195), File-scope gate

Evidence map for the planner/generator. See `prd.md` D2, D3, D4, D22 and
issue #195 for the settled decisions; this file states only what the
repository confirms. Do not restate PRD prose here — cite it.

## Files and current behavior

- FACT: `outOfScopeChangedPaths` (`src/escalation.ts:196-262`) already
  compares a changed-file list against a locked `AcceptanceManifest`,
  exempting the slice artifact directory (minus the orchestrator-owned
  `contract.md`/`acceptance-manifest.json` pair unless
  `acceptedPairIntact` is `true`) and migration paths, and reporting an
  unclassifiable path as an offender. It takes `acceptedPairIntact:
  boolean` with **no default** (`src/escalation.ts:210`).
- FACT: `src/orchestrator.ts:5432-5444` is the one existing call site of
  `outOfScopeChangedPaths` today, inside the focused-scope-revision
  escalation guard, and it passes `acceptedPairIntact: true` with a
  comment that the pair's integrity was proven immediately above
  (`mutatedAcceptedContractFiles` / `restoreAcceptedContractPair`,
  `src/orchestrator.ts:5348-5360`). This is a different call site from
  the one #195 must add — it is the pre-build escalation guard, not the
  final pre-merge scope gate.
- FACT: `listChangedFiles(worktreeDir, base)` (`src/git.ts:1272-1315`)
  unions three commands — `git diff --name-only <base>...HEAD`, `git
  diff --name-only HEAD` (working tree), `git ls-files --others
  --exclude-standard` (untracked) — with `core.quotePath=false`, and
  returns `ChangedFilesProbe` (`src/git.ts:1254-1256`), a discriminated
  union (`{ ok: true; paths }` | `{ ok: false; failure }`) that fails
  closed when any of the three git commands throws.
- FACT: `diffTreePaths(cwd, fromTree, toTree)` (`src/git.ts:1323-1346`) is
  `git diff-tree -r --name-only` between two tree objects, sorted,
  forward-slashed, and throws (does not fail-closed-return) on error.
- FACT: `src/orchestrator.ts:5420-5421` already calls `git.listChangedFiles
  (ctx.worktreeDir, featBranch)` for the escalation guard, using the
  feature branch name directly as `base` — not a `merge-base(...)...HEAD`
  three-dot range. D3 requires the new gate's comparison base to be
  `merge-base(<feature-branch tip>, HEAD)...HEAD` plus working tree and
  untracked, which `listChangedFiles`'s own diff arg is literal `${base}
  ...HEAD` (`src/git.ts:1307`) — a three-dot range already, so the
  existing escalation call site is arguably not computing what D3 says
  the git three-dot syntax already means (`base...HEAD` is
  `merge-base(base, HEAD)..HEAD` in git's own semantics). See Unknowns.
- FACT: `GateDeclaration` (`src/gate-runner.ts:23-33`) has no `run` field
  today; a `command == null` declaration is always treated as `SKIPPED`
  (if `required: false`) or `FAIL`/`CONFIGURATION` (if `required: true`
  and invalid) at `src/gate-runner.ts:413-440` — actually: reading the
  code, `declaration.command == null` unconditionally reaches this
  branch regardless of `required`, and the status is `SKIPPED` only when
  `!invalid && !declaration.required`; a **required** declaration with no
  command is `FAIL`/`CONFIGURATION` today, not silently passed. D22's
  planned behavior ("a required declaration supplying neither `command`
  nor `run` is a configuration failure") therefore already holds for the
  no-`run`-field world; the new part is that `run` becomes a second legal
  way to satisfy a declaration.
- FACT: `GateResult` (`src/gate-runner.ts:35-47`) carries only
  `detail?: string` — no field for a path list or waiver record.
  `GATE_EVIDENCE_VERSION = 1` (`src/gate-runner.ts:18`).
  `readGateEvidence` (`src/gate-runner.ts:626-654`) throws on any
  `version !== GATE_EVIDENCE_VERSION`.
- FACT: `runGates` (`src/gate-runner.ts:278-624`) is command-execution-only:
  every declaration in the loop at `src/gate-runner.ts:398-591` either
  hits the no-command branch or calls `runBoundedCommand` — there is no
  branch that would invoke an in-process `run` function today.
- FACT: `projectSanityGateDeclarations` (`src/base-gates.ts:8-25`) sets
  `required: step != null` and spreads `command` only when `step` exists,
  so an absent script yields `{ id, stage: "base", required: false }`
  with **no `command`** — confirms the PRD's claim that a flat
  required-implies-command rule would turn this gate red for a project
  missing e.g. a lint script. `src/base-gates.ts` is not in this slice's
  file scope per the file-scope map (issue text; `prd.md`'s File-scope
  map table).
- FACT: `runCandidateGatePhase` (`src/candidate-gate-phase.ts:37-152`)
  wraps `runGates` in a bounded infrastructure-retry loop keyed only on
  `gate.status === "INFRASTRUCTURE"` for a required gate
  (`src/candidate-gate-phase.ts:134-138`) — it never inspects whether a
  declaration carries `command` or `run`, so an in-process gate that
  returns `INFRASTRUCTURE` gets the retry for free with no edit to this
  file (confirms the anchors file's explicit "this file is NOT in your
  scope" note).
- FACT: `src/candidate-gate-phase.ts:114-117` computes
  `relative(repoRoot, evidencePath)` (forward-slashed) and passes it as
  `evidenceArtifactId` on every `gate-outcome` event
  (`onGateOutcome` callback, `src/candidate-gate-phase.ts:118-132`).
- FACT: `src/run-events.ts:141-158` declares the `"gate-outcome"`
  `RunEventPayload` variant with fields `gateId`, `stage`, `status`,
  `failureKind`, `evidenceArtifactId`, `logArtifactId`, etc. — no
  `findings` field. The union (`src/run-events.ts:26` region) is written
  as an open set of object-literal members, so a new variant or a widened
  existing one needs no schema-migration decision by itself.
- FACT: `RunState` is `version: 3` (`src/run-state.ts:50`); `loadRunState`
  defaults an absent state to `{ version: 3, ... }`
  (`src/run-state.ts:685`); `adaptLoadedState` and `saveRunState` both
  hard-code `version: 3` (`src/run-state.ts:726`, `:778`). No
  `appliedWaivers` field exists. Per the PRD's File-scope map, the D5
  waiver-record schema bump (`RunState` 3→4) is **#193's** work, not this
  slice's — this slice's file scope is `src/scope-gate.ts`,
  `src/gate-runner.ts`, the `src/orchestrator.ts` call site, and gate id
  `scope`.
- FACT: `src/post-qa-gates.ts` (`runPostQAGates`, lines 132-286) owns the
  QA-approved-tree → full-suite-checkpoint transition today: it captures
  a fresh checkpoint from `args.worktreeDir`, calls
  `reviewArtifactViolations` to fail closed if the tree drifted outside
  the QA-window allowlist, then calls `runCandidateGatePhase` with
  `args.declarations` (today: `fullSuiteDeclarations`, i.e. the `tests`
  gate) and returns `PASS`/`REPAIR`/`ERROR`/`CANCELLED`.
  `src/orchestrator.ts:5804-5876` is the one caller, inside
  `runSlice`'s deterministic-QA loop, and on `PASS` it goes on to compute
  `acceptedTreeId`, re-check `reviewArtifactViolations` once more
  (`src/orchestrator.ts:5891-5901`), commit if needed
  (`git.commitAll`, `:5910-5913`), then call
  `dispatchAcceptedCandidate(candidateLifecycle.accept(...))`
  (`:5915-5916`), which returns `{ phase: "PASS" }` up through `runSlice`.
- FACT: The actual git merge to the feature branch happens later, in
  `src/wave.ts`, not in `src/orchestrator.ts` or `src/post-qa-gates.ts`.
  After a slice's `runSlice` outcome is `PASS`
  (`src/wave.ts:499`), the wave code re-checks the migration claim gate
  (`checkClaimedGeneratedMigrations`, `:514-531`), verifies the slice
  branch exists and has commits ahead
  (`:540-563`), then calls `git.attemptMerge(repoRoot, branch, featBranch,
  scratchMergeDir)` under `mergeMutex` (`:576-578`), handling
  `"collision"` (deferred, `MERGE-PENDING`) and `"conflict"` outcomes
  before recording `PASS` (`:616`).
- FACT: The anchors file (read per the task's mandatory-reading
  instruction) records the settled call-site decision: the required
  `scope` gate must run "on the final candidate, after the QA window
  closes and before the merge" — not in the pre-QA declaration set — and
  names `src/post-qa-gates.ts` as "the natural home for the call site,"
  directing the planner to "read it before choosing the exact seam"
  without naming an exact line. It also states `src/candidate-gate-phase.ts`
  is explicitly **not** in this slice's file scope.
- FACT: `src/afk-manifest.ts`'s `AfkManifest`/`parseAfkManifest` and the
  `protectedChangeWaivers` field are named by the PRD as #193's work
  (D5), not this slice's — confirmed by the File-scope map table's `01`
  column split note in `prd.md` (search "Where the map's `01` column now
  lands").
- FACT: `src/gate-policy.ts` already exists (module header: "The first
  reader of `afk.config.json`'s optional top-level `gatePolicy` object");
  it exports `GateRiskClass`, `GATE_RISK_CLASSES`,
  `DEFAULT_GATE_POLICY_PATHS`, `DEFAULT_TEST_GLOBS`,
  `GatePolicyProtectedPaths`, `GatePolicy`, `matchesGlob`
  (`src/gate-policy.ts:211`), `parseGatePolicy` (`:287`),
  `loadGatePolicy` (`:325`). Its own header states "Nothing consumes a
  policy yet: the gate runner, the file-scope gate and the feedback
  channel are other slices' work" — confirming #84 (this slice's
  blocker) is merged and its glob matcher and policy reader exist and
  are callable.
- INFERENCE: Despite issue #195's body stating this gate "reads the
  `gatePolicy.protectedPaths` and `riskClasses` members ... and calls
  #84's exported glob matcher," the PRD's D2/D3/D4 decisions (which this
  slice implements) describe only a manifest-vs-changed-files comparison
  with no mention of `protectedPaths`, `riskClasses`, or glob matching —
  those are D5/D6, which `prd.md`'s File-scope map explicitly assigns to
  #193 (`feedback-integrity`), not to this slice's `scope` gate id. Drawn
  from: `prd.md` D2-D4 text (no policy/glob mention), the File-scope map's
  `01` column split note, and issue #195's "Blocked by #84" paragraph
  (which does mention them). See Unknowns.
- FACT: `src/scope-gate.ts` does not exist yet (checked via directory
  listing); this slice creates it.
- FACT: `src/merge-resolution.ts` does not exist yet (checked via
  directory listing) — slice 06 (#132) creates it. D3's re-resolved-base
  rule ("after a merge-resolution round the base re-resolves to the
  merged feature-branch tip") therefore has no existing mechanism this
  slice can read; #132 is a separate, currently-unbuilt slice, and the
  PRD's File-scope map states "#132 gains #195 because D3's re-resolved
  base is a `scope-gate` rule" (edge direction: #132 depends on #195, not
  the reverse).

## Patterns and test harness

- FACT: Pure-function scope-comparison and evidence-shaping logic is unit
  tested directly, no git process spawned — see `src/escalation.test.ts`
  (`describe("outOfScopeChangedPaths", ...)` at line 243) and
  `src/gate-policy.test.ts`. This matches `prd.md`'s Testing Decisions
  ("most of this is unit-shaped").
- FACT: `src/git.test.ts` exercises `listChangedFiles` and `diffTreePaths`
  against real throwaway git repos (spawns `git`), not mocks — follow
  that convention for any new coverage of the comparison base
  (`merge-base(...)...HEAD` behavior) rather than stubbing git.
- FACT: `src/gate-runner.test.ts` (`describe("runGates", ...)` line 157)
  drives `runGates` with real `GateDeclaration`s whose `command` is
  `process.execPath` running an inline script — the pattern to follow
  when adding coverage for the new `run` field, so a real declaration
  exercises the new branch rather than a mocked `runGates`.
- FACT: `src/post-qa-gates.test.ts` exists and presumably covers
  `runPostQAGates`/`reviewArtifactViolations` — read it before adding the
  `scope` gate's declaration into the full-suite gate list, since any new
  declaration there changes what that suite's existing fixtures assert
  about `declarations.length` / evidence completeness
  (`assertGateEvidenceReleasesEvaluation`, `src/candidate-gate-phase.ts:154-177`,
  compares `evidence.results.length === declarations.length`).
- FACT: `CLAUDE.md` (this repo's project instructions) states the full
  suite (`pnpm test`) costs ~7 minutes on Windows and instructs slice
  agents to run `pnpm test:fast` plus the heavy suites their change
  touches — not the full suite — before handoff.
- FACT: AGENTS.md's "where a new assertion goes" ladder (cited by
  `prd.md`'s Testing Decisions and `CLAUDE.md`) is unit test → existing
  spawned scenario's `it` → new slice in an existing wave fixture → new
  spawn as last resort. `prd.md`'s Testing Decision 2 names
  `src/orchestrator.test.ts`, `src/orchestrator-runs.test.ts`, and
  `src/qa-orchestration.test.ts` as the existing spawned fixtures whose
  `beforeAll` already reaches a lying-stub-generator state — the new
  `scope` gate's end-to-end assertion (a stub generator changing an
  undeclared path fails the gate; the slice does not merge) belongs on
  one of those, per AC1/AC5's shape, rather than a new spawn.
- FACT: `pnpm test` ends with `pnpm test:budgets`, a per-suite wall-clock
  budget check (`CLAUDE.md`); a red budget is fixed by moving the
  assertion up the ladder, never by raising the number without a
  `_measured<YYYY_MM_DD>@<branch>` entry in `suite-budgets.json`.

## Data and integration

- FACT: `ScopeEscalation` (`src/escalation.ts:50-55`) and
  `AcceptanceManifest` (imported from `./acceptance-manifest.js`) are the
  two data shapes `outOfScopeChangedPaths` already consumes; the new
  `scope-gate.ts` module reuses both types rather than inventing parallel
  ones (explicit in issue #195's body: "Reuse both halves; do not write
  a second dialect of either").
- FACT: `normalizeAcceptanceManifestPath` — the manifest's own path
  normalizer that `outOfScopeChangedPaths` calls
  (`src/escalation.ts:240`, `:318`) — lowercases (per the anchors file's
  citation of `src/acceptance-manifest.ts:64-71` and `:269`), so the
  file-scope comparison this slice builds is case-insensitive by
  construction; a `fileScope` entry's tracked casing (e.g.
  `ARCHITECTURE.md`) never causes a false out-of-scope report.
- FACT: `GateEvidenceArtifact` (`src/gate-runner.ts:92-107`) has
  `evidencePath` and `evidenceSha256`, no `id` field — D22's
  `evidenceArtifactId` in a `GATE-SCOPE` citation is the repo-relative
  `evidencePath` (the convention already computed at
  `src/candidate-gate-phase.ts:114-117`), not the sha256; the sha256 stays
  what `verifyGateEvidence` (`src/gate-runner.ts:660-701`) checks.
- FACT: `CandidateGateOutcome` (`src/candidate-gate-phase.ts:18-31`) is
  the typed shape recorded per gate result and handed to
  `onGateOutcome`; extending `GateResult` with `findings` means deciding
  whether `CandidateGateOutcome` also carries it through to the
  `gate-outcome` run event — currently it does not project every
  `GateResult` field (e.g. no `findings`, and no `detail`).

## Unknowns

- UNKNOWN: Whether `src/scope-gate.ts` needs `gate-policy.ts`'s
  `protectedPaths`/`riskClasses`/`matchesGlob` at all. Issue #195's body
  says it does ("Blocked by #84 — this gate reads the
  `gatePolicy.protectedPaths` and `riskClasses` members ... and calls
  #84's exported glob matcher"), but `prd.md`'s D2-D4 decisions (which
  this slice implements) describe a pure manifest-vs-changed-files
  comparison with no policy/glob involvement, and the File-scope map
  assigns D5/D6 (protected paths, glob-matched test deletion) to #193's
  `feedback-integrity` gate, not this slice's `scope` gate.
- UNKNOWN: The exact call site and wiring for the `scope` gate relative
  to `runPostQAGates` / `src/post-qa-gates.ts` and `src/orchestrator.ts`.
  The anchors file states the gate must run "after the QA window closes
  and before the merge" and names `post-qa-gates.ts` as "the natural
  home," but does not commit to a specific function or line, and
  explicitly defers that choice to whoever reads the file next.
- UNKNOWN: Whether the `scope` gate's comparison base
  (`merge-base(<feature-branch tip>, HEAD)...HEAD` plus working tree and
  untracked) is meant to reuse `listChangedFiles` unmodified (its
  existing `${base}...HEAD` arg is already a three-dot range, which git
  itself resolves via merge-base) or whether `merge-base` must be
  computed explicitly by the new gate before calling `listChangedFiles`
  with a resolved commit instead of a branch name. The distinction
  matters for D3's re-resolved-base behavior once #132 exists.
- UNKNOWN: Where the `RunState`/`run-events.ts` typed `findings` payload
  boundary sits precisely — D22 says `GateResult` gains `findings` with
  `outOfScopePaths`/`deletedTests` (this slice) plus `protectedChanges`/
  `appliedWaivers` (#193's), but whether this slice defines the full
  `findings` interface shape (all four members, #193 only populating two)
  or only its own two members with #193 widening the type later is not
  settled by anything read.
- UNKNOWN: How `CandidateGateOutcome` and the `gate-outcome` run event
  should carry `findings` (or a reference to them) through to
  `run-summary.md` and `escalation.md`'s `gateEvidence.gateId` citation —
  no code path today projects a `GateResult` field beyond what
  `CandidateGateOutcome` already lists, and `GATE-SCOPE`/`escalation.md`
  v2 is #193's file, not this slice's, so the exact contract between the
  two slices at that boundary is not visible in this slice's file scope.

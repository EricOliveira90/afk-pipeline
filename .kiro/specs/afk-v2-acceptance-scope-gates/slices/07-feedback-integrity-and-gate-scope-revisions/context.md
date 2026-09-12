# Evidence map — slice 07 (#193): Feedback integrity and gate-scope revisions

## Files and current behavior

### Gate policy reader (already shipped by #84 — reuse, do not rebuild)

- FACT: `src/gate-policy.ts:81-97` declares `GateRiskClass = "gate-policy" |
  "deleted-test" | "skipped-test"` (`GATE_RISK_CLASSES`),
  `DEFAULT_GATE_POLICY_PATHS = ["afk.config.json", "suite-budgets.json"]`, and
  `DEFAULT_TEST_GLOBS = ["**/*.test.ts"]`.
- FACT: `src/gate-policy.ts:365-373` exports `matchesGlob(glob, path): boolean`,
  the D6 glob dialect: literal segments, `*` within one segment
  (`matchesSegment`, lines 304-325), `**` across zero-or-more whole segments
  (`matchesFrom`, lines 327-349), refusing `?[]{}()!+@\` and any `**` that is
  not a whole segment (`assertGlobDialect`, lines 282-302). Comparison is
  **case-sensitive on every platform**; only the path side is
  forward-slash-normalized (docstring, lines 351-364). This is the one matcher
  slice 07 must call for D6 deleted-test detection and for matching a waiver's
  `path` is explicitly *not* a glob call (prd.md D5: "one exact
  repository-relative path, never a glob").
- FACT: `src/gate-policy.ts:191-207` — full `GatePolicy` interface:
  `{ version: 1; protectedPaths: { gatePolicyPaths: string[]; testGlobs:
  string[] }; riskClasses: GateRiskClass[]; acceptance?: ...; cost?: ... }`.
  `protectedPaths.gatePolicyPaths` (default `afk.config.json`,
  `suite-budgets.json`) and `protectedPaths.testGlobs` (default
  `**/*.test.ts`) are already parsed and defaulted; slice 07 reads them, does
  not add them.
- FACT: `src/gate-policy.ts` module docstring (lines 5-19) states nothing
  consumes the policy yet — "the gate runner, the file-scope gate and the
  feedback channel are other slices' work" — and flags that `cost` joined the
  known key set in #86 while "every other member is still refused" (unknown
  top-level `gatePolicy` keys throw). Slice 07 adds no new top-level
  `gatePolicy` key (waivers live in `afk.json`, not `afk.config.json`).

### `escalation.ts` — the pre-build scope door slice 07 extends to v2

- FACT: `src/escalation.ts:50-55` — `ScopeEscalation` is `{ version: 1;
  findingIds: string[]; paths: string[]; reason: string; }`. The literal type
  is `1`; there is no version-2 branch anywhere in this file today.
- FACT: `src/escalation.ts:264-352` — `parseScopeEscalation(value, manifest,
  options?, source)`: calls `requireExactKeys(input, ["version","findingIds",
  "paths","reason"], source)` (an **exact**-key check, lines 57-72), then
  `if (input.version !== 1) throw ...` (lines 291-293, hardcoded to `1`).
  `findingIds` must be non-empty, unique, and if it contains
  `PRE_BUILD_SCOPE_FINDING_ID` it must be the *only* entry (lines 300-314).
  `paths` must normalize uniquely, none already declared, none migration
  paths. `reason` must be a non-blank string.
- FACT: `src/escalation.ts:48` — `export const PRE_BUILD_SCOPE_FINDING_ID =
  "PRE-BUILD-SCOPE"`. Anchors file (item 3, see below) says export
  `GATE_SCOPE_FINDING_ID` beside it.
- FACT: `src/escalation.ts:196-262` — `outOfScopeChangedPaths({ changedFiles,
  manifest, sliceArtifactDir, acceptedPairIntact, options })` returns the
  sorted, deduped subset of `changedFiles` not covered by: declared manifest
  paths, the slice-artifact-dir prefix (with `contract.md` /
  `acceptance-manifest.json` carved back out unless `acceptedPairIntact` is
  true), or migration paths (`migrationPathsIn`). This is the one classifier
  both the pre-build escalation door and `scope-gate.ts`'s gate call.
- FACT: `src/escalation.ts:22-25` — `ORCHESTRATOR_OWNED_SLICE_FILENAMES =
  ["contract.md", ACCEPTANCE_MANIFEST_FILENAME]`.

### `src/orchestrator.ts` — the existing focused-revision door (reuse, do not build a second one)

- FACT: `src/orchestrator.ts:5305-5407` — before every generator dispatch the
  orchestrator captures `acceptedPair` (`captureAcceptedContractPair`), and
  immediately after the generator returns it computes `mutatedOwned =
  mutatedAcceptedContractFiles(ctx.absSliceDir, acceptedPair)`; if non-empty it
  archives the attempted bytes (`artifacts.archiveRejectedContractMutation`),
  restores the accepted pair (`restoreAcceptedContractPair`), and throws.
  `acceptedPairIntact = true` is set (line 5407) only after that check passes
  — "the one place the attestation is earned."
- FACT: `src/orchestrator.ts:5409-5423` — if `escalationPath` exists:
  `artifacts.archiveScopeEscalationAttempt(...)` runs first (evidence
  survives a later refusal), then `loadAcceptanceManifest` and the sole
  orchestrator call site of `parseScopeEscalation(readFileSync(escalationPath,
  "utf-8"), lockedManifest, { migrationPathPattern }, escalationPath)`.
- FACT: `src/orchestrator.ts:5424-5434` — `if (scopeRevisions >=
  MAX_SCOPE_REVISIONS_PER_ROUND) throw ...` (ADR 0050's per-round bound,
  `MAX_SCOPE_REVISIONS_PER_ROUND` is 2 per round per ADR 0050 summary).
- FACT: `src/orchestrator.ts:5451-5489` — `git.listChangedFiles(ctx.worktreeDir,
  featBranch)` (fails closed by throw if the probe itself fails), then
  `outOfScopeChangedPaths({ ..., acceptedPairIntact: true, ... })`; if
  `undeclaredChanges.length > 0` throws citing ADR 0052, "the grant is only
  for an edit that has NOT happened yet." **This is D12's "refused once the
  requested path has already been edited" and is already fully implemented.**
  A `GATE-SCOPE` escalation must go through this exact door.
- FACT: `src/orchestrator.ts:5490-5498` — on success, `await
  runFocusedScopeRevision(ctx, escalation)`; `scopeRevisions++`; a
  `scopeRevisionNote` describing the revised `fileScope` is built for the next
  generator prompt.
- FACT: `src/orchestrator.ts:5919-5946` — the only declaration site of the
  post-QA "content-derived" gates: `postQaDeclarations = [scopeGateDeclaration(...),
  skipGateDeclaration(...), ...fullSuiteDeclarations]`, comment (lines
  5908-5918) explaining the scope gate is prepended so it runs before the
  ~7-minute suite and is never skippable. A `feedback-integrity` gate
  declaration is the natural next entry in this same array (same call site,
  same `acceptedPairIntact` value already computed above it).

### `src/artifacts.ts` — review-archive record for the accepted revision

- FACT: `src/artifacts.ts:758-774` — `ValidArchivedScopeEscalation { round;
  attempt; name; escalation: ScopeEscalation }`, sibling
  `InvalidArchivedScopeEscalation { round; attempt; name; invalid: true }`,
  union `ArchivedScopeEscalation`. Storing the *whole* `ScopeEscalation` object
  means once that type gains `gateEvidence` the archived record type carries
  it automatically — **but** see the Unknowns note below: a separate
  hand-rolled re-parse at `archivedScopeEscalations` (lines 840-876) currently
  checks `parsed.version !== 1` (line 860) and would reject a v2 document
  outright unless that check is also updated.
- FACT: `src/artifacts.ts:586-603` — `archiveScopeEscalationAttempt` just
  `cpSync`s the raw `escalation.md` bytes to `escalation-r<N>-a<M>.md`; no
  parsing happens at archive time (parsing happens later, on read, at
  `archivedScopeEscalations`).
- FACT: `src/artifacts.ts:840-876` — `archivedScopeEscalations(reviewArchiveDir)`
  matches `ESCALATION_RECORD_NAME = /^escalation-r(\d+)-a(\d+)\.md$/` (line
  791), `JSON.parse`s the archived file (not `parseScopeEscalation` — a
  second, looser re-validation), and requires `parsed.version === 1` plus
  `Array.isArray(findingIds)`, `Array.isArray(paths)`,
  `typeof reason === "string"` — a malformed/wrong-version document becomes
  `{ ...attempt, invalid: true }` rather than throwing, preserving the
  generator's bytes as evidence for STUCK diagnosis (story 13).

### `src/post-qa-gates.ts` — QA-window artifact allowlist (separate mechanism from escalation.md's carve-out)

- FACT: `src/post-qa-gates.ts:38-39` — `QA_WINDOW_ARTIFACT_NAME =
  /^(?:qa|uat)-report(?:-r[1-9]\d*-a[1-9]\d*)?\.md$|^(?:qa|uat)-review\.json$|^stuck\.md$/`.
  This allowlist does **not** admit `escalation.md`; the anchors file (item 8)
  notes that path is exempted separately by `outOfScopeChangedPaths`'s
  slice-artifact-dir carve-out in `escalation.ts`, not by this regex. These
  are two distinct authority checks (QA-verdict-voiding vs. pre-build-grant),
  and slice 07 must not conflate them.

### `src/run-events.ts` — event schema (no schema decision needed)

- FACT: `src/run-events.ts:31-357` — `RunEventPayload` is an explicitly open
  discriminated union. The `"gate-outcome"` member (lines 142-175) already
  carries `gateId`, `evidenceArtifactId`, `treeId`, `status`, etc. New waiver
  events can reuse this shape or the `"warn"` member's `reason` union (lines
  316-343) — no new top-level event type is required by anything read so far.

### `src/candidate-gate-phase.ts` — `evidenceArtifactId` computation (reuse verbatim; D22 says do not edit this file)

- FACT: `src/candidate-gate-phase.ts:132-135` — `const evidenceArtifactId =
  relative(repoRoot, evidencePath).replace(/\\/g, "/");` — the repo-relative
  evidence path, forward-slashed, **not** a sha256. prd.md D22 (line 446-447)
  literally says "the evidence sha256," but the anchors file (item 4, dated
  2026-09-08) explicitly corrects this: `evidenceArtifactId` must match this
  existing computed value so a `GATE-SCOPE` citation cross-references the
  same `gate-outcome` event. **The anchors correction, not prd.md's D22 text,
  is authoritative.**
- FACT: prd.md D22 (lines 403-465) states `src/candidate-gate-phase.ts` and
  `src/base-gates.ts` must stay unedited by slice 07 — the reasons given are
  that a project without a lint script needs `required: false` with no
  `command` to keep counting as passing (`adopt-command.ts:647-649`), which
  a generic edit to those hub files could break.

### `src/gate-runner.ts` — `GateDeclaration` / `GateFindings` / `GateResult` (schema already extended for this slice)

- FACT: `src/gate-runner.ts:97-107` — `GateFindings` is **already declared**
  with all four D22 fields: `outOfScopePaths?`, `deletedTests?`,
  `protectedChanges?`, `appliedWaivers?: readonly { riskClass: GateRiskClass;
  path: string; author: string; reason: string }[]`. The docstring (lines
  84-96) states plainly: "`deletedTests` / `protectedChanges` /
  `appliedWaivers` stay typed and unpopulated until the feedback-integrity
  gate lands (#193)." Slice 07 populates these fields; it does not invent
  them.
- FACT: `src/gate-runner.ts:24-46` — `GATE_EVIDENCE_VERSION = 3` (bumped 1→2
  for `GateFindings`, D22; 2→3 for `cacheReused`/`prerequisiteSkipped`/
  `environmentSensitive`, #86). `SUPPORTED_GATE_EVIDENCE_VERSIONS = [1,2,3]`.
  Both bumps are additive/backward-readable; there is no pending version bump
  needed on `gate-runner.ts` for this slice's `GateFindings` population (the
  fields already exist at version 3).
- FACT: `src/gate-runner.ts:109-` — `GateDeclaration { id; stage; required;
  command?; args?; run?: (ctx) => GateRunOutcome | Promise<GateRunOutcome>;
  expectedCostMs?; wallClockTimeoutMs?; ... }`; "exactly one of `command` and
  `run` may be supplied."

### `src/scope-gate.ts` — the worked pattern for an in-process gate declaration (model to follow)

- FACT: `src/scope-gate.ts` is a complete, small module: `SCOPE_GATE_ID =
  "scope"`, `SCOPE_GATE_STAGE = "deterministic"`, a `ScopeGateInput` type
  naming its comparison source (`"candidate"` worktree-vs-featureRef, or
  `"role"` checkpoint-tree-vs-checkpoint-tree), `runScopeGate(input):
  GateRunOutcome` (returns `INFRASTRUCTURE` if the changed-set probe fails,
  else `PASS`/`FAIL` with `findings: { outOfScopePaths }` on FAIL), and
  `scopeGateDeclaration(input): GateDeclaration` returning `{ id, stage,
  required: true, run: () => runScopeGate(input) }`. A hypothetical
  `feedback-integrity` gate is expected to follow this exact shape (declared
  `required`, `run`-based, no `command`).
- FACT: `src/skip-gate.ts` (lines 1-60+) is the second existing example of this
  same pattern (D22, "modelled on `src/scope-gate.ts`"), for the `tests:skipped`
  gate id. Its docstring (line 21) states explicitly: "Waiver authorization is
  deliberately out of scope: #193 owns the one waiver reader, and a second one
  is exactly the defect this PRD exists to remove." — i.e. #86 already shipped
  the skip *detector* fail-closed with no waiver path, and slice 07 must not
  add a second waiver reader for it; slice 07's waiver reader in
  `afk-manifest.ts` is meant to authorize both `skipped-test` and
  `gate-policy`/`deleted-test` risk classes through one path.

### `src/afk-manifest.ts` — the waiver record is NOT yet parsed (this slice's central gap)

- FACT: `src/afk-manifest.ts:9-14` — `AfkManifest { version: 1; selectedSlices:
  string[]; migrationPrefixes: string[]; protectedIssues: ProtectedIssue[] }`
  has **no** `protectedChangeWaivers` field today.
- FACT: `src/afk-manifest.ts:48-117` — `parseAfkManifest` builds its result
  from exactly `version`, `selectedSlices`, `migrationPrefixes`,
  `protectedIssues`; it does not check for unknown top-level keys, so a
  `protectedChangeWaivers` array in an `afk.json` today is silently accepted
  and discarded (confirmed: no read of `input.protectedChangeWaivers`
  anywhere in the function, and the returned object at lines 111-116 omits
  it).
- FACT: `src/afk-manifest.ts:166-194` — `trimUnclaimedMigrationPrefixes` does
  `const next = { ...manifest, migrationPrefixes }; writeFileSync(path,
  JSON.stringify(next, ...))` — because `manifest` comes from
  `parseAfkManifest`, any field `parseAfkManifest` drops (including a future
  `protectedChangeWaivers`) is dropped again on this rewrite. This function is
  slice 07's, per prd.md D5, alongside `AfkManifest` and `parseAfkManifest`.
- FACT: `src/gate-policy.ts` module docstring (lines 14-19) explicitly cites
  this exact defect as the reason unknown keys are refused in *its own*
  parser: "`parseAfkManifest` accepted and silently discarded
  `protectedChangeWaivers`."
- FACT: `.kiro/specs/afk-v2-acceptance-scope-gates/afk.json` (this PRD's own
  launch manifest) already contains a real, pre-recorded
  `protectedChangeWaivers` entry: `{ riskClass: "gate-policy", path:
  "afk.config.json", author: "EricOliveira90", reason: "..." }` (lines
  15-22). It is currently inert (silently dropped by today's parser) —
  prd.md's launch preconditions section (line 849) says this is intentional
  until slice 07 (there called "slice 01" in stale prose — see Unknowns)
  parses it.

### `src/acceptance-manifest.ts` — version confirmed unchanged

- FACT: `src/acceptance-manifest.ts:21-30` — `AcceptanceManifestV1 { version:
  1; ...base }`, `AcceptanceManifestV2 { version: 2; ...base; behaviors:
  AcceptanceBehavior[] }`, union `AcceptanceManifest`. Both versions are
  actively parsed today (unlike `ScopeEscalation`, which has only v1). Issue
  #193's acceptance criterion "acceptance manifest schema is unchanged at
  version 2" and D13's "the acceptance manifest stays at version 2" are
  satisfied by leaving this file untouched — the ADR 0060 rubric text is
  prose-only, in the prompts, not a manifest field.

### `src/run-state.ts` — the version-4 bump this slice must make

- FACT: `src/run-state.ts:49-108` — `RunState { version: 3; prdSlug;
  featureBranch; specsDir?; scope?; slices; reviewPhase?; resume?;
  stageCheckpoints?; contractConvergence?; qaConvergence?; nonProgress?;
  migrations?; }`. No `appliedWaivers` field exists yet.
- FACT: `src/run-state.ts:691-748` — `adaptLoadedState(raw, prdSlug)` is the
  single load-time upgrade path (no separate "migrate" function): `if
  (r.version === 1 || r.version === 2 || r.version === 3)` always returns
  `{ version: 3, ... }` regardless of which of the three it read, gating
  version-2+-only fields with `...(r.version !== 1 && r.stageCheckpoints !==
  undefined ? {...} : {})`. A version-4 bump (per-slice `appliedWaivers`
  array, D5/D22) follows this exact established pattern: accept `1|2|3|4`,
  always return `{ version: 4, ... }`, gate the new field the same way.
- FACT: `src/run-state.test.ts` (~lines 1051-1108, inside `describe
  ("clearSliceStateForDispatch", ...)`) establishes the test convention for a
  version bump: hand-write a raw JSON fixture at the **older** literal version
  number with every other field present, write it directly to disk (bypassing
  the writer), load it through `loadRunState`, and assert fields survive/
  upgrade. This is the pattern to reuse for a v3→v4 test.

### `src/scope-amendment.ts` — the after-the-fact door (ADR 0048), for contrast only — not this slice's file

- FACT: `src/scope-amendment.ts` implements `planScopeAmendment`,
  `applyScopeAmendment`, `appendContractScopeFiles`,
  `buildScopeAmendmentRecord` for the QA-driven `SCOPE_AMENDMENT` remedy
  (ADR 0048). `planScopeAmendment` **requires** every requested path to
  already be in the slice's changed set (lines 138-144) — the mirror
  opposite of `outOfScopeChangedPaths`'s pre-build door, which **forbids**
  any pre-existing undeclared change. Both doors are described in the PRD and
  ADRs as deliberately asymmetric and must not be "reconciled."

## Patterns and test harness

- FACT: `src/escalation.test.ts` exists — unit tests for
  `parseScopeEscalation` and `outOfScopeChangedPaths`, using a `MANIFEST`
  fixture (`version: 1`) and a `VALID` escalation fixture (`version: 1`, two
  finding IDs, two paths). A version-2 branch (with `gateEvidence`) will need
  new fixtures alongside these, not a rewrite of them (v1 must keep parsing
  unchanged per the issue's acceptance criteria).
- FACT: `src/orchestrator.test.ts` has a `describe("generator scope
  escalation", ...)` block (~starting line 1488) already covering: malformed/
  absent-field escalation refusal, `MAX_SCOPE_REVISIONS_PER_ROUND` exhaustion
  ("refuses a third escalation in one round instead of looping", ~line 1624),
  an ADR-0052 accepted-revision round trip (~line 1716+), and `"P-03: refuses
  the grant when the escalation follows an undeclared edit"` (~line 1840,
  asserting `phase === "ERROR"` and `/already holds changes outside the
  locked file scope/`). A `GATE-SCOPE` variant of these same scenarios is
  the natural extension point — per this repo's test-loop discipline (root
  `CLAUDE.md`), prefer adding `it`s to this existing spawned scenario/describe
  block over a new spawned pipeline scenario.
- FACT: `src/prompt-template.test.ts:167-191` — `it("gives every generator
  invocation the canonical scope-escalation contract", ...)` reads
  `prompts/generator.md` and `prompts/generator-repair.md`, extracts the `^#
  Scope escalation` section via regex, and asserts (for each file) it
  `toContain`s the **exact literal**
  `'{"version":1,"findingIds":["F-01"],"paths":["src/file.ts"],"reason":"why the cited fix requires the paths"}'`
  and `toMatch`es `/Never mix \`PRE-BUILD-SCOPE\` with a real finding\s+ID/i`.
  D12 (prd.md lines 298-306) states this test file is load-bearing and must
  be edited: the two-way branch (cited findings / `PRE-BUILD-SCOPE`) becomes
  three-way (cited findings / `PRE-BUILD-SCOPE` / `GATE-SCOPE` +
  `gateEvidence`), and this assertion is pinned to the old two-way text.
- FACT: grep across `prompts/*.md` for the version-1 escalation JSON literal
  and `PRE-BUILD-SCOPE` found it in `prompts/generator.md:28`,
  `prompts/generator-repair.md:28`, and `agents/generator.md:40` (JSON
  literal) / `agents/generator.md:58` (`PRE-BUILD-SCOPE` branch). ADR 0052's
  consequences section states the "Scope escalation" section is meant to be
  byte-identical across `agents/generator.md`, `prompts/generator.md`, and
  historically `prompts/generator-resume.md` (retired in slice 04/#82) — three
  generator-facing sources to edit in lockstep for the three-way branch.
- FACT: `prompts/evaluator-contract.md` carries `# Durable finding lineage`
  (line 30) and `# Control-plane situation` (line 40) headings, with
  `{{DURABLE_FINDING_LINEAGE}}` (line 38) and `{{CONTROL_SITUATION}}` (line
  42) placeholders in between and after. `prompts/evaluator-contract-
  revision.md` carries the same two headings (at different line numbers).
  Grepping both files for "ADR 0060", "parser", "regression surface" found
  zero matches — the rubric text D13 requires does not exist yet in either
  prompt and must be added additively, without disturbing these two sections.
- FACT: root `CLAUDE.md` ("Where a new assertion goes") instructs: prefer a
  unit test → an `it` on an existing spawned scenario's shared result → a new
  slice in a fixture that already runs a wave → a new spawn (last resort),
  with a comment saying why; run `pnpm test:ratchet` (not part of `pnpm test`)
  whenever a new spawned scenario is added.
- FACT: root `CLAUDE.md` mandates, for an AFK slice agent, running
  `pnpm test:fast` plus the specific heavy suite(s) touched (e.g. `pnpm run
  test:heavy:wave` if `orchestrator.test.ts`/`wave.test.ts` are touched) —
  never the full `pnpm test` suite as a slice agent.

## Data and integration

- FACT: prd.md D22 (lines 403-465) is the single authoritative wiring
  decision for this slice's gate: two gate ids at stage `deterministic` —
  `scope` (already shipped, D2/D3/D4 file-scope comparison) and
  `feedback-integrity` (D5/D6 protected-change and deleted-test checks, this
  slice). Two ids, not one, because a `GATE-SCOPE` citation's `gateId` must
  disambiguate which rule fired.
- FACT: prd.md D24 (lines 763-801, settled 2026-09-09, **supersedes D5's
  wording**) resolves a `SPEC_CONTRADICTION` the planner itself raised: a
  post-QA gate phase can only return `PASS`, `ERROR`, or `REPAIR`
  (`src/candidate-gate-policy.ts:16-24`, `src/post-qa-gates.ts:99-125`
  confirmed — `PostQAGateResult` union has exactly the actions `"PASS"`,
  `"CANCELLED"`, `"ERROR"`, `"REPAIR"`), and no adjudication-estate identity
  exists for a non-agent finding. **"Parks the slice" is realized as "does
  not merge until an operator waives it"**: an unwaived protected change makes
  the required `feedback-integrity` gate FAIL, which routes through the
  existing `REPAIR` path (next generator round) rather than any new
  `AWAITING-ADJUDICATION` phase or park record. D5's evidence clause survives
  unchanged: the blocking outcome must still carry `riskClass` and the exact
  path into `GateResult.findings.protectedChanges`, into gate evidence, and
  into `run-summary.md`, and the failure text must name the exact
  `{riskClass, path, author, reason}` fields to add to `afk.json`.
- FACT: `src/post-qa-gates.ts:99-125` — `PostQAGateResult` union confirmed:
  `{action:"PASS", candidateTreeId, artifacts}` |
  `{action:"CANCELLED", ...}` | `{action:"ERROR", error, ...}` |
  `{action:"REPAIR", failedGateIds, references, retryNote, failureSet,
  candidateTreeId, attemptTreeIds, ...}`.
- FACT: prd.md D22 (lines 446-465) says the waiver-record run-state bump is
  version 3→4, adding an optional per-slice `appliedWaivers` array of D5's
  four fields (`riskClass`, `path`, `author`, `reason`); the reader must
  accept version 3 and default the array empty. Matches the anchors file's
  load-bearing detail 5 exactly.
- FACT: `.kiro/specs/afk-v2-acceptance-scope-gates/review-pm.md:115-118`
  records the PM's own summary of this slice's scope: "07 (#193) D5 waivers
  (`protectedChangeWaivers` is still parsed-and-ignored), D6's deletion rule,
  the `feedback-integrity` gate, D12's `GATE-SCOPE` channel and D13's rubric.
  `findings.deletedTests`, `protectedChanges` and `appliedWaivers` are
  therefore typed and empty by design [until this slice]."
- FACT: prd.md D5 (lines 135-183) fixes the exact waiver comparison rule: a
  `path` is one exact repo-relative path (never a glob), matched by string
  equality after normalization to forward slashes with no leading `./`; a
  `path` containing `*`, `?`, or `[` refuses the *launch*; a duplicate
  `riskClass`+`path` pair also refuses the launch. `riskClass` vocabulary is
  exactly `gate-policy` | `deleted-test` | `skipped-test` (already declared in
  `src/gate-policy.ts`); an unknown `riskClass` in `afk.json` must fail closed
  at launch, not at a park/gate.
- INFERENCE: because `GateFindings.appliedWaivers` (gate-runner.ts:101-106)
  and `RunState.appliedWaivers` (v4, per D22) are both per-slice records of
  the same four fields, and D5 requires "every allowed protected change" to
  carry a waiver into *both* gate evidence and `run-summary.md`, the
  gate-time check most likely needs to read the launch-time `AfkManifest.
  protectedChangeWaivers` (an operator-wide list) and cross-reference it
  against the *current slice's* risk class + path to decide which entries
  apply and get persisted into that slice's `RunState.appliedWaivers` — but
  the exact cardinality/keying (is a waiver slice-scoped or launch-global?)
  is not settled by any file read; see Unknowns.

## Unknowns

- UNKNOWN: prd.md's D5/D6/D22 prose (lines 135-465) still says "slice 01"
  should extend `AfkManifest`/`parseAfkManifest`/`trimUnclaimedMigrationPrefixes`
  and should write the `feedback-integrity` gate — but issue #193's own body
  states plainly that #193 (this slice) was split out of #84 specifically to
  own D5, D6, D12, D13, and `.kiro/specs/afk-v2-acceptance-scope-gates/slices/
  08-file-scope-gate/context.md:132-136` independently confirms
  `protectedChangeWaivers` is named by the PRD as "#193's work," not slice
  01's. This context.md treats the issue body and the cross-references as
  authoritative and the "slice 01" phrasing in prd.md's D5/D6/D22 prose as
  stale, unrewritten text from before the #84/#193 split — but the contract
  author should confirm this rather than silently resolve it, since prd.md is
  nominally the settled cross-slice record.
- UNKNOWN: whether `archivedScopeEscalations` in `src/artifacts.ts` (lines
  840-876, hand-rolled `JSON.parse` + `parsed.version !== 1` check at line
  860) is expected to gain its own version-2 branch as part of this slice, or
  whether the anchors file's claim ("the review-archive record preserves the
  gate ID and evidence ID automatically" once `ScopeEscalation` gains
  `gateEvidence`) is meant loosely and this hand-rolled re-validation is a
  separate thing this slice must still touch. As read, a v2 escalation
  archived to disk would be marked `{ invalid: true }` by this function today
  even after `ScopeEscalation`'s type gains `gateEvidence`, because the
  version check is a literal `!== 1`, not a call to `parseScopeEscalation`.
- UNKNOWN: the exact shape/cardinality of how `AfkManifest.
  protectedChangeWaivers` (launch-wide) is matched against one slice's
  protected changes to produce that slice's `RunState.appliedWaivers` (D22)
  and `GateFindings.appliedWaivers` — no code or prose read specifies whether
  one waiver entry can satisfy multiple slices, or whether a waiver not
  "used" by any slice is diagnosed at launch (lint:tickets-style) or is simply
  inert.
- UNKNOWN: whether the deleted-test comparison base (D6: "exists on the
  comparison base and not in the candidate tree") is the same `featureRef`/
  worktree-vs-feature-branch comparison `scope-gate.ts`'s `"candidate"` source
  uses, or a different base — no file read names the exact git ref pair for
  the feedback-integrity gate's own comparison, only that the scope gate's
  existing `"candidate"` source (`ScopeComparisonSource`, `scope-gate.ts:
  36-61`) is the established shape to reuse.
- UNKNOWN: `src/gate-cache.ts`'s `GateCacheKey` requires non-optional
  `command: string` and `args: readonly string[]` (gate-cache.ts:37-45), but
  an in-process `run`-based declaration (like the existing `scope-gate.ts` and
  the expected `feedback-integrity` gate) supplies neither. Whether a
  `run`-based required gate participates in the tree-identity cache at all,
  or is simply never cached (always re-evaluated), is not resolved by any
  file read in this pass.

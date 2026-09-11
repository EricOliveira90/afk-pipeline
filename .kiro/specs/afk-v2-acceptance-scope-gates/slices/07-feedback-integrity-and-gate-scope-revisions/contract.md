# Slice Contract — Feedback integrity and gate-scope revisions

**Parent PRD:** .kiro/specs/afk-v2-acceptance-scope-gates/prd.md
**GH issue:** #193
**Status:** LOCKED

**Lock-Provenance:** negotiation round 1
**Negotiation round:** 1

## Scope lock

One waiver reader and one new deterministic gate close the feedback-integrity
half of PRD 4, and `escalation.md` gains the gate-evidenced revision channel.
`parseAfkManifest` reads `protectedChangeWaivers` from the PRD directory's
`afk.json` once at launch (`prd.md` D5); a new `feedback-integrity` gate,
declared through #195's in-process `GateDeclaration.run` seam beside the `scope`
and `tests:skipped` gates, fails closed on a changed `gatePolicy` path or a
deleted test file unless a launch waiver covers it, and names the four fields the
operator must add to `afk.json` (`prd.md` D6, D22, D24). Each applied waiver
travels one owned chain end to end: the gate puts it in
`GateResult.findings.appliedWaivers`, `src/orchestrator.ts` re-reads the written
evidence with `readGateEvidence`, passes it through the new pure
`appliedWaiversFrom`, emits one `waiver-applied` run event per waiver and
persists it through a new `saveAppliedWaivers` in `src/run-state.ts` (version
3 → 4), and `src/logger.ts` renders those events as `## Applied Waivers` in
`run-summary.md` (`prd.md` D22, D23 — D23 settles this producing seam and
rejects narrowing it to schema and renderer). `escalation.md` reaches schema
version 2 with an optional `gateEvidence`, carrying the reserved identity
`GATE-SCOPE` through ADR 0052's existing focused-revision door unchanged, and
ADR 0060's parser-regression rule lands as additive contract-evaluator rubric
text with the acceptance manifest left at version 2 (`prd.md` D12, D13).

### In scope

- [behavior:B-01] `AfkManifest` and `parseAfkManifest` (`src/afk-manifest.ts`)
  gain `protectedChangeWaivers`: an optional array of
  `{ riskClass, path, author, reason }`, absent reading as empty. The launch
  refuses, naming the offender: a `riskClass` outside
  `GATE_RISK_CLASSES` (`src/gate-policy.ts:84`), a `path` containing `*`, `?` or
  `[`, a blank field, and a duplicate `riskClass` + `path` pair. A `path` is one
  exact repository-relative path — never a glob — normalized to forward slashes
  with no leading `./`, and matched by string equality (`prd.md` D5).
- [behavior:B-02] `trimUnclaimedMigrationPrefixes` (`src/afk-manifest.ts`)
  preserves `protectedChangeWaivers` when it rewrites `afk.json`; today it
  rebuilds the file from the parsed fields and would drop the array (`prd.md`
  D5).
- [behavior:B-03] New `src/feedback-integrity-gate.ts` declares gate id
  `feedback-integrity` at stage `deterministic`, `required: true`, in-process
  through `GateDeclaration.run`, modelled on `src/scope-gate.ts` and
  `src/skip-gate.ts` (`prd.md` D22). A candidate path equal after normalization
  to a `gatePolicy.protectedPaths.gatePolicyPaths` entry (default
  `afk.config.json`, `suite-budgets.json`) with no covering `gate-policy` waiver
  makes the gate FAIL with `failureKind: "COMMAND"`, `findings.protectedChanges`
  naming the exact path, and `detail` naming the risk class plus the literal
  `riskClass`, `path`, `author` and `reason` fields to add to the PRD
  directory's `afk.json`. Declaring the path in the contract's `fileScope` is
  never authorization (`prd.md` D5, D24). A changed-set probe that cannot answer
  returns `INFRASTRUCTURE`, never an empty violation list.
- [behavior:B-04] The same gate FAILs closed on a deleted test: a path matching
  a `gatePolicy.protectedPaths.testGlobs` glob that exists on the comparison
  base and not in the candidate, named exactly in `findings.deletedTests`,
  unless a `deleted-test` waiver covers it. With no policy the default
  `**/*.test.ts` applies. Glob matching calls #84's exported
  `matchesGlob` (`src/gate-policy.ts:365`) and no second matcher is written
  (`prd.md` D6). The comparison is the candidate source the `scope` and
  `tests:skipped` gates already take — the live slice worktree against
  `featureRef`, because the candidate is not committed at the post-QA call site
  (`prd.md` D3).
- [behavior:B-05] A launch waiver whose `riskClass` and `path` cover a detected
  protected change or deleted test exempts that path, and the gate records the
  waiver's four fields in `GateResult.findings.appliedWaivers`. A candidate with
  every detection waived PASSes.
- [behavior:B-06] The gate reads waivers only from the launch manifest the CLI
  loaded from `--prd-dir` (`loadAfkManifest`, `src/afk.ts:157` and the two
  sibling entries, reaching the gate through `config.manifest`), so a waiver
  present only in the candidate worktree's `afk.json` exempts nothing and the
  gate still FAILs — the actor being constrained cannot author its own
  exemption (`prd.md` D5).
- [behavior:B-07] The gate enforces only the risk classes present in
  `gatePolicy.riskClasses`: a policy that omits `gate-policy` or `deleted-test`
  suppresses that rule and the omission is stated in `detail`, so the catalog
  declares what is enforced (#193 "the same comparison enforces the
  catalog-declared escalation risk classes").
- [behavior:B-08] The declaration takes `acceptedPairIntact` from the value
  `src/orchestrator.ts` already earned at the accepted-pair integrity check and
  never a fresh one; when it is `false` the gate FAILs closed naming
  `contract.md` and `acceptance-manifest.json` as `gate-policy`-class protected
  changes that no waiver may exempt, because an agent-authored lock change is
  the posture D5 refuses.
- [behavior:B-09] `ScopeEscalation` (`src/escalation.ts`) accepts schema version
  2 with an optional `gateEvidence: { gateId, evidenceArtifactId }`, both
  non-blank strings, and exports `GATE_SCOPE_FINDING_ID = "GATE-SCOPE"` beside
  `PRE_BUILD_SCOPE_FINDING_ID`. `requireExactKeys` admits `gateEvidence`
  conditionally on version 2, never unconditionally. `gateEvidence` present
  requires `findingIds` to be exactly `["GATE-SCOPE"]`; `GATE-SCOPE` present
  requires `gateEvidence`; neither may mix with a cited finding ID or with
  `PRE-BUILD-SCOPE`; a version-1 document carrying `gateEvidence` is refused; a
  version-2 document without `gateEvidence` is an ordinary cited-finding or
  `PRE-BUILD-SCOPE` escalation, because version is a schema version and not a
  document kind (`prd.md` D12).
- [behavior:B-10] A `GATE-SCOPE` escalation is accepted through ADR 0052's
  existing focused-revision door in `src/orchestrator.ts` — no second request
  channel — and produces the same focused scope revision, so a failing
  orchestrator-run deterministic gate warrants a revision for behavior the
  locked contract already decided (`prd.md` D12; ADR 0050, ADR 0052).
- [behavior:B-11] `archivedScopeEscalations` (`src/artifacts.ts`) accepts a
  version-2 archived record instead of marking it `invalid`, and
  `renderStuckDiagnosis` renders the record's `gateId` and `evidenceArtifactId`,
  so the accepted revision's review-archive record under
  `.afk/artifacts/<run-slug>/slice-<n>/reviews/` preserves both (#193 AC4).
- [behavior:B-12] Immediately after `gateArtifacts.push(...postQaGates.artifacts)`
  (`src/orchestrator.ts:6001`, which precedes the CANCELLED/ERROR/REPAIR
  branches) the orchestrator calls the already-exported `readGateEvidence` on
  each pushed artifact's `evidencePath`, passes the evidence through a new pure
  export `appliedWaiversFrom(evidence)` in `src/feedback-integrity-gate.ts`
  which collects `findings.appliedWaivers` from every result, emits one
  `waiver-applied` run event per waiver through `logger.event`, and persists
  them with `saveAppliedWaivers`. This is the one producing seam, and it works
  on the gate's PASS path, where no result object carries findings (`prd.md`
  D23).
- [behavior:B-13] `src/run-state.ts` goes version 3 → 4, adding an optional
  per-slice `appliedWaivers` record keyed by GH issue holding D5's four fields,
  and a `saveAppliedWaivers(repoRoot, prdSlug, ghIssue, waivers)` writer
  modelled on `saveFiledFindings` (`src/run-state.ts:1058`) that re-reads state
  and ignores an already-recorded `riskClass` + `path` pair. `adaptLoadedState`
  accepts versions 1, 2, 3 and 4 and always returns version 4, defaulting the
  new field absent, so a resumed run knows which waivers were already applied
  (`prd.md` D22). Keyed beside `slices` rather than inside
  `PersistedSliceState` because a RUNNING slice has no persisted record yet
  (ADR 0018) and the waiver is written at gate time.
- [behavior:B-14] `Logger.writeSummary` (`src/logger.ts`) renders an
  `## Applied Waivers` section in `run-summary.md` from the run's
  `waiver-applied` events — slice, risk class, exact path, author, reason — and
  omits the section entirely when there are none (`prd.md` D5, D24).
- [behavior:B-15] `SkipGateInput` (`src/skip-gate.ts`) takes the launch
  `skipped-test` waivers, and `src/orchestrator.ts` passes them at the existing
  declaration site. A waived path is excluded from both the base and the
  candidate scan — and therefore from the uncovered-file fail-closed check, a
  file the operator waived by name being one the gate is instructed not to speak
  for — and each waived path present in the candidate is recorded in
  `findings.appliedWaivers`. Contract file scope alone authorizes nothing. This
  is #86's authorization criterion re-homed here because this slice owns the one
  waiver reader (`prd.md` D5, D23's wave note; #193 AC13).
- [behavior:B-16] `prompts/generator.md`, `prompts/generator-repair.md` and
  `agents/generator.md` teach a three-way escalation branch in their byte-shared
  `Scope escalation` section — routed finding IDs, `PRE-BUILD-SCOPE`, or
  `GATE-SCOPE` plus `gateEvidence` citing a failing orchestrator-run gate —
  against a version-2 JSON literal, and state that a discovery which changes
  behavior, a public interface, a data format, security posture or acceptance
  criteria escalates for a human decision instead of revising scope. The
  version-1 literal and `PRE-BUILD-SCOPE` sentence pinned in
  `src/prompt-template.test.ts:167-191` are updated in lockstep (`prd.md` D12;
  ADR 0052).
- [behavior:B-17] `prompts/evaluator-contract.md` and
  `prompts/evaluator-contract-revision.md` gain ADR 0060's parser-regression
  rubric text additively: a contract that changes a parser's accepted input
  language must bind positive and rejected-or-boundary regression evidence, and
  where the established harness is fixture-backed must declare the owning
  fixture area and the concrete existing fixture paths expected to change or
  explicitly authorize new fixtures there, inline tests staying valid when they
  are the established harness (`prd.md` D13; ADR 0060).

### Non-goals (explicit out-of-scope)

- No park record, `AWAITING-ADJUDICATION` phase or adjudication-estate identity
  for a gate finding: an unwaived protected change blocks the merge through the
  existing `REPAIR` path (`prd.md` D24).
- No new skip detector and no universal skip regex — #86 owns detection; only
  its authorization lands here.
- No acceptance-manifest schema change: `src/acceptance-manifest.ts` stays at
  version 2 and is not edited (`prd.md` D13).
- No second scope-revision request channel, no change to ADR 0048's
  after-the-fact amendment door, and no reconciliation of the two doors.
- No edits to `src/gate-runner.ts`, `src/post-qa-gates.ts`,
  `src/candidate-gate-phase.ts`, `src/base-gates.ts` or `src/gate-policy.ts`:
  `GateFindings` and `GATE_EVIDENCE_VERSION = 3` already carry every field this
  slice populates, and D23 froze the first three rather than widening
  `PostQAGateResult`'s PASS branch.
- No gate-cache participation for the new gate: only the command path consults
  the cache (`src/gate-runner.ts` `RunGatesOptions`).

### Existing behavior to preserve

- [behavior:P-01] `parseScopeEscalation` (`src/escalation.ts:264`) parses a
  version-1 document exactly as today, including the mandatory non-empty unique
  `findingIds`, the `PRE-BUILD-SCOPE` sole-entry rule, path normalization
  against the locked manifest, migration-path refusal and the non-blank
  `reason`; `PRE_BUILD_SCOPE_FINDING_ID` behavior is untouched (ADR 0052).
- [behavior:P-02] The focused-revision door still refuses any escalation —
  `GATE-SCOPE` included — when `outOfScopeChangedPaths` reports the worktree
  already holds changes outside the locked file scope, so a gate failure never
  legalizes existing out-of-scope work (`src/orchestrator.ts`; ADR 0052).
- [behavior:P-03] `MAX_SCOPE_REVISIONS_PER_ROUND` still bounds revisions per
  implementation round, `GATE-SCOPE` included, and the accepted-pair mutation
  refusal and restore still run before any escalation is read (ADR 0050, ADR
  0051).
- [behavior:P-04] Both evaluator prompts keep their `# Durable finding lineage`
  and `# Control-plane situation` sections, their `{{DURABLE_FINDING_LINEAGE}}`
  and `{{CONTROL_SITUATION}}` placeholders, and the bullets enumerating the
  legal `severity` and `state` values (ADR 0061); the rubric addition is
  additive.
- [behavior:P-05] Without a covering waiver the `tests:skipped` gate still fails
  closed exactly as #86 shipped it, including the `CONFIGURATION` failures for
  no declared detector and for a declared test file no detector covers, and
  counting still fires only on an increase over the base.
- [behavior:P-06] A contract-evaluator `REVISE` verdict still blocks the
  contract lock, which is the refusal path a citation of the new rubric rule
  travels; and `run-summary.md` bytes are unchanged for a run that applied no
  waiver.

### Changes to existing behavior (only if the issue asks for it)

- `src/skip-gate.ts` gains waiver authorization: a path covered by a
  `skipped-test` launch waiver is no longer counted and no longer triggers the
  uncovered-file refusal (#193 AC13, moved from #86 on 2026-09-08).
- `archivedScopeEscalations` (`src/artifacts.ts`) no longer marks a version-2
  escalation record `invalid` (#193 AC4).

## Files expected to change

- src/afk-manifest.ts
- src/afk-manifest.test.ts
- src/feedback-integrity-gate.ts
- src/feedback-integrity-gate.test.ts
- src/escalation.ts
- src/escalation.test.ts
- src/artifacts.ts
- src/artifacts.test.ts
- src/skip-gate.ts
- src/skip-gate.test.ts
- src/run-state.ts
- src/run-state.test.ts
- src/run-events.ts
- src/logger.ts
- src/logger.test.ts
- src/orchestrator.ts
- src/orchestrator.test.ts
- src/prompt-template.test.ts
- prompts/generator.md
- prompts/generator-repair.md
- prompts/evaluator-contract.md
- prompts/evaluator-contract-revision.md
- agents/generator.md

## Migration requirements

- New migration files: 0

## New patterns / deps / schema (if any)

- New module `src/feedback-integrity-gate.ts` (gate id `feedback-integrity`),
  following the existing in-process gate pattern; it also exports the pure
  `appliedWaiversFrom(evidence)`.
- `afk.json` gains optional `protectedChangeWaivers` at manifest version 1
  (additive, absent reads as empty).
- `escalation.md` schema version 2 with optional `gateEvidence`.
- `RunState` version 3 → 4 with an optional per-slice `appliedWaivers` record.
- `RunEventPayload` gains a `waiver-applied` member (the union is explicitly
  open, `src/run-events.ts:31`).
- No new runtime dependency — AFK has none.

## Test plan

- Given an `afk.json` with a valid `protectedChangeWaivers` entry, when
  `parseAfkManifest` runs, then the four fields survive; and given an unknown
  `riskClass`, a `path` containing `*`, a blank field or a duplicate
  `riskClass` + `path` pair, then the launch throws naming the offender
  (`src/afk-manifest.test.ts`, B-01).
- Given a manifest carrying waivers, when `trimUnclaimedMigrationPrefixes`
  rewrites it, then the waivers are still on disk
  (`src/afk-manifest.test.ts`, B-02).
- Given a worktree that changed `afk.config.json` with no waiver, when the
  `feedback-integrity` gate runs, then it FAILs with `protectedChanges` naming
  `afk.config.json` and a `detail` naming the risk class and the four `afk.json`
  fields — including when the path is declared in `fileScope`; and given the
  changed-set probe fails, then the status is `INFRASTRUCTURE`
  (`src/feedback-integrity-gate.test.ts`, B-03).
- Given `src/foo.test.ts` on the feature branch and deleted in the candidate
  with no policy file, when the gate runs, then it FAILs with `deletedTests`
  naming `src/foo.test.ts`; and given a `deleted-test` waiver for that path,
  then it PASSes with the waiver in `appliedWaivers`
  (`src/feedback-integrity-gate.test.ts`, B-04, B-05).
- Given a waiver present only in the candidate worktree's `afk.json` and not in
  the launch manifest, when the gate runs, then it still FAILs
  (`src/feedback-integrity-gate.test.ts`, B-06).
- Given a `gatePolicy.riskClasses` omitting `deleted-test`, when a test file is
  deleted, then the gate does not FAIL for it and `detail` says the class is not
  enforced (`src/feedback-integrity-gate.test.ts`, B-07).
- Given `acceptedPairIntact: false`, when the gate runs, then it FAILs naming
  `contract.md` and `acceptance-manifest.json`, and a `gate-policy` waiver for
  either does not exempt it (`src/feedback-integrity-gate.test.ts`, B-08).
- Given a version-2 `escalation.md` with `gateEvidence` and
  `findingIds: ["GATE-SCOPE"]`, when `parseScopeEscalation` runs, then it
  parses; and given `gateEvidence` with any other `findingIds`, `GATE-SCOPE`
  without `gateEvidence`, `GATE-SCOPE` mixed with a cited ID or with
  `PRE-BUILD-SCOPE`, version 1 carrying `gateEvidence`, or an unknown key, then
  it throws; and given the existing version-1 fixtures, then they parse
  unchanged (`src/escalation.test.ts`, B-09, P-01).
- Given a locked slice whose worktree holds no undeclared change, when the
  generator writes a `GATE-SCOPE` escalation citing a failing gate, then the
  orchestrator accepts it and the next round's file scope carries the requested
  path; and given the requested path was already edited, then the round ends
  ERROR naming the undeclared change and the scope is not widened; and given a
  third escalation in one round, then it is refused — added as `it`s on the
  existing `describe("generator scope escalation", ...)` scenario in
  `src/orchestrator.test.ts` rather than a new spawn (B-10, P-02, P-03).
- Given an archived `escalation-r1-a1.md` at version 2 with `gateEvidence`, when
  `renderStuckDiagnosis` runs, then the record is not `invalid` and the rendered
  diagnosis contains the `gateId` and the `evidenceArtifactId`
  (`src/artifacts.test.ts`, B-11).
- Given gate evidence whose results carry `appliedWaivers`, when
  `appliedWaiversFrom` reads it, then every waiver is returned once; and given a
  run whose `feedback-integrity` gate passed on a waived path, then a
  `waiver-applied` event is on the run's event log and the persisted state
  records the waiver for that GH issue (`src/feedback-integrity-gate.test.ts`
  plus an `it` on an existing spawned `src/orchestrator.test.ts` scenario,
  B-12).
- Given a hand-written version-3 run-state file with every other field present,
  when `loadRunState` reads it, then the state is version 4 with
  `appliedWaivers` absent-as-empty; and given `saveAppliedWaivers` called twice
  with the same `riskClass` + `path`, then one record is stored
  (`src/run-state.test.ts`, B-13).
- Given a run whose events include a `waiver-applied` payload, when
  `writeSummary` runs, then `run-summary.md` carries an `## Applied Waivers`
  section with the risk class, exact path, author and reason; and given no such
  event, then the section is absent and the bytes are unchanged
  (`src/logger.test.ts`, B-14, P-06).
- Given a `skipped-test` waiver for a candidate test file that adds an
  `it.skip`, when the `tests:skipped` gate runs, then it PASSes with the waiver
  in `appliedWaivers`; and given no waiver, then it FAILs as #86 shipped it,
  including the two `CONFIGURATION` refusals (`src/skip-gate.test.ts`, B-15,
  P-05).
- Given the three generator-facing sources, when their `Scope escalation`
  sections are read, then each carries the version-2 JSON literal, all three
  branches, and the escalate-instead-of-revise rule; and given both evaluator
  prompts, then each carries the parser-regression rubric text and still carries
  `# Durable finding lineage`, `# Control-plane situation` and the `severity` /
  `state` bullets (`src/prompt-template.test.ts`, B-16, B-17, P-04).

## Definition of done

- [ ] Every behavior above is bound by a test in the declared file, and
      `pnpm run typecheck` and the declared suites pass.
- [ ] `src/gate-runner.ts`, `src/post-qa-gates.ts`, `src/candidate-gate-phase.ts`,
      `src/base-gates.ts`, `src/gate-policy.ts` and
      `src/acceptance-manifest.ts` are unedited; `GATE_EVIDENCE_VERSION` stays 3
      and the acceptance manifest stays at version 2.
- [ ] The `feedback-integrity` gate is declared exactly once, at the existing
      post-QA declaration site in `src/orchestrator.ts`, and no rule of it is
      implemented anywhere else.
- [ ] One waiver reader exists: `src/afk-manifest.ts`, reached from the launch
      manifest only, with no second reader and no glob matcher of its own.
- [ ] An applied waiver is observable at all three points — gate evidence,
      a `waiver-applied` run event plus `run-summary.md`, and persisted run
      state — from one run, with no field written by nothing.
- [ ] Changed files are exactly the declared file scope; no new migration file.

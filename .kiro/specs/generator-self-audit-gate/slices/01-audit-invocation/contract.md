# Slice Contract — Opt-in audit invocation and the unchanged-tree happy path

**Parent PRD:** .kiro/specs/generator-self-audit-gate/prd.md
**GH issue:** #299
**Status:** LOCKED

**Lock-Provenance:** negotiation round 2
**Negotiation round:** 2

## Scope lock

Behind a new `--self-audit` flag (default off), a candidate that has passed its
required cheap gates receives exactly one generator audit invocation in its own
worktree between the gate-release assertion and the deterministic QA dispatch in
`src/orchestrator.ts`. A new `src/self-audit.ts` module owns the stage: it
assembles a new `generator-audit` context-envelope manifest over the locked
contract pair, the candidate's handoff and the candidate's change summary in a
fixed input order under the standard 64 KiB inline budget, dispatches the
invocation once through an injected callback, re-hashes the worktree with the
same exact-tree identity the gate cache uses (`resolveCandidateTreeId`,
`src/gate-runner.ts:280`), and classifies the outcome with a pure function
covering `AUDIT_UNCHANGED`, `AUDIT_CHANGED` and `AUDIT_NOT_RUN`. Only the
unchanged-tree path is orchestrated here: on an identical tree the stage itself
records `AUDIT_UNCHANGED` in run state (schema v7) before it returns, and the
candidate proceeds to QA on the orchestrator's existing bindings. With the flag absent nothing is
dispatched, nothing is recorded, and the gates-passed branch behaves exactly as
it does today.

### In scope

- [behavior:B-01] `--self-audit` is one exact-token boolean runtime option in
  `src/cli-options.ts`, parsed like `recordPrompts` (`src/cli-options.ts:65`,
  `:255`, `:289`): present sets `selfAudit: true`, absent leaves the field
  unset, and near misses (`--self-audit=true`, `--self-audits`) are not the
  flag. `PipelineConfig` in `src/orchestrator.ts` gains `selfAudit?: boolean`,
  which is all three CLI entries need — they already spread `...runtimeOptions`
  into `runPipeline` (`src/afk.ts:314`). No second knob and no per-slice
  configuration (PRD "Implementation Decisions").
- [behavior:B-02] `runSelfAuditStage` in `src/self-audit.ts` declines without
  dispatching when the run did not opt in (`selfAudit` not true), and likewise
  when the released base-gate evidence it was handed disagrees with the
  checkpoint it was handed (`qaBaseGate.candidateTreeId !== checkpoint.treeId`).
  In both cases it calls its `dispatch` callback zero times, writes no run-state
  entry, and returns `{ ran: false }`. It declines rather than throws: the gate
  may add scrutiny and may never block a run by its own failure (PRD Solution).
- [behavior:B-03] `src/orchestrator.ts` gains exactly one `runSelfAuditStage(`
  call site, inside `runSliceExecute`'s gates-passed branch, after the
  `assertGateEvidenceReleasesEvaluation(` call (`src/orchestrator.ts:6385`) and
  the `qaBaseGate` construction (`:6395-6403`), and before the deterministic QA
  dispatch (`:6415`). The required-cheap-gate failure branch (`:6341-6383`)
  contains no audit call site, so a candidate that failed a required gate is
  never audited. New behavior lives in the new module with one call site in the
  hub (ARCHITECTURE.md "Hubs — do not grow these"). The scan is a source-order
  assertion only: it observes where the call site sits, never what the injected
  `dispatch` argument does. No declared observation in this slice binds that
  argument to a real generator invocation in the candidate worktree — with
  `--self-audit` default off and a new spawned pipeline scenario an explicit
  non-goal, the orchestrator-to-provider wiring is carried by `pnpm run
  typecheck` accepting the callback's type and by nothing else. It is first
  exercised for real by an operator self-run launched with `--self-audit`, whose
  audit outcomes become readable through the run-summary totals and status
  surfaces #301 owns; #300 is the sibling slice that builds the changed-tree
  path over the same injected dispatch. Stated deliberately so no candidate
  reads the stage's dispatch-spy tests as coverage of the wiring.
- [behavior:B-04] `src/context-envelope.ts` gains
  `SELF_AUDIT_CONTEXT_MANIFEST` — `role: "generator-audit"`, added to
  `PromptAssemblyRole` (`src/context-envelope.ts:827`) because assembly consumes
  it — declaring the complete role contract that
  `validateContextEnvelopeManifest` requires: objective, non-goals,
  `allowedWriteScope` limited to the slice worktree, stop conditions,
  escalation conditions, accepted input artifact classes, output artifact,
  `inlineSizeBudgetBytes: 65_536` (the standard budget every other role
  declares), and `omittedArtifactClasses`. `inputOrder` is exactly
  `["locked-contract", "acceptance-manifest", "candidate-handoff",
  "change-summary"]`: the audit re-reads what it was contracted to build before
  its own account of building it, and reads that before the diff.
- [behavior:B-05] `assembleSelfAuditEnvelope` in `src/context-envelope.ts`
  renders `prompts/generator-audit.md` and returns the envelope through
  `assembleContextEnvelope` (`src/context-envelope.ts:1284`), so the manifest's
  declared input order and the effective byte budget are enforced by the one
  existing validator rather than by a second copy: an envelope whose blocks are
  rendered out of manifest order, and one whose assembled prompt exceeds the
  effective budget, both fail closed before any evidence is emitted.
- [behavior:B-06] The audit envelope's byte-budget override is stricter-only:
  the effective budget is `min(override, manifest budget)`, so an override
  above 65_536 is clamped to the manifest budget and an override below it is
  honored (`src/context-envelope.ts:1327-1330`).
- [behavior:B-07] `prompts/generator-audit.md` states the audit challenge —
  re-read the locked contract, trace every done-criterion to code and to test
  evidence, examine boundaries and failure cases, commit a fix only if the
  audit finds a gap — and states in its own words that resubmitting the
  candidate unchanged is a legitimate outcome, so the generator is not pressured
  into cosmetic churn (PRD user story 12). It carries no `{{TEST_COMMAND}}`
  placeholder and every placeholder it does declare is rendered.
- [behavior:B-08] `classifySelfAuditVerdict` in `src/self-audit.ts` is a pure
  function over the pre-audit tree identity, the post-audit tree identity and
  the invocation result, returning one of `AUDIT_UNCHANGED`, `AUDIT_CHANGED`,
  `AUDIT_NOT_RUN` plus the tree id QA would grade and a reason string. Equal
  ids classify `AUDIT_UNCHANGED`; different ids classify `AUDIT_CHANGED`; an
  invocation that did not complete classifies `AUDIT_NOT_RUN`, and so does a
  completed invocation whose post-audit tree id could not be resolved —
  uncertain classification takes the branch that cannot loop (ADR 0041), which
  is the branch that proceeds to QA on the tree the gates released. The
  function reads no filesystem and no run state; prior art is `decideFinalReuse`
  (`src/final-evaluation.ts:117`).
- [behavior:B-09] On an identical tree the stage returns
  `{ ran: true, verdict: "AUDIT_UNCHANGED", treeId }` where `treeId` is the
  checkpoint tree id the gates released, having called `dispatch` exactly once
  — one invocation per QA submission, bounded by construction, with no second
  challenge and no retry in this slice — having recorded exactly one
  `AUDIT_UNCHANGED` entry for the slice's GitHub issue through
  `recordSelfAuditOutcome` (B-10) before it returns, whose `candidateTreeId` and
  `auditedTreeId` are both that released tree id, and having mutated neither the
  `qaBaseGate` object nor the `checkpoint` object it was given, so the
  orchestrator's own bindings are still the ones it goes on to pass to the
  deterministic QA dispatch (issue #299 operator decision, 2026-09-14, part 1).
  Writing the entry is the stage's obligation, not the writer's: the observation
  reads `selfAuditsFor(loadRunState(...), ghIssue)` after awaiting the stage
  against the same temporary run-state directory B-02 already declares, so it
  fails when the stage classifies `AUDIT_UNCHANGED` and records nothing —
  #299 AC10, and the inverse of ARCHITECTURE.md's "a record no reader checks is
  decoration".
  The invocation runs in the slice's own worktree through the injected callback,
  under the existing per-invocation bounds and the one `AgentProvider` interface
  (ADR 0002, ADR 0007) — it is a re-dispatch of the generator, not a new agent
  role or a new backend. That sentence is carried by `pnpm run typecheck` alone
  in this slice; B-03 records why and names what exercises it later.
- [behavior:B-10] `src/run-state.ts` gains an additive `selfAudits?:
  Record<string, PersistedSelfAuditOutcome[]>` keyed by GitHub issue, a
  `PersistedSelfAuditOutcome` carrying `{ candidateTreeId, auditedTreeId?,
  verdict }` over the three verdicts, a reader `selfAuditsFor`, a writer
  `recordSelfAuditOutcome`, sanitization in `adaptLoadedState`, and
  `RUN_STATE_VERSION = 7` with the version union widened to `3 | 4 | 5 | 6 | 7`.
  A persisted fact extends this schema with a version bump and a reader
  (ARCHITECTURE.md "Placement rules"), and the bump is unconditional for the
  same reason v6's was (`src/run-state.ts:50-67`): "no audit ran" and "this file
  predates audits" are the same fact to every reader. The writer is round-tripped
  against the reader here — one written `AUDIT_UNCHANGED` entry reads back with
  both tree ids intact and the reloaded file at version 7 — while the obligation
  that a classifying stage actually calls it the moment the verdict lands is
  B-09's, observed there on the stage's own entry point so that an unreferenced
  writer cannot pass. The three tests that pin
  the literal `6` (`src/eval-boundary.test.ts:127`,
  `src/qa-orchestration.test.ts:1028`,
  `src/qa-orchestration-gates.test.ts:1043`) move to `7`.
- [behavior:B-11] `docs/adr/0069-bounded-generator-self-audit-before-qa-dispatch.md`
  records the mechanism (structural tree comparison across one generator
  re-dispatch, never an agent-certified verdict), its provenance (SwarmForge's
  two-call audit gate, github.com/unclebob/swarm-forge `swarm_handoff.sh`), and
  the one-invocation-per-QA-submission bound as the standing argument against a
  future audit-of-the-audit, following the existing ADR structure (H1 title,
  `**Status:**`/`**Date:**`, narrative, `## Decision`, `## Consequences`).

### Non-goals (explicit out-of-scope)

- Orchestrating the changed-tree path: no re-run of the required cheap gates on
  an audited tree, and no edit to any argument of the deterministic QA dispatch
  at `src/orchestrator.ts:6415`. #300 owns that call site and the value-level
  assertion about what QA receives, and its issue body records the spread-override
  and pass-through risks there. Until #300 lands, an `AUDIT_CHANGED` verdict is
  classified and returned but changes nothing downstream; the exposure is bounded
  because `--self-audit` is off by default and #300 is in the same wave on the
  same feature branch. Recorded here rather than escalated: the routing is the
  operator's, not this contract's.
- The agent-failure-cause taxonomy for a dead audit invocation, its
  infrastructure-only retry, run-ID provenance, resume-treats-audit-as-spent,
  run-summary totals and changed-rate, status surfaces, and CONTEXT.md's three
  outcome terms — all #301 (ADR 0025 governs the taxonomy there).
- Recording `AUDIT_CHANGED` or `AUDIT_NOT_RUN` in run state. This slice lands
  the persisted shape covering all three verdicts so neither sibling slice needs
  a second version bump, but only `AUDIT_UNCHANGED` is written here.
- Retiring the `# Self-audit before commit` prose in `prompts/generator.md` and
  `prompts/generator-repair.md`, and the default-on decision (PRD "Out of
  Scope").
- Auditing any other role's output, any gate/merge/dispatch decision keyed on
  the audit rate, a second challenge for changed trees, and any change to QA
  evaluator behavior, inputs or the sanity command set (ADR 0012 untouched).
- A new spawned pipeline scenario, a new `prompt-assembly`/`invocation-completed`
  event, and an `ARCHITECTURE.md` module row.

### Existing behavior to preserve

- [behavior:P-01] ADR 0012's base-gate skip authorization keeps its current
  behavior: `authorizeBaseGateSkip` still refuses when the evidence's tree id
  does not match the tree under review, and neither
  `src/qa-gate-authorization.ts`, `src/post-qa-gates.ts` nor
  `src/gate-runner.ts` is touched — the stage imports `resolveCandidateTreeId`
  (`src/gate-runner.ts:280`) and changes nothing there.
- [behavior:P-02] A candidate that fails a required cheap gate keeps today's
  exit: the `requiredFailures.length > 0` branch (`src/orchestrator.ts:6341`)
  still builds the base-gate repair references and returns through
  `finishIntervention(candidateLifecycle.exhaustDeterministicGates(...))`
  (`:6375-6383`) with no audit dispatched.
- [behavior:P-03] Every run-state file written before this slice still loads:
  a v3–v6 file adapts in memory with no `selfAudits` member and every other
  field intact, and `writeRunState` re-stamps the current version, exactly as
  the v4, v5 and v6 additions did (`src/run-state.ts:993-1012`).
- [behavior:P-04] The four existing assembly-wired envelopes are unchanged by
  the fifth manifest: `EXPLORER_`, `PLANNER_`, `CONTRACT_EVALUATOR_` and
  `GENERATOR_CONTEXT_MANIFEST` keep their declared fields, budgets and input
  orders, `"cleaner"` stays a `ContextEnvelopeRole` that is not a
  `PromptAssemblyRole` (`src/context-envelope.test.ts:3251`), and
  `prompts/generator.md` and `prompts/generator-repair.md` are not edited.

### Changes to existing behavior (only if the issue asks for it)

- `RUN_STATE_VERSION` moves from `6` to `7` and `RunState.version` widens to
  `3 | 4 | 5 | 6 | 7`, authorized by the issue's requirement that an identical
  pre- and post-audit tree "records `AUDIT_UNCHANGED` in run state" plus
  ARCHITECTURE.md's placement rule that a new persisted fact carries a version
  bump. Purely additive: no field is removed, renamed or reinterpreted.
- `PromptAssemblyRole` gains `"generator-audit"`, authorized by the issue's
  settled decision that the envelope is "a new per-role manifest in the
  context-envelope layer under the standard inline budget with stricter-only
  overrides" — assembly, not manifest-only, is what enforces the order and the
  budget. Additive: no existing role's assembly path changes.

## Files expected to change

- src/self-audit.ts
- src/self-audit.test.ts
- src/context-envelope.ts
- src/context-envelope.test.ts
- prompts/generator-audit.md
- src/cli-options.ts
- src/cli-options.test.ts
- src/orchestrator.ts
- src/orchestrator.test.ts
- src/run-state.ts
- src/run-state.test.ts
- src/eval-boundary.test.ts
- src/qa-orchestration.test.ts
- src/qa-orchestration-gates.test.ts
- docs/adr/0069-bounded-generator-self-audit-before-qa-dispatch.md

## Migration requirements

- New migration files: 0

## New patterns / deps / schema (if any)

- New module `src/self-audit.ts` (stage + pure classifier), dispatching through
  an injected callback like `src/cleaner-stage.ts:745`'s `ctx.dispatch`, so the
  stage is unit-testable without a provider.
- New context-envelope role `"generator-audit"` with
  `SELF_AUDIT_CONTEXT_MANIFEST` and `assembleSelfAuditEnvelope`.
- New prompt template `prompts/generator-audit.md`.
- Run-state schema v7: additive `selfAudits` record, no migration file.
- New ADR 0069. No new dependencies.

## Test plan

- Given `["--self-audit"]`, when `parsePipelineRuntimeOptions` parses it, then
  `selfAudit` is `true`; given `[]`, `["--self-audit=true"]` or
  `["--self-audits"]`, then `selfAudit` is `undefined`.
- Given a stage input with `selfAudit` not true, and separately one whose
  `qaBaseGate.candidateTreeId` differs from `checkpoint.treeId`, when
  `runSelfAuditStage` runs, then it returns `{ ran: false }`, the dispatch spy
  recorded zero calls, and no run-state entry exists.
- Given `src/orchestrator.ts` read as text, when a scan collects occurrence
  indices of `runSelfAuditStage(`, `assertGateEvidenceReleasesEvaluation(`,
  the `collectRequiredGateFailures(` call assigned to `requiredFailures` and
  `await runQAStage(` — excluding declaration occurrences by anchoring on
  `await runQAStage(` and on the assignment form of
  `collectRequiredGateFailures(`, per the issue's operator decision part 2 —
  then there is exactly one `runSelfAuditStage(` occurrence, it sits after the
  gate-release assertion and before the first `await runQAStage(`, and none
  sits between the required-failure call and the gate-release assertion. The
  scan asserts nothing about the injected `dispatch` argument: that the callback
  reaches a real generator invocation is proven only by `pnpm run typecheck`
  here, and no test in this slice claims otherwise.
- Given `SELF_AUDIT_CONTEXT_MANIFEST`, when `validateContextEnvelopeManifest`
  runs, then it does not throw, `inlineSizeBudgetBytes` is `65_536`, and
  `inputOrder` is exactly the four declared classes in the declared order.
- Given envelope inputs whose rendered blocks are out of manifest order, and
  separately inputs whose assembled prompt exceeds the effective budget, when
  `assembleSelfAuditEnvelope` runs, then it throws before returning evidence;
  given in-order inputs within budget, then the evidence lists the four
  artifact classes in order.
- Given an override of `65_536 * 4` and a prompt over the standard budget, when
  the envelope assembles, then it still throws; given an override of a few
  hundred bytes and a prompt that fits the standard budget, then it throws too.
- Given `prompts/generator-audit.md` rendered with its declared arguments, then
  the text states that an unchanged resubmission is legitimate, names the four
  audit obligations, contains no unrendered `{{…}}` placeholder and no
  `TEST_COMMAND`.
- Given equal, unequal, missing and unresolvable tree-identity inputs, when
  `classifySelfAuditVerdict` runs, then the verdicts are `AUDIT_UNCHANGED`,
  `AUDIT_CHANGED`, `AUDIT_NOT_RUN` and `AUDIT_NOT_RUN`, with the returned tree
  id being the pre-audit tree id in every case except `AUDIT_CHANGED`.
- Given a dispatch that leaves the worktree tree identical to the released
  checkpoint tree id and a temporary run-state directory, when the stage runs,
  then it returns
  `{ ran: true, verdict: "AUDIT_UNCHANGED", treeId: <released tree id> }`, the
  dispatch spy recorded exactly one call, `selfAuditsFor(loadRunState(<that
  directory>), ghIssue)` returns exactly one entry whose `verdict` is
  `"AUDIT_UNCHANGED"` and whose `candidateTreeId` and `auditedTreeId` both equal
  the released tree id, and deep snapshots of the passed `qaBaseGate` and
  `checkpoint` objects taken before the call still equal them afterwards. A stage
  that classifies `AUDIT_UNCHANGED` without calling `recordSelfAuditOutcome`
  fails this scenario.
- Given a run state with no `selfAudits`, when `recordSelfAuditOutcome` writes
  an `AUDIT_UNCHANGED` entry, then `selfAuditsFor` returns one entry whose
  `candidateTreeId` and `auditedTreeId` are the released tree id, and the
  reloaded file's `version` is `7`; given a v6 fixture, then it loads with no
  `selfAudits` member and every other field intact.
- Given `docs/adr/0069-bounded-generator-self-audit-before-qa-dispatch.md`
  read as text, then it names the tree-comparison mechanism, `swarm-forge` as
  the provenance, and the one-invocation bound.

## Definition of done

- [ ] `--self-audit` parses to `PipelineConfig.selfAudit` and defaults off.
- [ ] `src/orchestrator.ts` holds exactly one `runSelfAuditStage(` call site,
      in the gates-passed branch between the gate-release assertion and the
      deterministic QA dispatch, and none in the required-failure branch.
- [ ] `SELF_AUDIT_CONTEXT_MANIFEST` validates, declares the four accepted input
      classes in a fixed order, and declares the standard 65_536-byte budget.
- [ ] `assembleSelfAuditEnvelope` enforces that order and budget through
      `assembleContextEnvelope`, and clamps an over-large override.
- [ ] `prompts/generator-audit.md` states the audit challenge and that an
      unchanged resubmission is legitimate.
- [ ] `classifySelfAuditVerdict` is pure and covers all three verdicts.
- [ ] An `AUDIT_UNCHANGED` stage run dispatches exactly once, returns the
      released tree id, mutates neither object it was given, and records one
      run-state entry under schema v7.
- [ ] ADR 0069 records mechanism, SwarmForge provenance and the one-invocation
      bound.
- [ ] Every new assertion lives at an existing unit seam; no new spawned
      pipeline scenario is added.
- [ ] Only the paths in `## Files expected to change` are edited; migration
      count is 0.
- [ ] `pnpm run typecheck`, `pnpm test:fast`, and the heavy suites this scope
      touches (`test:heavy:orchestrator`, `test:heavy:qa-orchestration`) pass.

# Slice Contract — File-scope gate

**Parent PRD:** .kiro/specs/afk-v2-acceptance-scope-gates/prd.md
**GH issue:** #195
**Status:** LOCKED

**Lock-Provenance:** negotiation round 1
**Negotiation round:** 1

## Scope lock

A new module `src/scope-gate.ts` wraps the two comparison halves that already
exist — `outOfScopeChangedPaths` (`src/escalation.ts:196`) and
`listChangedFiles` / `diffTreePaths` (`src/git.ts:1272`, `:1323`) — as one
required in-process gate, id `scope`, stage `deterministic` (`prd.md` D2, D3,
D4). It is declared at exactly one call site, ahead of the full-suite
declarations handed to `runPostQAGates` (`src/orchestrator.ts:5804`), so the
final candidate's committed, working-tree and untracked changes are compared
against the accepted manifest **as it stands at gate time** and a violation
turns the post-QA decision `REPAIR` — the slice does not merge, while it still
reaches the candidate evaluator, which binding ADR 0048's amendment warrant
requires (settled in `anchors/08-file-scope-gate.md`, "Where the `scope` gate's
call site goes"; #195 AC1 weakens from "does not reach evaluation or merge" to
"does not merge"). `src/gate-runner.ts` grows exactly the plumbing an
in-process gate needs and nothing more: an optional `run`, a typed `findings`
payload on `GateResult`, and `GATE_EVIDENCE_VERSION` 1 → 2 with a reader that
still accepts version 1 (`prd.md` D22).

### In scope

- [behavior:B-01] `GateDeclaration` (`src/gate-runner.ts:23-33`) gains optional
  `run?: (ctx: { treeId: string; cwd: string; signal?: AbortSignal }) =>
  GateRunOutcome | Promise<GateRunOutcome>`, where the new exported
  `GateRunOutcome` is `{ status: GateStatus; failureKind?: GateFailureKind;
  detail?: string; findings?: GateFindings }`. `runGates` handles a declaration
  carrying `run` **before** the existing `existsSync(options.cwd)`,
  `prepareFailure` and `restoreCheckpoint` branches (`src/gate-runner.ts:441-527`):
  an in-process gate needs none of the three, and a post-QA checkpoint captured
  with `materialize: false` has no working directory to test (`src/post-qa-gates.ts:164-178`,
  unmodified per P-04). The recorded `GateResult` takes the outcome's `status`,
  `failureKind ?? null`, `detail` and `findings`, with `exitCode: null`,
  `treeId: options.treeId`, `logArtifactId` as the loop already computed it, and
  `startedAt` / `endedAt` / `durationMs` measured around the call. The outcome's
  `detail` is emitted into that gate log before the status line, so the paths a
  red gate names reach the next generator round inside the log and evidence
  files `decideCandidateGatePhase` already hands over as `references`
  (`src/candidate-gate-policy.ts:80-101`). If `options.signal` is already
  aborted when the declaration is reached, the loop breaks without recording,
  exactly as the command path's `CANCELLED` does (`src/gate-runner.ts:543`).
- [behavior:B-02] A `run` that throws, or whose promise rejects, is recorded as
  `status: "INFRASTRUCTURE"`, `failureKind: null`, `detail` the error's message
  (`String(error)` for a non-`Error`), and the loop continues to the next
  declaration, so `runGates` still writes its evidence document
  (`src/gate-runner.ts:593-600`) and every declaration still binds to one
  result. `INFRASTRUCTURE` rather than `FAIL`: `diffTreePaths` throws by design
  when a tree cannot be diffed (`src/git.ts:1317-1327`) and no generator edit
  can repair that, so this is the branch that cannot loop (ADR 0041) — P-06's
  bounded retry re-runs it, and `decideCandidateGatePhase` then ERRORs to the
  operator rather than blaming the generator.
- [behavior:B-03] `GateResult` gains optional `findings?: GateFindings`, and
  `GateFindings` types all four fields `prd.md` D22 names in this one bump:
  `outOfScopePaths?: readonly string[]`, `deletedTests?: readonly string[]`,
  `protectedChanges?: readonly string[]`, and `appliedWaivers?: readonly {
  riskClass: GateRiskClass; path: string; author: string; reason: string }[]`
  (D5's four fields per record). This slice populates only `outOfScopePaths`;
  the other three are typed and unpopulated until #193, so version 2 has one
  shape regardless of merge order. `riskClass` is `GateRiskClass`, type-imported
  from `./gate-policy.js` where #84 already exports it beside
  `GATE_RISK_CLASSES`: a bare `string` would let a persisted waiver name a class
  the policy reader refuses. `detail` stays human-facing and nothing parses it.
- [behavior:B-04] `GATE_EVIDENCE_VERSION` goes 1 → 2 (`src/gate-runner.ts:18`),
  `GateEvidence.version` widens to `1 | 2`, and `runGates` stamps 2.
  `readGateEvidence` (`src/gate-runner.ts:626-654`) accepts 1 and 2 and refuses
  any other value, and refuses a version-1 document whose results carry
  `findings` — only version 2 may carry it (`prd.md` D22). `verifyGateEvidence`'s
  digest, attempt, tree and declaration-binding checks are unchanged.
- [behavior:B-05] `src/scope-gate.ts` fails closed on an unproven changed set: a
  `ChangedFilesProbe` with `ok: false` (`src/git.ts:1254-1256`) yields
  `status: "INFRASTRUCTURE"`, `failureKind: null` and the probe's `failure`
  string as `detail`, with no `findings` — never an empty violation list, which
  would read as a clean tree.
- [behavior:B-06] The candidate comparison source is
  `{ kind: "candidate", worktreeDir, featureRef }`. The gate calls
  `listChangedFiles(worktreeDir, featureRef)` and probes **that** directory, not
  `ctx.cwd`: only the live slice worktree carries the working-tree and untracked
  changes D3 requires, while `ctx.cwd` at the post-QA call site is a checkpoint
  directory that may not even be materialized (`src/post-qa-gates.ts:164-178`).
  The recorded result's `treeId` stays `options.treeId` (the post-QA checkpoint
  tree), which is sound because `reviewArtifactViolations` has already proven
  that tree differs from the worktree by nothing but the QA-window allowlist
  before any gate runs (`src/post-qa-gates.ts:186-215`). `featureRef` is passed
  verbatim as the base, because git's own `<base>...HEAD` is
  `merge-base(<base>, HEAD)..HEAD` (`src/git.ts:1307`) — D3's base needs no
  second `merge-base` call.
- [behavior:B-07] The gate reads the manifest bytes **at gate time**: `run`
  calls `loadAcceptanceManifest(absSliceDir)` (`src/acceptance-manifest.ts:290`)
  when it executes, not when the declaration is built, so a `fileScope` widened
  by an ADR 0048 scope amendment applied during the QA window is the scope the
  gate compares against and the newly declared path is not a violation.
  `acceptedPairIntact` comes from the existing integrity check and never a fresh
  one (settled in `anchors/08-file-scope-gate.md`): the orchestrator latches it
  true per generator attempt only after `mutatedAcceptedContractFiles` /
  `restoreAcceptedContractPair` passed for that attempt
  (`src/orchestrator.ts:5348-5377`, which throws otherwise), and the latch starts
  false each attempt, so a reordering that skips the check gates with `false`
  and fails closed via B-10.
- [behavior:B-08] A declaration supplies either `command` or `run`. Supplying
  **both** is an invalid declaration — `FAIL` / `CONFIGURATION`, as
  `src/gate-runner.ts:413-440` already treats every invalid declaration.
  Supplying **neither** keeps today's split exactly: required is `FAIL` /
  `CONFIGURATION` with detail "Invalid required gate declaration", optional is
  `SKIPPED` with detail "Optional gate has no command". Not a flat rule, because
  `projectSanityGateDeclarations` (`src/base-gates.ts:8-25`) yields
  `{ id: "lint", stage: "base", required: false }` with no command for a project
  with no lint script and `src/adopt-command.ts:647-649` counts that gate as
  passing only while its status is `SKIPPED` (`prd.md` D22's correction).
- [behavior:B-09] Violation classification is `outOfScopeChangedPaths`' and is
  not re-implemented: the slice artifact directory by prefix, the migration
  paths under `options.migrationPathPattern`, and (under
  `acceptedPairIntact: true`) the orchestrator-owned pair are exempt, and a path
  the manifest cannot normalize is reported rather than skipped
  (`src/escalation.ts:196-262`). The comparison is case-insensitive by
  construction — `normalizePath` lowercases and the parser stores the normalized
  form (`src/acceptance-manifest.ts:64-71`, `:269`) — so a `fileScope` entry's
  tracked casing can never produce a false violation. A red gate reports the
  offenders in `findings.outOfScopePaths` and names each exact path in `detail`.
- [behavior:B-10] A caller that cannot prove the pair passes
  `acceptedPairIntact: false`, and then the accepted pair is not exempt: in a
  gated tree where both `contract.md` and `acceptance-manifest.json` differ from
  the feature branch (which a negotiated slice tree always does — the pair is
  written into the worktree, `src/escalation.ts:172-177`), both appear in
  `findings.outOfScopePaths` and the gate is red.
- [behavior:B-11] The role write-scope source is
  `{ kind: "role", cwd, inputCheckpointTree, outputCheckpointTree }`, whose
  changed set is `diffTreePaths(cwd, inputCheckpointTree, outputCheckpointTree)`
  (`src/git.ts:1323-1346`) and never a working-tree probe (`prd.md` D4): the
  checkpoints are what later evidence cites. A throwing diff is B-02's
  `INFRASTRUCTURE`, never an empty set.
- [behavior:B-12] The declaration is built by `src/scope-gate.ts` and prepended
  to the declarations passed to `runPostQAGates` at the single call site
  (`src/orchestrator.ts:5804`): `[scopeDeclaration, ...fullSuiteDeclarations]`.
  Prepended, not appended, so the deterministic check that needs no toolchain
  cannot be preceded by the ~7-minute suite (`CLAUDE.md`) and cannot be skipped
  by an earlier declaration's `INFRASTRUCTURE` or checkpoint `break`
  (`src/gate-runner.ts:459`, `:504`, `:527`). A red `scope` does not
  short-circuit the remaining declarations — `runGates` continues past `FAIL`,
  and gate sequencing is #86's work — so the suite still runs and
  `decideCandidateGatePhase` returns `REPAIR` naming `scope`, which
  `src/orchestrator.ts:5845-5870` turns into the next generator round rather
  than a merge.
- [behavior:B-13] A manifest declaring `{"kind":"no-repository-changes"}` passes
  only when nothing outside the allowlist changed: `acceptanceManifestPaths`
  returns `[]` for it (`src/acceptance-manifest.ts:298-304`), so every changed
  path that is not an exempt artifact or migration path is a violation.
- [behavior:B-14] `featureRef` is the caller's ref and is used verbatim, which
  is what makes D3's re-resolved base work: when a slice tree has the feature
  branch merged into it (slice 06's merge-resolution round, #132), the merge
  base of `featureRef` and `HEAD` is the merged feature-branch tip, so an
  already-merged sibling's paths are not in this slice's changed set and never
  in its violation list. This slice provides the seam and asserts the rule;
  #132 owns the call that re-resolves the ref.

### Non-goals (explicit out-of-scope)

- Reading `gatePolicy.protectedPaths` or `riskClasses`, or calling #84's glob
  matcher. #195's "Blocked by #84" paragraph is pre-split text: `prd.md` D2-D4,
  which this slice implements, describe a manifest-versus-changed-files
  comparison only, and the file-scope map's split note assigns D5/D6 and gate id
  `feedback-integrity` to #193 (`prd.md`, "Where the map's `01` column now
  lands"). `prd.md` controls where it and #72's issue text differ
  (`prd.md:22-25`). The only thing this slice takes from `src/gate-policy.ts` is
  the `GateRiskClass` type in B-03.
- Populating `deletedTests`, `protectedChanges` or `appliedWaivers`; the
  `RunState` 3 → 4 waiver bump; `escalation.md` v2 and the `GATE-SCOPE` channel;
  the generator and evaluator-contract prompt edits — all #193's (D5, D6, D12,
  D13).
- Projecting `findings` into `CandidateGateOutcome`, the `gate-outcome` run
  event, or `run-summary.md`. That needs `src/candidate-gate-phase.ts`, which
  the anchors file puts outside this slice's scope; the structured evidence
  reaches the next round through the evidence document and log references
  `decideCandidateGatePhase` already emits.
- Gate sequencing, cheap-set ordering, advisory gates and the evidence cache
  (#86), the `merge-resolution.ts` call that re-resolves `featureRef` (#132), and
  any change to `src/base-gates.ts`, `src/post-qa-gates.ts`,
  `src/candidate-gate-phase.ts` or the acceptance-manifest schema (stays
  version 2).

### Existing behavior to preserve

- [behavior:P-01] Every declaration carrying `command` keeps today's path
  through `runGates` unchanged: the invalid/no-command branch and its detail
  strings, the missing-`cwd` `INFRASTRUCTURE` break, the `prepareFailure`
  `FAIL` / `CONFIGURATION` fan-out, `restoreCheckpoint` before and after the
  command, `runBoundedCommand`, the `CANCELLED` break, and
  `classifyExecution`'s statuses (`src/gate-runner.ts:398-591`), along with the
  evidence document's `wx` write and the artifact's per-declaration log hashing
  (`:593-620`).
- [behavior:P-02] `outOfScopeChangedPaths`, `listChangedFiles` and
  `diffTreePaths` are reused unmodified — no second path normalizer, no second
  changed-set probe, and `acceptedPairIntact` keeps having no default
  (`prd.md` D2; `src/escalation.ts:210`).
- [behavior:P-03] The pre-build escalation guard keeps its own call site and
  behavior: `src/orchestrator.ts:5420-5444` still calls `listChangedFiles` with
  `featBranch` and `outOfScopeChangedPaths` with `acceptedPairIntact: true`, and
  still refuses a focused revision by throw when the tree already holds
  undeclared changes (ADR 0052). The new gate is a second, later door and
  replaces nothing (ADR 0048: "Do not 'reconcile' them").
- [behavior:P-04] `src/post-qa-gates.ts` is not edited:
  `reviewArtifactViolations`' allowlist and blob provenance, the
  `executable`-driven checkpoint materialization, the fail-closed ERROR before
  the gates, and the `PASS` / `REPAIR` / `ERROR` / `CANCELLED` mapping all stand
  (`src/post-qa-gates.ts:51-286`).
- [behavior:P-05] `src/base-gates.ts` stays unedited, so a project with no lint
  script still derives `{ id: "lint", stage: "base", required: false }` with no
  command and still records `SKIPPED`, which `src/adopt-command.ts:647-649`
  counts as passing.
- [behavior:P-06] `src/candidate-gate-phase.ts` is not edited: the bounded
  infrastructure retry keyed on any required gate's `INFRASTRUCTURE`
  (`:114-138`), `assertGateEvidenceReleasesEvaluation`'s one-result-per-declaration
  check (`:154-177`), and `evidenceArtifactId` as the repo-relative
  `evidencePath` (`:114-117`) all apply to the in-process gate unchanged.

### Changes to existing behavior (only if the issue asks for it)

- A post-QA candidate whose tree holds a change outside the locked `fileScope`
  now returns `REPAIR` instead of being accepted and merged (#195 AC1, AC6;
  `prd.md` D2). Existing spawned fixtures whose stub generator writes a path
  their fixture manifest does not declare are corrected by declaring the path in
  the fixture manifest — never by weakening the gate, making it optional, or
  removing an assertion.
- The post-QA declaration set gains one member, so evidence assertions counting
  or listing gate ids on that phase change from `["tests"]` to
  `["scope", "tests"]` (e.g. `src/qa-orchestration.test.ts:2160-2175`).

## Files expected to change

- src/scope-gate.ts
- src/scope-gate.test.ts
- src/gate-runner.ts
- src/gate-runner.test.ts
- src/orchestrator.ts
- src/orchestrator.test.ts
- src/orchestrator-runs.test.ts
- src/orchestrator.fixtures.ts
- src/qa-orchestration.test.ts
- src/wave.test.ts
- src/wave-migrations.test.ts
- src/wave.fixtures.ts
- src/resume-integration.test.ts
- src/resume-integration.fixtures.ts
- src/clean-failed.test.ts
- ARCHITECTURE.md

## Migration requirements

- New migration files: 0

## New patterns / deps / schema (if any)

- `src/scope-gate.ts` is a new module on the existing `GateDeclaration` seam
  (`ARCHITECTURE.md`, "a new check is a declared gate with evidence"); it gets a
  row in the Gates module's public seam list.
- Persisted schema: gate evidence version 1 → 2, additive and backward-readable
  (B-04). No other persisted schema changes.
- No new dependencies.

## Test plan

- Given a `GateDeclaration` with `run` returning `PASS` and one with `run`
  returning `FAIL` plus `findings`, when `runGates` runs them, then both results
  carry `exitCode: null`, the phase `treeId`, the returned `detail` and
  `findings`, and each gate log holds the detail text (`src/gate-runner.test.ts`).
- Given a declaration whose `run` throws synchronously and one whose promise
  rejects, when `runGates` runs, then each records `INFRASTRUCTURE` /
  `failureKind: null` with the error message as `detail`, the evidence document
  exists, and `results.length` equals `declarations.length`
  (`src/gate-runner.test.ts`).
- Given a `run` declaration and an `options.cwd` that does not exist, when
  `runGates` runs, then the in-process gate still records its own outcome
  instead of the missing-directory `INFRASTRUCTURE`
  (`src/gate-runner.test.ts`).
- Given declarations supplying neither `command` nor `run` and one supplying
  both, when `runGates` runs, then required-neither and both-supplied are
  `FAIL` / `CONFIGURATION`, optional-neither is `SKIPPED` with detail "Optional
  gate has no command", and the derived `lint` declaration for a project with no
  lint script is asserted `SKIPPED` explicitly (`src/gate-runner.test.ts`).
- Given evidence documents at version 1 and version 2, when `readGateEvidence`
  reads them, then both parse, a version-1 document carrying `findings` is
  refused, version 3 is refused, and a fresh `runGates` document stamps
  version 2 (`src/gate-runner.test.ts`).
- Given a real throwaway repo with a slice branch, a declared path, an
  undeclared path, an untracked file, an artifact-directory file and a migration
  file, when the candidate-source gate runs, then only the undeclared path and
  the untracked file appear in `findings.outOfScopePaths` and in `detail`
  (`src/scope-gate.test.ts`).
- Given a manifest whose `fileScope` names `ARCHITECTURE.md` and a changed set
  spelling it differently in case, when the gate runs, then there is no
  violation (`src/scope-gate.test.ts`).
- Given a manifest on disk whose `fileScope` was widened after the declaration
  was built (the applied-amendment case), when the gate runs on a tree holding
  the newly declared path, then the gate passes and reports no violation
  (`src/scope-gate.test.ts`).
- Given a worktree directory git cannot probe, when the candidate-source gate
  runs, then the result is `INFRASTRUCTURE` with the probe failure in `detail`
  and no `findings` (`src/scope-gate.test.ts`).
- Given `acceptedPairIntact: false` and a gated tree where both `contract.md`
  and `acceptance-manifest.json` differ from the feature branch, when the gate
  runs, then both paths appear in `findings.outOfScopePaths`
  (`src/scope-gate.test.ts`).
- Given a manifest declaring `{"kind":"no-repository-changes"}`, when the gate
  runs on a tree that changed only artifact-directory and migration paths and
  again on one that changed a source path, then the first passes and the second
  names that path (`src/scope-gate.test.ts`).
- Given a slice branch that has the feature branch merged into it and a sibling
  path present only from that merge, when the gate runs with `featureRef` set to
  the feature branch, then the sibling path is absent from the changed set and
  from the violation list (`src/scope-gate.test.ts`).
- Given input and output checkpoint trees for a writing role, when the
  role-source gate runs, then the changed set is the tree-to-tree diff and an
  uncommitted working-tree edit is not in it (`src/scope-gate.test.ts`).
- Given the existing spawned scenario whose stub generator writes a path the
  fixture manifest does not declare, when the slice runs, then the post-QA
  evidence records `scope` before `tests`, the gate is red naming that exact
  path, the outcome is not `PASS`, and the slice branch is not merged into the
  feature branch (an `it` on an existing `describe` in
  `src/qa-orchestration.test.ts`; no new spawned scenario).
- Given the existing spawned scenarios that expect `PASS`, when their fixture
  manifests declare every path their stubs write, then they still reach `PASS`
  with `scope` recorded green in the post-QA evidence
  (`src/qa-orchestration.test.ts`, `src/orchestrator.test.ts`,
  `src/orchestrator-runs.test.ts`, `src/wave.test.ts`,
  `src/wave-migrations.test.ts`, `src/resume-integration.test.ts`,
  `src/clean-failed.test.ts` and their fixture modules).

## Definition of done

- [ ] `src/scope-gate.ts` exists, exports the declaration builder and the two
      comparison sources, and imports its comparison and probe helpers from
      `src/escalation.ts` and `src/git.ts` rather than reimplementing either.
- [ ] `src/gate-runner.ts` carries `run`, `GateRunOutcome`, `GateFindings` with
      D22's four fields, and `GATE_EVIDENCE_VERSION = 2` with a reader that
      accepts 1 and 2.
- [ ] The `scope` declaration appears exactly once in `src/orchestrator.ts`,
      prepended to the declarations passed to `runPostQAGates`, required, at
      stage `deterministic`.
- [ ] `src/base-gates.ts`, `src/post-qa-gates.ts`,
      `src/candidate-gate-phase.ts` and `src/acceptance-manifest.ts` are
      unedited by this slice.
- [ ] Every behavior anchor above has at least one assertion in a declared test
      file, and no gate was made optional or assertion deleted to reach green.
- [ ] `pnpm typecheck`, `pnpm test:fast`, `pnpm run test:heavy:qa`,
      `pnpm run test:heavy:orchestrator`, `pnpm run test:heavy:wave`,
      `pnpm run test:heavy:resume` and `pnpm run test:heavy:clean` pass on this
      slice's worktree (the heavy suites this slice touches; not the full suite,
      per `CLAUDE.md`).
- [ ] `ARCHITECTURE.md` lists `src/scope-gate.ts` in the Gates module row.

# Handoff — 08-file-scope-gate (#195)

## What shipped

- B-01: `src/gate-runner.ts:GateDeclaration.run` / `runGates` (in-process branch)
- B-02: `src/gate-runner.ts:classifyDeclaration`
- B-03: `src/gate-runner.ts:runGates` (in-process branch, ahead of the `existsSync(options.cwd)` precondition)
- B-04: `src/gate-runner.ts:runGates` (in-process `catch` → `INFRASTRUCTURE`, `failureKind: null`)
- B-05: `src/scope-gate.ts:runScopeGate`
- B-06: `src/scope-gate.ts:runScopeGate` (`detail` + `findings.outOfScopePaths`)
- B-07: `src/scope-gate.ts:ScopeGateInput.acceptedPairIntact`, set by `src/orchestrator.ts:acceptedPairIntact`
- B-08: `src/gate-runner.ts:GateFindings`, `src/gate-runner.ts:GateResult.findings`
- B-09: `src/scope-gate.ts:changedPathsFor` (via `listChangedFiles`)
- B-10: `src/scope-gate.ts:runScopeGate` (`loadAcceptanceManifest` called inside the gate, not in `scopeGateDeclaration`)
- B-11: `src/scope-gate.ts:runScopeGate` (via `outOfScopeChangedPaths`' artifact-dir and migration exemptions)
- B-12: `src/orchestrator.ts:postQaDeclarations` (`scopeGateDeclaration` prepended to `fullSuiteDeclarations`)
- B-13: `src/scope-gate.ts:runScopeGate` (`changed.failure` → `INFRASTRUCTURE`)
- B-14: `src/scope-gate.ts:runScopeGate` (accepted-pair refusal via `outOfScopeChangedPaths`)
- P-01: `src/gate-runner.ts:classifyDeclaration` (`kind: "undeclared"` keeps the optional-gate `SKIPPED`)
- P-02: `src/scope-gate.ts:ScopeComparisonSource` (the module takes a source and returns an outcome; no orchestration)
- P-03: `src/orchestrator.ts` pre-build escalation refusal, unchanged; asserted in `src/orchestrator.test.ts`
- P-04: `src/post-qa-gates.ts`, unedited; asserted in `src/qa-orchestration.test.ts`
- P-05: `src/gate-runner.ts:SUPPORTED_GATE_EVIDENCE_VERSIONS`, `readGateEvidence`
- P-06: `src/gate-runner.ts:runGates` (cancellation break, `emit`, per-gate log artifact on both paths)
- New migration files: 0

## Decisions made during implementation

- The gate is a `run` declaration on the existing gate-runner seam rather
  than a new phase. Prepending it to the post-QA declarations is what makes
  "recorded first in that phase's evidence" and "the remaining declarations
  still run" the same fact rather than two mechanisms.
- `command` and `run` together are a CONFIGURATION defect, not a precedence
  rule. A declaration with neither is left exactly as it was: `lint` with no
  script derives commandless and optional, and `src/adopt-command.ts` counts
  it as passing only while its status is `SKIPPED`.
- The in-process branch runs before the command path's working-directory,
  toolchain and restore preconditions. A post-QA checkpoint captured with
  `materialize: false` has no directory, so testing `options.cwd` first would
  record INFRASTRUCTURE for a check that never touches it.
- A `run` that throws is INFRASTRUCTURE with `failureKind: null`. The throws
  reachable here are "the tree could not be diffed" and "the manifest could
  not be parsed" — no generator edit repairs either, so it goes to the bounded
  retry and then to the operator (ADR 0041) rather than buying a repair round.
- Evidence version went 1 → 2 with all four `GateFindings` fields declared at
  once, even though this slice populates only `outOfScopePaths`. One shape per
  version means the feedback-integrity gate (#193) can land in either order
  without a second bump. `readGateEvidence` still accepts version 1, and
  refuses a version-1 document that carries `findings`.
- `runScopeGate` loads the acceptance manifest itself instead of closing over
  a preloaded one, so an amendment accepted mid-round is the scope the gate
  grades. `scopeGateDeclaration` therefore carries paths to read, not data
  read at declaration time.
- Offender detection reuses `outOfScopeChangedPaths` rather than
  reimplementing the exemptions. The artifact-directory and migration
  exemptions and the accepted-pair refusal are already the orchestrator's
  answer to "what counts as out of scope", and two answers would drift.
- Existing spawned fixtures were corrected by declaring the path their stub
  generator writes, never by softening the gate. The `no-repository-changes`
  fixture is the one exception in form: it writes under the slice artifact
  directory, which the gate exempts, because declaring repository paths would
  contradict the scope that fixture exists to declare.
- The `orchestrator.fixtures.ts` augmentation is decided from round 1's
  declared list and held for later rounds, so the additive revision guard
  still refuses a revision that drops a locked path.

## Gotchas / learnings

- Lane partitioning reads the acceptance manifest's `fileScope`. Declaring one
  shared path in two slices' manifests puts them in a single serial lane, which
  is why the add/add CONFLICT fixture stopped conflicting once its clash path
  was declared. Under this gate, a same-wave conflict on a declared path is
  unreachable; the honest source is a base that advanced under a slice after
  its worktree was cut. The fixture now commits to the feature branch during
  Phase A — every slice negotiates before any lane runs, so that commit is a
  sibling of both slice branches and cannot race a merge for the main
  repository's index.
- `resume-integration.fixtures.ts` needed `extraScopePaths` per slice for the
  same reason: one shared declaration would have collapsed the disjoint lanes
  the resume scenarios depend on.
- Migration outputs must not be added to a fixture manifest even though the
  generator writes them. `writeAcceptanceManifest` derives `migrationCount`
  from the declared paths, and the prefix-claim fixtures assert on that number.
- `qa-orchestration.test.ts`'s shared `makeContext` runs its slice on `main`
  with `featBranch: "main"`, so `git diff main...HEAD` is empty by
  construction and any file-scope comparison passes. A scope scenario there has
  to cut a real slice branch and set `ctx.branch`.
- A repair prompt's "Current failure set" cites gate evidence rather than
  inlining a gate's `detail`, so an assertion that a path reached the generator
  belongs on the gate log the prompt cites, not on the prompt text.
- `GateEvidence` carries no timestamp and evidence filenames embed a random hex
  attempt id, so `readdirSync(...).sort()` does not order attempts. Tell the
  rounds apart by what their results say.
- Two base-gate evidence assertions counted post-QA gate ids as `["tests"]`;
  both are now `["scope", "tests"]`. The second was several hundred lines from
  the first, so a search for the whole array literal is worth doing before
  assuming one hit.

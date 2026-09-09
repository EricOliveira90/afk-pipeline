# QA Report

**Verdict:** PASS
**Failure class:** NONE

## Pass 1: Functional Correctness
- Pre-QA commands: PASS
- UAT verification: NOT IN SCOPE
- Boundary compliance: PASS
- Preservation check: PASS

### Commands

- `pnpm install --frozen-lockfile` — run in this worktree, exit 0
  (`Done in 6.1s using pnpm v10.33.0`).
- `pnpm run typecheck` — **skipped under the orchestrator's authorization.**
  The orchestrator ran it itself on a checkpoint of the exact tree under
  review and verified the evidence artifact against its recorded digest:
  PASS at 2026-09-09T01:45:37.257Z (6.8s), evidence
  `.afk/logs/afk-v2-acceptance-scope-gates-claude-code/run-20260908-203830/gates/s08/attempt-04085a70b58c.json`,
  gate attempt `04085a70-b58c-4a35-820b-ae27e71cbd4f`, Git tree
  `0d707ce24b318c8b2cd41a9f9fdbb0cb52af2a0a`. No file under review was
  modified during this QA stage, so the authorization holds.

No test suite was run: this stage's command list does not name one, and the
orchestrator runs the full suite on the authorized candidate tree after QA
accepts. Behavior verification below is by reading the tree and the code the
tree depends on.

### Behavior verification (B-01 … B-14)

Every behavior anchor has at least one named assertion in a declared test
file — all twenty ids (`B-01`–`B-14`, `P-01`–`P-06`) appear as test titles
across `src/scope-gate.test.ts`, `src/gate-runner.test.ts`,
`src/orchestrator.test.ts`, `src/qa-orchestration.test.ts`,
`src/resume-integration.test.ts` and `src/wave-migrations.test.ts`. Spot
checks against the sources those tests exercise:

- **B-01 / B-02**: `src/gate-runner.ts:543-600` places the in-process branch
  after the invalid/undeclared classification and *before*
  `existsSync(options.cwd)` (`:601`), the `prepareFailure` fan-out and
  `restoreCheckpoint`. `prepare` itself runs before the loop (`:400-492`) and
  is consumed after the in-process branch, so a broken toolchain cannot mask
  the comparison. `exitCode: null`, `treeId: options.treeId`, the loop's
  `logArtifactId`, and `startedAt`/`endedAt`/`durationMs` measured around the
  call are all as B-01 specifies; the aborted-signal `break` at `:546`
  mirrors the command path. The `catch` at `:556` records `INFRASTRUCTURE` /
  `failureKind: null` with `error.message` (`String(error)` otherwise) and
  `continue`s, so the evidence document is still written and every
  declaration still binds to one result.
- **B-03 / B-04**: `GateFindings` declares all four D22 fields with
  `riskClass: GateRiskClass` type-imported from `./gate-policy.js`.
  `GATE_EVIDENCE_VERSION = 2`, `GateEvidence.version` is `GateEvidenceVersion`
  (`1 | 2`), `readGateEvidence` accepts both (`:786-792`), refuses anything
  else, and refuses a version-1 document whose results carry `findings`
  (`:812-823`). `verifyGateEvidence`'s digest, attempt, tree and
  declaration-binding checks are untouched. There is exactly one writer
  (`:749`) and one reader, and the only other `GateEvidence` literal in the
  repo (`src/candidate-gate-policy.test.ts:39`, `version: 1`) still typechecks
  and asserts nothing about the version.
- **B-05 / B-06 / B-09 / B-13 / B-14**: `src/scope-gate.ts:94-157`.
  `changedPathsFor` returns the `ok: false` probe verbatim and
  `runScopeGate` turns it into `INFRASTRUCTURE` / `failureKind: null` with the
  probe's `failure` in `detail` and **no** `findings`. The candidate source
  probes `source.worktreeDir`, never `ctx.cwd` — the declaration's `run`
  ignores its ctx argument entirely — and `featureRef` is passed verbatim to
  `listChangedFiles`, whose `<base>...HEAD` (`src/git.ts:1307`) is already
  `merge-base(base, HEAD)..HEAD`. Classification is delegated whole to
  `outOfScopeChangedPaths`; `detail` names each offender by
  `offenders.join(", ")`. `listChangedFiles` uses
  `ls-files --others --exclude-standard`, so ignored paths cannot produce a
  false violation.
- **B-07**: `loadAcceptanceManifest(input.absSliceDir)` is called inside
  `runScopeGate`, and `scopeGateDeclaration` closes over paths only. The
  attestation is earned in exactly one place —
  `src/orchestrator.ts:5392`, immediately after `mutatedAcceptedContractFiles`
  found nothing — is reset at `:5188` at the top of every generator attempt,
  and the loop's only `break` (`:5394`) is *after* the latch. Traced every
  path into the post-QA site: the exact-stage resume branch (`:5098-5108`)
  returns before the implementation loop, so no legitimate path reaches the
  gate with `false`, and any reordering that skipped the check would fail
  closed via B-10 rather than exempt a widened lock.
- **B-08**: `classifyDeclaration` (`:369-389`) makes `command` + `run`
  invalid alongside a blank id or stage, and preserves today's split exactly —
  `undeclared && !required` is the only `SKIPPED`, with the two detail strings
  unchanged at `:527-530`. `src/base-gates.ts` is unedited, and
  `src/gate-runner.test.ts` asserts the *derived* `lint` declaration (not a
  hand-written stand-in) records `SKIPPED`.
- **B-12**: exactly one `scopeGateDeclaration` call site
  (`src/orchestrator.ts:5831`), prepended as
  `[scopeGateDeclaration({...}), ...fullSuiteDeclarations]`, `required: true`,
  stage `deterministic`. `runPostQAGates` derives `executable` with
  `declarations.some(d => d.command != null)`
  (`src/post-qa-gates.ts:164-166`), so prepending a commandless declaration
  does not change checkpoint materialization or the `prepare` decision.

### Boundary compliance

The slice's four commits (`6a40f16..d375169`) change 13 files, every one of
them declared in the contract's `## Files expected to change`:
`ARCHITECTURE.md`, `src/scope-gate.ts`, `src/scope-gate.test.ts`,
`src/gate-runner.ts`, `src/gate-runner.test.ts`, `src/orchestrator.ts`,
`src/orchestrator.test.ts`, `src/orchestrator.fixtures.ts`,
`src/qa-orchestration.test.ts`, `src/wave.fixtures.ts`,
`src/wave-migrations.test.ts`, `src/resume-integration.test.ts` and
`src/resume-integration.fixtures.ts`.
Three declared files (`src/wave.test.ts`, `src/orchestrator-runs.test.ts`,
`src/clean-failed.test.ts`) were not touched, which is allowed — their
fixture manifests are corrected centrally in the two shared fixture modules.
No amendment is needed. New migration files: 0, as declared.

### Preservation check

- **P-01**: the command path's invalid/no-command branch and both detail
  strings, the missing-`cwd` `INFRASTRUCTURE` break, the `prepareFailure`
  fan-out, `restoreCheckpoint`, `runBoundedCommand`, the `CANCELLED` break and
  `classifyExecution` are unchanged; only `declaration.command`/`args` were
  replaced by the already-narrowed `shape.command`/`shape.args`. The `wx`
  evidence write and per-declaration log hashing are untouched, and
  `src/gate-runner.test.ts`'s `P-01` case asserts a command result still
  carries `findings: undefined`.
- **P-02**: `src/scope-gate.ts` imports `outOfScopeChangedPaths` from
  `./escalation.js` and `listChangedFiles` / `diffTreePaths` from `./git.js`,
  contains no `toLowerCase` and no `execFileSync`, and never defaults
  `acceptedPairIntact`.
- **P-03**: the pre-build escalation guard keeps its own call site
  (`src/orchestrator.ts:5436-5457`), still passing `featBranch` and
  `acceptedPairIntact: true` and still refusing by throw. The new gate is a
  second door.
- **P-04 / P-05 / P-06**: `git diff --name-only 4f84374 HEAD --
  src/base-gates.ts src/post-qa-gates.ts src/candidate-gate-phase.ts
  src/acceptance-manifest.ts src/escalation.ts src/git.ts` is empty — none of
  them were edited. `src/gate-runner.test.ts`'s `P-06` case drives an
  in-process `INFRASTRUCTURE` result through the unedited
  `runCandidateGatePhase` and asserts two attempts, the retry message, one
  result per declaration and a repo-relative `evidencePath`.
- **Changes to existing behavior, as the contract authorizes them**: the
  fixture corrections declare the path each stub generator writes
  (`src/orchestrator.fixtures.ts`, `src/wave.fixtures.ts`,
  `src/resume-integration.fixtures.ts`) rather than weakening the gate; no
  gate was made optional and no assertion was deleted. The add/add CONFLICT
  fixture in `src/wave-migrations.test.ts` keeps its MERGE-PENDING assertion
  and re-sources the conflict from the feature branch advancing under a slice
  — the only route to a conflicting merge that survives this gate — with the
  reason recorded in the handoff.

## Pass 2: Quality & Craft
- Convention compliance: PASS
- Code quality: PASS
- Test quality: NOTES

`src/scope-gate.ts` is 173 lines with the comparison delegated whole to the
two existing helpers, and its header states the one thing a reader most needs
(it is a second door, not a replacement). `ScopeComparisonSource` being a
discriminated union rather than two booleans is the right call: the contract
notes picking the wrong source is a silent hole, and a union makes it a
compile error. `classifyDeclaration`'s four-way shape resolves the either-or
rule once instead of letting the loop read `command` and `run` as independent
options, which is what keeps P-01's branches provably untouched.

Two minor notes, neither material:

- `isGateFindingsField` validates a persisted `appliedWaivers[].riskClass` as
  a bare `string` while the type says `GateRiskClass`. The comment states the
  reason (the policy reader owns the class vocabulary and this slice populates
  no waivers), so this is a deliberate, documented gap for #193 to close, not
  a hole this slice opened.
- `runScopeGate`'s PASS detail reads "Every one of the N changed path(s) is
  …", which is slightly awkward for N = 1. Cosmetic; nothing parses `detail`.

Test quality is high and the assertions are load-bearing rather than
shape-checking: `src/scope-gate.test.ts` uses real throwaway repositories so
the three-dot base, the untracked file and the merged-sibling case are git's
answers rather than a fixture author's model of git, and the two prompt
assertions in `src/qa-orchestration.test.ts` are grounded in real code
(`- Gate ID: \`${gate.id}\`` at `src/context-envelope.ts:1781`, and the log
reference `candidate-gate-policy.ts` puts in `references`). The one note is
recorded as finding QA-01 below.

## Resolved findings
- None. No findings were routed to this QA stage.

## Findings
### Finding 1 — B-12/P-04 coverage lands in a new spawned scenario, against a ~35s budget margin
**Severity:** Minor
**Pass:** 2
**Evidence:** `src/qa-orchestration.test.ts:2135` opens
`describe("a red file-scope gate at the post-QA transition")` whose
`beforeAll` (timeout 180_000) calls `runSliceExecute` on a fresh fixture repo
through two generator rounds, two evaluator rounds and four gate phases.
`suite-budgets.json` budgets `qa-orchestration` at 151s against a last
recorded measurement of 115.7s
(`_measured2026_09_01_prd3_slice01_five_chain@afk-codex/afk-v2-context-envelopes-slice-01-generator-runs-on-the-focused-envelope`),
leaving roughly 35s for this spawn plus the extra `scope` gate every other
spawned scenario in the file now runs. This stage's command list does not
include a test run, so the wall clock is unverified here.
**What the contract expected:** "Given the existing spawned scenario whose
stub generator writes a path the fixture manifest does not declare, when the
slice runs, then … (an `it` on an existing `describe` in
`src/qa-orchestration.test.ts`; **no new spawned scenario**)."
**What I observed:** A new spawned run was added, and the deviation is
necessary rather than careless. Every pre-existing spawned scenario in that
file goes through `makeContext`, which runs the slice on `main` with
`featBranch: "main"` (`src/qa-orchestration.test.ts:163`), so
`git diff main...HEAD` is empty by construction and a red-scope assertion is
unreachable there; the file's other scope tests call `runQAStage` directly and
never reach the post-QA transition. The new block carries the comment
CLAUDE.md requires for a last-resort spawn, shares one run across three `it`s,
and captures every fact inside the hook so the shared `afterEach` cleanup does
not race it. Non-blocking: it adds coverage the contract wants and that no
unit test can carry. The residual risk is only the budget, which
`pnpm run test:heavy:qa` plus `pnpm run test:budgets` settles — and if it goes
red, `scripts/check-suite-budgets.mjs` documents raising it with a recorded
measurement as a normal outcome.

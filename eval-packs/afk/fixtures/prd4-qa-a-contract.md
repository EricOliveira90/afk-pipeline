# Slice Contract — Candidate evaluator in a disposable worktree

**Parent PRD:** .kiro/specs/afk-v2-acceptance-scope-gates/prd.md
**GH issue:** #91
**Status:** LOCKED

**Lock-Provenance:** negotiation round 2
**Negotiation round:** 2

## Scope lock

The deterministic candidate evaluator stops reading the generator's own
worktree. After the pre-QA gate phase passes, the orchestrator creates a
disposable worktree at the candidate checkpoint commit, seeds it with the
accepted contract pair, invokes `evaluator-qa` there, copies back only the
allowlisted review artifacts, records every other change it finds as a
`reviewer-write-violation` run event, and removes the worktree. On PASS it
writes `approved-baseline.json` keyed to the checkpoint tree, beside a
`change-summary.json` produced by a new `src/change-summary.ts`. The atomic
isolation boundary is **B-01 → B-04**: the worktree lifecycle, its seeding,
the copy-back allowlist and the violation scan are one mechanism and are
worth nothing apart. B-05 and B-06 (the two records) depend on B-01 landing;
B-07, B-08 and B-09 (manifest reshape, prompt wording, run-summary section)
are independent of the mechanism and are the tail of the ordering, taken
after B-01 → B-04 are green. Shared-preview UAT keeps running in
`ctx.worktreeDir` and is untouched.

### In scope

- [behavior:B-01] For `stage === "deterministic"` only, `runQAStage`
  (`src/orchestrator.ts:4290`) invokes the evaluator with `cwd` set to a
  disposable review worktree instead of `ctx.worktreeDir`
  (`src/orchestrator.ts:4661`). The orchestrator builds it with the existing
  `git.createWorktree` and removes it with `git.removeWorktreeOrWarn` after
  the attempt loop ends, on every exit path including throw and cancellation
  (`src/git.ts:131`, `src/git.ts:461`). It is created from the candidate
  checkpoint commit the gate phase already ran on, so the evaluator reads the
  exact tree the gates graded (ADR 0012's 2026-08-28 amendment, already
  relied on by `QABaseGateEvidence.candidateTreeId`,
  `src/orchestrator.ts:4249-4259`). The worktree lifecycle needs no new
  `src/git.ts` primitive: `git.createWorktree` (`src/git.ts:131`),
  `git.assertWorktreeRegistered` (`src/git.ts:163`), `git.removeWorktree`
  (`src/git.ts:283`) and `git.removeWorktreeOrWarn` (`src/git.ts:461`) are all
  already exported and already imported by `src/orchestrator.ts:17`.
  **Decision recorded here:** `src/git.ts` stays outside this slice's scope
  because the map is exhaustive (`prd.md:498-501`) and a file-scope gate ships
  in this same PRD; the two git reads this slice performs that no exported
  `src/git.ts` function covers — B-04's ignored-path status read and B-05's
  two-ref summary read — are therefore implemented inside files this slice
  already owns, not by widening `src/git.ts`. That is the established pattern
  for a module that needs a git read of its own shape:
  `src/gate-runner.ts:271-311` and `src/migration-gate.ts:56` both spawn
  `git`/`pnpm` directly rather than growing the `src/git.ts` surface.
- [behavior:B-02] Before each attempt the orchestrator seeds the review
  worktree's slice directory: it writes `contract.md` and
  `acceptance-manifest.json` from `ctx.absSliceDir`, so an attempt granted by
  an applied scope amendment grades against the amended pair (ADR 0048: an
  applied amendment buys one extra attempt in the same stage-round, and only
  the evaluator can re-take the grade). Every path the orchestrator writes
  during seeding is recorded, at write time, into a per-attempt
  **seed manifest** of repo-relative paths. The seed manifest is a distinct
  set from B-03's copy-back allowlist and exists for exactly one purpose: to
  keep the orchestrator's own writes out of B-04's scan.
- [behavior:B-03] Copy-back is a positive allowlist by basename over the
  review worktree's slice directory only. `QA_WINDOW_ARTIFACT_NAME`
  (`src/post-qa-gates.ts:38-39`) becomes exported and is the single source:
  the full set it admits is `qa-report.md`, `uat-report.md`,
  `qa-report-rN-aM.md`, `uat-report-rN-aM.md`, `qa-review.json`,
  `uat-review.json` and `stuck.md`. That set, and not
  `CANDIDATE_EVALUATOR_CONTEXT_MANIFEST.allowedWriteScope`'s two entries, is
  the copy-back boundary because D9 says so verbatim (`prd.md:250-253`) and
  because one constant shared with the post-QA window check cannot disagree
  with itself about the same directory, while `allowedWriteScope` is the
  narrower *instruction* to the evaluator, not the enforcement surface. A
  path outside the review worktree's slice directory, and a nested or
  unmatched name inside it, is never copied — so an evaluator-authored
  `approved-baseline.json` or `change-summary.json` cannot reach the repo by
  construction, whatever the evaluator wrote in its own tree.
- [behavior:B-04] After each attempt, and after copy-back, the orchestrator
  enumerates what the evaluator changed in the review worktree and emits one
  new `reviewer-write-violation` run event per path that is neither in B-03's
  copy-back allowlist nor in that attempt's B-02 seed manifest. **Seam
  recorded here:** the enumeration is a new exported function in
  `src/qa-review.ts` — the review-rails seam this slice already owns
  (ARCHITECTURE.md, Review rails) — called once from `runQAStage`, and it
  issues its own `git` reads with `execFileSync` rather than calling into
  `src/git.ts`. Two reads: `git status --porcelain=v1 --untracked-files=all`
  over the whole review worktree, and a second status adding `--ignored`
  scoped to the ignored artifact roots (`.afk`, and the checkpoint/evidence
  directories under it). Both pass `-c core.quotePath=false` for the reason
  `src/git.ts:1299-1305` records. The exported `git.statusPorcelain`
  (`src/git.ts:489`) is deliberately **not** reused and not amended: its argv
  carries neither `--untracked-files=all` nor `--ignored`, so it cannot report
  the `.afk/` paths this behavior makes load-bearing, and changing that argv
  would change what the ship gate parses out of it
  (`src/ship-gate.ts:1046`, `src/git.ts:481-488`) in a file outside this
  slice's scope. A tree-object diff is ruled out for the same reason it
  cannot be `git.diffTreePaths` (`src/git.ts:1323`): `.afk/` is gitignored
  (`.gitignore:3`), and a tree built the way `resolveCandidateTreeId` builds
  one — `git add -A` through a throwaway index,
  `src/gate-runner.ts:261-311` — cannot see an ignored path at all.
  Subtracting the seed manifest is what makes the seeded pair
  invisible to this scan, so the amendment attempt of B-02 emits no
  violation for `contract.md` or `acceptance-manifest.json`. Violations are
  reported, never fatal: the discard already happened at B-03.
- [behavior:B-05] A new module `src/change-summary.ts` exports one builder
  parameterised by a repo directory and two tree-ish refs, plus a candidate
  variant that binds the refs to the feature base and the candidate
  checkpoint tree, and writes `change-summary.json` into
  `.afk/artifacts/<run-slug>/slice-<n>/`. Parameterised, not duplicated,
  because slice 04 (#96) adds the baseline → final variant to this same
  module and D11 requires one producer (`prd.md:272-281`). **Seam recorded
  here:** the builder is not pure in the no-I/O sense — it reads git — but it
  is a deterministic function of its `(cwd, fromRef, toRef)` arguments alone,
  holding no orchestrator, run-state or run-slug state, which is the property
  slice 04 relies on to add a second variant. Its git reads are performed in
  `src/change-summary.ts` itself with `execFileSync`, for the same reason
  B-04's are: no exported `src/git.ts` function answers "commits, changed
  files and diff stats between two arbitrary tree-ish refs" —
  `git.logCommitsWithStat` (`src/git.ts:726`) is hard-wired to
  `<base>..HEAD` in one worktree, `git.listChangedFiles`
  (`src/git.ts:1272`) unions worktree and index state into a bare path list,
  and `git.diffTreePaths` (`src/git.ts:1323`) returns names with no commits
  and no stats — and `src/git.ts` is outside the file-scope map for this
  slice (`prd.md:498-501`). It is generated from git, never from an agent,
  and lands before the evaluator is invoked
  so the review worktree's seeded inputs can reference it — the merged
  candidate manifest already leads with `change-summary`
  (`src/context-envelope.ts:637-647`).
- [behavior:B-06] On a deterministic PASS the orchestrator — never the
  evaluator — writes `approved-baseline.json` beside the change summary in
  `.afk/artifacts/<run-slug>/slice-<n>/`, holding the candidate checkpoint
  tree ID and commit, the `contract.md` and `acceptance-manifest.json` blob
  IDs, and the gate evidence artifact IDs (D10, `prd.md:263-270`). Every
  value is already in the orchestrator's hand on the PASS path: the tree ID
  and commit from `checkpoint`, the blob IDs from the already-imported
  `git.hashFileAsBlob` (`src/orchestrator.ts:4277`), and the evidence
  artifact ID from `QABaseGateEvidence.evidenceArtifactId` as the
  orchestrator itself computes it at `src/orchestrator.ts:5752-5760`, with
  the per-gate `evidenceArtifactId` / `logArtifactId` already delivered to
  its `onGateOutcome` callback (`src/candidate-gate-phase.ts:30-31`,
  `src/orchestrator.ts:5631-5658`) — so no new export from
  `src/gate-runner.ts` is required, which is why that file is outside this
  slice's scope. `src/run-state.ts` goes to version 4 with an additive
  per-slice `approvedBaseline` record — checkpoint tree ID, commit, and the
  artifact's repo-relative path — plus a reader and an in-memory adapter for
  v3, so a resumed run can locate the baseline without re-deriving it
  (ARCHITECTURE.md placement rule; existing v0→v3 adapter,
  `src/run-state.ts:675-778`). **Decision recorded here:** the artifact file
  is canonical, because D20 compares the final tree against
  `approved-baseline.json` itself (`prd.md:392`); the run-state record is a
  locator, so nothing has two authorities for the same fact. A new
  `approved-baseline` run event is added to `RunEventPayload`; additive
  variants leave `EVENTS_SCHEMA_VERSION` at 1, as `behavior-coverage` did
  (`src/run-events.ts:26`, `src/run-events.ts:186`).
- [behavior:B-07] `CANDIDATE_EVALUATOR_CONTEXT_MANIFEST`
  (`src/context-envelope.ts:602-657`) is reshaped in place, not replaced: the
  role ID stays `evaluator-qa`, `outputArtifact` stays `qa-review-pair`,
  `allowedWriteScope` stays the two canonical artifacts, `change-summary`
  stays first in `inputOrder`, and `handoff.md` stays absent via the
  `candidate-handoff` and `dependency-sibling-handoffs` entries in
  `omittedArtifactClasses` (`src/context-envelope.ts:650-655`). No second
  candidate verdict artifact name is introduced (D9, `prd.md:244-253`).
- [behavior:B-08] `prompts/evaluator-qa.md` states the four judgement
  questions — intent, boundaries, preservation, and test honesty and
  sufficiency — and states the D14 probe rule in the terms D14 uses: the
  evaluator may run ad-hoc probes in its own disposable worktree and quote
  what it observed in a finding's `evidence` field; no schema field carries
  probe code and no mechanism hands a probe file to the generator
  (`prd.md:332-340`). It also states that the worktree is disposable and
  that any write outside the two canonical artifacts is discarded, so the
  prohibition is instruction as well as enforcement.
- [behavior:B-09] `src/logger.ts` renders one new `run-summary.md` section
  for this slice's records — the approved baseline per slice and the
  reviewer-write violations — alongside the existing `## Base Gates`,
  `## Advisory Gates` and `## Behavior Coverage` sections
  (`src/logger.ts:415-461`).

### Non-goals (explicit out-of-scope)

- Moving the `scope` gate into the pre-QA declaration set. Its call site
  stays on the final candidate after the QA window
  (`src/orchestrator.ts:5921-5935`), which is where `prd.md:685-691` and
  `anchors/08-file-scope-gate.md` put it. See P-02.
- Adding an evaluator-round budget to `src/bounds.ts`. `src/bounds.ts` is
  not in this slice's column of the exhaustive file-scope map
  (`prd.md:503-533`), so the three-round bound is the existing round loop's,
  preserved by P-03, not new work here.
- Editing `src/gate-runner.ts` or `src/base-gates.ts`. Every symbol this
  slice consumes from them is already exported and already imported by
  `src/orchestrator.ts` (see B-04, B-06).
- Adding, amending or widening any `src/git.ts` export — including
  `git.statusPorcelain`'s argv. The two reads no existing export covers live
  in `src/qa-review.ts` (B-04) and `src/change-summary.ts` (B-05), both in
  this slice's file scope. See B-01's recorded decision.
- Slice 04's baseline → final change-summary variant, its exact-tree reuse
  decision (D20), and `prompts/evaluator-final.md`.
- Any change to the acceptance manifest schema; it stays at version 2
  (`prd.md:664-665`).
- Isolating the shared-preview UAT stage. See P-04.

### Existing behavior to preserve

- [behavior:P-01] A red required pre-QA gate — base or acceptance — returns
  to the generator without dispatching an evaluator. The
  `requiredFailures.length > 0` branch sets `retryNote` and `continue`s the
  implementation loop (`src/orchestrator.ts:5698-5730`) and does not reach
  `runQAStage` (`src/orchestrator.ts:5772`). Its round accounting is already
  distinguished: `RunJournal.bumpEvalRound` (`src/run-journal.ts:417`)
  advances the slice lifecycle's `evalRounds`, and the `continue` at
  `src/orchestrator.ts:5730` returns before the `bumpEvalRound` call at
  `src/orchestrator.ts:5731`, so a gate-red round costs a generator round and
  no evaluator round.
- [behavior:P-02] `scopeGateDeclaration` keeps its single post-QA call site
  in `postQaDeclarations` (`src/orchestrator.ts:5921-5935`): a red `scope`
  still becomes REPAIR and a fresh generator round rather than a merge, and
  the candidate still reaches the evaluator, which ADR 0048's amendment
  warrant requires. **Decision recorded here:** #91's AC1 names the scope
  gate alongside base and acceptance, and `prd.md:685-691` supersedes it —
  the parent PRD, which #91's own header makes the authority on settled
  cross-slice decisions, weakened #195's AC1 from "does not reach evaluation
  or merge" to "does not merge" on exactly this reasoning. D19's
  never-dispatch guarantee therefore binds the pre-QA set, which is what
  P-01 covers.
- [behavior:P-03] The deterministic stage's attempt and round accounting is
  unchanged: `attemptLimit()` stays `infrastructureRetries + 1 + amendments`
  (`src/orchestrator.ts:4357`), an applied amendment still buys one extra
  attempt and no implementation round (ADR 0048), and every attempt is still
  archived under `.afk/artifacts/<run-slug>/slice-<n>/` stamped
  `r<N>-a<M>` beside the contract-review archives via
  `artifacts.contractReviewArchiveDir` and `archiveQAReviewRecord`
  (`src/orchestrator.ts:4331-4335`, `src/orchestrator.ts:4567-4570`).
- [behavior:P-04] `runQAStage` with `stage === "shared-preview"` keeps
  running in `ctx.worktreeDir`: the migration commands at
  `src/orchestrator.ts:4605-4616` and the UAT invocation still use the
  generator's worktree, and `uat-report.md` / `uat-review.json` are still
  written and read there directly with no copy-back step (#91 AC12).
- [behavior:P-05] A PASS carrying an unresolved blocking finding stays
  mechanically invalid: `QAAttemptLifecycle.recordAttempt`
  (`src/orchestrator.ts:4580-4585`) and `src/qa-convergence.ts` decide the
  verdict's validity from the recorded findings, and the disposable worktree
  changes only where the pair was written, not how it is graded.

### Changes to existing behavior (only if the issue asks for it)

- The deterministic evaluator's working directory changes from
  `ctx.worktreeDir` to a disposable review worktree
  (`src/orchestrator.ts:4661`), and its two output artifacts arrive in
  `ctx.absSliceDir` by copy-back rather than by direct write. Authorized by
  #91 ("a fresh evaluator invocation inspects a detached disposable worktree
  at the exact checkpoint") and by ADR 0012's statement of the behavior being
  replaced ("runs inside the slice's worktree, before the slice is merged",
  `docs/adr/0012-evaluator-qa-runs-sanity-command-set.md:10`).
- `QA_WINDOW_ARTIFACT_NAME` (`src/post-qa-gates.ts:38`) changes from
  module-private to exported. Authorized by D9's instruction to reuse that
  exact set rather than write a second dialect (`prd.md:250-253`).
- `src/run-state.ts` goes from version 3 to version 4 (`src/run-state.ts:50`)
  with an additive record and a v3 adapter. Authorized by D10 plus the
  map's `baseline record` cell for this slice (`prd.md:521`).

## Files expected to change

- src/orchestrator.ts
- src/change-summary.ts
- src/candidate-gate-phase.ts
- src/post-qa-gates.ts
- src/qa-review.ts
- src/context-envelope.ts
- src/run-state.ts
- src/run-events.ts
- src/logger.ts
- prompts/evaluator-qa.md
- ARCHITECTURE.md
- src/change-summary.test.ts
- src/prompt-template.test.ts
- src/post-qa-gates.test.ts
- src/context-envelope.test.ts
- src/run-state.test.ts
- src/logger.test.ts
- src/qa-orchestration.test.ts
- src/orchestrator.test.ts

## Migration requirements

- New migration files: 0

## New patterns / deps / schema (if any)

- New module `src/change-summary.ts` — one pure two-tree builder plus a
  candidate variant, so #96 adds a variant and not a producer (D11).
- New artifact `.afk/artifacts/<run-slug>/slice-<n>/approved-baseline.json`
  and `change-summary.json`. Not committed: `.afk/` is gitignored
  (`.gitignore:3`).
- `src/run-state.ts` schema version 3 → 4, additive, with a reader and an
  in-memory v3 adapter.
- New `RunEventPayload` variants `approved-baseline` and
  `reviewer-write-violation`; `EVENTS_SCHEMA_VERSION` stays 1.
- No new runtime dependency. AFK has none, and this slice adds none.

## Test plan

- Given a slice whose required acceptance gate is red, when the
  implementation round finishes, then the `slice-outcome` event's
  `evalRounds` is unchanged for that round while `genRounds` advances, and
  `events.jsonl` holds no `phase-started` with `agent: "evaluator-qa"` for
  it.
- Given a stub deterministic evaluator that edits a source file under `src/`
  in its worktree and writes `qa-review.json` plus `qa-report.md`, when the
  attempt ends, then the source edit is absent from `ctx.worktreeDir` and
  from the accepted commit, one `reviewer-write-violation` event names that
  path, and both canonical artifacts are present in `ctx.absSliceDir`.
- Given a stub deterministic evaluator that also writes `notes.md`,
  `approved-baseline.json` and `nested/qa-review.json` beside its verdict
  pair, when the attempt ends, then none of the three exists under
  `ctx.absSliceDir` and each is named by its own
  `reviewer-write-violation` event — including the one under the gitignored
  artifact root.
- Given a deterministic attempt granted by an applied scope amendment, when
  the orchestrator seeds the amended `contract.md` and
  `acceptance-manifest.json` into the review worktree, then no
  `reviewer-write-violation` event names either path, and the evaluator's
  attempt reads the amended bytes.
- Given a deterministic PASS, when the stage returns, then
  `.afk/artifacts/<run-slug>/slice-<n>/approved-baseline.json` holds the
  checkpoint tree ID and commit, both pair blob IDs and at least one gate
  evidence artifact ID; `change-summary.json` sits beside it; and the review
  worktree directory no longer exists.
- Given a deterministic evaluator invocation that throws, when the attempt
  loop unwinds, then the review worktree is still removed and no
  `approved-baseline.json` is written for that round.
- Given a temp repo with two commits and `src/change-summary.ts`, when the
  builder is called with that repo directory and the two tree-ish refs, then
  it returns the commits, files and diff stats between them, reading git
  itself and taking no orchestrator, run-state or run-slug argument; calling
  it twice with the same three arguments returns the same result.
- Given the reshaped `CANDIDATE_EVALUATOR_CONTEXT_MANIFEST`, when it is
  read, then `role` is `evaluator-qa`, `outputArtifact` is
  `qa-review-pair`, `allowedWriteScope` is the two canonical artifacts,
  `change-summary` is first in `inputOrder`, and `handoff.md` resolves to no
  input.
- Given `prompts/evaluator-qa.md` read from disk in
  `src/prompt-template.test.ts` — the existing non-spawned home for prompt
  text assertions (`src/prompt-template.test.ts:138-244`) — when its text is
  inspected, then it names the four judgement questions, states both halves
  of the D14 probe rule (probes allowed and quoted as evidence, transport
  deferred), and states that any write outside the two canonical artifacts is
  discarded.
- Given a version-3 run-state file, when it is loaded, then it adapts to
  version 4 in memory with no `approvedBaseline` record and no write.
- Given a run that recorded an approved baseline and a reviewer-write
  violation, when `run-summary.md` is rendered, then the new section names
  both.
- Given a shared-preview UAT stage, when it runs, then its invocation `cwd`
  is `ctx.worktreeDir`, no review worktree is created, and `uat-report.md`
  is read from `ctx.absSliceDir` exactly as today.
- New assertions follow AGENTS.md's ladder: the change-summary builder, the
  manifest reshape, the run-state adapter, the allowlist export, the
  `prompts/evaluator-qa.md` text and the
  run-summary section are unit tests; the isolation, copy-back, violation
  and baseline assertions extend existing spawned scenarios in
  `src/qa-orchestration.test.ts`, and the P-01 assertion extends an existing
  `evalRounds` scenario in `src/orchestrator.test.ts`. A new spawned
  scenario is added only if no existing one reaches the deterministic
  evaluator, with a comment saying so.

## Definition of done

- [ ] `pnpm run typecheck` passes.
- [ ] The deterministic evaluator invocation's `cwd` is a disposable review
      worktree created from the candidate checkpoint commit and removed on
      every exit path, including throw and cancellation.
- [ ] `QA_WINDOW_ARTIFACT_NAME` is exported from `src/post-qa-gates.ts` and
      is the only allowlist consulted by copy-back; no second regex or
      basename list exists in this slice's changed files.
- [ ] Every non-allowlisted evaluator write in the review worktree is
      discarded and named by a `reviewer-write-violation` run event,
      including a write under the gitignored `.afk/` root.
- [ ] The per-attempt seed manifest is subtracted from the violation scan,
      and the scope-amendment attempt emits no violation for `contract.md`
      or `acceptance-manifest.json`.
- [ ] A deterministic PASS writes `approved-baseline.json` with all four
      recorded facts, and `change-summary.json` beside it, both authored by
      the orchestrator.
- [ ] `src/run-state.ts` is version 4, reads version 3 without a write, and
      has a reader for the new record.
- [ ] `CANDIDATE_EVALUATOR_CONTEXT_MANIFEST` is reshaped in place with the
      role ID, output artifact, write scope and `handoff.md` omission
      unchanged.
- [ ] `prompts/evaluator-qa.md` states the four questions, both halves of
      the D14 probe rule, and the discard instruction — asserted in
      `src/prompt-template.test.ts`, not in a spawned suite.
- [ ] `src/git.ts` is unmodified: the violation-scan status read lives in
      `src/qa-review.ts` and the two-ref summary read in
      `src/change-summary.ts`, and no call to `git.statusPorcelain`,
      `git.diffTreePaths`, `git.logCommitsWithStat` or `git.listChangedFiles`
      is relied on for either.
- [ ] `src/logger.ts` renders the new `run-summary.md` section and
      `ARCHITECTURE.md` carries this slice's rows.
- [ ] Shared-preview UAT still runs in `ctx.worktreeDir` with no copy-back.
- [ ] `pnpm test:fast` passes, plus `pnpm run test:heavy:qa-orchestration`
      and `pnpm run test:heavy:orchestrator`.

# Slice 03 — Recovery attempt execution — evidence map

Source: `gh issue view 332` (PRD9-S3). Parent PRD is
`.kiro/specs/afk-preserved-work-renegotiation/prd.md` (not opened — the
protocol/failure matrix are binding there per the issue body, but this
slice's task is scoped entirely by issue #332 and this repo's existing
modules; FACT below cites only files actually opened this session).

## Files and current behavior

- FACT: The admission half of the recovery protocol is implemented in
  `src/preserve-work-recovery.ts` (module docstring, lines 1–33). It exports
  `admitStaleRenegotiation` (line 618), which appends exactly one `PENDING`
  `PersistedRecoveryLineageEvent` under the ADR 0056 run-state lock
  (`src/preserve-work-recovery.ts:759-778`) and nothing else. This slice's own
  issue text states execution is the successor that "runs the attempt that
  event admitted" and "adds no second admission rule."
- FACT: `PersistedRecoveryLineageEvent` carries `target: RecoveryTargetIdentity
  { number, ghIssue }`, `attemptId`, `state`, `snapshotPath`,
  `contractFingerprint`, `manifestFingerprint`, `sliceBranch`, `sliceHead`,
  `featureHead`, `scopeFingerprint`, `reason`, `extensions: []`, `recordedAt`
  (`src/preserve-work-recovery.ts:759-777`, imported type from
  `src/run-state.ts`).
- FACT: `hasOpenRecoveryAttempt(state, ghIssue)` (line 551) returns whether the
  target's lineage's last event has `state === "PENDING"`, via
  `recoveryLineageFor` imported from `src/run-state.ts`. This is the existing
  read this slice's "execution starts only after the attempt's PENDING event
  has committed" precondition can reuse.
- FACT: `RecoveryLineageState` legal transitions are declared in
  `LEGAL_RECOVERY_TRANSITIONS` (`src/preserve-work-recovery.ts:231-249`):
  `PENDING → {COMPLETED, ROLLED_BACK, ROLLBACK_FAILED}`; nothing transitions
  back to `PENDING`. `isLegalRecoveryTransition` (line 252) checks one
  transition against that map.
- FACT: The issue explicitly forbids this slice from writing `COMPLETED`,
  `ROLLED_BACK`, or `ROLLBACK_FAILED` — verified restore/rollback is the next
  successor slice named in `issues.md` (issue body, "Two boundaries are
  settled here"). So execution in this slice appends no terminal lineage
  event at all; it only clears checkpoint/convergence state and reruns
  explorer/planner/evaluator.
- FACT: `readLockedAcceptedPair(sliceDir)` (`src/preserve-work-recovery.ts:316`)
  reads `contract.md` (`CONTRACT_FILENAME`, line 73) and
  `acceptance-manifest.json` (`ACCEPTANCE_MANIFEST_FILENAME`, imported from
  `src/acceptance-manifest.ts`) from a slice dir, and validates the contract's
  `**Status:** LOCKED` line plus manifest coverage. This is the only existing
  reader of "the accepted pair," but the issue's six-file copy set
  (`context.md`, `contract-review.json`, `contract-response.json`,
  `contract-negotiation-outcome.json`, `planner-escalation.md`,
  `feedback-r*.md`) is disjoint from `contract.md`/manifest — none of those
  six is read or written by `preserve-work-recovery.ts` today.
- FACT: `CONTRACT_RESPONSE_FILENAME = "contract-response.json"` and
  `CONTRACT_NEGOTIATION_OUTCOME_FILENAME = "contract-negotiation-outcome.json"`
  are declared in `src/contract-review.ts:11-13`. `contract-response.json` is
  read at `src/contract-review.ts:551` (default `source` param at line 433).
- FACT: `planner-escalation.md` is owned by `src/planner-escalation.ts` (file
  exists; not opened this session — filename match only from
  `Grep "planner-escalation"` over `src/`).
- FACT: `feedback-r*.md` round files and `contract-review.json` are handled by
  `src/contract-review.ts` / `src/contract-prompt-orchestration.test.ts`
  (filename matches from the same grep; contents not opened this session).
- FACT: `RECOVERY_SNAPSHOT_DIRNAME = "recovery-snapshots"`
  (`src/preserve-work-recovery.ts:76`) is the directory
  `publishAcceptedPairSnapshot` (line 478) already publishes the accepted
  `contract.md`/manifest pair beneath, keyed by `attemptId`
  (`join(sliceDir, RECOVERY_SNAPSHOT_DIRNAME, attemptId)`, line 494).
  `listPublishedPairSnapshots(sliceDir)` (line 788) lists published attempt
  dirs. The issue's "immutable history beneath the target's artifact
  directory" for the six live negotiation files is a second, disjoint history
  location this slice must define — INFERENCE: keeping the six files inside
  the same per-attempt directory the snapshot already occupies
  (`recovery-snapshots/<attemptId>/...`) would reuse an existing directory
  identity instead of inventing a second one, but the issue does not name the
  path and no code establishes it, so the exact layout is `UNKNOWN`.
- FACT: `publishAcceptedPairSnapshot` writes through a temp sibling directory
  (`.${attemptId}.partial`) and `renameSync`s it into place only after
  re-reading and byte-comparing the copy (`src/preserve-work-recovery.ts:502-529`).
  This is the existing "byte-verified, atomic publish" pattern the issue's
  "byte-copied into the attempt's immutable history... before any of them is
  deleted" requirement echoes for the six live files.
- FACT: `clearExactStageCheckpoint(location: { repoRoot, prdSlug, ghIssue })`
  (`src/exact-stage-resume.ts:179-203`) is the existing single-slice checkpoint
  clear: it deletes `state.stageCheckpoints[ghIssue]` under `transactRunState`,
  removing the whole `stageCheckpoints` key when the map becomes empty. This is
  the "existing single-slice clear" the issue's acceptance criteria says must
  be wrapped, not modified, by the new recovery module.
- FACT: `ExactStageCheckpoint.completedStage` is typed as
  `CompletedCandidateStage = "deterministic-qa" | "shared-preview-uat"`
  (`src/exact-stage-resume.ts:14-16, 20-26`) — i.e. today's only exact-stage
  checkpoints are post-implementation (post-QA) stages, not a "contract stage."
  INFERENCE: the issue's "target's contract-stage checkpoint" refers generically
  to whatever entry `clearExactStageCheckpoint` removes for that `ghIssue` from
  `state.stageCheckpoints` (the function clears by `ghIssue` regardless of
  `completedStage` value), not to a new checkpoint variant this slice must add —
  the issue never asks for a new `CompletedCandidateStage` member and forbids
  editing "the module that owns the checkpoint." Whether a contract round ever
  actually populates `stageCheckpoints` for a slice today is `UNKNOWN`.
- FACT: There is no existing "clear" function in `src/contract-convergence.ts`
  for one slice's `contractConvergence` entry. `saveContractFindingLineage`
  (line 609) always merges a lineage value in
  (`state.contractConvergence = { ...existing, [ghIssue]: lineage }`, lines
  614-618); `emptyContractFindingLineage()` (line 78, not opened in full) is
  the type's zero value. INFERENCE: "clear... through the focused run-state API
  that owns it" for contract-convergence means calling
  `saveContractFindingLineage(location, emptyContractFindingLineage())` from the
  new recovery module — the issue's "any adaptation... lands as a wrapper in
  the new recovery module, leaving the module that owns the checkpoint
  unmodified" applies this pattern to both the checkpoint and the convergence
  clears.
- FACT: `RunState.contractConvergence` and `RunState.stageCheckpoints` are both
  typed `unknown` on the persisted schema (`src/run-state.ts:369`, `:363`) and
  are two of the fields `RUN_STATE_VERSION` migration logic (lines 1244,
  1300-1301) forwards untouched across versions — confirms these are
  independent, separately-keyed maps, not a single "slice state" blob.
- FACT: `clearSliceStateForDispatch(repoRoot, prdSlug, ghIssue)`
  (`src/run-state.ts:1567-1578`) deletes `state.slices[ghIssue]` wholesale and
  is documented (lines 1556-1565) as deliberately **not** touching resume
  `attempts`, exact-stage checkpoints, contract/QA convergence lineage,
  `scope`, `migrations`, or `reviewPhase`. This is a different, coarser
  operation than what #332 asks for — it clears the terminal-outcome record
  for a *dispatch*, not one field for a *recovery attempt* — and the issue's
  acceptance criteria ("resume counters, slice outcomes, implementation and QA
  state, migration claims, guardian history and every other slice's fields...
  unchanged") reads as ruling this function out for recovery execution.
- FACT: `evaluateRecoveryEligibility` (`src/preserve-work-recovery.ts:350-447`)
  and `admitStaleRenegotiation` only ever call three injected git predicates
  (`RecoveryGitProbes`: `hasUncommittedChanges`, `countCommitsAhead`,
  `isAncestor`, lines 268-278) plus `resolveCommit` for branch tips
  (lines 649-650, imported from `src/git.ts`). No merge/reset/rebase is called
  anywhere in this file — matches the issue's "no code path in this slice runs
  a git merge, reset or rebase."
- FACT: `src/run-identity.ts` exports `featureBranchForProviderName` and
  `sliceWorktreeDirForProviderName`, both already used by
  `preserve-work-recovery.ts` (imports, lines 57-60) to name the target's
  branch and worktree without touching git state.
- FACT (entry-point refusal, must stay intact): the issue states "#277's
  entry-point refusal stays in place for the whole successor chain:
  `--renegotiate-stale` stays refused at the three entry points until the
  completion slice lands." Not verified in this session which three files hold
  that refusal (CLI entries per ARCHITECTURE.md are `src/afk.ts`,
  `src/afk-claude.ts`, `src/afk-codex.ts`) — `UNKNOWN` which file(s) actually
  contain the refusal check.
- FACT: The commit at HEAD (`a7a97c2 feat(#277): Preserve-work recovery
  admission`, from git status) and preceding commits (`054207b`, `9b8e30c`,
  `24b3d4a`, `0caa0f8`) are all tagged `(#277)` — i.e. #277 is fully landed on
  this branch already, matching the issue's "Once #277's PENDING event has
  committed" premise and "Blocked by #277" metadata.

## Patterns and test harness

- FACT: `src/preserve-work-recovery.test.ts` is the existing test file for
  this module (module docstring, lines 1–14). It builds one real git repo
  once per file (`beforeAll`) and resets it `beforeEach`, injecting
  `RecoveryGitProbes` stubs for all *eligibility* branching so per-case
  `git init` is avoided; the one spawned child process in the file exists only
  to prove the B-08 interleave between two independent OS processes around the
  run-state lock (docstring lines 4–13). INFERENCE: a new execution test in
  this file should follow the same rule — inject seams/stubs for anything not
  git-tip-resolution, and justify a new spawn (if any) only as a last resort,
  matching this slice's own acceptance criterion ("extend an existing
  resume/negotiation fixture... say so in a comment if not").
- FACT: `src/preserve-work-recovery.test.ts` imports fixture helpers only from
  `run-identity.ts`, `run-state.ts`, `slice-scope.ts`, and the module under
  test itself (lines 29-58) — it does not currently import
  `resume-integration.fixtures.ts` or any wave fixture.
- FACT: `src/resume-integration.fixtures.ts` is the shared fixture module for
  `resume-integration.test.ts` and `resume-worktree.test.ts`, split across two
  files "so one `vitest run` schedules them across both workers" (module
  docstring lines 1-11). It exports `makeRepo`, `git`, `cleanupResumeTempDirs`,
  and helpers `writeContractReview`/`writeQAReview` re-exported from
  `src/test-support.ts` (lines 26, 49-60). This is a candidate "existing
  resume/negotiation fixture" the issue's last acceptance criterion asks to
  extend, though it currently has no recovery-lineage awareness — `UNKNOWN`
  whether it or `preserve-work-recovery.test.ts`'s own in-file repo is the
  better extension point for an execution test that needs both a committed
  `PENDING` event and a real contract-negotiation round.
- FACT: `admitStaleRenegotiation`'s test seams
  (`beforeLockAcquired`, `afterTemporaryWritten`, both optional callbacks on
  `AdmitStaleRenegotiationArgs`, lines 587-599) are the existing precedent for
  how this module exposes interleave/ordering hooks to tests without widening
  a shared primitive (`transactRunState`/`withFileLock`). INFERENCE: an
  execution entry point in the new module should follow the same shape if it
  needs a similar seam, per the docstring's stated rationale (lines 591-596).
- FACT: `AGENTS.md` is referenced repeatedly (module docstring line 8;
  ARCHITECTURE.md "Tests:" placement rule) as the source of the "prefer a unit
  test, then an existing spawned scenario, then a new slice in an existing
  wave fixture — a new spawned scenario is last resort" ladder; not opened
  directly this session, but both the module docstring and ARCHITECTURE.md
  cite it as the same rule, and issue #332's own acceptance criteria restate
  it verbatim for this slice ("Add no spawned pipeline scenario unless no
  existing fixture can reach the state").
- FACT: ARCHITECTURE.md lists `src/preserve-work-recovery.ts` under module
  "Preserved-work recovery" with public seam = the file itself and no
  `Internals (do not import)` entry, i.e. it currently has no split-out
  internals module. A new execution function is expected to land in this same
  file (issue: "the new recovery module") rather than a new file, matching the
  ARCHITECTURE.md module table's current shape (one file, no internals).
- FACT: ARCHITECTURE.md's placement rule "A new persisted fact extends
  `src/run-state.ts`'s schema with a version bump and a reader" governs any new
  field this slice might add; the issue's own acceptance criteria, by contrast,
  ask for *reuse* of two already-owned focused APIs
  (`clearExactStageCheckpoint`, `saveContractFindingLineage`) rather than a new
  schema field, so no version bump is implied by the issue text itself —
  INFERENCE, since no new field name is specified anywhere in #332.

## Data and integration

- FACT: The six live negotiation files the issue names —
  `context.md`, `contract-review.json`, `contract-response.json`,
  `contract-negotiation-outcome.json`, `planner-escalation.md`,
  `feedback-r*.md` — live directly beneath "the target's artifact directory"
  per the issue body. `preserve-work-recovery.ts` already parameterizes that
  directory as `sliceDir` on every public function
  (`evaluateRecoveryEligibility`, `publishAcceptedPairSnapshot`,
  `admitStaleRenegotiation`, all taking `sliceDir: string`) — the same
  parameter name/shape an execution function would need to locate the six
  files and the `recovery-snapshots/` sibling directory.
- FACT: `PersistedRecoveryLineageEvent.snapshotPath` (referenced at
  `src/preserve-work-recovery.ts:773`) is stored as a repo-root-relative,
  forward-slash-normalized locator (`relative(args.repoRoot, published)
  .split("\\").join("/")`, lines 542-543) — any new path this slice records
  (if it records one) should follow the same normalization to stay
  comparable across POSIX/Windows checkouts (this repo runs on win32 per the
  environment banner).
- FACT: `reviews/` (a subdirectory under the slice dir, referenced by the
  issue's "Existing `reviews/` contents... stay untouched") is not read or
  written anywhere in `src/preserve-work-recovery.ts` — no FACT establishes
  its schema; `UNKNOWN` what else lives there beyond the acceptance
  criterion's assertion that it must be left alone.

## Unknowns

- UNKNOWN: The exact on-disk layout for the six-file "immutable history"
  this slice must create (a new subdirectory name, or reuse of
  `recovery-snapshots/<attemptId>/`) — issue #332 says only "beneath the
  target's artifact directory," and no code in this repo establishes it yet.
- UNKNOWN: Whether `state.stageCheckpoints` is ever actually populated for a
  slice still in its contract stage today, given the only concrete
  `CompletedCandidateStage` values are post-QA (`deterministic-qa`,
  `shared-preview-uat`) — i.e. whether "clear the target's contract-stage
  checkpoint" is normally a no-op clear (entry absent) or removes a real
  entry, for the run states this slice's execution path will encounter.
- UNKNOWN: Which of the three CLI entry points
  (`src/afk.ts`, `src/afk-claude.ts`, `src/afk-codex.ts`) hold the
  `--renegotiate-stale` refusal #332 requires to stay in force — not opened
  this session, cited only from the issue body and ARCHITECTURE.md's CLI
  entries module row.
- UNKNOWN: The exact signature/return contract for "rerun explorer fact
  collection followed by the ordinary planner/evaluator negotiation" that
  this slice must trigger — which existing orchestrator entry point
  (`src/orchestrator.ts`, `src/contract-review.ts`, or a new call) dispatches
  that pair was not located this session; the issue only names the two
  agents by role, not a function.
- UNKNOWN: What identifies "the module that owns the checkpoint" precisely
  for `stageCheckpoints` if the issue intends something narrower than
  `src/exact-stage-resume.ts`'s existing `clearExactStageCheckpoint` — the
  evidence above assumes that function is the intended focused API, but this
  is an INFERENCE, not confirmed by any code comment naming this slice.

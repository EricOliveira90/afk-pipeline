## Files and current behavior

- FACT: `src/preserve-work-recovery.ts` is the whole recovery module so far.
  It exports admission (`admitStaleRenegotiation`, `evaluateRecoveryEligibility`,
  `canonicalizeRecoveryRequest`, `publishAcceptedPairSnapshot`,
  `readLockedAcceptedPair`, `runScopeFingerprint`, `hasOpenRecoveryAttempt`,
  `isLegalRecoveryTransition`) and attempt execution
  (`executeRecoveryAttempt`, `listLiveNegotiationFiles`,
  `clearRecoveryStageCheckpoint`, `clearRecoveryContractConvergence`). This
  slice (#333) adds nothing to those — it adds the two terminal outcomes of an
  admitted attempt (`ROLLED_BACK`, `ROLLBACK_FAILED`) and a dispatch-refusal
  check, per the module's own top-of-file doc comment: "The completion half —
  the terminal events, verified rollback, launch-time reconciliation — is #332
  through #335. This module ships the persisted shape and the transition rule
  those writers must obey, and none of the writers." (`src/preserve-work-recovery.ts:30-33`)

- FACT: `PersistedRecoveryLineageEvent` (`src/run-state.ts:284-315`) is the one
  persisted event shape all four states share (`RecoveryLineageState`,
  `src/run-state.ts:263-267`: `PENDING | COMPLETED | ROLLED_BACK |
  ROLLBACK_FAILED`). It already carries `snapshotPath`, `contractFingerprint`,
  `manifestFingerprint`, `sliceBranch`, `sliceHead`, `featureHead`,
  `scopeFingerprint`, `target`, `reason`, `provider`, `recordedAt`. This slice's
  acceptance criteria (fingerprints "actually observed" on a `ROLLBACK_FAILED`)
  imply a shape carrying *observed* fingerprints distinct from the event's own
  `contractFingerprint`/`manifestFingerprint` (which record the *original*
  accepted-pair bytes at admission, per `src/preserve-work-recovery.ts:309-312`).
  UNKNOWN: whether `PersistedRecoveryLineageEvent` needs new optional fields
  (e.g. `observedContractFingerprint`/`observedManifestFingerprint`, or a
  `restoreError` message) or whether the failure message/fingerprints are
  encoded some other way within the existing shape — no field currently exists
  to carry a restore-failure message or newly-observed fingerprints.

- FACT: `appendRecoveryLineageEvent(state, ghIssue, event)`
  (`src/run-state.ts:1190-1200`) is the only writer, append-only, and must be
  called from inside a `transactRunState` body (its own doc comment,
  `src/run-state.ts:1179-1189`: "the only legal moment to append is inside a
  `transactRunState` body that has already reloaded the file under the ADR
  0056 lock and rechecked the facts"). `admitStaleRenegotiation` is the only
  current caller (`src/preserve-work-recovery.ts:791`), inside
  `transactRunState` (`src/preserve-work-recovery.ts:690-797`).

- FACT: `sanitizeRecoveryLineage` (`src/run-state.ts:1093-1164`) validates every
  persisted event on load and requires every one of the fields above to be a
  non-blank string (or, for `extensions`, an array of non-blank strings) — an
  event missing any required field is dropped along with the whole target's
  list (`src/run-state.ts:1139-1142,1160`). INFERENCE: any new field this slice
  adds to `PersistedRecoveryLineageEvent` that is not present on some other
  transition's event must be optional (readable as absent), or
  `sanitizeRecoveryLineage`'s all-required check must be extended per-state,
  or older/other-state events will fail to round-trip through load/save.

- FACT: `isLegalRecoveryTransition` and `LEGAL_RECOVERY_TRANSITIONS`
  (`src/preserve-work-recovery.ts:230-264`) already encode this slice's target
  transitions: `PENDING -> {COMPLETED, ROLLED_BACK, ROLLBACK_FAILED}` and
  `ROLLBACK_FAILED -> {ROLLED_BACK}`; `ROLLED_BACK` and `COMPLETED` map to an
  empty set (terminal). This matches `prd.md:126-131`'s state diagram exactly.
  No change to this function is implied by the PRD text.

- FACT: `executeRecoveryAttempt` (`src/preserve-work-recovery.ts:968-1060`)
  already performs the negotiation-file clearing this slice must NOT undo: it
  byte-copies live negotiation files into `<snapshotDir>/negotiation/`, deletes
  the live copies, and clears the exact-stage checkpoint
  (`clearRecoveryStageCheckpoint`, wraps `clearExactStageCheckpoint` from
  `src/exact-stage-resume.ts`) and the contract-finding lineage
  (`clearRecoveryContractConvergence`, wraps `saveContractFindingLineage`/
  `emptyContractFindingLineage` from `src/contract-convergence.ts`). It appends
  **no** lineage event itself (doc comment, `src/preserve-work-recovery.ts:962-966`:
  "What it deliberately does not do: append a lineage event (the terminal
  events are #333/#335)"). FACT: the issue body confirms this slice ends "an
  admitted attempt that did not succeed" — i.e. it appends the terminal event
  after some other admitted-path failure has already happened (provider
  failure, evaluator non-acceptance, deterministic validation/lock-gate
  refusal, cancellation), not after `executeRecoveryAttempt` itself fails
  (that already returns `ok:false` with no lineage event, per
  `src/preserve-work-recovery.ts:975-981,988-994,1017-1023,1029-1034`).

- FACT: The snapshot this slice restores from is located at
  `event.snapshotPath` (repo-relative, `/`-separated;
  `src/preserve-work-recovery.ts:986`: `join(args.repoRoot,
  ...admitted.snapshotPath.split("/"))`). The snapshot directory holds exactly
  `contract.md` (`CONTRACT_FILENAME`, `src/preserve-work-recovery.ts:78`) and
  `acceptance-manifest.json` (`ACCEPTANCE_MANIFEST_FILENAME`, imported from
  `src/acceptance-manifest.ts`), published via `renameSync`
  (`src/preserve-work-recovery.ts:491-561`, doc comment: "never overwritten"),
  plus (after `executeRecoveryAttempt`) a `negotiation/` child
  (`RECOVERY_NEGOTIATION_DIRNAME`, `src/preserve-work-recovery.ts:817`). The
  accepted-pair files live at `join(sliceDir, CONTRACT_FILENAME)` and
  `join(sliceDir, ACCEPTANCE_MANIFEST_FILENAME)`
  (`src/preserve-work-recovery.ts:326-327`), and can be read/validated with the
  existing `readLockedAcceptedPair(sliceDir)` (`src/preserve-work-recovery.ts:323-348`),
  which returns `undefined` for anything not exactly a `LOCKED`, schema-valid
  pair rather than throwing.

- FACT: `readLockedAcceptedPair` requires `**Status:** LOCKED` and successful
  `parseAcceptanceManifest`/`validateAcceptanceManifestCoverage`
  (`src/preserve-work-recovery.ts:323-348`). INFERENCE: restoring the accepted
  pair by writing the snapshot's raw bytes back to `contract.md`/
  `acceptance-manifest.json` and then calling `readLockedAcceptedPair` again to
  verify is consistent with how the module already verifies copies elsewhere
  (`publishAcceptedPairSnapshot`, `src/preserve-work-recovery.ts:527-541`, and
  `executeRecoveryAttempt`'s history verification,
  `src/preserve-work-recovery.ts:1012-1024`, both re-read-and-compare after
  write, both verify from the *destination* bytes not the source). No
  restore/verify routine exists yet — this slice must add it.

- FACT: Nothing in `src/preserve-work-recovery.ts` or `src/run-state.ts`
  currently refuses agent dispatch based on recovery-lineage state. FACT: no
  "dispatch refusal" seam scoped to one GH issue currently exists in this
  module; `hasOpenRecoveryAttempt(state, ghIssue)` is the closest existing
  primitive (checks only for a trailing `PENDING`,
  `src/preserve-work-recovery.ts:563-570`). UNKNOWN: whether the fail-closed
  dispatch refusal this slice must add is a new exported predicate (e.g.
  `hasFailedRollback`/`recoveryDispatchRefusal`) called from a future
  orchestrator seam (#334 per the issue body: "exposes the routine for that
  successor to call rather than wiring an orchestrator call site itself"), or
  whether it must also be enforced somewhere reachable in this slice (the
  issue's AC says "every agent dispatch is refused" but the issue also says
  "this slice wires no orchestrator call site" — the two ACs read as: export
  the check, do not wire it to a real dispatch path).

- FACT: `PublishedPairSnapshot`/`PairSnapshotResult`/`AcceptedPairBytes`
  (`src/preserve-work-recovery.ts:457-468,302-308`) are the existing exported
  shapes for a snapshot and a read pair; a restore routine's result type does
  not yet exist.

- FACT: ADR 0039 ("A from-base restart never destroys unmerged commits") and
  the module's own doc comment (`src/preserve-work-recovery.ts:16-19`: "Nothing
  here moves a ref. No merge, reset or rebase is invoked on any path... Recovery
  exists to preserve unmerged commits") govern this slice directly — the
  acceptance criteria's "no branch tip, commit or worktree state changes on the
  rollback path" is the same invariant applied to the rollback path
  specifically.

- FACT: ADR 0055 ("accepted-pair validation, lock gate and provenance") and
  ADR 0056 ("one cross-process lock per run-state file") are cited as binding
  in `prd.md:11-14`. ADR 0018 (per-slice state persistence) is also cited
  there.

## Patterns and test harness

- FACT: `src/preserve-work-recovery.test.ts` builds one real git repo once per
  file (`beforeAll`) and resets fixture state per test (`beforeEach`)
  (`src/preserve-work-recovery.test.ts:4-13` doc comment), because eligibility's
  only real-git dependency is `resolveCommit` for two branch tips — every other
  git-derived fact goes through the injected `RecoveryGitProbes`
  (`hasUncommittedChanges`, `countCommitsAhead`, `isAncestor`,
  `src/preserve-work-recovery.ts:275-285`). The doc comment states the file's
  one spawned child process is reserved for the cross-process lock-interleave
  proof (B-08) — "the documented last-resort case for a spawn."
  (`src/preserve-work-recovery.test.ts:10-13`).

- FACT: Existing test helpers in that file: `admit(f, overrides)` (around
  `src/preserve-work-recovery.test.ts:274`) calls `admitStaleRenegotiation`;
  `admitPending(f, attemptId)` (`:1149-1153`) commits one `PENDING` attempt and
  returns its snapshot dir; `execute(f, overrides)` (`:1155-1166`) calls
  `executeRecoveryAttempt`; `writeSliceFiles`, `stateDocument`, `digestTree`,
  `checkpointsOf` exist for setting up/asserting slice-dir and run-state
  content. `NEGOTIATION_BYTES` is a fixture map of the live negotiation
  filenames to fixture bytes. INFERENCE: this slice's tests should add
  `rollback`/`rollbackAfterExecute`-style helpers alongside these, following
  the same shape (thin wrapper over the new exported function, `f` fixture,
  `overrides`).

- FACT: Test naming convention in this file tags each `it` with
  `[behavior:#<issue>:<code>]` (e.g. `[behavior:#332:B-01]`,
  `src/preserve-work-recovery.test.ts:1173`), matching the module doc's `B-0N`
  markers (e.g. `#277 B-06`, `#332 B-02`) — each test cites the numbered
  behavior it proves. INFERENCE: this slice's tests should follow the same
  `[behavior:#333:B-0N]` convention, defining new `B-0N` markers in this
  slice's own module/doc comments to be cited by test names, matching the style
  established for #277 and #332.

- FACT: The PRD's own Testing Decisions section
  (`.kiro/specs/afk-preserved-work-renegotiation/prd.md:244-253`) instructs:
  "Unit-test admission... state transitions... Extend an existing
  resume/negotiation fixture to prove the first admitted mutation is `PENDING`,
  process-death reconciliation restores exact bytes, rollback failure blocks
  dispatch, retries create new attempts, and no generator sees an unresolved
  pair." This slice's own issue body repeats: "extend an existing
  resume/negotiation fixture... Add no spawned pipeline scenario unless no
  existing fixture can reach the state, and say so in a comment if not." FACT:
  `src/preserve-work-recovery.test.ts` is that existing fixture for this
  module's own unit-level state-transition proofs; the issue's phrase
  "resume/negotiation fixture" plausibly also refers to a spawned-pipeline
  fixture elsewhere (e.g. `resume-integration`/`qa-orchestration` per
  `CLAUDE.md`'s heavy-suite list) but nothing in this slice's own module
  requires a spawn — restore-and-verify and dispatch refusal are pure
  filesystem/run-state operations exercisable entirely through the exported
  seams already in `src/preserve-work-recovery.test.ts`. UNKNOWN: whether a
  spawned-pipeline fixture (outside this module's own test file) is expected
  to gain a slice/assertion for this issue, or whether "extend an existing
  fixture" is fully satisfied by extending `src/preserve-work-recovery.test.ts`
  itself.

- FACT: `CLAUDE.md`'s "Where a new assertion goes" section (and ADR 0063) rank
  a new spawned pipeline scenario as last resort; this repo's ratchet
  (`pnpm test:ratchet`, `pnpm test:budgets`) is not part of `pnpm test` and
  should only be run when a spawned scenario is added.

- FACT: Per `CLAUDE.md`, while iterating run `pnpm vitest run
  src/preserve-work-recovery.test.ts` or `pnpm test:fast`; before handoff as an
  AFK slice agent run `pnpm test:fast` plus any touched heavy suite — do not
  run the full `pnpm test` in that role.

## Unknowns

- UNKNOWN: The exact persisted fields a `ROLLBACK_FAILED` event must add to
  carry "the failure message and the fingerprints actually observed" (AC5) —
  no such fields exist yet on `PersistedRecoveryLineageEvent`
  (`src/run-state.ts:284-315`), and `sanitizeRecoveryLineage`
  (`src/run-state.ts:1093-1164`) currently treats every listed field as
  required for every state.
- UNKNOWN: Whether the fail-closed dispatch refusal (AC6) is meant to be
  reachable from any code path in this slice (e.g. a new exported predicate
  with its own unit tests) or purely a documented contract for #334 to wire,
  given the issue's explicit "this slice wires no orchestrator call site."
- UNKNOWN: Whether "extend an existing resume/negotiation fixture" (issue body,
  and `prd.md:247-251`) refers only to `src/preserve-work-recovery.test.ts` or
  also to a spawned-pipeline fixture such as `resume-integration.test.ts` or
  `qa-orchestration.test.ts` (both listed as heavy suites in `CLAUDE.md`) —
  no read of those files was performed for this evidence map since nothing in
  `src/preserve-work-recovery.ts` currently touches the orchestrator's dispatch
  loop.
- UNKNOWN: Whether the restore-and-verify routine this slice exports (for
  #334's launch-time reconciliation) needs to accept an already-loaded
  `RunState`/locked transaction (matching `appendRecoveryLineageEvent`'s
  "must be called inside `transactRunState`" constraint) or a `repoRoot`
  convenience form — the issue body says "exposes the routine for that
  successor to call" but does not fix its signature.

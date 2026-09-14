# Handoff — Recovery attempt execution (#332)

## What shipped

- B-01: `src/preserve-work-recovery.ts:executeRecoveryAttempt` (refusal code
  `no-pending-attempt` on `RecoveryRefusalCode`)
- B-02: `src/preserve-work-recovery.ts:executeRecoveryAttempt`,
  `src/preserve-work-recovery.ts:listLiveNegotiationFiles`,
  `src/preserve-work-recovery.ts:RECOVERY_NEGOTIATION_DIRNAME`,
  `src/preserve-work-recovery.ts:RECOVERY_NEGOTIATION_FILENAMES`
- B-03: `src/preserve-work-recovery.ts:executeRecoveryAttempt` (`movedFiles`)
- B-04: `src/preserve-work-recovery.test.ts` (`digestTree` over the slice
  directory and the published pair)
- B-05: `src/preserve-work-recovery.ts:clearRecoveryStageCheckpoint`,
  `src/preserve-work-recovery.ts:clearRecoveryContractConvergence`
- B-06: `src/resume-integration.fixtures.ts:makeRecoveryExecutionFixture`,
  `src/resume-integration.test.ts` (the B-06 named test)
- B-07: `src/preserve-work-recovery.test.ts` (`inspectTarget`, `lineageOf`)
- B-08: `src/preserve-work-recovery.test.ts` (branch tips, worktree status and
  the `MODULE_CODE` text-level pin)
- B-09: `src/preserve-work-recovery.test.ts` (`recoveryLineageFor` before/after)
- P-01: `src/preserve-work-recovery.ts:admitStaleRenegotiation` (unchanged)
- P-02: `src/preserve-work-recovery.test.ts` (`parsePipelineRuntimeOptions`,
  `parseStaleRenegotiationRequest`)
- P-03: `src/preserve-work-recovery.test.ts` (import-shape and single-call-site
  pins over `MODULE_CODE`)
- P-04: `src/preserve-work-recovery.test.ts` (live pair bytes and the absence of
  a second `**Status:** LOCKED` writer)

## Decisions made during implementation

- The attempt's history is located from the recorded `snapshotPath` locator
  (`join(repoRoot, ...snapshotPath.split("/"))`) rather than re-derived from
  `sliceDir/recovery-snapshots/<attemptId>`, so no new persisted field is
  needed and the locator stays the single identity of an attempt.
- An already-published `negotiation/` child reuses the existing
  `snapshot-already-published` code with a negotiation-specific message,
  because the contract authorizes exactly one new `RecoveryRefusalCode` member
  and that member is spent on `no-pending-attempt`.
- `contractConvergence[ghIssue]` is cleared by writing
  `emptyContractFindingLineage()` through `saveContractFindingLineage` — the
  owning API has no delete — while `stageCheckpoints[ghIssue]` is removed by
  `clearExactStageCheckpoint`, which does. So the two clears are observably
  different shapes: an absent key versus an empty lineage.
- Publication always goes through `.negotiation.partial` plus one `renameSync`,
  including when a single file is present; the byte verification re-reads every
  copied file before the rename, and any failure removes the temporary
  directory and returns `snapshot-publication-failed` with nothing deleted.
- `executeRecoveryAttempt` takes `runSlug` optionally, defaulting to `prdSlug`,
  matching how the admission entry point in the same module resolves the state
  file key.

## Gotchas / learnings

- `src/preserve-work-recovery.test.ts` already asserts that `MODULE_CODE` (the
  module source with comments stripped) matches no `/\b(?:merge|reset|rebase)\b/i`
  for #277 B-06. Any new identifier, string literal or message in that module
  must avoid those three words — hence `movedFiles` and "cleared". Comments are
  exempt because they are stripped, but `MODULE_SOURCE` pins some comment
  wording, so check both constants before renaming anything.
- `ARCHITECTURE.md` lists `src/exact-stage-resume.ts` and
  `src/contract-convergence.ts` under "Internals (do not import)" of other
  module rows, while this slice's contract mandates importing both. Nothing
  enforces that column — `src/orchestrator.ts` and `src/non-progress.ts`
  already import them — so the wrappers import directly; a future slice that
  wants the column to be true has to move those two into a public seam.
- `parseContractFindingLineage` re-parses each finding through
  `parseContractReview`, so a hand-built `ContractFindingLineage` is not
  necessarily `toEqual` what `loadContractFindingLineage` returns for it.
  Compare round-tripped values, or assert on `Object.keys(...).findings` and
  "not empty" instead.
- A guardian round record with `source: "INVOKED"` must carry
  `findingsOriginRound` equal to its own round *even when it has no findings*
  (`sanitizeGuardianRecord`), and the round ledger is all-or-nothing: one
  malformed record makes `reviewPhase.rounds` read back as absent. The B-06
  fixture guards itself against that with a `toHaveLength(1)` on `rounds`
  before it measures anything.
- `makeRecoveryExecutionFixture` seeds its checkpoints and lineages through
  `recordExactStageCheckpoint` / `saveContractFindingLineage`, which rewrites
  the hand-written state document through `updateRunState`. Without that
  normalization pass a caller's "before" snapshot differs from the "after" one
  in fields execution never touched.

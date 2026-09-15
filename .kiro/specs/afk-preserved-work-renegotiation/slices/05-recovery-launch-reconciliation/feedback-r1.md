# Contract review — round 1

## What is already solid

The shape of this slice is right and most of it is locked well.

- The routine's signature `reconcileRecoveryLineage({ repoRoot, prdSlug, runSlug? })`
  matches the convention every other entry point in
  `src/preserve-work-recovery.ts` already uses (`runSlug ?? prdSlug` fed to
  `loadRunState`, as at lines 603-648 and 1336-1374), so the explorer's open
  question about the entry point's signature is answered from the module's own
  precedent rather than invented.
- The call-site anchor checks out: `src/orchestrator.ts:8497` is the top-level
  `try`, and `assertWithinManifestScope` (8500-8508) and the `resolveRunScope`
  write (8509-8516) are exactly the statements the contract promises to run
  after. Placing one call there, given all three entry points converge on
  `runPipeline`, is a sound answer to "every provider entry point" and needs no
  change to `afk.ts` / `afk-claude.ts` / `afk-codex.ts`.
- Reusing #333's two-phase discipline (restore outside the lock, recheck and
  append inside `transactRunState`) instead of inventing a second one, and
  routing the append through `isLegalRecoveryTransition` +
  `appendRecoveryLineageEvent`, keeps the transition table the single authority.
  P-02 binds that promise to the typecheck gate.
- Preservation is drawn where the issue draws it: #277's `--renegotiate-stale`
  refusal stays in force with its existing tests unedited (P-01), the no-lineage
  launch is unchanged (P-03), and wiring `recoveryDispatchRefusal` into dispatch
  is named as a non-goal rather than left ambiguous.
- Scale looks like one session: one new export, one call site, one spawned
  `runPipeline` scenario with a written justification for why it must be spawned,
  and the rest unit-level.

## What has to change before this can lock

**The malformed-locator guard admits a restore into the repository root.**
`publishAcceptedPairSnapshot` builds the locator as
`relative(repoRoot, join(sliceDir, "recovery-snapshots", attemptId))`
(`src/preserve-work-recovery.ts:519-520,569`), so a well-formed locator always
carries at least three forward-slash segments with `recovery-snapshots` as the
penultimate one. B-03 rejects only locators with "fewer than two path segments".
A two-segment locator (`recovery-snapshots/<attemptId>`) passes that guard, its
grandparent is the empty string, and the derived slice directory collapses to
`repoRoot` — so the accepted pair would be rewritten at the repository root.
B-07's "only the two accepted-pair files and the run-state file change" would
not catch it, because those *are* two accepted-pair files. State the guard in
terms of the locator's real shape, and let B-03's manifest scenario exercise a
locator rejected for the derived-destination reason, not just a single-segment
one.

**B-02 locks only one of its two append branches.** The contract obligation for
B-02 covers both `ROLLED_BACK` on a verified restore and `ROLLBACK_FAILED`
carrying `rollbackError` and the observed fingerprints otherwise. The manifest
scenario for B-02 binds the success append plus a case where *nothing* is
appended; the failing-restore append that writes the ROLLBACK_FAILED-only
fields (`src/run-state.ts:284-341`) appears only in the prose test plan, which
no gate reaches. Since `acceptance:behaviors` selects tests by behavior id, an
implementation that never appends a `ROLLBACK_FAILED`, or appends one without
those fields, would satisfy every declared observable. Bind that branch to
B-02's observable result or to its own behavior id.

## Worth answering, not blocking

B-05 promises each operator log line names "the retry the operator needs", and
every reported target now ends the launch unsuccessfully. That retry is clear
for the appended outcomes — relaunch, because P-03's terminal-lineage path then
runs normally. It is not defined for the outcomes that append nothing: a
`ROLLBACK_FAILED` whose retry fails again (B-06) and the malformed locator
(B-03). For those, no relaunch can move the lineage, so each future launch
reports the same target and stops. Say what the line should ask for there, or
say plainly that the hold is terminal until #335.

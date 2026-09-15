# Contract review — round 2 (recovery launch reconciliation, #334)

The revision resolves all three findings routed from round 1. What follows is
why each condition is met, plus one small wording point in B-05 that does not
block implementation.

## F-01 — malformed-locator guard (B-03)

Resolved. The old threshold ("fewer than two path segments") is gone, replaced
by the locator's real shape. B-03 now accepts a `snapshotPath` only as
`<sliceDir>/recovery-snapshots/<attemptId>`: at least three `/` segments, every
segment non-empty and neither `.` nor `..`, the penultimate segment equal to
`RECOVERY_SNAPSHOT_DIRNAME`, and therefore a non-empty derived `<sliceDir>`.
That is the same constant and the same construction `publishAcceptedPairSnapshot`
uses, and the contract cites both sites, so the guard is derived from the
producer rather than guessed.

The two-segment `recovery-snapshots/<attemptId>` case is now named explicitly
and for the right reason: its grandparent is the empty string, so the derived
destination collapses onto `repoRoot`. The manifest scenario binds that reason
observably — it plants a `contract.md` and `acceptance-manifest.json` of known
bytes at the repository root, sweeps four locators, then asserts the
repository-root pair is byte-identical afterwards and that each rejection
message names both the rejected locator and the derived destination that caused
it. A rejection that fired only on segment count would satisfy the count but not
the message assertion, which is what closes the original hole.

## F-02 — the failing-restore append branch (B-02)

Resolved. B-02's scenario now carries a second trailing-`PENDING` target whose
snapshot `contract.md` was deleted, so the restore must fail. Its `then` demands
exactly one appended `ROLLBACK_FAILED` for that same `attemptId` carrying the
restore failure message as `rollbackError` plus `observedContractFingerprint` and
`observedManifestFingerprint` read off disk, with an absent file recorded as the
explicit absent marker rather than a blank. The observableResult asserts all
three fields by name under `[behavior:#334:B-02]`, which is the name
`acceptance:behaviors` selects, so the three `ROLLBACK_FAILED`-only fields are
now ID-bound rather than living in prose. The contract-side statement, the test
plan bullet and a Definition-of-done bullet all carry the same
exactly-one-event obligation, and the `typecheck` gate was added to this
behavior's gate ids.

## F-03 — the named retry per outcome (B-05)

Resolved. B-05 now fixes the retry for each of the three outcome families
instead of leaving "the retry the operator needs" to the implementer: relaunch
for `ROLLED_BACK`; repair the named snapshot directory until its pair again
reads as a valid `LOCKED` pair matching the event's recorded fingerprints, then
relaunch, for a `ROLLBACK_FAILED` appended this launch; and for the
append-nothing outcomes, an explicit statement that the hold is intentionally
terminal until #335's completion path, naming the run-state file and the
`attemptId` and saying that a relaunch alone will report the same target and
stop again. That last branch is the one the finding asked for, and it is honest
about the limitation rather than promising a retry that cannot work. The
manifest asserts the outcome-specific content of each line.

## One remaining wording point (advisory, F-04)

B-05's `given` now says the fixture is "exercised once per reported outcome
family" while its `when` says "`runPipeline` is invoked once", and the contract's
test plan still justifies exactly one spawned launch on cost grounds. Since
B-05 already promises one log line per reported target, a single launch over all
four planted targets reaches every asserted observable, so the per-family
phrasing reads as three or four spawned pipeline runs where one would do. This
is a scenario-wording point only — nothing is left unbound — so it is worth
tightening whenever B-05 is next touched, not a reason to hold the slice.

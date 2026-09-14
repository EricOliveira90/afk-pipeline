# Handoff — Recovery rollback hold (#333)

## What shipped

- `B-01`: `src/preserve-work-recovery.ts:restoreAcceptedPairFromSnapshot` — resolves
  the snapshot directory from the attempt's recorded `snapshotPath` and rewrites
  both pair files from those bytes.
- `B-02`: same routine — rereads the two destination files and succeeds only when
  they are byte-equal to the snapshot copies, read back as a valid `LOCKED` pair
  through `readLockedAcceptedPair`, and fingerprint-equal to the `PENDING` event.
- `B-03`: `src/preserve-work-recovery.ts:rollBackRecoveryAttempt` — appends exactly
  one `ROLLED_BACK` event carrying the trailing event's `attemptId` inside a
  `transactRunState` body that reloaded, rechecked and admitted the transition
  through `isLegalRecoveryTransition`.
- `B-04`: same writer — returns `failure` by identity and imports no ref-mutating
  git helper.
- `B-05`: same writer — restores only `contract.md` and
  `acceptance-manifest.json`, neither of which is in the closed set
  `listLiveNegotiationFiles` reports.
- `B-06`: `src/preserve-work-recovery.ts:rollBackRecoveryAttempt` plus
  `src/run-state.ts:PersistedRecoveryLineageEvent.rollbackError` /
  `observedContractFingerprint` / `observedManifestFingerprint`,
  `src/run-state.ts:RECOVERY_FINGERPRINT_ABSENT` and the per-state branch in
  `src/run-state.ts:sanitizeRecoveryLineage`.
- `B-07`: `src/preserve-work-recovery.ts:recoveryDispatchRefusal`.
- `B-08`: `src/preserve-work-recovery.ts:rollbackableEvent` (accepts a trailing
  `ROLLBACK_FAILED`) and `nextRecoveryEvent` (copies `attemptId`, strips the three
  failure members), over the unedited `LEGAL_RECOVERY_TRANSITIONS`.
- `B-09`: `src/preserve-work-recovery.ts:rollBackRecoveryAttempt` calls
  `restoreAcceptedPairFromSnapshot` and copies its `message` and both observed
  fingerprints into the event verbatim.
- `P-01`: `src/preserve-work-recovery.test.ts` `[behavior:#333:P-01]`.
- `P-02`: `src/preserve-work-recovery.test.ts` `[behavior:#333:P-02]`.
- `P-03`: `src/preserve-work-recovery.test.ts` `[behavior:#333:P-03]`.
- `P-04`: `src/run-state.test.ts` `[behavior:#333:P-04]` (three `it`s).
- `P-05`: `src/preserve-work-recovery.test.ts` `[behavior:#333:P-05]`.

## Decisions made during implementation

- Verification order inside the restore routine is byte-equality → `LOCKED`
  validity → fingerprint compare. Fingerprints last is what makes the
  tampered-after-publication case fail on the fingerprint compare the contract
  names, while a snapshot that is no longer a `LOCKED` pair fails on validity;
  the reverse order would make the second case unreachable.
- Two refusal codes were added to `RecoveryRefusalCode`:
  `rollback-verification-failed` (restore-and-verify did not prove out, or the
  append was refused by the transition rule) and `rollback-failed-hold` (the
  dispatch refusal). `no-pending-attempt` is reused, with its doc comment widened,
  for "no unresolved attempt to roll back"; no other code or message changed.
- `rollBackRecoveryAttempt` is generic in the failure value (`F extends
  RecoveryFailure`) so the caller's own richer failure type comes back out
  unchanged by identity rather than being narrowed to `{trigger, message}`.
- A retry whose obstacle is still there appends nothing and returns
  `rollback-verification-failed`, because `ROLLBACK_FAILED -> ROLLBACK_FAILED` is
  not in the unedited transition map. The hold the first failure recorded stays in
  force instead of accumulating one event per attempt to clear it.
- An *unreadable* destination file (a directory in its place, a permission error)
  records `RECOVERY_FINGERPRINT_ABSENT`, the same marker an absent file gets: both
  mean "somebody looked and could not observe the bytes", which is the fact the
  hold exists to report.
- The `P-03` export enumeration is scoped to run-state export names matching
  `/recovery/i` rather than the module's whole export list, so a merge from
  another slice adding an unrelated export cannot redden this behavior.

## Gotchas / learnings

- `restoreAcceptedPairFromSnapshot` reads both snapshot files *before* it writes
  anything, so a missing snapshot half leaves the destination exactly as it was.
  #334's launch-time reconciliation can therefore call it on a reopened pair
  without risking a half-restore from an incomplete snapshot.
- A `ROLLED_BACK` event appended after a `ROLLBACK_FAILED` one must be built from
  the trailing event with the three failure members *stripped* — run state now
  rejects a non-`ROLLBACK_FAILED` event carrying any of them, and a rejection
  degrades the target's whole lineage list to absent, which would read as "no
  attempt was ever admitted".
- The rollback writer restores into `sliceDir` and appends one event; it does not
  clear the exact-stage checkpoint or the contract-finding lineage. After a
  verified rollback the target has an accepted pair again but the negotiation
  controls #332 cleared are still cleared — #334 decides what that means for a
  resumed run.
- `recoveryDispatchRefusal` keys on the *last* event only. A `ROLLBACK_FAILED`
  followed by a `ROLLED_BACK` for the same attempt is a cleared hold, not a
  permanent one.
- Test-fixture mechanics: an unwritable destination is reachable cross-platform by
  putting a directory where `contract.md` belongs (`writeFileSync` throws), and a
  tampered snapshot that still parses as a `LOCKED` pair is what isolates the
  fingerprint compare.
- `pnpm test:fast` emitted one `[vitest-worker]: Timeout calling "onTaskUpdate"`
  unhandled error alongside 2477 passing tests on this machine; it is a reporter
  RPC timeout under load, not a failing assertion.

# Slice Contract — Recovery rollback hold

**Parent PRD:** .kiro/specs/afk-preserved-work-renegotiation/prd.md
**GH issue:** #333
**Status:** LOCKED

**Lock-Provenance:** negotiation round 2
**Negotiation round:** 1

## Scope lock

This slice adds the two unsuccessful terminal outcomes of an admitted
preserved-work recovery attempt to `src/preserve-work-recovery.ts`, and nothing
else. One exported restore-and-verify routine rewrites both accepted-pair files
from the immutable snapshot the attempt's `PENDING` event names, rereads them,
and proves them byte-equal to the snapshot and equal to the original
fingerprints that event carries. One exported rollback writer calls that routine
for any admitted failure trigger — provider failure, evaluator non-acceptance,
deterministic validation refusal, lock-gate refusal, cancellation — and, under
the ADR 0056 run-state lock, appends `ROLLED_BACK` when verification proves out
or `ROLLBACK_FAILED` (carrying the failure message and the fingerprints observed
on disk) when it does not, returning the caller's original failure unchanged
either way. One exported predicate refuses agent dispatch fail-closed while an
attempt's last event is `ROLLBACK_FAILED`, naming the attempt and its snapshot.
No ref, worktree, orchestrator call site or existing refusal changes: the
launch-time retry that consumes the exported routine is #334, and #277's
entry-point refusal of `--renegotiate-stale` stays in force.

### In scope

- [behavior:B-01] `restoreAcceptedPairFromSnapshot` (new export,
  `src/preserve-work-recovery.ts`) restores `contract.md` and
  `acceptance-manifest.json` in the target's slice directory from the bytes at
  the `PENDING` event's `snapshotPath`, resolved from that recorded locator and
  never re-derived (`prd.md:141-142`, issue AC1, matching
  `executeRecoveryAttempt`'s existing locator rule,
  `src/preserve-work-recovery.ts:983-986`).
- [behavior:B-02] The same routine verifies by rereading the two restored
  destination files: it succeeds only when both are byte-identical to the
  snapshot copies **and** their SHA-256 fingerprints equal the `PENDING` event's
  `contractFingerprint`/`manifestFingerprint`, and only when the restored pair
  reads back as a valid `LOCKED` pair through the existing
  `readLockedAcceptedPair`. Verification is on the destination bytes, matching
  `publishAcceptedPairSnapshot` (`src/preserve-work-recovery.ts:527-541`) and
  ADR 0055's accepted-pair validation (`prd.md:141-142`, issue AC2).
- [behavior:B-03] `rollBackRecoveryAttempt` (new export) accepts the original
  failure as an opaque `{ trigger, message }` value covering provider failure,
  evaluator non-acceptance, deterministic validation refusal, lock-gate refusal
  and cancellation, runs B-01/B-02, and on success appends exactly one
  `ROLLED_BACK` event carrying the `attemptId` copied verbatim from the trailing
  `PENDING` event, inside a `transactRunState` body that
  reloaded state under the ADR 0056 lock, rechecked the trailing event, and
  admitted the transition through `isLegalRecoveryTransition`
  (`src/run-state.ts:1178-1189`, `prd.md:184-187`, issue AC1/AC2). `attemptId`
  is an existing required member of `PersistedRecoveryLineageEvent`
  (`src/run-state.ts:284-286`, "Opaque per-attempt identity; a retry never
  reuses one"), already required non-blank on every state by
  `sanitizeRecoveryLineage` (`src/run-state.ts:1120`) and copied forward on load
  (`src/run-state.ts:1144`); this slice adds no attempt-identity field and
  changes none of that validation.
- [behavior:B-04] `rollBackRecoveryAttempt` returns the caller's original
  failure value unchanged after a verified rollback, and invokes no git
  operation on any path — no import of `resolveCommit`, `countCommitsAhead`,
  `isAncestor` or any ref-moving helper is added, so no branch tip, commit or
  worktree state changes (ADR 0039, `src/preserve-work-recovery.ts:16-19`,
  issue AC3).
- [behavior:B-05] The rollback path restores the accepted pair only: it writes
  no live negotiation file that `executeRecoveryAttempt` cleared, and leaves
  every byte under the attempt's published `negotiation/` history untouched
  (`prd.md:171-175`, issue AC4). The disjointness this rests on is fixed by the
  closed list `RECOVERY_NEGOTIATION_FILENAMES`
  (`src/preserve-work-recovery.ts:828-834`: `context.md`,
  `contract-review.json`, `contract-response.json`,
  `contract-negotiation-outcome.json`, `planner-escalation.md`) plus every
  `feedback-r<N>.md` round, which is the whole set
  `listLiveNegotiationFiles` reports (`src/preserve-work-recovery.ts:847-860`):
  it contains neither `CONTRACT_FILENAME` nor `ACCEPTANCE_MANIFEST_FILENAME`, so
  restoring the pair into the same slice directory cannot re-add a live
  negotiation file.
- [behavior:B-06] When the restore or the verification fails,
  `rollBackRecoveryAttempt` appends exactly one `ROLLBACK_FAILED` event carrying
  the trailing `PENDING` event's `attemptId` verbatim (the existing required
  member at `src/run-state.ts:284-286`, validated at `:1120`), plus the failure
  message and the fingerprints observed on disk
  (absent file recorded as an explicit absent marker, not a blank), appends no
  `ROLLED_BACK`, and claims no rollback in its result (`prd.md:143-146`, issue
  AC5). The observed facts ride three new **optional** fields on
  `PersistedRecoveryLineageEvent` — `rollbackError`,
  `observedContractFingerprint`, `observedManifestFingerprint` — required
  non-blank by `sanitizeRecoveryLineage` only when `state` is
  `ROLLBACK_FAILED` and required absent otherwise. Planner decision, recorded
  here: purely additive optional fields with no `RUN_STATE_VERSION` bump,
  because a v7 file written by #277/#332 simply has neither and adapts in
  memory unchanged, the same precedent `specsDir` set
  (`src/run-state.ts:317-342`); the per-state check is what keeps existing
  events round-tripping through `sanitizeRecoveryLineage`'s
  all-fields-required gate (`src/run-state.ts:1119-1142`).
  Because that rule changes the validator's accepted input language, B-06 binds
  **both** halves of its regression surface, per ADR 0060
  (`docs/adr/0060-parser-contracts-declare-regression-surfaces.md`): the newly
  accepted input (a well-formed `ROLLBACK_FAILED` event round-tripping through
  save/load) *and* each newly rejected one, because a rule enforced in one
  direction only still passes every accepted-input test. The rejections are: a
  `ROLLBACK_FAILED` event missing or blanking any one of `rollbackError`,
  `observedContractFingerprint` or `observedManifestFingerprint`, and a
  `PENDING`, `ROLLED_BACK` or `COMPLETED` event carrying any one of the three.
  A rejection takes the pre-existing consequence unchanged — the target's whole
  event list degrades to absent (`src/run-state.ts:1140-1141,1160`) — so the
  per-state check adds branches to that gate, not a second failure mode.
- [behavior:B-07] `recoveryDispatchRefusal(state, ghIssue)` (new export) returns
  a refusal whose message names that event's `attemptId` and `snapshotPath` —
  both existing required members of `PersistedRecoveryLineageEvent`
  (`src/run-state.ts:284-286` and `:307-308`), so the refusal reads them off the
  event and derives nothing — whenever
  the target's last lineage event is `ROLLBACK_FAILED`, and `undefined`
  otherwise. It is exported for #334 to call; this slice wires it into no
  orchestrator or dispatch call site (`prd.md:146`, issue AC6 and the issue's
  "wires no orchestrator call site").
- [behavior:B-08] Calling `rollBackRecoveryAttempt` again for an attempt whose
  last event is `ROLLBACK_FAILED` restores and verifies from the same snapshot
  and may append `ROLLED_BACK` carrying that same event's `attemptId`
  (`src/run-state.ts:284-286`, whose doc comment already fixes the rule this
  behavior relies on: "Every terminal event is a *new* record citing the same
  `attemptId`; nothing edits or deletes an earlier one, so a retry is always a
  fresh attempt ID", `src/run-state.ts:269-277`); every other outbound
  transition from `ROLLBACK_FAILED` is refused, no path appends a second
  `PENDING` for an existing attempt, and no existing event is edited or deleted
  (`prd.md:130,148`, issue AC7/AC8).
- [behavior:B-09] `restoreAcceptedPairFromSnapshot` is the single exported
  implementation of restore-and-verify: `rollBackRecoveryAttempt` calls it
  rather than duplicating the compare, so #334's launch-time reconciliation has
  exactly one routine to call (issue AC9). Observed behaviourally rather than by
  reading source text: one induced restore obstacle produces the same failure
  identity through both entry points — the direct call's failure value and the
  `ROLLBACK_FAILED` event's `rollbackError` carry the same message and the same
  observed fingerprints — which a second, independent compare inside the writer
  could not keep true.

### Non-goals (explicit out-of-scope)

- Launch-time reconciliation of an unresolved attempt before ordinary resume,
  and any call site that invokes these routines during a run (#334).
- The `COMPLETED` terminal event, the pre-dispatch fingerprint check, replay
  identity and attempt-state reporting (#335).
- Removing #277's entry-point refusal of `--renegotiate-stale`, or making any
  recovery path reachable from a live run.
- `--extend-scope` and any persisted-scope mutation (#278).
- Restoring live negotiation artifacts, or altering what `executeRecoveryAttempt`
  copies, deletes or clears (#332).
- Any orchestrator, `src/wave.ts`, gate-catalog or CLI change.

### Existing behavior to preserve

- [behavior:P-01] `src/preserve-work-recovery.ts` invokes no merge, reset,
  rebase or other ref mutation on any path, including every refusal path
  (ADR 0039, `src/preserve-work-recovery.ts:16-19`).
- [behavior:P-02] `executeRecoveryAttempt` keeps its current outcome unchanged:
  the published `negotiation/` history, the deletion of exactly the copied live
  files, and the cleared exact-stage checkpoint and contract-finding lineage
  (`src/preserve-work-recovery.ts:968-1060`).
- [behavior:P-03] `appendRecoveryLineageEvent` stays append-only and stays
  callable only from inside a `transactRunState` body; no `repoRoot`-shaped
  convenience writer is added (`src/run-state.ts:1178-1200`).
- [behavior:P-04] `sanitizeRecoveryLineage` still drops a target's whole event
  list when any event is malformed, and still loads every `PENDING` event
  written by #277 unchanged (`src/run-state.ts:1093-1164`). Preservation here is
  two-sided and both sides are bound: a `PENDING`-only lineage with none of the
  three new fields present still loads (the accepted-input side), and a
  `PENDING`/`ROLLED_BACK`/`COMPLETED` event that *does* carry one of them is
  newly rejected under B-06's "required absent otherwise" — so the per-state
  rule cannot ship enforced in the `ROLLBACK_FAILED` direction only while this
  behavior still reads green.
- [behavior:P-05] `readLockedAcceptedPair`, `publishAcceptedPairSnapshot`,
  `admitStaleRenegotiation`, `hasOpenRecoveryAttempt` and
  `isLegalRecoveryTransition` keep their current signatures and results; the
  legal-transition map is not edited, because it already encodes
  `PENDING -> {ROLLED_BACK, ROLLBACK_FAILED}` and
  `ROLLBACK_FAILED -> ROLLED_BACK` (`src/preserve-work-recovery.ts:230-264`,
  `prd.md:126-131`).

### Changes to existing behavior (only if the issue asks for it)

- `PersistedRecoveryLineageEvent` gains three optional fields and
  `sanitizeRecoveryLineage` gains the per-state validation described in B-06.
  Authorized by issue AC5 ("carrying the failure message and the fingerprints
  observed on disk") and `prd.md:143`; additive only, and no already-persisted
  document changes meaning.

## Files expected to change

- src/preserve-work-recovery.ts
- src/preserve-work-recovery.test.ts
- src/run-state.ts
- src/run-state.test.ts
- ARCHITECTURE.md

## Migration requirements

- New migration files: 0

## New patterns / deps / schema (if any)

- Three optional persisted fields on `PersistedRecoveryLineageEvent`
  (`rollbackError`, `observedContractFingerprint`,
  `observedManifestFingerprint`), validated per lineage state in both
  directions — required non-blank on `ROLLBACK_FAILED`, required absent on every
  other state, each direction bound by its own rejected input per ADR 0060 (see
  B-06). No `RUN_STATE_VERSION` bump. No attempt-identity field is added:
  `attemptId` is already a required member of
  `PersistedRecoveryLineageEvent` (`src/run-state.ts:284-286`) and already
  validated non-blank for every state (`src/run-state.ts:1120`), so the four
  behaviors that name it cite it rather than introduce it. No new dependency.

## Test plan

- Given an admitted `PENDING` attempt whose accepted pair was reopened and
  overwritten, when `restoreAcceptedPairFromSnapshot` is called directly for that
  attempt, then both slice-directory pair files are byte-identical to the
  snapshot copies and the routine reports success — no failure trigger is
  swept here, because the routine takes none (B-01).
- Given that same admitted attempt, when `rollBackRecoveryAttempt` runs once for
  each of the five failure triggers — provider failure, evaluator
  non-acceptance, deterministic validation refusal, lock-gate refusal,
  cancellation — then each run ends the target's lineage on exactly one
  `ROLLED_BACK` event whose `attemptId` equals the trailing `PENDING` event's
  (B-03).
- Given a snapshot whose `contract.md` was tampered with after publication,
  when the routine restores and verifies, then verification fails on the
  fingerprint compare against the `PENDING` event and no `ROLLED_BACK` is
  appended (B-02).
- Given a successful rollback, when the caller inspects the result, then it
  carries the original failure value unchanged, and the slice branch head,
  feature branch head and worktree status recorded before the call are
  identical afterwards (B-04).
- Given an executed attempt (live negotiation files cleared, history
  published), when a rollback succeeds, then `listLiveNegotiationFiles` still
  returns empty and a digest of the published `negotiation/` directory is
  unchanged — and, so the emptiness is not vacuous, the same test asserts
  neither restored pair filename is a member of
  `RECOVERY_NEGOTIATION_FILENAMES` and neither matches the
  `feedback-r<N>.md` round pattern (B-05).
- Given a forced restore failure (unwritable destination or a snapshot file
  removed), when `rollBackRecoveryAttempt` runs, then lineage ends on one
  `ROLLBACK_FAILED` event carrying the failure message and the observed
  fingerprints, no `ROLLED_BACK` exists for the attempt, and the event
  round-trips through save/load (B-06).
- Given a persisted `ROLLBACK_FAILED` event that is missing `rollbackError`,
  and again with it present but blank, and again for each of
  `observedContractFingerprint` and `observedManifestFingerprint`, when the
  state file is loaded, then `sanitizeRecoveryLineage` rejects the event and the
  target's whole lineage list reads as absent — the first newly rejected input
  (B-06, `src/run-state.test.ts`).
- Given a persisted `PENDING` event that carries `rollbackError`, and again a
  `ROLLED_BACK` event that carries `observedContractFingerprint`, when the state
  file is loaded, then `sanitizeRecoveryLineage` rejects the event and the
  target's whole lineage list reads as absent — the second newly rejected input,
  the "required absent otherwise" direction (B-06, P-04,
  `src/run-state.test.ts`).
- Given a `PENDING`-only lineage written in the #277 shape with none of the
  three new fields present, when the state file is loaded, then the event loads
  unchanged field for field and the existing `sanitizeRecoveryLineage` tests
  pass unmodified (P-04, `src/run-state.test.ts`).
- Given lineage ending on `ROLLBACK_FAILED`, when `recoveryDispatchRefusal` is
  called, then it returns a refusal naming the `attemptId` and `snapshotPath`;
  given lineage ending on `PENDING`, `ROLLED_BACK` or `COMPLETED`, then it
  returns `undefined` (B-07).
- Given a `ROLLBACK_FAILED` attempt whose restore obstacle is removed, when
  rollback runs again against the same snapshot, then `ROLLED_BACK` is appended
  for the same `attemptId`, every earlier event is still present byte-for-byte,
  and a fresh admission after that produces a different `attemptId` and a
  different snapshot directory (B-08).
- Given one induced restore obstacle (the same snapshot file removed), when the
  obstacle is met first through a direct `restoreAcceptedPairFromSnapshot` call
  and then through `rollBackRecoveryAttempt`, then the direct call's failure
  message and observed fingerprints equal the `ROLLBACK_FAILED` event's
  `rollbackError`, `observedContractFingerprint` and
  `observedManifestFingerprint` — no source text is inspected (B-09).
- Tests extend `src/preserve-work-recovery.test.ts`, which is the existing
  negotiation fixture for this module's exported seams, and
  `src/run-state.test.ts` for the persisted-shape round trip. No spawned
  pipeline scenario is added — restore-and-verify, lineage append and dispatch
  refusal are filesystem and run-state operations fully reachable through the
  exported seams — and a comment in the test file says so (`prd.md:244-256`,
  ADR 0063, issue AC11).

## Definition of done

- [ ] `pnpm run typecheck` passes.
- [ ] Every in-scope behavior above has at least one `it` named
  `[behavior:#333:B-0N]`, **and every preservation behavior has at least one `it`
  named `[behavior:#333:P-0N]`** — because the acceptance gate selects by
  `--testNamePattern {behaviorId}`, a `P-0N` entry with no test of its own
  selects zero tests and reports a vacuous pass. A `P-0N` test may assert against
  an existing `[behavior:#332:B-0N]` / `[behavior:#277:B-0N]` fact, but it must
  carry its own `[behavior:#333:P-0N]` name to be selectable. All of
  `src/preserve-work-recovery.test.ts` and `src/run-state.test.ts` pass.
- [ ] `restoreAcceptedPairFromSnapshot`, `rollBackRecoveryAttempt` and
  `recoveryDispatchRefusal` are exported from
  `src/preserve-work-recovery.ts`, and no other module imports them yet.
- [ ] `src/preserve-work-recovery.ts` imports no ref-mutating git helper, and
  no orchestrator, wave or CLI file appears in the diff.
- [ ] `git diff` shows no removal of #277's `--renegotiate-stale` entry-point
  refusal and no edit to `LEGAL_RECOVERY_TRANSITIONS`.
- [ ] The `PersistedRecoveryLineageEvent` additions are optional, documented
  with the per-state validation rule, and `RUN_STATE_VERSION` is unchanged.
- [ ] The `Preserved-work recovery` row in ARCHITECTURE.md names #333 and its
  two terminal outcomes.

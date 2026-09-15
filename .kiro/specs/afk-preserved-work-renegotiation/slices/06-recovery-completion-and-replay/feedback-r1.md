# Contract review — round 1 (recovery completion and replay, #335)

## What the second cut fixed

The scope narrowing landed in both halves this time. The manifest's behaviors are
now B-01..B-05, B-10, B-11, B-12 and the five preservation behaviors, and its
`fileScope` lists the same seven paths the contract lists — including
`src/run-state.test.ts`, which B-12 needs. Every in-scope behavior now writes
only inside that scope, and the two preservation behaviors that used to demand
edits outside it (P-04, P-05) assert the absence of those edits instead. That
retires the self-contradiction where the acceptance-behaviors gate was
unsatisfiable inside the declared file scope, and with it the four-body scope
that was too large for one session.

The launch-wiring obligations went with it. Nothing in the pair now asserts a
single "seam where the replacement pair reaches LOCKED"; B-04 states the
opposite and anchors it — `recoveryPreDispatchRefusal` is exported and wired
nowhere, with `src/wave.ts:536`'s single `runSliceExecute(ctx)` call named as
#336's work, exactly the shape #333 used for `recoveryDispatchRefusal`
(`src/preserve-work-recovery.ts:1468`). The unbounded repository-wide text
search is gone; the surviving source-text assertions each name one owned file
and the concrete literal they expect absent, matching the module's existing
`MODULE_SOURCE` assertions (`src/preserve-work-recovery.test.ts:1590`). The
reporting surface — including the unresolved question of how `foldEvents` is
invoked — travels to #336 with `src/run-snapshot.ts` and `src/status.ts` out of
scope; that question should be the first thing #336's contract confirms.

The decisions the contract makes in place of the explorer's unknowns all hold up
against the tree. Injecting the lock gate and the provenance stamp rather than
importing `src/contract-transaction.ts` or `src/artifacts.ts` follows the
module's own `RecoveryGitProbes` seam and its recorded reason for hand-matching
`**Status:** LOCKED`. Persisting provenance as one opaque non-blank string keeps
the review-rails vocabulary out of this module. The three `COMPLETED`-only
fields sit on the `ROLLBACK_FAILURE_FIELDS` precedent (`src/run-state.ts:356`,
rationale at `:318-326`) and are read by B-04, B-05 and B-10, so they are not
decoration. `readLockedAcceptedPair` already returns both fingerprints, so
B-04's drift check is writable inside the owned module. And the end-to-end
fixture the contract names is real: `makeRecoveryExecutionFixture` in
`src/resume-integration.fixtures.ts:462-650` plants a `PENDING`
`recoveryLineage` entry with both fingerprints, so the `PENDING -> COMPLETED`
path can be driven through exported seams with no spawned pipeline.

## What still needs a change

**The completion-CAS-lost failure path (B-03) cannot produce the observable it
promises.** `rollBackRecoveryAttempt` takes no `attemptId`. It reloads run state
itself and acts on whatever `rollbackableEvent` returns
(`src/preserve-work-recovery.ts:1369-1390`, predicate `:1293-1302`), rechecking
only that the *trailing* event is unchanged (`:1412-1422`). B-03's given
includes the case where "the trailing event ... changed", and in that case:

- if the trailing event became `ROLLED_BACK` or `COMPLETED`, the writer refuses
  `no-pending-attempt` and appends nothing (`:1377-1384`), so the asserted
  "trailing event is the `ROLLED_BACK` or `ROLLBACK_FAILED` one
  `rollBackRecoveryAttempt` appends" is false;
- if a different attempt was admitted in the gap — reachable, since after
  `ROLLED_BACK` `hasOpenRecoveryAttempt` is false (`:577-583`) — the writer
  restores *that* attempt's snapshot over the live pair and appends
  `ROLLED_BACK` for it, a write against an attempt this completion call never
  admitted.

Only the scope-fingerprint flavor, where this attempt is still the trailing
`PENDING` event, satisfies B-03 as written — and the test plan's third bullet
aims at the other flavor. Editing the writer is not the way out: P-02 pins it.
Split the two shapes in the contract and the manifest: scope-fingerprint drift
with the attempt still trailing delegates to `rollBackRecoveryAttempt` with
`completion-cas-lost`; a recheck lost because the trailing event is no longer
this attempt's `PENDING` event appends nothing and calls no rollback (or the
writer's own `no-pending-attempt` refusal is named as the ending). State the
observable per shape, and rule out any path where completion rolls back an
`attemptId` it did not admit.

**Smaller, non-blocking:** B-01 says completion "refuses before any write", but
B-03 routes both precondition refusals through the rollback writer, which
restores the pair and appends a lineage event (`:1386-1443`). B-01's observable
checks only the refusal code and the gate call, so either reading passes.
Saying "appends no `COMPLETED` event" instead, and stating that a failed
precondition ends the attempt rather than leaving it `PENDING`, removes the
guess.

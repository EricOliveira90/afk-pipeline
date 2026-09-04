# One cross-process lock per run-state file

## Context

Every run-state writer rewrites the whole `.afk/state/<run-slug>.json` file.
ADR 0018 proved only that synchronous writers cannot interleave on one Node
event loop. A pipeline process and an operator command can still both read the
same generation, write different mutations, and silently discard one.

`afk adopt` makes that race unsafe: it observes a slice record, spends minutes
verifying a candidate, and may only replace that exact record. An unlocked
read-check-write can overwrite a park created by another process.

## Decision

Each run-state file has one sibling lock directory. Every writer acquires it
before loading state and releases it after the comparison, mutation, and
whole-file commit:

- `saveSliceState`
- `saveRunState`
- `saveReviewPhase`
- `recordRetryDecision`
- `clearSliceStateForDispatch`
- the convergence, checkpoint, migration-claim, and non-progress updates that
  formerly composed `loadRunState` with `saveRunState`
- conditional adoption state finalization

The lock is synchronous because the protected operations are synchronous. It
uses atomic directory creation, records a PID and unique owner token, and
times out rather than writing without exclusion.

Stale recovery is part of the protocol. A contender may remove a lock only
after proving its owner process no longer exists. Recovery itself holds a
second atomic reaper directory; new acquirers wait while it exists, closing
the race where one contender removes a stale lock after another process has
already replaced it. A newly created lock with incomplete owner metadata gets
a grace period for the directory-to-owner-record initialization window.

Release checks the owner token before removal, so an old owner never removes a
successor's lock.

## Consequences

- Cross-process run-state updates serialize as one load → compare/mutate →
  commit transaction, so whole-file rewrites cannot lose unrelated mutations.
- `saveSliceStateIfUnchanged` can honestly compare the observed slice record
  and commit its replacement inside the same lock.
- A process killed while holding the lock does not wedge the next run; the
  next writer reclaims the dead owner's lock.
- A live owner that exceeds the wait bound causes a named write failure. AFK
  fails closed instead of bypassing the lock.
- The JSON state schema does not change. Lock and reaper directories are
  transient siblings of the state file.

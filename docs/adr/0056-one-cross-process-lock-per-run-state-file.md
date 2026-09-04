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

Each run-state file has one sibling lock path. Every writer acquires it
before loading state and releases it after the comparison, mutation, and
whole-file commit:

- `saveSliceState`
- `saveRunState` (creation only; it refuses to replace an existing file from
  a potentially stale whole-file snapshot)
- `saveReviewPhase`
- `recordRetryDecision`
- `clearSliceStateForDispatch`
- the convergence, checkpoint, migration-claim, and non-progress updates that
  formerly composed `loadRunState` with `saveRunState`
- conditional adoption state finalization

The lock is synchronous because the protected operations are synchronous. An
acquirer writes its PID, unique owner token, and acquisition time to a unique
pending file, then atomically hard-links that complete record to the lock
path. Link creation is the exclusion primitive: it succeeds only when the
lock path is absent. The pending name is then removed. Other processes
therefore see either no lock or a complete owner record, never an
initialization window with incomplete metadata. The writer times out rather
than writing without exclusion.

Stale recovery is part of the protocol. A contender may quarantine a lock only
after proving its owner process no longer exists. It atomically renames that
dead lock to a reaper path before removing it; new acquirers yield while
the quarantine exists, closing the race where one contender removes a stale
lock after another process has already replaced it. The reaper path can
never contain a live owner, so another process may safely remove it if the
reaper is killed.

A process killed before atomic publication can leave only an unreferenced
pending file, which does not exclude another writer. A process killed after
publication leaves a complete owner record whose dead PID can be proved and
reaped. Missing or malformed ownership at the lock path is therefore not a
state this protocol creates; it is treated as corruption and fails closed
instead of guessing that an unknown owner is dead. Complete lock directories
from the pre-publication implementation remain readable and recoverable.

Release checks the owner token before removal, so an old owner never removes a
successor's lock.

## Consequences

- Cross-process run-state updates serialize as one load → compare/mutate →
  commit transaction, so whole-file rewrites cannot lose unrelated mutations.
- The former unrestricted whole-state replacement API is create-only. Existing
  state must be changed through a focused transaction that re-reads under the
  lock.
- `saveSliceStateIfUnchanged` can honestly compare the observed slice record
  and commit its replacement inside the same lock.
- A process killed while holding the lock does not wedge the next run; the
  next writer reclaims the dead owner's lock.
- A live owner that exceeds the wait bound causes a named write failure. AFK
  fails closed instead of bypassing the lock.
- Locking itself adds no persisted lock fields: lock, pending, and reaper
  paths are transient siblings of the state file. This prerequisite also restores
  adoption provenance, so run state advances to schema v3; older files are
  upgraded in memory and on their next focused write.

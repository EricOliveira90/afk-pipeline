# Intent: PRD 9 preserve-work contract renegotiation

**Status:** approved for specification.
**Written:** 2026-09-12.
**Motivation:** PRD 5 recovery required hand-editing negotiation artifacts and
moving run state aside after a slice was split, even though its worktree held
valuable commits.

## Problem

AFK can resume a preserved slice branch, but resume trusts its existing locked
slice contract. It can revise a locked contract after narrow gate evidence, but
that path is not an operator recovery transition and cannot extend the
persisted scope of record. A stale lock therefore leaves maintainers choosing
between destructive restart and unsupported artifact/state surgery.

## Outcome

Add one explicit preserve-work renegotiation transition:

- `--renegotiate-stale <slice|ghIssue>` names exactly one existing scoped
  slice.
- `--recovery-reason <text>` is required and recorded.
- `--extend-scope <slice|ghIssue>[,...]` is optional, additive-only, and valid
  only with `--renegotiate-stale`.

The transition never merges, resets, rebases or otherwise changes the slice
branch or feature branch.
Admission requires a clean registered preserved worktree whose slice branch
already contains the current feature-branch head and still has commits ahead
of it.

AFK performs eligibility checks read-only, then creates and validates an
immutable snapshot of the accepted contract pair. The first admitted mutation
is a write-ahead `PENDING` recovery record that references that snapshot and
the original fingerprints. Only then may AFK reopen the pair and rerun explorer
plus full contract negotiation. No generator may run while an attempt is
pending or while the current pair differs from the pair certified by completed
lineage.

An admitted attempt ends in one of three ways:

- `COMPLETED` after a replacement lock succeeds and one atomic run-state write
  both completes the attempt and admits the entire optional scope-extension
  set;
- `ROLLED_BACK` only after the prior pair has been restored and verified
  byte-for-byte; or
- `ROLLBACK_FAILED`, a fail-closed state that blocks all dispatch until a later
  launch restores and verifies the pair.

A retry is a new attempt. A launch that finds an unresolved attempt reconciles
it before ordinary resume. Proposed scope additions live only in the pending
record until completion, so a crash cannot make them executable scope.

## Constraints

- Preserve ADR 0039's rule: only `--force-restart` may discard unmerged
  commits.
- Reuse ADR 0055's validation, lock gate and provenance, but do not rely on its
  process-local rollback snapshot for crash recovery.
- Do not broaden focused scope revision; this is a separate explicit operator
  transition.
- Persisted scope extension is additive and committed with recovery completion
  under the ADR 0056 run-state lock.
- Historical PASS identities, resume counters and prior artifacts remain
  lineage; they are not deleted or reassigned.
- No AFK launch is part of this PRD authoring work.

## Out of scope

- Automatic stale-contract detection.
- Multiple renegotiation targets in one invocation.
- Automatic feature-branch merging or merge-conflict resolution.
- Removing, renumbering or replacing identities in the scope of record.
- Editing a slice contract by hand, destructive restart, adoption, or
  `clean-failed`.

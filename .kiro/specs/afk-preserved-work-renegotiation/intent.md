# Intent: Preserve-work contract renegotiation

**Status:** approved for specification.
**Written:** 2026-09-12.
**Motivation:** PRD 5 recovery required hand-editing negotiation artifacts and
moving run state aside after a slice was split, even though its worktree held
valuable commits.

## Problem

AFK can resume a preserved slice branch, but resume trusts the existing locked
slice contract. It can also revise a locked contract after narrow gate evidence,
but that path is not an operator recovery transition and cannot extend the
persisted scope of record. A stale lock therefore leaves maintainers choosing
between destructive restart and unsupported artifact/state surgery.

## Outcome

Add one explicit preserve-work renegotiation transition:

- `--renegotiate-stale <slice|ghIssue>[,...]` names existing scoped slices.
- `--recovery-reason <text>` is required and recorded.
- `--extend-scope <slice|ghIssue>[,...]` is optional, additive-only, and valid
  only with `--renegotiate-stale`.

The transition preserves the slice branch, registered worktree, commits,
resume counters and historical artifacts. Before reopening the lock it must
refresh the slice branch from the current feature branch, refuse without
mutation on conflict, capture branch-aware planning facts, and archive the
accepted contract pair. It then reruns exploration and full contract
negotiation; no generator may run until a replacement lock is accepted and
mechanically gated.

If a stale slice was split, `--extend-scope` may add AFK slices already
declared by current `issues.md` and allowed by current `afk.json`. It never
removes or rewrites an existing scope identity. Every added slice's blockers
must already be in the scope of record or be added by the same action.

The run state keeps append-only lineage for the operator action, reason,
target and added identities, branch/head/base facts, prior and replacement
lock fingerprints, and pending/completed/refused outcome. A crash or failed
negotiation leaves the transition pending, so the next launch retries
renegotiation instead of consuming the stale lock.

## Constraints

- Preserve ADR 0039's rule: only `--force-restart` may discard unmerged
  commits.
- Reuse ADR 0055's accepted-pair transaction and lock gate.
- Do not broaden focused scope revision; this is a separate, explicit
  operator transition.
- Persisted scope extension is additive and compare-and-swapped under the
  run-state lock.
- Historical PASS identities and prior artifacts remain lineage; they are not
  deleted or reassigned.
- No AFK launch is part of this PRD authoring work.

## Out of scope

- Automatic stale-contract detection.
- Removing, renumbering or replacing identities in the scope of record.
- Resolving feature-branch merge conflicts.
- Editing a slice contract by hand, destructive restart, adoption, or
  `clean-failed`.

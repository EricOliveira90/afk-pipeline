# PRD 9: Preserve-work contract renegotiation

**GH issue:** #276.
**Slice issues:** #277 (preserve-work renegotiation), #278 (additive
split-scope extension, blocked by #277).
**Parent design:** `intent.md` in this directory and
`docs/specs/afk-v2-plan.md` PRD 9.
**Binding decisions:** ADR 0018 (run state), ADR 0039 (never destroy unmerged
commits), ADRs 0050–0051 (focused scope revision bounds and rollback), ADR
0055 (accepted-pair transaction and lock provenance), ADR 0056 (run-state
lock), and ADR 0062 (contract revision lineage).

## Problem Statement

AFK can preserve commits or refresh a contract, but it has no supported
transition that does both. When a locked slice contract becomes stale after
work has landed, maintainers must currently edit artifacts and run state by
hand. A re-slice adds a second gap: the persisted scope of record correctly
rejects silent growth, but offers no explicit, recorded way to add the new
slice identity.

## Solution

Add one operator-authorized transition to the normal pipeline launch:

```text
--renegotiate-stale <slice|ghIssue>[,...]>
--recovery-reason <text>
[--extend-scope <slice|ghIssue>[,...]>]
```

The transition keeps the existing slice branch, worktree and commits; refreshes
the branch against the current feature branch; archives and reopens the stale
accepted contract pair through the shared contract transaction; reruns explorer
fact collection and full planner/evaluator negotiation; and records durable
lineage before generation can resume. `--extend-scope` is accepted only as part
of this transition and adds declared slice identities without removing or
rewriting the existing scope of record.

## User Stories

1. As a run operator, I want to renegotiate a stale locked contract without
   resetting its branch, so that landed work survives recovery.
2. As a planner, I want fresh issue, branch, base, changed-file and commit facts,
   so that the replacement contract describes the worktree that actually exists.
3. As a run operator, I want a failed refresh or negotiation to preserve the
   prior lock and all commits, so that recovery is retryable.
4. As a maintainer, I want the old and replacement locks linked in durable run
   lineage, so that later sessions can explain why generation resumed.
5. As a run operator, I want to add newly split slices to the scope of record
   only through an explicit recorded action, so that a changed `issues.md`
   cannot silently grow a run.
6. As a run operator, I want dependency-invalid or manifest-disallowed
   additions refused before state changes, so that the extended run remains
   schedulable and intentional.

## Implementation Decisions

- The flags are available on all three pipeline entry points. A recovery reason
  is mandatory. `--extend-scope` without `--renegotiate-stale` is refused.
- Every renegotiation target must already be in the persisted scope, have a
  registered worktree on its recorded slice branch, contain commits ahead of
  the feature branch, and hold a locked accepted pair. The action refuses
  before mutation when any fact is false.
- Refresh merges the current feature branch into the preserved slice branch.
  A conflict is aborted and reported; AFK neither resolves it nor reopens the
  lock.
- The accepted pair is archived before mutation. ADR 0055's transaction owns
  reopen, validation, lock gate, provenance and byte-for-byte rollback.
- Renegotiation always reruns the explorer and ordinary planner/evaluator
  protocol against the refreshed worktree. Exact-stage resume may not skip it.
  Implementation-round and resume-attempt history remains attached to the tree.
- Preflight eligibility and request validation happen before mutation; a
  refusal there creates no lineage entry. After admission, a pending recovery
  record prevents the stale lock from reaching a generator. Process death or
  a failed negotiation with byte-for-byte rollback leaves it pending and
  safely retryable. Acceptance completes it with the replacement lock
  fingerprint and provenance. `refused` is terminal and is written only when a
  deterministic post-admission guard rejects an already-recorded transition
  after rollback, so replaying the identical request cannot make progress.
- The lineage record is append-only and versioned. It records the reason,
  target and added slice identities, provider, branch, pre-refresh head,
  refreshed head, feature-base head, prior lock fingerprint, replacement lock
  fingerprint when available, and outcome. Status and run summary render it.
- Scope extension is compare-and-swapped under the run-state lock. It may add
  only AFK slices present in current `issues.md`, allowed by current `afk.json`,
  absent from the current scope, and whose blockers are already scoped or are
  added in the same action. Existing scope entries, PASS records, migration
  claims and review history are preserved.
- The absent-from-scope rule applies to a new extension. Repeating a completed
  action is an idempotent no-op only when the renegotiation targets, recovery
  reason and complete extension identity set exactly match its completed
  lineage entry, and every requested addition is already scoped by that entry.
  Partial overlap or any different target, reason or identity set is refused
  and names the existing lineage entry.
- Scope extension is additive even when the product change is described as a
  split. The original identity remains historical lineage; the operator edits
  `issues.md`, `afk.json` and issue dependencies before invoking the transition.

## Testing Decisions

- Prefer pure tests for flag compatibility, recovery eligibility, additive
  scope validation, compare-and-swap behavior, and lineage sanitization.
- Extend an existing resume/negotiation spawned fixture to prove commits survive,
  branch facts refresh, the stale lock cannot reach generation, rollback is
  byte-identical, and a successful replacement lock resumes generation.
- Extend an existing scope fixture to prove a newly declared dependent slice is
  admitted only by the explicit action and schedules after its blocker. Do not
  add a new pipeline scenario unless no existing fixture can reach the state.
- Verify status and summary from the persisted recovery record, not by parsing
  prose logs.

## Out of Scope

- Automatic detection or automatic scope growth.
- Removing or replacing persisted scope identities.
- Merge-conflict resolution, destructive restart, adoption, or cleanup.
- Generalizing focused scope revision beyond its gate-evidenced purpose.
- Launching AFK as part of this PRD.

## Further Notes

This is a recovery follow-up to PRD 5, but it is pipeline infrastructure and
does not depend on the cleaner implementation. The design deliberately exposes
one transition rather than separate “reopen contract” and “edit run scope”
escape hatches.

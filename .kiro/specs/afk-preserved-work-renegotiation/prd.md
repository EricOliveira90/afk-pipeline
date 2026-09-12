# PRD 9: Preserve-work contract renegotiation

**GH issue:** #276.
**Slice issues:** #277 (recovery state machine), #278 (atomic additive
split-scope extension, blocked by #277).
**Parent design:** `intent.md` in this directory and
`docs/specs/afk-v2-plan.md` PRD 9.
**Binding decisions:** ADR 0018 (run state), ADR 0039 (never destroy unmerged
commits), ADRs 0050–0051 (focused revision bounds and rollback), ADR 0055
(accepted-pair validation, lock gate and provenance), ADR 0056 (run-state
lock), and ADR 0062 (contract revision lineage).

## Problem Statement

AFK has no supported transition that both preserves landed slice work and
replaces a stale locked contract. A re-slice adds a second gap: persisted scope
correctly rejects silent growth, but offers no explicit atomic way to admit the
new identities only after recovery succeeds.

## Interface

All three pipeline entry points add:

```text
--renegotiate-stale <slice|ghIssue>
--recovery-reason <text>
[--extend-scope <selector-list>]
```

`--renegotiate-stale` accepts exactly one selector. A list, duplicate selector
or second occurrence is refused. `--recovery-reason` must be non-blank.
`<selector-list>` is one or more comma-separated slice or GitHub-issue
selectors. `--extend-scope` is valid only with the other two flags; its members
form one atomic, duplicate-free set.

## Admission Protocol

AFK performs these steps before ordinary resume and before any agent dispatch.

1. Under read-only checks, resolve the target and optional additions against
   current `issues.md`, `afk.json` and persisted run state. The target must be
   in the scope of record, have a registered worktree at the recorded slice
   branch, have a clean worktree, have commits ahead of the feature branch, and
   hold a valid locked accepted pair. The slice branch must already contain
   the exact current feature-branch head. AFK does not merge, reset or rebase
   either branch.
2. Validate the whole extension set: each member is an AFK slice present in
   current `issues.md`, allowed by current `afk.json`, absent from persisted
   scope, identity-consistent, and has every blocker either already scoped or
   in the same set. No state changes on refusal.
3. Copy the exact `contract.md` and `acceptance-manifest.json` bytes into a new
   immutable recovery-snapshot directory beneath the target's artifact
   directory. Write through a temporary sibling and atomically publish the
   directory only after both files, their presence, SHA-256 fingerprints and
   locked-pair validation agree with the source. Never overwrite a published
   snapshot. A snapshot not referenced by admitted lineage grants no authority
   and is safe for later collection.
4. Recheck the target pair, branch heads, clean worktree, scope fingerprint and
   request identity against the facts used to build the snapshot.
5. Acquire the ADR 0056 run-state lock. While holding it, reload run state and
   repeat the pair, branch-head, clean-worktree, active-attempt, request and
   scope-fingerprint comparisons. A mismatch is a pre-admission refusal; the
   unreferenced snapshot remains inert. Otherwise atomically append a
   `PENDING` event. This is the first admitted mutation. The event contains a
   unique attempt ID; target, canonical reason and complete proposed extension
   set; provider and branch; slice head and feature head; scope fingerprint;
   immutable snapshot locator; and original pair fingerprints. Only after this
   write commits may AFK reopen or modify either contract file or negotiation
   state.

Pre-admission refusal writes no lineage, changes no branch or accepted-pair
byte, and admits no scope. Snapshot creation failure is also pre-admission.

### Canonical request and scope identity

- The canonical recovery reason is the CLI value after ECMAScript
  `String.prototype.trim()`. AFK preserves every remaining code point exactly:
  no case folding, whitespace collapse or Unicode normalization.
- A target or extension identity is the resolved pair `{number, ghIssue}`;
  `number` uses `canonicalSliceNumber`. The extension set is sorted by
  canonical slice number, then GitHub issue number, before storage or equality
  comparison.
- The scope fingerprint is SHA-256 over UTF-8 JSON with no insignificant
  whitespace and this exact shape:
  `{"mode":<mode>,"slices":[{"number":<canonical>,"ghIssue":<id>}]}`.
  Slice order is the persisted scope order. Object keys appear in the shown
  order. Admission and completion use the same encoder.

## Recovery State Machine

Recovery lineage is an append-only event list. A `PENDING` event carries the
full admitted request; each later event references its `attemptId`. Events are
never edited or deleted. The current outcome of an attempt is its last event,
which has one of four states:

```text
PENDING -> COMPLETED
PENDING -> ROLLED_BACK
PENDING -> ROLLBACK_FAILED -> ROLLED_BACK
```

- `PENDING` means one admitted attempt is unresolved and exclusively owns
  recovery of the target. It remains the active attempt across process death
  until launch-time reconciliation terminates it. While it exists, AFK blocks
  ordinary resume, generator dispatch and another admission for that target.
- `COMPLETED` means the replacement pair locked successfully and the atomic
  completion transaction committed. Its terminal event records the replacement
  pair fingerprints and lock provenance.
- `ROLLED_BACK` may be written only after both accepted-pair files have been
  restored from the referenced immutable snapshot and reread to prove exact
  byte equality and original fingerprints.
- `ROLLBACK_FAILED` records the restore or verification error and observed
  fingerprints. It never claims rollback. Every launch blocks dispatch and
  retries restoration from the same snapshot before doing anything else. A
  successful later verification appends `ROLLED_BACK` for the same attempt.

No attempt changes from `ROLLED_BACK` or `ROLLBACK_FAILED` back to `PENDING`.
After rollback, an operator retry creates a new snapshot and a new attempt ID.

## Attempt Execution and Failure Semantics

After admission, AFK first preserves and clears the exact current negotiation
state below, then reopens the accepted pair through the shared contract
mutation rules, reruns explorer fact collection, and runs the ordinary
planner/evaluator protocol. Exact-stage resume cannot skip either role. The
replacement candidate must pass normal accepted-pair validation, mechanical
lock gates and lock provenance before it is locked.

- Copy the current bytes, when present, of `context.md`,
  `contract-review.json`, `contract-response.json`,
  `contract-negotiation-outcome.json`, `planner-escalation.md`, and
  `feedback-r*.md` into the immutable attempt history, then delete only those
  live copies. Existing `reviews/` contents and every implementation or QA
  artifact remain untouched.
- Through the owning focused run-state APIs, remove only the target's
  contract-stage checkpoint and contract-convergence entry. Preserve resume
  counters, slice outcomes, implementation/QA state, migrations, guardian
  history and every other slice's fields.

These live negotiation controls are deliberately not restored on rollback:
their immutable history copy preserves the evidence, while leaving them live
would let a stale outcome or exact-stage checkpoint bypass the required fresh
explorer and negotiation on the next attempt. The accepted pair is the only
authoritative state restored in place.

The preserved worktree, slice branch, commits, implementation-round count,
resume-attempt count and historical archives are not changed by admission or
negotiation. Proposed additions are data in the `PENDING` record only; scope
resolution and DAG construction ignore them.

Every unsuccessful admitted exit—including provider failure, evaluator
non-acceptance, deterministic validation or lock-gate refusal, cancellation,
and a lost completion compare-and-swap—restores from the immutable snapshot.
If byte verification succeeds, AFK appends `ROLLED_BACK` and returns the
original failure. If restore or verification fails, AFK appends
`ROLLBACK_FAILED`, returns a fail-closed recovery error and blocks dispatch.

On process death, the next launch examines recovery lineage before ordinary
resume. For `PENDING` it restores and verifies the prior pair, then appends
`ROLLED_BACK`; for `ROLLBACK_FAILED` it repeats the same restoration. A launch
without an exact recovery request exits after reconciliation and tells the
operator to retry. A launch carrying the exact request may admit a new attempt
after reconciliation. No stale, reopened or half-written pair reaches a
generator.

## Successful Completion and Scope Atomicity

After the replacement lock succeeds, AFK performs one ADR 0056-protected
run-state transaction. It rechecks that the same attempt is `PENDING`, that the
persisted scope still has the admitted fingerprint, and that every proposed
addition is still valid and absent. That one write:

1. appends a `COMPLETED` terminal event carrying replacement fingerprints and
   provenance; and
2. adds the entire proposed extension set to persisted scope.

The transaction preserves every unrelated run-state field. Atomic here means
one locked read-modify-write publishes one JSON document containing both the
terminal event and the whole extension set; there is no valid intermediate
run-state document with only one of them. It writes all additions or none. A
crash or failure before this commit leaves the attempt `PENDING`;
launch-time reconciliation restores the old pair and no slice was added. A
crash after it leaves completed lineage and the whole set in scope. Only after
the commit may AFK rebuild the DAG or dispatch a generator.

Before dispatch, AFK rereads the current pair and requires it to match the
replacement fingerprints in `COMPLETED` lineage and to remain locked. A
mismatch fails closed.

## Replay and Conflicts

When the current pair equals a completed action's replacement pair, repeating
the exact target, canonical reason and complete extension identity set is an
idempotent no-op. It neither appends lineage nor rewrites scope. A different
target, reason, partial extension or different extension identity set against
that completed replacement is refused and names the completed attempt.

If the current accepted pair has since changed to a different valid lock, it
may be the original pair of a new recovery action; that action receives a new
snapshot and attempt ID. Thus completed replay is idempotent without preventing
later recovery of a genuinely newer lock.

## Failure Matrix

| Point | Persisted result | Pair and scope | Dispatch |
|---|---|---|---|
| Eligibility, extension or snapshot refusal | No lineage | Original pair and scope unchanged | Refused |
| Admitted negotiation/guard failure | `ROLLED_BACK` after verified restore | Original pair; no additions | Refused |
| Process death before completion commit | `PENDING`, reconciled next launch | Restored and verified before any resume; no additions | Blocked until reconciled |
| Restore or verification failure | `ROLLBACK_FAILED` | Untrusted pair; no additions | Blocked fail-closed |
| Replacement lock plus completion commit | `COMPLETED` | Replacement pair; complete extension set added atomically | Allowed after fingerprint check |

## Testing Decisions

- Prefer pure tests for selector compatibility, eligibility, snapshot identity,
  state transitions, replay identity, extension validation and completion CAS.
- Extend an existing resume/negotiation fixture to prove the first admitted
  mutation is `PENDING`, process-death reconciliation restores exact bytes,
  rollback failure blocks dispatch, retries create new attempts, and no
  generator sees an unresolved pair.
- Extend an existing persisted-scope fixture to prove additions stay
  non-executable while pending and become visible only in the same state write
  that records `COMPLETED`.
- Do not add a spawned pipeline scenario unless no existing fixture can reach
  the required state.

## Out of Scope

- Automatic stale-contract detection or automatic scope growth.
- Multiple recovery targets in one invocation.
- Any branch mutation, merge-conflict resolution, destructive restart,
  adoption, or cleanup.
- Removing or replacing persisted scope identities.
- Generalizing focused scope revision beyond its gate-evidenced purpose.
- Launching AFK as part of this PRD.

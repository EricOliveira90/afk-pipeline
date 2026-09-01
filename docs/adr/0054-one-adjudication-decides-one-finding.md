# One adjudication decides one finding, and applying them is a transaction

Applies ADR 0008 (the on-disk contract is the orchestrator-owned single
source of truth) and ADR 0051 (the revision that mutates the accepted
contract is a transaction) to the impasse-adjudication path shipped by
PRD 2 slice 03 (#89). Evidence: the PRD 2 architecture guardian review,
round 3, blocking findings 1 and 2, and the product guardian review's
sole fix-before-ship finding.

## What happened

An IMPASSE record lists every unresolved BLOCKING finding, and any of them
may be `CONTESTED` — planner and evaluator both held their position, so a
human has to decide. `adjudication.md` names exactly one finding, because
the PRD's rule is that "a human decision resolves a finding, not the
contract."

The first implementation did not enforce that rule anywhere downstream of
the artifact. `parseAdjudication` checked only that the named finding
existed and was contested; `runSliceNegotiate` applied that one decision
and returned `LOCKED`. So an impasse holding contested `F-01` and `F-02`
became generator-dispatchable the moment `F-01` was decided. The on-disk
`LOCKED` said the contract was settled while the structured impasse beside
it still said `F-02` was contested — the exact disagreement ADR 0008 exists
to prevent.

The same path also had no transaction and no memory:

- Validation or lock-gate refusal returned `ESCALATE` with the planner's
  half-applied `contract.md` and `acceptance-manifest.json` left on disk.
  The sibling `runFocusedScopeRevision` had owed and paid this debt under
  ADR 0051; the adjudication path mutates the same authoritative pair and
  skipped it.
- Nothing consumed or marked `adjudication.md`. A later run re-entered the
  IMPASSE branch and invoked the apply planner again. Worse, a *rejected*
  behaviour renumbering survived as the next run's `preApplyManifest`, so
  the renumbering the stability check had just refused would pass on retry.

## Decision

**A decision is recorded per finding, and the contract locks only when they
are all in.** `adjudication-decisions.json` in the slice directory holds
each accepted decision's verbatim bytes plus a fingerprint of the impasse
it answers (round, attempt, and every finding's id/severity/state). Per
dispatch, the orchestrator:

1. loads the log, discarding it whole if it is malformed, a different
   version, fingerprinted to another impasse, or carries a decision that no
   longer parses against the current impasse — the log is evidence, never
   authority;
2. validates any newly written `adjudication.md`, refusing a finding that
   is absent, not contested, or already decided; records it; then deletes
   the file. Consuming it is what makes the next decision distinguishable
   from the last, and what stops the bounded wait accepting the same
   decision forever;
3. parks again as `AWAITING-ADJUDICATION`, naming the contested findings
   still undecided, unless the log now covers every one of them.

A refused decision is *not* consumed: the human's bytes stay where they can
be read and corrected.

**Applying the complete set is one transaction.** `contract.md` and
`acceptance-manifest.json` are captured before the planner runs and
restored byte-for-byte on every exit that is not an accepted lock —
planner throw, cancellation, stability/coverage/binding refusal,
lock-gate objection. Decisions the contract already satisfies (every
`winningPosition: PLANNER`) lock without any invocation; one planner
invocation applies all the others together, with every decision passed
verbatim.

**A successful lock marks the log applied.** A later re-entry into the
IMPASSE branch — an implementation retry, a resumed run — returns `LOCKED`
without a second planner apply. A `LOCKED` contract found with a complete
but unmarked log is the crash window between the two writes; it is marked,
not re-applied.

**The decision log is not part of the transaction.** Like the escalation
archive in ADR 0051, human input must outlive a mechanical refusal: a
rolled-back apply is retried from the same decisions, not from a fresh
interrogation of the human.

## Consequences

- A multi-finding impasse now costs one dispatch per decision. That is the
  honest shape of the workflow the PRD describes — the courier presents one
  finding's two positions at a time — and each dispatch between decisions
  costs no agent invocation at all.
- An operator who hand-writes `adjudication.md` will find it gone
  afterwards. The bytes are not lost: they are in
  `adjudication-decisions.json`, which is also what tells them which
  findings remain.
- A refused apply is now retried from the recorded decisions with no human
  action, which means a deterministic refusal (a planner that keeps
  renumbering behaviours) repeats until the round budget stops it rather
  than parking. The `ESCALATE` and its named defect are on `run.log` each
  time.
- The impasse fingerprint makes a renegotiated contract's decisions
  non-transferable. Correct: a decision answers two recorded positions, and
  a new negotiation produced new ones.
- `runImpasseAdjudication` and `runFocusedScopeRevision` now each carry
  their own copy of the capture/restore rule. The shotgun-surgery risk ADR
  0050 and ADR 0051 recorded is what let these two drift apart in the first
  place; a shared revision protocol remains the standing follow-up.

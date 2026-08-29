# One contract-mutation transaction, one lock predicate, and a park that is durable, replaceable state

Consolidates ADR 0051 and ADR 0054's transaction rules into a single
shared protocol, pays the shotgun-surgery debt ADR 0050/0051/0054 each
recorded, and gives the `AWAITING-ADJUDICATION` park the lifecycle
standing every other phase already has. Amends ADR 0031 and ADR 0047
(the park is a third transition class, not an exception), and narrows
one sentence of ADR 0023. Evidence: PRD 2 (#70) round-5 guardian
reviews, blocking findings A1–A5 and P1, after five consecutive
FIX-BEFORE-SHIP rounds against the same state model.

## What happened

Five gate rounds each surfaced a fresh correctness gap in the same
adjudication path. The pattern had one cause, already named by the
round-5 architect as active debt: the "revise the accepted contract"
path (`runFocusedScopeRevision`, ADR 0051) and the "apply a human
decision" path (`runImpasseAdjudication`, ADR 0054) each carry their
own copy of capture → mutate → validate → lock → restore-on-failure,
and the predicates deciding when a lock is permitted are scattered
across `contract-review.ts`, `adjudication.ts`, and two orchestrator
functions. Each patch closed one case; the duplicated seam leaked the
next:

- A mixed exhaustion — one `CONTESTED` plus one `OPEN` blocking
  finding — classifies `IMPASSE`, and the completion predicate
  (`undecidedContestedFindingIds`) counts only contested findings, so
  the contract locks while an `OPEN` blocker is unresolved (A1).
- A discarded decision log (malformed, stale, wrong impasse) empties
  the log but leaves an already-`LOCKED` contract untouched;
  replacement decisions then inherit that stale lock through the
  `readContractStatus === "LOCKED"` crash-window shortcut and are
  never applied or lock-gated (A2).
- Meanwhile the park itself had no standing anywhere else in the
  lifecycle: the scheduler `await`s the adjudication wait inside
  serial outcome reconciliation, stalling unrelated ready work (A3);
  `clean-failed` derives disposability from the presentation bucket
  and `AWAITING-ADJUDICATION` sits in `failed`, so it deletes the
  parked worktree and branch (A4); and `afk adopt` swallows worktree
  enumeration failure into "no holders", allowing a ref move behind a
  live worktree (A5). `RunJournal.reopenAdjudication` deliberately
  removes terminal idempotency — an undocumented exception to ADR
  0031 and ADR 0047.

Two seams, redesigned once, eliminate all six symptoms.

## Decision — Seam 1: one transaction, one predicate

### 1. Adjudicability decides the classification

An exhaustion is an `IMPASSE` only when **every** unresolved BLOCKING
finding is `CONTESTED`. Any unresolved `OPEN` blocker makes it
`NON_CONVERGENCE`.

A contested finding is adjudicable: two held positions exist for a
human to choose between. An open blocker is not — no decision a human
can record resolves it, so a park containing one can never satisfy any
honest completion predicate and would park forever. ADR 0041 settles
the choice: between "park that cannot unlock" and "non-convergence
that routes to the operator", take the branch that cannot loop. A
resumed slice renegotiates; if renegotiation resolves the open
findings and the contested ones survive, the fresh exhaustion is a
pure impasse and parks adjudicably.

### 2. One completion predicate, over all unresolved blocking findings

`LOCKED` is permitted only when **every unresolved BLOCKING finding in
the exhaustion record — `CONTESTED` and `OPEN` alike — has a valid
recorded decision**, and the mechanical lock gate (`onContractLocked`:
migration-prefix and run-specific checks) passes. One function owns
this predicate; the orchestrator, the classifier tests, and the
crash-window shortcut all consult it.

Under decision 1 the `OPEN` clause is unreachable — an impasse only
contains contested findings. It is stated over the full set anyway:
the predicate is the last line of defence, and A1 existed precisely
because the classifier and the predicate could disagree about which
findings mattered. If they ever drift again, the failure mode is "the
lock is refused and the disagreement is visible", not "the contract
locks over an unresolved blocker".

### 3. Both mutation paths share one transaction

A single primitive — capture `contract.md` +
`acceptance-manifest.json` byte-for-byte, run the mutation, restore
both on every exit not explicitly signalled as an accepted lock
(`onAccepted` callback, per ADR 0051: success is signalled by the
inner function, never inferred), announce any rollback — is the only
way the accepted pair is mutated. `runFocusedScopeRevision` and the
adjudication apply path become callers of it; the lock-gate call and
the completion predicate live at the transaction's single lock exit.

The Track C/D fixes from this review cycle (lock-gate bypass,
one-decision-per-finding) stop being special cases: with one lock
exit there is no second path to bypass.

### 4. A discarded decision log reconciles contract status

ADR 0054 made the log evidence, never authority. This ADR adds the
contrapositive: **a `LOCKED` status the surviving evidence does not
witness is not authority either.** When the loader discards the log,
the transaction immediately reconciles: if `contract.md` reads
`LOCKED` but no valid, applied, current-impasse decision log witnesses
that lock, the contract is reopened, and the reopening is announced in
the run log. ADR 0008 makes the orchestrator the owner of the status
field; a status line contradicting the structured exhaustion record
beside it is exactly the disk/orchestrator disagreement that ADR
exists to prevent, and the owner repairs it.

### 5. The lock carries provenance; the crash window is proved, not presumed

ADR 0054's crash window — `lockContract` succeeded, the applied-marker
write did not — was detected by `readContractStatus === "LOCKED"`
alone, which cannot distinguish "this lock is the one these decisions
produced" from "this lock is stale debris a discard left behind" (A2's
second half).

The transaction therefore writes a **pending-lock witness** into the
decision log immediately before `lockContract`: a fingerprint of the
exact decision set (the recorded decisions' raw bytes) plus the
impasse fingerprint it answers. Marking the log applied clears the
witness. The already-applied shortcut may then return `LOCKED` without
re-applying only when the current, validated, complete log is either
marked applied or carries a pending-lock witness matching its own
decision set — the provable crash window. A `LOCKED` contract with no
matching witness is stale: it is reconciled (decision 4) and the full
apply-and-lock runs.

Crash cases: dying between witness and `lockContract` leaves a witness
over an unlocked contract — harmless, the next dispatch runs the full
apply and overwrites it. Dying between `lockContract` and the
applied-mark leaves witness + lock — the shortcut proves it and marks
applied, ADR 0054's original intent. The lock-then-mark order is
unchanged; only its evidence improved.

## Decision — Seam 2: a park is durable, replaceable state

One invariant, stated once and consulted by every lifecycle operation:

> **A parked slice's adjudication estate — its impasse record, its
> `adjudication-decisions.json`, any in-flight `adjudication.md`, its
> worktree, and its branch — survives every lifecycle operation except
> the slice's own re-dispatch. An operation that cannot prove it
> preserves the estate refuses by name; nothing derives disposability
> from a presentation bucket, and nothing treats an enumeration
> failure as proved absence.**

### 6. Cleanup eligibility is a trait, not a bucket

`PHASE_TRAITS` gains an explicit cleanup-disposition axis, separate
from the presentation `bucket`. `AWAITING-ADJUDICATION` declares
"preserve everything"; `clean-failed` keys its target predicate off
the cleanup trait and reports parked slices as skipped, by name, with
the invariant as the reason. The presentation bucket goes back to
being about rendering only.

This narrows one sentence of ADR 0023: "every slice in a failure
phase" becomes "every slice whose phase declares its debris
disposable". The command's scope guarantees, branch-preservation
guard, and pass structure are unchanged.

### 7. The scheduler waits for a decision only at idle

Outcome reconciliation records a park and moves on; it never awaits
the bounded adjudication wait inline. The loop reconciles **all**
outcomes, recomputes readiness, and dispatches every ready wave first.
Only when no runnable work remains and parked slices still hold live
waits does the pipeline await them (any one resolving is enough to
re-enter the loop). A valid decision re-enqueues its slice — that
re-dispatch is the park replacement of decision 9; an expired wait
leaves the slice parked for the next run. This is ADR 0024's rule
applied to parks: dependency safety belongs to the DAG, and a human's
think-time on one slice is not a dependency of anyone else's.

### 8. Adoption refuses when it cannot enumerate

`worktreesHolding`'s catch-all returned `[]`, making "git failed" and
"no worktree holds the branch" the same answer, ahead of an
`update-ref` that corrupts a checked-out worktree (ADR 0010). Worktree
enumeration failure becomes operator-visible refusal 6 in ADR 0053's
list — named, before candidate creation or any ref mutation, leaving
refs and run state untouched. The worktree lister is injected at the
command seam so the failure path is testable. This is the invariant's
fail-closed clause applied to the one lifecycle operation that moves
refs out from under worktrees.

### 9. The journal gets a third transition class: the park

ADR 0031 knows two classes — non-terminal tracking and terminal
records (immutable this run). `RunJournal.reopenAdjudication`
retrofitted a third by deleting a terminal mark, which both round-5
guardians correctly read as an undocumented exception. The exception
becomes the model:

- **A park is recorded like a terminal** — persisted first, projected
  to state, run log and events identically — but enters a `parked`
  set, not `terminalSlices`. Re-recording the same park is idempotent
  (ADR 0031's retry rule). Recording a *different* terminal for a
  parked slice without an intervening dispatch throws (ADR 0031's
  protection, kept).
- **Re-dispatch is the reopen.** `trackSlice` on a parked slice clears
  the parked mark and, per ADR 0047, clears the persisted record —
  that is the one legal path from parked to a new outcome.
  `reopenAdjudication` is deleted; the wave loop simply re-dispatches.
- **ADR 0047 needs no exception**, only this note: clearing the
  persisted park record at dispatch loses nothing durable, because the
  park's estate (decisions log, impasse record, worktree, branch)
  lives in the slice directory and repository, which decision 6
  protects. The state-file record is the announcement of the park, not
  its substance.
- Amendment to ADR 0031: "terminal outcome" reads "terminal or parked
  outcome; a park is durable but replaceable, and only a dispatch
  replaces it."

## Also decided: one STUCK finalizer, no exceptions (P1)

The migration-sync failure branch in `runSliceExecute` returns
`STUCK` directly, bypassing `finishStuck` and so shipping no
`stuck.md`. `finishStuck` is parameterized with the outcome's specific
reason (default: the round-exhaustion message it hardcodes today), and
the migration-sync branch routes through it. Slice 04's promise —
every STUCK outcome carries a code-assembled diagnosis — becomes
structural: `finishStuck` is the only constructor of a STUCK return in
`runSliceExecute`.

## Consequences

- One transaction, one predicate, one lock exit: the class of defect
  that consumed five gate rounds ("this mutation path forgot that
  rule") is closed structurally, not case-by-case. New contract
  mutations get the capture/restore/validate/lock behaviour by calling
  the shared primitive, or they visibly do not exist.
- The decision log format gains a pending-lock witness field. Existing
  logs without one are simply pre-witness: a locked-and-applied log is
  already proven, and an unapplied one now (correctly) re-applies
  rather than inheriting the lock. Fail-closed either way.
- Mixed exhaustions stop parking. A slice that previously parked with
  an undecidable OPEN blocker now ends the round as non-convergence
  with both findings preserved in the exhaustion record. That costs a
  renegotiation where a human might have wished to decide the
  contested finding early; it buys the guarantee that every park can
  actually be unlocked by human decisions alone.
- `clean-failed` reports parked slices instead of destroying them; the
  operator cleaning a five-slice wreck sees "skipped #NN:
  awaiting adjudication — parked state is preserved" rather than
  losing the human's recorded decisions.
- A parked slice no longer delays unrelated waves; total pipeline time
  for a run with one impasse drops from "everything after the park
  waits for the human" to "only the park's dependents wait".
- `afk adopt` gains one refusal and loses one corruption path.
- The journal's state machine is honest: PENDING → RUNNING →
  (terminal | parked); parked → RUNNING → …; terminal is final this
  run. Tests assert the machine directly instead of the
  delete-a-terminal backdoor.
- Not changed: PRD 2 scope (#94 out, Story 14 deferred), the bounded
  wait's duration, ADR 0054's one-decision-per-dispatch workflow, the
  decision log's exclusion from the rollback (human input still
  outlives mechanical refusals), and ADR 0050's revision bound.

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

**Reaffirmed with an amendment (fourth adjudication gate round, PM
finding, operator ruling).** The review argued that a mixed exhaustion —
one blocking finding genuinely contested, another still open — discards
the contest by classifying `NON_CONVERGENCE`. The classification stays as
written above: the argument for parking such an exhaustion is an argument
for a park that cannot unlock, which is exactly what ADR 0041 tells us
not to build, and `buildContractNegotiationOutcome` is not changed. The
real defect the review found is a *visibility* one — the operator saw
"reached NON_CONVERGENCE after N rounds" and could not distinguish a flat
non-convergence from a live contest the classifier declined to park, so
the contest looked discarded because nothing showed it. So the diagnosis
now carries it:

- `stuck.md` gains a `## Contested positions held at exhaustion` section
  whenever a `NON_CONVERGENCE` record contains a contested finding: each
  contested finding's two held positions with both sides' evidence, the
  named `OPEN` blocker that made the park impossible, and the forward path
  (close the open blocker in the source issue, rerun; if the contest
  survives a fresh negotiation, that exhaustion is a pure impasse and
  parks for a decision).
- The run-state reason names the contested ids and the open ids and points
  at `stuck.md`, rather than reporting the round count alone.
- The record itself already retains both blockers (decision 1's last
  paragraph) — the audit was never lossy; only the operator-facing
  rendering was.

Slice 02 `[behavior:B-01a]` binds this. Anyone tempted to revisit the
classification should read this paragraph first: the operator has ruled on
it once, with the contest made visible instead.

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

**Amended (third adjudication gate round, PM blocker): the focused-scope
revision is additive, and the guard proves it.** A revision exists to
repair a too-narrow lock by *adding* the escalation's requested paths
(Story 1-2, slice 01 B-03/B-04: preserve the accepted contract, add the
requested paths). `reviseAcceptedContract` verified that every requested
path arrived but never that every previously locked path survived, so a
revision that dropped an accepted path while adding the requested one was
re-locked — handing the fresh generator an incomplete scope and losing
already-contracted work. It now also requires every previously declared
path to remain in *both* `contract.md` and `acceptance-manifest.json`;
dropping one throws inside the transaction, which rolls the accepted pair
back byte-for-byte and ends the slice `ERROR` with no fresh generator
dispatch. This constraint is additive-only and therefore lives on the
revision path alone: the adjudication apply path shares
`validateAcceptanceManifestStability` but may legitimately *narrow* scope
per a human decision (ADR 0054's "keep the API, narrow the file scope"),
so the check is not in the shared validator.

**Amended (second adjudication gate round, architect blocker 3): the QA
scope amendment is the third caller, not a third copy.** `#112`'s
amendment (ADR 0048) predates this ADR and mutates the same accepted
pair — it widens `acceptance-manifest.json`, then widens the contract's
file list in a second function that can refuse (no
`## Files expected to change` section) or simply fail. With no
capture/restore boundary around the two writes, a refusal left a widened
manifest beside an unwidened, *locked* contract: exactly the desync
ADR 0048 makes the orchestrator responsible for preventing. "Both
mutation paths" was therefore an undercount of this decision's own
scope; the rule is **every** path that mutates the accepted pair calls
the transaction. The amendment passes no `completion` and never calls
`tx.lock` — it does not lock, it widens a contract already locked — so
what it takes from the transaction is the two-file capture/restore and
the guarantee that its archive is written only over a coherent pair.
The archive therefore goes *inside* the transaction, beside the writes
it records, and not after it.

### 4. Every lock names what produced it

Every lock exit of the shared transaction stamps the contract with the
lock's provenance: the impasse fingerprint it settled, the escalation
it declared, or the ordinary negotiation round that accepted it. The
stamp is a separate orchestrator-owned `**Lock-Provenance:**` line;
the `**Status:** LOCKED` line stays byte-identical, because agent
prompts read that literal field (ADR 0008) and this ADR does not
reopen that wound. The orchestrator writes and reads the stamp;
agents never do.

**Amended (third adjudication gate round, architect blocker 1): the
impasse fingerprint identifies the *dispute*, not just its shape.** The
fingerprint is what binds a decision log and a provenance stamp to the
impasse they settle (§5 below and the discarded-log reconciliation
above), so it must be the identity of the question a human decided.
ADR 0054 Consequences makes decisions non-transferable precisely because
a decision answers the two recorded positions — yet the fingerprint
hashed only round, attempt, and each finding's id/severity/state. Two
IMPASSE outcomes with identical IDs and state but different
planner/evaluator positions or evidence collided, so a stale decision
log validated against a new dispute and a stamped lock self-certified
against the wrong question. The fingerprint now spans each finding's
`plannerPosition`, `plannerEvidence`, `evaluatorEvidence`, and
`unresolved` flag as well: changing any of them is a different question,
which invalidates the log and reopens the stamped lock.

Provenance is what makes a discarded decision log survivable. ADR 0054
made the log evidence, never authority; without provenance, a `LOCKED`
contract found beside a discarded log is undecidable — it could be the
lock these decisions legitimately produced (the log corrupted
afterwards) or stale debris from before the impasse (A2). Blanket
reopening would silently invalidate completed human adjudication
whenever its receipt got corrupted; blanket trust is A2 itself. With
the stamp, the transaction reconciles by proof instead of policy:

- **Discarded log + lock stamped with the current impasse
  fingerprint:** the lock self-certifies — only the transaction's lock
  exit writes that stamp, and it only locks on a proven-complete
  decision set. The lock stands; the loss is announced.
- **Discarded log + unstamped lock, or a stamp for anything other
  than the current impasse:** provably stale. The contract is
  reopened, the reopening announced, and the full apply-and-lock runs
  when replacement decisions arrive. This is A2's fix.

### 5. The crash window is proved, not presumed

ADR 0054's crash window — `lockContract` succeeded, the applied-marker
write did not — was detected by `readContractStatus === "LOCKED"`
alone, which is exactly the shortcut A2 abused. The transaction now
writes a **pending-lock witness** into the decision log immediately
before `lockContract`: a fingerprint of the exact decision set (the
recorded decisions' raw bytes) plus the impasse fingerprint. Marking
the log applied clears it. The already-applied shortcut may return
`LOCKED` without re-applying only when the current, validated,
complete log is marked applied or carries a witness matching its own
decision set. The provenance stamp is not re-checked here — a valid
log already binds to this impasse by its own fingerprint, and
requiring the stamp would wrongly refuse a legacy pre-stamp lock whose
applied log is intact.

Crash cases: dying between witness and `lockContract` leaves a witness
over an unlocked contract — harmless, the next dispatch runs the full
apply and overwrites it. Dying between `lockContract` and the
applied-mark leaves witness + stamped lock — proved, marked applied,
ADR 0054's original intent. The lock-then-mark order is unchanged;
only its evidence improved.

**Amended (adjudication gate round, architect blocker 1).** As first
shipped this section left the mechanical lock gate *after*
`lockContract`, and cleared the witness only at a lock exit that did not
lock. Both leaked, in the same way: persisted state claiming an
invariant the responsible operation had not established. Two rules
close it, and they are the ordering this ADR now mandates —
**witness → gate → `lockContract` → applied-mark**:

- **The gate runs before `LOCKED` is written.** With the gate after the
  lock, a process stop between the two left a stamped `LOCKED` contract
  beside a witness proving the decision set, and nothing recording that
  the gate had never run. `adjudicatedLockIsProven` reads exactly that
  pair as proof, so the next dispatch short-circuited and the gate was
  skipped for good — a `LOCKED` contract that had passed no
  migration-prefix check, which is what ADR 0008 makes the on-disk lock
  status authoritative *against*. Nothing about the gate needs a locked
  contract: it reads the declared file scope, never the status line.
  Running it first makes `LOCKED` on disk the gate's own attestation,
  and no crash window can forge one. This does not weaken decision 5's
  witness-first rule — a witness must still precede the lock it
  explains — it only settles where the third operation goes.
- **The witness is cleared on every exit that did not reach
  `onAccepted`, not merely on a refused lock.** The remaining hole was
  the asymmetric exit: the lock succeeded, the caller's applied-marker
  write then threw, so `onAccepted` was never called and the outer
  rollback restored the pre-transaction contract — while the witness
  survived. Where that restored contract was stale `LOCKED` debris, the
  witness certified the rolled-back lock on the next dispatch. The
  clear therefore belongs to the transaction's own exit, beside the
  restore it has to accompany, not to the lock call. It is best effort
  with a named warning: the exit it defends is usually "writes to the
  decision log are failing", so the clear can fail with it, and an
  operator told which artifact to inspect is strictly better than a
  masked original error.

**Amended again (second adjudication gate round, architect blocker 1): a
proven lock is proof about the decisions, not about the base.** The two
shortcuts that return `LOCKED` without entering the transaction — an
already-applied (or witnessed) decision log, and a stamped lock beside a
discarded log — both establish that *this decision set produced this
lock*. Neither establishes anything about the base the contract is about
to be generated against, and the mechanical gate's checks are precisely
the ones a changed base invalidates. An adjudicated lane successor is
where that gap opens: `runWave` merges the new feature tip into the
preserved parked worktree and re-negotiates, so a migration prefix the
predecessor's merge has since claimed is a collision only a fresh gate
call can see — which is what ADR 0028's *why the gate is a callback*
requires it to see. The gate-before-`lockContract` ordering above cannot
help, because these shortcuts never enter the transaction.

So **every path that returns `LOCKED` re-runs the mechanical gate,
including the ones that do not lock anything.** The gate is a pure read
of the declared scope against the current base, and it is cheap, so the
rule is unconditional rather than conditional on "did the base change" —
a predicate nothing here could answer honestly.

A refusal from that re-attestation preserves the parked estate exactly
as it stands: no reopen, no rollback, nothing written. There is no
transaction to roll back to, and the contract on disk is the one a
passing gate did attest to at the base it locked on. Reopening it would
throw away a completed human adjudication over a condition that is not
about the decisions at all, and re-applying would re-invoke the planner
for decisions already applied. Because nothing is mutated, the refusal
is idempotent: every later dispatch re-asks the gate, so the lock can
never be consumed while the objection stands, and it is accepted again
unchanged once the base is fixed.

**Amended (third adjudication gate round, architect blocker 2): the
refusal is its own phase, `ADJUDICATION-LOCK-REFUSED`, not `ESCALATE`.**
As first written this section said the refusal "reads as a lock refusal
(`ESCALATE`)", and every adjudication-branch lock refusal (this
re-attestation, the transaction's own gate refusal, and the manifest
stability/coverage refusal) returned terminal `ESCALATE`. But `ESCALATE`
carries `debris: "disposable"` (Seam 2 §6), and the decision log lives
inside the slice worktree — so `clean-failed` would delete the worktree
holding a *completed* human adjudication, and `adopt` (refusal 7, §8)
would no longer recognise the estate, both keying off the phase's debris
trait. That directly contradicts this section's own promise that the
same decisions are accepted again once the base is fixed: the promise
only holds until the next cleanup. The refusal therefore persists as a
distinct `FailurePhase` that presents like `ESCALATE` (failed bucket,
`STUCK` summary label — to the operator it is still a lock refusal to
resolve by renumbering) but declares `debris: "preserve-all"`, so
cleanup and adoption inherit the estate-preserving behaviour off the
trait without learning the phase by name. It is terminal *this* run —
the operator fixes the base and the next run re-dispatches it via the
persisted IMPASSE outcome, exactly like `ESCALATE` — so it is not
`replaceableThisRun`; the park's within-run replacement is a human
*decision*, which this estate already has.

**Amended again (fourth adjudication gate round): the phase stays, the
trait does not.** The distinct phase is worth keeping — an operator
reading the status table should see "the lock gate objected to the base",
not a generic escalation — but its `preserve-all` trait was the wrong
carrier for the estate and is retired to `disposable`. Seam 2 §6 has the
reasoning: this phase was one exit among several that leave a decision log
behind, and the estate is now proved from disk by `clean-failed` and
`adopt` alike. This section's promise ("the same decisions are accepted
again once the base is fixed") is therefore stronger than it was, not
weaker: it now also holds for the refusals that never reached this phase
because the apply died mechanically first.

## Decision — Seam 2: a park is durable, replaceable state

One invariant, stated once and consulted by every lifecycle operation:

> **A parked slice's adjudication estate — its impasse record, its
> `adjudication-decisions.json`, any in-flight `adjudication.md`, its
> worktree, and its branch — survives every lifecycle operation except
> the slice's own re-dispatch. An operation that cannot prove it
> preserves the estate refuses by name; nothing derives disposability
> from a presentation bucket, and nothing treats an enumeration
> failure as proved absence.**

**Amended (adjudication gate round, architect blocker 2): the ownership
check belongs before the dispatch routes, not inside one arm of it.**
ADR 0010 item 3 requires `assertWorktreeRegistered` immediately before
every agent dispatch, and the only call sat at the end of
`prepareSliceWorktree` — which only the *ordinary* negotiate path
reaches. A slice arriving with a persisted `IMPASSE` routes straight to
the adjudication branch, and an adjudicated lane successor routes
straight to a merge into its parked worktree; both then run git in
`ctx.worktreeDir` and can invoke the planner there, unchecked. A leaked
directory git no longer registers sends those commands up to the parent
repository — the corruption mode the invariant exists to prevent, and a
routine Windows leftover after a failed cleanup.

One shared check therefore runs ahead of the ordinary-versus-`IMPASSE`
fork, and again in the adjudicated lane-successor branch that preserves
its worktree instead of recreating it. It is deliberately narrower than
`prepareSliceWorktree`: it creates, resets and deletes nothing, because
its two new callers must preserve the parked estate byte-for-byte, and
per ADR 0010 a stale directory is left for the operator either way. An
absent directory is not a violation — that is the ordinary first
dispatch, and creating it is the ordinary path's job.

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

**Amended (third adjudication gate round, architect blocker 2): a second
phase now declares `preserve-all`.** `ADJUDICATION-LOCK-REFUSED`
(Seam 1 §5) preserves its estate for the same reason the park does — it
holds a completed human adjudication — so it carries the same trait and
`clean-failed` skips it and `adopt` refuses it (§8) with no new code in
either: both key off the trait, exactly as this decision intended when it
said "a new preserved phase never has to be remembered in two places".
The two preserve-all phases differ only on the *journal's* axis
(`replaceableThisRun`): the park's within-run replacement is a human
decision it is still awaiting; the lock-refused estate already has its
decisions and waits on a base fix, so it is terminal this run.

**Superseded (fourth adjudication gate round, architect findings 1 and 2):
estate ownership is a fact about the worktree, not about the phase.** The
amendment above is the wrong shape and it is retired: `ADJUDICATION-LOCK-
REFUSED` goes back to `disposable`, presentation-only like `ESCALATE`, and
nothing about ownership rides on it.

The reasoning: encoding ownership as a phase covers exactly the exits
someone remembered to enumerate. Round 3 enumerated one — the lock
refusal — but a decision log exists from the moment the first decision is
recorded, and after that point the apply step can still fail
*mechanically* in at least four ways that are not adjudication phases at
all: the planner or provider dies, the lane-successor feature refresh
conflicts, the operator cancels mid-apply, or post-lock bookkeeping throws
and is flattened to `ERROR`. Each lands in `ERROR`, `CONFLICT` or
`LANE-CANCELLED` — all `disposable` — and `clean-failed` then deletes the
worktree holding the only copy of the operator's decisions. ADR 0054
already says the decision log is not part of the transaction and that
human input outlives a mechanical refusal; deriving its disposability from
the phase contradicted that for every exit but one. The same lossiness hit
`adopt`, which matched the estate by branch and so let a detached
registered worktree (`branch: null`) through the refusal entirely.

So the question is asked of disk instead. A slice **owns a live
adjudication estate** iff its slice directory, inside the worktree, holds
either:

- `adjudication-decisions.json` — recorded human decisions (ADR 0054); or
- `contract-negotiation-outcome.json` with `classification: "IMPASSE"` —
  an impasse record awaiting a decision, which is literally the predicate
  `negotiate()` re-enters adjudication on.

Those two files are the two re-entry paths, which is why they and not the
phase are the fact. One function (`findAdjudicationEstate`) answers it,
over a bounded walk of the worktree that skips `node_modules` and friends;
`clean-failed` consults it in both passes (registered slices *and* the
namespace sweep, where no run state claims the directory at all) and
`adopt` consults it before any ref or state mutation. Scoping the
negotiation-outcome clause to `IMPASSE` matters: mere presence of that file
would have preserved every escalated slice in the run. An unreadable
record counts as owned — §8's "absence is proved, not inferred" applied to
a truncated file, where deleting the worktree destroys the evidence of
what it was.

Read this before simplifying it back into the phase. Ownership was always
a property of the worktree; the phase was a proxy for it, and four gate
rounds each found another exit the proxy missed. Adding exit number five
to a `preserve-all` list is the failure mode this decision removes — a new
post-decision exit now inherits preservation without knowing this decision
exists.

`AWAITING-ADJUDICATION` keeps `preserve-all` as a *secondary* signal, and
only for the case with no disk to read: a park whose worktree an operator
has already removed by hand, where the phase is the last thing that says
the branch is still the next dispatch's input.

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

Two boundary decisions, made explicitly rather than by accident:

- **The idle wait races the abort signal.** Cancellation during the
  wait ends it immediately; the park is already durable, so nothing is
  lost (ADR 0003, ADR 0040 unchanged).
- **The wall-clock ceiling (ADR 0019) keeps running while the
  pipeline idles on a human.** The bounded wait is already sized by
  configuration, and the park surviving run death is this seam's whole
  point; exempting human-wait from the ceiling would let a run live
  forever.

### 8. Adoption refuses when it cannot enumerate

> **Deferred to PRD `afk-v2-run-state-lock-and-adoption` (2026-08-31).** This
> section is about `afk adopt`, which was excised from PRD 2 — the code it
> describes is not in the tree. The estate probe it relies on
> (`probeAdjudicationEstate`, §10) *did* ship and `clean-failed` uses it; only
> adoption's use of it is deferred. See ADR 0053's banner.

`worktreesHolding`'s catch-all returned `[]`, making "git failed" and
"no worktree holds the branch" the same answer, ahead of an
`update-ref` that corrupts a checked-out worktree (ADR 0010). Worktree
enumeration failure becomes operator-visible refusal 6 in ADR 0053's
list — named, before candidate creation or any ref mutation, leaving
refs and run state untouched. The worktree lister is injected at the
command seam so the failure path is testable. This is the invariant's
fail-closed clause applied to the one lifecycle operation that moves
refs out from under worktrees.

**Amended (second adjudication gate round, architect blocker 2):
adoption also refuses while a park owns a worktree — refusal 7.** The
enumeration fix asked the right question of the *feature* branch and no
question at all about the slice being adopted. Adoption is not a
dispatch, so under the invariant above it may not replace a park; but it
overwrites the slice's persisted record with `PASS` and reconciles
nothing, which strands the park's registered worktree with no live slice
owning it. The next launch then excludes completed slices from both
`intended` and `retained`, preflight classifies that worktree as a
leftover, and the run refuses — so the operator's bypass valve, used on
the phase most likely to need it, bricked their next launch.

The check is therefore a refusal, not a reconciliation. Quiescing the
estate on the operator's behalf would delete a human's pending
adjudication worktree inside a command that never mentions adjudication:
the same "disposability inferred rather than proved" mistake decision 6
exists to undo. The refusal names the holding worktree and the two ways
forward — record the pending decision and let the slice's own
re-dispatch finish it, or remove the parked worktree by hand (its branch
and `adjudication-decisions.json` survive that) and adopt again. It is
raised before candidate creation or any ref mutation, like every other
adoption refusal, and it keys off the phase's `preserve-all` debris
trait rather than the phase name, so a future phase that preserves its
estate inherits the refusal instead of re-learning it. A record whose
phase preserves everything but that names no branch is refused too:
which worktree the estate holds cannot then be proved, and proved
absence is what the invariant demands.

**Amended (fourth adjudication gate round, architect finding 2): refusal 7
matches the estate on disk, and by path as well as by branch.** Keying off
the `preserve-all` trait was the same lossy proxy §6 now retires, and
matching only `worktreesHolding(record.branch)` had a second hole: a
registered worktree with a detached `HEAD` reports `branch: null`, holds
nothing by that query, and was adopted straight through the refusal while
still holding the operator's decision log. Detachment is not exotic — it is
what a `git bisect`, an interrupted rebase or a hand-inspected commit
leaves behind.

Refusal 7 therefore checks, before any ref or state mutation:

1. Every candidate worktree — the one registered at the slice's
   **expected** path (the path the run would have created, derived from the
   run slug's provider), every worktree holding the recorded branch, and
   the expected path itself even if git has forgotten it — for a live
   estate on disk. Any hit refuses, quoting the estate's evidence.
2. Then, for a record whose phase still declares `preserve-all`: the
   no-branch case as before, plus an **ambiguity** case — a worktree
   registered at the expected path whose branch is not the recorded one
   (detached, or moved to something else). Which worktree the estate holds
   cannot be proved, so it fails closed, citing this section.

The refusal quotes the registered (git-spelled) path first so it is
pasteable, and its forward path is specific to what the record is waiting
on: write the pending decision for a park, fix the base the lock gate
objected to for a lock refusal, and otherwise let the slice's own
re-dispatch retry the recorded decisions from where the apply stopped.

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

  **Amended (adjudication gate round, architect blocker 3): "the same
  park" is the whole record, phase and reason alike.** Keying
  idempotency on the phase alone looked like the retry rule and behaved
  like data loss. A partial adjudication parks again with the same phase
  and a *different* reason — the findings still undecided, which ADR
  0054 item 3 requires it to name — and the phase check silently kept the
  stale reason listing findings the human had already decided. A changed
  park with no intervening dispatch is a missing reopen in the caller,
  so it throws like any other undispatched replacement rather than being
  absorbed (issue #141).

  **Amended (third adjudication gate round, architect note): "the whole
  record" includes branch identity.** The idempotency check compared
  phase and reason but not the slice's branch. Branch naming is
  deterministic within a run, so this changes no behaviour today — but
  the invariant is stated over the whole record, and a re-park onto a
  different branch with no intervening dispatch is a missing reopen just
  as a changed reason is. The comparison now includes the branch, so the
  implementation and the invariant stay aligned before branch identity
  can become mutable.
- **Re-dispatch is the reopen.** `trackSlice` on a parked slice clears
  the parked mark and, per ADR 0047, clears the persisted record —
  that is the one legal path from parked to a new outcome.
  `reopenAdjudication` is deleted; the wave loop simply re-dispatches.

  **Amended: the reopen belongs at the entry to the adjudication
  branch, not behind its completion check.** Reaching that branch *is*
  the re-dispatch, and every arm of it can produce a new outcome —
  a refused decision, a partial one, a lock refusal. Placing the
  `trackSlice` after the all-decided check reopened the park only for
  the dispatch that completed the adjudication, which is precisely the
  dispatch that does not need it.
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
- The decision log format gains a pending-lock witness field, and the
  contract gains an orchestrator-owned lock-provenance line. Existing
  artifacts without them are simply pre-stamp: a locked-and-applied
  log is already proven, an unapplied one now (correctly) re-applies
  rather than inheriting the lock, and an unstamped lock beside a
  discarded log reopens. Fail-closed in every legacy shape. A
  corrupted *applied* log no longer costs the operator their completed
  adjudication — the stamped lock self-certifies and only the
  bookkeeping is lost.
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
- `afk adopt` gains two refusals (unenumerable worktrees, and a park
  that still holds one) and loses one corruption path. Adopting a
  parked slice is now a two-step operator action rather than a silent
  one that costs them the next launch.
- Every `LOCKED` return from the adjudication branch has run the
  mechanical gate against the base it is about to generate on, whether
  or not this dispatch produced the lock. The cost is one extra gate
  call per re-entry — a scope read, no agent — and the guarantee is that
  no adjudicated contract reaches a generator over a prefix another
  slice has since claimed.
- The QA scope amendment inherits the accepted pair's rollback instead
  of owning half of one, so a refused or failed amendment can no longer
  leave a widened manifest beside an unwidened locked contract.
- A refused adjudicated lock is its own phase,
  `ADJUDICATION-LOCK-REFUSED`, presenting as a lock refusal — but the
  estate it leaves is protected by the disk fact, not by that phase
  (§6, fourth round). `clean-failed` and `adopt` protect *any* worktree
  holding a decision log or an impasse record, so the retry-once-the-base-
  is-fixed promise survives cleanup for every post-decision exit — the
  planner dying, a refresh conflict, a cancellation mid-apply — and not
  only for the exits someone enumerated. The impasse fingerprint binds
  both positions and their evidence, so a stale log or stamp can no longer
  certify against a different dispute.
- A mixed exhaustion still classifies `NON_CONVERGENCE` (§1), but the
  operator can now see the contest it held: both positions, the open
  blocker that made a park impossible, and the path back to an adjudicable
  impasse.
- A focused scope revision can no longer silently drop a locked path: it
  must preserve the accepted file scope and add the requested paths, or
  it rolls back and errors without dispatching a generator.
- The journal's state machine is honest: PENDING → RUNNING →
  (terminal | parked); parked → RUNNING → …; terminal is final this
  run. Tests assert the machine directly instead of the
  delete-a-terminal backdoor.
- Not changed: PRD 2 scope (#94 out, Story 14 deferred), the bounded
  wait's duration, ADR 0054's one-decision-per-dispatch workflow, the
  decision log's exclusion from the rollback (human input still
  outlives mechanical refusals), and ADR 0050's revision bound.
- Deferred, filed as follow-up: moving `AWAITING-ADJUDICATION` out of
  the `failed` *presentation* bucket. Once no logic reads the bucket
  (decision 6), the remaining harm is a human misled by `afk status`
  grouping — the same bug class one layer up, but cosmetic, with real
  rendering ripple, and not required by any blocker.

## Amendment (fifth round) — §8 applied to the probe that was meant to honour it

Fifth adjudication gate round, architect blockers 2 and 3. Operator-authorized
fix round recorded 2026-08-31. Both are defects in code the *fourth* round added
to satisfy §6 and §8, which is the reason they are recorded here rather than in
a new ADR: the invariant was right, its first implementation was not.

### 10. The estate probe returns a tri-state, and the run records where to look

`findAdjudicationEstate` read ownership off disk (§6) but reported two different
facts as the same `null`:

- **"I walked the worktree and found no estate."** Proved absence.
- **"I could not complete the walk."** Not a fact about the estate at all.

Two ways to reach the second one, both routine. The walk was bounded at six
levels — exactly deep enough for the default
`.kiro/specs/<prd-slug>/slices/<NN>-<slug>/` — while `--prd-dir` accepts any
path, so any deeper `specsDir` fell off the end. And every `readdirSync` failure
returned silently. After either, `clean-failed` deleted the worktree and `adopt`
treated the same incomplete inspection as proof no estate existed. §8 forbids
exactly that, and the code written to honour §8 did it.

**Two repairs, and both are needed:**

1. **Resolve, do not guess.** The run knows its own `specsDir` — it is a launch
   input — so it is persisted as `RunState.specsDir` beside the feature branch
   and handed to the probe. The estate's location is then computed
   (`<worktree>/<specsDir>/slices/*`), one directory is enumerated, and layout
   depth stops being a variable. Optional, because state files predating the
   field must stay loadable.
2. **Never collapse `absent` into `indeterminate`.**
   `probeAdjudicationEstate` returns `present | absent | indeterminate`, and
   `indeterminate` carries its reason. The no-`specsDir` fallback still walks,
   but it walks the **whole** worktree minus `SKIP_DIRS` rather than six levels
   of it, so a completed fallback walk is a real proof of absence; the remaining
   depth bound is a cycle valve set far above any honest layout, and reaching it
   is `indeterminate`, not absence. Symlinked and junctioned directories are not
   descended.

**The two compose asymmetrically, and that asymmetry is the point.** A
`present` from the resolved location short-circuits — that is the answer where
being wrong destroys something, and it costs no walk. A `resolved` result of
`absent` does **not** short-circuit: it proves only that the *recorded*
location holds no estate, and the record can be wrong (relaunching the same PRD
slug with a different `--prd-dir` overwrites `specsDir`; a hand-edited state
file can say anything). Trusting it would be inferring absence from an input
instead of proving it — the same mistake in a new place. So `absent` is always
earned by the complete walk. An `indeterminate` from the resolved location
stands as `indeterminate`: the place the run itself said to look could not be
read, and that is not something to walk past quietly. This composition was
found by the fifth round's own self-probe pass, after the first version of the
fix had already been written.

**Every caller refuses by name on `indeterminate`:** `clean-failed` pass 1 and
pass 2 preserve the directory and put the probe's reason in the report;
`adopt`'s estate check refuses before any ref moves. `absent` is now a claim the
probe has earned.

One implementation note that is load-bearing: whether a path is a directory is
asked with `existsSync`/`statSync`, not classified from the `readdir` errno.
Windows reports `ENOENT` for a read under a plain file, so an errno-only rule
would turn "the run's recorded specs dir is a file" back into proved absence —
the same bug in a new costume. A missing directory is absence (git checked the
tree out from a commit); a path that exists and is not a directory is
`indeterminate`.

The identical decision governs `git.listChangedFiles`, which had the same shape
— three commands, swallowed failures, a partial union returned as if complete.
See ADR 0052's amendment: one honest primitive, and callers that fail closed in
their own direction.

### 11. Adoption is conditional on the record it was authorized against

> **Deferred to PRD `afk-v2-run-state-lock-and-adoption` (2026-08-31), and
> incomplete as written.** The compare-and-swap below is an unlocked
> read-check-write: it loads the state file, compares one slice record, and
> then overwrites the whole file, with no lock spanning the comparison and the
> write. A second process can persist a park in that window, so the claim at
> the end of this section that concurrent corruption is "impossible" overstates
> what the code did — the window is *narrowed*, not closed. Closing it needs a
> cross-process lock held by **every** run-state writer (`saveSliceState`,
> `saveRunState`, `saveReviewPhase`, `recordRetryDecision`,
> `clearSliceStateForDispatch`), which is why adoption moved to its own PRD.
> `saveSliceStateIfUnchanged` and `sameSliceRecord` are not in the tree.

§8 made adoption refuse a park it could see. It could only see the park it
looked for *before* verification: run state and worktrees were read once, the
estate refusal ran, base gates executed for minutes, the feature ref was
compare-and-swapped, and `saveSliceState` then re-read the file and replaced
this slice's record **unconditionally**.

A concurrent run can park the same slice inside that window without moving the
feature branch. The ref CAS therefore still succeeds, the blind write turns
`AWAITING-ADJUDICATION` into `PASS`, and the live estate is stranded with no
slice record owning it — which is the corruption §8 exists to prevent, produced
by the command §8 was written for.

**Adoption now re-asks everything that can change, immediately before
finalization, and its state write is a compare-and-swap on the record observed
before verification.** Concretely:

- Worktrees are re-enumerated, run state re-read, and the estate re-probed
  before the feature ref moves. Enumeration failure is still refusal 6; an
  `indeterminate` probe is a refusal too (§10). A refusal here costs nothing —
  no ref has been touched.
- If the slice's record is no longer the one adoption observed, it refuses and
  names both records. Only the slice's own re-dispatch replaces a park.
- The state write goes through `saveSliceStateIfUnchanged`. If it loses the CAS
  in the remaining window — after the re-check, before the write — the feature
  ref is rolled back with the same guarded update a throwing write already used,
  and the refusal names both outcomes. The two failures leave the same
  inconsistency, so they get the same repair.

`saveSliceState` keeps its unconditional behavior for the pipeline, which owns
the slice it is writing. The conditional form exists for the one caller that
reads a record, spends minutes, and then writes.

### Consequences of the amendment

- `RunState` gains an optional `specsDir`. Nothing refuses a state file without
  it; the probe falls back to a complete walk, which is slower and still honest.
- `clean-failed` and `adopt` can now decline to act for a reason that is neither
  "there is an estate" nor "there is not": the probe could not tell. That is a
  new operator-facing outcome and it is deliberately loud.
- `afk adopt` gains two more refusals — a record that changed during
  verification, and a lost state CAS — which narrows the silent corruption path
  §8 had left open. It does **not** close it: the check and the write are not
  atomic across processes, so a park persisted between them is still lost.
  Adopting a slice a concurrent run is touching is *unlikely* rather than
  last-writer-wins, and making it genuinely impossible is deferred to PRD
  `afk-v2-run-state-lock-and-adoption` (architect A1, sixth gate round).
- Adoption pays one extra worktree enumeration, run-state read and estate probe
  per invocation. Against a command whose middle step is a full base-gate run,
  that is free.
- Not changed: the refusal-not-reconciliation stance (adoption still never
  quiesces an estate for the operator), the estate's two ownership files, and
  every §6 trait.

### Also found by the fifth round's self-probe pass

Two defects the guardians had not reported, found by probing the slice 01/03/06
surface with adversarial input before submitting. Both are the same "prove it,
do not infer it" family:

- **`git.listChangedFiles` returned git's quoted spelling of a non-ASCII path.**
  git's default `core.quotePath` prints a non-ASCII path C-quoted *and* wrapped
  in double quotes, which matches no declared path. The QA scope-amendment door
  therefore refused an honest request for such a file with "not among the files
  this slice changed", and the new escalation guard would have reported it as an
  out-of-scope change — a false accusation manufactured by an output
  convention. The probe now runs with `core.quotePath=false`.
- **A UTF-8 BOM refused a human's adjudication.** `adjudication.md` is the one
  artifact in the pipeline a *human* types, on Windows, where PowerShell's
  `Set-Content` and Notepad both emit a BOM by default. `JSON.parse` then failed
  at position 0, the slice stayed parked, and the operator was told their
  decision "is not valid JSON" with no visible cause. A leading BOM carries no
  semantics, so it is stripped — nothing is guessed at, and the duplicate-key
  scan still sees the whole object. A mark anywhere but the start is still a
  real defect and still refuses.

Reported, not fixed, because each would widen this round's scope and each
already fails closed with a message that names the cause:

- `normalizeAcceptanceManifestPath` accepts control characters inside a path, so
  a path containing one is a "valid" declarable path. Nothing can be written
  there, so the failure lands later — at the planner's revised manifest or at
  the filesystem — rather than at the parse. Tightening it is a manifest-wide
  normalization change.
- `afk adopt` resolves `issues.md` at the hard-coded
  `.kiro/specs/<prd-slug>/issues.md`, so a run launched with a configurable
  `--prd-dir` cannot be adopted. It refuses with "cannot resolve slice … not
  found", which is honest but is a capability gap, not a defect — and
  `RunState.specsDir` (§10) now makes the fix a small one for whoever takes it.
- Adoption's feature-ref CAS uses the `featureBranch` read before verification.
  A run does not rename its own feature branch mid-flight, and the commit CAS
  still protects the ref itself, so the exposure is theoretical.

# Architecture Guardian Review

**Verdict:** FIX-BEFORE-SHIP

## Scope reviewed

Reviewed the feature diff from merge base
`8f97ce6b34e5c268f159d7a48d3d28af83d4c542`, all slice contracts and
implementations under `.kiro/specs/afk-v2-routing-adjudication/slices/`, and
the merged transaction, adjudication, worktree, scheduler, journal, cleanup,
adoption, and finalization paths.

The pre-ship gate already passed this tree, so I did not rerun the full suite.
Fresh evidence below comes from direct source and ADR reads; I also ran
`git diff --check` against the feature diff.

## Blocking findings

### 1. The pending-lock witness can certify a lock that never passed its gate or was rolled back

- **File/location:** `src/contract-transaction.ts`,
  `withContractTransaction` and `tx.lock` (lines 158-241);
  `src/orchestrator.ts`, `applyAdjudicationDecisions` (lines 2442-2453);
  `src/adjudication.ts`, `adjudicatedLockIsProven` (lines 461-479).
- **Evidence gathered:** I read the complete transaction and shortcut control
  flow. `tx.lock` writes the witness, calls `lockContract`, and only then calls
  `onContractLocked`. A process stop between the latter two operations leaves
  witness plus stamped `LOCKED` contract even though the mechanical gate never
  ran; `adjudicatedLockIsProven` accepts that pair. Separately,
  `lockAccepted = true` preserves the witness before the caller writes the
  applied marker. If that marker write throws, the outer transaction restores
  the old contract because `onAccepted` was not called but leaves the witness.
  When the restored contract was stale `LOCKED`, the next dispatch accepts the
  surviving witness and skips both application and the gate.
- **Convention violated:** ADR 0055, **Decision - Seam 1**, section 2 permits
  `LOCKED` only after the mechanical gate passes; section 3 requires restoration
  on every exit not explicitly accepted through `onAccepted`; section 5 permits
  the crash shortcut only for proof of the completed lock operation. This also
  breaks ADR 0008, **Decision**, which makes orchestrator-owned on-disk lock
  status authoritative.
- **Required fix:** Run the mechanical gate before writing `LOCKED`, and clear
  the pending witness on every transaction exit that did not reach
  `onAccepted`. Add focused fault-injection coverage for a stop before the gate
  and for an applied-marker write failure over a previously locked contract.

### 2. Resumed IMPASSE dispatch bypasses the worktree ownership assertion

- **File/location:** `src/orchestrator.ts`, `runSliceNegotiate`
  (lines 2053-2078), `runImpasseAdjudication` (lines 2113-2274),
  `prepareSliceWorktree` (lines 1698-1979), and `negotiateAttempt`
  (lines 2520-2529).
- **Evidence gathered:** I traced both branches from `runSliceNegotiate`.
  Finding an existing IMPASSE calls `runImpasseAdjudication` immediately.
  The only shared call to `prepareSliceWorktree`, whose final operation is
  `git.assertWorktreeRegistered`, is inside `negotiateAttempt` and is therefore
  skipped. The IMPASSE path later merges into `ctx.worktreeDir` and can invoke
  agents from it. A leaked directory no longer registered with Git can
  consequently make Git walk up to the parent repository, the corruption mode
  this invariant exists to prevent.
- **Convention violated:** ADR 0010, **Decision**, item 3 requires
  `assertWorktreeRegistered` immediately before every agent dispatch. ADR 0055,
  **Decision - Seam 2**, requires lifecycle operations to prove preservation
  of the parked worktree and branch.
- **Required fix:** Put shared worktree ownership and registration validation
  before ordinary-versus-IMPASSE routing, so every dispatch validates the same
  boundary before Git mutation or agent invocation. Cover redispatch from a
  stale unregistered parked directory.

### 3. Partial adjudication redispatch does not reopen its persisted park

- **File/location:** `src/orchestrator.ts`, `runImpasseAdjudication`
  (lines 2202-2234 and 2263-2272), and scheduler redispatch
  (lines 5234-5249); `src/run-journal.ts`, `RunJournal.recordTerminal`
  (lines 332-357); `src/run-journal.test.ts`, same-phase park case
  (lines 213-230).
- **Evidence gathered:** I traced an IMPASSE with multiple findings through a
  valid first decision. The scheduler removes the hold-back and redispatches,
  but no `trackSlice` occurs before `runImpasseAdjudication` returns a new
  `AWAITING-ADJUDICATION` outcome naming the remaining findings; its only
  `trackSlice` call is after the all-decided check. `recordTerminal` sees the
  existing parked phase and returns it unchanged solely because the phase
  matches. The test explicitly confirms that even a changed error is discarded.
  State, events, and summary therefore retain the prior park instead of the
  replacement that names what remains undecided.
- **Convention violated:** ADR 0054, **Decision**, item 3 requires each partial
  adjudication to park again naming the findings still undecided. ADR 0055,
  **Decision - Seam 2**, section 9 defines redispatch as the reopen and requires
  `trackSlice` to clear the parked mark and persisted record before a new
  outcome.
- **Required fix:** Reopen every actual parked redispatch with `trackSlice`
  before processing its decision, including partial and refused decisions, then
  persist the replacement park. Add a journal-level or existing orchestration
  assertion that the persisted reason changes from all findings to the
  remaining set.

## Architecture assessment

The merged design otherwise establishes the intended shared contract
transaction, full-blocker completion predicate, durable cleanup trait,
idle-only scheduler wait, fail-closed adoption guard, and single STUCK
finalizer. The blockers are boundary-ordering defects in those abstractions,
not style differences: each permits persisted state to claim an invariant that
the responsible operation did not establish.

# Architecture Guardian Review

**Verdict:** FIX-BEFORE-SHIP

## Scope reviewed

Reviewed `git diff 8f97ce6...HEAD`, every slice artifact under
`.kiro/specs/afk-v2-routing-adjudication/slices/`, the PRD, and ADRs
0050-0055. I traced the merged escalation, adjudication, contract
transaction, journal, wave, cleanup, and adoption paths.

The pre-ship gate already passed this tree, so I did not rerun the full
suite. I ran only the focused commands cited below.

## Blocking findings

### 1. The impasse fingerprint does not identify the dispute the human decided

- **File/location:** `src/adjudication.ts`, `impasseFingerprint()` at
  lines 198-213; consumers `loadAdjudicationDecisionLog()` and
  `reconcileDiscardedDecisionLog()`.
- **Evidence gathered:** I read `ContractReviewAttemptFinding` in
  `src/contract-review.ts` and confirmed that the persisted impasse carries
  `plannerPosition`, `plannerEvidence`, `evaluatorEvidence`, and
  `unresolved`. The fingerprint hashes only round, attempt, finding ID,
  severity, and state. I ran an inline `node --import tsx` probe with two
  IMPASSE outcomes having identical IDs/state but different planner and
  evaluator evidence; both produced
  `c17e69d2ecb0fb69796af2abf7c27f360a369b13bbb29cefe6a898233bb73574`.
- **Defect:** A fresh negotiation can reuse round 2, attempt 1, and the same
  finding IDs while changing the positions or evidence being adjudicated.
  The old decision log then validates against the new impasse. A stamped
  lock can likewise self-certify against the incomplete identity, allowing
  generation under a human decision made for a different question.
- **Convention violated:** ADR 0054, **Consequences**, says a renegotiated
  contract's decisions are non-transferable because a decision answers the
  two recorded positions. ADR 0055, **Seam 1 sections 4-5**, relies on this
  fingerprint as lock provenance and as the pending-lock witness's impasse
  identity.
- **Required fix:** Fingerprint the complete canonical question-bearing
  impasse data, including both positions/evidence and unresolved status (or
  the canonical raw outcome), and prove that changing any of those fields
  invalidates the decision log and lock provenance.

### 2. A mechanical adjudication refusal makes durable human evidence disposable

- **File/location:** `src/orchestrator.ts`,
  `runImpasseAdjudication()`/`revalidateAdjudicatedLock()` at lines
  2181-2201 and 2214-2232; `src/slice-lifecycle.ts`, the `ESCALATE` trait at
  lines 271-278; `src/clean-failed.ts`, `isCleanupTarget()` and pass 1;
  `src/adopt-command.ts`, `parkedEstateRefusal()`.
- **Evidence gathered:** I traced re-dispatch from its initial
  `logger.trackSlice(RUNNING)`, which clears the park, through both lock-gate
  refusal paths, which return terminal `ESCALATE`. I ran an inline trait
  probe: `AWAITING-ADJUDICATION` reports `debris: "preserve-all"`, while
  `ESCALATE` reports `debris: "disposable"`. I also ran the focused
  clean-failed test; it confirms pass 1 removes a disposable worktree and
  preserves only the `preserve-all` park. The focused adoption tests passed
  but guard only records whose phase has that same `preserve-all` trait.
- **Defect:** The decision log lives inside the slice worktree. After a
  lock-gate objection, pipeline persistence changes the record to
  `ESCALATE`. `afk clean-failed` may then remove that worktree and the human
  decisions, and `afk adopt` no longer recognizes the slice as owning an
  estate. This contradicts the refusal path's promise that the same
  decisions can be retried after the mechanical objection is fixed.
- **Convention violated:** ADR 0054, **The decision log is not part of the
  transaction**, requires human input to outlive a mechanical refusal. ADR
  0055, **Seam 2 invariant** and **Consequences**, requires the adjudication
  estate to remain protected and repeats that the decision log outlives
  mechanical refusals.
- **Required fix:** Persist adjudication-estate ownership independently of
  the broad `ESCALATE` phase (or use a state variant that retains
  `preserve-all`), and make cleanup and adoption consult it. Add a focused
  flow from lock-gate refusal through `clean-failed` and adoption, asserting
  the decision log, worktree, branch, and retry path remain coherent.

## Note

`RunJournal.recordTerminal()` calls two parks identical when only phase and
error match. ADR 0055 section 9 says idempotency covers the whole record;
branch identity is not compared. Current branch naming is deterministic
within a run, so I do not classify this as a ship blocker, but the invariant
and implementation should be aligned before branch identity becomes mutable.

## Focused verification

- `git diff --check 8f97ce6...HEAD` - passed.
- `pnpm vitest run src/contract-transaction.test.ts src/scope-amendment.test.ts`
  - 31 passed.
- Focused `src/clean-failed.test.ts` case - passed.
- Focused parked-estate cases in `src/adopt-command.test.ts` - 2 passed.
- Focused adjudicated lane-successor case in `src/wave.test.ts` - passed.

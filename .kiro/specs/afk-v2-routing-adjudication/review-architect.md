# Architecture Guardian Review

**Verdict:** FIX-BEFORE-SHIP

## Scope reviewed

Reviewed `git diff origin/main...HEAD`, the PRD, all slice contracts and
implementation handoffs under
`.kiro/specs/afk-v2-routing-adjudication/slices/`, and the production paths
for escalation, impasse parking, adjudication, stuck diagnosis, adoption,
persistence, reporting, and Git finalization. The pre-ship gate was accepted
as already passed. I ran only the focused adjudication scenario:

`pnpm vitest run src/orchestrator.test.ts -t "parks a contested round-two exhaustion for adjudication"`

It passed and exposed the current multi-finding lock sequence described
below.

## Blocking findings

### 1. One adjudication resolves one finding but locks a contract with other contested findings still open

- **File/location:** `src/adjudication.ts`, `parseAdjudication` (lines
  37-123), and `src/orchestrator.ts`, `runSliceNegotiate` (lines
  2065-2185). The proving fixture is `src/orchestrator.test.ts`, lines
  2921-2938 and 2962-2997.
- **Evidence gathered:** I read the parser and lock path, then ran the
  focused test above. The fixture's IMPASSE contains both `F-01` and `F-02`
  as `CONTESTED`. Its adjudication names only `F-01`. The run output then
  reports `accepted adjudication for F-01; contract LOCKED`. The parser
  checks only that the selected finding exists and is contested; the lock
  path never checks for remaining contested findings.
- **Convention violated:** ADR 0008, **Decision**, makes the orchestrator's
  on-disk `LOCKED` status the single source of truth. Here that status says
  the contract is settled while the current structured impasse still says
  another blocking finding is contested. The PRD's adjudication rule also
  states that a human decision resolves a finding, not the whole contract.
- **Required fix:** Make the state model honest for multi-finding impasses.
  Either refuse an impasse/adjudication shape with more than one contested
  finding, or persist decisions per finding and permit `LOCKED` only after
  every contested blocking finding has a valid decision applied.

### 2. The apply-and-lock step has no transaction or durable applied state, so rejected and completed decisions can replay

- **File/location:** `src/orchestrator.ts`, `runSliceNegotiate` (lines
  2065-2248), especially `lockAdjudicatedContract` and the evaluator-winner
  / third-instruction planner invocation. The revealing assertions are in
  `src/orchestrator.test.ts`, lines 3007-3041.
- **Evidence gathered:** I read every exit from the apply path and searched
  the source for removal, consumption, or an applied marker for
  `adjudication.md` / `contract-negotiation-outcome.json`; none exists.
  Validation or lock-gate refusal returns `ESCALATE` without restoring the
  pre-apply contract and manifest. The focused test manually rewrites both
  files to `contractBefore` / `manifestBefore` between refusal cases,
  confirming production performs no rollback. Because the same two working
  artifacts remain, a later run enters the IMPASSE branch and invokes the
  apply planner again. Worse, a rejected behavior renumbering becomes the
  next run's `preApplyManifest`, so the same renumbered result can pass the
  stability comparison on retry.
- **Convention violated:** ADR 0008, **Decision**, requires one trustworthy
  orchestrator-owned contract state. ADR 0051, **Decision**, records the
  transaction rule already used by the sibling focused-revision path:
  capture the authoritative contract and manifest before mutation and
  restore them on every exit that does not reach an accepted lock. The
  adjudication path mutates the same authoritative pair but omits that
  guarantee.
- **Required fix:** Give adjudication application a durable lifecycle:
  snapshot and restore both files on every non-success exit, and record or
  consume the applied decision atomically with a successful lock so later
  implementation retries do not apply it again. Add focused tests proving
  rollback after planner/validation/lock refusal and no second planner apply
  after a successful adjudication followed by an implementation retry.

## Non-blocking notes

1. `runFocusedScopeRevision` duplicates the ordinary planner/evaluator/
   archive/validate/lock protocol. ADR 0050 and ADR 0051, **Consequences**,
   already identify this shotgun-surgery risk. A shared revision protocol
   would reduce the chance that the transaction, archive, and lock rules
   diverge again.

2. `RunJournal.reopenAdjudication` deliberately removes a current run's
   terminal marker so the slice can be dispatched again. That is a practical
   exception to ADR 0031's single terminal-record seam and ADR 0047's
   **What is deliberately not cleared** rule. Model the park as a replaceable
   transition, or amend those ADRs so future journal work does not treat this
   escape hatch as an accidental invariant breach.

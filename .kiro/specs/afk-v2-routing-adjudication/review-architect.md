# Architecture Guardian Review

**Verdict:** FIX-BEFORE-SHIP

## Scope reviewed

Reviewed `git diff main...HEAD`, the PRD and slice index, every slice
contract and implementation handoff under
`.kiro/specs/afk-v2-routing-adjudication/slices/`, and the merged production
paths for escalation, impasse classification, adjudication, wave scheduling,
cleanup, stuck diagnosis, adoption, persistence, and Git finalization.

The pre-ship gate was accepted as already passed; I did not rerun the full
suite. For fresh evidence I used source reads/searches and two pure probes:
one confirmed `AWAITING-ADJUDICATION` is assigned the `failed` lifecycle
bucket, and one confirmed a mixed `CONTESTED` + `OPEN` exhaustion is classified
`IMPASSE` with no undecided findings after only the contested finding is
decided.

## Blocking findings

### 1. A mixed exhaustion can lock while an OPEN blocking finding remains unresolved

- **File/location:** `src/contract-review.ts`,
  `buildContractNegotiationOutcome` (lines 718-735);
  `src/adjudication.ts`, `contestedFindingIds` and
  `undecidedContestedFindingIds` (lines 197-204 and 341-350);
  `src/orchestrator.ts`, `runImpasseAdjudication` (lines 2185-2222).
- **Evidence gathered:** I read the classification and completion predicates,
  then ran a pure TypeScript probe with one `F-C/CONTESTED` blocker and one
  `F-O/OPEN` blocker. The outcome was `IMPASSE`, retained both findings, and
  reported `undecided: []` after a decision only for `F-C`. The orchestrator
  therefore reaches the lock path while `F-O` is still unresolved.
- **Convention violated:** ADR 0008, **Decision**, makes the orchestrator's
  on-disk `LOCKED` status the trustworthy source of contract state. ADR 0054,
  **Decision**, says a decision resolves one finding rather than the contract
  and permits locking only after the complete required decision set is in.
  Locking with an `OPEN` blocking finding makes `LOCKED` contradict the
  structured exhaustion record.
- **Required fix:** Define mixed exhaustion explicitly. Either classify it as
  non-convergence until every OPEN blocker is resolved, or keep it parked but
  prohibit locking while any unresolved blocking finding remains. Add a pure
  mixed-state test and an orchestration assertion that generation never
  dispatches from this shape.

### 2. Discarding a decision log can leave a false LOCKED contract and later bypass application

- **File/location:** `src/adjudication.ts`,
  `loadAdjudicationDecisionLog` (lines 219-298);
  `src/orchestrator.ts`, `runImpasseAdjudication` (lines 2132-2183 and
  2203-2222).
- **Evidence gathered:** I read the fail-closed loader and its existing focused
  tests. A malformed, stale, or invalid log becomes an empty log plus a
  `discarded` reason. The orchestrator logs that every finding must be decided
  again and parks, but it does not reopen a contract that is already
  `LOCKED`. Once replacement decisions are collected, the
  `readContractStatus(contractPath) === "LOCKED"` shortcut marks them applied
  without running their mechanical apply-and-lock step.
- **Convention violated:** ADR 0054, **Decision** steps 1 and 3, says a
  discarded log is evidence rather than authority and that only a valid
  complete record permits locking. ADR 0008, **Decision**, forbids the disk
  saying `LOCKED` while the orchestrator says every contested finding needs a
  new decision.
- **Required fix:** Reconcile contract status when the log is discarded, and
  make the crash-window shortcut prove that the existing lock corresponds to
  the same validated complete decision set. A replacement decision set must
  be applied and pass the lock gate rather than inherit an unrelated
  `LOCKED` line.

### 3. The bounded adjudication wait blocks unrelated later waves

- **File/location:** `src/orchestrator.ts`, wave reconciliation in
  `runPipeline` (lines 5106-5164), especially the `await wait` at line 5138.
- **Evidence gathered:** I traced the scheduling sets and loop order. After
  `runWave` returns, outcomes are reconciled serially. Encountering one
  `AWAITING-ADJUDICATION` outcome awaits its human timer before reconciliation
  finishes and before the next `dag.ready(completed)` call. Thus a dependent
  of an unrelated PASS slice cannot enter its next wave until the decision
  arrives or the wait expires.
- **Convention violated:** ADR 0024, **Decision**, requires independent work to
  continue after a member needs human attention; dependency safety belongs to
  the DAG, not incidental lane or outcome ordering. The PRD's routing decision
  likewise permits waiting at idle, not before checking whether another wave
  is ready.
- **Required fix:** Reconcile all outcomes and dispatch all newly ready work
  before awaiting adjudication promises. Wait only when no runnable work
  remains, while still allowing a valid decision to re-enqueue its slice.
  Cover a parked slice plus an unrelated PASS whose dependent must start
  before the adjudication timeout.

### 4. `clean-failed` treats a parked slice as disposable failure debris

- **File/location:** `src/slice-lifecycle.ts`, `PHASE_TRAITS` for
  `AWAITING-ADJUDICATION` (lines 240-247); `src/clean-failed.ts`,
  `isCleanupTarget`/`mustPreserveBranch` (lines 47-61) and the removal/deletion
  pass (lines 153-223).
- **Evidence gathered:** I read the cleanup predicate and ran
  `traitsFor("AWAITING-ADJUDICATION")`; it returned `bucket: "failed"`.
  `clean-failed` therefore removes the parked worktree. Because the phase is
  not `deferred`, it also deletes the branch when it has no commits ahead,
  which is the normal pre-generation impasse shape. Searches found no
  `AWAITING-ADJUDICATION` coverage in `src/clean-failed.test.ts`.
- **Convention violated:** ADR 0023, **Decision**, scopes the command to dead
  failure phases and preserved debris; a parked external dependency is not
  one of those phases. ADR 0054, **Decision**, requires the impasse and durable
  human decision record to survive across dispatches and runs.
- **Required fix:** Separate cleanup eligibility from the presentation bucket.
  `AWAITING-ADJUDICATION` must preserve its worktree and branch, and
  `clean-failed` must report/skip it. Add a focused cleanup test proving the
  impasse, adjudication file/log, branch, and worktree remain intact.

### 5. `afk adopt` fails open when Git worktree enumeration fails

- **File/location:** `src/adopt-command.ts`, `worktreesHolding` (lines
  259-278) and its caller in `runAdoptCli` (lines 404-416);
  `src/git.ts`, `listWorktrees` (lines 906-921) and
  `updateBranchIfUnchanged` (lines 882-899).
- **Evidence gathered:** I read the worktree guard and finalization path.
  `worktreesHolding` catches every `git worktree list` failure and returns
  `[]`, which is indistinguishable from a proved absence. Adoption then
  continues to an `update-ref` that can move a checked-out feature branch
  behind its worktree. The focused tests cover a successfully enumerated
  holder, but not enumeration failure.
- **Convention violated:** ADR 0010, **Decision**, requires worktree identity
  to be verified rather than trusted. ADR 0053, **Operator-visible
  refusals** item 5, specifically requires adoption to refuse when the feature
  branch is checked out because moving only its ref corrupts the worktree's
  index/tree relationship.
- **Required fix:** Make enumeration failure a named refusal before candidate
  creation or ref mutation. Inject the worktree lister at the command seam and
  test that a thrown enumeration leaves refs and run state unchanged.

## Non-blocking notes

1. `runFocusedScopeRevision` and `runImpasseAdjudication` still duplicate the
   capture/restore/validate/lock transaction. ADR 0050, ADR 0051, and ADR
   0054, **Consequences**, already identify this shotgun-surgery risk; the
   defects fixed during this review cycle demonstrate that it is active debt.

2. `RunJournal.reopenAdjudication` deliberately removes terminal idempotency
   so a parked slice can receive a later outcome in the same run. That is a
   necessary workflow seam, but it is an undocumented exception to ADR 0031,
   **Decision**, and ADR 0047, **What is deliberately not cleared**. Model a
   park as a replaceable transition or amend those ADRs before future journal
   work treats the exception as accidental corruption.

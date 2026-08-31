# Implementation plan — adjudication state model redesign (ADR 0055)

Companion to ADR 0055. Maps each round-5 blocker (A1–A5 architect, P1
PM) to the seam that eliminates it, with the failing probe/test that
must go green. The probes are the ones the round-5 guardians already
ran — encoded as vitest assertions, placed per the AGENTS.md ladder
(unit test → existing spawned scenario → new slice in an existing wave
→ new scenario). No test wall-clock budget changes.

Baseline: `feat-codex/afk-v2-routing-adjudication` @ `672d53d`.
Verification per step and at the end: `pnpm typecheck && pnpm
test:fast`, plus `test:heavy:orchestrator`, `test:heavy:wave`,
`test:heavy:clean` where named. Line references below are to `672d53d`.

## Build order

Seam 1 steps 1–3 first (they change what "locked" means; everything
else asserts around it), then Seam 2 steps 4–7, then P1 (step 8),
independent of both seams after step 1's predicate exists. Step 9
(estate audit) runs last, once every operation it audits has its final
shape.

### Step 1 — classification + single completion predicate (A1, Seam 1)

- `src/contract-review.ts` `buildContractNegotiationOutcome`
  (~718–735): classify `IMPASSE` only when **every** unresolved
  BLOCKING finding is `CONTESTED`; any unresolved `OPEN` blocker ⇒
  `NON_CONVERGENCE` (ADR 0055 §1).
- `src/adjudication.ts`: add `unresolvedBlockingFindingIds(outcome,
  log)` over all unresolved blocking findings (OPEN + CONTESTED);
  the lock path consults only this predicate.
  `undecidedContestedFindingIds` callers migrate to it (park messages
  may still render the contested subset for the courier).
- **Failing probes (architect probe 2, re-encoded):**
  - Unit, `src/contract-review.test.ts`: one `F-C/CONTESTED` + one
    `F-O/OPEN` blocker ⇒ classification `NON_CONVERGENCE`, both
    findings retained. (Today: `IMPASSE`.)
  - Unit, `src/adjudication.test.ts`: predicate over that shape with a
    decision only for `F-C` ⇒ `F-O` still unresolved; lock refused.
    (Today: `undecided: []`.)
  - Orchestration assertion in an **existing**
    orchestrator adjudication scenario: generation is never dispatched
    from a mixed-exhaustion shape. No new spawned scenario.

### Step 2 — shared contract-mutation transaction (Seam 1 §3; C/D guards)

- New `src/contract-transaction.ts` (or a seam in `orchestrator.ts`):
  `withContractTransaction(ctx, fn)` — capture `contract.md` +
  `acceptance-manifest.json`, `finally`-restore unless `onAccepted`
  fired, announce rollback (ADR 0051 mechanics, extracted verbatim).
  Single lock exit runs the completion predicate (step 1) and the
  mechanical lock gate.
- `runFocusedScopeRevision` (~1110) and the adjudication apply path in
  `runImpasseAdjudication` (~2185–2260) become callers; their private
  copies of capture/restore/lock are deleted.
- The QA scope amendment (`applyScopeAmendment` + its archive, in the
  QA loop) is the third caller — it widens the same pair without
  locking, so it passes no `completion` and never calls `tx.lock`.
- **Guards:** the existing Track C/D focused tests (lock-gate bypass,
  one-decision-per-finding) and the ADR 0051 rollback tests stay green
  unmodified — they are the regression net proving the extraction
  changed nothing behavioural.

### Step 3 — lock provenance stamp; witnessed crash window (A2, Seam 1 §4–5)

- `src/artifacts.ts` `lockContract`: gains a provenance argument; the
  transaction's lock exit writes an orchestrator-owned
  `**Lock-Provenance:**` line (impasse fingerprint, escalation id, or
  `negotiation round N`) alongside a byte-identical
  `**Status:** LOCKED` line. `readContractStatus` untouched; a new
  reader parses the stamp. Every lock exit stamps — no special cases.
- `src/adjudication.ts`: decision-log schema gains an optional
  `pendingLock` witness (fingerprint of decision-set raw bytes +
  impasse fingerprint); `markAdjudicationDecisionsApplied` clears it.
  Loader validates it like everything else (fail-closed).
- Transaction lock exit (step 2): write witness → mechanical lock gate
  → stamped `lockContract` → mark applied, and clear the witness on
  every transaction exit that did not reach `onAccepted`. Amended after
  the gate round's architect blocker 1; see ADR 0055 §5 for why the gate
  moved ahead of the lock and why the clear moved out to the
  transaction's own exit.
- `runImpasseAdjudication` (~2132–2183): on `loaded.discarded` with a
  `LOCKED` contract, reconcile by stamp — matching current impasse
  fingerprint ⇒ lock stands, loss announced; unstamped or mismatched ⇒
  reopen, announce, full apply-and-lock on replacement decisions. The
  already-applied shortcut (~2203–2222) requires `log.applied` **or**
  a matching `pendingLock` witness; bare `LOCKED` no longer suffices.
- Fact-check during implementation: confirm when
  `contract-negotiation-outcome` files are deleted/overwritten, so a
  stale outcome file cannot shadow a later ordinary lock.
- **Failing probes (architect finding 2 scenario):**
  - Focused test: stale unstamped `LOCKED` + malformed log ⇒ dispatch
    reopens and parks; replacement decisions drive a full
    apply-and-lock (planner invoked, lock gate run) — not inherited.
  - Unit: discarded log + lock stamped with the current impasse ⇒ lock
    stands (scenario Y — corrupted applied log does not destroy a
    legitimate lock).
  - Unit: `LOCKED` + complete unapplied log + matching witness ⇒
    marked applied without re-apply (crash window). Missing/mismatched
    witness ⇒ reconcile + full apply.

### Step 4 — journal park transition (Seam 2 §9; 0031/0047 resolution)

- `src/slice-lifecycle.ts`: `PHASE_TRAITS` gains
  `replaceableThisRun: true` for `AWAITING-ADJUDICATION` only.
- `src/run-journal.ts`: `recordTerminal` routes replaceable phases
  into a `parkedSlices` set (same persist/project/emit ordering);
  same-park re-record is idempotent over the *whole* record (phase and
  reason); a different terminal, or a changed park, without an
  intervening `trackSlice` throws; `trackSlice` clears the parked mark
  (and the persisted record, per ADR 0047). Delete
  `reopenAdjudication`. `runImpasseAdjudication` takes the reopen at its
  entry, so a partial or refused decision persists its replacement park
  (gate round, architect blocker 3; closes #141).
- **Failing tests:** unit, `src/run-journal.test.ts` — the park state
  machine directly: park → re-park idempotent; park → terminal without
  dispatch throws; park → `trackSlice` → terminal succeeds and clears
  the persisted park. Replace the existing `reopenAdjudication` test
  (line ~189).

### Step 5 — scheduler waits only at idle (A3, Seam 2 §7)

- `src/orchestrator.ts` `runPipeline` reconciliation (~5106–5164):
  recording a park no longer `await`s its wait (~5138). After
  reconciling all outcomes, loop back to `dag.ready(completed)`; only
  when `toRun` is empty and live waits remain, `Promise.race` them
  **together with the abort signal** — accepted ⇒ clear park (step 4
  semantics) and re-enter the loop; expired ⇒ drop the wait, slice
  stays parked; aborted ⇒ normal cancellation sweep, park untouched;
  all expired + nothing runnable ⇒ exit. The wall-clock ceiling (ADR
  0019) keeps running during the idle wait — deliberate, per ADR 0055.
- **Failing probe (architect finding 3 scenario):** add to an existing
  wave/orchestrator adjudication fixture if one reaches the shape,
  else one new slice in an existing wave fixture: parked slice A +
  unrelated PASS slice B with dependent C ⇒ C dispatches **before**
  A's adjudication wait resolves/expires. Plus: abort during the idle
  wait returns promptly with the park intact. Verify with
  `test:heavy:orchestrator` + `test:heavy:wave`.

### Step 6 — clean-failed preserves parks (A4, Seam 2 §6)

- `src/slice-lifecycle.ts`: traits gain a cleanup-disposition axis
  (e.g. `debris: "disposable" | "preserve-branch" | "preserve-all"`);
  `AWAITING-ADJUDICATION` ⇒ `preserve-all`. Presentation `bucket`
  untouched.
- `src/clean-failed.ts` `isCleanupTarget`/`mustPreserveBranch`
  (~47–61): key off the trait; parked slices are skipped with a named
  report entry.
- **Failing probes (architect probe 1, re-encoded):**
  - Unit: `traitsFor("AWAITING-ADJUDICATION")` cleanup disposition is
    `preserve-all` (probe showed `bucket: "failed"` driving deletion).
  - Focused test in the existing `clean-failed` suite: a parked slice
    keeps impasse record, `adjudication-decisions.json`, branch, and
    worktree; the report names the skip. Verify with
    `test:heavy:clean`.

### Step 7 — adopt refuses on enumeration failure (A5, Seam 2 §8)

- `src/adopt-command.ts` `worktreesHolding` (~259–278): remove the
  catch-all; enumeration failure surfaces as `Adoption refused: could
  not enumerate worktrees — <error>` **before** candidate creation or
  ref mutation (new refusal 6 in the ADR 0053 list). Inject the
  worktree lister at the command seam (default `git.listWorktrees`).
- **Failing test (architect finding 5):** existing adopt suite — a
  lister that throws ⇒ named refusal, exit 1, refs and run state
  byte-identical.
- Refusal 7 (second gate round): the same single enumeration also
  answers "does the slice being adopted still hold a parked estate?",
  keyed on the phase's `preserve-all` debris trait.
- **Superseded (fourth gate round):** refusal 7 and step 6 both read
  ownership off disk (`findAdjudicationEstate`) instead of off the phase
  trait, and refusal 7 matches the registered *expected path* as well as
  the branch so a detached worktree fails closed. See ADR 0055 Seam 2 §6
  and §8 for why the phase was the wrong carrier.

### Step 8 — migration-sync STUCK goes through the finalizer (P1)

- `src/orchestrator.ts`: `finishStuck` (~3743–3753) takes a reason
  (default: today's round-exhaustion message); the migration-sync
  branch (~4254–4262) calls `finishStuck` with `Migration sync check
  failed: …` instead of returning `STUCK` inline.
- **Failing test (PM finding 1):** narrow assertion in the existing
  orchestration fixture that exercises `verifyMigrationSync` failure:
  `stuck.md` exists and names the migration-sync reason.

### Step 9 — estate audit: the invariant as a checklist (A6 insurance)

Steps 4–7 route the three operations the round-5 reviews caught
through the Seam 2 invariant. The invariant claims **every** lifecycle
operation, so the next blocker lives in the unaudited ones.
Enumerate every operation that touches a slice's dir, worktree, or
branch, and for each add one assertion in an **existing** fixture that
a parked slice's estate (impasse record, `adjudication-decisions.json`,
in-flight `adjudication.md`, worktree, branch) survives — or that the
operation refuses by name. Known list to start from; the enumeration
itself is part of the step:

- lane refresh (`recreateWorktreeFromBase` + stale-artifact deletion) —
  slice 03 already covers this; keep as the pattern.
- the cancellation sweep (ADR 0003) and `afk stop` (ADR 0043) — slice
  02 covers park-through-cancellation; confirm the estate assertion is
  explicit, not incidental.
- restart preflight and archives (ADR 0039, ADR 0042).
- resume (`decideResume`) and `--only-failed` selection.
- the crash-after-redispatch window: `trackSlice` cleared the park
  record, the run dies before a new outcome ⇒ next run's negotiate
  entry re-reads the persisted exhaustion outcome and re-parks with
  the decision log intact. One assertion in an existing resume
  fixture.

Mostly one `expect` each; no new spawned scenarios and no budget
change expected — if the enumeration surfaces an operation no fixture
reaches, that operation goes to the plan as its own finding rather
than a silent new scenario.

## Blocker → seam → probe summary

| Blocker | Eliminated by | Failing probe that must go green |
|---|---|---|
| A1 mixed exhaustion locks over OPEN | Seam 1 §1–2 (step 1) | mixed shape ⇒ `NON_CONVERGENCE`; predicate refuses lock with OPEN undecided; no generation from mixed shape |
| A2 stale LOCKED inherited after discard | Seam 1 §4–5 (step 3) | discard reopens; replacement set fully applied; witness proves crash window |
| C/D regressions (lock-gate bypass, one-per-finding) | Seam 1 §3 (step 2) | existing focused tests unchanged and green through the extraction |
| A3 park stalls unrelated waves | Seam 2 §7 (step 5) | dependent of unrelated PASS starts before adjudication timeout |
| A4 clean-failed deletes park | Seam 2 §6 (step 6) | park's estate intact; skip reported by name |
| A5 adopt fails open on enumeration | Seam 2 §8 (step 7) | thrown enumeration ⇒ named refusal; refs/state unchanged |
| P1 migration-sync STUCK has no stuck.md | shared finalizer (step 8) | `stuck.md` written with migration-sync reason |
| 0031/0047 exception (`reopenAdjudication`) | Seam 2 §9 (step 4) | park state machine asserted at journal interface |
| A6 (the one nobody has found yet) | Seam 2 invariant audit (step 9) | every estate-touching lifecycle op has a preserve-or-refuse assertion |

Found by the gate round's architect review of this plan's own
implementation, and fixed on `design/gate-blockers`:

| Blocker | Eliminated by | Probe that must stay green |
|---|---|---|
| Witness certifies an ungated or rolled-back lock | Seam 1 §5 amendment | gate observes a non-LOCKED contract; a lock whose bookkeeping throws leaves no witness |
| Resumed IMPASSE / adjudicated successor dispatch skips `assertWorktreeRegistered` | Seam 2 amendment (shared check ahead of the routing fork) | redispatch into a stale unregistered parked dir refuses before any git mutation or agent |
| Partial adjudication redispatch does not reopen its park (#141) | Seam 2 §9 amendment | persisted park reason changes from all findings to the remaining set; a changed park with no dispatch throws |

Found by the gate round's *second* architect review, and fixed on
`design/gate-blockers-2`:

| Blocker | Eliminated by | Probe that must stay green |
|---|---|---|
| Adjudicated lane successor's proven lock skips the gate after its base changes | Seam 1 §5 second amendment (`revalidateAdjudicatedLock`, both `LOCKED` shortcuts) | an objection injected after an accepted lock refuses the re-entry with the estate byte-identical; the lock is accepted again once the objection clears; the wave's own gate closure is reached through the lane refresh |
| Adoption orphans a parked worktree and the next launch refuses | Seam 2 §8 amendment (refusal 7, keyed on the `preserve-all` debris trait) | adopt refuses while the park holds a registered worktree, before the candidate merge; after the operator quiesces it, adoption succeeds and the next launch's preflight finds nothing |
| QA scope amendment bypasses the accepted-pair transaction | Seam 1 §3 amendment (third caller of `withContractTransaction`) | a throw after the manifest write — the contract refusal, and a failure in the step after it — leaves both files byte-identical; a completed amendment keeps both |

## Non-goals

- No PRD 2 scope change: #94 stays out, Story 14 stays deferred.
- No presentation-bucket change for `AWAITING-ADJUDICATION` — filed as
  a follow-up once no logic reads the bucket (ADR 0055 consequences).
- No test wall-clock budget raise; new assertions follow the AGENTS.md
  placement ladder (steps above name their target suites).
- No change to the bounded wait's duration, ADR 0054's
  one-decision-per-dispatch workflow, or ADR 0050's revision bound.
- Gate reopen is the operator's, after this plan's implementation
  track merges to the feature branch and
  `typecheck + test:fast + test:heavy:{orchestrator,wave,clean}` are
  green.

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
independent of both seams after step 1's predicate exists.

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
- **Guards:** the existing Track C/D focused tests (lock-gate bypass,
  one-decision-per-finding) and the ADR 0051 rollback tests stay green
  unmodified — they are the regression net proving the extraction
  changed nothing behavioural.

### Step 3 — discard reconciles status; lock witness (A2, Seam 1 §4–5)

- `src/adjudication.ts`: decision-log schema gains an optional
  `pendingLock` witness (fingerprint of decision-set raw bytes +
  impasse fingerprint); `markAdjudicationDecisionsApplied` clears it.
  Loader validates it like everything else (fail-closed).
- Transaction lock exit (step 2): write witness → `lockContract` →
  mark applied.
- `runImpasseAdjudication` (~2132–2183): on `loaded.discarded`, if
  `readContractStatus === "LOCKED"` and no valid applied/witnessing
  log exists, reopen the contract and announce it. The already-applied
  shortcut (~2203–2222) requires `log.applied` **or** a matching
  `pendingLock` witness; bare `LOCKED` no longer suffices.
- **Failing probes (architect finding 2 scenario):**
  - Focused test, `src/adjudication.test.ts` or the existing
    orchestrator adjudication scenario: stale `LOCKED` contract +
    malformed log ⇒ dispatch reopens the contract and parks;
    replacement decisions then drive a full apply-and-lock (planner
    invoked, lock gate run) — not an inherited lock.
  - Unit: `LOCKED` + complete unapplied log + matching witness ⇒
    marked applied without re-apply (crash window). Same shape with
    missing/mismatched witness ⇒ reconcile + full apply.

### Step 4 — journal park transition (Seam 2 §9; 0031/0047 resolution)

- `src/slice-lifecycle.ts`: `PHASE_TRAITS` gains
  `replaceableThisRun: true` for `AWAITING-ADJUDICATION` only.
- `src/run-journal.ts`: `recordTerminal` routes replaceable phases
  into a `parkedSlices` set (same persist/project/emit ordering);
  same-park re-record is idempotent; different terminal without an
  intervening `trackSlice` throws; `trackSlice` clears the parked mark
  (and the persisted record, per ADR 0047). Delete
  `reopenAdjudication`.
- **Failing tests:** unit, `src/run-journal.test.ts` — the park state
  machine directly: park → re-park idempotent; park → terminal without
  dispatch throws; park → `trackSlice` → terminal succeeds and clears
  the persisted park. Replace the existing `reopenAdjudication` test
  (line ~189).

### Step 5 — scheduler waits only at idle (A3, Seam 2 §7)

- `src/orchestrator.ts` `runPipeline` reconciliation (~5106–5164):
  recording a park no longer `await`s its wait (~5138). After
  reconciling all outcomes, loop back to `dag.ready(completed)`; only
  when `toRun` is empty and live waits remain, `Promise.race` them —
  accepted ⇒ clear park (step 4 semantics) and re-enter the loop;
  expired ⇒ drop the wait, slice stays parked; all expired + nothing
  runnable ⇒ exit.
- **Failing probe (architect finding 3 scenario):** add to an existing
  wave/orchestrator adjudication fixture if one reaches the shape,
  else one new slice in an existing wave fixture: parked slice A +
  unrelated PASS slice B with dependent C ⇒ C dispatches **before**
  A's adjudication wait resolves/expires. Verify with
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

### Step 8 — migration-sync STUCK goes through the finalizer (P1)

- `src/orchestrator.ts`: `finishStuck` (~3743–3753) takes a reason
  (default: today's round-exhaustion message); the migration-sync
  branch (~4254–4262) calls `finishStuck` with `Migration sync check
  failed: …` instead of returning `STUCK` inline.
- **Failing test (PM finding 1):** narrow assertion in the existing
  orchestration fixture that exercises `verifyMigrationSync` failure:
  `stuck.md` exists and names the migration-sync reason.

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

## Non-goals

- No PRD 2 scope change: #94 stays out, Story 14 stays deferred.
- No test wall-clock budget raise; new assertions follow the AGENTS.md
  placement ladder (steps above name their target suites).
- No change to the bounded wait's duration, ADR 0054's
  one-decision-per-dispatch workflow, or ADR 0050's revision bound.
- Gate reopen is the operator's, after this plan's implementation
  track merges to the feature branch and
  `typecheck + test:fast + test:heavy:{orchestrator,wave,clean}` are
  green.

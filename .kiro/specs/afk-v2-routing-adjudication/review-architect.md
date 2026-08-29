# Architecture Guardian Review

**Verdict:** FIX-BEFORE-SHIP

## Scope reviewed

Reviewed `git diff main...HEAD`, the PRD, and every `contract.md` and
`handoff.md` under `.kiro/specs/afk-v2-routing-adjudication/slices/`.
The pre-ship gate was accepted as already passed. I additionally ran
`pnpm vitest run src/adopt-command.test.ts src/escalation.test.ts
--reporter=dot` (37 tests passed) and `git diff --check main...HEAD`.

## Blocking finding

### 1. A failed focused scope revision destroys the last accepted lock before a replacement is accepted

- **File/location:** `src/orchestrator.ts`,
  `runFocusedScopeRevision` (especially lines 1064-1091 and 1203-1260),
  reached from `runSliceExecute` around lines 3427-3452; the enclosing error
  path is around lines 3824-3835.
- **Evidence gathered:** I read the complete mutation and failure sequence.
  The function reads `previousContract` and `previousManifestText`, then
  immediately calls `reopenContract(contractPath)` and deletes
  `acceptance-manifest.json` before invoking the planner. Those saved values
  are used only later to describe a successful revision diff. There is no
  catch/finally restoration. A planner/provider exception therefore reaches
  `runSliceExecute`'s generic `ERROR` return with the prior contract reopened
  and the prior manifest deleted. An evaluator rejection likewise returns
  `ERROR` while leaving the unaccepted revision on disk. I also searched
  `src/orchestrator.test.ts`; its escalation failure coverage stops before
  revision planning and does not exercise planner/evaluator failure after
  these mutations.
- **Convention violated:** ADR 0008, **Decision**, makes the on-disk contract
  the orchestrator-owned single source of truth. ADR 0039, **Decision 2 —
  every restart archives first**, establishes that slice contract artifacts
  must survive failure/restart boundaries because the worktree copy may be
  the only copy. This path replaces or removes that authoritative accepted
  state before the replacement passes evaluation and without preserving a
  recoverable copy.
- **Required fix:** Treat the focused revision as a transaction. Preserve the
  accepted contract and manifest before mutation, and restore them on every
  planner, validation, evaluator, malformed-artifact, rejection, or
  cancellation exit. Add narrow tests for at least planner failure and
  evaluator rejection, asserting the previous locked files remain
  byte-identical while the escalation archive survives.

## Non-blocking notes

1. `runFocusedScopeRevision` duplicates the normal planner/evaluator/archive/
   lock protocol. ADR 0050, **Consequences**, already records this as a
   shotgun-surgery risk under ADR 0008. A shared revision protocol would
   reduce future drift.

2. `src/logger.ts:DependencyBlocker.status` is an unrestricted `string` even
   though routing depends on the exact lifecycle value
   `AWAITING-ADJUDICATION`. ADR 0032's single-fold direction favors typing
   this as `SlicePhase | "UNKNOWN"` rather than introducing another loose
   status vocabulary.

3. `afk adopt` has a recoverable but incomplete two-resource transaction:
   it advances the feature ref, writes run state, then attempts a guarded
   rollback if the state write throws. If both the write and reverse CAS
   fail, the command explicitly leaves merged code without state. ADR 0042,
   **No launch-time state↔branch audit**, places this invariant at adopt write
   time. The explicit refusal is useful, but a durable intent/recovery record
   would make this failure mechanically repairable.

# Architecture Guardian Review
**Verdict:** FIX-BEFORE-SHIP

## Blocking Findings

### 1. Scope revision has no pipeline-level bound

- **File/location:** `src/orchestrator.ts`, `runSliceExecute`, lines 3294-3424.
- **Evidence gathered:** I read the implementation and its focused tests. The
  outer implementation loop is bounded, but the inner `while (true)` repeats
  generator -> planner -> contract evaluator for every valid `escalation.md`.
  `generatorAttempt` is only used in archive names and is never checked. The
  loop exits only when a generator omits the artifact. The test at
  `src/orchestrator.test.ts:1056-1194` covers one escalation, not repeated valid
  escalations.
- **Convention:** ADR 0041, "The rule", requires uncertain routing to choose
  the branch that cannot loop. ADR 0048, "Decision", applies that rule to scope
  amendment by allowing one extra same-round attempt because repeated
  amendments without source change are a loop.
- **Defect:** A generator that discovers or emits one undeclared path at a time
  can run an unlimited number of fresh agent invocations without consuming an
  implementation or contract-round budget. Per-invocation wall-clock limits do
  not bound the enclosing loop.
- **Required change:** Give focused scope revision an explicit finite allowance
  per implementation round (or consume an existing round budget), fail with a
  persisted reason when exhausted, and cover repeated valid escalations.

### 2. Adoption finalization can split the feature ref, checked-out tree, and run state

- **File/location:** `src/adopt-command.ts`, `runAdoptCli`, lines 273-305;
  `src/git.ts`, `updateBranchIfUnchanged`, lines 857-878.
- **Evidence gathered:** I read the finalization order: `git update-ref` moves
  the feature branch, then `saveSliceState` writes PASS with no catch or
  rollback. I also ran an isolated Git fixture with the target feature branch
  checked out in a linked worktree. The compare-and-swap moved `HEAD` to
  `66596a4`, while `git status --short` reported widespread staged additions
  and deletions; `HEAD^{tree}` was `1fff7e8...` and the index tree remained
  `3e05ad8...`.
- **Convention:** ADR 0042, "No launch-time state<->branch audit", assigns this
  invariant to `afk adopt` at write time, where the state write must be
  refusable. ADR 0010, "Decision", requires Git worktree identity and on-disk
  state to agree rather than trusting only a ref. ADR 0018, "The post-wave loop
  becomes reconciliation", requires failed terminal-state writes to have a
  retry path.
- **Defect:** A checked-out feature branch is advanced behind its worktree,
  leaving its index/files inconsistent. Separately, any state-write failure
  after the ref CAS leaves merged code recorded as incomplete, with no rollback
  or reconciliation path.
- **Required change:** Finalization must detect a checked-out target and either
  update that worktree coherently or refuse. If state persistence fails, roll
  back the feature ref with a guarded CAS (or provide an equivalent recoverable
  transaction) and return a named refusal. Add both failure scenarios to the
  focused adoption tests.

### 3. Adoption discards structured teardown failures

- **File/location:** `src/adopt-command.ts`, lines 241-261;
  `src/git.ts`, `createCandidateMerge`, lines 826-845.
- **Evidence gathered:** I read every new candidate-worktree teardown call.
  Each awaits `removeWorktree(...)` but ignores its `RemoveWorktreeResult`;
  `resolveGatePlan` also runs outside the cleanup `try`, so a thrown plan
  resolution leaves the detached worktree registered.
- **Convention:** ADR 0035, Decision 5, says every call site reads
  `result.removed`, and post-gate teardown uses the shared warning/refusal
  idiom. ADR 0042, Decision 1, treats surviving scratch/review worktrees as
  residue that must block a later launch.
- **Defect:** Adoption can report success or a clean refusal while its detached
  candidate worktree survives. This recreates the silent worktree-residue class
  ADR 0035 replaced with structured handling.
- **Required change:** Put candidate lifetime in `try/finally`, inspect
  `result.removed` on every path, and surface a classified refusal or warning
  consistent with ADR 0035. Cover gate-plan throws and teardown survivors.

## Notes

- `runFocusedScopeRevision` duplicates the planner/evaluator/archive/lock
  protocol already owned by normal negotiation. This is a future shotgun-
  surgery risk under ADR 0008's orchestrator-owned contract lifecycle; extract
  the shared protocol when the blocking bound is added.
- `DependencyBlocker.status` in `src/logger.ts` is an unconstrained `string`
  even though it controls lifecycle rendering. Prefer
  `SlicePhase | "UNKNOWN"` to prevent naming drift.

## Verification

`pnpm vitest run src/escalation.test.ts src/adopt-command.test.ts` passed
(30 tests). `git diff --check main...HEAD` passed. The pre-ship full suite was
not rerun, as instructed.

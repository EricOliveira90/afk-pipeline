# Merge resolution round (#132) — slice 06 handoff

- New migration files: 0

## What shipped

- `src/merge-resolution.ts` — the round's body. `runMergeResolutionRound`
  merges the feature tip into the slice branch in the slice's *own* worktree
  with `git merge --no-commit`, hands the generator the conflicted index,
  re-enters `runCandidateGatePhase` on the resolution commit's tree, scans the
  conflicted paths' blobs for surviving markers, and returns one of
  `RESOLVED | NO-CONFLICT | UNRESOLVED | GATES-RED | CONFLICT-MARKERS`. Also
  exports the two pure functions the contract names — `conflictMarkerPaths`
  (line-start `<<<<<<< `, `======= `, `>>>>>>> `) and
  `boundMergeResolutionBlock` — plus `resolveRef`. Nothing here resets: an
  unresolved dispatch aborts only the merge this module started, and every
  other failure keeps the resolution commit (ADR 0039).
- `src/wave.ts` — the merge critical section is now wider: first attempt →
  optional `resolveMergeConflict` → retry, all inside the single `mergeMutex`
  acquisition the refused attempt already holds. `resolveMergeConflict` is
  optional, so every `runWave` caller outside the orchestrator behaves exactly
  as before. A collision on the retry maps to a conflict attempt, not
  MERGE-PENDING.
- `src/orchestrator.ts` — `runSliceMergeResolution`, the wiring seam passed as
  `resolveMergeConflict`. It resolves the feature tip to a sha, reads the
  locked contract and manifest, builds the slice's own declaration set (scope +
  pre-QA + acceptance + full suite), dispatches the generator with the repair
  envelope, emits the `merge-resolution-round` event and closes the agent log.
- `src/context-envelope.ts` — `MERGE_RESOLUTION_SITUATION_SECTION`,
  `withMergeResolutionSituation` and `mergeResolutionBlockRoom`: the block
  rides in the existing `{{REPAIR_SITUATION}}` slot of
  `prompts/generator-repair.md` under one level-1 heading, and the room left
  for it is measured against the envelope's inline-size budget (#230).
- `src/run-events.ts`, `src/logger.ts` — the `merge-resolution-round` event and
  its own `## Merge Resolution Rounds` section in `run-summary.md`, distinct
  from the per-slice repair-round counts.
- Tests: `src/merge-resolution.test.ts` (real temp repositories and real
  `GateDeclaration`s), additions to `src/context-envelope.test.ts` and three
  wave-level assertions in `src/wave-migrations.test.ts`.
- `ARCHITECTURE.md` — the module row and the seam bullet.

## Decisions made during implementation

- **No `prepare` gate in the round's gate phase.** The slice's own worktree
  already has its install; a dependency install under the held merge mutex
  would stall every other lane's merge for minutes. The declaration set is
  otherwise the slice's own required set, full-suite declarations included.
- **`acceptedPairIntact` is proven, never asserted.** `scopeGateDeclaration`
  reads its input inside its `run` closure, so the round is handed a mutable
  input object: `runSliceMergeResolution` captures the accepted contract pair
  before dispatch and sets the flag from
  `mutatedAcceptedContractFiles(...).length === 0` *after* the generator
  returns, while the gate still sees the value at gate time. `src/scope-gate.ts`
  is unchanged. A test drives the flag false and asserts the scope gate then
  names `contract.md` — a caller hard-coding `true` would be lying.
- **Round identity is `round: 0`.** Implementation repair rounds are 1..n, and
  the resolution round is not one of them; the gate evidence directory and the
  agent log (`generator-merge-resolution`) inherit that.
- **The resolver is non-throwing except for cancellation.** A preparation
  failure (unreadable manifest, missing contract) returns `UNRESOLVED` with the
  reason in `detail`, so the slice degrades to the terminal `CONFLICT` it would
  have had without the round rather than to `ERROR`.
- **Terminal mapping stays in `src/wave.ts`.** The module returns a verdict and
  never records an outcome, so the CONFLICT/MERGE-PENDING policy has exactly
  one owner.

## Gotchas / learnings

- Gate evidence must be written *outside* the tree the round's gates run on.
  Writing it into the worktree made the scope gate report its own gate logs as
  untracked out-of-scope paths. Production is already correct — `logger.runDir`
  lives in the host repo — but the first version of the test was not.
- A negotiated slice always shows its accepted contract pair as changed against
  the feature branch. A fixture whose slice branch leaves `contract.md`
  untouched cannot exercise the attestation at all: the pair never enters the
  changed set, so the flag looks inert whichever value it holds.
- The merge mutex is not reentrant and is shared with the pre-wave
  MERGE-PENDING recovery. Nothing reachable from inside the round may acquire
  it — a reentrant acquisition deadlocks the run instead of failing a gate. The
  wave test proves the span by queueing a competing acquisition from inside the
  round and asserting it does not settle until the retry has already merged.
- `git merge --no-commit` exits non-zero on conflict, which is the success path
  here: the conflicted index is the input to the round. Any caller shelling out
  to it needs the failure tolerated and the index inspected instead
  (`git diff --name-only --diff-filter=U`).
- A Markdown setext underline (`=======` with no trailing space) is not a
  conflict marker, which is why the scan matches the contract's literals with
  their trailing space at line start and nothing else.

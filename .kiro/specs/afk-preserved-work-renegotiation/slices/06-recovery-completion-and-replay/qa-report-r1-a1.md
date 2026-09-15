# QA Report

**Verdict:** PASS
**Failure class:** NONE

## Pass 1: Functional Correctness
- Pre-QA commands: PASS
- UAT verification: NOT IN SCOPE
- Boundary compliance: PASS
- Preservation check: PASS

`pnpm install --frozen-lockfile` — exit 0, run in this worktree.
`pnpm run typecheck` — covered by the skip authorization (gate attempt
`2d4be36b-bc32-49af-95a0-8e13e0bac1c7`, evidence
`.afk/logs/afk-preserved-work-renegotiation-claude-code/run-20260914-231711/gates/s06/attempt-2d4be36bbc32.json`,
tree `ecf64f877c52b0ebed1ecee87901f2d77e1132d2`). I also ran it myself after
reverting my probe: `tsc --noEmit`, exit 0, no output.

### Behavior verification

Diff read against the feature base `71488b1`. Every anchor id has at least one
test carrying it (`B-01`, `B-02`, `B-03`, `B-04`, `B-05`, `B-10`, `B-11`,
`B-12`, `P-01`–`P-05`).

- B-01/B-02 — `completeRecoveryAttempt` (`src/preserve-work-recovery.ts:1809`)
  reads run state once, validates the replacement pair through the single
  `readLockedAcceptedPair`, calls the injected `lockGate` exactly once with
  `join(sliceDir, CONTRACT_FILENAME)` and only after the pair validated, then
  requires a non-blank `provenance`, then performs exactly one
  `transactRunState` that rechecks trailing `attemptId`/state,
  `runScopeFingerprint(locked.scope)` against the `PENDING` event's
  `scopeFingerprint`, and `isLegalRecoveryTransition("PENDING", "COMPLETED")`
  before one `appendRecoveryLineageEvent`. `transactRunState` writes nothing on
  `changed: false` (`src/run-state.ts:672-684`), so every non-appending branch
  publishes no document.
- B-03 — all three shapes are implemented as the contract specifies.
  Precondition and CAS-lost endings go through `endCompletionThroughRollback`,
  which re-reads state and delegates to #333's `rollBackRecoveryAttempt` *only*
  when the trailing event is still this `attemptId` in `PENDING`; otherwise it
  returns `facts-changed-before-lock` naming both attempts and calls no
  writer. Triggers are `deterministic-validation-refusal`,
  `lock-gate-refusal` and the new `completion-cas-lost`.
- B-04 — `recoveryPreDispatchRefusal` returns `undefined` for any target not
  trailing `COMPLETED`, re-reads the pair at call time, and fails closed with
  `completed-pair-drifted` on reopened, mutated or missing pairs, recording
  `RECOVERY_FINGERPRINT_ABSENT` when no valid `LOCKED` pair exists.
- B-05/B-10/B-11 — the replay check is placed before snapshot publication
  (`admitStaleRenegotiation` step 2), keyed on the pair's fingerprints rather
  than on the requested target. That keying is what makes B-10's
  "differing in canonical target" clause reachable at all: a target-keyed lookup
  would find no `COMPLETED` event for a differently-named target and would admit
  instead of refusing. A pair matching no completed replacement admits normally,
  which is B-11.
- B-12 — the three fields are optional in the type and enforced per-state by
  `sanitizeRecoveryLineage` via `COMPLETION_FIELDS`, on the same shape as
  `ROLLBACK_FAILURE_FIELDS`, and copied forward in the field-by-field copy.
  `RUN_STATE_VERSION` is still 7 and no migration file was added.

### Boundary compliance

`git diff --name-only 71488b1..HEAD` touches exactly the seven declared paths
(`src/preserve-work-recovery.ts`, `src/run-state.ts`,
`src/preserve-work-recovery.test.ts`, `src/run-state.test.ts`,
`src/resume-integration.test.ts`, `src/resume-integration.fixtures.ts`,
`ARCHITECTURE.md`) plus this slice's own `.kiro` process artifacts.
`src/cli-options.ts`, `src/orchestrator.ts`, `src/wave.ts`,
`src/run-events.ts`, `src/run-snapshot.ts`, `src/status.ts`, `src/afk.ts`,
`src/afk-claude.ts` and `src/afk-codex.ts` are absent from the diff.
`src/preserve-work-recovery.ts` imports none of `./artifacts.js`,
`./contract-transaction.js`, `./orchestrator.js`, `./wave.js`, and carries no
`**Lock-Provenance:**` literal. ARCHITECTURE.md is 140 lines (cap 150) and its
`Preserved-work recovery` row names the `COMPLETED` outcome, the dispatch hold
and replay under #335. No scope amendment is needed.

### Preservation

- P-01: `completeRecoveryAttempt`'s body contains no `probes`, `resolveCommit(`,
  `git` or `worktree` reference, and the module still matches no
  merge/reset/rebase token. The `P-01` test drives completion, both replay
  paths, the drift hold and a precondition refusal and asserts tips, `log
  --all`, `status --porcelain`, `branch --list`, the worktree tree digest and
  the `resume`/`slices` state sections all unchanged.
- P-02: `rollBackRecoveryAttempt` keeps its signature; the module still has one
  restore-and-verify implementation, one event builder and no second rollback.
  The #333/#334 exports behave as pinned.
- P-03: only the counter assertions and the fixtures that now must supply the
  three required `COMPLETED` members were edited in existing blocks; the
  `attempt-already-pending` refusal and trim-only canonicalization are re-pinned
  and pass.
- P-04/P-05: `--renegotiate-stale` is still refused at the entry point, and no
  shipped module outside `src/preserve-work-recovery.ts` names either new
  export (asserted by scanning `src/*.ts`).

### Commands and probes I ran

- `pnpm vitest run src/preserve-work-recovery.test.ts src/run-state.test.ts` —
  `Test Files 2 passed (2)`, `Tests 235 passed (235)`, 28.8s, exit 0.
- Mutation probe 1 (test honesty): forced the replay branch dead
  (`if (replay !== undefined)` → `if (false as boolean)`). Result:
  `Tests 4 failed | 23 passed` — B-05, both B-10 cases and P-01 fail.
- Mutation probe 2: removed the blank-provenance guard (`: provenance === ""` →
  `: (false as boolean)`). Result: `Tests 2 failed | 10 passed` — the "blank
  provenance" and "missing provenance" B-01 rows fail.
- Both probes reverted with `git checkout -- src/preserve-work-recovery.ts`;
  `git status --porcelain` then shows only the two `.kiro` contract artifacts
  (line-ending normalization only — `git diff` reports no content change), and
  `pnpm run typecheck` re-run on the restored tree exits 0.

## Pass 2: Quality & Craft
- Convention compliance: PASS
- Code quality: PASS
- Test quality: PASS

The new code follows the module's established idioms: injected structural seams
rather than forbidden imports, one discriminated-union result per entry point,
`transactRunState` recheck-then-append, and one shared `nextRecoveryEvent`
builder extended to the third terminal state instead of a parallel one. The
`Preconditions` union decides all three checks in one expression so no branch is
reachable alone, and every non-obvious choice (why the gate is injected, why
shape (c) is not delegated, why the replay check keys on the pair) carries its
reason in a comment rather than being left to be rediscovered.

Test quality is above the bar: the tests compare whole run-state documents key
by key, compare pair files and snapshot trees as bytes, and deliberately build
discriminators — the replacement pair differs from the admitted one so
fingerprint assertions cannot pass by coincidence, and the second attempt's
snapshot differs from the live pair so "nothing was restored" is a real claim.
The two mutation probes above confirm the assertions fail when the behavior
does. No new spawned pipeline scenario was added; the end-to-end case is one
`it` on the existing recovery fixture.

## Resolved findings
- None routed to this stage.

## Findings
- None.

# QA Report

**Verdict:** PASS
**Failure class:** NONE

## Pass 1: Functional Correctness
- Pre-QA commands: PASS
- UAT verification: NOT IN SCOPE
- Boundary compliance: PASS
- Preservation check: PASS

### Commands run

- `pnpm install --frozen-lockfile` — exit 0.
- `pnpm run typecheck` — exit 0, run by me rather than cited. The skip
  authorization for tree `9038632f1477be2d9fe6cbd1f04f362629afc0d9` was void
  once I mutated `src/preserve-work-recovery.ts` for the probes below, so I ran
  it myself after reverting; `git diff --stat -- src/` is empty, i.e. the tree
  is back to the one under review.
- `pnpm vitest run src/preserve-work-recovery.test.ts` — 111 passed, exit 0
  (60.9s). Includes every `[behavior:#334:B-01/B-02/B-03/B-05/B-06/B-07]` and
  `[behavior:#334:P-01/P-02/P-03]` test.
- `pnpm vitest run src/resume-integration.test.ts` — 32 passed, exit 0 (173.1s).
  Includes the one spawned
  `[behavior:#334:B-04] [behavior:#334:B-05]` scenario and the
  `[behavior:#334:P-03]` no-lineage assertion.

The full suite was not run: this is a candidate-QA stage and the pre-QA list
does not name it.

### Behaviour verification

- **B-01** — `reconcileRecoveryLineage` reports exactly the trailing-`PENDING`
  and trailing-`ROLLBACK_FAILED` targets and skips the `ROLLED_BACK` one, in
  ascending `ghIssue` order. The unresolved predicate is literally
  `rollbackableEvent`, the same function the contract names. The test plants
  `9`, `88`, `1001` — chosen so a plain lexicographic `.sort()` would invert the
  promised order — and asserts that explicitly.
- **B-02** — Both append branches verified against the persisted file, not just
  the return value. The `ROLLBACK_FAILED` branch carries `rollbackError` equal
  to the restore's own failure message (compared against a direct
  `restoreAcceptedPairFromSnapshot` call in the same test) plus
  `observedContractFingerprint` and `observedManifestFingerprint`, with the
  deleted destination half recorded as `RECOVERY_FINGERPRINT_ABSENT` rather
  than a blank, and the destination pair left as it was.
- **B-03** — Verified by probe, not by reading. The well-formed locator resolves
  to `dirname(dirname(join(repoRoot, ...segments)))`; the two-segment,
  wrong-penultimate-segment and single-segment locators are all refused before
  any filesystem access, and the repository-root `contract.md` /
  `acceptance-manifest.json` planted beforehand are byte-identical afterwards.
- **B-04** — Asserted through one real `runPipeline`: `records` is empty (and
  the stub's `generator` throws if reached), `.afk/worktrees` is empty, no
  `slice-01` branch exists, and the persisted `scope`, `slices` and `resume`
  are byte-equal to their pre-launch values — which is what places the call
  ahead of the `resolveRunScope` write and the resume decision.
- **B-05** — The four reported outcome families are exercised in one spawned run
  and the lines read off a real `run.log`, not off a formatter call. Sample
  observed lines (abridged): `... appended ROLLED_BACK. Retry: relaunch the
  same command ...`; `... ROLLBACK_FAILED was appended. Retry: repair the
  snapshot directory <dir> ... then relaunch ...`; `... nothing was appended:
  the retry failed again (...) ... This hold is intentionally terminal until
  #335 ... attempt attempt-held in <state file> ... a relaunch alone will
  report the same target and stop again.`; and the same terminal-until-#335
  wording for the rejected two-segment locator, naming the derived destination.
  `failureReason` matches `Launch stopped after reconciling 4` and contains
  every reconciled `ghIssue`.
- **B-06** — `ROLLBACK_FAILED -> ROLLBACK_FAILED` appends nothing (the
  transition is asserted illegal in the same test), every prior event is equal
  at its original index, `digestTree(snapshotDir)` is unchanged across the call,
  `recoveryDispatchRefusal` still returns `rollback-failed-hold`, and after a
  `ROLLED_BACK` append `admitStaleRenegotiation` mints a different `attemptId`
  and a new snapshot directory while the prior one is untouched.
- **B-07** — Ref tips, `git log --oneline --all`, `git status --porcelain`,
  `git branch --list` and a digest of the preserved worktree are all equal
  before and after, and `git show <sliceBranch>:slice.txt` still reads
  `preserved work`.

### Boundary compliance

Every source file the candidate changed is in the contract's declared list:
`src/preserve-work-recovery.ts`, `src/orchestrator.ts`,
`src/preserve-work-recovery.test.ts`, `src/resume-integration.test.ts`,
`src/resume-integration.fixtures.ts`, `ARCHITECTURE.md`. No migration files.
`ARCHITECTURE.md` gained no lines (one table row rewritten), so the 150-line cap
holds. No amendment is needed.

### Preservation check

- **P-01** — `git diff 4a65d60 HEAD --stat -- src/cli-options.test.ts
  src/cli-entries.test.ts` is empty: the refusal tests are unedited. The slice's
  own re-pin of the refusal (`--renegotiate-stale is refused until #335 lands`)
  passes.
- **P-02** — The #277/#332/#333 recovery tests all pass in the 111-test run and
  `tsc --noEmit` reports no signature change. Reconciliation delegates to
  `rollBackRecoveryAttempt`, which is one of the five exports P-02 names and
  which itself holds the single `restoreAcceptedPairFromSnapshot` call and the
  single `appendRecoveryLineageEvent`-inside-`transactRunState` sequence, so the
  "no second restore, no second verification rule" obligation holds.
- **P-03** — Verified twice: a unit `it.each` proving the run-state file bytes
  are unchanged both with no `recoveryLineage` and with an all-terminal one, and
  an assertion on the existing two-pipeline resume scenario that its merged
  `run.log` carries neither `was left unresolved on` nor `Launch stopped after
  reconciling` and still shows `Slice #4001` being worked.

### Probes run

Both probes were reverted; the tree under review is unmodified.

1. `segments.length < 3` → `segments.length < 2` in
   `deriveRestoreDestination`. `pnpm vitest run
   src/preserve-work-recovery.test.ts -t "B-03"` failed with
   `- "appended": "none" / + "appended": "ROLLBACK_FAILED"` and
   `- "locatorRejected": true / + "locatorRejected": false` at
   `src/preserve-work-recovery.test.ts:2756`. The two-segment guard is really
   load-bearing and the test really catches its absence.
2. The numeric comparison in `compareGhIssue` short-circuited to `false`.
   `pnpm vitest run src/preserve-work-recovery.test.ts -t "B-01"` failed at
   `src/preserve-work-recovery.test.ts:2551` with `9` sorted after `88`. The
   ordering claim is asserted, not decorative.

## Pass 2: Quality & Craft
- Convention compliance: PASS
- Code quality: NOTES
- Test quality: PASS

Naming, doc-comment density and the "why, not what" comment style match the
surrounding module. The decision to delegate to `rollBackRecoveryAttempt` rather
than re-run the two-phase sequence is argued in the doc comment and is the
reading P-02 authorizes. `describeRecoveryReconciliation` lives beside the
outcome type rather than in the orchestrator hub, which is the right side of
that boundary. The new orchestrator block is the first statement in the
top-level `try` and matches the surrounding failure-return shape, including the
`run-ended` event; it skips `emitHandoff`, which is correct because `emitHandoff`
returns early while `scope` is undefined.

Test quality is good and unusually honest: assertions read the persisted
run-state file rather than the in-memory return value, the "nothing was
dispatched" claim is backed by a throwing stub generator as well as an empty
records array, and the spawned scenario is justified in a comment against the
`AGENTS.md` assertion ladder. The structural string-count assertions
(`occurrences(MODULE_CODE, ...)`) are brittle by nature but follow the existing
#333 P-03 pattern in the same file.

Two advisory notes are recorded as findings below. Neither blocks.

## Resolved findings
- none — this is round 1 of this QA stage and no findings were routed to it.

## Findings

### Finding 1 — Append-nothing operator line mis-advises a lock-race refusal
**Severity:** Minor
**Pass:** 2
**Evidence:** `reconcileRecoveryLineage` maps every non-rejected outcome with no
appended `ROLLBACK_FAILED` event to `appended: "none"` with
`locatorRejected: false`. `rollBackRecoveryAttempt` reaches that shape for three
different reasons: a re-failed retry (illegal transition), `no-pending-attempt`,
and `facts-changed-before-lock` (`src/preserve-work-recovery.ts:1377-1384`,
`:1418-1422`). `describeRecoveryReconciliation` then always emits `the retry
failed again (<message>), so the existing hold stays in force. A human must
repair the snapshot directory <snapshotDir> ...`.
**What the contract expected:** B-05 — "The named retry is fixed per outcome, so
the line's promised content is derivable rather than left to the implementer",
enumerating the append-nothing families as "a trailing `ROLLBACK_FAILED` whose
retry failed again (B-06), or a rejected locator (B-03)".
**What I observed:** A lineage that drifted between the restore and the
run-state lock is reported with the re-failed-retry wording and told to repair a
snapshot directory that is not the obstacle. The parenthesised message does
carry the real reason, so the operator is mis-advised rather than misinformed,
and the cause requires a concurrent writer on the same run-state file, which is
why this is advisory.

### Finding 2 — Run-state file path duplicated instead of derived
**Severity:** Minor
**Pass:** 2
**Evidence:** `reconcileRecoveryLineage` builds
`join(args.repoRoot, ".afk", "state", `${runSlug}.json`)`, a second copy of the
private `statePath` helper at `src/run-state.ts:640`. The B-01 test asserts
`runStateFile: fixture.statePath`, and the fixture builds that path from the
same literals, so neither side is pinned to `run-state.ts`.
**What the contract expected:** B-01 — the outcome record names the run-state
file reconciliation read and appended to, and B-05's append-nothing line names
that file to the operator.
**What I observed:** If the run-state layout ever moves, both the code and its
test stay green while the operator line names a file that does not exist. The
code comment states the reason for the duplication (run-state keeps the path
private), which is why this is a note rather than a defect.

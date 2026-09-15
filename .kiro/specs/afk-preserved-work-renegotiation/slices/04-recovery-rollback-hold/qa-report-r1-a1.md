# QA Report

**Verdict:** PASS
**Failure class:** NONE

## Pass 1: Functional Correctness
- Pre-QA commands: PASS
- UAT verification: NOT IN SCOPE
- Boundary compliance: PASS
- Preservation check: PASS

### Commands run

- `pnpm install --frozen-lockfile` — exit 0, "Done in 5.7s using pnpm v10.33.0".
  Run here rather than cited, per the skip authorization's carve-out for the
  dependency install.
- `pnpm run typecheck` — exit 0 (`tsc --noEmit`, no diagnostics). Run rather
  than cited: my probes modified `src/run-state.ts` and
  `src/preserve-work-recovery.ts`, which voided the authorization for gate
  attempt `454535fa-c2cc-41b7-a779-f2a9c3d755c2` / tree
  `fdb097f83c98badeeddf0d418e8b10f3e73a5a15`. Both files were reverted with
  `git checkout --` before the typecheck, and `git status --porcelain` shows
  only the two pre-existing CRLF-only entries for the slice's own
  `contract.md` / `acceptance-manifest.json`.
- `pnpm vitest run src/preserve-work-recovery.test.ts src/run-state.test.ts` —
  exit 0, `Test Files 2 passed (2)`, `Tests 179 passed (179)`, 16.45s. Run
  because the contract's definition of done names both suites and the
  authorization covered typecheck only. The full suite was not run: it is not
  on the pre-QA list.

### Behavior coverage

Every in-scope and preservation behavior has at least one selectable
`[behavior:#333:...]` test:

- B-01 (two tests, incl. the recorded-locator case that relocates the snapshot
  so a re-derived path would miss it), B-02 (fingerprint tamper, invalid-LOCKED
  reread), B-03 (`it.each` over all five triggers, plus the
  `no-pending-attempt` refusal), B-04, B-05, B-06 (two in
  `preserve-work-recovery.test.ts`, four in `run-state.test.ts`), B-07 (three),
  B-08 (three), B-09.
- P-01, P-02, P-03, P-05 in `src/preserve-work-recovery.test.ts`; P-04 (three)
  in `src/run-state.test.ts`. Each carries its own `#333` name, so the
  acceptance gate's `--testNamePattern` selects a real test rather than
  reporting a vacuous zero-test pass.

### Boundary compliance

`git diff --stat HEAD~4 HEAD` shows five non-artifact files:
`src/preserve-work-recovery.ts`, `src/preserve-work-recovery.test.ts`,
`src/run-state.ts`, `src/run-state.test.ts`, `ARCHITECTURE.md` — exactly the
contract's declared list. The remaining entries are this slice's own
negotiation artifacts under
`.kiro/specs/afk-preserved-work-renegotiation/slices/04-recovery-rollback-hold/`.
No orchestrator, `src/wave.ts`, gate-catalog or CLI file appears. No migration
file was added (`Migration requirements: 0`).

### Preservation

- P-01 / B-04: `git diff HEAD~4 HEAD -- src/` contains no change to the
  `./git.js` import list; the B-04 test pins it to exactly
  `countCommitsAhead, hasUncommittedChanges, isAncestor, resolveCommit` and
  compares branch tips, worktree digest, `git status --porcelain` and
  `git log --oneline --all` across a verified rollback.
- P-03 / P-05: `git diff HEAD~4 HEAD -- src/ | Select-String
  "LEGAL_RECOVERY_TRANSITIONS|renegotiate-stale|RUN_STATE_VERSION ="` returns
  nothing — the transition map, #277's entry-point refusal and the schema
  version are all untouched. `RUN_STATE_VERSION` is still `7`, asserted
  in-test.
- P-04: the three new members are optional on `PersistedRecoveryLineageEvent`
  and validated per state; a `PENDING`-only #277 lineage loads field for field
  with `Object.keys` equality.
- Definition-of-done "no other module imports them yet": `Select-String -Path
  src/*.ts -Pattern "rollBackRecoveryAttempt|recoveryDispatchRefusal|restoreAcceptedPairFromSnapshot" -List`
  lists only `preserve-work-recovery.ts` and its test file.

### Probes — test honesty

Two mutations in this disposable worktree, both reverted:

1. Replaced the "required absent otherwise" half of the per-state check in
   `src/run-state.ts` with `: true;`. `pnpm vitest run src/run-state.test.ts`
   → exit 1, `Tests 4 failed | 76 passed (80)`: the three
   `[behavior:#333:B-06] rejects a <state> event carrying <field>` cases and
   `[behavior:#333:P-04] rejects the newly-forbidden direction too, so the rule
   cannot ship half-enforced`. The ADR 0060 both-directions obligation is
   genuinely enforced, not asserted in name only.
2. Replaced `nextRecoveryEvent`'s destructuring strip with
   `const base = trailing;`. `pnpm vitest run
   src/preserve-work-recovery.test.ts` → exit 1, `Tests 1 failed | 98 passed
   (99)`: `[behavior:#333:B-08] appends ROLLED_BACK for the same attempt once
   the obstacle is gone`. The subtlest piece of logic in the writer — a
   `ROLLED_BACK` event must not inherit the prior failure's observations, or
   run state would reject it — is covered by a test that fails when it breaks.

## Pass 2: Quality & Craft
- Convention compliance: PASS
- Code quality: NOTES
- Test quality: PASS

Naming, doc-comment density and the "why, not what" comment style match the
surrounding module. `restoreAcceptedPairFromSnapshot` is genuinely the single
implementation: `rollBackRecoveryAttempt` calls it and duplicates no compare,
and B-09 pins that behaviourally rather than by reading source text. The
refusal-code additions (`rollback-verification-failed`, `rollback-failed-hold`)
extend the existing union in place. `observedFingerprintOf` folding unreadable
into absent is documented with its reason.

Two non-blocking notes, neither a contract violation and neither worth a
finding:

- Restore writes the destination before it verifies, so a snapshot tampered
  with after publication (the B-02 case) leaves the slice directory holding the
  tampered bytes rather than either prior state. This is what the contract asks
  for — B-02 verifies "by rereading the two restored destination files" — and
  the `ROLLBACK_FAILED` event records the observed fingerprints, with
  `recoveryDispatchRefusal` holding dispatch until a human resolves it. Worth
  knowing when #334 calls the same routine at launch time.
- In the illegal-transition branch of `rollBackRecoveryAttempt`, the refusal
  code is `rollback-verification-failed` even on the `restored.ok === true`
  arm, whose message reads "The rollback verified; ...". That arm is
  unreachable today (both `PENDING -> ROLLED_BACK` and
  `ROLLBACK_FAILED -> ROLLED_BACK` are legal), so it is defensive code with a
  slightly misleading code rather than a wrong result.

## Resolved findings
- None. No findings were routed into this QA stage.

## Findings
None.

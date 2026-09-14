# Handoff — slice 01, preserved-work recovery admission (#277)

## What shipped

- B-01: `src/cli-options.ts:parseStaleRenegotiationRequest`
- B-02: `src/cli-options.ts:parseStaleRenegotiationRequest`
- B-03: `src/preserve-work-recovery.ts:canonicalizeRecoveryRequest`
- B-04: `src/preserve-work-recovery.ts:encodeRunScopeFingerprintPayload`, `src/preserve-work-recovery.ts:runScopeFingerprint`
- B-05: `src/preserve-work-recovery.ts:evaluateRecoveryEligibility`, `src/preserve-work-recovery.ts:RecoveryRefusalCode`
- B-06: `src/preserve-work-recovery.ts:admitStaleRenegotiation`
- B-07: `src/preserve-work-recovery.ts:publishAcceptedPairSnapshot`
- B-08: `src/preserve-work-recovery.ts:admitStaleRenegotiation`
- B-09: `src/preserve-work-recovery.ts:admitStaleRenegotiation`, `src/preserve-work-recovery.ts:hasOpenRecoveryAttempt`
- B-10: `src/run-state.ts:PersistedRecoveryLineageEvent`, `src/run-state.ts:sanitizeRecoveryLineage`, `src/run-state.ts:recoveryLineageFor`, `src/run-state.ts:appendRecoveryLineageEvent`
- B-11: `src/preserve-work-recovery.ts:isLegalRecoveryTransition`
- B-12: `src/cli-options.ts:parsePipelineRuntimeOptions`
- P-01: `src/cli-options.ts:parsePipelineRuntimeOptions`
- P-02: `src/cli-options.ts:PipelineRuntimeOptions`
- P-03: `src/run-state.ts:adaptLoadedState`
- P-04: `src/run-state.ts:appendRecoveryLineageEvent`
- P-05: `src/preserve-work-recovery.ts:RecoveryGitProbes`, `src/preserve-work-recovery.ts:DEFAULT_RECOVERY_GIT_PROBES`

## Decisions made during implementation

- P-05's "no other `src/git.ts` export is invoked" is scoped to
  `evaluateRecoveryEligibility`, matching the behavior's own `when` clause ("the
  new module's eligibility predicates run"). Read literally against the whole
  module it contradicts B-09, which requires the slice head and feature head to
  be recorded — neither is derivable from the three pinned predicates. So the
  eligibility predicates take an injected `RecoveryGitProbes` (a structural type
  at git.ts's current signatures), and `resolveCommit` is called only in
  `admitStaleRenegotiation`, outside the predicates, purely to name the two tips
  the lineage event records.
- Worktree registration is read off the filesystem (`existsSync(dir)` and
  `existsSync(join(dir, ".git"))`) rather than `git worktree list`, precisely so
  eligibility's git surface stays at the three pinned predicates. A linked
  worktree always carries a `.git` file, so its absence is the same answer git
  would give.
- The `**Status:** LOCKED` check re-implements `readContractStatus`'s regex
  locally instead of importing `src/artifacts.ts`, which ARCHITECTURE.md lists as
  a Review-rails internal ("do not import") and the contract's import allowlist
  excludes. The pattern is deliberately byte-identical so the two readers cannot
  disagree about what a locked contract is.
- The target's artifact directory is an explicit `sliceDir` input rather than
  derived inside the module: deriving it needs the slugified `issues.md` title,
  which is Admission Protocol step 2 and deferred to #278.
- Two extra refusal codes beyond the contract's list: `selector-ambiguous` (a
  selector that matches one scope entry by number and a different one by issue
  id names no single slice) and `branch-head-unresolvable` (an attempt whose tips
  cannot be named could never be reconciled). Both are refusals of inputs the
  contract's codes do not distinguish, not new behavior.
- `appendRecoveryLineageEvent` takes an already-loaded `RunState` and has no
  `repoRoot` variant, so nothing can append lineage outside a locked recheck.
- The paired-presence check is two directional messages rather than one, so all
  seven B-01/B-02 refusals stay pairwise distinct; `12,12` (a duplicated target)
  and `12,13` (a list of targets) are likewise distinguished, by
  `new Set(parts).size === 1`.
- B-08's contention seam is `beforeLockAcquired` on this module's own admission
  entry point. `withRunStateLock`, `transactRunState` and `withFileLock` are
  untouched: the ordering being proven belongs to this module, not to the shared
  ADR 0056 primitive.
- `src/run-state.test.ts`'s `[behavior:#87:B-14]` test asserted
  `RUN_STATE_VERSION === 6`. The contract mandates 7, so the assertion was
  rewritten in place (that file is in scope) to pin `6` as still assignable and
  the written schema as at or past it.
- ARCHITECTURE.md was already at its 150-line cap, so the trailing "Tests:"
  placement-rule bullet was compressed from three lines to two to make room for
  the new module row. The file is still exactly 150 lines.

## Gotchas / learnings

- `src/eval-boundary.test.ts:127` also pins `RUN_STATE_VERSION`, inside PRD 7's
  "leaves both schema versions alone" assertion. The focused scope revision
  brought that file into scope and the pin moved from `6` to `7` — the literal is
  the only edit to it, so PRD 7's property (an eval run writes no run state) is
  unchanged. A future schema bump must move this pin too; it is the only
  assertion of the version literal outside `src/run-state.test.ts`.
- In `parsePipelineRuntimeOptions`, reading `staleRenegotiation?.selector`
  *after* the `#335` guard makes TypeScript narrow the variable to `undefined`
  and the property access to `never` (TS2339). Both members are read out into
  `string | undefined` consts above the guard, which is also why deleting the
  guard in #335 is a one-hunk change.
- `sanitizeRecoveryLineage` drops a target's whole event list when any single
  event is malformed, rather than dropping just that event: a silently dropped
  `PENDING` would read as "no attempt open" and let a second admission through.
- Snapshot verification reads the bytes *in the temporary sibling*, not the
  source. Verifying the source and publishing a copy proves nothing about the
  copy, which is why the `afterTemporaryWritten` seam exists and why the failure
  test corrupts the temp directory rather than the source.
- The published-snapshot locator is stored repo-relative with `/` separators, so
  a Windows-authored run-state file stays readable elsewhere.
- `src/preserve-work-recovery.ts` is checked out LF here but git converts it to
  CRLF, so the source-reading assertions in its test normalize line endings
  before comparing. A raw `readFileSync` comparison against a multi-line literal
  passes locally and fails on a fresh clone.
- The test file builds one real git repository in `beforeAll` and resets the
  artifact directory, fake worktree and run-state file before each test. Git is
  needed only for `resolveCommit`; every eligibility outcome comes from stubs, so
  a per-case `git init` would have cost seconds per run and proven nothing more.

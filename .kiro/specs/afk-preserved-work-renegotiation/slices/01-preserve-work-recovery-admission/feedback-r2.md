# Contract feedback — round 2

Slice: `01-preserve-work-recovery-admission` (GH #277)

The revised pair is accepted. All three findings routed from round 1 are
resolved, and the revision introduced no new gap in the regions it changed.

## F-01 — the accepted-input observable (B-01, B-12)

Resolved. Round 1's problem was that one function was required both to return a
parsed request for `--renegotiate-stale 12 --recovery-reason " stale lock "` and
to throw the #335 refusal on that same input, which made B-01's accepted-input
assertion unwritable.

The revision names the seam: a new exported `parseStaleRenegotiationRequest` in
`src/cli-options.ts` returns a request value carrying the selector and the
accepted reason text, and `parsePipelineRuntimeOptions` calls it before the #335
guard. B-12 now says the parser itself throws for that same input. The
manifest follows — B-01's observableResult asserts against the helper's return,
B-12's against the parser's throw — and test-plan bullet 1 states both halves on
different functions in one sentence. The new export is declared under "Changes
to existing behavior" and in the scope lock, and it needs no file-scope change
because `src/cli-options.ts` and `src/cli-options.test.ts` were already listed.

The parser-language change now binds both halves of its regression surface: the
newly accepted input on the helper, and the rejected/boundary side — the three
distinct refusals (list, duplicate selector, repeated flag), B-02's
reason-flag refusals, P-01's unchanged existing flag behavior and error text,
and P-02's flagless result. The established harness for this parser is inline
tests in `src/cli-options.test.ts`, which is in scope, so no fixture area is
left undeclared.

Also worth noting for implementation: B-12's recorded decision keeps #335's
future change to deleting one guard in the parser, with the helper untouched.
That keeps the flag's user-visible validation messages stable across the two
slices.

## F-02 — the cross-process contention seam (B-08)

Resolved. Round 1 found that `afterLockPublished` cannot be supplied through
`transactRunState` → `withRunStateLock` → `withFileLock(statePath(...), action)`,
which passes no options object, and that `src/file-lock.ts` was out of scope.

The revision takes the second of the two options the finding offered rather than
widening scope: the interleave is driven by an optional
`beforeLockAcquired?: () => void` parameter on the new module's own exported
admission entry point, invoked after snapshot publication and before
`transactRunState`, with the contention test running the mutating child process
to completion inside it. `withFileLock`, `withRunStateLock` and
`transactRunState` keep their signatures, `src/file-lock.ts` stays out of scope,
and the change is recorded in three places that agree: "Changes to existing
behavior", the "New patterns" entry for `src/preserve-work-recovery.ts`, and the
rewritten test-plan contention bullet. Manifest B-08's given and
observableResult cite `beforeLockAcquired` and explicitly say "not
`afterLockPublished`".

The interleave being proven is unchanged in substance — the facts changed after
the snapshot was published and before this process held the ADR 0056 lock — so
the recheck refusal B-08 asserts still rests on a real cross-process race, not a
simulated one.

## F-03 — P-05's observable under `acceptance:behaviors`

Resolved. P-05 keeps the `acceptance:behaviors` gate and now states something a
`--testNamePattern P-05` run can assert: stubbing exactly
`hasUncommittedChanges`, `countCommitsAhead` and `isAncestor` (`src/git.ts:476`,
`:683`, `:1446`) at their current signatures flips every git-derived eligibility
outcome, and no other `src/git.ts` or `src/worktree-processes.ts` export is
invoked. The contract's P-05 entry and a new test-plan bullet state the same
assertion. The "unmodified files" claim it replaces is still enforced, but by
the file-scope check where it belongs rather than by a named test.

## Notes carried forward, not findings

- Manifest `fileScope` now spells the architecture doc lowercase while "Files
  expected to change" spells it `ARCHITECTURE.md`. `fileScope` paths are
  lowercased comparison keys, so this is not a defect and needs no change.
- B-08's observableResult ends with a clause about `src/file-lock.ts`,
  `withFileLock` and `withRunStateLock` being unmodified. That part is a
  file-scope fact rather than a test assertion, but the same sentence carries
  three real assertions (mismatch reason code, lineage absent, accepted-pair
  bytes unchanged), so the gate still produces evidence. No revision needed.
- The explorer's unresolved unknowns about the recorded slice branch field and
  the scope of record are answered inside B-05's recorded decisions
  (`PersistedSliceState.branch` at `src/run-state.ts:33`; `RunState.scope`, not a
  re-read of `afk.json`), and ADR 0065 is addressed in B-03. Implementation
  should hold to those decisions rather than re-deciding them.

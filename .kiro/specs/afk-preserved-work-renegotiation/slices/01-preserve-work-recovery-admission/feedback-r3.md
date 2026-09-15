# Contract feedback — slice 01, preserve-work recovery admission

The contract locks. Below is why, and the three small imprecisions worth
fixing on the way past.

## Why it is testable

Every behavior names a seam that returns or throws, so the acceptance gate
(`vitest --testNamePattern <id>`) can reach it without a spawned pipeline.
The hard case is handled honestly rather than papered over: because B-12 makes
the shared parser throw the #335 refusal for every well-formed
`--renegotiate-stale` pair, there is no accepted input observable on the
parser at all. B-01 answers that by exporting
`parseStaleRenegotiationRequest` and asserting the accepted return there while
the refusal is asserted on the parser — one function with an accepted return,
one with the refusal. That is the right split, and the recorded reason (it keeps
#335's change to "delete one guard") is the reason it stays right later.

The parser's regression surface is bound on both halves, which is what ADR 0060
asks for. Positive: the well-formed pair returning selector `12` and reason
`stale lock`, trimmed only. Rejected and boundary: the comma list, the
duplicated selector inside one value, the second flag occurrence, the missing,
blank and repeated reason, and each flag alone — seven inputs that must stay
refused, with pairwise-distinct messages. P-01 pins every existing flag's
accepted result and exact error text, including `optionValue`'s
`` `${flag} requires a value` `` and the paired preview-command message; P-02
pins the neither-flag launch to today's parsed object. The established harness
for this parser is inline unit tests in `src/cli-options.test.ts` and
`src/cli-entries.test.ts`; both exist and both are declared in `fileScope`, so
no fixture surface is left implicit.

The two claims that are easy to state and hard to observe are also handled:
B-08's contention scenario does not thread a seam through the shared run-state
lock — it puts an optional `beforeLockAcquired` on the new module's own
admission entry point, which reproduces exactly the interleave being proven
("the facts changed after the snapshot and before this process held the lock")
while leaving `withRunStateLock`, `transactRunState` and `withFileLock` at
their current signatures and keeping `src/file-lock.ts` out of scope. That is
the cheaper seam and the honest one.

## Why it is evidence-backed

The three unknowns the explorer left open are each closed with a symbol that
exists, and I checked all three rather than taking the citation on trust:

- "persisted run scope" resolves to `RunState.scope`, typed
  `PersistedRunScope` (`mode`, `slices[{number, ghIssue}]`) in
  `src/slice-scope.ts` — not a re-read of `afk.json`, whose revalidation is
  step 2 and belongs to #278. That reconciles the PRD's two phrasings against
  one field.
- the "recorded slice branch" resolves to `PersistedSliceState.branch`, an
  optional field, and the contract makes its absence its own refusal reason —
  which is the correct consequence of it being optional.
- ADR 0065 is answered rather than deferred: the selector resolves against the
  persisted scope entries and their canonical numbers, so an ID match is
  corroborated before it resolves identity, and `matchesSliceSelector`'s
  second, differently-shaped `Number(...)` comparison is deliberately not
  reused.

The B-10 pin is the strongest signal that the contract was written against the
tree rather than around it. `RUN_STATE_VERSION` is already 7 on this branch
while `src/eval-boundary.test.ts:127` still expects 6, inside PRD 7's
`P-05 finds no eval module importing the run-evidence machinery, and leaves
both schema versions alone`. The contract names that exact assertion as the one
literal outside `src/run-state.test.ts` that moves, declares
`src/eval-boundary.test.ts` in `fileScope`, cites the precedent from the eval
harness slice's own manifest, and bounds the edit to the pin — same test names,
same forbidden-import list, same module set, `EVENTS_SCHEMA_VERSION` still 1.
It also faces the resulting `--testNamePattern P-05` collision head-on instead
of hoping nobody runs it: both `P-05` cases must be green, and neither is
renamed.

## Why one session can deliver it

Twelve behaviors and five preservation properties over a new module is a lot on
paper, and the feasibility question is fair to ask. The answer is on the
branch: `src/preserve-work-recovery.ts` already exists at ~755 lines exporting
every symbol the contract names — `canonicalizeRecoveryRequest`,
`encodeRunScopeFingerprintPayload`, `runScopeFingerprint`,
`isLegalRecoveryTransition`, `evaluateRecoveryEligibility`,
`readLockedAcceptedPair`, `publishAcceptedPairSnapshot`,
`hasOpenRecoveryAttempt`, `admitStaleRenegotiation` — alongside the flag
parsing, the v7 run-state bump and the entry-point refusal. The scope cut of
2026-09-14 is what made that fit, and the four commits on the branch are the
evidence it did. The `beforeLockAcquired` seam keeps the one cross-process test
cheap, no spawned pipeline scenario is added, and the heavy-suite obligation is
scoped to `test:heavy:resume` because `src/run-state.ts` changed.

## Three things to tidy

None of these blocks the lock; all three are cheap.

First, two observable results claim a test asserts something is "unmodified in
the diff" — `src/git.ts` and `src/worktree-processes.ts` in B-05, the lock
primitives' signatures in B-08. A vitest case has no baseline to diff against,
and it does not need one: none of those files is in `fileScope`, so touching
them fails file-scope adjudication. Either restate the clause as the
source-level assertion the harness can actually make, or drop it and let
`fileScope` carry the guarantee.

Second, B-09 says the appended `PENDING` event is "the first mutation on
disk". The scope lock says "the first admitted mutation", which is the true
statement — B-07 publishes a snapshot directory to disk before the lock is
taken. B-09's observable result is already precise about the run-state diff, so
this is a wording slip, but it is the kind of slip an evaluator can fail a slice
on. Say "the first change to run state".

Third, the `src/run-state.ts` line numbers are all `main`-relative and this
branch has moved: `RUN_STATE_VERSION` is at :76 rather than :67,
`PersistedSliceState.branch` at :29, `RunState.scope` at :344,
`withRunStateLock` at :598, `transactRunState` at :627, `adaptLoadedState` at
:1233. Every symbol exists and every claim about it holds, so nothing is
unreadable — but a generator following the numbers lands in the wrong place.
Either refresh them or say once that the symbol names are authoritative.

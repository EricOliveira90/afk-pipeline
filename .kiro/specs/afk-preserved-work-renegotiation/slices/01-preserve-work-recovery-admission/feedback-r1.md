# Contract review feedback — round 1

## What holds

Most of this contract is in good shape, and the parts I checked against the
worktree check out. `PersistedSliceState.branch` really is at
`src/run-state.ts:33` and is optional, so B-05 is right that its absence is its
own refusal reason. `RunState.scope` is at `:273` with `PersistedRunScope` at
`src/slice-scope.ts:9-12`, so B-04's fingerprint input and B-05's "scope of
record is `RunState.scope`, not a re-read of `afk.json`" decision are both
grounded — and that decision resolves the explorer's unknown about which field
"persisted run scope" means, cleanly and in the direction that keeps step 2
inside #278. `RUN_STATE_VERSION` is 6 at `:67` with the running version comment
at `:49-66`, so B-10 and the definition of done describe an edit that exists.
`transactRunState` is at `:545-557` as cited.

The recorded decisions are doing real work rather than restating the PRD. B-01
choosing `optionValue`'s single-token discipline over `parseSliceIdList` — while
reusing only that helper's whole-args scan to catch a second occurrence — is the
right reading of "a list is a refusal here, not an input", and it names the one
piece of behavior (duplicate-occurrence refusal) that has no existing helper.
B-03's refusal to reuse `matchesSliceSelector` avoids importing a second,
differently-shaped number normalization, and its appeal to corroboration against
persisted scope entries answers the explorer's open question about ADR 0065
without needing the planner to guess. B-04's insistence that key order be emitted
explicitly rather than inherited from an object literal is exactly the gap
between the PRD's fixed shape and what `decisionSetFingerprint` actually does.

Non-goals are named issue by issue (#278, #332, #333, #334, #335), and the
`src/scope-amendment.ts` disclaimer heads off the most likely
wrong-mechanism confusion. Keeping `src/git.ts` and `src/worktree-processes.ts`
out of scope and composing over already-exported primitives matches the issue's
own note about where the git-side predicates land.

## What needs to change

**The parser cannot both accept and refuse the same well-formed input.** B-01
and the first test-plan bullet require `parsePipelineRuntimeOptions` to return a
parsed request carrying selector `12` and reason `stale lock`; B-12 requires the
same function to throw a #335 refusal for exactly that input. As written, the
only newly accepted input the pair declares is one the parser rejects, so the
positive half of the parser's regression evidence has nothing to assert against.
The fix is small and mostly editorial: name the seam whose return value carries
the accepted selector and reason (an exported validation helper that
`parsePipelineRuntimeOptions` calls before the #335 guard is the obvious shape,
and it is what makes B-12's "#335's change is deleting one guard" literally
true), and let B-12 own the parser-level throw. The refusal cases in B-01/B-02
are unaffected — those are already observable on the parser itself.

**The declared contention seam is not reachable from the declared lock path.**
B-08 locks through `transactRunState`, but `transactRunState` calls
`withRunStateLock` (`src/run-state.ts:516-522`), which calls
`withFileLock(statePath(...), action)` with no options argument — so the
`afterLockPublished` seam the test plan names (`src/file-lock.ts:110`, fired at
`:165`) has no path to admission's lock acquisition. `src/file-lock.ts` is not in
the file scope, and "Changes to existing behavior" lists only the version bump
and the two parser members, so threading a seam through the shared run-state lock
would be an undeclared change to a primitive every other writer calls. This is
the slice's single cross-process test and the mechanism behind its most
safety-relevant claim, so it needs to be nailed down before the lock, not
improvised by the generator. Either declare the additive optional seam on
`withRunStateLock`/`transactRunState` (`src/run-state.ts` is already in scope, so
this costs one line in the changes section), or name an exported admission seam
the test can interleave against instead.

**One smaller point.** P-05's observable is a branch diff and the absence of two
paths from `fileScope` — both true, both already enforced by the deterministic
file-scope check, but neither is something a `--testNamePattern P-05` run can
produce, even though the definition of done promises a test named P-05. Either
give P-05 an assertion a test can make (that the module reaches git behavior only
through the three named exported primitives is the natural one) or drop
`acceptance:behaviors` from its gates and let the file-scope gate carry it.

## Two things worth watching, not blocking

The slice is on the heavy side for one session — twelve behaviors plus five
preservation behaviors, a new module carrying six responsibilities, a run-state
version bump, and a cross-process test. It is still smaller than the boundary
that was cut on 2026-09-14 and the test plan keeps every scenario at an exported
seam with no spawned pipeline, so I read it as feasible. The riskiest item is the
contention test, which is the same thing F-02 asks you to pin down; resolving
that finding also removes most of the schedule risk.

The explorer's remaining unknown — whether some existing state-machine helper
should back B-11's transition validator — stays open, but it cannot prevent a
lock: B-11 enumerates all four states and every accepted pair, so the behavior is
fully specified regardless of which internals the generator picks.

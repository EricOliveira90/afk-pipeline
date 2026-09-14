# Contract feedback — slice 01, preserve-work recovery admission

The contract pair is testable, evidence-backed and feasible in one generator
session. Below is why, followed by two non-blocking notes.

## Why it locks

**Gates produce relevant evidence.** Every behavior carries `tests` and
`acceptance:behaviors`, and each ID is named in a test whose name the
`--testNamePattern {behaviorId}` gate can select (definition of done, first
box). The typed behaviors — the new parser helper, the canonicalizer, the
fingerprint encoder, the transition validator — additionally carry `typecheck`,
which is where a shape change would actually show. `lint` is correctly unused
because the catalog marks it not executable.

**The parser-language change binds both halves of its regression surface.**
This contract changes what `parsePipelineRuntimeOptions` accepts, so ADR 0060's
two-sided requirement applies. Positive evidence is concrete: B-01 asserts that
`--renegotiate-stale 12 --recovery-reason " stale lock "` returns a request
carrying selector `12` and reason `stale lock`. Rejected-and-boundary evidence
is equally concrete and enumerated: a comma list, a duplicated selector inside
one value, a second occurrence of the flag, a missing reason, a blank reason, a
repeated reason, and either flag alone — seven inputs that must stay rejected,
with pairwise-distinct messages. P-01 pins the existing accepted results and the
exact existing error strings, including `optionValue`'s
`` `${flag} requires a value` `` and the paired preview-command message. The
established harness for this parser is inline unit tests in
`src/cli-options.test.ts`, which is declared in the file scope; no fixture area
is implied and none is left undeclared.

**The B-01 / B-12 split is the honest way to state a flag that is refused on
purpose.** The parser must throw the #335 refusal for exactly the input the
helper accepts. Rather than paper over that, the pair puts the accepted return
on `parseStaleRenegotiationRequest` and the refusal on
`parsePipelineRuntimeOptions`, states that the parser calls the helper first so
B-01's three refusals remain observable on the parser too, and records that
#335's future change is deleting one guard while the helper is untouched. Both
halves are asserted where they can actually be observed.

**The explorer's open unknowns are each resolved to a named field or an
explicit decision, so nothing is left for the generator to guess.** The
"persisted run scope" ambiguity resolves to `RunState.scope`
(`src/run-state.ts:273`, `PersistedRunScope` at `src/slice-scope.ts:9-12`), with
`issues.md` / `afk.json` revalidation named as step 2 and deferred to #278. The
unresolved "recorded slice branch" field resolves to
`PersistedSliceState.branch` (`src/run-state.ts:33`), with its absence given its
own refusal reason. The ADR 0065 question is answered by construction: the
selector resolves against persisted scope entries and their canonical numbers
rather than through `matchesSliceSelector`'s inline `Number(...)` comparison, so
the identity is corroborated whether or not that ADR is formally binding here.
Only the "does a lineage/transition helper already exist" unknown stays open,
and it cannot prevent a lock — a targeted grep either finds a helper to reuse or
confirms the new validator, and either way B-11's table-driven obligation is
unchanged.

**Declared scope fits the repository evidence.** Each of the eleven paths earns
its place: the two new-module files, the parser and its two test files, the
run-state pair, ARCHITECTURE.md for the module row, and the three test files
holding the version pins. `src/git.ts` and `src/worktree-processes.ts` are
deliberately absent, and P-05 states the assertion that keeps them absent —
stubbing exactly `hasUncommittedChanges`, `countCommitsAhead` and `isAncestor`
at their current signatures flips every git-derived eligibility outcome, and no
other export of either module is invoked. Similarly, the ADR 0056 contention
seam is the new module's own `beforeLockAcquired` parameter, which is what keeps
`withRunStateLock`, `transactRunState`, `withFileLock` and `src/file-lock.ts`
out of scope while still reproducing the interleave being proven: the facts
changed after the snapshot and before this process held the lock.

**The v7 bump is handled as a real cost rather than an aside.** B-10 names all
three out-of-file version assertions with file, line and current literal,
including the two that read the version off a loaded state as a bare `6` and so
escaped an importer-based survey. It explains why moving each pin preserves the
property that scenario locked — the #91 approved-baseline locator, the #193
applied waivers, PRD 7's "an eval run writes no run state" — rather than
weakening it, and it cites the precedent of the same pin moving on an earlier
bump. The definition of done then constrains the edit to one literal per file
with no test added, removed or renamed, and adds `test:heavy:qa` and
`test:heavy:resume` because those files and `src/run-state.ts` are touched.

**Feasibility.** Twelve behaviors is a lot, but the work is one new module built
entirely over already-exported seams, two flags on one shared parser, one
additive schema field, three one-literal pins, and one ARCHITECTURE.md row. No
spawned pipeline scenario is added and the single cross-process test is scoped
to one contention seam, so the slice does not pay the integration-suite cost
that makes work in this repo expensive. The non-goals name every neighbour
precisely — `--extend-scope` to #278, attempt execution to #332, verified
rollback to #333, launch-time reconciliation to #334, the completion transaction
and reporting to #335 — and separately rule out `src/scope-amendment.ts` and any
automatic stale-contract detection.

## Two notes worth folding into the next edit of this contract

Neither changes what gets built or what a passing gate proves.

1. **B-09's "first mutation on disk" contradicts B-07.** B-07 publishes a
   snapshot directory to disk before the lock is taken, and explicitly allows a
   published snapshot that no `PENDING` event references. So the lineage event
   is the first *admitted* mutation — as the scope lock already words it — not
   the first on-disk mutation. B-09's observable result is stated correctly
   ("the run-state diff is exactly that single appended event"), so the test
   that gets written is unambiguous; it is the `then` clause that overreaches.

2. **Three observable results attribute diff-level facts to the test gate.**
   B-05 and B-08 say a test asserts that `src/git.ts` /
   `src/worktree-processes.ts` are unmodified and that the lock primitives'
   signatures are untouched "in the diff", and B-06 says a test inspects the
   module's "call graph". A vitest run has no baseline to compare against;
   those properties are enforced by the manifest `fileScope` check and the
   definition-of-done file-scope rule. The testable substance is already
   present next to each claim — per-predicate reason codes, unmoved branch tips,
   stub-driven outcomes, absent lineage — so the surrounding obligations stand
   as written.

# Feedback — slice 04, final evaluation and exact-tree reuse

Most of this contract is in good shape, and the parts that are wrong are wrong
in a checkable way. Three things need changing before it can lock; the fourth
note is a suggestion.

## What already holds up

The reuse decision is the right shape: a pure tree-ID comparison in a new
module, asserted without git or an agent, with no cosmetic-change escape hatch.
Pushing it into `src/final-evaluation.ts` rather than growing the orchestrator
matches the hub rule, and it makes B-01 cheap to prove.

The three places the contract had to decide something, it decided rather than
gesturing. B-02 says exactly where the reuse fact lives (`finalEvaluations` in
`src/run-state.ts`, an additive `final-evaluation-reuse` event, a
`run-summary.md` section) and, importantly, says what it is *not*: not a
`GateEvidence` field, and not the D17 gate-cache `reused` flag. Those two facts
are easy to conflate and the contract keeps them apart. B-04 does the same
service for the partition — `byStage` with an asserted key set and per-stage
stats summing to the totals means a flat summary fails on a missing key instead
of passing vacuously, which is the difference between a real assertion and a
restatement of D11. B-05 pairing the third `QAReviewStage` member with the
`qaArchivePrefix` three-way map in one change closes the trap the issue's code
anchors flagged, and B-07 binds both halves of the allowlist change: the two
newly admitted names and a source path that must still be rejected.

The non-goals are named where they matter — no new gate and no `gate-runner.ts`
edit, no scope-gate call site (that is #195/#132), no role write-scope grader
(#226), no baseline writer (#91 owns it), no cross-role attribution. Those are
the four ways this slice could have quietly grown, and each is closed by name.

## What needs to change

**The `src/run-state.test.ts` edit list does not match the file.** This is the
one that would actually break the build. P-06 names five version literals at
`:250`, `:275`, `:1492`, `:1564`, `:1575` and says nothing else in the file
changes. Reading the file:

- `:250`, `:275`, `:1564` and `:1575` are **input fixtures** — `version: 4` on
  objects handed to `adaptLoadedState` in the B-06 locator tests and the B-13
  malformed-waiver tests. None of them fails on a bump, and rewriting them to
  `5` deletes exactly the "a v4 file still loads" coverage P-06 exists to
  protect. They should stay `4`, and the contract should say so and say why.
- Seven assertions that *do* stamp the current version as the literal `4` are
  not cited and *will* fail: `:151` (v0 load), `:168` (v1 upgrade), `:359` and
  `:371` (load and on-disk re-stamp), `:1506` (inside the B-13 upgrade loop),
  `:1528` and `:1531` (v3 re-stamp path). The title at `:1491` also reads
  "upgrades every earlier version to 4".

So as written, a generator that follows the contract literally lands a red
suite and is forbidden from fixing it. Restate the list against the file:
enumerate the assertions moving to `5`, name the four fixtures that stay at
`4` as the backward-read evidence, and scope the "nothing else changes" clause
to that enumeration. The Definition-of-done box needs the same correction.

**`ARCHITECTURE.md` is declared under the wrong casing.** The manifest's
`fileScope.paths` has `architecture.md`; the tracked file is
`ARCHITECTURE.md`, which is also what the contract's own file list and B-12
say. B-12 obliges you to add rows to that file, so the one edit the behavior
requires is authorized under a path that is not in the tree. Fix the manifest
entry to match the tree.

**B-09's round-counter clause has no seam to assert it from.** The observable
result asks for "the generator round counter incremented by exactly one across
the return", asserted by a unit test. Round accounting lives in
`src/accepted-candidate.ts` (`ImplementationAttemptPlan`, computed through
`implementationRoundsRemaining`), which is in neither file list. The only
in-scope home for the transition is `src/orchestrator.ts`, and no declared
test exercises it — B-09 is bound to no spawned scenario, where B-03 and P-01
both explicitly say "an it on an existing spawned scenario". The rest of B-09
is well specified (the invalidated tree ID read back through
`finalEvaluationFor`, `decideFinalReuse` refusing `reuse` even on exact
equality, the untouched attempt count, nothing rewritten in the baseline
record); it is just this clause that can go unproven while the gate reads
green. Either name the pure seam that reports which budget a routing decision
consumes, bind the clause to a named existing spawned scenario, or bring
`src/accepted-candidate.ts` into scope in both files.

## One suggestion

The test plan's ordering — pure module and schema, then the cross-cutting
constants, then the wiring — is genuinely useful and worth keeping. The
sentence after it, that a session stopping after the first group "leaves a
coherent, green half", is less so: twenty-one paths is already a full session,
and offering a stopping point tends to produce one. Drop the fallback and keep
the order, or split the slice so the first group is the whole contract.

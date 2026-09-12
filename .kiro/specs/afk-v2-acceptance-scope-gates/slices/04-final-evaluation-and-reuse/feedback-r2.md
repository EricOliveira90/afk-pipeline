# Contract review — round 2

Slice 04, final evaluation and exact-tree reuse (GH #96). Companion to
`contract-review.json`.

## What the revision fixed

Both blocking gaps from round 1 were about the same thing: the contract asserted
facts into stores it had declared unmodifiable and out of scope. The revision
solved that by stopping the routing through gate evidence entirely and giving
the slice its own record.

**The reuse fact (F-01).** B-02 no longer writes anything into `GateEvidence`.
It names one field in one in-scope store — `finalEvaluations[ghIssue].decision
=== "reuse"` on `RunState` in `src/run-state.ts`, placed beside the existing
`approvedBaselines` (`src/run-state.ts:149`) and read back through a new
`finalEvaluationFor` reader modelled on `approvedBaselineFor`
(`src/run-state.ts:813`) — plus an additive `final-evaluation-reuse` run event
and the `run-summary.md` section. All three files were already in `fileScope`,
so the scope did not have to grow. The contract says three times over (behavior
body, authorized-changes list, DoD) that this marker is *not* the D17 gate-cache
`reused` flag on `GateResult` (`src/gate-runner.ts:161-162`) and that neither is
read as the other. That is the distinction round 1 asked for, made explicit
rather than left to a reader.

Worth noting for the ship record: this puts the contract at odds with the
literal wording of prd.md D20 (line 390), which says the reuse is "recorded as
reuse in gate evidence and `run-summary.md`". The contract makes the deviation
and its reason visible in the behavior body — prd.md line 722 says #96 ships no
gate, and prd.md's own file-scope map assigns this slice a "reuse record" in
`run-state.ts` and a "reuse event" in `run-events.ts`. Choosing the file-scope
map over D20's prose is the right read of two sources that disagree, and it is
stated rather than silent, so it is not a finding.

**The invalidation (F-02).** B-09's "downstream evidence" now has a store and a
shape. The store is the same `finalEvaluations[ghIssue]` record; invalidation
appends the rejected candidate tree ID to `invalidatedCandidateTreeIds`, drops
the record's `baselineTreeId`/`baselineArtifactPath` citation of it, and makes
`decideFinalReuse` refuse `reuse` against that tree ID even on exact string
equality — a nice touch, because it closes the loop back to B-01 rather than
leaving invalidation as a passive marker. P-03 is updated to say explicitly that
none of this rewrites or deletes the baseline record, its artifact, or a
gate-evidence artifact, which is what kept the round-1 version from being
lockable.

**The round charge (F-03).** Both the manifest observable and the test-plan
scenario now assert the generator round counter incremented by exactly one
across the return. D19's load-bearing half is now asserted, not implied.

**The partition (F-04).** `byStage` on the baseline→final variant's own result
type, keyed by the stage ids that ran, with the single-stub case pinned to
exactly one key equal to the stub's stage id constant and per-stage stats
summing to the totals. A flat summary now fails on a missing key instead of
passing. `ChangeSummary` `version: 1` is untouched, so P-04 still holds.

**The surface (F-05).** No re-scoping was asked for and none happened. The only
`fileScope` edit is `ARCHITECTURE.md` → `architecture.md`, which is a no-op:
`normalizeAcceptanceManifestPath` lowercases every path
(`src/acceptance-manifest.ts:71`), so the gate sees the same scope. The test
plan now opens with an explicit delivery order, which is what the finding asked
for.

## Two things to tidy, neither blocking

**Diff claims on unit tests.** B-02's observable ends with "src/gate-runner.ts
unmodified in the diff", and B-09's with "no baseline write site in the diff",
both attributed to "a unit test". A unit suite cannot see the slice diff. The
mechanism that actually enforces the first is the file-scope gate — and it
already does, unconditionally, because `src/gate-runner.ts` is absent from
`fileScope`. Move those clauses to the file-scope gate (or the DoD's
out-of-scope-paths line) and leave the suite the clauses it can assert. Nothing
is unlockable here; every substantive clause in both observables is genuinely
unit-testable.

**The delivery order and B-09 disagree.** The order puts B-09 in the first,
pure-module group, but the same revision made B-09 depend on `finalEvaluations`
and `finalEvaluationFor` in `src/run-state.ts` — which the order defers to the
third group with B-02. A session that stops after group one therefore cannot
have B-09's asserted observable green, which is exactly the outcome the order
was written to prevent. Either pull the `finalEvaluations` type and reader
forward into group one, or split B-09 so its group-one half is the pure
`decideFinalReuse`-refuses-an-invalidated-tree assertion and its record half
lands with B-02. This is a sequencing note; the contract's observables are fine
either way.

## Standing guidance for the generator

The three genuine trap doors in this slice are unchanged and all three are now
locked by an assertion: `qaArchivePrefix` must become three-way in the same
change as the `QAReviewStage` member (otherwise final artifacts silently archive
as `uat-review-*`), the copy-back allowlist must admit exactly two new names and
nothing else, and `src/gate-runner.ts` must stay untouched. The remaining
explorer UNKNOWNs — the `evaluator-final` role string, the stub stage's exact
interface, the D20 comparison's call site — are all decisions the contract now
either records or leaves safely to implementation inside declared scope.

# Contract review — round 1, slice 02 (#85) behavior coverage gate

## What is already solid

Most of this pair is precise in the way a lockable contract has to be. The
call-site citations check out against the tree: `preQaDeclarations` really is
built at `src/orchestrator.ts:5523`, and the "two predicates at `:5526-5535`
that today ask only whether a declaration carries a `command`" are exactly
`preQaHasExecutable` (`:5526-5527`) and the `checkpoint` ternary (`:5529-5535`),
with `prepare` gated on the former at `:5550-5552`. `GateDeclaration.stage` is a
bare `string` (`src/gate-runner.ts:74`), so stage `acceptance` needs no union
widening, and one aggregate declaration keeps
`assertGateEvidenceReleasesEvaluation`'s one-result-per-declaration arithmetic
intact — the per-behavior alternative would not have. Routing an unreadable
manifest to a throw is right: the in-process branch already converts a throw
into `INFRASTRUCTURE`. The no-binding PASS is the right call for the same
reason the contract gives — a required gate reporting `SKIPPED` would stall
evaluation. The non-goals are unusually complete: cost control, the second
matcher, prompt edits, the findings-shape and evidence-version freeze, and the
sibling gates are all named and pushed away.

Scale is not a concern. Fourteen files sounds heavy, but the pieces are small
and mostly additive — one policy key, one resolver, one pure matcher, one
declaration builder, one call-site append, one event, one summary section — and
the test plan holds the spawned cost to a single `it` on an existing scenario's
shared pre-QA evidence, which is the right rung of the ladder. One generator
session can do this.

The pre-QA placement is also defensible even though the PRD sent the sibling
scope gate post-QA: that carve-out exists because ADR 0048's amendment warrant
needs an evaluator finding, and an untested behavior has the opposite
requirement — it should not reach the evaluator at all.

## What has to change before this can lock

**The matcher's input is assumed rather than evidenced, and the test plan makes
the assumption unfalsifiable.** The PASS rule (`numTotalTests >= 1`,
`numFailedTests === 0`, `numPassedTests === numTotalTests`) and the untested rule
(`numTotalTests === 0`) both depend on what a `--testNamePattern`-filtered vitest
run actually reports, which the explorer recorded as unknown and which neither
`prd.md:229` nor the anchors file settles beyond `numTotalTests`. If a filtered
run reports its non-matching tests as skipped, `numPassedTests ===
numTotalTests` never holds and PASS is unreachable; if a run that matches
nothing collects no test file and emits no JSON, `numTotalTests === 0` never
occurs and the untested case lands in B-05's CONFIGURATION branch instead of the
untested FAIL that AC3 asks for. Hand-authored fixtures pass in either world, so
nothing in this manifest can catch it. Fixtures recorded from real filtered runs
(match-and-pass, match-and-fail, no-match) fix this without the suite ever
spawning vitest.

**The declared-policy branch is unowned.** The scope lock promises resolution
"from `gatePolicy.acceptance` when declared, from the derived baseline
otherwise", but B-01 stops at parsing, B-02 is conditioned on no `acceptance`
key, and B-04 runs "the plan" without naming its source or the preference order.
Nothing proves a declared `command`/`args`/`matcher` is what the gate spawns.
B-07 makes this the live branch for this repository, so the untested path is the
one this slice will run on.

**The lock-time catalog entry has the same gap, with sharper consequences.** The
catalog handed to `validateAcceptanceManifestBindings` is
`resolveBaseGateDeclarations(ctx.worktreeDir)` (`src/orchestrator.ts:1375`,
`:3257`; the planner display at `:1334`, `:2860`, `:3324`) — a function of `cwd`
alone, with no view of `gatePolicy`. The contract states the
`acceptance:behaviors` entry only inside B-02's no-policy Given, with the
derived command. A project that declares the member — this one, after B-07 — or
declares it without a `tests` script gets no entry, and then AC9's refusal fires
on a legitimate binding and no slice here can lock an acceptance-bound behavior.
Say what the catalog carries in the declared case, and how the policy reaches
that site.

Two smaller things. The materialization and `prepare` widening is keyed on "the
plan is present", so a project with a test script but no typecheck or lint script
starts materializing and installing on every round even when nothing is bound
and the gate is a no-op — which is a change to a case P-03 calls unchanged;
either key it on a bound behavior or say so in P-03. And B-07's
"ARCHITECTURE.md stays within its line cap" has nothing to check it: no cap
constant or assertion exists in `src/`, so the `tests` gate cannot produce
evidence for that clause, unlike its `loadGatePolicy` half
(`src/gate-policy.ts:325`), which it can.

## Budget warning

The pair is 19,825 bytes against the anchors file's 20,000-byte combined hard
limit — 175 bytes of room. The additions above will not fit unless restated PRD
and ADR rationale comes out. Trim prose, not obligations; a breach here kills
the slice at `CONFIGURATION` rather than on its merits.

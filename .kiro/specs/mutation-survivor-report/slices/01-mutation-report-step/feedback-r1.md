# Contract feedback — round 1

## The concurrency hole is closed

The fork-wrap design now hangs together. Three things had to line up and all
three do:

- The rejection exit is bounded by the same mechanism the rejoin exit uses —
  one exported helper, one `MUTATION_STEP_BOUND_MS`, its own captured origin —
  instead of an open-ended settlement await. The contract even follows the
  swallowed-`terminate` branch through to the same conclusion, which is where
  the previous shape leaked.
- The pre-spawn window is closed by ordering rather than by hope: the flag is
  set before `terminate`, and the step reads it with no `await` between the read
  and the seam invocation, so the two orderings the contract enumerates really
  are the only two.
- The window is now *observable*. The `mutationScope` seam lets a test hold the
  step ahead of the seam and assert an invocation count of `0` after the
  rejection has already left the gate. That is the assertion the earlier round
  was missing, and it lands in `src/ship-gate.test.ts`, which already drives
  `runShipGate` directly 25 times — no spawned scenario needed.

The three new seams sit in the documented `runCommand`/`sanityRunCommand` shape
on `RunShipGateArgs`, and the contract is explicit that none of them is a
configuration surface or a way to move the bound. That is the right guardrail
for a test seam that exists to make a deadline observable.

## What still blocks the lock

One behavior has nowhere to be asserted. B-07 is the refusal firing from the
orchestrator's manifest fail-closed block before any worktree, branch, or agent
dispatch — the ordering claim that makes GH #303 AC2 mean something. Its
observable points at "the orchestrator test", but `src/orchestrator.test.ts` is
not in the file list or the manifest's `fileScope`, so the generator cannot
write that test, and `--testNamePattern B-07` would match nothing while the
gate still reports green.

There is no in-scope fallback today. The existing fail-closed throw is
untested: the `Run scope conflicts with afk.json selectedSlices` message at
`src/orchestrator.ts:8506` has no assertion anywhere in `src/`, and
`assertWithinManifestScope` is not named by any test file. B-06's pure function
in `src/preflight.test.ts` deliberately cannot see the ordering — it asserts
only the returned reason. And the contract's own non-goal ("no new spawned
pipeline scenarios") rules out reaching the path by spawning a run. So B-07 as
written is unsatisfiable, not merely under-scoped.

Two ways out, either is fine:

1. Put `src/orchestrator.test.ts` in scope and name the existing scenario whose
   shared result the new `B-07` case rides, stating plainly that no new spawn is
   added — the repository's own preference ladder favours an extra `it` on an
   existing spawned scenario over a new spawn.
2. Move the observable to a seam that is already in scope and can still see the
   ordering — a source-position assertion in the shape of
   `src/eval-boundary.test.ts`'s source-reading cases, checking the refusal call
   site sits inside the `assertWithinManifestScope` block and ahead of the
   `updateRunState` call at `src/orchestrator.ts:8509`.

Whichever you pick, the manifest's `observableResult` should name the file, the
way every other behavior in this manifest does.

## One smaller note

B-13 settles the shape of the run-state fact (one optional field, additive
event member, bump plus reader) but not which identifier the "run-ID
provenance" value actually is. `runSlug` is already on `RunShipGateArgs` and
`src/run-identity.ts` owns the slug helpers, so this is a naming gap rather than
a design gap — but naming it turns the round-trip assertion from "the field came
back" into "the field came back with the run's slug in it". Worth a clause.

## Verified while reviewing

- `ARCHITECTURE.md` is exactly 150 lines and the `| Ship path |` row exists with
  `src/preship.ts`, `src/handoff.ts` in its internals cell, so widening that
  cell genuinely adds no line and the `<= 150` cap assertion at
  `src/eval-boundary.test.ts:293-304` needs no edit.
- The two `RUN_STATE_VERSION` hard pins are exactly the two the contract names
  (`src/run-state.test.ts:990`, `src/eval-boundary.test.ts:127`); every other
  reference uses the constant symbolically, including
  `src/orchestrator.test.ts:5829`.
- `src/eval-boundary.test.ts`'s `P-05` case is real and matches the contract's
  description of it — import-boundary scan, `EVENTS_SCHEMA_VERSION` pinned at
  `1`, `RUN_STATE_VERSION` at `6` — so the pin update is a literal-and-comment
  move as declared.
- There is no `src/run-events.test.ts` and no exhaustive payload-member
  assertion, so an additive `RunEventPayload` member needs no test file beyond
  those already in scope.
- `src/logger.ts:271`'s `readQualityStageOutcomes` and the two
  `buildPrCreationPlan` sites passing `qualityStages` are the precedent B-14 and
  B-15 claim they are.

## Scale

This is a large slice — 22 behaviors across 19 implementation files, a schema
bump, a new module, and a concurrency change in the ship gate. It is feasible in
one session only because every assertion lands at an existing unit seam and no
test waits on a real bound; the contract's discipline about that is what keeps
it deliverable. Keep that constraint intact through the revision: the fix for
B-07 should not become the slice's first spawned scenario.

# Contract feedback — round 2

Slice: `01-mutation-report-step` (GH #303)
Companion to round 1: `feedback-r1.md`

## What the revision fixed

**B-07's observable now lives where the slice can write it.** The revision takes
branch (b): the ordering claim is a source-position assertion in
`src/mutation-report.test.ts`, the refusal *reason* stays at B-06's pure-function
seam in `src/preflight.test.ts`, and `src/orchestrator.test.ts` stays out of the
file scope. Both named files are in `fileScope.paths`, so
`--testNamePattern B-07` now matches a test the generator is allowed to author,
and the spawned-scenario non-goal is untouched — nothing in the declared plan
drives `runPipeline`.

I checked the declared shape and every anchor against this worktree rather than
taking the planner's word for it:

- `src/eval-boundary.test.ts:166-186` is a genuine source-position case (`P-01`),
  reading a source file as text and comparing `indexOf` positions. The shape the
  contract borrows exists.
- `assertWithinManifestScope({` occurs exactly once, at `src/orchestrator.ts:8501`.
  The only other mention of the symbol is the import at `:223`, which does not
  match the `({` form — so the pin is unambiguous.
- `const initialized = updateRunState(` occurs exactly once, at `:8509`.
- `runLaunchPreflight(` occurs exactly once, at `:8545`.
- `runWave(` occurs exactly once, at `:9178`.

The load-bearing half of AC2 is therefore observable: the refusal sits inside the
`8497-8508` fail-closed block and ahead of `:8509`, which is the run's first
run-state mutation, and ahead of `runLaunchPreflight(`, which is what makes
`--preflight-report-only` structurally unable to reach it (P-04, ADR 0042).

**B-13 names its provenance value.** The identifier is the run's `runSlug`, and
the citations behind that choice hold: `runSlugForProviderName` is declared at
`src/run-identity.ts:23`, `runSlug: string;` is a member of `RunShipGateArgs` at
`src/ship-gate.ts:584`, and `src/run-state.ts:1389` is the `runSlug` a caller
hands to `updateRunState` at `:1394` — so the state file is already keyed by that
slug and no new identifier is minted. The round-trip through `adaptLoadedState`
now has a definite value to compare, and the Test plan bullet, the Definition of
done item and the New patterns entry all carry the same value, so the contract
does not disagree with itself about what is persisted.

One imprecision, noted rather than raised: `src/run-state.ts:1389` is a caller's
parameter (`saveAppliedWaivers`), not `updateRunState`'s own signature. The
substantive claim is correct.

## One thing still worth a small correction

B-07's `then` closes with "and precedes `runWave(`, at or after which every
worktree creation, branch creation and agent dispatch happens", and the matching
Test plan bullet says the same. The branch-creation half of that sentence is not
what the code does. Between `:8509` and `runWave(` at `:9178` the orchestrator
already creates and can fast-forward the feature branch —
`git.createBranch(repoRoot, featBranch, baseBranch)` at
`src/orchestrator.ts:8627`, then
`git.ensureFeatureBranchContainsHostHead(...)` at `:8640` — and ADR 0029
merge-only recovery merges slice branches from `:8921` onward.

This is rationale, not assertion. Every position the test compares is a true fact
about the file, and the guarantee the gate actually needs is already carried by
the refusal preceding `const initialized = updateRunState(` at `:8509` — the
run's first mutation, which sits ahead of all of the branch work above. No broken
implementation slips through because of the sentence; it just claims `runWave(`
is a boundary it is not, which will read as wrong to whoever next opens
`orchestrator.ts` at that line. Either scope the `runWave(` clause to worktree
creation and agent dispatch, or drop the clause and rest the claim on `:8509`.
The pinned positions themselves need no change.

## Notes that are not findings

- The `fileScope` entry `architecture.md` differs from the repository's
  `ARCHITECTURE.md` only in case. `fileScope` paths are lowercased comparison
  keys, so this is not a defect and needs no revision.
- B-07 picked up the `tests` gate this round. It is redundant with
  `acceptance:behaviors` for a source-text assertion, but it is harmless: the
  full suite already runs for B-13, B-16, P-01, P-02 and P-05, so nothing new is
  spent. It also means the `src/run-state.test.ts:990` pin — which lives in an
  `it` named `[behavior:#87:B-14]` and so is not reachable from
  `--testNamePattern B-13` — is still gated, by `tests` on B-13.

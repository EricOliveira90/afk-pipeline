# Extract post-wave shipping into a ship gate module

**Status:** Accepted
**Date:** 2026-08-23

## Context

`runPipeline` had become the owner of two different kinds of orchestration.
Its main path resolved the run scope, scheduled DAG waves, and recorded slice
outcomes. After the last merge, the same function also contained the complete
shipping decision:

- discover and run the pre-ship sanity commands;
- reuse a sanity PASS cached by feature-branch tree SHA;
- render and invoke the architect reviewer and PM reviewer;
- retry guardian infrastructure failures;
- reuse favorable review verdicts cached by feature-branch commit SHA;
- commit guardian artifacts regardless of verdict;
- persist the refreshed review phase;
- decide whether the normal or override PR gate opened;
- push and create a draft PR; and
- recover the URL of a PR that already existed.

That inline phase was several hundred lines and depended on state from the
surrounding function. Testing one shipping behavior therefore required a full
pipeline fixture: issue parsing, DAG construction, slice worktrees, generation,
QA, merge, and only then the behavior under test. The interface exposed by
`runPipeline` was too broad to make the post-wave decision independently
testable.

Two related clusters had the same locality problem.

First, the pre-ship sanity command policy lived near the top of
`orchestrator.ts`. ADR 0012 requires evaluator QA and the post-merge gate to
derive commands from the same ordered set. `resolveSanityCommands` therefore
has two legitimate consumers and cannot become a private detail of the
post-wave implementation.

Second, migration validation lived in `orchestrator.ts` even though it is a
standalone post-PASS gate. `migration-gate.test.ts` already described that
module in name and behavior but imported its implementation from the
orchestrator.

ADR 0015 defines the load-bearing shipping semantics. A failed sanity check,
an unfavorable or absent guardian verdict, and cancellation before the gates
run are blocked ships. `--open-pr-on-override` is successful when it overrides
a real unfavorable PM judgment under a favorable architect judgment. Push and
GitHub CLI failures remain best-effort and do not reverse a ship decision.
Review cache keys, infrastructure retries, artifact commits, and existing-PR
recovery must remain unchanged.

The guardian failure classifier is not part of this extraction.
`classifyReviewFailure` stays in `artifacts.ts`; moving that agent-result
classification belongs to the separately catalogued AgentRunner work.

## Decision

Introduce three modules and make `runPipeline` their caller.

### `preship.ts`

`preship.ts` owns the pre-ship sanity command policy:

- the ordered `SANITY_STEPS` list;
- package-script discovery;
- `resolveTestCommand`;
- `resolveSanityCommands`; and
- `runPreShipSanity`.

`SANITY_STEPS` remains private. The evaluator-QA prompt and the post-merge ship
gate consume exported functions that walk the same list, preserving ADR 0012's
single source of truth. Missing scripts are still skipped, `test:run` still
precedes `test`, and an unreadable or absent `package.json` still produces no
gate failure.

### `migration-gate.ts`

`migration-gate.ts` owns `MigrationValidation`,
`DEFAULT_MIGRATION_VALIDATION`, local-stack and linked validation, the public
`verifyMigrationSync` dispatcher, and `sliceTouchedMigrations`.

The orchestrator supplies the slice worktree and feature branch; the module
decides whether and how validation runs. The existing migration test suite now
imports this module directly with its cases unchanged.

### `ship-gate.ts`

`ship-gate.ts` is the deep module for the post-wave shipping decision. Its
`runShipGate` interface accepts:

- the prepared feature-branch review directory;
- repository, branch, PRD, and specs identifiers;
- the rendered invocation scope and GH issues closed by the PR;
- the persisted review phase loaded from run state;
- the guardian invocation function;
- a narrow `RunJournal` handle containing only the methods this phase uses;
- cancellation; and
- the review retry, timeout, serialization, duration, and override settings
  this phase actually reads.

The module returns a `SHIP` or `BLOCKED` verdict and a structured PR outcome:
whether opening was requested, whether it was overridden, and any created or
recovered PR URL and number.

The verdict records the gate decision, not remote command success. Once
favorable guardian outcomes or a valid operator override open the gate, the
result is `SHIP` even if push or `gh pr create` fails. This preserves ADR
0015. A failed sanity check, closed guardian gate, or pre-gate cancellation
returns `BLOCKED` with the existing operator-facing reason.

The module owns:

- sanity cache lookup by tree SHA;
- guardian prompt rendering and invocation;
- guardian infrastructure retries and cancellation propagation;
- favorable review cache lookup by commit SHA;
- serial or parallel guardian scheduling;
- guardian artifact commits;
- review-phase persistence against the post-commit tree and HEAD;
- normal and override PR planning;
- push and draft-PR creation; and
- existing-PR lookup after creation failure.

`buildReviewScopeBlock` and `buildPrCreationPlan` move with the behavior they
describe and remain exported pure functions. `classifyReviewFailure` remains
in `artifacts.ts` and is called by the ship gate.

`runPipeline` retains review-worktree acquisition and cleanup because that
lifetime is coupled to the feature-branch checkout already managed by the
orchestrator. After the wave loop it prepares the worktree, calls one ship-gate
interface, copies the returned blocker and PR outcome into final summary and
handoff state, and removes a scratch worktree when one was needed.

The `ShipCommandRunner` seam is internal test support for push and GitHub CLI
commands. Production uses `execFileSync`; direct tests inject a deterministic
runner. Git inspection and guardian artifact commits continue through the
existing `git.ts` module.

## Verification strategy

Existing orchestrator, resume-integration, and QA-orchestration suites continue
to pin end-to-end behavior and exit semantics.

`ship-gate.test.ts` tests the module through its interface with a stubbed
guardian invocation and no DAG or wave machinery. It directly covers:

- unchanged-SHA sanity and favorable guardian cache hits;
- guardian infrastructure retry and recovery;
- an override PR for `SHIP` architect plus `FIX-BEFORE-SHIP` PM; and
- recovery of an existing PR after `gh pr create` fails.

The pre-existing sanity drift test continues to assert that evaluator QA and
the post-merge gate execute the same command set. The migration test cases are
unchanged apart from importing `migration-gate.ts`.

## Consequences

`runPipeline` reads as scope resolution, wave orchestration, one ship-gate
call, and summary construction. Post-wave behavior can change and be tested
through a narrow interface without constructing slices or running a DAG.

Sanity command policy and migration validation each have one module and one
obvious import location. CLI migration option types no longer depend on the
orchestrator module.

The ship gate still coordinates local Git and filesystem effects. Those
effects are part of its job: caching, evidence commits, and PR recovery form
one shipping decision whose ordering is defined by ADR 0015. Splitting them
into pass-through modules would enlarge the caller's interface without
improving testability.

The orchestrator still owns feature-branch review-worktree lifetime. Moving
that lifetime into the ship gate would require a wider repository-management
interface and would hide cleanup behavior already shared with merge
orchestration.

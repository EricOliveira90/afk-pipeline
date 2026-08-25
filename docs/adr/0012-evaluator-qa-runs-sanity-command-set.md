# ADR 0012 — evaluator-qa runs the post-merge sanity command set

**Status:** Accepted
**Date:** 2026-05-26

## Context

Each slice goes through two correctness checks:

1. **evaluator-qa** runs inside the slice's worktree, before the slice
   is merged onto the feature branch. It is the only barrier between
   the generator and a merged commit.
2. **`runPreShipSanity`** runs once after every slice has merged, on
   the feature branch in a single review worktree, before guardian
   reviews and PR creation.

Until this change, evaluator-qa ran only `{{TEST_COMMAND}}` (the
project's test runner — `pnpm test:run` or `pnpm test`), while
`runPreShipSanity` walked `SANITY_STEPS = [typecheck, lint, tests]`.

In the consumer project's PRD 029 run, all four slices reached
`Verdict: PASS` from evaluator-qa, then the post-merge gate caught:

- `noUncheckedIndexedAccess` violations (`opps![0].id`) in an
  integration test.
- `@typescript-eslint/no-explicit-any` (`supabase: any`) in a server
  action.

Both are exactly the failure modes typecheck and lint exist to catch.
Tests passed because indexed-access and `any` are compile-time errors
that vitest, by default, doesn't surface — `tsc --noEmit` does.

The post-merge gate catching them is too late. By that point the
human either has to fix it themselves (defeating the AFK premise) or
a corrective slice has to be added. The fix belongs at the slice
boundary.

## Decision

Evaluator-qa runs the **same command set** the post-merge sanity gate
runs, derived from the same `SANITY_STEPS` constant.

`resolveSanityCommands(cwd)` returns the ordered list of `pnpm run
<script>` invocations the gate would execute. The list is rendered
into the evaluator-qa prompt as `{{SANITY_COMMANDS}}` and the prompt's
Pass 1 instruction now reads "run **every** sanity command below — any
non-zero exit = FAIL", replacing the single `pnpm test` line.

`resolveSanityCommands` and `runPreShipSanity` walk the same constant
in the same order with the same fallback rules, so they cannot drift.
A drift test (`evaluator-qa sanity command set matches the post-merge
gate`) records the commands `runPreShipSanity` actually executes for a
given `package.json` and asserts the recorded sequence equals
`resolveSanityCommands` output.

### Amendment (2026-08-25, #101)

The command set includes the dependency install that makes the steps
runnable, not only the `pnpm run <script>` steps. A review or slice
worktree is a fresh `git worktree add` with no `node_modules`, so every
step failed instantly and the gate read the environment gap as a red
suite.

The single source is therefore `resolveSanityPlan(cwd)`, which returns
one ordered plan — an optional `prepare` command followed by the
`SANITY_STEPS` commands. `resolveSanityCommands` renders that plan,
`runPreShipSanity` executes it, and `resolveBaseGateDeclarations`
projects its steps. A step that is not a `package.json` script can no
longer be invisible to the drift test, because the test records the
runner's actual invocations rather than script names.

`prepare` is `pnpm install --frozen-lockfile`, present only for a
project with a checked-in `pnpm-lock.yaml` and at least one sanity
step. It runs unconditionally rather than guarded on
`existsSync("node_modules")`: a partial tree from an aborted install
passes an existence check and reproduces the bug, and
`--frozen-lockfile` is itself the lockfile-state check — near-free when
the store is already satisfied. A consumer on another package manager
gets no install rather than a `pnpm install` that would misinstall.

A failure that means the commands never really ran — the install
failed, or `pnpm` is absent from PATH — is reported with
`failureKind: "CONFIGURATION"`, the same `GateFailureKind` vocabulary
the per-slice base gates emit (`gate-runner.ts`), so an operator can
tell a broken environment from a red suite. The gate emits no
`gate-outcome` event: that event is per-slice and carries slice,
round, and evidence-artifact identity the aggregate phase does not
have. The `run-phase-ended` event carries the kind instead.

## Consequences

**Positive**

- The class of failures that motivated this ADR (typecheck + lint
  errors slipping through QA) is caught at slice time, where the
  generator can still react in-loop.
- No duplicated logic: both functions read from `SANITY_STEPS`. Adding
  a step (e.g. `format:check`) updates both call sites simultaneously.
- "Skip steps whose primary AND fallback are absent" is honoured in
  both directions — projects without a `lint` script aren't
  false-failed at QA, mirroring the gate.

**Negative**

- Slice runtime grows by one `tsc --noEmit` and one lint pass per QA
  round. On the consumer project these add ~30 s; small relative to
  the generator and test phases.
- The agent must execute multiple commands rather than one. The
  prompt now lists them as a bullet block; failure to run any of them
  would be visible in `qa-report.md` and caught by Pass-1's
  evidence-citation rule.

**Alternatives considered**

- **Run typecheck/lint inside `{{TEST_COMMAND}}` itself** by changing
  `resolveTestCommand` to return a chained command. Rejected: the
  generator prompt also uses `{{TEST_COMMAND}}` for tracer-bullet
  iteration, where running typecheck after every red test would slow
  the inner loop without commensurate value. Generator gets the test
  command, evaluator-qa gets the full sanity set.
- **Move the post-merge gate earlier** so it runs per-slice on the
  feature branch. Rejected: the gate runs once on the merged
  aggregate; running it per-slice would multiply runtime and still
  not catch slice-local violations until after a wasted merge.

## References

- `src/orchestrator.ts` — `SANITY_STEPS`, `resolveSanityCommands`,
  `runPreShipSanity`.
- `prompts/evaluator-qa.md` — `{{SANITY_COMMANDS}}` rendering.
- `src/orchestrator.test.ts` — drift test pinning the equivalence.

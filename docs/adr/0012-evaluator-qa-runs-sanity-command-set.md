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

### Amendment (2026-08-28) — the same tree is not tested twice

The decision above says *what* evaluator-qa runs. It said nothing about
the fact that the orchestrator runs the same set, on the same tree,
minutes earlier — and measurement showed that duplicate is the single
largest avoidable cost in a QA round. On `run-20260827` a base gate
took 739.3 s and the QA round that followed spent 772.5 s reproducing
it on a tree that had not changed. Run 3's second QA round shows the
intended shape by accident: it passed on the base gate's evidence with
34 s of commands.

**Evaluator-qa may skip a base gate's command when the orchestrator
authorizes it, and only then.**

At QA dispatch the orchestrator renders `{{BASE_GATE_AUTHORIZATION}}`
into the evaluator-qa prompt. When the authorization is granted it
names, per covered gate, the command, its PASS status and the timestamp
it finished, plus three citable identifiers: the gate evidence
artifact's repo-relative path, the gate run's attempt ID, and the tree
sha. The evaluator may skip exactly those commands in Pass 1 and cite
that evidence in their place. Every sanity command the block does not
name — notably `pnpm install --frozen-lockfile`, which ran in the gate's
own checkout and did not populate the evaluator's — it still runs.

#### This is not agent self-certification

The distinction is the whole basis for accepting the skip, so it is
worth stating flatly. Every fact in the authorization is the
orchestrator's own: it derived the declarations from `resolveSanityPlan`,
executed them itself through `runGates`, verified the resulting evidence
artifact against its recorded digest with `verifyGateEvidence`, and
hashed the candidate tree itself. No agent is asked to attest that
anything passed, and no agent's claim is taken as input. The evaluator
is handed a conclusion the orchestrator can prove, and told it may cite
it. ADR 0012's original concern — an agent asserting a command was clean
when it never ran it — is untouched, because the agent is not the one
asserting.

#### Fail closed on the tree sha

The authorization is valid only when the tree the gates ran on is
*byte-identical* to the tree under review. `resolveCandidateTreeId`
(`gate-runner.ts`) hashes the candidate at QA dispatch the same way
`createCandidateCheckpoint` hashed it for the gate run — one shared
implementation, deliberately, because a second way of hashing the
candidate would let the two disagree and the authorization would then
assert something about a tree nobody tested.

`authorizeBaseGateSkip` (`qa-gate-authorization.ts`) refuses on any
other state, each with a reason rendered into the prompt: the tree
could not be hashed, the shas differ, a gate has no result, a gate
result carries a different tree, a gate is not `PASS`, the project
declares no executable gate, the evidence has no citable path. A
refusal tells the evaluator to run the whole sanity list — which is
this ADR's pre-amendment behaviour. **A refusal is never worse than the
status quo; it is the status quo.** The decision is re-taken per QA
attempt, so an infrastructure retry — which archives a report into the
worktree and therefore moves the tree — falls closed rather than citing
a stale run.

#### The skip is auditable

`QAReviewAttemptRecord` gains an optional `baseGateCitation`
(`evidenceArtifactId`, `attemptId`, `treeId`, `gateIds`), written by the
orchestrator into `qa-review-r<N>-a<M>-record.json` beside that
attempt's verdict. Citation and verdict therefore cannot be separated
later. The key records what the orchestrator *authorized* and on which
tree — the fact the orchestrator can assert. Whether the evaluator took
the skip is visible in its report's command log, read next to this
citation. The key is optional rather than nullable so that records
archived before this amendment still parse on resume.

#### Interim, and what supersedes it

This is deliberately the cheap half. PRD 4's #96 (exact-tree gate reuse
keyed on `(treeId, command set)`) subsumes it: once a gate result is
reusable by tree identity, QA does not need a prompt-level
authorization, because the commands themselves become near-free to
"re-run". Remove this mechanism when #96 lands; until then it recovers
the measured ~13 min per QA round that #96 is not yet there to recover.
Recorded first as recovery-plan Phase D step 14, and carried as item 9
of the reliability wave.

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
- *(2026-08-28 amendment)* QA dispatch pays one `git add -A` plus
  `git write-tree` against the slice worktree, per QA attempt, to hash
  the tree under review. Bounded and small against the round it can
  save; the checkpoint path already pays the same cost once per round.
- *(2026-08-28 amendment)* The Pass-1 command set is now conditional
  on orchestrator state rather than fixed, so "which commands did this
  QA round actually run" has two possible answers. The citation in the
  attempt record exists so a reader never has to guess which.

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

Considered for the 2026-08-28 amendment and rejected:

- **Let the evaluator declare in `qa-review.json` that it took the
  skip.** Rejected: that is the self-certification this ADR exists to
  prevent, and it would put the audit record downstream of the actor
  being audited. The orchestrator records what it authorized instead.
- **Waive the sha check when the diff is "only" orchestrator-written
  artifacts** (an archived report from a previous attempt). Rejected:
  the check's value is that it is exact. A predicate deciding which
  differences are benign is a second, weaker definition of "same tree",
  and it would be the thing that eventually authorizes a skip against a
  changed candidate. Falling closed on an infrastructure retry costs one
  extra gate run in a case that was already anomalous.
- **Have the orchestrator drop the covered commands out of
  `{{SANITY_COMMANDS}}` instead of granting an authorization beside it.**
  Rejected: the evaluator would then have no way to tell "this project
  has no lint script" from "lint was already run", and no evidence to
  cite for a command it never saw. Naming the skip explicitly is what
  makes the report auditable.

## References

- `src/orchestrator.ts` — `SANITY_STEPS`, `resolveSanityCommands`,
  `runPreShipSanity`.
- `prompts/evaluator-qa.md` — `{{SANITY_COMMANDS}}` and
  `{{BASE_GATE_AUTHORIZATION}}` rendering.
- `src/orchestrator.test.ts` — drift test pinning the equivalence.
- `src/qa-gate-authorization.ts` — the skip decision and its rendering;
  `src/qa-gate-authorization.test.ts` — the fail-closed decision table.
- `src/gate-runner.ts` — `resolveCandidateTreeId`, shared with
  `createCandidateCheckpoint`.
- `src/qa-review.ts` — `baseGateCitation` on `QAReviewAttemptRecord`.
- `src/qa-orchestration.test.ts` — "blocks evaluation until every
  required checkpoint gate passes" also pins that the grant is reachable
  on a real candidate.

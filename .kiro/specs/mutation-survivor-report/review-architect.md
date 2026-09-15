# Architect review — mutation survivor report (round 1)

**Verdict:** ACCEPT-WITH-NOTES

## Scope reviewed

`git diff main...HEAD` in full: `src/mutation-report.ts` (new, 968 lines),
`src/ship-gate.ts`, `src/afk-manifest.ts`, `src/run-state.ts`,
`src/run-events.ts`, `src/logger.ts`, `src/preflight.ts`, `src/cli-options.ts`,
`src/orchestrator.ts`, `ARCHITECTURE.md`, `docs/adr/0071-*.md`, plus both slice
contracts and the acceptance manifests. Read for structure, not style.

## What is right

The load-bearing decisions of ADR 0071 are enforced by the code, not merely
asserted in comments:

- **No gate anywhere.** `src/mutation-report.ts` produces no `GateDeclaration`
  and holds no gate id; nothing in `ship-gate.ts` reads the outcome in the
  `open` decision (`buildPrCreationPlan` only appends a section), and no
  verdict, cap, or PR-open branch touches it. ADR 0071 *Refusals* ("no blocking
  mutation gate") and ADR 0063 survive the implementation.
- **One derivation, two render sites.** `deriveMutationStepOutcome` in
  `src/logger.ts` is the single reader, `formatMutationReportLines` the single
  formatter, and both the summary section and `buildPrCreationPlan` consume
  them — the rule `deriveQualityStageOutcomes` established (ARCHITECTURE.md
  *Post-approval quality stages*). The file, the stream and the PR body cannot
  disagree.
- **One change producer.** `mutationEligibleSources` is a filter over
  `buildChangeSummary`, never a second differ (ARCHITECTURE.md *Change summary*).
- **One kill path.** The runner registers its child with
  `registerWorktreeProcess`, and the only termination binding is
  `quiesceWorktree(reviewDir)`; the bound-reached exit and every
  guardian-rejection exit share that closure, and the pre-spawn abandonment read
  sits with no `await` before the invocation. ADR 0020 / ADR 0035 teardown
  quiescence holds and no detached post-exit process exists.
- **Refusal placement.** `refuseUndeclaredMutationReport` is deliberately not a
  `PreflightFinding` and is thrown from the manifest fail-closed block in
  `runPipeline` before the first run-state mutation, so
  `--preflight-report-only` (ADR 0042) cannot downgrade it.
- **Additive schema discipline.** `afk.json` stays `version: 1` with absent
  staying absent; `trimUnclaimedMigrationPrefixes` spreads rather than rebuilds,
  so the declaration survives that rewrite; run state bumps to 7 with
  `adaptLoadedState` accepting 3–7 and `sanitizeMutationStep` degrading a broken
  record to absent instead of throwing — the posture `sanitizeQualityStages`
  set. Every parser is total and none throws into a gate.

The notes below are structural observations. I blocked on none of them; the
reason is stated per finding.

## Notes

### A-01 — the step writes into the tree the gate drift-checks and commits

Evidence I gathered myself: `src/ship-gate.ts` starts the step with
`cwd: reviewDir` (mutation-step block, ~L1005–1020) concurrently with the
guardians. The declared `reportPath` is repo-relative to that same tree
(`src/afk-manifest.ts`, `MutationReportDeclaration.reportPath`), and
`readMutationReport(args.cwd, args.config.reportPath)` reads it from `reviewDir`;
nothing removes it afterwards. Later the gate reads
`git.statusPorcelain(reviewDir)`, runs `detectReviewWorktreeDrift` — whose
`allowed` set is exactly the two `review-<role>.md` files (`src/ship-gate.ts`
L218–246) — and then calls `git.commitAll`, which is `git add -A`
(`src/git.ts` L500–503).

So on a normal `--mutation-report` run the report JSON and any tool scratch
directory left in `reviewDir` are untracked: the gate emits a
`review-worktree-drift` warning and commits tool output into the review commit
on the feature branch and into the draft PR. Worse in kind, though
tool-dependent: a tool that mutates sources in place, or one killed mid-mutation
by the `BOUND_REACHED` quiesce, can leave a *tracked* file dirty, which the same
check classifies as `changedPaths` and the gate answers with
`return blocked(...)` (L1303–1320) — a report-only step holding back the merge
ADR 0071 forbids it from touching. I found no mention of this interaction in
either slice contract or handoff (grepped `drift`, `commitAll`, `gitignore`: no
hits), so it is unconsidered rather than accepted.

Not blocking: the guaranteed path produces committed noise on a draft PR a human
reads before merge, and the blocking variant depends on tool behavior
(StrykerJS sandboxes by default) I cannot establish from this tree. Clear
condition: keep the step's writes out of the committed tree, or exclude the
declared `reportPath` and the tool's scratch paths from the drift read and the
review commit, and state that invariant in ADR 0071.

### A-02 — a step rejection kills the run instead of producing MUTATION_NOT_RUN

Evidence: `runMutationStep` derives its scope before any `try`
(`src/mutation-report.ts` L727–731 — `mutationEligibleSources(buildChangeSummary(...))`
runs synchronously, ahead of the first `await`), so a `buildChangeSummary`
failure (it shells out with `execFileSync`, `src/change-summary.ts` L25) rejects
the promise at creation. `src/ship-gate.ts` then leaves that promise unawaited
across the entire guardian phase — the first handler is attached at the rejoin
inside `awaitMutationStepWithinBound`. A rejection in that window is an
`unhandledRejection`, and `installCrashRecorder` treats it as fatal:
`src/crash-records.ts` L141–163 writes a CRASHED record, marks in-flight slices
CANCELLED and calls `host.exit(1)`. A report-only step can therefore end the run
with no draft PR instead of the honest `MUTATION_NOT_RUN` the PRD (story 6) and
ADR 0071 promise. Even without the crash, `awaitMutationStepWithinBound` maps a
rejection to `outcome: undefined`, which the gate reads as "publish nothing", so
the failure renders as no section at all — indistinguishable from a run that
never opted in. `src/ship-gate.test.ts` has no rejecting-`mutationScope` case.

Not blocking: the trigger is an infrastructure fault (a failing git read), not a
normal-operation path, per this round's authority rules. Clear condition: move
the scope derivation inside the step's own error handling so a failure classifies
as `MUTATION_NOT_RUN`, and attach a handler at creation so no rejection sits
unhandled across the guardian phase.

### A-03 — command and derived paths are concatenated into a shell

`defaultMutationRun` (`src/mutation-report.ts` L657–686) spawns with
`shell: true` and `[...files]` appended, so the argv entries are re-parsed by the
shell: a changed source path containing a space silently narrows the mutation
scope, and one containing shell metacharacters is interpreted. The paths come
from `buildChangeSummary` over the run's own agent-authored branch. Noted, not
blocking: the declared command already executes with the operator's privileges in
that worktree, so this widens no authority boundary, and the step is opt-in.
Clear condition: pass the scope as argv without shell re-parsing, or quote each
path, and record which in the module header.

### A-04 — the flag exists but is undiscoverable

`--mutation-report` is parsed in `src/cli-options.ts` L258 and spread into the
config by each entry (`src/afk-claude.ts` L276), but appears in none of the three
`usage()` strings (`src/afk.ts`, `src/afk-claude.ts`, `src/afk-codex.ts` — which
list every other runtime flag, `--preflight-report-only` and `--record-prompts`
included) and nowhere in `README.md` (grepped: hits only in
`src/afk-manifest.ts` comments). ARCHITECTURE.md gains only the satellite entry,
correct under its 150-line cap, but the operator-facing surface — the flag and
the `afk.json` `mutationReport` member with its optional `baselinePath` and
`decisionsPath` — is documented only in an ADR and TSDoc, while README documents
the comparable `--preflight-report-only` in prose (L665). Clear condition: add
the flag to the three usage strings and document the manifest member in README.

### A-05 — observability now depends statically on a spawning module

`src/logger.ts` imports `MUTATION_REPORT_HEADING` and
`formatMutationReportLines` as values from `src/mutation-report.ts`, which
imports `node:child_process` `spawn`, `./change-summary.js` and
`./worktree-processes.js`. There is no cycle (I read the imports of both
satellites), and sharing one formatter is the right rule — but ARCHITECTURE.md
files `mutation-report.ts` under *Ship path*, and every module importing the
logger now transitively pulls the runner. A pure render module (heading,
formatter, types) imported by both sides is the cheaper shape. "I'd have done it
differently", so: a note. Clear condition: split the render surface out, or
record the dual role deliberately in ARCHITECTURE.md.

## Structured findings (v2)

{"version":2,"findings":[{"id":"A-01","title":"Mutation step writes into the review worktree the gate drift-checks and commits with git add -A","class":"COUPLING","clearCondition":"The step's report and scratch output stay out of the committed tree, or the declared reportPath and tool scratch paths are excluded from detectReviewWorktreeDrift and the review commit, with the invariant stated in ADR 0071.","disposition":"OPEN","reachableTrigger":null,"introducedByReviewedDiff":false},{"id":"A-02","title":"A step-promise rejection reaches the fatal unhandledRejection handler instead of producing MUTATION_NOT_RUN","class":"ERROR_HANDLING","clearCondition":"Scope derivation runs inside runMutationStep's own error handling so a failure classifies as MUTATION_NOT_RUN, and the step promise carries a handler from creation so no rejection sits unhandled across the guardian phase.","disposition":"OPEN","reachableTrigger":null,"introducedByReviewedDiff":false},{"id":"A-03","title":"Declared mutation command and derived file paths are concatenated into a shell invocation","class":"SECURITY","clearCondition":"Scope paths are passed as argv without shell re-parsing, or each path is quoted, with the choice recorded in the module header.","disposition":"OPEN","reachableTrigger":null,"introducedByReviewedDiff":false},{"id":"A-04","title":"--mutation-report and the afk.json mutationReport member are absent from every usage string and from README","class":"CONVENTION","clearCondition":"The flag appears in the three CLI usage strings and the manifest member including baselinePath and decisionsPath is documented in README.","disposition":"OPEN","reachableTrigger":null,"introducedByReviewedDiff":false},{"id":"A-05","title":"logger.ts takes a value dependency on the spawning mutation-report module for a heading and a formatter","class":"LAYERING","clearCondition":"The heading, formatter and types live in a pure render module both the ship path and the logger import, or ARCHITECTURE.md records the dual role deliberately.","disposition":"OPEN","reachableTrigger":null,"introducedByReviewedDiff":false}]}

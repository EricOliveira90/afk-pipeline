# PM review — PRD 4 (acceptance and scope gates), slice 08 (#195) only

**Verdict:** ACCEPT-WITH-NOTES

Run scope judged: slice 08 (#195) File-scope gate. Slices 01-07 were not run by
this invocation and did not drive this verdict (#84's code is on the branch from
an earlier invocation; I read it only where slice 08 depends on it).

Method note for this round: this review worktree has no `node_modules`
(`Test-Path node_modules` → `False`), so every finding below rests on reading
the shipped code, the shipped tests and the git history of slice 08's four
commits (`6a40f16`, `0462c65`, `a8efbce`, `d375169`), not on a fresh test run.
The pre-ship sanity gate already ran the suite against this tree.

## What the PRD promised, and what a user gets

The user is the operator watching an unattended run. The promise is one
sentence: a candidate that changed a file its locked contract never declared
does not reach the feature branch, and the next generator round is told which
path. That promise is delivered end to end.

| PRD requirement | Where it landed | How I checked |
|---|---|---|
| D2 — one gate reusing `outOfScopeChangedPaths` and `listChangedFiles`, no second normalizer or probe | `src/scope-gate.ts:19-22,94-157`; `outOfScopeChangedPaths` (`src/escalation.ts:196-262`) is untouched | read both modules; `git log main...HEAD -- src/escalation.ts` shows no slice-08 commit |
| D3 — candidate base is the slice's own work; working tree and untracked count | `src/scope-gate.ts:97-100` passes `featureRef` verbatim into `listChangedFiles` (git's three-dot base) | read the code; `src/scope-gate.test.ts:131-143` asserts the untracked `src/orphan.ts` and the undeclared committed path are the only offenders |
| D3 — base re-resolves after a merge-resolution round | same verbatim `featureRef`, so `merge-base(featureRef, HEAD)` is the merged tip | `src/scope-gate.test.ts:274-312` builds a real repo where a sibling path arrives only via the merge and asserts PASS with no findings |
| D4 — role write-scope is a tree-to-tree diff, never a working-tree probe | `src/scope-gate.ts:56-61,101-111` (`diffTreePaths`) | `src/scope-gate.test.ts:314-350` asserts an uncommitted file is absent from the diff (see note P-01 about the missing consumer) |
| D22 — `run` either/or with `command`; required-neither is CONFIGURATION, optional-neither stays SKIPPED | `src/gate-runner.ts` `classifyDeclaration` (both supplied → `invalid`) and the unchanged FAIL/SKIPPED split in `runGates` | read the diff in `6a40f16`; `src/gate-runner.test.ts` covers all four shapes plus the derived commandless `lint` gate |
| D22 — typed `GateResult.findings` with the four named fields; prose in `detail` parsed by nothing | `GateFindings` in `src/gate-runner.ts` (only `outOfScopePaths` populated, per the split); `isGateFindingsField` validates on read | read the types and the reader guard |
| D22 — evidence version 1 → 2, reader accepts both, only v2 may carry findings | `GATE_EVIDENCE_VERSION = 2`, `SUPPORTED_GATE_EVIDENCE_VERSIONS = [1,2]`, explicit refusal of a v1 document carrying `findings` in `readGateEvidence` | read the diff; `src/gate-runner.test.ts` has the version-1/2/3 case |
| Anchors — the `scope` gate runs on the final candidate after the QA window and before the merge, not pre-QA | exactly one declaration site, `src/orchestrator.ts:5830-5846`, prepended to the post-QA declarations | `Select-String 'scopeGateDeclaration'` finds one importer and one construction site |
| #195 AC1/AC6 as amended — the undeclared change does not merge, but still reaches the evaluator | REPAIR path at `src/orchestrator.ts:5907-5919` | `src/qa-orchestration.test.ts` "a red file-scope gate at the post-QA transition" asserts `["scope","tests"]` order, `findings.outOfScopePaths == ["src/smuggled.ts"]`, `acceptedCommitsAtDispatch == [0,0]` (nothing merged before the repair round) and `evaluators == 2` |
| AC — AFK-owned artifacts never trigger violations | exemptions live in the reused `outOfScopeChangedPaths` | `src/scope-gate.test.ts:145-152` asserts the slice artifact file, the migration and a case-differing declared path are all exempt |
| AC — the explicit no-repository-change declaration passes only when nothing outside the allowlist changed | `acceptanceManifestPaths` returns `[]` for that scope | `src/scope-gate.test.ts:352-382` passes on artifacts+migration only, then names `src/sneaked.ts` |
| The violation reaches the next generator round as evidence, and names the exact path | `detail` emitted into the gate log before the status line (`runGates` in-process branch); `findings` persisted in the evidence document; `decideCandidateGatePhase` hands both as `references` | the spawned scenario asserts `Gate ID: ` + backtick-scope in the round-2 prompt, a `-scope.log` reference, and the smuggled path inside that log; `src/context-envelope.ts:1779-1785` is the renderer |
| Manifest bytes read at gate time, so an ADR 0048 amendment applied during the QA window is honored | `loadAcceptanceManifest` called inside the `run` closure (`src/scope-gate.ts:129,164-173`) | read it; `src/scope-gate.test.ts:168-189` widens the manifest after the declaration is built and asserts the newly declared path is no longer a violation |
| Fails closed rather than reporting a tree it could not prove clean | probe `ok:false` → INFRASTRUCTURE with no findings (`src/scope-gate.ts:117-127`); a throwing `run` → INFRASTRUCTURE (`runGates`) | read both; `src/scope-gate.test.ts:250-272` asserts `findings` stays `undefined` |
| The actor being constrained cannot author its own exemption | `acceptedPairIntact` is latched false at the top of every generator attempt and set true only after the pair-integrity check passed (`src/orchestrator.ts:5185-5188,5389-5392`) | read the latch; `src/scope-gate.test.ts:154-166` shows an unproven pair makes both files violations; `src/orchestrator.test.ts` B-07 asserts no `scope` gate-outcome event exists for a slice whose generator rewrote its own pair |
| Preservation — `src/base-gates.ts`, `src/post-qa-gates.ts`, `src/candidate-gate-phase.ts`, `src/acceptance-manifest.ts` unedited | none of the four appears in the four slice-08 commits' `--stat` | read all four `git show --stat` outputs |
| `ARCHITECTURE.md` names the new module | `ARCHITECTURE.md:25` Gates row and `:46-49` seam note | read it |

Two things I checked specifically, because this is where such a promise is
usually only half-kept:

- **No gate was made optional and no assertion was deleted to reach green.**
  The spawned fixtures were corrected by *declaring* what their stub generators
  already write (`src/orchestrator.fixtures.ts`, `src/wave.fixtures.ts`,
  `src/resume-integration.fixtures.ts` in `a8efbce`), the deliberate
  out-of-scope fixtures (`undeclaredEdits`) stay undeclared, and the
  `no-repository-changes` fixture now writes under the slice artifact directory
  instead of having its scope widened. `src/wave-migrations.test.ts` reshapes
  its add/add conflict so the conflict comes from the feature branch advancing
  rather than from an undeclared write — that is the gate working, and the
  scenario's own claim is intact.
- **The gate is the first declaration in the phase**, so it cannot sit behind
  the ~7-minute suite nor be skipped by an earlier declaration's
  INFRASTRUCTURE or checkpoint break, and a red `scope` does not short-circuit
  the rest: the spawned scenario asserts `tests` still ran and PASSed in the
  red round.

## Notes (non-blocking)

- **P-01 — D4's role comparison source ships as a seam with no consumer.**
  `kind: "role"` is implemented and unit-tested, but the only importer of
  `./scope-gate.js` in `src/` is `src/orchestrator.ts:117`, and it builds only
  the `candidate` source. No role's write scope is graded by this gate today;
  the pre-existing review-window allowlist in `src/post-qa-gates.ts` is still
  what catches a reviewer editing source. The contract scoped B-11 as a seam,
  so this is shipped intent rather than a defect — recorded so the operator
  knows D4 is currently a capability, not an enforcement.
- **P-02 — the structured findings do not reach `run-summary.md` or the
  `gate-outcome` event.** `src/logger.ts:332-349` renders one Base Gates row
  per gate outcome (slice, round, gate, status, elapsed, evidence, log), so an
  operator sees `scope` red and then has to open the evidence document or the
  gate log to learn which path. The contract lists this as an explicit non-goal
  (it needs `src/candidate-gate-phase.ts`, which the anchors file puts outside
  slice 08) and the paths do reach both the generator and a human through the
  cited log, so the outcome is delivered — one hop from the summary.
- **P-03 — the repair note the generator receives still says the suite failed.**
  `src/candidate-gate-policy.ts:102-106` writes "The full slice suite failed on
  the accepted candidate" for every red required gate in that phase, which is
  now inaccurate for `scope`: nothing about the suite failed. The failure set
  does carry `Gate ID: scope` and its evidence, so the round is actionable, and
  that file belongs to #86 in the PRD's file-scope map rather than to this
  slice. Recorded as wording an operator or generator can misread.
- **P-04 — the red-gate coverage is a new spawned scenario, and its wall-clock
  effect is unmeasured.** `src/qa-orchestration.test.ts` opens a new spawned
  `describe` although the contract's test plan asked for an `it` on an existing
  one. The deviation is argued in the file and I confirmed the argument: every
  pre-existing spawned scenario there runs the slice on `main` as its own
  feature branch (`makeContext`), so a scope comparison is empty by
  construction. It carries the CLAUDE.md-required comment and shares one run
  across three `it`s. `suite-budgets.json` still budgets `qa-orchestration` at
  151s against a 115.7s recorded measurement, and ADR 0063 has moved the
  ratchet out of `pnpm test`, so it cannot turn a deterministic gate red. I
  could not measure it this round (no `node_modules` in this worktree).

## Out-of-scope PRD gaps (for the operator, not the verdict)

Everything below belongs to slices this invocation did not run.

- 01 (#84) policy reader and D6's glob matcher: on the branch from an earlier
  invocation, not judged here. Note that #195's issue text said this gate would
  read `gatePolicy.protectedPaths` and call the glob matcher; `prd.md`'s split
  note reassigns that to #193, and the contract follows `prd.md`, which
  `prd.md:22-25` makes controlling.
- 02 (#85) behavior-coverage gate and D8's `vitest-json` match count.
- 03 (#91) candidate evaluator isolation, D11's change summary, D14's wording.
- 04 (#96) final evaluator, D10's approved baseline, D20's exact-tree reuse.
- 05 (#86) test cost split, D7's skip detector, D16 advisory gates, D17's cache,
  D18's derived verification command (so `AGENTS.md` / `CLAUDE.md` still
  prescribe the hand-written launch command).
- 06 (#132) the merge-resolution round, including the caller that re-resolves
  `featureRef`; slice 08 ships the seam and asserts the rule.
- 07 (#193) D5 waivers (`protectedChangeWaivers` is still parsed-and-ignored),
  D6's deletion rule, the `feedback-integrity` gate, D12's `GATE-SCOPE` channel
  and D13's rubric. `findings.deletedTests`, `protectedChanges` and
  `appliedWaivers` are therefore typed and empty by design.

## Structured findings (v1)

{"version":1,"findings":[{"id":"P-01","title":"D4's role comparison source ships as a seam with no production consumer","class":"PRODUCT","clearCondition":"A production call site grades a writing role through the `role` comparison source, or the PRD/issues record which later slice owns role write-scope enforcement.","disposition":"REPEATED"},{"id":"P-02","title":"Structured scope findings are absent from run-summary.md and the gate-outcome event","class":"PRODUCT","clearCondition":"The offending paths appear in the run summary or the gate-outcome event, or the PRD records that reading them from the gate evidence is the intended operator path.","disposition":"REPEATED"},{"id":"P-03","title":"The post-QA repair note blames the full suite even when the failing gate is `scope`","class":"PRODUCT","clearCondition":"The repair note names the failing gate class rather than asserting the suite failed, or #86 records that wording as intended when it takes src/candidate-gate-policy.ts.","disposition":"OPEN"},{"id":"P-04","title":"Red-gate coverage added a new spawned scenario against the contract's test plan, with unmeasured budget effect","class":"PRODUCT","clearCondition":"`pnpm run test:heavy:qa` followed by `pnpm run test:budgets` reports qa-orchestration inside its 151s budget, or the budget is adjusted with the recorded measurement.","disposition":"REPEATED"}]}

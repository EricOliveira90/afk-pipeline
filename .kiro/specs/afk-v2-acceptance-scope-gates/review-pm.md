# PM review — PRD 4 (acceptance and scope gates), slice 08 (#195) only

**Verdict:** ACCEPT-WITH-NOTES

Run scope judged: slice 08 (#195) File-scope gate. Slices 01-07 were not run by
this invocation and did not drive this verdict (#84's code is on the branch from
an earlier invocation; I read it only where slice 08 depends on it).

Method note for this round: this worktree now has `node_modules`, so this
review rests on fresh narrow runs as well as reading. I ran
`pnpm vitest run src/scope-gate.test.ts` (10/10 pass, 7.1s),
`pnpm run test:heavy:qa` (33/33 pass, suite time 88.2s) and
`pnpm run test:budgets` (every suite within budget) — no full-suite run; the
pre-ship gate already did that against this tree.

## What the PRD promised, and what a user gets

The user is the operator watching an unattended run. The promise is one
sentence: a candidate that changed a file its locked contract never declared
does not reach the feature branch, and the next generator round is told which
path. That promise is delivered end to end.

| PRD requirement | Where it landed | How I checked |
|---|---|---|
| D2 — one gate reusing `outOfScopeChangedPaths` and `listChangedFiles`, no second normalizer or probe | `src/scope-gate.ts:19-22,94-157` | read the module; `src/scope-gate.test.ts:232-246` pins the reuse (no `toLowerCase`, no `execFileSync` in the module) and passed in my run |
| D3 — candidate base is the slice's own work; working tree and untracked count | `src/scope-gate.ts:97-100` passes `featureRef` verbatim into `listChangedFiles` (git's three-dot base) | ran `src/scope-gate.test.ts`: B-09 asserts the untracked `src/orphan.ts` and the undeclared committed path are the only two offenders |
| D3 — base re-resolves after a merge-resolution round | same verbatim `featureRef`, so `merge-base(featureRef, HEAD)` is the merged tip | B-14 (`src/scope-gate.test.ts:274-312`) builds a real repo where a sibling path arrives only via the merge and asserts PASS with no findings — passed in my run |
| D4 — role write-scope is a tree-to-tree diff, never a working-tree probe | `src/scope-gate.ts:56-61,101-111` (`diffTreePaths`) | B-11 asserts an uncommitted file is absent from the diff (see note P-01 about the missing consumer) |
| D22 — `run` either/or with `command`; required-neither is CONFIGURATION, optional-neither stays SKIPPED | `classifyDeclaration` plus the unchanged FAIL/SKIPPED split at `src/gate-runner.ts:509-535` | read the branch; the in-process branch at `:543-595` sits ahead of the `existsSync(options.cwd)` break at `:597` |
| D22 — typed `GateResult.findings` with the four named fields; prose in `detail` parsed by nothing | `GateFindings` at `src/gate-runner.ts:60-70` (only `outOfScopePaths` populated, per the split); `isGateFindingsField` validates on read | read the types and the reader guard |
| D22 — evidence version 1 → 2, reader accepts both, only v2 may carry findings | `GATE_EVIDENCE_VERSION = 2` (`:24`), `SUPPORTED_GATE_EVIDENCE_VERSIONS = [1,2]` (`:27`), explicit refusal at `:812-822` | read `readGateEvidence` |
| Anchors — the `scope` gate runs on the final candidate after the QA window and before the merge, not pre-QA | exactly one declaration site, `src/orchestrator.ts:5830-5846`, prepended to the post-QA declarations | `Select-String 'scope-gate.js'` finds one importer in `src/` outside tests (`orchestrator.ts:117`) and one construction site |
| #195 AC1/AC6 as amended — the undeclared change does not merge, but still reaches the evaluator | REPAIR path at `src/orchestrator.ts:5907-5926`; the only acceptance path (`dispatchAcceptedCandidate`, `:5959`) is behind a green phase | `src/qa-orchestration.test.ts:2263-2318` asserts `["scope","tests"]` order, `findings.outOfScopePaths == ["src/smuggled.ts"]`, `acceptedCommitsAtDispatch == [0,0]` and `evaluators == 2`; it passed in my `test:heavy:qa` run |
| The gate cannot be skipped by a candidate with no runnable suite | the in-process branch runs before the missing-`cwd` INFRASTRUCTURE break, and `runPostQAGates` never short-circuits when no declaration has a `command` (`src/post-qa-gates.ts:164-226`) | read both; B-06 (`src/scope-gate.test.ts:191-230`) runs the gate with a `cwd` that is not a repository and still gets FAIL with the offender |
| AFK-owned artifacts never trigger violations | exemptions live in the reused `outOfScopeChangedPaths` | B-09 asserts the artifact file, the migration and a case-differing declared path are all exempt |
| The explicit no-repository-change declaration passes only when nothing outside the allowlist changed | `acceptanceManifestPaths` returns `[]` for that scope | B-13 passes on artifacts+migration only, then names `src/sneaked.ts` |
| The violation reaches the next generator round as evidence, naming the exact path | `detail` emitted into the gate log before the status line (`src/gate-runner.ts:569-573`); `findings` persisted in evidence; `decideCandidateGatePhase` hands both as `references` (`src/candidate-gate-policy.ts:80-101`) | the spawned scenario asserts round 2's prompt contains ``Gate ID: `scope` `` and a `-scope.log` reference, and that the log holds the smuggled path |
| Manifest bytes read at gate time, so an ADR 0048 amendment applied during the QA window is honored | `loadAcceptanceManifest` inside the `run` closure (`src/scope-gate.ts:129,164-173`) | B-07 widens the manifest after the declaration is built and asserts the newly declared path is no longer a violation |
| Fails closed rather than reporting a tree it could not prove clean | probe `ok:false` → INFRASTRUCTURE with no findings (`src/scope-gate.ts:117-127`); a throwing `run` → INFRASTRUCTURE (`src/gate-runner.ts:556-567`) | B-05 asserts `findings` stays `undefined` |
| The actor being constrained cannot author its own exemption | `acceptedPairIntact` is latched false per attempt and set true only after the pair-integrity refusal at `src/orchestrator.ts:5359-5392` | read the latch; B-10 shows an unproven pair makes both files violations |
| Preservation — `src/base-gates.ts`, `src/post-qa-gates.ts`, `src/candidate-gate-phase.ts`, `src/acceptance-manifest.ts` unedited | none appears in the four slice-08 commits (`6a40f16`, `0462c65`, `a8efbce`, `d375169`) | `git show --stat` on each |
| `ARCHITECTURE.md` names the new module | `ARCHITECTURE.md:25` Gates row and `:46-49` seam note | read it |

Two things I checked specifically, because this is where such a promise is
usually only half-kept.

- **No gate was made optional and no assertion was deleted to reach green.**
  The spawned fixtures were corrected by *declaring* what their stub generators
  already write, and only that: `src/orchestrator.fixtures.ts:463-497` adds
  `fixture.outputFile` to the declared list, skips migration outputs, and
  decides from round 1 so the additive revision guard still sees a dropped
  path. The deliberate out-of-scope fixtures stay undeclared —
  `src/orchestrator.test.ts:1618-1728` still drives `undeclaredEdits` and still
  asserts the ADR 0052 refusal, its error text and that QA never ran.
- **A resumed run cannot merge around the gate.** The exact-stage resume path
  (`src/orchestrator.ts:5098-5108`) finalizes without re-running the gates, but
  the checkpoint it reads is written only after the post-QA phase passed on
  that exact tree (`src/accepted-candidate.ts:130-141`) and `inspectResume`
  requires the current candidate tree to equal it, so the green `scope` result
  is tied to the tree that merges.

## Notes (non-blocking)

- **P-01 — D4's role comparison source ships as a seam with no consumer.**
  `kind: "role"` is implemented and unit-tested, but the only `src/` importer
  of `./scope-gate.js` is `src/orchestrator.ts:117` and it builds only the
  `candidate` source. No role's write scope is graded by this gate today; the
  pre-existing review-window allowlist in `src/post-qa-gates.ts` is still what
  catches a reviewer editing source. The contract scoped B-11 as a seam, so
  this is shipped intent — recorded so the operator knows D4 is a capability,
  not yet an enforcement.
- **P-02 — the structured findings do not reach `run-summary.md` or the
  `gate-outcome` event.** The `gate-outcome` payload (`src/run-events.ts:141-158`)
  carries status, `evidenceArtifactId` and `logArtifactId` and no path list, so
  an operator sees `scope` red in the summary and then opens the cited evidence
  or log to learn which path. The contract lists this as an explicit non-goal
  (it needs `src/candidate-gate-phase.ts`, which the anchors file puts outside
  slice 08), and the paths do reach both the generator and a human through the
  cited log — one hop from the summary.
- **P-03 — the repair note the generator receives still says the suite failed.**
  `src/candidate-gate-policy.ts:102-106` writes "The full slice suite failed on
  the accepted candidate" for every red required gate in that phase, which is
  now inaccurate for `scope`: nothing about the suite failed. The failure set
  still carries `Gate ID: scope` and its evidence, so the round is actionable,
  and that file belongs to #86 in the PRD's file-scope map rather than to this
  slice. Recorded as wording an operator or a generator can misread.
- **P-04 (now cleared) — the new spawned scenario's budget effect is measured.**
  `src/qa-orchestration.test.ts:2142` opens a new spawned `describe` although
  the contract's test plan asked for an `it` on an existing one; I re-confirmed
  the argument for the deviation (every pre-existing spawned scenario there
  runs the slice on `main` as its own feature branch via `makeContext`, so a
  scope comparison is empty by construction) and the block carries the required
  comment and shares one run across three `it`s. This round I measured it:
  `pnpm run test:heavy:qa` → 33/33 passing, `qa-orchestration` 88.2s, and
  `pnpm run test:budgets` reports 88.2s / 151s with every suite inside budget.
  The finding's clear condition is met.

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

{"version":1,"findings":[{"id":"P-01","title":"D4's role comparison source ships as a seam with no production consumer","class":"PRODUCT","clearCondition":"A production call site grades a writing role through the `role` comparison source, or the PRD/issues record which later slice owns role write-scope enforcement.","disposition":"REPEATED"},{"id":"P-02","title":"Structured scope findings are absent from run-summary.md and the gate-outcome event","class":"PRODUCT","clearCondition":"The offending paths appear in the run summary or the gate-outcome event, or the PRD records that reading them from the gate evidence is the intended operator path.","disposition":"REPEATED"},{"id":"P-03","title":"The post-QA repair note blames the full suite even when the failing gate is `scope`","class":"PRODUCT","clearCondition":"The repair note names the failing gate class rather than asserting the suite failed, or #86 records that wording as intended when it takes src/candidate-gate-policy.ts.","disposition":"REPEATED"},{"id":"P-04","title":"Red-gate coverage added a new spawned scenario against the contract's test plan, with unmeasured budget effect","class":"PRODUCT","clearCondition":"`pnpm run test:heavy:qa` followed by `pnpm run test:budgets` reports qa-orchestration inside its 151s budget, or the budget is adjusted with the recorded measurement.","disposition":"RESOLVED"}]}

# PM review — PRD 4 (acceptance and scope gates), slice 08 (#195) only

**Verdict:** ACCEPT-WITH-NOTES

Run scope judged: slice 08 (#195) File-scope gate. Slices 01-07 were not run
by this invocation and did not drive this verdict (#84's code is present on the
branch from an earlier invocation; it was read only where slice 08 depends on
it).

## What the PRD promised, and what a user gets

The user here is the operator watching an unattended run, and the promise is
one sentence: a candidate that changed a file its locked contract never
declared does not reach the feature branch, and the next generator round is
told which path. That promise is delivered, end to end, and I verified each
link myself.

| PRD requirement | Where it landed | How I checked |
|---|---|---|
| D2 — the gate reuses `outOfScopeChangedPaths` and `listChangedFiles`, no second normalizer or probe, one call site | `src/scope-gate.ts:19-22,94-157` imports both; `git diff --stat 4f84374..d375169 -- src/escalation.ts src/git.ts` is empty | read the module; ran the diff |
| D3 — candidate base is the slice's own work, working tree and untracked included; re-resolved after a merge | `src/scope-gate.ts:97-100` passes `featureRef` verbatim to `listChangedFiles` (three-dot base) | ran `pnpm vitest run src/scope-gate.test.ts` — 10/10 pass, including "B-14: excludes a sibling path that reached this tree only through the feature-branch merge" |
| D4 — role write-scope is a tree-to-tree diff, never a working-tree probe | `src/scope-gate.ts:56-61,101-111` (`diffTreePaths`) | same run: "B-11: compares checkpoint tree to checkpoint tree for a role write scope" passes (see note P-01 on the missing consumer) |
| D22 — `GateDeclaration.run`, either/or with `command`, required-neither is CONFIGURATION and optional-neither stays SKIPPED | `src/gate-runner.ts:357-372` (`classifyDeclaration`, invalid when both are supplied), `:510-535` (the unchanged split) | read both branches; ran `pnpm vitest run src/gate-runner.test.ts` — 32/32 pass |
| D22 — typed `GateResult.findings` with the four named fields, prose stays unparsed | `src/gate-runner.ts:40-64,106`, populated at `:586-588`; only `outOfScopePaths` filled, per the split | read the types; the qa-orchestration scenario asserts the persisted payload |
| D22 — `GATE_EVIDENCE_VERSION` 1 → 2, reader accepts 1 and 2, only 2 may carry findings | `src/gate-runner.ts:24-29,783-821` | `src/gate-runner.test.ts` green, including the version-1-carrying-findings refusal |
| Anchors — the `scope` gate runs on the final candidate after the QA window and before the merge, not pre-QA | one declaration site, `src/orchestrator.ts:5830-5846`, prepended to the post-QA declarations; `grep` finds no second `scopeGateDeclaration` | ran the grep; read the call site |
| #195 AC1/AC6 as amended — an undeclared change does not merge, still reaches the evaluator | `runPostQAGates` REPAIR path, `src/orchestrator.ts:5907-5919` | ran `pnpm vitest run src/qa-orchestration.test.ts -t "red file-scope gate"` — 3/3 pass |
| The violation reaches the next generator round as evidence a human can also read | detail emitted into the gate log before the status line, `src/gate-runner.ts:569-573`; findings persisted in the evidence document | same run asserts `Gate ID: \`scope\`` in the round-2 generator prompt, a `-scope.log` reference in it, and the smuggled path inside that log |
| Manifest read at gate time, so an ADR 0048 amendment widening `fileScope` during the QA window is honored | `src/scope-gate.ts:129` inside the `run` closure (`:164-173`) | `src/scope-gate.test.ts` covers the applied-amendment case; run green |
| Fails closed rather than reporting a clean tree it could not prove | `src/scope-gate.ts:117-127` (probe `ok: false` → INFRASTRUCTURE, no findings); `src/gate-runner.ts:556-567` (a throwing `run` → INFRASTRUCTURE) | read both; covered by the two green suites above |
| Preservation: `src/base-gates.ts`, `src/post-qa-gates.ts`, `src/candidate-gate-phase.ts`, `src/acceptance-manifest.ts` unedited | `git diff --stat 4f84374..d375169` over those paths is empty | ran it |
| `ARCHITECTURE.md` names the new module | `ARCHITECTURE.md:25` Gates row and `:45-49` seam note | read it |

Two things I looked for specifically, because they are the ways this promise is
usually only half-kept:

- **No gate was made optional and no assertion was deleted to reach green.**
  The spawned fixtures were corrected by *declaring* what their stub generators
  write (`src/orchestrator.fixtures.ts:463-490`, `src/wave.fixtures.ts:279-345`,
  `src/resume-integration.fixtures.ts:160-230`), and the deliberate
  out-of-scope fixtures stay undeclared. `src/wave-migrations.test.ts:1201-1250`
  reshapes its add/add conflict fixture so the conflict now comes from the
  feature branch advancing rather than from an undeclared write — which is the
  gate working, not the test being weakened, and the scenario's claim
  (MERGE-PENDING on a real conflict) is intact.
- **The gate is the first declaration in the phase**, so it cannot be preceded
  or skipped by the ~7-minute suite, and a red `scope` does not short-circuit
  the rest. The spawned scenario asserts the recorded order is exactly
  `["scope", "tests"]` in both rounds.

## Notes (non-blocking)

- **P-01 — D4's role comparison source has no production consumer.** `kind:
  "role"` exists and is unit-tested, but `grep 'scope-gate.js'` finds exactly
  one importer (`src/orchestrator.ts:117`) and it only builds the `candidate`
  source. So today no role's write scope is actually graded by this gate; the
  pre-existing review-window allowlist (`src/post-qa-gates.ts:51-76`) is still
  what catches a reviewer editing source. The slice contract scoped B-11 as a
  seam, so this is the shipped intent rather than a defect — worth the
  operator knowing that D4 is currently a capability, not an enforcement.
- **P-02 — the structured findings do not surface in `run-summary.md` or the
  `gate-outcome` event.** An operator reading the run summary sees `scope`
  red but has to open the evidence document or the gate log to see which path.
  The contract lists this as an explicit non-goal (it needs
  `src/candidate-gate-phase.ts`, which the anchors file puts outside slice 08),
  and the paths do reach both the generator and a human through the gate log,
  so the outcome is delivered — just one hop away from the summary.
- **P-03 — the red-gate coverage is a new spawned scenario, which the contract's
  own test plan asked it not to be.** `src/qa-orchestration.test.ts:2142`
  opens a new spawned `describe`. The deviation is argued in the file: every
  pre-existing spawned scenario in that suite runs the slice on `main` as its
  own feature branch, so a scope comparison there is empty by construction.
  It carries the CLAUDE.md-required comment and shares one run across three
  `it`s. The wall-clock consequence is unmeasured here; the `qa-orchestration`
  budget is unchanged at 151s against a 115.7s recorded measurement, and ADR
  0063 has moved the ratchet out of `pnpm test`, so it cannot turn a
  deterministic gate red. Recorded so the next budget measurement is read
  rather than raised.

## Out-of-scope PRD gaps (for the operator, not the verdict)

Everything below belongs to slices this invocation did not run. None of it
influences the verdict.

- 01 (#84) policy reader / D6 glob matcher: present on this branch from an
  earlier invocation, not judged here.
- 02 (#85) the behavior-coverage gate and D8's `vitest-json` match count.
- 03 (#91) candidate evaluator isolation, D11's change summary, D14's probe
  wording.
- 04 (#96) final evaluator, D10's approved baseline, D20's exact-tree reuse.
- 05 (#86) test cost split, D7's skip detector, D16 advisory gates, D17's
  cache, D18's derived verification command (so `AGENTS.md` / `CLAUDE.md`
  still prescribe the hand-written launch command).
- 06 (#132) merge-resolution round, including the call that re-resolves
  `featureRef` for D3 — slice 08 ships the seam and asserts the rule, but the
  re-resolving caller is #132's.
- 07 (#193) D5 waivers (`protectedChangeWaivers` is still parsed-and-ignored),
  D6's deletion rule, the `feedback-integrity` gate, D12's `GATE-SCOPE`
  channel and D13's evaluator rubric. Consequently `findings.deletedTests`,
  `protectedChanges` and `appliedWaivers` are typed and empty by design.

## Structured findings (v1)

{"version":1,"findings":[{"id":"P-01","title":"D4's role comparison source ships as a seam with no production consumer","class":"PRODUCT","clearCondition":"A production call site grades a writing role through the `role` comparison source, or the PRD/issues record which later slice owns role write-scope enforcement.","disposition":"OPEN"},{"id":"P-02","title":"Structured scope findings are absent from run-summary.md and the gate-outcome event","class":"PRODUCT","clearCondition":"The offending paths appear in the run summary or the gate-outcome event, or the PRD records that reading them from the gate evidence is the intended operator path.","disposition":"OPEN"},{"id":"P-03","title":"Red-gate coverage added a new spawned scenario against the contract's test plan, with unmeasured budget effect","class":"PRODUCT","clearCondition":"`pnpm run test:heavy:qa` followed by `pnpm run test:budgets` reports qa-orchestration inside its 151s budget, or the budget is adjusted with the recorded measurement.","disposition":"OPEN"}]}

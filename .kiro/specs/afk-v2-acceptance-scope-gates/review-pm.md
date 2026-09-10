# PM review — PRD 4 (acceptance and scope gates), slice 05 (#86) only

**Verdict:** ACCEPT-WITH-NOTES

Run scope judged: slice 05 (#86) "Test cost split and caching". Slices 01-04 and
06-08 were not run by this invocation; where their code is on the branch from an
earlier invocation I read it only where slice 05 depends on it, and it did not
drive this verdict.

Method: reading plus two narrow fresh runs —
`pnpm vitest run src/gate-cache.test.ts src/skip-gate.test.ts` (12/12 pass,
12.8s). No full-suite run; the pre-ship gate already covered this tree.

## What the PRD promised, and what a user gets

The user is the operator of an unattended run. The promise: the generator
iterates on a cheap command instead of a 7-minute suite, a green gate on an
unchanged tree is not paid for twice, a dependent gate is not paid for at all
when its prerequisite failed, a wall-clock budget can report without blocking,
and a candidate cannot smuggle in a disabled test. All five arrive.

| PRD requirement | Where it landed | How I checked |
|---|---|---|
| D1/anchors — `gatePolicy.cost` is a parsed, validated member with the settled hybrid shape | `src/gate-policy.ts:37` (`POLICY_KEYS` holds `cost`), `parseCost`/`parseRelatedTests`/`parseSkipDetector` (`:514-700`), defaults at `:124-160` | read the parser; `src/gate-policy.test.ts:376-470` covers unknown sub-keys, wrong types, blank command, bad glob |
| D1 — one production reader, each consumer handed its part | `resolveTestCostPlan` (`src/base-gates.ts:134-145`) is the only non-test caller of `policy.cost`; consumers at `:155`, `:185`, `src/orchestrator.ts:5594`, `:6403`, `src/skip-gate.ts:46` | `Select-String 'resolveTestCostPlan|relatedTests|cost?\.' src/*.ts` — no second reader outside tests |
| D16 — advisory gate excluded from the required set, never from evidence | `environmentSensitiveDeclarations` (`src/base-gates.ts:184-201`) emits `required: false` + `environmentSensitive: true`, appended by `resolveFullSuiteGateDeclarations` (`:230-239`); no second exclusion path added to `candidate-gate-phase.ts`/`candidate-gate-policy.ts` | read all four `required` readers; `src/gate-runner.ts:924-931` stamps the real status with the advisory marker |
| D16 — `run-summary.md` and the draft PR carry an advisory section | `src/logger.ts:403-434` (`## Advisory Gates`, filtered on the advisory marker), `src/ship-gate.ts:425-436` (`## Advisory gates (reported, never blocking)`), fed by `readAdvisoryGateOutcomes` (`logger.ts:118`) at `ship-gate.ts:1221` | read both renderers and the wiring — see note P-01: nothing in this repo's shipped config makes the block appear |
| D16 — `test:budgets` stays blocking for a plain developer run | `package.json` untouched (`git diff --stat main...HEAD` lists no `package.json`), and `resolveScriptStep` (`src/preship.ts:80-87`) is not a `SanityPlan` member | read `preship.ts`; `SANITY_STEPS` unchanged, so neither sanity command list can see the budgets command (ADR 0063 holds) |
| D17 — cache keyed by gate id + resolved command/args + tree id, under `.afk/artifacts/<run-slug>/gate-cache.json` | `src/gate-cache.ts:66-68`, path assembled at `src/orchestrator.ts:5597-5606` and forwarded to both phases (`:5621`, `:5960`) | read; `src/gate-cache.test.ts` passed in my run |
| D17 — a changed tree or definition invalidates; a bad cache is a miss, never a throw | `readDocument`/`isEntry` (`gate-cache.ts:70-135`) treat absent, malformed, wrong-version and mis-filed entries as misses; only `PASS` is written (`:147`) | read; the entry's own fields must re-derive its key, so a hand-moved record cannot answer for another gate |
| D17 — every reuse and every prerequisite skip is explicit | `GateResult.cacheReused` / `.prerequisiteSkipped` (`src/gate-runner.ts:164-168`), reuse recorded at `:795-814`, rendered by `src/logger.ts:91-93` as `PASS (cache reuse)` and `SKIPPED (prerequisite tests failed)` | read the runner branch and the summary cell — a silent skip is not possible |
| D16/D17 — declared prerequisites, independent gates still report together | `prerequisiteGateIds` (`gate-runner.ts:144`), the branch at `:601-622` records SKIPPED and `continue`s; catalog in `src/base-gates.ts:53-56` (`tests`←`typecheck`, `test:budgets`←`tests`) | read the loop: it continues rather than breaking, so an independent `lint` still executes in the same attempt |
| D18 — the verification command is derived from required cheap gates in gate order, excluding the full suite | `resolveCheapGateCatalog` (`src/base-gates.ts:154-174`, full suite excluded by identity *and* cost), `resolveGeneratorTestCommand` (`src/preship.ts:168-190`), single call site `src/orchestrator.ts:6401` | read both; `GATE_EXPECTED_COST_MS` puts `tests` at 420_000 against the 120_000 default |
| D18 — `--test-command` may only narrow; a launch that drops a required cheap gate is refused naming it | `uncoveredCheapGateIds` (`src/preship.ts:138-148`) + the throw at `:175-186`, which names the omitted ids and prints the derived command | read; `src/orchestrator.test.ts:528-554` asserts `"pnpm test:fast"` alone throws naming `typecheck` while `"pnpm run typecheck && pnpm test:fast"` is accepted, and `pnpm x` normalizes against `pnpm run x` |
| D18 — the self-run sections of `AGENTS.md` and `CLAUDE.md` are corrected | `AGENTS.md:60` and `CLAUDE.md:47` both read `--test-command "pnpm run typecheck && pnpm test:fast"` | `Select-String '--test-command' AGENTS.md CLAUDE.md` — identical strings; `src/orchestrator.test.ts:566-584` reads the value out of both files and runs it through the check |
| D7 — one TypeScript/Vitest skip detector, base-vs-candidate counting, fails closed elsewhere | `DEFAULT_SKIP_DETECTORS` (`src/gate-policy.ts:148-160`: `.skip`, `.todo`, `.only`), `src/skip-gate.ts` declared through the in-process `run` seam and wired at `src/orchestrator.ts:5941` between `scope` and the full suite | ran `src/skip-gate.test.ts`: 7/7 pass, including "passes a pre-existing skip", "fails on an increase, naming the detector and the pattern", "catches a skip smuggled into a brand-new test file", "fails closed with no detector" |
| Contract's own evidence-version rule | `GATE_EVIDENCE_VERSION = 3` (`src/gate-runner.ts:43`), `SUPPORTED_GATE_EVIDENCE_VERSIONS = [1,2,3]` (`:46`), the three new markers optional and validated on read (`:1158-1164`) | read; older evidence still loads, so a resumed run does not lose its history |

Two things I specifically tried to break and could not: the skip gate counting
its own fixture prose (the QA round's `stripNonCode` fix holds — the "counts
detector text only where it is code, not in a string or a comment" test passed
in my run), and the cache answering for the wrong gate (an entry filed under a
key it does not describe is rejected at `gate-cache.ts:91-98`).

## Notes (not blocking)

- **P-01 — the advisory block is built but nothing turns it on.** `afk.config.json`
  on this branch (whole file, 26 lines) has `gatePolicy.version`,
  `protectedPaths`, `riskClasses` and `acceptance` — and **no `cost` member**,
  although the PRD's file-scope map assigns `afk.config.json` → `cost` to slice
  05. Consequence, read end to end: `resolveTestCostPlan` defaults
  `environmentSensitive` to `[]` (`src/base-gates.ts:139`),
  `environmentSensitiveDeclarations` returns `[]` unless the set names the gate
  (`:185-187`), and `src/logger.ts:403` filters the advisory block on attempts
  carrying the advisory marker — so no run of this repo, and no consuming project
  out of the box, ever renders `## Advisory Gates` or the PR's advisory section.
  D16's "`test:budgets` is the first declared member" is therefore unrealized in
  the product even though the mechanism, the declaration path and the renderers
  are all present and unit-covered (`src/base-gates.test.ts:106-260`). Kept a
  note rather than a blocker because the capability is complete and switching it
  on is one config array, and because the locked contract deliberately left
  `afk.config.json` out of `## Files expected to change` (so the generator could
  not have added it without a scope violation). It is worth a decision, not a
  round: enabling it makes every post-QA phase spawn the budgets script.
- **P-02 — `cost.relatedTests` is a config surface with no behavior.** It is
  parsed and validated (`src/gate-policy.ts:514-541`) and threaded into
  `TestCostPlan` (`src/base-gates.ts:123,141`), but no non-test file reads it
  (`Select-String 'relatedTests' src/*.ts` — every remaining hit is the parser,
  the plan field or a test). D1 lists "related-test selection" among `cost`'s
  contents, so an operator who declares it today gets no change in what runs and
  no warning that the member is inert. Same class as slice 08's D4 seam note.
- **P-03 — the `--test-command` refusal happens after the run journal opens.**
  The check runs inside `runPipeline` at `src/orchestrator.ts:6401`, after
  `logger.setFeatureBranch` (`:6395`), not at CLI option parse
  (`src/cli-options.ts`). The operator still gets a named, actionable refusal
  before any agent is dispatched, so the promise ("a bare `test:fast` override is
  refused before the run starts") holds in substance; a run directory exists by
  then, which is cosmetic.

## Out-of-scope PRD gaps (for the operator, not part of this verdict)

- Waiver **authorization** of an intentional skip is #193's (prd.md's
  "Two ownership gaps the splits created"), so a legitimately skipped test
  currently has no way to be waived — the gate fails closed, which is plan item
  17's stated and accepted failure mode.
- D18's derived command excludes `lint` for this repo simply because
  `package.json` declares no `lint` script; that is a property of the repo, not
  of the slice.
- Everything else in the PRD that is unmet belongs to slices 01-04, 06 and 07,
  which this invocation did not run.

## Structured findings (v1)

{"version":1,"findings":[{"id":"P-01","title":"Advisory test:budgets gate is implemented but no shipped config declares it, so the advisory run-summary/PR block never renders","class":"PRODUCT","clearCondition":"Either this repo's afk.config.json declares gatePolicy.cost.environmentSensitive with \"test:budgets\", or prd.md/issues records the decision not to enable it and which issue owns it.","disposition":"OPEN"},{"id":"P-02","title":"gatePolicy.cost.relatedTests is parsed and threaded but has no production consumer","class":"PRODUCT","clearCondition":"A production call site consumes TestCostPlan.relatedTests, or the PRD/issues records which later slice owns related-test selection so a declared member is not silently inert.","disposition":"OPEN"},{"id":"P-03","title":"--test-command narrowing refusal fires inside runPipeline after the run journal opens rather than at option parse","class":"PRODUCT","clearCondition":"The refusal is raised during CLI option validation, or the PRD records that a refusal after the journal opens satisfies \"refused before the run starts\".","disposition":"OPEN"}]}

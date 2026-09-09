# Slice 05 — Test cost split and caching (#86)

## What shipped

- B-01: `src/gate-policy.ts:parseCost` (plus `parseSkipDetector`,
  `parseRelatedTests`, `DEFAULT_CHEAP_THRESHOLD_MS`, `DEFAULT_CACHE_ENABLED`,
  `DEFAULT_SKIP_DETECTORS`) and `src/base-gates.ts:resolveTestCostPlan`, the
  single production reader every cost consumer goes through
- B-02: `src/base-gates.ts:resolveFullSuiteGateDeclarations` (the
  `test:budgets` declaration, `required: false`, `environmentSensitive: true`,
  assembled outside `resolveSanityPlan`), `src/logger.ts:writeSummary`'s
  `## Advisory Gates` block, `src/logger.ts:readAdvisoryGateOutcomes`, and
  `src/ship-gate.ts:buildPrCreationPlan`'s advisory PR-body section
- B-03: `src/gate-cache.ts:writeGateCacheEntry` / `readGateCacheEntry` /
  `gateCacheKeyOf`, consulted in `src/gate-runner.ts:runGates`, forwarded by
  `src/candidate-gate-phase.ts:runCandidateGatePhase` and
  `src/post-qa-gates.ts:runPostQAGates`, and pathed by
  `src/orchestrator.ts` (`gateCache`, `.afk/artifacts/<run-slug>/gate-cache.json`)
- B-04: the miss and invalidation guards in
  `src/gate-cache.ts:readGateCacheEntry` / `writeGateCacheEntry`, plus
  `GateResult.cacheReused` in `src/gate-runner.ts`
- B-05: `src/base-gates.ts:resolveCheapGateCatalog` and
  `src/preship.ts:resolveGeneratorTestCommand` / `uncoveredCheapGateIds`
  (catalog passed in as a parameter), with the accepted self-run command
  literal in `AGENTS.md` and `CLAUDE.md`
- B-06: `src/skip-gate.ts:runSkipGate` / `skipGateDeclaration` /
  `SKIP_GATE_ID`, declared in `src/orchestrator.ts` between
  `scopeGateDeclaration` and `...fullSuiteDeclarations`
- B-07: `GateDeclaration.prerequisiteGateIds` and the prerequisite branch in
  `src/gate-runner.ts:runGates`, surfaced as `GateResult.prerequisiteSkipped`
  and rendered by `src/logger.ts:gateStatusCell`
- P-01: `src/base-gates.test.ts` — the policy-less path resolves the
  documented defaults and leaves the full-suite phase at `["tests"]`
- P-02: `src/base-gates.test.ts` — `resolveSanityPlan`'s step names and order
  are untouched and neither command list mentions `test:budgets`
- P-03: `src/qa-orchestration.test.ts` — the spawned pre-QA/post-QA split
  scenario, still `["typecheck", "lint"]` before QA
- P-04: `src/base-gates.test.ts` — the acceptance plan and bindable catalog
  answer as before, and a malformed policy still throws

## Decisions made during implementation

- The cheap-gate catalog is a **parameter** of
  `resolveGeneratorTestCommand(cwd, catalog, override?)`, so `base-gates`
  imports `preship` and never the reverse. `src/orchestrator.ts` is the one
  place that composes the two.
- `test:budgets` is excluded from the sanity path by two independent
  mechanisms, deliberately: it is never added to `resolveSanityPlan`, so the
  three readers that know nothing about `GateDeclaration`
  (`resolveSanityCommands`, `resolveCandidateQACommands`,
  `projectSanityGateDeclarations`) cannot see it at all, and its declaration
  carries `required: false`, so the gate phase cannot block on it (ADR 0063).
- Advisory rows are rendered in their own `## Advisory Gates` block rather
  than inside `## Base Gates`. An operator scanning the base-gate table is
  asking what blocked the candidate; a red row that can never block does not
  belong to that answer.
- One `resolveTestCostPlan(ctx.worktreeDir)` read per round feeds both the
  cache switch and the skip gate's detectors, so the two features cannot
  disagree about the policy they were configured from.
- The gate cache is keyed on `gateId + command + JSON(args) + treeId`, args
  JSON-encoded so `["a b"]` cannot collide with `["a","b"]`, and an entry
  filed under a key it does not describe is a miss.
- Only `PASS` is cached. A `FAIL` is a fact about a tree the next round exists
  to change, and an `INFRASTRUCTURE` result is a fact about the machine.
- The skip gate reads every base blob in a single `git cat-file --batch`
  process rather than one `git show` per file, so it does not cost tens of git
  spawns per phase.
- `resolveFullSuiteGateDeclarations` emits no `test:budgets` declaration when
  the project has no such script, so opting out needs no `package.json`
  change.

## Gotchas / learnings

- The policy lives in `afk.config.json` under the top-level `gatePolicy` key
  (`loadGatePolicy`), not in a `.afk/` file — a fixture that writes the wrong
  path silently exercises the defaults instead.
- `parseGatePolicy`'s unknown-member cases used `cost: {}` as their example
  unknown key. `cost` is now known, so those two assertions moved to `costs`
  — the same edit slice 02 made when `acceptance` became known.
- The bindable gate id is `ACCEPTANCE_GATE_ID === "acceptance:behaviors"`, not
  `"acceptance"`.
- `expectedCostMs` is stamped on the *phase* declarations
  (`resolvePreQAGateDeclarations`, `resolveFullSuiteGateDeclarations`) and not
  on `resolveBaseGateDeclarations`, whose other consumer is the bindable
  catalog a locked manifest is compared against. A scriptless project's
  commandless declarations carry it too, which is why
  `orchestrator.test.ts`'s P-03 expectation grew the field.
- `runGates` verifies that its `treeId` argument matches the tree it is run
  on, so a test that wants a cache miss has to produce a *real* second tree;
  a fabricated tree id is reported `INFRASTRUCTURE`.
- `toMatchObject({ key: undefined })` fails when the received object omits the
  key; assert `expect(x.key).toBeUndefined()` separately.
- A post-QA gate test must write its marker, evidence and cache **outside**
  the worktree: anything it drops inside is post-QA tree drift and
  `reviewArtifactViolations` correctly rejects the run.
- New migration files: 0

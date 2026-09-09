# Slice Contract — Test-cost split and gate caching

**Parent PRD:** .kiro/specs/afk-v2-acceptance-scope-gates/prd.md
**GH issue:** #86
**Status:** LOCKED

**Lock-Provenance:** negotiation round 3
**Negotiation round:** 2

## Scope lock

Complete the test-cost half of the gate policy. `gatePolicy.cost` becomes a
parsed, validated member of `src/gate-policy.ts`; `src/base-gates.ts` — already
the one production reader of the policy (`loadGatePolicy` at
`src/base-gates.ts:108`) — resolves it once and hands each consumer its part. On
that plan the slice ships `test:budgets` as a declared `environmentSensitive`
gate that runs but cannot block and is declared outside the sanity plan,
declared gate prerequisites, a tree-identity gate cache in
`.afk/artifacts/<run-slug>/gate-cache.json`, a `tests:skipped` detector gate
declared through the in-process `run` seam, and the derived verification command
whose required cheap gates every `--test-command` override must still cover.

### In scope

- [behavior:B-01] `gatePolicy.cost` is parsed, validated, and threaded to every
  consumer from one site. `POLICY_KEYS` (`src/gate-policy.ts:24-29`) gains
  `"cost"` so `requireKnownKeys` stops refusing it, and a `parseCost` modelled on
  `parseProtectedPaths` (`:287-329`) is assembled into the returned `GatePolicy`
  (`:415-446`) as `cost?: GatePolicyCost`. Shape is the settled hybrid in
  `.kiro/specs/afk-v2-acceptance-scope-gates/anchors/05-test-cost-split.md`:
  `cheapThresholdMs` (default 120000), `environmentSensitive` (gate-ID array),
  `cacheEnabled` (default true), `relatedTests` (`{command, args}`), and
  `skipDetectors` (records of `id`, `testGlobs`, `patterns`) whose `testGlobs`
  reuse `assertGlobDialect`/`matchesGlob` (`:194-285`, D6). Unknown sub-keys,
  wrong types, and empty `patterns` are refused naming the offending path.
  **The live-run load site is `src/base-gates.ts`**, which already calls
  `loadGatePolicy(cwd)` at `:108`: a new exported
  `resolveTestCostPlan(cwd): TestCostPlan` reads `loadGatePolicy(cwd)?.cost`,
  applies those defaults, and is the only production reader of `cost`. Each
  consumer takes its part from that plan, with no second policy read: (a)
  `projectSanityGateDeclarations` (`:15-32`) stamps `expectedCostMs` and
  `prerequisiteGateIds` on the declarations
  `resolvePreQAGateDeclarations`/`resolveFullSuiteGateDeclarations` return, and
  `resolveFullSuiteGateDeclarations` appends the `environmentSensitive`
  declaration the plan names, assembled outside the sanity plan (B-02, B-07);
  (b) a new exported `resolveCheapGateCatalog(cwd)` applies
  `cheapThresholdMs`, and `src/orchestrator.ts:6364` passes its result into
  `resolveGeneratorTestCommand` (B-05); (c) `src/orchestrator.ts` reads
  `cacheEnabled` from the same plan and passes cache options into
  `runCandidateGatePhase`/`runPostQAGates`, which forward them to `runGates`
  (B-03, B-04); (d) `src/orchestrator.ts` passes `skipDetectors` into the
  `tests:skipped` declaration it assembles (B-06). A declared `cost` member
  therefore changes what a run assembles, not only what a parser returns.
- [behavior:B-02] `test:budgets` is a declared `environmentSensitive` gate, and it
  is declared **outside the sanity plan**. `SANITY_STEPS`
  (`src/preship.ts:21-28`) and `BASE_GATE_IDS` (`src/base-gates.ts:11`) are
  unchanged, so `resolveSanityPlan` still yields exactly `typecheck`, `lint`,
  `tests` and the three readers that know nothing about `GateDeclaration` never
  see the budgets command: `resolveSanityCommands` (`:131-135`) — hence
  `runPreShipSanity` and evaluator QA's `{{SANITY_COMMANDS}}` — and
  `resolveCandidateQACommands` (`:145-153`). That absence, not a declaration
  field, is what keeps a red budget from failing the pre-ship gate, as ADR 0063
  (`docs/adr/0063-a-wall-clock-budget-cannot-fail-a-gate.md`) requires: "`pnpm
  test` runs the suites and nothing else", and "a budget overage is never a
  finding against a slice". The declaration is instead assembled in
  `src/base-gates.ts` from its own `ENVIRONMENT_SENSITIVE_STEPS` table through a
  new exported `resolveScriptStep(cwd, scriptName): SanityCommand | null` in
  `src/preship.ts` — a direct `package.json` scripts read that is not a
  `SanityPlan` member and enters no sanity command list — backed by the existing
  `package.json:33` script; an absent script yields no declaration at all, so
  today's undeclared `required: false` path (`src/gate-runner.ts:388`) is
  untouched. `resolveFullSuiteGateDeclarations` appends it after `tests` (its
  prerequisite, B-07) only when `resolveTestCostPlan(cwd).environmentSensitive`
  names it, and it stays out of `resolveBindableGateCatalog` (`:146-160`) because
  a manifest behavior must not bind its proof to a gate that cannot fail (P-04).
  `GateDeclaration` (`src/gate-runner.ts:90-110`) gains
  `environmentSensitive?: boolean` (D16) and a declared member is emitted
  `required: false` from `src/base-gates.ts`; that is the whole mechanism for the
  *gate-phase* exclusion — no second exclusion path is added to
  `src/candidate-gate-phase.ts:169` or `src/candidate-gate-policy.ts:51-74`
  (D16) — and it is deliberately a different mechanism from the sanity-plan
  absence above, because those two exclusions have two different readers. It
  executes, its real status reaches gate evidence, and it appears in a new
  advisory block in `run-summary.md` (`src/logger.ts`) and in the draft PR body
  (`src/ship-gate.ts:395-415`'s section list). `package.json` is unchanged, so
  `pnpm test:ratchet` still exits non-zero for a developer and D16's "stays
  blocking for plain developer runs" holds without contradicting the ADR.
- [behavior:B-03] A green result on an identical tree and unchanged definition is
  reused. New `src/gate-cache.ts` reads and writes
  `.afk/artifacts/<run-slug>/gate-cache.json` keyed by gate ID plus resolved
  command and args plus tree ID (D17). `RunGatesOptions` gains
  `cache?: { path: string; enabled: boolean }`; the declaration loop
  (`src/gate-runner.ts:512`) consults it before spawning and records a hit as
  `PASS` marked reused. Only `PASS` is cached, and reuse is explicit in gate
  evidence and `run-summary.md`. `src/candidate-gate-phase.ts` and
  `src/post-qa-gates.ts` forward the option from their existing `repoRoot` — a
  pass-through parameter, not new gate logic in either file.
- [behavior:B-04] A changed tree or definition invalidates the entry: a different
  tree ID, or different resolved command or args, misses and re-executes (D17).
  `cacheEnabled: false` disables lookup and write; a malformed or unreadable
  cache file is a miss, never a throw.
- [behavior:B-05] The verification command is derived from the catalog.
  `resolveGeneratorTestCommand` (`src/preship.ts:77-82`) takes the cheap-gate
  catalog as a parameter, not an import, because `src/base-gates.ts` imports
  `src/preship.ts` and the dependency may not reverse; with no override it
  returns the required cheap gates' commands joined with ` && ` in gate order,
  excluding the full-suite `tests` gate (D18) — for this repo, which declares no
  `lint` script (`package.json:17-37`), exactly `pnpm run typecheck`. **The
  `--test-command` (`src/cli-options.ts:235`) check is over gate IDs, not over
  the derived command string** — recorded here as this slice's decision. The
  override is split on `&&`, each segment trimmed and normalized so `pnpm <script>`
  and `pnpm run <script>` are the same segment, and the launch is refused only
  when a required cheap gate's own resolved command is absent from those
  segments; the refusal names the omitted gate IDs. Segments naming no cheap gate
  are permitted and unvalidated, because which extra fast subset the generator
  iterates on is ADR 0038's decision
  (`docs/adr/0038-generator-verification-command.md`: the generator's
  verification command is its own decision) and `src/cli-options.ts:55` documents
  the flag as pointing at a fast subset. So `pnpm test:fast` **remains an
  accepted** part of an override: `--test-command "pnpm test:fast"` alone is
  refused naming `typecheck`, and
  `--test-command "pnpm run typecheck && pnpm test:fast"` is accepted. Its one
  call site is `src/orchestrator.ts:6364`. ADR 0038 keeps this separate from
  `resolveSanityPlan`, and ADR 0012's single source is untouched. Both self-run
  sections are corrected to carry that literal command —
  `afk-codex --prd-dir .kiro/specs/<prd-slug> --test-command "pnpm run typecheck && pnpm test:fast"`
  — replacing `AGENTS.md`'s `pnpm typecheck && pnpm test:fast` and `CLAUDE.md`'s
  `pnpm test:fast`, and a new assertion in `src/orchestrator.test.ts` reads the
  `--test-command` value out of both documents and asserts they are identical and
  that the override check accepts each.
- [behavior:B-06] A `tests:skipped` gate catches a newly introduced TypeScript or
  Vitest skip. New `src/skip-gate.ts` declares it through the in-process
  `GateDeclaration.run` seam, modelled on `src/scope-gate.ts` (#195, D22: a
  content-derived status cannot come from `classifyExecution`). It counts each
  detector's `patterns` over files matching its `testGlobs` on the base tree and
  the candidate tree and fails only on an increase, so pre-existing occurrences
  do not fire; with no detector matching the project's test files it fails closed
  (D7, plan item 17). Waiver authorization is out of scope. It is declared in
  `postQaDeclarations` (`src/orchestrator.ts:5899-5915`) between
  `scopeGateDeclaration` and `fullSuiteDeclarations`, taking
  `worktreeDir`/`featureRef` from the same resolved pair the scope gate uses
  (`ctx.worktreeDir`, `featBranch`, `:5906-5907`); `runPostQAGates` passes those
  declarations to `decideCandidateGatePhase` (`src/post-qa-gates.ts:235-240`), so
  a red required `tests:skipped` becomes REPAIR. The existing assertions that
  already observe the assembled list are updated to include it:
  `src/qa-orchestration.test.ts` asserts the post-QA gate IDs as exactly
  `["scope", "tests"]` at `:1071`, `:2281-2287`, `:2309-2315` and `:2432`, and
  each becomes `["scope", "tests:skipped", "tests"]`.
- [behavior:B-07] A declared prerequisite stops a dependent gate without stopping
  independent ones. `GateDeclaration` gains
  `prerequisiteGateIds?: readonly string[]`; the in-order loop
  (`src/gate-runner.ts:512`) records a dependent as `SKIPPED` naming the failed
  prerequisite and continues with declarations naming no failed prerequisite, so
  independent failures still arrive together (D16/D17). `src/base-gates.ts`
  declares `tests` with prerequisite `typecheck`, and `test:budgets` with
  prerequisite `tests` (it reads the `.vitest-reports/*.json` the suite writes).
  Skips are explicit in gate evidence and `run-summary.md` — a silent skip is
  indistinguishable from a gate that never ran (D17).

### Non-goals (explicit out-of-scope)

- Waiver **authorization**, or any second waiver reader (#193 owns
  `protectedChangeWaivers` in `src/afk-manifest.ts`).
- New risk classes (`src/gate-policy.ts:71` already declares `skipped-test`).
- Changing `pnpm test`, `pnpm test:ratchet`, the budgets script, or
  `suite-budgets.json` numbers (ADR 0063).
- `protectedPaths`/`riskClasses`/`acceptance` semantics (#84, #85), the
  file-scope gate itself (#195), behavior-coverage reporting (#85).
- Caching non-`PASS` results, cross-run sharing, or eviction beyond per-key
  overwrite.

### Existing behavior to preserve

- [behavior:P-01] A repo with no `gatePolicy`, or no `cost` member, keeps today's
  behavior: `loadGatePolicy` returns `null` (`src/gate-policy.ts:458-468`), the
  defaults apply, and existing `protectedPaths`/`riskClasses`/`acceptance` cases
  pass unchanged.
- [behavior:P-02] ADR 0012's single source holds: `resolveSanityPlan`
  (`src/preship.ts:105-120`), `resolveSanityCommands`,
  `resolveCandidateQACommands` and `projectSanityGateDeclarations` still agree
  about which script backs a step, and `runPreShipSanity` still runs the
  aggregate suite. `SANITY_STEPS` is unchanged, so `resolveSanityPlan`'s step
  names stay `["typecheck", "lint", "tests"]` and neither
  `resolveSanityCommands(repoRoot)` nor `resolveCandidateQACommands(repoRoot)`
  contains the `test:budgets` command (B-02).
- [behavior:P-03] The pre-QA/post-QA split stands: `preQaDeclarations`
  (`src/orchestrator.ts:5558-5563`) runs cheap gates plus the acceptance gate
  before candidate QA, the full suite runs only after QA accepts that exact tree,
  a full-suite failure still returns evidence to the next repair round, and the
  existing pre-QA gate-ID assertions (`["typecheck", "lint"]`) stay green.
- [behavior:P-04] `resolveAcceptancePlan` (`src/base-gates.ts:107-125`) and
  `resolveBindableGateCatalog` (`:146-160`) keep their answers for a project
  declaring no `cost`; a malformed policy still throws rather than degrading.

### Changes to existing behavior (only if the issue asks for it)

- `--test-command` is validated against the required cheap gate IDs rather than
  passed through, and both `AGENTS.md` and `CLAUDE.md` self-run sections carry the
  one literal command named in B-05 (#86, D18).
- Post-QA gate IDs gain `tests:skipped`, so the four
  `src/qa-orchestration.test.ts` assertions named in B-06 are updated (#86, D7).
- `GATE_EVIDENCE_VERSION` (`src/gate-runner.ts:24`) becomes `3` in this slice —
  unconditionally, not left to the implementation. `cacheReused`,
  `prerequisiteSkipped` and `environmentSensitive` are **optional** on
  `GateResult` and on the `gate-outcome` event, present only for the gate they
  describe, so absence means "not reused" / "not skipped" and no existing
  fixture or writer has to carry a false flag; the version still bumps because a
  version-2 reader must not silently ignore a reuse or prerequisite-skip marker
  (#86, D17). The reader side is settled here, not by the implementation: `3`
  **joins** `SUPPORTED_GATE_EVIDENCE_VERSIONS` (`src/gate-runner.ts:27`), which
  becomes `[1, 2, 3]`, so `verifyGateEvidence` (`:804-807`) accepts a
  version-1, version-2 or version-3 document and the version-1 branch at `:835`
  is unchanged. The version-keyed `findings` rule at `src/gate-runner.ts:22-27`
  is rewritten to key on "version 1 may not carry `findings`; version 2 and
  version 3 may" — a version-3 document carries `findings` exactly as a
  version-2 one does, because this slice adds no findings semantics (D22 owns
  them). The constant's docstring records both bumps (1 → 2 for
  `GateFindings`, 2 → 3 for the optional cache and prerequisite markers) so the
  rule and the accepted list stay readable together.
- Every in-tree assertion of the old constant is updated in this slice, and each
  file holding one is declared in `## Files expected to change`: two in
  `src/gate-runner.test.ts` (`:629`, `:978-979`) and one in
  `src/acceptance-gate.test.ts:326` (`expect(GATE_EVIDENCE_VERSION).toBe(2)`,
  imported at `:24`), each becoming `3`. `src/acceptance-gate.test.ts` is
  otherwise untouched — its `version: 2` fixture at `:134` is an
  acceptance-manifest document, not gate evidence, and stays `2` (#86, F-14).

## Files expected to change

- src/gate-policy.ts
- src/gate-policy.test.ts
- src/base-gates.ts
- src/base-gates.test.ts
- src/gate-runner.ts
- src/gate-runner.test.ts
- src/gate-cache.ts
- src/gate-cache.test.ts
- src/acceptance-gate.test.ts
- src/skip-gate.ts
- src/skip-gate.test.ts
- src/candidate-gate-phase.ts
- src/post-qa-gates.ts
- src/post-qa-gates.test.ts
- src/preship.ts
- src/orchestrator.ts
- src/orchestrator.test.ts
- src/qa-orchestration.test.ts
- src/logger.ts
- src/logger.test.ts
- src/run-events.ts
- src/ship-gate.ts
- src/ship-gate.test.ts
- ARCHITECTURE.md
- AGENTS.md
- CLAUDE.md

## Migration requirements

- New migration files: 0

## New patterns / deps / schema (if any)

- `GatePolicyCost` type and parser in `src/gate-policy.ts`; `TestCostPlan`,
  `resolveTestCostPlan`, `resolveCheapGateCatalog` in `src/base-gates.ts`;
  `resolveScriptStep` in `src/preship.ts` (a `package.json` script lookup that is
  not a `SanityPlan` member).
- `GateDeclaration.environmentSensitive` and `.prerequisiteGateIds`;
  `RunGatesOptions.cache`; optional `cacheReused`/`prerequisiteSkipped`/
  `environmentSensitive` on `GateResult`, with `GATE_EVIDENCE_VERSION` bumped to
  `3` in this slice and `SUPPORTED_GATE_EVIDENCE_VERSIONS` becoming `[1, 2, 3]`
  (version 2 and version 3 may carry `findings`; version 1 may not).
- `src/gate-cache.ts`: versioned `gate-cache.json` document (`version: 1`).
- `src/skip-gate.ts`: `SKIP_GATE_ID = "tests:skipped"`, declared through `run`.
- Optional `environmentSensitive`, `cacheReused`, `prerequisiteSkipped` fields on
  the `gate-outcome` event (`src/run-events.ts:143-160`).
- No new runtime dependencies (AFK has none).

## Test plan

- Given a full `cost` object, when `parseGatePolicy` runs, then the typed `cost`
  returns, and an unknown sub-key, a non-number `cheapThresholdMs`, empty
  `patterns` or a bad `testGlob` metacharacter each throw naming the path.
- Given `environmentSensitive: ["test:budgets"]`, when the declarations assemble
  and that gate runs red, then it is `required: false`, its real `FAIL` is in
  evidence, `decideCandidateGatePhase` does not name it, no round is consumed,
  and `run-summary.md` and the draft PR list it as advisory.
- Given this repo's own `package.json`, when `resolveSanityPlan`,
  `resolveSanityCommands` and `resolveCandidateQACommands` run with
  `environmentSensitive: ["test:budgets"]` declared, then the plan's step names
  are still `["typecheck", "lint", "tests"]`, neither command list contains
  `test:budgets`, and `resolveBindableGateCatalog` does not list it — while
  `resolveFullSuiteGateDeclarations` does, after `tests`.
- Given a lowered `cheapThresholdMs`, when `resolveCheapGateCatalog` and
  `resolveGeneratorTestCommand` run, then costlier gates drop out, `tests` is
  excluded from the derived command regardless, `"pnpm run typecheck && pnpm
  test:fast"` is accepted, `"pnpm typecheck"` is accepted as the same segment as
  `"pnpm run typecheck"`, `"pnpm test:fast"` alone throws naming `typecheck`, and
  the `--test-command` value parsed out of `AGENTS.md` and `CLAUDE.md` is the same
  string in both and is accepted.
- Given a cached `PASS` for `typecheck` at tree T, when `runGates` runs it at T
  with the same args, then nothing spawns and the result is `PASS` marked reused;
  at another tree, changed args, `cacheEnabled: false`, or a corrupt cache file,
  the gate executes.
- Given `tests` with prerequisite `typecheck` and an independent `lint`, when
  `typecheck` fails, then `tests` is `SKIPPED` naming `typecheck` while `lint`
  executes and reports in the same attempt, both visible in evidence and
  `run-summary.md`.
- Given a candidate adding `it.skip` to a file matching a detector's `testGlobs`,
  when the post-QA phase runs, then `tests:skipped` returns `FAIL` through `run`,
  the phase returns REPAIR naming it, and the gate IDs are
  `["scope", "tests:skipped", "tests"]` at the four
  `src/qa-orchestration.test.ts` assertions named in B-06; an unchanged base-tree
  skip returns `PASS`, and no matching detector returns `FAIL`.
- Given the bumped constant, when the evidence readers run, then
  `GATE_EVIDENCE_VERSION` is `3`, `verifyGateEvidence` accepts a version-1,
  version-2 and version-3 document and still refuses an unsupported version and
  a version-1 document carrying `findings`, a version-3 document carrying
  `findings` is accepted, and the three in-tree assertions of the constant —
  `src/gate-runner.test.ts:629`, `:978-979` and `src/acceptance-gate.test.ts:326`
  — read `3` and are green, while `src/acceptance-gate.test.ts:134`'s
  acceptance-manifest fixture stays `version: 2`.
- Given a repo with no `gatePolicy`, when the phases run, then pre-QA gate IDs
  are still `["typecheck", "lint"]` and existing `src/gate-policy.ts` and
  `src/preship.ts` expectations hold.

## Definition of done

- [ ] `POLICY_KEYS` includes `"cost"`; malformed `cost` is refused naming the
      offending path.
- [ ] `resolveTestCostPlan` is the only production reader of `cost`, and every
      consumer named in B-01 gets its part through a parameter.
- [ ] `test:budgets` is declared `environmentSensitive` and `required: false`,
      executes, records its real status, blocks nothing, enters no repair failure
      set, consumes no round, and appears in the advisory block of
      `run-summary.md` and the draft PR.
- [ ] `SANITY_STEPS` is unchanged and `test:budgets` appears in neither
      `resolveSanityCommands(repoRoot)` nor `resolveCandidateQACommands(repoRoot)`
      nor `resolveBindableGateCatalog(repoRoot)`.
- [ ] `gate-cache.json` reuses a `PASS` on an identical tree and definition and
      misses on a changed tree, changed command/args, or `cacheEnabled: false`.
- [ ] A dependent gate is `SKIPPED` naming its failed prerequisite while
      independent gates still report; reuse and skips are explicit in gate
      evidence and `run-summary.md`.
- [ ] The derived command holds every required cheap gate in gate order and
      excludes the full suite; a `--test-command` omitting a required cheap gate
      refuses the launch naming the omitted gate IDs while extra segments such as
      `pnpm test:fast` are accepted; `AGENTS.md` and `CLAUDE.md` both carry
      `--test-command "pnpm run typecheck && pnpm test:fast"`, and the
      `src/orchestrator.test.ts` assertion that reads both documents proves they
      agree and that the value passes the check.
- [ ] `GATE_EVIDENCE_VERSION` is `3`, with the cache and prerequisite fields
      optional on `GateResult` and on the `gate-outcome` event;
      `SUPPORTED_GATE_EVIDENCE_VERSIONS` is `[1, 2, 3]`, the docstring rule at
      `src/gate-runner.ts:22-27` says version 2 and version 3 may carry
      `findings` and version 1 may not, and the constant's three in-tree
      assertions (`src/gate-runner.test.ts:629`, `:978-979`,
      `src/acceptance-gate.test.ts:326`) read `3` and are green.
- [ ] `tests:skipped` is declared in `postQaDeclarations` through
      `GateDeclaration.run`, fires on a newly introduced skip or `.only` and not
      a pre-existing one, fails closed with no detector, and the four
      `src/qa-orchestration.test.ts` assertions named in B-06 include it and are
      green.
- [ ] `ARCHITECTURE.md`'s Gates row lists `src/gate-cache.ts` and
      `src/skip-gate.ts`.
- [ ] `pnpm run typecheck` and the touched suites are green; no file outside
      `## Files expected to change` is modified.
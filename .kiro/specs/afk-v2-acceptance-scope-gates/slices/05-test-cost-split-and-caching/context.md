# Context — Slice 05 (#86): Test cost split and caching

## Files and current behavior

- FACT: `src/gate-policy.ts` is the config reader for `afk.config.json`'s
  `gatePolicy`. `POLICY_KEYS` (`src/gate-policy.ts:24-29`) is exactly
  `["version", "protectedPaths", "riskClasses", "acceptance"]`; `cost` is not
  yet a known key, and `requireKnownKeys` (`src/gate-policy.ts:127-143`) throws
  on any unrecognized member. This slice must widen `POLICY_KEYS` and add a
  `cost` parser/type, per the anchors file's settled hybrid shape.
- FACT: `GatePolicy` (`src/gate-policy.ts:109-119`) has no `cost` member today.
  `parseGatePolicy` (`src/gate-policy.ts:415-446`) builds the returned object
  from `protectedPaths`, `riskClasses`, and optional `acceptance` only.
- FACT: `loadGatePolicy(repoRoot)` (`src/gate-policy.ts:458-468`) returns
  `null` when `afk.config.json` is absent or has no `gatePolicy` key, and
  parses with `parseJsonWithUniqueKeys` (duplicate-key detection).
- FACT: `src/base-gates.ts` derives `BASE_GATE_IDS = ["typecheck", "lint",
  "tests"]` (`src/base-gates.ts:11`), `PRE_QA_GATE_IDS = ["typecheck",
  "lint"]` (`:12`), `FULL_SUITE_GATE_IDS = ["tests"]` (`:13`). None of the
  three declarations built by `projectSanityGateDeclarations`
  (`src/base-gates.ts:15-32`) sets `expectedCostMs`; `GateDeclaration` has no
  `expectedCostMs` field set anywhere in `src/` (verified by inspection — the
  field is declared at `src/gate-runner.ts:106-107` but no current gate
  populates it).
- FACT: `test:budgets` is not a gate today. It exists only as a `package.json`
  script (`package.json:33`, `"test:budgets": "node
  scripts/check-suite-budgets.mjs"`) invoked by `pnpm run test:ratchet`
  (`package.json:25`). No `src/*.ts` file references `check-suite-budgets.mjs`
  or the string `test:budgets` (grep across `src/` for `testCommand|test-
  command` returned 17 files, none of which name `test:budgets`).
- FACT: `scripts/check-suite-budgets.mjs` reads `.vitest-reports/*.json`
  (written by `scripts/timed-suite.mjs`, referenced from every
  `test:heavy:*`/`test:fast` script) and `suite-budgets.json`, and exits 1 on
  any suite/total over budget or any suite with no budget entry
  (`scripts/check-suite-budgets.mjs:198-234`). It is explicitly NOT part of
  `pnpm test` (ADR 0063) because a red result there cannot be fixed by an
  unattended agent — only a human/CI reader can decide to raise the number.
- FACT: ADR 0063 (`docs/adr/0063-a-wall-clock-budget-cannot-fail-a-gate.md`)
  decides `pnpm test` runs only the suites (assertion failures), and the
  budget ratchet lives in `pnpm test:ratchet` = `pnpm test && pnpm
  test:budgets`. It records the incident (#78: a 130.5s `fast` suite against a
  110s budget, zero failing tests, took a blocking Major finding) that this
  slice's `environmentSensitive` design is meant to prevent from recurring
  once `test:budgets` becomes a declared gate.
- FACT: `declaration.required` (`GateDeclaration.required`,
  `src/gate-runner.ts:93`) is read in exactly four places:
  `src/candidate-gate-phase.ts:86` (`isRequired`, used at `:134-137` to gate
  infrastructure-retry logic) and `src/candidate-gate-phase.ts:169`
  (`assertGateEvidenceReleasesEvaluation`'s per-result check `(!declaration
  .required || result.status === "PASS")`), and
  `src/candidate-gate-policy.ts:51-53` (`requiredIds` built from `declarations
  .filter(d => d.required)`) and `:74` (`requiredIds.has(result.gateId) &&
  result.status === "FAIL"` — the failure set the REPAIR decision carries).
- FACT: Setting `required: false` on a gate declaration already yields D16's
  "executes, records its real status, neither blocks (`:169`'s check passes
  regardless of status) nor enters the repair failure set (`:74`'s
  `requiredIds.has` excludes it) nor consumes a round". No new exclusion path
  exists in these two files today; per the issue's own anchors, this is
  "mostly achievable via `required: false`" and the advisory run-summary
  section is the new work.
- FACT: `src/logger.ts` has no per-slice or per-gate-class section machinery.
  The run-summary is one template literal starting at `src/logger.ts:420`
  (`` `# Run Summary — ${prdSlug} ...` ``), with `gateSection` (`## Base
  Gates`, built `:332-350`), `coverageSection` (`## Behavior Coverage`,
  `:355-376`), `dependencySection` (`## Dependency Holds`, `:377-394`), and
  `adoptionSection` (`## Adopted Slices`, `:395-418`) all assembled as string
  fragments and interpolated into the final template at `:429-430`. A new
  "advisory"/environment-sensitive section is another such fragment, gated on
  `gateAttempts.length === 0` style emptiness checks, not a generic mechanism.
- FACT: `src/preship.ts` (`resolveSanityPlan`, `:105-120`) is ADR 0012's single
  source for what the pre-ship sanity gate, the base-gate catalog
  (`src/base-gates.ts`'s `projectSanityGateDeclarations`), and evaluator QA's
  `{{SANITY_COMMANDS}}` all run — none of the three may disagree about the
  backing script.
- FACT: `resolveCandidateQACommands(cwd)` (`src/preship.ts:145-153`) already
  implements the "cheap prerequisites before candidate QA, full suite
  deferred" sequence described in the issue's "Early delivery during PRD 3"
  section: it filters `plan.steps` to exclude the step named `"tests"`. Its
  docstring (`:137-143`) states this is "the narrow early delivery... the
  policy-owned gate catalog and automatic related-test selection remain PRD 4
  work" — i.e., this slice.
- FACT: `resolveGeneratorTestCommand(cwd, override)` (`src/preship.ts:77-82`)
  currently has no validation of `override` beyond passing it straight
  through: precedence is `override ?? resolveTestCommand(cwd) ?? "pnpm
  test"`. There is no check today that `override` covers every required cheap
  gate in gate order or excludes the full-suite gate — the issue's `--test-
  command` refusal requirement (named-omitted-gate-IDs) is new behavior.
- FACT: `--test-command` is parsed in `src/cli-options.ts:235`
  (`parseCommandOption(args, "--test-command")`) into `PipelineOptions
  .testCommand` (`src/cli-options.ts:55`, documented as "Point it at a fast
  subset... to keep whole-suite runs out of every generator round; the gate
  and QA still run the full set"). It is consumed by `src/orchestrator.ts` and
  `src/context-envelope.ts` (both appear in the 17-file grep for
  `testCommand`), and surfaced on `src/afk.ts`, `src/afk-claude.ts`,
  `src/afk-codex.ts` CLI entries.
- FACT: `AGENTS.md`'s self-run section (around its "generator's verification
  command explicitly" heading) prescribes `afk-codex --prd-dir
  .kiro/specs/<prd-slug> --test-command "pnpm typecheck && pnpm test:fast"`.
  `CLAUDE.md`'s equivalent section prescribes `afk-codex --prd-dir
  .kiro/specs/<prd-slug> --test-command "pnpm test:fast"` — omitting
  `typecheck`. The issue explicitly calls out this disagreement and requires
  D18 to correct both, deriving the command from the catalog instead of hand-
  writing it.
- FACT: `src/gate-runner.ts`'s `GateDeclaration` (`:90-110`) has no
  `environmentSensitive` field. `expectedCostMs` (`:106-107`) and
  `wallClockTimeoutMs` (`:108-109`) already exist as optional numeric fields
  on the same interface; `environmentSensitive` is new.
- FACT: `GateEvidence`/`GateResult`/`GateFindings` are versioned;
  `GATE_EVIDENCE_VERSION = 2` (`src/gate-runner.ts:24`). `GateFindings`
  (`:78-88`) currently declares `outOfScopePaths`, `deletedTests`,
  `protectedChanges`, `appliedWaivers` — no cache-related or cost-related
  fields. Adding cache-reuse/prerequisite-skip visibility to evidence (an
  acceptance criterion) means either a new `GateFindings` member or a new
  `GateResult` field; no version-3 bump exists yet in this repo.
- FACT: `.afk/artifacts/<run-slug>/gate-cache.json` (the cache path named in
  the issue) does not exist as a concept anywhere in `src/` today — no file
  references `gate-cache.json`. The evidence directory convention elsewhere is
  `.afk`-rooted (e.g. `.afk/checkpoints/...` in `src/post-qa-gates.ts:167-171`)
  but no cache module exists yet.
- FACT: `src/scope-gate.ts` is the one worked example of an in-process
  (`run`, not `command`) `GateDeclaration` (ADR/ARCHITECTURE.md's stated
  seam). `SCOPE_GATE_ID = "scope"` (`:26`), stage `"deterministic"` (`:29`).
  The issue's linked #195 (file-scope gate) explains that a content-derived
  gate (like the skip detector this slice must ship) needs `GateDeclaration
  .run` to return its own status rather than being classified from an exit
  code — `classifyExecution` (`src/gate-runner.ts:892-914`) only classifies
  command-path executions.
- FACT: `src/candidate-gate-phase.ts` (`runCandidateGatePhase`) and
  `src/post-qa-gates.ts` (`runPostQAGates`) are the two call sites that invoke
  `runGates`/`decideCandidateGatePhase` for, respectively, the pre-QA/candidate
  phase and the full post-QA suite phase. Both take a flat `declarations:
  readonly GateDeclaration[]` array with no ordering/prerequisite dependency
  metadata between declarations — "gate prerequisites" (D16/D17: "an expensive
  gate does not run after a failed prerequisite") is not represented in either
  interface today.
- FACT: `runGates` (`src/gate-runner.ts:392-797`) already executes
  declarations strictly in array order (`for (const [index, declaration] of
  options.declarations.entries())`, `:512`), and a `checkpointError` or
  missing `restoreCheckpoint` causes a `break` (`:677`) that stops all
  subsequent declarations — so "stop after an infrastructure fault" already
  exists, but there is no declared-prerequisite concept that stops a
  *specific* dependent gate after a *specific* failed prerequisite while still
  letting independent gates run and "arrive together" (an explicit acceptance
  criterion).

## Patterns and test harness

- FACT: `package.json` scripts of interest: `test` (`:24`, clears
  `.vitest-reports`, runs `test:fast` + all five `test:heavy:*`),
  `test:ratchet` (`:25`, `test` + `test:budgets`), `test:fast` (`:26`,
  excludes the heavy integration files and `*.e2e.test.ts`), five
  `test:heavy:<name>` scripts (`:28-32`, each wrapped in
  `scripts/timed-suite.mjs <name> vitest run ...`), `test:budgets` (`:33`),
  `lint:tickets` (`:34`), `typecheck` (`:36`, `tsc --noEmit`). No `lint` script
  exists in `package.json` today — `SANITY_STEPS` in `src/preship.ts:25-28`
  and `PRE_QA_GATE_IDS` in `src/base-gates.ts:12` both name a `"lint"` step,
  but `projectSanityGateDeclarations` (`src/base-gates.ts:15-32`) sets
  `required: step != null` — since AFK's own `package.json` has no `lint`
  script, its own `lint` gate declares with `required: false` and no command,
  landing on `classifyDeclaration`'s `"undeclared"` branch
  (`src/gate-runner.ts:388`), which records `SKIPPED` (`:531-533`) when
  `required` is false.
- FACT: CLAUDE.md (this worktree's own project instructions) already documents
  the "where a new assertion goes" ladder (unit test → existing spawned
  scenario's `it` → new slice in an existing wave fixture → new spawn) and
  states `pnpm test:ratchet` is "deliberately not part of `pnpm test`... run it
  when you add a spawned scenario." Any new tests this slice's generator adds
  for cache/prerequisite/skip-detector behavior should follow this ladder —
  most of gate-policy.ts, base-gates.ts, gate-runner.ts logic is unit-testable
  without spawning a pipeline.
- FACT: `GateAcceptanceMatcher` today has exactly one implemented value,
  `"vitest-json"` (`src/gate-policy.ts:34`, `ACCEPTANCE_MATCHERS`). This is
  unrelated to the skip detector but shows the existing single-matcher pattern
  a project-declared cost/skip config would follow (declared, validated
  against a known set, refused otherwise).
- FACT: `matchesGlob`/`assertGlobDialect` (`src/gate-policy.ts:194-285`)
  already implement the "D6 dialect" glob matcher (literal segments, `*`
  within a segment, `**` across segments, case-sensitive) used for
  `protectedPaths.testGlobs`. The anchors file states the skip detector's
  `skipDetectors[].testGlobs` reuses this same matcher — confirmed structurally
  compatible (same string-array-of-globs shape as `testGlobs` already parsed
  by `parseProtectedPaths`, `:287-329`).
- FACT: `requireKnownKeys`/`requireExactKeys` (`src/gate-policy.ts:127-166`)
  are the two validation helpers already used for `protectedPaths` and
  `acceptance`. A new `cost` member's sub-shape (`cheapThresholdMs`,
  `environmentSensitive`, `cacheEnabled`, `relatedTests`, `skipDetectors`) will
  need parser functions following the same pattern (see `parseProtectedPaths`,
  `parseAcceptance` as templates), and `parseGatePolicy` (`:415-446`) is the
  one place that assembles the returned `GatePolicy`.
- FACT: `GateRiskClass` (`src/gate-policy.ts:71`) is `"gate-policy" |
  "deleted-test" | "skipped-test"` — a `"skipped-test"` risk class already
  exists, which is the class a skip-detector FAIL would presumably be
  associated with for waiver purposes (owned by #193, not this slice, per the
  issue).
- FACT: The `afk-manifest.ts`/`migration-claims.ts` split (ARCHITECTURE.md
  table) is the existing precedent for "manifest reader vs. claims reader" —
  relevant only as the analogous precedent the issue cites when it says
  waiver **authorization** (in `src/afk-manifest.ts`'s
  `protectedChangeWaivers` reader, per #193) is out of scope and "do not build
  a second waiver reader."
- INFERENCE: Because `runGates` already writes one `GateEvidence` per attempt
  and `runCandidateGatePhase`/`runPostQAGates` each call it fresh per phase,
  tree-identity caching (D17) most likely needs to intercept *before*
  `runGates` builds its `declarations` array (or wrap `classifyDeclaration`'s
  command path) — the cache key is "gate ID + resolved command/args + tree ID"
  per the issue, which are all known before a gate is spawned. Drawn from:
  `src/gate-runner.ts:392-513` (declarations loop) and the issue's D17 cache
  key description.

## Unknowns

- UNKNOWN: Whether `expectedCostMs` values for AFK's own three base gates
  (`typecheck`, `lint`, `tests`) should be hardcoded constants in
  `src/base-gates.ts` or derived/measured — the anchors file says
  "`expectedCostMs`... [is] code in `src/base-gates.ts`, not config" but does
  not give concrete millisecond figures for AFK's own gates.
- UNKNOWN: The exact shape/location of the `gate-cache.json` cache-entry
  schema (fields beyond the stated key of gate ID + resolved command/args +
  tree ID) — no prior art in this repo for a persisted gate-level cache file
  format to model it on.
- UNKNOWN: Whether the `environmentSensitive` advisory run-summary block
  should be a single new `## ` section listing all environment-sensitive gate
  results across the run, or per-slice sub-sections nested under an existing
  section (`src/logger.ts` has no nesting precedent to follow either way).
- UNKNOWN: How "cheap prerequisites, so an expensive gate does not run after a
  failed prerequisite... independent failures still arrive together" (D16/D17)
  should be represented in `GateDeclaration` or `RunGatesOptions` — whether as
  a new field naming a prerequisite gate ID, an ordering/grouping wrapper
  around today's flat array, or logic layered above `runGates` in
  `candidate-gate-phase.ts`/`post-qa-gates.ts`. No existing field or pattern in
  `src/gate-runner.ts` represents inter-gate dependencies today.
- UNKNOWN: Whether #195 (file-scope gate, in-process `GateDeclaration.run`
  seam owner) has landed in this branch's history — this context was built
  from `src/scope-gate.ts` as it exists now (a file-scope gate keyed on
  `fileScope`/`outOfScopeChangedPaths`, not yet named `SKIP_GATE_ID` or similar
  for a skip detector), and the issue states #195 is a separate, still-pending
  dependency for the skip-detection gate specifically.

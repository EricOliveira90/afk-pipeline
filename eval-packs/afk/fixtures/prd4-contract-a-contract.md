# Slice Contract — Behavior coverage gate

**Parent PRD:** .kiro/specs/afk-v2-acceptance-scope-gates/prd.md
**GH issue:** #85
**Status:** LOCKED

**Lock-Provenance:** negotiation round 2

## Scope lock

Every behavior ID a locked manifest binds to the acceptance gate is proved by a
real test run before the slice reaches behavioral evaluation. New module
`src/acceptance-gate.ts` decides from the runner's JSON alone, never from prose,
through D22's in-process `GateDeclaration.run` seam rather than an exit code
(`prd.md`; #85 blocked by #195), and joins the pre-QA set.

### In scope

- [behavior:B-01] `src/gate-policy.ts` adds `acceptance` to `POLICY_KEYS`, parsed
  as an exact-key object of `command` (non-blank string), `args` (non-empty array
  of non-blank strings) and `matcher`, exposed as optional `GatePolicy.acceptance`,
  with three refusals naming the offender: a non-object, missing, unknown or blank
  member; `args` with no literal `{behaviorId}` token; a `matcher` other than
  `"vitest-json"` (#85 AC4; D1, D8, `anchors/02-behavior-coverage-gate.md`).
  `{behaviorId}` is literal, not the D6 glob dialect.
- [behavior:B-02] `src/base-gates.ts` resolves the acceptance plan in one order: a
  declared `gatePolicy.acceptance` wins and needs no `tests` script; the derived
  baseline — `pnpm` with args `["exec","vitest","run","--reporter=json",
  "--testNamePattern","{behaviorId}"]`, matcher `vitest-json` — applies only when
  that member is absent and `resolveSanityPlan` (ADR 0012's single plan source)
  yields a `tests` step; with neither there is no plan. The same module exports the
  lock-time bindable catalog: the three base declarations plus
  `{ id: "acceptance:behaviors", command, args }` from whichever plan resolved, no
  entry when none did, reading the policy itself through `loadGatePolicy(cwd)`
  (`src/gate-policy.ts:325`). All six `resolveBaseGateDeclarations(...)` sites in
  `src/orchestrator.ts` call that catalog, so
  `validateAcceptanceManifestBindings` (`src/acceptance-manifest.ts:360-392`)
  accepts the binding under either source, still refuses an ID the catalog does not
  declare, and `formatBaseGateCatalog` shows the planner the ID with its command
  (#85 AC8, AC9).
- [behavior:B-03] `src/acceptance-gate.ts` exports the `vitest-json` matcher as a
  pure function over an already-parsed reporter document (Testing decision 1):
  matched is `numPassedTests + numFailedTests`; matched `0` is untested,
  `numFailedTests > 0` is failed, PASS is matched `>= 1` with
  `numFailedTests === 0`, so a skipped- or todo-only match is not covered
  (#85 AC3). Recorded decision: `numTotalTests`, which D8 and `anchors/02` name as
  the match count, is not one — in this tree's vitest 3.2.4 a filtered run leaves
  every non-matching test collected and counted there as skipped
  (`@vitest/runner`'s `interpretTaskModes`; the reporter counts only `pass`/`fail`
  into `numPassedTests`/`numFailedTests`), so it never reaches `0` and both D8
  verdicts would be unreachable. The rule above keeps D8's semantics and refines
  only the field read. The document is parsed from stdout, where the reporter logs
  it as one `JSON.stringify` line absent an output file.
- [behavior:B-04] `src/acceptance-gate.ts` exports one declaration builder
  returning `{ id: "acceptance:behaviors", stage: "acceptance", required: true,
  run }` — D8's ID, one aggregate, never one per behavior — and nothing when the
  locked manifest binds no behavior to it. `run` reads that manifest at call time,
  substitutes each bound ID into every `{behaviorId}` occurrence of B-02's plan and
  runs it once per behavior in `ctx.cwd`, honouring `ctx.signal` (ADR 0003) by
  stopping the loop and never reporting PASS from a partial one.
- [behavior:B-05] PASS only when every bound behavior passes; otherwise one
  `FAIL`/`COMMAND` whose `detail` names every failing ID with its
  matched/passed/failed counts and its untested-versus-failed reason (#85 AC1, AC2,
  AC5). A no-match run is that untested FAIL, not a configuration error, since it
  still emits a document (B-03); `FAIL`/`CONFIGURATION` naming the ID and matcher
  covers only an unsupported matcher and stdout with no reporter document (#85 AC4;
  ADR 0041). An unreadable manifest throws, which `runGates` records as
  INFRASTRUCTURE. A manifest binding nothing is PASS saying so (a required SKIPPED
  would block evaluation).
- [behavior:B-06] `src/orchestrator.ts` appends the declaration to
  `preQaDeclarations` (`:5523`) at one call site, so a red set takes the existing
  pre-QA repair path with every failing ID in one `generatorFailureSet` and
  dispatches no evaluator, and a green set passes
  `assertGateEvidenceReleasesEvaluation` (#85 AC1, AC5, AC7; D19). That site
  materializes the checkpoint and runs the `prepare` install when the declaration
  is present — by B-04 at least one bound behavior — so the two predicates at
  `:5526-5535`, today asking only whether a declaration carries a `command`, widen
  on bound work, never on plan presence. `src/gate-runner.ts` gains the shared ID
  and stage literals; `src/run-events.ts` gains a per-behavior coverage event
  (behavior, gate and tree IDs, status, counts, evidence and log artifact IDs)
  emitted once per behavior per gate attempt; `src/logger.ts` renders it as this
  slice's own `run-summary.md` section beside `## Base Gates` (#85 AC6).
- [behavior:B-07] `afk.config.json` declares `gatePolicy.acceptance` with the
  anchors file's shape, making B-02's declared branch this repo's live one;
  `ARCHITECTURE.md`'s Gates row names `src/acceptance-gate.ts`.

### Non-goals (explicit out-of-scope)

- No cost control: no cache, `expectedCostMs`, related-test selection,
  `environmentSensitive` gate or `gatePolicy.cost` (#86; D16-D18).
- No new `GateFindings` member and no `GATE_EVIDENCE_VERSION` bump; the manifest
  stays version 2 (D13, D22).
- No prompt or agent-file edits, so which behavior a planner binds, and the rubric
  judging it, stay other slices'.
- No scope gate, feedback-integrity gate, post-QA gate set, waiver reader,
  `escalation.md` v2, second matcher, or verdict decided after `runGates` returns
  (#195, #193, D7, `prd.md`).

### Existing behavior to preserve

- [behavior:P-01] `src/gate-policy.ts` keeps every existing refusal and default —
  `cost` and typos still unknown, `version` still `1`, `protectedPaths` and
  `riskClasses` still defaulting, the D6 dialect and the six pinned exports
  unchanged. The three resolvers keep their signatures and still yield exactly
  `typecheck`, `lint`, `tests` with `required: step != null` and no
  `command` when the script is absent. The acceptance entry lives only in the new
  bindable catalog, so `src/adopt-command.ts:582` — which still counts a scriptless
  gate's `SKIPPED` as passing — the wave and orchestrator fixtures and
  `src/gate-runner.test.ts` need no edit.
- [behavior:P-02] No persisted schema changes: `GATE_EVIDENCE_VERSION` stays 2,
  `GateFindings` keeps its four members, `classifyDeclaration` its exactly-one-of
  rule (so the catalog entry carries `command` and the declaration `run`), the
  in-process branch its semantics; the manifest stays version 2 and
  `validateAcceptanceManifestBindings` keeps its signature and refusal message —
  only the catalog handed to it grows, whose entry `command` is the runner the gate
  spawns, so `nonExecutable` keeps its meaning.
- [behavior:P-03] The pre-QA repair path and its neighbours keep their shape:
  `collectRequiredGateFailures`, the `generatorFailureSet` records, the
  exhausted-round intervention, the positional release check and the bounded
  INFRASTRUCTURE retry, with `src/candidate-gate-phase.ts` unedited (D22);
  `run-summary.md`'s existing sections and the `gate-outcome` shape, with no empty
  new section when no coverage event exists. A slice binding nothing appends no
  acceptance declaration, so its checkpoint materialization, `prepare` install and
  outcomes stay today's on every project — including one with a `tests` script but
  no `typecheck` or `lint` script.

### Changes to existing behavior (only if the issue asks for it)

- A candidate binding a behavior to `acceptance:behaviors` no longer reaches the
  candidate evaluator while that behavior is untested or red; it returns to the
  generator as a pre-QA gate failure (#85 AC1, AC5; D19).
- `src/gate-policy.test.ts`'s `acceptance: {}` case now refuses for a missing
  required member instead of an unknown key (#85, D1).

## Files expected to change

- src/gate-policy.ts
- src/gate-policy.test.ts
- src/base-gates.ts
- src/acceptance-gate.ts
- src/acceptance-gate.test.ts
- src/gate-runner.ts
- src/acceptance-manifest.ts
- src/orchestrator.ts
- src/orchestrator.test.ts
- src/run-events.ts
- src/logger.ts
- src/logger.test.ts
- afk.config.json
- ARCHITECTURE.md

## Migration requirements

- New migration files: 0

## New patterns / deps / schema (if any)

- First runner-output matcher in `src/`; first non-test caller of `loadGatePolicy`;
  one new run-event member; no dependency.

## Test plan

The manifest's `observableResult` per behavior is the test list; P-01…P-03 are the
named existing assertions, run unchanged. B-03's fixtures are documents transcribed
verbatim from three real filtered runs recorded once while implementing and pasted
into `src/acceptance-gate.test.ts`, so the suite spawns no vitest; the only spawned
assertion is one `it` on an existing scenario's shared pre-QA evidence (AGENTS.md
ladder).

## Definition of done

- [ ] B-01…B-06 hold as stated, with the manifest's `observableResult` tests
      written and passing.
- [ ] Every P-01…P-03 statement holds, with the named existing assertions passing.
- [ ] `afk.config.json` carries the declared member; `ARCHITECTURE.md`'s Gates row
      names `src/acceptance-gate.ts` and the file stays inside its 150-line cap.
- [ ] `pnpm typecheck && pnpm test:fast` pass, plus the `orchestrator` heavy suite
      (CLAUDE.md's slice-agent loop).

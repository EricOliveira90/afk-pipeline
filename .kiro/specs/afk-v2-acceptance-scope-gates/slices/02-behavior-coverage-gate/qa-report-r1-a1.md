# QA Report

**Verdict:** PASS
**Failure class:** NONE

Deterministic slice QA against `contract.md` (`Status: LOCKED`, negotiation
round 2). Canonical verdict: `qa-review.json`.

## Pass 1: Functional Correctness
- Pre-QA commands: PASS
- UAT verification: NOT IN SCOPE
- Boundary compliance: PASS
- Preservation check: PASS

### Pre-QA commands

- `pnpm install --frozen-lockfile` — **PASS**, run in this checkout (exit 0,
  6s; `prepare` compiled `tsconfig.build.json` cleanly). The only warning is
  the pre-existing `Ignored build scripts: esbuild@…` notice.
- `pnpm run typecheck` — **PASS**, cited under the skip authorization rather
  than re-run. Evidence artifact
  `.afk/logs/afk-v2-acceptance-scope-gates-claude-code/run-20260909-163009/gates/s02/attempt-f9eaa1931b4f.json`,
  gate attempt `f9eaa193-1b4f-4875-b87c-bc813e3dd250`, Git tree
  `67c80991f962a14ed5ef1bbc49431238e031b7ae`, PASS at 2026-09-09T21:26:02.716Z
  (10.8s). No file under review was modified during this QA stage, so the
  authorization stands.

Per the assigned scope I did not run the project's test suites; the
orchestrator runs them on the authorized tree after this stage.

### Behavior verification

Verified by reading the shipped source against each locked behavior, and by
reading the assertions that pin it.

- **B-01** — `src/gate-policy.ts:44-49` adds `"acceptance"` to `POLICY_KEYS`;
  `parseAcceptance` (`:349-405`) refuses a non-object, refuses via the new
  `requireExactKeys` (`:151-171`) for a missing or unknown sub-member, refuses a
  blank `command` and (through the existing `parseStringArray`, `:168-186`) an
  empty `args` or a blank entry, refuses `args` with no literal
  `{behaviorId}`, and refuses a matcher outside `ACCEPTANCE_MATCHERS`. Every
  message names the offender. `GatePolicy.acceptance` is optional and omission
  stays omission rather than an explicit `undefined` (`:437-444`) — asserted at
  `src/gate-policy.test.ts:206-227`. The token is literal, not the D6 dialect:
  `parseAcceptance` runs no `assertGlobDialect`, and
  `src/gate-policy.test.ts:308-320` accepts `--testNamePattern=^{behaviorId}$`.
- **B-02** — `src/base-gates.ts:resolveAcceptancePlan` (`:106-124`) resolves in
  the stated order: declared wins with no `tests` requirement, else the derived
  baseline only when `resolveSanityPlan` yields a `tests` step, else `null`. A
  malformed policy throws rather than degrading (`src/acceptance-gate.test.ts:223`).
  `resolveBindableGateCatalog` (`:146-159`) is the three base declarations plus
  `{ id, command, args }` from whichever plan resolved, and reads the policy
  through `loadGatePolicy(cwd)`. All six `resolveBaseGateDeclarations(...)` sites
  in `src/orchestrator.ts` now call the catalog — I confirmed zero remaining
  occurrences of the old call in that file.
  `validateAcceptanceManifestBindings` needed no edit: its parameter is already
  the structural `readonly { id: string; command?: string }[]`
  (`src/acceptance-manifest.ts:362`), so `BindableGate[]` is accepted and
  `nonExecutable` still means "no command". `formatBaseGateCatalog`
  (`src/orchestrator.ts:395-404`) prints the id with its command.
- **B-03** — `matchVitestJson` (`src/acceptance-gate.ts:71-95`) is pure over an
  already-parsed document: `matched = numPassedTests + numFailedTests`, `0` is
  `untested`, `failed > 0` is `failed`, otherwise `covered`; `null` for anything
  that is not a reporter document. The recorded refinement away from
  `numTotalTests` is implemented and is the point of
  `src/acceptance-gate.test.ts:331-357`, whose fixtures carry the real
  `numTotalTests: 18 / numPendingTests: 18` pair from a zero-match run.
  `readReporterDocument` (`:106-121`) scans last-line-first and retries from the
  first `{`.
- **B-04** — `acceptanceGateDeclaration` (`:350-366`) returns
  `{ id: "acceptance:behaviors", stage: "acceptance", required: true, run }`, one
  aggregate, and `undefined` when the manifest binds nothing (also for an absent,
  v1 or unreadable manifest). `run` re-reads the manifest, substitutes into
  *every* token occurrence via `split(...).join(...)` (`:281`), runs once per
  behavior in `ctx.cwd`, and checks `ctx.signal?.aborted` per iteration,
  returning INFRASTRUCTURE naming the first id that never ran rather than a
  partial PASS.
- **B-05** — PASS only when every record is `covered` (`:311-320`); otherwise one
  `FAIL`/`COMMAND` whose detail carries each failing id with
  `(matched N, passed N, failed N)` and splits untested from failed
  (`:321-337`). A no-match run is that untested COMMAND failure, not a
  configuration error. `FAIL`/`CONFIGURATION` names the ids and the matcher for
  an unsupported matcher (`:252-261`) and for output with no reporter document
  (`:294-310`). An unreadable manifest throws, which `src/gate-runner.ts:619-622`
  records as INFRASTRUCTURE with `failureKind: null`. A manifest binding nothing
  is PASS saying so (`:227-238`). The third CONFIGURATION case — behaviors bound
  but no plan resolved (`:239-251`) — is a case the contract left unstated and
  the handoff records as deliberate widening; it is the right side of the choice,
  since the alternatives are a silent PASS or an omitted gate.
- **B-06** — `src/orchestrator.ts:5546-5556` appends the declaration to
  `preQaDeclarations` at one call site, and both the `prepare` and the
  materialization predicates now widen on `acceptanceDeclaration != null`, never
  on plan presence. The declaration is `required: true`, so a red set reaches
  `collectRequiredGateFailures` and the existing pre-QA repair path with every
  failing id in the one `detail`, and a green set satisfies
  `assertGateEvidenceReleasesEvaluation`; no code on that path was edited.
  `src/gate-runner.ts:43-51` holds `ACCEPTANCE_GATE_ID` and
  `ACCEPTANCE_GATE_STAGE`. `src/run-events.ts:160-185` adds `behavior-coverage`
  with behavior, gate and tree ids, status, the three counts, and both artifact
  ids; `src/orchestrator.ts:5617-5638` emits it once per behavior per gate
  attempt, draining the buffer with `.splice(0)` so a retried attempt cannot
  inherit the previous attempt's records. `src/logger.ts:350-375` renders
  `## Behavior Coverage` immediately after `## Base Gates`.
- **B-07** — `afk.config.json` declares `gatePolicy.acceptance` byte-for-byte in
  the anchors file's shape (`anchors/02-behavior-coverage-gate.md:13-22`), and
  `ARCHITECTURE.md`'s Gates row now names `src/acceptance-gate.ts`.
  `ARCHITECTURE.md` is 61 lines, inside its 150-line cap.

### Boundary compliance

Thirteen files changed against `HEAD~3`; every one is on the contract's declared
list. `src/acceptance-manifest.ts` is declared but unchanged, which is correct —
its structural parameter type already accepted the widened catalog. Migration
files: 0, as declared. The only untracked path is this slice's own artifact
directory. No `SCOPE_AMENDMENT` is needed.

### Preservation check

- **P-01** — `src/gate-policy.ts` still exports exactly six runtime names; the
  `Object.keys(gatePolicyModule).sort()` assertion is untouched and every new
  name is a type, an interface, or module-private. `cost` and typos are still
  unknown, `version` is still `!== 1` fatal, `protectedPaths` and `riskClasses`
  still default, and no case-folding call entered the module. The three
  resolvers keep their signatures and still yield exactly `typecheck`, `lint`,
  `tests` with `required: step != null` and no `command` when the script is
  absent (`src/acceptance-gate.test.ts:298-327`). The acceptance entry exists
  only in the new catalog, so `src/adopt-command.ts:582`, the wave and
  orchestrator fixtures, and `src/gate-runner.test.ts` are unedited.
- **P-02** — `GATE_EVIDENCE_VERSION` is still 2, `GateFindings` still has four
  members, `classifyDeclaration` is untouched and the declaration carries `run`
  with no `command` (`src/acceptance-gate.test.ts:399-402`). The manifest stays
  version 2, and `validateAcceptanceManifestBindings` keeps its signature and
  its refusal message; only the catalog handed to it grew.
- **P-03** — `src/candidate-gate-phase.ts` is unedited: the coverage records
  reach `events.jsonl` through the orchestrator-owned buffer instead. The pre-QA
  repair path, `collectRequiredGateFailures`, the `generatorFailureSet` records,
  the exhausted-round intervention, the positional release check and the bounded
  INFRASTRUCTURE retry are all unedited. `run-summary.md` renders no empty
  section when no coverage event exists, and the byte-pinned tail
  (`…| ev-1 | log-1 |\n\n\nPre-ship sanity gate: N/A`) is preserved —
  `${coverageSection}` collapses to the empty string, so the surrounding
  template is unchanged. A slice binding nothing appends no declaration and both
  call-site predicates stay false, including for a project with a `tests` script
  but no `typecheck` or `lint` script (`src/orchestrator.test.ts:2425`,
  `:664-676`).

### Changes to existing behavior

Both declared changes landed and are the intended ones: a bound-and-red
candidate now returns to the generator as a pre-QA failure rather than reaching
the evaluator, and `src/gate-policy.test.ts`'s `acceptance: {}` case moved from
the unknown-key assertion to the new missing-member assertion, with a comment
recording why it moved rather than disappeared.

## Pass 2: Quality & Craft
- Convention compliance: PASS
- Code quality: PASS
- Test quality: NOTES

Naming, module layout and comment density match the surrounding gate modules.
The two-module `BEHAVIOR_ID_TOKEN` duplication is the right call given P-01's
export pin and the reader-must-not-import-the-gates constraint, and it is pinned
by a source-text assertion rather than left to drift. Error handling is
deliberate throughout: the build-time/run-time asymmetry on manifest reads, the
`splice(0)` drain, and the choice to decide from the document rather than the
exit code are each stated at the point of the decision with the reason. The
`unparsable` status is correctly kept distinct from "zero matches" rather than
collapsed into it.

Test quality is high — the transcribed reporter documents keep real
`numPendingTests` values so the fixtures themselves argue the `numTotalTests`
decision, and the negative cases (`{ success: true }`, `{ numPassedTests: "1" }`,
`NaN`) are the ones that matter. Two notes, both advisory, are recorded as
findings below.

## Resolved findings
- None. No findings were routed into this QA stage.

## Findings

### Finding 1 — Command outcome is discarded, so a timeout reads as a configuration failure
**Severity:** Minor
**Pass:** 2
**Evidence:** `src/acceptance-gate.ts:157-173` awaits `runBoundedCommand` and
returns only `{ output }`. `src/command-runtime.ts:99` *resolves* rather than
rejects for `SPAWN_ERROR`, `INACTIVITY_TIMEOUT` and `WALL_CLOCK_TIMEOUT`, so
those outcomes arrive at `src/acceptance-gate.ts:285` with no reporter document,
become `status: "unparsable"`, and fall into the `FAIL`/`CONFIGURATION` branch at
`:294-310` — which the pre-QA repair path hands to the generator.
**What the contract expected:** B-05 — "`FAIL`/`CONFIGURATION` naming the ID and
matcher covers only an unsupported matcher and stdout with no reporter document
(#85 AC4; ADR 0041)." ADR 0041's own decision
(`docs/adr/0041-…:76-77`) reads: "Everything else, including every non-`EXITED`
outcome (spawn error, inactivity and wall-clock timeouts, a signal kill that
leaves no exit code), stays INFRASTRUCTURE and the orchestrator's retry applies."
**What I observed:** The `outcome` discriminator is available and free, and the
module's comment at `:296-299` cites ADR 0041 while reaching the opposite
conclusion for the timeout subset. A 30-minute wall-clock kill, an inactivity
kill under machine load and `pnpm` missing from PATH are all reported
identically to a genuinely misconfigured runner, costing a repair round on a
detail the generator cannot act on. Advisory and not blocking: B-05's locked text
does name "stdout with no reporter document" as the CONFIGURATION case, so the
letter of the contract is met, and ADR 0041's measured asymmetry puts this on the
recoverable side — at most one round, versus a burned slice.

### Finding 2 — The B-06 call-site predicate test asserts on a copy of the predicates
**Severity:** Minor
**Pass:** 2
**Evidence:** `src/orchestrator.test.ts:627-635` defines a local
`decide(declaration)` that rebuilds `{ prepare, materialize }` from
`declaration != null || preQa.some(...)` — a hand copy of
`src/orchestrator.ts:5546-5556` — and every assertion in that `it` reads
`decide(...)`, never anything `src/orchestrator.ts` exports. Reverting the
production `preQaHasExecutable` to its pre-slice form leaves the suite green: the
only other B-06 coverage is the spawned `P-03` assertion at
`src/orchestrator.test.ts:2425`, which exercises a slice binding *nothing* — the
case in which both predicates are unchanged by definition.
**What the contract expected:** B-06 — "the two predicates at `:5526-5535`,
today asking only whether a declaration carries a `command`, widen on bound
work, never on plan presence."
**What I observed:** A mirror test. It states the rule clearly and it does guard
`acceptanceGateDeclaration`'s own return value, but it is not a regression guard
on the shipped call site; the two expressions can drift apart silently. Lifting
the pair into one named exported helper that both the call site and the test call
would close it.

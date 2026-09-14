# Context — Quality policy starter and stage record (#274)

## Files and current behavior

- FACT: The `GatePolicy` type and its parser live in `src/gate-policy.ts`, not
  `src/gate-runner.ts`. Top-level shape `GatePolicy` is defined at
  `src/gate-policy.ts:333-356`: `{ version: 1; protectedPaths;
  riskClasses: GateRiskClass[]; acceptance?; cost?; clean? }`.
- FACT: `GatePolicyClean` (`src/gate-policy.ts:322-331`) is
  `{ gates: GatePolicyCleanGate[]; additionalWriteScope: string[];
  suppressionDetectors: GatePolicySuppressionDetector[] }`.
  `GatePolicyCleanGate` (`src/gate-policy.ts:271-278`) is
  `{ id; command; args; required; expectedCostMs }`.
- FACT: `GatePolicyCost` is `src/gate-policy.ts:253-260`:
  `{ cheapThresholdMs; environmentSensitive; cacheEnabled; relatedTests?;
  skipDetectors }`.
- FACT: `GatePolicyProtectedPaths` is `src/gate-policy.ts:170-173`:
  `{ gatePolicyPaths: string[]; testGlobs: string[] }`.
- FACT: `GateRiskClass` has exactly four members — `"gate-policy"`,
  `"deleted-test"`, `"skipped-test"`, `"suppression"` — declared at
  `src/gate-policy.ts:141-151` and enumerated in
  `GATE_RISK_CLASSES` (`src/gate-policy.ts:154-159`). The issue's "all four
  `riskClasses`" refers to this closed set.
- FACT: `CHANGED_FILES_TOKEN = "{changedFiles}"` is defined at
  `src/gate-policy.ts:117`; a clean gate's `args` may contain it, and
  `cleanGateDeclarations` (`src/cleaner-stage.ts:266-296`) expands it against
  `input.changedFiles` (forward-slash paths, `src/cleaner-stage.ts:312-314`).
- FACT: `loadGatePolicy(repoRoot: string): GatePolicy | null`
  (`src/gate-policy.ts:1121-1130`) reads `afk.config.json`'s `gatePolicy`
  member; `parseGatePolicy` is exported at `src/gate-policy.ts:1070-1073`.
- FACT: Unknown top-level or nested keys are rejected —
  `requireKnownKeys` (`src/gate-policy.ts:364-380`, throws on unknown keys,
  defaults missing ones) and the stricter `requireExactKeys`
  (`src/gate-policy.ts:388-403`, also requires every listed key present, used
  for members with no defaults such as `acceptance`). Confirmed by
  `src/gate-policy.test.ts:207` (unknown top-level key throws) and `:606`
  (unknown key on `clean` throws).
- FACT: The repo's own `afk.config.json` (root, 27 lines) currently declares
  only `version`, `resourceKeys`, `architectureDoc`, and a `gatePolicy` with
  `protectedPaths`, `riskClasses`, and `acceptance` — **no `cost` and no
  `clean` member**. Acceptance criteria explicitly forbid editing this file
  ("`afk.config.json` at the repo root is not edited"), so the starter
  template is a separate file under `templates/`, not a change to this one.
- FACT: `templates/` currently contains only
  `templates/agents/architect-review.md` and
  `templates/agents/pm-review.md`. There is no `templates/quality-policy/`
  path yet.
- FACT: `package.json:38-42` `files` is
  `["dist", "prompts", "agents"]` — no `"templates"` entry. Per the issue,
  packaging `templates/quality-policy/afk.config.json` requires adding
  `"templates"` to this array, which per the issue is also what first makes
  `templates/` ship at all (so the packaged set becomes exactly the new
  policy template plus the two existing `templates/agents/*.md` files —
  nothing else may live under `templates/` once packaged, per the acceptance
  criterion "a fourth packaged template file fails the assertion").
- FACT: `docs/adr/0063-a-wall-clock-budget-cannot-fail-a-gate.md` rules a
  wall-clock budget "is never a finding against a slice"; the doc comment at
  `src/gate-policy.ts:268-269` says `expectedCostMs` is "budgeting and
  reporting only, never a pass/fail condition" per that ADR. INFERENCE: the
  starter template's `clean.gates[*].expectedCostMs` values are advisory
  metadata only and must not be wired to any pass/fail logic in the template
  or its docs.
- FACT: The comment at `src/gate-policy.ts:248-251` states `expectedCostMs`
  and gate prerequisites are deliberately absent from `GatePolicyCost`
  because "a consuming project does not author AFK's gate catalog" — those
  two fields live in AFK's own code (`GATE_EXPECTED_COST_MS`,
  `GATE_PREREQUISITE_IDS` at `src/base-gates.ts:71-77`), separate from the
  per-clean-gate `expectedCostMs` on `GatePolicyCleanGate` which *is*
  author-supplied policy. INFERENCE: these are two distinct `expectedCostMs`
  concepts at different layers; the template only ever authors the
  clean-gate-level one.
- FACT: `EVENTS_SCHEMA_VERSION = 1` at `src/run-events.ts:26`. The
  `RunEventPayload` union starts at `src/run-events.ts:31`; members include
  `"header"` (:32), `"run-started"` (:33-45), `"wave-dispatched"` (:46),
  `"wave-completed"` (:47), `"lanes-partitioned"` (:48-67), `"phase-started"`
  (:68-80), `"phase-ended"` (:81+). Comments at lines 244, 261, 302 document
  that additive new event-type members do not bump
  `EVENTS_SCHEMA_VERSION` — only breaking/renamed shapes do. This matches
  the issue's requirement that `EVENTS_SCHEMA_VERSION` stays 1.
- FACT: `RunEvent = RunEventPayload & {...}` (`src/run-events.ts:496`) adds
  common stamped fields (e.g. `ts`); `RunEvents` interface is at
  `src/run-events.ts:501`.
- FACT: The `run-started` event is emitted at `src/orchestrator.ts:8291-8303`
  via `logger.phase(...)`, described in a comment as the "First run.log
  line" (around line 8289). It is the very first `logger.phase` call in a
  run, before the wave loop begins (a cancellation-record comment follows
  around line 8304). INFERENCE: a new `quality-stage-policy` event "emitted
  immediately after run-started" belongs in this same block, right after the
  existing call, once per run (not once per slice/wave), reading `enabled`
  from the same `ctx.runGatePolicy` / `loadGatePolicy` snapshot already used
  elsewhere in the orchestrator (see below) rather than re-deriving it
  per-slice.
- FACT: `ctx.runGatePolicy?.clean` is read at `src/orchestrator.ts:7021-7025`
  when building cleaner-stage input, and
  `ctx.runGatePolicy?.clean?.additionalWriteScope` is read at
  `src/orchestrator.ts:6889`. INFERENCE: `ctx.runGatePolicy` (the run's one
  `loadGatePolicy` snapshot) is the existing single source of truth the new
  event's `enabled`/`gateIds` fields should read from, per the issue's
  instruction that `enabled` come from "the run's own `loadGatePolicy`
  snapshot and never from a worktree or a per-slice context."
- FACT: `CleanerStageInput.clean` doc at `src/cleaner-stage.ts:212-214` notes
  it may be `undefined` "for a run that declares none (P-01)".
  `cleanGateDeclarations({ gates, changedFiles })` at
  `src/cleaner-stage.ts:278-296` consumes `gates: readonly
  GatePolicyCleanGate[]` directly, i.e. `clean.gates`.
- FACT: `package.json` `files` and `README.md` are otherwise unmodified by
  this repo's cleaner-loop work to date (per #87's own separable-seam framing
  in the issue body, listing "`package.json` `files` and README section" as
  one of the two things split into this slice).

## Patterns and test harness

- FACT: `src/logger.ts` renders `run-summary.md` by filtering `runEvents` for
  a given `type` and emitting `""` when there are no matching events (so
  summaries without the new event type are unchanged), else a `##` heading
  plus a table. The closest analog is "Final Evaluation Reuse"
  (`src/logger.ts:585-611`):
  `const reuseEvents = runEvents.filter(event => event.type ===
  "final-evaluation-reuse"); const finalReuseSection = reuseEvents.length
  === 0 ? "" : \`## Final Evaluation Reuse\n...\`;`. "Applied Waivers"
  (`src/logger.ts:557-574`) is a second close analog. Existing rendered
  section headers found: `## Base Gates` (:415), `## Advisory Gates` (:427),
  `## Behavior Coverage` (:461), `## Candidate Review Isolation` (:491),
  `## Merge Resolution Rounds` (:509), `## Applied Waivers` (:561), `##
  Final Evaluation Reuse` (:596), `## Dependency Holds` (:624), `## Adopted
  Slices` (:639). File writes happen at `src/logger.ts:673` and `:677`.
  INFERENCE: the new `## Quality Stages` header should follow this same
  filter → `""` or heading idiom, but per the issue it must render "even
  when disabled" — unlike the existing analogs, which render nothing when
  their event list is empty, this new section is unconditional given the
  event exists exactly once per run.
- FACT: `src/gate-policy.test.ts` has a ticket-tagged describe-block
  convention already in use for #87: `describe("[behavior:#87:B-01]
  parseGatePolicy's clean member", ...)` at line 544. INFERENCE: new tests
  for this slice's template/parser assertions should follow the same
  `[behavior:#274:...]` tagging convention if this repo's test-tagging
  practice extends to this slice.
- FACT: `src/gate-policy.test.ts:764` `describe("loadGatePolicy", ...)` and
  lines 848, 874 assert directly against this repo's own `afk.config.json`
  shape via `loadGatePolicy(REPO_ROOT)`. Since the acceptance criteria forbid
  editing the root `afk.config.json`, these assertions are NOT expected to
  change for this slice (the new template lives under `templates/`, a
  separate file).
- FACT: `src/cleaner-stage.test.ts` builds `GatePolicyClean` fixtures via a
  helper `cleanPolicy(required = true): GatePolicyClean => ({...})` at lines
  132, 182, 454 — the existing pattern for constructing a valid `clean`
  fixture in tests.
- FACT: No `src/run-events.test.ts` file exists (glob search found none);
  event-emission and event-count assertions for existing event types are
  presumably in `src/orchestrator.test.ts`, `src/wave.test.ts`, or
  `src/logger.test.ts`. UNKNOWN: exact line numbers of any existing
  single-slice-run vs. wave-of-N-slices event-count assertion pattern to
  mirror for "exactly one `quality-stage-policy` event per run, never N."
- FACT: Per this repo's `CLAUDE.md` test-loop discipline, a new spawned
  pipeline scenario (e.g. a new orchestrator/wave integration test that
  spawns real git processes) is the last resort — prefer a unit test on
  `gate-policy.ts` parsing, then an `it` on an existing spawned scenario's
  shared result (single-slice run and existing two-slice wave fixtures
  likely already exist and can gain an assertion), before adding a new
  spawn.
- FACT: `pnpm test:fast` is unit + light integration; `pnpm test:heavy:*`
  covers named heavy suites (`orchestrator`, `wave`, `resume-integration`,
  `qa-orchestration`, `clean-failed`). INFERENCE: changes to
  `src/gate-policy.ts`, `src/run-events.ts`, `src/logger.ts`, and
  `src/orchestrator.ts` (event emission site) put this slice's test blast
  radius across `gate-policy.test.ts` (unit, fast), `logger.test.ts` (likely
  fast/light), and potentially `test:heavy:orchestrator` if the event-count
  assertion needs a real run/wave spawn.

## Unknowns

- UNKNOWN: Exact target line/section in `README.md` for "Quality policy
  starter" — candidates are near `## Setting up guardian reviews` (line 411)
  or `## Agent Configuration` (line 391), but no existing convention pins a
  "starter template" doc section to one of these.
- UNKNOWN: Whether `src/logger.test.ts` already has a section-count or
  section-content test for an analogous unconditional (always-rendered)
  header, versus the conditional (`reuseEvents.length === 0 ? "" : ...`)
  pattern used by every existing example found — the new `## Quality Stages`
  section must render in the disabled case too, which no cited existing
  section does.
- UNKNOWN: Which exact gate ids the issue's `clean.gates` list (format,
  lint, typecheck, changed-code coverage, complexity/CRAP, duplication,
  architecture-rule) should use — no existing gate-id catalog for these was
  located in this pass; `GATE_EXPECTED_COST_MS`/`GATE_PREREQUISITE_IDS`
  keys in `src/base-gates.ts:71-77` were not enumerated.
- UNKNOWN: The precise `protectedPaths.gatePolicyPaths` set the issue calls
  "the threshold-bearing files the feedback-integrity gate-policy rule
  relies on" — no `feedback-integrity` symbol or doc was located in this
  pass; needs a targeted grep before the template's `protectedPaths` can be
  written.
- UNKNOWN: Whether a second ADR beyond 0063 governs `environmentSensitive`
  or `cacheEnabled` semantics on `GatePolicyCost` — only ADR 0063 surfaced
  for `expectedCostMs`; no ADR specifically for the other cost fields was
  found in this pass.

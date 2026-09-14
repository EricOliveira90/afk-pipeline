# Slice Contract — Quality policy starter and stage record

**Parent PRD:** .kiro/specs/afk-v2-quality-loops/prd.md
**GH issue:** #274
**Status:** LOCKED

**Lock-Provenance:** negotiation round 2
**Negotiation round:** 2

## Scope lock

This slice ships #87's separable tail (PRD D14): two records the cleaner's
round loop never reads. First, the starter quality policy becomes a real
shipped file — `templates/quality-policy/afk.config.json`, parsed by the
production policy parser, carrying `protectedPaths`, all four `riskClasses`,
`acceptance`, `cost` and a `clean.gates` list for the seven named quality
checks — and `templates/` starts shipping at all via `package.json` `files`,
documented by a new `README.md` "Quality policy starter" section. Second, the
enable/disable fact becomes run evidence: exactly one additive
`quality-stage-policy` event per run, emitted immediately after `run-started`
from the run's own `loadGatePolicy` snapshot, and one `## Quality Stages`
header line in `run-summary.md` rendered from that event alone in both the
enabled and the disabled case. No cleaner behavior, no per-slice rows, no PR
section (PRD D10 items 2-rows and 3 are #97's).

### In scope

- [behavior:B-01] `templates/quality-policy/afk.config.json` exists as a
  complete `afk.config.json` and parses through the production parser
  (`parseGatePolicy` / `loadGatePolicy`, `src/gate-policy.ts:1070`, `:1121`)
  with no unknown top-level or nested member — its `gatePolicy` carries
  `version: 1`, `protectedPaths`, `riskClasses` holding all four members of
  `GATE_RISK_CLASSES` (`src/gate-policy.ts:154-159`), `acceptance`, `cost` and
  `clean` (GH #274 "What to build"; PRD D6). No `_note`-style comment member
  exists anywhere in the file: an unknown member refuses the launch
  (`requireKnownKeys` / `requireExactKeys`, `src/gate-policy.ts:364`, `:388`),
  so the tool-choice notes live in `README.md` instead (PRD D6).
  **Decision recorded here:** `protectedPaths` ships the two concrete arrays
  `gatePolicyPaths: ["afk.config.json", "suite-budgets.json"]` and
  `testGlobs: ["**/*.test.ts"]` — the shipped baselines
  `DEFAULT_GATE_POLICY_PATHS` (`src/gate-policy.ts:161-165`) and
  `DEFAULT_TEST_GLOBS` (`:167-168`) written out explicitly, so a consuming
  project sees the shape it must edit rather than inheriting a default it
  cannot see. `gatePolicyPaths` is the exact-path list the
  `feedback-integrity` gate's `gate-policy` risk class classifies a changed
  path against (`src/feedback-integrity-gate.ts:255`, `:265`); nothing is
  discovered during the slice, and the test asserts those two arrays
  element-for-element rather than only asserting that the member parses.
- [behavior:B-02] The template's `clean.gates` declares seven gates naming
  format, lint, typecheck, changed-code coverage, complexity/CRAP, duplication
  and architecture rules, each with `command`, `args`, an explicit `required`
  setting and `expectedCostMs`, and each carrying the literal
  `CHANGED_FILES_TOKEN` (`{changedFiles}`, `src/gate-policy.ts:117`) in `args`
  wherever the named tool accepts paths (GH #274; PRD D6). **Decision recorded
  here:** the gate ids are namespaced (`clean:format`, `clean:lint`,
  `clean:typecheck`, `clean:coverage-changed`, `clean:complexity`,
  `clean:duplication`, `clean:architecture`) because `RESERVED_GATE_IDS`
  (`src/gate-policy.ts:77-89`) already owns the bare `lint`, `tests` and
  `typecheck` ids and `parseCleanGate` (`:879`) refuses a collision — the
  issue names the checks, and the shipped parser names the id rule. Whether
  `expectedCostMs` can decide anything is not this behavior's claim — see the
  non-goals.
- [behavior:B-03] `package.json` `files` gains `"templates"`, which is what
  first makes `templates/` ship at all, and the packaged path set under
  `templates/` is asserted **as a whole set** — exactly
  `templates/quality-policy/afk.config.json`,
  `templates/agents/architect-review.md` and `templates/agents/pm-review.md`,
  so a fourth file under `templates/` fails the assertion (GH #274 AC2;
  PRD D6). `files` keeps its existing `"dist"`, `"prompts"` and `"agents"`
  entries.
- [behavior:B-04] `README.md` gains a "Quality policy starter" section that
  says how to copy `templates/quality-policy/afk.config.json` into a consuming
  project and states that declaring `gatePolicy.clean` is what turns the
  cleaner on (GH #274; PRD D6). It is a top-level `## Quality policy starter`
  heading and no existing section is rewritten. **Decision recorded here:**
  the section is placed immediately before `## Setting up guardian reviews`,
  beside the existing `### Templates` copy instructions
  (`README.md:447-456`) — but that placement is editorial and deliberately
  not gated: the obligation is the heading, the template path and the
  clean-enables-the-cleaner statement being present, so a later reader may
  move the section without failing this behavior.
- [behavior:B-05] `RunEventPayload` (`src/run-events.ts:31`) gains one
  additive member `{ type: "quality-stage-policy"; stage: "cleaner";
  enabled: boolean; gateIds: string[]; source: "afk.config.json" }`, and
  `EVENTS_SCHEMA_VERSION` stays `1` — an added event-type member is additive
  by the rule the file's own comments state (`src/run-events.ts:244`, `:261`,
  `:302`; PRD D10 item 1; GH #274 AC6).
- [behavior:B-06] `src/orchestrator.ts` emits exactly one
  `quality-stage-policy` event per run, immediately after the `run-started`
  emission at `src/orchestrator.ts:8291-8303` — one for a single-slice run and
  one for a wave of N slices, never N, and never per slice (GH #274; PRD D10
  item 1). **Decision recorded here:** the existing single run policy
  snapshot `const runGatePolicy = loadGatePolicy(repoRoot)`
  (`src/orchestrator.ts:8498`) is hoisted to sit immediately after that
  `run-started` emission and its one binding continues to feed every present
  reader; no second `loadGatePolicy` call is added, and the hoist keeps a
  malformed-policy refusal after the first `run.log` line, as today.
- [behavior:B-07] The emitted event's `enabled` is
  `runGatePolicy?.clean !== undefined` and its `gateIds` are that snapshot's
  `clean.gates` ids in declaration order (`[]` when disabled), read from the
  run's snapshot and never from a worktree, a candidate tree or a per-slice
  context (GH #274 "with `enabled` read from the run's own `loadGatePolicy`
  snapshot"; PRD D10 item 1; #251). **Decision recorded here:** that
  derivation is one pure exported helper in `src/run-events.ts` —
  `buildQualityStagePolicyEvent(policy: GatePolicy | null)` returning the
  B-05 payload — and B-06's single emission site calls it rather than
  computing the payload inline, because that is what gives both branches a
  declared, in-scope proof site. The `enabled: true` branch is proved by a
  unit test in `src/logger.test.ts` that feeds the helper the policy
  `parseGatePolicy` returns for the shipped
  `templates/quality-policy/afk.config.json` (B-01) and asserts
  `enabled: true` with B-02's seven gate ids in declaration order; the
  `enabled: false` branch is proved by the same unit test file with a
  `clean`-less policy and by `null`, and is corroborated in a real stream by
  B-06's `it`s on the two existing spawned scenarios. This is the AGENTS.md
  ladder's first rung and it is chosen over the alternatives on purpose: no
  new spawned scenario is added (so `pnpm test:ratchet` is not implicated),
  no spawned fixture repo gains a `gatePolicy.clean` `afk.config.json` — which
  would turn the cleaner on inside a scenario that exists to assert something
  else — and this repository's own `afk.config.json` stays unedited (P-01,
  non-goals).
- [behavior:B-08] `src/logger.ts` renders a `## Quality Stages` section in
  `run-summary.md` from the `quality-stage-policy` event alone, following the
  `## Final Evaluation Reuse` filter idiom (`src/logger.ts:589-611`), with one
  per-run header line naming the stage, enabled/disabled and the gate ids —
  rendered in the disabled case too, because a run that says nothing cannot be
  read as evidence of either state (GH #274 AC5; PRD D10 item 2).
  **Decision recorded here:** the section is present exactly when the run's
  event stream carries the event, so a historical stream that has none renders
  no section and its summary stays byte-identical; no per-slice row is
  rendered here (those are #97's).

### Non-goals (explicit out-of-scope)

- Any cleaner stage behavior: no rounds, no dispatch, no gating, no
  `src/cleaner-stage.ts` change (#87).
- The `## Quality Stages` per-slice rows, `readQualityStageOutcomes`, the
  `quality-stage-attempt` event family, and the draft-PR quality-stage section
  in `src/ship-gate.ts` (PRD D10 item 3, D11 — #97).
- Enabling the cleaner for this repository: no `gatePolicy.clean` is added to
  the root `afk.config.json` (PRD "Scope", D1).
- Any reader of the template's `expectedCostMs` values: this slice adds none,
  so they stay advisory budgeting metadata wired to no pass/fail condition —
  guaranteed by the absence of any new reader, not by an assertion (ADR 0063
  "a wall-clock budget cannot fail a gate"; `src/gate-policy.ts:268-269`).
- Any change to `RUN_STATE_VERSION`, `GATE_EVIDENCE_VERSION`,
  `EVENTS_SCHEMA_VERSION`, or any gate's pass/fail semantics.
- A CLI enable flag, and `afk status` rendering of quality stages (PRD D1,
  "Out of scope").

### Existing behavior to preserve

- [behavior:P-01] The repository's own `afk.config.json` is not edited: it
  keeps its three `riskClasses` and no `clean` member, so this repo's runs
  record the cleaner as disabled (GH #274 AC6; PRD "Scope", D5). Its existing
  assertions through `loadGatePolicy(REPO_ROOT)`
  (`src/gate-policy.test.ts:764`, `:848`, `:874`) keep passing unchanged.
- [behavior:P-02] `EVENTS_SCHEMA_VERSION` is `1` (`src/run-events.ts:26`) and
  every existing `RunEventPayload` member — `header`, `run-started`,
  `phase-started`, `phase-ended` and the rest — keeps its current shape and
  emission sites (GH #274 AC6).
- [behavior:P-03] `templates/agents/architect-review.md` and
  `templates/agents/pm-review.md` are unedited and stay reachable by the
  `README.md:447-456` copy instructions.
- [behavior:P-04] Every other `run-summary.md` section — `## Base Gates`
  (`src/logger.ts:415`), `## Advisory Gates` (`:427`), `## Behavior Coverage`
  (`:461`), `## Candidate Review Isolation` (`:491`), `## Merge Resolution
  Rounds` (`:509`), `## Applied Waivers` (`:561`), `## Final Evaluation Reuse`
  (`:596`), `## Dependency Holds` (`:624`), `## Adopted Slices` (`:639`) — and
  the summary's table, totals row and trailing lines render exactly as today,
  and both write sites (`src/logger.ts:673`, `:677`) are unchanged.
- [behavior:P-05] `loadGatePolicy` stays the one reader of
  `afk.config.json`'s `gatePolicy` and the run keeps exactly one policy
  snapshot: no gate or reader is handed a policy loaded from a candidate
  worktree (#251; `src/orchestrator.ts:6619-6627`, `:7021-7025`).

### Changes to existing behavior (only if the issue asks for it)

- `package.json` `files` gains `"templates"`, so a published package now
  contains `templates/` — authorized by GH #274 ("`package.json` `files` gains
  `"templates"`") and PRD D6.
- The run's `loadGatePolicy` snapshot is taken earlier in `runPipeline`
  (still once, still before any agent runs), so the new event can read it —
  the mechanical consequence of GH #274's "emitted immediately after
  `run-started`" with "`enabled` read from the run's own `loadGatePolicy`
  snapshot".

## Files expected to change
- templates/quality-policy/afk.config.json
- package.json
- README.md
- src/run-events.ts
- src/orchestrator.ts
- src/logger.ts
- src/gate-policy.test.ts
- src/logger.test.ts
- src/orchestrator-runs.test.ts
- src/wave.test.ts

## Migration requirements
- New migration files: 0

## New patterns / deps / schema (if any)
- New shipped file `templates/quality-policy/afk.config.json` — a starter
  config, not a code module; no new runtime dependency and no new parser.
- One additive `RunEventPayload` member (`quality-stage-policy`) at
  `EVENTS_SCHEMA_VERSION` 1 — the additive-member precedent this file already
  documents; otherwise existing patterns.
- One pure exported helper beside it, `buildQualityStagePolicyEvent`
  (B-07) — a payload builder, not a new seam: it has exactly one caller
  (B-06's emission site) and reads only the policy snapshot handed to it.

## Test plan
- Given `templates/quality-policy/afk.config.json`, when it is read and passed
  to `parseGatePolicy`, then it parses without throwing and the parsed policy
  carries `protectedPaths` — with `gatePolicyPaths` deep-equal to
  `["afk.config.json", "suite-budgets.json"]` and `testGlobs` deep-equal to
  `["**/*.test.ts"]` — all four `riskClasses`, `acceptance`, `cost` and
  `clean` (`src/gate-policy.test.ts`, unit, no git).
- Given the same file, when each `clean.gates` entry is inspected, then there
  are seven entries, every `id` is absent from AFK's reserved ids and
  collision-free, every entry sets `required`, and every entry whose tool
  accepts paths carries `{changedFiles}` in `args`.
- Given the same file with any one member renamed to an unknown key in a
  fixture copy, when `parseGatePolicy` runs, then it throws naming that key —
  pinning that the shipped file's shape is the parser's, not prose.
- Given `package.json` and a recursive walk of `templates/`, when the packaged
  path set is computed, then `files` contains `"templates"` and the set equals
  exactly the three expected paths, so a fourth file fails.
- Given `README.md`, when it is read, then it carries a "Quality policy
  starter" section naming
  `templates/quality-policy/afk.config.json` and stating that
  `gatePolicy.clean` turns the cleaner on.
- Given a `runEvents` array holding one `quality-stage-policy` event with
  `enabled: true` and two gate ids, when `writeSummary` renders, then
  `run-summary.md` carries a `## Quality Stages` header line naming
  `cleaner`, `enabled` and both gate ids (`src/logger.test.ts`, unit).
- Given the same with `enabled: false` and `gateIds: []`, when `writeSummary`
  renders, then the `## Quality Stages` header line is still present and says
  `disabled`.
- Given a `runEvents` array with no `quality-stage-policy` event, when
  `writeSummary` renders, then no `## Quality Stages` section appears and the
  other sections are unchanged.
- Given an existing single-slice spawned run in `src/orchestrator-runs.test.ts`
  whose `events.jsonl` is already read by the shared scenario, when the stream
  is filtered, then it holds exactly one `quality-stage-policy` event, it is
  the line immediately after `run-started`, and it reads
  `{ stage: "cleaner", enabled: false, gateIds: [], source: "afk.config.json" }`
  for a fixture with no `gatePolicy.clean` — an `it` on the existing shared
  result, not a new spawn (AGENTS.md ladder; PRD Testing decisions 1 and 3).
- Given an existing two-slice wave scenario in `src/wave.test.ts`, when its
  `events.jsonl` is filtered, then it holds exactly one
  `quality-stage-policy` event, never one per slice — an `it` on the existing
  spawned scenario.
- Given the policy `parseGatePolicy` returns for the shipped
  `templates/quality-policy/afk.config.json`, when
  `buildQualityStagePolicyEvent` is called on it, then the payload reads
  `{ stage: "cleaner", enabled: true, source: "afk.config.json" }` with
  `gateIds` deep-equal to B-02's seven ids in declaration order — a unit test
  in `src/logger.test.ts`, which is where this slice's other
  `src/run-events.ts` pin already lives; no new spawn and no fixture
  `afk.config.json` (AGENTS.md ladder rung 1; B-07's recorded decision).
- Given a `clean`-less policy and `null`, when
  `buildQualityStagePolicyEvent` is called on each, then both payloads read
  `enabled: false` with `gateIds: []` (`src/logger.test.ts`, unit).
- Given the type pins, when `EVENTS_SCHEMA_VERSION` is asserted, then it is
  `1` (`src/logger.test.ts`).

## Definition of done
- [ ] `templates/quality-policy/afk.config.json` exists, parses through
      `parseGatePolicy` with no unknown member, and carries `protectedPaths`
      with `gatePolicyPaths` `["afk.config.json", "suite-budgets.json"]` and
      `testGlobs` `["**/*.test.ts"]`, four `riskClasses`, `acceptance`, `cost`
      and seven `clean.gates`.
- [ ] Every `clean.gates` id avoids `RESERVED_GATE_IDS`, sets `required`, and
      uses `{changedFiles}` wherever its tool accepts paths.
- [ ] `package.json` `files` contains `"templates"` and a whole-set assertion
      pins the three packaged paths under `templates/`.
- [ ] `README.md` carries the "Quality policy starter" section with the copy
      instruction and the "`clean` turns the cleaner on" statement.
- [ ] `RunEventPayload` carries the `quality-stage-policy` member and
      `EVENTS_SCHEMA_VERSION` is still `1`.
- [ ] A single-slice run and a two-slice wave each emit exactly one
      `quality-stage-policy` event, immediately after `run-started`, with
      `enabled` and `gateIds` matching the run's policy snapshot.
- [ ] `buildQualityStagePolicyEvent` is exported from `src/run-events.ts`, is
      the emission site's only payload source, and has a unit test for the
      `enabled: true` branch over the shipped template's parsed policy and for
      the `enabled: false` branch over a `clean`-less policy and `null`.
- [ ] `run-summary.md` renders the `## Quality Stages` header line in both the
      enabled and the disabled case, and no section when the event is absent.
- [ ] The root `afk.config.json` is unedited and every P-01…P-05 assertion
      still passes.
- [ ] Each behavior anchor is tagged in the test name that proves it, so
      `acceptance:behaviors` can select it.
- [ ] `pnpm run typecheck && pnpm test:fast`, plus
      `pnpm run test:heavy:orchestrator` and `pnpm run test:heavy:wave` (the
      suites this slice's spawned assertions live in), pass.

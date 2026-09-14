# QA Report

**Verdict:** PASS
**Failure class:** NONE

Slice 04 (#274) ships what the locked contract describes: the starter quality
policy as a real parsed file, `templates/` in the published package, the README
section, one additive `quality-stage-policy` event emitted once per run
immediately after `run-started` from the run's single `loadGatePolicy` snapshot,
and a `## Quality Stages` summary section rendered from that event alone in both
states. One advisory finding records a test-plan deviation the generator
disclosed; nothing blocks.

## Pass 1: Functional Correctness
- Pre-QA commands: PASS
- UAT verification: NOT IN SCOPE
- Boundary compliance: PASS
- Preservation check: PASS

### Commands
- `pnpm install --frozen-lockfile` — PASS (6.2s; its `prepare` hook ran
  `tsc -p tsconfig.build.json` clean).
- `pnpm run typecheck` — skipped under the orchestrator's skip authorization,
  citing gate attempt `0331f9ab-d3d5-41db-a69a-5bf74b6f9fef`, evidence artifact
  `.afk/logs/afk-v2-quality-loops-claude-code/run-20260913-055550/gates/s04/attempt-0331f9abd3d5.json`,
  Git tree `e13fb4f64cb4692ab7dea6556189889dbf7f961a`. No file under review was
  modified in this worktree, so the authorization holds.

### Probes (disposable worktree only)
- `pnpm vitest run src/gate-policy.test.ts src/logger.test.ts` → `Test Files 2
  passed (2) / Tests 110 passed (110)`, exit 0, 1.28s. Covers B-01…B-05, B-07,
  B-08.
- `pnpm vitest run src/orchestrator-runs.test.ts` → `Test Files 1 passed (1) /
  Tests 48 passed (48)`, exit 0, 324.95s. Covers B-06 and B-08 in a real
  spawned stream.
- `pnpm test:fast` → `Test Files 100 passed (100) / Tests 2294 passed (2294)`,
  exit 0, `[suite-time] fast: 163.3s`. Two `[vitest-worker]: Timeout calling
  "onTaskUpdate"` unhandled errors appeared; they are reporter-transport noise
  on a loaded host (the same noise slice 01's handoff records), no assertion
  failed and the run exited 0.

### Behavior checks
- **B-01** — `templates/quality-policy/afk.config.json` parses through
  `parseGatePolicy` *and* through `loadGatePolicy(TEMPLATE_DIR)` (the file is
  itself named `afk.config.json`). `protectedPaths.gatePolicyPaths` is
  `["afk.config.json", "suite-budgets.json"]` and `testGlobs` is
  `["**/*.test.ts"]`, asserted element-for-element and against
  `DEFAULT_GATE_POLICY_PATHS` / `DEFAULT_TEST_GLOBS`. All four
  `GATE_RISK_CLASSES` members, `acceptance`, `cost` and `clean` are present, and
  no `_note`-style or JSONC comment member exists (checked per line, since the
  globs legitimately contain `/*`). The renamed-member refusal is proved twice —
  top level (`riskClass`) and nested (`clean.gates[0].commands`).
- **B-02** — seven gates, ids `clean:format`, `clean:lint`, `clean:typecheck`,
  `clean:coverage-changed`, `clean:complexity`, `clean:duplication`,
  `clean:architecture`, asserted in declaration order. `required` and
  `expectedCostMs` are read from the raw JSON, not the parsed policy, so the
  assertion pins what the file declares rather than a parser default. The
  `{changedFiles}` check is an equality against the expectation
  (`carries === !WITHOUT_PATHS.has(gate.id)`), so it fails both on a missing
  token and on a spurious one; `clean:typecheck` is the documented exception and
  README.md states why. Reserved-id avoidance is proved live by mutating gate 1
  to bare `lint` and asserting the parser's refusal message.
- **B-03** — `package.json` `files` is `["dist", "prompts", "agents",
  "templates"]`, asserted as a whole array. The recursive walk of `templates/`
  is asserted as a whole sorted set; I confirmed the tree independently and it
  holds exactly the three expected files.
- **B-04** — the `## Quality policy starter` section is a pure insertion before
  `## Setting up guardian reviews`; no existing section is rewritten, and the
  `### Templates` copy instructions for both agent templates are asserted
  intact. Line endings are normalized before the heading assertion, so it is not
  an accidental EOL test.
- **B-05 / P-02** — one additive `RunEventPayload` member; `EVENTS_SCHEMA_VERSION`
  is still `1`, asserted, and no pre-existing member changed (diff is
  insertion-only). A typed payload literal is written through `RunJournal.event`
  and read back off `events.jsonl`.
- **B-06** — one emission site, `src/orchestrator.ts:8320`, on the line after
  the `run-started` `logger.phase(...)` block at `:8292-8304`, using
  `logger.event` so `run.log` stays byte-identical. `grep` confirms exactly one
  `type: "run-started"` production site and exactly one production caller of
  `buildQualityStagePolicyEvent`. The spawned four-slice scenario asserts
  `toHaveLength(1)` and `lines[2]` adjacency with
  `{ stage: "cleaner", enabled: false, gateIds: [], source: "afk.config.json" }`.
  See Finding 1 for the wave-side deviation.
- **B-07** — `buildQualityStagePolicyEvent` is pure and exported; tested against
  the shipped template's parsed policy (`enabled: true`, seven ids in
  declaration order), a `clean`-less policy, `null`, and a hand-built policy the
  parser never saw. Nothing in it touches the filesystem or a per-slice context.
- **B-08** — the section renders from the event alone, following the
  `## Final Evaluation Reuse` filter idiom, and is asserted enabled, disabled
  ("no gates declared") and absent. The disabled case is corroborated in the
  real spawned summary.

### Boundary compliance
Every non-artifact path this slice changed is declared: `README.md`,
`package.json`, `src/run-events.ts`, `src/orchestrator.ts`, `src/logger.ts`,
`src/gate-policy.test.ts`, `src/logger.test.ts`, `src/orchestrator-runs.test.ts`,
`src/wave.test.ts`, `templates/quality-policy/afk.config.json`. No migration
files (contract: 0). No scope amendment is needed. (The candidate's
`change-summary.json` artifact is not present in this worktree — `.afk/` does not
exist here — so the changed-path set was derived from
`git diff --stat 2000d05..HEAD`, the three `feat(#274)` commits plus the
candidate checkpoint.)

### Preservation
- **P-01** — root `afk.config.json` is absent from the diff; `git diff
  --name-only` over it and `suite-budgets.json` returns nothing. The repo-root
  `loadGatePolicy(REPO_ROOT)` assertions in `src/gate-policy.test.ts` pass.
- **P-03** — `templates/agents/architect-review.md` and
  `templates/agents/pm-review.md` are unedited and still named by the README
  copy instructions (asserted).
- **P-04** — every other summary section, the totals row and the trailing lines
  render as before: the new section is appended to the existing section
  concatenation and collapses to `""` when the event is absent; all 43
  `src/logger.test.ts` tests and the full fast suite are green.
- **P-05** — `loadGatePolicy` appears twice in `src/orchestrator.ts`: the single
  `runPipeline` snapshot (now at `:8315`, hoisted, still before any agent runs)
  and the pre-existing `:1213` fallback this slice did not touch. No reader is
  handed a candidate-worktree policy.

## Pass 2: Quality & Craft
- Convention compliance: PASS
- Code quality: NOTES
- Test quality: PASS

The new summary section copies the established `## Final Evaluation Reuse`
idiom, comments explain *why* rather than *what*, and the README notes carry the
tool-choice rationale the JSON cannot. Tests are substantive: raw-JSON reads
where the file's declaration is the claim, live parser refusals instead of
prose, whole-set equalities that fail on an extra file, and an exact-match
`{changedFiles}` check rather than a one-sided one.

One note, not a finding: `qualityStageSection` interpolates `event.gateIds`
into a Markdown bullet without the `inlineMarkdown` whitespace collapse the
neighbouring `## Applied Waivers` rows apply to their config-derived strings.
Gate ids are only validated as non-blank strings (`src/gate-policy.ts:873`), so
an operator id containing a newline would split the bullet. Cosmetic, in a
report file, from the operator's own config — worth a collapse next time this
function is touched, not worth a round.

## Resolved findings
- none (no findings were routed into this stage).

## Findings
### Finding 1 — The wave-side B-06 `it` asserts zero events, not the contracted exactly-one
**Severity:** Minor
**Pass:** 1
**Evidence:** `src/wave.test.ts:416-452`. The scenario calls `runWave({...})`
directly with a hand-built `RunJournal` (line 428) and ends with
`expect(readRunEvents(logger.runDir)?.events.filter((event) => event.type ===
"quality-stage-policy")).toEqual([])`. Because that stream has no `run-started`
line, a run-level event cannot appear there at all. The contracted assertion
lives instead at `src/orchestrator-runs.test.ts:2088-2107`, on the four-slice /
three-dispatched `runPipeline` scenario: `expect(stagePolicy).toHaveLength(1)`
plus `expect(lines[2]).toMatchObject({ type: "quality-stage-policy" })`, green
under `pnpm vitest run src/orchestrator-runs.test.ts` (48/48, exit 0).
**What the contract expected:** "Given an existing two-slice wave scenario in
`src/wave.test.ts`, when its `events.jsonl` is filtered, then it holds exactly
one `quality-stage-policy` event, never one per slice — an `it` on the existing
spawned scenario"; acceptance-manifest B-06: "an it on each existing spawned
scenario's shared events.jsonl asserts a length of 1 and the run-started
adjacency."
**What I observed:** The wave `it` asserts a length of 0, with the reason stated
in the test comment and in `handoff.md`. The contract's premise was wrong —
`src/wave.test.ts` is the per-slice layer and never runs `runPipeline` — and the
generator recorded that rather than manufacturing an event. B-06's substance
(one record per run, never N per slice) is genuinely proved: three slices
dispatched across two waves in one `runPipeline` stream yield exactly one event,
immediately after `run-started`, and the wave assertion guards the
regression where `runWave` starts emitting per slice. Advisory only: the
behavior is correct, `acceptance:behaviors` has a qualified passing B-06
assertion, and no source change is required to ship. What is stale is the
contract's test plan and the manifest's B-06 `observableResult`.

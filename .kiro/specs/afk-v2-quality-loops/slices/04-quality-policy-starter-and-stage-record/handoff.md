# Handoff — slice 04, quality policy starter and stage record (#274)

- New migration files: 0

## What shipped

- B-01: `templates/quality-policy/afk.config.json:gatePolicy`
- B-02: `templates/quality-policy/afk.config.json:gatePolicy.clean.gates`
- B-03: `package.json:files`
- B-04: `README.md:## Quality policy starter`
- B-05: `src/run-events.ts:RunEventPayload` (member `quality-stage-policy`)
- B-06: `src/orchestrator.ts:runPipeline` (`runGatePolicy` snapshot + `logger.event`)
- B-07: `src/run-events.ts:buildQualityStagePolicyEvent`
- B-08: `src/logger.ts:RunJournal.writeSummary` (`qualityStageSection`)
- P-01: root `afk.config.json` — not in the write scope, unedited
- P-02: `src/run-events.ts:EVENTS_SCHEMA_VERSION` (still `1`)
- P-03: `templates/agents/architect-review.md`, `templates/agents/pm-review.md` — unedited
- P-04: `src/logger.ts:RunJournal.writeSummary` (empty section when the event is absent)
- P-05: `src/orchestrator.ts:runPipeline` (one `loadGatePolicy` call site)

Tests: `src/gate-policy.test.ts` (B-01..B-04), `src/logger.test.ts` (B-05, B-07,
B-08), `src/orchestrator-runs.test.ts` (B-06, B-08 in a real stream),
`src/wave.test.ts` (B-06, the wave-side half).

## Decisions made during implementation

- The contract and the manifest place B-06's "exactly one event, never N" proof
  on "a two-slice wave scenario in `src/wave.test.ts`". `src/wave.test.ts` never
  calls `runPipeline` — it calls `runWave` with a directly-constructed
  `RunJournal`, so its stream has no `run-started` and structurally cannot hold
  a run-level event. Rather than escalate (no behavior, interface, data format
  or acceptance criterion changes), the proof was split: the count, the payload
  and the immediately-after-`run-started` position are asserted on the existing
  multi-slice `runPipeline` scenario `describe("one wave's event stream")` in
  `src/orchestrator-runs.test.ts` (four slices, three dispatched, two waves),
  and the existing two-slice `it("runs disjoint slices in parallel lanes")` in
  `src/wave.test.ts` asserts that `runWave`'s own stream carries zero such
  events — which is what forbids the count from scaling per slice. No new
  spawned scenario, so `pnpm test:ratchet` is not implicated.
- `clean:typecheck` is the one starter gate with no `{changedFiles}`: `tsc`
  given an explicit file list drops the project's `tsconfig.json` options, so
  passing changed files there would silently weaken the check. Every other gate
  takes paths and gets the token.
- Emission uses `logger.event(...)`, not `logger.phase(...)`: the record is
  machine-facing, and `event` leaves `run.log` byte-identical while still
  placing the line immediately after `run-started`.
- `buildQualityStagePolicyEvent` is unit-tested against the shipped template's
  parsed policy for the `enabled: true` branch. The alternative — proving that
  branch in a spawned stream — would mean giving a fixture repo (or this
  repository) a live `gatePolicy.clean`, which the PRD puts out of scope.
- `expectedCostMs` values in the starter are asserted as advisory metadata
  only; nothing reads them, per ADR 0063.

## Gotchas / learnings

- `loadGatePolicy(templates/quality-policy)` works directly on the template
  directory because the template file is itself named `afk.config.json` — that
  is why B-01 can assert the shipped bytes parse through the production loader,
  not only through `parseGatePolicy`.
- `RESERVED_GATE_IDS` is module-private to `src/gate-policy.ts`, so "the starter
  avoids reserved ids" is proved by the successful parse plus a fixture that
  renames one gate to bare `lint` and expects the refusal, rather than by
  importing the list.
- A "no JSONC comments" assertion cannot be `expect(source).not.toContain("/*")`:
  `**/*.test.ts` and the other globs legitimately contain `/*`. The check is
  per line, on the trimmed prefix, plus a strict `JSON.parse`.
- `README.md` is checked in with CRLF, so `toContain("\n## Heading\n")` fails
  unless the read normalizes line endings first.
- `RunJournal.writeSummary()` re-reads `events.jsonl` from the run directory
  rather than an in-memory list, so a summary assertion needs the event to have
  been written, and a stream without it renders no section at all.
- `pnpm test:fast` in a fresh worktree needs `pnpm install` first; the run also
  emits `[vitest-worker]: Timeout calling "onTaskUpdate"` unhandled errors that
  are worker RPC noise, unrelated to any assertion.

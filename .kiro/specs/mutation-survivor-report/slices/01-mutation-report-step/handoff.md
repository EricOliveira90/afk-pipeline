# Handoff — 01 Report-only mutation survivor step at the ship gate (#303)

## What shipped

- B-01: `src/cli-options.ts:parseCliOptions` (`mutationReport` flag), `src/cli-options.test.ts`
- B-02: `src/afk-manifest.ts:parseAfkManifest` (`normalizeMutationReport`), `src/afk-manifest.test.ts`
- B-03: `src/afk-manifest.ts:normalizeMutationReport` (named rejection reasons), `src/afk-manifest.test.ts`
- B-04: `src/afk-manifest.ts:parseAfkManifest` (member absent by default), `src/afk-manifest.test.ts`
- B-05: `src/afk-manifest.ts:trimUnclaimedMigrationPrefixes` (member preserved on rewrite), `src/afk-manifest.test.ts`
- B-06: `src/preflight.ts:refuseUndeclaredMutationReport`, `src/preflight.test.ts`
- B-07: `src/orchestrator.ts:runOrchestrator` (refusal call site), `src/mutation-report.test.ts`
- B-08: `src/mutation-report.ts:parseMutationReport` / `readMutationReport`, `src/mutation-report.test.ts`
- B-09: `src/mutation-report.ts:classifyMutationStep`, `src/mutation-report.test.ts`
- B-10: `src/mutation-report.ts:mutationEligibleSources` / `isMutationEligibleSource`, `src/mutation-report.test.ts`
- B-11: `src/mutation-report.ts:runMutationStep`, `src/ship-gate.ts:runShipGate`, `src/mutation-report.test.ts`, `src/ship-gate.test.ts`
- B-12: `src/mutation-report.ts:MUTATION_STEP_BOUND_MS` / `awaitMutationStepWithinBound`, `src/ship-gate.test.ts`
- B-13: `src/run-state.ts:recordMutationStepOutcome` / `adaptLoadedState`, `src/run-events.ts:RunEventPayload`, `src/run-state.test.ts`
- B-14: `src/mutation-report.ts:MUTATION_REPORT_HEADING` / `formatMutationReportLines`, `src/logger.ts:readMutationStepOutcome`, `src/logger.test.ts`
- B-15: `src/ship-gate.ts:buildPrCreationPlan` (mutation section in the draft body), `src/ship-gate.test.ts` (`the draft PR body's mutation section`)
- B-16: `src/ship-gate.ts:buildPrCreationPlan` (decision fields unchanged), `src/ship-gate.test.ts`
- B-17: `docs/adr/0071-report-only-mutation-survivor-step.md`, `ARCHITECTURE.md` (ship-path internals row), `src/mutation-report.test.ts`
- P-01: `src/ship-gate.ts:runShipGate` (no declaration, no step), `src/logger.test.ts`, `src/ship-gate.test.ts`
- P-02: `src/afk-manifest.ts:parseAfkManifest`, `src/afk-manifest.test.ts`
- P-03: `src/ship-gate.ts:runShipGate` (`abandonMutationStep`), `src/ship-gate.test.ts`
- P-04: `src/preflight.ts:formatPreflightReport`, `src/preflight.test.ts`
- P-05: `src/run-state.ts:adaptLoadedState`, `src/run-state.test.ts`, `src/eval-boundary.test.ts`

New migration files: 0

## Decisions made during implementation

- The bound lives in `src/mutation-report.ts` as a flat, non-configurable
  `MUTATION_STEP_BOUND_MS` (30 minutes). The contract left the number's home
  unstated; putting it beside the step keeps the CLI and the orchestrator free
  of a mutation knob, which the refusals in ADR 0071 rule out anyway.
- The step is reached through three injectable seams on `RunShipGateArgs` —
  `mutationRun`, `mutationScope`, `mutationNow`. No suite invokes a real
  mutation tool and no test waits on the real bound; the gate under test is
  still the real one on a real fixture repo.
- Termination is one binding: `() => quiesceWorktree(reviewDir)`. Nothing in
  this slice spawns its own kill path, so a mutation process is torn down by the
  same code every other worktree process is.
- B-15 gets its own named block rather than riding along inside B-11/B-12/B-16.
  It reads a hand-written `events.jsonl` through `readMutationStepOutcome` and
  asserts the plan body's list block equals `formatMutationReportLines`'s output
  character for character, at both plan sites — the ordinary one and the cap
  exit's — so "the PR renders the summary's derivation" is checked rather than
  described.
- The published text is one derivation. `readMutationStepOutcome(runDir)` reads
  this run's `events.jsonl` and both `run-summary.md` and the draft PR body
  render from it, so the stream, the summary and the PR cannot disagree.
- `RUN_STATE_VERSION` moved 6 -> 7 for the persisted record; `EVENTS_SCHEMA_VERSION`
  stays 1 because the run event is purely additive.
- A guardian rejection publishes nothing at all — no event, no state record, no
  PR — and rethrows the guardian's own reason, including when the termination
  itself fails. A failed quiesce is the worktree teardown's report to make;
  substituting it would lose why the run stopped.
- The ship gate has no `gate-outcome` event of its own, so B-11/B-16's "the gate
  ids are identical with the flag set and absent" is pinned as a projection over
  the teed `events.jsonl`: every payload carrying a `gateId`/`gateIds`, plus the
  `sanity` phase entries, which are this gate's whole gate-result surface. The
  two runs are compared set-for-set with `toEqual` rather than by asserting the
  absence of a named id, so any future gate the step grows — under any id — moves
  the projection and fails.
- The rejoin origin is pinned by a clock the *guardians* move rather than by a
  read-counting clock. `mutationNow` is read only twice per run (the origin, then
  the helper's deadline arithmetic), so a per-read clock returns the same first
  value wherever the capture sits; a clock the guardian invocations advance makes
  the pre-fork and post-fork instants two different numbers.

## Gotchas / learnings

- A `Symbol()` race sentinel widens to `symbol` through `Promise.race`, so
  `settled === BOUND_REACHED` does not narrow and the step arm's properties go
  missing under `tsc`. `undefined` is also a real step result (the abandonment
  return), so the arms are a discriminated `BoundRace` union instead.
- The shared `makeJournal()` fixture in `src/ship-gate.test.ts` records events on
  a mock and writes no `events.jsonl`. Anything asserting published text has to
  add the tee itself; the tee's own shape is pinned on the real `Logger` in
  `src/logger.test.ts`.
- `quiesceWorktree(dir)` short-circuits to `{observed: [], terminated: [], survivors: [], verified: true}`
  when nothing is registered inside `dir`, which makes a call-through `vi.mock`
  spy cheap and gives "no process was registered" a direct observable.
- The only guardian rejection `runGuardianReview` propagates rather than
  classifying is a throw before its internal try — e.g. from `journal.agentLog`.
  That is how P-03 drives the fork region's catch in both lane modes.
- `isMutationEligibleSource` treats any status starting with `D` as deleted, so
  a test asserting eligibility must use real `git diff --name-status` letters
  (`R100`, `C075`, `T`) rather than invented ones.
- `src/ship-gate.test.ts` imports no `beforeEach`; per-test spy state is cleared
  inline. `ARCHITECTURE.md` has a hard 150-line cap that its own assertion in
  `src/mutation-report.test.ts` enforces.
- The `acceptance:behaviors` gate reads behavior tags out of **test names** only.
  Asserting a behavior inside another behavior's test and citing it in a `// B-15:`
  comment proves nothing to the gate: every behavior needs `[behavior:#303:<ID>]`
  in an `it`/`describe` title of its own. Round 1 failed on exactly this — B-15's
  assertions all existed and passed, under other behaviors' names.
- `buildPrCreationPlan` joins its sections with a blank line and each section
  joins its own lines with a single newline, so
  `body.slice(body.indexOf(HEADING)).split("\n\n")[2]` is exactly the rendered
  list block. That makes a strict `toBe` against the formatter possible where a
  `toContain` sweep would not notice a second, divergent rendering.
- Do not append large TypeScript blocks to a file with a bash heredoc here —
  backticks and apostrophes in the content break the outer quoting. Write the
  content to a file with the editor tools instead.
- A control character written into a `.ts` file as a raw byte rather than as a
  JavaScript escape makes git classify the whole file as **binary**: no `git diff`,
  no `git grep` match, no `git blame`, no PR line-by-line review — silently, since
  the tests still pass. Round 2 shipped `src/mutation-report.test.ts` that way with
  a single raw NUL. Spell it as an escape — backslash, `u`, then four zeros —
  which is the identical runtime string, and after adding any odd byte check that
  `git diff --stat` reports a line count rather than `Bin`. Beware
  that a `\x00` typed into a shell heredoc or `printf` can itself land as a raw
  byte; `grep -c $'\x00'` is no help either — the pattern degenerates to empty and
  matches every line.
- Read a test's `filter` predicates before trusting them. Round 2's
  ARCHITECTURE.md cap assertion filtered with `(line) => line !== "" || true`,
  which is unconditionally true and drops nothing; the cap still held, but the
  predicate said the count excluded blank lines when it did not. `wc -l` counting
  is `lines.at(-1) === "" ? lines.length - 1 : lines.length` over
  `split("\n")` — a trailing newline closes the last line rather than opening an
  empty one.

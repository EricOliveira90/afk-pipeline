# Handoff — slice 02, behavior coverage gate (#85)

## What shipped

- B-01: `src/gate-policy.ts:parseAcceptance` (reached through
  `parseGatePolicy`), with `GatePolicyAcceptance`, `GateAcceptanceMatcher`,
  `ACCEPTANCE_KEYS`, `ACCEPTANCE_MATCHERS` and the private
  `BEHAVIOR_ID_TOKEN`; `POLICY_KEYS` gained `"acceptance"`.
- B-02: `src/base-gates.ts:resolveAcceptancePlan` and
  `src/base-gates.ts:resolveBindableGateCatalog`, with `AcceptancePlan`,
  `BindableGate`, the exported `BEHAVIOR_ID_TOKEN` and the private
  `DERIVED_ACCEPTANCE_ARGS`; `src/gate-runner.ts:ACCEPTANCE_GATE_ID` and
  `src/gate-runner.ts:ACCEPTANCE_GATE_STAGE` hold the two shared literals.
- B-03: `src/acceptance-gate.ts:matchVitestJson`, with
  `BehaviorCoverageStatus`, `BehaviorCoverageRecord` and the private
  `readReporterDocument`.
- B-04: `src/acceptance-gate.ts:acceptanceGateDeclaration`.
- B-05: `src/acceptance-gate.ts:runAcceptanceGate`, with the
  `AcceptanceRunner` seam and `boundedAcceptanceRunner`.
- B-06: the pre-QA wiring in `src/orchestrator.ts` (`acceptanceCoverage`
  buffer, `preQaDeclarations`, `preQaHasExecutable`, `checkpoint`, and the
  `behavior-coverage` emission in `onGateOutcome`);
  `src/run-events.ts`'s `behavior-coverage` member;
  `src/logger.ts:Logger.writeSummary`'s `coverageSection`.
- B-07: `afk.config.json`'s `gatePolicy.acceptance` member;
  `ARCHITECTURE.md` lists `src/acceptance-gate.ts` on the Gates row.
- New migration files: 0

## Decisions made during implementation

- **The gate reports its own status through D22's `run` seam, never a
  `command`.** `classifyExecution` derives a command gate's status from its
  exit code, and `vitest --testNamePattern <ID>` exits 0 when it matched
  nothing — the exact case the gate exists to catch. So the coverage verdict
  had to be computed in-process.
- **The match count is `numPassedTests + numFailedTests`, not
  `numTotalTests`.** On vitest 3.2.4 a filtered run still *collects* every
  test in the project and counts the non-matching ones in `numTotalTests`
  and `numPendingTests`. Reading `numTotalTests` would have reported every
  behavior as covered.
- **`BEHAVIOR_ID_TOKEN` is spelled in two modules, pinned by a test.**
  `src/gate-policy.ts` may gain no new runtime export (P-01 pins its six
  names) and the config reader must not import the gate modules it
  configures, so the token is declared privately there and exported from
  `src/base-gates.ts`; a source-text assertion in `src/gate-policy.test.ts`
  fails if the two spellings drift.
- **The catalog entry is a `BindableGate { id, command?, args? }`, not a
  `GateDeclaration`.** The acceptance gate has no `command` at run time, so
  minting a fake `stage`/`required` pair just to satisfy binding validation
  would have been decoration. `GateDeclaration[]` is structurally assignable
  to `BindableGate[]`, and `nonExecutable` keeps meaning "no command".
- **Coverage events reach `events.jsonl` without editing
  `src/candidate-gate-phase.ts`** (P-03 keeps that file untouched): the gate
  pushes records into an orchestrator-owned buffer through
  `onBehaviorResult`, and `onGateOutcome` drains it with `.splice(0)` once
  the enclosing outcome carries the attempt, tree and artifact IDs.
- **Build time tolerates a missing manifest; run time does not.**
  `acceptanceGateDeclaration` returns `undefined` for an absent, v1 or
  unreadable manifest, which is what keeps every existing project's gate set
  byte-identical. `runAcceptanceGate` re-reads the manifest and lets a read
  failure become INFRASTRUCTURE, because by then a bound manifest was
  already observed.
- **Widening, recorded deliberately:** when a slice binds behaviors but no
  acceptance plan resolves, the gate reports FAIL/CONFIGURATION naming the
  unrunnable IDs rather than omitting itself. Silence there would let a
  bound slice ship with zero coverage checking.
- **`afk.config.json` declares the plan explicitly** even though the derived
  baseline is currently identical, so the declared branch — not the
  derivation — is the one exercised whenever AFK runs on itself.

## Gotchas / learnings

- `--testNamePattern <ID>` is a **repo-global substring match**, so a
  behavior ID collides with identically named tests in other slices'
  suites. `-t "B-06"` in this repo matched three tests: the two added here
  plus the pre-existing `B-06 rejects an over-budget explorer prompt`. A
  matched-and-passing foreign test is enough to mark a behavior covered, so
  IDs are only as discriminating as they are unique across the whole repo.
- `resolveBindableGateCatalog` makes `src/orchestrator.ts` the first
  non-test caller of `loadGatePolicy`. A malformed `afk.config.json` in a
  slice worktree therefore now throws during prompt assembly, earlier than
  it used to.
- `runBoundedCommand` merges stdout and stderr into one `onOutput` stream,
  so the reporter document is not alone on the channel. `readReporterDocument`
  scans lines last-first and retries from the first `{` on a line, which is
  what makes it survive vitest's own banner and any stderr interleaving.
- The `run-summary.md` template is byte-pinned by a test
  (`src/logger.test.ts`): the trailing space in `Pre-ship sanity gate: ` is
  load-bearing, and inserting `${coverageSection}` next to it is easy to
  break.
- Reading the manifest twice (declaration build, then inside `run`) is
  intentional, not a leftover: a generator round can write or rewrite the
  manifest between prompt assembly and gate execution.

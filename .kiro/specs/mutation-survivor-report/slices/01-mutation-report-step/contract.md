# Slice Contract — Report-only mutation step at the ship gate

**Parent PRD:** .kiro/specs/mutation-survivor-report/prd.md
**GH issue:** #303
**Status:** LOCKED

**Lock-Provenance:** negotiation round 2
**Negotiation round:** 2

## Scope lock

With `--mutation-report` set and a `mutationReport` member declared in the PRD
directory's `afk.json`, the ship gate invokes the declared mutation command once
per run in its merged review worktree, started before the guardian-mode fork so
it runs concurrently with the two guardian reviews in both the serial and the
parallel mode, and scoped to the files the run changed. Every exit from the
guardian fork — the normal rejoin and each guardian-rejection exit alike — awaits
the step through one bounded helper under the same flat 30-minute bound and
terminates it through one quiesce binding, and the rejection exits set an
abandonment flag before that termination so a not-yet-spawned command can never
spawn after it. AFK parses the declared mutation-testing-elements JSON report
into a survivor list and classifies the step as `MUTATION_REPORTED` or
`MUTATION_NOT_RUN` (bound reached, tool failure, unparseable report), records
that outcome in run state with run-ID provenance, and renders survivors or the
not-run reason into both `run-summary.md` and the draft PR body from one
derivation. The flag set without a declared command refuses the launch as a
configuration error before any agent dispatch, from the manifest fail-closed
block rather than as a `PreflightFinding`. No outcome may block the ship, fail a
gate, or change a verdict, and with the flag absent nothing runs and ship-gate
behavior is unchanged.

### In scope

- [behavior:B-01] `src/cli-options.ts` parses `--mutation-report` as an exact
  boolean flag in the shape of `--preflight-report-only`
  (`src/cli-options.ts:247`), returns it on the runtime options object
  (`src/cli-options.ts:286`), and `src/orchestrator.ts` reads it as an optional
  config field beside `preflightReportOnly` (`src/orchestrator.ts:611`). The
  three CLI entries already spread runtime options into `runPipeline`
  (`src/afk-claude.ts:276`), so no entry file changes. No
  `--mutation-command`/`--mutation-report-path` flags (GH #303 "Rejected —
  companion CLI flags").
- [behavior:B-02] `parseAfkManifest` (`src/afk-manifest.ts:143`) accepts an
  optional `mutationReport` object of `command` and `reportPath`, normalizes
  `reportPath` the way waiver paths already are (`normalizeWaiverPath`,
  `src/afk-manifest.ts:91`: trimmed, forward slashes, no leading `./`), exposes
  it on `AfkManifest` (`src/afk-manifest.ts:39`) as optional, and **returns** it
  in the normalized object beside `protectedChangeWaivers`
  (`src/afk-manifest.ts:225-231`) (GH #303 AC4).
- [behavior:B-03] A present `mutationReport` is refused by `parseAfkManifest`
  when `command` or `reportPath` is blank or missing, or when `reportPath` holds
  a glob (`/[*?[]/`, the waiver check at `src/afk-manifest.ts:128-134`), is
  absolute, or contains a `..` segment; the thrown message names the offending
  member (GH #303 AC3, AC4).
- [behavior:B-04] A manifest carrying no `mutationReport` member parses exactly
  as it does today with `version` still `1`; `afk.json` does not change schema
  version (GH #303 AC5, "What the ADR must say about the version").
- [behavior:B-05] `trimUnclaimedMigrationPrefixes`
  (`src/afk-manifest.ts:281-309`) preserves a declared `mutationReport` in the
  bytes it writes back, asserted the way waiver preservation already is in
  `src/afk-manifest.test.ts` (GH #303 AC4).
- [behavior:B-06] `src/preflight.ts` gains one exported pure function that,
  given the flag state and the parsed manifest, returns a refusal reason when
  the flag is set and no `mutationReport` is declared and `undefined` otherwise.
  It is not a `PreflightCheck`/`PreflightFinding`
  (`src/preflight.ts:107`, `:113`), because `--preflight-report-only` downgrades
  every finding-based refusal to a warning and a missing declaration is not a
  false reading of machine state (ADR 0042) (GH #303 "Config surface").
- [behavior:B-07] `src/orchestrator.ts` calls that function and throws its
  reason inside the manifest fail-closed block that already runs
  `assertWithinManifestScope` (`src/orchestrator.ts:8497-8508`), so the refusal
  lands before any worktree, branch, or agent dispatch, and
  `--preflight-report-only` cannot bypass it (GH #303 AC2). Decision recorded
  here: the observable for that ordering claim is a source-position assertion in
  `src/mutation-report.test.ts`, and `src/orchestrator.test.ts` stays out of this
  slice's file scope. The assertion is in the shape of
  `src/eval-boundary.test.ts:166-183`'s `P-01` case — read a source file as
  text, compare `indexOf` positions with `toBeLessThan` — and reading
  `src/orchestrator.ts` it pins these positions in this order:
  `assertWithinManifestScope({` (`src/orchestrator.ts:8501`) < the refusal call
  site < `const initialized = updateRunState(` (`:8509`) < `runLaunchPreflight(`
  (`:8545`) < `runWave(` (`:9178`). Each of those three trailing anchors occurs
  exactly once in the file, so every position is unambiguous and no regex over
  prose is involved. That ordering *is* the claim: the refusal precedes the first
  run-state mutation of the run, precedes the launch preflight — which is why
  `--preflight-report-only` cannot bypass it, since that flag only downgrades
  `PreflightFinding`s emitted by a preflight that has not run yet (B-06, P-04,
  ADR 0042) — and precedes `runWave(`, at or after which every worktree
  creation, branch creation and agent dispatch happens. The refusal *reason*
  itself is asserted at B-06's pure-function seam in `src/preflight.test.ts`, so
  reason and position are both observed at in-scope seams and the non-goal "New
  spawned pipeline scenarios (GH #303 AC17)" holds: no scenario is added to the
  heavy orchestrator suite and no test drives `runPipeline` for this behavior.
- [behavior:B-08] A new module `src/mutation-report.ts` exports a pure function
  that parses a mutation-testing-elements report (the schema StrykerJS and peers
  emit) into a survivor list of mutant identity, file, position, and mutator,
  asserted over fixture JSON inlined in `src/mutation-report.test.ts`
  (GH #303 AC8). Decision recorded here: the
  module hand-derives the minimal survivor shape it needs from the public schema
  rather than vendoring the schema file, since no schema artifact exists in-repo
  and only mutant status `Survived` is load-bearing for this slice. The
  obligation that AFK reads the declared report file rather than tool stdout is
  not observable from a pure-parser assertion, so it is carried by B-11's
  invocation assertion instead of by this one. The same test file also records
  the module's place in `ARCHITECTURE.md`: `src/mutation-report.ts` is added to
  the **internals** cell of the existing `| Ship path |` row (beside
  `src/preship.ts` and `src/handoff.ts`) rather than as a new module row, on the
  `src/prompt-recorder.ts` precedent in the `| CLI entries |` row. Decision
  recorded here: the internals-cell placement is the whole compensating edit —
  `ARCHITECTURE.md` is exactly 150 lines today and its cap is `<= 150`
  (`src/eval-boundary.test.ts:293-304`), so widening one existing cell adds a
  module without adding a line and needs no row consolidated away, and
  `src/eval-boundary.test.ts` needs no edit for the cap.
- [behavior:B-09] `src/mutation-report.ts` exports a pure classifier over
  (report parse result × step exit × deadline state) returning
  `MUTATION_REPORTED` with the survivor list, or `MUTATION_NOT_RUN` with a
  structured reason (`BOUND_REACHED`, `COMMAND_FAILED`, `REPORT_UNREADABLE`,
  `REPORT_MALFORMED`); a malformed or absent declared report classifies
  `MUTATION_NOT_RUN` (GH #303 AC9).
- [behavior:B-10] The mutation command's file scope is derived from the existing
  change-summary builder (`buildChangeSummary`, `src/change-summary.ts:178`)
  over the run's base and merged tip, filtered by a pure
  mutation-eligible-source predicate in `src/mutation-report.ts` that returns
  only mutation-eligible source files for a `ChangeSummary` holding source, test,
  and non-source changed files; the builder is
  not duplicated (ARCHITECTURE.md "Change summary": one builder, never a second
  producer). What the ship gate actually hands the declared command is observed
  by B-11, not here, because a predicate assertion cannot see an argument list
  (GH #303 AC7).
- [behavior:B-11] `src/ship-gate.ts` starts the mutation step on the merged
  review worktree (`reviewDir`, `src/ship-gate.ts:580`, destructured at `:656`)
  **before** the guardian mode fork at `src/ship-gate.ts:930` — the step is
  kicked off as an unawaited promise, so neither branch of
  `src/ship-gate.ts:930-947` is restructured and the step is running
  concurrently with the guardians under both `options.serialReviews` and the
  `Promise.allSettled` path. Only the flag set plus a declared command starts
  it. The step is `runMutationStep`, exported from `src/mutation-report.ts`, and
  it does exactly two things in this order: it derives its file scope (B-10),
  then it invokes the `mutationRun` seam. Immediately before that invocation —
  with **no `await` between the check and the invocation**, so no other task can
  interleave on the event loop — it reads the abandonment flag its caller owns;
  if the flag is set it returns without invoking the seam and without spawning
  anything, so the declared command never starts. Because the step is in flight
  across the fork, the whole fork region (`src/ship-gate.ts:930-947`) is wrapped
  so that **no** exit from it leaves the step unawaited or unbounded. On the
  normal rejoin the bounded await of B-12 runs. On a guardian-rejection exit —
  the `throw architectSettled.reason` / `throw pmSettled.reason` rethrows at
  `:941-944` in the parallel branch, and a rejecting `await
  runGuardianReview(...)` at `:931-933` in the serial branch — the wrap performs
  exactly these four steps in this order: (1) it sets the abandonment flag, (2)
  it invokes the same single `terminate` binding B-12 declares, (3) it awaits
  the step through the **same bounded helper and the same
  `MUTATION_STEP_BOUND_MS`** B-12 declares — never to settlement with no
  deadline — and (4) it rethrows the guardian's reason unchanged. Setting the
  flag *before* `terminate` is what closes the pre-spawn window: at the instant
  `terminate` runs, either the step has already invoked the seam and `terminate`
  quiesces the process registered on `reviewDir`, or it has not, and the
  pre-seam check skips the invocation; there is no ordering in which the seam is
  invoked after the wrap ran, so a command is never spawned after the quiesce
  that was supposed to stop it. That abandonment path publishes nothing: the
  outcome is discarded (no run-state entry, no event, no report text, because
  the gate never reaches the publish path), and a step rejection or a
  `terminate` failure on it is swallowed so it can never replace or mask the
  guardian's own reason (P-03 requires the rethrow to stay byte-equal) — and
  because a swallowed `terminate` failure leaves the bounded await as the only
  remaining mechanism, that await carries the bound of step (3) rather than
  waiting for settlement, so a swallowed failure cannot make the exit
  unbounded. Decision recorded here: the start point moves ahead of the fork
  rather than into the `Promise.allSettled` array, because an array element is
  awaited by the same `await` that would have to observe the guardians'
  completion instant and terminate the step; a third element there makes B-12's
  origin unobservable. Three obligations are asserted at this seam because only
  it can see them, through a new internal `mutationRun` runner seam on
  `RunShipGateArgs` in the documented shape of `runCommand`/`sanityRunCommand`
  (`src/ship-gate.ts:595`, `:601`): the seam records the file list it received
  and it holds only the mutation-eligible source files B-10's predicate returns;
  the seam returns stdout carrying a differently-shaped report while the
  recorded outcome matches the JSON at the declared `reportPath`, so the report
  file and never tool stdout is the source of results (B-08, GH #303 AC8); and
  the gate ids the run reports with the flag set are identical to those it
  reports with the flag absent, so the step holds no gate id and constructs no
  `GateDeclaration` (GH #303 AC6). Decision recorded here: two further optional
  seams in that same documented shape accompany it — `mutationScope`, which
  substitutes the scope derivation so a test can hold the step *ahead* of the
  seam invocation, and `mutationNow`, which substitutes the clock the bounded
  helper reads — because the pre-spawn window (P-03) and the bound on the throw
  exit (B-12) are otherwise unobservable at this seam; none of the three is a
  configuration surface, none is read from CLI options or `afk.json`, and none
  can change `MUTATION_STEP_BOUND_MS`.
- [behavior:B-12] The step is bounded by a flat, non-configurable 30-minute
  deadline. `MUTATION_STEP_BOUND_MS` lives beside the helper in
  `src/mutation-report.ts` and is not an option field, which is what keeps it
  non-configurable. One exported bounded-await helper takes the in-flight step
  promise, an origin instant, an injectable `now`/timer pair, and a `terminate`
  callback, and **every** exit that awaits the step calls that one helper with
  that one constant: the rejoin exit with the origin captured once immediately
  after either branch of the mode fork rejoins (`src/ship-gate.ts:947-948`), so
  that origin is the instant both guardian results are in hand and is the same
  instant in serial and parallel mode; and each guardian-rejection exit (B-11)
  with the origin it captures at the instant it observes the rejection. No exit
  awaits the step promise to settlement with no deadline, and no exit has a
  second deadline. Decision recorded here: a rejection exit captures its own
  origin for the same flat constant rather than reusing the rejoin origin,
  because the rejoin instant never occurs on that path; "the same bound" is
  therefore one constant and one helper, and the abandonment flag plus
  `terminate` are what make that exit settle promptly in practice, with the
  bound as the backstop that guarantees it settles at all. The ship gate binds
  `terminate` to the existing quiesce path
  (`registerWorktreeProcess`/`quiesceWorktree`, `src/worktree-processes.ts:60`,
  `:138`) on `reviewDir`, with no second kill path and no tolerated detached
  post-exit process, and does not return before the helper resolves — so a step
  past the bound is terminated before the ship gate returns and classifies
  `MUTATION_NOT_RUN` with reason `BOUND_REACHED` (ADR 0020, ADR 0035;
  GH #303 AC10). That one `terminate` binding is also the only kill on the
  guardian-rejection exits B-11 declares: the fork wrap invokes the *same*
  binding — not a second kill path — so `reviewDir` holds no live `cwd` when the
  rejection leaves the gate and the worktree can still be deleted (ADR 0035).
  Every exit from `src/ship-gate.ts:930-947` therefore both terminates the step
  and awaits it under this bound, and there is no third exit between the start
  point and the rejoin await. Decision recorded here: the deadline arithmetic
  and the terminate-then-classify ordering are asserted in
  `src/mutation-report.test.ts` by injecting a `now` already past the origin plus
  30 minutes and a step promise that never settles, so no test waits 30 real
  minutes and no suite needs fake timers around real git. `src/ship-gate.test.ts`
  asserts the wiring: the rejoin origin is the post-fork instant, `terminate` is
  bound to `quiesceWorktree` on `reviewDir`, the gate has not returned while the
  `mutationRun` seam's promise is still pending, and — with a never-settling
  `mutationRun` and `mutationNow` already past the rejection exit's origin plus
  the bound — a guardian rejection still leaves the gate with the guardian's own
  reason after `terminate` ran, which is the observable that the throw exit
  carries a deadline rather than an open-ended settlement await. The rejection
  exits' remaining observables live with P-03, which is the behavior that already
  runs the rejecting-guardian scenario in both modes.
- [behavior:B-13] The outcome joins run state when it lands, carrying run-ID
  provenance. Decision recorded here: the identifier that provenance value is
  the run's `runSlug` — the provider-qualified slug `runSlugForProviderName`
  produces (`src/run-identity.ts:23`), which is already the string the ship gate
  receives on `RunShipGateArgs` (`src/ship-gate.ts:584`) and already the key
  `updateRunState` writes the state file under (`src/run-state.ts:1389`), so no
  new identifier is minted and the round-trip test asserts that exact slug value
  came back rather than only that a field is present. The persisted shape is one
  optional field on `RunState` (`src/run-state.ts:254`) with
  `RUN_STATE_VERSION` bumped `6 → 7` (`src/run-state.ts:67`) and the accepted
  `version` union extended to `3 | 4 | 5 | 6 | 7` so older records still load,
  plus one new `RunEventPayload` member in `src/run-events.ts` recording the
  same outcome (additive, so `EVENTS_SCHEMA_VERSION` stays `1`, per the existing
  members' own rule at `src/run-events.ts:245`). The bump moves two hard-pinned
  literals, and this behavior authorizes both: `src/run-state.test.ts:990`
  (`expect(RUN_STATE_VERSION).toBe(6)` and its `[3, 4, 5, 6]` list) and
  `src/eval-boundary.test.ts:127` (`expect(RUN_STATE_VERSION).toBe(6)` inside the
  `P-05` case), which move to `7` and `[3, 4, 5, 6, 7]` with their surrounding
  assertions and intent untouched — see P-05 for the eval-boundary invariant that
  must survive. `src/eval-boundary.test.ts` is in the file scope for exactly this
  one literal and its comment wording; it is the only hard pin anywhere else in
  the suite (`src/orchestrator.test.ts:5829` uses the constant symbolically and
  needs no edit). Decision recorded here: the bump
  stays rather than dropping to `RunEventPayload`-only persistence, because the
  PRD states the outcome joins run state with run-ID provenance (`prd.md:107`,
  GH #303 AC15) and ARCHITECTURE.md's placement rule spells the mechanism out
  ("A new persisted fact extends `src/run-state.ts`'s schema with a version bump
  and a reader"); the reader for the schema fact is the load adapter
  (`adaptLoadedState`) asserted as a write→load round-trip in
  `src/run-state.test.ts` that compares the loaded provenance value against the
  `runSlug` the record was written under, while the *report* text is derived only from the event
  stream (B-14) so the file and the stream cannot disagree. No future version
  number is reserved in prose (#249).
- [behavior:B-14] `run-summary.md` gains a mutation section that lists every
  survivor under `MUTATION_REPORTED` (including an explicit empty-survivor line)
  and states the reason under `MUTATION_NOT_RUN`, derived from the persisted
  event stream by one exported reader in `src/logger.ts`, mirroring
  `readQualityStageOutcomes` (`src/logger.ts:271`) so the file and the stream
  cannot disagree (GH #303 AC11, AC12).
- [behavior:B-15] The draft PR body carries the same survivor list or not-run
  reason from that same reader, passed into `buildPrCreationPlan`
  (`src/ship-gate.ts:336`) exactly as `qualityStages` is at both plan sites
  (`src/ship-gate.ts:1287`, `:1351`), and the draft PR opens under both outcomes
  (GH #303 AC11, AC12, AC13).
- [behavior:B-16] Neither outcome participates in any gate result, guardian or
  QA verdict, or PR-open decision: the ship gate's decisions are byte-identical
  to a run with the flag absent apart from the added report text (GH #303 AC14).
- [behavior:B-17] `docs/adr/0071-report-only-mutation-survivor-step.md` records
  the mechanism, the SwarmForge/Martin provenance, the decisions-file schema
  (mutant identity, consequence, containment, `KILL` or `ACCEPT`, one-line
  reasoning), the staged trust-ladder direction, `afk.json` staying at
  `version: 1` as an executable claim on `parseAfkManifest` rather than a
  reserved number, and the five refusals as killing arguments (GH #303 AC16).
  The assertion lives in `src/mutation-report.test.ts`, in the shape of this
  repository's existing docs assertion (`src/eval-boundary.test.ts:293-304`,
  which reads `ARCHITECTURE.md` as text): its `it` name carries `B-17`, it reads
  the ADR at that exact path, and it checks the file contains each of these
  exact literals — the heading lines `## Context`, `## Decision`,
  `## Consequences`, `### Decisions file schema`, `### Trust ladder`, and
  `### Refusals`; the provenance strings `SwarmForge` and `Martin`; the
  decisions-file field names `mutant identity`, `consequence`, `containment`,
  `KILL`, `ACCEPT`, and `reasoning`; the version-regime strings `version: 1` and
  `parseAfkManifest`; and the five refusal strings verbatim — `no blocking
  mutation gate`, `no kill-rate or score threshold`, `no generator-loop
  mutation`, `no hardener role`, `no automated survivor-killing`. Decision
  recorded here: the checked list is exactly these literals, so
  `--testNamePattern B-17` proves a defined claim rather than grading prose; the
  prose *around* each literal is the ADR's job and is not asserted. The number
  `0071` is the one GH #303 "The ADR number" resolved across every ref; it is not
  re-derived by listing `docs/adr/`.

### Non-goals (explicit out-of-scope)

- Survivor attribution against a committed baseline and accepted-decision
  labels — slice 2 (#304) extends the same `mutationReport` member with
  `baselinePath` and `decisionsPath`.
- Any blocking gate, kill-rate threshold, verdict change, or generator-loop
  mutation; any automated survivor remediation or hardener role.
- Per-slice, per-QA-round, or generator-verification-command mutation runs.
- Making the 30-minute bound configurable, adding a second or shorter bound for
  the rejection exits, and adding
  `--mutation-command`/`--mutation-report-path` flags.
- Adding a mutation tool, mutation config, or mutation fixtures-on-disk to this
  repository; no test invokes a real mutation tool.
- Tool-specific adapters beyond the standard mutation-testing-elements schema.
- New spawned pipeline scenarios (GH #303 AC17); all assertions land at existing
  unit seams.
- Pipeline-owned negotiation artifacts under
  `.kiro/specs/mutation-survivor-report/slices/01-mutation-report-step/` are not
  implementation work, and the planner and evaluator roles remain free to write
  their contract, manifest, response, review, and feedback files there.

### Existing behavior to preserve

- [behavior:P-01] With `--mutation-report` absent, no mutation step is started
  and `runShipGate` (`src/ship-gate.ts`) behaves exactly as today — no new
  process, no new section in `run-summary.md`, no new PR body text (GH #303
  AC1).
- [behavior:P-02] `parseAfkManifest` still throws for `input.version !== 1`
  (`src/afk-manifest.ts:160-162`) and still validates and returns
  `selectedSlices`, `migrationPrefixes`, `protectedIssues`, and
  `protectedChangeWaivers` unchanged (ADR 0034).
- [behavior:P-03] Both branches of `src/ship-gate.ts:930-947` are unchanged: with
  `options.serialReviews` the architect review still completes before the PM
  review starts, without it both still run under `Promise.allSettled` with the
  reject-rethrow at `:941-944`, and no cached-verdict reuse path moves. Because
  B-11 starts the mutation step ahead of the fork rather than inside either
  branch, the serial-mode assertion observes the same thing the parallel-mode one
  does: the `mutationRun` seam was already invoked before the first guardian
  invocation resolved, and the guardians' own ordering and rethrow are byte-equal
  to a run with the flag absent. The rejecting-guardian scenario additionally
  carries the observables for B-11's fork wrap, because this is the behavior that
  runs it, and it runs **two** cases in each guardian mode. *Already spawned:*
  with the step's `mutationRun` promise still pending when a guardian rejects,
  `terminate`/`quiesceWorktree` was called on `reviewDir` and no mutation process
  remains registered for `reviewDir` at the instant the rejection leaves the gate,
  while the thrown reason is still the guardian's own and identical to the
  flag-absent run's (ADR 0035). *Not yet spawned:* with the step held ahead of the
  seam by a `mutationScope` promise the test owns, so `mutationRun` has not been
  invoked when the guardian rejects, `terminate`/`quiesceWorktree` was called on
  `reviewDir`, the thrown reason is again the guardian's own and byte-equal, and
  after the test releases `mutationScope` and flushes, `mutationRun` has still
  never been invoked (invocation count `0`) and no mutation process is registered
  for `reviewDir` — so the rejection left the gate without waiting on a
  subsequent mutation run and nothing spawned after the quiesce.
- [behavior:P-04] `--preflight-report-only` still downgrades genuine
  `PreflightFinding`s to warnings (`formatPreflightReport`,
  `src/preflight.ts:624`; ADR 0042).
- [behavior:P-05] Run-state records written at versions `3`–`6` still load
  through the existing adapter after the bump, and existing callers and fixtures
  holding an older `version` literal still compile
  (`src/run-state.ts:248-256`). The eval-isolation invariant that shares this id
  survives the pin update B-13 authorizes: `src/eval-boundary.test.ts`'s
  `P-05` case keeps every import-boundary assertion (no eval module imports the
  run-evidence machinery) and keeps `EVENTS_SCHEMA_VERSION` pinned at `1`; only
  the `RUN_STATE_VERSION` literal moves `6 → 7` and its comment is reworded to
  say the same thing — an eval run writes no event and no state, so neither
  schema moves *because of eval*. Note that `--testNamePattern P-05` matches both
  that case and this slice's own `P-05` case in `src/run-state.test.ts`, so this
  behavior's `acceptance:behaviors` run is the gate that sees the pin update.

### Changes to existing behavior (only if the issue asks for it)

- `AfkManifest` gains an optional `mutationReport` member and
  `parseAfkManifest` validates and returns it — authorized by GH #303 "Config
  surface — settled 2026-09-14" and PRD Implementation Decisions line 86.
- `RUN_STATE_VERSION` moves `6 → 7` with the accepted union widened —
  authorized by GH #303 AC15 ("the mutation outcome entry in run state carries
  run-ID provenance") and `prd.md:107`, under ARCHITECTURE.md's placement rule.
  Its two hard-pinned literals move with it: `src/run-state.test.ts:990` and the
  `RUN_STATE_VERSION` line of `src/eval-boundary.test.ts`'s `P-05` case
  (`src/eval-boundary.test.ts:127`), the latter as a literal-and-comment update
  only, with that case's import-boundary and `EVENTS_SCHEMA_VERSION` assertions
  untouched (B-13, P-05).
- The guardian-rejection exits of `src/ship-gate.ts:930-947` gain an abandon,
  terminate and bounded await before the guardian's reason is rethrown unchanged
  — authorized by GH #303 "Concurrency with the guardians — settled 2026-09-15"
  and its first three acceptance criteria (B-11, B-12, P-03).
- `ARCHITECTURE.md`'s `| Ship path |` row gains `src/mutation-report.ts` in its
  internals cell — no new row, no line added, the `<= 150` cap unchanged (B-08).

## Files expected to change

- src/cli-options.ts
- src/cli-options.test.ts
- src/afk-manifest.ts
- src/afk-manifest.test.ts
- src/preflight.ts
- src/preflight.test.ts
- src/orchestrator.ts
- src/mutation-report.ts
- src/mutation-report.test.ts
- src/ship-gate.ts
- src/ship-gate.test.ts
- src/run-state.ts
- src/run-state.test.ts
- src/eval-boundary.test.ts
- src/run-events.ts
- src/logger.ts
- src/logger.test.ts
- ARCHITECTURE.md
- docs/adr/0071-report-only-mutation-survivor-step.md
- .kiro/specs/mutation-survivor-report/slices/01-mutation-report-step/contract.md
- .kiro/specs/mutation-survivor-report/slices/01-mutation-report-step/acceptance-manifest.json
- .kiro/specs/mutation-survivor-report/slices/01-mutation-report-step/contract-response.json
- src/qa-orchestration.test.ts (added by scope amendment for QA finding QA-07)
- src/qa-orchestration-gates.test.ts (added by scope amendment for QA finding QA-07)

## Migration requirements

- New migration files: 0

## New patterns / deps / schema (if any)

- New module `src/mutation-report.ts` — pure report parsing, survivor
  extraction, mutation-eligible-source filtering, outcome classification, the
  step runner with its pre-seam abandonment check, and the bounded-await helper
  (`MUTATION_STEP_BOUND_MS` plus injectable `now`/timer and `terminate` seams),
  with the ship gate as its one call site (ARCHITECTURE.md
  "Hubs — do not grow these; extract instead"). It is recorded in
  `ARCHITECTURE.md` by widening the existing `| Ship path |` row's internals
  cell, not by adding a row: the file is exactly at its `<= 150`-line cap
  (`src/eval-boundary.test.ts:293-304`), so a new row would break that cap and an
  internals-cell entry costs no line (the `src/prompt-recorder.ts` precedent).
- Three new optional internal test seams on `RunShipGateArgs` — `mutationRun`,
  `mutationScope` and `mutationNow` — in the documented shape of `runCommand`
  (`src/ship-gate.ts:595`) and `sanityRunCommand` (`:601`): substituted runner,
  scope derivation and clock, never a configuration surface, and never a way to
  change the 30-minute bound.
- One abandonment flag owned by the ship gate's fork wrap and read by
  `runMutationStep` immediately before it invokes the `mutationRun` seam.
- New optional `afk.json` member `mutationReport: { command, reportPath }` at
  `version: 1` (no manifest version bump).
- New `RunEventPayload` member for the mutation step outcome and one new
  optional `RunState` field carrying the outcome with the run's `runSlug` as its
  provenance value (`src/run-identity.ts:23`), with `RUN_STATE_VERSION` at `7`.
- New ADR `docs/adr/0071-report-only-mutation-survivor-step.md`.
- No new runtime dependency: no mutation tool is added to this repository.

## Test plan

- Given a manifest declaring `mutationReport` with a `command` and a
  `reportPath` needing normalization, when `parseAfkManifest` runs, then the
  returned manifest carries the normalized member (B-02).
- Given manifests whose `mutationReport` has a blank `command`, a missing
  `reportPath`, a glob `reportPath`, an absolute `reportPath`, and a
  `..`-traversing `reportPath`, when `parseAfkManifest` runs, then each throws
  naming the offending member (B-03).
- Given a manifest with no `mutationReport`, when `parseAfkManifest` runs, then
  the result equals today's parse and `version` is `1` (B-04).
- Given an `afk.json` declaring `mutationReport` and an unclaimed migration
  prefix, when `trimUnclaimedMigrationPrefixes` rewrites it, then the member is
  still present in the file's bytes (B-05).
- Given the flag set and a manifest with no `mutationReport`, when the preflight
  pure function runs, then it returns a refusal reason; and given the flag
  absent or a declared member, then it returns `undefined` (B-06).
- Given `src/orchestrator.ts` read as text, when the source-position assertion
  in `src/mutation-report.test.ts` runs, then the refusal call site sits after
  `assertWithinManifestScope({` and before `const initialized = updateRunState(`,
  `runLaunchPreflight(` and `runWave(` — so the throw precedes the first
  run-state mutation, the launch preflight that `--preflight-report-only`
  governs, and every worktree, branch and dispatch — while the refusal reason
  itself is the B-06 assertion in `src/preflight.test.ts`, and no test in this
  slice drives `runPipeline` (B-07).
- Given a mutation-testing-elements fixture with survived, killed, and
  no-coverage mutants, when the parser runs, then only survivors are returned
  with their identity, file, position, and mutator (B-08).
- Given `ARCHITECTURE.md`, when the docs assertion in `src/mutation-report.test.ts`
  reads it, then the `| Ship path |` row's internals cell names
  `src/mutation-report.ts`, no row's first cell is a new mutation module row, and
  the file is still `<= 150` lines (B-08).
- Given each of (valid report + clean exit), (malformed JSON), (missing file),
  (non-zero exit), and (deadline reached), when the classifier runs, then the
  outcome is `MUTATION_REPORTED` or `MUTATION_NOT_RUN` with the matching reason
  (B-09).
- Given a change summary listing source, test, and non-source changed files,
  when the eligible-source predicate filters it, then the returned list holds only
  the mutation-eligible source files and the change-summary builder is the single
  producer (B-10).
- Given the flag set with a declared command, when the ship gate runs, then the
  `mutationRun` seam was invoked on `reviewDir` before the first guardian
  invocation resolved, the file list it received is exactly B-10's filtered list,
  the recorded outcome matches the JSON at the declared `reportPath` and not the
  differently-shaped report the seam returned on stdout, and the gate ids the run
  reports are identical to the same run with the flag absent (B-11).
- Given `runMutationStep` with an abandonment flag already set when its scope
  derivation resolves, when the step continues, then it returns without invoking
  the `mutationRun` seam (invocation count `0`), and given the flag unset, then
  it invokes the seam with no `await` between the flag read and the invocation
  (B-11).
- Given an in-flight step promise that never settles and an injected `now`
  already past the captured origin plus 30 minutes, when the bounded-await helper
  runs, then it calls `terminate` before it resolves and resolves
  `MUTATION_NOT_RUN` with reason `BOUND_REACHED`; and given a `now` inside the
  bound, then it awaits the step instead (B-12).
- Given the flag set and a `mutationRun` seam whose promise is still pending,
  when the ship gate reaches its rejoin await, then it has not returned, the
  captured origin is the post-fork instant at which both guardian results are in
  hand, and `terminate` is bound to `quiesceWorktree` on `reviewDir` (B-12).
- Given the flag set, a `mutationRun` seam whose promise never settles, a
  guardian that rejects, and `mutationNow` already past that exit's origin plus
  `MUTATION_STEP_BOUND_MS` — once with `options.serialReviews` and once under
  `Promise.allSettled` — when the rejection leaves the ship gate, then it leaves
  with the guardian's own reason after `terminate` ran on `reviewDir` rather than
  waiting for the step to settle, so the throw exit carries the same bound the
  rejoin exit does (B-11, B-12).
- Given the flag set, a `mutationRun` seam whose promise is pending and settles
  when the injected `terminate` runs, and a guardian invocation that rejects —
  once with `options.serialReviews` and once under `Promise.allSettled` — when
  the rejection leaves the ship gate, then `terminate`/`quiesceWorktree` was
  called on `reviewDir` before the throw propagated, no mutation process remains
  registered for `reviewDir`, and the thrown reason is the guardian's own,
  identical to the flag-absent run's (B-11, B-12, P-03).
- Given the flag set, a `mutationScope` promise the test holds pending so
  `mutationRun` has not been invoked, and a guardian invocation that rejects —
  once with `options.serialReviews` and once under `Promise.allSettled` — when
  the rejection leaves the ship gate, then `terminate`/`quiesceWorktree` was
  called on `reviewDir`, the thrown reason is the guardian's own and identical to
  the flag-absent run's, and after the test releases `mutationScope` and flushes,
  `mutationRun` has still never been invoked and no mutation process is
  registered for `reviewDir` (B-11, B-12, P-03).
- Given the same pending-`mutationRun` rejection scenario with a `terminate`
  binding that throws, when the rejection leaves the ship gate, then the failure
  is swallowed, the thrown reason is still the guardian's own, and the exit still
  leaves under the bound rather than awaiting settlement (B-11, B-12).
- Given each outcome, when it lands, then run state carries it with the run's
  `runSlug` as its provenance value at `RUN_STATE_VERSION` `7`, a run event
  records the same outcome with `EVENTS_SCHEMA_VERSION` still `1`, a write→load
  round-trip reads that same slug back through `adaptLoadedState`, and a version
  `6` record still loads (B-13, P-05).
- Given the run-state bump, when the suite runs, then
  `src/run-state.test.ts`'s version pin and `src/eval-boundary.test.ts`'s `P-05`
  pin both read `7`, and that `P-05` case's import-boundary assertions and its
  `EVENTS_SCHEMA_VERSION` pin at `1` are unchanged (B-13, P-05).
- Given `MUTATION_REPORTED` with survivors, with zero survivors, and
  `MUTATION_NOT_RUN`, when `run-summary.md` is written, then the mutation
  section lists each survivor, states the empty case explicitly, or states the
  reason (B-14).
- Given the same three cases, when the PR creation plan is built, then the body
  carries the same text from the same reader and the plan still opens a draft PR
  (B-15).
- Given `MUTATION_NOT_RUN`, when the ship gate completes, then every gate
  result, guardian and QA verdict, and the PR-open decision match a run with the
  flag absent (B-16, P-01).
- Given the flag absent, when the ship gate runs, then no mutation process is
  spawned and neither `run-summary.md` nor the PR body gains any mutation text
  (P-01).
- Given a manifest with `version: 2` and a manifest with waivers, when
  `parseAfkManifest` runs, then the version throw and waiver handling are
  unchanged (P-02).
- Given `options.serialReviews`, when the ship gate runs with the flag set, then
  the architect review still completes before the PM review starts, the
  reject-rethrow still throws, and the `mutationRun` seam was already invoked
  before the first guardian invocation resolved — the same observation the
  parallel-mode case makes (P-03, B-11).
- Given the ADR at `docs/adr/0071-report-only-mutation-survivor-step.md`, when the
  docs assertion in `src/mutation-report.test.ts` reads it, then it contains each
  declared heading line, provenance string, decisions-file field name,
  version-regime string, and the five refusal strings verbatim (B-17).
- Given a genuine `PreflightFinding` under `--preflight-report-only`, when the
  preflight report is formatted, then it is still a warning (P-04).

## Definition of done

- [ ] `--mutation-report` is parsed, threaded to the orchestrator config, and
      absent by default, with no changes to the three CLI entry files.
- [ ] `parseAfkManifest` accepts, validates, normalizes, and returns an optional
      `mutationReport`, refuses a blank member and a glob/absolute/traversing
      `reportPath`, and `afk.json` stays at `version: 1`.
- [ ] `trimUnclaimedMigrationPrefixes` preserves a declared `mutationReport` in
      the bytes on disk, asserted in `src/afk-manifest.test.ts`.
- [ ] The flag set without a declaration refuses the launch by a throw from the
      orchestrator's manifest fail-closed block, using an exported pure function
      in `src/preflight.ts` that is not a `PreflightFinding`, and
      `--preflight-report-only` does not bypass it — the reason asserted in
      `src/preflight.test.ts` and the call-site ordering asserted as a
      source-position check in `src/mutation-report.test.ts`, with
      `src/orchestrator.test.ts` untouched and out of scope.
- [ ] `src/mutation-report.ts` exports pure survivor parsing, eligible-source
      filtering, outcome classification, the step runner with its pre-seam
      abandonment check, and the bounded-await helper with its injectable
      `now`/timer and `terminate` seams, all asserted over inline fixtures with
      no test waiting on a real 30-minute bound.
- [ ] The ship gate starts the step on `reviewDir` before the guardian mode fork
      so it is concurrent in both modes, captures the rejoin origin instant after
      the fork rejoins, awaits the step under the flat 30-minute bound, and
      terminates an overrun through the existing quiesce path before returning,
      with no detached survivor.
- [ ] Every exit from the guardian mode fork terminates the in-flight step and
      awaits it under the same `MUTATION_STEP_BOUND_MS` through the same helper:
      a rejecting guardian in either branch sets the abandonment flag, invokes
      the same `terminate` binding, awaits the step bounded — never to settlement
      with no deadline, including when `terminate` itself fails and is swallowed
      — and then rethrows the guardian's own unchanged reason, publishing no
      outcome on that path.
- [ ] A mutation command is never spawned after the wrap's `terminate` ran:
      `runMutationStep` reads the abandonment flag with no `await` between that
      read and the `mutationRun` invocation, and the pre-spawn
      rejecting-guardian case in `src/ship-gate.test.ts` sees the seam never
      invoked and no process registered for `reviewDir`.
- [ ] The outcome is in run state with the run's `runSlug` as its run-ID
      provenance at `RUN_STATE_VERSION` `7`, older records still load, one run event carries
      the same outcome at `EVENTS_SCHEMA_VERSION` `1`, and both hard-pinned
      version literals (`src/run-state.test.ts`, `src/eval-boundary.test.ts`'s
      `P-05` case) read `7` with every other assertion in that case unchanged.
- [ ] `run-summary.md` and the draft PR body carry survivors or the not-run
      reason from one shared reader, and the draft PR opens under both outcomes.
- [ ] No gate result, verdict, or PR-open decision reads the mutation outcome.
- [ ] `docs/adr/0071-report-only-mutation-survivor-step.md` records the
      mechanism, provenance, decisions-file schema, trust-ladder direction,
      version handling, and the five refusals, and the docs assertion in
      `src/mutation-report.test.ts` finds every literal B-17 declares.
- [ ] `ARCHITECTURE.md` names `src/mutation-report.ts` in the existing
      `| Ship path |` row's internals cell, adds no row, and is still `<= 150`
      lines — so `src/eval-boundary.test.ts`'s cap assertion needs no edit.
- [ ] No new spawned pipeline scenario, no mutation tool dependency, and no real
      mutation tool invoked in any test.
- [ ] `pnpm run typecheck` and the test files listed in this contract's file
      scope pass.

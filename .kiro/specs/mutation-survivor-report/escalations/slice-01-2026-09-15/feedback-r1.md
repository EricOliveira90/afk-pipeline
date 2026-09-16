# Contract review feedback — round 1

Slice: `01-mutation-report-step` (GH #303)

## What already holds

The contract is unusually well anchored. Every line citation I spot-checked is
real: `--preflight-report-only` at `src/cli-options.ts:247` and its return at
`:286`, `preflightReportOnly` on the orchestrator config at
`src/orchestrator.ts:611`, `buildPrCreationPlan` at `src/ship-gate.ts:336` with
its two plan sites at `:1287` and `:1351` reading `qualityStages` from the logger
at `:1286`, and the guardian if/else at `src/ship-gate.ts:930-947`. The
manifest-parser change binds both halves of its regression surface — B-02 is the
newly accepted input, B-03 the rejections (blank member, glob, absolute,
traversal), and B-04 plus P-02 keep the existing accepted language and the
`version !== 1` throw pinned — and it does so at `src/afk-manifest.test.ts`,
which is the established harness for that parser. B-05 is the right instinct:
`trimUnclaimedMigrationPrefixes` spreads a parsed manifest, so a member the
parser does not return is silently dropped on the ship-gate rewrite, and the
contract asserts the bytes on disk rather than the in-memory object.

The refusal design is also sound. Putting the pure check in `src/preflight.ts`
while throwing from the orchestrator's fail-closed block keeps
`--preflight-report-only` from downgrading it, and P-04 keeps the genuine
finding-based downgrade intact. Twenty-two behaviors is inside this repo's
precedent for a single session (recent accepted slices carried 36, 24 and 23),
so I am not treating slice size as a problem; the problems below are specific.

## What must change

**The run-state version bump breaks a test the slice may not touch.**
`src/eval-boundary.test.ts:127` asserts `expect(RUN_STATE_VERSION).toBe(6)`
deliberately — the comment says an eval run writes no state, so neither schema
moved. B-13 moves it to `7`, and that file is in neither the file scope nor any
behavior. Either authorize the pin update in scope, or persist the outcome as a
`RunEventPayload` only and let B-14's reader derive from the stream, which is
what the quality-stage precedent it cites actually does.

**ARCHITECTURE.md is already at its cap.** The file is exactly 150 lines, and
`src/eval-boundary.test.ts:293-304` asserts `lines.length <= 150`. A new module
row makes it 151, and that enforcing test is out of scope too. Say which line
makes room, or list `src/mutation-report.ts` inside an existing row's internals
column the way `src/prompt-recorder.ts` is. While you are there, give the
ARCHITECTURE.md change a behavior id — right now it is a Definition-of-done item
with no observable and no gate.

**The start seam does not exist in serial mode.** B-11 starts the step inside
the `Promise.allSettled` array at `src/ship-gate.ts:935-947`, but that array is
the `else` of `if (options.serialReviews)`. P-03 then asserts the step still
starts in both modes. One implementation cannot satisfy both readings, so the
seam has to be stated in terms that survive the mode fork.

**The 30-minute bound cannot be measured from inside the batch it bounds.**
B-12 measures a flat deadline from guardian-review completion, and its observable
requires the gate not to return before the step is terminated. If the step is a
third element of that `await Promise.allSettled([...])`, the await does not
resolve until the step settles — so the awaiting code never sees the guardians'
completion instant and cannot terminate the branch it is blocked on. Spell out
where the step is started, where it is awaited, and which instant starts the
clock. `runBoundedCommand`'s `wallClockTimeoutMs` (`src/command-runtime.ts:174`)
is the flat, non-resetting bound you want, and `RunShipGateArgs` already carries
`runCommand`/`sanityRunCommand` seams so a direct test can drive an overrun
without a real subprocess — naming that seam would make B-12 testable as written.

## Smaller notes

Three `then` clauses are not visible to their own observable results: B-08's "no
tool stdout is read" (a pure fixture assertion cannot see it), B-10's "passed to
the declared command" (a predicate test over a `ChangeSummary` cannot see the
spawned argument list), and B-11's absent `GateDeclaration`. Move them to an
assertion that can observe them or drop them. And B-17 gates the ADR on
`acceptance:behaviors` without naming the test file that will hold the
`[behavior:B-17]` case or the literal strings it checks, so the gate would run
without a defined claim.

## Not raised

I did not treat the withheld harness and integration evidence as a gap, and I
did not re-check the deterministic manifest fields or path casing. The non-goals
are complete and useful — slice 2's `baselinePath`/`decisionsPath`, the refused
blocking gate and thresholds, the refused companion flags, the configurable
bound, and the no-new-spawned-scenario commitment are all named explicitly.

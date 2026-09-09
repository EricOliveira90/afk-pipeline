# Contract review — round 2, slice 02 (#85), behavior coverage gate

The revision clears every blocking finding from round 1. Two small things are
open and neither has to be fixed before implementation starts; fix them if the
pair is edited again for any other reason.

## What the revision fixed, and how it was checked

**The matcher now reads fields that exist under a filter (F-01).** This was the
round-1 blocker, and the fix is the right one: PASS and untested are restated
over `numPassedTests`/`numFailedTests`, and `numTotalTests` is explicitly
recorded as *not* the match count. I confirmed the reason in this tree rather
than taking the citation on trust:

- `@vitest/runner@3.2.4`'s `interpretTaskModes` sets a non-matching test's mode
  to `"skip"` and leaves it in the collected tree
  (`chunk-hooks.js:1031-1033`, called with `config.testNamePattern` at `:1212`).
- The JSON reporter computes `numTotalTests = getTests(files).length` and filters
  `numPassedTests`/`numFailedTests` on result state `pass`/`fail`
  (`vitest/dist/chunks/index.VByaPkjc.js:1702-1707`).

So the old rule's `numTotalTests === 0` and `numPassedTests === numTotalTests`
were both unreachable under a name filter, and the new rule is reachable. The
same file settles the no-match question the round-1 finding raised: absent an
output file, `writeReport` logs the document to the console
(`:1773-1781`), so a run that matches nothing still emits one. B-05 assigning
no-match to the untested `FAIL`/`COMMAND` branch and narrowing
`FAIL`/`CONFIGURATION` to an unsupported matcher plus stdout-with-no-document is
therefore correct, not just internally consistent.

Note that this puts the contract deliberately at odds with D8 and the anchors
file, both of which name `numTotalTests` as the match count. The contract records
that as a decision with its evidence instead of escalating, which is the right
handling — but the anchors text will keep saying the opposite, so the recorded
decision is the only place a later reader learns why.

The fixtures are pinned to documents transcribed from three real filtered runs
(match-and-pass, match-and-fail, no-match) and pasted into
`src/acceptance-gate.test.ts`, so the suite still spawns no vitest and the file
scope is unchanged. Recording those three documents faithfully is now the step
that carries the production risk; if any of them is hand-shaped instead of
transcribed, the gate's two load-bearing verdicts go back to being unproved.

**Plan resolution has an owner in both directions (F-02).** B-02 states the
order both ways — a declared `gatePolicy.acceptance` wins and needs no `tests`
script; the derived baseline applies only when the member is absent and
`resolveSanityPlan` yields a `tests` step; neither means no plan — and its
observable result walks all four temp-root combinations, asserting the plan, the
per-behavior argv and the matcher under both sources. B-04 substitutes into
"B-02's plan" rather than an unsourced "the plan", and B-07 makes the declared
branch this repository's live one. `loadGatePolicy` is exported at
`src/gate-policy.ts:325` and has no non-test caller today, so the contract's
"first non-test caller" note is accurate.

**The lock-time catalog carries the entry under either source (F-03).** B-02 now
names the mechanism: a new bindable catalog exported from `src/base-gates.ts`
that reads the policy itself through `loadGatePolicy(cwd)`, consumed by the six
`resolveBaseGateDeclarations(ctx.worktreeDir)` sites in `src/orchestrator.ts`.
Both halves check out. Those six sites are at `:1335, :1375, :2754, :2861,
:3257, :3325`, and they are the complete feed into `formatBaseGateCatalog` and
`validateAcceptanceManifestBindings` — the seventh `formatBaseGateCatalog` call
at `:3506` renders `loadBehaviorLockArtifacts().gateCatalog`, which is the
`:3257` catalog — so no display or validation path is left behind.

Putting the entry in a *new* function rather than widening
`resolveBaseGateDeclarations` is what makes P-01's "need no edit" claim true, and
it matters more than the contract lets on: that resolver's output is *executed*
as `defaultGatePlan.declarations` at `src/adopt-command.ts:582`, and asserted
by exact-list equality at `src/gate-policy.test.ts:340`,
`src/orchestrator.test.ts:514` and `src/gate-runner.test.ts:1113`, plus
`.find((gate) => gate.command)` in `src/orchestrator.fixtures.ts:325` and
`src/wave.fixtures.ts:131`. Widening it in place would have run the acceptance
command as a base gate with `{behaviorId}` unsubstituted and broken four call
sites outside the file scope. Keep the two functions separate when implementing.

**The pre-QA widening is keyed on bound work (F-04).** B-04's builder returns
nothing when the locked manifest binds no behavior, and B-06 keys the checkpoint
and `prepare` widening on the declaration's presence. I confirmed the cited
lines: `preQaHasExecutable` at `src/orchestrator.ts:5526-5527`, the `checkpoint`
ternary at `:5529-5535`, `prepare` gated on it at `:5550-5552`. P-03 also names
the tests-script-but-no-typecheck-or-lint project as unchanged, so the case is
both fixed and stated.

**B-07 claims only executable evidence (F-05).** The line-cap clause moved to the
Definition of done, where it is checkable — `ARCHITECTURE.md:11` declares
"Cap: 150 lines" and the file is 61 lines today — and the contract is right that
no `src/` assertion enforces it.

**The pair fits the budget (F-06).** 19,961 bytes on disk: `contract.md` 10,011
plus `acceptance-manifest.json` 9,950, so 39 bytes under the anchors' 20,000.
The additions were paid for out of restated rationale, not obligations — every
behavior ID, the 14-path file scope, the migration count and every gate binding
survive. Two cautions. First, the headroom is thinner than the planner's own
figure, so there is effectively no room for another round; treat the pair as
frozen. Second, roughly 250 of the bytes the revision spent went on reformatting
five `gateIds` arrays from one line to three, which bought nothing — that is
where the headroom went.

## Still open (advisory, non-blocking)

**The `ARCHITECTURE.md` path was lowercased in the manifest.** `fileScope` now
lists `architecture.md` while `contract.md`'s file list and B-07 both keep
`ARCHITECTURE.md`, which is the tracked name (`git ls-files`). The anchors file
asks for tracked casing by name. Nothing fires on it today —
`normalizePath` lowercases every `fileScope` path at
`src/acceptance-manifest.ts:71`, so scope comparison is case-insensitive — and
it saves no bytes, so it is a divergence with no upside. Restore the uppercase
form if the manifest is touched again.

**B-05 kept the old empty-binding rule after B-04 got a new one.** B-04 now
returns no declaration when the manifest binds nothing; B-05 still says that
state is a PASS whose detail says so, justified by a required SKIPPED that would
block evaluation. With no declaration there is no SKIPPED, so that rationale is
stale. The two are reconcilable — the builder omits the declaration at build
time, and `run`, which re-reads the manifest at call time, guards with PASS if
the bytes changed underneath — and the manifest pins both observable results, so
an implementer following it writes both and nothing breaks. Say which
relationship you mean anyway: the reading that treats B-05's PASS as the primary
rule puts the declaration back on every unbound slice and undoes the F-04 fix.

## Note for implementation

`src/gate-policy.test.ts:308` asserts `loadGatePolicy(REPO_ROOT)` by equality
against this repository's current policy. B-07 adds `gatePolicy.acceptance` to
`afk.config.json`, so that assertion must be updated — which is what B-07's
observable result describes, and `src/gate-policy.test.ts` is in the file scope,
so no scope change is needed.

There is no `src/base-gates.test.ts`. B-02's new unit tests belong in
`src/gate-policy.test.ts` (which already asserts `resolveBaseGateDeclarations` at
`:340`) or `src/orchestrator.test.ts`; both are in scope, and
`src/acceptance-manifest.test.ts` is not, so keep the new catalog-and-binding
assertions out of it.

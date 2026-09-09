# Contract review — round 2

## What the revision fixed

**F-11 (budgets gate vs. the sanity plan) — resolved.** The revision took the
cleanest of the two options the clear-condition offered: `test:budgets` is now
declared *outside* the sanity plan. `SANITY_STEPS` (`src/preship.ts:21-28`) and
`BASE_GATE_IDS` (`src/base-gates.ts:11`) are stated unchanged, so the three
readers that know nothing about `GateDeclaration` — `resolveSanityCommands`
(`:131-135`), hence `runPreShipSanity` and evaluator QA's `{{SANITY_COMMANDS}}`,
and `resolveCandidateQACommands` (`:145-153`) — never see the budgets command.
The declaration is assembled in `src/base-gates.ts` from its own
`ENVIRONMENT_SENSITIVE_STEPS` table via a new `resolveScriptStep(cwd,
scriptName)` that is explicitly not a `SanityPlan` member, appended after
`tests` by `resolveFullSuiteGateDeclarations`, and kept out of
`resolveBindableGateCatalog`. Just as important, B-02 no longer claims
`required: false` is the whole exclusion mechanism — it now names two mechanisms
with two different readers, and says so. P-02, the manifest entry, a new
test-plan scenario and a new DoD item all assert the plan's step names stay
`["typecheck", "lint", "tests"]` and that neither command list contains the
budgets command, sited in the already-in-scope `src/base-gates.test.ts`.

**F-12 (`--test-command` validation) — resolved.** The domain is fixed and
recorded as a decision: the check is over required cheap gate IDs, not over the
derived command string. The override is split on `&&`, `pnpm <script>` and
`pnpm run <script>` normalize to the same segment, the launch is refused only
when a required cheap gate's own resolved command is missing, and extra segments
are permitted and unvalidated with ADR 0038 and `src/cli-options.ts:55` cited
for why. `pnpm test:fast` explicitly survives, with both sides worked:
`"pnpm test:fast"` alone is refused naming `typecheck`, and
`"pnpm run typecheck && pnpm test:fast"` is accepted. The literal derived
command for this repo (`pnpm run typecheck`) checks out — `package.json`
declares `typecheck` and no `lint` script, only `lint:tickets`, which also
matches the executable catalog's "lint: (not executable)". Both `AGENTS.md` and
`CLAUDE.md` now carry one literal command that keeps the fast subset in the
generator loop, and the docs-agreement assertion has a named home in
`src/orchestrator.test.ts` echoed in the test plan, the manifest and the DoD.

**F-13 (conditional schema version) — resolved.** The conditional is gone:
`GATE_EVIDENCE_VERSION` is `3` in this slice, the three new fields are optional
on `GateResult` and on the `gate-outcome` event with absence meaning "not
reused"/"not skipped", the new-patterns section matches, and a DoD item asserts
it.

## What the revision introduced

Making the version bump unconditional is the right call, but it turned a
generator escape hatch into a scope collision.

**`src/acceptance-gate.test.ts:326` asserts `expect(GATE_EVIDENCE_VERSION)
.toBe(2)`** — and that file is in neither `## Files expected to change` nor the
manifest's `fileScope.paths`. The in-scope assertions are covered
(`src/gate-runner.test.ts:629`, `:978-979`), but this one is not, so bumping the
constant leaves the suite red unless the slice edits an undeclared file, which
the file-scope gate refuses and the contract's own last DoD item ("no file
outside `## Files expected to change` is modified") forbids. As written the
slice cannot be both green and in scope. Adding `src/acceptance-gate.test.ts` to
both lists, with a named observable result for the version-3 assertion there,
closes it.

Secondarily, and advisory only: the contract names the constant at
`src/gate-runner.ts:24` but nothing about the reader side in the same file.
`SUPPORTED_GATE_EVIDENCE_VERSIONS = [1, 2]` (`:27`) is what `verifyGateEvidence`
accepts (`:804-807`), and the constant's docstring (`:22`) keys a rule to the
version ("refuses one that carries `findings` — only version 2 may"), with a
version-1 branch at `:835`. Whether `3` joins the supported list and whether a
version-3 document may carry `findings` are still implementation choices — worth
one sentence, since the point of going unconditional was to stop leaving these
to the generator.

## Note on the manifest path casing

The `fileScope` entries for the three root documents were lowercased
(`architecture.md`, `agents.md`, `claude.md`) while the contract's file list
keeps the on-disk casing. This is harmless: `normalizeAcceptanceManifestPath`
lowercases both sides (`src/acceptance-manifest.ts:71`) before comparison, so
the scope gate still matches `AGENTS.md`. No change required — flagged only so
it is not mistaken for a defect later.

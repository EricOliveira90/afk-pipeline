# Contract feedback — round 1

## What is settled

The two carried findings are done, and one of them was carried on a wrong
premise that this round's contract exposed.

**The live-run policy reader (F-10).** The contract names
`src/base-gates.ts:108` as the site that already calls `loadGatePolicy(cwd)`,
and that checks out: `resolveAcceptancePlan` reads the policy there, and the
orchestrator reaches that module on the live path (`resolveAcceptancePlan` at
`src/orchestrator.ts:5548`, `resolveBindableGateCatalog` at `:1347`, `:1387`,
`:2766`, `:2873`, `:3269`, `:3337`, `resolvePreQAGateDeclarations` at `:5559`).
The earlier claim that no production module reads the gate policy was wrong;
that is retired. B-01 now routes every `cost` consumer from one
`resolveTestCostPlan` by parameter — declaration stamping, the cheap catalog
feeding `resolveGeneratorTestCommand` at the real call site
`src/orchestrator.ts:6364`, `cacheEnabled` into the two phase callers,
`skipDetectors` into the skip declaration — and its observable result demands a
declared `environmentSensitive` entry change an assembled declaration, not just
a parsed object. That is the difference between plumbing and a parser test.

**The skip gate's evidence (F-03).** `postQaDeclarations` is where the contract
says it is (`src/orchestrator.ts:5899-5915`, with `ctx.worktreeDir` and
`featBranch` at `:5906-5907`), the four spawned assertions the new gate ID
breaks are named and real (`src/qa-orchestration.test.ts:1071`, `:2281-2287`,
`:2309-2315`, `:2432`), `src/qa-orchestration.test.ts` is declared in the file
scope, and the diff-review claim is gone. The generator is now pointed at the
edit it will actually have to make instead of being told the edit cannot happen.

## What still needs a decision

**`test:budgets` cannot enter `SANITY_STEPS` as written.** B-02 puts the step
into `SANITY_STEPS` and then says the declaration's `required: false` /
`environmentSensitive` pair is "the whole exclusion mechanism". Those fields
live on `GateDeclaration`; `SANITY_STEPS` (`src/preship.ts:21-28`) feeds
`resolveSanityPlan`, and the plan's other readers know nothing about gate
declarations. `resolveSanityCommands` (`:131-135`) turns the plan's steps into
the list `runPreShipSanity` executes and evaluator QA is shown, and
`resolveCandidateQACommands` (`:145-153`) filters out only the step named
`tests`. So the step lands in the aggregate pre-ship suite, where an
over-budget run exits non-zero and fails the gate — precisely what ADR 0063
forbids and what this contract's own non-goals disclaim — and it also joins
candidate QA's cheap command list. P-02 meanwhile promises `resolveSanityPlan`'s
output is unchanged. Say where the step is declared and what keeps it out of
those two paths, with an assertion that this repo's `resolveSanityCommands`
does not carry the budgets command.

**`--test-command` narrowing is ambiguous, and the docs correction may fight
the repo's own iteration guidance.** B-05 says the override "may narrow that
list to a subset" and also that one "naming anything outside it" refuses.
Read literally against a derived `pnpm run typecheck && pnpm run lint`, both
launches prescribed today are refused: `AGENTS.md`'s
`--test-command "pnpm typecheck && pnpm test:fast"` omits the required cheap
`lint` and names a command that is no cheap gate's, and `CLAUDE.md`'s
`--test-command "pnpm test:fast"` names only that command. Correcting the docs
to the derived command therefore drops `test:fast` out of the generator loop,
against ADR 0038's purpose, `CLAUDE.md`'s test-loop discipline, and
`--test-command`'s documented contract at `src/cli-options.ts:55`. Under the
other reading — subset over gate IDs, with a narrower command allowed per gate
— `pnpm test:fast` is a legal narrowing of `tests`, but then "excludes the
full-suite `tests` gate" needs restating. Pick one, print the literal command
the corrected `AGENTS.md`/`CLAUDE.md` sections will carry, and name the test
that asserts the two documents agree.

## Worth tightening while you are in there

The evidence-version bump is conditional in two places ("goes to `3` if …",
"when the fields are required"). That leaves a schema decision with
cross-reader consequences to the generator; state plainly whether version 3
ships and whether the cache and prerequisite fields are required or optional on
`GateResult`.

On breadth: five independent features across 25 paths, plus four spawned
assertions to update, is at the upper bound of one session. Every behavior is
anchored to a real site, so this is workable rather than a rejection — but if a
later round needs relief, the cache pair (B-03/B-04) and the prerequisite
mechanism (B-07) are the cleanest seam to move.

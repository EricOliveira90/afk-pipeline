# AFK Pipeline — agent instructions

Standalone CLI tool that orchestrates multi-agent pipelines to implement PRD slices autonomously.

## Directory map

- `src/` — TypeScript source (orchestrator, agent providers, parsers, git helpers)
- `prompts/` — Prompt templates interpolated at invocation time (one per agent role)
- `agents/` — Agent persona/config files for guardian reviews
- `docs/adr/` — Architecture decision records
- `dist/` — Compiled JS (built via `pnpm build`, gitignored)

## Test loop discipline (read this)

The full suite (`pnpm test`) takes about 7 minutes on Windows (416s
measured 2026-08-26 after the two-file suite splits; paired alone-runs
that day put the three split suites ~2.5 minutes faster combined than
their single-file forms) — the pipeline integration suites
(`orchestrator`, `wave`, `resume-integration`, `qa-orchestration`,
`clean-failed`) spawn hundreds of real git processes. The three biggest
suites are each split across two test files balanced by measured
`describe`-block time (e.g. `wave.test.ts` + `wave-migrations.test.ts`),
so a single `test:heavy:<name>` run schedules them across both vitest
workers — see the file headers before adding or moving a block.

- **While iterating:** run the specific test file you are working on
  (`pnpm vitest run src/<file>.test.ts`), or `pnpm test:fast` (unit +
  light integration, a few minutes).
- **Before handoff — working directly in this repo:** run the full
  `pnpm test` once. Nothing checks the suite behind you, so the definition
  of done requires the full suite, not `test:fast`.
- **Before handoff — running as an AFK pipeline slice agent:** run
  `pnpm test:fast` plus the heavy suites your change touches (e.g.
  `pnpm run test:heavy:wave`). Do **not** run the full suite.
  The evaluator-qa runs it on your slice and the pre-ship gate runs it on
  the merged feature branch. A third run costs about 7 minutes and proves
  nothing the other two do not.
- Never loop on the full suite to debug a single failure.

## Self-run launch command (AFK running on this repo)

Before a PRD's tickets enter AFK, run `pnpm lint:tickets <issue>...`
(ADR 0049); check 1 (compound predicates) is an authoring-checklist item,
not a lint.

If you hand-wrote or migrated a `contract-negotiation-outcome.json`, lint
it too: `pnpm lint:tickets --outcome .afk`. Check 5 gates the one shape
that parks forever — an `IMPASSE` carrying `CONTESTED` findings *and* an
unresolved `OPEN` `BLOCKING` finding. Only a `CONTESTED` finding can be
adjudicated, so the open blocker never leaves the lock's completion
predicate: every contest gets decided and the slice parks again on the
same finding. The runtime writes `NON_CONVERGENCE` for a mixed
exhaustion (ADR 0055 §1); a hand-written file has to do the same, or
close the open blocker first.

Every self-run launch — babysit prompts included — passes the
generator's verification command explicitly:

```bash
afk-codex --prd-dir .kiro/specs/<prd-slug> --test-command "pnpm run typecheck && pnpm test:fast"
```

(Substitute `afk`/`afk-claude` for other backends; keep the flag.)

**Typecheck is mandatory in the command, and now enforced.** Vitest strips
types without checking them: run 5 of the PRD 1 self-runs used the bare
`test:fast` form, the generator drove 8 commits to green over code that did
not compile, and the slice died to a misclassified gate failure (#120).
Since #86 the command is *derived* from the cheap-gate catalog — with no
`--test-command` at all this repo gets `pnpm run typecheck` — and an
override is checked against the catalog's required gate **ids**: it may add a
faster subset, but dropping `typecheck` is refused before the run starts.
`CLAUDE.md` carries the same literal command, and
`src/orchestrator.test.ts` reads it out of both documents.

Why the flag at all: ADR 0038 (`docs/adr/0038-generator-verification-command.md`)
shipped `--test-command`, but the flag only helps if the launch uses
it. The PRD 1 run didn't, and its generator round 2 spent ~35 minutes
on three full-suite runs inside a single writing round. This is safe
because the flag narrows only the generator's iteration loop: the
pre-ship sanity gate and the QA evaluator still run the full suite, so
nothing ships verified only on the fast subset.

## Push a commit the moment it exists

A commit that lives only in a local worktree is invisible work. Nobody can
review it, no triage pass counts it, and the next session that looks at the
issue starts building it again.

**The convention: push the branch as soon as the first commit lands, before
verification.** Not after the suite passes, not after the PR is ready.
`git push -u origin <branch>` costs a second, and pushing is not merging —
an unverified branch on the remote blocks nothing and risks nothing.

Two failure modes this exists for, both observed here on 2026-09-09:

- **#143, #144 and #206 were fully implemented** in `C:\tmp` worktrees with
  clean trees, no remote branch and no PR. Two consecutive triage passes
  reported them as not started, because both read the wave checklist rather
  than the worktrees. One machine failure would have lost three finished
  issues that nobody remembered writing.
- **A closed issue's worktree lingers** (`C:\tmp\afk-149`), and the only way
  to tell "its patch landed" from "its patch died unpushed" is
  `git cherry -v main HEAD`. That check is only cheap while the worktree
  still exists.

Corollaries, both cheap:

- **Before removing any worktree**, run `git cherry -v main HEAD` and
  `git status -sb` in it. A `+` line or a dirty tree means work would be
  destroyed. Clean, zero-ahead, and in sync with `origin` is the only safe
  removal.
- **When you finish something, tick its box** in the wave or plan document
  that lists it. The checklist is what the next session reads; a checklist
  that disagrees with the worktrees sends the next agent to rebuild
  finished work.

## Ticket authoring — do not leave a load-bearing decision unmade

The planner decides mechanical, reversible, in-contract details itself and
records them in the contract (`docs/specs/afk-v2-plan.md` §3c policy 1). It
stops and asks only when one of three tests fires: a **spec contradiction** (a
recorded ADR counts as spec), **load-bearing silence** about a public
interface, a data format or a security posture, or a **declared risk class**
(schema history, auth, deletion of tests or gates, destructive git). It stops
by writing `planner-escalation.md` naming the test, the citation, and the
candidate answers, and the run reports a design-decision request and spends no
further contract round on it.

That is a correct outcome, not a failure — the alternative is a contract built
on a guess. But it costs a slice dispatch and a human round trip, so the
author's job is to settle those decisions in the ticket body, or cite the ADR
that already settled them, rather than leave them for the planner to find.

## Where a new assertion goes (read this before adding a test)

A test that spawns a pipeline or a wave costs seconds of wall clock on
every run from now on. The suite reached twenty minutes one
reasonable-looking test at a time, so the default is no longer a new
spawned scenario. In order:

1. **A unit test.** If the claim is about a pure function — a parser, a
   verdict rule, a plan builder — assert it there. No git, no agents.
2. **An existing spawned scenario.** Find the `describe` whose fixture
   already reaches the state you want to assert and add an `it` that
   inspects its result. These blocks spawn once in `beforeAll` and split
   the assertions across cases for exactly this reason.
3. **A slice added to an existing wave.** A new outcome usually only
   needs another slice in a fixture that already runs a wave, not another
   wave.
4. **A new spawned scenario** — only when the fixture state genuinely
   differs and no existing one can reach it. Say so in a comment, so the
   next reader knows the cost was deliberate.

`pnpm test:ratchet` runs the suites and then `pnpm test:budgets`, a
per-suite wall-clock budget (`suite-budgets.json`). If it goes red, the fix
is normally to move the assertion up this list — not to raise the number.
Raising one is fine when the cost is genuinely necessary, but record the
measurement in the commit message.

Run `pnpm test:ratchet` when you add a spawned scenario. It is not part of
`pnpm test`, because `pnpm test` is what AFK's deterministic gates and its
pre-ship sanity gate run, and a wall-clock number is a measurement of the
host rather than of the code (ADR 0063). An agent inside a run cannot make
the machine faster, so a red budget there only teaches it to raise the
number — which is what happened to slice #78 and to run 3's babysitter.

Record it in `suite-budgets.json` as well, as a block named
`_measured<YYYY_MM_DD>[_<qualifier>]@<branch>` — the branch you measured
on. The check compares a run only against a block carrying the branch you
are on, refuses the rest, and warns when another worktree holds different
budgets. It never fails for a labelling problem; a red gate there would
only teach people to delete the labels. Run 3's babysitter raised a budget
off a feature-branch measurement while reading main's numbers, with the
labels already in the file and nothing reading them.

Merging scenarios pays off when it removes whole *pipeline* runs — the
fixed cost of a run is feature-branch setup, the review phase and the
sanity gate. Packing more slices into one *wave* was measured on
2026-08-26 and did not help: that cost is per-slice git work, and running
the lanes concurrently does not recover it on Windows. (That measurement
predates the hermetic-git fix below; ~35% of wave cost then was hook
execution. The direction still holds: packing removes pipeline fixed
cost, not per-slice cost.)

The suite runs git hermetically: `vitest.config.ts` sets
`GIT_CONFIG_NOSYSTEM=1` and an unreadable `GIT_CONFIG_GLOBAL`, so no
host-installed gitconfig or hook (e.g. git-defender's `core.hooksPath`)
reaches fixture repos. Do not remove this — it is correctness first
(host-independent results) and it is worth ~45% of the suite's former
runtime (see `docs/slow-test-consolidation-round2-2026-08-26.md`).


## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues (`gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles use their default label strings (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Triage rules (repo-specific)

Vision citation against `docs/PRODUCT.md`, stale-issue refresh, batch parallelism note. See `docs/agents/triage-rules.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

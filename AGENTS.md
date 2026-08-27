# AFK Pipeline — agent instructions

Standalone CLI tool that orchestrates multi-agent pipelines to implement PRD slices autonomously.

## Directory map

- `src/` — TypeScript source (orchestrator, agent providers, parsers, git helpers)
- `prompts/` — Prompt templates interpolated at invocation time (one per agent role)
- `agents/` — Agent persona/config files for guardian reviews
- `docs/adr/` — Architecture decision records
- `dist/` — Compiled JS (built via `pnpm build`, gitignored)

## Test loop discipline (read this)

The full suite (`pnpm test`) takes about 7 minutes on Windows (421s
measured 2026-08-26, idle machine) — the pipeline integration suites
(`orchestrator`, `wave`, `resume-integration`, `qa-orchestration`,
`clean-failed`) spawn hundreds of real git processes.

- **While iterating:** run the specific test file you are working on
  (`pnpm vitest run src/<file>.test.ts`), or `pnpm test:fast` (unit +
  light integration, a few minutes).
- **Before handoff — working directly in this repo:** run the full
  `pnpm test` once. Nothing checks the suite behind you, so the definition
  of done requires the full suite, not `test:fast`.
- **Before handoff — running as an AFK pipeline slice agent:** run
  `pnpm test:fast` plus the heavy suites your change touches (e.g.
  `pnpm vitest run src/wave.test.ts`). Do **not** run the full suite.
  The evaluator-qa runs it on your slice and the pre-ship gate runs it on
  the merged feature branch. A third run costs about 7 minutes and proves
  nothing the other two do not.
- Never loop on the full suite to debug a single failure.

## Self-run launch command (AFK running on this repo)

Every self-run launch — babysit prompts included — passes the
generator's verification command explicitly:

```bash
afk-codex --prd-dir .kiro/specs/<prd-slug> --test-command "pnpm test:fast"
```

(Substitute `afk`/`afk-claude` for other backends; keep the flag.)

Why: ADR 0038 (`docs/adr/0038-generator-verification-command.md`)
shipped `--test-command`, but the flag only helps if the launch uses
it. The PRD 1 run didn't, and its generator round 2 spent ~35 minutes
on three full-suite runs inside a single writing round. This is safe
because the flag narrows only the generator's iteration loop: the
pre-ship sanity gate and the QA evaluator still run the full suite, so
nothing ships verified only on the fast subset.

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

`pnpm test` ends with `pnpm test:budgets`, a per-file wall-clock budget
(`suite-budgets.json`). If it goes red, the fix is normally to move the
assertion up this list — not to raise the number. Raising one is fine
when the cost is genuinely necessary, but record the measurement in the
commit message.

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

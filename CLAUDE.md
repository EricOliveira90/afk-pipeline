# AFK Pipeline

Standalone CLI tool that orchestrates multi-agent pipelines to implement PRD slices autonomously. Consumed by other projects via `pnpm add -D git+https://github.com/EricOliveira90/afk-pipeline.git`.

## Directory map

- `src/` — TypeScript source (orchestrator, agent providers, parsers, git helpers)
- `prompts/` — Prompt templates interpolated at invocation time (one per agent role)
- `agents/` — Agent persona/config files for guardian reviews
- `docs/adr/` — Architecture decision records
- `dist/` — Compiled JS (built via `pnpm build`, gitignored)


## Test loop discipline (agents: read this)

The full suite (`pnpm test`) takes roughly 20–30 minutes on Windows. Every
measurement since 2026-09-01 lands in that band: recorded in-chain totals
of 1184–1443s of suite time (`suite-budgets.json`,
`_measured2026_09_01_prd3_slice01_five_chain`), two sessions in the week of
2026-09-08 at ~20 and ~26 minutes, and PRD 4's pre-ship gate at ~18.5
minutes under agent load on 2026-09-11 (#250). The governing ceiling is
`suite-budgets.json` `totalSeconds` (1877s, ~31 min): that number is the
ratchet's budget, set ~30% above the slowest in-chain run, while the figure
here is the observation — when they disagree, the budget file wins and this
sentence is stale. (The earlier "about 7 minutes / 416s" figure was measured
2026-08-26, before #76 gave every fixture repo a real sanity script; it no
longer holds and no idle-host re-measurement has been recorded yet.) The
cost is the pipeline integration suites (`orchestrator`, `wave`,
`resume-integration`, `qa-orchestration`, `clean-failed`), which spawn
hundreds of real git processes. The three biggest suites are each split
across two test files balanced by measured `describe`-block time (e.g.
`wave.test.ts` + `wave-migrations.test.ts`), so a single
`test:heavy:<name>` run schedules them across both vitest workers — see the
file headers before adding or moving a block.

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
  the merged feature branch. A third run costs 20-30 minutes and proves
  nothing the other two do not.
- Never loop on the full suite to debug a single failure.

## Self-run launch command (AFK running on this repo)

Every self-run launch — babysit prompts included — passes the
generator's verification command explicitly:

```bash
afk-codex --prd-dir .kiro/specs/<prd-slug> --test-command "pnpm run typecheck && pnpm test:fast"
```

(Substitute `afk`/`afk-claude` for other backends; keep the flag.)

`typecheck` is not optional here: vitest strips types without checking them,
and a bare `test:fast` override is now **refused** before the run starts,
because the command is derived from the cheap-gate catalog and an override is
checked against that catalog's required gate ids (#86). `AGENTS.md` carries
the same literal command, and `src/orchestrator.test.ts` reads it out of both.

Why: ADR 0038 (`docs/adr/0038-generator-verification-command.md`)
shipped `--test-command`, but the flag only helps if the launch uses
it. The PRD 1 run didn't, and its generator round 2 spent ~35 minutes
on three full-suite runs inside a single writing round. This is safe
because the flag narrows only the generator's iteration loop: the
pre-ship sanity gate and the QA evaluator still run the full suite, so
nothing ships verified only on the fast subset.

## Push a commit the moment it exists

A commit in a local worktree is invisible work: unreviewable, uncounted by
triage, and rebuilt from scratch by the next session. Push the branch as
soon as the first commit lands — **before** verification, not after.
Pushing is not merging, so an unverified branch on the remote blocks and
risks nothing.

On 2026-09-09 three finished issues (#143, #144, #206) were found sitting
unpushed in `C:\tmp` worktrees, reported as "not started" by two triage
passes that read the wave checklist instead of the worktrees. So: tick the
checklist box when you finish, and before removing any worktree run
`git cherry -v main HEAD` plus `git status -sb` in it — a `+` line or a
dirty tree means removal would destroy work. The full reasoning is in
AGENTS.md.

## Where a new assertion goes

A test that spawns a pipeline costs seconds on every run from now on, so a
new spawned scenario is the last resort, not the default. Prefer, in
order: a unit test → an `it` on an existing spawned scenario's shared
result → another slice in a fixture that already runs a wave → a new
spawn, with a comment saying why. `pnpm test:ratchet` runs the suites and
then `pnpm test:budgets`, a per-suite wall-clock budget; when it goes red,
move the assertion up that list rather than raising the number. Run it when
you add a spawned scenario — it is deliberately not part of `pnpm test`,
which is what the deterministic gates run (ADR 0063). The full reasoning is
in AGENTS.md.


## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues (`gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles use their default label strings (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Triage rules (repo-specific)

Vision citation against `docs/PRODUCT.md`, stale-issue refresh, batch parallelism note. See `docs/agents/triage-rules.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

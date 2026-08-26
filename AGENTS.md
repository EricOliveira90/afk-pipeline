# AFK Pipeline — agent instructions

Standalone CLI tool that orchestrates multi-agent pipelines to implement PRD slices autonomously.

## Directory map

- `src/` — TypeScript source (orchestrator, agent providers, parsers, git helpers)
- `prompts/` — Prompt templates interpolated at invocation time (one per agent role)
- `agents/` — Agent persona/config files for guardian reviews
- `docs/adr/` — Architecture decision records
- `dist/` — Compiled JS (built via `pnpm build`, gitignored)

## Test loop discipline (read this)

The full suite (`pnpm test`) takes 20+ minutes on Windows — the pipeline
integration suites (`orchestrator`, `wave`, `resume-integration`,
`qa-orchestration`, `clean-failed`) spawn hundreds of real git processes.

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
  the merged feature branch. A third run costs 20 minutes and proves
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

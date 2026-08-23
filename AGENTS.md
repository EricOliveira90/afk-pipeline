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
- **Before handoff / done-claim:** run the full `pnpm test` once. The
  definition of done requires the full suite, not `test:fast`.
- Never loop on the full suite to debug a single failure.

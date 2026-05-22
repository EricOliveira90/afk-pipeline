# AFK Pipeline

Standalone CLI tool that orchestrates multi-agent pipelines to implement PRD slices autonomously. Consumed by other projects via `pnpm add -D git+https://github.com/EricOliveira90/afk-pipeline.git`.

## Directory map

- `src/` — TypeScript source (orchestrator, agent providers, parsers, git helpers)
- `prompts/` — Prompt templates interpolated at invocation time (one per agent role)
- `agents/` — Agent persona/config files for guardian reviews
- `docs/adr/` — Architecture decision records
- `dist/` — Compiled JS (built via `pnpm build`, gitignored)

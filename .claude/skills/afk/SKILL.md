---
name: afk
description: Run the AFK Pipeline to autonomously implement PRD slices as draft PRs. Orchestrates explorer, planner, evaluator, and generator agents per slice with DAG-based parallelism. Use when user wants to run AFK, set up AFK in a project, create issues.md for the pipeline, or asks about the AFK pipeline workflow.
---

# AFK Pipeline

Autonomous multi-agent orchestration: PRD → sliced issues → draft PR. You define the work, kick off the pipeline, walk away, come back to a PR.

## Quick Start

```bash
# Install
pnpm add -D git+https://github.com/EricOliveira90/afk-pipeline.git

# Preview execution plan
npx afk --prd-dir docs/prds/<prd-slug> --dry-run

# Run (Kiro backend)
npx afk --prd-dir docs/prds/<prd-slug>

# Run (Claude Code backend)
npx afk-claude --prd-dir docs/prds/<prd-slug>
```

## Prerequisites

- Node.js 22+
- GitHub CLI authenticated (`gh auth login`)
- Agent backend authenticated: `kiro-cli login` (Kiro) or `claude login` (Claude Code)
- `git`, `pnpm` on PATH
- Project conventions: `CONTEXT.md`, `docs/ARCHITECTURE.md`, `docs/CONVENTIONS.md`, `docs/PRODUCT.md`
- For guardian reviews: `.kiro/agents/{architect-review,pm-review}.md` or `.claude/agents/` equivalent — copy from `templates/agents/` in this package

## Input Format (issues.md)

```markdown
| Slice | GH Issue | Title              | Type | Blocked by | User stories covered |
|-------|----------|--------------------|------|------------|----------------------|
| 01    | #41      | Contact list CRUD  | AFK  | —          | US-1, US-2           |
| 02    | #42      | Contact detail     | AFK  | —          | US-3                 |
| 03    | #43      | Contact search     | AFK  | #41        | US-4                 |
| 04    | #44      | Contact CSV import | AFK  | #41, #42   | US-6                 |
| 05    | #45      | LGPD delete flow   | HITL | #41        | US-7                 |
```

- **AFK** = pipeline runs it. **HITL** = skipped (needs human).
- **Blocked by** = `—` for none, or comma-separated issue numbers for DAG deps.

## Pipeline Flow (per slice)

```
explorer → context.md (codebase search, read-only)
planner  → contract.md (scope + acceptance criteria, max 3 rounds with evaluator)
generator → implements via TDD, commits (max 3 rounds with evaluator-qa)
  PASS  → merge into feature branch
  STUCK → stuck.md written, worktree preserved
```

## Key Behaviors

- **Resumable**: re-run the same command to skip completed slices
- **Parallel**: independent slices run concurrently; file-overlap slices serialized in lanes
- **Post-merge gates**: `pnpm typecheck && pnpm lint && pnpm test` → architect + PM reviews (run concurrently) → draft PR. A crashed review surfaces as `UNKNOWN` and gates the PR off without aborting the pipeline.
- **Cancellation**: Ctrl-C kills agents cleanly; second Ctrl-C hard-exits

## Detailed Reference

See [REFERENCE.md](REFERENCE.md) for: artifact locations, branch strategy, error handling, backend comparison, guardian agent setup, and convenience scripts.

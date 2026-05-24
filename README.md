# AFK Pipeline

Automated multi-agent orchestration that implements PRD slices end-to-end. You define the work (PRD → GitHub issues), kick off the pipeline, walk away, and come back to a draft PR.

The pipeline runs each slice in its own git worktree on a dedicated branch. A planner, generator, and evaluator agent collaborate per slice; once all slices pass, two guardian agents review the merged feature branch and a draft PR is opened.

## Installation

```bash
pnpm add -D git+https://github.com/EricOliveira90/afk-pipeline.git
```

## Prerequisites

- Node.js 22+
- [GitHub CLI](https://cli.github.com/) authenticated (`gh auth login`)
- One of the supported agent backends, authenticated:
  - [Kiro CLI](https://kiro.dev) — `kiro-cli login` (default backend)
  - [Claude Code CLI](https://github.com/anthropics/claude-code) — `claude login`
- `git`, `pnpm` on PATH
- Repo conventions:
  - `CONTEXT.md` and `docs/{ARCHITECTURE,CONVENTIONS,PRODUCT}.md` for the agents to read
  - For **guardian reviews**: `.kiro/agents/<name>.md` (Kiro) or `.claude/agents/<name>.md` (Claude Code)

## Quick Start

```bash
# 1. Author a PRD at .kiro/specs/<prd-slug>/prd.md

# 2. Slice the PRD into GitHub issues + an issues.md manifest
#    (the to-issues skill can do this, or do it manually)

# 3. Preview the execution plan
npx afk --issues .kiro/specs/contacts-crud/issues.md --dry-run

# 4. Run (Kiro backend)
npx afk --issues .kiro/specs/contacts-crud/issues.md

# OR — run (Claude Code backend)
npx afk-claude --issues .kiro/specs/contacts-crud/issues.md
```

Ctrl-C cancels cleanly: in-flight agents are killed, remaining slices are marked CANCELLED, worktrees are preserved. A second Ctrl-C hard-exits.

## Input Format

The pipeline reads a markdown file with a dependency table:

```markdown
| Slice | GH Issue | Title              | Type | Blocked by | User stories covered |
|-------|----------|--------------------|------|------------|----------------------|
| 01    | #41      | Contact list CRUD  | AFK  | —          | US-1, US-2           |
| 02    | #42      | Contact detail     | AFK  | —          | US-3                 |
| 03    | #43      | Contact search     | AFK  | #41        | US-4                 |
| 04    | #44      | Contact CSV import | AFK  | #41, #42   | US-6                 |
| 05    | #45      | LGPD delete flow   | HITL | #41        | US-7                 |
```

- **Type `AFK`** — the pipeline runs it autonomously.
- **Type `HITL`** — skipped; reserved for slices that need a human.
- **Blocked by** — `—` for none, or comma-separated issue numbers for DAG dependencies.

## How It Works

### Per-Slice Pipeline

Each AFK slice runs on its own git worktree and branch:

```
@explorer    → searches the codebase, writes context.md (read-only)
     ↓
@planner     → drafts contract.md (Status: NEGOTIATING)
     ↓
@evaluator   → reviews contract → ACCEPT or REVISE (max 3 rounds)
     ↓
             contract LOCKED
     ↓
@generator   → implements via TDD, commits, writes handoff.md
     ↓
@evaluator   → grades implementation → PASS or FAIL (max 3 rounds)
     ├── PASS  → merge slice branch into feature branch
     └── STUCK → @generator writes stuck.md, worktree preserved
```

### Post-Implementation

Once every AFK slice passes:

```
Pre-ship sanity gate  → pnpm typecheck && pnpm lint && pnpm test:run (or test)
     ├── FAIL → skip guardians + PR (failing steps recorded in run-summary.md)
     └── PASS ↓
@architect-review  → reviews against ARCHITECTURE.md → review-architect.md
@pm-review         → reviews against PRODUCT.md → review-pm.md
     ↓
Both SHIP or ACCEPT-WITH-NOTES → opens draft PR via `gh pr create`
Either FIX-BEFORE-SHIP        → stops; no PR opened
```

### Parallelisation

Independent slices run concurrently:

```
Wave 1: #41 Contact list CRUD    ← no deps
        #42 Contact detail       ← no deps
Wave 2: #43 Contact search       ← blocked by #41
        #44 Contact CSV import   ← blocked by #41, #42
Skipped: #45 LGPD delete flow    ← HITL
```

Slices that declare overlapping files are grouped into **lanes** and run serially within their lane. Merges into the feature branch are serialised via an async mutex.

### Branch Strategy

```
main
 └── feat/contacts-crud                                ← feature branch
      ├── afk/contacts-crud-slice-01-contact-list-crud   ← per-slice worktree branch
      ├── afk/contacts-crud-slice-02-contact-detail
      ├── afk/contacts-crud-slice-03-contact-search
      └── afk/contacts-crud-slice-04-contact-csv-import
```

Branch prefixes are namespaced per provider (`afk/` + `feat/` for Kiro, `afk-claude/` + `feat-claude/` for Claude Code) so both can run on the same PRD without collisions.

## CLI Usage

```bash
npx afk        --issues .kiro/specs/<prd-slug>/issues.md
npx afk-claude --issues .kiro/specs/<prd-slug>/issues.md
npx afk        --issues <path> --dry-run
```

Convenience scripts for your `package.json`:

```json
{
  "scripts": {
    "afk": "afk --issues .kiro/specs/<prd-slug>/issues.md",
    "afk:claude": "afk-claude --issues .kiro/specs/<prd-slug>/issues.md",
    "afk:dry": "afk --issues .kiro/specs/<prd-slug>/issues.md --dry-run"
  }
}
```

## Resumability

State persists in `.afk/run-state.json`, keyed by PRD slug + provider name. Re-run the same command to resume — completed slices are skipped, stuck slices retry from their artifact state.

## Artifacts

```
.kiro/specs/<prd-slug>/
├── prd.md                       # human-authored PRD
├── issues.md                    # slice manifest (pipeline input)
├── slices/
│   ├── 01-contact-list-crud/
│   │   ├── context.md           # explorer output
│   │   ├── contract.md          # planner + evaluator negotiation
│   │   ├── handoff.md           # generator summary on PASS
│   │   ├── qa-report.md         # evaluator grade
│   │   └── stuck.md             # only on final-round FAIL
│   └── ...
├── review-architect.md          # post-impl architect review
└── review-pm.md                 # post-impl PM review
```

Logs: `.afk/logs/<prd-slug>/` (per-invocation stdout + `run-summary.md` with status table and cost totals).

## Error Handling

| Situation | What happens |
|-----------|--------------|
| Contract negotiation fails (max rounds) | Slice → STUCK, worktree preserved |
| Generator fails QA (3 rounds) | `stuck.md` written, slice → STUCK |
| Merge conflict | Slice → CONFLICT, both branches preserved |
| Agent idle timeout (10 min) | Agent killed, slice → STUCK |
| Pre-ship sanity gate fails | Skip guardians + PR; recorded in run-summary.md |
| Guardian says FIX-BEFORE-SHIP | No PR; review files still written |
| HITL slice | Skipped entirely |
| Ctrl-C | In-flight agents killed, remaining → CANCELLED |
| Pipeline crash | Re-run to resume |

A failed dependency holds its dependents — fix the broken slice and re-run.

## Agent Configuration

**Prompt-only roles** — persona fused into prompt templates at invocation time:

| Role | Template |
|------|----------|
| explorer | `prompts/explorer.md` |
| planner | `prompts/planner.md` |
| evaluator (contract) | `prompts/evaluator-contract.md` |
| evaluator (QA) | `prompts/evaluator-qa.md` |
| generator | `prompts/generator.md` |

**Agent-config roles** — post-implementation guardians load persona + tool grants from your project:

| Agent | Location |
|-------|----------|
| architect-review | `.kiro/agents/architect-review.md` or `.claude/agents/architect-review.md` |
| pm-review | `.kiro/agents/pm-review.md` or `.claude/agents/pm-review.md` |

## Setting up guardian reviews

After every AFK slice merges into the feature branch, two guardian
agents review the result before a PR is opened:
`architect-review` (structural patterns, conventions) and `pm-review`
(PRD intent vs reality). Each writes a verdict file the orchestrator
parses to decide whether to ship.

This section covers what a consuming project needs in place before its
first AFK run.

### The contract (what AFK actually requires)

Two files, in the consuming project:

- `.claude/agents/architect-review.md` — guardian persona for the
  architect review. Loaded by Claude Code via `claude --agent`.
- `.claude/agents/pm-review.md` — guardian persona for the PM review.

That's it. AFK passes `{{SPECS_DIR}}` and `{{RELEVANT_FILES}}` (from
`prd.md`'s `## Relevant Files` section) to both prompts. The persona
files decide what else to read.

### Recommended doc surface

The persona templates ship in this repo assume your project has these
files. They aren't required by AFK itself — your personas can point
anywhere — but adapting the templates as-is means they'll reach for:

- `CONTEXT.md` — ubiquitous language / glossary
- `docs/PRODUCT.md` — product decisions and user stories
- `docs/ARCHITECTURE.md` — expensive-to-reverse technical decisions
- `docs/CONVENTIONS.md` — cheap-to-reverse code conventions

If your project uses different paths, edit the templates to match.

### Templates

Copy from this package's `templates/agents/` into your project's
`.claude/agents/`:

```bash
mkdir -p .claude/agents
cp node_modules/afk-pipeline/templates/agents/architect-review.md .claude/agents/
cp node_modules/afk-pipeline/templates/agents/pm-review.md .claude/agents/
```

Then customize: replace doc paths if your project differs, and tune
the "what to focus on" sections for your project's risk profile.

### Read-only contract and parallel execution

The two reviews run **concurrently** on a shared worktree. Both
templates declare a read-only contract: the only writable output is
the verdict file (`review-architect.md` / `review-pm.md`). If you
customize a persona to edit source from a guardian, you risk a race
between the two reviewers. Keep guardians read-only.

A failed or crashed review yields an `UNKNOWN` verdict and does NOT
abort the pipeline. The other review still completes; the PR is gated
off (only `SHIP` and `ACCEPT-WITH-NOTES` open a PR).

### Pre-flight checklist

Before your first `npx afk-claude` run with reviews enabled:

- [ ] `.claude/agents/architect-review.md` exists and references your
      architecture/conventions docs.
- [ ] `.claude/agents/pm-review.md` exists and references your
      product/PRD docs.
- [ ] Both personas declare they only write `review-architect.md` /
      `review-pm.md` and do NOT edit source. (Templates do this.)
- [ ] Both personas include the verdict invariant line:
      `**Verdict:** SHIP | ACCEPT-WITH-NOTES | FIX-BEFORE-SHIP`.
- [ ] Your `prd.md` has a `## Relevant Files` section.

## Choosing a Backend

| Backend | Strengths | Trade-offs |
|---------|-----------|------------|
| Kiro | Default; persona-rich agent configs | Opaque stream — no cost/tool-call stats |
| Claude Code | Streamed JSON; surfaces cost + tool calls in run-summary.md | Requires `claude` CLI auth; agent configs in `.claude/agents/` |

Both share the orchestrator, prompts, artifact format, and DAG semantics.

## Claude Code Skill

This repo ships a Claude Code skill at `.claude/skills/afk/` that teaches other projects' agents how to consume the pipeline. Install it by adding this repo as a dependency — the skill is automatically available to Claude Code agents in consuming projects.

## Architecture Decisions

See `docs/adr/` for the reasoning behind key design choices:

- **ADR 0001** — No sandbox; isolation via per-slice worktrees
- **ADR 0002** — Pluggable `AgentProvider` interface
- **ADR 0003** — Cancellation via `AbortSignal`
- **ADR 0004** — Optional stream parsing per provider
- **ADR 0005** — File-overlap lanes for merge safety
- **ADR 0006** — Default branch detection cascade
- **ADR 0007** — Invocation bounds (tool-call cap + idle timeout)

## Development

```bash
pnpm install
pnpm build          # compile to dist/
pnpm test           # run tests
pnpm typecheck      # type-check without emitting
pnpm dev -- --issues <path>         # run locally via tsx (Kiro)
pnpm dev:claude -- --issues <path>  # run locally via tsx (Claude Code)
```

## Glossary

See `CONTEXT.md` for the canonical glossary of pipeline terms.

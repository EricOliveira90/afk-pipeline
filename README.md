# AFK Pipeline

Automated multi-agent orchestration that implements PRD slices end-to-end. You define the work (PRD → GitHub issues), kick off the pipeline, walk away, and come back to a draft PR.

The pipeline runs each slice in its own git worktree on a dedicated branch. A planner, generator, and evaluator agent collaborate per slice; once all slices pass, two guardian agents review the merged feature branch and a draft PR is opened.

## Installation

Install from git URL into your project as a dev dependency:

```bash
pnpm add -D git+https://github.com/your-org/afk-pipeline.git
# or local path during development:
pnpm add -D file:../afk
```

## Prerequisites

- Node.js 22+
- [GitHub CLI](https://cli.github.com/) authenticated (`gh auth login`)
- One of the supported agent providers, authenticated:
  - [Kiro CLI](https://kiro.dev) — `kiro-cli login` (default backend)
  - [Claude Code CLI](https://github.com/anthropics/claude-code) — `claude login`
- `git`, `pnpm` on `PATH`
- Repo conventions:
  - `CONTEXT.md` and `docs/{ARCHITECTURE,CONVENTIONS,PRODUCT}.md` for the agents to read (the agent prompts cite them)
  - For the **agent-config roles** (architect-review, pm-review): `.kiro/agents/<name>.md` for Kiro, or `.claude/agents/<name>.md` for Claude Code

## Quick start

```bash
# 1. Author a PRD (any way you like) at .kiro/specs/<prd-slug>/prd.md

# 2. Slice the PRD into GitHub issues + an issues.md manifest. Any agent
#    can do this — the to-issues skill is one option. The output must
#    follow the table format below.

# 3. Preview the execution plan
npx afk --issues .kiro/specs/contacts-crud/issues.md --dry-run

# 4. Run AFK (Kiro backend)
npx afk --issues .kiro/specs/contacts-crud/issues.md

# OR — run AFK (Claude Code backend)
npx afk-claude --issues .kiro/specs/contacts-crud/issues.md
```

Ctrl-C cancels cleanly: in-flight agent processes are killed, remaining slices are marked CANCELLED, and worktrees are preserved so a re-run resumes where you stopped. A second Ctrl-C exits hard.

## Input format

The pipeline reads `.kiro/specs/<prd-slug>/issues.md`, a markdown file with a dependency table:

```
| Slice | GH Issue | Title              | Type | Blocked by | User stories covered |
|-------|----------|--------------------|------|------------|----------------------|
| 01    | #41      | Contact list CRUD  | AFK  | —          | US-1, US-2           |
| 02    | #42      | Contact detail     | AFK  | —          | US-3                 |
| 03    | #43      | Contact search     | AFK  | #41        | US-4                 |
| 04    | #44      | Contact CSV import | AFK  | #41, #42   | US-6                 |
| 05    | #45      | LGPD delete flow   | HITL | #41        | US-7                 |
```

- **Type `AFK`** — the pipeline runs it.
- **Type `HITL`** — skipped entirely; reserve for slices that need a human.
- **Blocked by** — `—` for none, or a comma-separated list of issue numbers.

The pipeline builds a DAG from this table and runs independent slices in parallel.

## How it works

### Per-slice pipeline

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

The explorer's job is context engineering — it isolates noisy codebase search to one invocation so the planner and generator start with a tight `context.md` instead of dragging the whole repo through their windows. See `afk/CONTEXT.md` for the full glossary.

### Post-implementation

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

The **pre-ship sanity gate** uses your project's own `package.json` scripts and skips any step that isn't defined (no penalty for projects without a `lint` script). It exists because every AFK commit goes through `git commit --no-verify`, so husky hooks never run during the pipeline — without this gate, lint debt would only surface when a human tries to push.

### Parallelisation

Independent slices run concurrently:

```
Wave 1: #41 Contact list CRUD    ← no deps
        #42 Contact detail       ← no deps
Wave 2: #43 Contact search       ← blocked by #41
        #44 Contact CSV import   ← blocked by #41, #42
Skipped: #45 LGPD delete flow    ← HITL
```

A slice starts as soon as all its dependencies have completed. Within a wave, slice work happens in parallel; merges into the feature branch are serialised (one merge at a time, to avoid `.git/index.lock` races).

### Branch strategy

```
main
 └── feat/contacts-crud                                ← feature branch
      ├── afk/contacts-crud-slice-01-contact-list-crud   ← per-slice worktree branch
      ├── afk/contacts-crud-slice-02-contact-detail
      ├── afk/contacts-crud-slice-03-contact-search
      └── afk/contacts-crud-slice-04-contact-csv-import
```

The feature branch is created from `prd/<prd-slug>` if it exists (so worktrees inherit the human-authored `prd.md` + `issues.md`), otherwise from `main`. Branch prefixes are namespaced per provider — `afk/...` and `feat/...` for the Kiro backend, `afk-claude/...` and `feat-claude/...` for the Claude Code backend — so two providers can run on the same PRD without stomping each other.

On PASS the slice branch merges into the feature branch and the worktree is removed. On merge conflict the worktree is preserved for manual resolution.

## CLI usage

```bash
# Required: path to issues.md
npx afk        --issues .kiro/specs/<prd-slug>/issues.md
npx afk-claude --issues .kiro/specs/<prd-slug>/issues.md

# Dry run: print the wave plan, make no changes
npx afk --issues <path> --dry-run
```

Optionally add convenience scripts to your project's `package.json`:

```json
{
  "scripts": {
    "afk":        "afk",
    "afk:claude": "afk-claude",
    "afk:dry":    "afk --dry-run"
  }
}
```

```bash
pnpm afk --issues .kiro/specs/contacts-crud/issues.md
```

## Resumability

The pipeline is resumable. State persists in `.afk/run-state.json` and is keyed by PRD slug + provider name. If the run crashes, you Ctrl-C, or a slice gets stuck, re-run the same command — slices already at `PASS` (with a green `qa-report.md` and a merged branch) are skipped. Stuck or cancelled slices retry from their on-disk artifact state: contract negotiation resumes from the last `contract.md`, generator retries pick up the last `qa-report.md` findings.

## Artifacts

All slice artifacts live under `.kiro/specs/<prd-slug>/`:

```
.kiro/specs/<prd-slug>/
├── prd.md                       # human-authored PRD
├── issues.md                    # slice manifest (the input)
├── slices/
│   ├── 01-contact-list-crud/
│   │   ├── context.md           # explorer output
│   │   ├── contract.md          # planner + evaluator negotiation
│   │   ├── handoff.md           # generator summary on PASS
│   │   ├── qa-report.md         # evaluator grade
│   │   └── stuck.md             # only on final-round FAIL
│   └── 02-contact-detail/
│       └── ...
├── review-architect.md          # post-impl architect review
└── review-pm.md                 # post-impl PM review
```

## Logs

Per-invocation raw stdout is written to `.afk/logs/<prd-slug>/` (or `<prd-slug>-claude/` for the Claude backend):

```
.afk/logs/contacts-crud/
├── run-summary.md                       # status table for the whole run
├── slice-01-explorer.log
├── slice-01-planner-r1.log
├── slice-01-evaluator-contract-r1.log
├── slice-01-generator-r1.log
├── slice-01-evaluator-qa-r1.log
├── slice-all-architect-review.log
├── slice-all-pm-review.log
└── ...
```

`run-summary.md` is the human-friendly report:

```
# Run Summary — contacts-crud

| Slice                  | Status     | Rounds        | Branch    | Cost     | Tool calls |
|------------------------|------------|---------------|-----------|----------|------------|
| #41 Contact list CRUD  | ✅ PASS    | gen:1 eval:1  | merged    | $0.4231  | 47         |
| #42 Contact detail     | ✅ PASS    | gen:2 eval:2  | merged    | $0.7104  | 82         |
| #43 Contact search     | 🔴 STUCK   | gen:3 eval:3  | preserved | $1.2055  | 134        |
| #45 LGPD delete flow   | ⏭️ SKIPPED | —             | —         | —        | —          |
| **Run totals**         |            |               |           | **$2.34**| **263**    |

Pre-ship sanity gate: PASS
Architect review: SHIP
PM review: ACCEPT-WITH-NOTES
PR: https://github.com/user/repo/pull/15
```

Cost and tool-call columns are populated by providers that parse a structured stream (Claude Code does; Kiro currently treats stdout as opaque — see ADR 0004). When a provider doesn't parse stream events, those columns show `—`.

## Idle warnings and idle timeout

While an agent is running and producing no stdout, the pipeline writes an idle warning into the slice log every minute (default). After 10 minutes of total silence (default) the agent process is hard-killed and the slice is marked STUCK. Both intervals are configurable per invocation — see `InvokeOptions.idleTimeoutMs` and `idleWarningIntervalMs` in `agent-provider.ts`.

This makes long-running invocations legible without requiring the agent to emit a heartbeat itself.

## Error handling

| Situation                              | What happens                                                            |
|----------------------------------------|-------------------------------------------------------------------------|
| Contract negotiation fails (max rounds)| Slice marked STUCK, worktree preserved                                  |
| Generator fails QA (3 rounds)          | Generator writes `stuck.md`, slice marked STUCK, worktree preserved     |
| Merge conflict                         | Slice marked CONFLICT, both branches preserved                          |
| Agent idle timeout (10 min)            | Agent process killed, slice marked STUCK                                |
| Pre-ship sanity gate fails             | Skip guardian reviews + PR; failing steps recorded in `run-summary.md`  |
| Guardian verdict FIX-BEFORE-SHIP       | No PR opened; review files are still written                            |
| HITL slice                             | Skipped entirely                                                        |
| Ctrl-C                                 | In-flight agents killed, remaining slices marked CANCELLED, run state preserved |
| Pipeline crash                         | Re-run to resume; completed slices are skipped                          |

A failed dependency holds its dependents — they will never run in that wave, even if they don't transitively block on the failed slice. Fix the broken slice manually (or rerun after a fix) to unblock them.

## Agent configuration

The pipeline uses two layers:

**Prompt-only roles** — the persona is fused into the prompt template at invocation time; no `--agent` flag is passed to the CLI. Templates live in `afk/prompts/`:

| Role                    | Template file                              |
|-------------------------|--------------------------------------------|
| `explorer`              | `explorer.md`                              |
| `planner`               | `planner.md`                               |
| `evaluator` (contract)  | `evaluator-contract.md`                    |
| `evaluator` (QA)        | `evaluator-qa.md`                          |
| `generator`             | `generator.md` + `generator-stuck.md`      |

Customise behaviour by editing the template directly. Variables like `{{SLICE_DIR}}`, `{{GH_ISSUE}}`, and `{{ROUND}}` are interpolated by `prompt-template.ts`.

**Agent-config roles** — the post-implementation guardian reviews load persona + tool grants from a named agent config (`.kiro/agents/<name>.md` for Kiro, `.claude/agents/<name>.md` for Claude Code). Project-specific context (architecture decisions, product memory, allowed tools) belongs in these config files:

| Agent              | Role                          |
|--------------------|-------------------------------|
| `architect-review` | Post-impl architecture review |
| `pm-review`        | Post-impl product review      |

## Choosing a backend

| Backend     | Strengths                                                                | Trade-offs                                                              |
|-------------|--------------------------------------------------------------------------|-------------------------------------------------------------------------|
| Kiro        | Default; persona-rich agent configs; well-trodden in this repo           | Stream is opaque — no per-invocation cost or tool-call stats            |
| Claude Code | Streamed JSON output; surfaces cost + tool calls in `run-summary.md`     | Requires `claude` CLI auth; agent configs live in `.claude/agents/`     |

The two backends share the orchestrator, prompts, artifact format, and DAG semantics — branch namespacing keeps them from colliding when both run on the same PRD. See ADR 0002 for the abstraction and ADR 0004 for stream parsing.

## Architecture decisions

The `docs/adr/` folder records why the pipeline is shaped the way it is:

- **ADR 0001** — No sandbox; Kiro chat invocations are isolated by per-slice worktrees, not containers.
- **ADR 0002** — `AgentProvider` interface; backends are pluggable adapters.
- **ADR 0003** — Cancellation propagates via `AbortSignal`; in-flight agents die immediately, slice state is preserved on disk.
- **ADR 0004** — Stream parsing is opt-in per provider; not every CLI emits a structured stream.

## Project-specific gates

Some gates are tailored to specific stacks and may need to be removed or adapted when porting AFK to a different project:

- **Migration sync check** — when a slice modifies files under `supabase/migrations/`, the pipeline runs `pnpm supabase migration list --linked` from the repo root to verify the local migration was actually applied to the linked remote. If drift is detected, the slice is marked STUCK. This catches the failure mode where `db:push` records a version in `schema_migrations` without creating the underlying tables. Remove from `orchestrator.ts` if your project doesn't use Supabase.

## Glossary

`afk/CONTEXT.md` is the canonical glossary — _slice_, _slice contract_, _worktree_, _feature branch_, _agent provider_, _idle warning_, _idle timeout_, _stream event_, _invocation stats_, _slice totals_, _run totals_, _pre-ship sanity gate_, _DAG_, _round_, _escalation_, _cancellation_. Read it before editing prompts or extending the orchestrator.

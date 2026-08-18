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
  - [Codex CLI](https://github.com/openai/codex) — use managed authentication or an inheritable Bedrock source (`AWS_PROFILE`, Bedrock API key, or AWS environment credentials). AFK automatically selects a managed Codex `credential_process` profile from the shared AWS config when available.
- `git`, `pnpm` on PATH
- Repo conventions:
  - `CONTEXT.md` and `docs/{ARCHITECTURE,CONVENTIONS,PRODUCT}.md` for the agents to read
  - For **Kiro guardian reviews**: `.kiro/agents/<name>.md` — copy from `templates/agents/`, see [Setting up guardian reviews](#setting-up-guardian-reviews). Claude Code and Codex use complete bundled prompt templates.

## Quick Start

```bash
# 1. Author a PRD at .kiro/specs/<prd-slug>/prd.md

# 2. Slice the PRD into GitHub issues + an issues.md manifest
#    (the to-issues skill can do this, or do it manually)

# 3. Preview the execution plan
npx afk --prd-dir .kiro/specs/contacts-crud --dry-run

# 4. Run (Kiro backend)
npx afk --prd-dir .kiro/specs/contacts-crud

# OR — run (Claude Code backend)
npx afk-claude --prd-dir .kiro/specs/contacts-crud

# OR — run (Codex backend)
npx afk-codex --prd-dir .kiro/specs/contacts-crud

# Run only slices 01-04 (all must be declared AFK)
npx afk-codex --prd-dir .kiro/specs/contacts-crud --slices 01,02,03,04
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
- `--slices` selects manifest slice numbers, not GitHub issue numbers. Selecting a `HITL` slice is rejected; there is no force override.

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
     └── PASS ↓            (result cached by tree SHA — re-entry with an
     ┌────────────────────────────────────┐        unchanged tree skips it)
     │  parallel (serial with --serial-lanes)   │
     │  @architect-review → review-architect.md │
     │  @pm-review        → review-pm.md        │
     └────────────────────────────────────┘
     ↓
review-*.md + governance-log changes are committed to the feature branch
regardless of verdict — they are evidence either way.
     ↓
Both SHIP or ACCEPT-WITH-NOTES → opens draft PR via `gh pr create`
Either FIX-BEFORE-SHIP        → stops; no PR opened (unless
                                --open-pr-on-override, see below)
Agent dies before any output  → outcome NEVER_RAN (infrastructure;
                                retried within the run)
Agent killed after real work  → outcome DIED_MID_RUN (infrastructure;
                                retried within the run)
Finished but no verdict line  → outcome UNPARSEABLE (terminal); no PR;
                                surviving review still recorded
```

The two reviews share the post-impl worktree and run concurrently (serially under `--serial-lanes`). Each codex invocation gets a private temp copy of `AWS_CONFIG_FILE`, so concurrent wrappers cannot race on persisting the shared config (ADR 0015). The persona templates declare a read-only contract (write only the verdict file) so shared-worktree parallelism is safe — see [Setting up guardian reviews](#setting-up-guardian-reviews).

The PM review is scope-aware: it receives the run's selected slices and the skipped ones (with reasons like HITL), and must not let out-of-scope PRD gaps drive the verdict. A favorable verdict (SHIP / ACCEPT-WITH-NOTES) is cached against the reviewed HEAD; re-entering with an unchanged HEAD skips that review and re-runs only what is unresolved.

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

Branch prefixes are namespaced per provider: `afk/` + `feat/` for Kiro, `afk-claude-code/` + `feat-claude-code/` for Claude Code, and `afk-codex/` + `feat-codex/` for Codex. Logs and run state use the same provider namespace, so providers can run on the same PRD without collisions.

## CLI Usage

```bash
npx afk        --prd-dir .kiro/specs/<prd-slug>
npx afk-claude --prd-dir .kiro/specs/<prd-slug>
npx afk-codex  --prd-dir .kiro/specs/<prd-slug>
npx afk-codex  --prd-dir .kiro/specs/<prd-slug> --slices 01,02,03,04
npx afk-codex  --prd-dir .kiro/specs/<prd-slug> --open-pr-on-override
npx afk        --prd-dir <path> --dry-run
```

`--open-pr-on-override` opens the draft PR even when the PM guardian
returns `FIX-BEFORE-SHIP` (the architect verdict must still be
favorable). The override and both verdicts are recorded in the PR body.
Use it when a PRD's remaining gaps belong to HITL slices outside the
run's scope. Infrastructure failures and unparseable verdicts are never
overridden.

### Cleaning up after failed runs

```bash
npx afk clean-failed --prd-dir .kiro/specs/<prd-slug> [--dry-run]
```

Failed and stuck slices preserve their worktree and branch for
postmortem. Before a re-run, `clean-failed` removes that debris in one
command: worktrees of every slice in a failure phase (plus unregistered
leftover directories and scratch merge dirs in the PRD's namespace),
then the slice branches — but only branches with **no commits ahead of
the feature branch**; branches carrying unmerged work are kept and
reported. Other PRDs' and other providers' worktrees are out of scope
by construction. `--dry-run` prints the plan without touching anything.
See ADR 0023.

Convenience scripts for your `package.json`:

```json
{
  "scripts": {
    "afk": "afk --prd-dir .kiro/specs/<prd-slug>",
    "afk:claude": "afk-claude --prd-dir .kiro/specs/<prd-slug>",
    "afk:codex": "afk-codex --prd-dir .kiro/specs/<prd-slug>",
    "afk:dry": "afk --prd-dir .kiro/specs/<prd-slug> --dry-run"
  }
}
```

## Resumability

State persists in `.afk/state/<run-slug>.json`, where the run slug includes the provider for non-Kiro backends. The first non-dry run stores the resolved slice identities. Re-run the same command to resume: completed slices are skipped and stuck slices retry from their artifact state.

A retry with no `--slices` argument reuses the persisted scope. Supplying a different selection is rejected so a changed manifest or command cannot silently expand the run. To intentionally start a different scope, use a fresh PRD/run slug or remove the old state file after confirming no in-progress work depends on it. State files created by older package versions have no scope; their first run after upgrade adopts the then-current set of all AFK slices.

The state file also caches the post-merge review phase (ADR 0015): a passing pre-ship sanity gate is keyed by the reviewed tree's SHA, and favorable guardian verdicts by the reviewed HEAD. Re-entering a finished run re-executes only what actually changed — typically just the review that previously failed or blocked.

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

Logs: `.afk/logs/<run-slug>/` (per-invocation stdout + `run-summary.md` with status table and cost totals). Non-Kiro providers suffix the run slug, for example `<prd-slug>-codex`.

Every terminal pipeline exit also writes `.afk/logs/<run-slug>/handoff.json`. This versioned JSON artifact records run status, selected slice outcomes, skipped slices and reasons, feature branch, final commit SHA, newly added migration paths, GitHub issues to close, and draft PR number/URL when available. The generated draft PR body includes `Closes #<issue>` for each selected slice.

## Error Handling

| Situation | What happens |
|-----------|--------------|
| Contract negotiation fails (max rounds) | Slice → STUCK, worktree preserved |
| Generator fails QA (3 rounds) | `stuck.md` written, slice → STUCK |
| Merge conflict | Slice → CONFLICT, both branches preserved |
| Agent idle timeout (10 min) | Agent killed, slice → STUCK |
| Pre-ship sanity gate fails | Skip guardians + PR; recorded in run-summary.md |
| Guardian says FIX-BEFORE-SHIP | No PR (unless `--open-pr-on-override`); review files committed to the feature branch |
| Guardian dies before producing output | Outcome → NEVER_RAN; infrastructure retry within the run (`--infrastructure-retries`); stderr surfaced in run-summary.md |
| Guardian killed mid-run (idle watcher / tool cap) | Outcome → DIED_MID_RUN; infrastructure retry within the run |
| Guardian finishes but verdict unparseable | Outcome → UNPARSEABLE (terminal); no PR; other review still completes |
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

**Guardian roles** — post-implementation reviews always receive complete prompt templates. Kiro also loads project agent configs; Claude Code runs guardians in `--bare` mode and Codex ignores `agent`/`bare`, so neither requires project agent files:

| Agent | Location |
|-------|----------|
| architect-review | `prompts/architect-review.md`; optional Kiro config at `.kiro/agents/architect-review.md` |
| pm-review | `prompts/pm-review.md`; optional Kiro config at `.kiro/agents/pm-review.md` |

## Setting up guardian reviews

After every AFK slice merges into the feature branch, two guardian
agents review the result before a PR is opened:
`architect-review` (structural patterns, conventions) and `pm-review`
(PRD intent vs reality). Each writes a verdict file the orchestrator
parses to decide whether to ship.

This section covers what a consuming project needs in place before its
first AFK run.

### The contract (what AFK actually requires)

Kiro expects two files in the consuming project:

- `.kiro/agents/architect-review.md` — guardian persona for the architect review.
- `.kiro/agents/pm-review.md` — guardian persona for the PM review.

Claude Code and Codex do not require these files. Their guardians use
AFK's complete `prompts/architect-review.md` and `prompts/pm-review.md`
templates. AFK passes `{{SPECS_DIR}}` and `{{RELEVANT_FILES}}` (from
`prd.md`'s `## Relevant Files` section) to both prompts.

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

For Kiro, copy from this package's `templates/agents/` into your project's
`.kiro/agents/`:

```bash
mkdir -p .kiro/agents
cp node_modules/afk-pipeline/templates/agents/architect-review.md .kiro/agents/
cp node_modules/afk-pipeline/templates/agents/pm-review.md .kiro/agents/
```

Then customize: replace doc paths if your project differs, and tune
the "what to focus on" sections for your project's risk profile.

### Read-only contract and parallel execution

The two reviews run **concurrently** on a shared worktree (serially
when `--serial-lanes` is set). Both templates declare a read-only
contract: the only writable output is the verdict file
(`review-architect.md` / `review-pm.md`). If you customize a persona to
edit source from a guardian, you risk a race between the two reviewers.
Keep guardians read-only.

A failed or crashed review never aborts the pipeline. Failures are
classified (ADR 0015): `NEVER_RAN` (died before producing output, e.g.
a wrapper spawn error) and `DIED_MID_RUN` (killed after real activity)
are infrastructure-class and retry within the run using the
`--infrastructure-retries` budget; `UNPARSEABLE` (finished, but no
verdict marker) is terminal. The other review still completes, review
artifacts are committed to the feature branch regardless of outcome,
and the PR is gated off (only `SHIP` and `ACCEPT-WITH-NOTES` open a PR,
unless the operator passes `--open-pr-on-override` to override a real
`FIX-BEFORE-SHIP` PM verdict — the override and both verdicts are then
recorded in the PR body).

### Pre-flight checklist

Before your first run with reviews enabled:

- [ ] For Kiro, `.kiro/agents/architect-review.md` exists and references your
      architecture/conventions docs.
- [ ] For Kiro, `.kiro/agents/pm-review.md` exists and references your
      product/PRD docs.
- [ ] Both personas declare they only write `review-architect.md` /
      `review-pm.md` and do NOT edit source. (Templates do this.)
- [ ] Both personas include the verdict invariant line:
      `**Verdict:** SHIP | ACCEPT-WITH-NOTES | FIX-BEFORE-SHIP`.
- [ ] Your `prd.md` has a `## Relevant Files` section.

## Choosing a Backend

| Backend | Strengths | Trade-offs |
|---------|-----------|------------|
| Kiro | Default; persona-rich agent configs; Fable for most roles and Sonnet for explorer | Opaque stream — no cost/tool-call stats |
| Claude Code | Streamed JSON; Opus for most roles and Sonnet for explorer; cost + tool calls in run-summary.md | Requires `claude` CLI auth |
| Codex | Ephemeral JSONL sessions; tool-call stats; prompt-only guardians | Requires managed CLI auth; fixed `openai.gpt-5.6-sol` model |

All providers share the orchestrator, prompts, artifact format, and DAG semantics. Codex runs `explorer` at medium reasoning effort and every other role at high effort. Provider failures are explicit and never fall back to another provider.

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
- **ADR 0013** — Codex provider command, model policy, prompts, and JSONL behavior
- **ADR 0014** — PRD 070 QA classification and shared-preview isolation
- **ADR 0015** — Guardian review failure classes, scope-aware PM review, and cheap re-entry
- **ADR 0023** — `clean-failed` subcommand for dead-slice worktree/branch debris

## QA Rounds and Shared Preview

AFK preserves the three-round cap for implementation failures. Evaluator
reports classify failures as `IMPLEMENTATION` or `INFRASTRUCTURE`.
Infrastructure failures retry without invoking the generator or advancing the
round (two retries by default). The same retry budget covers post-merge
guardian reviews: `NEVER_RAN` and `DIED_MID_RUN` review failures retry within
the run without becoming terminal (ADR 0015). Each attempt is preserved beside the live report:

- `qa-report-r<round>-a<attempt>.md` for deterministic slice QA
- `uat-report-r<round>-a<attempt>.md` for shared-preview UAT

Pass 1 evaluators continue through independent checks and return all findings in
one report. Retry generators receive complete prior QA report history. Only
handoffs from declared `blockedBy` dependencies are included in generator and
evaluator context.

Shared-preview UAT is opt-in and separate from deterministic QA. Configure it by
providing both central migration commands:

```bash
npx afk-codex --prd-dir .kiro/specs/<prd-slug> \
  --command-timeout-ms 900000 \
  --heartbeat-interval-ms 30000 \
  --infrastructure-retries 2 \
  --preview-verify-command "pnpm db:preview:verify" \
  --preview-apply-command "pnpm db:preview:apply"
```

AFK acquires `.afk/locks/shared-preview.lock` across verification, apply, and
remote UAT, so separate AFK processes cannot run shared-database tests
concurrently. Use `--preview-lock-path` when multiple repositories target the
same preview; they must all point to the same absolute lock path. Command and
agent timeouts measure output inactivity, so stdout/stderr heartbeats keep a
healthy long-running command alive.

Every agent invocation also carries a wall-clock ceiling independent of output
activity (ADR 0016/0019): 120 minutes for generator and evaluator-qa, 60
minutes for other roles. `--max-agent-duration-ms <n>` overrides the ceiling
uniformly for all roles. A ceiling kill during slice execution is terminal for
the slice — rerun with a larger ceiling; committed work is preserved on the
slice branch.

## Development

```bash
pnpm install
pnpm build          # compile to dist/
pnpm test           # run tests
pnpm typecheck      # type-check without emitting
pnpm dev -- --prd-dir <path>         # run locally via tsx (Kiro)
pnpm dev:claude -- --prd-dir <path>  # run locally via tsx (Claude Code)
pnpm dev:codex -- --prd-dir <path>   # run locally via tsx (Codex)

# Opt-in real Codex CLI smoke test (creates a temporary Git repository)
AFK_CODEX_E2E=1 pnpm test src/codex.e2e.test.ts
```

## Glossary

See `CONTEXT.md` for the canonical glossary of pipeline terms.

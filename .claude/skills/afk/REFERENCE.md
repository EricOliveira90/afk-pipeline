# AFK Pipeline — Reference

## Artifacts

All slice artifacts live under the directory passed via `--prd-dir`, conventionally `.kiro/specs/<prd-slug>/`:

```
.kiro/specs/<prd-slug>/
├── prd.md                        # human-authored PRD
├── issues.md                     # slice manifest (pipeline input)
├── slices/
│   ├── 01-contact-list-crud/
│   │   ├── context.md            # explorer output
│   │   ├── contract.md           # planner + evaluator negotiation
│   │   ├── handoff.md            # generator summary on PASS
│   │   ├── qa-report.md          # evaluator grade
│   │   └── stuck.md              # only on final-round FAIL
│   └── 02-contact-detail/
│       └── ...
├── review-architect.md           # post-impl architecture review
└── review-pm.md                  # post-impl product review
```

Logs go to `.afk/logs/<prd-slug>/`:
```
.afk/logs/<prd-slug>/
├── run-summary.md                # human-readable status table + cost totals
├── handoff.json                  # machine-readable terminal handoff
├── slice-01-explorer.log
├── slice-01-planner-r1.log
├── slice-01-evaluator-contract-r1.log
├── slice-01-generator-r1.log
├── slice-01-evaluator-qa-r1.log
├── slice-all-architect-review.log
└── slice-all-pm-review.log
```

Run state (for resumability): `.afk/state/<run-slug>.json`

## Branch Strategy

```
main
 └── feat/<prd-slug>                              ← feature branch (PR target)
      ├── afk/<prd-slug>-slice-01-contact-list      ← per-slice worktree branch
      ├── afk/<prd-slug>-slice-02-contact-detail
      └── afk/<prd-slug>-slice-03-contact-search
```

- Feature branch created from `prd/<prd-slug>` if it exists, otherwise from default branch.
- Branch prefixes are namespaced per provider: `afk/` + `feat/` (Kiro), `afk-claude-code/` + `feat-claude-code/` (Claude Code), and `afk-codex/` + `feat-codex/` (Codex).
- On PASS: slice branch merges into feature branch; worktree removed.
- On conflict: worktree preserved for manual resolution.

## Post-Implementation Gates

Once all AFK slices pass:

1. **Pre-ship sanity**: `pnpm typecheck && pnpm lint && pnpm test:run` (or `test`). Skips any step not defined in `package.json`.
2. **Guardian reviews** (only if sanity passes) — run concurrently via `Promise.allSettled` on a shared worktree:
   - `architect-review` — reviews against `docs/ARCHITECTURE.md`, writes `review-architect.md`
   - `pm-review` — reviews against `docs/PRODUCT.md`, writes `review-pm.md`

   Both templates declare a read-only contract (write only the verdict file) so the shared worktree is safe.
3. **PR creation** (only if both guardians say SHIP or ACCEPT-WITH-NOTES):
   - Opens draft PR via `gh pr create --draft`

If either guardian says FIX-BEFORE-SHIP, no PR is opened (unless the operator passes `--open-pr-on-override`, which opens the draft PR anyway and records the override plus both verdicts in the PR body — only a real FIX-BEFORE-SHIP PM verdict with a favorable architect verdict can be overridden). Review failures are classified (ADR 0015): an agent that dies before producing output is `NEVER_RAN`, one killed after real activity is `DIED_MID_RUN` — both retry within the run via `--infrastructure-retries` — while a finished review with no verdict marker is terminal `UNPARSEABLE`. The surviving review still completes, review artifacts are committed to the feature branch regardless of verdict, the pipeline still returns success, but the PR is gated off.

## Error Handling

| Situation | Outcome |
|-----------|---------|
| Contract negotiation fails (3 rounds) | Slice → STUCK, worktree preserved |
| Generator fails QA (3 rounds) | `stuck.md` written, slice → STUCK |
| Merge conflict | Slice → CONFLICT, branches preserved |
| Agent idle timeout (10 min default) | Agent killed, slice → STUCK |
| Pre-ship sanity fails | Skip guardians + PR; recorded in run-summary.md |
| Guardian says FIX-BEFORE-SHIP | No PR (unless `--open-pr-on-override`); review files committed to the feature branch |
| Guardian dies before producing output | Outcome → NEVER_RAN; infrastructure retry within the run |
| Guardian killed mid-run | Outcome → DIED_MID_RUN; infrastructure retry within the run |
| Guardian verdict unparseable | Outcome → UNPARSEABLE (terminal); no PR; other review still completes |
| HITL slice | Skipped entirely |
| Ctrl-C | In-flight agents killed, remaining → CANCELLED |
| Crash / interruption | Re-run to resume from last state |

A failed dependency holds its dependents — they won't run until the blocker is fixed.

## Backend Comparison

| Backend | Strengths | Trade-offs |
|---------|-----------|------------|
| Kiro | Default; persona-rich agent configs | Opaque stream — no cost/tool-call stats |
| Claude Code | Streamed JSON; Sonnet explorer, Opus otherwise; cost + tool calls in run-summary | Requires `claude` CLI auth |
| Codex | Ephemeral JSONL; prompt-only guardians; tool-call stats | Managed CLI auth; fixed `openai.gpt-5.6-sol` model |

All share the orchestrator, prompts, artifact format, and DAG semantics. Codex uses medium reasoning effort for explorer and high for every other role. Failures never trigger provider fallback.

## Guardian Agent Setup

Generic Kiro templates ship with this package at `templates/agents/`. Copy them into your project and adapt:

```bash
mkdir -p .kiro/agents
cp node_modules/afk-pipeline/templates/agents/architect-review.md .kiro/agents/
cp node_modules/afk-pipeline/templates/agents/pm-review.md .kiro/agents/
```

**For Kiro** — `.kiro/agents/architect-review.md` and `.kiro/agents/pm-review.md` are loaded by name.
**For Claude Code and Codex** — no project agent files are required. Complete guardian personas are carried in AFK's prompt templates; Codex treats `agent` and `bare` options as no-ops.

The Kiro files define persona, tool grants, and project-specific context for post-implementation reviewers. Claude Code and Codex receive the same review contract from the rendered prompt instead.

**Both templates declare a read-only contract** — they write only their verdict file (`review-architect.md` / `review-pm.md`) and never edit source. This is what makes shared-worktree parallelism safe. If you customize a persona to edit source from a guardian, you risk a race between the two reviewers.

**Required invariant** — each persona must produce a line `**Verdict:** SHIP | ACCEPT-WITH-NOTES | FIX-BEFORE-SHIP` (bold, with colon) in its output file. The orchestrator parses this to gate PR creation. The templates handle this; if you write your own, preserve it.

## Convenience Scripts

Add to your project's `package.json`:

```json
{
  "scripts": {
    "afk": "afk --prd-dir .kiro/specs/<prd-slug>",
    "afk:claude": "afk-claude --prd-dir .kiro/specs/<prd-slug>",
    "afk:codex": "afk-codex --prd-dir .kiro/specs/<prd-slug>",
    "afk:codex:scoped": "afk-codex --prd-dir .kiro/specs/<prd-slug> --slices 01,02,03,04",
    "afk:dry": "afk --prd-dir .kiro/specs/<prd-slug> --dry-run"
  }
}
```

## Resumability

State persists in `.afk/state/<run-slug>.json`, with provider-specific run slugs.

- `--slices 01,02,03,04` selects manifest slice numbers; every selected slice must be `AFK`.
- `HITL` selection is rejected and has no force override.
- The first non-dry run persists the resolved scope. Retries without `--slices` reuse it, and a different explicit selection is rejected.
- Slices at PASS (merged branch + green qa-report) are skipped on re-run.
- Stuck/cancelled slices retry from on-disk artifact state.
- Contract negotiation resumes from last `contract.md`.
- Generator retries pick up last `qa-report.md` findings.
- `handoff.json` contains selected/skipped scope, skip reasons, final branch/SHA, added migrations, closing issues, and draft PR metadata.

## Setting Up a Project for AFK

Checklist for a consuming project:

1. `pnpm add -D git+https://github.com/EricOliveira90/afk-pipeline.git`
2. Ensure `CONTEXT.md` exists at repo root (glossary/domain terms)
3. Ensure `docs/ARCHITECTURE.md`, `docs/CONVENTIONS.md`, `docs/PRODUCT.md` exist
4. Ensure `package.json` has `typecheck`, `lint`, and `test` (or `test:run`) scripts
5. Author PRD at `.kiro/specs/<prd-slug>/prd.md`
6. Slice PRD into issues.md (use the `to-issues` skill or do manually)
7. For Kiro, create guardian agent configs in `.kiro/agents/`; Claude Code and Codex use bundled prompts
8. Run `npx afk --prd-dir .kiro/specs/<prd-slug> --dry-run` to validate
9. Run the chosen provider command with `--prd-dir .kiro/specs/<prd-slug>`

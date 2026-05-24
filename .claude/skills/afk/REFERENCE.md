# AFK Pipeline — Reference

## Artifacts

All slice artifacts live under `.kiro/specs/<prd-slug>/` (or `.claude/specs/` for the Claude backend):

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
├── slice-01-explorer.log
├── slice-01-planner-r1.log
├── slice-01-evaluator-contract-r1.log
├── slice-01-generator-r1.log
├── slice-01-evaluator-qa-r1.log
├── slice-all-architect-review.log
└── slice-all-pm-review.log
```

Run state (for resumability): `.afk/run-state.json`

## Branch Strategy

```
main
 └── feat/<prd-slug>                              ← feature branch (PR target)
      ├── afk/<prd-slug>-slice-01-contact-list      ← per-slice worktree branch
      ├── afk/<prd-slug>-slice-02-contact-detail
      └── afk/<prd-slug>-slice-03-contact-search
```

- Feature branch created from `prd/<prd-slug>` if it exists, otherwise from default branch.
- Branch prefixes are namespaced per backend: `afk/` + `feat/` (Kiro), `afk-claude/` + `feat-claude/` (Claude Code).
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

If either guardian says FIX-BEFORE-SHIP, no PR is opened. If a guardian crashes or its verdict is unparseable, that verdict becomes `UNKNOWN` — the surviving review still completes, the pipeline still returns success, but the PR is gated off.

## Error Handling

| Situation | Outcome |
|-----------|---------|
| Contract negotiation fails (3 rounds) | Slice → STUCK, worktree preserved |
| Generator fails QA (3 rounds) | `stuck.md` written, slice → STUCK |
| Merge conflict | Slice → CONFLICT, branches preserved |
| Agent idle timeout (10 min default) | Agent killed, slice → STUCK |
| Pre-ship sanity fails | Skip guardians + PR; recorded in run-summary.md |
| Guardian says FIX-BEFORE-SHIP | No PR; review files still written |
| Guardian crashes or verdict unparseable | Verdict → UNKNOWN; no PR; other review still completes |
| HITL slice | Skipped entirely |
| Ctrl-C | In-flight agents killed, remaining → CANCELLED |
| Crash / interruption | Re-run to resume from last state |

A failed dependency holds its dependents — they won't run until the blocker is fixed.

## Backend Comparison

| Backend | Strengths | Trade-offs |
|---------|-----------|------------|
| Kiro | Default; persona-rich agent configs | Opaque stream — no cost/tool-call stats |
| Claude Code | Streamed JSON; surfaces cost + tool calls in run-summary | Requires `claude` CLI auth; configs in `.claude/agents/` |

Both share the orchestrator, prompts, artifact format, and DAG semantics.

## Guardian Agent Setup

Generic templates ship with this package at `templates/agents/`. Copy them into your project and adapt:

```bash
mkdir -p .claude/agents   # or .kiro/agents for the Kiro backend
cp node_modules/afk-pipeline/templates/agents/architect-review.md .claude/agents/
cp node_modules/afk-pipeline/templates/agents/pm-review.md .claude/agents/
```

**For Kiro backend** — `.kiro/agents/architect-review.md` and `.kiro/agents/pm-review.md`
**For Claude Code backend** — `.claude/agents/architect-review.md` and `.claude/agents/pm-review.md`

These files define persona, tool grants, and project-specific context for the post-implementation reviewers. The pipeline passes `--agent <name>` to the CLI when invoking guardian roles.

**Both templates declare a read-only contract** — they write only their verdict file (`review-architect.md` / `review-pm.md`) and never edit source. This is what makes shared-worktree parallelism safe. If you customize a persona to edit source from a guardian, you risk a race between the two reviewers.

**Required invariant** — each persona must produce a line `**Verdict:** SHIP | ACCEPT-WITH-NOTES | FIX-BEFORE-SHIP` (bold, with colon) in its output file. The orchestrator parses this to gate PR creation. The templates handle this; if you write your own, preserve it.

## Convenience Scripts

Add to your project's `package.json`:

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

State persists in `.afk/run-state.json`, keyed by PRD slug + provider name.

- Slices at PASS (merged branch + green qa-report) are skipped on re-run.
- Stuck/cancelled slices retry from on-disk artifact state.
- Contract negotiation resumes from last `contract.md`.
- Generator retries pick up last `qa-report.md` findings.

## Setting Up a Project for AFK

Checklist for a consuming project:

1. `pnpm add -D git+https://github.com/EricOliveira90/afk-pipeline.git`
2. Ensure `CONTEXT.md` exists at repo root (glossary/domain terms)
3. Ensure `docs/ARCHITECTURE.md`, `docs/CONVENTIONS.md`, `docs/PRODUCT.md` exist
4. Ensure `package.json` has `typecheck`, `lint`, and `test` (or `test:run`) scripts
5. Author PRD at `.kiro/specs/<prd-slug>/prd.md`
6. Slice PRD into issues.md (use the `to-issues` skill or do manually)
7. Create guardian agent configs (copy from `node_modules/afk-pipeline/templates/agents/` into `.kiro/agents/` or `.claude/agents/`)
8. Run `npx afk --issues .kiro/specs/<prd-slug>/issues.md --dry-run` to validate
9. Run `npx afk --issues .kiro/specs/<prd-slug>/issues.md` and walk away

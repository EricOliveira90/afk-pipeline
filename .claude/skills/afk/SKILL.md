---
name: afk
description: Run the AFK v2 pipeline to autonomously implement PRD slices as verified draft PRs, and organize a repository so AFK works well in it. Use when the user wants to run AFK, set up or onboard a project for AFK, prepare issues.md or afk.json, add ARCHITECTURE.md or afk.config.json for the pipeline, understand contracts, gates, escalations, or adjudication, or asks anything about the AFK pipeline workflow — even if they only say "run the pipeline on this PRD" or "make this repo agent-ready".
---

# AFK Pipeline (v2)

Autonomous multi-agent orchestration: PRD → sliced issues → contract-locked,
gate-proven implementation → verified draft PR. You define the work, launch,
walk away, come back to a PR whose every claim carries machine-checkable
evidence.

Two jobs this skill covers:

1. **Run AFK** — launch, monitor, adjudicate, adopt.
2. **Organize the repo** — the files and conventions that make runs fast,
   parallel, and evidence-rich.

Related skills: `to-spec` → `to-tickets` → `to-afk` is the planning path;
`to-afk` prepares a ticketed PRD (slice selection, migration-prefix
reservation, committed `afk.json`) and hands you a `$babysit-afk` prompt.
Use this skill when you need to understand or operate the pipeline itself.

## Quick Start

```bash
# Install
pnpm add -D git+https://github.com/EricOliveira90/afk-pipeline.git

# Preview the execution plan (waves, lanes, bounds)
npx afk --prd-dir .kiro/specs/<prd-slug> --dry-run

# Run (Kiro / Claude Code / Codex backends)
npx afk        --prd-dir .kiro/specs/<prd-slug>
npx afk-claude --prd-dir .kiro/specs/<prd-slug>
npx afk-codex  --prd-dir .kiro/specs/<prd-slug>

# Stop a live run cleanly (routes through the abort path, records CANCELLED)
npx afk stop --prd-dir .kiro/specs/<prd-slug>

# Inspect a run
npx afk status --prd-dir .kiro/specs/<prd-slug> [--json]

# Adopt a slice you finished by hand (verifies merge + gates, records who/why)
npx afk adopt --prd-dir .kiro/specs/<prd-slug> --slice <nn>
```

## Repo Organization — what AFK reads, and why each file earns its place

| File | Read by | What it buys you |
|---|---|---|
| `.kiro/specs/<slug>/prd.md` | planner, evaluators | The spec. Escalations cite it; contradicting it routes to a human. |
| `.kiro/specs/<slug>/issues.md` | orchestrator | Slice table → DAG. Drives waves, lanes, and scope. |
| `.kiro/specs/<slug>/afk.json` | orchestrator | Run scope + migration-prefix reservation pool (written by `to-afk`). Omit it only for repos without migrations. |
| `afk.config.json` (repo root) | lane partitioner | Project policy: `resourceKeys` (hub files, shared resources) and the architecture doc path. Two slices touching the same key serialize into one lane instead of colliding at merge. |
| `ARCHITECTURE.md` | explorer, planner envelopes | Modules, hubs, seams, placement rules. This is how the planner declares seams instead of hubs — the single biggest lever on parallelism. |
| `docs/adr/` | explorer (via an ADR title index) | Recorded decisions. Agents get the index (numbers + titles) and pull full texts on demand; a slice that must contradict an ADR escalates instead of overriding it. |
| `CONTEXT.md` | all roles | Glossary and domain terms. |
| Gate scripts in `package.json` | gate runner | `typecheck`, `test:related`, `test:full` (or `test`), `lint`. PASS is auditable only for gates the orchestrator can execute. |

Authoring rules that pay off every run:

- **Slices are vertical** (end-to-end behavior, independently verifiable) but
  **siblings in one wave declare disjoint files**. When two slices need the
  same seam, add a tiny "seam slice" first that lands the interface, types,
  and stubs — then the implementations parallelize. Vertical for testability,
  seams for parallelism; never horizontal layers (they can't be verified
  independently, and verification is the only trust mechanism here).
- **Name hub files in `afk.config.json`** (`resourceKeys`) and keep them in
  `ARCHITECTURE.md`'s Hubs section. The partitioner serializes contenders;
  the authoring goal is not to touch hubs at all — extract instead.
- **ADR titles should be sentences that carry the rule** ("restart never
  destroys unmerged commits"). The index is all agents see by default; a
  title like "Miscellaneous" buys nothing.
- **Lint tickets before they enter AFK.** A criterion that names a
  state/field absent from schemas, or a recording obligation without a named
  channel, burns bounded rounds on defects a human reads past.

See [REFERENCE.md](REFERENCE.md) for the exact `issues.md`, `afk.json`, and
`afk.config.json` formats.

## Pipeline Flow (per slice)

```
explorer → evidence map (four sections, cited facts, named unknowns)
planner ⇄ contract evaluator → contract.md + acceptance manifest
        every behavior locks with an executable binding (a test the gate
        runner can execute); undeclared scope cannot lock; review fails closed
generator ⇄ deterministic gates + QA evaluator
        gates first (typecheck, behavior coverage, file scope, related tests)
        — a mechanical failure returns to the generator without spending a
        review round; the candidate evaluator judges only gate-green trees,
        from a disposable read-only worktree
  PASS     → merge into feature branch (serialized under a mutex)
  CONFLICT → one agent merge-resolution round, re-proven by gates, then
             terminal CONFLICT only if that fails (both branches preserved)
  STUCK    → code-assembled diagnosis from archived findings; worktree kept
```

Waves and lanes: independent slices run in parallel; slices whose declared
files or resource keys overlap serialize into a lane, where each successor
re-plans on its predecessor's merged result. The full suite runs once per
slice at the merge boundary and once at the aggregate pre-ship gate — not at
every checkpoint.

## Escalation and Adjudication — what reaches a human

Agents decide and record most judgment calls. A slice escalates only on:

1. **Spec contradiction** — the correct fix contradicts the PRD or a
   recorded ADR.
2. **Load-bearing silence** — the spec says nothing and the choice creates
   something others will build on.
3. **Declared risk class** — the change touches a catalog-declared risky
   path (schema history, auth, deletion of tests or gates).

An escalated slice **parks; the run continues** with everything that doesn't
depend on it. The babysit agent couriers the contested question to you
verbatim and writes your decision back as an adjudication artifact; the
parked slice resumes in the live run. Nothing merges on an unresolved
escalation.

## Key Behaviors

- **Evidence over claims**: gate results carry exit status, duration, tree
  identity, and log artifacts; evaluator verdicts cite them. Nothing PASSes
  on an agent's say-so.
- **Resumable**: per-slice state persists; re-run to continue. Restarts never
  destroy unmerged commits; crashes write the same records a clean stop does.
- **Bounded**: contract and repair rounds are capped; remaining bounds are
  visible at dispatch in `run.log` and `afk status`.
- **Ship gate**: full suite on the merged feature branch → guardian reviews
  → draft PR. Environment-sensitive gates (declared in the catalog) report
  at PR review instead of blocking rounds.
- **Concurrent PRDs**: two runs may share a machine — one clone per run,
  prefixes reserved per PRD via `afk.json`, ticket file-overlap checked
  first. Details in REFERENCE.md.
- **Cancellation**: `afk stop` or Ctrl-C lands CANCELLED records; a second
  Ctrl-C hard-exits.

## Detailed Reference

See [REFERENCE.md](REFERENCE.md) for: file formats, artifact locations,
branch strategy, gate catalog and quality policy, error handling, backend
comparison, adjudication artifacts, `afk adopt`, and concurrent-run setup.

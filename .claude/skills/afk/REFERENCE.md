# AFK Pipeline (v2) — Reference

## Input Formats

### issues.md (slice table → DAG)

```markdown
| Slice | GH Issue | Title              | Type | Blocked by | User stories covered |
|-------|----------|--------------------|------|------------|----------------------|
| 01    | #41      | Contact list CRUD  | AFK  | -          | US-1, US-2           |
| 02    | #42      | Contact detail     | AFK  | -          | US-3                 |
| 03    | #43      | Contact search     | AFK  | #41        | US-4                 |
| 04    | #44      | Contact CSV import | AFK  | #41, #42   | US-6                 |
| 05    | #45      | LGPD delete flow   | HITL | #41        | US-7                 |
```

- **AFK** = pipeline runs it. **HITL** = skipped (needs human).
- **Blocked by** = `-` for none, or comma-separated issue numbers (DAG edges).
- `--slices 01,02` narrows within manifest scope; HITL selection is rejected.

### afk.json (per-PRD run manifest, written by `to-afk`)

```json
{
  "version": 1,
  "selectedSlices": ["01", "02", "03", "04"],
  "migrationPrefixes": ["041", "042", "043"],
  "protectedIssues": [{ "issue": 40, "state": "OPEN" }]
}
```

- `selectedSlices` is the default run scope; anything outside fails closed.
- `migrationPrefixes` is a reservation pool: the pipeline claims exact
  prefixes per contract and hands them to agents — **agents never calculate
  the next prefix**. Unused reservations are trimmed from the reviewed branch
  before the draft PR.
- Absence of the file is legacy mode (no reservation, no scope pinning).
  Repos without migrations can omit it.

### afk.config.json (repo-root project policy)

```json
{
  "version": 1,
  "resourceKeys": {
    "orchestrator-core": "^src/(orchestrator|wave)\\.ts$",
    "migrations": "(^|/)migrations/.*\\.sql$"
  },
  "architectureDoc": "ARCHITECTURE.md"
}
```

- Each `resourceKeys` value is a regex matched against normalized declared
  paths (forward slashes, lowercase, no leading `./`). Two wave slices whose
  declared paths match the same key union into one serial lane; the
  lane-composition log names the key.
- A `migrations` key replaces the built-in default pattern (replace, not
  extend).
- Repo-level on purpose: concurrent PRD runs must see identical lane
  semantics.

### ARCHITECTURE.md (envelope input)

Four sections, each with a named reader: **Modules** (name, purpose, public
seam, internals), **Hubs** (do not grow; extract instead), **Seams**
(extension points), **Placement rules**. Keep it under ~150 lines — it rides
in every planner envelope. Every listed hub must have a matching
`resourceKeys` entry; every named path must exist.

## Artifacts

Slice artifacts live under `--prd-dir`, conventionally `.kiro/specs/<slug>/`:

```
.kiro/specs/<prd-slug>/
├── prd.md                      # human-authored PRD
├── issues.md                   # slice table (pipeline input)
├── afk.json                    # run manifest (to-afk output)
├── slices/<nn>-<slug>/
│   ├── context.md              # explorer evidence map
│   ├── contract.md             # locked contract
│   ├── acceptance-manifest.*   # behavior IDs → executable bindings
│   ├── feedback-r<N>.md        # contract-round findings
│   ├── qa-report*.md           # QA verdicts (schema-validated)
│   ├── escalation.*            # written when a role cannot proceed legally
│   ├── adjudication.*          # human decision, written by the courier
│   ├── handoff.md              # what shipped, decisions, gotchas
│   └── stuck.md                # code-assembled diagnosis on terminal failure
├── review-architect.md         # guardian verdicts
└── review-pm.md
```

Run records: logs in `.afk/logs/<run-slug>/` (per-invocation logs,
`run-summary.md`, `handoff.json`), state in `.afk/state/<run-slug>.json`,
journal events alongside. Gate evidence records exit status, duration, tree
identity, and log artifact per execution; envelope evidence records prompt
size, included artifact IDs, and manifest version per invocation.

## Branch Strategy

```
main
 └── feat/<prd-slug>                         ← feature branch (PR target)
      ├── afk/<prd-slug>-slice-01-...        ← per-slice worktree branch
      └── afk/<prd-slug>-slice-02-...
```

- Prefixes are provider-namespaced: `afk/`+`feat/` (Kiro),
  `afk-claude-code/`+`feat-claude-code/`, `afk-codex/`+`feat-codex/`.
- On PASS: slice branch merges into the feature branch under a mutex;
  worktree removed. Merge-time checks (migration claims, collision) are
  atomic with the merge.
- On CONFLICT: one merge-resolution round (generator receives conflict hunks
  + merged sibling diffs; resolved tree re-passes the slice's gates and
  bindings; retry inside the same mutex). Terminal CONFLICT preserves both
  branches.
- MERGE-PENDING: a merge refused for a reason needing no human (e.g. prefix
  collision) is retried free at the next run start, before wave 1.

## Gates and Quality Policy

The orchestrator owns gate execution; agents receive results, never
self-certify. Order per checkpoint:

1. **Base gates** — typecheck first; prerequisite failure skips dependents.
2. **Behavior-coverage gate** — for each acceptance-manifest behavior ID,
   run the bound test filter: zero matches = FAIL (untested), matched tests
   must pass.
3. **File-scope gate** — tracked + untracked changes vs. the locked
   declaration + AFK's artifact allowlist; violations list exact paths.
   Paths matching a declared risk class escalate when undeclared in the
   contract.
4. **Test-cost split** — `test:related` at intermediate checkpoints,
   `test:full` once at the merge boundary and at the aggregate pre-ship
   gate. Passing expensive gates cache against tree identity.
5. **Candidate evaluator** — judgment only, on a gate-green tree, from a
   disposable read-only worktree (edits discarded and recorded; probes
   travel inside findings). Its PASS is the approved behavior baseline;
   post-approval writers trigger a narrow final evaluation, exact-tree
   reuse otherwise.

Catalog attributes: a gate declared **environment-sensitive** (e.g. a
wall-clock budget check) reports in pipeline context — never blocks, never
consumes a round — and surfaces at PR review. The **risk classes** for
escalation live in the same policy-owned catalog.

## Escalation, Adjudication, Adoption

- **Escalation artifact** (schema-validated, fail-closed): written when a
  role cannot proceed legally — generator fix needs an out-of-scope path
  (routes to contract revision), contested finding at round exhaustion
  (impasse → human), remediator out-of-scope aggregate fix.
- **Park-as-dependency**: the escalated slice becomes blocked on
  "adjudication"; the run continues elsewhere. The wait is bounded; a
  timed-out slice parks permanently and the next run resumes it.
- **Adjudication artifact**: finding ID, winning position or third
  instruction, author. Written into the slice directory (normally by the
  babysit courier); the slice becomes dispatchable again. One mechanical
  apply-and-lock step runs before any generator starts — a human decision
  resolves a finding, never bypasses the lock gate.
- **`afk adopt`**: verified manual adoption of a slice finished outside the
  pipeline — verifies the branch merges and base gates pass, merges, writes
  the state entry, records who and why. Refusal names the failing check.
  The adoption record surfaces in run-summary and the draft PR.

## Error Handling

| Situation | Outcome |
|-----------|---------|
| Undeclared scope at contract time | Cannot lock; deterministic gate refuses before any evaluator round |
| Contract rounds exhausted, finding CONTESTED | Impasse → escalation artifact → parked, human adjudicates |
| Contract rounds exhausted, no contest | Non-convergence → fix the ticket (STUCK with diagnosis) |
| Mechanical gate failure | Returns to generator; no evaluator round consumed |
| Generator fix needs out-of-scope path | Escalation → focused contract-revision round |
| QA repair rounds exhausted | STUCK; code-assembled `stuck.md`; worktree preserved |
| Merge conflict | One resolution round, gate-proven; else CONFLICT, branches preserved |
| Migration prefix collision at merge | MERGE-PENDING; free retry next run |
| Environment-sensitive gate fails | Reported, surfaces at PR review; never blocks |
| Guardian FIX-BEFORE-SHIP | No PR (unless `--open-pr-on-override`; override recorded in PR body) |
| Agent idle timeout / transient provider error | Bounded infrastructure retries; never classified as candidate failure |
| `afk stop` / Ctrl-C / crash | CANCELLED (or CRASHED) records written; resume continues; restarts never destroy unmerged commits |

A failed dependency holds its dependents. A parked (adjudication) slice
holds only its dependents; other lanes continue.

## Concurrent PRD Runs

Two PRDs may run on one machine when all four hold:

1. **One clone per run** — separate clones, not just worktrees; two
   orchestrators' merge mutexes cannot see each other.
2. **Migration prefixes reserved per PRD** — disjoint `afk.json` pools
   (`to-afk` allocates non-overlapping ranges).
3. **Acceptable overlap** — check the two ticket sets' file hints first; the
   second merger pays a rebase over the first.
4. **Tickets linted** — both PRDs, before launch.

Environment-sensitive gates (wall-clock budgets) are advisory in pipeline
context, so concurrent suites cannot burn rounds on machine load.

## Backend Comparison

| Backend | Strengths | Trade-offs |
|---------|-----------|------------|
| Kiro | Default; persona-rich agent configs | Opaque stream — no cost/tool-call stats |
| Claude Code | Streamed JSON; cost + tool calls in run-summary | Requires `claude` CLI auth |
| Codex | Ephemeral JSONL; prompt-only guardians; tool-call stats | Managed CLI auth; fixed model |

All backends share the orchestrator, context-envelope assembly, artifact
formats, and DAG semantics: the same logical envelope (included artifact
classes, order, IDs) is produced regardless of provider. Failures never
trigger provider fallback.

## Setting Up a Project for AFK

1. `pnpm add -D git+https://github.com/EricOliveira90/afk-pipeline.git`
2. `package.json` scripts: `typecheck`, `lint`, `test:related`, `test:full`
   (or a single `test` — the split is what makes rounds cheap).
3. `CONTEXT.md` at repo root (glossary and domain terms).
4. `ARCHITECTURE.md` — modules, hubs, seams, placement rules (~150 lines).
5. `afk.config.json` — declare hub files and shared resources as
   `resourceKeys`.
6. `docs/adr/` with sentence titles (agents receive the title index).
7. Author the PRD (`to-spec`), slice it (`to-tickets`), lint the tickets.
8. Prepare the run with `to-afk` (scope, prefixes, committed `afk.json`).
9. `npx afk --prd-dir .kiro/specs/<slug> --dry-run` to preview waves, lanes,
   and bounds; then launch — ideally via the `$babysit-afk` prompt `to-afk`
   returns, so escalations get couriered while you are away.

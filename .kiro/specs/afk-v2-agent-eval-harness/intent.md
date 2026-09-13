# Intent: PRD 7 — agent-behavior eval harness

**Status:** draft, prepared for a maintainer session. Not approved. No spec,
no tickets, and no **AFK manifest** exist yet for this PRD.
**GH issue:** #152 (PRD parent).
**Approved source intent:** `docs/intent/agent-eval-harness.intent.md`
(founder, 2026-09-02). That file is the recorded decision; this file expands
it to PRD scope and does not replace or contradict it.
**Parent design:** `docs/specs/afk-v2-plan.md` §2 (PRD 7 row), §3d item 18,
§4 sequencing, §6 standing triggers. Rescoped 2026-09-12 by
`afk-v2-plan-debate.md` §7 (rulings R1–R3 of `decisions-review.md` in this
directory): the learning-proposal schema is no longer this PRD's
deliverable.
**Vision:** `docs/PRODUCT.md` — "Evidence over argument", "Measurements are
never gates until proven stable", "No merge-gating on agent-eval results".
**Cross-repo counterpart:** rumo-app #809 (closed, shipped) and
`rumo-app/docs/prds/governance-evals/intent.md` (deferred until this runner
exists).
**Written:** 2026-09-12.

Companion: `decisions.md` in this directory lists every load-bearing
decision the spec must settle, and `decisions-review.md` is the independent
review whose rulings this file now reflects. Read both before writing the
spec. They exist
because PRD 4's slices escalated `LOAD_BEARING_SILENCE` repeatedly on
exactly the class of thing this PRD is full of — persisted schema versions
and public type shapes.

## Problem

AFK regression-tests its orchestrator code exhaustively. It does not test
its agents' behavior at all.

A change to `prompts/`, to `agents/`, or to envelope assembly policy is
verified only by the next live PRD run. That is the most expensive feedback
signal the project has: a run costs hours, spends model calls, and reports
the defect as a burned **round** rather than as a failed check. Run 5 spent
8 generator commits on one steering defect. PRD 4's run exposed three more
of the same shape (#192, #194, and the #196 assembly overflow): a role
reasoning from an assumption the repository had already settled.

The pipeline therefore cannot answer two questions a maintainer asks before
every prompt change:

1. Would this change have altered the **verdict** on a case we already know
   the right answer to?
2. Does this change fix the incident it was written for?

Today both answers cost a live run.

## Who it serves

- **The AFK maintainer**, before a prompt, agent-config, or envelope-policy
  change merges. Primary reader of the report.
- **Consuming projects**, which own their own scenario packs. rumo-app's
  governance pack is deferred *specifically* until this runner exists.

Not for external adopters. `docs/PRODUCT.md` keeps adoption by others out of
scope until v2 is complete. PRD 6's item 19 is no longer a reader of this
PRD: the learning-proposal schema it consumes lands by hand on `main`
(`afk-v2-plan-debate.md` §7, R1).

## Outcome

A separate `afk eval` runner, plus a versioned scenario-pack schema.

The runner replays cases against agent roles and compares the role's
structured output against the recorded expectation. One case kind:

- **Prompt-plus-expected-verdict cases.** A prompt — the exact string
  `AgentProvider.invoke` receives — the files the role reads from disk, the
  verdict a correct role must produce, and a required `source` citing the
  issue, run or artifact the case came from. A case whose prompt text was
  recorded from a real run is this kind with a `source` naming the run; it
  is not a second kind (`decisions-review.md` R2, H1). rumo-app's governance
  scenarios are expressible in the same shape.

AFK owns the runner and one seeded pack. Consuming projects own their packs.

## Success measures

Measurable, and each one checkable without a live PRD run:

1. A maintainer can check a prompt change before launching a run: one
   command, a per-case comparison report, exit status independent of the
   pass rate.
2. **Every case cites a source** — the issue, run or artifact it came from
   — and a case with no `source` is refused, not skipped. The AFK-owned
   pack holds as many cases as the verified sources yield (#192, #194,
   run 5's steering defect, PRD 4's archived evaluator verdicts; roughly
   5–15 for v1) and grows from incidents. There is no target count
   (`decisions-review.md` R3).
3. A run stopped by the model-call cap reports `INCOMPLETE` and reports no
   pass rate. A partial result is never presented as a result.
4. **Zero** deterministic gates, **zero** pre-ship checks and **zero** merge
   paths read an eval result. Verifiable by grep, and worth a test.

The former measure 5 (the learning-proposal schema validates a document
rumo-app's findings ledger can produce) moved out with the schema
(`afk-v2-plan-debate.md` §7, R1) and is verified where that module lands.
The former measure 6 collapsed into measure 2.

## Constraints inherited, not negotiable in this PRD

Each one is already a recorded decision. A slice that needs to break one
escalates as a **spec contradiction** under plan §3c policy 1 — it does not
decide.

| Constraint | Source |
|---|---|
| Results never gate a merge. Report-only. | `docs/PRODUCT.md` "What AFK is not"; plan §3 and §6. Re-opens only on repeated evidence of stable results with an agreed false-positive rate. |
| Compare exact structured output in v1. No model-based grader. | Source intent "Resolved decisions"; plan §3d item 18. |
| Enforce a model-call cap; report `INCOMPLETE` when it stops a run. | Source intent; item 18. |
| Runs are weekly and operator-invoked. No CI schedule. | Item 18. CI scheduling waits for item 21's filtered-environment pattern (#135). |
| AFK owns the runner; consumers own packs. | Source intent; rumo-app governance-evals intent, which explicitly declines to build a runner. |
| Reuse the recorded envelope format. Do not invent a parallel fixture format. | Source intent "Constraints and non-goals". Read per `decisions-review.md` R2/H1: no envelope file format exists, so the case input is the exact `AgentProvider.invoke` prompt string and the runner dispatches through `AgentProvider.invoke`. |
| Provider-agnostic at the interface. | ADR 0002; `docs/PRODUCT.md` principle 9. A replay path plugs in at `AgentProvider`, not inside a provider. |
| Deterministic checks live in the gate catalog, never in provider hook config. | Plan §3c policy 6; PRODUCT.md principle 9. |
| A new persisted fact carries a schema version and a reader. | `ARCHITECTURE.md` placement rules. A record no reader checks is decoration (plan §3 item 11). |
| New machinery defaults off, opt-in, with enable/disable recorded. | PRODUCT.md principle 7. |
| Nothing adds minutes to the happy path. | PRODUCT.md principle 4. `afk eval` runs outside a pipeline run, so its cost must not touch one. |
| A new deterministic check is a declared gate, not prompt prose; new behavior extends a seam, not a hub. | `ARCHITECTURE.md`. `src/orchestrator.ts` and `src/wave.ts` do not grow for this. |
| The learning-proposal schema is AFK-canonical and lands by hand on `main`, not in this PRD; its fields change only by an AFK version bump coordinated with rumo-app. | `afk-v2-plan-debate.md` §7 (R1); plan §2 PRD 6 row, §3d item 19, §6. |
| A new spawned pipeline scenario is the last-resort test. | `AGENTS.md`, `CLAUDE.md`, ADR 0063. Eval scenarios are not pipeline spawns and must not become them. |

## Out of scope

- **Merge gating on results.** Recorded "no". Its re-open trigger is in
  plan §6.
- **A model-based grader**, similarity scoring, or any fuzzy match. v1
  compares exactly.
- **CI scheduling.** Blocked on item 21.
- **Consumer scenario packs.** rumo-app owns its governance pack. This PRD
  ships the runner, the scenario-pack schema, and AFK's own pack.
- **The learning-proposal schema.** Hand-landed on `main` under R1; item
  19's classifier similarity stays out of scope there too.
- **New provider surface.** PRODUCT.md forbids speculative provider
  features. If replay needs something no live backend needs, that is a
  decision, not an implementation detail.
- **OS sandboxing, network allowlists, containers.** Not a CI system.
- **Retroactive mining** of every past run into scenarios. The seed set is
  what the named sources yield; the pack grows from incidents, not from
  archaeology.
- **Auto-repair.** The runner reports a mismatch. It does not propose or
  apply a prompt fix. Proposals are item 19's job, in PRD 6.
- **Grading the pipeline's own control flow.** `afk eval` checks agent
  output, not orchestrator behavior. The existing suites own that.

## Plan placement and sequencing

PRD 7 depends on PRD 4, which merged (`dbd6fdc`). It may run concurrently
with PRD 5 under plan §3c policy 5's four conditions — one clone per run,
migration prefixes reserved at prep time, checked file-hint overlap, linted
tickets.

PRD 7 is off the critical path. PRD 6 depends on PRD 4 and on the
hand-landed learning-proposal module, not on PRD 7
(`afk-v2-plan-debate.md` §7, R1). PRD 5 and PRD 7 are both concurrent
after PRD 4; a delay in either delays only itself. The learning-proposal
schema is therefore no longer this PRD's first slice, and nothing in this
PRD needs another repository's agreement before a ticket exists.

## What the next session must produce

This file, `decisions.md` and `decisions-review.md` are the whole current
deliverable. The maintainer session that follows owes:

1. Every `decisions.md` item marked **maintainer must decide** answered, and
   every **defensible default** either confirmed or replaced —
   `decisions-review.md` §3–§4 carry the recommended answers and
   `afk-v2-plan-debate.md` §7 records the accepted R1–R3.
2. The learning-proposal schema is **not** negotiated here: it lands by hand
   on `main` as an AFK-canonical module (`decisions-review.md` D25–D29,
   H3 amended). rumo-app is told by an issue citing that module; its
   shipped ledger stays as it is.
3. A `prd.md` in this directory in PRD 4's form — a settled-decisions
   document whose stated purpose is to leave the planner no load-bearing
   decision to discover.
4. `issues.md` with the slice DAG, linted with the item 6 ticket lint before
   any launch.
5. An `afk.json` **AFK manifest** with `selectedSlices` and a reserved
   **migration reservation pool**, written by `to-afk`.

## Vocabulary note

`CONTEXT.md` defines **verdict** (the evaluator's ACCEPT/REVISE and
PASS/FAIL), **agent failure cause**, **kill class**, and **failure class**.
It does **not** define "disposition" or "envelope", although plan §3d and
the source intent use both freely. "Disposition" already has two other
live meanings: AFK's own `GuardianFindingDisposition`
(`OPEN | RESOLVED | REPEATED | REOPENED | REGRESSED`, `src/artifacts.ts`)
for a guardian finding's lifecycle, and rumo-app's findings-ledger routing
outcome (`none | proposal opened | eval-candidate`). This PRD therefore says
**verdict** for an agent's structured output — decided, `decisions.md` D36
as ruled in `decisions-review.md` §3 — and nothing `afk eval` emits or
documents says "disposition". Plan §3d item 18 now reads
`prompt-plus-expected-verdict`.

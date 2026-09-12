# Intent: PRD 7 — agent-behavior eval harness

**Status:** draft, prepared for a maintainer session. Not approved. No spec,
no tickets, and no **AFK manifest** exist yet for this PRD.
**GH issue:** #152 (PRD parent).
**Approved source intent:** `docs/intent/agent-eval-harness.intent.md`
(founder, 2026-09-02). That file is the recorded decision; this file expands
it to PRD scope and does not replace or contradict it.
**Parent design:** `docs/specs/afk-v2-plan.md` §2 (PRD 7 row), §3d item 18,
§3d item 19 (the consumer of this PRD's shared schema), §4 sequencing, §6
standing triggers.
**Vision:** `docs/PRODUCT.md` — "Evidence over argument", "Measurements are
never gates until proven stable", "No merge-gating on agent-eval results".
**Cross-repo counterpart:** rumo-app #809 (closed, shipped) and
`rumo-app/docs/prds/governance-evals/intent.md` (deferred until this runner
exists).
**Written:** 2026-09-12.

Companion: `decisions.md` in this directory lists every load-bearing
decision the spec must settle. Read it before writing the spec. It exists
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
- **PRD 6's item 19**, which consumes this PRD's versioned
  learning-proposal schema and cannot start until that schema is fixed.

Not for external adopters. `docs/PRODUCT.md` keeps adoption by others out of
scope until v2 is complete.

## Outcome

A separate `afk eval` runner, plus a versioned scenario-pack schema.

The runner replays recorded cases against agent roles and compares the
role's structured output against the recorded expectation. Two case kinds:

- **Recorded-envelope cases.** Replay a real assembled envelope from a past
  run and compare the role's structured verdict.
- **Prompt-plus-expected-verdict cases.** A written prompt and the verdict a
  correct role must produce. This kind exists because rumo-app's governance
  scenarios cannot be expressed as recorded AFK envelopes; its intent file
  raises that as an open question and item 18 answers it by supporting both
  kinds.

AFK owns the runner and one seeded pack. Consuming projects own their packs.

The runner also defines the versioned **learning-proposal** schema that
PRD 6's item 19 writes and rumo-app's Close learning pass produces.

## Success measures

Measurable, and each one checkable without a live PRD run:

1. A maintainer can check a prompt change before launching a run: one
   command, a per-case comparison report, exit status independent of the
   pass rate.
2. The AFK-owned pack holds **20–50 scenarios**, each traceable to a
   recorded source: a PRD 1 envelope, a #111–#121 reliability-wave incident,
   or an evaluator or classifier verdict case.
3. A run stopped by the model-call cap reports `INCOMPLETE` and reports no
   pass rate. A partial result is never presented as a result.
4. **Zero** deterministic gates, **zero** pre-ship checks and **zero** merge
   paths read an eval result. Verifiable by grep, and worth a test.
5. The learning-proposal schema validates a document that rumo-app's
   already-shipped findings ledger can produce, with no field rumo-app
   cannot fill.
6. Every scenario names the recorded incident or run artifact it came from.
   A scenario with no source is not admitted.

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
| Reuse the recorded envelope format. Do not invent a parallel fixture format. | Source intent "Constraints and non-goals". |
| Provider-agnostic at the interface. | ADR 0002; `docs/PRODUCT.md` principle 9. A replay path plugs in at `AgentProvider`, not inside a provider. |
| Deterministic checks live in the gate catalog, never in provider hook config. | Plan §3c policy 6; PRODUCT.md principle 9. |
| A new persisted fact carries a schema version and a reader. | `ARCHITECTURE.md` placement rules. A record no reader checks is decoration (plan §3 item 11). |
| New machinery defaults off, opt-in, with enable/disable recorded. | PRODUCT.md principle 7. |
| Nothing adds minutes to the happy path. | PRODUCT.md principle 4. `afk eval` runs outside a pipeline run, so its cost must not touch one. |
| A new deterministic check is a declared gate, not prompt prose; new behavior extends a seam, not a hub. | `ARCHITECTURE.md`. `src/orchestrator.ts` and `src/wave.ts` do not grow for this. |
| The learning-proposal schema's fields require cross-repo coordination to change. | Plan §2 PRD 6 row, §3d items 18–19, §6. |
| A new spawned pipeline scenario is the last-resort test. | `AGENTS.md`, `CLAUDE.md`, ADR 0063. Eval scenarios are not pipeline spawns and must not become them. |

## Out of scope

- **Merge gating on results.** Recorded "no". Its re-open trigger is in
  plan §6.
- **A model-based grader**, similarity scoring, or any fuzzy match. v1
  compares exactly.
- **CI scheduling.** Blocked on item 21.
- **Consumer scenario packs.** rumo-app owns its governance pack. This PRD
  ships the runner, the schema, and AFK's own pack.
- **Classifier similarity** for finding classes. Out of scope for item 19's
  v1 and therefore for the schema this PRD fixes.
- **New provider surface.** PRODUCT.md forbids speculative provider
  features. If replay needs something no live backend needs, that is a
  decision, not an implementation detail.
- **OS sandboxing, network allowlists, containers.** Not a CI system.
- **Retroactive mining** of every past run into scenarios. The seed set is
  bounded at 20–50 and drawn from the three named sources.
- **Auto-repair.** The runner reports a mismatch. It does not propose or
  apply a prompt fix. Proposals are item 19's job, in PRD 6.
- **Grading the pipeline's own control flow.** `afk eval` checks agent
  output, not orchestrator behavior. The existing suites own that.

## Plan placement and sequencing

PRD 7 depends on PRD 4, which merged (`dbd6fdc`). It may run concurrently
with PRD 5 under plan §3c policy 5's four conditions — one clone per run,
migration prefixes reserved at prep time, checked file-hint overlap, linted
tickets.

PRD 7 is on the critical path. **PRD 6 launches only after PRD 7 merges**,
because item 19 consumes the learning-proposal schema. PRD 5 is concurrent
and off the critical path. A delay here delays the v2 endgame; a delay in
PRD 5 does not.

One consequence for slicing: the learning-proposal schema is the critical
path *inside* this PRD too. It is the smallest deliverable and it unblocks
the most. It should not sit behind the runner's plumbing.

## What the next session must produce

This file and `decisions.md` are the whole current deliverable. The
maintainer session that follows owes:

1. Every `decisions.md` item marked **maintainer must decide** answered, and
   every **defensible default** either confirmed or replaced.
2. The learning-proposal schema agreed **with rumo-app**, in writing, in
   both repositories. rumo-app #809 is already closed and shipped, so this
   is a negotiation against an existing artifact, not a greenfield design.
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
the source intent use both freely, and rumo-app's shipped findings ledger
already uses "disposition" for something else entirely — a ledger entry's
routing outcome (`none | proposal opened | eval-candidate`). This file
therefore says **verdict** for an agent's structured output and flags the
naming as a decision (`decisions.md`, D14). PRD 7 must not ship a third
meaning of the word.

# A planner revision round names its pair

**Status:** Accepted
**Date:** 2026-09-12

Issue #265 (rumo-app self-runs, PRD 7 slice #262 `run-20260912-045140` and
PRD 5 slice #87 `run-20260912-044640` / `run-20260912-051355`). Each slice
wrote a contract the evaluator reviewed, drew `REVISE`, and then died at
`CONFIGURATION` — "Planner prompt exceeds inline-size budget" — before the
planner could revise anything. A slice was blocked not by its contract's
quality but by having drawn any revision round at all on a pair over ~34 KB.

The per-artifact-class byte breakdown ADR 0062 decision 4 added to the
overflow error made the diagnosis immediate this time:

| Run | Actual | `current-contract-pair` inlined |
|---|---|---|
| PRD 7 #262 `run-20260912-045140` | 87,482 | 55,892 (contract.md 26,791 + acceptance-manifest.json 29,101) |
| PRD 5 #87 `run-20260912-044640` | 83,744 | 47,777 |
| PRD 5 #87 `run-20260912-051355` | 75,247 | 45,872 |

`assemblePlannerRevisionEnvelope` rendered `prompts/planner-revision.md` with
both files of the current pair interpolated as fenced copies under
`# Current contract pair`. The planner runs in the slice's worktree, where both
files already exist at the paths the prompt names in its write boundary. The
copy added nothing the planner could not open itself, and it made the revision
prompt scale with the size of the pair rather than with the size of the
revision.

This is the third instance of one defect. #196 was the contract evaluator
inlining the pair (ADR 0062 decision 2); #230 was the generator repair round
quoting `stuck.md` and `handoff.md` it already carried by reference. The
planner revision round was the remaining envelope that copied a worktree file
into the prompt.

## Decision

**ADR 0062 decision 2 extends to the planner revision round: the current
contract pair travels by reference.** `prompts/planner-revision.md` names
`{{SLICE_DIR}}/contract.md` and `{{SLICE_DIR}}/acceptance-manifest.json` and
requires the round to read both files in full before revising, as
`prompts/evaluator-contract.md` and `prompts/evaluator-contract-revision.md`
already do for the evaluator. The `current-contract-pair` class stays declared
in `PLANNER_CONTEXT_MANIFEST` and both files are still recorded in the
envelope evidence, each carrying the same `CONTRACT_PAIR_BY_REFERENCE`
`locatorExemption` the evaluator rounds use, so the omission is in the run
evidence rather than silent.

The mechanics are exactly the evaluator's, and nothing else moves:

- The manifest's input order, accepted classes and `inlineSizeBudgetBytes`
  (65,536) are unchanged. The budget is **not** raised, for ADR 0062's reason:
  a budget that has to grow to hold a whole copy of an artifact is measuring
  the copy, not the discipline. A budget setter is #161 and separate.
- The overflow breakdown is unchanged in shape. The pair now appears under
  "by reference" instead of among the inlined weights, so the next babysitter
  reading an overflow is not sent looking for bytes that are no longer there.
- `currentContract` and `currentAcceptanceManifest` stay on
  `PlannerRevisionEnvelopeInput`, unrendered, the way `proposedContract` stays
  on the evaluator's input. Every caller already reads and passes them; moving
  that seam is not this change's job.
- The planner round-1 envelope (`planner.md`), the evaluator envelopes and the
  generator envelopes are untouched.

Reference, not omission: the planner has file tools and already must write the
same two files, so the capability is not in question. The discipline is a
prompt instruction rather than a mechanical guarantee, which is the same cost
ADR 0062 recorded for the evaluator.

## Consequences

- A planner revision prompt no longer scales with the size of the contract
  pair. The #262-shaped fixture in `src/context-envelope.test.ts` — a 62,845-
  byte pair, 11,144 bytes of open findings, a control-plane objection, the gate
  catalog and the repository's ADR index and ARCHITECTURE.md blocks — assembles
  at 37,017 bytes with every non-pair block whole. Under the previous envelope
  the same inputs were about 100,000 bytes.
- Contract revision is no longer self-contained: a planner that does not read
  the two named files revises from the findings alone, or from its memory of
  an earlier round, and rewrites terms the findings never touched. The prompt
  says so in as many words. This is the cost of the decision, recorded rather
  than discovered.
- A `REVISE` on a large contract is now a revision round, not a slice death.
  Both PRD 5 and PRD 7 can resume from the round that failed.
- Cites ADR 0062 (the decision this extends and the byte breakdown that
  diagnosed it) and #230 (the same defect on the generator repair path).

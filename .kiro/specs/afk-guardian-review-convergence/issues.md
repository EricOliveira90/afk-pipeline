# Guardian review convergence - Slice Index

**Parent PRD:** TBD - see `prd.md` in this directory.

| Slice | GH Issue | Title | Status | Blocked by | User stories covered |
|-------|----------|-------|--------|------------|----------------------|
| 01 | TBD | Every guardian round is recorded, blocked ones included | Deferred until after PRD 3 | - | US-1 |
| 02 | TBD | Later architect reviews use prior-round evidence | Deferred; delta-only design not approved | 01 | US-2, US-3 |
| 03 | - | A blocking finding states impact, recovery, and attribution | Landed by hand on `integration/pre-prd3` | - | US-4 |
| 04 | TBD | A bounded gate and a symmetric override | Override landed; automatic cap deferred | 01 | US-5, US-6 |
| 05 | TBD | A note that ships unfixed is filed once | Deferred until after PRD 3 | 04 | US-7 |

## Current cut

- Slice 03 landed by hand.
- The override half of slice 04 landed by hand.
- Slices 01, 02 and 05 remain deferred.
- The automatic-cap half of slice 04 remains deferred.
- PRD 3 supplies the next evidence before any deferred design returns.

## Before this runs

Do not launch this PRD before PRD 3 completes one measured guardian run. After
that decision, the remaining work still needs:

- **Every deferred GH issue number is `TBD`, including the parent.** Creating
  issues is an outward-facing action this spec session was not authorized to
  take. File five issues (one parent, four deferred slices), then replace all
  five `TBD`s. `pnpm lint:tickets <issue>...` (ADR 0049) runs on them first.
- **The `Blocked by` column names slice numbers, not issue numbers.** The DAG
  parser keys on issue numbers, so `01` and `04` must become `#<n>` once the
  issues exist.
- **The ADR number is provisional.** `0056` is the next free number across
  current repository history as of 2026-08-31. Re-check it when the deferred
  work starts.

## Landed by hand

- Slice 03 policy: `prompts/architect-review.md`.
- Slice 04 override half: `src/ship-gate.ts`, its focused tests, and the
  amendment to ADR 0015.
- Related live defect #149: `src/orchestrator.ts` rejects a planner-authored
  lock when the evaluator returns `REVISE`.

## Provenance

All of this PRD's evidence is committed history in this repo, not reconstructed
narrative:

- Nine rounds of guardian artifacts under
  `.kiro/specs/afk-v2-routing-adjudication/` — round 1 `076540c`, then
  `74dfb34`, `86a2896`, `4c665ab`, `5521e3f`, round 6 `d80fc61`, `88174b9`,
  round 8 `274f859`, and round 9 `2000b34`. Four earlier complete pairs
  (`770bb20`, `06a4e2f`, `f9cdf89`, `672d53d`, 2026-08-29) belong to a
  previous run. PM-only rerun `516e6c2` is not a complete pair.
- The `main`-side origin of round 8's finding A2: commit `32df84b`, 2026-08-22,
  with the lock-before-gate ordering live on `main` today at
  `src/orchestrator.ts:2284` and `:2291`.
- `.kiro/specs/afk-v2-run-state-lock-and-adoption/prd.md` (commit `15376d0`) —
  the excision of PRD 2's slice 06 after round 6's A1, and the prior instance of
  this same loop being resolved by removing scope rather than by the gate
  clearing.

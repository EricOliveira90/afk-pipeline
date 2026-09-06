# Guardian review convergence - Slice Index

**Parent PRD:** no parent issue filed — the approved design is
`docs/adr/0057-guardian-review-rounds-converge.md` (PR #169, merged
2026-09-06). Slice issues are #170–#174, one per ADR 0057 decision.

| Slice | GH Issue | Title | Type | Blocked by | User stories covered |
|-------|----------|-------|------|------------|----------------------|
| 01 | #170 | Every review round is recorded, blocked ones included | AFK | — | US-1 |
| 02 | #171 | Architect rounds 2+ verify the fix diff against prior findings' clear conditions | AFK | #170 | US-2, US-3 |
| 03 | #172 | Blocking findings need a reachable trigger; new findings in later rounds report-but-don't-block | AFK | — | US-4 |
| 04 | #173 | Hard round cap with recorded cap exit; verify symmetric override | AFK | #170 | US-5, US-6 |
| 05 | #174 | A note that ships unfixed is filed exactly once | AFK | #173 | US-7 |

## Expected wave structure

- **Wave 1:** #170 (round ledger) and #172 (rubric floor) — no code edges.
- **Wave 2:** #171 (delta-scoped rounds 2+) and #173 (cap + override exit),
  both blocked by #170. Both touch `src/ship-gate.ts`; the lane partitioner
  will serialize them into one lane. Expected, not a problem.
- **Wave 3:** #174 (notes filed once), blocked by #173 (reuses its
  finding-to-issue filing path).

## Why the cut falls here

- **01 before 02 and 04.** Both consuming slices need the same thing that does
  not exist today: a persisted record of an *unfavorable* round.
  `PersistedReviewResult` is typed `"SHIP" | "ACCEPT-WITH-NOTES"` and
  `sanitizeReviewResult` (`src/run-state.ts`) drops everything else, so
  the storage change is not a field addition — it amends an explicit ADR 0015
  rule (per ADR 0057 decision 1: the favorable-only *cache* stays; the
  *ledger* records everything) and needs its own sanitizer, its own tolerance
  for old state files, and its own tests. 01 also stands alone: it makes the
  round-over-round history readable, which for PRD 2 took a `git log` over the
  guardian artifact history to reconstruct by hand.
- **02 is separate from 01** because it is a different seam. 01 is
  `src/run-state.ts`; 02 is the prompt-render call in `src/ship-gate.ts`
  plus new template variables in `prompts/architect-review.md`. Nothing in
  02 changes storage, and 01 ships value without it.
- **03 is independent and parallelizable.** It is a rubric change to
  `prompts/architect-review.md` (ADR 0057 decision 3) with a mechanical
  assertion on the finding disposition. It touches neither the state file nor
  the PR decision, so it has no edge to 01, 02 or 04 and runs in wave 1.
- **04 holds the cap and the recorded exit in one slice** because they are
  conditions on the same expression — `open` in `buildPrCreationPlan`
  (`src/ship-gate.ts`) — and share the PR-body note, the run-summary line and
  the exit-signal carve-out. The symmetric override itself already landed by
  hand (ADR 0015's 2026-08-31 amendment); #173 verifies it and wires the cap
  exit through the same plumbing.
- **05 after 04** because 04 introduces the finding-to-issue filing path (for
  unresolved blockers at the cap) and 05 reuses it (for notes at ship). Building
  the filer twice, or building it in 05 and having 04 wait, both cost more.
- **The rubric floor is not merged into the delta-scoping slice** even
  though both are prompt edits, because they fail differently. Delta scoping is
  a mechanical win regardless of whether the findings were right; the floor is a
  policy judgement about which findings should block. Keeping them separate means
  a rollback of the policy does not roll back the efficiency fix.
- **No slice adds a spawned pipeline scenario.** See the PRD's Testing Decisions
  and AGENTS.md's "where a new assertion goes".

## Launch checklist — resolved 2026-09-06

The three blockers this file used to list are closed:

- **Issue numbers:** #170–#174 filed, mapped 01–05 above. No parent issue was
  filed; ADR 0057 is the anchoring design. `pnpm lint:tickets 170 171 172 173
  174` (ADR 0049) runs before launch.
- **`Blocked by` uses issue numbers** (the DAG parser's key), not slice
  numbers.
- **The ADR number resolved to 0057**, merged via PR #169. The PRD's
  provisional `0056` was taken on `main` by the run-state-lock ADR; `0058` is
  taken by the teardown sidecar sweep (issue #166).
- The PRD-3 measured-run precondition is satisfied: `afk-v2-context-envelopes`
  ran the gate for seven rounds (fix commits listed in ADR 0057's Context) and
  merged via PR #160.
- `afk.json` in this directory selects all five slices; no migrations, so no
  prefix reservation.

## Landed by hand (pre-ADR 0057)

- Slice 03's precursor policy: findings state impact, recovery, and diff
  attribution (`prompts/architect-review.md`).
- Slice 04's override half: the symmetric one-favorable-guardian override in
  `src/ship-gate.ts`, its focused tests, and the amendment to ADR 0015.
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
- PRD 2 itself merged to `main` via hand-opened PR #150 (2026-09-04) after
  round 9 ended with both guardians blocking — the loop was exited by operator
  decision, not by the gate clearing. PRD 3's seven-round gate (PR #160,
  merged 2026-09-05) is the second measurement, recorded in ADR 0057.

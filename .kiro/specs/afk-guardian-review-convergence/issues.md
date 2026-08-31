# Guardian review convergence - Slice Index

**Parent PRD:** TBD - see `prd.md` in this directory.

| Slice | GH Issue | Title | Type | Blocked by | User stories covered |
|-------|----------|-------|------|------------|----------------------|
| 01 | TBD | Every guardian round is recorded, blocked ones included | AFK | - | US-1 |
| 02 | TBD | The architect's later rounds review only what changed | AFK | 01 | US-2, US-3 |
| 03 | TBD | A blocking finding names a reachable trigger | AFK | - | US-4 |
| 04 | TBD | A bounded gate: round cap and a symmetric override | AFK | 01 | US-5, US-6 |
| 05 | TBD | A note that ships unfixed is filed once | AFK | 04 | US-7 |

## Why the cut falls here

- **01 before 02 and 04.** Both consuming slices need the same thing that does
  not exist today: a persisted record of an *unfavorable* round.
  `PersistedReviewResult` is typed `"SHIP" | "ACCEPT-WITH-NOTES"` and
  `sanitizeReviewResult` (`src/run-state.ts:93-104`) drops everything else, so
  the storage change is not a field addition — it reverses an explicit ADR 0015
  rule and needs its own sanitizer, its own tolerance for old state files, and
  its own tests. 01 also stands alone: it makes the round-over-round history
  readable, which for PRD 2 took a `git log` over twelve commits of a docs
  artifact to reconstruct by hand.
- **02 is separate from 01** because it is a different seam. 01 is
  `src/run-state.ts`; 02 is the prompt-render call at `src/ship-gate.ts:519`
  plus two new template variables in `prompts/architect-review.md`. Nothing in
  02 changes storage, and 01 ships value without it.
- **03 is independent and parallelizable.** It is a rubric change to
  `prompts/architect-review.md` principle 2 with a mechanical assertion in the
  finding disposition. It touches neither the state file nor the PR decision, so
  it has no edge to 01, 02 or 04 and can run in the first wave alongside 01 and
  03's own lane.
- **04 holds both escape valves in one slice** because the cap and the symmetric
  override are two conditions on the same expression — `open` in
  `buildPrCreationPlan` (`src/ship-gate.ts:284`) — and share the PR-body
  override note, the run-summary line and the exit-signal carve-out. Splitting
  them would mean two slices editing the same three call sites.
- **05 after 04** because 04 introduces the finding-to-issue filing path (for
  unresolved blockers at the cap) and 05 reuses it (for notes at ship). Building
  the filer twice, or building it in 05 and having 04 wait, both cost more.
- **The reachability floor is not merged into the delta-scoping slice** even
  though both are prompt edits, because they fail differently. Delta scoping is
  a mechanical win regardless of whether the findings were right; the floor is a
  policy judgement about which findings should block. Keeping them separate means
  a rollback of the policy does not roll back the efficiency fix.
- **No slice adds a spawned pipeline scenario.** See the PRD's Testing Decisions
  and AGENTS.md's "where a new assertion goes".

## Before this runs

Three things are deliberately unfilled and an AFK launch should refuse until
they are:

- **Every GH issue number is `TBD`, including the parent.** Creating issues is an
  outward-facing action this spec session was not authorized to take. File six
  issues (one parent, five slices), then replace all six `TBD`s. `pnpm
  lint:tickets <issue>...` (ADR 0049) runs on them first.
- **The `Blocked by` column names slice numbers, not issue numbers.** The DAG
  parser keys on issue numbers, so `01` and `04` must become `#<n>` once the
  issues exist.
- **The ADR number is provisional.** The PRD proposes `0056`; `0050`-`0055` are
  taken on PRD 2's unmerged branch and `0029` is duplicated on `main`. Re-derive
  the next free number across all branches before writing the file.

## Round 9 — PLACEHOLDER

**TBD (round 9).** Round 9 of `afk-v2-routing-adjudication` was running while
this spec was written. Record its architect verdict and blocking-finding count in
the PRD's Problem Statement placeholder before this PRD enters AFK. It does not
gate any slice; it is one more data point on a per-round finding series that
currently reads 3, 3, 2, 2, 3, 1, 1, 2.

## Provenance

All of this PRD's evidence is committed history in this repo, not reconstructed
narrative:

- Eight rounds of guardian artifacts under
  `.kiro/specs/afk-v2-routing-adjudication/` — round 1 `076540c`, then
  `74dfb34`, `86a2896`, `4c665ab`, `5521e3f`, round 6 `d80fc61`, `88174b9`,
  round 8 `274f859`. Four earlier pairs (`770bb20`, `06a4e2f`, `f9cdf89`,
  `672d53d`, 2026-08-29) belong to a previous run of the same PRD and are not
  counted in the eight.
- The `main`-side origin of round 8's finding A2: commit `32df84b`, 2026-08-22,
  with the lock-before-gate ordering live on `main` today at
  `src/orchestrator.ts:2284` and `:2291`.
- `.kiro/specs/afk-v2-run-state-lock-and-adoption/prd.md` (commit `15376d0`) —
  the excision of PRD 2's slice 06 after round 6's A1, and the prior instance of
  this same loop being resolved by removing scope rather than by the gate
  clearing.

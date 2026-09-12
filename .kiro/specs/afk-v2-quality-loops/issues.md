# AFK v2 Quality Loops - Slice Index

**Parent PRD:** #73 - see `prd.md` in this directory for the settled
decisions D1-D13, the file-scope map and the deferral of #92.

| Slice | GH Issue | Title | Type | Blocked by | User stories covered |
|-------|----------|-------|------|------------|----------------------|
| 01 | #87 | Cleaner loop | AFK | — | US-1, US-2, US-3, US-4, US-5, US-6, US-7, US-8, US-16, US-20 |
| 02 | #92 | Hardener loop | AFK | #87 | US-9, US-10, US-11, US-12, US-13, US-14, US-15, US-19 (deferred) |
| 03 | #97 | Changed trees face final evaluation; ROI evidence | AFK | #87 | US-17, US-18, US-20 |

**Slice 02 (#92) is listed for numbering and is not selected.** Plan §2
defers #73 stories 9–15 and 19 (all hardener/mutation machinery) and plan
§4 runs "PRD 5 (cleaner only, default-off, story 17 ROI experiment)".
`afk.json` selects `01` and `03` only; `assertWithinManifestScope`
(`src/afk-manifest.ts`) refuses any dispatch outside that set. #92 stays
OPEN with its labels unchanged; see `prd.md` "Deferred".

#97's GH body originally listed `#92` under `Blocked by` and phrased two
criteria as "cleaner or hardener" / "cleaner-then-hardener". Both were
narrowed to the cleaner on 2026-09-12 to match the plan's scope, so the
DAG above and the body agree.

Titles are deliberately short. Branch and artifact directory names derive
from `slugify(title)`, and the guardian-convergence run died on Windows'
260-char path limit with longer ones. The full behavior statements live in
the GH issue titles and bodies, which the pipeline reads.

## Expected wave structure — and why it is serial

- **Wave 1:** #87 alone.
- **Wave 2:** #97, blocked by #87.

Both slices declare `src/orchestrator.ts` (the one call site each, per
ARCHITECTURE.md "Hubs"), so `partitionLanes` (`src/lanes.ts`) would union
them into one lane even inside a wave; the DAG already serialises them.
The shared files stack rather than conflict because #97's worktree is cut
from the feature tip after #87 merged:

- `src/cleaner-stage.ts` — 01 creates it (D2, D4, D8); 03 adds the
  `quality-stage-attempt` emission and the `repair` input (D11, D12).
- `src/run-events.ts` — 01 adds `quality-stage-policy` and widens
  `invocation-completed.role`; 03 adds `quality-stage-attempt`.
- `src/logger.ts` — 01 adds the `## Quality Stages` header line; 03 adds
  the per-slice rows and `readQualityStageOutcomes`.
- `src/final-evaluation.ts` — 01 adds `CLEANER_STAGE_ID`; 03 changes
  `routeFinalReviewFinding`'s input.
- `prompts/cleaner.md` — 01 creates it; 03 adds the restore variant text.
- `ARCHITECTURE.md` — each slice adds only its own rows.

The full matrix is the file-scope map in `prd.md`. **`afk.config.json` is
edited by neither slice**: it is a protected gate-policy path, and the
self-run keeps the cleaner off (plan item 8).

## Why the cut falls here

- **01 first.** It creates the stage, the gate, the policy member, the
  persisted record and the enable/disable event — everything 03 measures.
  It also stands alone: a cleaner that is off by default, correctly
  recorded as off, is a shippable increment even if 03 never lands.
- **03 after 01** because its two claims need a real writer: that a cleaner
  checkpoint forces a fresh final evaluation (D12) cannot be shown with the
  #96 stub without restating #96, and per-stage ROI rows (D11) need a stage
  that emits rounds. 03 is deliberately not folded into 01: the ROI
  evidence is the plan's stated deliverable for this PRD (§4 "story 17 ROI
  experiment"), and a separate slice keeps its file scope — `src/ship-gate.ts`,
  the `## Quality Stages` rows — out of the slice that changes gate evidence
  and run-state versions.
- **No slice adds a spawned pipeline scenario** without a comment saying
  why no existing fixture reaches the state. The fake-gate and
  stub-cleaner cases are `it`s on `src/qa-orchestration.test.ts` "final
  evaluation and reuse" (`prd.md` Testing decisions).

## Launch checklist

- `pnpm lint:tickets 87 97` — exits 0 with zero warnings, run 2026-09-12 on
  `docs/prd5-prep` after the #97 body edit. It prints three "waiver matched
  nothing" notes for #92, #93 and #95 — stale waivers from earlier PRDs.
  They are not these tickets' and they do not gate.
- `Blocked by` uses issue numbers, the DAG parser's key
  (`src/issues-parser.ts`), not slice numbers. The two waves above were
  derived from that parser against this table.
- PRD 4 is merged (#223 CLOSED); `POST_APPROVAL_WRITING_STAGE_ID`,
  `decideFinalReuse` and the `scope` gate's `role` source are on
  `origin/main` at `46f6c38`.
- `afk.json` here selects slices 01 and 03. No slice adds a migration
  (AFK has no SQL migrations), so `migrationPrefixes` stays empty; #73 is
  protected as OPEN so the run cannot close the parent while #92 is
  deferred. No `protectedChangeWaivers`: neither slice touches a protected
  path.
- Launch from a clone of this repository with the verification command
  explicit — `node <repo>/dist/afk-claude.js --prd-dir
  .kiro/specs/afk-v2-quality-loops --test-command "pnpm run typecheck &&
  pnpm test:fast"` after `pnpm build` — and confirm PRD 7's file hints do
  not name `src/orchestrator.ts`, `src/run-events.ts`, `src/logger.ts` or
  `src/ship-gate.ts` before launching concurrently (plan §3c policy 5).

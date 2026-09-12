# AFK v2 Agent-Behavior Eval Harness - Slice Index

**Parent PRD:** #152 - see `prd.md` in this directory for the settled
decisions D1-D36 (numbered as in `decisions.md`; D3-D5, D25-D30 and D37 are
closed by plan-debate §7 R1/R2 and are not restated), the file-scope map and
the concurrency note for PRD 5.

| Slice | GH Issue | Title | Type | Blocked by | User stories covered |
|-------|----------|-------|------|------------|----------------------|
| 01 | #262 | Eval runner | AFK | — | US-1, US-2, US-3, US-4, US-5 |
| 02 | #263 | Eval seed pack | AFK | #262 | US-1, US-2, US-6 |
| 03 | #264 | Prompt recorder | AFK | — | US-1 |

Story numbers are #152's. US-6 is read through plan-debate §7 R3: the seed
pack holds what #192, #194, run 5's steering defect and PRD 4's archived
evaluator verdicts yield (roughly 9–14 cases), not 20–50, and none of it comes
from PRD 1 envelopes or the #111–#121 incidents (`decisions-review.md` H1, H2).
#152's learning-proposal items are R1's and belong to
`feat/learning-proposal-schema` (ADR 0066), not to any slice here.

Titles are deliberately short. Branch and artifact directory names derive
from `slugify(title)`, and the guardian-convergence run died on Windows'
260-char path limit with longer ones. The full behavior statements live in
the GH issue titles and bodies, which the pipeline reads.

## Expected wave structure

- **Wave 1:** #262 and #264, both unblocked.
- **Wave 2:** #263, blocked by #262.

Within wave 1, #262 and #264 both declare `src/afk.ts`, `src/afk-claude.ts`
and `src/afk-codex.ts` (the `eval` subcommand and the `--record-prompts`
flag respectively), so `partitionLanes` (`src/lanes.ts`) unions them into
**one lane**: contract negotiation runs in parallel, generation and merge are
serial. That is the expected shape. The shared edits stack because the
lane-mate's worktree is cut from the feature tip after its predecessor merged:

- the three CLI entries — 01 adds the `eval` branch and one usage line; 03
  adds the flag, the provider wrap and one usage line;
- `CONTEXT.md` — 01 adds **Envelope**, **Scenario pack**, **Eval case**,
  **Eval outcome**; 03 adds **Prompt record**;
- `ARCHITECTURE.md` — 01 adds the "Agent eval" row; 03 adds
  `src/prompt-recorder.ts` to the CLI entries row.

Neither #262 nor #263 touches `src/orchestrator.ts`, `src/wave.ts`,
`src/run-events.ts`, `src/logger.ts` or `src/ship-gate.ts`. #264 touches
`src/run-events.ts` (one optional field on `run-started`) and
`src/orchestrator.ts` (one optional `PipelineConfig` field and one property in
the `run-started` emission) and nothing else in either file — see
`prd.md` "Concurrency with PRD 5". The full matrix is `prd.md`'s file-scope
map.

## Why the cut falls here

- **01 first, and 02 behind it.** The runner creates the pack schema, the
  reader, the projection table, the report and the stub provider; the seed
  pack is a set of files validated by that reader and proven by that stub.
  Two slices writing the schema at once is the contract impasse PRD 4's
  slice 01 paid for. 01 also stands alone: a runner with only the refused
  fixture pack and the consumer fixture is a shippable, testable increment,
  and every one of its claims is unit-shaped.
- **02 is separate from 01** because its content is evidence work, not
  code: reconstructing prompts from archived artifacts, deciding which
  recorded verdicts a human confirmed, and citing each `source`. It changes
  no `src/*.ts` source file. Folding it into 01 would put the runner's
  contract at the mercy of an inventory that may yield nine cases or
  fourteen.
- **03 is independent** and deliberately tiny: one flag, one wrapper, one
  event field. It shares no code with the runner — it plugs in at
  `AgentProvider` (ADR 0002) in the CLI entries, and the runner reads packs,
  not recordings. It may run in wave 1 beside 01 or trail everything; it is
  the one slice that touches files PRD 5 also edits, and the second merger
  pays the rebase (plan §3c policy 5).
- **No slice adds a spawned pipeline scenario.** 01 and 02 are unit tests
  over the `src/eval.fixtures.ts` stub; 03's only spawned assertion is an
  `it` on an existing `src/orchestrator.test.ts` fixture (`prd.md` Testing
  decisions; AGENTS.md; ADR 0063). **No eval scenario is ever run by
  `pnpm test`**: `vitest.config.ts` includes only `src/**/*.test.ts`, the
  packs live under `eval-packs/`, and no test dispatches `eval-packs/afk` to
  any provider.

## Launch checklist

- `pnpm lint:tickets 262 263 264` — exits 0 with zero warnings, run
  2026-09-12 on `docs/prd7-spec` immediately after the issues were created.
  It prints three "waiver matched nothing" notes for #92, #93 and #95 —
  stale waivers from earlier PRDs. They are not these tickets' and they do
  not gate. No waiver was added for these tickets.
- `Blocked by` uses issue numbers, the DAG parser's key
  (`src/issues-parser.ts`), not slice numbers. The two waves above were
  derived from that parser against this table.
- PRD 4 is merged (#223 CLOSED); `parseFinalReview`, the `evaluator-final`
  role and `POST_APPROVAL_WRITING_STAGE_ID` are on `origin/main` at `46f6c38`.
  Every `file:line` in `prd.md` was read on `0faf207`.
- `afk.json` here selects all three slices. No slice adds a migration (AFK
  has no SQL migrations), so `migrationPrefixes` stays empty; #152 is
  protected as OPEN so the run cannot close the parent while the post-merge
  hand tasks (the `AGENTS.md` `--record-prompts` convention line) are
  outstanding. No `protectedChangeWaivers`: no slice touches
  `afk.config.json` or `suite-budgets.json`.
- Launch from a dedicated clone with the verification command explicit —
  `node <clone>/dist/afk-claude.js --prd-dir
  .kiro/specs/afk-v2-agent-eval-harness --test-command "pnpm run typecheck &&
  pnpm test:fast"` after `pnpm build`. The globally linked `afk-claude` on the
  operator's machine is not this checkout (PRD 4 precondition 6).
- Host conditions at prep time: PRD 5 (`afk-v2-quality-loops`, #87/#97) is
  prepared to run concurrently and a rumo-app AFK run is live. One clone per
  run. Never run the full suite by hand; never merge.

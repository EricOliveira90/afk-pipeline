# PM review — PRD 7: Agent-behavior eval harness

Scope reviewed: slices 01 (#262 Eval runner), 02 (#263 Eval seed pack), 03
(#264 Prompt recorder). No manifest slice was skipped.

**Verdict:** SHIP

## What the operator can now do, verified

**S1 — `afk eval` exists and behaves as promised (D7–D24, D31–D35).**

- `npx tsx src/afk.ts eval --pack eval-packs/afk --dry-run` printed the nine
  cases as `<id> (<role>) — <source>`, dispatched nothing, wrote nothing, and
  exited 0 (D21). `--pack eval-packs/fixtures/refused` printed
  `01-unknown-member.json declares the unknown top-level member "notes"; a case
  carries exactly version, id, role, source, prompt, files, expected` and exited
  2 — the pack is refused by file and member before a model call (D7).
  `--max-calls 0` exited 2 with the usage line (D15).
- `src/eval-command.ts:258-353` writes the report and returns exit 0 whatever
  the outcomes, and exit 1 only after `dispatchBegan` — mechanically "non-zero
  iff no `report.json`" (D21). The cap is checked before each dispatch
  (`:299-316`), a `NOT-RUN` case costs `callsUsed: 0`, and the run's `status`
  becomes `INCOMPLETE` (`:330-334`), so two runs of the same pack with the same
  cap yield the same `NOT-RUN` set (D19).
- `src/eval-compare.ts:216-247` dispatches the six D9 rows through the
  *production* parsers (`parseContractReview`, `parseQAReview`,
  `parseFinalReview`, `parseGuardianReview`, `readPlannerEscalation` +
  `parseAcceptanceManifest`) with the production `InvokeOptions` shapes,
  including `agent`/`bare: true` for the guardians only. The projection is the
  verdict enum (plus `failureClass` for QA), never findings or tree ids.
- Scratch directories are fresh `mkdtemp` dirs seeded only from `files`, removed
  on `MATCH` and kept with `scratchDir` recorded on `MISMATCH`/`ERROR`
  (`src/eval-command.ts:136-243`) — D34. No git, no `RunState`, no
  `events.jsonl`: `src/eval-boundary.test.ts` asserts both directions of the
  import boundary (B-27, P-05) and it passes.
- Report shape and `readEvalReport` exist with `EVAL_REPORT_VERSION = 1`
  (`src/eval-report.ts`); the summary line carries counts only — I grepped the
  module and found no ratio, percentage or rate anywhere (D24).
- `src/eval-pack.test.ts`, `eval-compare`, `eval-report`, `eval-command`,
  `eval-boundary`: 68 tests, all passing on this tree, none dispatching a live
  model.

**S2 — the seed packs are real and readable (D2).**

`eval-packs/afk/` holds nine cases: three `planner` cases from #192
(ESCALATION, ESCALATION, CONTRACT), one `evaluator-contract` case from #194
expecting `ACCEPT`, one `evaluator-qa` case from #120/ADR 0041 expecting
`FAIL`/`IMPLEMENTATION`, and four PRD 4 final-round verdicts — inside D2's
"roughly 9–14" and squarely on its source table. Every `source` names its
provenance and says the prompt is hand-reconstructed, as the PRD requires;
`eval-packs/afk/README.md` records fixture provenance outside the bytes the
graded role reads, which is the right call (a fixture that named its own
expected answer would leak it). `eval-packs/fixtures/consumer-governance/`
carries the one `pm` case expecting `FIX-BEFORE-SHIP` over a seeded PRD whose
R3 unsubscribe promise the seeded implementation omits — a genuine graded
judgment, not a tautology. `src/eval-packs.test.ts` (22 tests) reads both
committed packs and the refusal pack and passes; nothing dispatches the AFK
pack.

**S3 — `--record-prompts` records, and its state is in run evidence (D1, D6).**

`src/prompt-recorder.ts` wraps at the `AgentProvider` seam, derives the record
name from the log's own path with `.log` → `.prompt.md`, uses `wx` so nothing is
appended or overwritten, falls through to `.prompt.2.md`, and forwards `name`
and `parseStreamLine`. All three entries route through
`providerForRun(provider, runtimeOptions.recordPrompts)`
(`src/afk.ts:309`, `afk-claude.ts:271`, `afk-codex.ts:271`) and spread
`...runtimeOptions` into the pipeline config, so `run-started` carries
`recordPrompts` (`src/run-events.ts:37-44`, `src/orchestrator.ts:7913`) — always
written, `false` when off, which is PRODUCT.md principle 7 satisfied without a
second channel. Default-off is asserted on an existing spawned fixture
(`src/orchestrator.test.ts` B-06/B-07), not a new spawn. `--record-prompts`
appears in all three usage strings, and `afk eval …` is the new usage line.
`src/prompt-recorder.test.ts` (11 tests) passes.

Documentation the PRD asked for is present: the four `CONTEXT.md` "Pipeline
concepts" entries plus **Prompt record**, and one "Agent eval" row in
`ARCHITECTURE.md`. `package.json` is untouched, as D32 required.

## Observations (non-blocking, no action required)

1. The eval `--dry-run` case list is dominated by the long `source` strings —
   readable but noisy at nine cases. The PRD left the wording to S1, and
   provenance-in-full is the more useful default.
2. The AFK pack sits at the bottom of D2's 9–14 range; R3 makes the count "what
   the sources yield", and the README explains why round-1 REVISE verdicts were
   not admissible (no committed round-1 contract pair). Consistent with the PRD,
   worth remembering when the recorder starts producing real prompts.

## Out-of-scope PRD gaps (for the operator, not verdict-bearing)

- The `AGENTS.md` self-run convention line for `--record-prompts` is, by the
  PRD's own words, a hand edit after S3 merges. Still to do.
- The learning-proposal schema (R1) remains on `feat/learning-proposal-schema`;
  correctly absent here.

## Structured findings (v1)

{"version":1,"findings":[]}

# PM review — Mutation survivor report (slices 01 #303, 02 #304), round 2

**Verdict:** ACCEPT-WITH-NOTES

## What I checked, and how

Read the PRD (`.kiro/specs/mutation-survivor-report/prd.md`), both locked slice
contracts, and the shipped code on this branch: `src/mutation-report.ts`
(parser, decisions parser, readers, `attributeMutationSurvivors` at `:513-570`,
scope predicate `:591-620`, classifier `:624-650`, bound `:819-898`, formatter
`:934-967`), `src/ship-gate.ts` (mutation region `:1000-1165`, PR body
`:526-539`), `src/logger.ts` (`deriveMutationStepOutcome` `:315-333`, summary
section `:883-899`), `src/afk-manifest.ts`, `src/preflight.ts:142`,
`src/orchestrator.ts:8517-8525`, `src/run-events.ts:35-46, :389-410`,
`src/run-snapshot.ts:429-459`, `src/status-present.ts:1-160`,
`src/status-pipeline.ts:240-318`, `src/status-web-assets.ts:568`, and
`docs/adr/0071-report-only-mutation-survivor-step.md`.

Fresh commands I ran (narrow only; I did not re-run the suite):
`npx vitest run src/mutation-report.test.ts` (110 passed),
`npx vitest run src/status-pipeline.test.ts` (4 passed), plus greps over
`git diff main..HEAD -- src/` for gate ids, `GateDeclaration`, thresholds and
kill rates, and a grep for every consumer of `run-phase-started` /
`run-phase-ended` to find who reads the new phase member.

## Round-1 blocker P-01 (US-13) — now delivered

Round 1 blocked because a ship gate waiting on the step emitted nothing and so
read as a stall. I re-verified the fix myself rather than taking the commit
message for it:

- `src/ship-gate.ts:1035-1041`: the moment the step is kicked off (before the
  guardian-mode fork), `run-phase-started` with `phase: "mutation-step"` is
  journaled, plus a `run.log` line naming the 30-minute bound the operator is
  waiting on. `src/ship-gate.ts:1028-1033` closes the phase exactly once, with
  the step's own status as verdict (`:1150`), `ABANDONED` on the
  guardian-rejection exit (`:1086-1090`, still publishing nothing about the
  step's result), and `NO_OUTCOME` when the step produced none (`:1162`).
- `src/run-events.ts:38-46`: `mutation-step` joins the `RunPhaseName` union — an
  added member on existing optional-tolerant payloads, so
  `EVENTS_SCHEMA_VERSION` stays 1.
- `src/status-pipeline.ts:291-317`: the step is projected as an aggregate stage
  labelled "Mutation step", placed immediately before `draft-pr`, `active` while
  any attempt is open and `done` otherwise — and, because the splice happens
  *after* the `previousFailed` chain is computed at `:276-289`, it can never make
  the draft PR read as blocked by mutation. It appears only on runs that opened
  the step, so a run without the flag shows no stage it will never run.
  `src/status-web-assets.ts:568` renders `aggregateStages` generically, so the
  new stage surfaces in the babysitter dashboard with no per-id branch.
- I also checked the inverse risk — that an open 30-minute phase would now be
  flagged "possibly hung" by the 10-minute staleness rule. It is not:
  `src/status-present.ts:120-159` derives active entries from slice-level
  `phase-started` events only, and `src/run-snapshot.ts:429-459` keeps run
  phases in a separate `runPhases` collection.

So an operator or babysitter can now distinguish "ship gate waiting on the
mutation step, bound 30m" from silence, which is the outcome US-13 asked for.

## User story by user story

| US | Promise | Verdict |
|----|---------|---------|
| 1 | Survivor list in the draft PR body | Delivered — `buildPrCreationPlan` pushes the section from the shared formatter (`src/ship-gate.ts:526-539`), fed by `readMutationStepOutcome` (`:1507`) |
| 2 | Flag defaults off, zero cost when unused | Delivered — exact-token boolean in `src/cli-options.ts`; nothing starts and no phase opens when the config is absent (`src/ship-gate.ts:1009-1041`) |
| 3 | Once per run, concurrent with guardians | Delivered — kicked off unawaited ahead of the mode fork, so neither the serial nor the `allSettled` branch is restructured |
| 4 | Scope limited to the run's changed files | Delivered — `mutationEligibleSources(buildChangeSummary(...))` inside `runMutationStep`; no second diff producer |
| 5 | Launch-time refusal on flag without declaration | Delivered — `refuseUndeclaredMutationReport` thrown from the manifest fail-closed block at `src/orchestrator.ts:8522-8525`, ahead of `updateRunState`, `runLaunchPreflight` and `runWave`, so `--preflight-report-only` cannot downgrade it |
| 6 | `MUTATION_NOT_RUN` stated honestly, PR still opens | Delivered — four structured reasons; the not-run line names the reason and refuses to invent one for a record carrying none (`src/mutation-report.ts:944-953`); no PR-open condition reads the step |
| 7 | Parse the standard JSON schema, not stdout | Delivered — `parseMutationReport` is pure over text; the seam test pins that stdout carrying a different shape is ignored while the declared file wins |
| 8 | Terminated through the normal quiesce path | Delivered — one `terminate` binding on the review worktree, invoked by the bound-reached and every guardian-rejection exit, abandonment flag set first |
| 9 | New vs pre-existing against a baseline | Delivered — `attributeMutationSurvivors` keys on file, mutator and all four position numbers; no baseline means `unattributed`, silently |
| 10 | Adjudicated survivors labeled accepted, never re-raised | Delivered — `ACCEPT` matched on id plus file relabels in place, `KILL` changes nothing, the list is mapped and never filtered (`:551-566`) |
| 11 | Outcome in run state with run-ID provenance; totals in the summary | Delivered with a note — `recordMutationStepOutcome(repoRoot, runSlug, record)`; see N-01 on the word "totals" |
| 12 | Refusals recorded as killing arguments in an ADR | Delivered — ADR 0071 `### Refusals` |
| 13 | Step status visible in run status surfaces | Delivered this round — see above |
| 14 | Decisions-file schema in the ADR | Delivered — ADR 0071 `### Decisions file schema`, spellings pinned by `parseMutationDecisions` |
| 15 | Trust ladder recorded as direction | Delivered — ADR 0071 `### Trust ladder` |

Degradation reads exactly as the PRD promise that the report marks and never
suppresses: an omitted or `ABSENT` artifact is silent, while a present-but-broken
one is named `BASELINE_UNUSABLE` / `DECISIONS_UNUSABLE` in both surfaces and
cannot move the step status. The never-gates promise held everywhere I looked:
the diff adds no gate id, no `GateDeclaration`, no threshold and no verdict or
PR-open read touching a survivor, a label or a note; the one `thresholds` string
in the diff is a fixture field of the tool's own report JSON.

## Notes (non-blocking)

- **N-01 — no explicit survivor total in `run-summary.md`** (repeat of round 1's
  P-02). US-11 says "totals in run-summary.md". `formatMutationReportLines`
  (`src/mutation-report.ts:934-967`) emits one bullet per survivor, an explicit
  "No surviving mutants..." line when empty, and the not-run reason — but no
  count. The count is derivable by counting bullets, and the `run.log` phase line
  states "N survivor(s) reported" (`src/ship-gate.ts:1151-1158`), so the operator
  outcome is substantially met; one count line would close it literally.
- **N-02 — the baseline shape is an unverified assumption** (repeat). The
  baseline is parsed by `parseMutationReport` on the assumption that a tool's
  incremental artifact is the same mutation-testing-elements document, with no
  sample artifact in-repo. The failure is contained and named: a wrong shape is
  `MALFORMED` then `BASELINE_UNUSABLE` with every survivor `unattributed`, never
  a wrong label. Worth confirming the first time an operator declares
  `baselinePath`.
- **N-03 — an `accepted` label can go stale** (repeat). The decisions key is the
  tool's own `id` corroborated by `file`, so a tool that renumbers per-file ids
  could mark a survivor no human adjudicated. Documented in the code, bounded by
  what a label is (the survivor stays in the list at full detail and no gate
  reads it), but the first triage corpus should check id stability.

## Out-of-scope PRD gaps

None. Both manifest slices ran; the PRD's remaining work (baseline creation and
refresh, Stage A triage sessions, trust-ladder stages B and C, adding a mutation
tool to any repo) is operator work the PRD itself places out of scope.

## Structured findings (v1)

{"version":1,"findings":[{"id":"P-01","title":"US-13 wait-visibility gap from round 1: a ship gate waiting on the mutation step now opens a run phase, is journaled with its bound, and is projected as an active status stage","class":"PRODUCT","clearCondition":"Cleared: verified run-phase-started/ended at src/ship-gate.ts:1028-1041 and :1150-1163, RunPhaseName at src/run-events.ts:38-46, the non-blocking stage projection at src/status-pipeline.ts:291-317, and 4 passing status-pipeline cases.","disposition":"RESOLVED"},{"id":"P-02","title":"run-summary.md mutation section states no survivor total, though US-11 asks for totals","class":"PRODUCT","clearCondition":"Either formatMutationReportLines emits a survivor count line, or the operator accepts the per-survivor bullets plus the run.log phase line as the totals US-11 asked for.","disposition":"REPEATED"},{"id":"P-03","title":"The baseline is parsed on an unverified assumption about the tool's incremental artifact shape","class":"PRODUCT","clearCondition":"A real incremental artifact from the declaring tool is confirmed to parse, or the operator-facing docs state that a non-conforming baseline degrades to BASELINE_UNUSABLE with every survivor unattributed.","disposition":"REPEATED"},{"id":"P-04","title":"An ACCEPT decision keyed on the tool's mutant id can mislabel a survivor accepted after renumbering","class":"PRODUCT","clearCondition":"The first triage corpus confirms mutant ids are stable for the declared tool, or the decisions match key gains position corroboration in a later slice.","disposition":"REPEATED"}]}

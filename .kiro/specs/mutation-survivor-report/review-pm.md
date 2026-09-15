# PM review — Mutation survivor report (slices 01 #303, 02 #304)

**Verdict:** FIX-BEFORE-SHIP

## What I checked, and how

Read the PRD (`.kiro/specs/mutation-survivor-report/prd.md`), both locked slice
contracts, and then the shipped code: `src/mutation-report.ts`,
`src/ship-gate.ts` (mutation region at `:992-1130`, PR body at `:522-537`),
`src/logger.ts` (`readMutationStepOutcome` / `deriveMutationStepOutcome` at
`:284-345`, summary section at `:881-899`), `src/afk-manifest.ts`
(`normalizeMutationReportPath` / `normalizeMutationReport`, `:198-313`),
`src/preflight.ts:127-160`, `src/cli-options.ts:110-120, :258, :298`,
`src/orchestrator.ts:8517-8525` and `:9334-9338`,
`docs/adr/0071-report-only-mutation-survivor-step.md`. Ran
`npx vitest run src/mutation-report.test.ts` (110 passed) as a narrow check; I
did not re-run the suite.

## User story by user story

| US | Promise | Verdict |
|----|---------|---------|
| 1 | Survivor list in the draft PR body | Delivered — `buildPrCreationPlan` pushes the section from `formatMutationReportLines` (`src/ship-gate.ts:525-537`), fed by `readMutationStepOutcome` at both plan sites (`:1473`, `:1484`, `:1549`) |
| 2 | Flag defaults off, zero cost when unused | Delivered — exact-token boolean (`src/cli-options.ts:258`); `runShipGate` starts nothing when the config is absent (`src/ship-gate.ts:1009-1020`); pinned by `src/ship-gate.test.ts:2716` and `src/logger.test.ts:1787` |
| 3 | Once per run, concurrent with guardians | Delivered — the step is kicked off unawaited before the mode fork, so both the serial and the allSettled branch are unrestructured (`src/ship-gate.ts:1009`, fork `:1072-1091`) |
| 4 | Scope limited to the run changed files | Delivered — `mutationEligibleSources(buildChangeSummary(...))` inside `runMutationStep` (`src/mutation-report.ts:727-733`); no second diff producer |
| 5 | Launch-time refusal on flag without declaration | Delivered — `refuseUndeclaredMutationReport` thrown from the manifest fail-closed block ahead of `updateRunState`, `runLaunchPreflight` and `runWave` (`src/orchestrator.ts:8517-8525`), so `--preflight-report-only` cannot downgrade it |
| 6 | MUTATION_NOT_RUN stated honestly, PR still opens | Delivered — reasons BOUND_REACHED / COMMAND_FAILED / REPORT_UNREADABLE / REPORT_MALFORMED (`src/mutation-report.ts:624-646`); the not-run line names the reason and refuses to invent one for a record that carries none (`:944-960`); no PR-open condition reads the step |
| 7 | Parse the standard JSON schema, not stdout | Delivered — `parseMutationReport` is pure over text and the command stdout is discarded, pinned by `src/ship-gate.test.ts:2321` |
| 8 | Terminated through the normal quiesce path | Delivered — one `terminateMutationStep` binding to `quiesceWorktree(reviewDir)`, invoked by the bound-reached exit and by every guardian-rejection exit, abandonment flag set first (`src/ship-gate.ts:1027-1068`) |
| 9 | New vs pre-existing against a baseline | Delivered — `attributeMutationSurvivors` keys on file, mutator and all four position numbers (`src/mutation-report.ts:465-540`) |
| 10 | Adjudicated survivors labeled accepted, never re-raised | Delivered — ACCEPT entries matched on id plus file relabel in place, KILL changes nothing, the list is mapped and never filtered (`:552-566`) |
| 11 | Outcome in run state with run-ID provenance; totals in the summary | Delivered with a note — `recordMutationStepOutcome(repoRoot, runSlug, record)` carries the run slug (`src/ship-gate.ts:1119`); see N-01 on totals |
| 12 | Refusals recorded as killing arguments in an ADR | Delivered — ADR 0071 `### Refusals` |
| 13 | Step status visible in run status surfaces, so waiting is not a stall | **Missing — see P-01** |
| 14 | Decisions-file schema in the ADR | Delivered — ADR 0071 `### Decisions file schema`, spellings pinned by `parseMutationDecisions` (`src/mutation-report.ts:326-392`) |
| 15 | Trust ladder recorded as direction | Delivered — ADR 0071 `### Trust ladder` |

Degradation reads exactly as the PRD promise that the report marks and never
suppresses: absence is silent (an omitted or ABSENT input takes one branch and
produces no note), while a present-but-broken artifact is named
BASELINE_UNUSABLE or DECISIONS_UNUSABLE in both surfaces and can never move the
step status. The never-gates promise held everywhere I looked: no gate id, no
`GateDeclaration`, and no verdict or PR-open read touches a survivor, a label or
a note.

## Fix before ship

### P-01 — a run waiting on the mutation step is indistinguishable from a stall

`prd.md:72-74` (US-13) promises the step status is visible in run status
surfaces "so that a ship gate waiting on mutation is distinguishable from a
stall", and `issues.md` assigns US-13 to the selected slice 01 (#303). Nothing
delivers it.

What I read:

- `grep -rn "mutation" src/status*.ts` returns nothing: no status surface
  (`src/status.ts`, `status-present.ts`, `status-future.ts`,
  `status-pipeline.ts`, `status-web.ts`) knows the step exists.
- `src/ship-gate.ts:992-1130`: the only operator-facing output about the step is
  the `journal.phase("  Mutation step: ...")` line at `:1121-1130`, emitted
  after the bounded await resolves. Nothing is written when the step starts, and
  the command stdout is buffered into a string in `defaultMutationRun`
  (`src/mutation-report.ts:657-686`) rather than into any run-directory log, so
  no file grows while the step runs.
- `src/status-present.ts:22-48`: liveness is derived from an open phase plus the
  mtime of a run-directory log, and an entry is flagged `stale` — possibly hung
  — after `STALE_AFTER_MS` (10 minutes) of silence, "or with no log at all,
  which is even deader".

So on a run that opted in, the step may legitimately hold the ship gate for up
to `MUTATION_STEP_BOUND_MS` (30 minutes, `src/mutation-report.ts:819`) after the
guardians finish while emitting nothing at all — the exact misreading US-13
exists to prevent, over a window three times the stall threshold the babysitter
surface itself uses. Every other US-13-adjacent fact (run-state record, event,
summary section, PR section, phase line) lands only once the step has already
finished, so none of them answers "is it waiting or is it dead?".

Clear condition: either the in-flight step becomes observable to a babysitter —
one journal or event signal emitted where the step is started
(`src/ship-gate.ts` around `:1009`) and surfaced by the status derivation, so an
operator reads "ship gate awaiting mutation step, bound 30m" instead of silence
— or US-13 is explicitly deferred in writing on #303/#302 with the
stall-misreading risk stated, so the gap is a recorded decision rather than an
omission.

## Notes (non-blocking)

- **N-01 — no explicit survivor total in `run-summary.md`.** US-11 asks for
  totals in `run-summary.md`. `formatMutationReportLines`
  (`src/mutation-report.ts:934-967`) emits one bullet per survivor, an explicit
  "No surviving mutants..." line when empty, and the not-run reason, but no
  count. The count is derivable by counting bullets and the phase line states
  "N survivor(s) reported", so the operator outcome is substantially met; a
  one-line count would close it literally.
- **N-02 — the baseline shape is an unverified assumption.** The baseline is
  parsed by `parseMutationReport` on the assumption that a tool incremental
  artifact is the same mutation-testing-elements document
  (`src/mutation-report.ts:425-433`, contract B-04), with no sample artifact
  in-repo to confirm it. The failure is contained and named: a wrong shape is
  MALFORMED, which becomes BASELINE_UNUSABLE with every survivor unattributed,
  never a wrong label. Worth confirming against a real incremental file the
  first time an operator declares `baselinePath`.
- **N-03 — an accepted label can go stale.** The decisions key is the tool own
  `id` corroborated by `file` (`src/mutation-report.ts:490-493`), so a tool that
  renumbers per-file ids can mark a survivor no human adjudicated. The code
  documents this and the harm is bounded (the survivor stays in the list at full
  detail and no gate reads the label), but the first triage corpus will want the
  ids checked.

## Out-of-scope PRD gaps

None. Both manifest slices ran; the PRD remaining work (baseline creation,
Stage A triage sessions, trust-ladder stages B and C) is operator work the PRD
already places out of scope.

## Structured findings (v1)

{"version":1,"findings":[{"id":"P-01","title":"A ship gate waiting on the mutation step is invisible to every run status surface, so it reads as a stall (US-13)","class":"PRODUCT","clearCondition":"Either the in-flight step becomes observable to a babysitter (a signal emitted where the step starts in src/ship-gate.ts and surfaced by the status derivation), or US-13 is explicitly deferred in writing on #303/#302 with the stall-misreading risk stated.","disposition":"OPEN"},{"id":"P-02","title":"run-summary.md mutation section states no survivor total, though US-11 asks for totals","class":"PRODUCT","clearCondition":"Either formatMutationReportLines emits a survivor count line, or the operator accepts the per-survivor bullets plus the phase line as the totals US-11 asked for.","disposition":"OPEN"},{"id":"P-03","title":"The baseline is parsed on an unverified assumption about the tool incremental artifact shape","class":"PRODUCT","clearCondition":"A real incremental artifact from the declaring tool is confirmed to parse, or the operator-facing docs state that a non-conforming baseline degrades to BASELINE_UNUSABLE with every survivor unattributed.","disposition":"OPEN"},{"id":"P-04","title":"An ACCEPT decision keyed on the tool mutant id can mislabel a survivor accepted after renumbering","class":"PRODUCT","clearCondition":"The first triage corpus confirms mutant ids are stable for the declared tool, or the decisions match key gains position corroboration in a later slice.","disposition":"OPEN"}]}

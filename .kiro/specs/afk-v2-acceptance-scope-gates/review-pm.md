# PM / product review — PRD 4, slice 07 (#193) only

**Verdict:** ACCEPT-WITH-NOTES

Scope judged: slice 07 "Feedback integrity and gate-scope revisions" (#193).
Slices 01–06 and 08 were not run by this invocation and are not judged here.

## What the PRD promised for this slice, and what a user gets

Slice 07 owns D5 (protected-change waivers as an operator launch input), D6's
deletion rule, D12 (`GATE-SCOPE` gate-evidenced revisions), D13 (parser-regression
rubric), D23 (waiver observability) and D24 (a gate finding blocks the merge
instead of parking). Each promised outcome is present:

- **An operator can authorize a protected change, and only an operator can.**
  `src/afk-manifest.ts:206-224` parses `protectedChangeWaivers` from the PRD
  directory's `afk.json`, refusing an unknown `riskClass` (`:120-125`), a glob
  `path` (`:128-133`), a blank field (`:99-104`) and a duplicate
  `riskClass` + `path` pair (`:215-222`). `src/orchestrator.ts:6003` reads them
  from `config.manifest` — the launch input — and passes that same array into the
  gate (`:6378`) and the skip gate (`:6367`). Nothing re-reads `afk.json` from the
  candidate worktree, so a waiver an agent writes for itself buys nothing (D5's
  security posture). I confirmed this PRD's own pre-recorded waiver
  (`.kiro/specs/afk-v2-acceptance-scope-gates/afk.json`) satisfies every rule
  above, so the live launch input is not refused by the new validator.
- **A self-edit of the pipeline's quality config, or a deleted test, does not
  merge unwaived.** `src/feedback-integrity-gate.ts:303-314` declares
  `feedback-integrity` at stage `deterministic`, `required: true`, in-process; a
  changed `gatePolicyPaths` entry (`:190-197`) or a base-present /
  candidate-absent `testGlobs` match (`:198-210`) FAILs with `failureKind:
  "COMMAND"` and names the exact path in `findings.protectedChanges` /
  `findings.deletedTests` (`:261-294`). Deletion matching calls #84's exported
  `matchesGlob`; no second matcher was written.
- **The operator can act from the failure text alone** (D24). The FAIL `detail`
  (`:274-289`) names the risk class and path, states that declaring the path in
  `fileScope` is not authorization, and spells out the four `afk.json` fields to
  add. The accepted contract pair is unwaivable (`:211-219, 224-230`), which is
  the one case where no authorization is admitted at all.
- **A gate that cannot see the tree does not pass it.** An unanswerable
  changed-set probe returns `INFRASTRUCTURE` rather than an empty violation list
  (`:170-181`).
- **An applied waiver is visible at all three points a human looks.** The gate
  records it (`:240-241, 257`), `src/orchestrator.ts:6448-6481` re-reads the
  written evidence with `readGateEvidence`, funnels it through
  `appliedWaiversFrom`, emits one `waiver-applied` event per waiver and persists
  it with `saveAppliedWaivers` (`src/run-state.ts:1283-1303`, version 4 with the
  v3 reader defaulting the field empty). `src/logger.ts:548-573` renders
  `## Applied Waivers` with slice, round, risk class, path, author and reason, and
  omits the section entirely when there are none — so a run that spent no
  authorization has an unchanged summary.
- **A failing gate can warrant a focused revision honestly.** `src/escalation.ts`
  admits schema version 2 with `gateEvidence` only at version 2 (`:349-361`),
  requires `findingIds` to be exactly `["GATE-SCOPE"]` when it is present
  (`:392-407`), and the orchestrator reads it through the one existing
  focused-revision door (`:5821`) behind the unchanged laundered-scope refusal
  (`:5854-5880`) and the per-round revision bound (`:5827-5837`). The archive keeps
  the citation: `src/artifacts.ts:237-278, 963-976` accepts a version-2 record and
  renders its `gateId` and `evidenceArtifactId` into the stuck diagnosis, so a
  human reading the diagnosis can cross-reference the gate run.
- **The generator is taught the third branch** — `prompts/generator.md:41-54`,
  `prompts/generator-repair.md:41-54` and `agents/generator.md:45-72` all carry the
  version-2 literal, `gateEvidence` required-and-only-with-`GATE-SCOPE`, and the
  escalate-for-a-human-decision rule.
- **D13 lands additively.** `prompts/evaluator-contract.md:75` and
  `prompts/evaluator-contract-revision.md:110` gain `# Parser regression surface`
  while `# Durable finding lineage`, `# Control-plane situation` and the
  `severity` / `state` bullets (ADR 0061) are still present in both — the
  preservation P-04 asked for.

## Notes (not blocking)

### P-01 — the gate reads its own enforcement catalog out of the tree it is judging

`src/orchestrator.ts:6379` builds the declaration with
`policy: loadGatePolicy(ctx.worktreeDir)`, i.e. the candidate worktree's
`afk.config.json`. Inside the gate both the enforced risk classes
(`src/feedback-integrity-gate.ts:159-161, 184`) and the protected path list
(`:147-157, 183`) come from that value. So a candidate whose contract legitimately
declares `afk.config.json` (slice 01, 02 and 05 all do) can, in the same edit,
set `"riskClasses": []` or drop `afk.config.json` from `gatePolicyPaths`, and the
gate then reports no protected change for the edit that disabled it. That is the
one shape of D5's "the actor being constrained cannot author its own exemption"
that the waiver channel closes and the policy channel does not.

Why this is a note and not a blocker: the contract's B-07 explicitly makes the
catalog decide what is enforced without fixing which tree it is read from; reading
project config from the worktree is the established convention this slice
followed (`resolveTestCostPlan(ctx.worktreeDir)`, `resolveAcceptancePlan(ctx.worktreeDir)`
at `src/orchestrator.ts:5954, 5995`, i.e. a pre-existing pattern rather than a
slice-07 invention); the suppression is not silent — the PASS `detail` carries
`Not enforced by policy: <classes>` (`src/feedback-integrity-gate.ts:235-239, 256`)
into gate evidence and the gate log; and the required `scope` gate independently
fails any candidate that touches `afk.config.json` without declaring it. Clear
condition: either the policy is loaded from the run's base tree (or the operator's
launch snapshot) rather than the candidate worktree, or the PRD records that
catalog suppression is deliberately candidate-authorable and visible-by-detail.

### P-02 — one waiver row, and the round data behind it

`## Applied Waivers` de-duplicates on slice + risk class + path and keeps the
round of first application (`src/logger.ts:548-560`), while `events.jsonl` keeps
one event per round. That reads correctly for a human (one human decision, one
row) and matches QA-01's disposition; the note is only that the summary no longer
shows that an authorization was honored on every subsequent round. No PRD line
requires it. Clear condition: none needed — recorded so a later reader does not
mistake the single row for a single gate run.

## Out-of-scope PRD gaps (for the operator, not driving the verdict)

- Role write-scope enforcement (D4) still ships as a seam with no production call
  site. The PRD already re-homes it to #226, so no slice here owes it.
- The `feedback-integrity` gate is declared at the post-QA site only. Whether the
  merge-resolution re-run (D15 / slice 06) re-runs it is slice 06's concern; not
  judged here.
- D18's `--test-command` narrowing and the `AGENTS.md` / `CLAUDE.md` launch
  correction belong to slice 05, not run by this invocation.

## Structured findings (v1)

{"version":1,"findings":[{"id":"P-01","title":"feedback-integrity reads its enforcement catalog from the candidate worktree it is judging","class":"PRODUCT","clearCondition":"The gate's gatePolicy is loaded from the run's base tree or the launch snapshot rather than ctx.worktreeDir, or prd.md records candidate-authorable catalog suppression as accepted and detail-visible.","disposition":"OPEN"},{"id":"P-02","title":"Applied Waivers shows one row per authorization, not per round honored","class":"PRODUCT","clearCondition":"No change required; recorded so a reader does not read the single row as a single gate run. Clears when acknowledged in the run record or prd.md.","disposition":"OPEN"}]}

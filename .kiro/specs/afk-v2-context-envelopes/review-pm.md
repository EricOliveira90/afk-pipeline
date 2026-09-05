# Product Guardian Review — PRD 3 selected slices

**Verdict:** FIX-BEFORE-SHIP

## Scope

Reviewed the current tree at `0060ac6` against the PRD and selected slices 01
(#83), 02 (#90), 03 (#95), and 04 (#99). No manifest slice was skipped. The
pre-ship sanity result was accepted and the full suite was not rerun.

## Requirement verification

| Slice | Result | Product outcome |
|---|---|---|
| 01 — Generator runs on the focused envelope | **Partial** | Initial and repair templates, inline scope, six-section contract projection, fail-closed budgets, deterministic assembly, escalation criteria, reduced handoff, and ordinary open-only failure projection are present. Repair context is still duplicated and over-broad, `--resume-stuck` can restore resolved findings, and assembly evidence is not journaled before dispatch. |
| 02 — Explorer four-section evidence map | **Partial** | Ordered section validation, required `Unknowns`, generator section projection, optional ADR index and `ARCHITECTURE.md`, and no per-item role tags are present. The required `FACT` / `INFERENCE` / `UNKNOWN` statement-label rule is absent. |
| 03 — Planner and contract-evaluator envelopes | Delivered | Initial and revision envelopes are distinct, planner revisions receive open findings only, evaluator revisions receive their own prior open findings and exact revision evidence, repository context is supplied to the planner, and role evidence is recorded. |
| 04 — Envelope parity and evidence completeness | **Partial** | Complete manifests, stricter-only budgets, undeclared-class rejection, deterministic provider-independent assembly, stable-ID preservation, exact invocation evidence, token fields, `nonCommandTimeMs`, and slice/run totals are present. The fresh-context exclusion still fails through the STUCK-resume path. |

## Fix before ship

### 1. Restore the explorer citation-label rule

PRD user story 9 and slice #90 require every explorer statement to be
distinguishable as `FACT`, `INFERENCE`, or `UNKNOWN`.

- **File and location:** `prompts/explorer.md`, `# Citation rule`.
- **What I read:** the prompt asks for citations and places unresolved questions
  under `Unknowns`, but never tells the explorer to label statements as
  `FACT`, `INFERENCE`, or `UNKNOWN`.
- **File and location:** `src/context-envelope.test.ts`, test
  `B-04 QA-01 assembles the ordered focused prompt and exact evidence`.
- **What I ran:** the focused 130-test command passed while this test explicitly
  requires the captured explorer prompt not to contain those three labels or
  “Label every statement.”

Without the labels, downstream roles cannot reliably distinguish cited facts
from uncited inference as promised.

**Clear condition:** Put the three-label rule in the assembled explorer prompt
and assert it at the captured-provider boundary.

### 2. Make the compact failure set the only QA-finding block in repair prompts

PRD user story 5 and slice #83 require one orchestrator-computed unresolved
block, last in the prompt: finding IDs with clear conditions plus failed gate
evidence.

- **File and location:** `src/qa-convergence.ts`, `formatEntry` and
  `formatQAGeneratorContext`.
- **What I read:** the formatter serializes severity, disposition, state,
  remedy, summary, expected, observed, clear condition, and report references.
- **File and location:** `src/orchestrator.ts`, `runSliceExecute`, the
  `retryNote` assignments and `repairSituation` construction.
- **What I read:** that expanded formatter output is inserted into
  `repairSituation`, while `assembleGeneratorEnvelope` also appends the compact
  `generatorFailureSet` at the end. The generator therefore receives two
  finding blocks, one broader than the promised projection.
- **What I ran:** the focused QA-orchestration test
  `routes compact lineage and grants one final repair for a fresh round-three blocker`
  passed while requiring finding summaries and prior report references in the
  repair prompt.

This restores prompt detail the focused envelope was meant to remove.

**Clear condition:** Keep control-plane and resume facts in `repairSituation`,
but place all QA-finding content only in the final compact failure set.

### 3. Remove resolved findings from `--resume-stuck` prompts

The PRD requires fresh repair invocations with no resolved findings. That rule
applies to resumed repair templates as well as ordinary retry rounds.

- **File and location:** `src/artifacts.ts`, `renderStuckDiagnosis`.
- **What I read:** the generated `stuck.md` includes a `### RESOLVED` section
  with resolved finding IDs, summaries, clear conditions, and artifact
  references.
- **File and location:** `src/resume.ts`, `buildStuckDiagnosisNote`, and
  `src/orchestrator.ts`, `runSliceExecute` repair-situation construction.
- **What I read:** `stuck.md` is copied verbatim into `stuckNote`, then embedded
  under `# Preserved STUCK evidence` in the generator repair prompt.
- **What I ran:** the focused artifacts test passed while proving the diagnosis
  contains separate resolved and open sections; the focused resume-integration
  test passed while proving the preserved diagnosis rides into the resumed
  generator prompt.

The normal QA retry fix in `0060ac6` does not close this resume path.

**Clear condition:** Project preserved STUCK evidence to current open findings
and current failed gates before prompt assembly; retain resolved lifecycle
history only in operator evidence.

### 4. Journal assembly evidence before provider dispatch

Slice #83 requires the stub to observe its matching `prompt-assembly` event as
the immediately preceding journal event at provider invocation entry.

- **File and location:** `src/orchestrator.ts`, `makeSliceContext`, local
  `invoke` function.
- **What I read:** `provider.invoke(...)` is awaited first; only after it
  returns does the code append the `prompt-assembly` event. The role paths write
  `phase-started` before dispatch, so the required assembly event is neither
  present nor immediately preceding when the provider starts.
- **File and location:** `src/orchestrator.test.ts`, test
  `B-01 B-05 QA-04 journals exact complete envelope evidence for every scoped stub invocation`.
- **What I read:** the test checks event count, order by role, and field values
  after the run, but does not inspect the journal at provider entry.

This loses assembly evidence when an invocation dies before returning and does
not deliver the dispatch-order contract.

**Clear condition:** Record assembly evidence immediately before every provider
dispatch and add a stub assertion at invocation entry. Preserve post-return
token and timing evidence without weakening that pre-dispatch record.

## Verification performed

- `pnpm vitest run src/context-envelope.test.ts src/contract-prompt-orchestration.test.ts src/qa-convergence.test.ts src/candidate-gate-policy.test.ts src/logger.test.ts src/prompt-template.test.ts src/kiro.test.ts src/claude.test.ts src/codex.test.ts` — 130 tests passed.
- Focused `src/artifacts.test.ts` STUCK lifecycle test — passed.
- Focused `src/resume-integration.test.ts` STUCK repair-situation test — passed.
- Focused `src/qa-orchestration.test.ts` compact-lineage repair test — passed.
- The full suite was not rerun.

## Out-of-scope PRD gaps

- The live Kiro, Claude Code, and Codex parity matrix remains explicitly
  deferred; slice 04 covers provider-independent assembly and named stubs.
- New assembled prompts for candidate/final evaluators, cleaner, hardener, and
  remediator remain assigned to PRDs 4–6. The candidate-evaluator manifest-only
  entry is present.
- Acceptance and scope gate execution remains PRD 4 work.

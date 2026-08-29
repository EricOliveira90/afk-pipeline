# Product Guardian Review

**Verdict:** FIX-BEFORE-SHIP

## Scope

This review judges only slices 01 (#80), 02 (#81), and 06 (#129).

## Fix Before Ship

### 1. Pre-build scope discovery still has no usable escalation identity

The PRD’s original deadlock case is a generator that knows before building that the correct implementation needs an undeclared path (Problem Statement; stories 1 and 2). It promises a structured route to contract revision.

Evidence gathered:

- `prompts/generator.md`, “Scope escalation” (lines 70-81), authorizes escalation only when a **cited finding** needs an undeclared path and requires cited `findingIds`.
- `src/orchestrator.ts`, `runSliceExecute` initial-generator prompt construction (lines 3382-3393), supplies no unresolved findings or other finding identity to the initial generator.
- `src/escalation.ts`, `parseScopeEscalation` (lines 60-103), rejects an artifact without at least one non-blank `findingIds` entry.
- I read the initial prompt construction and ran the focused prompt/escalation tests. They pass, but preserve this cited-finding-only wording; they do not exercise the PRD’s before-building case without a finding.

An initial generator that discovers the contract’s file scope is too narrow has no cited finding ID it can legally put in the required artifact. The exact pre-build deadlock named by the PRD therefore remains possible.

Give pre-build scope discoveries a defined identity and prompt contract, or allow a schema-valid escalation without a prior finding. Add an initial-generator scenario that discovers an undeclared required path without receiving QA findings and proves contract revision occurs.

### 2. `afk adopt` cannot adopt Codex or Claude run state

The PRD promises that a finished slice can be adopted with pipeline-equivalent verification and state discipline (Solution; story 17; slice-06 B-01 and B-05). AFK’s supported non-Kiro providers use provider-qualified run state and feature branches.

Evidence gathered:

- `src/orchestrator.ts`, `pipelineRunSlug` (lines 539-540), stores non-Kiro runs under `<prd-slug>-<provider>`.
- `src/adopt-command.ts`, `resolveSliceIdentity` and `runAdoptCli` (lines 130-174 and 310-316), use the entered PRD slug for `issues.md` and then load only that unqualified state key.
- `src/run-state.ts`, `statePath` and `loadRunState` (lines 201-217), therefore look for `<prd-slug>.json` and default to `feat/<prd-slug>` when it is absent.
- The current run’s actual state is `C:\Code\afk-prd2-run\.afk\state\afk-v2-routing-adjudication-codex.json`, with feature branch `feat-codex/afk-v2-routing-adjudication`; no unqualified state file or feature branch exists.
- I ran the current command against that run and its finished slice-06 branch. It refused with: `Feature branch not found: feat/afk-v2-routing-adjudication`.

The adoption bypass valve is unusable for a Codex or Claude run and cannot write provenance into the state that the pipeline later reads.

Make the canonical `afk adopt` command select the intended provider-qualified run state, with ambiguity refusal when necessary, and test at least Kiro and Codex state/branch identities.

## Delivered outcomes

- Valid, identified scope escalations are validated, archived, routed through focused revision, and resumed without spending the implementation round; malformed artifacts fail closed.
- Slice 02 delivers impasse evidence, `AWAITING-ADJUDICATION`, independent-sibling continuation, dependent blocking, and cancellation-safe parked state.
- The Kiro-style adoption path verifies candidate gates before moving the feature ref, records provenance, names ordinary refusals, and renders adoption details in summaries and draft PR bodies.
- Focused verification passed: 12 test files, 188 tests. The already-passed full suite was not rerun.

## Notes

- `afk adopt` refuses an otherwise valid adoption while the feature branch is checked out in any registered worktree. This is a defensible safety choice, but it is an operator-visible restriction not stated in the PRD and should be documented.

## Out-of-scope PRD gaps

- Slice 03 (#89): adjudication validation, bounded waiting, human-decision injection, mechanical apply-and-lock, and resumption.
- Slice 04 (#82): code-assembled stuck diagnosis and retirement of stuck prompt variants.
- Slice 05 (#94): babysit courier behavior; story 14 remains deferred.

These skipped slices do not drive this verdict.

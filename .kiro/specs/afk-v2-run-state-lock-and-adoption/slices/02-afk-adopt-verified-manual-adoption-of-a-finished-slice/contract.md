# Slice Contract — afk adopt: verified manual adoption of a finished slice

**Parent PRD:** .kiro/specs/afk-v2-routing-adjudication/prd.md
**GH issue:** #129
**Status:** LOCKED
**Negotiation round:** 2

## Scope lock
Deliver the thin `afk adopt` subcommand for a manually finished slice: verify a candidate merge and the pipeline's base gates before changing the feature branch, persist a pipeline-complete slice entry with who/why/branch/commit provenance, and expose that provenance in later run summaries and draft PR bodies (GH #129; PRD story 17; plan section 3 item 10).

### In scope
- [behavior:B-01] Given a PRD slug, slice identifier, finished slice branch, resolved non-empty adopter, and non-empty reason, when `adopt` finds a clean candidate merge and every base gate passes on that merged tree, then it merges the slice into the state's feature branch and writes that slice as `phase: "PASS"` with `mergedToFeature: true`, its branch, and `adoption: { adopter, reason, branch, commit }`, where `commit` is the verified slice tip (GH #129 AC1).
- [behavior:B-02] Given a clean candidate merge whose merged tree fails a base gate, when adoption is attempted, then the command exits unsuccessfully, names the failing gate, and leaves the working tree, feature-branch ref, slice branch, and run-state file unchanged (GH #129 AC2).
- [behavior:B-03] Given a slice branch that conflicts with the feature branch, when adoption is attempted, then the command exits unsuccessfully, names the merge conflict, and leaves the working tree, both branch refs, and run-state file unchanged (GH #129 AC3).
- [behavior:B-04] Given a missing, empty, or whitespace-only reason, when adoption is attempted, then it is refused, no merge occurs, no adoption record is written, and neither branch nor run state changes (GH #129 AC5).
- [behavior:B-05] Given persisted adoption metadata for a completed slice, when AFK writes `run-summary.md` or builds the draft PR body, then each output identifies the adopted slice and shows adopter, reason, branch, and commit (GH #129 AC4; plan section 3 item 10).

### Non-goals (explicit out-of-scope)
- Approval workflows, second-reviewer ceremony, launch-time state/branch auditing, provider-specific `afk-claude adopt` or `afk-codex adopt` aliases, UI work, and GitHub issue mutation (GH #129 "Deliberately thin"; plan section 3 item 10; PRD Out of Scope).
- Escalation, adjudication, parking, stuck diagnosis, or babysit courier behavior from PRD stories 1-16 (PRD scope).

### Existing behavior to preserve
- [behavior:P-01] Given any existing `status`, `stop`, `clean-failed`, pipeline option, or help invocation, when its current CLI entry point dispatches it, then its routing, provider selection, output channel, and exit behavior remain available (context.md, Existing Behavior In Touched Files).
- [behavior:P-02] Given legacy or current run-state JSON without `adoption`, when it is loaded, saved, or checked by `isSliceComplete`, then v0 adaptation, optional state fields, parallel slice updates, and the existing PASS-plus-merged completion rule remain unchanged (context.md, `src/run-state.ts`).
- [behavior:P-03] Given a merge attempted through existing git helpers, when it succeeds or conflicts, then current scratch/registered-worktree handling and conflict cleanup remain unchanged for pipeline merges (context.md, `src/git.ts`).
- [behavior:P-04] Given a run with no adopted slices, when its stable and per-run summaries are written, then lifecycle labels, branch dispositions, dependency holds, base-gate attempts, totals, and both output locations retain their current rendering (context.md, `src/logger.ts`).
- [behavior:P-05] Given draft-PR planning with no adopted slices, when guardian verdicts and optional override are evaluated, then open/refuse behavior, override disclosure, artifact links, and `Closes #...` lines remain unchanged (context.md, `src/ship-gate.ts`).

### Changes to existing behavior (only if the issue asks for it)
- Completed slice state may carry optional `adoption: { adopter, reason, branch, commit }` metadata, and summary/PR projections render it (GH #129 AC1 and AC4).

## Files expected to change
- src/adopt-command.ts (new file)
- src/adopt-command.test.ts (new file)
- src/afk.ts
- src/afk.test.ts (new file)
- src/run-state.ts
- src/run-state.test.ts
- src/git.ts
- src/git.test.ts
- src/run-journal.ts
- src/run-journal.test.ts
- src/logger.ts
- src/logger.test.ts
- src/orchestrator.ts
- src/orchestrator.test.ts
- src/ship-gate.ts
- src/ship-gate.test.ts
- src/slice-lifecycle.ts (added by scope amendment for QA finding QA-04)

## Migration requirements
- New migration files: 0

## New patterns / deps / schema (if any)
- Add optional persisted slice-state field `adoption: { adopter: string; reason: string; branch: string; commit: string }`; no new dependency or database schema.

## Test plan
- Given feature ref F, slice tip S, and known candidate merge tree M, when `afk adopt` runs with passing fixtures for every resolved base gate, then each fixture logs and asserts `HEAD^{tree}` equals M and the live feature ref still equals F; only after every gate passes does the feature ref move once, and the command reports success and writes B-01's exact completed state and adoption record.
- Given the same identity-recording fixture with a named gate configured to fail, when adoption runs, then every resolved gate records candidate tree M and live feature ref F before refusal; the refusal names the failing gate and byte/ref snapshots prove the worktree, feature ref, slice ref, and state stayed unchanged.
- Given branches with a real merge conflict, when adoption runs, then its refusal names the conflict and byte/ref snapshots prove no worktree, ref, or state mutation.
- Given omitted, empty, and whitespace-only reasons, when adoption runs, then each attempt is refused without merging, writing adoption metadata, or changing branch or state.
- Given adopted and ordinary completed records, when summary and draft-PR projections run, then adoption details appear only for the adopted slice and the P-04/P-05 projections remain intact.
- Given legacy v0/v1 state fixtures without adoption metadata and existing merge-helper fixtures, when load/save/completion and pipeline merge operations run, then P-02/P-03 behavior remains unchanged.
- Given an automated `src/afk.ts` entrypoint harness, when it invokes `status`, `stop`, `clean-failed`, a representative `--prd-dir ... --dry-run` pipeline, and `--help`, then spies or fixture effects prove the existing dispatch target and provider selection for each case, while captured stdout/stderr and exit results match current behavior.
- Given the implementation, when the evaluator runs `pnpm run typecheck` and `pnpm run test`, then both commands exit successfully.

## Definition of done
- [ ] Successful adoption proves every base gate ran on the candidate merged tree before the feature ref changed, then persists the complete audit record.
- [ ] Every reason, conflict, or gate refusal identifies its cause and is atomic across worktree, refs, and state.
- [ ] Adoption provenance appears in both required reporting surfaces without changing ordinary output behavior.
- [ ] Existing state files and CLI entrypoint behavior remain compatible.

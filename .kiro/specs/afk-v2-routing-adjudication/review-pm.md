# Product Guardian Review

**Verdict:** FIX-BEFORE-SHIP

## Scope

This verdict covers only slice 06 (#129), `afk adopt`. Slices 01-05 do not affect it.

## Fix Before Ship

### Slice numbers are persisted under the wrong run-state identity

The PRD promises that `afk adopt` takes a finished slice and writes its state entry as the pipeline would, so hand-finishing never bypasses gates or state discipline (PRD Solution and story 17; slice-06 behavior B-01).

Evidence gathered:

- `.kiro/specs/afk-v2-routing-adjudication/issues.md`, slice table: slice `06` is GitHub issue `129`.
- `src/adopt-command.ts`, `parseArgs` and `runAdoptCli` state write (lines 74-95 and 295-305): the command accepts the raw `<slice>` argument and passes it unchanged to `saveSliceState`; it never resolves the manifest slice to its GitHub issue ID.
- `src/run-state.ts`, `isSliceComplete` (lines 492-494), and `src/orchestrator.ts`, completed-slice restoration (lines 4298-4307): pipeline completion is looked up by GitHub issue ID.
- I ran a focused state check using this PRD's `issues.md`. A PASS record written under the entered slice `06` returned `completeByEnteredSlice: true` but `completeByPipelineKey: false` for issue `129`.

An operator following the CLI's `afk adopt <prd-slug> <slice>` wording can receive success after entering `06`, yet AFK will not recognize #129 as complete. A later run can dispatch the slice again, and summary/PR provenance is associated with `#06` instead of `#129`.

Resolve either the manifest slice number or GitHub issue ID to the canonical GitHub issue key before any merge, reject unknown identifiers before mutation, and cover both `06` and `129`.

## Delivered Outcomes

- Candidate merges are built and base gates run before the feature ref moves.
- Gate and merge-conflict refusals name their cause and preserve refs and state.
- Missing, empty, whitespace-only, and option-shaped reasons are refused.
- Successful adoption records adopter, reason, branch, and verified slice-tip commit.
- Persisted adoption provenance renders in run summaries and draft PR bodies; ordinary summaries retain their prior rendering.
- Focused verification passed: 4 test files, 43 tests (`adopt-command`, `afk`, `logger`, and `ship-gate`). The already-passed pre-ship full suite was not rerun.

## Notes

`src/git.ts:updateBranchIfUnchanged` advances the feature ref directly. If that branch is checked out, its worktree and index remain at the old tree even though adoption reports success. The existing `mergeSliceBranch` helper explicitly handles checked-out feature branches. The PRD does not specify successful-worktree behavior, so this is not an additional verdict driver, but it is an operator-visible risk worth resolving or documenting.

## Out-of-scope PRD gaps

- Slice 03 (#89), human adjudication and bounded resumption (stories 4 and 7-9), was not executed and has no slice implementation directory in this tree.
- Slice 04 (#82), code-assembled stuck diagnosis and prompt retirement (stories 11-12), was not executed and has no slice implementation directory in this tree.
- Slice 05 (#94), the manual babysit courier follow-up (story 5; story 14 remains deferred), was not executed.
- Slices 01 (#80) and 02 (#81) are present on the branch but were narrowed out and were not judged for this verdict.

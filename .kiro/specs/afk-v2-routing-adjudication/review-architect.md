# Architecture Guardian Review

**Verdict:** FIX-BEFORE-SHIP

## Scope reviewed

Reviewed `git diff main...HEAD`, all contracts and implementation artifacts
under `.kiro/specs/afk-v2-routing-adjudication/slices/`, the PRD, and ADRs
0008, 0010, 0028, 0031, 0047, and 0050-0055. I traced the merged escalation,
contract-transaction, adjudication, journal, cleanup, and adoption paths.

The pre-ship gate already passed this tree, so I did not rerun the full suite.

## Blocking findings

### 1. Scope escalation can authorize an out-of-scope edit after it happened

- **File/location:** `src/orchestrator.ts`, `runSliceExecute()` at
  lines 4240-4266; `src/escalation.ts`, `parseScopeEscalation()` at
  lines 83-169.
- **Evidence gathered:** I read the complete post-generator escalation path.
  It archives `escalation.md`, validates its schema and requested paths
  against the manifest, and immediately starts `runFocusedScopeRevision()`.
  It never compares the changed worktree paths with the still-locked scope.
  A repository search for `listChangedFiles` in this flow found only the
  separate QA amendment check at `src/orchestrator.ts:3891`.
- **Defect:** A generator may edit an undeclared path first, then name that
  path in a valid escalation. The focused revision adds the path and the
  existing edit proceeds to gates as if it had been made under the revised
  lock. The control artifact therefore launders the boundary violation it is
  meant to prevent.
- **Convention violated:** ADR 0008, **Decision**, makes the on-disk locked
  contract the orchestrator-owned source of truth. ADR 0052, **Decision**,
  defines this route as a pre-build discovery: the generator discovers the
  narrow scope before building and then emits the reserved or cited identity.
- **Required fix:** Before granting a focused revision, fail closed if the
  worktree already contains changes outside the current locked scope. Preserve
  the raw escalation archive and add focused coverage for an escalation that
  follows an undeclared edit.

### 2. Estate discovery reports absence without completing the probe

- **File/location:** `src/adjudication-estate.ts`, `MAX_DEPTH` and
  `findAdjudicationEstate()` at lines 50-58 and 100-134; destructive callers
  in `src/clean-failed.ts:223-242,317-328` and the adoption caller in
  `src/adopt-command.ts:373-393`.
- **Evidence gathered:** I read the walk: it stops at depth six and silently
  returns from any `readdirSync()` failure, after which an empty result becomes
  `null`. I also ran a focused TypeScript probe with a valid configurable
  specs path,
  `docs/internal/programs/2026/specs/demo/slices/01-deep/`, containing
  `adjudication-decisions.json`; the function returned `null`. `src/afk.ts`
  lines 145-163 accept an arbitrary `--prd-dir` and impose no matching depth
  constraint.
- **Defect:** `clean-failed` can delete a worktree whose estate is deeper than
  the assumed default layout, or whose directory could not be enumerated.
  Adoption can likewise treat the same incomplete inspection as proof that no
  estate exists. Both destroy or strand operator-owned adjudication state.
- **Convention violated:** ADR 0055, **Seam 2 invariant**, says an operation
  that cannot prove it preserves the estate refuses by name. Seam 2
  **sections 6 and 8** require estate ownership to be read from disk and
  absence to be proved, not inferred from enumeration failure.
- **Required fix:** Resolve the exact slice/specs location rather than using a
  bounded blind walk, or return a tri-state result that distinguishes absent
  from indeterminate. Traversal errors must make cleanup and adoption refuse.

### 3. Adoption can overwrite a park created while gates run

- **File/location:** `src/adopt-command.ts`, `runAdoptCli()` at lines
  586-611 and 674-767; `src/run-state.ts`, `saveSliceState()` at lines
  422-437.
- **Evidence gathered:** I read the ordering: run state and worktrees are read
  once, the estate refusal runs, base gates execute, the feature ref is
  compare-and-swapped, and `saveSliceState()` then re-reads state but
  unconditionally replaces this slice's record. I ran a focused reproduction
  whose gate callback parked slice `#129` and wrote
  `adjudication-decisions.json` after the initial refusal check. Adoption
  returned exit code 0, persisted `PASS`, and left the decision file on disk.
- **Defect:** Gate verification is long enough for a concurrent run to park
  the same slice without moving the feature branch. The feature-ref CAS still
  succeeds, adoption overwrites `AWAITING-ADJUDICATION` with `PASS`, and the
  live estate is stranded with no slice record owning it.
- **Convention violated:** ADR 0055, **Seam 2 invariant** and **section 8**,
  says only the slice's own re-dispatch replaces a park and adoption must
  refuse before mutation while that estate exists.
- **Required fix:** Re-enumerate worktrees and re-check the estate immediately
  before finalization, and make the slice-state update conditional on the
  record observed before verification. A changed record must refuse without
  moving the feature ref, or roll it back if the state CAS loses.

## Verification

- Focused estate-depth probe reproduced a false `null`.
- Focused adoption-race probe reproduced `PASS` beside a live decision log.
- No full suite was rerun, per the review invariant.

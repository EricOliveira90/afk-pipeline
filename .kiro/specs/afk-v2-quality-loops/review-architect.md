# Architecture review - afk-v2-quality-loops (round 5, verification)

**Verdict:** ACCEPT-WITH-NOTES

Scope: git diff 1dbd6e9..HEAD (cd477a6 scope-gate carve-out, 0685fb5 cleaner
orchestration seam, a835eac quality-stage git seam) plus the current state of
the files each open finding names. No re-read of the rest of the branch.

## Dispositions

### A-01 - RESOLVED

src/cleaner-orchestration.ts runs decide(result) on the RESTORE re-dispatch's
merged result exactly as it does on the INITIAL one: EXHAUSTED returns STUCK
with cleanerExhaustionReason and the still-red gates' logArtifactIds,
ESCALATED resets to input.accepted.commitSha via resetCleanerRangeTo, calls
invalidateFinalEvaluationBaseline, and returns the generator failure set and
retry note. The no-round-left branch still resets the cleaner range and
re-stamps EXHAUSTED. The refactor in 0685fb5 preserves the orchestrator side:
the restore branch in src/orchestrator.ts now returns
restoredCleaner.terminal, and createCleanerContinuation's finishStuck adapter
pushes artifactReferences into stuckReferences before calling finishStuck,
while returnToGenerator assigns generatorFailureSet/retryNote before
"returnToGenerator = true; break". Pinned by
src/cleaner-orchestration.test.ts:200 (RESTORE exhaustion -> STUCK with
still-red gate evidence) and :262 (RESTORE escalation -> generator failure
set plus accepted-range reset), beside
src/qa-orchestration-gates.test.ts:1497 ("refuses a restore for want of a
cleaner round"), and by src/cleaner-continuation.test.ts for the adapter
translation. Clear condition met.

### A-02 - RESOLVED

src/scope-gate.ts:154-184: the additionalWriteScope pre-filter now retains any
path in unwaivablePaths, derived from ORCHESTRATOR_OWNED_SLICE_FILENAMES under
the same condition src/escalation.ts:326 uses (artifactDir === "" ||
acceptedPairIntact), through the shared normalizeAcceptanceManifestPath; an
unnormalizable path falls through to outOfScopeChangedPaths rather than being
exempted. Verified by running "pnpm vitest run src/scope-gate.test.ts" - the
new [behavior:#87:B-11] "keeps the accepted pair unwaivable under a broad
additionalWriteScope" case FAILs with both contract.md and
acceptance-manifest.json reported under additionalWriteScope ["**"] (16/16
passed). The P-10 refusal is no longer waivable by policy widening.

### A-03 - RESOLVED

src/cleaner-stage.ts no longer holds a private git()/resetHardTo:
execFileSync is dropped from its imports, and all five reset sites (exit paths
1-3, the escalation-malformed reset, the restore reset) plus
resetCleanerRangeTo call resetWorktreeTo from src/git.ts. src/git.ts:733-750
factors resetWorktreeToHead onto the new resetWorktreeTo(worktreeDir, ref,
excludePaths), preserving the "clean -fd -e ..." shape, and src/git.test.ts
pins the earlier-commit plus untracked-sweep behavior. src/suppression-gate.ts
likewise drops its private readAtTree for git.readFileOnRef. The reset
mechanics now live in one module; the stage keeps only the naming of "a
cleaner range".

### A-04 and A-04-2 - RESOLVED

src/orchestrator.ts (restoreStageId, ~:7682-7690): the comment now reads
"routes[0] reads that agreed target off the first route", matching the
"routes[0] && routes[0].route.target === 'writing-stage'" read below it. No
at(-1) claim remains at that site.

### A-05 - REPEATED (note)

src/logger.ts:214 still initializes "enabled: policyFor(attempt.stage) ??
true", and the summary rows at :781 render "${outcome.enabled ? 'yes' : 'no'}"
from the same derivation readQualityStageOutcomes exposes to the PR body. A
stage with attempts but no quality-stage-policy event therefore prints yes
from a default rather than an unknown marker. Nothing in the fix diff touches
src/logger.ts. Measurement-only surface (ADR 0063: nothing thresholded or
gated on it), so it stays a note; the clear condition is unmet.

### A-06 - new (note)

src/scope-gate.ts:158-162 re-derives the unwaivable accepted-pair set with the
same "artifactDir === '' || acceptedPairIntact" predicate that
src/escalation.ts:319-331 already computes internally. Two copies of one
authority rule can drift - a future change to how the pair's exemption is
decided must be made twice. Preferable: export the predicate (or an
unwaivableSliceArtifactPaths helper) from escalation.ts and have the gate call
it, keeping the seam's single owner as ADR 0055 Seam 1 intends. Behavior today
is correct and pinned, so this is a note only; it is new in this round and is
not INTEGRITY or DATA_LOSS, so it carries no blocking authority.

## Note on the seam refactor (no finding)

src/cleaner-continuation.ts is a thin translation layer: the session keeps
cleaner state and terminal policy, the adapter keeps generator-loop and
slice-lifecycle authority with the orchestrator, and the getter throws rather
than reading a stage result before the first advance. That is a net reduction
in orchestrator branching at the cleaner boundary and reads consistently with
the module-per-seam convention the rest of src/ uses.

## Structured findings (v2)

{"version":2,"findings":[{"id":"A-01","title":"Restore re-dispatch ignores the cleaner stage's EXHAUSTED and ESCALATED outcomes","class":"INTEGRITY","clearCondition":"After the RESTORE re-dispatch the merged stage result's terminal outcomes are acted on with the same authority as the first dispatch, pinned by a test.","disposition":"RESOLVED","reachableTrigger":null,"introducedByReviewedDiff":false},{"id":"A-02","title":"additionalWriteScope pre-filter runs ahead of the unwaivable accepted-pair carve-out in outOfScopeChangedPaths","class":"AUTHORITY","clearCondition":"The additionalWriteScope widening cannot remove ORCHESTRATOR_OWNED_SLICE_FILENAMES from classification, so the orchestratorOwned refusal stays unwaivable as P-10 states.","disposition":"RESOLVED","reachableTrigger":null,"introducedByReviewedDiff":false},{"id":"A-03","title":"cleaner-stage re-implements a hard reset and untracked sweep instead of using git.ts","class":"CONVENTION","clearCondition":"The cleaner's reset either routes through src/git.ts or documents at the sweep site why no untracked slice artifact can be destroyed by it.","disposition":"RESOLVED","reachableTrigger":null,"introducedByReviewedDiff":false},{"id":"A-04","title":"restoreStageId's comment describes an at(-1) read the code does not perform","class":"MAINTAINABILITY","clearCondition":"The comment above restoreStageId describes the routes[0] read the code makes.","disposition":"RESOLVED","reachableTrigger":null,"introducedByReviewedDiff":false},{"id":"A-04-2","title":"restoreStageId's comment describes an at(-1) read the code does not perform","class":"MAINTAINABILITY","clearCondition":"The comment above restoreStageId describes the routes[0] read the code makes.","disposition":"RESOLVED","reachableTrigger":null,"introducedByReviewedDiff":false},{"id":"A-05","title":"Quality-stage rows print enabled=yes from a default when no quality-stage-policy event describes the stage","class":"EVIDENCE","clearCondition":"A stage with no quality-stage-policy event renders an unknown marker rather than a defaulted 'yes' in the summary row and the PR table.","disposition":"REPEATED","reachableTrigger":null,"introducedByReviewedDiff":false},{"id":"A-06","title":"scope-gate duplicates escalation.ts's accepted-pair exemption predicate","class":"MAINTAINABILITY","clearCondition":"The unwaivable accepted-pair path derivation has one owner, exported from escalation.ts and called by scope-gate.ts.","disposition":"OPEN","reachableTrigger":null,"introducedByReviewedDiff":false}]}

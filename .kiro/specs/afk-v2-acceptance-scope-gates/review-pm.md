# PM review — PRD 4 (acceptance and scope gates), invocation scope: slice 06 (#132)

**Verdict:** ACCEPT-WITH-NOTES

## What I judged

Only slice 06 (#132) "Merge resolution round". The other manifest slices
were not executed by this invocation and are recorded at the bottom as
operator information only.

## The promised user outcome

PRD D15: "the conflict hunks and the merged sibling diffs enter
`prompts/generator-repair.md` as a data block. The resolved tree re-runs the
slice's candidate gate phase (`src/candidate-gate-phase.ts`) and its behavior
bindings before the merge retries inside the same mutex critical section; a
resolution failing any gate writes terminal `CONFLICT` with both branches
preserved." PRD D3: after a resolution round the scope comparison base is
"re-resolved to the feature-branch tip that was merged in". PRD D21:
`MERGE-PENDING` semantics unchanged.

For an operator, that means: a wave that used to stop with "CONFLICT, finish
the merge by hand" now spends one automated round and, when it works, ships
both slices — and when it does not work, the operator is left exactly where
they were before, with nothing destroyed.

### D15 — data block in the existing repair prompt: delivered

`prompts/generator-repair.md` (diff `main..HEAD`, +11 lines after the
`stuck.md` paragraph) gains framing prose for a `# Merge conflict to resolve`
block and no new template file. `src/context-envelope.ts` adds
`MERGE_RESOLUTION_SITUATION_SECTION`, registers it in
`REPAIR_SITUATION_SECTION_TITLES` (so surrounding section extents stay
correct), and adds `withMergeResolutionSituation` /
`mergeResolutionBlockRoom`. `src/merge-resolution.ts:185-250`
(`boundMergeResolutionBlock`) drops whole files with a note naming them and
the worktree to read them in, so the block cannot overflow the envelope
budget. Verified by reading both files plus the named tests
`src/context-envelope.test.ts:2708, 2741, 2766, 2805`.

### D15 — gates re-run on the resolved tree, inside one mutex: delivered

`src/merge-resolution.ts:331-498` merges the feature tip into the slice
branch with `git merge --no-commit --no-ff`, dispatches the generator,
verifies the resulting commit really is that in-progress merge
(`:410-428`), computes `HEAD^{tree}` and re-enters the exported
`runCandidateGatePhase` (`:432-437`) with declarations passed in by
`src/orchestrator.ts:6672-6677` — `scopeGateDeclaration`, the pre-QA set,
`acceptanceGateDeclaration` (behavior bindings) and the full-suite set. A
required gate not `PASS` returns `GATES-RED` with no retry (`:438-460`).
`src/wave.ts:596-672` performs first attempt → resolution → retry inside a
single `mergeMutex(...)` callback; the round is only dispatched when
`first.result.status === "conflict"` and the resolver is wired.
`src/merge-resolution.ts:507-522` refuses a declaration set that omits a
required `scope` gate, so the gate re-run cannot silently lose the
comparison D3 needs.

### D15 — failure preserves both branches: delivered

`UNRESOLVED` aborts only the merge this module started (`:397-409`,
`abortStartedMerge` at `:560`); every other failure keeps the generator's
resolution commit on the slice branch and never resets (ADR 0039). The
feature tip is untouched on all failure paths because the retry is the only
thing that moves it. `src/wave.ts` maps any non-`RESOLVED` verdict back to
today's terminal `CONFLICT` with git's own details.

### D3 — re-resolved base: delivered

`src/orchestrator.ts:6594` resolves the feature branch label to a sha
(`resolveRef`) and passes that sha as both the merge base of the round and
the scope gate's `featureRef` (`:6661-6671`), so a path owned by an
already-merged sibling is attributed to that sibling. `acceptedPairIntact`
starts `false` and is set only from a real comparison after the generator
returns (`:6734-6738`) — not hard-coded true. Covered by
`src/merge-resolution.test.ts:313` and `:337`.

### D21 — `MERGE-PENDING` untouched: delivered

`src/wave.ts:611-616` returns before any resolution dispatch when
`first.kind === "collision"`, so a prefix-collision deferral still records
`MERGE-PENDING` and never spends a round
(`src/wave-migrations.test.ts:1145`).

### The end-to-end outcome is proven, not asserted

`src/wave-migrations.test.ts:1311-1463` builds a real two-lane wave, advances
the feature branch out of band to create a genuine textual conflict, runs
one resolution round and asserts both slices end `PASS`, exactly one round
was dispatched, and a competing mutex acquisition queued inside the round
does not settle until the retry has already merged. That is the user outcome
this slice exists for, observed rather than described.

Also delivered: the round is recorded distinctly from repair rounds — the
`merge-resolution-round` run event (`src/run-events.ts`, with `verdict` and
`durationMs`) and its own `## Merge Resolution Rounds` section in
`run-summary.md` (`src/logger.ts`), rendered only when such a round ran.
`src/git.ts`, `src/candidate-gate-phase.ts`, `src/scope-gate.ts`,
`src/acceptance-gate.ts` and `src/run-state.ts` are untouched by this
slice's commits (`git diff --stat 88e5e8a..HEAD`), as its contract froze.

## Notes (not blocking)

### P-01 — on a retry prefix collision the operator is told the merge was deferred, then gets terminal CONFLICT

**Evidence I gathered.** `src/wave.ts:645-660` maps
`retry.kind === "collision"` to a synthetic conflict attempt whose details
are `"The resolved tree could not be merged: " +
git.mergePendingReason(retry.prefixes, featBranch)`. I read
`mergePendingReason` at `src/git.ts:795-805`: its text ends
`"merge deferred; the next run retries the merge (no agent, no
regeneration)."` The phase actually recorded on that path is terminal
`CONFLICT`, which no next run retries. So the recorded outcome is right
(contract B-06) and the sentence the operator reads is wrong about what
happens next. Narrow and rare (it needs a migration-prefix collision to
appear between the gate re-run and the retry, inside a held mutex), text
only, nothing parses the string — hence a note. This is the same ground as
the slice's own QA-01; the reading above is mine.

### P-02 — the production seam that wires the round has no test through it

**Evidence I gathered.** `runSliceMergeResolution` is the function that
builds the envelope, the declaration set, the `acceptedPairIntact`
attestation and the run event; grepping the tree, it appears only at
`src/orchestrator.ts:6576` (definition) and `:7837` (the `WaveInput` wiring)
— no test file names it. The wave-level fixture
(`src/wave-migrations.test.ts:1385-1427`) supplies its own stub resolver that
always returns `RESOLVED`, so neither the orchestrator seam nor the
retry-collision branch executes under test. The user-facing risk is bounded:
a defect there returns `UNRESOLVED` (`:6816-6837`) and the slice degrades to
the terminal `CONFLICT` it would have had without the round, so the failure
mode is the pre-slice status quo rather than a lost or corrupted merge.
Worth a follow-up assertion, not a ship block.

## Out-of-scope PRD gaps (operator information only, no bearing on the verdict)

- Slices 01 (#84), 02 (#85), 03 (#91), 04 (#96), 05 (#86), 07 (#193) and
  08 (#195) were not executed by this invocation; PRD requirements D1, D2,
  D4-D14, D16-D20 and D22-D24 are therefore not judged here.
- D4's role write-scope enforcement remains a seam without a production call
  site; the PRD already records #226 as its owner.

## Structured findings (v1)

{"version":1,"findings":[{"id":"P-01","title":"Retry prefix-collision detail promises a deferred merge while the run records terminal CONFLICT","class":"PRODUCT","clearCondition":"The retry-collision detail in src/wave.ts names the colliding prefixes without asserting a deferral or a next-run retry.","disposition":"OPEN"},{"id":"P-02","title":"runSliceMergeResolution, the production wiring of the round, is exercised by no test","class":"PRODUCT","clearCondition":"A test drives the merge path through runSliceMergeResolution (including the retry-collision branch) and asserts the outcome an operator sees.","disposition":"OPEN"}]}

# QA Report

**Verdict:** PASS
**Failure class:** NONE

## Pass 1: Functional Correctness
- Pre-QA commands: PASS
- UAT verification: NOT IN SCOPE
- Boundary compliance: PASS
- Preservation check: PASS

Commands run in this worktree, not cited from the skip authorization (writing
these two QA artifacts changes the tree, so I measured both myself):

- `pnpm install --frozen-lockfile` — exit 0, "Lockfile is up to date", `prepare`
  (`tsc -p tsconfig.build.json`) clean.
- `pnpm run typecheck` — `tsc --noEmit`, exit 0, no diagnostics.

Behavior verification (read against `88e5e8a..HEAD`, 12 files, +2105/-7):

- **B-01** `src/wave.ts:606-660` holds the only new call site; the body is in
  `src/merge-resolution.ts`. `src/orchestrator.ts:7837` wires
  `runSliceMergeResolution` into `WaveInput.resolveMergeConflict`, and the
  pre-wave MERGE-PENDING recovery site is untouched. Covered by
  `src/wave-migrations.test.ts:1443` (one dispatch, both slices PASS).
- **B-02** The block rides the existing `{{REPAIR_SITUATION}}` slot under one
  level-1 heading (`MERGE_RESOLUTION_SITUATION_SECTION`), which is registered in
  `REPAIR_SITUATION_SECTION_TITLES`; `prompts/generator-repair.md` gains framing
  prose only and no prompt file was added
  (`src/context-envelope.test.ts:2708,2741` asserts both, including that a
  following `# Prior handoff` keeps its extent past the block's fenced diffs).
- **B-03** `runMergeResolutionRound` computes `treeId` as
  `git rev-parse HEAD^{tree}` on the resolution merge commit and re-enters the
  exported `runCandidateGatePhase` — no duplicated body. It assembles no
  declaration; `requireDeclaredScopeGate` refuses a set missing the required
  `scope` gate. `src/merge-resolution.test.ts:216` pins the parents, the tree id
  and both gate outcomes.
- **B-04** A red required gate returns `GATES-RED` before any retry; the wave
  then records terminal CONFLICT with `first.result.details`. Test at
  `src/merge-resolution.test.ts:260` asserts the resolution commit is still the
  slice tip, the feature tip is unmoved and the pre-round tip is still an
  ancestor.
- **B-05** First attempt, round, gate re-run, marker scan and retry are one
  `mergeMutex(async () => …)` body. I checked the reentrancy claim by reading:
  the resolver uses direct `execFileSync` plumbing, `runCandidateGatePhase` and
  `ctx.invoke` take no merge-mutex path. `src/wave-migrations.test.ts:1452`
  proves the span with an instrumented mutex and a competitor queued from inside
  the round that does not settle until the retry has already merged.
- **B-06** Marker refusal fires after green gates and before the retry
  (`src/merge-resolution.test.ts:282`, one dispatch, feature tip unmoved). The
  retry-collision mapping (`src/wave.ts:645-660`) is correct in phase but its
  detail text and its coverage are the two advisory findings below.
- **B-07** `scopeGateDeclaration` is handed
  `{ kind: "candidate", worktreeDir: ctx.worktreeDir, featureRef: featureTip }`
  with `featureTip` a proven sha (`resolveRef`), and `acceptedPairIntact` starts
  `false` and is set from `mutatedAcceptedContractFiles(...).length === 0` after
  the generator returns. I verified the mechanism is sound:
  `src/scope-gate.ts:164-171` reads its input inside the `run` closure, so the
  post-dispatch mutation is what the gate sees. `src/scope-gate.ts` is
  unmodified. Both halves tested (`:313` sibling file is no violation, `:337` a
  false attestation names `contract.md`).
- **B-08** Additive `merge-resolution-round` payload with `verdict` and
  `durationMs` and no cost field; its own `## Merge Resolution Rounds` section,
  rendered only when such a round ran (`src/merge-resolution.test.ts:495,523`).
- **B-09** `first.kind === "collision"` returns before the resolver exists;
  `src/wave-migrations.test.ts:1145` throws from the resolver to prove it is
  never called and still asserts MERGE-PENDING with prefix `042`.
- **B-10** `boundMergeResolutionBlock` is pure, drops whole files (never a
  truncated diff), reserves the drop note at its widest, keeps hunks ahead of
  sibling diffs, and names the worktree.  `mergeResolutionBlockRoom` measures the
  room by rendering with an empty block and clamps the override to the
  manifest's ceiling (`src/context-envelope.test.ts:2766,2805`).

Boundary compliance: every path in `88e5e8a..HEAD` is in the contract's declared
list. The one path outside it is
`.kiro/specs/afk-v2-acceptance-scope-gates/slices/06-merge-resolution-round/handoff.md`,
the slice's own process artifact — not a finding, and no amendment is requested.
Migration files: 0, as declared.

Preservation: P-01 the collision branch is byte-unchanged and tested; P-02
`src/git.ts` is unmodified; P-03 `prompts/generator-repair.md` is purely
additive and `src/prompt-template.test.ts` is unmodified; P-04
`projectGeneratorRepairSituation` and the commit-log bounding are unchanged and
still exercised through the new block's fences; P-05 the clean-merge path is
reached unchanged when `first.result.status !== "conflict"`; P-06
`src/candidate-gate-phase.ts` is unmodified and its two existing call sites are
untouched. `src/run-state.ts`, `src/scope-gate.ts` and `src/acceptance-gate.ts`
are unmodified, as the contract's non-goals require.

One correctness question I checked rather than assumed: after the resolution
merge commit the slice branch carries the sibling's migration files, so the
retry's prefix check could have produced a false collision.
`findMigrationPrefixCollisions` (`src/git.ts:629-636`) only collides on a shared
prefix under a *different* filename, and a merged sibling contributes the same
filename — no false positive is introduced.

## Pass 2: Quality & Craft
- Convention compliance: PASS
- Code quality: PASS
- Test quality: NOTES

The new module reads like the surrounding code: reason-giving comments over
restated mechanics, the tree model stated once at the top and referenced by step
number, pure functions exported where the guarantee is testable without a
repository, and the verdict/policy split (module returns a verdict, `src/wave.ts`
owns the CONFLICT/MERGE-PENDING mapping) keeps one owner per decision. The
`round: 0` identity, the omitted `prepare` gate and the non-throwing resolver are
each argued in place. `runSliceMergeResolution` is ~290 lines inline in
`src/orchestrator.ts`, which is large but matches that file's existing shape for
a dispatch seam.

Test notes: assertions are load-bearing rather than smoke — the mutex span is
proven by a queued competitor and an ancestry check, not by counting calls; the
marker scan is pinned against a Markdown setext underline and an indented
marker; the bounding test asserts the block is under budget *and* that the
sibling diff is what yielded. The gap is QA-02 below.

## Resolved findings
- none (no findings were routed to this QA stage)

## Findings
### Finding 1 — Retry-collision CONFLICT carries a "merge deferred" reason
**Severity:** Minor
**Pass:** 1
**Evidence:** `src/wave.ts:645-660` builds the retry-collision attempt's details
as `The resolved tree could not be merged: ` + `git.mergePendingReason(...)`
(`src/git.ts:795-803`), whose text ends "merge deferred; the next run retries the
merge (no agent, no regeneration)". The wave then records terminal CONFLICT for
that attempt. No consumer parses the string — the only other uses are
`src/orchestrator.ts:7636` and `src/wave.ts:674`, both genuine MERGE-PENDING
paths — so this is operator-facing text, not routing.
**What the contract expected:** B-06 — "either records terminal `CONFLICT` — the
collision case included, since a round has already been spent and
`MERGE-PENDING` is reserved for the untouched first-attempt path".
**What I observed:** The recorded phase is right (terminal CONFLICT, no second
round); the detail an operator reads tells them the merge was deferred and the
next run will retry it, which for a terminal CONFLICT is not true.

### Finding 2 — Two named test-plan scenarios have no test
**Severity:** Minor
**Pass:** 2
**Evidence:** `retry.kind` and "The resolved tree could not be merged" appear
only at `src/wave.ts:649` and `:655`; `runSliceMergeResolution` appears only at
`src/orchestrator.ts:6576` and `:7837`. No test file references either. The
wave-level fixture (`src/wave-migrations.test.ts:1300-1470`) injects its own stub
resolver that always returns `RESOLVED`, so neither the retry-collision branch
nor the orchestrator's envelope/declaration/event assembly executes under test.
The `acceptedPairIntact` attestation is covered with a hand-built declaration
(`src/merge-resolution.test.ts:337`) but not through the code that mutates
`scopeGateInput` after the dispatch (`src/orchestrator.ts:6700-6720`).
**What the contract expected:** Test plan — "Given a retry whose
`git.attemptMerge` returns a prefix collision rather than a fast-forward, when
the round ends, then terminal `CONFLICT` is persisted — not `MERGE-PENDING` — and
no second round is dispatched (B-06)."
**What I observed:** Every behavior ID B-01…B-10 has at least one named test, so
the Definition of done item is met, and the marker-refusal half of B-06 is well
covered; the retry-collision scenario the test plan enumerates is not asserted
anywhere, and the orchestrator seam is untested end to end. Advisory rather than
blocking: the branch is ten lines and correct by inspection, and the slice's
shipped behavior is not wrong.

# Context — slice 06 (#132), Merge resolution round

Evidence map for the planner/generator. See `prd.md` D3, D15 and issue #132
for the settled decisions; this file states only what the repository
confirms. Do not restate PRD prose here — cite it.

## Files and current behavior

- FACT: `src/merge-resolution.ts` does not exist yet (checked via `Glob
  src/merge-resolution*` — no matches). This slice creates it, per the
  issue body.
- FACT: The real merge attempt that can produce a textual conflict runs in
  `src/wave.ts`, not `src/orchestrator.ts`. `src/wave.ts:576-598`, inside a
  per-slice lane loop, calls `await mergeMutex(() =>
  git.attemptMerge(repoRoot, branch, featBranch, scratchMergeDir))` and
  branches on `attempt.kind === "collision"` (records `MERGE-PENDING`,
  `:579-588`) then `mergeResult.status === "conflict"` (records `CONFLICT`,
  `:591-597`, comment: "a human is now genuinely needed"). This is the one
  call site the issue's "the merge path" refers to for a *first* attempt.
- FACT: `src/orchestrator.ts:7217` (`const mergeMutex = makeAsyncMutex();`)
  constructs the mutex; `makeAsyncMutex` is defined at
  `src/orchestrator.ts:811` and exported for `wave.ts` to accept as a typed
  parameter (`mergeMutex: <T>(fn: () => Promise<T>) => Promise<T>`,
  `src/wave.ts:58`) — one mutex instance per run, shared by the wave loop
  and by the pre-wave `MERGE-PENDING` recovery block.
- FACT: `src/orchestrator.ts:7273-7376` is a *second*, separate merge-conflict
  site: pre-wave `MERGE-PENDING` recovery (ADR 0029-recoverable-merge-deferral).
  It re-runs `git.attemptMerge` under the same `mergeMutex` for slices
  recorded `MERGE-PENDING` from a prior run, and on `attempt.result.status
  === "conflict"` records terminal `CONFLICT` (`:7352-7358`) with no retry.
  The issue's acceptance criteria say nothing about this second site, and
  #132's Blocked-by list (#85, #195) is written against the QA/gate
  machinery a *slice's own* generator would re-run — a stale branch
  recovered with no live worktree or agent has no generator to dispatch a
  resolution round to. See Unknowns.
- FACT: `git.attemptMerge` (`src/git.ts:766-787`) is "the body of the merge
  mutex's critical section, in one place so the wave's first attempt and a
  later run's merge-only recovery cannot diverge (ADR 0029)" — it checks
  migration-prefix collisions first, then calls `mergeSliceBranch`.
- FACT: `mergeSliceBranch` (`src/git.ts:1006-1058`) is where a real
  conflict is detected: it runs `git merge <sliceBranch> --no-edit` inside
  a feature-branch worktree (or a scratch worktree it creates), and on
  throw immediately runs `git merge --abort` (`:1032-1036`) before
  returning `{ status: "conflict", details: execErrorDetails(err) }`. The
  abort happens unconditionally, in the same function, before the caller
  ever sees the conflict. **No conflict markers or in-progress merge state
  survive this call** — by the time `wave.ts` reads `mergeResult.status
  === "conflict"`, the working tree is already clean again.
- FACT: `execErrorDetails` (`src/git.ts:33-39`) returns the failed `git
  merge` command's `stderr`, else `stdout`, else `err.message` — the
  ordinary git conflict output (`"Auto-merging <path>\nCONFLICT (content):
  Merge conflict in <path>"` per colliding file, from experience with git's
  own messages), which names *which files* conflicted but carries no hunk
  diff content. `MergeResult`'s `conflict` variant (`src/git.ts:20`) has
  only `details: string` — no path list, no hunk field.
- INFERENCE: Because the merge is aborted before the caller sees it and
  `MergeResult` carries only a details string, "the conflict hunks" the
  issue's acceptance criteria require the resolution prompt to contain
  (AC1) do not exist anywhere in today's data path — this slice's module
  must itself either (a) re-run the merge without `--no-edit`+immediate
  abort so conflict markers land in a worktree it controls, or (b) compute
  the hunks separately (e.g. `git merge-tree` or a non-aborting merge
  attempt in a disposable worktree) before `mergeSliceBranch`'s existing
  abort-on-conflict behavior fires. Drawn from: `git.ts:1006-1058`,
  `execErrorDetails`, `MergeResult` shape. See Unknowns.
- FACT: `runCandidateGatePhase` (`src/candidate-gate-phase.ts:47-160`) is
  the one function the issue names as what a resolution round must re-run
  ("re-runs ... `runCandidateGatePhase`"). Its existing call site is
  `src/orchestrator.ts:5994` (inside `runSlice`'s pre-QA gate block, not on
  the merge path), confirming the issue's anchors-file claim that this is a
  re-entry, not a duplicated body: the merge-resolution module must call
  the same exported function with a fresh `treeId`/`cwd` for the resolved
  tree, not reimplement gate execution.
- FACT: `runCandidateGatePhase`'s `treeId` argument is threaded straight
  into `runGates`'s tree-identity gate cache (`gate-cache.ts`, cited by
  `src/candidate-gate-phase.ts:59-61`'s comment "Tree-identity gate cache");
  a resolution round re-running gates on a genuinely different tree
  (post-resolution) must pass a treeId that reflects that tree, or the
  cache could return a stale `PASS` from the pre-conflict candidate.
- FACT: `outOfScopeChangedPaths` (`src/escalation.ts:196-262`) takes
  `acceptedPairIntact: boolean` **with no default** (`:210`) — "proven, not
  assumed" (docstring `:206-209`). `src/scope-gate.ts` (created by slice 08,
  #195, already merged — confirmed present via `Read src/scope-gate.ts`)
  wraps this as `ScopeGateInput.acceptedPairIntact` with the identical
  no-default contract (`src/scope-gate.ts:74-80`). Any resolved-tree gate
  re-run this slice adds must supply a caller-proven value for this field,
  never a hard-coded `true`.
- FACT: `ScopeComparisonSource` (`src/scope-gate.ts:36-61`) already has a
  `{ kind: "candidate"; worktreeDir; featureRef }` variant whose docstring
  (`:43-48`) states verbatim: "`featureRef` is used verbatim as git's
  three-dot base ... That is also what makes a slice tree with the feature
  branch merged into it behave: the merge base is the merged tip, so an
  already-merged sibling's paths are not in this slice's changed set."
  This is D3's re-resolved-base mechanism already built by slice 08 — this
  slice's job (per the issue: "the scope gate on a resolved tree... this
  slice must not add a second exemption of its own") is to pass the
  correct `featureRef` (the tip that was merged in during resolution) into
  this existing variant, not to add new scope-comparison logic.
- FACT: `src/context-envelope.ts` declares one `ContextEnvelopeManifest`
  per role today (confirmed: `EXPLORER_CONTEXT_MANIFEST`,
  `:34-79`, is the only exported manifest constant found by reading the
  file's opening block); no `repair` or `merge-resolution` envelope exists
  yet. `renderPrompt("generator-repair", {...})` is called from
  `src/orchestrator.ts` for ordinary repair rounds — no
  `renderPrompt("generator-repair", ...)` call was found via a scoped grep
  of `context-envelope.ts` (wrong file to search) and a repo-wide grep for
  the same string returned no matches in `src/orchestrator.ts` either
  under the pattern tried; the exact call site line was not located. See
  Unknowns.
- FACT: `prompts/generator-repair.md` (full file read) has these top-level
  sections in order: `# Objective`, `# Write boundary`, `# Stop condition`,
  `# Scope escalation`, `# Repair situation` (holds `{{REPAIR_SITUATION}}`),
  `# Locked contract view`, `# Acceptance manifest`, `# Task`, `# Patterns
  and harness`, `# Handoff contract`, `# Current failure set`. There is
  **no `GATE-SCOPE` literal and no three-way branch** in this file today —
  the issue's anchors-file claim that slice 01 (#84/D12) edits this same
  "# Scope escalation" section with a `GATE-SCOPE` three-way branch and a
  pinned "Never mix `PRE-BUILD-SCOPE`..." sentence does **not** yet appear
  (a repo-wide search for `GATE-SCOPE` under `src/` found no matches
  either). The current "# Scope escalation" section's exact text (`:24-33`)
  already contains "Never mix `PRE-BUILD-SCOPE` with a real finding ID" —
  so part of that sentence exists without `GATE-SCOPE` alongside it. See
  Unknowns for what this means for landing order.
- FACT: `{{REPAIR_SITUATION}}` is the one placeholder the template exposes
  for situation-specific data (`prompts/generator-repair.md:39`), immediately
  followed by prose about `stuck.md` being read-only — confirming the
  template already carries more than one kind of "situation" as data
  substituted into one slot, which is the seam D15 says a merge-conflict
  situation extends rather than a new template.
- FACT: `ChangeSummary` (`src/change-summary.ts:45-60`) is built from
  `(cwd, fromRef, toRef)` via `execFileSync` git plumbing, independent of
  `src/git.ts`, and its module header states "One producer, two variants
  ... every variant is the same two-ref read with its refs bound
  differently" — the existing mechanism the ARCHITECTURE.md seam list
  names for "a new evaluator's input" being "a variant binding those two
  refs, never a second producer." A resolution round's need for "the
  already-merged sibling diffs" (issue body) is the same shape of ask:
  diffs between the slice's fork point and the current feature-branch tip.
  Whether this slice is expected to reuse `ChangeSummary` for that purpose,
  or read raw `git diff`/`git log` directly (as `change-summary.ts`'s own
  header says `src/git.ts` callers already do for similar plumbing needs
  outside its file scope), is not settled by anything read. See Unknowns.
- FACT: `git.ts` exports `mergeBranchIntoWorktree` (`:845-860`) and
  `createCandidateMerge` (`:867-...`) as the two other conflict-detecting
  merge helpers in the file, both of which also abort-and-report rather
  than leaving markers; neither is the function `wave.ts`'s merge path
  calls (that is `attemptMerge` → `mergeSliceBranch`), but both confirm the
  abort-then-report pattern is this file's convention, not an accident of
  one function.

## Patterns and test harness

- FACT: ADR 0029 `docs/adr/0029-recoverable-merge-deferral.md` (full file
  read) is the governing ADR for the merge mutex's shape: "checking the
  prefixes against the feature-branch tip and merging must be atomic ...
  The check belongs inside the merge mutex and stays there" and "`CONFLICT`
  keeps its meaning unchanged — a real git merge conflict, human resolution
  required, both branches preserved." The issue explicitly says this
  slice "extends ADR 0029" and that "MERGE-PENDING semantics ... are
  unchanged: this round runs only for real textual conflicts, never for
  prefix-collision deferrals" — consistent with the ADR's own boundary
  between the two refusal kinds.
- FACT: There is a second, differently-numbered ADR file at the same
  number, `docs/adr/0029-guardian-prompts-use-bash-for-file-writes.md`
  (two files both prefixed `0029-`, confirmed via glob) — unrelated to this
  slice; do not confuse the two when citing "ADR 0029" in the contract.
- FACT: The retry-inside-the-same-mutex requirement (AC5) is the pattern
  the pre-wave `MERGE-PENDING` recovery block already follows for its own
  retry (`src/orchestrator.ts:7333`, `await mergeMutex(() =>
  git.attemptMerge(...))`) — same function, same mutex instance, invoked a
  second time. This slice's retry-after-resolution should follow the same
  shape: call `git.attemptMerge` again inside `mergeMutex` from within
  `wave.ts`'s existing critical section, not open a second mutex acquisition
  outside it (an acquisition outside would defeat AC5's "same critical
  section as the original attempt").
- FACT: `src/wave.test.ts` and `src/wave-migrations.test.ts` are the split
  test files for `wave.ts` per `CLAUDE.md`'s "three biggest suites are each
  split across two test files" note; a conflict-path test belongs in
  whichever of the two already covers `attemptMerge`/`CONFLICT` handling —
  not read in full here, but named by `CLAUDE.md` as the pair to check
  before adding a new spawn (`pnpm run test:heavy:wave` runs both).
- FACT: `AGENTS.md`/`CLAUDE.md`'s assertion ladder (unit → existing spawned
  scenario → new fixture slice → new spawn as last resort) applies here.
  A cross-lane textual conflict (AC1) is inherently a two-slice, real-git
  scenario, which argues for extending an existing multi-slice wave fixture
  with a deliberately conflicting pair rather than a wholly new spawn — but
  no existing conflict-inducing fixture was located in this pass; see
  Unknowns.
- FACT: `src/gate-runner.test.ts` drives `runGates` with real
  `GateDeclaration`s (`process.execPath` running an inline script) rather
  than mocks (cited by slice 08's own context.md,
  `.kiro/specs/afk-v2-acceptance-scope-gates/slices/08-file-scope-gate/context.md`
  lines ~180-184) — the convention to follow for any new coverage that
  exercises `runCandidateGatePhase` from the resolution module, rather than
  stubbing gate execution.
- FACT: `src/escalation.test.ts` unit-tests `outOfScopeChangedPaths`
  directly with no git process spawned (per slice 08's context.md) — the
  convention for any pure-function piece of the resolution module (e.g. a
  hunk-extraction or prompt-data-shaping helper) that does not itself need
  a real repository.
- FACT: `pnpm test` costs ~7 minutes on Windows per `CLAUDE.md`; the
  self-run test-command convention is `pnpm run typecheck && pnpm test:fast`,
  and slice agents run `pnpm test:fast` plus the heavy suites their change
  touches (`test:heavy:wave` for this slice) before handoff, never the full
  suite.

## Data and integration

- FACT: `RunEventPayload` (`src/run-events.ts:31-...`) is an open union of
  object-literal variants (e.g. `"wave-dispatched"`, `"lanes-partitioned"`,
  `"gate-outcome"` at `:143` per slice 08's context.md) — "written as an
  open set of object-literal members, so a new variant ... needs no
  schema-migration decision by itself" (slice 08's context.md, corroborated
  by reading the file's variant list here). AC8 ("Run events and
  `run-summary.md` record the resolution round, its verdict, and its cost
  distinctly from generator repair rounds") is satisfiable as a new
  variant added to this union, following the same pattern as
  `gate-outcome`.
- FACT: `CandidateGateOutcome` (`src/candidate-gate-phase.ts:19-41`) is the
  typed shape `runCandidateGatePhase` reports per gate result via
  `onGateOutcome`; a resolution round's re-run of this phase produces the
  same outcome shape, so distinguishing "resolution round" gate outcomes
  from ordinary repair-round ones (AC8) needs either a wrapping event
  (e.g. a new `"merge-resolution-round"` event bracketing the gate outcomes)
  or a tag threaded through — `CandidateGateOutcome` itself has no free
  field for a round-kind tag today.
- FACT: `SliceLifecycle`/`RunState` persistence is version-3 (per slice
  08's context.md, `src/run-state.ts:50`, confirmed pattern of hard-coded
  `version: 3` at save/load sites) — a new resolution-round outcome that
  must be distinguishable in the persisted record (AC4: "writes terminal
  `CONFLICT` to the persisted slice state with both branches preserved")
  can reuse the existing `CONFLICT` phase shape unless a new field is
  needed to mark "conflict after a resolution attempt" distinctly from
  "conflict on the first attempt" — not settled by anything read; the
  issue's ACs describe behavior (terminal `CONFLICT`, both branches
  preserved) without naming a new persisted field. See Unknowns.

## Unknowns

- UNKNOWN: How the resolution round is meant to obtain literal conflict
  hunks given that `mergeSliceBranch` (`src/git.ts:1006-1058`) aborts the
  merge immediately on conflict and returns only a details string with no
  path list or hunk content (`execErrorDetails`, `MergeResult`). Whether
  this slice adds a non-aborting merge step (a disposable worktree that is
  left in conflict state for the module to read hunks from before its own
  abort/cleanup) or computes hunks via a separate command (`git merge-tree`
  or similar) is not settled by anything read.
- UNKNOWN: The exact call site in `src/orchestrator.ts` the issue refers to
  ("one call site on the merge path in `src/orchestrator.ts`") when the
  actual first-attempt merge and conflict branch live in `src/wave.ts:591-598`,
  and the only conflict-producing code literally inside `src/orchestrator.ts`
  is the separate pre-wave `MERGE-PENDING` recovery block
  (`:7273-7376`), which has no live generator/worktree to dispatch a
  resolution round to. Whether the module's call site is actually in
  `wave.ts` (with `orchestrator.ts` only wiring the mutex/config through, as
  it already does) is not settled.
- UNKNOWN: Whether the pre-wave `MERGE-PENDING`-recovery conflict branch
  (`src/orchestrator.ts:7352-7358`) is in scope for this slice's resolution
  round at all, given it runs before any wave dispatch and against a
  branch with no active worktree or generator invocation this run. The
  issue's acceptance criteria are silent on this second site.
- UNKNOWN: Where `renderPrompt("generator-repair", ...)` is actually called
  from for ordinary repair rounds — not located in this pass despite a
  targeted grep — and therefore how the merge-resolution round's call
  would differ from (or reuse) that call site's option-building code.
- UNKNOWN: Whether slice 01's (#84/D12) planned `GATE-SCOPE` three-way
  branch and pinned literal in `prompts/generator-repair.md`'s "# Scope
  escalation" section has landed. As read now, no `GATE-SCOPE` string
  exists anywhere under `src/`, and the section's current text does not
  match the anchors-file's description of a three-way branch. This
  slice's D15 data block must be checked against whichever version of that
  section is present at generation time, not assumed to be the version
  described in #132's anchors.
- UNKNOWN: Whether `ChangeSummary` (`src/change-summary.ts`) is the
  intended mechanism for "the already-merged sibling diffs" data (issue
  body), or whether this slice reads raw git plumbing directly the way
  `change-summary.ts`'s own header says other modules outside `src/git.ts`'s
  file scope already do. `src/change-summary.ts` is not named in the
  issue's "What to build" file list (`src/merge-resolution.ts`,
  `src/orchestrator.ts`, `src/context-envelope.ts`,
  `prompts/generator-repair.md`).
- UNKNOWN: Whether a new persisted-state field (beyond the existing
  `CONFLICT` phase shape) is needed to distinguish "conflict after a
  resolution round ran" from "conflict on the first attempt" for AC6's "no
  resolution loop" guarantee, or whether that guarantee is enforced purely
  by control flow (the module is called at most once per merge attempt)
  with no new persisted marker.
- UNKNOWN: No existing wave-fixture test was located in this pass that
  deliberately induces a cross-lane textual conflict between two slices;
  whether one already exists elsewhere in `src/wave.test.ts` /
  `src/wave-migrations.test.ts` (not read in full) that AC1's coverage
  could extend was not confirmed.

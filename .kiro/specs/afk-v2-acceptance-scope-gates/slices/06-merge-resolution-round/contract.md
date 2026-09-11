# Slice Contract — Merge-resolution round on CONFLICT

**Parent PRD:** .kiro/specs/afk-v2-acceptance-scope-gates/prd.md
**GH issue:** #132
**Status:** LOCKED

**Lock-Provenance:** negotiation round 3
**Negotiation round:** 2

## Scope lock

A real git merge conflict on the wave's merge path dispatches exactly one
scoped resolution round before the slice records terminal `CONFLICT`. A new
module `src/merge-resolution.ts` computes the conflict hunks and the
already-merged sibling diffs, hands them to the slice's generator as a data
block inside the existing repair situation (`prompts/generator-repair.md`,
PRD D15 — no new template), re-enters `runCandidateGatePhase`
(`src/candidate-gate-phase.ts`) on the resolved tree with the slice's own
required gate declarations including `scope` and `acceptance:behaviors`, and
retries the merge — the first attempt, the resolution, the gate re-run and the
retry all inside one `mergeMutex` acquisition (ADR 0029: the check and the
merge are atomic). One round only: any red required gate, a resolved tree that
still carries conflict markers, or a conflict on the retry falls back to today's
terminal `CONFLICT`. Prefix-collision `MERGE-PENDING` deferrals never enter this
path.

### Resolution tree model (one tree, stated once)

Every behavior below uses exactly this model; it is the single tree identity
B-03, B-04, B-06, B-07 and B-10 refer to.

1. The round runs in **the slice's own existing worktree** on the slice branch.
   No disposable worktree is created, and no second checkout of the slice
   branch exists.
2. `src/merge-resolution.ts` merges the **feature-branch tip into the slice
   branch** in that worktree (`git merge --no-commit` of the re-resolved base,
   PRD D3), leaving the conflicted index in place. The conflict hunks and the
   already-merged sibling diffs are read from that same worktree — the
   conflicted index for hunks, `merge-base..featureTip` for sibling diffs — so
   the module never calls `git.mergeSliceBranch` (which aborts before its
   caller sees the conflict, `src/git.ts:1032-1036`).
3. The generator **resolves in that worktree and commits the in-progress
   merge** — the merge state started in step 2 is never discarded, so the
   resolution commit is a **merge commit whose first parent is the pre-round
   slice-branch tip and whose second parent is the feature-branch tip that was
   merged in**. The slice branch tip advances to that merge commit during a
   successful round. This is the tree the gate re-run proves and the tree the
   retry merges. **Decision recorded here:** the alternative — discard the merge
   state and commit a plain resolution so the retry stays a real merge — is
   rejected, because a plain commit would re-present the same conflict to the
   retry inside the same held mutex, which is the failure this slice exists to
   remove; and the merge commit is what makes the resolved tree the tree that
   actually reaches the feature branch (step 6).
4. If the generator leaves the merge unresolved (no commit, conflicted index
   still present), the resolver aborts the merge **it started**, restoring the
   slice branch tip, and the round fails.
5. **Failure disposition (decision recorded here):** a resolution merge commit
   that the generator did make is **kept on the slice branch and never reset
   away**, on a gate failure, on a conflict-marker refusal (step 7) and on a
   retry conflict alike — ADR 0039
   (`docs/adr/0039-restart-never-destroys-unmerged-commits.md`): unmerged
   commits are never destroyed. The **feature branch tip is unmoved** by a
   failed round, and both refs still exist. "Both branches preserved" in this
   contract means exactly that: feature tip unmoved, both refs alive, no reset
   of slice-branch work — not that the slice branch tip is unchanged.
6. **What the retry means under this model:** because step 3's merge commit
   carries the feature-branch tip as a parent and the held `mergeMutex` (B-05)
   keeps that tip from moving, the retried `git.attemptMerge` is a
   **fast-forward** of the feature branch to the resolution merge commit. It
   runs through the same unmodified `git.attemptMerge` (P-02: the
   migration-prefix check still precedes it), so a prefix collision is still
   possible on the retry; a *textual* conflict on the retry is not reachable
   while the mutex is held. The retry therefore ships exactly the tree the gates
   proved — no third tree exists.
7. **Conflict-marker refusal (decision recorded here):** because the retry is a
   fast-forward, the gate re-run is not the last thing standing between a bad
   resolution and the feature branch — a resolved tree can pass `tests` and
   `typecheck` while still containing conflict markers in a file no gate reads
   (a Markdown doc, a fixture, a prompt template). So after the gate re-run and
   **before** the retry, `src/merge-resolution.ts` scans the resolution merge
   commit's blobs **for the paths that were conflicted in step 2** for
   conflict-marker lines (`<<<<<<< `, `======= `, `>>>>>>> ` at line start). Any
   hit refuses the retry and the round fails per step 5. The scan is a pure
   function over path/content pairs, not a gate declaration: it guards this
   slice's own retry, it is not part of any slice's declared gate set, and
   adding a catalog gate is out of scope here.

### In scope

- [behavior:B-01] A real textual conflict at the wave merge path
  (`src/wave.ts:591-598`, `mergeResult.status === "conflict"`) dispatches
  exactly one resolution round per slice per run, through one new call in
  `src/wave.ts` to a resolver `src/orchestrator.ts` wires into `WaveInput`;
  `src/merge-resolution.ts` holds the round's body. **Decision recorded here:**
  the issue says "one call site on the merge path in `src/orchestrator.ts`" and
  the PRD file-scope map does not name `src/wave.ts`, but the only first-attempt
  merge that can produce a textual conflict for a dispatched slice is
  `src/wave.ts:576-598`; `src/orchestrator.ts` holds only the mutex
  construction (`:7217`), the generator/provider machinery, and the pre-wave
  recovery site. AC5's "same critical section as the original attempt" is
  therefore unbuildable without editing `src/wave.ts`, so this contract
  declares it, per the issue's own Code-anchors Method ("check the PRD's claim
  about it against the actual declaration"). `src/wave.ts` is an
  ARCHITECTURE.md hub, so it gains one call site and no logic.
- [behavior:B-02] The conflict hunks and the merged sibling diffs reach the
  generator as a data block in the existing `{{REPAIR_SITUATION}}` slot of
  `prompts/generator-repair.md` (PRD D15, mechanism M5), assembled in
  `src/context-envelope.ts`; the block's level-1 heading is added to
  `REPAIR_SITUATION_SECTION_TITLES` (`src/context-envelope.ts:1684-1690`) so
  section extents stay correct, and `prompts/generator-repair.md` gains only
  framing prose naming the block and the resolve-don't-rescope obligation. No
  new prompt template and no new prompt file.
- [behavior:B-03] Before any retry, the resolved tree — the slice's own
  worktree at the resolution merge commit (tree model step 3), per the tree
  model above — re-enters the exported
  `runCandidateGatePhase` (`src/candidate-gate-phase.ts:47`) — re-entry, not a
  duplicated body — with a `treeId` computed from that merge commit's tree
  (`git rev-parse HEAD^{tree}` in the slice worktree, so the id names the tree
  the fast-forward will ship, not the branch tip label) and with
  the slice's own required declarations, including the `scope` gate
  (`scopeGateDeclaration`, `src/scope-gate.ts:164`) and the behavior bindings
  (`acceptanceGateDeclaration`, `src/acceptance-gate.ts:350`). The declarations
  are built by `src/orchestrator.ts`, which already builds both
  (`:5937`, `:6319`), and passed in; `src/merge-resolution.ts` assembles no
  declarations of its own.
- [behavior:B-04] A resolution whose gate re-run leaves any required gate not
  `PASS` performs no retry: the slice records terminal `CONFLICT` with the
  original `mergeResult.details`, the feature branch tip is unmoved, both refs
  still exist, and the generator's resolution merge commit stays on the slice
  branch (tree model steps 3 and 5; ADR 0039 — no reset, no destroyed unmerged
  commit).
- [behavior:B-05] The first `git.attemptMerge`, the resolution round, the gate
  re-run, the conflict-marker scan (tree model step 7) and the merge retry all
  execute inside a single `mergeMutex(...)`
  acquisition in `src/wave.ts`, so no sibling lane can merge between the tree
  the gates proved and the tree that merges — which is also what keeps the
  retry a fast-forward of the parent the resolution merge commit already
  carries (tree model step 6) (ADR 0029:
  `docs/adr/0029-recoverable-merge-deferral.md`, "the check belongs inside the
  merge mutex and stays there"). **Decision recorded here:** the mutex is held
  across the generator invocation; correctness beats merge throughput, and this
  PRD's slices already share one lane. `mergeMutex` is not documented as
  reentrant and the same instance is shared with the pre-wave `MERGE-PENDING`
  recovery path (`src/orchestrator.ts:7217`), so nothing reached from inside
  the widened critical section acquires `mergeMutex`: the resolver, the gate
  re-run and the generator invocation take no merge-mutex path, and the
  resolver's own git work uses direct plumbing rather than any helper that
  acquires it. A reentrant acquisition would deadlock the run instead of
  failing a gate, so this is asserted by test, not by convention.
- [behavior:B-06] The retry produces at most one round, and no bad tree reaches
  the feature branch through it. **Decision recorded here** (this is the shape
  tree-model step 6 forces): under step 3's merge commit and B-05's held mutex
  the retry is a fast-forward, so a *textual* conflict on the retry is
  unreachable and this contract does not claim a fixture for one. What the
  retry can still return is `git.attemptMerge`'s prefix collision or an
  unexpected non-fast-forward `conflict` result; either records terminal
  `CONFLICT` — the collision case included, since a round has already been spent
  and `MERGE-PENDING` is reserved for the untouched first-attempt path (B-09,
  P-01) — and dispatches no second round. The tree-content case the finding
  asked about is caught **before** the retry by tree-model step 7's
  conflict-marker refusal, which also records terminal `CONFLICT` with no
  retry and no second round. So the fixture lever is a stubbed gate phase
  forced to `PASS` over a generator that commits the merge with conflict
  markers left in a file no gate reads: the marker scan refuses, the retry never
  runs, and the markers never reach the feature branch (see Test plan). The
  single-round guarantee itself is control flow — the resolver is called from one
  place, once per merge attempt — with no new persisted marker.
- [behavior:B-07] The `scope` gate on the resolved tree is passed the existing
  `{ kind: "candidate", worktreeDir, featureRef }` source
  (`src/scope-gate.ts:36-61`) with `worktreeDir` the slice's own worktree (tree
  model step 1) and `featureRef` set to the feature-branch tip that was merged
  in (PRD D3's re-resolved base) and a caller-proven
  `acceptedPairIntact` (`src/scope-gate.ts:74-82`, `src/escalation.ts:196`:
  no default, "proven, not assumed" — never a hard-coded `true`), so a path
  owned by an already-merged sibling is not reported as this slice's violation.
  This slice adds no second exemption and no scope-comparison logic.
- [behavior:B-08] The round is recorded distinctly from a generator repair
  round: a new `src/run-events.ts` payload variant carrying the round's
  `verdict` and its `durationMs`, and its own `run-summary.md` section written
  from `src/logger.ts` showing that same verdict and duration. Those two field
  names — `verdict` and `durationMs` — are the only ones the payload owes;
  nothing here records a cost. **Deferrable tail (decision recorded here):** of
  the ten behaviors, B-08 alone has no dependency on the merge path, so if the
  session runs long B-08 is the one behavior to drop to a follow-up issue; the
  other nine (B-01…B-07, B-09, B-10) are indivisible, because a resolution
  round that dispatches without gates, bounding or the collision guard is not
  shippable.
- [behavior:B-09] A `MERGE-PENDING` prefix-collision deferral
  (`attempt.kind === "collision"`, `src/wave.ts:579-588`) returns without
  dispatching a resolution round; ADR 0029's `MERGE-PENDING` semantics are
  untouched (PRD D21).
- [behavior:B-10] The data block is bounded by a pure function in
  `src/merge-resolution.ts`: hunks and sibling diffs are truncated to the room
  the repair envelope's inline-size budget leaves, dropping whole files with a
  named note pointing at the paths in the worktree, so the block carries hunks
  and diffs rather than full sibling histories and cannot overflow the budget
  (`src/context-envelope.ts:1811-1855`, #230). **Decision recorded here:**
  `src/merge-resolution.ts` obtains hunks itself via git plumbing **in the
  slice's own worktree** (tree model step 2 — no disposable worktree), following
  `src/change-summary.ts`'s precedent of direct plumbing outside
  `src/git.ts`, because `mergeSliceBranch` aborts the merge before its caller
  sees it (`src/git.ts:1032-1036`) and `MergeResult`'s conflict variant carries
  only `details: string`.

### Non-goals (explicit out-of-scope)

- The pre-wave `MERGE-PENDING` recovery conflict site
  (`src/orchestrator.ts:7273-7376`): it runs before any dispatch, against a
  branch with no live worktree or generator, so there is nothing to dispatch a
  resolution round to. The issue's acceptance criteria are silent on it.
- Any change to `src/run-state.ts`. The existing terminal `CONFLICT` phase
  record already satisfies AC4 and AC6, AC8's distinct recording is a run event
  plus a `run-summary.md` section, and the single-round guarantee is control
  flow (B-06) — so no persisted-schema version bump is taken. Schema history is
  a declared risk class, avoided here rather than paid.
- Any change to `src/git.ts`, `src/candidate-gate-phase.ts`,
  `src/scope-gate.ts` or `src/acceptance-gate.ts`: this slice calls and reads
  them.
- Optimistic lanes (PRD Out of scope), more than one resolution round, and any
  operator-facing conflict-resolution surface.

### Existing behavior to preserve

- [behavior:P-01] `src/wave.ts:579-588`: a collision still records
  `MERGE-PENDING` with `git.mergePendingReason` and its colliding prefixes, and
  still continues the lane.
- [behavior:P-02] `git.attemptMerge` / `mergeSliceBranch`
  (`src/git.ts:766-787`, `:1006-1058`) keep their behavior: the migration-prefix
  check precedes the merge, a conflicting merge is aborted immediately, and
  both branches survive.
- [behavior:P-03] `prompts/generator-repair.md`'s existing sections and
  placeholders are only added to, never rewritten — including the
  `# Scope escalation` literal and its "Never mix `PRE-BUILD-SCOPE` with a real
  finding ID" sentence pinned by `src/prompt-template.test.ts:167-190` and the
  `{{REPAIR_SITUATION}}` slot at `:39`.
- [behavior:P-04] `src/context-envelope.ts`'s #230 repair-situation behavior is
  unchanged: `projectGeneratorRepairSituation` still replaces by-reference
  quotes with pointers, and the commit log is still the block that yields to
  the inline-size budget.
- [behavior:P-05] The clean merge path is unchanged: no conflict means the same
  `cleanupWarning` log, the same `git.removeWorktreeOrWarn` under the git-admin
  mutex, and the same `PASS` (`src/wave.ts:599-616`).
- [behavior:P-06] `runCandidateGatePhase`'s existing pre-QA and post-QA call
  sites (`src/orchestrator.ts:5994`, `src/post-qa-gates.ts:215`) and its
  bounded infrastructure-retry behavior are unchanged.

### Changes to existing behavior (only if the issue asks for it)

- `src/wave.ts`'s conflict branch no longer records terminal `CONFLICT`
  immediately: it first runs one resolution round, and records terminal
  `CONFLICT` only when that round fails a gate, leaves conflict markers in the
  resolved tree, or the retry does not fast-forward (issue
  #132, "A real git merge conflict at the merge mutex dispatches one scoped
  resolution round before recording terminal `CONFLICT`").
- The `mergeMutex` critical section in `src/wave.ts` widens from the single
  `git.attemptMerge` call to first attempt + resolution + gate re-run +
  conflict-marker scan + retry (issue #132 AC5; ADR 0029's atomicity
  requirement is preserved, not relaxed).

## Files expected to change

- src/merge-resolution.ts
- src/merge-resolution.test.ts
- src/wave.ts
- src/wave-migrations.test.ts
- src/orchestrator.ts
- src/context-envelope.ts
- src/context-envelope.test.ts
- src/run-events.ts
- src/logger.ts
- prompts/generator-repair.md
- ARCHITECTURE.md

## Migration requirements

- New migration files: 0

## New patterns / deps / schema (if any)

- One new `src/run-events.ts` payload variant for the resolution round, added
  to that file's open union of object literals — no schema-version decision.
- No new runtime dependency: AFK has none, and the conflict-hunk read is
  `node:child_process` git plumbing in the new module.

## Test plan

- Given the existing two-lane real-conflict fixture
  (`src/wave-migrations.test.ts:1198`, "still records CONFLICT for a real git
  merge conflict"), when the conflicting slice's generator resolves the
  conflict, then the wave records `PASS` for it, exactly one resolution round
  is dispatched, the captured prompt contains the conflicting file's hunks
  and the merged sibling's diff but no sibling commit history, and the merged
  feature tip is the resolution merge commit whose second parent is the
  pre-retry feature tip (tree model steps 3 and 6 — the retry fast-forwarded).
- Given a resolution round with the merge state in place, when the generator's
  resolution commit is inspected, then it has two parents — the pre-round slice
  tip and the merged feature tip — and the `treeId` handed to
  `runCandidateGatePhase` is that commit's tree (B-03).
- Given the same fixture with a stub generator that resolves nothing, when the
  round ends, then the resolver has aborted the merge it started, the slice
  records terminal `CONFLICT`, both refs still exist with the feature tip at its
  pre-round commit, and no second round is dispatched.
- Given a resolution whose tree fails a required gate, when the gate re-run
  returns, then no retry runs, the persisted slice phase is `CONFLICT`, the
  feature tip is unmoved, and the generator's resolution merge commit is still
  reachable from the slice branch (B-04, ADR 0039).
- Given a stubbed gate phase forced to `PASS` over a generator that commits the
  merge with conflict markers left in a file no gate reads, when the round
  reaches the pre-retry marker scan, then the retry never runs, terminal
  `CONFLICT` is persisted, the feature tip is unmoved and carries no marker
  lines, and exactly one resolution round was dispatched (B-06's fixture lever,
  tree model step 7).
- Given path/content pairs with and without `<<<<<<< `, `======= ` and
  `>>>>>>> ` line-starts, when the marker scan runs, then it names exactly the
  marker-carrying paths and passes clean content untouched (unit test, no git).
- Given a retry whose `git.attemptMerge` returns a prefix collision rather than
  a fast-forward, when the round ends, then terminal `CONFLICT` is persisted —
  not `MERGE-PENDING` — and no second round is dispatched (B-06).
- Given an instrumented `mergeMutex` that throws on reentrant acquisition, when
  a full resolution round runs inside the widened critical section, then the run
  completes without a reentrant acquisition and without deadlock (B-05).
- Given a prefix-collision deferral, when the merge path runs, then
  `MERGE-PENDING` is recorded and the resolver is never called.
- Given a resolved worktree with the feature tip merged in, when the `scope`
  gate runs with `featureRef` at that tip, then a path owned by an
  already-merged sibling produces no violation, and an `acceptedPairIntact` of
  `false` still names the contract pair.
- Given conflict hunks larger than the room the repair envelope leaves, when
  the block is bounded, then whole files are dropped with a note naming them
  and the rendered repair prompt stays inside the inline-size budget (unit
  test, no git).
- Given a completed resolution round, when the run summary is written, then it
  carries a resolution-round section with the round's `verdict` and
  `durationMs`, distinct from the generator repair rounds.

## Definition of done

- [ ] `src/merge-resolution.ts` exists and holds the round's body; `src/wave.ts`
      gains one call and no resolution logic.
- [ ] Every behavior B-01…B-10 has at least one test named with its ID.
- [ ] No code path reached inside the widened `mergeMutex` critical section
      acquires `mergeMutex`, proven by a test, not by inspection.
- [ ] A failed round leaves the feature branch tip unmoved and resets nothing on
      the slice branch.
- [ ] No tree carrying conflict markers in a previously conflicted path can
      reach the feature branch: the pre-retry scan refuses it even when every
      required gate returned `PASS`.
- [ ] `src/git.ts`, `src/candidate-gate-phase.ts`, `src/scope-gate.ts`,
      `src/acceptance-gate.ts` and `src/run-state.ts` are unmodified by this
      slice.
- [ ] `prompts/generator-repair.md` gains a data-block section and no new
      template file; `src/prompt-template.test.ts` passes unmodified.
- [ ] `pnpm run typecheck`, `pnpm test:fast` and `pnpm run test:heavy:wave` pass
      on the slice branch.
- [ ] ARCHITECTURE.md's module table names `src/merge-resolution.ts`.

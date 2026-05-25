# Worktree creation must verify, not trust, on-disk state

**Date:** 2026-05-24

## Context

After ADR 0009 contained post-merge throws so sibling lanes could
survive, a new failure mode surfaced in PRD 024 / 029 runs on Windows:
**every slice was reported `ERROR — generator produced no output` even
though the agents had clearly executed and committed.** Investigation
showed the commits had landed on the consumer repo's currently
checked-out feature branch, not on the slice branch the orchestrator
expected. Multiple PRDs' worth of work (PRD 024 slices 01 + 04, PRD
029 slice scaffolding) had silently piled up on whichever branch the
user happened to have checked out at the time of each run.

The root cause sat upstream of the post-merge guard in `createWorktree`
(`src/git.ts`):

```ts
if (existsSync(worktreeDir)) return;     // ← silent reuse of any directory
createBranch(repoRoot, branch, from);
git(["worktree", "add", worktreeDir, branch], { cwd: repoRoot });
```

The `existsSync` short-circuit treated **any** directory at that path
as a valid worktree. On Windows, `removeWorktree` is a three-layer
best-effort cleanup that swallows every error; when both `git worktree
remove --force` AND Node's `rmSync` failed (file lock from pnpm's
`node_modules/.pnpm/`, antivirus scanning the tree, junction
permissions), the directory leaked but git's admin state was already
pruned. Next run: `existsSync(worktreeDir)` was true, `createWorktree`
short-circuited, and **no slice branch was ever created**. The agent
was then dispatched with `cwd: ctx.worktreeDir`, ran `git commit`, and
git walked up from cwd looking for `.git` — landing on the parent
repo's `.git` and committing to whatever branch the user had checked
out.

The downstream symptom was deceptive: ADR 0009's `hasCommitsAhead`
returned `false` for the missing slice branch (correct for sibling-lane
resilience), so the wave reported `ERROR — generator produced no
output` — the *same* message used for legitimate empty runs. Operators
investigated phantom no-output bugs while their feature branches
silently accumulated cross-PRD commits.

## Decision

Three layered invariants enforce that an agent never executes against
a directory git doesn't recognise as a worktree.

**1. `createWorktree` validates pre-existing paths.** Before reusing,
it queries `findWorktreeForBranch` and accepts the path only when git
agrees the directory is the worktree for the requested branch.
Otherwise it throws — the operator is told the directory is stale,
warned about Windows / pnpm / antivirus causes, and instructed to
remove it manually after verifying no uncommitted work. We deliberately
do **not** auto-remove — a stale-looking directory may contain
in-progress user work, and silent deletion is exactly the failure mode
this ADR exists to prevent.

**2. `wave.ts` distinguishes "branch missing" from "0 commits ahead".**
ADR 0009's collapse of both into the same `ERROR — generator produced
no output` message was correct for resilience but masked corruption.
The wave now checks `branchExists(slice branch)` before
`hasCommitsAhead`. A missing slice branch after a successful generator
run is the canonical signature of the corruption bug; surfacing it as a
distinct error directs operators to inspect `git reflog --all` and
`git worktree list --porcelain` rather than chasing phantom empty
runs. `hasCommitsAhead` keeps its ADR 0009 behaviour.

**3. `assertWorktreeRegistered` is a pre-dispatch check.** Even with
(1) in place, `recreateWorktreeFromBase` (the lane-successor refresh
path) does a `removeWorktree → deleteBranch → createWorktree` sequence
whose intermediate states leave room for filesystem races. A second
check, called immediately after every `createWorktree` /
`recreateWorktreeFromBase` and immediately before agent dispatch, makes
silent corruption impossible to cross the agent boundary regardless of
which path got us there.

## Consequences

- A previous run's leaked worktree directory now causes the next run
  to fail loudly at slice negotiation rather than silently funnel
  commits to the wrong branch. The error message points at the likely
  causes (Windows file locks, pnpm node_modules, antivirus, path
  length).
- Operators investigating "no commits ahead" reports get an unambiguous
  signal when the underlying cause is corruption rather than a true
  empty run.
- The architecture issue this exposed — `removeWorktree`'s
  swallow-everything cleanup model leaving callers unable to tell
  whether teardown succeeded — is left for a follow-up. After this fix,
  a leaked directory becomes a loud per-slice failure rather than
  silent corruption, so the worst case is recoverable by humans.
- Tests in `src/git.test.ts` (`createWorktree` rejects stale dirs and
  branch-mismatched worktrees; `assertWorktreeRegistered` covers the
  pre-dispatch check) and `src/wave.test.ts` (branch-missing surfaces
  with a distinct error) lock the contract.

## Out of scope

- Recovering the consumer-side commits already misrouted before this
  fix lands — that's a one-time human cherry-pick from the wrong
  branch's reflog, not something the pipeline should automate.
- Reworking `removeWorktree` to surface failures structurally — left
  as an architecture follow-up. The current fix makes leaks loud at
  the next run; structural error returns from `removeWorktree` would
  let the orchestrator refuse to start at all, which is a stronger
  guarantee but a bigger change.
- Eliminating the underlying Windows-specific causes (path length,
  antivirus, junction permissions). The pre-dispatch assertion makes
  these failure modes visible; root-causing them is a follow-up if
  they prove frequent enough to warrant per-cause handling.

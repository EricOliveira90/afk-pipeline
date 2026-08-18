# `afk clean-failed`: one command for dead-slice debris

## Failure mode

Failed and stuck slices deliberately preserve their worktree and branch
for postmortem. On Windows, clearing that debris before a re-run is a
four-step manual sequence per dead slice: `git worktree remove --force`
(fails "Directory not empty" on pnpm's `node_modules/.pnpm`), a
PowerShell `Remove-Item -Recurse -Force`, `git worktree prune`, and
`git branch -D afk/<slug>-slice-*`. The PRD 075 babysit run performed
it ~3× per slice across five recovery cycles — with a live junction
hazard: `Remove-Item -Recurse` on a worktree containing a
`node_modules` junction can traverse into the junction target.

## Decision — a state-driven subcommand with hard scope guards

`afk clean-failed --prd-dir <dir> [--dry-run]` (same subcommand on
`afk-claude` / `afk-codex`, which resolve their provider's namespace).
First bare-token subcommand in the CLIs; dispatch happens before flag
parsing so the existing flag surface is untouched.

Three passes (src/clean-failed.ts):

1. **State-driven** — every slice in `.afk/state/<runSlug>.json` with a
   failure phase (STUCK / ESCALATE / ERROR / CONFLICT / CANCELLED /
   LANE-CANCELLED): remove its worktree (registered location when git
   knows one, else the `.afk/worktrees/<prefix>-<prdSlug>-s<NN>` naming
   formula), then delete its branch **only when it has no commits ahead
   of the feature branch**. A STUCK slice's partial implementation or a
   CONFLICT branch awaiting manual resolution is kept and reported with
   the reason — committed work is never lost. When the feature branch
   itself is missing, every branch is kept (nothing to verify against).
2. **Unregistered leftovers** — on-disk dirs under `.afk/worktrees/`
   matching this PRD's exact `<prefix>-<prdSlug>-s<digits>` pattern that
   git no longer tracks (crashed runs, hand-deleted state, PASS
   cleanups that lost to a file lock). Registered worktrees whose slice
   is NOT in a failure phase are skipped with a report entry — a
   concurrent run's live worktrees stay safe.
3. **Scratch merge dirs** — leftover `.afk/merge-<prefix>-<prdSlug>-s<NN>`
   dirs from interrupted merges.

`git worktree prune` reconciles admin state at the end. `--dry-run`
prints the full plan and a report without touching anything.

## Scope guarantees

- Other PRDs and other providers are untouchable by construction: every
  match is anchored on the full `<prefix>-<prdSlug>-s<digits>` name, so
  `afk-foo-s1` never matches PRD `foo-bar`, and `afk-codex-*` debris is
  invisible to the kiro binary.
- State entries are left alone. There is no retry cap (see issue #17),
  so ERROR entries do not block a re-run and deleting them would erase
  postmortem evidence for no benefit.
- Directory deletion reuses `git.removeWorktree`, whose on-disk
  fallback is Node's `rmSync` — it unlinks junctions instead of
  traversing them, which is exactly the `Remove-Item -Recurse` hazard
  the manual sequence carried. A directory that still cannot be removed
  (live file lock) is reported, not retried forever.

## Alternatives considered

- **Automatic cleanup at run start.** Rejected: preserved worktrees are
  evidence, and a re-run that silently destroys them makes postmortems
  impossible. Cleanup stays an explicit operator action.
- **Deleting branches unconditionally.** Rejected: the guard costs one
  `rev-list` per branch and is the difference between "cleanup" and
  "data loss" for STUCK/CONFLICT branches.
- **Waiting for checkpoint/resume (issue #15).** The issue notes the
  interaction; when resume lands, resumable slices simply won't be in a
  failure phase, so this command's semantics already compose with it.

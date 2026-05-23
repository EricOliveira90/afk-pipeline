# Default branch detection

The orchestrator resolves the consumer repo's integration branch (what
most projects call `main`, but some call `master`, `trunk`, etc.) at
the top of `runPipeline` and threads that value through every place
that previously hardcoded `"main"`: the feat-branch base fallback, the
review worktree creation, and `gh pr create --base`.

## Failure mode

A consumer ran AFK against a repo whose primary branch was `master`.
The first orchestration step — `git.createBranch(repoRoot, featBranch,
"main")` — failed because no `main` ref existed. The hardcode was
duplicated in three places (default param of `createBranch` /
`createWorktree`, the `prd/<slug>` fallback, and the PR base flag), so
fixing one wasn't enough.

## Detection cascade

`getDefaultBranch(cwd)` in `src/git.ts`:

1. **`git symbolic-ref refs/remotes/origin/HEAD`** — authoritative
   when set. `git clone` populates this automatically, so the common
   case (consumer is working in a clone of a remote repo) needs
   nothing extra from the user.
2. **Local probes**: `main`, then `master`. Catches `git init`-created
   repos where `origin/HEAD` was never set, and clones where the user
   explicitly removed origin/HEAD.
3. **Throw** with a remediation hint
   (`git remote set-head origin --auto`).

## Why we don't fall back to HEAD

A tempting fourth step would be "use whatever branch HEAD is currently
pointing at". Rejected: HEAD might be a feature branch, a detached
commit, or a one-off scratch branch. Using it as the integration base
would silently corrupt every downstream decision: feat-branches would
fork from the wrong place, slice merges would diverge from the
expected target, and `gh pr create --base <wrong>` would open a PR
against a branch the user didn't mean. Failing loudly with a one-line
fix is better than guessing.

## Why no `--base-branch` CLI override

Considered and deferred. The cascade handles every reported case; an
override flag adds a config surface for a hypothetical user. The
thrown error tells anyone in a non-standard setup exactly what command
to run. If a real user hits a wall the flag can be added in one place
(`PipelineConfig`) and threaded through.

## Removed `= "main"` defaults

`createBranch` and `createWorktree` previously had `from = "main"` as
a default parameter. Removed: a default that's wrong half the time
hides bugs at the call site. Every caller now passes a base
explicitly, so a future regression that drops the argument fails type
checking instead of silently falling back to a branch that may not
exist.

import { execFileSync, ExecFileSyncOptions } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const git = (args: string[], opts?: ExecFileSyncOptions): string =>
  (execFileSync("git", args, { encoding: "utf-8", ...opts }) as string).trim();

export type MergeResult =
  | { status: "merged"; cleanupWarning?: string }
  | { status: "conflict"; details: string };

function execErrorDetails(err: unknown): string {
  const stderr = (err as { stderr?: string })?.stderr?.trim();
  if (stderr) return stderr;
  const stdout = (err as { stdout?: string })?.stdout?.trim();
  if (stdout) return stdout;
  return err instanceof Error ? err.message : String(err);
}

export function currentBranch(cwd: string): string {
  return git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
}

/**
 * Detects the repo's default branch (the integration target — what most
 * projects call `main` or `master`).
 *
 * Cascade:
 *   1. `origin/HEAD` symbolic ref — authoritative when the remote was set
 *      up by `git clone` (covers the common case).
 *   2. Local `main`, then `master` — covers `git init`-created repos
 *      where `origin/HEAD` was never set.
 *   3. Throw — refusing to guess. Falling back to the *current* HEAD
 *      would be wrong: HEAD might be a feature branch, and using it as
 *      the integration base would silently corrupt the slice graph.
 */
export function getDefaultBranch(cwd: string): string {
  try {
    const ref = git(["symbolic-ref", "refs/remotes/origin/HEAD"], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const prefix = "refs/remotes/origin/";
    if (ref.startsWith(prefix)) return ref.slice(prefix.length);
  } catch {
    // origin/HEAD not set — fall through to local probes.
  }

  for (const candidate of ["main", "master"]) {
    if (branchExists(cwd, candidate)) return candidate;
  }

  throw new Error(
    "Could not determine default branch. Set it with " +
      "`git remote set-head origin --auto`, or create a local `main` or `master` branch.",
  );
}

/** Returns true if the local branch exists. */
export function branchExists(cwd: string, branch: string): boolean {
  try {
    git(["rev-parse", "--verify", `refs/heads/${branch}`], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

export function createBranch(cwd: string, branch: string, from: string) {
  try {
    git(["rev-parse", "--verify", branch], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Branch exists already
  } catch {
    git(["branch", branch, from], { cwd });
  }
}

export function createWorktree(
  repoRoot: string,
  branch: string,
  worktreeDir: string,
  from: string,
) {
  if (existsSync(worktreeDir)) return;
  createBranch(repoRoot, branch, from);
  git(["worktree", "add", worktreeDir, branch], { cwd: repoRoot });
}

export function removeWorktree(repoRoot: string, worktreeDir: string) {
  // Step 1: ask git to remove. On Windows this often fails with
  // "Directory not empty" when pnpm has populated `node_modules/.pnpm/`
  // — git's libc-style unlink walk leaves stragglers behind even with
  // --force. Admin metadata is still unregistered, so the dir is
  // orphaned: not a worktree per `git worktree list`, but on disk.
  try {
    git(["worktree", "remove", worktreeDir, "--force"], { cwd: repoRoot });
  } catch {
    // Already removed, doesn't exist, or stragglers — fall through.
  }

  // Step 2: nuke any on-disk leftovers. Node's rmSync handles pnpm's
  // junctions/symlinks reliably on Windows where git stumbles.
  if (existsSync(worktreeDir)) {
    try {
      rmSync(worktreeDir, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 200,
      });
    } catch {
      // If even rmSync can't get it (file lock from a still-running
      // child process), leave the dir — pruneWorktrees() will at least
      // reconcile git's admin state below.
    }
  }

  // Step 3: reconcile git's admin state in case step 1 silently failed.
  try {
    git(["worktree", "prune"], { cwd: repoRoot });
  } catch {
    // Best effort.
  }
}

export function hasUncommittedChanges(cwd: string): boolean {
  const status = git(["status", "--porcelain"], { cwd });
  return status.length > 0;
}

export function commitAll(cwd: string, message: string) {
  git(["add", "-A"], { cwd });
  git(["commit", "-m", message, "--no-verify"], { cwd });
}

/**
 * Returns true if source has commits that target doesn't.
 *
 * Returns `false` (not throws) when either ref is missing — the
 * caller's invariant of interest is "does source contribute new
 * commits", and a missing ref contributes none. Throwing here would
 * propagate up through `runWave`'s post-merge step (see ADR 0009)
 * and abort sibling lanes still in flight; instead we let the caller
 * report ERROR for that one slice and continue.
 */
export function hasCommitsAhead(
  repoRoot: string,
  source: string,
  target: string,
): boolean {
  try {
    const count = git(["rev-list", "--count", `${target}..${source}`], {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return parseInt(count, 10) > 0;
  } catch {
    return false;
  }
}

/**
 * Merge a source branch into a target branch.
 * Returns true on success, false on conflict.
 */
export function mergeBranch(
  repoRoot: string,
  source: string,
  target: string,
): boolean {
  // Checkout target
  git(["checkout", target], { cwd: repoRoot });
  try {
    git(["merge", source, "--no-edit"], { cwd: repoRoot });
    return true;
  } catch {
    // Conflict — abort the merge
    try {
      git(["merge", "--abort"], { cwd: repoRoot });
    } catch {
      // Already clean
    }
    return false;
  }
}

/**
 * Find an existing worktree that has the given branch checked out, if any.
 * Returns the worktree path or null.
 *
 * Parses `git worktree list --porcelain`, which emits blocks like:
 *   worktree /path/to/repo
 *   HEAD abcd…
 *   branch refs/heads/main
 *   <blank line>
 */
export function findWorktreeForBranch(
  repoRoot: string,
  branch: string,
): string | null {
  const output = git(["worktree", "list", "--porcelain"], { cwd: repoRoot });
  const blocks = output.split(/\r?\n\r?\n/);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    let path: string | null = null;
    let foundBranch: string | null = null;
    for (const line of lines) {
      if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
      else if (line.startsWith("branch refs/heads/"))
        foundBranch = line.slice("branch refs/heads/".length);
    }
    if (path && foundBranch === branch) return path;
  }
  return null;
}

/**
 * Merge a slice branch into the feature branch.
 *
 * If `featureBranch` is already checked out in some worktree (commonly
 * the main repo working tree), we merge there directly — `git worktree add`
 * would otherwise fail with "<branch> is already used by worktree at <path>".
 * Otherwise we create a scratch worktree at `scratchMergeDir` to keep the
 * main working tree undisturbed, and clean it up afterward.
 *
 * `scratchMergeDir` is chosen by the caller so it can keep the path short
 * (Windows MAX_PATH).
 */
export function mergeSliceBranch(
  repoRoot: string,
  sliceBranch: string,
  featureBranch: string,
  scratchMergeDir: string,
): MergeResult {
  const existingWorktree = findWorktreeForBranch(repoRoot, featureBranch);

  let mergeDir: string;
  let cleanupWorktree = false;
  if (existingWorktree) {
    mergeDir = existingWorktree;
  } else {
    mergeDir = scratchMergeDir;
    if (existsSync(mergeDir)) {
      git(["worktree", "remove", mergeDir, "--force"], { cwd: repoRoot });
    }
    git(["worktree", "add", mergeDir, featureBranch], { cwd: repoRoot });
    cleanupWorktree = true;
  }

  let result: MergeResult;
  try {
    git(["merge", sliceBranch, "--no-edit"], { cwd: mergeDir });
    result = { status: "merged" };
  } catch (err: unknown) {
    try {
      git(["merge", "--abort"], { cwd: mergeDir });
    } catch {
      // Already clean
    }
    result = { status: "conflict", details: execErrorDetails(err) };
  }

  if (cleanupWorktree) {
    removeWorktree(repoRoot, mergeDir);
    if (existsSync(mergeDir) && result.status === "merged") {
      result = {
        status: "merged",
        cleanupWarning: `Worktree directory still exists after cleanup: ${mergeDir}`,
      };
    }
  }

  return result;
}

export function pruneWorktrees(repoRoot: string) {
  try {
    git(["worktree", "prune"], { cwd: repoRoot });
  } catch {
    // Best effort
  }
}

export function deleteBranch(repoRoot: string, branch: string) {
  try {
    git(["branch", "-D", branch], { cwd: repoRoot });
  } catch {
    // Branch doesn't exist or can't be deleted
  }
}

/**
 * Tear down `branch`'s worktree (if any) and recreate it from `base`,
 * so the next slice in a lane starts from the latest predecessor-merged
 * feature branch instead of the stale wave-start base. The branch is
 * deleted and recreated to guarantee its tip equals `base`'s tip — a
 * `git reset --hard` inside the existing worktree would also work, but
 * deleting + recreating reuses the well-tested `createWorktree` /
 * `removeWorktree` path that already handles the Windows cleanup edge
 * cases (pnpm `node_modules/.pnpm` stragglers, junction symlinks).
 *
 * Caller is responsible for re-creating any per-slice scratch files
 * (context.md, contract.md) inside the new worktree.
 */
export function recreateWorktreeFromBase(
  repoRoot: string,
  branch: string,
  worktreeDir: string,
  base: string,
): void {
  removeWorktree(repoRoot, worktreeDir);
  deleteBranch(repoRoot, branch);
  createWorktree(repoRoot, branch, worktreeDir, base);
}

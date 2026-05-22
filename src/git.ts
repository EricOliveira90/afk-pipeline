import { execFileSync, ExecFileSyncOptions } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const git = (args: string[], opts?: ExecFileSyncOptions): string =>
  (execFileSync("git", args, { encoding: "utf-8", ...opts }) as string).trim();

export function currentBranch(cwd: string): string {
  return git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
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

export function createBranch(cwd: string, branch: string, from = "main") {
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
  from = "main",
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

/** Returns true if source has commits that target doesn't. */
export function hasCommitsAhead(
  repoRoot: string,
  source: string,
  target: string,
): boolean {
  const count = git(["rev-list", "--count", `${target}..${source}`], {
    cwd: repoRoot,
  });
  return parseInt(count, 10) > 0;
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
 * Otherwise we create a scratch worktree under `.afk/merge-…` to keep the
 * main working tree undisturbed, and clean it up afterward.
 *
 * Returns true on success, false on merge conflict (merge aborted).
 */
export function mergeSliceBranch(
  repoRoot: string,
  sliceBranch: string,
  featureBranch: string,
): boolean {
  const existingWorktree = findWorktreeForBranch(repoRoot, featureBranch);

  let mergeDir: string;
  let cleanupWorktree = false;
  if (existingWorktree) {
    mergeDir = existingWorktree;
  } else {
    mergeDir = join(
      repoRoot,
      ".afk",
      "merge-" + sliceBranch.replace(/\//g, "-"),
    );
    if (existsSync(mergeDir)) {
      git(["worktree", "remove", mergeDir, "--force"], { cwd: repoRoot });
    }
    git(["worktree", "add", mergeDir, featureBranch], { cwd: repoRoot });
    cleanupWorktree = true;
  }

  try {
    git(["merge", sliceBranch, "--no-edit"], { cwd: mergeDir });
    return true;
  } catch {
    try {
      git(["merge", "--abort"], { cwd: mergeDir });
    } catch {
      // Already clean
    }
    return false;
  } finally {
    if (cleanupWorktree) {
      try {
        git(["worktree", "remove", mergeDir, "--force"], { cwd: repoRoot });
      } catch {
        // Best effort
      }
    }
  }
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

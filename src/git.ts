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

/** Compare two filesystem paths case-insensitively on Windows, with normalised slashes. */
function pathEquals(a: string, b: string): boolean {
  const normalise = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const na = normalise(a);
  const nb = normalise(b);
  return process.platform === "win32"
    ? na.toLowerCase() === nb.toLowerCase()
    : na === nb;
}

/**
 * Create a git worktree for `branch` at `worktreeDir`, branching off `from`.
 *
 * Refuses to silently reuse a pre-existing path. If `worktreeDir` exists,
 * it must be a real git worktree registered for `branch`; otherwise we
 * throw rather than dispatch agents into a non-worktree directory whose
 * `git commit` would walk up to the parent repo's `.git` and corrupt the
 * caller's checked-out branch.
 *
 * Background: prior implementations short-circuited on `existsSync`. When
 * a previous run's cleanup failed (Windows file lock, antivirus stragglers
 * in `node_modules/.pnpm/`), the on-disk dir survived but git's admin
 * state was already pruned. The next run treated the leftover as valid,
 * the slice "branch" was never created, and every commit landed on the
 * user's HEAD branch. The fix is to verify, not trust, on-disk state.
 */
export function createWorktree(
  repoRoot: string,
  branch: string,
  worktreeDir: string,
  from: string,
) {
  if (existsSync(worktreeDir)) {
    const registered = findWorktreeForBranch(repoRoot, branch);
    if (registered && pathEquals(registered, worktreeDir)) return;
    throw new Error(
      `Path exists but is not a registered git worktree for branch ${branch}: ${worktreeDir}. ` +
        `A previous run likely left a stale directory after a cleanup failure ` +
        `(common on Windows with pnpm node_modules or antivirus locks). ` +
        `Verify the directory has no uncommitted work, remove it manually, and re-run.`,
    );
  }
  createBranch(repoRoot, branch, from);
  git(["worktree", "add", worktreeDir, branch], { cwd: repoRoot });
}

/**
 * Assert that `worktreeDir` is the git-registered worktree for `branch`.
 * Throws otherwise.
 *
 * Layered defense alongside `createWorktree`'s built-in check. Call this
 * right before dispatching an agent against a worktree — `createWorktree`
 * enforces the invariant at creation time, but `recreateWorktreeFromBase`
 * (the lane-successor refresh path) does a `removeWorktree → deleteBranch
 * → createWorktree` sequence whose intermediate states leave room for
 * filesystem races on Windows. Re-checking just before dispatch makes
 * silent corruption impossible to cross the agent boundary.
 */
export function assertWorktreeRegistered(
  repoRoot: string,
  branch: string,
  worktreeDir: string,
): void {
  const registered = findWorktreeForBranch(repoRoot, branch);
  if (!registered) {
    throw new Error(
      `Worktree for branch ${branch} is not registered with git. ` +
        `Expected at ${worktreeDir}. Likely causes: previous cleanup left a ` +
        `stale directory, antivirus / path-length / permissions blocked ` +
        `'git worktree add', or the worktree was removed out-of-band.`,
    );
  }
  if (!pathEquals(registered, worktreeDir)) {
    throw new Error(
      `Worktree for branch ${branch} is registered at ${registered}, expected ${worktreeDir}.`,
    );
  }
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
 * List files under `supabase/migrations/` on a given ref (branch/commit).
 * Returns basenames only. Empty array if the path or ref is absent — a
 * ref with no migrations contributes no collisions.
 */
export function listMigrationFiles(repoRoot: string, ref: string): string[] {
  try {
    const output = git(
      ["ls-tree", "-r", "--name-only", ref, "--", "supabase/migrations/"],
      { cwd: repoRoot, stdio: ["pipe", "pipe", "pipe"] },
    );
    return output
      .split(/\r?\n/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
      .map((p) => p.slice(p.lastIndexOf("/") + 1));
  } catch {
    return [];
  }
}

/** Extract the leading numeric prefix of a migration filename, or null. */
function migrationPrefix(filename: string): string | null {
  const m = /^(\d+)/.exec(filename);
  return m ? m[1]! : null;
}

/**
 * Pure: numeric prefixes the slice introduces that already exist on the
 * feature branch under a *different* filename. Same prefix + same filename
 * is the slice re-touching a migration it already owns (not a collision);
 * same prefix + different filename is the integration-time schema-ordering
 * collision we must block. See Bug 2.
 */
export function findMigrationPrefixCollisions(
  featFiles: string[],
  sliceFiles: string[],
): string[] {
  const featByPrefix = new Map<string, Set<string>>();
  for (const f of featFiles) {
    const p = migrationPrefix(f);
    if (!p) continue;
    (featByPrefix.get(p) ?? featByPrefix.set(p, new Set()).get(p)!).add(f);
  }
  const collisions = new Set<string>();
  for (const f of sliceFiles) {
    const p = migrationPrefix(f);
    if (!p) continue;
    const existing = featByPrefix.get(p);
    if (existing && !existing.has(f)) collisions.add(p);
  }
  return [...collisions].sort();
}

/**
 * Numeric migration prefixes the slice branch would collide with on the
 * feature branch. Empty array = safe to merge. Compares committed trees
 * (no working-tree state), so it's deterministic under parallelism when
 * called inside the merge mutex against the current feature-branch tip.
 */
export function migrationPrefixCollisions(
  repoRoot: string,
  sliceBranch: string,
  featureBranch: string,
): string[] {
  return findMigrationPrefixCollisions(
    listMigrationFiles(repoRoot, featureBranch),
    listMigrationFiles(repoRoot, sliceBranch),
  );
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

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

/** Errors Windows raises while another process still holds a handle. */
const TRANSIENT_RM_CODES = new Set(["EBUSY", "ENOTEMPTY", "EPERM", "EACCES"]);

/**
 * Block the thread briefly between removal retries. `Atomics.wait` rather
 * than a busy loop so the backoff does not burn CPU on a contended host.
 * Synchronous on purpose: the git module is synchronous throughout, and
 * several callers invoke removeWorktree from `finally` blocks.
 */
function sleepSync(ms: number): void {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

export interface RemoveWorktreeResult {
  /** True when the directory is gone from disk. */
  removed: boolean;
  /** rmSync attempts made against on-disk leftovers (0 if git got it). */
  attempts: number;
  /** Last filesystem error message when `removed` is false. */
  lastError?: string;
}

export interface RemoveWorktreeOptions {
  /**
   * Budget for retrying on-disk removal while another process releases
   * its handles (issue #102: a straggler child with cwd inside the
   * worktree locks it on Windows for a short window after the invocation
   * root settles). Default 10s — comfortably longer than the observed
   * handle lifetimes, bounded so a genuinely wedged process cannot hang
   * teardown forever.
   */
  timeoutMs?: number;
}

/**
 * Remove a worktree: git first, then on-disk leftovers, then prune.
 *
 * Never throws — teardown runs in `finally` blocks and after merges, where
 * an exception would mask the real outcome. Instead the result reports
 * whether the directory is actually gone; callers decide whether a
 * survivor is a loud warning (post-merge cleanup) or a hard stop
 * (recreateWorktreeFromBase). Issue #102: the previous version swallowed
 * every failure after ~600ms of retries, silently producing the ADR 0010
 * partial-tree signature (dir on disk, admin state pruned) whenever a
 * live process still held handles inside the tree.
 */
export function removeWorktree(
  repoRoot: string,
  worktreeDir: string,
  options: RemoveWorktreeOptions = {},
): RemoveWorktreeResult {
  const timeoutMs = options.timeoutMs ?? 10_000;

  // Step 1: ask git to remove. On Windows this often fails when a live
  // process holds handles inside the tree ("Permission denied") or when
  // pnpm has populated `node_modules/.pnpm/` ("Directory not empty") —
  // and git unregisters the admin metadata on the FIRST attempt even when
  // the on-disk delete fails, so there is no point retrying this step:
  // a second call just reports "not a working tree".
  try {
    git(["worktree", "remove", worktreeDir, "--force"], { cwd: repoRoot });
  } catch {
    // Already removed, doesn't exist, or stragglers — fall through.
  }

  // Step 2: remove on-disk leftovers, waiting out transient handle locks.
  // Node's rmSync handles pnpm's junctions/symlinks reliably on Windows
  // where git stumbles. A straggler's handles release when it exits, so
  // the failure is usually transient — retry with bounded backoff instead
  // of giving up after rmSync's built-in ~600ms.
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let lastError: string | undefined;
  while (existsSync(worktreeDir)) {
    attempts++;
    try {
      rmSync(worktreeDir, { recursive: true, force: true });
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      lastError = err.message ?? String(error);
      if (Date.now() >= deadline || !TRANSIENT_RM_CODES.has(err.code ?? "")) {
        break;
      }
      sleepSync(Math.min(50 * attempts, 400));
    }
  }

  // Step 3: reconcile git's admin state in case step 1 silently failed.
  try {
    git(["worktree", "prune"], { cwd: repoRoot });
  } catch {
    // Best effort.
  }

  const removed = !existsSync(worktreeDir);
  return { removed, attempts, lastError: removed ? undefined : lastError };
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

/**
 * Every repo-relative file path on `ref` (committed tree only, no
 * working-tree state). Empty array when the ref or repo is missing —
 * the same tolerant contract as {@link listMigrationFiles}.
 *
 * Listing the whole tree rather than one directory is deliberate:
 * deciding whether a path is a migration belongs to the configured
 * recognition rule (`migrationPathsIn` in `src/lanes.ts`), and scoping
 * the git call to a hardcoded directory is exactly what leaves
 * {@link listMigrationFiles} blind to any layout but Supabase's.
 */
export function listFilesOnRef(repoRoot: string, ref: string): string[] {
  try {
    const output = git(["ls-tree", "-r", "--name-only", ref], {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return output
      .split(/\r?\n/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
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
 * Pure: the lowest prefix above every numeric prefix `featFiles` already
 * uses, rendered at the width of the widest one so a zero-padded scheme
 * stays padded (`003` → `004`) and a timestamp scheme stays a timestamp
 * (`20240101000000` → `20240101000001`).
 *
 * "Above every used prefix" rather than "the first unused gap": a
 * migration runner applies files in prefix order, so a new migration
 * belongs at the end of the sequence. Filling a gap would insert a
 * schema change *before* changes already applied downstream.
 *
 * `BigInt` because a 14-digit timestamp prefix fits a `number` but a
 * longer one silently would not. Returns `"1"` when no file carries a
 * numeric prefix.
 */
export function nextFreeMigrationPrefix(featFiles: string[]): string {
  let highest = 0n;
  let width = 1;
  for (const f of featFiles) {
    const p = migrationPrefix(f);
    if (!p) continue;
    const value = BigInt(p);
    if (value > highest) highest = value;
    if (p.length > width) width = p.length;
  }
  return (highest + 1n).toString().padStart(width, "0");
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
 * Number of commits `source` has that `target` doesn't. Returns 0 (not
 * throws) when either ref is missing, mirroring `hasCommitsAhead`: a
 * missing ref contributes no commits, and the resume decision treats
 * "0 commits beyond base" as a deliberate restart, not an error.
 */
export function countCommitsAhead(
  repoRoot: string,
  source: string,
  target: string,
): number {
  try {
    const count = git(["rev-list", "--count", `${target}..${source}`], {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const parsed = parseInt(count, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  } catch {
    return 0;
  }
}

/**
 * Non-throwing sibling of `assertWorktreeRegistered`: true iff
 * `worktreeDir` is the git-registered worktree for `branch`. Used by
 * the resume-eligibility inspection, which needs a fact, not an
 * invariant failure — an unregistered worktree is a valid restart
 * reason there (ADR 0010 still forbids dispatching into it).
 */
export function isWorktreeRegistered(
  repoRoot: string,
  branch: string,
  worktreeDir: string,
): boolean {
  const registered = findWorktreeForBranch(repoRoot, branch);
  return registered !== null && pathEquals(registered, worktreeDir);
}

/**
 * Discard everything after the last commit in `worktreeDir`:
 * `git reset --hard` for tracked modifications, `git clean -fd` for
 * untracked files and directories. Run before a resumed generator
 * starts so half-applied edits from the moment of death never poison
 * the resumed run — the resume prompt tells the generator exactly what
 * was lost. See the design note on issue #15.
 *
 * `excludePaths` (gitignore-style patterns, repo-relative) survive the
 * clean. The caller passes the specs dir so *untracked* slice
 * artifacts (context.md, contract.md, feedback) outlive the clean —
 * the contract is reused verbatim on resume and explorer/planner stay
 * skipped, which is only possible if their artifacts survive. Tracked
 * modifications are still reverted by the reset regardless of
 * excludes; slice artifacts are untracked until a slice passes QA.
 */
export function resetWorktreeToHead(
  worktreeDir: string,
  excludePaths: string[] = [],
): void {
  git(["reset", "--hard"], { cwd: worktreeDir });
  const excludes = excludePaths.flatMap((p) => ["-e", p]);
  git(["clean", "-fd", ...excludes], { cwd: worktreeDir });
}

/**
 * The slice branch's own commit log beyond `base`, with per-file stats
 * (`git log <base>..HEAD --stat`). Injected into the resume prompt so
 * the generator can verify where its predecessor stopped instead of
 * redoing finished work. Empty string when there are no commits.
 */
export function logCommitsWithStat(worktreeDir: string, base: string): string {
  return git(["log", `${base}..HEAD`, "--stat", "--no-color"], {
    cwd: worktreeDir,
  });
}

/**
 * Committer timestamp of the HEAD commit in `worktreeDir`, in epoch
 * seconds — the reference point for the handoff-freshness check (#38).
 * Null when there is no commit to read (not a repo, unborn branch).
 */
export function lastCommitEpochSeconds(worktreeDir: string): number | null {
  try {
    const out = git(["log", "-1", "--format=%ct"], {
      cwd: worktreeDir,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const parsed = parseInt(out, 10);
    return Number.isNaN(parsed) ? null : parsed;
  } catch {
    return null;
  }
}

/**
 * Outcome of one attempt at the merge-mutex critical section: either the
 * migration prefix check refused before anything was merged, or a real
 * merge was performed and reports its own status.
 */
export type MergeAttempt =
  | { kind: "collision"; prefixes: string[] }
  | { kind: "merge"; result: MergeResult };

/**
 * The body of the merge mutex's critical section, in one place so the
 * wave's first attempt and a later run's merge-only recovery cannot
 * diverge (ADR 0029). Checking the prefixes against the feature-branch
 * tip and merging must be atomic — callers MUST invoke this inside the
 * merge mutex.
 */
export function attemptMerge(
  repoRoot: string,
  sliceBranch: string,
  featureBranch: string,
  scratchMergeDir: string,
): MergeAttempt {
  const prefixes = migrationPrefixCollisions(
    repoRoot,
    sliceBranch,
    featureBranch,
  );
  if (prefixes.length > 0) return { kind: "collision", prefixes };
  return {
    kind: "merge",
    result: mergeSliceBranch(
      repoRoot,
      sliceBranch,
      featureBranch,
      scratchMergeDir,
    ),
  };
}

/**
 * The reason text a deferred merge carries, shared by the merge mutex's
 * refusal and by the next run's merge-only recovery so both say the same
 * thing (ADR 0029). Names the prefixes, states that the work survived,
 * and says what happens next — the operator has nothing to adjudicate.
 */
export function mergePendingReason(
  collidingPrefixes: string[],
  featureBranch: string,
): string {
  return (
    `Migration prefix collision: ${collidingPrefixes.join(", ")} already exists on ` +
    `${featureBranch} under a different filename. The slice's work is committed on its ` +
    `slice branch and QA passed — merge deferred; the next run retries the merge ` +
    `(no agent, no regeneration).`
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
 * Merge `sourceBranch` into the branch checked out at `worktreeDir`,
 * running entirely inside that worktree. Used by the resume path to
 * refresh a resumed slice branch with the current feature branch before
 * the generator starts (#35) — the generator must verify against the
 * world it will eventually merge into, not the stale fork base.
 *
 * The generic `mergeBranch` helper is unsafe here: it checks out the
 * target in the repo root, stomping whatever the operator has checked
 * out. This mirrors `mergeSliceBranch`'s conflict handling instead —
 * on conflict the merge is aborted, leaving the branch tip and worktree
 * exactly as they were; the caller falls back to restart-from-base.
 */
export function mergeBranchIntoWorktree(
  worktreeDir: string,
  sourceBranch: string,
): MergeResult {
  try {
    git(["merge", sourceBranch, "--no-edit"], { cwd: worktreeDir });
    return { status: "merged" };
  } catch (err: unknown) {
    try {
      git(["merge", "--abort"], { cwd: worktreeDir });
    } catch {
      // Already clean
    }
    return { status: "conflict", details: execErrorDetails(err) };
  }
}

/**
 * All registered worktrees with the branch each has checked out (null
 * for detached HEAD). Parses `git worktree list --porcelain`.
 */
export function listWorktrees(
  repoRoot: string,
): Array<{ path: string; branch: string | null }> {
  const output = git(["worktree", "list", "--porcelain"], { cwd: repoRoot });
  const result: Array<{ path: string; branch: string | null }> = [];
  for (const block of output.split(/\r?\n\r?\n/)) {
    let path: string | null = null;
    let branch: string | null = null;
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
      else if (line.startsWith("branch refs/heads/"))
        branch = line.slice("branch refs/heads/".length);
    }
    if (path) result.push({ path, branch });
  }
  return result;
}

/**
 * Find an existing worktree that has the given branch checked out, if any.
 * Returns the worktree path or null.
 */
export function findWorktreeForBranch(
  repoRoot: string,
  branch: string,
): string | null {
  for (const wt of listWorktrees(repoRoot)) {
    if (wt.branch === branch) return wt.path;
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
  options: { removalTimeoutMs?: number } = {},
): void {
  const removal = removeWorktree(repoRoot, worktreeDir, {
    timeoutMs: options.removalTimeoutMs,
  });
  if (!removal.removed) {
    // Issue #102: proceeding here deleted the branch and then failed in
    // createWorktree with a misleading "stale directory" error — after
    // destroying the branch. A locked tree is a retryable infrastructure
    // condition; stop before any destructive step and say why.
    throw new Error(
      `Cannot refresh worktree for ${branch}: directory still present after ` +
        `removal retries (${removal.attempts} attempt(s)): ${worktreeDir}. ` +
        `A live process is likely holding handles inside it` +
        (removal.lastError ? ` (${removal.lastError})` : "") +
        `. Close the process (or wait for it to exit) and re-run.`,
    );
  }
  deleteBranch(repoRoot, branch);
  createWorktree(repoRoot, branch, worktreeDir, base);
}

/** Resolve a branch or ref to its commit SHA, or null when it is absent. */
export function resolveCommit(repoRoot: string, ref: string): string | null {
  try {
    return git(["rev-parse", "--verify", `${ref}^{commit}`], {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
}

/**
 * Resolve a ref to its tree SHA, or null when it is absent. The tree SHA
 * identifies file *content*, independent of commit metadata — the key the
 * pre-ship sanity gate cache uses so a docs-only review commit with the
 * same source tree doesn't force a full gate re-run (ADR 0015).
 */
export function resolveTree(cwd: string, ref = "HEAD"): string | null {
  try {
    return git(["rev-parse", "--verify", `${ref}^{tree}`], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
}

/** Repo-relative migration paths added between the run base and final ref. */
export function listAddedMigrationFiles(
  repoRoot: string,
  base: string,
  head: string,
): string[] {
  try {
    const output = git(
      [
        "diff",
        "--name-only",
        "--diff-filter=A",
        `${base}...${head}`,
        "--",
        "supabase/migrations/",
      ],
      { cwd: repoRoot, stdio: ["pipe", "pipe", "pipe"] },
    );
    return output
      .split(/\r?\n/)
      .map((path) => path.trim())
      .filter(Boolean)
      .sort();
  } catch {
    return [];
  }
}

/** Repo-relative files added between two refs, independent of project layout. */
export function listAddedFiles(
  repoRoot: string,
  base: string,
  head: string,
): string[] {
  try {
    const output = git(
      ["diff", "--name-only", "--diff-filter=A", `${base}...${head}`],
      { cwd: repoRoot, stdio: ["pipe", "pipe", "pipe"] },
    );
    return output
      .split(/\r?\n/)
      .map((path) => path.trim())
      .filter(Boolean)
      .sort();
  } catch {
    return [];
  }
}

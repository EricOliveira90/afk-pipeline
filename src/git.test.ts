import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmDirWithRetry } from "./test-support.js";
import {
  assertWorktreeRegistered,
  branchExists,
  countCommitsAhead,
  createWorktree,
  isWorktreeRegistered,
  lastCommitEpochSeconds,
  logCommitsWithStat,
  mergeBranchIntoWorktree,
  resetWorktreeToHead,
  findMigrationPrefixCollisions,
  findWorktreeForBranch,
  getDefaultBranch,
  hasCommitsAhead,
  listFilesOnRef,
  listMigrationFiles,
  mergeSliceBranch,
  migrationPrefixCollisions,
  nextFreeMigrationPrefix,
  recreateWorktreeFromBase,
  removeWorktree,
} from "./git.js";

/**
 * Regression tests for git.branchExists.
 *
 * Added to guard the PRD 012 run-1 fix where the orchestrator was always
 * initializing `feat/<slug>` from `main` instead of checking for an
 * existing `prd/<slug>` branch. `branchExists` is the primitive that
 * lets the orchestrator make the right choice.
 */

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

describe("git.branchExists", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "afk-git-"));
    // Init a throwaway repo with a single commit so we can create branches.
    git(repoDir, ["init", "--initial-branch=main"]);
    git(repoDir, ["config", "user.email", "test@example.com"]);
    git(repoDir, ["config", "user.name", "Test"]);
    git(repoDir, ["commit", "--allow-empty", "-m", "root"]);
  });

  afterEach(() => {
    rmDirWithRetry(repoDir);
  });

  it("returns true for an existing branch", () => {
    expect(branchExists(repoDir, "main")).toBe(true);
  });

  it("returns false for a branch that does not exist", () => {
    expect(branchExists(repoDir, "prd/999-nothing")).toBe(false);
  });

  it("returns true after creating the branch", () => {
    expect(branchExists(repoDir, "prd/012-foo")).toBe(false);
    git(repoDir, ["branch", "prd/012-foo"]);
    expect(branchExists(repoDir, "prd/012-foo")).toBe(true);
  });

  it("only matches local branches, not remote tracking refs", () => {
    // The orchestrator uses this to check the local `prd/<slug>` exists
    // before initializing feat from it. Remote-only branches should not
    // count.
    expect(branchExists(repoDir, "origin/main")).toBe(false);
  });
});

describe("git.getDefaultBranch", () => {
  let repoDir: string;
  let originDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "afk-default-"));
    originDir = mkdtempSync(join(tmpdir(), "afk-default-origin-"));
  });

  afterEach(() => {
    rmDirWithRetry(repoDir);
    rmDirWithRetry(originDir);
  });

  function initBare(branch: string): void {
    // A bare repo with HEAD pointing at `refs/heads/<branch>` so cloning
    // it produces a working copy whose `origin/HEAD` resolves to that
    // branch — the exact shape `getDefaultBranch` reads.
    git(originDir, ["init", "--bare", `--initial-branch=${branch}`]);
    // Bare repos have no commits yet; we need a commit on the branch so
    // `git clone` can resolve origin/HEAD. Easiest: clone, commit, push.
    const seedDir = mkdtempSync(join(tmpdir(), "afk-default-seed-"));
    try {
      git(seedDir, ["clone", originDir, "."]);
      git(seedDir, ["config", "user.email", "test@example.com"]);
      git(seedDir, ["config", "user.name", "Test"]);
      git(seedDir, ["checkout", "-b", branch]);
      git(seedDir, ["commit", "--allow-empty", "-m", "root"]);
      git(seedDir, ["push", "-u", "origin", branch]);
    } finally {
      rmDirWithRetry(seedDir);
    }
  }

  it("returns the branch from origin/HEAD when set to main", () => {
    initBare("main");
    git(repoDir, ["clone", originDir, "."]);
    expect(getDefaultBranch(repoDir)).toBe("main");
  });

  it("returns the branch from origin/HEAD when set to master", () => {
    // The exact bug from the issue: repo's primary branch is master,
    // not main, and the orchestrator must not hardcode `main`.
    initBare("master");
    git(repoDir, ["clone", originDir, "."]);
    expect(getDefaultBranch(repoDir)).toBe("master");
  });

  it("falls back to local master when origin/HEAD is unset", () => {
    git(repoDir, ["init", "--initial-branch=master"]);
    git(repoDir, ["config", "user.email", "test@example.com"]);
    git(repoDir, ["config", "user.name", "Test"]);
    git(repoDir, ["commit", "--allow-empty", "-m", "root"]);
    expect(getDefaultBranch(repoDir)).toBe("master");
  });

  it("prefers local main over master when both exist and no origin", () => {
    git(repoDir, ["init", "--initial-branch=main"]);
    git(repoDir, ["config", "user.email", "test@example.com"]);
    git(repoDir, ["config", "user.name", "Test"]);
    git(repoDir, ["commit", "--allow-empty", "-m", "root"]);
    git(repoDir, ["branch", "master"]);
    expect(getDefaultBranch(repoDir)).toBe("main");
  });

  it("throws when no canonical default branch can be found", () => {
    git(repoDir, ["init", "--initial-branch=develop"]);
    git(repoDir, ["config", "user.email", "test@example.com"]);
    git(repoDir, ["config", "user.name", "Test"]);
    git(repoDir, ["commit", "--allow-empty", "-m", "root"]);
    expect(() => getDefaultBranch(repoDir)).toThrow(
      /Could not determine default branch/,
    );
  });
});

describe("git.findWorktreeForBranch — regression for PRD 012 run-2", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "afk-wt-"));
    git(repoDir, ["init", "--initial-branch=main"]);
    git(repoDir, ["config", "user.email", "test@example.com"]);
    git(repoDir, ["config", "user.name", "Test"]);
    git(repoDir, ["commit", "--allow-empty", "-m", "root"]);
  });

  afterEach(() => {
    rmDirWithRetry(repoDir);
  });

  it("returns the main repo path when the branch is checked out there", () => {
    // This is the exact PRD 012 run-2 failure mode: the user was on
    // feat/012 in the main repo, and the orchestrator tried to `git
    // worktree add` a scratch worktree on the same branch. Fix: detect
    // the existing checkout and reuse it for merging.
    const result = findWorktreeForBranch(repoDir, "main");
    expect(result).not.toBeNull();
    // Normalize slashes for cross-platform compare
    expect(result!.replace(/\\/g, "/").toLowerCase()).toBe(
      repoDir.replace(/\\/g, "/").toLowerCase(),
    );
  });

  it("returns null for a branch not checked out in any worktree", () => {
    git(repoDir, ["branch", "prd/999-nothing"]);
    expect(findWorktreeForBranch(repoDir, "prd/999-nothing")).toBeNull();
  });

  it("returns null for a branch that does not exist at all", () => {
    expect(findWorktreeForBranch(repoDir, "does-not-exist")).toBeNull();
  });

  it("distinguishes between branches with shared prefix", () => {
    git(repoDir, ["branch", "prd/012-foo"]);
    // Only main is checked out; prd/012-foo exists but isn't in any worktree
    expect(findWorktreeForBranch(repoDir, "prd/012-foo")).toBeNull();
    expect(findWorktreeForBranch(repoDir, "main")).not.toBeNull();
  });
});

describe("git.removeWorktree — regression for Windows pnpm leftovers", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "afk-rm-"));
    git(repoDir, ["init", "--initial-branch=main"]);
    git(repoDir, ["config", "user.email", "test@example.com"]);
    git(repoDir, ["config", "user.name", "Test"]);
    git(repoDir, ["commit", "--allow-empty", "-m", "root"]);
  });

  afterEach(() => {
    rmDirWithRetry(repoDir);
  });

  // The 999-claude-smoke run hit a "Directory not empty" error from
  // `git worktree remove --force` because pnpm had populated
  // node_modules/.pnpm/ inside the worktree before tests ran. git
  // unregistered the admin metadata but left the on-disk tree, leaking
  // hundreds of MB. This test simulates that shape.
  it("cleans up on-disk leftovers even when git worktree remove fails partially", () => {
    const wt = join(repoDir, "wt-leftover");
    git(repoDir, ["branch", "feature/test"]);
    git(repoDir, ["worktree", "add", wt, "feature/test"]);

    // Mimic pnpm's nested node_modules — the kind of structure that
    // tripped git's unlink walker on Windows.
    const pnpmDir = join(
      wt,
      "node_modules",
      ".pnpm",
      "@babel+core@7.29.0",
      "node_modules",
      "@babel",
      "core",
    );
    mkdirSync(pnpmDir, { recursive: true });
    writeFileSync(join(pnpmDir, "index.js"), "module.exports = {};");
    writeFileSync(
      join(wt, "node_modules", ".pnpm-workspace-state-v1.json"),
      "{}",
    );

    expect(existsSync(wt)).toBe(true);
    removeWorktree(repoDir, wt);
    expect(existsSync(wt)).toBe(false);

    // Admin state should also be reconciled.
    const list = git(repoDir, ["worktree", "list"]);
    expect(list).not.toContain("wt-leftover");
  });

  it("is idempotent when called on an already-removed worktree", () => {
    const wt = join(repoDir, "wt-gone");
    git(repoDir, ["branch", "feature/gone"]);
    git(repoDir, ["worktree", "add", wt, "feature/gone"]);
    removeWorktree(repoDir, wt);
    // Second call must not throw.
    expect(() => removeWorktree(repoDir, wt)).not.toThrow();
  });

  it("reports a successful removal in its result", () => {
    const wt = join(repoDir, "wt-result");
    git(repoDir, ["branch", "feature/result"]);
    git(repoDir, ["worktree", "add", wt, "feature/result"]);
    const result = removeWorktree(repoDir, wt);
    expect(result.removed).toBe(true);
  });
});

// Issue #102: worktree teardown races live Windows file handles. A spawned
// process whose cwd is inside the worktree (the shape of any straggler an
// agent invocation or gate command leaves behind — natural-exit settlement
// never verifies the process tree) locks the directory against deletion on
// Windows. removeWorktree's old ~600ms rmSync retry then swallowed the
// failure and returned silently, leaving the ADR 0010 partial-tree
// signature: directory on disk, git admin state already pruned. The cwd
// lock is Windows-specific, so these tests only run there.
describe.runIf(process.platform === "win32")(
  "git.removeWorktree — issue #102 live-handle races (win32)",
  { timeout: 30_000 },
  () => {
    let repoDir: string;
    let holder: ChildProcess | undefined;

    beforeEach(() => {
      repoDir = mkdtempSync(join(tmpdir(), "afk-rm102-"));
      git(repoDir, ["init", "--initial-branch=main"]);
      git(repoDir, ["config", "user.email", "test@example.com"]);
      git(repoDir, ["config", "user.name", "Test"]);
      git(repoDir, ["commit", "--allow-empty", "-m", "root"]);
    });

    afterEach(async () => {
      if (holder && holder.exitCode === null) {
        holder.kill();
        await new Promise((r) => holder!.once("exit", r));
      }
      holder = undefined;
      rmDirWithRetry(repoDir);
    });

    /** Spawn a process that holds `dir` via its cwd for `lifetimeMs`. */
    async function holdDir(dir: string, lifetimeMs: number) {
      holder = spawn(
        process.execPath,
        ["-e", `setTimeout(() => {}, ${lifetimeMs})`],
        { cwd: dir, stdio: "ignore" },
      );
      // Let the child be fully alive before teardown races it.
      await new Promise((r) => setTimeout(r, 300));
    }

    function addWorktree(name: string): string {
      const wt = join(repoDir, name);
      git(repoDir, ["branch", `feature/${name}`]);
      git(repoDir, ["worktree", "add", wt, `feature/${name}`]);
      return wt;
    }

    it("outlives a transient handle and fully removes the worktree", async () => {
      const wt = addWorktree("wt-transient");
      await holdDir(wt, 2000); // dies well within the default retry budget

      const result = removeWorktree(repoDir, wt);

      expect(result.removed).toBe(true);
      expect(existsSync(wt)).toBe(false);
    });

    it("reports a persistent handle instead of returning silently on a partial tree", async () => {
      const wt = addWorktree("wt-stuck");
      await holdDir(wt, 60_000); // outlives any reasonable budget

      const result = removeWorktree(repoDir, wt, { timeoutMs: 1000 });

      expect(result.removed).toBe(false);
      expect(result.lastError).toBeTruthy();
      // The directory genuinely survives — the result must say so.
      expect(existsSync(wt)).toBe(true);
    });

    it("recreateWorktreeFromBase refuses a locked tree before deleting the branch", async () => {
      const wt = addWorktree("wt-refresh");
      await holdDir(wt, 60_000);

      expect(() =>
        recreateWorktreeFromBase(repoDir, "feature/wt-refresh", wt, "main", {
          removalTimeoutMs: 1000,
        }),
      ).toThrow(/still present|live process|holding/i);

      // The old behaviour deleted the branch and only then blew up in
      // createWorktree — destroying state while the tree was locked. The
      // branch must survive a refused refresh.
      expect(branchExists(repoDir, "feature/wt-refresh")).toBe(true);
    });
  },
);

describe("git.mergeSliceBranch — MergeResult", { timeout: 240_000 }, () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "afk-merge-"));
    git(repoDir, ["init", "--initial-branch=main"]);
    git(repoDir, ["config", "user.email", "test@example.com"]);
    git(repoDir, ["config", "user.name", "Test"]);
    writeFileSync(join(repoDir, "file.txt"), "base content\n");
    git(repoDir, ["add", "."]);
    git(repoDir, ["commit", "-m", "root"]);
  });

  afterEach(() => {
    rmDirWithRetry(repoDir);
  });

  it("returns { status: 'merged' } on clean merge", () => {
    git(repoDir, ["checkout", "-b", "feat"]);
    git(repoDir, ["checkout", "main"]);
    git(repoDir, ["checkout", "-b", "slice"]);
    writeFileSync(join(repoDir, "new-file.txt"), "slice work\n");
    git(repoDir, ["add", "."]);
    git(repoDir, ["commit", "-m", "slice commit"]);
    git(repoDir, ["checkout", "main"]);

    const scratchDir = join(repoDir, "scratch-merge");
    const result = mergeSliceBranch(repoDir, "slice", "feat", scratchDir);
    expect(result).toEqual({ status: "merged" });
  });

  it("returns { status: 'conflict', details } on merge conflict", () => {
    git(repoDir, ["checkout", "-b", "feat"]);
    writeFileSync(join(repoDir, "file.txt"), "feat version\n");
    git(repoDir, ["add", "."]);
    git(repoDir, ["commit", "-m", "feat change"]);

    git(repoDir, ["checkout", "main"]);
    git(repoDir, ["checkout", "-b", "slice"]);
    writeFileSync(join(repoDir, "file.txt"), "slice version\n");
    git(repoDir, ["add", "."]);
    git(repoDir, ["commit", "-m", "slice change"]);
    git(repoDir, ["checkout", "main"]);

    const scratchDir = join(repoDir, "scratch-merge");
    const result = mergeSliceBranch(repoDir, "slice", "feat", scratchDir);
    expect(result.status).toBe("conflict");
    if (result.status === "conflict") {
      expect(result.details).toBeTruthy();
    }
  });

  it("returns { status: 'merged' } when using existing worktree (fast path)", () => {
    git(repoDir, ["checkout", "-b", "feat"]);
    git(repoDir, ["checkout", "-b", "slice"]);
    writeFileSync(join(repoDir, "new-file.txt"), "slice work\n");
    git(repoDir, ["add", "."]);
    git(repoDir, ["commit", "-m", "slice commit"]);
    git(repoDir, ["checkout", "feat"]);

    const scratchDir = join(repoDir, "scratch-merge");
    const result = mergeSliceBranch(repoDir, "slice", "feat", scratchDir);
    expect(result).toEqual({ status: "merged" });
    expect(existsSync(scratchDir)).toBe(false);
  });
});

describe("git.hasCommitsAhead", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "afk-ahead-"));
    git(repoDir, ["init", "--initial-branch=main"]);
    git(repoDir, ["config", "user.email", "test@example.com"]);
    git(repoDir, ["config", "user.name", "Test"]);
    git(repoDir, ["commit", "--allow-empty", "-m", "root"]);
  });

  afterEach(() => {
    rmDirWithRetry(repoDir);
  });

  it("returns true when source has commits the target lacks", () => {
    git(repoDir, ["checkout", "-b", "feat"]);
    git(repoDir, ["commit", "--allow-empty", "-m", "feat work"]);
    expect(hasCommitsAhead(repoDir, "feat", "main")).toBe(true);
  });

  it("returns false when source equals target", () => {
    git(repoDir, ["branch", "feat"]);
    expect(hasCommitsAhead(repoDir, "feat", "main")).toBe(false);
  });

  // Regression for the PRD 024 crash: the slice branch can disappear
  // between merge-success and the next post-merge check (e.g. the agent
  // rewrote it locally, an out-of-band cleanup ran, or a sibling step
  // deleted the ref). `rev-list` against a missing ref exits non-zero,
  // and the previous implementation let the throw escape — taking down
  // the whole wave (including unrelated sibling lanes still in flight).
  // The post-merge guard's intent — "treat this slice as having
  // produced no output" — is exactly what `false` already conveys.
  it("returns false when the source branch does not exist", () => {
    expect(() => hasCommitsAhead(repoDir, "no-such-branch", "main")).not.toThrow();
    expect(hasCommitsAhead(repoDir, "no-such-branch", "main")).toBe(false);
  });

  it("returns false when the target branch does not exist", () => {
    git(repoDir, ["checkout", "-b", "feat"]);
    git(repoDir, ["commit", "--allow-empty", "-m", "feat work"]);
    expect(() => hasCommitsAhead(repoDir, "feat", "no-such-base")).not.toThrow();
    expect(hasCommitsAhead(repoDir, "feat", "no-such-base")).toBe(false);
  });
});

/**
 * Regression tests for the silent-corruption bug where `createWorktree`
 * would no-op on any pre-existing directory at the worktree path. If a
 * previous run's cleanup failed (Windows file lock, antivirus) the on-disk
 * dir leaked, but `git worktree list` no longer registered it. The next
 * run's `existsSync` short-circuit then dispatched the agent into a
 * non-worktree directory, and `git commit` walked up to the parent repo's
 * `.git`, leaking commits onto whatever branch the user had checked out.
 *
 * The fix: refuse to reuse a path unless git agrees it is the worktree
 * for the requested branch.
 */
describe("git.createWorktree", { timeout: 240_000 }, () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "afk-cw-"));
    git(repoDir, ["init", "--initial-branch=main"]);
    git(repoDir, ["config", "user.email", "test@example.com"]);
    git(repoDir, ["config", "user.name", "Test"]);
    git(repoDir, ["commit", "--allow-empty", "-m", "root"]);
  });

  afterEach(() => {
    rmDirWithRetry(repoDir);
  });

  it("creates a worktree from the given base branch when path does not exist", () => {
    const wt = join(repoDir, "wt-fresh");
    createWorktree(repoDir, "feat/fresh", wt, "main");
    expect(existsSync(wt)).toBe(true);
    const list = git(repoDir, ["worktree", "list", "--porcelain"]);
    expect(list).toContain("feat/fresh");
  });

  it("is idempotent when the path is already a registered worktree for the branch", () => {
    const wt = join(repoDir, "wt-idem");
    createWorktree(repoDir, "feat/idem", wt, "main");
    expect(() =>
      createWorktree(repoDir, "feat/idem", wt, "main"),
    ).not.toThrow();
    // Still exactly one entry for the branch.
    const list = git(repoDir, ["worktree", "list", "--porcelain"]);
    const matches = list.match(/refs\/heads\/feat\/idem/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("throws when path exists but is not a registered git worktree", () => {
    // Simulate the leaked-dir state: a plain directory at the worktree
    // path, no `.git` file, git's admin state has no record of it.
    const wt = join(repoDir, "wt-stale");
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, "stale-file.txt"), "leftover from a prior run");

    expect(() => createWorktree(repoDir, "feat/stale", wt, "main")).toThrow(
      /not a registered git worktree/i,
    );

    // The branch must NOT have been created — that would mean we silently
    // accepted the corrupt state and made it look real.
    expect(branchExists(repoDir, "feat/stale")).toBe(false);
  });

  it("throws when path is a worktree but checked out on a different branch", () => {
    // This catches the "stale dir from a previous slice" variant: the
    // dir is registered with git but for the WRONG branch. Reusing it
    // would dispatch the agent against the wrong base.
    const wt = join(repoDir, "wt-mismatch");
    git(repoDir, ["branch", "feat/other", "main"]);
    git(repoDir, ["worktree", "add", wt, "feat/other"]);

    expect(() =>
      createWorktree(repoDir, "feat/expected", wt, "main"),
    ).toThrow(/not a registered git worktree/i);
    expect(branchExists(repoDir, "feat/expected")).toBe(false);
  });
});

/**
 * Pre-dispatch invariant check: before any agent runs in `worktreeDir`,
 * confirm git agrees the directory is the worktree for `branch`. Layered
 * defense — `createWorktree` enforces it on creation; this helper lets
 * call sites enforce it again right before dispatch (and after
 * `recreateWorktreeFromBase`, which delegates to `createWorktree` but
 * adds a removeWorktree → deleteBranch → createWorktree sequence that
 * leaves more windows for filesystem races).
 */
describe("git.assertWorktreeRegistered", { timeout: 240_000 }, () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "afk-assert-"));
    git(repoDir, ["init", "--initial-branch=main"]);
    git(repoDir, ["config", "user.email", "test@example.com"]);
    git(repoDir, ["config", "user.name", "Test"]);
    git(repoDir, ["commit", "--allow-empty", "-m", "root"]);
  });

  afterEach(() => {
    rmDirWithRetry(repoDir);
  });

  it("does not throw when the path is the registered worktree for the branch", () => {
    const wt = join(repoDir, "wt-ok");
    git(repoDir, ["branch", "feat/ok"]);
    git(repoDir, ["worktree", "add", wt, "feat/ok"]);
    expect(() =>
      assertWorktreeRegistered(repoDir, "feat/ok", wt),
    ).not.toThrow();
  });

  it("throws when the branch has no registered worktree", () => {
    const wt = join(repoDir, "wt-missing");
    git(repoDir, ["branch", "feat/missing"]);
    // No worktree add — branch exists, no worktree.
    expect(() =>
      assertWorktreeRegistered(repoDir, "feat/missing", wt),
    ).toThrow(/not registered/i);
  });

  it("throws when the branch is registered at a different path", () => {
    const real = join(repoDir, "wt-real");
    const expected = join(repoDir, "wt-expected");
    git(repoDir, ["branch", "feat/elsewhere"]);
    git(repoDir, ["worktree", "add", real, "feat/elsewhere"]);
    expect(() =>
      assertWorktreeRegistered(repoDir, "feat/elsewhere", expected),
    ).toThrow(/registered at .* expected/i);
  });
});


describe("findMigrationPrefixCollisions (pure)", () => {
  it("flags a shared prefix with a different filename", () => {
    expect(
      findMigrationPrefixCollisions(["043_users.sql"], ["043_orders.sql"]),
    ).toEqual(["043"]);
  });

  it("does not flag a slice re-touching its own migration (same filename)", () => {
    expect(
      findMigrationPrefixCollisions(["043_users.sql"], ["043_users.sql"]),
    ).toEqual([]);
  });

  it("does not flag distinct prefixes", () => {
    expect(
      findMigrationPrefixCollisions(["042_a.sql"], ["043_b.sql"]),
    ).toEqual([]);
  });

  it("ignores files without a numeric prefix", () => {
    expect(
      findMigrationPrefixCollisions(["README.md"], ["seed.sql"]),
    ).toEqual([]);
  });

  it("returns each colliding prefix once, sorted", () => {
    expect(
      findMigrationPrefixCollisions(
        ["043_a.sql", "044_c.sql"],
        ["044_d.sql", "043_b.sql", "043_e.sql"],
      ),
    ).toEqual(["043", "044"]);
  });
});

/**
 * The prefix the contract-lock gate tells a colliding planner to move
 * to (ADR 0028). "Next free" means past the end of the sequence, not
 * the first gap: a migration runner applies files in prefix order, so
 * filling a gap would insert a schema change before ones already
 * applied downstream.
 */
describe("nextFreeMigrationPrefix (pure)", () => {
  it("returns one past the highest used prefix", () => {
    expect(nextFreeMigrationPrefix(["042_a.sql", "043_b.sql"])).toBe("044");
  });

  it("keeps the zero padding of the widest prefix", () => {
    expect(nextFreeMigrationPrefix(["009_a.sql"])).toBe("010");
  });

  it("stays a timestamp for a timestamp scheme", () => {
    expect(
      nextFreeMigrationPrefix(["20240101000000_a.sql"]),
    ).toBe("20240101000001");
  });

  it("skips past a gap rather than filling it", () => {
    expect(nextFreeMigrationPrefix(["001_a.sql", "005_b.sql"])).toBe("006");
  });

  it("ignores files carrying no numeric prefix", () => {
    expect(nextFreeMigrationPrefix(["README.md", "007_a.sql"])).toBe("008");
  });

  it("starts at 1 when nothing is numbered", () => {
    expect(nextFreeMigrationPrefix(["seed.sql"])).toBe("1");
    expect(nextFreeMigrationPrefix([])).toBe("1");
  });

  it("does not lose precision on a prefix too long for a number", () => {
    // 20 digits — beyond Number.MAX_SAFE_INTEGER, where a `number`
    // implementation would round and return a prefix that is not free.
    expect(nextFreeMigrationPrefix(["20240101000000000001_a.sql"])).toBe(
      "20240101000000000002",
    );
  });
});

describe("git.listFilesOnRef", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "afk-git-"));
    git(repoDir, ["init", "--initial-branch=main"]);
    git(repoDir, ["config", "user.email", "test@example.com"]);
    git(repoDir, ["config", "user.name", "Test"]);
    git(repoDir, ["commit", "--allow-empty", "-m", "root"]);
  });

  afterEach(() => {
    rmDirWithRetry(repoDir);
  });

  it("lists repo-relative paths from anywhere in the tree", () => {
    mkdirSync(join(repoDir, "db", "migrations"), { recursive: true });
    writeFileSync(join(repoDir, "db", "migrations", "003_x.sql"), "select 1;");
    writeFileSync(join(repoDir, "app.ts"), "export {};");
    git(repoDir, ["add", "-A"]);
    git(repoDir, ["commit", "-m", "add files"]);

    // Unlike listMigrationFiles this is not scoped to one directory, so
    // a non-Supabase migration layout is visible to the caller's own
    // recognition rule.
    expect(listFilesOnRef(repoDir, "main").sort()).toEqual([
      "app.ts",
      "db/migrations/003_x.sql",
    ]);
  });

  it("returns empty for a ref that does not exist", () => {
    expect(listFilesOnRef(repoDir, "no/such/ref")).toEqual([]);
  });
});

describe("git.listMigrationFiles / migrationPrefixCollisions", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "afk-git-"));
    git(repoDir, ["init", "--initial-branch=main"]);
    git(repoDir, ["config", "user.email", "test@example.com"]);
    git(repoDir, ["config", "user.name", "Test"]);
    git(repoDir, ["commit", "--allow-empty", "-m", "root"]);
  });

  afterEach(() => {
    rmDirWithRetry(repoDir);
  });

  function addMigration(name: string, body = "select 1;") {
    const dir = join(repoDir, "supabase", "migrations");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), body);
    git(repoDir, ["add", "-A"]);
    git(repoDir, ["commit", "-m", `add ${name}`]);
  }

  it("lists migration basenames on a ref", () => {
    addMigration("042_init.sql");
    expect(listMigrationFiles(repoDir, "main")).toEqual(["042_init.sql"]);
  });

  it("returns empty for a ref with no migrations", () => {
    expect(listMigrationFiles(repoDir, "main")).toEqual([]);
  });

  it("detects a colliding prefix between a slice branch and the feature branch", () => {
    addMigration("042_init.sql"); // shared history
    git(repoDir, ["branch", "feat/x"]);
    git(repoDir, ["checkout", "-b", "afk/slice"]);
    addMigration("043_orders.sql");
    git(repoDir, ["checkout", "feat/x"]);
    addMigration("043_users.sql"); // same prefix, different file

    expect(migrationPrefixCollisions(repoDir, "afk/slice", "feat/x")).toEqual([
      "043",
    ]);
  });

  it("does not flag when the slice adds a fresh prefix", () => {
    addMigration("042_init.sql");
    git(repoDir, ["branch", "feat/x"]);
    git(repoDir, ["checkout", "-b", "afk/slice"]);
    addMigration("043_orders.sql");

    expect(migrationPrefixCollisions(repoDir, "afk/slice", "feat/x")).toEqual(
      [],
    );
  });
});


/**
 * Primitives backing the resume-a-dead-slice feature (spec #33, design
 * note on #15). Each test drives a real temp repo — the convention for
 * git behavior in this suite — because these primitives guard hours of
 * committed work on a surviving slice branch.
 */
describe("resume git primitives", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "afk-resume-git-"));
    git(repoDir, ["init", "--initial-branch=main"]);
    git(repoDir, ["config", "user.email", "test@example.com"]);
    git(repoDir, ["config", "user.name", "Test"]);
    writeFileSync(join(repoDir, "base.txt"), "base\n", "utf-8");
    git(repoDir, ["add", "base.txt"]);
    git(repoDir, ["commit", "-m", "root"]);
  });

  afterEach(() => {
    rmDirWithRetry(repoDir);
  });

  function commitFile(cwd: string, name: string, content: string, msg: string) {
    writeFileSync(join(cwd, name), content, "utf-8");
    git(cwd, ["add", name]);
    git(cwd, ["commit", "-m", msg]);
  }

  describe("countCommitsAhead", () => {
    it("counts commits on the slice branch beyond the base", () => {
      git(repoDir, ["checkout", "-b", "slice"]);
      commitFile(repoDir, "a.txt", "a", "feat: a");
      commitFile(repoDir, "b.txt", "b", "feat: b");
      expect(countCommitsAhead(repoDir, "slice", "main")).toBe(2);
    });

    it("returns 0 when the branch sits exactly on the base", () => {
      git(repoDir, ["branch", "slice"]);
      expect(countCommitsAhead(repoDir, "slice", "main")).toBe(0);
    });

    it("returns 0 when either ref is missing", () => {
      expect(countCommitsAhead(repoDir, "no-such-branch", "main")).toBe(0);
      expect(countCommitsAhead(repoDir, "main", "no-such-base")).toBe(0);
    });
  });

  describe("isWorktreeRegistered", () => {
    it("returns true for the registered worktree of the branch", () => {
      const wt = join(repoDir, ".afk", "wt-slice");
      createWorktree(repoDir, "slice", wt, "main");
      expect(isWorktreeRegistered(repoDir, "slice", wt)).toBe(true);
    });

    it("returns false when no worktree has the branch checked out", () => {
      git(repoDir, ["branch", "slice"]);
      expect(
        isWorktreeRegistered(repoDir, "slice", join(repoDir, ".afk", "gone")),
      ).toBe(false);
    });

    it("returns false when the branch is registered at a different path", () => {
      const wt = join(repoDir, ".afk", "wt-slice");
      createWorktree(repoDir, "slice", wt, "main");
      expect(
        isWorktreeRegistered(repoDir, "slice", join(repoDir, ".afk", "other")),
      ).toBe(false);
    });
  });

  describe("resetWorktreeToHead", () => {
    it("discards uncommitted modifications and untracked files, keeping commits", () => {
      const wt = join(repoDir, ".afk", "wt-slice");
      createWorktree(repoDir, "slice", wt, "main");
      commitFile(wt, "kept.txt", "committed work", "feat: kept");
      // Simulate a mid-edit death: a tracked file modified, an
      // untracked half-written file, and an untracked directory.
      writeFileSync(join(wt, "kept.txt"), "half-applied edit", "utf-8");
      writeFileSync(join(wt, "orphan.txt"), "never committed", "utf-8");
      mkdirSync(join(wt, "scratch"), { recursive: true });
      writeFileSync(join(wt, "scratch", "tmp.txt"), "junk", "utf-8");

      resetWorktreeToHead(wt);

      expect(readFileSync(join(wt, "kept.txt"), "utf-8")).toBe("committed work");
      expect(existsSync(join(wt, "orphan.txt"))).toBe(false);
      expect(existsSync(join(wt, "scratch"))).toBe(false);
      // The commit itself survives.
      expect(git(wt, ["log", "--format=%s", "-1"])).toBe("feat: kept");
    });

    it("preserves untracked files under excluded paths (slice artifacts)", () => {
      // context.md / contract.md are written by explorer/planner and
      // never committed. The resume clean must not destroy them — the
      // contract is reused verbatim and explorer/planner stay skipped
      // (spec #33). Everything else untracked still goes.
      const wt = join(repoDir, ".afk", "wt-slice");
      createWorktree(repoDir, "slice", wt, "main");
      commitFile(wt, "kept.txt", "committed work", "feat: kept");
      const sliceDir = join(wt, ".kiro", "specs", "demo", "slices", "01-x");
      mkdirSync(sliceDir, { recursive: true });
      writeFileSync(join(sliceDir, "contract.md"), "**Status:** LOCKED", "utf-8");
      writeFileSync(join(wt, "orphan.txt"), "never committed", "utf-8");

      resetWorktreeToHead(wt, [".kiro/specs/demo"]);

      expect(readFileSync(join(sliceDir, "contract.md"), "utf-8")).toBe(
        "**Status:** LOCKED",
      );
      expect(existsSync(join(wt, "orphan.txt"))).toBe(false);
    });
  });

  describe("lastCommitEpochSeconds", () => {
    it("returns the HEAD commit's committer timestamp", () => {
      const wt = join(repoDir, ".afk", "wt-slice");
      createWorktree(repoDir, "slice", wt, "main");
      commitFile(wt, "a.txt", "a", "feat: a");
      const expected = parseInt(git(wt, ["log", "-1", "--format=%ct"]), 10);
      expect(lastCommitEpochSeconds(wt)).toBe(expected);
    });

    it("returns null for a directory that is not inside a git repo", () => {
      const plain = mkdtempSync(join(tmpdir(), "afk-plain-"));
      try {
        expect(lastCommitEpochSeconds(plain)).toBeNull();
      } finally {
        rmDirWithRetry(plain);
      }
    });
  });

  describe("logCommitsWithStat", () => {
    it("returns the slice's own commit log with per-file stats", () => {
      const wt = join(repoDir, ".afk", "wt-slice");
      createWorktree(repoDir, "slice", wt, "main");
      commitFile(wt, "feature.ts", "export const x = 1;\n", "feat(#42): add x");
      commitFile(wt, "feature.test.ts", "test\n", "test(#42): cover x");

      const log = logCommitsWithStat(wt, "main");

      expect(log).toContain("feat(#42): add x");
      expect(log).toContain("test(#42): cover x");
      expect(log).toContain("feature.ts");
      expect(log).toContain("feature.test.ts");
    });

    it("returns an empty string when there are no commits beyond base", () => {
      const wt = join(repoDir, ".afk", "wt-slice");
      createWorktree(repoDir, "slice", wt, "main");
      expect(logCommitsWithStat(wt, "main")).toBe("");
    });
  });
});


/**
 * Base refresh for resumed slices (#35): merge the feature branch INTO
 * the slice branch, inside the slice worktree. The generic mergeBranch
 * helper is unsafe here — it checks out in the repo root.
 */
describe("git.mergeBranchIntoWorktree", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "afk-refresh-"));
    git(repoDir, ["init", "--initial-branch=main"]);
    git(repoDir, ["config", "user.email", "test@example.com"]);
    git(repoDir, ["config", "user.name", "Test"]);
    writeFileSync(join(repoDir, "shared.txt"), "line1\nline2\nline3\n", "utf-8");
    git(repoDir, ["add", "shared.txt"]);
    git(repoDir, ["commit", "-m", "root"]);
  });

  afterEach(() => {
    rmDirWithRetry(repoDir);
  });

  function commitFile(cwd: string, name: string, content: string, msg: string) {
    writeFileSync(join(cwd, name), content, "utf-8");
    git(cwd, ["add", name]);
    git(cwd, ["commit", "-m", msg]);
  }

  it("merges an advanced feature branch into the slice branch inside the worktree", () => {
    const wt = join(repoDir, ".afk", "wt-slice");
    createWorktree(repoDir, "slice", wt, "main");
    commitFile(wt, "slice-work.ts", "slice\n", "feat: slice work");
    // Feature branch (main here) advances after the fork.
    commitFile(repoDir, "other-slice.ts", "sibling\n", "feat: sibling merged");

    const result = mergeBranchIntoWorktree(wt, "main");

    expect(result.status).toBe("merged");
    // The feature commit is now part of the slice worktree's world.
    expect(existsSync(join(wt, "other-slice.ts"))).toBe(true);
    // The slice's own work survived.
    expect(existsSync(join(wt, "slice-work.ts"))).toBe(true);
    // The repo root's checkout was never touched (merge ran in the worktree).
    expect(git(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
  });

  it("is a no-op merge when the feature branch has not moved", () => {
    const wt = join(repoDir, ".afk", "wt-slice");
    createWorktree(repoDir, "slice", wt, "main");
    commitFile(wt, "slice-work.ts", "slice\n", "feat: slice work");
    const tipBefore = git(wt, ["rev-parse", "HEAD"]);

    const result = mergeBranchIntoWorktree(wt, "main");

    expect(result.status).toBe("merged");
    expect(git(wt, ["rev-parse", "HEAD"])).toBe(tipBefore);
  });

  it("aborts a conflicting merge cleanly, leaving the branch and worktree untouched", () => {
    const wt = join(repoDir, ".afk", "wt-slice");
    createWorktree(repoDir, "slice", wt, "main");
    commitFile(wt, "shared.txt", "slice version\n", "feat: slice edit");
    const tipBefore = git(wt, ["rev-parse", "HEAD"]);
    // Conflicting edit to the same file on the feature branch.
    commitFile(repoDir, "shared.txt", "feature version\n", "feat: conflicting edit");

    const result = mergeBranchIntoWorktree(wt, "main");

    expect(result.status).toBe("conflict");
    // Merge aborted: branch tip untouched, worktree clean, file content intact.
    expect(git(wt, ["rev-parse", "HEAD"])).toBe(tipBefore);
    expect(git(wt, ["status", "--porcelain"])).toBe("");
    expect(readFileSync(join(wt, "shared.txt"), "utf-8").replace(/\r\n/g, "\n")).toBe(
      "slice version\n",
    );
  });
});

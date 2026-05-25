import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertWorktreeRegistered,
  branchExists,
  createWorktree,
  findWorktreeForBranch,
  getDefaultBranch,
  hasCommitsAhead,
  mergeSliceBranch,
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
    rmSync(repoDir, { recursive: true, force: true });
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
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(originDir, { recursive: true, force: true });
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
      rmSync(seedDir, { recursive: true, force: true });
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
    rmSync(repoDir, { recursive: true, force: true });
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
    rmSync(repoDir, { recursive: true, force: true });
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
});

describe("git.mergeSliceBranch — MergeResult", { timeout: 30_000 }, () => {
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
    rmSync(repoDir, { recursive: true, force: true });
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
    rmSync(repoDir, { recursive: true, force: true });
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
describe("git.createWorktree", { timeout: 30_000 }, () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "afk-cw-"));
    git(repoDir, ["init", "--initial-branch=main"]);
    git(repoDir, ["config", "user.email", "test@example.com"]);
    git(repoDir, ["config", "user.name", "Test"]);
    git(repoDir, ["commit", "--allow-empty", "-m", "root"]);
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
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
describe("git.assertWorktreeRegistered", { timeout: 30_000 }, () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "afk-assert-"));
    git(repoDir, ["init", "--initial-branch=main"]);
    git(repoDir, ["config", "user.email", "test@example.com"]);
    git(repoDir, ["config", "user.name", "Test"]);
    git(repoDir, ["commit", "--allow-empty", "-m", "root"]);
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
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

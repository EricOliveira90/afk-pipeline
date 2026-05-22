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
import { branchExists, findWorktreeForBranch, removeWorktree } from "./git.js";

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

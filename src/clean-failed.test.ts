import { describe, it, expect, afterEach } from "vitest";
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
import { runCleanFailed } from "./clean-failed.js";
import * as git from "./git.js";

/**
 * `afk clean-failed` (issue #19, ADR 0023): removes dead slice
 * worktrees/branches before a re-run, in one command, with guards —
 * branches carrying unmerged commits are kept, other PRDs' debris is
 * out of scope by construction, and live (registered, non-failed)
 * worktrees are never touched.
 *
 * Real temp git repos, mirroring git.test.ts.
 */

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Best effort.
    }
  }
});

function sh(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "afk-clean-"));
  tempDirs.push(dir);
  sh(dir, ["init", "--initial-branch=main"]);
  writeFileSync(join(dir, "README.md"), "root\n", "utf-8");
  sh(dir, ["add", "README.md"]);
  sh(dir, ["commit", "-m", "root"]);
  return dir;
}

const SLUG = "cleanme";
const FEAT = `feat/${SLUG}`;

interface SliceFixture {
  ghIssue: string;
  number: string;
  phase: string;
  /** Create the branch + registered worktree on disk. */
  materialise?: boolean;
  /** Add a commit on the slice branch (unmerged work). */
  withCommit?: boolean;
}

function setUp(repo: string, slices: SliceFixture[]): void {
  sh(repo, ["branch", FEAT, "main"]);
  const stateSlices: Record<string, unknown> = {};
  const scopeSlices: Array<{ number: string; ghIssue: string }> = [];
  for (const s of slices) {
    const branch = `afk/${SLUG}-slice-${s.number}-fixture`;
    const worktreeDir = join(
      repo,
      ".afk",
      "worktrees",
      `afk-${SLUG}-s${s.number}`,
    );
    if (s.materialise) {
      git.createWorktree(repo, branch, worktreeDir, FEAT);
      if (s.withCommit) {
        writeFileSync(join(worktreeDir, `work-${s.number}.txt`), "wip\n");
        sh(worktreeDir, ["add", "-A"]);
        sh(worktreeDir, ["commit", "-m", `wip on slice ${s.number}`]);
      }
    }
    stateSlices[s.ghIssue] = {
      phase: s.phase,
      branch,
      ...(s.phase === "PASS" ? { mergedToFeature: true } : { error: "boom" }),
    };
    scopeSlices.push({ number: s.number, ghIssue: s.ghIssue });
  }
  const stateDir = join(repo, ".afk", "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, `${SLUG}.json`),
    JSON.stringify({
      version: 1,
      prdSlug: SLUG,
      featureBranch: FEAT,
      scope: { mode: "all-afk", slices: scopeSlices },
      slices: stateSlices,
    }),
  );
}

describe("runCleanFailed", () => {
  /**
   * The ERROR slice is the command's bread and butter. The parked slice
   * rides along in the same fixture rather than paying for a second temp
   * git repo (AGENTS.md: put a new assertion in a fixture that already
   * runs), and it earns its place here — the two together are the
   * distinction ADR 0055 Seam 2 §6 draws. Both phases render in the
   * `failed` bucket; only one is debris.
   */
  it("removes an ERRORed slice's estate while leaving a parked slice's untouched", async () => {
    const repo = makeRepo();
    setUp(repo, [
      { ghIssue: "101", number: "01", phase: "ERROR", materialise: true },
      {
        ghIssue: "111",
        number: "11",
        phase: "AWAITING-ADJUDICATION",
        materialise: true,
      },
    ]);
    const dir = join(repo, ".afk", "worktrees", `afk-${SLUG}-s01`);
    const branch = `afk/${SLUG}-slice-01-fixture`;
    expect(existsSync(dir)).toBe(true);

    // The park's estate as the run left it: the impasse record and the
    // decision log live in the slice directory *inside the worktree*, so
    // removing the worktree destroys the operator's pending input.
    const parkedDir = join(repo, ".afk", "worktrees", `afk-${SLUG}-s11`);
    const parkedBranch = `afk/${SLUG}-slice-11-fixture`;
    const parkedSliceDir = join(parkedDir, "specs", "slices", "11-parked");
    mkdirSync(parkedSliceDir, { recursive: true });
    const impasseRecord = join(
      parkedSliceDir,
      "contract-negotiation-outcome.json",
    );
    const decisionLog = join(parkedSliceDir, "adjudication-decisions.json");
    // The fourth estate file: a decision the human has written but that no
    // dispatch has consumed yet. It is the only member of the estate that
    // exists nowhere else — the log has not recorded it, so deleting it
    // loses the operator's answer outright (ADR 0055 Seam 2 invariant).
    const inFlight = join(parkedSliceDir, "adjudication.md");
    writeFileSync(impasseRecord, JSON.stringify({ outcome: "IMPASSE" }), "utf-8");
    writeFileSync(decisionLog, JSON.stringify({ version: 1 }), "utf-8");
    writeFileSync(
      inFlight,
      JSON.stringify({ version: 1, findingId: "F-02" }),
      "utf-8",
    );

    const report = await runCleanFailed({
      repoRoot: repo,
      prdSlug: SLUG,
      log: () => {},
    });

    expect(existsSync(dir)).toBe(false);
    expect(git.branchExists(repo, branch)).toBe(false);
    expect(report.removedWorktrees).toEqual([dir]);
    expect(report.deletedBranches).toEqual([branch]);
    expect(report.keptBranches).toEqual([]);

    // Nothing of the park is debris — not the worktree, not the branch,
    // and above all not the two files a human is being asked to decide on.
    expect(existsSync(parkedDir)).toBe(true);
    expect(existsSync(impasseRecord)).toBe(true);
    expect(existsSync(decisionLog)).toBe(true);
    expect(existsSync(inFlight)).toBe(true);
    expect(git.branchExists(repo, parkedBranch)).toBe(true);
    // The worktree is still git's, not just a surviving directory: pass 2
    // sweeps unregistered namespace leftovers, and a park that pass 1
    // skipped but pass 2 deleted would be preserved in name only.
    expect(git.findWorktreeForBranch(repo, parkedBranch)).not.toBeNull();
    expect(report.removedWorktrees).not.toContain(parkedDir);

    // And the operator is told WHY the slice still has a worktree — a
    // silent skip reads as a bug in the command.
    const parkSkip = report.skipped.find((s) => s.target === parkedDir);
    expect(parkSkip).toBeDefined();
    expect(parkSkip!.reason).toContain("AWAITING-ADJUDICATION");
    expect(parkSkip!.reason).toMatch(/adjudication estate|re-dispatch/);
  });

  it("keeps a branch with commits ahead of the feature branch but still removes its worktree", async () => {
    const repo = makeRepo();
    setUp(repo, [
      {
        ghIssue: "102",
        number: "02",
        phase: "STUCK",
        materialise: true,
        withCommit: true,
      },
    ]);
    const dir = join(repo, ".afk", "worktrees", `afk-${SLUG}-s02`);
    const branch = `afk/${SLUG}-slice-02-fixture`;

    const report = await runCleanFailed({
      repoRoot: repo,
      prdSlug: SLUG,
      log: () => {},
    });

    expect(existsSync(dir)).toBe(false);
    expect(git.branchExists(repo, branch)).toBe(true);
    expect(report.deletedBranches).toEqual([]);
    expect(report.keptBranches).toHaveLength(1);
    expect(report.keptBranches[0]!.branch).toBe(branch);
    expect(report.keptBranches[0]!.reason).toContain("commits ahead");
  });

  it("removes unregistered leftover dirs in this PRD's namespace and ignores other PRDs' debris", async () => {
    const repo = makeRepo();
    setUp(repo, [
      { ghIssue: "103", number: "03", phase: "LANE-CANCELLED" },
    ]);
    // Unregistered leftover for this PRD (state knows the slice but the
    // worktree was pruned; only the dir survived a Windows cleanup).
    const mine = join(repo, ".afk", "worktrees", `afk-${SLUG}-s03`);
    mkdirSync(join(mine, "node_modules", ".pnpm"), { recursive: true });
    writeFileSync(join(mine, "node_modules", ".pnpm", "straggler.txt"), "x");
    // Another PRD's leftover — out of scope by construction.
    const other = join(repo, ".afk", "worktrees", "afk-otherprd-s01");
    mkdirSync(other, { recursive: true });
    // A prefix-overlapping PRD (`cleanme-extra`) must not match `cleanme`.
    const overlapping = join(
      repo,
      ".afk",
      "worktrees",
      `afk-${SLUG}-extra-s01`,
    );
    mkdirSync(overlapping, { recursive: true });

    const report = await runCleanFailed({
      repoRoot: repo,
      prdSlug: SLUG,
      log: () => {},
    });

    expect(existsSync(mine)).toBe(false);
    expect(existsSync(other)).toBe(true);
    expect(existsSync(overlapping)).toBe(true);
    expect(report.removedWorktrees).toContain(mine);
  });

  it("never touches a registered worktree whose slice is not in a failure phase", async () => {
    const repo = makeRepo();
    setUp(repo, [
      { ghIssue: "104", number: "04", phase: "PASS", materialise: true },
    ]);
    const dir = join(repo, ".afk", "worktrees", `afk-${SLUG}-s04`);

    const report = await runCleanFailed({
      repoRoot: repo,
      prdSlug: SLUG,
      log: () => {},
    });

    expect(existsSync(dir)).toBe(true);
    expect(git.branchExists(repo, `afk/${SLUG}-slice-04-fixture`)).toBe(true);
    expect(report.removedWorktrees).toEqual([]);
    expect(report.skipped.some((s) => s.target === dir)).toBe(true);
  });

  it("removes leftover scratch merge dirs in this PRD's namespace", async () => {
    const repo = makeRepo();
    setUp(repo, []);
    const scratch = join(repo, ".afk", `merge-afk-${SLUG}-s05`);
    mkdirSync(scratch, { recursive: true });
    const foreignScratch = join(repo, ".afk", "merge-afk-otherprd-s01");
    mkdirSync(foreignScratch, { recursive: true });

    const report = await runCleanFailed({
      repoRoot: repo,
      prdSlug: SLUG,
      log: () => {},
    });

    expect(existsSync(scratch)).toBe(false);
    expect(existsSync(foreignScratch)).toBe(true);
    expect(report.removedScratchDirs).toEqual([scratch]);
  });

  it("dry-run reports the full plan without touching anything", async () => {
    const repo = makeRepo();
    setUp(repo, [
      { ghIssue: "106", number: "06", phase: "ERROR", materialise: true },
    ]);
    const dir = join(repo, ".afk", "worktrees", `afk-${SLUG}-s06`);
    const branch = `afk/${SLUG}-slice-06-fixture`;

    const report = await runCleanFailed({
      repoRoot: repo,
      prdSlug: SLUG,
      dryRun: true,
      log: () => {},
    });

    expect(existsSync(dir)).toBe(true);
    expect(git.branchExists(repo, branch)).toBe(true);
    expect(report.removedWorktrees).toEqual([dir]);
    expect(report.deletedBranches).toEqual([branch]);
  });

  it("preserves a MERGE-PENDING slice's branch — the next run merges it (ADR 0029)", async () => {
    const repo = makeRepo();
    setUp(repo, [
      {
        ghIssue: "103",
        number: "03",
        phase: "MERGE-PENDING",
        materialise: true,
        withCommit: true,
      },
    ]);
    const dir = join(repo, ".afk", "worktrees", `afk-${SLUG}-s03`);
    const branch = `afk/${SLUG}-slice-03-fixture`;

    const report = await runCleanFailed({
      repoRoot: repo,
      prdSlug: SLUG,
      log: () => {},
    });

    // The worktree is debris — merge-only recovery works from the branch
    // alone — but the branch itself carries the slice's committed work.
    expect(existsSync(dir)).toBe(false);
    expect(report.removedWorktrees).toEqual([dir]);
    expect(git.branchExists(repo, branch)).toBe(true);
    expect(report.deletedBranches).toEqual([]);
    expect(report.keptBranches).toHaveLength(1);
    expect(report.keptBranches[0]!.branch).toBe(branch);
    expect(report.keptBranches[0]!.reason).toContain("MERGE-PENDING");
    expect(report.keptBranches[0]!.reason).toContain("retries the merge");
  });

  it("keeps a MERGE-PENDING branch even when it has no commits ahead", async () => {
    const repo = makeRepo();
    setUp(repo, [
      {
        ghIssue: "104",
        number: "04",
        phase: "MERGE-PENDING",
        materialise: true,
      },
    ]);
    const branch = `afk/${SLUG}-slice-04-fixture`;

    const report = await runCleanFailed({
      repoRoot: repo,
      prdSlug: SLUG,
      log: () => {},
    });

    // The commit comparison never gets a say: a MERGE-PENDING branch is
    // never a deletion candidate. (The next run finds it empty and falls
    // through to ordinary dispatch — the pipeline's call, not cleanup's.)
    expect(git.branchExists(repo, branch)).toBe(true);
    expect(report.deletedBranches).toEqual([]);
  });

  it("is a no-op with an empty report when there is no state file", async () => {
    const repo = makeRepo();
    const report = await runCleanFailed({
      repoRoot: repo,
      prdSlug: "neverran",
      log: () => {},
    });
    expect(report.removedWorktrees).toEqual([]);
    expect(report.deletedBranches).toEqual([]);
    expect(report.keptBranches).toEqual([]);
    expect(report.skipped).toEqual([]);
  });
});

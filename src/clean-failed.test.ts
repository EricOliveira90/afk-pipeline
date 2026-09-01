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
      // The run records where its own slice artifacts live, so the estate
      // probe resolves `<worktree>/specs/slices/*` instead of walking for it
      // (architect blocker 2, fifth adjudication gate round). Every fixture
      // worktree below puts its slice directory under `specs/`.
      specsDir: "specs",
      scope: { mode: "all-afk", slices: scopeSlices },
      slices: stateSlices,
    }),
  );
}

describe("runCleanFailed", () => {
  /**
   * The ERROR slice is the command's bread and butter. Every estate-owning
   * slice rides along in the same fixture rather than paying for a temp git
   * repo each (AGENTS.md: put a new assertion in a fixture that already
   * runs), and they earn their place here — together they are the
   * distinction ADR 0055 Seam 2 §6 draws. All of them render in the `failed`
   * bucket; only the one with no estate on disk is debris.
   *
   * The three exits after `#131` are the point of the fourth gate round.
   * Once every human decision is accepted, the apply step can still fail
   * mechanically — the planner or provider dies, the lane-successor refresh
   * conflicts, the operator cancels mid-apply — and each of those lands in
   * an ordinary `ERROR`, `CONFLICT` or `LANE-CANCELLED`, not in a
   * `preserve-all` phase. Deriving disposability from the phase deleted the
   * only decision log in exactly those cases. Ownership is read off disk
   * instead, so all three preserve for the same reason and no future exit
   * has to remember to opt in.
   */
  it("removes an ERRORed slice's estate while leaving every adjudication estate untouched", async () => {
    const repo = makeRepo();
    setUp(repo, [
      { ghIssue: "101", number: "01", phase: "ERROR", materialise: true },
      {
        ghIssue: "111",
        number: "11",
        phase: "AWAITING-ADJUDICATION",
        materialise: true,
      },
      // A completed adjudication whose lock the mechanical gate refused on
      // the current base (ADR 0055 Seam 1 §5). Its decisions are recorded,
      // not pending. Its phase is presentation-only (`disposable`, like
      // ESCALATE), so its survival here is the disk fact and nothing else.
      {
        ghIssue: "121",
        number: "12",
        phase: "ADJUDICATION-LOCK-REFUSED",
        materialise: true,
      },
      // The post-decision apply exits: a planner/provider failure, a
      // lane-successor refresh conflict, and a cancellation mid-apply.
      { ghIssue: "131", number: "13", phase: "ERROR", materialise: true },
      { ghIssue: "141", number: "14", phase: "CONFLICT", materialise: true },
      {
        ghIssue: "151",
        number: "15",
        phase: "LANE-CANCELLED",
        materialise: true,
      },
      // Architect blocker 2: a worktree whose estate could not be *probed*.
      // Its own `specs` path is a file, so the enumeration cannot complete —
      // and an unfinished probe is not proof that the directory is
      // disposable. It rides this fixture rather than paying for another
      // temp repo (AGENTS.md ladder).
      { ghIssue: "161", number: "16", phase: "ERROR", materialise: true },
    ]);
    const dir = join(repo, ".afk", "worktrees", `afk-${SLUG}-s01`);
    const branch = `afk/${SLUG}-slice-01-fixture`;
    expect(existsSync(dir)).toBe(true);

    // Pass 2's namespace sweep rides along in the same repo. It is the one
    // place that deletes a directory *because* no run state claims it —
    // state deleted by hand, a crash before the state write, a record that
    // never named its branch — and the disk fact has to hold there too: it
    // is a property of the worktree, not of the record that lost track of
    // it. `s09` holds a decision log; `s08` is an ordinary leftover.
    const orphanEstate = join(repo, ".afk", "worktrees", `afk-${SLUG}-s09`);
    const orphanLog = join(
      orphanEstate,
      "specs",
      "slices",
      "09-orphaned-estate",
      "adjudication-decisions.json",
    );
    mkdirSync(join(orphanEstate, "specs", "slices", "09-orphaned-estate"), {
      recursive: true,
    });
    writeFileSync(
      orphanLog,
      JSON.stringify({ version: 1, decisions: [{ findingId: "F-01" }] }),
      "utf-8",
    );
    const plainLeftover = join(repo, ".afk", "worktrees", `afk-${SLUG}-s08`);
    mkdirSync(plainLeftover, { recursive: true });
    // ...and an unregistered leftover whose estate cannot be probed either.
    // Pass 2 is the pass that deletes because nothing claims a directory, so
    // it is the one that most needs "I could not tell" to refuse.
    const unprobableLeftover = join(
      repo,
      ".afk",
      "worktrees",
      `afk-${SLUG}-s07`,
    );
    mkdirSync(unprobableLeftover, { recursive: true });
    writeFileSync(join(unprobableLeftover, "specs"), "not a directory", "utf-8");
    // The pass-1 counterpart, in slice #161's registered worktree.
    const unprobableWorktree = join(
      repo,
      ".afk",
      "worktrees",
      `afk-${SLUG}-s16`,
    );
    writeFileSync(join(unprobableWorktree, "specs"), "not a directory", "utf-8");

    // Each estate as the run left it: the impasse record and the decision
    // log live in the slice directory *inside the worktree*, so removing the
    // worktree destroys the operator's input.
    const preserved = [
      // Still awaiting an answer: the impasse record is the retry path and
      // adjudication.md is the decision in flight; no decision recorded yet.
      { number: "11", name: "parked", phase: "AWAITING-ADJUDICATION", log: false },
      { number: "12", name: "lock-refused", phase: "ADJUDICATION-LOCK-REFUSED", log: true },
      { number: "13", name: "planner-failed", phase: "ERROR", log: true },
      { number: "14", name: "refresh-conflict", phase: "CONFLICT", log: true },
      { number: "15", name: "cancelled-mid-apply", phase: "LANE-CANCELLED", log: true },
    ].map(({ number, name, phase, log }) => {
      const wtDir = join(repo, ".afk", "worktrees", `afk-${SLUG}-s${number}`);
      const branchName = `afk/${SLUG}-slice-${number}-fixture`;
      const sliceDir = join(wtDir, "specs", "slices", `${number}-${name}`);
      mkdirSync(sliceDir, { recursive: true });
      const impasseRecord = join(sliceDir, "contract-negotiation-outcome.json");
      const decisionLog = log
        ? join(sliceDir, "adjudication-decisions.json")
        : null;
      const inFlight = log ? null : join(sliceDir, "adjudication.md");
      writeFileSync(
        impasseRecord,
        JSON.stringify({ version: 1, classification: "IMPASSE", findings: [] }),
        "utf-8",
      );
      if (decisionLog) {
        writeFileSync(
          decisionLog,
          JSON.stringify({ version: 1, decisions: [{ findingId: "F-02" }] }),
          "utf-8",
        );
      }
      if (inFlight) {
        writeFileSync(
          inFlight,
          JSON.stringify({ version: 1, findingId: "F-02" }),
          "utf-8",
        );
      }
      return { wtDir, branchName, impasseRecord, decisionLog, inFlight, phase };
    });

    const report = await runCleanFailed({
      repoRoot: repo,
      prdSlug: SLUG,
      log: () => {},
    });

    expect(existsSync(dir)).toBe(false);
    expect(git.branchExists(repo, branch)).toBe(false);
    expect(report.removedWorktrees).toEqual([dir, plainLeftover]);
    expect(report.deletedBranches).toEqual([branch]);
    expect(report.keptBranches).toEqual([]);

    // The unregistered estate survives the sweep, named in the report.
    expect(existsSync(orphanLog)).toBe(true);
    const orphanSkip = report.skipped.find((s) => s.target === orphanEstate);
    expect(orphanSkip).toBeDefined();
    expect(orphanSkip!.reason).toContain("adjudication estate");

    // Neither unprobable directory was removed, and both refusals say why.
    // "The probe could not finish" must never be spent as "there is nothing
    // here to lose" (ADR 0055 Seam 2 §8).
    for (const target of [unprobableWorktree, unprobableLeftover]) {
      expect(existsSync(target)).toBe(true);
      expect(report.removedWorktrees).not.toContain(target);
      const skip = report.skipped.find((s) => s.target === target);
      expect(skip).toBeDefined();
      expect(skip!.reason).toMatch(/could not be (established|probed)/);
      expect(skip!.reason).toContain("not a directory");
    }
    // ...and the slice branch of the unprobable worktree survives with it.
    expect(
      git.branchExists(repo, `afk/${SLUG}-slice-16-fixture`),
    ).toBe(true);

    for (const est of preserved) {
      // Nothing of the estate is debris — not the worktree, not the branch,
      // and above all not the files the operator's next step depends on.
      expect(existsSync(est.wtDir)).toBe(true);
      expect(existsSync(est.impasseRecord)).toBe(true);
      if (est.decisionLog) expect(existsSync(est.decisionLog)).toBe(true);
      if (est.inFlight) expect(existsSync(est.inFlight)).toBe(true);
      // The retry path: the branch the next dispatch re-enters adjudication
      // on, still pointing at the same commit the estate was recorded
      // against.
      expect(git.branchExists(repo, est.branchName)).toBe(true);
      expect(report.deletedBranches).not.toContain(est.branchName);
      // The worktree is still git's, not just a surviving directory: pass 2
      // sweeps unregistered namespace leftovers, and an estate that pass 1
      // skipped but pass 2 deleted would be preserved in name only.
      expect(git.findWorktreeForBranch(repo, est.branchName)).not.toBeNull();
      expect(report.removedWorktrees).not.toContain(est.wtDir);

      // And the operator is told WHY the slice still has a worktree — a
      // silent skip reads as a bug in the command.
      const skip = report.skipped.find((s) => s.target === est.wtDir);
      expect(skip).toBeDefined();
      expect(skip!.reason).toContain(est.phase);
      expect(skip!.reason).toMatch(/adjudication estate|re-dispatch/);
    }
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

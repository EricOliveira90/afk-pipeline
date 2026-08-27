/**
 * `prepareSliceWorktree` integration tests — worktree creation and
 * refresh without agent invocations. Split out of
 * `resume-integration.test.ts` so one `vitest run` schedules the resume
 * suite across both workers (`maxWorkers: 2`) instead of pinning it to
 * one. Shared helpers are in `resume-integration.fixtures.ts`. When
 * adding a `describe`, keep the halves balanced by measured block time
 * (`--reporter=./scripts/describe-times.reporter.mjs`), not test count.
 */
import { describe, it, expect, afterAll, afterEach, beforeAll } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPipeline, makeSliceContext, prepareSliceWorktree } from "./orchestrator.js";
import { MAX_RESUME_ATTEMPTS } from "./resume.js";
import { loadRunState, recordRetryDecision } from "./run-state.js";
import { RunJournal as Logger } from "./run-journal.js";
import { buildDAG, type Slice } from "./issues-parser.js";
import type { AgentProvider, InvokeOptions, InvokeResult } from "./agent-provider.js";
import {
  allRunLogs,
  buildProvider,
  cleanupResumeTempDirs,
  findSliceArtifactDir,
  git,
  makeRepo,
  makeSlice,
  sliceLogLines,
  sliceNumberFromCwd,
  writePrdFixture,
  type PromptRecord,
} from "./resume-integration.fixtures.js";

afterEach(() => {
  cleanupResumeTempDirs();
});


/**
 * Cheaper checks at the worktree-preparation seam: `prepareSliceWorktree`
 * is the exported orchestrator unit that inspects git state, decides,
 * and mutates the worktree. No agent invocations needed.
 */
describe("prepareSliceWorktree", () => {
  const stubProvider: AgentProvider = {
    name: "stub",
    invoke: async () => ({ exitCode: 0, stdout: "", stats: {} }),
  };

  function makeCtx(
    repo: string,
    slug: string,
    slice: Slice,
    flags: { forceRestart?: string[]; resumeStuck?: string[] } = {},
  ) {
    return makeSliceContext(
      {
        repoRoot: repo,
        prdSlug: slug,
        prdDir: join(repo, ".kiro", "specs", slug),
        specsDir: join(".kiro", "specs", slug),
        dag: buildDAG([slice]),
        provider: stubProvider,
        ...(flags.forceRestart ? { forceRestart: flags.forceRestart } : {}),
        ...(flags.resumeStuck ? { resumeStuck: flags.resumeStuck } : {}),
      },
      slice,
      new Logger(repo, `${slug}-stub`),
      `feat-stub/${slug}`,
      "- README.md",
      "pnpm test",
    );
  }

  function sliceAt(number: string, ghIssue: string): Slice {
    return { number, ghIssue, title: `S${number}`, type: "AFK", blockedBy: [], userStories: "" };
  }

  /** Create the feature branch, the slice worktree, and one commit in it. */
  function seedResumableSlice(repo: string, ctx: ReturnType<typeof makeCtx>) {
    git(repo, ["branch", ctx.featBranch]);
    execFileSync("git", ["worktree", "add", "-b", ctx.branch, ctx.worktreeDir, ctx.featBranch], {
      cwd: repo, encoding: "utf-8",
    });
    mkdirSync(join(ctx.worktreeDir, "src"), { recursive: true });
    writeFileSync(join(ctx.worktreeDir, "src", `work-${ctx.slice.number}.ts`), "export {};\n", "utf-8");
    git(ctx.worktreeDir, ["add", "-A"]);
    git(ctx.worktreeDir, ["commit", "-m", `feat(#${ctx.slice.ghIssue}): work`]);
  }

  it("a feature branch that has not moved is a no-op refresh and still resumes (#35)", async () => {
    const repo = makeRepo();
    const ctx = makeCtx(repo, "noop-refresh", sliceAt("01", "4001"));
    seedResumableSlice(repo, ctx);
    const tipBefore = git(ctx.worktreeDir, ["rev-parse", "HEAD"]);

    await prepareSliceWorktree(ctx);

    // Resumed — and the no-op merge added no commit.
    expect(ctx.resume).toBeDefined();
    expect(ctx.resume!.commitsAhead).toBe(1);
    expect(git(ctx.worktreeDir, ["rev-parse", "HEAD"])).toBe(tipBefore);
  }, 240_000);

  it("multiple slices forced in one invocation restart; unnamed slices resume normally (#37)", async () => {
    const repo = makeRepo();
    const slug = "multi-force";
    const forced = ["01", "4003"]; // slice 01 by number, slice 03 by GH issue
    const contexts = [
      makeCtx(repo, slug, sliceAt("01", "4001"), { forceRestart: forced }),
      makeCtx(repo, slug, sliceAt("02", "4002"), { forceRestart: forced }),
      makeCtx(repo, slug, sliceAt("03", "4003"), { forceRestart: forced }),
    ];
    git(repo, ["branch", contexts[0]!.featBranch]);
    for (const ctx of contexts) {
      execFileSync("git", ["worktree", "add", "-b", ctx.branch, ctx.worktreeDir, ctx.featBranch], {
        cwd: repo, encoding: "utf-8",
      });
      mkdirSync(join(ctx.worktreeDir, "src"), { recursive: true });
      writeFileSync(join(ctx.worktreeDir, "src", `work-${ctx.slice.number}.ts`), "export {};\n", "utf-8");
      git(ctx.worktreeDir, ["add", "-A"]);
      git(ctx.worktreeDir, ["commit", "-m", `feat(#${ctx.slice.ghIssue}): work`]);
    }

    for (const ctx of contexts) await prepareSliceWorktree(ctx);

    expect(contexts[0]!.resume).toBeUndefined(); // forced by slice number
    expect(contexts[1]!.resume).toBeDefined(); // unnamed — resumes
    expect(contexts[2]!.resume).toBeUndefined(); // forced by GH issue id
    // Forced slices really went back to base.
    expect(git(repo, ["rev-parse", contexts[0]!.branch])).toBe(
      git(repo, ["rev-parse", contexts[0]!.featBranch]),
    );
  }, 240_000);

  /**
   * Mark a seeded slice STUCK the way the pipeline does — a stuck.md in
   * the slice artifact dir — and leave an uncommitted edit behind.
   */
  function markStuckWithDirtyTree(ctx: ReturnType<typeof makeCtx>) {
    mkdirSync(ctx.absSliceDir, { recursive: true });
    writeFileSync(join(ctx.absSliceDir, "stuck.md"), "# Stuck Handoff\nFinding 1.\n", "utf-8");
    writeFileSync(join(ctx.worktreeDir, "src", "in-flight.ts"), "export const x =", "utf-8");
  }

  it("--resume-stuck keeps the preserved tip, the dirty tree, and stuck.md (#49)", async () => {
    const repo = makeRepo();
    const ctx = makeCtx(repo, "stuck-optin", sliceAt("20", "49"), { resumeStuck: ["49"] });
    seedResumableSlice(repo, ctx);
    markStuckWithDirtyTree(ctx);
    const tipBefore = git(ctx.worktreeDir, ["rev-parse", "HEAD"]);

    await prepareSliceWorktree(ctx);

    expect(ctx.resume).toEqual({
      mode: "stuck",
      commitsAhead: 1,
      commitLog: expect.stringContaining("work"),
      handoffNote: "",
      stuckNote: expect.stringContaining("Finding 1."),
      baseRefreshed: true,
    });
    // Nothing was reset, cleaned, or recreated.
    expect(git(ctx.worktreeDir, ["rev-parse", "HEAD"])).toBe(tipBefore);
    expect(existsSync(join(ctx.worktreeDir, "src", "in-flight.ts"))).toBe(true);
    expect(existsSync(join(ctx.absSliceDir, "stuck.md"))).toBe(true);
  }, 240_000);

  it("--resume-stuck on an unnamed slice still declines to resume it (#49)", async () => {
    const repo = makeRepo();
    const ctx = makeCtx(repo, "stuck-unnamed", sliceAt("20", "49"), { resumeStuck: ["21"] });
    seedResumableSlice(repo, ctx);
    markStuckWithDirtyTree(ctx);
    const tipBefore = git(ctx.worktreeDir, ["rev-parse", "HEAD"]);

    // Terminal still means terminal — but since #113 the branch's commits
    // are not force-reset away to express that; the slice refuses and the
    // message names both flags that resolve it.
    await expect(prepareSliceWorktree(ctx)).rejects.toThrow(
      /refusing to restart .*--resume-stuck 49/s,
    );

    expect(ctx.resume).toBeUndefined();
    expect(git(repo, ["rev-parse", ctx.branch])).toBe(tipBefore);
  }, 240_000);

  it("--force-restart beats --resume-stuck on the same slice (#49)", async () => {
    const repo = makeRepo();
    const ctx = makeCtx(repo, "stuck-contested", sliceAt("20", "49"), {
      forceRestart: ["20"],
      resumeStuck: ["49"],
    });
    seedResumableSlice(repo, ctx);
    markStuckWithDirtyTree(ctx);

    await prepareSliceWorktree(ctx);

    expect(ctx.resume).toBeUndefined();
    expect(git(repo, ["rev-parse", ctx.branch])).toBe(
      git(repo, ["rev-parse", ctx.featBranch]),
    );
  }, 240_000);

  /**
   * #113: the resume-attempt cap used to convert into a from-base restart,
   * which force-reset the branch and recreated the worktree — destroying
   * 11 unmerged commits and a LOCKED contract in the PRD 1 run. These
   * cases live at this seam rather than in a spawned pipeline because the
   * whole defect is inside `prepareSliceWorktree`: no agent, contract
   * negotiation or QA round takes part in it.
   */
  function writeSliceArtifacts(ctx: ReturnType<typeof makeCtx>) {
    mkdirSync(ctx.absSliceDir, { recursive: true });
    writeFileSync(
      join(ctx.absSliceDir, "contract.md"),
      "# Slice Contract\n\n**Status:** LOCKED\n\n## Operator amendment\nKeep me.\n",
      "utf-8",
    );
    writeFileSync(join(ctx.absSliceDir, "context.md"), "# Context\n", "utf-8");
    writeFileSync(join(ctx.absSliceDir, "feedback-r2.md"), "VERDICT: ACCEPT\n", "utf-8");
    writeFileSync(join(ctx.absSliceDir, "qa-report.md"), "**Verdict:** FAIL\n", "utf-8");
  }

  /** Spend the slice's whole resume budget, as a prior run would have. */
  function spendResumeBudget(repo: string, slug: string, ghIssue: string) {
    recordRetryDecision(repo, `${slug}-stub`, ghIssue, {
      attempts: MAX_RESUME_ATTEMPTS,
      lastDecision: "resumed from 1 commit(s)",
    });
  }

  /**
   * The PRD 1 incident state, prepared once: a spent resume budget, a
   * commit on the branch, and the untracked artifacts in the worktree.
   * Every claim about the refusal reads off this one preparation.
   */
  describe("at the resume cap with commits on the branch (#113)", () => {
    const slug = "cap-refuses";
    let repo: string;
    let ctx: ReturnType<typeof makeCtx>;
    let tipBefore: string;
    let rejection: Error;

    beforeAll(async () => {
      repo = makeRepo({ lifetime: "describe" });
      ctx = makeCtx(repo, slug, sliceAt("05", "75"));
      seedResumableSlice(repo, ctx);
      writeSliceArtifacts(ctx);
      spendResumeBudget(repo, slug, "75");
      tipBefore = git(ctx.worktreeDir, ["rev-parse", "HEAD"]);
      rejection = await prepareSliceWorktree(ctx).then(
        () => {
          throw new Error("prepareSliceWorktree resolved — the cap did not refuse");
        },
        (err: Error) => err,
      );
    }, 240_000);

    afterAll(() => {
      try {
        rmSync(repo, { recursive: true, force: true });
      } catch {
        // best effort
      }
    });

    it("refuses instead of restarting, naming the commits at risk", () => {
      expect(rejection.message).toMatch(/refusing to restart .*1 unmerged commit\(s\)/s);
      expect(ctx.resume).toBeUndefined();
    });

    it("leaves the commits and the LOCKED contract exactly where they were", () => {
      expect(git(repo, ["rev-parse", ctx.branch])).toBe(tipBefore);
      expect(git(repo, ["rev-parse", ctx.branch])).not.toBe(
        git(repo, ["rev-parse", ctx.featBranch]),
      );
      const contract = readFileSync(join(ctx.absSliceDir, "contract.md"), "utf-8");
      expect(contract).toContain("**Status:** LOCKED");
      expect(contract).toContain("Keep me.");
    });

    it("names --force-restart and keeps the spent attempt count", () => {
      // The cap still binds: the counter is not reset, so the next
      // unattended run refuses again rather than granting a fresh budget.
      expect(rejection.message).toMatch(/--force-restart 75/);
      const recorded = loadRunState(repo, `${slug}-stub`).resume?.["75"];
      expect(recorded?.attempts).toBe(MAX_RESUME_ATTEMPTS);
      expect(recorded?.lastDecision).toMatch(/refused to restart from base/);
      expect(sliceLogLines(repo, `${slug}-stub`, "75")).toMatch(
        /refusing to restart/,
      );
    });
  });

  it("--force-restart archives the slice artifacts before resetting the branch (#113)", async () => {
    const repo = makeRepo();
    const slug = "force-archives";
    const ctx = makeCtx(repo, slug, sliceAt("05", "75"), { forceRestart: ["75"] });
    seedResumableSlice(repo, ctx);
    writeSliceArtifacts(ctx);

    await prepareSliceWorktree(ctx);

    // The operator asked for the discard, so the branch really does go
    // back to base — but the artifacts are recoverable afterwards.
    expect(git(repo, ["rev-parse", ctx.branch])).toBe(
      git(repo, ["rev-parse", ctx.featBranch]),
    );
    expect(existsSync(join(ctx.absSliceDir, "contract.md"))).toBe(false);
    const archiveDir = join(
      repo, ".afk", "artifacts", `${slug}-stub`, "slice-05", "pre-restart-1",
    );
    expect(readdirSync(archiveDir).sort()).toEqual([
      "context.md",
      "contract.md",
      "feedback-r2.md",
      "qa-report.md",
    ]);
    expect(readFileSync(join(archiveDir, "contract.md"), "utf-8")).toContain(
      "Keep me.",
    );
    expect(sliceLogLines(repo, `${slug}-stub`, "75")).toMatch(
      /artifacts archived to \.afk\/artifacts/,
    );
  }, 240_000);

  it("a capped slice with no commits beyond base still restarts plainly (#113)", async () => {
    const repo = makeRepo();
    const slug = "cap-no-commits";
    const ctx = makeCtx(repo, slug, sliceAt("05", "75"));
    git(repo, ["branch", ctx.featBranch]);
    execFileSync("git", ["worktree", "add", "-b", ctx.branch, ctx.worktreeDir, ctx.featBranch], {
      cwd: repo, encoding: "utf-8",
    });
    // Uncommitted work only — so there is nothing to lose and the restart
    // is not a no-op refresh either.
    mkdirSync(join(ctx.worktreeDir, "src"), { recursive: true });
    writeFileSync(join(ctx.worktreeDir, "src", "half-written.ts"), "export const x =", "utf-8");
    writeSliceArtifacts(ctx);
    spendResumeBudget(repo, slug, "75");

    await prepareSliceWorktree(ctx);

    expect(ctx.resume).toBeUndefined();
    expect(git(repo, ["rev-parse", ctx.branch])).toBe(
      git(repo, ["rev-parse", ctx.featBranch]),
    );
    expect(existsSync(join(ctx.worktreeDir, "src", "half-written.ts"))).toBe(false);
    // Restart earns a fresh resume budget, and the artifacts it deleted
    // were archived on the way out.
    expect(loadRunState(repo, `${slug}-stub`).resume?.["75"]?.attempts).toBe(0);
    expect(
      existsSync(join(
        repo, ".afk", "artifacts", `${slug}-stub`, "slice-05", "pre-restart-1", "contract.md",
      )),
    ).toBe(true);
  }, 240_000);
});

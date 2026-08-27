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

  it("--resume-stuck on an unnamed slice leaves the terminal restart alone (#49)", async () => {
    const repo = makeRepo();
    const ctx = makeCtx(repo, "stuck-unnamed", sliceAt("20", "49"), { resumeStuck: ["21"] });
    seedResumableSlice(repo, ctx);
    markStuckWithDirtyTree(ctx);

    await prepareSliceWorktree(ctx);

    expect(ctx.resume).toBeUndefined();
    expect(git(repo, ["rev-parse", ctx.branch])).toBe(
      git(repo, ["rev-parse", ctx.featBranch]),
    );
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
});

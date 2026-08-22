import { describe, it, expect, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executionLanes, runWave } from "./wave.js";
import { makeAsyncMutex, sliceBranch } from "./orchestrator.js";
import { buildDAG, type Slice } from "./issues-parser.js";
import { Logger } from "./logger.js";
import * as gitModule from "./git.js";
import type {
  AgentProvider,
  InvokeOptions,
  InvokeResult,
} from "./agent-provider.js";
import type { PipelineConfig } from "./orchestrator.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "afk-wave-"));
  tempDirs.push(dir);
  git(dir, ["init", "--initial-branch=main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  writeFileSync(join(dir, "README.md"), "test\n", "utf-8");
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "-m", "root"]);
  return dir;
}

interface SliceFixture {
  files: string[];
  qaPasses: boolean;
  outputFile: string;
  outputContent: string;
}

function findSliceArtifactDir(cwd: string, sliceNumber: string): string | null {
  const specsRoot = join(cwd, ".kiro", "specs");
  if (!existsSync(specsRoot)) return null;
  for (const slug of readdirSync(specsRoot)) {
    const slicesDir = join(specsRoot, slug, "slices");
    if (!existsSync(slicesDir)) continue;
    for (const entry of readdirSync(slicesDir)) {
      if (entry.startsWith(`${sliceNumber}-`)) {
        const full = join(slicesDir, entry);
        if (statSync(full).isDirectory()) return full;
      }
    }
  }
  return null;
}

function sliceFromCwd(cwd: string, slices: Slice[]): Slice | null {
  const norm = cwd.replace(/\\/g, "/").toLowerCase();
  for (const s of slices) {
    const re = new RegExp(`-s${s.number}(?:$|/)`);
    if (re.test(norm)) return s;
  }
  return null;
}

function buildStubProvider(opts: {
  fixtures: Map<string, SliceFixture>;
  slices: Slice[];
}): AgentProvider {
  const { fixtures, slices } = opts;
  const generatorRounds = new Map<string, number>();

  return {
    name: "stub",
    async invoke(options: InvokeOptions): Promise<InvokeResult> {
      const { role, cwd } = options;
      const slice = sliceFromCwd(cwd, slices);
      const ghIssue = slice?.ghIssue ?? "";
      const fixture = fixtures.get(ghIssue);
      await new Promise((r) => setTimeout(r, 5));

      const sliceArtifactDir = slice
        ? findSliceArtifactDir(cwd, slice.number)
        : null;

      if (role === "explorer" && sliceArtifactDir) {
        writeFileSync(
          join(sliceArtifactDir, "context.md"),
          `# Context for ${ghIssue}\n`,
          "utf-8",
        );
      } else if (role === "planner" && sliceArtifactDir && fixture) {
        const filesBlock = fixture.files.map((f) => `- ${f}`).join("\n");
        writeFileSync(
          join(sliceArtifactDir, "contract.md"),
          `# Slice Contract\n\n**Status:** LOCKED\n\n## Files expected to change\n${filesBlock}\n`,
          "utf-8",
        );
      } else if (role === "evaluator-contract" && sliceArtifactDir) {
        writeFileSync(
          join(sliceArtifactDir, "feedback-r1.md"),
          "## Evaluator feedback — round 1\n\n**Verdict:** ACCEPT\n",
          "utf-8",
        );
      } else if (role === "generator" && sliceArtifactDir && fixture) {
        const round = (generatorRounds.get(ghIssue) ?? 0) + 1;
        generatorRounds.set(ghIssue, round);
        const outPath = join(cwd, fixture.outputFile);
        mkdirSync(join(outPath, ".."), { recursive: true });
        writeFileSync(
          outPath,
          `${fixture.outputContent}\n// round ${round}\n`,
          "utf-8",
        );
      } else if (role === "evaluator-qa" && sliceArtifactDir && fixture) {
        const verdict = fixture.qaPasses ? "PASS" : "FAIL";
        writeFileSync(
          join(sliceArtifactDir, "qa-report.md"),
          `# QA Report\n\n**Verdict:** ${verdict}\n`,
          "utf-8",
        );
      } else if (role === "generator-stuck" && sliceArtifactDir) {
        writeFileSync(
          join(sliceArtifactDir, "stuck.md"),
          "# Stuck\n",
          "utf-8",
        );
      }

      return { exitCode: 0, stdout: "", stats: {} };
    },
  };
}

function setupWave(
  repo: string,
  slug: string,
  slices: Slice[],
  fixtures: Map<string, SliceFixture>,
  opts?: { signal?: AbortSignal },
) {
  const specsDir = join(".kiro", "specs", slug);
  const prdDir = join(repo, specsDir);
  mkdirSync(prdDir, { recursive: true });
  writeFileSync(
    join(prdDir, "prd.md"),
    `# ${slug}\n\n## Relevant Files\n- README.md\n`,
    "utf-8",
  );

  const provider = buildStubProvider({ fixtures, slices });
  const dag = buildDAG(slices);
  const featBranch = `feat-stub/${slug}`;

  // Create the feature branch
  git(repo, ["branch", featBranch]);

  const loggerSlug = `${slug}-stub`;
  const logger = new Logger(repo, loggerSlug);

  const config: PipelineConfig = {
    repoRoot: repo,
    prdSlug: slug,
    prdDir,
    specsDir,
    dag,
    provider,
    signal: opts?.signal,
  };

  return { config, dag, logger, featBranch, provider };
}

describe("runWave", () => {
  it("flattens independent lanes in deterministic order when serial execution is enabled", () => {
    const one = { number: "01", ghIssue: "101", title: "One", type: "AFK", blockedBy: [], userStories: "" } as Slice;
    const two = { number: "02", ghIssue: "102", title: "Two", type: "AFK", blockedBy: [], userStories: "" } as Slice;

    expect(executionLanes([[one], [two]], true)).toEqual([[one, two]]);
    expect(executionLanes([[one], [two]], false)).toEqual([[one], [two]]);
  });

  it("returns PASS for a single slice that passes QA", async () => {
    const repo = makeRepo();
    const slices: Slice[] = [
      { number: "01", ghIssue: "100", title: "Only", type: "AFK", blockedBy: [], userStories: "" },
    ];
    const fixtures = new Map<string, SliceFixture>([
      ["100", { files: ["src/a.txt"], qaPasses: true, outputFile: "src/a.txt", outputContent: "hello" }],
    ]);
    const { config, dag, logger, featBranch } = setupWave(repo, "wave-pass", slices, fixtures);

    const { outcomes } = await runWave({
      waveNumber: 1,
      readyIds: ["100"],
      config,
      dag,
      logger,
      featBranch,
      relevantFilesBlock: "- README.md",
      testCommand: "pnpm test",
      mergeMutex: makeAsyncMutex(),
    });

    expect(outcomes.get("100")?.phase).toBe("PASS");
  }, 30_000);

  it("returns STUCK when QA fails after max rounds", async () => {
    const repo = makeRepo();
    const slices: Slice[] = [
      { number: "01", ghIssue: "200", title: "Failing", type: "AFK", blockedBy: [], userStories: "" },
    ];
    const fixtures = new Map<string, SliceFixture>([
      ["200", { files: ["src/b.txt"], qaPasses: false, outputFile: "src/b.txt", outputContent: "broken" }],
    ]);
    const { config, dag, logger, featBranch } = setupWave(repo, "wave-stuck", slices, fixtures);

    const { outcomes } = await runWave({
      waveNumber: 1,
      readyIds: ["200"],
      config,
      dag,
      logger,
      featBranch,
      relevantFilesBlock: "- README.md",
      testCommand: "pnpm test",
      mergeMutex: makeAsyncMutex(),
    });

    expect(outcomes.get("200")?.phase).toBe("STUCK");
  }, 30_000);

  it("continues the lane when a predecessor fails — the successor runs on the unchanged base (ADR 0024)", async () => {
    const repo = makeRepo();
    const slices: Slice[] = [
      { number: "01", ghIssue: "301", title: "First", type: "AFK", blockedBy: [], userStories: "" },
      { number: "02", ghIssue: "302", title: "Second", type: "AFK", blockedBy: [], userStories: "" },
    ];
    const fixtures = new Map<string, SliceFixture>([
      ["301", { files: ["src/shared.txt"], qaPasses: false, outputFile: "src/shared.txt", outputContent: "fail" }],
      ["302", { files: ["src/shared.txt"], qaPasses: true, outputFile: "src/shared.txt", outputContent: "ok" }],
    ]);
    const { config, dag, logger, featBranch } = setupWave(repo, "wave-continue", slices, fixtures);

    const { outcomes } = await runWave({
      waveNumber: 1,
      readyIds: ["301", "302"],
      config,
      dag,
      logger,
      featBranch,
      relevantFilesBlock: "- README.md",
      testCommand: "pnpm test",
      mergeMutex: makeAsyncMutex(),
    });

    // Pre-ADR-0024 behaviour marked 302 LANE-CANCELLED as collateral of
    // 301's failure. The slices are DAG-independent and the successor
    // re-negotiates on the featBranch tip either way, so it now runs —
    // and passes — despite the dead predecessor ahead of it.
    expect(outcomes.get("301")?.phase).toBe("STUCK");
    expect(outcomes.get("302")?.phase).toBe("PASS");
    // 302's work actually landed on the feature branch.
    git(repo, ["checkout", featBranch]);
    const shared = readFileSync(
      join(repo, "src", "shared.txt"),
      "utf-8",
    );
    expect(shared).toContain("ok");
  }, 60_000);

  it("runs disjoint slices in parallel lanes", async () => {
    const repo = makeRepo();
    const slices: Slice[] = [
      { number: "01", ghIssue: "401", title: "Alpha", type: "AFK", blockedBy: [], userStories: "" },
      { number: "02", ghIssue: "402", title: "Beta", type: "AFK", blockedBy: [], userStories: "" },
    ];
    const fixtures = new Map<string, SliceFixture>([
      ["401", { files: ["src/alpha.txt"], qaPasses: true, outputFile: "src/alpha.txt", outputContent: "a" }],
      ["402", { files: ["src/beta.txt"], qaPasses: true, outputFile: "src/beta.txt", outputContent: "b" }],
    ]);
    const { config, dag, logger, featBranch } = setupWave(repo, "wave-parallel", slices, fixtures);

    const { outcomes } = await runWave({
      waveNumber: 1,
      readyIds: ["401", "402"],
      config,
      dag,
      logger,
      featBranch,
      relevantFilesBlock: "- README.md",
      testCommand: "pnpm test",
      mergeMutex: makeAsyncMutex(),
    });

    expect(outcomes.get("401")?.phase).toBe("PASS");
    expect(outcomes.get("402")?.phase).toBe("PASS");
  }, 30_000);

  it("returns CANCELLED for all slices when signal fires during Phase A", async () => {
    const repo = makeRepo();
    const controller = new AbortController();
    const { CancelledError } = await import("./agent-provider.js");
    const slices: Slice[] = [
      { number: "01", ghIssue: "501", title: "Aborted", type: "AFK", blockedBy: [], userStories: "" },
      { number: "02", ghIssue: "502", title: "Also aborted", type: "AFK", blockedBy: [], userStories: "" },
    ];

    // Provider aborts during the first slice's explorer, then throws
    // CancelledError on subsequent invocations (mimicking real behaviour).
    const abortProvider: AgentProvider = {
      name: "stub",
      async invoke(options: InvokeOptions): Promise<InvokeResult> {
        if (options.role === "explorer" && !controller.signal.aborted) {
          controller.abort();
          throw new CancelledError();
        }
        if (controller.signal.aborted) {
          throw new CancelledError();
        }
        await new Promise((r) => setTimeout(r, 5));
        return { exitCode: 0, stdout: "", stats: {} };
      },
    };

    const specsDir = join(".kiro", "specs", "wave-abort");
    const prdDir = join(repo, specsDir);
    mkdirSync(prdDir, { recursive: true });
    writeFileSync(join(prdDir, "prd.md"), "# wave-abort\n\n## Relevant Files\n- README.md\n", "utf-8");
    const dag = buildDAG(slices);
    const featBranch = "feat-stub/wave-abort";
    git(repo, ["branch", featBranch]);
    const logger = new Logger(repo, "wave-abort-stub");

    const config: PipelineConfig = {
      repoRoot: repo,
      prdSlug: "wave-abort",
      prdDir,
      specsDir,
      dag,
      provider: abortProvider,
      signal: controller.signal,
    };

    const { outcomes } = await runWave({
      waveNumber: 1,
      readyIds: ["501", "502"],
      config,
      dag,
      logger,
      featBranch,
      relevantFilesBlock: "- README.md",
      testCommand: "pnpm test",
      mergeMutex: makeAsyncMutex(),
    });

    // Both slices should be CANCELLED — one rejected with CancelledError,
    // the other caught by the post-Phase-A signal check.
    expect(outcomes.get("501")?.phase).toBe("CANCELLED");
    expect(outcomes.get("502")?.phase).toBe("CANCELLED");
  }, 30_000);

  it("collapses wave to one lane when a slice has undeclared files", async () => {
    const repo = makeRepo();
    const slices: Slice[] = [
      { number: "01", ghIssue: "601", title: "Known", type: "AFK", blockedBy: [], userStories: "" },
      { number: "02", ghIssue: "602", title: "Unknown", type: "AFK", blockedBy: [], userStories: "" },
    ];

    // 602 has an empty files list in the fixture — but the provider
    // won't write "Files expected to change" for it, so
    // readContractFiles returns undefined → undeclared → collapse.
    const undeclaredProvider: AgentProvider = {
      name: "stub",
      async invoke(options: InvokeOptions): Promise<InvokeResult> {
        const { role, cwd } = options;
        const slice = sliceFromCwd(cwd, slices);
        const ghIssue = slice?.ghIssue ?? "";
        await new Promise((r) => setTimeout(r, 5));

        const sliceArtifactDir = slice
          ? findSliceArtifactDir(cwd, slice.number)
          : null;

        if (role === "explorer" && sliceArtifactDir) {
          writeFileSync(join(sliceArtifactDir, "context.md"), "# Context\n", "utf-8");
        } else if (role === "planner" && sliceArtifactDir) {
          if (ghIssue === "601") {
            writeFileSync(
              join(sliceArtifactDir, "contract.md"),
              "# Contract\n\n**Status:** LOCKED\n\n## Files expected to change\n- src/a.txt\n",
              "utf-8",
            );
          } else {
            // No "Files expected to change" section → undeclared
            writeFileSync(
              join(sliceArtifactDir, "contract.md"),
              "# Contract\n\n**Status:** LOCKED\n",
              "utf-8",
            );
          }
        } else if (role === "evaluator-contract" && sliceArtifactDir) {
          writeFileSync(
            join(sliceArtifactDir, "feedback-r1.md"),
            "## Evaluator feedback — round 1\n\n**Verdict:** ACCEPT\n",
            "utf-8",
          );
        } else if (role === "generator" && sliceArtifactDir) {
          const outFile = ghIssue === "601" ? "src/a.txt" : "src/b.txt";
          const outPath = join(cwd, outFile);
          mkdirSync(join(outPath, ".."), { recursive: true });
          writeFileSync(outPath, `content for ${ghIssue}\n`, "utf-8");
        } else if (role === "evaluator-qa" && sliceArtifactDir) {
          writeFileSync(
            join(sliceArtifactDir, "qa-report.md"),
            "# QA Report\n\n**Verdict:** PASS\n",
            "utf-8",
          );
        }

        return { exitCode: 0, stdout: "", stats: {} };
      },
    };

    const specsDir = join(".kiro", "specs", "wave-undeclared");
    const prdDir = join(repo, specsDir);
    mkdirSync(prdDir, { recursive: true });
    writeFileSync(join(prdDir, "prd.md"), "# wave-undeclared\n\n## Relevant Files\n- README.md\n", "utf-8");
    const dag = buildDAG(slices);
    const featBranch = "feat-stub/wave-undeclared";
    git(repo, ["branch", featBranch]);
    const logger = new Logger(repo, "wave-undeclared-stub");

    const config: PipelineConfig = {
      repoRoot: repo,
      prdSlug: "wave-undeclared",
      prdDir,
      specsDir,
      dag,
      provider: undeclaredProvider,
      signal: undefined,
    };

    const { outcomes } = await runWave({
      waveNumber: 1,
      readyIds: ["601", "602"],
      config,
      dag,
      logger,
      featBranch,
      relevantFilesBlock: "- README.md",
      testCommand: "pnpm test",
      mergeMutex: makeAsyncMutex(),
    });

    // Both should pass (serial within one lane, no failure).
    expect(outcomes.get("601")?.phase).toBe("PASS");
    expect(outcomes.get("602")?.phase).toBe("PASS");
  }, 60_000);

  // Regression for the PRD 024 crash: when one lane's post-merge git
  // call threw, the whole `Promise.all` rejected, aborting the
  // `runWave` and any sibling lane mid-flight. The wave loop must
  // contain post-merge errors per-slice so independent lanes are
  // unaffected.
  it("contains a post-merge git failure to its own slice; sibling lane still passes", async () => {
    const repo = makeRepo();
    const slices: Slice[] = [
      { number: "01", ghIssue: "701", title: "Doomed", type: "AFK", blockedBy: [], userStories: "" },
      { number: "02", ghIssue: "702", title: "Survivor", type: "AFK", blockedBy: [], userStories: "" },
    ];
    const fixtures = new Map<string, SliceFixture>([
      ["701", { files: ["src/doomed.txt"], qaPasses: true, outputFile: "src/doomed.txt", outputContent: "doomed" }],
      ["702", { files: ["src/survivor.txt"], qaPasses: true, outputFile: "src/survivor.txt", outputContent: "survivor" }],
    ]);
    const { config, dag, logger, featBranch } = setupWave(repo, "wave-resilience", slices, fixtures);

    // Inject a thrown error into slice 701's post-merge `hasCommitsAhead`
    // call. Slice 702's call must still succeed and the wave must
    // return normally with both outcomes recorded.
    const real = gitModule.hasCommitsAhead;
    const spy = vi.spyOn(gitModule, "hasCommitsAhead").mockImplementation(
      (repoRoot, source, target) => {
        if (source.includes("slice-01-")) {
          throw new Error("simulated post-merge git failure");
        }
        return real(repoRoot, source, target);
      },
    );

    try {
      const { outcomes } = await runWave({
        waveNumber: 1,
        readyIds: ["701", "702"],
        config,
        dag,
        logger,
        featBranch,
        relevantFilesBlock: "- README.md",
        testCommand: "pnpm test",
        mergeMutex: makeAsyncMutex(),
      });

      expect(outcomes.get("701")?.phase).toBe("ERROR");
      expect(outcomes.get("702")?.phase).toBe("PASS");
    } finally {
      spy.mockRestore();
    }
  }, 60_000);

  // Regression for the silent-corruption bug: when the slice branch
  // does NOT exist after the generator returns, that's a different
  // failure mode than "branch exists but is at the same tip as
  // featBranch". The first means the worktree was corrupted and
  // commits leaked to the parent repo's HEAD; the second is a true
  // no-output run. The wave must surface them distinctly so operators
  // can investigate the right thing.
  it("flags ERROR with branch-missing message when slice branch does not exist", async () => {
    const repo = makeRepo();
    const slices: Slice[] = [
      { number: "01", ghIssue: "901", title: "Branch gone", type: "AFK", blockedBy: [], userStories: "" },
    ];
    const fixtures = new Map<string, SliceFixture>([
      ["901", { files: ["src/g.txt"], qaPasses: true, outputFile: "src/g.txt", outputContent: "g" }],
    ]);
    const { config, dag, logger, featBranch } = setupWave(repo, "wave-branch-gone", slices, fixtures);

    // Simulate the corruption: branch was never registered. Note we
    // mock branchExists to return false specifically for the slice
    // branch — the feature branch must continue to be reported as
    // existing or other call sites would break.
    const realBranchExists = gitModule.branchExists;
    const spy = vi
      .spyOn(gitModule, "branchExists")
      .mockImplementation((cwd, branch) => {
        if (branch.includes("slice-01-")) return false;
        return realBranchExists(cwd, branch);
      });

    try {
      const { outcomes } = await runWave({
        waveNumber: 1,
        readyIds: ["901"],
        config,
        dag,
        logger,
        featBranch,
        relevantFilesBlock: "- README.md",
        testCommand: "pnpm test",
        mergeMutex: makeAsyncMutex(),
      });

      const outcome = outcomes.get("901");
      expect(outcome?.phase).toBe("ERROR");
      if (outcome?.phase === "ERROR") {
        expect(outcome.error).toMatch(/does not exist/i);
        // Must NOT collapse to the generic no-commits message — that's
        // exactly the symptom the bug presented as.
        expect(outcome.error).not.toContain("no commits ahead");
      }
    } finally {
      spy.mockRestore();
    }
  }, 30_000);

  // The one lane-halting exception ADR 0024 keeps: the ADR 0010
  // corruption signature. Ordinary failures let the lane continue,
  // but dispatching more agents into a repo whose worktree
  // registration already failed silently risks compounding the
  // damage — successors stay LANE-CANCELLED and an operator goes
  // first.
  it("still lane-cancels successors when the predecessor hits the corruption signature", async () => {
    const repo = makeRepo();
    const slices: Slice[] = [
      { number: "01", ghIssue: "911", title: "Corrupted", type: "AFK", blockedBy: [], userStories: "" },
      { number: "02", ghIssue: "912", title: "Behind", type: "AFK", blockedBy: [], userStories: "" },
    ];
    const fixtures = new Map<string, SliceFixture>([
      ["911", { files: ["src/c.txt"], qaPasses: true, outputFile: "src/c.txt", outputContent: "c1" }],
      ["912", { files: ["src/c.txt"], qaPasses: true, outputFile: "src/c.txt", outputContent: "c2" }],
    ]);
    const { config, dag, logger, featBranch } = setupWave(repo, "wave-corrupt-halt", slices, fixtures);

    const realBranchExists = gitModule.branchExists;
    const spy = vi
      .spyOn(gitModule, "branchExists")
      .mockImplementation((cwd, branch) => {
        if (branch.includes("slice-01-")) return false;
        return realBranchExists(cwd, branch);
      });

    try {
      const { outcomes } = await runWave({
        waveNumber: 1,
        readyIds: ["911", "912"],
        config,
        dag,
        logger,
        featBranch,
        relevantFilesBlock: "- README.md",
        testCommand: "pnpm test",
        mergeMutex: makeAsyncMutex(),
      });

      expect(outcomes.get("911")?.phase).toBe("ERROR");
      const successor = outcomes.get("912");
      expect(successor?.phase).toBe("LANE-CANCELLED");
      if (successor?.phase === "LANE-CANCELLED") {
        expect(successor.error).toMatch(/corruption signature/i);
      }
    } finally {
      spy.mockRestore();
    }
  }, 60_000);

  // Sister regression: the existing "generator produced no output"
  // guard must keep working. When `hasCommitsAhead` reports `false`
  // (slice tip is already at featBranch), the slice gets ERROR with
  // the no-commits message — the resilience fix must not paper over
  // that path.
  it("flags ERROR with no-commits message when hasCommitsAhead returns false", async () => {
    const repo = makeRepo();
    const slices: Slice[] = [
      { number: "01", ghIssue: "801", title: "Empty output", type: "AFK", blockedBy: [], userStories: "" },
    ];
    const fixtures = new Map<string, SliceFixture>([
      ["801", { files: ["src/x.txt"], qaPasses: true, outputFile: "src/x.txt", outputContent: "x" }],
    ]);
    const { config, dag, logger, featBranch } = setupWave(repo, "wave-empty", slices, fixtures);

    const spy = vi
      .spyOn(gitModule, "hasCommitsAhead")
      .mockImplementation(() => false);

    try {
      const { outcomes } = await runWave({
        waveNumber: 1,
        readyIds: ["801"],
        config,
        dag,
        logger,
        featBranch,
        relevantFilesBlock: "- README.md",
        testCommand: "pnpm test",
        mergeMutex: makeAsyncMutex(),
      });

      const outcome = outcomes.get("801");
      expect(outcome?.phase).toBe("ERROR");
      if (outcome?.phase === "ERROR") {
        expect(outcome.error).toContain("no commits ahead");
      }
    } finally {
      spy.mockRestore();
    }
  }, 30_000);
});



/**
 * Per-slice outcome hook (ADR 0018): runWave must report each slice's
 * terminal outcome the moment it lands — PASS only after the merge —
 * so the orchestrator can persist it before the wave finishes. A
 * throwing callback must be contained, never aborting the lane.
 */
describe("runWave onOutcome", () => {
  it("fires PASS after the merge landed and before the lane successor's refresh starts", async () => {
    const repo = makeRepo();
    const slices: Slice[] = [
      { number: "01", ghIssue: "111", title: "Predecessor", type: "AFK", blockedBy: [], userStories: "" },
      { number: "02", ghIssue: "112", title: "Successor", type: "AFK", blockedBy: [], userStories: "" },
    ];
    // Shared file → one lane → 112 runs strictly after 111 merges.
    const fixtures = new Map<string, SliceFixture>([
      ["111", { files: ["src/serial.txt"], qaPasses: true, outputFile: "src/serial.txt", outputContent: "from 111" }],
      ["112", { files: ["src/serial.txt"], qaPasses: true, outputFile: "src/serial.txt", outputContent: "from 112" }],
    ]);
    const { config, dag, logger, featBranch, provider } = setupWave(
      repo,
      "wave-onoutcome-order",
      slices,
      fixtures,
    );

    // Wrap the stub provider so invocations and onOutcome calls land in
    // one ordered event list (Node is single-threaded, so array order
    // is the real interleaving).
    const events: string[] = [];
    let featContentAtPass: string | null = null;
    config.provider = {
      name: "stub",
      async invoke(options: InvokeOptions): Promise<InvokeResult> {
        const slice = sliceFromCwd(options.cwd, slices);
        events.push(`invoke:${options.role}:${slice?.ghIssue ?? "?"}`);
        return provider.invoke(options);
      },
    };

    const { outcomes } = await runWave({
      waveNumber: 1,
      readyIds: ["111", "112"],
      config,
      dag,
      logger,
      featBranch,
      relevantFilesBlock: "- README.md",
      testCommand: "pnpm test",
      mergeMutex: makeAsyncMutex(),
      onOutcome: (id, outcome) => {
        events.push(`outcome:${outcome.phase}:${id}`);
        if (id === "111" && outcome.phase === "PASS") {
          // PASS must only be reported once the content is actually on
          // the feature branch — a crash right after this callback must
          // leave a state file that is safe to resume from.
          featContentAtPass = git(repo, [
            "show",
            `${featBranch}:src/serial.txt`,
          ]);
        }
      },
    });

    expect(outcomes.get("111")?.phase).toBe("PASS");
    expect(outcomes.get("112")?.phase).toBe("PASS");

    // Merge-before-callback: the feature branch already held 111's work.
    expect(featContentAtPass).toContain("from 111");

    // Callback-before-successor: 112's first explorer ran during the
    // parallel Phase A; its SECOND explorer is the lane-successor
    // re-negotiation, which must start only after 111's PASS was
    // reported.
    const passIdx = events.indexOf("outcome:PASS:111");
    const explorer112 = events
      .map((e, i) => (e === "invoke:explorer:112" ? i : -1))
      .filter((i) => i >= 0);
    expect(passIdx).toBeGreaterThanOrEqual(0);
    expect(explorer112.length).toBeGreaterThanOrEqual(2);
    expect(passIdx).toBeLessThan(explorer112[1]!);
  }, 60_000);

  it("contains a throwing onOutcome and still records outcomes in-memory", async () => {
    const repo = makeRepo();
    const slices: Slice[] = [
      { number: "01", ghIssue: "121", title: "Only", type: "AFK", blockedBy: [], userStories: "" },
    ];
    const fixtures = new Map<string, SliceFixture>([
      ["121", { files: ["src/ok.txt"], qaPasses: true, outputFile: "src/ok.txt", outputContent: "ok" }],
    ]);
    const { config, dag, logger, featBranch } = setupWave(
      repo,
      "wave-onoutcome-throws",
      slices,
      fixtures,
    );

    const calls: string[] = [];
    const { outcomes } = await runWave({
      waveNumber: 1,
      readyIds: ["121"],
      config,
      dag,
      logger,
      featBranch,
      relevantFilesBlock: "- README.md",
      testCommand: "pnpm test",
      mergeMutex: makeAsyncMutex(),
      onOutcome: (id, outcome) => {
        calls.push(`${id}:${outcome.phase}`);
        throw new Error("state file write failed");
      },
    });

    // The callback threw, but the wave neither rejected nor lost the
    // outcome — the orchestrator's post-wave reconciliation retries.
    expect(calls).toEqual(["121:PASS"]);
    expect(outcomes.get("121")?.phase).toBe("PASS");
  }, 30_000);
});

/**
 * Deferred merge (ADR 0025). The merge-mutex migration-prefix check is
 * unchanged and stays where it is; what changed is that its refusal is no
 * longer terminal. These drive `runWave` the way the rest of this file
 * does — a real temporary git repo plus per-slice fixtures — and assert
 * the outcome an operator sees.
 */
describe("runWave migration prefix collision → MERGE-PENDING", () => {
  /** Put a migration on `main` so the feature branch inherits it. */
  function seedMigrationOnMain(repo: string, filename: string) {
    mkdirSync(join(repo, "supabase", "migrations"), { recursive: true });
    writeFileSync(
      join(repo, "supabase", "migrations", filename),
      "-- seeded\n",
      "utf-8",
    );
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", `add ${filename}`]);
  }

  it("records MERGE-PENDING with the colliding prefixes and preserves the slice branch", async () => {
    const repo = makeRepo();
    seedMigrationOnMain(repo, "042_users.sql");
    const slices: Slice[] = [
      { number: "01", ghIssue: "601", title: "Adds orders", type: "AFK", blockedBy: [], userStories: "" },
    ];
    // Same numeric prefix, different filename — the integration-time
    // schema-ordering collision, detected against the feature-branch tip.
    const fixtures = new Map<string, SliceFixture>([
      ["601", {
        files: ["supabase/migrations/042_orders.sql"],
        qaPasses: true,
        outputFile: "supabase/migrations/042_orders.sql",
        outputContent: "-- orders",
      }],
    ]);
    const { config, dag, logger, featBranch, provider } = setupWave(
      repo,
      "wave-merge-pending",
      slices,
      fixtures,
    );

    const { outcomes } = await runWave({
      waveNumber: 1,
      readyIds: ["601"],
      config,
      dag,
      logger,
      featBranch,
      relevantFilesBlock: "- README.md",
      testCommand: "pnpm test",
      mergeMutex: makeAsyncMutex(),
    });

    const outcome = outcomes.get("601");
    expect(outcome?.phase).toBe("MERGE-PENDING");
    if (outcome?.phase !== "MERGE-PENDING") throw new Error("expected MERGE-PENDING");
    expect(outcome.collidingPrefixes).toEqual(["042"]);
    expect(outcome.error).toContain("042");
    expect(outcome.error).toContain("retries the merge");

    // The whole point: the work survived. The branch still exists and
    // still carries the commits the merge refused.
    const branch = sliceBranch("wave-merge-pending", slices[0]!, provider);
    expect(gitModule.branchExists(repo, branch)).toBe(true);
    expect(gitModule.hasCommitsAhead(repo, branch, featBranch)).toBe(true);
    // …and nothing landed on the feature branch.
    expect(
      gitModule.listMigrationFiles(repo, featBranch),
    ).toEqual(["042_users.sql"]);
  }, 30_000);

  it("still records CONFLICT for a real git merge conflict", async () => {
    const repo = makeRepo();
    const slices: Slice[] = [
      { number: "01", ghIssue: "611", title: "Alpha", type: "AFK", blockedBy: [], userStories: "" },
      { number: "02", ghIssue: "612", title: "Beta", type: "AFK", blockedBy: [], userStories: "" },
    ];
    // Disjoint declared files → separate lanes → both generate from the
    // same base; both add the same untracked path with different content,
    // so whichever merges second hits a real add/add conflict. No
    // migrations anywhere near it.
    const fixtures = new Map<string, SliceFixture>([
      ["611", { files: ["src/alpha.txt"], qaPasses: true, outputFile: "src/clash.txt", outputContent: "from alpha" }],
      ["612", { files: ["src/beta.txt"], qaPasses: true, outputFile: "src/clash.txt", outputContent: "from beta" }],
    ]);
    const { config, dag, logger, featBranch } = setupWave(
      repo,
      "wave-real-conflict",
      slices,
      fixtures,
    );

    const { outcomes } = await runWave({
      waveNumber: 1,
      readyIds: ["611", "612"],
      config,
      dag,
      logger,
      featBranch,
      relevantFilesBlock: "- README.md",
      testCommand: "pnpm test",
      mergeMutex: makeAsyncMutex(),
    });

    const phases = ["611", "612"].map((id) => outcomes.get(id)?.phase).sort();
    expect(phases).toEqual(["CONFLICT", "PASS"]);
  }, 60_000);

  it("continues the lane past a MERGE-PENDING member", async () => {
    const repo = makeRepo();
    seedMigrationOnMain(repo, "042_users.sql");
    const slices: Slice[] = [
      { number: "01", ghIssue: "621", title: "Collides", type: "AFK", blockedBy: [], userStories: "" },
      { number: "02", ghIssue: "622", title: "Lane mate", type: "AFK", blockedBy: [], userStories: "" },
    ];
    // Shared declared file → one lane, 621 ahead of 622.
    const fixtures = new Map<string, SliceFixture>([
      ["621", {
        files: ["src/lane.txt", "supabase/migrations/042_orders.sql"],
        qaPasses: true,
        outputFile: "supabase/migrations/042_orders.sql",
        outputContent: "-- orders",
      }],
      ["622", { files: ["src/lane.txt"], qaPasses: true, outputFile: "src/lane.txt", outputContent: "lane mate" }],
    ]);
    const { config, dag, logger, featBranch } = setupWave(
      repo,
      "wave-merge-pending-lane",
      slices,
      fixtures,
    );

    const { outcomes } = await runWave({
      waveNumber: 1,
      readyIds: ["621", "622"],
      config,
      dag,
      logger,
      featBranch,
      relevantFilesBlock: "- README.md",
      testCommand: "pnpm test",
      mergeMutex: makeAsyncMutex(),
    });

    expect(outcomes.get("621")?.phase).toBe("MERGE-PENDING");
    expect(outcomes.get("622")?.phase).toBe("PASS");
  }, 60_000);
});

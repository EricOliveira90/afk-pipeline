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
import { executionLanes, runWave, type WaveOutcome } from "./wave.js";
import { makeAsyncMutex, sliceBranch } from "./orchestrator.js";
import { buildDAG, type Slice } from "./issues-parser.js";
import { RunJournal as Logger } from "./run-journal.js";
import * as gitModule from "./git.js";
import type {
  AgentProvider,
  InvokeOptions,
  InvokeResult,
} from "./agent-provider.js";
import { CancelledError, TransientProviderError } from "./agent-provider.js";
import { readRunEvents, type RunEvent } from "./run-events.js";
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
  /**
   * Verdict the contract evaluator writes. Defaults to ACCEPT; ESCALATE
   * drives the "genuine verdict" negotiate failure — the evaluator lived
   * and decided, so nothing about it is an infrastructure death.
   */
  contractVerdict?: "ACCEPT" | "ESCALATE";
}

/**
 * How the fake provider should die on a role's invocation, so the wave
 * tests can drive each agent-failure cause (ADR 0025) at the same seam
 * a real provider produces it: a rejected `invoke` whose message is the
 * only record of the exit code or the kill class.
 *
 * `times` bounds how many consecutive invocations of that role die;
 * later ones behave normally, which is how an infrastructure retry is
 * observed to recover. Omit it to die every time.
 */
interface ProviderDeath {
  role: string;
  kind: "exit" | "idle-kill" | "ceiling-kill" | "tool-cap-kill" | "transient";
  /** `kind: "exit"` only. */
  exitCode?: number;
  times?: number;
}

/**
 * Build the rejection a real provider would produce. The message shapes
 * are copied from `claude.ts` / `kiro.ts` verbatim — they are the wire
 * format the classifier reads.
 */
function deathError(death: ProviderDeath, role: string): Error {
  switch (death.kind) {
    case "exit":
      return new Error(`Agent ${role} exited with code ${death.exitCode ?? 1}`);
    case "idle-kill":
      return new Error(`Agent ${role} idle for 600s — killed`);
    case "ceiling-kill":
      return new Error(
        `Agent ${role} exceeded 7200s wall-clock ceiling — killed`,
      );
    case "tool-cap-kill":
      return new Error(`Agent ${role} exceeded 100 tool calls — killed`);
    case "transient":
      return new TransientProviderError(
        `Agent ${role} exited with code 1 — model temporarily unavailable`,
      );
  }
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
  deaths?: ProviderDeath[];
  /** `role:ghIssue` per invocation, in call order. */
  records?: string[];
}): AgentProvider {
  const { fixtures, slices, deaths = [], records } = opts;
  const generatorRounds = new Map<string, number>();
  const roleAttempts = new Map<string, number>();

  return {
    name: "stub",
    async invoke(options: InvokeOptions): Promise<InvokeResult> {
      const { role, cwd } = options;
      const slice = sliceFromCwd(cwd, slices);
      const ghIssue = slice?.ghIssue ?? "";
      const fixture = fixtures.get(ghIssue);
      records?.push(`${role}:${ghIssue}`);
      await new Promise((r) => setTimeout(r, 5));

      const attempts = (roleAttempts.get(`${role}:${ghIssue}`) ?? 0) + 1;
      roleAttempts.set(`${role}:${ghIssue}`, attempts);
      const death = deaths.find(
        (d) => d.role === role && attempts <= (d.times ?? Infinity),
      );
      if (death) {
        // Real providers tee stdout into the agent log before dying, and
        // that tail is what the failure reason must carry.
        options.logStream?.write(
          `stub ${role} output line\nabout to die: ${death.kind}\n`,
        );
        throw deathError(death, role);
      }

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
        // The planner leaves the contract in DRAFT: the orchestrator owns
        // the LOCKED transition (ADR 0008), and a planner that pre-locked
        // it would hide the round loop from any test that re-enters
        // negotiation on a contract already on disk.
        writeFileSync(
          join(sliceArtifactDir, "contract.md"),
          `# Slice Contract\n\n**Status:** DRAFT\n\n## Files expected to change\n${filesBlock}\n`,
          "utf-8",
        );
      } else if (role === "evaluator-contract" && sliceArtifactDir) {
        const verdict = fixture?.contractVerdict ?? "ACCEPT";
        writeFileSync(
          join(sliceArtifactDir, "feedback-r1.md"),
          `## Evaluator feedback — round 1\n\n**Verdict:** ${verdict}\n`,
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
  opts?: { signal?: AbortSignal; deaths?: ProviderDeath[] },
) {
  const specsDir = join(".kiro", "specs", slug);
  const prdDir = join(repo, specsDir);
  mkdirSync(prdDir, { recursive: true });
  writeFileSync(
    join(prdDir, "prd.md"),
    `# ${slug}\n\n## Relevant Files\n- README.md\n`,
    "utf-8",
  );

  const records: string[] = [];
  const provider = buildStubProvider({
    fixtures,
    slices,
    deaths: opts?.deaths,
    records,
  });
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

  return { config, dag, logger, featBranch, provider, records };
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
 * Agent failure causes for the negotiate phase (issue #40, ADR 0025).
 *
 * The defect: a contract evaluator that died mid-tool-call failed its
 * slice with the fixed text "Negotiation returned ERROR" — no exit code,
 * no output, no way to tell "the agent provider hung up" from "the
 * evaluator returned a real verdict" — and got no retry, because
 * `--infrastructure-retries` covered only QA and the guardian reviews.
 * One such death ended a whole wave.
 *
 * Asserted through `runWave` outcomes and the typed event stream, never
 * through console prose.
 */
describe("runWave negotiate failure causes (issue #40)", () => {
  /** One independent slice whose contract evaluator is the thing that dies. */
  function oneSlice(
    slug: string,
    ghIssue: string,
    opts?: { deaths?: ProviderDeath[]; contractVerdict?: "ACCEPT" | "ESCALATE" },
  ) {
    const repo = makeRepo();
    const slices: Slice[] = [
      {
        number: "01",
        ghIssue,
        title: "Negotiator",
        type: "AFK",
        blockedBy: [],
        userStories: "",
      },
    ];
    const fixtures = new Map<string, SliceFixture>([
      [
        ghIssue,
        {
          files: ["src/n.txt"],
          qaPasses: true,
          outputFile: "src/n.txt",
          outputContent: "n",
          ...(opts?.contractVerdict
            ? { contractVerdict: opts.contractVerdict }
            : {}),
        },
      ],
    ]);
    const setup = setupWave(repo, slug, slices, fixtures, {
      ...(opts?.deaths ? { deaths: opts.deaths } : {}),
    });
    return { repo, slices, ...setup };
  }

  function dispatch(
    setup: ReturnType<typeof oneSlice>,
    readyIds: string[],
  ): Promise<Map<string, WaveOutcome>> {
    return runWave({
      waveNumber: 1,
      readyIds,
      config: setup.config,
      dag: setup.dag,
      logger: setup.logger,
      featBranch: setup.featBranch,
      relevantFilesBlock: "- README.md",
      testCommand: "pnpm test",
      mergeMutex: makeAsyncMutex(),
    }).then((r) => r.outcomes);
  }

  function reasonOf(outcome: WaveOutcome | undefined): string {
    return outcome && outcome.phase !== "PASS" ? outcome.error : "";
  }

  it("names the agent provider's exit code when a negotiate invocation exits non-zero", async () => {
    const setup = oneSlice("neg-exit", "1001", {
      deaths: [{ role: "evaluator-contract", kind: "exit", exitCode: 137 }],
    });
    setup.config.infrastructureRetries = 0;

    const outcomes = await dispatch(setup, ["1001"]);

    expect(outcomes.get("1001")?.phase).toBe("ERROR");
    const reason = reasonOf(outcomes.get("1001"));
    expect(reason).toContain("exit code 137");
    expect(reason).toContain("evaluator-contract");
    // The tail of the dead invocation's output rides along, so an
    // operator has a starting point without opening the agent log.
    expect(reason).toContain("last output:");
    expect(reason).toContain("about to die");
    // The retired fixed string must be gone.
    expect(reason).not.toContain("Negotiation returned ERROR");
  }, 30_000);

  it("names the kill class when the orchestrator killed the negotiate invocation", async () => {
    const cases: Array<[ProviderDeath["kind"], string, string]> = [
      ["idle-kill", "neg-idle", "idle timeout"],
      ["ceiling-kill", "neg-ceiling", "wall-clock ceiling"],
      ["tool-cap-kill", "neg-toolcap", "tool-call cap"],
    ];
    let ghIssue = 1100;
    for (const [kind, slug, label] of cases) {
      const id = String(ghIssue++);
      const setup = oneSlice(slug, id, {
        deaths: [{ role: "evaluator-contract", kind }],
      });
      setup.config.infrastructureRetries = 0;

      const outcomes = await dispatch(setup, [id]);

      expect(outcomes.get(id)?.phase, label).toBe("ERROR");
      const reason = reasonOf(outcomes.get(id));
      expect(reason, label).toContain(label);
      expect(reason, label).toContain("the orchestrator killed");
      // A kill is not an exit: the two causes must stay distinguishable.
      expect(reason, label).not.toContain("exit code");
    }
  }, 90_000);

  it("distinguishes an exhausted transient-provider retry from an exit and from a kill", async () => {
    const setup = oneSlice("neg-transient", "1201", {
      deaths: [{ role: "evaluator-contract", kind: "transient" }],
    });
    setup.config.infrastructureRetries = 0;
    // Window closed: the transient retry (ADR 0022) is already exhausted
    // by the time the negotiate phase sees the failure.
    setup.config.transientRetryWindowMs = 0;

    const outcomes = await dispatch(setup, ["1201"]);

    expect(outcomes.get("1201")?.phase).toBe("ERROR");
    const reason = reasonOf(outcomes.get("1201"));
    expect(reason).toContain("exhausted its transient-provider retry window");
    expect(reason).not.toContain("the orchestrator killed");
    expect(reason).not.toContain("hung up");
  }, 30_000);

  it("labels a genuine evaluator verdict as a verdict, never as an infrastructure death", async () => {
    const setup = oneSlice("neg-verdict", "1301", {
      contractVerdict: "ESCALATE",
    });

    const outcomes = await dispatch(setup, ["1301"]);

    expect(outcomes.get("1301")?.phase).toBe("ESCALATE");
    const reason = reasonOf(outcomes.get("1301"));
    expect(reason).toContain("evaluator verdict ESCALATE");
    expect(reason).toContain("not an infrastructure death");
    expect(reason).not.toContain("exit code");
    expect(reason).not.toContain("killed");
    expect(reason).not.toContain("transient");
  }, 30_000);

  it("retries an infrastructure death under --infrastructure-retries and the slice still passes", async () => {
    const setup = oneSlice("neg-retry", "1401", {
      // Dies on the first evaluator-contract invocation only.
      deaths: [{ role: "evaluator-contract", kind: "idle-kill", times: 1 }],
    });
    // Default is 2; state it so the test documents the bound it relies on.
    setup.config.infrastructureRetries = 2;

    const outcomes = await dispatch(setup, ["1401"]);

    // One dead evaluator no longer ends the slice — or the wave.
    expect(outcomes.get("1401")?.phase).toBe("PASS");

    // The retry is announced through the existing warn reason, naming
    // the negotiate stage — one reason code across all stages.
    const events = readRunEvents(setup.logger.runDir);
    const retries = (events?.events ?? []).filter(
      (e: RunEvent) => e.type === "warn" && e.reason === "infrastructure-retry",
    );
    expect(retries).toHaveLength(1);
    const [retry] = retries as Array<Extract<RunEvent, { type: "warn" }>>;
    expect(retry!.ghIssue).toBe("1401");
    expect(retry!.message).toContain("negotiate infrastructure retry 1/2");
    expect(retry!.message).toContain("idle timeout");

    // The retry repeats only the failed evaluator invocation with the
    // same round. Explorer context and the planner's contract survive.
    expect(setup.records.filter((r) => r === "explorer:1401")).toHaveLength(1);
    expect(setup.records.filter((r) => r === "planner:1401")).toHaveLength(1);
    expect(
      setup.records.filter((r) => r === "evaluator-contract:1401"),
    ).toHaveLength(2);
    const plannerRounds = (events?.events ?? [])
      .filter(
        (e: RunEvent) =>
          e.type === "phase-started" &&
          e.agent === "planner" &&
          e.ghIssue === "1401",
      )
      .map((e) => (e as Extract<RunEvent, { type: "phase-started" }>).round);
    expect(plannerRounds).toEqual([1]);
  }, 60_000);

  it.each(["explorer", "planner"] as const)(
    "retries only the failed %s invocation with the same prompt",
    async (role) => {
      const setup = oneSlice(`neg-retry-${role}`, role === "explorer" ? "1451" : "1452", {
        deaths: [{ role, kind: "exit", exitCode: 9, times: 1 }],
      });
      setup.config.infrastructureRetries = 1;
      const prompts: string[] = [];
      const inner = setup.config.provider!;
      setup.config.provider = {
        name: inner.name,
        invoke(options) {
          if (options.role === role) prompts.push(options.prompt);
          return inner.invoke(options);
        },
      };

      const id = role === "explorer" ? "1451" : "1452";
      const outcomes = await dispatch(setup, [id]);

      expect(outcomes.get(id)?.phase).toBe("PASS");
      expect(setup.records.filter((record) => record === `${role}:${id}`)).toHaveLength(2);
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toBe(prompts[0]);
      expect(
        setup.records.filter((record) => record === `explorer:${id}`),
      ).toHaveLength(role === "explorer" ? 2 : 1);
      expect(
        setup.records.filter((record) => record === `planner:${id}`),
      ).toHaveLength(role === "planner" ? 2 : 1);
      expect(
        setup.records.filter((record) => record === `evaluator-contract:${id}`),
      ).toHaveLength(1);
    },
    60_000,
  );

  it("does not retry cancellation or consume the infrastructure budget", async () => {
    const setup = oneSlice("neg-cancel", "1491");
    const controller = new AbortController();
    setup.config.signal = controller.signal;
    setup.config.infrastructureRetries = 2;
    const inner = setup.config.provider!;
    setup.config.provider = {
      name: inner.name,
      async invoke(options) {
        if (options.role === "planner") {
          controller.abort();
          throw new CancelledError();
        }
        return inner.invoke(options);
      },
    };

    const outcomes = await dispatch(setup, ["1491"]);

    expect(outcomes.get("1491")?.phase).toBe("CANCELLED");
    expect(setup.records.filter((record) => record === "planner:1491")).toEqual([]);
    const retries = (readRunEvents(setup.logger.runDir)?.events ?? []).filter(
      (event) => event.type === "warn" && event.reason === "infrastructure-retry",
    );
    expect(retries).toEqual([]);
  }, 30_000);

  it("never retries a genuine verdict — it is terminal on the first occurrence", async () => {
    const setup = oneSlice("neg-verdict-terminal", "1501", {
      contractVerdict: "ESCALATE",
    });
    setup.config.infrastructureRetries = 2;

    const outcomes = await dispatch(setup, ["1501"]);

    expect(outcomes.get("1501")?.phase).toBe("ESCALATE");
    // One negotiate attempt only: a real escalation must not burn the
    // infrastructure-retries budget.
    expect(setup.records.filter((r) => r === "explorer:1501")).toHaveLength(1);
    expect(setup.records.filter((r) => r === "planner:1501")).toHaveLength(1);
    const events = readRunEvents(setup.logger.runDir);
    expect(
      (events?.events ?? []).filter(
        (e: RunEvent) => e.type === "warn" && e.reason === "infrastructure-retry",
      ),
    ).toHaveLength(0);
  }, 30_000);

  it("gives up with the cause named once the retry budget is spent", async () => {
    const setup = oneSlice("neg-retry-spent", "1601", {
      deaths: [{ role: "evaluator-contract", kind: "exit", exitCode: 2 }],
    });
    setup.config.infrastructureRetries = 1;

    const outcomes = await dispatch(setup, ["1601"]);

    expect(outcomes.get("1601")?.phase).toBe("ERROR");
    expect(reasonOf(outcomes.get("1601"))).toContain("exit code 2");
    // 1 initial attempt + 1 retry, then terminal.
    expect(
      setup.records.filter((r) => r === "evaluator-contract:1601"),
    ).toHaveLength(2);
  }, 60_000);

  it("keeps a dead negotiate invocation from ending the wave — the sibling slice still passes", async () => {
    const repo = makeRepo();
    const slices: Slice[] = [
      {
        number: "01",
        ghIssue: "1701",
        title: "Doomed negotiator",
        type: "AFK",
        blockedBy: [],
        userStories: "",
      },
      {
        number: "02",
        ghIssue: "1702",
        title: "Healthy sibling",
        type: "AFK",
        blockedBy: [],
        userStories: "",
      },
    ];
    const fixtures = new Map<string, SliceFixture>([
      ["1701", { files: ["src/p.txt"], qaPasses: true, outputFile: "src/p.txt", outputContent: "p" }],
      ["1702", { files: ["src/q.txt"], qaPasses: true, outputFile: "src/q.txt", outputContent: "q" }],
    ]);
    const setup = setupWave(repo, "neg-wave-survives", slices, fixtures);
    // `deaths` is keyed by role, so wrap the stub to kill only 1701's
    // evaluator and leave the sibling negotiating normally.
    const inner = setup.config.provider!;
    setup.config.provider = {
      name: "stub",
      async invoke(options: InvokeOptions): Promise<InvokeResult> {
        if (
          options.role === "evaluator-contract" &&
          options.cwd.includes("-s01")
        ) {
          options.logStream?.write("stub evaluator-contract output\n");
          throw new Error("Agent evaluator-contract exited with code 1");
        }
        return inner.invoke(options);
      },
    };
    setup.config.infrastructureRetries = 0;

    const { outcomes } = await runWave({
      waveNumber: 1,
      readyIds: ["1701", "1702"],
      config: setup.config,
      dag: setup.dag,
      logger: setup.logger,
      featBranch: setup.featBranch,
      relevantFilesBlock: "- README.md",
      testCommand: "pnpm test",
      mergeMutex: makeAsyncMutex(),
    });

    expect(outcomes.get("1701")?.phase).toBe("ERROR");
    expect(reasonOf(outcomes.get("1701"))).toContain("exit code 1");
    expect(outcomes.get("1702")?.phase).toBe("PASS");
  }, 60_000);
});

/**
 * Migrations as a lane-shared resource (ADR 0027). Two slices that each
 * declare their own migration file share no path, so they used to run
 * concurrently from an identical base, compute the same "next free
 * prefix", and collide hours later at the merge mutex. They must now
 * land in one lane, which serialises them and gives the successor a
 * base that already contains its predecessor's merged migration.
 */
describe("runWave — migration lane grouping", () => {
  function readEvents(runDir: string): Array<Record<string, unknown>> {
    const raw = readFileSync(join(runDir, "events.jsonl"), "utf-8");
    return raw
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  it("serialises two migration-bearing slices and re-negotiates the successor on the merged base", async () => {
    const repo = makeRepo();
    const slices: Slice[] = [
      { number: "01", ghIssue: "1001", title: "First migration", type: "AFK", blockedBy: [], userStories: "" },
      { number: "02", ghIssue: "1002", title: "Second migration", type: "AFK", blockedBy: [], userStories: "" },
    ];
    // Deliberately different directories: the grouping is driven by the
    // `migrations` segment, not by one project's layout, and the two
    // slices share no declared path.
    const first = "supabase/migrations/20240101000000_first.sql";
    const second = "db/migrations/20240202000000_second.sql";
    const fixtures = new Map<string, SliceFixture>([
      ["1001", { files: [first], qaPasses: true, outputFile: first, outputContent: "-- first" }],
      ["1002", { files: [second], qaPasses: true, outputFile: second, outputContent: "-- second" }],
    ]);
    const { config, dag, logger, featBranch, provider } = setupWave(
      repo,
      "wave-migrations",
      slices,
      fixtures,
    );

    // Record, for each invocation, whether the predecessor's migration
    // was already visible in the invoking worktree.
    const events: string[] = [];
    const predecessorVisible: boolean[] = [];
    config.provider = {
      name: "stub",
      async invoke(options: InvokeOptions): Promise<InvokeResult> {
        const slice = sliceFromCwd(options.cwd, slices);
        events.push(`invoke:${options.role}:${slice?.ghIssue ?? "?"}`);
        if (slice?.ghIssue === "1002" && options.role === "explorer") {
          predecessorVisible.push(existsSync(join(options.cwd, first)));
        }
        return provider.invoke(options);
      },
    };

    const { outcomes } = await runWave({
      waveNumber: 1,
      readyIds: ["1001", "1002"],
      config,
      dag,
      logger,
      featBranch,
      relevantFilesBlock: "- README.md",
      testCommand: "pnpm test",
      mergeMutex: makeAsyncMutex(),
      onOutcome: (id, outcome) => events.push(`outcome:${outcome.phase}:${id}`),
    });

    expect(outcomes.get("1001")?.phase).toBe("PASS");
    expect(outcomes.get("1002")?.phase).toBe("PASS");

    // One lane, and the structured event says so.
    const partitioned = readEvents(logger.runDir).find(
      (e) => e.type === "lanes-partitioned",
    );
    expect(partitioned?.lanes).toEqual([["1001", "1002"]]);
    expect(partitioned?.sharedResources).toEqual({
      migrations: ["1001", "1002"],
    });

    // Serialised: 1002's lane-successor re-negotiation (its second
    // explorer) starts only after 1001's PASS is reported.
    const passIdx = events.indexOf("outcome:PASS:1001");
    const explorers = events
      .map((e, i) => (e === "invoke:explorer:1002" ? i : -1))
      .filter((i) => i >= 0);
    expect(explorers.length).toBeGreaterThanOrEqual(2);
    expect(passIdx).toBeGreaterThanOrEqual(0);
    expect(passIdx).toBeLessThan(explorers[1]!);

    // The successor re-negotiated against a base that already contained
    // the predecessor's migration — the whole point of the grouping.
    expect(predecessorVisible[0]).toBe(false); // wave-start base
    expect(predecessorVisible[1]).toBe(true); // refreshed base
  }, 60_000);

  it("leaves non-migration slices in their own parallel lanes", async () => {
    const repo = makeRepo();
    const slices: Slice[] = [
      { number: "01", ghIssue: "1011", title: "Migration", type: "AFK", blockedBy: [], userStories: "" },
      { number: "02", ghIssue: "1012", title: "No migration", type: "AFK", blockedBy: [], userStories: "" },
    ];
    const migration = "supabase/migrations/20240101000000_only.sql";
    const fixtures = new Map<string, SliceFixture>([
      ["1011", { files: [migration], qaPasses: true, outputFile: migration, outputContent: "-- only" }],
      ["1012", { files: ["src/app.ts"], qaPasses: true, outputFile: "src/app.ts", outputContent: "app" }],
    ]);
    const { config, dag, logger, featBranch } = setupWave(
      repo,
      "wave-migrations-mixed",
      slices,
      fixtures,
    );

    const { outcomes } = await runWave({
      waveNumber: 1,
      readyIds: ["1011", "1012"],
      config,
      dag,
      logger,
      featBranch,
      relevantFilesBlock: "- README.md",
      testCommand: "pnpm test",
      mergeMutex: makeAsyncMutex(),
    });

    expect(outcomes.get("1011")?.phase).toBe("PASS");
    expect(outcomes.get("1012")?.phase).toBe("PASS");

    const partitioned = readEvents(logger.runDir).find(
      (e) => e.type === "lanes-partitioned",
    );
    expect(partitioned?.lanes).toEqual([["1011"], ["1012"]]);
    // A lone migration slice is contending with nobody, so the event
    // carries no shared-resource grouping.
    expect(partitioned?.sharedResources).toBeUndefined();
  }, 60_000);

  it("honours a configured pattern instead of the default", async () => {
    const repo = makeRepo();
    const slices: Slice[] = [
      { number: "01", ghIssue: "1021", title: "Changeset one", type: "AFK", blockedBy: [], userStories: "" },
      { number: "02", ghIssue: "1022", title: "Changeset two", type: "AFK", blockedBy: [], userStories: "" },
    ];
    const one = "db/changesets/001_one.xml";
    const two = "db/changesets/002_two.xml";
    const fixtures = new Map<string, SliceFixture>([
      ["1021", { files: [one], qaPasses: true, outputFile: one, outputContent: "<one/>" }],
      ["1022", { files: [two], qaPasses: true, outputFile: two, outputContent: "<two/>" }],
    ]);
    const { config, dag, logger, featBranch } = setupWave(
      repo,
      "wave-migrations-configured",
      slices,
      fixtures,
    );
    config.migrationPathPattern = /(^|\/)changesets\/.*\.xml$/;

    const { outcomes } = await runWave({
      waveNumber: 1,
      readyIds: ["1021", "1022"],
      config,
      dag,
      logger,
      featBranch,
      relevantFilesBlock: "- README.md",
      testCommand: "pnpm test",
      mergeMutex: makeAsyncMutex(),
    });

    expect(outcomes.get("1021")?.phase).toBe("PASS");
    expect(outcomes.get("1022")?.phase).toBe("PASS");
    const partitioned = readEvents(logger.runDir).find(
      (e) => e.type === "lanes-partitioned",
    );
    expect(partitioned?.lanes).toEqual([["1021", "1022"]]);
  }, 60_000);

  it("still collapses the whole wave under --serial-lanes", async () => {
    const repo = makeRepo();
    const slices: Slice[] = [
      { number: "01", ghIssue: "1031", title: "Migration", type: "AFK", blockedBy: [], userStories: "" },
      { number: "02", ghIssue: "1032", title: "Unrelated", type: "AFK", blockedBy: [], userStories: "" },
    ];
    const migration = "supabase/migrations/20240101000000_serial.sql";
    const fixtures = new Map<string, SliceFixture>([
      ["1031", { files: [migration], qaPasses: true, outputFile: migration, outputContent: "-- serial" }],
      ["1032", { files: ["src/unrelated.ts"], qaPasses: true, outputFile: "src/unrelated.ts", outputContent: "u" }],
    ]);
    const { config, dag, logger, featBranch } = setupWave(
      repo,
      "wave-migrations-serial",
      slices,
      fixtures,
    );
    config.serialLanes = true;

    const { outcomes } = await runWave({
      waveNumber: 1,
      readyIds: ["1031", "1032"],
      config,
      dag,
      logger,
      featBranch,
      relevantFilesBlock: "- README.md",
      testCommand: "pnpm test",
      mergeMutex: makeAsyncMutex(),
    });

    expect(outcomes.get("1031")?.phase).toBe("PASS");
    expect(outcomes.get("1032")?.phase).toBe("PASS");
    const partitioned = readEvents(logger.runDir).find(
      (e) => e.type === "lanes-partitioned",
    );
    expect(partitioned?.lanes).toEqual([["1031", "1032"]]);
    expect(partitioned?.serial).toBe(true);
  }, 60_000);
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
 * The contract-lock migration prefix gate (ADR 0028).
 *
 * The contract names its migration file at lock time. When that
 * filename's prefix already exists on the feature branch under another
 * name, the merge mutex refuses the merge — in the PRD 076 session, four
 * hours and seven commits later. The wave inspects each contract the
 * moment it locks and sends a colliding one straight back to the
 * planner, which costs one contract round and no generation at all.
 */
describe("runWave — contract-lock migration prefix gate", () => {
  function readEvents(runDir: string): Array<Record<string, unknown>> {
    const raw = readFileSync(join(runDir, "events.jsonl"), "utf-8");
    return raw
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  /**
   * Commit the given repo-relative files onto the feature branch, without
   * disturbing HEAD. Each path is staged by name — `add -A` here would
   * sweep the run's untracked `.afk/logs` and `.kiro/specs` onto the
   * branch, and checking HEAD back out would then delete them mid-run.
   */
  function commitToFeatBranch(
    repo: string,
    featBranch: string,
    files: Record<string, string>,
  ) {
    const head = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
    git(repo, ["checkout", featBranch]);
    for (const [relPath, content] of Object.entries(files)) {
      const abs = join(repo, relPath);
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, content, "utf-8");
      git(repo, ["add", "--", relPath]);
    }
    git(repo, ["commit", "-m", `add ${Object.keys(files).join(", ")}`]);
    git(repo, ["checkout", head]);
  }

  function addMigrationToFeatBranch(
    repo: string,
    featBranch: string,
    relPath: string,
  ) {
    commitToFeatBranch(repo, featBranch, { [relPath]: "-- existing\n" });
  }

  /**
   * Provider whose planner declares — and whose generator writes — a
   * migration path chosen per planner round, so a test can make the
   * planner obey the gate's objection or ignore it.
   */
  function buildPlannerProvider(opts: {
    slices: Slice[];
    /** Migration path this slice's planner declares on the given round. */
    pathForRound: (ghIssue: string, round: number) => string;
    /** Overrides what the generator writes; defaults to the declared path. */
    generatorPath?: (ghIssue: string) => string;
    /** Every planner prompt, in invocation order. */
    plannerPrompts?: string[];
  }): AgentProvider {
    const { slices, pathForRound, generatorPath, plannerPrompts } = opts;
    const plannerRounds = new Map<string, number>();
    const declaredNow = new Map<string, string>();

    return {
      name: "stub",
      async invoke(options: InvokeOptions): Promise<InvokeResult> {
        const { role, cwd, prompt } = options;
        const slice = sliceFromCwd(cwd, slices);
        const ghIssue = slice?.ghIssue ?? "";
        const dir = slice ? findSliceArtifactDir(cwd, slice.number) : null;
        await new Promise((r) => setTimeout(r, 5));

        if (role === "explorer" && dir) {
          writeFileSync(join(dir, "context.md"), "# Context\n", "utf-8");
        } else if (role === "planner" && dir) {
          const round = (plannerRounds.get(ghIssue) ?? 0) + 1;
          plannerRounds.set(ghIssue, round);
          plannerPrompts?.push(prompt);
          const path = pathForRound(ghIssue, round);
          declaredNow.set(ghIssue, path);
          writeFileSync(
            join(dir, "contract.md"),
            `# Slice Contract\n\n**Status:** NEGOTIATING\n\n## Files expected to change\n- ${path}\n`,
            "utf-8",
          );
        } else if (role === "evaluator-contract" && dir) {
          // Always ACCEPT. The evaluator has no idea what is on the
          // feature branch, which is exactly why the gate has to exist.
          const round = plannerRounds.get(ghIssue) ?? 1;
          writeFileSync(
            join(dir, `feedback-r${round}.md`),
            `## Evaluator feedback — round ${round}\n\n**Verdict:** ACCEPT\n\nGAPS: 0\nRE_RAISED_GAPS: 0\n`,
            "utf-8",
          );
        } else if (role === "generator" && dir) {
          const path =
            generatorPath?.(ghIssue) ?? declaredNow.get(ghIssue) ?? "src/x.txt";
          const abs = join(cwd, path);
          mkdirSync(join(abs, ".."), { recursive: true });
          writeFileSync(abs, `-- ${ghIssue}\n`, "utf-8");
        } else if (role === "evaluator-qa" && dir) {
          writeFileSync(
            join(dir, "qa-report.md"),
            "# QA Report\n\n**Verdict:** PASS\n",
            "utf-8",
          );
        }

        return { exitCode: 0, stdout: "", stats: {} };
      },
    };
  }

  it("sends a colliding contract back to the planner with the free prefix, then passes", async () => {
    const repo = makeRepo();
    const slices: Slice[] = [
      { number: "01", ghIssue: "2001", title: "Adds a migration", type: "AFK", blockedBy: [], userStories: "" },
    ];
    const { config, dag, logger, featBranch } = setupWave(
      repo,
      "wave-gate-collision",
      slices,
      new Map<string, SliceFixture>(),
    );
    // The feature branch already owns prefix 003 under another name.
    addMigrationToFeatBranch(
      repo,
      featBranch,
      "supabase/migrations/003_users.sql",
    );

    const plannerPrompts: string[] = [];
    config.provider = buildPlannerProvider({
      slices,
      plannerPrompts,
      // Round 1 collides on 003; the planner then obeys the objection.
      pathForRound: (_id, round) =>
        round === 1
          ? "supabase/migrations/003_orders.sql"
          : "supabase/migrations/004_orders.sql",
    });

    const { outcomes } = await runWave({
      waveNumber: 1,
      readyIds: ["2001"],
      config,
      dag,
      logger,
      featBranch,
      relevantFilesBlock: "- README.md",
      testCommand: "pnpm test",
      mergeMutex: makeAsyncMutex(),
    });

    // The renumbered slice merged normally: one contract round bought
    // the correction and no generation was wasted.
    expect(outcomes.get("2001")?.phase).toBe("PASS");

    // The gate refused round 1, so the planner ran again.
    expect(plannerPrompts).toHaveLength(2);
    // The second prompt named the colliding prefix and the next free
    // one — a mechanical correction rather than a puzzle.
    expect(plannerPrompts[1]).toContain("003");
    expect(plannerPrompts[1]).toContain("004");
    expect(plannerPrompts[1]).toMatch(/REJECTED by the/i);

    // Observable in the event stream, under one warn reason.
    const refusals = readEvents(logger.runDir).filter(
      (e) => e.type === "warn" && e.reason === "contract-lock-refused",
    );
    expect(refusals).toHaveLength(1);
    expect(refusals[0]!.ghIssue).toBe("2001");
    expect(String(refusals[0]!.message)).toContain("004");

    // The renumbered migration is what landed on the feature branch.
    git(repo, ["checkout", featBranch]);
    expect(
      existsSync(join(repo, "supabase", "migrations", "004_orders.sql")),
    ).toBe(true);
    expect(
      existsSync(join(repo, "supabase", "migrations", "003_orders.sql")),
    ).toBe(false);
  }, 60_000);

  it("does not flag a contract re-touching a migration it already owns", async () => {
    const repo = makeRepo();
    const slices: Slice[] = [
      { number: "01", ghIssue: "2011", title: "Edits its own migration", type: "AFK", blockedBy: [], userStories: "" },
    ];
    const { config, dag, logger, featBranch } = setupWave(
      repo,
      "wave-gate-same-file",
      slices,
      new Map<string, SliceFixture>(),
    );
    const owned = "supabase/migrations/003_users.sql";
    addMigrationToFeatBranch(repo, featBranch, owned);

    const plannerPrompts: string[] = [];
    config.provider = buildPlannerProvider({
      slices,
      plannerPrompts,
      // Same prefix and same filename: the slice is editing the
      // migration already there, which collides with nothing.
      pathForRound: () => owned,
    });

    const { outcomes } = await runWave({
      waveNumber: 1,
      readyIds: ["2011"],
      config,
      dag,
      logger,
      featBranch,
      relevantFilesBlock: "- README.md",
      testCommand: "pnpm test",
      mergeMutex: makeAsyncMutex(),
    });

    expect(outcomes.get("2011")?.phase).toBe("PASS");
    // One planner round: the gate never fired.
    expect(plannerPrompts).toHaveLength(1);
    expect(
      readEvents(logger.runDir).filter(
        (e) => e.type === "warn" && e.reason === "contract-lock-refused",
      ),
    ).toEqual([]);
  }, 60_000);

  it("leaves a slice declaring no migration files alone", async () => {
    const repo = makeRepo();
    const slices: Slice[] = [
      { number: "01", ghIssue: "2021", title: "No migrations", type: "AFK", blockedBy: [], userStories: "" },
    ];
    const { config, dag, logger, featBranch } = setupWave(
      repo,
      "wave-gate-no-migrations",
      slices,
      new Map<string, SliceFixture>(),
    );
    // A migration exists on the tip; this slice just does not declare one.
    addMigrationToFeatBranch(
      repo,
      featBranch,
      "supabase/migrations/003_users.sql",
    );

    const plannerPrompts: string[] = [];
    config.provider = buildPlannerProvider({
      slices,
      plannerPrompts,
      pathForRound: () => "src/app.ts",
    });

    const { outcomes } = await runWave({
      waveNumber: 1,
      readyIds: ["2021"],
      config,
      dag,
      logger,
      featBranch,
      relevantFilesBlock: "- README.md",
      testCommand: "pnpm test",
      mergeMutex: makeAsyncMutex(),
    });

    expect(outcomes.get("2021")?.phase).toBe("PASS");
    expect(plannerPrompts).toHaveLength(1);
  }, 60_000);

  it("escalates when the contract rounds run out on an unresolved collision", async () => {
    const repo = makeRepo();
    const slices: Slice[] = [
      { number: "01", ghIssue: "2031", title: "Will not renumber", type: "AFK", blockedBy: [], userStories: "" },
    ];
    const { config, dag, logger, featBranch } = setupWave(
      repo,
      "wave-gate-escalate",
      slices,
      new Map<string, SliceFixture>(),
    );
    addMigrationToFeatBranch(
      repo,
      featBranch,
      "supabase/migrations/003_users.sql",
    );
    config.maxContractRounds = 2;

    const plannerPrompts: string[] = [];
    config.provider = buildPlannerProvider({
      slices,
      plannerPrompts,
      // The planner never takes the correction.
      pathForRound: () => "supabase/migrations/003_orders.sql",
    });

    const { outcomes } = await runWave({
      waveNumber: 1,
      readyIds: ["2031"],
      config,
      dag,
      logger,
      featBranch,
      relevantFilesBlock: "- README.md",
      testCommand: "pnpm test",
      mergeMutex: makeAsyncMutex(),
    });

    // Escalation through the ordinary unresolvable-contract path, not a
    // new outcome: a gate refusal spends rounds like any other revision,
    // and earns no cap extension for a correction it declined twice.
    expect(outcomes.get("2031")?.phase).toBe("ESCALATE");
    expect(plannerPrompts).toHaveLength(2);
    // Nothing was generated: the slice never reached Phase B.
    expect(
      existsSync(join(repo, "supabase", "migrations", "003_orders.sql")),
    ).toBe(false);

    // The escalated slice says why. Without the objection in stuck.md the
    // operator sees a contract that the evaluator ACCEPTed twice and no
    // trace of what refused it.
    const stuck = readFileSync(
      join(repo, ".afk", "artifacts", "wave-gate-escalate-stub", "slice-01", "stuck.md"),
      "utf-8",
    );
    expect(stuck).toContain("contract-lock gate");
    expect(stuck).toContain("003");
    expect(stuck).toContain("004");
  }, 60_000);

  it("still refuses at the merge mutex when the generator collides but the contract did not", async () => {
    const repo = makeRepo();
    const slices: Slice[] = [
      { number: "01", ghIssue: "2041", title: "Generator went off-contract", type: "AFK", blockedBy: [], userStories: "" },
    ];
    const { config, dag, logger, featBranch } = setupWave(
      repo,
      "wave-gate-merge-authority",
      slices,
      new Map<string, SliceFixture>(),
    );
    addMigrationToFeatBranch(
      repo,
      featBranch,
      "supabase/migrations/003_users.sql",
    );

    const plannerPrompts: string[] = [];
    config.provider = buildPlannerProvider({
      slices,
      plannerPrompts,
      // The contract is clean, so the contract-lock gate has nothing to say.
      pathForRound: () => "supabase/migrations/004_orders.sql",
      // The generator writes a colliding file anyway. Only a check
      // atomic with the merge can catch that, which is why the
      // merge-mutex check stays exactly where it is.
      generatorPath: () => "supabase/migrations/003_orders.sql",
    });

    const { outcomes } = await runWave({
      waveNumber: 1,
      readyIds: ["2041"],
      config,
      dag,
      logger,
      featBranch,
      relevantFilesBlock: "- README.md",
      testCommand: "pnpm test",
      mergeMutex: makeAsyncMutex(),
    });

    expect(plannerPrompts).toHaveLength(1);
    const outcome = outcomes.get("2041");
    expect(outcome?.phase).toBe("MERGE-PENDING");
    if (outcome?.phase === "MERGE-PENDING") {
      expect(outcome.collidingPrefixes).toEqual(["003"]);
      expect(outcome.error).toMatch(/Migration prefix collision: 003/);
    }
  }, 60_000);

  it("gates a contract left LOCKED on disk by an earlier run", async () => {
    const repo = makeRepo();
    const slices: Slice[] = [
      { number: "01", ghIssue: "2051", title: "Preseeded contract", type: "AFK", blockedBy: [], userStories: "" },
    ];
    const slug = "wave-gate-prior-lock";
    const { config, dag, logger, featBranch } = setupWave(
      repo,
      slug,
      slices,
      new Map<string, SliceFixture>(),
    );

    // A LOCKED contract naming prefix 003, plus the 003 the feature
    // branch already owns. Committing the contract onto the feature
    // branch is how it reaches the slice worktree: the worktree is cut
    // from that branch, so negotiation starts with the contract already
    // on disk — exactly the state an interrupted earlier run leaves.
    const sliceDir = `.kiro/specs/${slug}/slices/01-preseeded-contract`;
    commitToFeatBranch(repo, featBranch, {
      "supabase/migrations/003_users.sql": "-- existing\n",
      [`${sliceDir}/contract.md`]:
        "# Slice Contract\n\n**Status:** LOCKED\n\n## Files expected to change\n- supabase/migrations/003_orders.sql\n",
    });

    const plannerPrompts: string[] = [];
    config.provider = buildPlannerProvider({
      slices,
      plannerPrompts,
      pathForRound: () => "supabase/migrations/004_orders.sql",
    });

    const { outcomes } = await runWave({
      waveNumber: 1,
      readyIds: ["2051"],
      config,
      dag,
      logger,
      featBranch,
      relevantFilesBlock: "- README.md",
      testCommand: "pnpm test",
      mergeMutex: makeAsyncMutex(),
    });

    expect(outcomes.get("2051")?.phase).toBe("PASS");

    // The whole point: negotiation would otherwise have skipped the
    // planner entirely and carried the stale colliding contract into
    // generation. The gate reopened it, so the planner ran once.
    expect(plannerPrompts).toHaveLength(1);
    expect(plannerPrompts[0]).toMatch(/REJECTED by the/i);

    // Announced as a refusal by a previous run's lock, not by a round
    // this run never ran.
    const refusals = readEvents(logger.runDir).filter(
      (e) => e.type === "warn" && e.reason === "contract-lock-refused",
    );
    expect(refusals).toHaveLength(1);

    // The renumbered migration is what landed; the stale one never existed.
    git(repo, ["checkout", featBranch]);
    expect(
      existsSync(join(repo, "supabase", "migrations", "004_orders.sql")),
    ).toBe(true);
    expect(
      existsSync(join(repo, "supabase", "migrations", "003_orders.sql")),
    ).toBe(false);
  }, 60_000);
});

/**
 * Deferred merge (ADR 0029). The merge-mutex migration-prefix check is
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
        files: ["supabase/migrations/043_orders.sql"],
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
        files: ["src/lane.txt", "supabase/migrations/043_orders.sql"],
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

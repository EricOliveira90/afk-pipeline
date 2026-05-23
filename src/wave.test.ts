import { describe, it, expect, afterEach } from "vitest";
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
import { runWave, type SliceOutcome } from "./wave.js";
import { makeAsyncMutex } from "./orchestrator.js";
import { buildDAG, type Slice } from "./issues-parser.js";
import { Logger } from "./logger.js";
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
        const path = join(sliceArtifactDir, "contract.md");
        const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
        writeFileSync(path, existing + "\n\n**Verdict:** ACCEPT\n", "utf-8");
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

    expect(outcomes.get("100")).toBe("PASS");
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

    expect(outcomes.get("200")).toBe("STUCK");
  }, 30_000);

  it("lane-cancels successors when predecessor fails", async () => {
    const repo = makeRepo();
    const slices: Slice[] = [
      { number: "01", ghIssue: "301", title: "First", type: "AFK", blockedBy: [], userStories: "" },
      { number: "02", ghIssue: "302", title: "Second", type: "AFK", blockedBy: [], userStories: "" },
    ];
    const fixtures = new Map<string, SliceFixture>([
      ["301", { files: ["src/shared.txt"], qaPasses: false, outputFile: "src/shared.txt", outputContent: "fail" }],
      ["302", { files: ["src/shared.txt"], qaPasses: true, outputFile: "src/shared.txt", outputContent: "ok" }],
    ]);
    const { config, dag, logger, featBranch } = setupWave(repo, "wave-cancel", slices, fixtures);

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

    expect(outcomes.get("301")).toBe("STUCK");
    expect(outcomes.get("302")).toBe("LANE-CANCELLED");
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

    expect(outcomes.get("401")).toBe("PASS");
    expect(outcomes.get("402")).toBe("PASS");
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
    expect(outcomes.get("501")).toBe("CANCELLED");
    expect(outcomes.get("502")).toBe("CANCELLED");
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
          const path = join(sliceArtifactDir, "contract.md");
          const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
          writeFileSync(path, existing + "\n\n**Verdict:** ACCEPT\n", "utf-8");
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
    expect(outcomes.get("601")).toBe("PASS");
    expect(outcomes.get("602")).toBe("PASS");
  }, 60_000);
});

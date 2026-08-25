import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import {
  execFileSync,
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDAG, type Slice } from "./issues-parser.js";
import { lifecycle } from "./slice-lifecycle.js";
import { RunJournal as Logger } from "./run-journal.js";
import {
  makeSliceContext,
  runQAStage,
  runSliceExecute,
  type PipelineConfig,
  type SliceContext,
} from "./orchestrator.js";
import type { AgentProvider, InvokeOptions, InvokeResult } from "./agent-provider.js";
import { rmDirWithRetry } from "./test-support.js";

const dirs: string[] = [];
const fixtureChildren = new Set<ChildProcess>();

beforeEach(() => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await terminateFixtureChildren();
  for (const dir of dirs.splice(0)) {
    rmDirWithRetry(dir);
  }
});

function spawnFixtureChild(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): ChildProcess {
  const child = spawn(command, args, options);
  fixtureChildren.add(child);
  child.once("close", () => fixtureChildren.delete(child));
  return child;
}

async function terminateFixtureChildren(): Promise<void> {
  await Promise.all(
    [...fixtureChildren].map(
      (child) =>
        new Promise<void>((resolve, reject) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          child.once("close", () => resolve());
          child.once("error", reject);
          child.kill();
        }),
    ),
  );
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "afk-qa-070-"));
  dirs.push(repo);
  git(repo, ["init", "--initial-branch=main"]);
  const hooksDir = join(repo, ".git", "test-hooks");
  mkdirSync(hooksDir);
  git(repo, ["config", "core.hooksPath", hooksDir]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  writeFileSync(join(repo, "README.md"), "fixture\n", "utf-8");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "root"]);
  return repo;
}

function makeContext(
  repo: string,
  provider: AgentProvider,
  configOverrides: Partial<PipelineConfig> = {},
): SliceContext {
  const slice: Slice = {
    number: "01",
    ghIssue: "70",
    title: "PRD 070 regression",
    type: "AFK",
    blockedBy: [],
    userStories: "",
  };
  const absSliceDir = join(repo, "specs", "slices", "01-prd-070-regression");
  mkdirSync(absSliceDir, { recursive: true });
  const config: PipelineConfig = {
    repoRoot: repo,
    prdSlug: "prd-070",
    prdDir: join(repo, "specs"),
    specsDir: "specs",
    dag: buildDAG([slice]),
    provider,
    commandTimeoutMs: 2_000,
    heartbeatIntervalMs: 20,
    ...configOverrides,
  };
  const logger = new Logger(repo, "prd-070-test");
  logger.trackSlice(
    lifecycle.running(
      { ghIssue: slice.ghIssue, title: slice.title, branch: "main" },
      { genRounds: 0, evalRounds: 0 },
    ),
  );
  return {
    config,
    slice,
    logger,
    featBranch: "main",
    relevantFilesBlock: "- README.md",
    siblingHandoffsBlock: "(none)",
    branch: "main",
    worktreeDir: repo,
    absSliceDir,
    relSliceDir: "specs/slices/01-prd-070-regression",
    relSpecsDir: "specs",
    tag: "[afk] Slice #70",
    testCommand: "pnpm test",
    sanityCommandsBlock: "(none)",
    invoke: (options) => provider.invoke(options),
  };
}

describe("temporary repository isolation", () => {
  it("does not run machine-global Git hooks", () => {
    const hookRoot = mkdtempSync(join(tmpdir(), "afk-global-hook-"));
    dirs.push(hookRoot);
    const hooksDir = join(hookRoot, "hooks");
    const markerPath = join(hookRoot, "hook-ran.txt");
    const globalConfigPath = join(hookRoot, "gitconfig");
    mkdirSync(hooksDir);
    const hookPath = join(hooksDir, "post-commit");
    writeFileSync(
      hookPath,
      `#!/bin/sh\nprintf hook-ran > "${markerPath.replace(/\\/g, "/")}"\n`,
      "utf-8",
    );
    chmodSync(hookPath, 0o755);
    execFileSync(
      "git",
      [
        "config",
        "--file",
        globalConfigPath,
        "core.hooksPath",
        hooksDir,
      ],
      { stdio: "ignore" },
    );

    const previousGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = globalConfigPath;
    try {
      makeRepo();
    } finally {
      if (previousGlobalConfig == null) {
        delete process.env.GIT_CONFIG_GLOBAL;
      } else {
        process.env.GIT_CONFIG_GLOBAL = previousGlobalConfig;
      }
    }

    expect(existsSync(markerPath)).toBe(false);
  });
});

describe("PRD 070 QA retry behavior", { timeout: 60_000 }, () => {
  it("does not treat the inactivity timeout as the base-gate wall-clock limit", async () => {
    const repo = makeRepo();
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({
        name: "active-gate-fixture",
        scripts: {
          test: "node -e \"let ticks=0; const timer=setInterval(()=>console.log(++ticks),50); setTimeout(()=>clearInterval(timer),2500)\"",
        },
      }),
      "utf-8",
    );
    git(repo, ["add", "package.json"]);
    git(repo, ["commit", "-m", "add active gate"]);

    let artifactDir = "";
    let evaluators = 0;
    const provider: AgentProvider = {
      name: "stub",
      async invoke(options: InvokeOptions): Promise<InvokeResult> {
        if (options.role === "evaluator-qa") {
          evaluators++;
          writeFileSync(
            join(artifactDir, "qa-report.md"),
            "# QA Report\n\n**Verdict:** PASS\n**Failure class:** NONE\n",
            "utf-8",
          );
        }
        return { exitCode: 0, stdout: "", stats: {} };
      },
    };
    const ctx = makeContext(repo, provider, {
      commandTimeoutMs: 2_000,
      heartbeatIntervalMs: 20,
    });
    artifactDir = ctx.absSliceDir;

    await expect(runSliceExecute(ctx)).resolves.toEqual({ phase: "PASS" });
    expect(evaluators).toBe(1);
  });

  it("blocks evaluation until every required checkpoint gate passes", async () => {
    const repo = makeRepo();
    const gateScript =
      "node -e \"const fs=require('fs'); process.exit(fs.readFileSync('gate-state.txt','utf8').trim()==='pass'?0:23)\"";
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({
        name: "gate-fixture",
        scripts: { typecheck: gateScript, test: gateScript },
      }),
      "utf-8",
    );
    git(repo, ["add", "package.json"]);
    git(repo, ["commit", "-m", "add gate scripts"]);

    let generators = 0;
    let evaluators = 0;
    let artifactDir = "";
    const generatorPrompts: string[] = [];
    const provider: AgentProvider = {
      name: "stub",
      async invoke(options: InvokeOptions): Promise<InvokeResult> {
        if (options.role === "generator") {
          generators++;
          generatorPrompts.push(options.prompt);
          writeFileSync(
            join(repo, "gate-state.txt"),
            generators === 1 ? "fail" : "pass",
            "utf-8",
          );
        } else if (options.role === "evaluator-qa") {
          evaluators++;
          writeFileSync(
            join(artifactDir, "qa-report.md"),
            "# QA Report\n\n**Verdict:** PASS\n**Failure class:** NONE\n",
            "utf-8",
          );
        }
        return { exitCode: 0, stdout: "", stats: {} };
      },
    };
    const ctx = makeContext(repo, provider, {
      commandTimeoutMs: 5_000,
      heartbeatIntervalMs: 20,
    });
    artifactDir = ctx.absSliceDir;

    await expect(runSliceExecute(ctx)).resolves.toEqual({ phase: "PASS" });
    expect(generators).toBe(2);
    expect(evaluators).toBe(1);
    expect(generatorPrompts[1]).toMatch(/attempt-[\w]+\.json/);
    expect(generatorPrompts[1]).toMatch(/typecheck\.log/);
    expect(generatorPrompts[1]).toMatch(/tests\.log/);

    const evidenceDir = join(ctx.logger.runDir, "gates", "s01");
    const evidenceFiles = readdirSync(evidenceDir)
      .filter((name) => name.endsWith(".json"))
      .sort();
    expect(evidenceFiles).toHaveLength(2);
    expect(evidenceFiles.every((name) => name.length <= 32)).toBe(true);
    expect(existsSync(join(artifactDir, "gate-evidence"))).toBe(false);
    expect(
      execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD"], {
        cwd: repo,
        encoding: "utf-8",
      }),
    ).not.toContain("gate-evidence");
    const attempts = evidenceFiles.map((name) =>
      JSON.parse(readFileSync(join(evidenceDir, name), "utf-8")),
    );
    expect(attempts[0].results.map((gate: { gateId: string }) => gate.gateId))
      .toEqual(["typecheck", "lint", "tests"]);
    expect(
      attempts.some(
        (attempt) =>
          attempt.results.filter(
            (gate: { status: string; failureKind: string }) =>
              gate.status === "FAIL" &&
              gate.failureKind === "COMMAND",
          ).length === 2,
      ),
    ).toBe(true);
    expect(
      attempts.some(
        (attempt) =>
          attempt.results.filter(
            (gate: { status: string }) => gate.status === "PASS",
          ).length === 2,
      ),
    ).toBe(true);
  });

  it("retries infrastructure without consuming an implementation round", async () => {
    const repo = makeRepo();
    let generators = 0;
    let evaluators = 0;
    let artifactDir = "";
    const provider: AgentProvider = {
      name: "stub",
      async invoke(options: InvokeOptions): Promise<InvokeResult> {
        if (options.role === "generator") {
          generators++;
          writeFileSync(join(repo, "change.txt"), "fixed\n", "utf-8");
        } else if (options.role === "evaluator-qa") {
          evaluators++;
          const failure = evaluators === 1;
          writeFileSync(
            join(artifactDir, "qa-report.md"),
            `# QA Report\n\n**Verdict:** ${failure ? "FAIL" : "PASS"}\n**Failure class:** ${failure ? "INFRASTRUCTURE" : "NONE"}\n`,
            "utf-8",
          );
        }
        return { exitCode: 0, stdout: "", stats: {} };
      },
    };
    const ctx = makeContext(repo, provider);
    artifactDir = ctx.absSliceDir;

    await expect(runSliceExecute(ctx)).resolves.toEqual({ phase: "PASS" });
    expect(generators).toBe(1);
    expect(evaluators).toBe(2);
    expect(ctx.logger.getSliceProgress("70")).toEqual({ genRounds: 1, evalRounds: 1 });
    expect(existsSync(join(artifactDir, "qa-report-r1-a1.md"))).toBe(true);
    expect(existsSync(join(artifactDir, "qa-report-r1-a2.md"))).toBe(true);
  });

  it("preserves every implementation report and passes all prior reports to retries", async () => {
    const repo = makeRepo();
    const generatorPrompts: string[] = [];
    let artifactDir = "";
    const provider: AgentProvider = {
      name: "stub",
      async invoke(options: InvokeOptions): Promise<InvokeResult> {
        if (options.role === "generator") {
          generatorPrompts.push(options.prompt);
          writeFileSync(join(repo, "change.txt"), `${generatorPrompts.length}\n`, "utf-8");
        } else if (options.role === "evaluator-qa") {
          writeFileSync(
            join(artifactDir, "qa-report.md"),
            `# QA Report\n\n**Verdict:** FAIL\n**Failure class:** IMPLEMENTATION\n\n## Findings\nFinding ${generatorPrompts.length}\n`,
            "utf-8",
          );
        }
        return { exitCode: 0, stdout: "", stats: {} };
      },
    };
    const ctx = makeContext(repo, provider);
    artifactDir = ctx.absSliceDir;

    await expect(runSliceExecute(ctx)).resolves.toEqual({
      phase: "STUCK",
      error: "QA failed after 3 implementation rounds",
    });
    expect(generatorPrompts).toHaveLength(3);
    expect(generatorPrompts[1]).toContain("qa-report-r1-a1.md");
    expect(generatorPrompts[2]).toContain("qa-report-r1-a1.md");
    expect(generatorPrompts[2]).toContain("qa-report-r2-a1.md");
    expect(readFileSync(join(artifactDir, "qa-report-r3-a1.md"), "utf-8")).toContain("Finding 3");
  });

  it("cancels a base gate process tree without evaluator or repair", async () => {
    const repo = makeRepo();
    const childPidPath = join(repo, "gate-child.pid");
    writeFileSync(
      join(repo, "gate.cjs"),
      [
        "const { spawn } = require('node:child_process');",
        "const { writeFileSync } = require('node:fs');",
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
        `writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));`,
        "setInterval(() => {}, 1000);",
      ].join("\n"),
      "utf-8",
    );
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({
        name: "cancel-fixture",
        scripts: {
          typecheck: "node gate.cjs",
          lint: "node -e \"process.exit(0)\"",
          test: "node -e \"process.exit(0)\"",
        },
      }),
      "utf-8",
    );
    git(repo, ["add", "gate.cjs", "package.json"]);
    git(repo, ["commit", "-m", "add cancellation gate"]);

    const controller = new AbortController();
    let generators = 0;
    let evaluators = 0;
    const provider: AgentProvider = {
      name: "stub",
      async invoke(options: InvokeOptions): Promise<InvokeResult> {
        if (options.role === "generator") {
          generators++;
          writeFileSync(join(repo, "change.txt"), "candidate\n", "utf-8");
          setTimeout(() => controller.abort(), 1_500);
        } else if (options.role === "evaluator-qa") {
          evaluators++;
        }
        return { exitCode: 0, stdout: "", stats: {} };
      },
    };
    const ctx = makeContext(repo, provider, {
      signal: controller.signal,
      commandTimeoutMs: 10_000,
      heartbeatIntervalMs: 20,
    });

    await expect(runSliceExecute(ctx)).resolves.toEqual({
      phase: "CANCELLED",
      error: "Cancelled by user",
    });
    expect(generators).toBe(1);
    expect(evaluators).toBe(0);
    expect(ctx.logger.getSliceProgress("70")).toEqual({
      genRounds: 1,
      evalRounds: 0,
    });

    const evidenceDir = join(ctx.logger.runDir, "gates", "s01");
    const evidenceFile = readdirSync(evidenceDir).find((name) =>
      name.endsWith(".json"),
    )!;
    const evidence = JSON.parse(
      readFileSync(join(evidenceDir, evidenceFile), "utf-8"),
    );
    expect(evidence.results).toEqual([]);
    const events = readFileSync(
      join(ctx.logger.runDir, "events.jsonl"),
      "utf-8",
    )
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    expect(events.some((event) => event.type === "gate-outcome")).toBe(false);
    const partialLogs = readdirSync(join(evidenceDir, "gate-logs"));
    expect(partialLogs).toHaveLength(1);
    expect(
      readFileSync(join(evidenceDir, "gate-logs", partialLogs[0]!), "utf-8"),
    ).toContain("[gate:typecheck] START");
    const childPid = Number(readFileSync(childPidPath, "utf-8"));
    expect(() => process.kill(childPid, 0)).toThrow();
  }, 30_000);
});

describe("provider-independent policy-less base gates", () => {
  for (const providerName of ["kiro", "claude-code", "codex"]) {
    it(`uses stable typecheck, lint, and tests IDs for ${providerName}`, async () => {
      const repo = makeRepo();
      writeFileSync(
        join(repo, "package.json"),
        JSON.stringify({
          name: `${providerName}-fixture`,
          scripts: {
            typecheck: "node -e \"process.exit(0)\"",
            lint: "node -e \"process.exit(0)\"",
            "test:run": "node -e \"process.exit(0)\"",
            test: "node -e \"process.exit(23)\"",
          },
        }),
        "utf-8",
      );
      git(repo, ["add", "package.json"]);
      git(repo, ["commit", "-m", "add baseline scripts"]);

      let artifactDir = "";
      let evaluators = 0;
      const provider: AgentProvider = {
        name: providerName,
        async invoke(options: InvokeOptions): Promise<InvokeResult> {
          if (options.role === "generator") {
            writeFileSync(
              join(repo, "provider-output.txt"),
              providerName,
              "utf-8",
            );
          } else if (options.role === "evaluator-qa") {
            evaluators++;
            writeFileSync(
              join(artifactDir, "qa-report.md"),
              "# QA Report\n\n**Verdict:** PASS\n**Failure class:** NONE\n",
              "utf-8",
            );
          }
          return { exitCode: 0, stdout: "", stats: {} };
        },
      };
      const ctx = makeContext(repo, provider, {
        commandTimeoutMs: 30_000,
        heartbeatIntervalMs: 20,
      });
      artifactDir = ctx.absSliceDir;

      await expect(runSliceExecute(ctx)).resolves.toEqual({ phase: "PASS" });
      expect(evaluators).toBe(1);
      const evidenceDir = join(ctx.logger.runDir, "gates", "s01");
      const evidenceFile = readdirSync(evidenceDir).find((name) =>
        name.endsWith(".json"),
      )!;
      const evidence = JSON.parse(
        readFileSync(join(evidenceDir, evidenceFile), "utf-8"),
      );
      expect(evidence.results.map((gate: { gateId: string }) => gate.gateId))
        .toEqual(["typecheck", "lint", "tests"]);
      expect(
        evidence.results.every(
          (gate: { status: string }) => gate.status === "PASS",
        ),
      ).toBe(true);
      expect(
        execFileSync(
          "git",
          ["show", `${evidence.treeId}:provider-output.txt`],
          { cwd: repo, encoding: "utf-8" },
        ),
      ).toBe(providerName);
    }, 60_000);
  }
});

describe("base gate observability", () => {
  it("projects every completed outcome to typed events and the run summary", () => {
    const repo = makeRepo();
    const ctx = makeContext(repo, {
      name: "observability",
      async invoke() {
        throw new Error("not invoked");
      },
    });
    const statuses = [
      ["pass", "PASS", null],
      ["command", "FAIL", "COMMAND"],
      ["configuration", "FAIL", "CONFIGURATION"],
      ["infrastructure", "INFRASTRUCTURE", null],
      ["optional", "SKIPPED", null],
    ] as const;

    for (const [index, [gateId, status, failureKind]] of statuses.entries()) {
      ctx.logger.event({
        type: "gate-outcome",
        ghIssue: "70",
        sliceNumber: "01",
        round: 2,
        attemptId: "attempt-1",
        gateId,
        stage: "base",
        status,
        failureKind,
        startedAt: "2026-08-23T10:00:00.000Z",
        endedAt: "2026-08-23T10:00:00.010Z",
        durationMs: index + 10,
        exitCode: status === "FAIL" ? 1 : null,
        treeId: "0123456789abcdef0123456789abcdef01234567",
        evidenceArtifactId: "gates/s01/attempt-1.json",
        logArtifactId: `gate-logs/${gateId}.log`,
      });
    }

    const events = readFileSync(
      join(ctx.logger.runDir, "events.jsonl"),
      "utf-8",
    )
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line))
      .filter((event) => event.type === "gate-outcome");
    expect(events.map((event) => event.status)).toEqual([
      "PASS",
      "FAIL",
      "FAIL",
      "INFRASTRUCTURE",
      "SKIPPED",
    ]);
    expect(events[1]).toMatchObject({
      gateId: "command",
      durationMs: 11,
      failureKind: "COMMAND",
    });

    const summary = ctx.logger.writeSummary();
    expect(summary).toContain("| 70 | 2 | pass | PASS | 10ms |");
    expect(summary).toContain("| 70 | 2 | command | FAIL (COMMAND) | 11ms |");
    expect(summary).toContain(
      "| 70 | 2 | configuration | FAIL (CONFIGURATION) | 12ms |",
    );
    expect(summary).toContain(
      "| 70 | 2 | infrastructure | INFRASTRUCTURE | 13ms |",
    );
    expect(summary).toContain("| 70 | 2 | optional | SKIPPED | 14ms |");
  });

  it.runIf(process.platform === "win32")(
    "terminates a fixture child before removing its repository",
    async () => {
      const repo = makeRepo();
      const child = spawnFixtureChild(
        process.execPath,
        ["-e", "console.log('ready'); setTimeout(() => {}, 10000)"],
        {
          cwd: repo,
          stdio: ["ignore", "pipe", "ignore"],
        },
      );

      await new Promise<void>((resolve) => {
        child.stdout!.once("data", () => resolve());
      });
    },
  );
});

describe("shared-preview QA", () => {
  it("verifies and applies migrations centrally before remote UAT", async () => {
    const repo = makeRepo();
    const marker = join(repo, "migration-order.txt").replace(/\\/g, "/");
    let artifactDir = "";
    const provider: AgentProvider = {
      name: "stub",
      async invoke(options: InvokeOptions): Promise<InvokeResult> {
        expect(readFileSync(marker, "utf-8")).toBe("verify\napply\n");
        expect(options.prompt).toContain("Shared-preview UAT only");
        writeFileSync(
          join(artifactDir, "uat-report.md"),
          "# QA Report\n\n**Verdict:** PASS\n**Failure class:** NONE\n",
          "utf-8",
        );
        return { exitCode: 0, stdout: "", stats: {} };
      },
    };
    const command = (word: string) =>
      `node -e "require('fs').appendFileSync('${marker}', '${word}\\n')"`;
    const ctx = makeContext(repo, provider, {
      sharedPreview: {
        verifyMigrationCommand: command("verify"),
        applyMigrationCommand: command("apply"),
      },
    });
    artifactDir = ctx.absSliceDir;

    await expect(runQAStage(ctx, 1, "shared-preview", [])).resolves.toEqual({
      outcome: "PASS",
      report: "specs/slices/01-prd-070-regression/uat-report-r1-a1.md",
    });
    expect(existsSync(join(artifactDir, "uat-report-r1-a1.md"))).toBe(true);
  });
});

describe("dependency-relevant sibling handoffs", () => {
  it("injects direct dependency handoffs and excludes unrelated siblings", () => {
    const repo = makeRepo();
    const dependency: Slice = { number: "01", ghIssue: "1", title: "Dependency", type: "AFK", blockedBy: [], userStories: "" };
    const unrelated: Slice = { number: "02", ghIssue: "2", title: "Unrelated", type: "AFK", blockedBy: [], userStories: "" };
    const target: Slice = { number: "03", ghIssue: "3", title: "Target", type: "AFK", blockedBy: ["1"], userStories: "" };
    const provider: AgentProvider = { name: "stub", invoke: async () => ({ exitCode: 0, stdout: "", stats: {} }) };
    const logger = new Logger(repo, "handoff-scope");
    const ctx = makeSliceContext(
      { repoRoot: repo, prdSlug: "scope", prdDir: repo, specsDir: "docs/prd", dag: buildDAG([dependency, unrelated, target]), provider },
      target,
      logger,
      "main",
      "",
      "pnpm test",
    );
    expect(ctx.siblingHandoffsBlock).toContain("01-dependency/handoff.md");
    expect(ctx.siblingHandoffsBlock).not.toContain("02-unrelated");
  });
});

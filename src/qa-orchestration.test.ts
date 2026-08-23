import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
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

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "afk-qa-070-"));
  dirs.push(repo);
  git(repo, ["init", "--initial-branch=main"]);
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

describe("PRD 070 QA retry behavior", { timeout: 60_000 }, () => {
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
    expect(generatorPrompts[1]).toMatch(/test\.log/);

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
      .toEqual(["typecheck", "lint", "test"]);
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
    it(`uses typecheck, lint, and test:run for ${providerName}`, async () => {
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
        commandTimeoutMs: 5_000,
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
        .toEqual(["typecheck", "lint", "test:run"]);
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
    }, 30_000);
  }
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

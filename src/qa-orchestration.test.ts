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
import { join, relative } from "node:path";
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
import { rmDirWithRetry, writeQAReview } from "./test-support.js";

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
  writeFileSync(join(repo, "README.md"), "fixture\n", "utf-8");
  // Every real consumer ignores `.afk/`, and this fixture has to as well:
  // it uses the repo root as the slice worktree, so without the ignore the
  // run's own journal and gate evidence would land inside the tree being
  // hashed — and the QA-dedup tree-sha comparison (ADR 0012) would see the
  // candidate change under it for reasons that have nothing to do with the
  // candidate.
  writeFileSync(join(repo, ".gitignore"), ".afk/\nnode_modules/\n", "utf-8");
  git(repo, ["add", "README.md", ".gitignore"]);
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
  it("archives partial evaluator output before retrying a failed invocation", async () => {
    const repo = makeRepo();
    let artifactDir = "";
    let attempts = 0;
    const provider: AgentProvider = {
      name: "stub",
      async invoke(): Promise<InvokeResult> {
        attempts++;
        writeFileSync(
          join(artifactDir, "qa-report.md"),
          `# QA Report\n\nAttempt ${attempts}\n`,
          "utf-8",
        );
        if (attempts === 1) {
          writeFileSync(
            join(artifactDir, "qa-review.json"),
            '{"version":1,"verdict":',
            "utf-8",
          );
          throw new Error("provider disconnected");
        }
        writeQAReview(artifactDir, "deterministic");
        return { exitCode: 0, stdout: "", stats: {} };
      },
    };
    const ctx = makeContext(repo, provider, { infrastructureRetries: 1 });
    artifactDir = ctx.absSliceDir;

    await expect(runQAStage(ctx, 1, "deterministic", [])).resolves.toMatchObject(
      { outcome: "PASS" },
    );
    const reviewDir = join(
      repo,
      ".afk",
      "artifacts",
      "prd-070-stub",
      "slice-01",
      "reviews",
    );
    expect(readFileSync(join(artifactDir, "qa-report-r1-a1.md"), "utf-8")).toContain(
      "Attempt 1",
    );
    expect(
      readFileSync(join(reviewDir, "qa-review-r1-a1.json"), "utf-8"),
    ).toBe('{"version":1,"verdict":');
    expect(
      readFileSync(
        join(reviewDir, "qa-review-r1-a1-validation.txt"),
        "utf-8",
      ),
    ).toMatch(/valid JSON/);
    expect(existsSync(join(reviewDir, "qa-review-r1-a1-record.json"))).toBe(
      false,
    );
  });

  it("archives canonical validation when the Markdown companion is missing", async () => {
    const repo = makeRepo();
    const provider: AgentProvider = {
      name: "stub",
      async invoke(): Promise<InvokeResult> {
        return { exitCode: 0, stdout: "", stats: {} };
      },
    };
    const ctx = makeContext(repo, provider, { infrastructureRetries: 0 });

    await expect(runQAStage(ctx, 1, "deterministic", [])).rejects.toThrow(
      /qa-review\.json is missing/,
    );
    const reviewDir = join(
      repo,
      ".afk",
      "artifacts",
      "prd-070-stub",
      "slice-01",
      "reviews",
    );
    expect(
      readFileSync(
        join(reviewDir, "qa-review-r1-a1-validation.txt"),
        "utf-8",
      ),
    ).toMatch(/qa-review\.json is missing/);
    expect(existsSync(join(reviewDir, "qa-review-r1-a1-record.json"))).toBe(
      false,
    );
  });

  it("fails closed when Markdown passes without canonical QA JSON", async () => {
    const repo = makeRepo();
    let artifactDir = "";
    const provider: AgentProvider = {
      name: "stub",
      async invoke(): Promise<InvokeResult> {
        writeFileSync(
          join(artifactDir, "qa-report.md"),
          "# QA Report\n\n**Verdict:** PASS\n**Failure class:** NONE\n",
          "utf-8",
        );
        return { exitCode: 0, stdout: "", stats: {} };
      },
    };
    const ctx = makeContext(repo, provider);
    artifactDir = ctx.absSliceDir;

    await expect(runQAStage(ctx, 1, "deterministic", [])).rejects.toThrow(
      /qa-review\.json is missing/,
    );
    expect(existsSync(join(artifactDir, "qa-report-r1-a1.md"))).toBe(true);
    const reviewDir = join(
      repo,
      ".afk",
      "artifacts",
      "prd-070-stub",
      "slice-01",
      "reviews",
    );
    expect(
      readFileSync(
        join(reviewDir, "qa-review-r1-a1-validation.txt"),
        "utf-8",
      ),
    ).toMatch(/qa-review\.json is missing/);
    expect(existsSync(join(reviewDir, "qa-review-r1-a1-record.json"))).toBe(
      false,
    );
  });

  it("uses canonical PASS even when the Markdown companion says FAIL", async () => {
    const repo = makeRepo();
    let artifactDir = "";
    const provider: AgentProvider = {
      name: "stub",
      async invoke(): Promise<InvokeResult> {
        writeFileSync(
          join(artifactDir, "qa-report.md"),
          "# QA Report\n\n**Verdict:** FAIL\n**Failure class:** IMPLEMENTATION\n",
          "utf-8",
        );
        writeFileSync(
          join(artifactDir, "qa-review.json"),
          JSON.stringify({
            version: 2,
            verdict: "PASS",
            failureClass: "NONE",
            infrastructureEvidence: null,
            findings: [],
          }),
          "utf-8",
        );
        return { exitCode: 0, stdout: "", stats: {} };
      },
    };
    const ctx = makeContext(repo, provider);
    artifactDir = ctx.absSliceDir;

    await expect(runQAStage(ctx, 1, "deterministic", [])).resolves.toMatchObject(
      {
        outcome: "PASS",
        report: "specs/slices/01-prd-070-regression/qa-report-r1-a1.md",
        history: [],
        unresolved: [],
      },
    );
    const reviewDir = join(
      repo,
      ".afk",
      "artifacts",
      "prd-070-stub",
      "slice-01",
      "reviews",
    );
    expect(existsSync(join(reviewDir, "qa-review-r1-a1.json"))).toBe(true);
    expect(existsSync(join(reviewDir, "qa-review-r1-a1-record.json"))).toBe(
      true,
    );
  });

  it("deletes stale canonical JSON before an infrastructure retry", async () => {
    const repo = makeRepo();
    let artifactDir = "";
    let attempts = 0;
    const provider: AgentProvider = {
      name: "stub",
      async invoke(): Promise<InvokeResult> {
        attempts++;
        writeFileSync(
          join(artifactDir, "qa-report.md"),
          `# QA Report\n\n**Verdict:** ${attempts === 1 ? "FAIL" : "PASS"}\n`,
          "utf-8",
        );
        if (attempts === 1) {
          writeFileSync(
            join(artifactDir, "qa-review.json"),
            JSON.stringify({
              version: 2,
              verdict: "FAIL",
              failureClass: "INFRASTRUCTURE",
              infrastructureEvidence: "Registry unavailable",
              findings: [],
            }),
            "utf-8",
          );
        }
        return { exitCode: 0, stdout: "", stats: {} };
      },
    };
    const ctx = makeContext(repo, provider, { infrastructureRetries: 1 });
    artifactDir = ctx.absSliceDir;

    await expect(runQAStage(ctx, 1, "deterministic", [])).rejects.toThrow(
      /qa-review\.json is missing/,
    );
    expect(attempts).toBe(2);
    const reviewDir = join(
      repo,
      ".afk",
      "artifacts",
      "prd-070-stub",
      "slice-01",
      "reviews",
    );
    expect(existsSync(join(reviewDir, "qa-review-r1-a1.json"))).toBe(true);
    expect(existsSync(join(reviewDir, "qa-review-r1-a1-record.json"))).toBe(
      true,
    );
    expect(
      existsSync(join(reviewDir, "qa-review-r1-a2-validation.txt")),
    ).toBe(true);
    expect(existsSync(join(artifactDir, "qa-report-r1-a2.md"))).toBe(true);
  });

  // A resumed run needs archived round evidence on disk before
  // `runSliceExecute` starts — no existing fixture in this suite reaches
  // that state, and the resume-integration fixture passes in round 2, so
  // it can never prove exhaustion (QA slice #79 finding 2).
  it("caps an ordinary resume at the rounds left under the three-round budget", async () => {
    const repo = makeRepo();
    let artifactDir = "";
    const roles: string[] = [];
    const generatorPrompts: string[] = [];
    const provider: AgentProvider = {
      name: "stub",
      async invoke(options: InvokeOptions): Promise<InvokeResult> {
        roles.push(options.role);
        if (options.role === "generator") {
          generatorPrompts.push(options.prompt);
          writeFileSync(
            join(repo, "change.txt"),
            `${generatorPrompts.length}\n`,
            "utf-8",
          );
        } else if (options.role === "evaluator-qa") {
          writeFileSync(
            join(artifactDir, "qa-report.md"),
            "# QA Report\n\n**Verdict:** FAIL\n**Failure class:** IMPLEMENTATION\n",
            "utf-8",
          );
          // Repeats the restored OPEN finding (QA-01) exactly once, so
          // the lifecycle accepts every resumed attempt — the run stops
          // because the cap is spent, not because a transition is refused.
          writeQAReview(artifactDir, "deterministic", { verdict: "FAIL" });
        }
        return { exitCode: 0, stdout: "", stats: {} };
      },
    };
    const ctx = makeContext(repo, provider);
    artifactDir = ctx.absSliceDir;

    // Round 1 already happened in the slice's previous life: its record
    // and Markdown archive are what `loadQAReviewResumeState` reads.
    const reviewDir = join(
      repo,
      ".afk",
      "artifacts",
      "prd-070-stub",
      "slice-01",
      "reviews",
    );
    mkdirSync(reviewDir, { recursive: true });
    // Deliberately a version-1 record: a run interrupted before findings
    // carried a remedy (#112) must still resume from the evidence it has.
    writeFileSync(
      join(reviewDir, "qa-review-r1-a1-record.json"),
      JSON.stringify(
        {
          version: 1,
          stage: "deterministic",
          round: 1,
          attempt: 1,
          verdict: "FAIL",
          failureClass: "IMPLEMENTATION",
          findings: [
            {
              id: "QA-01",
              severity: "BLOCKING",
              state: "OPEN",
              unresolved: true,
              summary: "Fixture implementation finding",
              clearCondition:
                "The fixture evaluator observes the behavior passing",
              artifactReferences: [
                ".afk/artifacts/prd-070-stub/slice-01/reviews/qa-review-r1-a1.json",
                "specs/slices/01-prd-070-regression/qa-report-r1-a1.md",
              ],
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );
    writeFileSync(
      join(artifactDir, "qa-report-r1-a1.md"),
      "# QA Report\n\n**Verdict:** FAIL\n**Failure class:** IMPLEMENTATION\n",
      "utf-8",
    );
    ctx.resume = {
      mode: "killed",
      commitsAhead: 1,
      commitLog: "abc1234 feat(#70): round-1 work",
      handoffNote: "",
    };

    await expect(runSliceExecute(ctx)).resolves.toEqual({
      phase: "STUCK",
      error: "QA failed after 3 implementation rounds",
    });
    // Rounds 2 and 3 only — the fourth implementation round the QA
    // finding demonstrated is not reachable through an ordinary resume.
    expect(roles.filter((role) => role === "generator")).toHaveLength(2);
    expect(roles.filter((role) => role === "evaluator-qa")).toHaveLength(2);
    expect(roles.filter((role) => role === "generator-stuck")).toHaveLength(1);
    expect(generatorPrompts[1]).toContain("This is implementation round 3");
    expect(existsSync(join(artifactDir, "qa-report-r2-a1.md"))).toBe(true);
    expect(existsSync(join(artifactDir, "qa-report-r3-a1.md"))).toBe(true);
    expect(existsSync(join(artifactDir, "qa-report-r4-a1.md"))).toBe(false);
    expect(existsSync(join(reviewDir, "qa-review-r4-a1.json"))).toBe(false);
  });

  it("fails closed when the raw canonical archive cannot be preserved", async () => {
    const repo = makeRepo();
    let artifactDir = "";
    const provider: AgentProvider = {
      name: "stub",
      async invoke(): Promise<InvokeResult> {
        writeFileSync(
          join(artifactDir, "qa-report.md"),
          "# QA Report\n\n**Verdict:** PASS\n**Failure class:** NONE\n",
          "utf-8",
        );
        writeQAReview(artifactDir, "deterministic");
        return { exitCode: 0, stdout: "", stats: {} };
      },
    };
    const ctx = makeContext(repo, provider, { infrastructureRetries: 0 });
    artifactDir = ctx.absSliceDir;
    const reviewDir = join(
      repo,
      ".afk",
      "artifacts",
      "prd-070-stub",
      "slice-01",
      "reviews",
    );
    mkdirSync(reviewDir, { recursive: true });
    // The exact collision QA slice #79 finding 3 names: the archive slot
    // is already occupied, so the `errorOnExist` copy must throw and the
    // attempt must not be allowed to PASS over the lost evidence.
    writeFileSync(
      join(reviewDir, "qa-review-r1-a1.json"),
      "stale archive from another life\n",
      "utf-8",
    );

    await expect(runQAStage(ctx, 1, "deterministic", [])).rejects.toThrow(
      /could not preserve its raw canonical artifact/,
    );
    // The stale archive was refused, not silently overwritten.
    expect(readFileSync(join(reviewDir, "qa-review-r1-a1.json"), "utf-8")).toBe(
      "stale archive from another life\n",
    );
    expect(existsSync(join(reviewDir, "qa-review-r1-a1-record.json"))).toBe(
      false,
    );
  });

  // Both failures must survive into the terminal error: the archive
  // refusal (why the attempt cannot count) and the original invocation
  // failure (the root cause a reader debugs first). Before the fix the
  // archive throw replaced the evaluator failure outright.
  it("keeps the evaluator failure visible when its archive also fails", async () => {
    const repo = makeRepo();
    let artifactDir = "";
    const provider: AgentProvider = {
      name: "stub",
      async invoke(): Promise<InvokeResult> {
        // The evaluator wrote a valid review, then the provider died —
        // the catch path archives the evidence it left behind.
        writeQAReview(artifactDir, "deterministic");
        throw new Error("provider disconnected mid-review");
      },
    };
    const ctx = makeContext(repo, provider, { infrastructureRetries: 0 });
    artifactDir = ctx.absSliceDir;
    const reviewDir = join(
      repo,
      ".afk",
      "artifacts",
      "prd-070-stub",
      "slice-01",
      "reviews",
    );
    mkdirSync(reviewDir, { recursive: true });
    writeFileSync(
      join(reviewDir, "qa-review-r1-a1.json"),
      "stale archive from another life\n",
      "utf-8",
    );

    const error = await runQAStage(ctx, 1, "deterministic", []).then(
      () => {
        throw new Error("expected runQAStage to reject");
      },
      (err) => err as Error,
    );
    expect(error.message).toMatch(
      /could not preserve its raw canonical artifact/,
    );
    expect(error.message).toMatch(
      /while handling evaluator failure: provider disconnected mid-review/,
    );
  });

  it("refuses PASS when the lifecycle record cannot be archived", async () => {
    const repo = makeRepo();
    let artifactDir = "";
    const provider: AgentProvider = {
      name: "stub",
      async invoke(options: InvokeOptions): Promise<InvokeResult> {
        if (options.role === "generator") {
          writeFileSync(join(repo, "change.txt"), "done\n", "utf-8");
        } else if (options.role === "evaluator-qa") {
          writeFileSync(
            join(artifactDir, "qa-report.md"),
            "# QA Report\n\n**Verdict:** PASS\n**Failure class:** NONE\n",
            "utf-8",
          );
          writeQAReview(artifactDir, "deterministic");
        }
        return { exitCode: 0, stdout: "", stats: {} };
      },
    };
    const ctx = makeContext(repo, provider, { infrastructureRetries: 0 });
    artifactDir = ctx.absSliceDir;
    const reviewDir = join(
      repo,
      ".afk",
      "artifacts",
      "prd-070-stub",
      "slice-01",
      "reviews",
    );
    mkdirSync(reviewDir, { recursive: true });
    // Occupy the record's `wx` slot so the lifecycle write fails after a
    // valid PASS review — the slice must end ERROR, not merge (#79).
    writeFileSync(
      join(reviewDir, "qa-review-r1-a1-record.json"),
      "{}\n",
      "utf-8",
    );

    await expect(runSliceExecute(ctx)).resolves.toMatchObject({
      phase: "ERROR",
      error: expect.stringMatching(/could not preserve its lifecycle record/),
    });
  });

  // The cross-attempt hole the #79 fix left open (#124): attempt 1's
  // refusal evidence cannot be written, the loop infra-retries, and
  // attempt 2 PASSes — shipping the slice with the refused attempt's
  // validation file missing. The lost write now ends the slice instead,
  // because a retry re-invokes the evaluator and can never recover it.
  it("refuses to retry past an unarchivable validation write", async () => {
    const repo = makeRepo();
    let artifactDir = "";
    let attempts = 0;
    const provider: AgentProvider = {
      name: "stub",
      async invoke(): Promise<InvokeResult> {
        attempts++;
        writeFileSync(
          join(artifactDir, "qa-report.md"),
          `# QA Report\n\nAttempt ${attempts}\n`,
          "utf-8",
        );
        if (attempts === 1) {
          // Truncated canonical output, then a dead provider: exactly the
          // `failedAttemptEvidence` path that archives validation evidence.
          writeFileSync(
            join(artifactDir, "qa-review.json"),
            '{"version":1,"verdict":',
            "utf-8",
          );
          throw new Error("provider disconnected");
        }
        writeQAReview(artifactDir, "deterministic");
        return { exitCode: 0, stdout: "", stats: {} };
      },
    };
    const ctx = makeContext(repo, provider, { infrastructureRetries: 1 });
    artifactDir = ctx.absSliceDir;
    const reviewDir = join(
      repo,
      ".afk",
      "artifacts",
      "prd-070-stub",
      "slice-01",
      "reviews",
    );
    mkdirSync(reviewDir, { recursive: true });
    // Occupy the validation file's `wx` slot the way another life's
    // archive does after a restart.
    writeFileSync(
      join(reviewDir, "qa-review-r1-a1-validation.txt"),
      "stale validation from another life\n",
      "utf-8",
    );

    const error = await runQAStage(ctx, 1, "deterministic", []).then(
      () => {
        throw new Error("expected runQAStage to reject");
      },
      (err) => err as Error,
    );
    expect(error.message).toMatch(
      /could not preserve its validation evidence/,
    );
    // The evaluator failure that produced the evidence stays visible.
    expect(error.message).toMatch(
      /while handling evaluator failure: provider disconnected/,
    );
    // The retry that would have shipped a PASS over the lost evidence
    // never ran, and the occupied slot was refused, not overwritten.
    expect(attempts).toBe(1);
    expect(
      readFileSync(
        join(reviewDir, "qa-review-r1-a1-validation.txt"),
        "utf-8",
      ),
    ).toBe("stale validation from another life\n");
    expect(existsSync(join(reviewDir, "qa-review-r1-a1-record.json"))).toBe(
      false,
    );
  });

  it("names the lost validation write alongside the artifact ERROR", async () => {
    const repo = makeRepo();
    const provider: AgentProvider = {
      name: "stub",
      async invoke(): Promise<InvokeResult> {
        return { exitCode: 0, stdout: "", stats: {} };
      },
    };
    const ctx = makeContext(repo, provider, { infrastructureRetries: 0 });
    const reviewDir = join(
      repo,
      ".afk",
      "artifacts",
      "prd-070-stub",
      "slice-01",
      "reviews",
    );
    mkdirSync(reviewDir, { recursive: true });
    writeFileSync(
      join(reviewDir, "qa-review-r1-a1-validation.txt"),
      "stale validation from another life\n",
      "utf-8",
    );

    // This attempt already ended the slice before #124, so the fix only
    // has to say what was lost — the operator must not have to infer that
    // the refusal was never written down.
    await expect(runQAStage(ctx, 1, "deterministic", [])).rejects.toThrow(
      /qa-review\.json is missing.*could not preserve its validation evidence/s,
    );
  });

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
          writeQAReview(artifactDir, "deterministic");
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
    const evaluatorPrompts: string[] = [];
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
          evaluatorPrompts.push(options.prompt);
          writeFileSync(
            join(artifactDir, "qa-report.md"),
            "# QA Report\n\n**Verdict:** PASS\n**Failure class:** NONE\n",
            "utf-8",
          );
          writeQAReview(artifactDir, "deterministic");
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

    // QA-dedup (ADR 0012, 2026-08-28). Asserted on this scenario rather than
    // a new one because it is the only fixture that already runs real base
    // gates to green on a real candidate — which is exactly what the skip
    // authorization is derived from. The unit tests in
    // `qa-gate-authorization.test.ts` own the decision table; what only a
    // spawned run can prove is that the tree sha the orchestrator hashes at
    // QA dispatch still equals the one the gates ran on, so the grant is
    // reachable at all and not permanently fail-closed.
    const passingIndex = attempts.findIndex((attempt) =>
      attempt.results.every(
        (gate: { status: string }) => gate.status !== "FAIL",
      ),
    );
    const passingAttempt = attempts[passingIndex];
    const qaPrompt = evaluatorPrompts[0] ?? "";
    expect(qaPrompt).toContain("Skip authorization");
    expect(qaPrompt).toContain(`\`${passingAttempt.treeId}\``);
    expect(qaPrompt).toContain(`\`${passingAttempt.attemptId}\``);
    // `lint` has no script in this fixture, so the gate never ran it and the
    // authorization must not vouch for it.
    expect(qaPrompt).toContain("- typecheck — `pnpm run typecheck` — PASS at");
    expect(qaPrompt).toContain("- tests — `pnpm run test` — PASS at");
    expect(qaPrompt).not.toContain("- lint —");

    const record = JSON.parse(
      readFileSync(
        join(
          repo,
          ".afk",
          "artifacts",
          "prd-070-stub",
          "slice-01",
          "reviews",
          "qa-review-r2-a1-record.json",
        ),
        "utf-8",
      ),
    );
    expect(record.baseGateCitation).toEqual({
      evidenceArtifactId: relative(
        repo,
        join(evidenceDir, evidenceFiles[passingIndex]!),
      ).replace(/\\/g, "/"),
      attemptId: passingAttempt.attemptId,
      treeId: passingAttempt.treeId,
      gateIds: ["typecheck", "tests"],
    });
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
          writeQAReview(artifactDir, "deterministic", failure
            ? { verdict: "FAIL", failureClass: "INFRASTRUCTURE" }
            : {});
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

  it("routes only the current unresolved findings to QA and generator retries", async () => {
    const repo = makeRepo();
    const generatorPrompts: string[] = [];
    const evaluatorPrompts: string[] = [];
    let artifactDir = "";
    const provider: AgentProvider = {
      name: "stub",
      async invoke(options: InvokeOptions): Promise<InvokeResult> {
        if (options.role === "generator") {
          generatorPrompts.push(options.prompt);
          writeFileSync(join(repo, "change.txt"), `${generatorPrompts.length}\n`, "utf-8");
        } else if (options.role === "evaluator-qa") {
          evaluatorPrompts.push(options.prompt);
          const round = evaluatorPrompts.length;
          writeFileSync(
            join(artifactDir, "qa-report.md"),
            `# QA Report\n\n**Verdict:** ${round === 3 ? "PASS" : "FAIL"}\n`,
            "utf-8",
          );
          const finding = (
            id: string,
            severity: "BLOCKING" | "ADVISORY",
            summary: string,
            clearCondition: string,
            state: "OPEN" | "RESOLVED" = "OPEN",
          ) => ({
            id,
            severity,
            behaviorIds: [],
            summary,
            evidence: `${id} evidence`,
            expected: `${id} expected`,
            observed: `${id} observed`,
            clearCondition,
            state,
          });
          const findings =
            round === 1
              ? [
                  finding(
                    "QA-BLOCKING",
                    "BLOCKING",
                    "Blocking summary",
                    "Blocking condition",
                  ),
                  finding(
                    "QA-ADVISORY",
                    "ADVISORY",
                    "Advisory summary",
                    "Advisory condition",
                  ),
                ]
              : round === 2
                ? [
                    finding(
                      "QA-BLOCKING",
                      "BLOCKING",
                      "Blocking summary",
                      "Blocking condition",
                      "RESOLVED",
                    ),
                    finding(
                      "QA-ADVISORY",
                      "ADVISORY",
                      "Advisory summary",
                      "Advisory condition",
                    ),
                    finding(
                      "QA-FRESH",
                      "BLOCKING",
                      "Fresh summary",
                      "Fresh condition",
                    ),
                  ]
                : [
                    finding(
                      "QA-ADVISORY",
                      "ADVISORY",
                      "Advisory summary",
                      "Advisory condition",
                      "RESOLVED",
                    ),
                    finding(
                      "QA-FRESH",
                      "BLOCKING",
                      "Fresh summary",
                      "Fresh condition",
                      "RESOLVED",
                    ),
                  ];
          writeQAReview(artifactDir, "deterministic", {
            verdict: round === 3 ? "PASS" : "FAIL",
            findings,
          });
        }
        return { exitCode: 0, stdout: "", stats: {} };
      },
    };
    const ctx = makeContext(repo, provider);
    artifactDir = ctx.absSliceDir;

    await expect(runSliceExecute(ctx)).resolves.toEqual({ phase: "PASS" });
    expect(generatorPrompts).toHaveLength(3);
    expect(evaluatorPrompts).toHaveLength(3);

    expect(generatorPrompts[1]).toContain("QA-BLOCKING");
    expect(generatorPrompts[1]).toContain("Blocking summary");
    expect(generatorPrompts[1]).toContain("Blocking condition");
    expect(generatorPrompts[1]).toContain("QA-ADVISORY");
    expect(generatorPrompts[1]).toContain("Advisory summary");
    expect(generatorPrompts[1]).toContain("Advisory condition");
    expect(generatorPrompts[1]).toContain("qa-review-r1-a1.json");
    expect(generatorPrompts[1]).toContain("qa-report-r1-a1.md");

    expect(evaluatorPrompts[1]).toContain("QA-BLOCKING");
    expect(evaluatorPrompts[1]).toContain("QA-ADVISORY");
    expect(evaluatorPrompts[1]).toContain("qa-review-r1-a1.json");
    expect(evaluatorPrompts[1]).toContain("qa-report-r1-a1.md");

    expect(generatorPrompts[2]).not.toContain("QA-BLOCKING");
    expect(generatorPrompts[2]).toContain("QA-ADVISORY");
    expect(generatorPrompts[2]).toContain("Advisory summary");
    expect(generatorPrompts[2]).toContain("Advisory condition");
    expect(generatorPrompts[2]).toContain("QA-FRESH");
    expect(generatorPrompts[2]).toContain("Fresh summary");
    expect(generatorPrompts[2]).toContain("Fresh condition");
    expect(generatorPrompts[2]).toContain("qa-review-r2-a1.json");
    expect(generatorPrompts[2]).toContain("qa-report-r2-a1.md");
    expect(generatorPrompts[2]).not.toContain("qa-review-r1-a1.json");
    expect(generatorPrompts[2]).not.toContain("qa-report-r1-a1.md");

    expect(evaluatorPrompts[2]).not.toContain("QA-BLOCKING");
    expect(evaluatorPrompts[2]).toContain("QA-ADVISORY");
    expect(evaluatorPrompts[2]).toContain("QA-FRESH");
    expect(evaluatorPrompts[2]).toContain("qa-review-r2-a1.json");
    expect(evaluatorPrompts[2]).toContain("qa-report-r2-a1.md");
    expect(evaluatorPrompts[2]).not.toContain("qa-review-r1-a1.json");
    expect(evaluatorPrompts[2]).not.toContain("qa-report-r1-a1.md");
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

// Mid-slice scope amendments (#112). These drive `runQAStage` directly with
// a stub evaluator rather than a whole slice: the claim is about what the QA
// loop does with an amendment finding, and no existing scenario in this
// suite reaches a locked contract with an undeclared change in the tree.
describe("scope amendments during QA", { timeout: 60_000 }, () => {
  const CONTRACT = [
    "# Slice Contract — undeclared scope",
    "",
    "**Status:** LOCKED",
    "",
    "## Files expected to change",
    "- src/declared.ts",
    "",
    "## Migration requirements",
    "- New migration files: 0",
    "",
  ].join("\n");

  function lockContract(repo: string, sliceDir: string): void {
    writeFileSync(join(sliceDir, "contract.md"), CONTRACT, "utf-8");
    writeFileSync(
      join(sliceDir, "acceptance-manifest.json"),
      `${JSON.stringify(
        {
          version: 2,
          fileScope: { kind: "paths", paths: ["src/declared.ts"] },
          migrationCount: 0,
          behaviors: [
            {
              id: "B-01",
              source: "GH #70 AC1",
              given: "a declared file",
              when: "the suite runs",
              then: "it passes",
              observableResult: "green suite",
              preservation: false,
              gateIds: ["tests"],
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    mkdirSync(join(repo, "src"), { recursive: true });
    // The undeclared files the generator wrote and QA is about to find.
    writeFileSync(join(repo, "src", "support.ts"), "export const x = 1;\n", "utf-8");
    writeFileSync(join(repo, "src", "support-two.ts"), "export const z = 3;\n", "utf-8");
    writeFileSync(join(repo, "src", "declared.ts"), "export const y = 2;\n", "utf-8");
  }

  function amendmentFinding(
    paths: string[],
    state: "OPEN" | "RESOLVED",
  ) {
    return {
      id: "QA-02",
      severity: "BLOCKING" as const,
      behaviorIds: [],
      summary: "Test support lives in an undeclared file",
      evidence: "src/support.ts is not on the contract's file list",
      expected: "The file list names every file the behaviors need",
      observed: "The file list omits src/support.ts",
      clearCondition: "The locked file scope declares src/support.ts",
      state,
      remedy: "SCOPE_AMENDMENT" as const,
      amendmentPaths: paths,
    };
  }

  /**
   * A stub evaluator that asks for an amendment on attempt 1, and on
   * attempt 2 either repeats the routed finding as RESOLVED (the amended
   * contract satisfied it) or asks for a second, different amendment.
   */
  function amendingProvider(
    artifactDir: () => string,
    paths: string[],
    onSecondAttempt: "resolve" | "request-another",
  ): { provider: AgentProvider; attempts: () => number } {
    let attempts = 0;
    return {
      attempts: () => attempts,
      provider: {
        name: "stub",
        async invoke(): Promise<InvokeResult> {
          attempts++;
          const requesting =
            attempts === 1 || onSecondAttempt === "request-another";
          writeFileSync(
            join(artifactDir(), "qa-report.md"),
            `# QA Report\n\n**Verdict:** ${requesting ? "FAIL" : "PASS"}\n`,
            "utf-8",
          );
          writeQAReview(artifactDir(), "deterministic", {
            verdict: requesting ? "FAIL" : "PASS",
            findings: [
              amendmentFinding(
                attempts > 1 && onSecondAttempt === "request-another"
                  ? ["src/support-two.ts"]
                  : paths,
                requesting ? "OPEN" : "RESOLVED",
              ),
            ],
          });
          return { exitCode: 0, stdout: "", stats: {} };
        },
      },
    };
  }

  it("amends the locked scope and re-grades without consuming the round", async () => {
    const repo = makeRepo();
    let artifactDir = "";
    const { provider, attempts } = amendingProvider(
      () => artifactDir,
      ["src/support.ts"],
      "resolve",
    );
    const ctx = makeContext(repo, provider, { infrastructureRetries: 0 });
    artifactDir = ctx.absSliceDir;
    lockContract(repo, ctx.absSliceDir);

    const result = await runQAStage(ctx, 1, "deterministic", []);

    // The amendment bought exactly one extra attempt inside round 1 —
    // `infrastructureRetries: 0` allows no other second attempt.
    expect(attempts()).toBe(2);
    expect(result.outcome).toBe("PASS");
    // The amendment finding never reaches the generator's routed set.
    expect(result.unresolved).toEqual([]);

    const manifest = JSON.parse(
      readFileSync(join(ctx.absSliceDir, "acceptance-manifest.json"), "utf-8"),
    );
    expect(manifest.fileScope.paths).toEqual([
      "src/declared.ts",
      "src/support.ts",
    ]);
    expect(manifest.behaviors).toHaveLength(1);
    const contract = readFileSync(
      join(ctx.absSliceDir, "contract.md"),
      "utf-8",
    );
    expect(contract).toContain(
      "- src/support.ts (added by scope amendment for QA finding QA-02)",
    );
    expect(contract).toContain("**Status:** LOCKED");

    const reviewDir = join(
      repo,
      ".afk",
      "artifacts",
      "prd-070-stub",
      "slice-01",
      "reviews",
    );
    expect(
      JSON.parse(
        readFileSync(
          join(reviewDir, "qa-scope-amendment-r1-a1.json"),
          "utf-8",
        ),
      ),
    ).toEqual({
      version: 1,
      stage: "deterministic",
      round: 1,
      attempt: 1,
      findingIds: ["QA-02"],
      paths: ["src/support.ts"],
    });
    expect(
      readFileSync(join(ctx.logger.runDir, "run.log"), "utf-8"),
    ).toContain("scope amendment applied");
  });

  it("refuses a second amendment in the same round and reverts nothing", async () => {
    const repo = makeRepo();
    let artifactDir = "";
    const { provider, attempts } = amendingProvider(
      () => artifactDir,
      ["src/support.ts"],
      "request-another",
    );
    const ctx = makeContext(repo, provider, { infrastructureRetries: 0 });
    artifactDir = ctx.absSliceDir;
    lockContract(repo, ctx.absSliceDir);

    await expect(runQAStage(ctx, 1, "deterministic", [])).rejects.toThrow(
      /already spent its 1 amendment\(s\)/,
    );
    expect(attempts()).toBe(2);
  });

  it("refuses an amendment for a path the slice never changed", async () => {
    const repo = makeRepo();
    let artifactDir = "";
    const { provider, attempts } = amendingProvider(
      () => artifactDir,
      ["src/never-written.ts"],
      "resolve",
    );
    const ctx = makeContext(repo, provider, { infrastructureRetries: 0 });
    artifactDir = ctx.absSliceDir;
    lockContract(repo, ctx.absSliceDir);

    await expect(runQAStage(ctx, 1, "deterministic", [])).rejects.toThrow(
      /not among the files this slice changed/,
    );
    // Refused before any evaluator retry, and with the contract intact.
    expect(attempts()).toBe(1);
    expect(
      JSON.parse(
        readFileSync(
          join(ctx.absSliceDir, "acceptance-manifest.json"),
          "utf-8",
        ),
      ).fileScope.paths,
    ).toEqual(["src/declared.ts"]);
  });
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
            writeQAReview(artifactDir, "deterministic");
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
  it("keeps deterministic and UAT findings isolated across a UAT retry", async () => {
    const repo = makeRepo();
    const marker = join(repo, "migration-order.txt").replace(/\\/g, "/");
    const generatorPrompts: string[] = [];
    const deterministicPrompts: string[] = [];
    const uatPrompts: string[] = [];
    let artifactDir = "";
    const provider: AgentProvider = {
      name: "stub",
      async invoke(options: InvokeOptions): Promise<InvokeResult> {
        if (options.role === "generator") {
          generatorPrompts.push(options.prompt);
          writeFileSync(
            join(repo, "change.txt"),
            `${generatorPrompts.length}\n`,
            "utf-8",
          );
          return { exitCode: 0, stdout: "", stats: {} };
        }

        const isUAT = options.prompt.includes("Shared-preview UAT only");
        const prompts = isUAT ? uatPrompts : deterministicPrompts;
        prompts.push(options.prompt);
        const state = prompts.length === 1 ? "OPEN" : "RESOLVED";
        const id = isUAT ? "UAT-OPEN" : "QA-ADVISORY";
        const severity = isUAT ? "BLOCKING" : "ADVISORY";
        if (isUAT) {
          expect(readFileSync(marker, "utf-8")).toBe(
            "verify\napply\n".repeat(uatPrompts.length),
          );
        }
        writeFileSync(
          join(artifactDir, isUAT ? "uat-report.md" : "qa-report.md"),
          `# QA Report\n\n**Verdict:** ${isUAT && state === "OPEN" ? "FAIL" : "PASS"}\n`,
          "utf-8",
        );
        writeQAReview(
          artifactDir,
          isUAT ? "shared-preview" : "deterministic",
          {
            verdict: isUAT && state === "OPEN" ? "FAIL" : "PASS",
            findings: [
              {
                id,
                severity,
                behaviorIds: [],
                summary: `${id} summary`,
                evidence: `${id} evidence`,
                expected: `${id} expected`,
                observed: `${id} observed`,
                clearCondition: `${id} condition`,
                state,
              },
            ],
          },
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

    await expect(runSliceExecute(ctx)).resolves.toEqual({ phase: "PASS" });
    expect(generatorPrompts).toHaveLength(2);
    expect(deterministicPrompts).toHaveLength(2);
    expect(uatPrompts).toHaveLength(2);

    expect(generatorPrompts[1]).toContain("UAT-OPEN");
    expect(generatorPrompts[1]).toContain("UAT-OPEN summary");
    expect(generatorPrompts[1]).toContain("UAT-OPEN condition");
    expect(generatorPrompts[1]).toContain("uat-review-r1-a1.json");
    expect(generatorPrompts[1]).toContain("uat-report-r1-a1.md");
    expect(generatorPrompts[1]).not.toContain("QA-ADVISORY");

    expect(deterministicPrompts[1]).toContain("QA-ADVISORY");
    expect(deterministicPrompts[1]).not.toContain("UAT-OPEN");
    expect(uatPrompts[1]).toContain("UAT-OPEN");
    expect(uatPrompts[1]).not.toContain("QA-ADVISORY");

    expect(existsSync(join(artifactDir, "qa-report-r1-a1.md"))).toBe(true);
    expect(existsSync(join(artifactDir, "qa-report-r2-a1.md"))).toBe(true);
    expect(existsSync(join(artifactDir, "uat-report-r1-a1.md"))).toBe(true);
    expect(existsSync(join(artifactDir, "uat-report-r2-a1.md"))).toBe(true);
    const reviewDir = join(
      repo,
      ".afk",
      "artifacts",
      "prd-070-stub",
      "slice-01",
      "reviews",
    );
    for (const stage of ["qa", "uat"]) {
      for (const round of [1, 2]) {
        expect(
          existsSync(join(reviewDir, `${stage}-review-r${round}-a1.json`)),
        ).toBe(true);
        expect(
          existsSync(
            join(reviewDir, `${stage}-review-r${round}-a1-record.json`),
          ),
        ).toBe(true);
      }
    }
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

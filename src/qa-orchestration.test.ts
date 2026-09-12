import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
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
import * as gitModule from "./git.js";
import * as migrationGate from "./migration-gate.js";
import {
  approvedBaselineFor,
  finalEvaluationAttemptsSpent,
  finalEvaluationFor,
  invalidateFinalEvaluationBaseline,
  loadRunState,
  recordFinalEvaluation,
  saveRunState,
  updateRunState,
} from "./run-state.js";
import {
  POST_APPROVAL_WRITING_STAGE_ID,
  decideFinalReuse,
} from "./final-evaluation.js";
import { MAX_FINAL_EVALUATION_ATTEMPTS } from "./bounds.js";
import { fileURLToPath } from "node:url";
import { resolveCandidateTreeId } from "./gate-runner.js";
import { recordExactStageCheckpoint } from "./exact-stage-resume.js";
import { saveQAConvergenceState } from "./qa-convergence.js";
import { saveNonProgressHistory } from "./non-progress.js";
import {
  EXPECTED_STUCK_DIAGNOSIS,
  seedStuckDiagnosisArchive,
  STUCK_DIAGNOSIS_ADDITIONAL_ARTIFACTS,
  STUCK_DIAGNOSIS_COMMIT_LOG,
  stuckDiagnosisReviewFindings,
} from "./stuck-diagnosis.fixtures.js";
import type { AgentProvider, InvokeOptions, InvokeResult } from "./agent-provider.js";
import { rmDirWithRetry, writeQAReview } from "./test-support.js";

const dirs: string[] = [];
const fixtureChildren = new Set<ChildProcess>();
/**
 * Every path this file's stub generators write into the fixture repository.
 *
 * The post-QA phase now runs the file-scope gate (#195), so a fixture whose
 * generator writes a path its own locked manifest does not declare is a red
 * gate and a REPAIR round — correctly, because that is exactly the defect the
 * gate exists to catch. The fix is to declare the path here, never to narrow
 * the gate: `src/scope-gate.test.ts` owns the negative cases deliberately.
 * Migration paths are absent on purpose — they are exempt by pattern
 * (`src/escalation.ts`) — and so is anything under the slice artifact
 * directory.
 */
const GENERATOR_FIXTURE_SCOPE = [
  "README.md",
  "change.txt",
  "provider-output.txt",
];

const GENERATOR_FIXTURE_CONTRACT = [
  "# Slice Contract",
  "",
  "**Status:** LOCKED",
  "",
  "## Scope lock",
  "Exercise QA orchestration.",
  "",
  "### In scope",
  "- [behavior:B-01] Run the generator before QA.",
  "",
  "### Non-goals (explicit out-of-scope)",
  "- Production behavior.",
  "",
  "### Existing behavior to preserve",
  "- None.",
  "",
  "### Changes to existing behavior (only if the issue asks for it)",
  "- None.",
  "",
  "## New patterns / deps / schema (if any)",
  "- None.",
  "",
  "## Files expected to change",
  ...GENERATOR_FIXTURE_SCOPE.map((path) => `- ${path}`),
  "",
  "## Migration requirements",
  "- New migration files: 0",
  "",
].join("\n");

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

/**
 * Is every id in `expected` present in `actual`, in that relative order?
 *
 * A subsequence match, not an equality: ids may sit anywhere in `actual` as
 * long as they appear in the given order relative to one another.
 */
function declaresInOrder(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  let from = 0;
  for (const id of expected) {
    const at = actual.indexOf(id, from);
    if (at === -1) return false;
    from = at + 1;
  }
  return true;
}

/**
 * The gate-ID expectation every post-QA scenario below shares: the named gates
 * are **present** and in the named **relative order** (#231).
 *
 * Deliberately not exhaustive. These assertions exist to catch a gate that
 * fails to declare itself or declares itself in the wrong position, and
 * containment catches both. Exhaustiveness caught only "a gate was added",
 * which is the intended change of any gate-shipping slice and not a
 * regression — as exact arrays here it turned five assertions red for #86 and
 * #193, forcing an unrelated test file into a slice's `fileScope` both times.
 * No exhaustive gate-ID pin is kept anywhere in this file for that reason; a
 * gate's own declaration is covered by `src/base-gates.test.ts`.
 */
function expectDeclaresInOrder(
  actual: readonly string[],
  expected: readonly string[],
): void {
  expect(
    declaresInOrder(actual, expected),
    `expected gate ids ${JSON.stringify(expected)} present and in that relative order, got ${JSON.stringify(actual)}`,
  ).toBe(true);
}

/**
 * `expectDeclaresInOrder` over a phase's evidence: some one attempt declares
 * the named gates in the named relative order. Attempt ids are random hex, so
 * a scenario's attempts are told apart by what they declare, not by order.
 */
function expectSomeAttemptDeclaresInOrder(
  attempts: readonly (readonly string[])[],
  expected: readonly string[],
): void {
  expect(
    attempts.some((ids) => declaresInOrder(ids, expected)),
    `expected one attempt to declare gate ids ${JSON.stringify(expected)} in that relative order, got ${JSON.stringify(attempts)}`,
  ).toBe(true);
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
  writeFileSync(
    join(absSliceDir, "contract.md"),
    GENERATOR_FIXTURE_CONTRACT,
    "utf-8",
  );
  writeFileSync(
    join(absSliceDir, "acceptance-manifest.json"),
    JSON.stringify({
      version: 2,
      fileScope: { kind: "paths", paths: GENERATOR_FIXTURE_SCOPE },
      migrationCount: 0,
      behaviors: [
        {
          id: "B-01",
          source: "QA orchestration fixture",
          given: "a locked fixture slice",
          when: "the generator runs",
          then: "QA evaluates its candidate",
          observableResult: "the fixture reaches QA",
          preservation: false,
          gateIds: ["tests"],
        },
      ],
    }),
    "utf-8",
  );
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
    // The run's policy, which this fixture declares none of (#251). Never a
    // read of `worktreeDir`: that is the tree the gates judge.
    runGatePolicy: null,
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
    const evaluatorRounds = [2, 3] as const;
    let evaluatorAttempt = 0;
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
          const evaluatorRound = evaluatorRounds[evaluatorAttempt++];
          if (evaluatorRound === undefined) {
            throw new Error("fixture dispatched an unexpected evaluator round");
          }
          writeFileSync(
            join(artifactDir, "qa-report.md"),
            "# QA Report\n\n**Verdict:** FAIL\n**Failure class:** IMPLEMENTATION\n",
            "utf-8",
          );
          writeQAReview(artifactDir, "deterministic", {
            verdict: "FAIL",
            findings: stuckDiagnosisReviewFindings(evaluatorRound),
          });
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
    seedStuckDiagnosisArchive(reviewDir, { rounds: [1] });
    writeFileSync(
      join(artifactDir, "qa-report-r1-a1.md"),
      "# QA Report\n\n**Verdict:** FAIL\n**Failure class:** IMPLEMENTATION\n",
      "utf-8",
    );
    writeFileSync(
      join(artifactDir, "stuck.md"),
      STUCK_DIAGNOSIS_ADDITIONAL_ARTIFACTS.map(
        (path) => `- Additional artifact: \`${path}\``,
      ).join("\n"),
      "utf-8",
    );
    ctx.resume = {
      mode: "killed",
      commitsAhead: 1,
      commitLog: "abc1234 feat(#70): round-1 work",
      handoffNote: "",
    };
    const malformedState = loadRunState(repo, "prd-070");
    malformedState.stageCheckpoints = "malformed";
    saveRunState(repo, malformedState);
    vi.spyOn(gitModule, "logCommitsWithStat").mockReturnValue(
      STUCK_DIAGNOSIS_COMMIT_LOG,
    );

    await expect(runSliceExecute(ctx)).resolves.toMatchObject({
      phase: "STUCK",
      error: expect.stringContaining("EQUIVALENT_REPETITION"),
    });
    // Rounds 2 and 3 only — the fourth implementation round the QA
    // finding demonstrated is not reachable through an ordinary resume.
    expect(roles.filter((role) => role === "generator")).toHaveLength(2);
    expect(roles.filter((role) => role === "evaluator-qa")).toHaveLength(2);
    expect(roles.at(-1)).toBe("evaluator-qa");
    expect(generatorPrompts[1]).toContain("Implementation round: 3 of 3.");
    expect(existsSync(join(artifactDir, "qa-report-r2-a1.md"))).toBe(true);
    expect(existsSync(join(artifactDir, "qa-report-r3-a1.md"))).toBe(true);
    expect(existsSync(join(artifactDir, "qa-report-r4-a1.md"))).toBe(false);
    expect(existsSync(join(reviewDir, "qa-review-r4-a1.json"))).toBe(false);
    const diagnosis = readFileSync(join(artifactDir, "stuck.md"), "utf-8");
    expect(diagnosis).toContain("EQUIVALENT_REPETITION");
    expect(diagnosis).toContain("intervention.json");
    expect(diagnosis).toContain("Round 3 attempt 1 (deterministic)");
    expect(diagnosis).toContain(STUCK_DIAGNOSIS_COMMIT_LOG);
    expect(diagnosis).not.toContain("Best guess");
    expect(diagnosis).not.toContain(
      "SYNTHESIS-SHOULD-NOT-APPEAR",
    );
    expect(
      readFileSync(join(ctx.logger.runDir, "run.log"), "utf-8"),
    ).toContain(
      "exact-stage resume unavailable — the exact-stage checkpoint collection is malformed; " +
        "candidate preserved, falling back to normal re-evaluation",
    );

    const rolesAfterExhaustion = [...roles];
    rmSync(join(artifactDir, "stuck.md"));
    recordExactStageCheckpoint(
      { repoRoot: repo, prdSlug: "prd-070", ghIssue: "70" },
      {
        version: 1,
        completedStage: "deterministic-qa",
        candidateTreeId: "b".repeat(40),
        nextPendingStage: "post-qa-deterministic",
        round: 3,
      },
    );

    await expect(runSliceExecute(ctx)).resolves.toMatchObject({
      phase: "STUCK",
      error: expect.stringContaining(
        "AFK exhausted 0 implementation attempt(s) without an accepted candidate",
      ),
    });
    expect(roles).toEqual(rolesAfterExhaustion);
    expect(
      readFileSync(join(ctx.logger.runDir, "run.log"), "utf-8"),
    ).toContain(
      `does not match recorded tree ${"b".repeat(40)}; candidate preserved, ` +
        "falling back to normal re-evaluation",
    );
    expect(loadRunState(repo, "prd-070").stageCheckpoints).toBeUndefined();
    const exhausted = JSON.parse(
      readFileSync(join(artifactDir, "intervention.json"), "utf-8"),
    );
    expect(exhausted).toMatchObject({
      cause: {
        kind: "QA_CONVERGENCE",
        interventionClass: "IMPLEMENTATION_INTERVENTION",
      },
      reasonCodes: ["SEMANTIC_CAP_EXHAUSTED"],
      blockerIds: expect.arrayContaining(["QA-BETA"]),
      findingLineage: expect.arrayContaining([
        expect.objectContaining({
          currentId: "QA-BETA",
          artifactReferences: expect.any(Array),
        }),
      ]),
      attemptedRepairs: expect.arrayContaining([
        expect.objectContaining({
          phase: "deterministic-qa",
          activeBlockingIds: expect.arrayContaining(["QA-BETA"]),
          findingLineage: expect.arrayContaining([
            expect.objectContaining({
              currentId: "QA-BETA",
              state: "OPEN",
              evidence: expect.any(String),
            }),
          ]),
          supportingEvidence: expect.any(Array),
        }),
      ]),
      supportingEvidence: expect.any(Array),
      preservedCandidate: {
        recoveryRef: expect.stringContaining("refs/afk/recovery/"),
        recoveryCommit: expect.stringMatching(/^[0-9a-f]{40}$/),
      },
    });
    expect(exhausted.supportingEvidence.length).toBeGreaterThan(0);
    expect(exhausted.attemptedRepairs[0].supportingEvidence.length)
      .toBeGreaterThan(0);
    expect(readFileSync(join(artifactDir, "stuck.md"), "utf-8")).toContain(
      "Round 3 attempt 1 (deterministic): FAIL / IMPLEMENTATION",
    );
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
          // Keep the command alive beyond the inactivity limit while emitting
          // frequent output. Five seconds leaves enough scheduler margin for
          // this heavy suite on loaded Windows runners.
          test: "node -e \"let ticks=0; const timer=setInterval(()=>console.log(++ticks),50); setTimeout(()=>clearInterval(timer),6500)\"",
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
      commandTimeoutMs: 5_000,
      heartbeatIntervalMs: 20,
    });
    artifactDir = ctx.absSliceDir;

    await expect(runSliceExecute(ctx)).resolves.toEqual({ phase: "PASS" });
    expect(evaluators).toBe(1);
  });

  // The pre-QA/post-QA split itself is what this scenario proves, so it is the
  // test #86's P-03 is named on rather than a second spawned run of the same
  // shape (`CLAUDE.md`, "Where a new assertion goes").
  it("[behavior:P-03] [behavior:B-06] records checkpoint evidence, authorizes QA for the passing tree, and establishes its approved baseline", async () => {
    const repo = makeRepo();
    // Outside the repo: the evaluator stub and gate scripts append to it,
    // and an in-repo marker would (correctly) trip the A1 tree-authority
    // guard — evaluators must not mutate the candidate tree.
    const sequencePath = `${repo}-gate-sequence.txt`.replace(/\\/g, "/");
    const cheapScript =
      `node -e "require('fs').appendFileSync('${sequencePath}','cheap\\n')"`;
    const fullSuiteScript =
      `node -e "require('fs').appendFileSync('${sequencePath}','full\\n')"`;
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({
        name: "gate-fixture",
        scripts: { typecheck: cheapScript, test: fullSuiteScript },
      }),
      "utf-8",
    );
    git(repo, ["add", "package.json"]);
    git(repo, ["commit", "-m", "add gate scripts"]);

    let generators = 0;
    let evaluators = 0;
    let artifactDir = "";
    const evaluatorPrompts: string[] = [];
    const provider: AgentProvider = {
      name: "stub",
      async invoke(options: InvokeOptions): Promise<InvokeResult> {
        if (options.role === "generator") {
          generators++;
        } else if (options.role === "evaluator-qa") {
          evaluators++;
          evaluatorPrompts.push(options.prompt);
          appendFileSync(sequencePath, "qa\n", "utf-8");
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
    expect(generators).toBe(1);
    expect(evaluators).toBe(1);
    expect(readFileSync(sequencePath, "utf-8")).toBe(
      "cheap\nqa\nfull\n",
    );

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
    const attemptGateIds = attempts.map((attempt) =>
      attempt.results.map((gate: { gateId: string }) => gate.gateId),
    );
    expectSomeAttemptDeclaresInOrder(attemptGateIds, ["typecheck", "lint"]);
    // The post-QA phase declares the two content-derived gates ahead of the
    // full suite (#195 AC1; #86 B-06), so the second attempt carries all
    // three.
    expectSomeAttemptDeclaresInOrder(attemptGateIds, [
      "scope",
      "tests:skipped",
      "tests",
    ]);
    expect(
      attempts.some(
        (attempt) =>
          attempt.results.some(
            (gate: { gateId: string; status: string }) =>
              gate.gateId === "tests" && gate.status === "PASS",
          ),
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
    const qaPrompt = evaluatorPrompts[0] ?? "";
    const passingIndex = attempts.findIndex((attempt) =>
      qaPrompt.includes(attempt.attemptId),
    );
    expect(passingIndex).toBeGreaterThanOrEqual(0);
    const passingAttempt = attempts[passingIndex];
    expect(qaPrompt).toContain("Skip authorization");
    expect(qaPrompt).toContain(`\`${passingAttempt.treeId}\``);
    expect(qaPrompt).toContain(`\`${passingAttempt.attemptId}\``);
    // Candidate QA is authorized only for the cheap phase. The full suite has
    // not run yet and must never appear in its citation.
    expect(qaPrompt).toContain("- typecheck — `pnpm run typecheck` — PASS at");
    expect(qaPrompt).not.toContain("- tests —");
    expect(qaPrompt).not.toContain("- lint —");
    expect(qaPrompt).toContain("Git tree ID under review");
    expect(qaPrompt).toContain("`git rev-parse HEAD`");

    const record = JSON.parse(
      readFileSync(
        join(
          repo,
          ".afk",
          "artifacts",
          "prd-070-stub",
          "slice-01",
          "reviews",
          "qa-review-r1-a1-record.json",
        ),
        "utf-8",
      ),
    );
    const recordedPrompt = evaluatorPrompts[0] ?? "";
    const recordedIndex = attempts.findIndex((attempt) =>
      recordedPrompt.includes(attempt.attemptId),
    );
    expect(recordedIndex).toBeGreaterThanOrEqual(0);
    const recordedAttempt = attempts[recordedIndex];
    expect(record.baseGateCitation).toEqual({
      evidenceArtifactId: relative(
        repo,
        join(evidenceDir, evidenceFiles[recordedIndex]!),
      ).replace(/\\/g, "/"),
      attemptId: recordedAttempt.attemptId,
      treeId: recordedAttempt.treeId,
      gateIds: ["typecheck"],
    });

    // B-06, asserted on this scenario because it is the only fixture that
    // already reaches a deterministic PASS over real green gates — which is
    // exactly the moment a baseline is established (#91 AC5).
    const baselinePath = join(
      repo,
      ".afk",
      "artifacts",
      "prd-070-stub",
      "slice-01",
      "approved-baseline.json",
    );
    const baseline = JSON.parse(readFileSync(baselinePath, "utf-8"));
    const qaTreeId = attempts[passingIndex].treeId;
    expect(baseline).toMatchObject({
      version: 1,
      ghIssue: "70",
      sliceNumber: "01",
      round: 1,
      treeId: qaTreeId,
    });
    // The commit holds the graded tree, and the pair's bytes are recorded by
    // blob ID rather than by path.
    expect(
      execFileSync("git", ["rev-parse", `${baseline.commit}^{tree}`], {
        cwd: repo,
        encoding: "utf-8",
      }).trim(),
    ).toBe(qaTreeId);
    expect(Object.keys(baseline.contractBlobs).sort()).toEqual([
      "specs/slices/01-prd-070-regression/acceptance-manifest.json",
      "specs/slices/01-prd-070-regression/contract.md",
    ]);
    for (const [path, blobId] of Object.entries(baseline.contractBlobs)) {
      expect(blobId).toBe(gitModule.hashFileAsBlob(repo, path));
    }
    // Only evidence about this tree, and it names files that exist.
    expect(baseline.gateEvidenceArtifactIds.length).toBeGreaterThan(0);
    for (const artifactId of baseline.gateEvidenceArtifactIds) {
      expect(existsSync(join(repo, artifactId))).toBe(true);
    }
    // Run state is a locator; the artifact is canonical.
    const state = loadRunState(repo, "prd-070");
    // #96 P-06: the additive finalEvaluations record bumps the version; the
    // #91 baseline locator below still loads unchanged.
    expect(state.version).toBe(5);
    expect(state.approvedBaselines?.["70"]).toEqual({
      treeId: baseline.treeId,
      commit: baseline.commit,
      artifactPath: ".afk/artifacts/prd-070-stub/slice-01/approved-baseline.json",
    });
    const baselineEvents = readFileSync(
      join(ctx.logger.runDir, "events.jsonl"),
      "utf-8",
    )
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line))
      .filter((event) => event.type === "approved-baseline");
    expect(baselineEvents).toHaveLength(1);
    expect(baselineEvents[0]).toMatchObject({
      ghIssue: "70",
      sliceNumber: "01",
      round: 1,
      treeId: baseline.treeId,
      commit: baseline.commit,
      artifactId: ".afk/artifacts/prd-070-stub/slice-01/approved-baseline.json",
    });
  });

  it("[behavior:P-01] emits typed evidence when a resumed final-round checkpoint gate exhausts, with no evaluator dispatched", async () => {
    const repo = makeRepo();
    const sequencePath = join(repo, "gate-sequence.txt").replace(/\\/g, "/");
    const cheapScript =
      `node -e "require('fs').appendFileSync('${sequencePath}','cheap\\n'); process.exit(23)"`;
    const fullSuiteScript =
      `node -e "require('fs').appendFileSync('${sequencePath}','full\\n')"`;
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({
        name: "gate-fixture",
        scripts: { typecheck: cheapScript, test: fullSuiteScript },
      }),
      "utf-8",
    );
    git(repo, ["add", "package.json"]);
    git(repo, ["commit", "-m", "add failing gate scripts"]);

    let generators = 0;
    let evaluators = 0;
    let artifactDir = "";
    const provider: AgentProvider = {
      name: "stub",
      async invoke(options: InvokeOptions): Promise<InvokeResult> {
        if (options.role === "generator") {
          generators++;
        } else if (options.role === "evaluator-qa") {
          evaluators++;
          appendFileSync(sequencePath, "qa\n", "utf-8");
          writeFileSync(
            join(artifactDir, "qa-report.md"),
            "# QA Report\n\n**Verdict:** PASS\n**Failure class:** NONE\n",
            "utf-8",
          );
          writeQAReview(artifactDir, "deterministic", {
            findings: [
              {
                id: "QA-PRIOR",
                severity: "BLOCKING",
                behaviorIds: ["B-PRIOR"],
                summary: "Prior QA behavior regressed",
                evidence: "The prior semantic assertion now passes",
                expected: "The prior behavior remains fixed",
                observed: "The prior behavior remains fixed",
                clearCondition: "The prior semantic assertion passes",
                state: "RESOLVED",
              },
            ],
          });
        }
        return { exitCode: 0, stdout: "", stats: {} };
      },
    };
    const ctx = makeContext(repo, provider, {
      commandTimeoutMs: 5_000,
      heartbeatIntervalMs: 20,
    });
    artifactDir = ctx.absSliceDir;
    const reviewDir = join(
      repo,
      ".afk",
      "artifacts",
      "prd-070-stub",
      "slice-01",
      "reviews",
    );
    seedStuckDiagnosisArchive(reviewDir, {
      rounds: [1, 2],
      includeEscalation: false,
    });
    ctx.resume = {
      mode: "killed",
      commitsAhead: 1,
      commitLog: "abc1234 feat(#70): prior work",
      handoffNote: "",
    };

    // Persist semantic lineage from the candidate's prior life. Starting at
    // round three exercises the real terminal orchestration path with one
    // remaining repair instead of replaying two already-completed rounds.
    const priorTreeId = resolveCandidateTreeId(repo);
    const priorArtifact =
      ".afk/artifacts/prd-070-stub/slice-01/reviews/qa-review-prior.json";
    const priorReport =
      "specs/slices/01-prd-070-regression/qa-report-prior.md";
    saveQAConvergenceState(
      { repoRoot: repo, prdSlug: "prd-070", ghIssue: "70" },
      {
        version: 1,
        extensionUsed: false,
        revision: 1,
        findings: {
          "deterministic:QA-PRIOR": {
            stableId: "QA-PRIOR",
            currentId: "QA-PRIOR",
            stage: "deterministic",
            disposition: "REGRESSED",
            firstSeenRevision: 1,
            lastSeenRevision: 1,
            occurrences: 2,
            candidateTreeId: priorTreeId,
            finding: {
              id: "QA-PRIOR",
              severity: "BLOCKING",
              behaviorIds: ["B-PRIOR"],
              summary: "Prior QA behavior regressed",
              evidence: "The prior semantic assertion failed",
              expected: "The prior behavior remains fixed",
              observed: "The prior behavior regressed",
              clearCondition: "The prior semantic assertion passes",
              state: "OPEN",
              remedy: "SOURCE_CHANGE",
              amendmentPaths: [],
            },
            artifactReferences: [priorArtifact, priorReport],
          },
        },
      },
    );
    saveNonProgressHistory(
      { repoRoot: repo, prdSlug: "prd-070", ghIssue: "70" },
      {
        version: 1,
        observations: [
          {
            cause: {
              kind: "QA_CONVERGENCE",
              interventionClass: "IMPLEMENTATION_INTERVENTION",
            },
            phase: "deterministic-qa",
            revision: 1,
            candidate: {
              branch: "main",
              treeId: priorTreeId,
              phase: "deterministic-qa",
              revision: 1,
            },
            activeBlockingIds: ["QA-PRIOR"],
            repeatedBlockingIds: [],
            reopenedWithoutNewEvidenceIds: [],
            regressedBlockingIds: ["QA-PRIOR"],
            findings: [
              {
                stableId: "QA-PRIOR",
                currentId: "QA-PRIOR",
                state: "OPEN",
                disposition: "REGRESSED",
                occurrences: 2,
                summary: "Prior QA behavior regressed",
                evidence: "The prior semantic assertion failed",
                clearCondition: "The prior semantic assertion passes",
                artifactReferences: [priorArtifact, priorReport],
              },
            ],
            supportingEvidence: ["semantic-evidence:prior-qa"],
          },
        ],
      },
    );
    await expect(runSliceExecute(ctx)).resolves.toMatchObject({
      phase: "STUCK",
      error: expect.stringContaining(
        "AFK exhausted deterministic base-gate repair capacity",
      ),
    });
    expect(generators).toBe(1);
    expect(evaluators).toBe(0);
    expect(readFileSync(sequencePath, "utf-8")).toBe("cheap\n");
    // P-01: a red *required* pre-QA gate is the cheap wall in front of the
    // evaluator. The candidate never reaches a review worktree, so nothing
    // charges an evaluation round and no isolation machinery runs for it —
    // the repair path is still the generator's. (`evaluators` is the round
    // ledger for *this* run; the progress counters additionally carry the
    // seeded prior life this resume starts from.)
    expect(
      existsSync(
        join(
          repo,
          ".afk",
          "artifacts",
          "prd-070-stub",
          "slice-01",
          "change-summary.json",
        ),
      ),
    ).toBe(false);
    expect(
      execFileSync("git", ["worktree", "list"], {
        cwd: repo,
        encoding: "utf-8",
      }),
    ).not.toContain("qa-review");
    const intervention = JSON.parse(
      readFileSync(join(artifactDir, "intervention.json"), "utf-8"),
    );
    expect(intervention).toMatchObject({
      cause: {
        kind: "DETERMINISTIC_GATE_EXHAUSTION",
        interventionClass: "IMPLEMENTATION_INTERVENTION",
      },
      reasonCodes: ["DETERMINISTIC_GATE_EXHAUSTED"],
      blockerIds: expect.arrayContaining(["QA-PRIOR", "typecheck"]),
      findingLineage: expect.arrayContaining([
        expect.objectContaining({
          currentId: "QA-PRIOR",
          disposition: "REGRESSED",
          artifactReferences: [priorArtifact, priorReport],
        }),
      ]),
      attemptedRepairs: expect.arrayContaining([
        expect.objectContaining({
          candidateTreeId: priorTreeId,
          activeBlockingIds: ["QA-PRIOR"],
        }),
        expect.objectContaining({
          phase: "deterministic-qa",
          activeBlockingIds: ["typecheck"],
        }),
      ]),
      supportingEvidence: expect.arrayContaining([
        expect.stringMatching(/attempt-[\w]+\.json/),
        expect.stringMatching(/typecheck\.log/),
        priorArtifact,
        priorReport,
        "semantic-evidence:prior-qa",
      ]),
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

  /**
   * ADR 0055 P1: `finishStuck` is the only constructor of a STUCK return
   * in `runSliceExecute`, so every STUCK outcome ships a diagnosis. The
   * migration-sync branch is the one that used to return STUCK inline and
   * so shipped no `stuck.md` at all.
   *
   * New spawned scenario, deliberately: no existing fixture reaches the
   * post-commit migration gate (the default validation mode is `skip`),
   * and the state under test is exactly that late one — QA has passed and
   * the work is already committed when the gate refuses. Kept to the
   * cheapest shape that gets there: one generator round, one PASS review,
   * no package.json so no gate subprocess.
   */
  it("resumes the pending post-QA deterministic gate without another agent round", async () => {
    const repo = makeRepo();
    // The feature branch sits behind the slice's work, which is what makes
    // the migration diff — and the commit evidence in the diagnosis —
    // non-empty. `makeContext` otherwise runs the slice on `main` itself.
    git(repo, ["branch", "base", "main"]);
    const migration = join("supabase", "migrations", "001_orders.sql");
    let artifactDir = "";
    let generators = 0;
    let evaluators = 0;
    const provider: AgentProvider = {
      name: "stub",
      async invoke(options: InvokeOptions): Promise<InvokeResult> {
        if (options.role === "generator") {
          generators++;
          mkdirSync(join(repo, "supabase", "migrations"), { recursive: true });
          writeFileSync(join(repo, migration), "-- orders\n", "utf-8");
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
    const ctx = {
      ...makeContext(repo, provider, { migrationValidation: "linked" }),
      featBranch: "base",
    };
    artifactDir = ctx.absSliceDir;
    let migrationAttempts = 0;
    vi.spyOn(migrationGate, "verifyMigrationSync").mockImplementation(() => {
      migrationAttempts++;
      if (migrationAttempts === 1) {
        throw new Error(
          "simulated process death after accepted QA and before the deterministic gate",
        );
      }
      return {
        ok: false,
        error: "local migrations not applied to remote: 001",
      };
    });

    await expect(runSliceExecute(ctx)).resolves.toEqual({
      phase: "ERROR",
      error:
        "simulated process death after accepted QA and before the deterministic gate",
    });
    expect(generators).toBe(1);
    expect(evaluators).toBe(1);
    expect(migrationAttempts).toBe(1);
    expect(loadRunState(repo, "prd-070").stageCheckpoints).toMatchObject({
      "70": {
        completedStage: "deterministic-qa",
        candidateTreeId: resolveCandidateTreeId(repo),
        nextPendingStage: "post-qa-deterministic",
        round: 1,
      },
    });
    const progressBeforeResume = ctx.logger.getSliceProgress("70");

    ctx.resume = {
      mode: "killed",
      commitsAhead: 1,
      commitLog: "accepted candidate",
      handoffNote: "",
    };
    await expect(runSliceExecute(ctx)).resolves.toMatchObject({
      phase: "STUCK",
      error: expect.stringContaining(
        "Migration sync check failed: local migrations not applied to remote: 001",
      ),
    });
    expect(migrationAttempts).toBe(2);
    expect(generators).toBe(1);
    expect(evaluators).toBe(1);
    expect(ctx.logger.getSliceProgress("70")).toEqual(progressBeforeResume);
    expect(loadRunState(repo, "prd-070").stageCheckpoints).toBeUndefined();
    const recovery = JSON.parse(
      readFileSync(join(artifactDir, "intervention.json"), "utf-8"),
    );
    expect(recovery).toMatchObject({
      cause: {
        kind: "CHECKPOINT_RECOVERY",
        interventionClass: "RECOVERY_ACTION",
      },
      interventionClass: "RECOVERY_ACTION",
      blockerIds: ["post-qa-deterministic"],
      attemptedRepairs: [
        expect.objectContaining({
          phase: "deterministic-qa",
          activeBlockingIds: ["post-qa-deterministic"],
        }),
      ],
      supportingEvidence: expect.arrayContaining([
        expect.stringMatching(/^candidate-tree:[0-9a-f]{40}$/),
        "pending-stage:post-qa-deterministic",
        "pending-stage-error:Migration sync check failed: local migrations not applied to remote: 001",
      ]),
      preservedCandidate: {
        recoveryRef: expect.stringContaining("refs/afk/recovery/"),
        recoveryCommit: expect.stringMatching(/^[0-9a-f]{40}$/),
      },
    });

    // The resumed deterministic failure still carries the existing
    // diagnosis and exact quality-gate behavior.
    const diagnosis = readFileSync(join(artifactDir, "stuck.md"), "utf-8");
    expect(diagnosis).toContain(
      "Migration sync check failed: local migrations not applied to remote: 001",
    );
    expect(diagnosis).not.toContain("implementation rounds");
    // The gate runs after the commit, so the diagnosis has to describe a
    // slice whose work is already on the branch — and it does: the commit
    // evidence names it.
    const tracked = execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD"], {
      cwd: repo,
      encoding: "utf-8",
    });
    expect(tracked).toContain("supabase/migrations/001_orders.sql");
    expect(diagnosis).toContain("feat(#70): PRD 070 regression");
  });

  it("routes compact lineage and grants one final repair for a fresh round-three blocker", async () => {
    const repo = makeRepo();
    // Outside the repo — an in-repo evaluator marker would (correctly)
    // trip the A1 tree-authority guard.
    const sequencePath = `${repo}-qa-sequence.txt`.replace(/\\/g, "/");
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({
        name: "qa-sequencing-fixture",
        scripts: {
          test:
            `node -e "require('fs').appendFileSync('${sequencePath}','full\\n')"`,
        },
      }),
      "utf-8",
    );
    git(repo, ["add", "package.json"]);
    git(repo, ["commit", "-m", "add full-suite marker"]);
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
          appendFileSync(sequencePath, "qa\n", "utf-8");
          const round = evaluatorPrompts.length;
          writeFileSync(
            join(artifactDir, "qa-report.md"),
            `# QA Report\n\n**Verdict:** ${round === 4 ? "PASS" : "FAIL"}\n`,
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
                    "QA-01",
                    "BLOCKING",
                    "First blocker",
                    "First condition",
                  ),
                  finding(
                    "QA-02",
                    "BLOCKING",
                    "Second blocker",
                    "Second condition",
                  ),
                ]
              : round === 2
                ? [
                    finding(
                      "QA-01",
                      "BLOCKING",
                      "First blocker",
                      "First condition",
                      "RESOLVED",
                    ),
                    finding(
                      "QA-02",
                      "BLOCKING",
                      "Second blocker",
                      "Second condition",
                    ),
                  ]
                : round === 3
                  ? [
                    finding(
                      "QA-02",
                      "BLOCKING",
                      "Second blocker",
                      "Second condition",
                      "RESOLVED",
                    ),
                    finding(
                      "QA-03",
                      "BLOCKING",
                      "Fresh late blocker",
                      "Fresh late condition",
                    ),
                  ]
                  : [
                      finding(
                        "QA-03",
                        "BLOCKING",
                        "Fresh late blocker",
                        "Fresh late condition",
                        "RESOLVED",
                      ),
                    ];
          writeQAReview(artifactDir, "deterministic", {
            verdict: round === 4 ? "PASS" : "FAIL",
            findings,
          });
        }
        return { exitCode: 0, stdout: "", stats: {} };
      },
    };
    const ctx = makeContext(repo, provider);
    artifactDir = ctx.absSliceDir;

    await expect(runSliceExecute(ctx)).resolves.toEqual({ phase: "PASS" });
    expect(generatorPrompts).toHaveLength(4);
    expect(evaluatorPrompts).toHaveLength(4);

    // Repair prompts carry QA-finding content in exactly one place: the
    // compact failure set (finding ID + clear condition + report
    // references), rendered as the prompt's final block. Summaries and any
    // second finding block are absent (guardian round 2, PM 2).
    expect(generatorPrompts[1]).toContain("# Current failure set");
    expect(generatorPrompts[1]).toContain("Finding ID: `QA-01`");
    expect(generatorPrompts[1]).toContain("First condition");
    expect(generatorPrompts[1]).not.toContain("First blocker");
    expect(generatorPrompts[1]).toContain("Finding ID: `QA-02`");
    expect(generatorPrompts[1]).toContain("Second condition");
    expect(generatorPrompts[1]).not.toContain("Second blocker");
    expect(generatorPrompts[1]).not.toContain("Current open QA findings");
    expect(generatorPrompts[1]).toContain("qa-review-r1-a1.json");
    expect(generatorPrompts[1]).toContain("qa-report-r1-a1.md");

    expect(evaluatorPrompts[1]).toContain("QA-01");
    expect(evaluatorPrompts[1]).toContain("QA-02");
    expect(evaluatorPrompts[1]).toContain("qa-review-r1-a1.json");
    expect(evaluatorPrompts[1]).toContain("qa-report-r1-a1.md");

    expect(generatorPrompts[2]).toContain("# Current failure set");
    expect(generatorPrompts[2]).toContain("Finding ID: `QA-02`");
    expect(generatorPrompts[2]).toContain("Second condition");
    expect(generatorPrompts[2]).not.toContain("Current open QA findings");
    expect(generatorPrompts[2]).not.toContain("Relevant resolved QA findings");
    expect(generatorPrompts[2]).not.toContain("Finding ID: `QA-01`");
    expect(generatorPrompts[2]).not.toContain("First blocker");
    expect(generatorPrompts[2]).not.toContain("Second blocker");
    expect(generatorPrompts[2]).not.toContain("qa-review-r1-a1.json");
    expect(generatorPrompts[2]).toContain("qa-review-r2-a1.json");
    expect(generatorPrompts[2]).toContain("qa-report-r2-a1.md");

    expect(evaluatorPrompts[2]).not.toContain("Finding ID: `QA-01`");
    expect(evaluatorPrompts[2]).toContain("QA-02");
    expect(evaluatorPrompts[2]).toContain("qa-review-r2-a1.json");
    expect(evaluatorPrompts[2]).toContain("qa-report-r2-a1.md");
    expect(evaluatorPrompts[2]).not.toContain("qa-review-r1-a1.json");
    expect(evaluatorPrompts[2]).not.toContain("qa-report-r1-a1.md");

    expect(generatorPrompts[3]).toContain("# Current failure set");
    expect(generatorPrompts[3]).toContain("Finding ID: `QA-03`");
    expect(generatorPrompts[3]).toContain("Fresh late condition");
    expect(generatorPrompts[3]).not.toContain("Fresh late blocker");
    expect(generatorPrompts[3]).not.toContain("Current open QA findings");
    expect(generatorPrompts[3]).not.toContain("Relevant resolved QA findings");
    expect(generatorPrompts[3]).not.toContain("Finding ID: `QA-01`");
    expect(generatorPrompts[3]).not.toContain("Finding ID: `QA-02`");
    expect(generatorPrompts[3]).not.toContain("First blocker");
    expect(generatorPrompts[3]).not.toContain("Second blocker");
    expect(generatorPrompts[3]).toContain("qa-review-r3-a1.json");
    expect(generatorPrompts[3]).not.toContain("qa-review-r1-a1.json");

    expect(evaluatorPrompts[3]).toContain("QA-03");
    expect(evaluatorPrompts[3]).not.toContain("Finding ID: `QA-01`");
    expect(evaluatorPrompts[3]).not.toContain("Finding ID: `QA-02`");
    expect(evaluatorPrompts[3]).toContain("qa-review-r3-a1.json");

    const persisted = loadRunState(repo, "prd-070").qaConvergence as {
      "70": { extensionUsed: boolean; revision: number };
    };
    expect(persisted["70"]).toMatchObject({
      extensionUsed: true,
      revision: 4,
    });
  });

  /**
   * Reuses the existing non-progress runSliceExecute scenario. Three rounds
   * are necessary to observe A-B-A state oscillation; renaming the reopened
   * finding in that same third round also proves regression growth without a
   * second spawned pipeline fixture.
   */
  it("stops QA on oscillation and regression growth in one existing scenario", async () => {
    const repo = makeRepo();
    let artifactDir = "";
    let generators = 0;
    let evaluators = 0;
    const provider: AgentProvider = {
      name: "stub",
      async invoke(options: InvokeOptions): Promise<InvokeResult> {
        if (options.role === "generator") {
          generators++;
          writeFileSync(
            join(repo, "change.txt"),
            `${generators}\n`,
            "utf-8",
          );
        } else if (options.role === "evaluator-qa") {
          evaluators++;
          writeFileSync(
            join(artifactDir, "qa-report.md"),
            "# QA Report\n\n**Verdict:** FAIL\n",
            "utf-8",
          );
          const cycle = {
            id: evaluators === 3 ? "QA-CYCLE-RENAMED" : "QA-CYCLE",
            severity: "BLOCKING" as const,
            behaviorIds: ["B-CYCLE"],
            summary: "The cycling blocker",
            evidence: "src/change.ts alternates behavior",
            expected: "The value remains correct",
            observed: "The value regressed",
            clearCondition: "The focused behavior test remains green",
            state: (evaluators === 2 ? "RESOLVED" : "OPEN") as
              | "OPEN"
              | "RESOLVED",
          };
          const next = {
            id: "QA-NEXT",
            severity: "BLOCKING" as const,
            behaviorIds: ["B-NEXT"],
            summary: "The next blocker",
            evidence: "src/change.ts has a second issue",
            expected: "The second behavior is correct",
            observed: "The second behavior is wrong",
            clearCondition: "The second focused test remains green",
            state: (evaluators === 2 ? "OPEN" : "RESOLVED") as
              | "OPEN"
              | "RESOLVED",
          };
          writeQAReview(artifactDir, "deterministic", {
            verdict: "FAIL",
            findings: evaluators === 1 ? [cycle] : [cycle, next],
          });
        }
        return { exitCode: 0, stdout: "", stats: {} };
      },
    };
    const ctx = makeContext(repo, provider);
    artifactDir = ctx.absSliceDir;

    const result = await runSliceExecute(ctx);

    expect(result.phase).toBe("STUCK");
    expect(result).toMatchObject({
      error: expect.stringContaining("OSCILLATION"),
    });
    expect(generators).toBe(3);
    expect(evaluators).toBe(3);
    const intervention = JSON.parse(
      readFileSync(join(artifactDir, "intervention.json"), "utf-8"),
    );
    expect(intervention).toMatchObject({
      version: 1,
      interventionClass: "IMPLEMENTATION_INTERVENTION",
      phase: "deterministic-qa",
      reasonCodes: ["OSCILLATION", "REGRESSION_GROWTH"],
      blockerIds: ["QA-CYCLE-RENAMED"],
      preservedCandidate: {
        branch: "main",
        recoveryRef: expect.stringContaining("refs/afk/recovery/"),
        recoveryCommit: expect.stringMatching(/^[0-9a-f]{40}$/),
      },
    });
    expect(intervention.preservedCandidate.recoveryRef).toContain(
      `-r${intervention.preservedCandidate.revision}-` +
        intervention.preservedCandidate.treeId,
    );
    expect(intervention.attemptedRepairs).toHaveLength(3);
    expect(intervention.requiredOperatorAction).toContain(
      "QA-CYCLE-RENAMED",
    );
    const diagnosis = readFileSync(join(artifactDir, "stuck.md"), "utf-8");
    expect(diagnosis).toContain("intervention.json");
    expect(diagnosis).not.toContain(
      "QA failed after 3 implementation rounds",
    );
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

  /**
   * The post-QA transition with a candidate that never escalated at all.
   *
   * A spawned run, and one shared by both assertions below: the claim is
   * about the *order* of the post-QA declarations, the decision the phase
   * derives from them, and what the next generator round is told — and none
   * of that exists outside a run that reaches the post-QA transition. The
   * comparison itself is unit-tested in `src/scope-gate.test.ts` and the
   * amendment door is the `describe` above; this is the one thing neither can
   * carry. Two rounds rather than three: round 1 smuggles an undeclared path
   * and round 2 reverts it, so the run also shows what a repaired candidate
   * does, at the cost of one extra (empty) suite run.
   */
  describe("a red file-scope gate at the post-QA transition", () => {
    const SMUGGLED = "src/smuggled.ts";
    let phase: unknown;
    let generatorRounds = 0;
    let evaluators = 0;
    let finalAcceptedCommits = 0;
    let qaReportKept = false;
    /** Accepted slice commits visible at each generator dispatch. */
    const acceptedCommitsAtDispatch: number[] = [];
    let generatorPrompts: string[] = [];
    let scopeGateLogs: string[] = [];
    let postQaAttempts: Array<{
      results: Array<{
        gateId: string;
        status: string;
        failureKind: string | null;
        detail?: string;
        findings?: { outOfScopePaths?: string[] };
      }>;
    }> = [];

    const acceptedCommits = (cwd: string): number =>
      execFileSync("git", ["log", "--oneline", "--grep=feat(#70)", "--fixed-strings"], {
        cwd,
        encoding: "utf-8",
      })
        .split(/\r?\n/)
        .filter((line) => line.trim() !== "").length;

    // One run, several assertions, and every fact read off disk *inside* the
    // hook: the shared `afterEach` removes the fixture repository, so the
    // `it`s below read captured values rather than the filesystem.
    beforeAll(async () => {
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const repo = makeRepo();
      // A real `tests` command, so "the remaining declarations still run"
      // means a command actually ran rather than a declaration being skipped.
      writeFileSync(
        join(repo, "package.json"),
        JSON.stringify({
          name: "scope-gate-fixture",
          private: true,
          scripts: { "test:run": "node -e \"process.exit(0)\"" },
        }),
        "utf-8",
      );
      git(repo, ["add", "package.json"]);
      git(repo, ["commit", "-m", "add a test script"]);
      generatorPrompts = [];
      let artifactDir = "";
      const provider: AgentProvider = {
        name: "stub",
        async invoke(options: InvokeOptions): Promise<InvokeResult> {
          if (options.role === "generator") {
            generatorRounds++;
            generatorPrompts.push(options.prompt);
            acceptedCommitsAtDispatch.push(acceptedCommits(repo));
            mkdirSync(join(repo, "src"), { recursive: true });
            if (generatorRounds === 1) {
              // Never declared, never escalated: the shape ADR 0048 refuses
              // to reconcile.
              writeFileSync(
                join(repo, SMUGGLED),
                "export const smuggled = 1;\n",
                "utf-8",
              );
            } else {
              rmSync(join(repo, SMUGGLED), { force: true });
            }
            writeFileSync(
              join(repo, "change.txt"),
              `round ${generatorRounds}\n`,
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
        infrastructureRetries: 0,
      });
      artifactDir = ctx.absSliceDir;
      // The shared context runs the slice on `main`, which is also its feature
      // branch — a base its candidate can never differ from, so a file-scope
      // comparison against it is empty by construction. This gate is about
      // exactly that difference, so the fixture cuts a real slice branch.
      git(repo, ["checkout", "-b", "slice-01"]);
      ctx.branch = "slice-01";

      phase = await runSliceExecute(ctx);

      const evidenceDir = join(ctx.logger.runDir, "gates", "s01");
      postQaAttempts = readdirSync(evidenceDir)
        .filter((name) => name.endsWith(".json"))
        .sort()
        .map((name) =>
          JSON.parse(readFileSync(join(evidenceDir, name), "utf-8")),
        )
        .filter((attempt) =>
          attempt.results.some(
            (gate: { gateId: string }) => gate.gateId === "scope",
          ),
        );
      const logDir = join(evidenceDir, "gate-logs");
      scopeGateLogs = readdirSync(logDir)
        .filter((name) => name.endsWith("-scope.log"))
        .map((name) => readFileSync(join(logDir, name), "utf-8"));
      finalAcceptedCommits = acceptedCommits(repo);
      qaReportKept = existsSync(join(artifactDir, "qa-report-r2-a1.md"));
    }, 180_000);

    it("B-12: declares the scope gate first, red, and buys a repair round rather than a merge", () => {
      expect(postQaAttempts).toHaveLength(2);
      // Attempt ids are random hex, so the two documents are told apart by
      // what they say and not by filename order.
      const redRound = postQaAttempts.find((attempt) =>
        attempt.results.some(
          (gate) => gate.gateId === "scope" && gate.status === "FAIL",
        ),
      );
      const repairedRound = postQaAttempts.find((attempt) =>
        attempt.results.every((gate) => gate.status === "PASS"),
      );
      expect(redRound).toBeDefined();
      expect(repairedRound).toBeDefined();

      // First in the phase's evidence, and a red scope did not short-circuit
      // the declarations behind it.
      expectDeclaresInOrder(
        redRound!.results.map((gate) => gate.gateId),
        ["scope", "tests:skipped", "tests"],
      );
      expect(redRound!.results[0]).toMatchObject({
        gateId: "scope",
        status: "FAIL",
        findings: { outOfScopePaths: [SMUGGLED] },
      });
      expect(redRound!.results[0]!.detail).toContain(SMUGGLED);
      // Found by id, not by index: a gate declared ahead of `tests` by a later
      // slice must not move this assertion (#231).
      expect(
        redRound!.results.find((gate) => gate.gateId === "tests"),
      ).toMatchObject({
        gateId: "tests",
        status: "PASS",
      });

      // REPAIR, not acceptance: the candidate reached the evaluator (ADR 0048
      // needs that for an amendment warrant) but never the feature branch.
      // At the moment round 2 was dispatched there was still no accepted
      // slice commit, and the failed gate is what the round was told about.
      expect(generatorRounds).toBe(2);
      expect(acceptedCommitsAtDispatch).toEqual([0, 0]);
      expect(generatorPrompts[1]).toContain("Gate ID: `scope`");
      // The prompt's failure set cites the gate's evidence rather than
      // inlining it, so the named path has to be in the log it cites.
      expect(generatorPrompts[1]).toMatch(/-scope\.log/);
      expect(scopeGateLogs.some((log) => log.includes(SMUGGLED))).toBe(true);

      // And the repaired candidate passes the same gate.
      expectDeclaresInOrder(
        repairedRound!.results.map((gate) => gate.gateId),
        ["scope", "tests:skipped", "tests"],
      );
      expect(
        repairedRound!.results.every((gate) => gate.status === "PASS"),
      ).toBe(true);
      expect(phase).toEqual({ phase: "PASS" });
      expect(evaluators).toBe(2);
      expect(finalAcceptedCommits).toBe(1);
    });

    it("[behavior:P-02] keeps the scope gate's single post-QA call site: the candidate still reaches the evaluator and a red scope buys a repair round", () => {
      // Isolating the evaluator moved where it reads, not when the scope gate
      // runs (#91 D8 non-goal: `scope` stays post-QA). Both rounds' candidates
      // were graded by the evaluator before any gate saw them, and the red
      // scope produced a REPAIR round rather than an ERROR or a merge.
      expect(evaluators).toBe(2);
      expect(generatorRounds).toBe(2);
      expect(postQaAttempts).toHaveLength(2);
      expect(
        postQaAttempts.filter((attempt) =>
          attempt.results.some(
            (gate) => gate.gateId === "scope" && gate.status === "FAIL",
          ),
        ),
      ).toHaveLength(1);
      expect(acceptedCommitsAtDispatch).toEqual([0, 0]);
      expect(phase).toEqual({ phase: "PASS" });
    });

    it("P-04: leaves the post-QA phase's materialization, allowlist and outcome mapping alone", () => {
      // `src/post-qa-gates.ts` is unedited, and prepending a commandless
      // declaration changed none of its three jobs:
      //
      // 1. Executable-driven materialization — the `tests` command needed a
      //    checkout and got one, in both rounds.
      for (const attempt of postQaAttempts) {
        expect(
          attempt.results.find((gate) => gate.gateId === "tests"),
        ).toMatchObject({ status: "PASS" });
      }
      // 2. The PASS / REPAIR mapping — a red required gate became a repair
      //    round, a green phase became the accepted candidate.
      expect(generatorRounds).toBe(2);
      expect(phase).toEqual({ phase: "PASS" });
      // 3. The review-artifact allowlist and blob provenance — QA wrote
      //    reports into the slice directory between the authorized tree and
      //    the accepted one, and the phase accepted the tree anyway rather
      //    than failing closed on the difference (ADR 0012).
      expect(qaReportKept).toBe(true);
      expect(finalAcceptedCommits).toBe(1);
    });

    it("B-07: exempts the accepted pair, which the negotiated tree always changes", () => {
      // Both rounds' trees differ from `main` in `contract.md` and
      // `acceptance-manifest.json`, because negotiation wrote them there. The
      // attestation the orchestrator earned by finding the pair unmutated is
      // what keeps them off the violation list — without it every negotiated
      // slice would be red, and the one honest violation would be lost in the
      // noise.
      for (const attempt of postQaAttempts) {
        const offenders =
          attempt.results.find((gate) => gate.gateId === "scope")?.findings
            ?.outOfScopePaths ?? [];
        expect(offenders).not.toContain(
          "specs/slices/01-prd-070-regression/contract.md",
        );
        expect(offenders).not.toContain(
          "specs/slices/01-prd-070-regression/acceptance-manifest.json",
        );
      }
    });
  });
});

// A unit test on the shared expectation itself, so the containment relaxation
// (#231) cannot quietly become an assertion that passes on anything. No
// pipeline is spawned; see AGENTS.md on where a new assertion goes.
describe("the shared gate-ID expectation", () => {
  it("accepts a declaration set that gained an unrelated gate", () => {
    expect(
      declaresInOrder(["scope", "acceptance", "tests:skipped", "tests"], [
        "scope",
        "tests:skipped",
        "tests",
      ]),
    ).toBe(true);
  });

  it("rejects a set missing an expected gate", () => {
    expect(declaresInOrder(["scope", "tests"], ["scope", "tests:skipped", "tests"])).toBe(
      false,
    );
  });

  it("rejects two expected gates in the wrong relative order", () => {
    expect(
      declaresInOrder(["tests", "tests:skipped", "scope"], [
        "scope",
        "tests:skipped",
        "tests",
      ]),
    ).toBe(false);
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
      const evidence = readdirSync(evidenceDir)
        .filter((name) => name.endsWith(".json"))
        .map((name) =>
          JSON.parse(readFileSync(join(evidenceDir, name), "utf-8")),
        );
      const attemptGateIds = evidence.map((attempt) =>
        attempt.results.map((gate: { gateId: string }) => gate.gateId),
      );
      expectSomeAttemptDeclaresInOrder(attemptGateIds, ["typecheck", "lint"]);
      // The two content-derived gates lead the post-QA phase (#195 AC1;
      // #86 B-06): a comparison that needs no toolchain must not sit behind
      // the suite.
      expectSomeAttemptDeclaresInOrder(attemptGateIds, [
        "scope",
        "tests:skipped",
        "tests",
      ]);
      expect(
        evidence.every((attempt) =>
          attempt.results.every(
            (gate: { status: string }) => gate.status === "PASS",
          ),
        ),
      ).toBe(true);
      // Cheap gates authorize QA on the pre-review tree. The full suite is
      // then checkpointed from the exact post-QA tree whose pending stage can
      // survive a restart, so the two phases deliberately have distinct IDs.
      expect(new Set(evidence.map((attempt) => attempt.treeId)).size).toBe(2);
      expect(
        execFileSync(
          "git",
          ["show", `${evidence[0].treeId}:provider-output.txt`],
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
  it("[behavior:P-04] keeps deterministic and UAT findings isolated across a UAT retry, with UAT still in the generator worktree", async () => {
    const repo = makeRepo();
    // Outside the repo — the shared-preview verify/apply commands run in
    // the worktree after QA approval, and an in-repo marker would
    // (correctly) trip the A1 tree-authority guard.
    const marker = `${repo}-migration-order.txt`.replace(/\\/g, "/");
    const generatorPrompts: string[] = [];
    const deterministicPrompts: string[] = [];
    const uatPrompts: string[] = [];
    const deterministicCwds: string[] = [];
    const uatCwds: string[] = [];
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
        (isUAT ? uatCwds : deterministicCwds).push(options.cwd!);
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
    expect(generatorPrompts[1]).not.toContain("UAT-OPEN summary");
    expect(generatorPrompts[1]).toContain("UAT-OPEN condition");
    expect(generatorPrompts[1]).toContain("uat-review-r1-a1.json");
    expect(generatorPrompts[1]).toContain("uat-report-r1-a1.md");
    expect(generatorPrompts[1]).not.toContain("QA-ADVISORY");

    expect(deterministicPrompts[1]).toContain("QA-ADVISORY");
    expect(deterministicPrompts[1]).not.toContain("UAT-OPEN");
    expect(uatPrompts[1]).toContain("UAT-OPEN");
    expect(uatPrompts[1]).not.toContain("QA-ADVISORY");

    // Shared-preview UAT runs where the preview migrations were applied: the
    // generator worktree, with no review worktree and no copy-back. Only the
    // deterministic stage is isolated (#91 PRD D8 non-goal).
    expect(uatCwds).toEqual([repo, repo]);
    expect(deterministicCwds.every((cwd) => cwd !== repo)).toBe(true);
    expect(
      execFileSync("git", ["worktree", "list"], { cwd: repo, encoding: "utf-8" }),
    ).not.toContain("qa-review");

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

/**
 * Candidate evaluator isolation (#91). Every scenario here drives `runQAStage`
 * directly rather than spawning a slice: the mechanism under test is what the
 * evaluator is handed and what leaves its worktree, and a stub provider that
 * writes into `options.cwd` proves both without paying for gates or a
 * generator round (AGENTS.md on where a new assertion goes).
 */
describe("candidate evaluator isolation", { timeout: 60_000 }, () => {
  const REVIEW_SLICE_REL = "specs/slices/01-prd-070-regression";
  const runEvents = (ctx: SliceContext): Record<string, unknown>[] =>
    readFileSync(join(ctx.logger.runDir, "events.jsonl"), "utf-8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

  it("[behavior:B-01] [behavior:B-02] evaluates a disposable worktree at the candidate checkpoint, seeded per attempt", async () => {
    const repo = makeRepo();
    const absSliceDir = join(repo, "specs", "slices", "01-prd-070-regression");
    // The amendment case B-02 exists for: bytes that differ from the
    // checkpoint tree's, so the second attempt's seed is a *modification* in
    // the review worktree and the seed manifest is what keeps it out of
    // B-04's scan.
    const AMENDED_CONTRACT = GENERATOR_FIXTURE_CONTRACT.replace(
      "- provider-output.txt",
      "- provider-output.txt\n- amended.txt",
    );
    const cwds: string[] = [];
    const seenContract: string[] = [];
    const seenManifestScope: string[][] = [];
    const treeIds: string[] = [];
    let attempts = 0;
    const provider: AgentProvider = {
      name: "stub",
      async invoke(options: InvokeOptions): Promise<InvokeResult> {
        attempts++;
        const cwd = options.cwd!;
        cwds.push(cwd);
        if (attempts === 1) {
          // Both read before this attempt writes anything: the generator
          // worktree is still the tree the checkpoint captured.
          treeIds.push(
            execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
              cwd,
              encoding: "utf-8",
            }).trim(),
            resolveCandidateTreeId(repo),
          );
        }
        const reviewSliceDir = join(cwd, REVIEW_SLICE_REL);
        seenContract.push(
          readFileSync(join(reviewSliceDir, "contract.md"), "utf-8"),
        );
        seenManifestScope.push(
          JSON.parse(
            readFileSync(join(reviewSliceDir, "acceptance-manifest.json"), "utf-8"),
          ).fileScope.paths,
        );
        if (attempts === 1) {
          // A reviewer that destroys its own inputs must not make the next
          // attempt grade against a missing contract.
          rmSync(join(reviewSliceDir, "contract.md"), { force: true });
          rmSync(join(reviewSliceDir, "acceptance-manifest.json"), {
            force: true,
          });
          // A scope amendment lands in the generator worktree between the two
          // attempts (ADR 0048): the extra attempt has to grade the amended
          // pair, not the pair the checkpoint captured.
          writeFileSync(
            join(absSliceDir, "contract.md"),
            AMENDED_CONTRACT,
            "utf-8",
          );
          const manifest = JSON.parse(
            readFileSync(join(absSliceDir, "acceptance-manifest.json"), "utf-8"),
          );
          manifest.fileScope.paths = [...GENERATOR_FIXTURE_SCOPE, "amended.txt"];
          writeFileSync(
            join(absSliceDir, "acceptance-manifest.json"),
            JSON.stringify(manifest),
            "utf-8",
          );
          throw new Error("provider disconnected");
        }
        writeFileSync(
          join(reviewSliceDir, "qa-report.md"),
          "# QA Report\n\n**Verdict:** PASS\n**Failure class:** NONE\n",
          "utf-8",
        );
        writeQAReview(reviewSliceDir, "deterministic");
        return { exitCode: 0, stdout: "", stats: {} };
      },
    };
    const ctx = makeContext(repo, provider, { infrastructureRetries: 1 });

    await expect(runQAStage(ctx, 1, "deterministic", [])).resolves.toMatchObject(
      { outcome: "PASS" },
    );

    expect(attempts).toBe(2);
    // One worktree for the stage, and never the generator's.
    expect(new Set(cwds).size).toBe(1);
    const reviewCwd = cwds[0]!;
    expect(reviewCwd).not.toBe(repo);
    expect(reviewCwd.startsWith(join(repo, ".afk"))).toBe(true);
    // Built from the candidate checkpoint, so the evaluator read the tree the
    // verdict is tied to.
    expect(treeIds[0]).toBe(treeIds[1]);
    // Seeded before every attempt, with the generator worktree's bytes as
    // they stand at that attempt — so the amended pair is what the extra
    // attempt graded, not the checkpoint tree's copy.
    expect(seenContract).toEqual([GENERATOR_FIXTURE_CONTRACT, AMENDED_CONTRACT]);
    expect(seenManifestScope).toEqual([
      GENERATOR_FIXTURE_SCOPE,
      [...GENERATOR_FIXTURE_SCOPE, "amended.txt"],
    ]);
    // And the seed manifest is what keeps those orchestrator writes out of the
    // reviewer-write scan: attempt 1's deletions and attempt 2's differing
    // bytes both show up in the review worktree's `git status`.
    const seededPaths = [
      `${REVIEW_SLICE_REL}/contract.md`,
      `${REVIEW_SLICE_REL}/acceptance-manifest.json`,
    ];
    const violated = runEvents(ctx)
      .filter((event) => event.type === "reviewer-write-violation")
      .map((event) => event.path);
    for (const path of seededPaths) {
      expect(violated).not.toContain(path);
    }
    // And gone on the way out, along with its throwaway branch.
    expect(existsSync(reviewCwd)).toBe(false);
    expect(
      execFileSync("git", ["worktree", "list"], { cwd: repo, encoding: "utf-8" }),
    ).not.toContain("qa-review");
    expect(
      execFileSync("git", ["branch", "--list", "afk/qa-review/*"], {
        cwd: repo,
        encoding: "utf-8",
      }).trim(),
    ).toBe("");
  });

  it("[behavior:B-01] removes the review worktree when the stage ends in a throw", async () => {
    const repo = makeRepo();
    let reviewCwd = "";
    const provider: AgentProvider = {
      name: "stub",
      async invoke(options: InvokeOptions): Promise<InvokeResult> {
        reviewCwd = options.cwd!;
        throw new Error("provider disconnected");
      },
    };
    const ctx = makeContext(repo, provider, { infrastructureRetries: 0 });

    await expect(runQAStage(ctx, 1, "deterministic", [])).rejects.toThrow(
      /provider disconnected/,
    );

    expect(reviewCwd).not.toBe("");
    expect(existsSync(reviewCwd)).toBe(false);
    expect(
      execFileSync("git", ["worktree", "list"], { cwd: repo, encoding: "utf-8" }),
    ).not.toContain("qa-review");
  });

  it("[behavior:B-03] [behavior:B-04] copies back only allowlisted artifacts and journals every other reviewer write", async () => {
    const repo = makeRepo();
    // A tracked source file, so the reviewer can *edit* one rather than only
    // add untracked files.
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "app.ts"), "export const app = 1;\n", "utf-8");
    git(repo, ["add", "src/app.ts"]);
    git(repo, ["commit", "-m", "source"]);
    let reviewCwd = "";
    const provider: AgentProvider = {
      name: "stub",
      async invoke(options: InvokeOptions): Promise<InvokeResult> {
        reviewCwd = options.cwd!;
        const sliceDir = join(reviewCwd, REVIEW_SLICE_REL);
        writeFileSync(
          join(sliceDir, "qa-report.md"),
          "# QA Report\n\n**Verdict:** PASS\n**Failure class:** NONE\n",
          "utf-8",
        );
        writeQAReview(sliceDir, "deterministic");
        // Everything below is discarded: an unmatched name in the slice
        // directory, a self-authored baseline, a nested match, an edit to a
        // source file, a probe, and a write under the gitignored `.afk/` root
        // that only the second `--ignored` status read can see.
        writeFileSync(join(sliceDir, "notes.md"), "scratch\n", "utf-8");
        writeFileSync(
          join(sliceDir, "approved-baseline.json"),
          '{"self":"certified"}\n',
          "utf-8",
        );
        mkdirSync(join(sliceDir, "nested"), { recursive: true });
        writeFileSync(
          join(sliceDir, "nested", "qa-report.md"),
          "nested\n",
          "utf-8",
        );
        writeFileSync(join(reviewCwd, "README.md"), "reviewer edit\n", "utf-8");
        writeFileSync(join(reviewCwd, "probe.txt"), "probe\n", "utf-8");
        writeFileSync(
          join(reviewCwd, "src", "app.ts"),
          "export const app = 2;\n",
          "utf-8",
        );
        mkdirSync(join(reviewCwd, ".afk", "artifacts", "deep"), {
          recursive: true,
        });
        writeFileSync(
          join(reviewCwd, ".afk", "artifacts", "deep", "approved-baseline.json"),
          '{"ignored":"root"}\n',
          "utf-8",
        );
        return { exitCode: 0, stdout: "", stats: {} };
      },
    };
    const ctx = makeContext(repo, provider, { infrastructureRetries: 0 });

    await expect(runQAStage(ctx, 1, "deterministic", [])).resolves.toMatchObject(
      { outcome: "PASS" },
    );

    // The two canonical artifacts made it out.
    expect(
      readFileSync(join(ctx.absSliceDir, "qa-report-r1-a1.md"), "utf-8"),
    ).toContain("**Verdict:** PASS");
    expect(
      readFileSync(join(ctx.absSliceDir, "qa-review.json"), "utf-8"),
    ).toContain('"verdict"');
    // Nothing else did — including the baseline the evaluator wrote for
    // itself, which only the orchestrator may author.
    expect(existsSync(join(ctx.absSliceDir, "notes.md"))).toBe(false);
    expect(existsSync(join(ctx.absSliceDir, "approved-baseline.json"))).toBe(
      false,
    );
    expect(existsSync(join(ctx.absSliceDir, "nested"))).toBe(false);
    expect(readFileSync(join(repo, "README.md"), "utf-8")).toBe("fixture\n");
    expect(existsSync(join(repo, "probe.txt"))).toBe(false);
    // The source edit reached neither the generator worktree nor its commit.
    expect(readFileSync(join(repo, "src", "app.ts"), "utf-8")).toBe(
      "export const app = 1;\n",
    );
    expect(
      execFileSync("git", ["show", "HEAD:src/app.ts"], {
        cwd: repo,
        encoding: "utf-8",
      }),
    ).toBe("export const app = 1;\n");

    const violations = runEvents(ctx).filter(
      (event) => event.type === "reviewer-write-violation",
    );
    expect(violations.map((event) => event.path).sort()).toEqual(
      [
        "README.md",
        "probe.txt",
        "src/app.ts",
        // Invisible to a plain `git status`: the second, `--ignored` read is
        // the only reason this one is named.
        ".afk/artifacts/deep/approved-baseline.json",
        `${REVIEW_SLICE_REL}/approved-baseline.json`,
        `${REVIEW_SLICE_REL}/nested/qa-report.md`,
        `${REVIEW_SLICE_REL}/notes.md`,
      ].sort(),
    );
    // Identity, and non-fatal: the stage still returned PASS above.
    expect(violations[0]).toMatchObject({
      ghIssue: "70",
      sliceNumber: "01",
      round: 1,
      attempt: 1,
    });
    // The copied-back artifacts and the orchestrator's own seeds are not
    // reviewer writes.
    for (const path of [
      `${REVIEW_SLICE_REL}/qa-report.md`,
      `${REVIEW_SLICE_REL}/qa-review.json`,
      `${REVIEW_SLICE_REL}/contract.md`,
      `${REVIEW_SLICE_REL}/acceptance-manifest.json`,
    ]) {
      expect(violations.map((event) => event.path)).not.toContain(path);
    }
  });

  it("[behavior:B-05] writes the git change summary before the evaluator is invoked", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "change.txt"), "generated\n", "utf-8");
    const summaryPath = join(
      repo,
      ".afk",
      "artifacts",
      "prd-070-stub",
      "slice-01",
      "change-summary.json",
    );
    let existedAtInvocation = false;
    let promptedPath = false;
    const provider: AgentProvider = {
      name: "stub",
      async invoke(options: InvokeOptions): Promise<InvokeResult> {
        existedAtInvocation = existsSync(summaryPath);
        promptedPath = options.prompt.includes(
          ".afk/artifacts/prd-070-stub/slice-01/change-summary.json",
        );
        const sliceDir = join(options.cwd!, REVIEW_SLICE_REL);
        writeFileSync(
          join(sliceDir, "qa-report.md"),
          "# QA Report\n\n**Verdict:** PASS\n**Failure class:** NONE\n",
          "utf-8",
        );
        writeQAReview(sliceDir, "deterministic");
        return { exitCode: 0, stdout: "", stats: {} };
      },
    };
    const ctx = makeContext(repo, provider, { infrastructureRetries: 0 });

    await expect(runQAStage(ctx, 1, "deterministic", [])).resolves.toMatchObject(
      { outcome: "PASS" },
    );

    expect(existedAtInvocation).toBe(true);
    expect(promptedPath).toBe(true);
    const summary = JSON.parse(readFileSync(summaryPath, "utf-8"));
    expect(summary).toMatchObject({ version: 1, fromRef: "main" });
    expect(summary.files.map((file: { path: string }) => file.path)).toContain(
      "change.txt",
    );
    expect(summary.totals.files).toBe(summary.files.length);
  });

  it("[behavior:P-05] refuses a PASS that leaves a blocking finding open", async () => {
    const repo = makeRepo();
    const provider: AgentProvider = {
      name: "stub",
      async invoke(options: InvokeOptions): Promise<InvokeResult> {
        const sliceDir = join(options.cwd!, REVIEW_SLICE_REL);
        writeFileSync(
          join(sliceDir, "qa-report.md"),
          "# QA Report\n\n**Verdict:** PASS\n**Failure class:** NONE\n",
          "utf-8",
        );
        writeQAReview(sliceDir, "deterministic", {
          verdict: "PASS",
          failureClass: "NONE",
          findings: [
            {
              id: "QA-01",
              severity: "BLOCKING",
              behaviorIds: [],
              summary: "Still broken",
              evidence: "The fixture evaluator observed a failing behavior",
              expected: "The behavior passes",
              observed: "The behavior fails",
              clearCondition: "The behavior passes",
              state: "OPEN",
            },
          ],
        });
        return { exitCode: 0, stdout: "", stats: {} };
      },
    };
    const ctx = makeContext(repo, provider, { infrastructureRetries: 0 });

    await expect(runQAStage(ctx, 1, "deterministic", [])).rejects.toThrow(
      /must be one of PASS\/NONE/,
    );
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

/**
 * Final evaluation and reuse (#96). Three of these are unit tests over the
 * stores and one is a spawned scenario, because injecting a post-approval
 * writing stage and proving the tree it dirties cannot merge unreviewed is the
 * one claim no unit test reaches (`CLAUDE.md`, "Where a new assertion goes").
 */
describe("final evaluation and reuse", () => {
  /**
   * The three stores' own shapes, seeded by hand. This asserts the reader, the
   * event schema and the summary renderer — *not* that any run reaches a reuse,
   * which is the spawned `[behavior:B-02]` scenario below.
   */
  it("shapes a reuse record, event, and summary section the three stores round-trip", () => {
    const repo = makeRepo();
    const finalTreeId = "f".repeat(40);
    const baselineTreeId = finalTreeId;

    // Store 1: run state, read back through the new reader.
    recordFinalEvaluation(repo, "prd-070-stub", "70", {
      decision: "reuse",
      finalTreeId,
      baselineTreeId,
      baselineArtifactPath:
        ".afk/artifacts/prd-070-stub/slice-01/approved-baseline.json",
      attempts: [],
      invalidatedCandidateTreeIds: [],
    });
    const state = loadRunState(repo, "prd-070-stub");
    expect(finalEvaluationFor(state, "70")?.decision).toBe("reuse");

    // Stores 2 and 3: one additive event, and the slice's own summary section.
    const logger = new Logger(repo, "final-reuse");
    const slice = { ghIssue: "70", title: "PRD 070 regression", branch: "main" };
    logger.trackSlice(lifecycle.running(slice, { genRounds: 1, evalRounds: 1 }));
    logger.recordTerminal(slice, { phase: "PASS" });
    logger.event({
      type: "final-evaluation-reuse",
      ghIssue: "70",
      sliceNumber: "01",
      round: 1,
      finalTreeId,
      baselineTreeId,
    });
    const events = readFileSync(join(logger.runDir, "events.jsonl"), "utf-8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line))
      .filter((event) => event.type === "final-evaluation-reuse");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      ghIssue: "70",
      sliceNumber: "01",
      round: 1,
      finalTreeId,
      baselineTreeId,
    });
    // Not a GateEvidence field and not D17's gate-cache reused flag: the schema
    // version is unchanged and the event carries no gate id.
    expect(Object.keys(events[0]!)).not.toContain("gateId");

    const md = logger.writeSummary();
    const section = md.indexOf("## Final Evaluation Reuse");
    expect(section).toBeGreaterThan(-1);
    expect(md.slice(section)).toContain(finalTreeId);
    // The invocation count the reuse is worth, stated: zero.
    expect(md.slice(section)).toMatch(/\|\s*0\s*\|/);
  });

  it("leaves a run without a reuse byte-identical", () => {
    const repo = makeRepo();
    const logger = new Logger(repo, "no-final-reuse");
    const slice = { ghIssue: "70", title: "PRD 070 regression", branch: "main" };
    logger.trackSlice(lifecycle.running(slice, { genRounds: 1, evalRounds: 1 }));
    logger.recordTerminal(slice, { phase: "PASS" });

    expect(logger.writeSummary()).not.toContain("Final Evaluation Reuse");
  });

  it("[behavior:B-09] appends the rejected tree, drops the baseline citation, and refuses reuse", () => {
    const repo = makeRepo();
    const candidateTreeId = "a".repeat(40);
    const artifactPath =
      ".afk/artifacts/prd-070-stub/slice-01/approved-baseline.json";
    updateRunState(repo, "prd-070-stub", (state) => {
      state.approvedBaselines = {
        "70": {
          treeId: candidateTreeId,
          commit: "c".repeat(40),
          artifactPath,
        },
      };
    });
    recordFinalEvaluation(repo, "prd-070-stub", "70", {
      decision: "evaluate",
      finalTreeId: candidateTreeId,
      baselineTreeId: candidateTreeId,
      baselineArtifactPath: artifactPath,
      attempts: [
        // Two attempts on two different trees, so "every entry keyed to the
        // rejected tree" is a claim the read can get wrong.
        {
          attempt: 1,
          candidateTreeId: "e".repeat(40),
          verdict: "FAIL",
          outcome: "GRADED",
        },
        {
          attempt: 2,
          candidateTreeId,
          verdict: "FAIL",
          outcome: "GRADED",
        },
      ],
      invalidatedCandidateTreeIds: [],
    });

    const record = invalidateFinalEvaluationBaseline(
      repo,
      "prd-070-stub",
      "70",
      candidateTreeId,
    );

    expect(record.invalidatedCandidateTreeIds).toEqual([candidateTreeId]);
    expect(record.baselineTreeId).toBeUndefined();
    expect(record.baselineArtifactPath).toBeUndefined();
    // The per-attempt entries survive the invalidation, and every entry keyed
    // to the rejected tree reads back as invalidated — the distinction a bare
    // attempt count cannot make.
    const invalidatedView = finalEvaluationFor(
      loadRunState(repo, "prd-070-stub"),
      "70",
    );
    expect(invalidatedView?.attempts).toEqual([
      {
        attempt: 1,
        candidateTreeId: "e".repeat(40),
        verdict: "FAIL",
        outcome: "GRADED",
        invalidated: false,
      },
      {
        attempt: 2,
        candidateTreeId,
        verdict: "FAIL",
        outcome: "GRADED",
        invalidated: true,
      },
    ]);
    expect(
      invalidatedView!.attempts
        .filter((entry) => entry.candidateTreeId === candidateTreeId)
        .every((entry) => entry.invalidated),
    ).toBe(true);
    // A return to the generator is not a spent evaluator attempt (D19).
    expect(finalEvaluationAttemptsSpent(invalidatedView)).toBe(2);
    expect(
      finalEvaluationAttemptsSpent({
        attempts: [{ outcome: "RETURNED_TO_GENERATOR" }],
      }),
    ).toBe(0);
    // Even on exact equality, the approval this tree earned is the approval the
    // finding disputed.
    expect(
      decideFinalReuse({
        finalTreeId: candidateTreeId,
        baseline: { treeId: candidateTreeId },
        invalidatedCandidateTreeIds: record.invalidatedCandidateTreeIds,
      }).decision,
    ).toBe("evaluate");
    // P-03: the baseline locator and the artifact it names are untouched — a
    // withdrawn citation is not an erased citation.
    const after = loadRunState(repo, "prd-070-stub");
    expect(after.approvedBaselines?.["70"]).toEqual({
      treeId: candidateTreeId,
      commit: "c".repeat(40),
      artifactPath,
    });
  });

  it("[behavior:P-06] reads a v4 state, keeping the #91 locator and #193 waivers, and adds finalEvaluations", () => {
    const repo = makeRepo();
    const v4 = {
      version: 4,
      slices: {
        "70": {
          phase: "PASS",
          rounds: 1,
          updatedAt: "2026-09-11T00:00:00.000Z",
        },
      },
      approvedBaselines: {
        "70": {
          treeId: "a".repeat(40),
          commit: "c".repeat(40),
          artifactPath:
            ".afk/artifacts/prd-070-stub/slice-01/approved-baseline.json",
        },
      },
      appliedWaivers: {
        "70": [
          {
            riskClass: "migration",
            path: "db/001.sql",
            author: "operator",
            reason: "The migration is intentional",
          },
        ],
      },
    };
    mkdirSync(join(repo, ".afk", "state"), { recursive: true });
    writeFileSync(
      join(repo, ".afk", "state", "prd-070-stub.json"),
      JSON.stringify(v4),
      "utf-8",
    );

    const loaded = loadRunState(repo, "prd-070-stub");
    expect(loaded.approvedBaselines?.["70"]?.treeId).toBe("a".repeat(40));
    expect(finalEvaluationFor(loaded, "70")).toBeUndefined();

    recordFinalEvaluation(repo, "prd-070-stub", "70", {
      decision: "evaluate",
      finalTreeId: "b".repeat(40),
      attempts: [],
      invalidatedCandidateTreeIds: [],
    });
    const bumped = loadRunState(repo, "prd-070-stub");
    expect(bumped.version).toBe(5);
    expect(bumped.approvedBaselines?.["70"]?.commit).toBe("c".repeat(40));
    expect(bumped.appliedWaivers?.["70"]).toEqual([
      {
        riskClass: "migration",
        path: "db/001.sql",
        author: "operator",
        reason: "The migration is intentional",
      },
    ]);
    expect(finalEvaluationFor(bumped, "70")?.decision).toBe("evaluate");
  });

  /**
   * P-01's two halves, and which test carries which.
   *
   * "The merge stays serialized through the existing mutex" is a claim about a
   * merge, and only an executing merge can carry it. This slice does not run
   * one: `runSliceExecute` stops at the accepted candidate and `src/wave.ts`
   * merges. That half is therefore carried, unchanged and by an executing
   * merge, by `src/wave-migrations.test.ts` →
   * `describe("a real conflict spends one scoped resolution round")` →
   * `it("B-05: holds the merge mutex across the refused attempt, the round and
   * the retry")`, which instruments the mutex, queues a competitor inside the
   * critical section and asserts the acquisition count never moves. Nothing in
   * this slice touches the code that assertion covers, so it still passes.
   *
   * What *this* test checks is the other half — "no second lock" — and it says
   * so in its own name rather than claiming the merge behavior it never
   * observes. It is a source-text check on purpose: the absence of a second
   * lock primitive is a property of the diff, not of any run.
   */
  it("[behavior:P-01] introduces no second lock primitive anywhere in this slice's modules", () => {
    const repoRoot = fileURLToPath(new URL("..", import.meta.url));
    // The one mutex still exists where it always did, and this slice is not a
    // caller of it and declares no lock of its own.
    expect(
      readFileSync(join(repoRoot, "src", "wave.ts"), "utf-8"),
    ).toContain("mergeMutex");
    for (const file of [
      "src/final-evaluation.ts",
      "src/change-summary.ts",
      "src/run-state.ts",
      "src/run-events.ts",
      "src/post-qa-gates.ts",
      "src/context-envelope.ts",
      "src/bounds.ts",
      "src/artifacts.ts",
      "src/logger.ts",
      "src/qa-review.ts",
    ]) {
      // The identifiers that *are* a lock primitive in this codebase. Prose may
      // name the mutex and does — `src/run-events.ts` and `src/logger.ts` both
      // explain what a resolution under it means.
      const source = readFileSync(join(repoRoot, file), "utf-8");
      expect(source, file).not.toMatch(
        /mergeMutex|makeAsyncMutex|AsyncMutex|acquireLock|lockFile/,
      );
    }
  });

  /**
   * The three spawned scenarios below share this fixture: a repo with the gate
   * scripts committed, a QA evaluator that passes, and an injected
   * post-approval writing stage whose stub write changes the tree — which is
   * what gives the final evaluator a subject at all.
   */
  function finalEvaluationFixture(options: {
    /** Answers one `evaluator-final` dispatch; returns the review to write. */
    review: (
      call: { attempt: number; baselineTreeId: string; finalTreeId: string },
    ) => unknown;
    onFinalCall?: (call: { cwd: string; attempt: number }) => void;
    /**
     * `false` makes the injected stage production's no-op — the reuse path.
     * Defaults to `true`, the stub write that gives an evaluator a subject.
     */
    stageWrites?: boolean;
  }): {
    repo: string;
    ctx: SliceContext;
    finalCalls: { cwd: string; finalTreeId: string }[];
    stageCalls: { worktreeDir: string; stageId: string; repair?: string }[];
  } {
    const repo = makeRepo();
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({
        name: "gate-fixture",
        scripts: { typecheck: "node -e \"0\"", test: "node -e \"0\"" },
      }),
      "utf-8",
    );
    git(repo, ["add", "package.json"]);
    git(repo, ["commit", "-m", "add gate scripts"]);

    let artifactDir = "";
    let relSliceDir = "";
    const finalCalls: { cwd: string; finalTreeId: string }[] = [];
    const treeIdFrom = (prompt: string, label: string): string => {
      const match = new RegExp(`${label} tree ID: \`([^\`]+)\``).exec(prompt);
      expect(match, `${label} tree ID in the evaluator-final prompt`).not.toBe(
        null,
      );
      return match![1]!;
    };
    const provider: AgentProvider = {
      name: "stub",
      async invoke(invokeOptions: InvokeOptions): Promise<InvokeResult> {
        if (invokeOptions.role === "evaluator-qa") {
          writeFileSync(
            join(artifactDir, "qa-report.md"),
            "# QA Report\n\n**Verdict:** PASS\n**Failure class:** NONE\n",
            "utf-8",
          );
          writeQAReview(artifactDir, "deterministic");
        }
        if (invokeOptions.role === "evaluator-final") {
          const prompt = invokeOptions.prompt ?? "";
          const baselineTreeId = treeIdFrom(prompt, "Approved baseline");
          const finalTreeId = treeIdFrom(prompt, "Final checkpoint");
          const attempt = finalCalls.length + 1;
          finalCalls.push({ cwd: invokeOptions.cwd ?? "", finalTreeId });
          options.onFinalCall?.({ cwd: invokeOptions.cwd ?? "", attempt });
          // The review is written where the evaluator actually stands — the
          // disposable worktree — and reaches the slice directory only through
          // the orchestrator's copy-back allowlist.
          const reviewDir = join(invokeOptions.cwd ?? repo, relSliceDir);
          mkdirSync(reviewDir, { recursive: true });
          writeFileSync(
            join(reviewDir, "final-review.json"),
            JSON.stringify(
              options.review({ attempt, baselineTreeId, finalTreeId }),
            ),
            "utf-8",
          );
          writeFileSync(
            join(reviewDir, "final-report.md"),
            "# Final Report\n\n**Verdict:** PASS\n",
            "utf-8",
          );
        }
        return { exitCode: 0, stdout: "", stats: {} };
      },
    };
    const stageCalls: {
      worktreeDir: string;
      stageId: string;
      repair?: string;
    }[] = [];
    const ctx = makeContext(repo, provider, {
      commandTimeoutMs: 5_000,
      heartbeatIntervalMs: 20,
      postApprovalWritingStage: (input) => {
        stageCalls.push(input);
        if (options.stageWrites === false) return;
        // A stub write, which is all it takes: the tree is no longer the tree
        // that was approved.
        writeFileSync(
          join(input.worktreeDir, "README.md"),
          `fixture, tidied ${stageCalls.length}\n`,
          "utf-8",
        );
      },
    });
    artifactDir = ctx.absSliceDir;
    relSliceDir = ctx.relSliceDir;
    return { repo, ctx, finalCalls, stageCalls };
  }

  /** A PASS review keyed to the exact trees the prompt named. */
  const passingReview = (call: {
    baselineTreeId: string;
    finalTreeId: string;
  }): unknown => ({
    version: 1,
    verdict: "PASS",
    baselineTreeId: call.baselineTreeId,
    finalTreeId: call.finalTreeId,
    findings: [],
  });

  it("[behavior:B-02] records a reuse in all three stores and dispatches no evaluator when the writing stage writes nothing", async () => {
    // The reuse path as production runs it: the stage is a no-op, so every
    // value below is read back out of the run the orchestrator performed. A
    // hand-written record and a hand-emitted event would pass with the
    // orchestrator's reuse branch deleted; this cannot.
    const { repo, ctx, finalCalls, stageCalls } = finalEvaluationFixture({
      review: passingReview,
      stageWrites: false,
    });

    const result = await runSliceExecute(ctx);

    expect(result.phase).toBe("PASS");
    expect(stageCalls).toEqual([
      { worktreeDir: repo, stageId: POST_APPROVAL_WRITING_STAGE_ID },
    ]);
    // Store 1: run state, through the reader.
    const view = finalEvaluationFor(loadRunState(repo, "prd-070-stub"), "70");
    expect(view?.decision).toBe("reuse");
    expect(view?.attempts).toEqual([]);
    // The record cites the baseline #91 wrote, and the tree it merged.
    const baseline = approvedBaselineFor(loadRunState(repo, "prd-070"), "70");
    expect(view?.baselineTreeId).toBe(baseline?.treeId);
    expect(view?.baselineArtifactPath).toBe(baseline?.artifactPath);
    // Zero evaluator-final invocations — the reuse's whole point.
    expect(finalCalls).toEqual([]);
    // Store 2: exactly one journaled event, keyed to the tree that merged.
    const reuseEvents = readFileSync(
      join(ctx.logger.runDir, "events.jsonl"),
      "utf-8",
    )
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line))
      .filter((event) => event.type === "final-evaluation-reuse");
    expect(reuseEvents).toHaveLength(1);
    expect(reuseEvents[0]).toMatchObject({
      ghIssue: "70",
      sliceNumber: "01",
      finalTreeId: view!.finalTreeId,
      baselineTreeId: baseline!.treeId,
    });
    // Store 3: the slice's own run-summary section, rendered from that event.
    const md = ctx.logger.writeSummary();
    const section = md.indexOf("## Final Evaluation Reuse");
    expect(section).toBeGreaterThan(-1);
    expect(md.slice(section)).toContain(view!.finalTreeId);
    expect(md.slice(section)).toMatch(/\|\s*0\s*\|/);
  });

  it("[behavior:B-03] runs an injected post-approval writing stage and evaluates the tree it dirtied exactly once", async () => {
    const { repo, ctx, finalCalls, stageCalls } = finalEvaluationFixture({
      review: passingReview,
    });

    const result = await runSliceExecute(ctx);

    // One stage, named by one stage id, running in the slice worktree.
    expect(stageCalls).toEqual([
      { worktreeDir: repo, stageId: POST_APPROVAL_WRITING_STAGE_ID },
    ]);
    // B-06/B-11: the changed tree is graded by exactly one evaluator-final
    // invocation, in a disposable worktree that is not the slice worktree.
    expect(finalCalls).toHaveLength(1);
    expect(finalCalls[0]!.cwd).not.toBe(repo);
    expect(finalCalls[0]!.cwd).toContain("qa-review");
    expect(existsSync(finalCalls[0]!.cwd)).toBe(false);
    // B-11: the verdict passes on the final candidate, which means the scope
    // gate was evaluated on the final tree — the accepted candidate's evidence
    // is keyed to a different tree and authorizes nothing about this one.
    expect(result.phase).toBe("PASS");
    const view = finalEvaluationFor(loadRunState(repo, "prd-070-stub"), "70");
    expect(view?.decision).toBe("evaluate");
    expect(view?.attempts).toEqual([
      {
        attempt: 1,
        candidateTreeId: finalCalls[0]!.finalTreeId,
        verdict: "PASS",
        outcome: "GRADED",
      },
    ].map((entry) => ({ ...entry, invalidated: false })));
    // The graded artifacts are archived per attempt, keyed to round and attempt.
    expect(
      existsSync(
        join(
          repo,
          ".afk",
          "artifacts",
          "prd-070-stub",
          "slice-01",
          "reviews",
          "final-review-r1-a1.json",
        ),
      ),
    ).toBe(true);
  });

  it("[behavior:B-09] returns a baseline-is-wrong finding to the generator loop for exactly one round and no evaluator attempt", async () => {
    const progress: { genRounds: number; spent: number }[] = [];
    let repoRef = "";
    const fixture = finalEvaluationFixture({
      review: (call) =>
        call.attempt === 1
          ? {
              version: 1,
              verdict: "FAIL",
              baselineTreeId: call.baselineTreeId,
              finalTreeId: call.finalTreeId,
              findings: [
                {
                  id: "FE-01",
                  class: "BASELINE_IS_WRONG",
                  summary: "The approved candidate itself must not merge",
                  evidence: "The fixture evaluator read the final tree",
                  expected: "The generator revisits the approved candidate",
                  observed: "The approved candidate ships a defect",
                  repair: "RETURN_TO_GENERATOR",
                },
              ],
            }
          : passingReview(call),
      onFinalCall: () => {
        // Read at the dispatch itself, so the counters are the ones the return
        // moved rather than whatever the run ended on.
        progress.push({
          genRounds:
            fixture.ctx.logger.getSliceProgress("70")?.genRounds ?? -1,
          spent: finalEvaluationAttemptsSpent(
            finalEvaluationFor(loadRunState(repoRef, "prd-070-stub"), "70"),
          ),
        });
      },
    });
    repoRef = fixture.repo;

    const result = await runSliceExecute(fixture.ctx);

    expect(result.phase).toBe("PASS");
    // Exactly one generator round across the return (D19), and no evaluator
    // attempt spent by it.
    expect(progress).toEqual([
      { genRounds: 1, spent: 0 },
      { genRounds: 2, spent: 0 },
    ]);
    const view = finalEvaluationFor(
      loadRunState(fixture.repo, "prd-070-stub"),
      "70",
    );
    expect(view?.attempts.map((entry) => entry.outcome)).toEqual([
      "RETURNED_TO_GENERATOR",
      "GRADED",
    ]);
    // The rejected tree is invalidated, and its own attempt entry says so.
    expect(view?.attempts[0]?.invalidated).toBe(true);
  });

  it("[behavior:B-10] refuses a fourth final-evaluation attempt against the three-attempt bound", async () => {
    const fixture = finalEvaluationFixture({ review: passingReview });
    // Three graded attempts already on the record, so this run's dispatch is
    // the fourth — and the bound, not the evaluator, answers it.
    updateRunState(fixture.repo, "prd-070-stub", (state) => {
      state.finalEvaluations = {
        "70": {
          decision: "evaluate",
          finalTreeId: "b".repeat(40),
          attempts: [1, 2, 3].map((attempt) => ({
            attempt,
            candidateTreeId: `${attempt}`.repeat(40),
            verdict: "FAIL" as const,
            outcome: "GRADED" as const,
          })),
          invalidatedCandidateTreeIds: [],
        },
      };
    });

    const result = await runSliceExecute(fixture.ctx);

    expect(result.phase).toBe("ERROR");
    const error = "error" in result ? result.error : "";
    expect(error).toContain(`all ${MAX_FINAL_EVALUATION_ATTEMPTS}`);
    expect(error).toContain("#96 B-11");
    // Refused before any dispatch: the bound costs no evaluator read.
    expect(fixture.finalCalls).toHaveLength(0);
  });
});

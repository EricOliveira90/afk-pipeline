/**
 * QA orchestration integration tests, part 1 of 2: the PRD 070 QA retry
 * loop (partial-output archives, infrastructure retries, checkpoint
 * resume, the oscillation stop), mid-loop scope amendments (#112),
 * fixture repo isolation and sibling-handoff scoping. The base-gate,
 * candidate-evaluator and final-evaluation blocks live in
 * `qa-orchestration-gates.test.ts`.
 *
 * Two files exist so one `vitest run` schedules the suite across both
 * workers (`maxWorkers: 2`) — a single file always pinned it to one.
 * Shared helpers are in `qa-orchestration.fixtures.ts`. When adding a
 * `describe`, keep the halves balanced by measured block time
 * (`--reporter=./scripts/describe-times.reporter.mjs`), not test count.
 */
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
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { buildDAG, type Slice } from "./issues-parser.js";
import { lifecycle } from "./slice-lifecycle.js";
import { RunJournal as Logger } from "./run-journal.js";
import {
  makeSliceContext,
  runQAStage,
  runSliceExecute,
} from "./orchestrator.js";
import * as gitModule from "./git.js";
import * as migrationGate from "./migration-gate.js";
import {
  finalEvaluationFor,
  loadRunState,
  qualityStagesFor,
  saveRunState,
} from "./run-state.js";
import { parseGatePolicy } from "./gate-policy.js";
import { CLEANER_ESCALATION_FILENAME } from "./cleaner-stage.js";
import { resolveCandidateTreeId } from "./gate-runner.js";
import { recordExactStageCheckpoint } from "./exact-stage-resume.js";
import { saveQAConvergenceState } from "./qa-convergence.js";
import { saveNonProgressHistory } from "./non-progress.js";
import {
  seedStuckDiagnosisArchive,
  STUCK_DIAGNOSIS_ADDITIONAL_ARTIFACTS,
  STUCK_DIAGNOSIS_COMMIT_LOG,
  stuckDiagnosisReviewFindings,
} from "./stuck-diagnosis.fixtures.js";
import type { AgentProvider, InvokeOptions, InvokeResult } from "./agent-provider.js";
import { writeQAReview } from "./test-support.js";
import {
  cleanupQATempDirs,
  dirs,
  expectDeclaresInOrder,
  expectSomeAttemptDeclaresInOrder,
  git,
  makeContext,
  makeRepo,
  terminateFixtureChildren,
} from "./qa-orchestration.fixtures.js";

beforeEach(() => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await terminateFixtureChildren();
  cleanupQATempDirs();
});

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
 * The cleaner stage at the post-approval transition (#87), with a real
 * `gatePolicy.clean`.
 *
 * A marker word inside the declared file is the whole clean gate: it is red
 * until a cleaner round rewrites `change.txt` to carry {@link CLEAN_MARKER},
 * which is what lets a fixture drive the stage through its exits without a
 * formatter.
 *
 * The marker is content rather than a new file on purpose. A clean round may
 * write outside the manifest's scope — that is what `additionalWriteScope`
 * buys — but the widening is round-scoped: the *final* candidate is still
 * gated against the manifest alone, so a marker file would leave the run
 * with an undeclared path and fail final evaluation on `scope` instead of
 * reaching the exits these scenarios are about.
 */
const CLEAN_MARKER = "formatted";

/** The required clean gate every scenario below declares. */
const FORMAT_GATE = {
  id: "format",
  command: process.execPath,
  args: [
    "-e",
    `if (!require('node:fs').readFileSync('change.txt', 'utf-8')` +
      `.includes('${CLEAN_MARKER}')) { ` +
      `console.error('the formatter would rewrite change.txt'); ` +
      `process.exit(1); }`,
  ],
  required: true,
  expectedCostMs: 200,
};

/**
 * A path the clean set widens the round's scope gate to. Nothing below writes
 * it: it is here so the undeclared path scenario two *does* write is undeclared
 * against a policy that could have declared it.
 */
const CLEAN_SET_PATH = "cleanup-notes.txt";

/**
 * A repository the base gates can run in: `typecheck` and `test` scripts that
 * exit 0, so the regression bundle a cleaner round has to keep green is a real
 * bundle of real commands rather than a set of absent-script skips.
 */
function makeCleanerRepo(): string {
  const repo = makeRepo();
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({
      name: "cleaner-fixture",
      private: true,
      scripts: { typecheck: 'node -e "0"', test: 'node -e "0"' },
    }),
    "utf-8",
  );
  git(repo, ["add", "package.json"]);
  git(repo, ["commit", "-m", "add gate scripts"]);
  return repo;
}

/**
 * The shared context, plus the one thing the other scenarios in this file do
 * without: a **real slice worktree**, cut outside the repository.
 *
 * Every other fixture here runs the slice in the repository root, which is
 * cheaper and harmless while every gate runs against a materialized checkpoint.
 * The cleaner's round 0 does not: it gates the accepted tree *in place*, in
 * `ctx.worktreeDir`, and `runGates` restores a gate checkout with
 * `git clean -ffdx`. With `worktreeDir === repoRoot` that sweep deletes the
 * repository's ignored `.afk/` — this run's journal, its gate evidence, its run
 * state and its cleaner archives — which production can never see, because a
 * slice worktree is never the repository root. So the fixture takes the
 * production shape rather than narrowing what the assertions may read.
 */
function makeCleanerContext(
  provider: AgentProvider,
  clean: unknown,
  configOverrides: Parameters<typeof makeContext>[2] = {},
): { repo: string; worktree: string; ctx: ReturnType<typeof makeContext> } {
  const repo = makeCleanerRepo();
  const ctx = makeContext(repo, provider, {
    commandTimeoutMs: 30_000,
    heartbeatIntervalMs: 20,
    infrastructureRetries: 0,
    ...configOverrides,
  });
  // The locked pair on the feature branch, where the contract phase leaves it,
  // so the worktree cut below carries it.
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "lock the contract pair"]);
  const worktreeParent = mkdtempSync(join(tmpdir(), "afk-qa-070-wt-"));
  dirs.push(worktreeParent);
  const worktree = join(worktreeParent, "wt");
  git(repo, ["worktree", "add", "-b", "slice-01", worktree, "main"]);
  ctx.worktreeDir = worktree;
  ctx.branch = "slice-01";
  ctx.absSliceDir = join(worktree, ctx.relSliceDir);
  // The run's policy snapshot, never a read of the candidate worktree: a
  // candidate that could author `gatePolicy.clean` could delete the stage that
  // checks it (#251, and #87's call site for the same reason).
  ctx.runGatePolicy = parseGatePolicy(
    { version: 1, clean },
    "fixture afk.config.json",
  );
  return { repo, worktree, ctx };
}

function treeOf(repo: string, revision = "HEAD"): string {
  return execFileSync("git", ["rev-parse", `${revision}^{tree}`], {
    cwd: repo,
    encoding: "utf-8",
  }).trim();
}

function subjects(repo: string, grep: string): string[] {
  return execFileSync(
    "git",
    ["log", "--format=%s", `--grep=${grep}`, "--fixed-strings"],
    { cwd: repo, encoding: "utf-8" },
  )
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "");
}

/** One gate attempt's evidence, as the assertions below read it. */
interface GateAttemptEvidence {
  results: Array<{
    gateId: string;
    status: string;
    failureKind: string | null;
    detail?: string;
  }>;
}

function evidenceAttempts(evidenceDir: string): GateAttemptEvidence[] {
  return readdirSync(evidenceDir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map(
      (name) =>
        JSON.parse(
          readFileSync(join(evidenceDir, name), "utf-8"),
        ) as GateAttemptEvidence,
    );
}

/**
 * A run whose cleaner escalates the approved baseline and then cleans the
 * candidate the generator re-approved (#87 B-03, B-06, B-09, B-13, B-14).
 *
 * A new spawned scenario, and the last resort it is supposed to be
 * (`CLAUDE.md`, "Where a new assertion goes"). The orchestrator-side state no
 * cheaper assertion reaches: the *position* of the stage between the approval
 * commit and the post-approval writing stage, the round-gate bundle assembled
 * from this round's own pre-QA and full-suite declarations, the archive names
 * stamped with the generator round the approval happened in, and the second
 * `PersistedQualityStage` entry a re-approval opens — every one of which is a
 * value only `runSliceExecute` can produce. `src/cleaner-stage.test.ts` owns
 * the round loop itself, against the same seams this run wires up.
 *
 * One run, several assertions, and every fact captured *inside* the hook: the
 * shared `afterEach` removes the fixture repository.
 */
describe("a clean policy escalates, then repairs the re-approved tree", () => {
  let phase: unknown;
  let generatorRounds = 0;
  let cleanerCalls = 0;
  /** Every role dispatch and the writing stage, in the order they happened. */
  let order: string[] = [];
  let generatorPrompts: string[] = [];
  let cleanerPrompts: string[] = [];
  /** The tree, and the count of accepted commits, at each cleaner dispatch. */
  let treesAtCleaner: string[] = [];
  let acceptedAtCleaner: number[] = [];
  let sweepCommits: string[] = [];
  let archivedNames: string[] = [];
  let attemptsWithFormat: GateAttemptEvidence[] = [];
  let stages: unknown;
  let finalView: ReturnType<typeof finalEvaluationFor>;

  beforeAll(async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    generatorRounds = 0;
    cleanerCalls = 0;
    order = [];
    generatorPrompts = [];
    cleanerPrompts = [];
    treesAtCleaner = [];
    acceptedAtCleaner = [];
    let artifactDir = "";
    let relSliceDir = "";
    let tree = "";
    const provider: AgentProvider = {
      name: "stub",
      async invoke(options: InvokeOptions): Promise<InvokeResult> {
        if (options.role === "generator") {
          generatorRounds++;
          generatorPrompts.push(options.prompt ?? "");
          order.push(`generator-${generatorRounds}`);
          writeFileSync(
            join(tree, "change.txt"),
            `round ${generatorRounds}\n`,
            "utf-8",
          );
        } else if (options.role === "evaluator-qa") {
          order.push("evaluator-qa");
          writeFileSync(
            join(artifactDir, "qa-report.md"),
            "# QA Report\n\n**Verdict:** PASS\n**Failure class:** NONE\n",
            "utf-8",
          );
          writeQAReview(artifactDir, "deterministic");
        } else if (options.role === "cleaner") {
          cleanerCalls++;
          cleanerPrompts.push(options.prompt ?? "");
          order.push(`cleaner-${cleanerCalls}`);
          treesAtCleaner.push(treeOf(tree));
          acceptedAtCleaner.push(subjects(tree, "feat(#70)").length);
          if (cleanerCalls === 1) {
            // The first approval is refused rather than cleaned: the clean gate
            // cannot be cleared without changing what the tree does.
            writeFileSync(
              join(artifactDir, CLEANER_ESCALATION_FILENAME),
              JSON.stringify({
                version: 1,
                class: "BASELINE_IS_WRONG",
                id: "CL-01",
                summary: "the approved tree cannot be formatted",
                evidence: "format exits 1 on change.txt",
                expected: "change.txt is written in the project's format",
                observed: "change.txt is written in another format",
              }),
              "utf-8",
            );
          } else {
            // The clean-up itself: the declared file, rewritten so the clean
            // gate is green.
            writeFileSync(
              join(tree, "change.txt"),
              `round ${generatorRounds}, ${CLEAN_MARKER}\n`,
              "utf-8",
            );
          }
        } else if (options.role === "evaluator-final") {
          order.push("evaluator-final");
          const prompt = options.prompt ?? "";
          const treeIdFrom = (label: string): string => {
            const match = new RegExp(`${label} tree ID: \`([^\`]+)\``).exec(
              prompt,
            );
            expect(match, `${label} tree ID in the prompt`).not.toBe(null);
            return match![1]!;
          };
          const reviewDir = join(options.cwd ?? tree, relSliceDir);
          mkdirSync(reviewDir, { recursive: true });
          writeFileSync(
            join(reviewDir, "final-review.json"),
            JSON.stringify({
              version: 1,
              verdict: "PASS",
              baselineTreeId: treeIdFrom("Approved baseline"),
              finalTreeId: treeIdFrom("Final checkpoint"),
              findings: [],
            }),
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
    const { repo, worktree, ctx } = makeCleanerContext(
      provider,
      { gates: [FORMAT_GATE], additionalWriteScope: [CLEAN_SET_PATH] },
      {
        postApprovalWritingStage: () => {
          order.push("writing-stage");
        },
      },
    );
    artifactDir = ctx.absSliceDir;
    relSliceDir = ctx.relSliceDir;
    tree = worktree;

    phase = await runSliceExecute(ctx);

    sweepCommits = subjects(worktree, "chore(#70): cleaner round");
    archivedNames = readdirSync(
      join(repo, ".afk", "artifacts", "prd-070-stub", "slice-01", "reviews"),
    );
    attemptsWithFormat = evidenceAttempts(
      join(ctx.logger.runDir, "gates", "s01"),
    ).filter((attempt) =>
      attempt.results.some((gate) => gate.gateId === "format"),
    );
    stages = JSON.parse(
      JSON.stringify(qualityStagesFor(loadRunState(repo, "prd-070-stub"), "70")),
    );
    finalView = finalEvaluationFor(loadRunState(repo, "prd-070-stub"), "70");
  }, 300_000);

  it("[behavior:#87:B-03] runs after the approval commit and before the post-approval writing stage", () => {
    expect(phase).toEqual({ phase: "PASS" });
    // The stage's position, which is the whole of B-03: every cleaner dispatch
    // sits after that round's QA verdict and its approval commit, and the
    // writing stage runs once, after the cleaner released a tree.
    expect(order).toEqual([
      "generator-1",
      "evaluator-qa",
      "cleaner-1",
      "generator-2",
      "evaluator-qa",
      "cleaner-2",
      "writing-stage",
      "evaluator-final",
    ]);
    // The tree it cleans is the one the gates authorized and the QA verdict is
    // tied to: the approval commit already exists at every dispatch.
    expect(acceptedAtCleaner).toEqual([1, 2]);
  });

  it("[behavior:#87:B-06] gates the round's checkpoint against the bundle the approval rested on", () => {
    // Round 0 gates the accepted tree with the clean gates and nothing else,
    // once per approval, and both times red — which is what buys a round.
    const roundZero = attemptsWithFormat.filter(
      (attempt) => attempt.results.length === 1,
    );
    expect(roundZero).toHaveLength(2);
    for (const attempt of roundZero) {
      expect(attempt.results[0]).toMatchObject({
        gateId: "format",
        status: "FAIL",
      });
    }
    // The round's own gate run: the clean gate first, then the scope,
    // feedback-integrity, skip and suppression gates, then the regression
    // bundle this round already resolved. Containment and relative order, per
    // `expectDeclaresInOrder`'s contract.
    const roundOne = attemptsWithFormat.filter(
      (attempt) => attempt.results.length > 1,
    );
    expect(roundOne).toHaveLength(1);
    expectDeclaresInOrder(
      roundOne[0]!.results.map((gate) => gate.gateId),
      [
        "format",
        "scope",
        "feedback-integrity",
        "tests:skipped",
        "suppressions",
        "tests",
      ],
    );
    expect(
      roundOne[0]!.results.every(
        (gate) => gate.status === "PASS" || gate.status === "SKIPPED",
      ),
    ).toBe(true);
    // The sweep commit the round's checkpoint is taken from — one per round
    // that wrote, and the escalating round wrote none.
    expect(sweepCommits).toEqual(["chore(#70): cleaner round 1"]);
  });

  it("[behavior:#87:B-09] archives each round under the cleaner prefix, stamped with the generator round", () => {
    // The escalation is archived before the reset that discards it, and every
    // round's agent log with it — the one account of the round's reasoning that
    // survives a `git reset --hard`. `r1` and `r2` are the generator rounds the
    // two approvals happened in; `a1` is each stage's own first round.
    expect(archivedNames).toContain("cleaner-review-r1-a1.json");
    expect(archivedNames).toContain("cleaner-log-r1-a1.log");
    expect(archivedNames).toContain("cleaner-log-r2-a1.log");
    // Its own prefix, not the final evaluator's: both stages archive into this
    // one directory, so the prefix is the only thing that keeps a cleaner
    // round's review and a final grading apart.
    expect(archivedNames).toContain("final-review-r2-a1.json");
    expect(
      archivedNames.filter((name) => name.startsWith("cleaner-")).sort(),
    ).toEqual([
      "cleaner-log-r1-a1.log",
      "cleaner-log-r2-a1.log",
      "cleaner-review-r1-a1.json",
    ]);
  });

  it("[behavior:#87:B-13] returns the slice to the generator with the baseline citation invalidated", () => {
    // One generator round bought by the escalation, and the failure set it was
    // handed cites the escalation's id and the archived artifact — not the live
    // file, which the reset removed.
    expect(generatorRounds).toBe(2);
    expect(generatorPrompts[1]).toContain("CL-01");
    expect(generatorPrompts[1]).toContain("cleaner-review-r1-a1.json");
    expect(generatorPrompts[1]).toContain(
      "change.txt is written in the project's format",
    );
    // The accepted tree the escalation refused is invalidated, so the
    // re-approved candidate cannot stand on it — and the escalation itself
    // consumed no final-evaluation attempt.
    expect(finalView?.invalidatedCandidateTreeIds).toEqual([treesAtCleaner[0]]);
    expect(finalView?.attempts).toHaveLength(1);
    expect(finalView?.attempts[0]).toMatchObject({
      attempt: 1,
      verdict: "PASS",
      outcome: "GRADED",
      invalidated: false,
    });
  });

  it("[behavior:#87:B-14] persists one stage entry per approval, each with its own round budget", () => {
    // A list per issue, not one record: the re-approval opens a fresh entry, so
    // the escalating round is never charged to the re-approved candidate's
    // budget — even when the two trees are identical.
    expect(stages).toEqual([
      {
        stage: "cleaner",
        enabled: true,
        outcome: "ESCALATED",
        rounds: [
          {
            round: 1,
            attempt: 1,
            inputTreeId: treesAtCleaner[0],
            gateIds: [],
            outcome: "ESCALATED",
          },
        ],
      },
      {
        stage: "cleaner",
        enabled: true,
        outcome: "PASS",
        rounds: [
          expect.objectContaining({
            round: 1,
            attempt: 2,
            inputTreeId: treesAtCleaner[1],
            outcome: "PASS",
          }),
        ],
      },
    ]);
    // And the round the second entry recorded is the one whose gate ids the
    // evidence above shows, so the persisted record and the evidence agree.
    expect(
      (stages as Array<{ rounds: Array<{ gateIds: string[] }> }>)[1]!.rounds[0]!
        .gateIds,
    ).toContain("format");
  });
});

/**
 * A run whose cleaner reverts a regressing round and then spends its bound
 * (#87 B-07, B-08).
 *
 * The second and last new spawn. What no cheaper assertion reaches: the
 * `finishStuck` route out of an exhausted stage — the code-assembled `stuck.md`
 * listing every remaining red gate with its detail and its log artifact id, and
 * the preserved last checkpoint the reason promises an operator. The revert
 * itself is unit-tested in `src/cleaner-stage.test.ts`; what is here is that
 * the orchestrator turns the exhaustion into a STUCK diagnosis rather than a
 * merge, and that an *optional* red clean gate never contributes to either.
 */
describe("a clean policy reverts a regression and exhausts its rounds", () => {
  const UNDECLARED = "undeclared-cleanup.txt";
  let phase: { phase: string; error?: string } | undefined;
  let cleanerCalls = 0;
  let cleanerPrompts: string[] = [];
  let stuckDiagnosis = "";
  let sweepCommits: string[] = [];
  let undeclaredSurvived = true;
  let headTree = "";
  let stages: unknown;
  let roundAttempts: GateAttemptEvidence[] = [];

  beforeAll(async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    cleanerCalls = 0;
    cleanerPrompts = [];
    let artifactDir = "";
    let tree = "";
    const provider: AgentProvider = {
      name: "stub",
      async invoke(options: InvokeOptions): Promise<InvokeResult> {
        if (options.role === "generator") {
          writeFileSync(join(tree, "change.txt"), "round 1\n", "utf-8");
        } else if (options.role === "evaluator-qa") {
          writeFileSync(
            join(artifactDir, "qa-report.md"),
            "# QA Report\n\n**Verdict:** PASS\n**Failure class:** NONE\n",
            "utf-8",
          );
          writeQAReview(artifactDir, "deterministic");
        } else if (options.role === "cleaner") {
          cleanerCalls++;
          cleanerPrompts.push(options.prompt ?? "");
          if (cleanerCalls === 1) {
            // A path the locked manifest does not declare and the clean
            // policy's `additionalWriteScope` does not widen to: the `scope`
            // gate is required and outside the clean set, so this is a
            // regression and the round goes back.
            writeFileSync(join(tree, UNDECLARED), "swept\n", "utf-8");
          } else {
            // Declared, so no regression — and still not the marker, so the
            // required clean gate stays red and the bound is what ends it.
            writeFileSync(
              join(tree, "change.txt"),
              `round 1, tidied ${cleanerCalls}\n`,
              "utf-8",
            );
          }
        }
        return { exitCode: 0, stdout: "", stats: {} };
      },
    };
    const { repo, worktree, ctx } = makeCleanerContext(provider, {
      gates: [
        FORMAT_GATE,
        // Advisory and permanently red: an optional clean gate is recorded and
        // never blocks, so it must neither buy a round nor reach the diagnosis.
        {
          id: "style",
          command: process.execPath,
          args: ["-e", "console.error('style is advisory'); process.exit(1)"],
          required: false,
          expectedCostMs: 200,
        },
      ],
      additionalWriteScope: [CLEAN_SET_PATH],
    });
    artifactDir = ctx.absSliceDir;
    tree = worktree;

    phase = (await runSliceExecute(ctx)) as { phase: string; error?: string };

    stuckDiagnosis = readFileSync(join(ctx.absSliceDir, "stuck.md"), "utf-8");
    sweepCommits = subjects(worktree, "chore(#70): cleaner round");
    undeclaredSurvived = existsSync(join(worktree, UNDECLARED));
    headTree = treeOf(worktree);
    stages = JSON.parse(
      JSON.stringify(qualityStagesFor(loadRunState(repo, "prd-070-stub"), "70")),
    );
    roundAttempts = evidenceAttempts(
      join(ctx.logger.runDir, "gates", "s01"),
    ).filter(
      (attempt) =>
        attempt.results.some((gate) => gate.gateId === "format") &&
        attempt.results.length > 2,
    );
  }, 300_000);

  it("[behavior:#87:B-07] reverts the regressing round and tells the next one what it reddened", () => {
    // The round's write is gone, and no sweep commit for it survives: a
    // regressing round is reverted with `git reset --hard`, not re-baselined.
    expect(undeclaredSurvived).toBe(false);
    expect(sweepCommits).toEqual([
      "chore(#70): cleaner round 3",
      "chore(#70): cleaner round 2",
    ]);
    expect(
      (stages as Array<{ rounds: Array<{ outcome: string }> }>)[0]!.rounds.map(
        (round) => round.outcome,
      ),
    ).toEqual(["REVERTED", "FAIL", "EXHAUSTED"]);
    // Round 2 was told, in its own prompt, what round 1 reddened and that its
    // edit is gone — the `{{REGRESSION_NOTE}}` the template declares.
    expect(cleanerCalls).toBe(3);
    // (Keyed on the note's own wording: the template body mentions
    // `git reset --hard` in every rendered prompt, note or no note.)
    expect(cleanerPrompts[0]).not.toContain("Your edit is gone");
    expect(cleanerPrompts[1]).toContain("Round 1 was reverted");
    expect(cleanerPrompts[1]).toContain("scope");
    expect(cleanerPrompts[1]).toContain("Your edit is gone");
    // Round 3 regressed nothing, so it carries no note.
    expect(cleanerPrompts[2]).not.toContain("Round 2 was reverted");
  });

  it("[behavior:#87:B-08] finishes stuck with every remaining red gate and the preserved checkpoint", () => {
    expect(phase?.phase).toBe("STUCK");
    const reason = phase?.error ?? "";
    expect(reason).toContain("spent all 3 round(s)");
    expect(reason).toContain("format (FAIL)");
    // A command gate's `detail` is not its output, so what stands in for the
    // formatter's message is the log artifact the reason cites beside it.
    expect(reason).toContain("(the gate recorded no detail)");
    expect(reason).toMatch(/-format\.log/);
    expect(reason).toContain("The last checkpoint is preserved.");
    // The diagnosis an operator reads carries the same list and cites the log.
    expect(stuckDiagnosis).toContain("format (FAIL)");
    expect(stuckDiagnosis).toMatch(/-format\.log/);
    // The optional gate was red on every round and is in none of it: it is
    // recorded, and it blocks nothing.
    expect(roundAttempts).toHaveLength(3);
    for (const attempt of roundAttempts) {
      expect(attempt.results.find((gate) => gate.gateId === "style")).
        toMatchObject({ status: "FAIL" });
    }
    expect(reason).not.toContain("style");
    // And the promise the reason makes holds: the tree the last round produced
    // is still the worktree's HEAD, not the accepted tree it started from.
    const rounds = (
      stages as Array<{
        rounds: Array<{ inputTreeId: string; outputTreeId?: string }>;
      }>
    )[0]!.rounds;
    expect(headTree).toBe(rounds[2]!.outputTreeId);
    expect(headTree).not.toBe(rounds[0]!.inputTreeId);
  });
});

/**
 * QA orchestration integration tests, part 2 of 2: the deterministic base
 * gates (stable IDs across providers, the shared gate-ID expectation,
 * gate observability), what the evaluator is handed and what leaves its
 * worktree (shared-preview QA, candidate evaluator isolation #91) and
 * final evaluation and reuse (#96). The PRD 070 QA retry loop and the
 * scope-amendment blocks live in `qa-orchestration.test.ts`.
 *
 * Two files exist so one `vitest run` schedules the suite across both
 * workers (`maxWorkers: 2`) — a single file always pinned it to one.
 * Shared helpers are in `qa-orchestration.fixtures.ts`. When adding a
 * `describe`, keep the halves balanced by measured block time
 * (`--reporter=./scripts/describe-times.reporter.mjs`), not test count.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { lifecycle } from "./slice-lifecycle.js";
import { RunJournal as Logger } from "./run-journal.js";
import {
  runQAStage,
  runSliceExecute,
  type SliceContext,
} from "./orchestrator.js";
import {
  approvedBaselineFor,
  finalEvaluationAttemptsSpent,
  finalEvaluationFor,
  invalidateFinalEvaluationBaseline,
  loadRunState,
  qualityStagesFor,
  recordFinalEvaluation,
  updateRunState,
} from "./run-state.js";
import {
  CLEANER_STAGE_ID,
  POST_APPROVAL_WRITING_STAGE_ID,
  decideFinalReuse,
} from "./final-evaluation.js";
import { MAX_CLEANER_ROUNDS, MAX_FINAL_EVALUATION_ATTEMPTS } from "./bounds.js";
import { parseGatePolicy } from "./gate-policy.js";
import { buildQualityStagePolicyEvent } from "./run-events.js";
import { readQualityStageOutcomes } from "./logger.js";
import { fileURLToPath } from "node:url";
import { resolveCandidateTreeId } from "./gate-runner.js";
import type { AgentProvider, InvokeOptions, InvokeResult } from "./agent-provider.js";
import { writeQAReview } from "./test-support.js";
import {
  cleanupQATempDirs,
  declaresInOrder,
  dirs,
  expectSomeAttemptDeclaresInOrder,
  GENERATOR_FIXTURE_CONTRACT,
  GENERATOR_FIXTURE_SCOPE,
  git,
  makeContext,
  makeRepo,
  spawnFixtureChild,
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
    expect(bumped.version).toBe(6);
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
  it("[behavior:P-01] [behavior:#97:P-08] introduces no second lock primitive anywhere in this slice's modules", () => {
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
      // #97's two additions to the set: the stage that now takes a restore, and
      // the ship gate that now renders what the stages cost.
      "src/cleaner-stage.ts",
      "src/ship-gate.ts",
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
   * A clean gate that is red until `README.md` carries {@link CLEAN_MARKER}.
   *
   * Content in an already-declared path rather than a new file, for the reason
   * `src/qa-orchestration.test.ts`'s cleaner fixture gives: `additionalWriteScope`
   * widens the *round's* scope gate, but the final candidate is still gated
   * against the manifest alone, so a marker file would fail the final `scope`
   * gate instead of reaching the exit under test.
   */
  const CLEAN_MARKER = "formatted";
  const cleanPolicyMember = {
    gates: [
      {
        id: "format",
        command: process.execPath,
        args: [
          "-e",
          `if (!require('node:fs').readFileSync('README.md', 'utf-8')` +
            `.includes('${CLEAN_MARKER}')) { ` +
            `console.error('the formatter would rewrite README.md'); ` +
            `process.exit(1); }`,
        ],
        required: true,
        expectedCostMs: 200,
      },
    ],
    additionalWriteScope: [],
  };

  /**
   * The four spawned scenarios below share this fixture: a repo with the gate
   * scripts committed, a QA evaluator that passes, and an injected
   * post-approval writing stage whose stub write changes the tree — which is
   * what gives the final evaluator a subject at all.
   *
   * `clean` opts the run into a real `gatePolicy.clean`, which changes the
   * fixture's shape in one way that matters: the cleaner's round 0 gates the
   * accepted tree *in place* in `ctx.worktreeDir`, and `runGates` restores a
   * gate checkout with `git clean -ffdx`, so a worktree that is the repository
   * root has this run's `.afk/` — journal, evidence, run state, archives —
   * swept out from under the assertions. A real slice worktree cut outside the
   * repository is production's shape, and the only one those reads survive.
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
    /** `gatePolicy.clean` for this run, snapshotted as the run's policy. */
    clean?: unknown;
    /** Answers one `cleaner` dispatch, standing in the slice worktree. */
    onCleaner?: (call: {
      call: number;
      worktreeDir: string;
      prompt: string;
    }) => void;
    /**
     * Cleaner rounds a killed run already spent, seeded as a non-terminal
     * `qualityStages` entry so `resumableCleanerStage` resolves.
     */
    seedCleanerRoundsSpent?: number;
  }): {
    repo: string;
    /** Where the slice runs: a cut worktree with `clean`, the repo without. */
    worktree: string;
    ctx: SliceContext;
    finalCalls: { cwd: string; finalTreeId: string }[];
    stageCalls: { worktreeDir: string; stageId: string; repair?: string }[];
    cleanerPrompts: string[];
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
    let sliceWorktree = repo;
    const cleanerPrompts: string[] = [];
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
        if (invokeOptions.role === "cleaner") {
          cleanerPrompts.push(invokeOptions.prompt ?? "");
          options.onCleaner?.({
            call: cleanerPrompts.length,
            worktreeDir: sliceWorktree,
            prompt: invokeOptions.prompt ?? "",
          });
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
    if (options.clean !== undefined) {
      // The locked pair on the feature branch, where the contract phase leaves
      // it, so the worktree cut below carries it.
      git(repo, ["add", "-A"]);
      git(repo, ["commit", "-m", "lock the contract pair"]);
      const worktreeParent = mkdtempSync(join(tmpdir(), "afk-qa-097-wt-"));
      dirs.push(worktreeParent);
      const worktree = join(worktreeParent, "wt");
      git(repo, ["worktree", "add", "-b", "slice-01", worktree, "main"]);
      ctx.worktreeDir = worktree;
      ctx.branch = "slice-01";
      ctx.absSliceDir = join(worktree, ctx.relSliceDir);
      sliceWorktree = worktree;
      // The run's policy snapshot, never a read of the candidate worktree: a
      // candidate that could author `gatePolicy.clean` could delete the stage
      // that checks it (#251, and #87's call site for the same reason).
      ctx.runGatePolicy = parseGatePolicy(
        { version: 1, clean: options.clean },
        "fixture afk.config.json",
      );
    }
    if (options.seedCleanerRoundsSpent !== undefined) {
      // A killed stage's entry, left non-terminal so `resumableCleanerStage`
      // resolves and this run continues its budget rather than restarting it.
      updateRunState(repo, "prd-070-stub", (state) => {
        state.qualityStages = {
          "70": [
            {
              stage: "cleaner",
              enabled: true,
              rounds: Array.from(
                { length: options.seedCleanerRoundsSpent! },
                (_unused, index) => ({
                  round: index + 1,
                  attempt: 1,
                  inputTreeId: "0".repeat(40),
                  gateIds: ["format"],
                  outcome: "REVERTED" as const,
                }),
              ),
              outcome: "EXHAUSTED",
            },
          ],
        };
      });
    }
    artifactDir = ctx.absSliceDir;
    relSliceDir = ctx.relSliceDir;
    return {
      repo,
      worktree: ctx.worktreeDir,
      ctx,
      finalCalls,
      stageCalls,
      cleanerPrompts,
    };
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

  it("[behavior:B-09] [behavior:#97:P-03] returns a baseline-is-wrong finding to the generator loop for exactly one round and no evaluator attempt", async () => {
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

  /** Every `quality-stage-attempt` line the run journaled, in stream order. */
  function attemptEvents(runDir: string): Record<string, unknown>[] {
    return readFileSync(join(runDir, "events.jsonl"), "utf-8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((event) => event.type === "quality-stage-attempt");
  }

  /**
   * Every file under `root`, repo-relative-ish: the pair of its containing
   * directory and its name. Used to *discover* an archive directory rather than
   * pin it — the segment beneath `.afk/artifacts/<run-slug>/slice-<n>/` is
   * composed by the out-of-scope `src/artifacts.ts`, so #97 B-13 pins the file
   * stem and resolves the directory from the run's own tree.
   */
  function filesUnder(root: string): { dir: string; name: string }[] {
    if (!existsSync(root)) return [];
    const out: { dir: string; name: string }[] = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) out.push(...filesUnder(path));
      else out.push({ dir: root, name: entry.name });
    }
    return out;
  }

  it("[behavior:#97:B-07] [behavior:#97:B-08] [behavior:#97:B-12] a cleaner commit faces the final evaluator, and both stages report what they cost", async () => {
    // S1. The candidate PASS alone did not certify this tree: the cleaner
    // committed onto it after the approval, so `decideFinalReuse` answers
    // `evaluate` and one evaluator-final invocation grades it (#97 AC1). A
    // spawned scenario because only an executing run can put a cleaner commit
    // in front of the final evaluator.
    const fixture = finalEvaluationFixture({
      review: passingReview,
      stageWrites: false,
      clean: cleanPolicyMember,
      onCleaner: (call) => {
        // The declared file, rewritten so the clean gate is green.
        writeFileSync(
          join(call.worktreeDir, "README.md"),
          `fixture, ${CLEAN_MARKER}\n`,
          "utf-8",
        );
      },
    });

    const result = await runSliceExecute(fixture.ctx);

    expect(result.phase).toBe("PASS");
    expect(fixture.cleanerPrompts).toHaveLength(1);
    const view = finalEvaluationFor(
      loadRunState(fixture.repo, "prd-070-stub"),
      "70",
    );
    expect(view?.decision).toBe("evaluate");
    expect(fixture.finalCalls).toHaveLength(1);

    // B-07: one cleaner attempt line, measured off this run's own round.
    const attempts = attemptEvents(fixture.ctx.logger.runDir);
    const cleanerAttempts = attempts.filter(
      (event) => event.stage === CLEANER_STAGE_ID,
    );
    expect(cleanerAttempts).toHaveLength(1);
    expect(cleanerAttempts[0]).toMatchObject({
      ghIssue: "70",
      sliceNumber: "01",
      stage: CLEANER_STAGE_ID,
      stageRound: 1,
      attempt: 1,
      outcome: "PASS",
    });
    // The round committed, so it is measured as a tree change, and its gate ids
    // are the round's own bundle rather than a hand-written list.
    expect(cleanerAttempts[0]!.outputTreeId).not.toBe(
      cleanerAttempts[0]!.inputTreeId,
    );
    expect(cleanerAttempts[0]!.gateIds).toContain("format");
    expect(Array.isArray(cleanerAttempts[0]!.cacheReusedGateIds)).toBe(true);
    expect(cleanerAttempts[0]!.durationMs as number).toBeGreaterThanOrEqual(0);

    // B-08: one final-evaluation attempt line for the one attempt spent.
    const finalAttempts = attempts.filter(
      (event) => event.stage === "final-evaluation",
    );
    expect(finalAttempts).toHaveLength(1);
    expect(finalAttempts[0]).toMatchObject({
      stage: "final-evaluation",
      stageRound: 1,
      attempt: 1,
      outcome: "PASS",
      outputTreeId: fixture.finalCalls[0]!.finalTreeId,
    });
    expect(finalAttempts[0]!.gateIds).toContain("scope");

    // B-10: the rows render from those events under #274's header lines. The
    // header event is a run-level record (`src/orchestrator.ts:8597`), emitted
    // before the wave loop that calls `runSliceExecute` exists — so the fixture
    // supplies it from the same production builder. The rows beneath it are
    // still derived from the attempt events this run journaled.
    fixture.ctx.logger.event(
      buildQualityStagePolicyEvent(fixture.ctx.runGatePolicy),
    );
    const md = fixture.ctx.logger.writeSummary();
    const section = md.indexOf("## Quality Stages");
    expect(section).toBeGreaterThan(-1);
    expect(md.slice(section)).toContain("| Slice | Stage | Enabled |");
    expect(md.slice(section)).toContain(`| #70 | ${CLEANER_STAGE_ID} | yes |`);
    // B-09 over the run's real stream, not a hand-seeded one.
    expect(
      readQualityStageOutcomes(fixture.ctx.logger.runDir).map((o) => [
        o.stage,
        o.roundsUsed,
        o.finalDecision,
      ]),
    ).toEqual([
      [CLEANER_STAGE_ID, 1, "evaluate"],
      ["final-evaluation", 1, "evaluate"],
    ]);

    // B-12: the cleaner's bytes are attributed to the cleaner, and the two
    // spans tile the whole baseline → final range.
    const summary = JSON.parse(
      readFileSync(
        join(
          fixture.repo,
          ".afk",
          "artifacts",
          "prd-070-stub",
          "slice-01",
          "final-change-summary.json",
        ),
        "utf-8",
      ),
    ) as {
      stageOrder: string[];
      byStage: Record<string, { files: { path: string }[] }>;
    };
    expect(summary.stageOrder).toEqual([
      CLEANER_STAGE_ID,
      POST_APPROVAL_WRITING_STAGE_ID,
    ]);
    expect(
      summary.byStage[CLEANER_STAGE_ID]!.files.map((file) => file.path),
    ).toContain("README.md");
    // The injected stage is production's no-op here, so its truthful span is
    // empty — and an empty span is still an attribution.
    expect(summary.byStage[POST_APPROVAL_WRITING_STAGE_ID]!.files).toEqual([]);
  });

  it("[behavior:#97:P-01] [behavior:#97:P-06] reuses on exact tree equality with no cleaner declared, and reports the stage as disabled with no row", async () => {
    // S2. An `it` on the shared fixture, not a fourth spawn.
    const fixture = finalEvaluationFixture({
      review: passingReview,
      stageWrites: false,
    });

    const result = await runSliceExecute(fixture.ctx);

    expect(result.phase).toBe("PASS");
    const view = finalEvaluationFor(
      loadRunState(fixture.repo, "prd-070-stub"),
      "70",
    );
    expect(view?.decision).toBe("reuse");
    expect(fixture.finalCalls).toEqual([]);
    // No attempt ran, so there is nothing to pool and no row to render — the
    // #274 header line carries the whole fact, exactly as it did before #97.
    expect(readQualityStageOutcomes(fixture.ctx.logger.runDir)).toEqual([]);
    fixture.ctx.logger.event(
      buildQualityStagePolicyEvent(fixture.ctx.runGatePolicy),
    );
    const md = fixture.ctx.logger.writeSummary();
    const section = md.indexOf("## Quality Stages");
    expect(section).toBeGreaterThan(-1);
    expect(md.slice(section)).toContain(`\`${CLEANER_STAGE_ID}\`: disabled`);
    expect(md.slice(section)).not.toContain("| Slice | Stage | Enabled |");
  });

  it("[behavior:#97:B-04] [behavior:#97:B-13] refuses a restore for want of a cleaner round, reverts the cleaner's range, and reuses the accepted tree", async () => {
    // S3. Two rounds are already spent when this run starts, so the committing
    // round is the third of three: the restore the final evaluator then asks for
    // has no round to spend, and the whole cleaner range goes back instead.
    expect(MAX_CLEANER_ROUNDS).toBe(3);
    const fixture = finalEvaluationFixture({
      clean: cleanPolicyMember,
      seedCleanerRoundsSpent: 2,
      stageWrites: false,
      onCleaner: (call) => {
        writeFileSync(
          join(call.worktreeDir, "README.md"),
          `fixture, ${CLEAN_MARKER}\n`,
          "utf-8",
        );
      },
      review: (call) =>
        call.attempt === 1
          ? {
              version: 1,
              verdict: "FAIL",
              baselineTreeId: call.baselineTreeId,
              finalTreeId: call.finalTreeId,
              findings: [
                {
                  id: "FE-02",
                  class: "PRESERVATION",
                  summary: "the cleaner dropped behavior the approval had",
                  evidence: "README.md lost a line the baseline carried",
                  expected: "the approved README.md content survives",
                  observed: "the cleaner's round rewrote it away",
                  repair: "RESTORE",
                },
              ],
            }
          : passingReview(call),
    });

    const result = await runSliceExecute(fixture.ctx);

    expect(result.phase).toBe("PASS");
    // The round that committed was round 3 of 3, so nothing was left to spend.
    expect(fixture.cleanerPrompts).toHaveLength(1);
    // The restore went to the cleaner branch, not to the injected stub: the stub
    // is called exactly once, for the stage itself, and never with a repair.
    expect(fixture.stageCalls).toEqual([
      {
        worktreeDir: fixture.worktree,
        stageId: POST_APPROVAL_WRITING_STAGE_ID,
      },
    ]);
    // The stage's own outcome, re-stamped by the revert.
    expect(
      qualityStagesFor(
        loadRunState(fixture.repo, "prd-070-stub"),
        "70",
      ).at(-1)?.outcome,
    ).toBe("EXHAUSTED");
    // The whole cleaner range is gone: the surviving tree is the tree the accept
    // seam handed the stage, which the run itself names as the round's
    // `inputTreeId` — read off the stream rather than recomputed here.
    const cleanerAttempt = attemptEvents(fixture.ctx.logger.runDir).find(
      (event) => event.stage === CLEANER_STAGE_ID,
    );
    expect(cleanerAttempt?.stageRound).toBe(3);
    expect(
      execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
        cwd: fixture.worktree,
        encoding: "utf-8",
      }).trim(),
    ).toBe(cleanerAttempt?.inputTreeId);
    // And that tree is the one the baseline authorizes, so the next iteration
    // reuses instead of spending a second evaluator attempt on it.
    const view = finalEvaluationFor(
      loadRunState(fixture.repo, "prd-070-stub"),
      "70",
    );
    expect(view?.decision).toBe("reuse");
    expect(fixture.finalCalls).toHaveLength(1);

    // B-13: the stem is pinned — `r1` is the first generator round, `a3` the
    // third cleaner round — and its directory is discovered from the run's own
    // artifact tree rather than written into the assertion.
    const archived = filesUnder(
      join(fixture.repo, ".afk", "artifacts", "prd-070-stub", "slice-01"),
    ).filter((file) => file.name === "cleaner-log-r1-a3.log");
    expect(
      archived.map((file) => file.name),
      "the archived round log, found anywhere under the run's slice artifacts",
    ).toEqual(["cleaner-log-r1-a3.log"]);
  });
});

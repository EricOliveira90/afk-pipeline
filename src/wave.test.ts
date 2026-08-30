/**
 * Wave integration tests, part 1 of 2: `runWave` lane scheduling, the
 * negotiate failure causes (issue #40) and the per-slice outcome hook.
 * The migration-flavoured blocks live in `wave-migrations.test.ts`.
 *
 * Two files exist so one `vitest run` schedules the suite across both
 * workers (`maxWorkers: 2`) — a single file always pinned it to one.
 * Shared helpers are in `wave.fixtures.ts`. When adding a `describe`,
 * keep the halves balanced by measured block time
 * (`--reporter=./scripts/describe-times.reporter.mjs`), not test count.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executionLanes, runWave, type WaveOutcome } from "./wave.js";
import {
  makeAsyncMutex,
  makeSliceContext,
  runSliceNegotiate,
  sliceBranch,
} from "./orchestrator.js";
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
import {
  buildStubProvider,
  cleanupWaveTempDirs,
  deathError,
  findSliceArtifactDir,
  git,
  makeRepo,
  setupWave,
  sliceFromCwd,
  type ProviderDeath,
  type SliceFixture,
} from "./wave.fixtures.js";
import { writeContractReview, writeQAReview } from "./test-support.js";

afterEach(() => {
  cleanupWaveTempDirs();
});
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
  }, 240_000);

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
  }, 240_000);

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
  }, 240_000);

  it("continues a same-file independent sibling after a contract impasse parks", async () => {
    const repo = makeRepo();
    const slices: Slice[] = [
      {
        number: "01",
        ghIssue: "311",
        title: "Parked",
        type: "AFK",
        blockedBy: [],
        userStories: "",
      },
      {
        number: "02",
        ghIssue: "312",
        title: "Continues",
        type: "AFK",
        blockedBy: [],
        userStories: "",
      },
    ];
    const fixtures = new Map<string, SliceFixture>([
      [
        "311",
        {
          files: ["src/shared-impasse.txt"],
          qaPasses: true,
          outputFile: "src/shared-impasse.txt",
          outputContent: "parked",
          contractImpasse: true,
        },
      ],
      [
        "312",
        {
          files: ["src/shared-impasse.txt"],
          qaPasses: true,
          outputFile: "src/shared-impasse.txt",
          outputContent: "continued",
        },
      ],
    ]);
    const { config, dag, logger, featBranch, records } = setupWave(
      repo,
      "wave-impasse-continue",
      slices,
      fixtures,
    );

    const { outcomes } = await runWave({
      waveNumber: 1,
      readyIds: ["311", "312"],
      config,
      dag,
      logger,
      featBranch,
      relevantFilesBlock: "- README.md",
      testCommand: "pnpm test",
      mergeMutex: makeAsyncMutex(),
    });

    expect(outcomes.get("311")?.phase).toBe("AWAITING-ADJUDICATION");
    expect(outcomes.get("312")?.phase).toBe("PASS");
    expect(records).not.toContain("generator:311");
    expect(records).toContain("generator:312");
    git(repo, ["checkout", featBranch]);
    expect(
      readFileSync(join(repo, "src", "shared-impasse.txt"), "utf-8"),
    ).toContain("continued");
  }, 240_000);

  // A new spawned scenario is necessary: existing wave fixtures either
  // park an impasse before lane partitioning or enter a lane without an
  // accepted human decision, so none reaches #133's destructive window.
  it("keeps an adjudicated lane successor's decision and lock through refresh (#133)", async () => {
    const repo = makeRepo();
    const slices: Slice[] = [
      {
        number: "01",
        ghIssue: "321",
        title: "Lane predecessor",
        type: "AFK",
        blockedBy: [],
        userStories: "",
      },
      {
        number: "02",
        ghIssue: "322",
        title: "Adjudicated successor",
        type: "AFK",
        blockedBy: [],
        userStories: "",
      },
    ];
    const sharedFile = "src/shared-adjudicated.txt";
    const fixtures = new Map<string, SliceFixture>([
      [
        "321",
        {
          files: [sharedFile],
          qaPasses: true,
          outputFile: sharedFile,
          outputContent: "predecessor",
        },
      ],
      [
        "322",
        {
          files: [sharedFile],
          qaPasses: true,
          outputFile: sharedFile,
          outputContent: "successor",
          contractImpasse: true,
        },
      ],
    ]);
    const { config, dag, logger, featBranch, provider } = setupWave(
      repo,
      "wave-adjudicated-successor",
      slices,
      fixtures,
    );

    // Prepare the exact Phase-A state from defect #133: the future lane
    // successor has a complete human decision and accepted lock in its
    // slice worktree before its predecessor executes.
    const successor = slices[1]!;
    const successorCtx = makeSliceContext(
      config,
      successor,
      logger,
      featBranch,
      "- README.md",
      "pnpm test",
    );
    expect((await runSliceNegotiate(successorCtx)).phase).toBe(
      "AWAITING-ADJUDICATION",
    );
    writeFileSync(
      join(successorCtx.absSliceDir, "adjudication.md"),
      JSON.stringify({
        version: 1,
        findingId: "F-IMPASSE",
        winningPosition: "PLANNER",
        author: "Ada",
      }),
      "utf-8",
    );
    expect((await runSliceNegotiate(successorCtx)).phase).toBe("LOCKED");

    const decisionPath = join(
      successorCtx.absSliceDir,
      "adjudication-decisions.json",
    );
    expect(JSON.parse(readFileSync(decisionPath, "utf-8"))).toMatchObject({
      applied: true,
      decisions: [{ decision: { findingId: "F-IMPASSE" } }],
    });

    // The estate as it stands before the lane refresh, file by file. The
    // audit assertion is byte-identity rather than mere presence (ADR 0055
    // Seam 2, plan step 9): lane refresh is the one operation that reaches
    // a slice's worktree while the slice itself is not being dispatched,
    // and `recreateWorktreeFromBase` + the stale-artifact `rmSync` beside
    // it are what #133 aimed at these exact paths.
    const ESTATE = [
      "contract-negotiation-outcome.json",
      "adjudication-decisions.json",
      "contract.md",
    ] as const;
    const estateBefore = new Map(
      ESTATE.map((name) => [
        name,
        readFileSync(join(successorCtx.absSliceDir, name), "utf-8"),
      ]),
    );
    const branchTipBefore = git(repo, ["rev-parse", successorCtx.branch]);

    let decisionPresentAtGenerator = false;
    let acceptedLockPresentAtGenerator = false;
    /** Estate names whose bytes changed between negotiation and generation. */
    let estateDriftAtGenerator: string[] | undefined;
    config.provider = {
      name: "stub",
      async invoke(options: InvokeOptions): Promise<InvokeResult> {
        const slice = sliceFromCwd(options.cwd, slices);
        if (slice?.ghIssue === "322" && options.role === "generator") {
          const artifactDir = findSliceArtifactDir(options.cwd, slice.number)!;
          const record = JSON.parse(
            readFileSync(
              join(artifactDir, "adjudication-decisions.json"),
              "utf-8",
            ),
          ) as { applied?: boolean };
          decisionPresentAtGenerator = record.applied === true;
          acceptedLockPresentAtGenerator = readFileSync(
            join(artifactDir, "contract.md"),
            "utf-8",
          ).includes("**Status:** LOCKED");
          estateDriftAtGenerator = [...estateBefore]
            .filter(([name, contents]) => {
              const path = join(artifactDir, name);
              return !existsSync(path) || readFileSync(path, "utf-8") !== contents;
            })
            .map(([name]) => name);
        }
        return provider.invoke(options);
      },
    };

    const { outcomes } = await runWave({
      waveNumber: 1,
      readyIds: ["321", "322"],
      config,
      dag,
      logger,
      featBranch,
      relevantFilesBlock: "- README.md",
      testCommand: "pnpm test",
      mergeMutex: makeAsyncMutex(),
    });

    expect(outcomes.get("321")?.phase).toBe("PASS");
    expect(outcomes.get("322")?.phase).toBe("PASS");
    expect(decisionPresentAtGenerator).toBe(true);
    expect(acceptedLockPresentAtGenerator).toBe(true);
    // Named, not incidental: every estate file reached generation with the
    // bytes negotiation left, and the branch was refreshed by merge rather
    // than deleted and recreated at the feature tip.
    expect(estateDriftAtGenerator).toEqual([]);
    expect(() =>
      git(repo, [
        "merge-base",
        "--is-ancestor",
        branchTipBefore,
        successorCtx.branch,
      ]),
    ).not.toThrow();
  }, 240_000);

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
  }, 240_000);

  it("partitions normalized concrete and explicit no-change scope from acceptance manifests", async () => {
    const repo = makeRepo();
    const slices: Slice[] = [
      { number: "01", ghIssue: "411", title: "First", type: "AFK", blockedBy: [], userStories: "" },
      { number: "02", ghIssue: "412", title: "Second", type: "AFK", blockedBy: [], userStories: "" },
      { number: "03", ghIssue: "413", title: "No change", type: "AFK", blockedBy: [], userStories: "" },
    ];
    const fixtures = new Map<string, SliceFixture>([
      ["411", {
        files: ["src/prose-a.ts"],
        manifestFiles: ["./SRC/shared.ts"],
        qaPasses: true,
        outputFile: "src/first.txt",
        outputContent: "first",
      }],
      ["412", {
        files: ["src/prose-b.ts"],
        manifestFiles: ["src/shared.ts"],
        qaPasses: true,
        outputFile: "src/second.txt",
        outputContent: "second",
      }],
      ["413", {
        files: ["src/prose-a.ts"],
        manifestFiles: null,
        qaPasses: true,
        outputFile: "src/no-change-observation.txt",
        outputContent: "no change fixture",
      }],
    ]);
    const { config, dag, logger, featBranch } = setupWave(
      repo,
      "wave-acceptance-scope",
      slices,
      fixtures,
    );

    const { outcomes } = await runWave({
      waveNumber: 1,
      readyIds: ["411", "412", "413"],
      config,
      dag,
      logger,
      featBranch,
      relevantFilesBlock: "- README.md",
      testCommand: "pnpm test",
      mergeMutex: makeAsyncMutex(),
    });

    expect([...outcomes.values()].map((outcome) => outcome.phase)).toEqual([
      "PASS",
      "PASS",
      "PASS",
    ]);
    const partitioned = readRunEvents(logger.runDir)?.events.find(
      (event) => event.type === "lanes-partitioned",
    );
    expect(
      partitioned?.type === "lanes-partitioned"
        ? partitioned.lanes
        : undefined,
    ).toEqual([["411", "412"], ["413"]]);
  }, 240_000);

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
  }, 240_000);

  it("refuses undeclared machine scope instead of treating prose as a lane fallback", async () => {
    const repo = makeRepo();
    const slices: Slice[] = [
      { number: "01", ghIssue: "601", title: "Known", type: "AFK", blockedBy: [], userStories: "" },
      { number: "02", ghIssue: "602", title: "Unknown", type: "AFK", blockedBy: [], userStories: "" },
    ];

    // Neither planner writes acceptance-manifest.json. Prose shape is
    // irrelevant: both slices must fail before lane partitioning.
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
            "## Evaluator feedback — round 1\n\nThe contract is testable.\n",
            "utf-8",
          );
          writeContractReview(sliceArtifactDir, "ACCEPT");
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
          writeQAReview(sliceArtifactDir, "deterministic");
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

    // Both should fail closed: no manifest means no machine scope, and
    // prose never reaches lane partitioning.
    expect(outcomes.get("601")?.phase).toBe("ESCALATE");
    expect(outcomes.get("602")?.phase).toBe("ESCALATE");
    expect(
      readRunEvents(logger.runDir)?.events.some(
        (event) => event.type === "lanes-partitioned",
      ),
    ).toBe(false);
  }, 240_000);

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
  }, 240_000);

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
  }, 240_000);

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
  }, 240_000);

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
  }, 240_000);
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
    opts?: { deaths?: ProviderDeath[]; contractVerdict?: "ACCEPT" | "REVISE" },
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
    // A REVISE fixture never converges, so cap negotiation at one round:
    // the first REVISE is also the last, and the wave sees the genuine
    // verdict rather than three identical rounds of it.
    if (opts?.contractVerdict === "REVISE") setup.config.maxContractRounds = 1;
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
  }, 240_000);

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
  }, 240_000);

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
  }, 240_000);

  it("labels a genuine evaluator verdict as a verdict, never as an infrastructure death", async () => {
    const setup = oneSlice("neg-verdict", "1301", {
      contractVerdict: "REVISE",
    });

    const outcomes = await dispatch(setup, ["1301"]);

    expect(outcomes.get("1301")?.phase).toBe("ESCALATE");
    const reason = reasonOf(outcomes.get("1301"));
    expect(reason).toContain("evaluator verdict REVISE");
    expect(reason).toContain("not an infrastructure death");
    expect(reason).not.toContain("exit code");
    expect(reason).not.toContain("killed");
    expect(reason).not.toContain("transient");
  }, 240_000);

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
  }, 240_000);

  it("refuses to retry a tool-call-cap kill even with retries available", async () => {
    // The cap only exists when a caller opted in (ADR 0036), so
    // tripping it is the configured bound working, not infrastructure
    // flaking — retrying verbatim would spend another full budget
    // re-hitting the same cap.
    const setup = oneSlice("neg-toolcap-noretry", "1501", {
      // Would recover on the second invocation if a retry were granted.
      deaths: [{ role: "evaluator-contract", kind: "tool-cap-kill", times: 1 }],
    });
    setup.config.infrastructureRetries = 2;

    const outcomes = await dispatch(setup, ["1501"]);

    expect(outcomes.get("1501")?.phase).toBe("ERROR");
    const reason = reasonOf(outcomes.get("1501"));
    expect(reason).toContain("tool-call cap");
    expect(reason).toContain("the orchestrator killed");

    // No retry was attempted: one evaluator invocation, no
    // infrastructure-retry warn events.
    expect(
      setup.records.filter((r) => r === "evaluator-contract:1501"),
    ).toHaveLength(1);
    const events = readRunEvents(setup.logger.runDir);
    const retries = (events?.events ?? []).filter(
      (e: RunEvent) => e.type === "warn" && e.reason === "infrastructure-retry",
    );
    expect(retries).toHaveLength(0);
  }, 240_000);

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
  }, 240_000);

  it("never retries a genuine verdict — it is terminal on the first occurrence", async () => {
    const setup = oneSlice("neg-verdict-terminal", "1501", {
      contractVerdict: "REVISE",
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
  }, 240_000);

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
  }, 240_000);

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
  }, 240_000);
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
  }, 240_000);

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
  }, 240_000);
});

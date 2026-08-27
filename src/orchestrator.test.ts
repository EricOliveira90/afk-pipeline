/**
 * Orchestrator tests, part 1 of 2: the unit-level gates (pre-ship
 * sanity, command resolution, contract assessment, mutex), lane
 * scheduling, the summary report, contract feedback/status, the
 * post-merge guardian review phase and run.log observability. The
 * run-state half — per-slice persistence, wall-clock ceiling, events
 * tee, re-runs, MERGE-PENDING recovery, launch guard — lives in
 * `orchestrator-runs.test.ts`.
 *
 * Two files exist so one `vitest run` schedules the suite across both
 * workers (`maxWorkers: 2`) — a single file always pinned it to one.
 * Shared integration helpers are in `orchestrator.fixtures.ts`. When
 * adding a `describe`, keep the halves balanced by measured block time
 * (`--reporter=./scripts/describe-times.reporter.mjs`), not test count.
 */
import { describe, it, expect, afterAll, afterEach, beforeAll, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assessContractExtension,
  collectRequiredGateFailures,
  isCancelled,
  makeAsyncMutex,
  makeSliceContext,
  resolveBaseGateDeclarations,
  runPipeline,
  runSliceNegotiate,
} from "./orchestrator.js";
import {
  buildPrCreationPlan,
  buildReviewScopeBlock,
} from "./ship-gate.js";
import {
  resolveGeneratorTestCommand,
  resolveSanityCommands,
  resolveTestCommand,
  runPreShipSanity,
  type SanityCommandOutcome,
  type SanityGateResult,
} from "./preship.js";
import { buildDAG, parseIssuesMd, type Slice } from "./issues-parser.js";
import { RunJournal as Logger } from "./run-journal.js";
import type {
  AgentProvider,
  InvokeOptions,
  InvokeResult,
} from "./agent-provider.js";
import { TransientProviderError } from "./agent-provider.js";
import {
  ProcessTreeTerminationError,
  runBoundedCommand,
} from "./command-runtime.js";
import type { GateDeclaration, GateEvidence } from "./gate-runner.js";
import { terminateProcessTree } from "./kill-tree.js";
import {
  buildStubProvider,
  cleanupIntegrationTempDirs,
  findSliceArtifactDir,
  git,
  makeRepo,
  sliceFromCwd,
  writePrdFixture,
  type InvocationRecord,
  type SliceFixture,
} from "./orchestrator.fixtures.js";

/**
 * Tests for the pre-ship sanity gate. The gate detects which scripts a
 * project defines and runs them in order; missing scripts are skipped, not
 * failed. Each test creates a throwaway `package.json` with crafted scripts
 * so we can drive PASS/FAIL/SKIP without spawning real linters.
 */

const tempDirs: string[] = [];

function makeProject(scripts: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "afk-sanity-"));
  tempDirs.push(dir);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "fixture", scripts }),
    "utf-8",
  );
  return dir;
}

/**
 * Marks a fixture as a pnpm project. The sanity gate's dependency install is
 * gated on a checked-in lockfile (#101), so only fixtures that opt in pay it.
 */
function withLockfile(dir: string): string {
  writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf-8");
  return dir;
}

/**
 * Records the commands `runPreShipSanity` executes, through the subprocess
 * seam so no test spawns a real install (ADR 0033; AGENTS.md test loop
 * discipline). `outcomes` overrides the result for a matching command line.
 */
function recordSanityRun(
  dir: string,
  outcomes: Record<string, SanityCommandOutcome> = {},
): { ran: string[]; result: SanityGateResult } {
  const ran: string[] = [];
  const result = runPreShipSanity(dir, (command, args) => {
    const line = [command, ...args].join(" ");
    ran.push(line);
    return outcomes[line] ?? { outcome: "EXITED", exitCode: 0 };
  });
  return { ran, result };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort
    }
  }
  cleanupIntegrationTempDirs();
});

describe("cancellation classification", () => {
  it("does not hide failed process-tree termination behind an aborted signal", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "afk-command-"));
    tempDirs.push(cwd);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);

    let thrown: unknown;
    try {
      await runBoundedCommand(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        {
          cwd,
          signal: controller.signal,
          inactivityTimeoutMs: 1_000,
          heartbeatIntervalMs: 20,
          terminateProcessTree: async (proc) => {
            await terminateProcessTree(proc);
            return {
              rootDead: true,
              survivors: [4242],
              verified: true,
            };
          },
        },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ProcessTreeTerminationError);
    expect(isCancelled(thrown, controller.signal)).toBe(false);
  }, 240_000);
});

describe("base gate infrastructure retries", () => {
  it("retains a required command failure after a later retry passes", () => {
    const declarations: GateDeclaration[] = [
      { id: "typecheck", stage: "base", required: true, command: "pnpm" },
      { id: "lint", stage: "base", required: true, command: "pnpm" },
    ];
    const result = (
      gateId: string,
      status: "PASS" | "FAIL" | "INFRASTRUCTURE",
    ) => ({
      gateId,
      stage: "base",
      status,
      failureKind: status === "FAIL" ? ("COMMAND" as const) : null,
      startedAt: "2026-08-23T10:00:00.000Z",
      endedAt: "2026-08-23T10:00:00.010Z",
      durationMs: 10,
      exitCode: status === "FAIL" ? 1 : status === "PASS" ? 0 : null,
      treeId: "tree-1",
      logArtifactId: `gate-logs/${gateId}.log`,
    });
    const attempts: Array<{ evidence: GateEvidence; evidencePath: string }> = [
      {
        evidencePath: "attempt-1.json",
        evidence: {
          version: 1,
          attemptId: "attempt-1",
          treeId: "tree-1",
          results: [
            result("typecheck", "FAIL"),
            result("lint", "INFRASTRUCTURE"),
          ],
        },
      },
      {
        evidencePath: "attempt-2.json",
        evidence: {
          version: 1,
          attemptId: "attempt-2",
          treeId: "tree-1",
          results: [result("typecheck", "PASS"), result("lint", "PASS")],
        },
      },
    ];

    expect(collectRequiredGateFailures(attempts, declarations)).toEqual([
      {
        evidencePath: "attempt-1.json",
        result: expect.objectContaining({
          gateId: "typecheck",
          status: "FAIL",
          failureKind: "COMMAND",
        }),
      },
    ]);
  });
});

describe("runPreShipSanity", () => {
  const passed: SanityGateResult = {
    ok: true,
    failures: [],
    failureKind: null,
  };

  it("returns ok with no failures when no package.json exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "afk-sanity-"));
    tempDirs.push(dir);
    expect(runPreShipSanity(dir)).toEqual(passed);
  });

  it("skips steps not defined in package.json (lint absent → not a failure)", () => {
    const dir = makeProject({
      typecheck: "node -e \"process.exit(0)\"",
      "test:run": "node -e \"process.exit(0)\"",
    });
    expect(runPreShipSanity(dir)).toEqual(passed);
  });

  it("passes when all defined scripts succeed", () => {
    const dir = makeProject({
      typecheck: "node -e \"process.exit(0)\"",
      lint: "node -e \"process.exit(0)\"",
      "test:run": "node -e \"process.exit(0)\"",
    });
    expect(runPreShipSanity(dir)).toEqual(passed);
  });

  it("reports the failing step name when lint exits non-zero", () => {
    const dir = makeProject({
      typecheck: "node -e \"process.exit(0)\"",
      lint: "node -e \"process.exit(1)\"",
      "test:run": "node -e \"process.exit(0)\"",
    });
    const result = runPreShipSanity(dir);
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(["lint"]);
    // A red script is the tree's fault, in the gate-runner vocabulary.
    expect(result.failureKind).toBe("COMMAND");
  });

  it("falls back to `test` when `test:run` is not defined", () => {
    const dir = makeProject({
      test: "node -e \"process.exit(1)\"",
    });
    const result = runPreShipSanity(dir);
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(["tests"]);
  });

  it("collects multiple failures across steps", () => {
    const dir = makeProject({
      typecheck: "node -e \"process.exit(1)\"",
      lint: "node -e \"process.exit(1)\"",
      "test:run": "node -e \"process.exit(0)\"",
    });
    const result = runPreShipSanity(dir);
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(["typecheck", "lint"]);
  });

  // Regression for #101: the ship gate's scratch review worktree is a fresh
  // `git worktree add` with no node_modules, so every sanity command failed
  // instantly and the gate reported a code failure on a green branch.
  it("installs dependencies before running the sanity steps (#101)", () => {
    const dir = withLockfile(
      makeProject({
        typecheck: "tsc --noEmit",
        "test:run": "vitest run",
      }),
    );

    const { ran, result } = recordSanityRun(dir);

    expect(ran).toEqual([
      "pnpm install --frozen-lockfile",
      "pnpm run typecheck",
      "pnpm run test:run",
    ]);
    expect(result).toEqual(passed);
  });

  // `existsSync("node_modules")` is not a validity check: a partial tree
  // from an aborted install passes it and the incident reappears as a code
  // failure. --frozen-lockfile is the state check, and is near-free when the
  // store is already satisfied.
  it("installs even when node_modules already exists, so a stale tree cannot pass as installed (#101)", () => {
    const dir = withLockfile(makeProject({ typecheck: "tsc --noEmit" }));
    mkdirSync(join(dir, "node_modules"));

    expect(recordSanityRun(dir).ran).toEqual([
      "pnpm install --frozen-lockfile",
      "pnpm run typecheck",
    ]);
  });

  it("leaves a project without a pnpm lockfile alone (no pnpm install for an npm/yarn consumer)", () => {
    const dir = makeProject({ typecheck: "tsc --noEmit" });
    expect(recordSanityRun(dir).ran).toEqual(["pnpm run typecheck"]);
  });

  it("skips the install when the project defines no sanity scripts at all", () => {
    const dir = withLockfile(makeProject({ build: "tsc" }));
    const { ran, result } = recordSanityRun(dir);
    expect(ran).toEqual([]);
    expect(result).toEqual(passed);
  });

  it("classifies a failed dependency install as CONFIGURATION, not a code failure (#101)", () => {
    const dir = withLockfile(makeProject({ typecheck: "tsc --noEmit" }));

    const { ran, result } = recordSanityRun(dir, {
      "pnpm install --frozen-lockfile": {
        outcome: "EXITED",
        exitCode: 1,
        output:
          "  ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with frozen-lockfile\n",
      },
    });

    // The steps never ran — reporting them as failures is the incident.
    expect(ran).toEqual(["pnpm install --frozen-lockfile"]);
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(["install"]);
    expect(result.failureKind).toBe("CONFIGURATION");
    // The install's own output reaches the operator, not just the step name.
    expect(result.detail).toContain("pnpm install --frozen-lockfile failed");
    expect(result.detail).toContain("ERR_PNPM_OUTDATED_LOCKFILE");
  });

  // The general "commands never really ran" class, not just node_modules:
  // pnpm absent from PATH is the same environmental failure, and the
  // gate-runner already maps a spawn ENOENT to FAIL/CONFIGURATION.
  it("classifies a step that cannot be spawned as CONFIGURATION (#101)", () => {
    const dir = makeProject({
      typecheck: "tsc --noEmit",
      "test:run": "vitest run",
    });

    const { ran, result } = recordSanityRun(dir, {
      "pnpm run typecheck": {
        outcome: "SPAWN_ERROR",
        exitCode: null,
        output: "spawnSync pnpm ENOENT",
      },
    });

    // No point running the rest: they fail for the same reason.
    expect(ran).toEqual(["pnpm run typecheck"]);
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(["typecheck"]);
    expect(result.failureKind).toBe("CONFIGURATION");
    expect(result.detail).toContain("could not be spawned");
    expect(result.detail).toContain("ENOENT");
  });
});

/**
 * Tests for `resolveTestCommand`. Shared with the pre-ship gate so the
 * QA evaluator and the gate can't pick different runners — these cases
 * pin the same `test:run` → `test` priority `runPreShipSanity` uses.
 */
describe("resolveTestCommand", () => {
  it("prefers `test:run` over `test`", () => {
    const dir = makeProject({
      "test:run": "vitest run",
      test: "vitest",
    });
    expect(resolveTestCommand(dir)).toBe("pnpm test:run");
  });

  it("falls back to `test` when `test:run` is absent (Jest projects)", () => {
    const dir = makeProject({ test: "jest" });
    expect(resolveTestCommand(dir)).toBe("pnpm test");
  });

  it("returns undefined when neither script is defined", () => {
    const dir = makeProject({ build: "tsc" });
    expect(resolveTestCommand(dir)).toBeUndefined();
  });

  it("returns undefined when package.json is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "afk-resolve-"));
    tempDirs.push(dir);
    expect(resolveTestCommand(dir)).toBeUndefined();
  });
});

/**
 * The generator's verification command is a separate decision from the
 * gate's command set: an operator may hand the generator a fast subset so
 * whole-suite runs stay out of every edit cycle (ADR 0038). These cases
 * pin the precedence only. That an override cannot reach the gate or the
 * QA evaluator is pinned where it can actually fail — through
 * `runPipeline`, in "generator verification command (ADR 0038)" below.
 */
describe("resolveGeneratorTestCommand", () => {
  it("prefers an explicit override over the project's test script", () => {
    const dir = makeProject({ "test:run": "vitest run" });
    expect(resolveGeneratorTestCommand(dir, "pnpm test:fast")).toBe(
      "pnpm test:fast",
    );
  });

  it("resolves the project's test script when no override is given", () => {
    const dir = makeProject({ "test:run": "vitest run" });
    expect(resolveGeneratorTestCommand(dir)).toBe("pnpm test:run");
  });

  it("falls back to `pnpm test` when the project defines no test script", () => {
    const dir = makeProject({ build: "tsc" });
    expect(resolveGeneratorTestCommand(dir)).toBe("pnpm test");
  });

  it("resolves independently of the sanity gate's command set", () => {
    const dir = makeProject({
      typecheck: "tsc --noEmit",
      "test:run": "vitest run",
    });
    // The two answers can differ, and the gate keeps the full one.
    expect(resolveGeneratorTestCommand(dir, "pnpm test:fast")).toBe(
      "pnpm test:fast",
    );
    expect(resolveSanityCommands(dir).join(" ")).toContain("pnpm run test:run");
  });
});

/**
 * Drift test: the command set the evaluator-qa is told to run MUST equal
 * the command set the post-merge sanity gate runs. If they diverge, a
 * slice can pass QA on code the gate then rejects (the failure mode that
 * motivated this fix: typecheck/lint violations passing through QA
 * because QA only ran tests). Walks several package.json shapes; for
 * each, the commands `runPreShipSanity` attempts must exactly match — same
 * commands, same order, dependency install included — what
 * `resolveSanityCommands` reports.
 */
describe("evaluator-qa sanity command set matches the post-merge gate", () => {
  // Records the real invocation sequence through the subprocess seam, so the
  // comparison covers every command the gate runs — including the install
  // prep, which is not a `pnpm run` script and would otherwise be invisible
  // to this test (#101).
  function recordedRuns(dir: string): string[] {
    return recordSanityRun(dir).ran;
  }

  it("projects base gates and aggregate commands from one discovery result", () => {
    const dir = makeProject({
      typecheck: "tsc --noEmit",
      test: "vitest",
    });

    expect(resolveBaseGateDeclarations(dir)).toEqual([
      {
        id: "typecheck",
        stage: "base",
        required: true,
        command: "pnpm",
        args: ["run", "typecheck"],
      },
      { id: "lint", stage: "base", required: false },
      {
        id: "tests",
        stage: "base",
        required: true,
        command: "pnpm",
        args: ["run", "test"],
      },
    ]);
    expect(resolveSanityCommands(dir)).toEqual([
      "pnpm run typecheck",
      "pnpm run test",
    ]);
  });

  it("matches when all three steps are defined", () => {
    const dir = makeProject({
      typecheck: "node -e \"process.exit(0)\"",
      lint: "node -e \"process.exit(0)\"",
      "test:run": "node -e \"process.exit(0)\"",
    });
    const reported = resolveSanityCommands(dir);
    const ran = recordedRuns(dir);
    expect(reported).toEqual(ran);
    expect(reported).toEqual(["pnpm run typecheck", "pnpm run lint", "pnpm run test:run"]);
  });

  // The install prep is part of the command set, so QA is told to run it too
  // — otherwise QA and the gate diverge on the one step that decides whether
  // any of the others can run at all (#101).
  it("matches including the dependency install in a pnpm project", () => {
    const dir = withLockfile(
      makeProject({
        typecheck: "node -e \"process.exit(0)\"",
        "test:run": "node -e \"process.exit(0)\"",
      }),
    );
    const reported = resolveSanityCommands(dir);
    expect(reported).toEqual(recordedRuns(dir));
    expect(reported).toEqual([
      "pnpm install --frozen-lockfile",
      "pnpm run typecheck",
      "pnpm run test:run",
    ]);
  });

  it("matches when lint is absent (skipped step is reported in neither)", () => {
    const dir = makeProject({
      typecheck: "node -e \"process.exit(0)\"",
      "test:run": "node -e \"process.exit(0)\"",
    });
    const reported = resolveSanityCommands(dir);
    const ran = recordedRuns(dir);
    expect(reported).toEqual(ran);
    expect(reported).toEqual(["pnpm run typecheck", "pnpm run test:run"]);
  });

  it("matches when only the `test` fallback is defined", () => {
    const dir = makeProject({ test: "node -e \"process.exit(0)\"" });
    const reported = resolveSanityCommands(dir);
    const ran = recordedRuns(dir);
    expect(reported).toEqual(ran);
    expect(reported).toEqual(["pnpm run test"]);
  });

  it("matches when no scripts are defined (both report empty)", () => {
    const dir = makeProject({ build: "tsc" });
    expect(resolveSanityCommands(dir)).toEqual([]);
    expect(recordedRuns(dir)).toEqual([]);
  });
});

/**
 * Tests for `makeAsyncMutex`. The mutex serialises lane merges across
 * concurrently-running lanes; correctness here pins that contract.
 */
describe("assessContractExtension", () => {
  it("grants a converging round", () => {
    expect(
      assessContractExtension({
        previousGapCount: 6,
        currentGapCount: 3,
        reRaisedGapCount: 0,
        extensionAlreadyGranted: false,
      }),
    ).toMatchObject({ grant: true });
  });

  it("refuses flat or rising gap counts", () => {
    for (const currentGapCount of [3, 4]) {
      expect(
        assessContractExtension({
          previousGapCount: 3,
          currentGapCount,
          reRaisedGapCount: 0,
          extensionAlreadyGranted: false,
        }).grant,
      ).toBe(false);
    }
  });

  it("refuses a re-raised gap despite a lower count", () => {
    expect(
      assessContractExtension({
        previousGapCount: 6,
        currentGapCount: 2,
        reRaisedGapCount: 1,
        extensionAlreadyGranted: false,
      }),
    ).toMatchObject({ grant: false, reason: expect.stringContaining("re-raised") });
  });

  it("never grants a second extension", () => {
    expect(
      assessContractExtension({
        previousGapCount: 3,
        currentGapCount: 1,
        reRaisedGapCount: 0,
        extensionAlreadyGranted: true,
      }),
    ).toMatchObject({ grant: false, reason: expect.stringContaining("already used") });
  });
});

describe("makeAsyncMutex", () => {
  it("serialises two concurrent acquirers in submission order", async () => {
    const lock = makeAsyncMutex();
    const order: string[] = [];

    const a = lock(async () => {
      order.push("a-start");
      await new Promise((r) => setTimeout(r, 30));
      order.push("a-end");
      return "a";
    });
    const b = lock(async () => {
      order.push("b-start");
      await new Promise((r) => setTimeout(r, 5));
      order.push("b-end");
      return "b";
    });

    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toBe("a");
    expect(rb).toBe("b");
    // Strict serial order: B never starts before A ends.
    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  it("does not poison the chain when an acquirer throws", async () => {
    const lock = makeAsyncMutex();
    await expect(
      lock(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // Subsequent acquirers must still be able to run.
    await expect(lock(async () => 42)).resolves.toBe(42);
  });
});


/**
 * Integration tests for the lane-aware wave loop. These spin up a real
 * git repo per test and inject a stub `AgentProvider` that writes
 * deterministic artifacts. We assert observable lane behaviour:
 *  - Two slices declaring the same file run *serially* (slice B's
 *    Phase A starts after slice A's commit lands on featBranch).
 *  - A failure in lane position 1 no longer cancels lane position 2:
 *    the successor runs on the unchanged base and its PASS persists
 *    (ADR 0024).
 *  - Two slices with disjoint files run in *parallel* lanes
 *    (interleaved invocation timestamps).
 *
 * The stub provider is the source of truth for what each agent role
 * "did". We thread per-slice behaviour via per-test maps.
 */

describe("runPipeline lane scheduling", () => {
  it("serialises two slices that declare the same file (one lane)", async () => {
    const repo = makeRepo();
    const slug = "lanes-overlap";
    const { prdDir, specsDir } = writePrdFixture(repo, slug);

    const slices: Slice[] = [
      {
        number: "01",
        ghIssue: "1001",
        title: "First",
        type: "AFK",
        blockedBy: [],
        userStories: "",
      },
      {
        number: "02",
        ghIssue: "1002",
        title: "Second",
        type: "AFK",
        blockedBy: [],
        userStories: "",
      },
    ];
    const dag = buildDAG(slices);

    const fixtures = new Map<string, SliceFixture>([
      [
        "1001",
        {
          files: ["src/shared.txt"],
          qaPasses: true,
          outputFile: "src/shared.txt",
          outputContent: "hello from slice 1001",
        },
      ],
      [
        "1002",
        {
          files: ["src/shared.txt"],
          qaPasses: true,
          outputFile: "src/shared.txt",
          outputContent: "hello from slice 1002",
        },
      ],
    ]);
    const records: InvocationRecord[] = [];
    const provider = buildStubProvider({ fixtures, slices, records });

    await runPipeline({
      repoRoot: repo,
      prdSlug: slug,
      prdDir,
      specsDir,
      dag,
      provider,
    });

    // Lane serialisation: slice 1001's qa-evaluator (the last Phase B
    // step before commit) must finish before slice 1002's
    // lane-successor planner refresh begins. The lane-successor
    // refresh is the *last* planner invocation for slice 1002 — its
    // first planner ran during the parallel Phase A of the wave, but
    // the orchestrator re-runs negotiate after recreating the worktree
    // on the predecessor-merged base.
    const last1001QaEval = lastTimestamp(records, "1001", "evaluator-qa");
    const last1002Planner = lastTimestamp(records, "1002", "planner");

    expect(last1001QaEval).not.toBeNull();
    expect(last1002Planner).not.toBeNull();
    expect(last1002Planner!).toBeGreaterThanOrEqual(last1001QaEval!);
    // Sanity: slice 1002 should have *more than one* planner invocation
    // (initial Phase A + lane-successor refresh).
    const planner1002Count = records.filter(
      (r) => r.ghIssue === "1002" && r.role === "planner",
    ).length;
    expect(planner1002Count).toBeGreaterThanOrEqual(2);

    // Final state: feat branch has 1002's content, not 1001's
    // (since 1002 was the last to write src/shared.txt — but they're
    // serialised, so there should be no merge conflict).
    const featBranch = `feat-stub/${slug}`;
    git(repo, ["checkout", featBranch]);
    const shared = readFileSync(join(repo, "src", "shared.txt"), "utf-8");
    expect(shared).toContain("hello from slice 1002");
  }, 240_000);

  it("persists STUCK for the failed predecessor and PASS for the surviving lane successor (ADR 0024)", async () => {
    const repo = makeRepo();
    const slug = "lanes-cancel";
    const { prdDir, specsDir } = writePrdFixture(repo, slug);

    const slices: Slice[] = [
      {
        number: "01",
        ghIssue: "2001",
        title: "Predecessor",
        type: "AFK",
        blockedBy: [],
        userStories: "",
      },
      {
        number: "02",
        ghIssue: "2002",
        title: "Successor",
        type: "AFK",
        blockedBy: [],
        userStories: "",
      },
    ];
    const dag = buildDAG(slices);

    const fixtures = new Map<string, SliceFixture>([
      [
        "2001",
        {
          files: ["src/coupled.txt"],
          qaPasses: false, // STUCK after MAX_GENERATOR_ROUNDS
          outputFile: "src/coupled.txt",
          outputContent: "predecessor (will fail QA)",
        },
      ],
      [
        "2002",
        {
          files: ["src/coupled.txt"],
          qaPasses: true,
          outputFile: "src/coupled.txt",
          outputContent: "successor",
        },
      ],
    ]);
    const records: InvocationRecord[] = [];
    const provider = buildStubProvider({ fixtures, slices, records });

    await runPipeline({
      repoRoot: repo,
      prdSlug: slug,
      prdDir,
      specsDir,
      dag,
      provider,
    });

    const stateRaw = readFileSync(
      join(repo, ".afk", "state", `${slug}-stub.json`),
      "utf-8",
    );
    const state = JSON.parse(stateRaw);
    expect(state.slices["2001"].phase).toBe("STUCK");
    // Pre-ADR-0024: LANE-CANCELLED collateral. The slices are
    // DAG-independent, so the successor now survives its dead lane
    // predecessor, runs on the unchanged feature-branch tip, and its
    // PASS is persisted as resumable-complete.
    expect(state.slices["2002"].phase).toBe("PASS");
    expect(state.slices["2002"].mergedToFeature).toBe(true);
  }, 240_000);

  it("runs disjoint-file slices in parallel lanes (timestamps interleave)", async () => {
    const repo = makeRepo();
    const slug = "lanes-parallel";
    const { prdDir, specsDir } = writePrdFixture(repo, slug);

    const slices: Slice[] = [
      {
        number: "01",
        ghIssue: "3001",
        title: "Alpha",
        type: "AFK",
        blockedBy: [],
        userStories: "",
      },
      {
        number: "02",
        ghIssue: "3002",
        title: "Beta",
        type: "AFK",
        blockedBy: [],
        userStories: "",
      },
    ];
    const dag = buildDAG(slices);

    const fixtures = new Map<string, SliceFixture>([
      [
        "3001",
        {
          files: ["src/alpha.txt"],
          qaPasses: true,
          outputFile: "src/alpha.txt",
          outputContent: "alpha",
        },
      ],
      [
        "3002",
        {
          files: ["src/beta.txt"],
          qaPasses: true,
          outputFile: "src/beta.txt",
          outputContent: "beta",
        },
      ],
    ]);
    const records: InvocationRecord[] = [];
    const provider = buildStubProvider({ fixtures, slices, records });

    await runPipeline({
      repoRoot: repo,
      prdSlug: slug,
      prdDir,
      specsDir,
      dag,
      provider,
    });

    // Both slices should be PASS in run-state.
    const stateRaw = readFileSync(
      join(repo, ".afk", "state", `${slug}-stub.json`),
      "utf-8",
    );
    const state = JSON.parse(stateRaw);
    expect(state.slices["3001"].phase).toBe("PASS");
    expect(state.slices["3002"].phase).toBe("PASS");

    // Phase A invocations should overlap: one slice's explorer starts
    // before the other's explorer finishes. Later phases can be separated
    // by synchronous worktree and filesystem operations on a loaded host.
    const a = firstTimestamp(records, "3001", "explorer");
    const aEnd = lastTimestamp(records, "3001", "explorer");
    const b = firstTimestamp(records, "3002", "explorer");
    const bEnd = lastTimestamp(records, "3002", "explorer");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    // Overlap iff a < bEnd && b < aEnd.
    const overlap = a! < bEnd! && b! < aEnd!;
    expect(overlap).toBe(true);
  }, 240_000);
  it("runs only the explicitly selected AFK scope and writes its handoff", async () => {
    const repo = makeRepo();
    const slug = "scope-selection";
    const { prdDir, specsDir } = writePrdFixture(repo, slug);
    const slices: Slice[] = [
      { number: "01", ghIssue: "4001", title: "Selected", type: "AFK", blockedBy: [], userStories: "" },
      { number: "02", ghIssue: "4002", title: "Unselected", type: "AFK", blockedBy: [], userStories: "" },
      { number: "03", ghIssue: "4003", title: "Manual", type: "HITL", blockedBy: [], userStories: "" },
    ];
    const fixtures = new Map<string, SliceFixture>([
      ["4001", { files: ["src/selected.txt"], qaPasses: true, outputFile: "src/selected.txt", outputContent: "selected" }],
      ["4002", { files: ["src/unselected.txt"], qaPasses: true, outputFile: "src/unselected.txt", outputContent: "unselected" }],
    ]);
    const records: InvocationRecord[] = [];

    const result = await runPipeline({
      repoRoot: repo,
      prdSlug: slug,
      prdDir,
      specsDir,
      dag: buildDAG(slices),
      selectedSliceNumbers: ["01"],
      provider: buildStubProvider({ fixtures, slices, records }),
    });

    // The selected slice passed and merged; the run itself is unsuccessful
    // because the stub's no-op reviews leave no verdict to ship on
    // (issue #43) — which is why the handoff below records FAILED.
    expect(result.success).toBe(false);
    expect(records.some((record) => record.ghIssue === "4001")).toBe(true);
    expect(records.some((record) => record.ghIssue === "4002")).toBe(false);

    const state = JSON.parse(
      readFileSync(join(repo, ".afk", "state", `${slug}-stub.json`), "utf-8"),
    );
    expect(state.scope).toEqual({
      mode: "explicit",
      slices: [{ number: "01", ghIssue: "4001" }],
    });

    const handoff = JSON.parse(
      readFileSync(join(repo, ".afk", "logs", `${slug}-stub`, "handoff.json"), "utf-8"),
    );
    expect(handoff.runStatus).toBe("FAILED");
    expect(handoff.selectedSlices).toMatchObject([
      { number: "01", ghIssue: "4001", status: "PASS" },
    ]);
    expect(handoff.skippedSlices).toMatchObject([
      { number: "02", ghIssue: "4002", reason: "not-selected" },
      { number: "03", ghIssue: "4003", reason: "hitl" },
    ]);
    expect(handoff.featureBranch).toBe(`feat-stub/${slug}`);
    expect(handoff.finalCommitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(handoff.githubIssuesToClose).toEqual(["4001"]);
  }, 240_000);
});

/**
 * A run that dispatches nothing must say so and fail (issue #42). The
 * honest signal is `PipelineResult.success`, and `failureReason` carries
 * the diagnostic the three entrypoints print before their existing
 * non-zero exit — the same per-slice hold-back the NOT-RUN log lines
 * already spell out.
 */
describe("runPipeline zero-dispatch outcome (issue #42)", () => {
  it("is unsuccessful and names every unrun slice with its unresolved blockers", async () => {
    const repo = makeRepo();
    const slug = "zero-dispatch-blocked";
    const { prdDir, specsDir } = writePrdFixture(repo, slug);
    const slices: Slice[] = [
      {
        number: "01",
        ghIssue: "5001",
        title: "Held back",
        type: "AFK",
        blockedBy: ["4999"],
        userStories: "",
      },
      {
        number: "02",
        ghIssue: "5002",
        title: "Also held back",
        type: "AFK",
        blockedBy: ["5001"],
        userStories: "",
      },
    ];
    const records: InvocationRecord[] = [];

    const result = await runPipeline({
      repoRoot: repo,
      prdSlug: slug,
      prdDir,
      specsDir,
      dag: buildDAG(slices),
      provider: buildStubProvider({
        fixtures: new Map<string, SliceFixture>(),
        slices,
        records,
      }),
    });

    // Nothing was dispatched, so no agent was ever invoked — including
    // the guardian reviewers, which must not grade an untouched branch.
    expect(records).toEqual([]);
    expect(result.success).toBe(false);
    const reason = result.failureReason ?? "";
    expect(reason).toContain("no slices");
    expect(reason).toContain("#5001 Held back");
    expect(reason).toContain("#4999 (outside run scope)");
    expect(reason).toContain("#5002 Also held back");
    expect(reason).toContain("#5001");
  }, 240_000);

  it("stays successful when it dispatched nothing because every slice was already complete", async () => {
    const repo = makeRepo();
    const slug = "zero-dispatch-complete";
    const { prdDir, specsDir } = writePrdFixture(repo, slug);
    const slices: Slice[] = [
      {
        number: "01",
        ghIssue: "5101",
        title: "Done last run",
        type: "AFK",
        blockedBy: [],
        userStories: "",
      },
    ];
    // A prior run merged the slice. Its persisted PASS is authoritative,
    // so this run has nothing to dispatch and that is not a failure.
    mkdirSync(join(repo, ".afk", "state"), { recursive: true });
    writeFileSync(
      join(repo, ".afk", "state", `${slug}-stub.json`),
      JSON.stringify({
        version: 1,
        prdSlug: `${slug}-stub`,
        featureBranch: `feat-stub/${slug}`,
        slices: {
          "5101": {
            phase: "PASS",
            branch: `afk-stub/${slug}-s01`,
            mergedToFeature: true,
          },
        },
      }),
      "utf-8",
    );
    const records: InvocationRecord[] = [];
    const baseProvider = buildStubProvider({
      fixtures: new Map<string, SliceFixture>(),
      slices,
      records,
    });
    const provider: AgentProvider = {
      name: baseProvider.name,
      async invoke(options) {
        const result = await baseProvider.invoke(options);
        if (
          options.role === "architect-review" ||
          options.role === "pm-review"
        ) {
          const specs = join(options.cwd, ".kiro", "specs", slug);
          mkdirSync(specs, { recursive: true });
          const fileName =
            options.role === "architect-review"
              ? "review-architect.md"
              : "review-pm.md";
          writeFileSync(
            join(specs, fileName),
            "# Guardian Review\n\n**Verdict:** SHIP\n",
            "utf-8",
          );
        }
        return result;
      },
    };

    const result = await runPipeline({
      repoRoot: repo,
      prdSlug: slug,
      prdDir,
      specsDir,
      dag: buildDAG(slices),
      provider,
    });

    expect(result.success).toBe(true);
    expect(result.failureReason).toBeUndefined();
    // No slice work ran; only the post-merge guardian reviews.
    expect(
      records.every((record) => record.role.endsWith("-review")),
    ).toBe(true);
  }, 240_000);
});

/**
 * The pre-ship-gate reservation trim (ADR 0034 step 7, issue #65): only
 * prefixes claimed by *merged* slices survive into the verified draft's
 * afk.json. A claim held by a failed or descoped slice is an unused
 * reservation and must be released — both from the manifest on the
 * reviewed feature branch and from the run state's claim record.
 */
describe("ship-gate migration reservation trim (#65)", () => {
  it("drops a failed slice's reservation from afk.json on the reviewed feature branch and releases its claim", async () => {
    const repo = makeRepo();
    const slug = "trim-failed-claims";
    const { prdDir, specsDir } = writePrdFixture(repo, slug);
    const manifest = {
      version: 1 as const,
      selectedSlices: ["01", "02"],
      migrationPrefixes: ["144", "145", "146"],
      protectedIssues: [],
    };
    // afk.json must sit on the base branch: the trim edits the review
    // worktree's checkout of the feature branch.
    writeFileSync(
      join(prdDir, "afk.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf-8",
    );
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "prd fixture with afk.json"]);

    const slices: Slice[] = [
      { number: "01", ghIssue: "6501", title: "Merged", type: "AFK", blockedBy: [], userStories: "" },
      { number: "02", ghIssue: "6502", title: "Escalated", type: "AFK", blockedBy: [], userStories: "" },
    ];
    // A prior run merged slice 01 with prefix 144 and escalated slice 02
    // holding 145; 146 was never claimed. Narrowed to the merged slice,
    // this run reaches the ship gate with the failed claim still on file.
    mkdirSync(join(repo, ".afk", "state"), { recursive: true });
    writeFileSync(
      join(repo, ".afk", "state", `${slug}-stub.json`),
      JSON.stringify({
        version: 1,
        prdSlug: `${slug}-stub`,
        featureBranch: `feat-stub/${slug}`,
        scope: {
          mode: "all-afk",
          slices: [
            { number: "01", ghIssue: "6501" },
            { number: "02", ghIssue: "6502" },
          ],
        },
        slices: {
          "6501": {
            phase: "PASS",
            branch: `afk-stub/${slug}-s01`,
            mergedToFeature: true,
          },
          "6502": {
            phase: "ESCALATE",
            branch: `afk-stub/${slug}-s02`,
            error: "contract rounds exhausted",
          },
        },
        migrations: {
          pool: ["144", "145", "146"],
          claims: { "6501": ["144"], "6502": ["145"] },
        },
      }),
      "utf-8",
    );

    const records: InvocationRecord[] = [];
    const result = await runPipeline({
      repoRoot: repo,
      prdSlug: slug,
      prdDir,
      specsDir,
      dag: buildDAG(slices),
      selectedSliceNumbers: ["01"],
      manifest,
      provider: buildStubProvider({
        fixtures: new Map<string, SliceFixture>(),
        slices,
        records,
      }),
    });

    // The stub's no-op reviews leave no verdict, so the PR stays blocked
    // (issue #43) — but the trim runs before the reviews and must have
    // landed on the feature branch regardless.
    expect(result.success).toBe(false);

    const featBranch = `feat-stub/${slug}`;
    const shipped = JSON.parse(
      git(repo, ["show", `${featBranch}:.kiro/specs/${slug}/afk.json`]),
    );
    expect(shipped.migrationPrefixes).toEqual(["144"]);
    expect(git(repo, ["log", "--format=%s", featBranch])).toContain(
      "release unused migration reservations",
    );

    // Run state stays loadable for a later run: the failed slice's claim
    // is released together with its prefix, never left dangling outside
    // the trimmed pool.
    const state = JSON.parse(
      readFileSync(join(repo, ".afk", "state", `${slug}-stub.json`), "utf-8"),
    );
    expect(state.migrations).toEqual({
      pool: ["144"],
      claims: { "6501": ["144"] },
    });
  }, 60_000);
});

function firstTimestamp(
  records: InvocationRecord[],
  ghIssue: string,
  role: string,
): number | null {
  for (const r of records) {
    if (r.ghIssue === ghIssue && r.role === role) return r.startedAt;
  }
  return null;
}

function lastTimestamp(
  records: InvocationRecord[],
  ghIssue: string,
  role: string,
): number | null {
  let last: number | null = null;
  for (const r of records) {
    if (r.ghIssue === ghIssue && r.role === role) last = r.finishedAt;
  }
  return last;
}

/**
 * Tests for the end-of-run summary report. Cover the three exit paths:
 * happy success, slice failure, and uncaught throw mid-run.
 */
describe("runPipeline summary report", () => {
  it("groups succeeded slices and reports 'not ready' when reviews are unparseable", async () => {
    const repo = makeRepo();
    const slug = "summary-success";
    const { prdDir, specsDir } = writePrdFixture(repo, slug);

    const slices: Slice[] = [
      {
        number: "01",
        ghIssue: "5001",
        title: "Only",
        type: "AFK",
        blockedBy: [],
        userStories: "",
      },
    ];
    const dag = buildDAG(slices);

    const fixtures = new Map<string, SliceFixture>([
      [
        "5001",
        {
          files: ["src/only.txt"],
          qaPasses: true,
          outputFile: "src/only.txt",
          outputContent: "only",
        },
      ],
    ]);
    const records: InvocationRecord[] = [];
    const provider = buildStubProvider({ fixtures, slices, records });

    const result = await runPipeline({
      repoRoot: repo,
      prdSlug: slug,
      prdDir,
      specsDir,
      dag,
      provider,
    });

    // Unsuccessful: the slice passed but nothing shipped (issue #43).
    expect(result.success).toBe(false);
    expect(result.consoleSummary).toContain(`AFK Pipeline Summary — ${slug}`);
    expect(result.consoleSummary).toMatch(/Succeeded \(1\)/);
    expect(result.consoleSummary).toContain("#5001 Only");
    expect(result.consoleSummary).toContain(`merged into feat-stub/${slug}`);
    expect(result.consoleSummary).toMatch(/Failed \/ Stuck \(0\)/);
    // No package.json in fixture → sanity gate skipped (returns ok); reviews
    // are no-ops in the stub → verdicts UNKNOWN → not ready.
    expect(result.consoleSummary).toContain("Not ready");
  }, 240_000);

  it("groups failed slices under Failed/Stuck with the error reason", async () => {
    const repo = makeRepo();
    const slug = "summary-fail";
    const { prdDir, specsDir } = writePrdFixture(repo, slug);

    const slices: Slice[] = [
      {
        number: "01",
        ghIssue: "6001",
        title: "Will fail",
        type: "AFK",
        blockedBy: [],
        userStories: "",
      },
    ];
    const dag = buildDAG(slices);

    const fixtures = new Map<string, SliceFixture>([
      [
        "6001",
        {
          files: ["src/x.txt"],
          qaPasses: false,
          outputFile: "src/x.txt",
          outputContent: "x",
        },
      ],
    ]);
    const records: InvocationRecord[] = [];
    const provider = buildStubProvider({ fixtures, slices, records });

    const result = await runPipeline({
      repoRoot: repo,
      prdSlug: slug,
      prdDir,
      specsDir,
      dag,
      provider,
    });

    expect(result.success).toBe(false);
    expect(result.consoleSummary).toMatch(/Failed \/ Stuck \(1\)/);
    expect(result.consoleSummary).toContain("#6001 Will fail");
    expect(result.consoleSummary).toContain("[STUCK]");
    // Branch is preserved on failure; the stub uses provider.name="stub".
    expect(result.consoleSummary).toContain(`afk-stub/${slug}-slice-01-`);
    expect(result.consoleSummary).toContain("Not ready");
  }, 240_000);

  it("surfaces a thrown architect-review as a NEVER_RAN outcome without aborting the pipeline", async () => {
    const repo = makeRepo();
    const slug = "summary-throw";
    const { prdDir, specsDir } = writePrdFixture(repo, slug);

    const slices: Slice[] = [
      {
        number: "01",
        ghIssue: "7001",
        title: "Passes then architect review explodes",
        type: "AFK",
        blockedBy: [],
        userStories: "",
      },
    ];
    const dag = buildDAG(slices);

    const fixtures = new Map<string, SliceFixture>([
      [
        "7001",
        {
          files: ["src/y.txt"],
          qaPasses: true,
          outputFile: "src/y.txt",
          outputContent: "y",
        },
      ],
    ]);
    const records: InvocationRecord[] = [];
    const baseProvider = buildStubProvider({ fixtures, slices, records });

    // Wrap the stub so the architect-review invocation throws with a
    // spawn-style error (no output produced), but PM review still runs
    // (it's a no-op in the stub → UNPARSEABLE verdict).
    let architectAttempts = 0;
    const explodingProvider: AgentProvider = {
      name: baseProvider.name,
      async invoke(options) {
        if (options.role === "architect-review") {
          architectAttempts++;
          throw new Error(
            "Agent architect-review exited with code 1: codex-wrapper: error: failed to persist AWS config file: Access is denied. (os error 5)",
          );
        }
        return baseProvider.invoke(options);
      },
    };

    const result = await runPipeline({
      repoRoot: repo,
      prdSlug: slug,
      prdDir,
      specsDir,
      dag,
      provider: explodingProvider,
      infrastructureRetries: 1,
    });

    // Pipeline returns normally; the slice succeeded. The run does not:
    // no draft PR opened, so the exit signal is unsuccessful (issue #43).
    expect(result.success).toBe(false);
    expect(result.failureReason).toContain("NEVER_RAN");
    expect(result.consoleSummary).toContain(`AFK Pipeline Summary — ${slug}`);
    expect(result.consoleSummary).toMatch(/Succeeded \(1\)/);
    expect(result.consoleSummary).toContain("#7001");
    // Spawn-style failures are infrastructure-class: retried within the
    // run (ADR 0015), then reported as NEVER_RAN with the stderr detail.
    expect(architectAttempts).toBe(2);
    expect(result.consoleSummary).toContain("Not ready");
    expect(result.consoleSummary).toContain("architect review NEVER_RAN");
    // Summary file written, and it carries the failing agent's stderr line.
    const summaryPath = join(repo, ".afk", "logs", `${slug}-stub`, "run-summary.md");
    expect(existsSync(summaryPath)).toBe(true);
    const summary = readFileSync(summaryPath, "utf-8");
    expect(summary).toContain("Architect review: NEVER_RAN — Agent architect-review exited with code 1: codex-wrapper:");
    expect(summary).toContain("PM review: UNPARSEABLE");
  }, 240_000);

  it("surfaces both reviews failing as two infrastructure outcomes without aborting", async () => {
    const repo = makeRepo();
    const slug = "summary-both-throw";
    const { prdDir, specsDir } = writePrdFixture(repo, slug);

    const slices: Slice[] = [
      {
        number: "01",
        ghIssue: "8001",
        title: "Passes then both reviews explode",
        type: "AFK",
        blockedBy: [],
        userStories: "",
      },
    ];
    const dag = buildDAG(slices);

    const fixtures = new Map<string, SliceFixture>([
      [
        "8001",
        {
          files: ["src/z.txt"],
          qaPasses: true,
          outputFile: "src/z.txt",
          outputContent: "z",
        },
      ],
    ]);
    const records: InvocationRecord[] = [];
    const baseProvider = buildStubProvider({ fixtures, slices, records });

    const bothExplodingProvider: AgentProvider = {
      name: baseProvider.name,
      async invoke(options) {
        if (options.role === "architect-review") {
          throw new Error("simulated architect failure");
        }
        if (options.role === "pm-review") {
          throw new Error("simulated pm failure");
        }
        return baseProvider.invoke(options);
      },
    };

    const result = await runPipeline({
      repoRoot: repo,
      prdSlug: slug,
      prdDir,
      specsDir,
      dag,
      provider: bothExplodingProvider,
      infrastructureRetries: 0,
    });

    // Pipeline still returns normally, but the run is unsuccessful: both
    // verdicts are absent, so nothing shipped (issue #43).
    expect(result.success).toBe(false);
    expect(result.failureReason).toContain("NEVER_RAN");
    expect(result.consoleSummary).toMatch(/Succeeded \(1\)/);
    expect(result.consoleSummary).toContain("Not ready");
    expect(result.consoleSummary).toContain("architect review NEVER_RAN");
    expect(result.consoleSummary).toContain("PM review NEVER_RAN");
    const summaryPath = join(repo, ".afk", "logs", `${slug}-stub`, "run-summary.md");
    expect(existsSync(summaryPath)).toBe(true);
  }, 240_000);
});

/** Round feedback must stay separate from the contract specification. */
describe("round-scoped contract feedback", () => {
  it("advances after REVISE using only the previous feedback file", async () => {
    const repo = makeRepo();
    const slug = "feedback-rounds";
    const { prdDir, specsDir } = writePrdFixture(repo, slug);
    const issuesDir = join(prdDir, "issues");
    mkdirSync(issuesDir, { recursive: true });
    writeFileSync(
      join(issuesDir, "01-local.md"),
      "Local issue details: preserve notification ordering.\n",
      "utf-8",
    );

    const slice: Slice = {
      number: "01",
      ghIssue: "9001",
      title: "Feedback isolation",
      type: "AFK",
      blockedBy: [],
      userStories: "",
    };
    let plannerRounds = 0;
    let evaluatorRounds = 0;
    const plannerPrompts: string[] = [];
    const provider: AgentProvider = {
      name: "stub",
      async invoke(opts: InvokeOptions): Promise<InvokeResult> {
        const artifactDir = findSliceArtifactDir(opts.cwd, slice.number);
        if (!artifactDir) throw new Error("slice artifact directory missing");
        if (opts.role === "explorer") {
          writeFileSync(join(artifactDir, "context.md"), "# Context\n", "utf-8");
        } else if (opts.role === "planner") {
          plannerRounds++;
          plannerPrompts.push(opts.prompt);
          writeFileSync(
            join(artifactDir, "contract.md"),
            [
              "# Slice Contract",
              "",
              "**Status:** NEGOTIATING",
              `**Negotiation round:** ${plannerRounds}`,
              "",
              "## Files expected to change",
              "- src/example.ts",
              "",
            ].join("\n"),
            "utf-8",
          );
        } else if (opts.role === "evaluator-contract") {
          evaluatorRounds++;
          const verdict = evaluatorRounds === 1 ? "REVISE" : "ACCEPT";
          writeFileSync(
            join(artifactDir, `feedback-r${evaluatorRounds}.md`),
            `## Evaluator feedback — round ${evaluatorRounds}\n\nVERDICT: ${verdict}\n`,
            "utf-8",
          );
        }
        return { exitCode: 0, stdout: "", stats: {} };
      },
    };
    const dag = buildDAG([slice]);
    const featBranch = `feat-stub/${slug}`;
    git(repo, ["branch", featBranch]);
    const logger = new Logger(repo, `${slug}-stub`);
    const ctx = makeSliceContext(
      { repoRoot: repo, prdSlug: slug, prdDir, specsDir, dag, provider },
      slice,
      logger,
      featBranch,
      "- README.md",
      "pnpm test",
    );

    expect(await runSliceNegotiate(ctx)).toEqual({ phase: "LOCKED" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(plannerRounds).toBe(2);
    expect(evaluatorRounds).toBe(2);
    expect(plannerPrompts[0]).toContain("Local issue details");
    expect(plannerPrompts[0]).not.toContain("gh issue view 9001");
    expect(plannerPrompts[1]).toContain("feedback-r1.md");
    expect(plannerPrompts[1]).not.toContain("feedback-r2.md");

    const contract = readFileSync(join(ctx.absSliceDir, "contract.md"), "utf-8");
    expect(contract).toMatch(/^\*\*Status:\*\*\s*LOCKED\s*$/m);
    expect(contract).not.toContain("## Evaluator feedback");
    expect(readFileSync(join(ctx.absSliceDir, "feedback-r1.md"), "utf-8")).toContain(
      "VERDICT: REVISE",
    );
    expect(readFileSync(join(ctx.absSliceDir, "feedback-r2.md"), "utf-8")).toContain(
      "VERDICT: ACCEPT",
    );
  });

  it("grants exactly one extra round to a converging negotiation", async () => {
    const repo = makeRepo();
    const slug = "converging-contract";
    const { prdDir, specsDir } = writePrdFixture(repo, slug);
    const slice: Slice = {
      number: "01",
      ghIssue: "9003",
      title: "Converging contract",
      type: "AFK",
      blockedBy: [],
      userStories: "",
    };
    let plannerRounds = 0;
    let evaluatorRounds = 0;
    const provider: AgentProvider = {
      name: "stub",
      async invoke(opts: InvokeOptions): Promise<InvokeResult> {
        const artifactDir = findSliceArtifactDir(opts.cwd, slice.number);
        if (!artifactDir) throw new Error("slice artifact directory missing");
        if (opts.role === "explorer") {
          writeFileSync(join(artifactDir, "context.md"), "# Context\n", "utf-8");
        } else if (opts.role === "planner") {
          plannerRounds++;
          writeFileSync(
            join(artifactDir, "contract.md"),
            "# Contract\n\n**Status:** NEGOTIATING\n",
            "utf-8",
          );
        } else if (opts.role === "evaluator-contract") {
          evaluatorRounds++;
          const verdict = evaluatorRounds === 3 ? "ACCEPT" : "REVISE";
          const gaps = evaluatorRounds === 1 ? 4 : evaluatorRounds === 2 ? 2 : 0;
          writeFileSync(
            join(artifactDir, `feedback-r${evaluatorRounds}.md`),
            `VERDICT: ${verdict}\nGAPS: ${gaps}\nRE_RAISED_GAPS: 0\n`,
            "utf-8",
          );
        }
        return { exitCode: 0, stdout: "", stats: {} };
      },
    };
    const dag = buildDAG([slice]);
    const featBranch = `feat-stub/${slug}`;
    git(repo, ["branch", featBranch]);
    const logger = new Logger(repo, `${slug}-stub`);
    const ctx = makeSliceContext(
      {
        repoRoot: repo,
        prdSlug: slug,
        prdDir,
        specsDir,
        dag,
        provider,
        maxContractRounds: 2,
      },
      slice,
      logger,
      featBranch,
      "- README.md",
      "pnpm test",
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await runSliceNegotiate(ctx)).toEqual({ phase: "LOCKED" });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(plannerRounds).toBe(3);
      expect(evaluatorRounds).toBe(3);
      expect(errorSpy.mock.calls.flat().join(" ")).toContain(
        "granting contract round 3",
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("keeps ESCALATE when archive copying fails and leaves stuck.md", async () => {
    const repo = makeRepo();
    const slug = "archive-failure";
    const { prdDir, specsDir } = writePrdFixture(repo, slug);
    const slice: Slice = {
      number: "01",
      ghIssue: "9002",
      title: "Archive failure",
      type: "AFK",
      blockedBy: [],
      userStories: "",
    };
    const provider: AgentProvider = {
      name: "stub",
      async invoke(opts: InvokeOptions): Promise<InvokeResult> {
        const artifactDir = findSliceArtifactDir(opts.cwd, slice.number);
        if (!artifactDir) throw new Error("slice artifact directory missing");
        if (opts.role === "explorer") {
          writeFileSync(join(artifactDir, "context.md"), "# Context\n", "utf-8");
        } else if (opts.role === "planner") {
          writeFileSync(
            join(artifactDir, "contract.md"),
            "# Contract\n\n**Status:** NEGOTIATING\n",
            "utf-8",
          );
        } else if (opts.role === "evaluator-contract") {
          writeFileSync(
            join(artifactDir, "feedback-r1.md"),
            "VERDICT: ESCALATE\n\n### If REVISE, specific gaps:\n- Clarify the issue body.\n",
            "utf-8",
          );
        }
        return { exitCode: 0, stdout: "", stats: {} };
      },
    };
    const dag = buildDAG([slice]);
    const featBranch = `feat-stub/${slug}`;
    git(repo, ["branch", featBranch]);
    const logger = new Logger(repo, `${slug}-stub`);
    const archiveParent = join(repo, ".afk", "artifacts");
    mkdirSync(archiveParent, { recursive: true });
    writeFileSync(join(archiveParent, `${slug}-stub`), "blocked", "utf-8");
    const ctx = makeSliceContext(
      { repoRoot: repo, prdSlug: slug, prdDir, specsDir, dag, provider },
      slice,
      logger,
      featBranch,
      "- README.md",
      "pnpm test",
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      // The ESCALATE carries a verdict-class cause, not an
      // infrastructure one — so it is terminal, not retried (ADR 0025).
      const negotiate = await runSliceNegotiate(ctx);
      expect(negotiate.phase).toBe("ESCALATE");
      expect(
        negotiate.phase === "ESCALATE" ? negotiate.cause.kind : undefined,
      ).toBe("verdict");
      await new Promise((resolve) => setTimeout(resolve, 50));
      const stuckPath = join(ctx.absSliceDir, "stuck.md");
      expect(existsSync(stuckPath)).toBe(true);
      expect(readFileSync(stuckPath, "utf-8")).toContain("Clarify the issue body.");
      expect(errorSpy.mock.calls.flat().join(" ")).toContain(
        "failed to archive negotiation artifacts",
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});

/**
 * Regression test for the orchestrator-owned contract Status flip. The
 * planner is supposed to flip Status to LOCKED on ACCEPT, but it doesn't
 * reliably — when it forgets, the next phase's generator reads
 * `Status: NEGOTIATING` and bails. The orchestrator must own the flip.
 */
describe("orchestrator-owned contract status", () => {
  it("locks the contract on ACCEPT even when planner leaves Status NEGOTIATING", async () => {
    const repo = makeRepo();
    const slug = "024-test";
    const { prdDir, specsDir } = writePrdFixture(repo, slug);

    const slices: Slice[] = [
      {
        number: "01",
        ghIssue: "1",
        title: "First slice",
        type: "AFK",
        blockedBy: [],
        userStories: "",
      },
    ];
    const dag = buildDAG(slices);

    const fixtures = new Map<string, SliceFixture>([
      [
        "1",
        {
          files: ["src/foo.txt"],
          qaPasses: true,
          outputFile: "src/foo.txt",
          outputContent: "ok",
        },
      ],
    ]);
    const records: InvocationRecord[] = [];
    const baseProvider = buildStubProvider({ fixtures, slices, records });
    // Capture the contract on disk right before the generator runs —
    // this is the moment that proves the orchestrator flipped Status to
    // LOCKED at the Phase A → Phase B handoff. On success the worktree
    // is cleaned up after merge, so we can't read the contract
    // afterwards; capturing here pins the on-disk state.
    let contractAtGeneratorTime: string | null = null;

    // Wrap the provider so planner writes NEGOTIATING (the bug we're
    // reproducing) and evaluator-contract writes ACCEPT separately but never
    // touches Status. Other roles defer to the base stub.
    const buggyProvider: AgentProvider = {
      name: baseProvider.name,
      async invoke(opts: InvokeOptions): Promise<InvokeResult> {
        const slice = sliceFromCwd(opts.cwd, slices);
        const sliceArtifactDir = slice
          ? findSliceArtifactDir(opts.cwd, slice.number)
          : null;
        if (opts.role === "planner" && sliceArtifactDir) {
          writeFileSync(
            join(sliceArtifactDir, "contract.md"),
            [
              "# Slice Contract — first slice",
              "",
              "**Status:** NEGOTIATING",
              "**Negotiation round:** 1",
              "",
              "## Files expected to change",
              "- src/foo.txt",
              "",
              "## Scope lock",
              "trivial",
              "",
            ].join("\n"),
            "utf-8",
          );
          records.push({
            role: opts.role,
            cwd: opts.cwd,
            startedAt: Date.now(),
            finishedAt: Date.now(),
            ghIssue: slice!.ghIssue,
          });
          return { exitCode: 0, stdout: "", stats: {} };
        }
        if (opts.role === "evaluator-contract" && sliceArtifactDir) {
          writeFileSync(
            join(sliceArtifactDir, "feedback-r1.md"),
            "## Evaluator feedback — round 1\n\nVERDICT: ACCEPT\n",
            "utf-8",
          );
          records.push({
            role: opts.role,
            cwd: opts.cwd,
            startedAt: Date.now(),
            finishedAt: Date.now(),
            ghIssue: slice!.ghIssue,
          });
          return { exitCode: 0, stdout: "", stats: {} };
        }
        if (opts.role === "generator" && sliceArtifactDir) {
          // Snapshot the contract right before the generator runs.
          // By this point the orchestrator should have locked it.
          const path = join(sliceArtifactDir, "contract.md");
          contractAtGeneratorTime = existsSync(path)
            ? readFileSync(path, "utf-8")
            : null;
        }
        return baseProvider.invoke(opts);
      },
    };

    await runPipeline({
      repoRoot: repo,
      prdSlug: slug,
      prdDir,
      specsDir,
      dag,
      provider: buggyProvider,
    });

    // Sanity: Phase B started — generator actually ran. In the buggy
    // pre-fix state Phase A returns STUCK and the generator never runs,
    // so this is the load-bearing assertion that the orchestrator owned
    // the Status flip.
    expect(records.some((r) => r.role === "generator")).toBe(true);

    // The contract observed at Phase A → Phase B handoff must say
    // LOCKED — even though the planner wrote NEGOTIATING and never
    // updated it.
    expect(contractAtGeneratorTime).not.toBeNull();
    expect(contractAtGeneratorTime!).toMatch(
      /^\*\*Status:\*\*\s*LOCKED\s*$/m,
    );
    expect(contractAtGeneratorTime!).not.toMatch(
      /\*\*Status:\*\*\s*NEGOTIATING/,
    );
    expect(contractAtGeneratorTime!).not.toContain("## Evaluator feedback");
  }, 240_000);
});


/**
 * Post-merge guardian review phase hardening (ADR 0015): review failure
 * classes and infrastructure retries, always-committed review artifacts,
 * scope-aware PM prompts, PM-verdict override, and cheap re-entry caching.
 */
describe("post-merge guardian review phase (ADR 0015)", () => {
  /** Write a guardian review file into the review worktree's specs dir. */
  function writeReviewFile(
    cwd: string,
    slug: string,
    fileName: string,
    verdict: string,
  ): void {
    const dir = join(cwd, ".kiro", "specs", slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, fileName),
      `# Guardian Review\n\n**Verdict:** ${verdict}\n\nFindings here.\n`,
      "utf-8",
    );
  }

  function makePassingSliceSetup(
    slug: string,
    ghIssue: string,
    repoOpts: { lifetime?: "test" | "describe" } = {},
  ) {
    const repo = makeRepo(repoOpts);
    const { prdDir, specsDir } = writePrdFixture(repo, slug);
    const slices: Slice[] = [
      {
        number: "01",
        ghIssue,
        title: "Passing slice",
        type: "AFK",
        blockedBy: [],
        userStories: "",
      },
    ];
    const fixtures = new Map<string, SliceFixture>([
      [
        ghIssue,
        {
          files: ["src/out.txt"],
          qaPasses: true,
          outputFile: "src/out.txt",
          outputContent: "out",
        },
      ],
    ]);
    const records: InvocationRecord[] = [];
    const baseProvider = buildStubProvider({ fixtures, slices, records });
    return { repo, prdDir, specsDir, slices, records, baseProvider };
  }

  /**
   * Everything a blocked-by-the-PM run must do, on one fixture. These
   * cases all end in the same terminal state — architect favorable, PM
   * FIX-BEFORE-SHIP, no override, so no PR opens — and each used to pay
   * for its own pipeline. They now share two runs: the first recovers an
   * infrastructure-failed architect review and lands Not ready, the
   * second re-enters an unchanged tree. Per AGENTS.md, a new assertion
   * about this state belongs here rather than in a fourth spawn.
   */
  describe("a run the PM blocked, and its re-entry", () => {
    const slug = "review-notready";
    /** Counts sanity-gate executions, so the re-entry cache is observable. */
    let marker: string;
    let repo: string;
    let first: Awaited<ReturnType<typeof runPipeline>>;
    let second: Awaited<ReturnType<typeof runPipeline>>;
    let architectAttempts = 0;
    let pmRuns = 0;
    let gateRunsAfterFirst = 0;
    let gateRunsAfterSecond = 0;
    const reviewOptions: InvokeOptions[] = [];
    const featBranch = `feat-stub/${slug}`;

    beforeAll(async () => {
      const setup = makePassingSliceSetup(slug, "7101", { lifetime: "describe" });
      repo = setup.repo;

      // A sanity `test:run` step that counts its executions via a marker file.
      marker = join(repo, ".afk-sanity-marker.txt").replace(/\\/g, "/");
      writeFileSync(
        join(repo, "package.json"),
        JSON.stringify(
          {
            name: "consumer-fixture",
            private: true,
            scripts: {
              "test:run": `node -e "require('fs').appendFileSync('${marker}','x')"`,
            },
          },
          null,
          2,
        ),
        "utf-8",
      );
      git(repo, ["add", "package.json"]);
      git(repo, ["commit", "-m", "add sanity script"]);

      const provider: AgentProvider = {
        name: setup.baseProvider.name,
        async invoke(options) {
          if (options.role === "architect-review") {
            reviewOptions.push(options);
            architectAttempts++;
            if (architectAttempts === 1) {
              // Spawn-style wrapper failure: no output produced.
              throw new Error(
                "Agent architect-review exited with code 1: codex-wrapper: error: failed to persist AWS config file",
              );
            }
            writeReviewFile(
              options.cwd,
              slug,
              "review-architect.md",
              "ACCEPT-WITH-NOTES",
            );
            return { exitCode: 0, stdout: "", stats: {} };
          }
          if (options.role === "pm-review") {
            pmRuns++;
            // Unfavorable real verdict, so no PR/push path is exercised.
            writeReviewFile(options.cwd, slug, "review-pm.md", "FIX-BEFORE-SHIP");
            // Guardians also append to a governance log in consumer repos.
            const govDir = join(options.cwd, "docs", "governance");
            mkdirSync(govDir, { recursive: true });
            writeFileSync(join(govDir, "log.md"), "review entry\n", "utf-8");
            return { exitCode: 0, stdout: "", stats: {} };
          }
          return setup.baseProvider.invoke(options);
        },
      };

      const config = {
        repoRoot: repo,
        prdSlug: slug,
        prdDir: setup.prdDir,
        specsDir: setup.specsDir,
        provider,
        infrastructureRetries: 1,
      };
      first = await runPipeline({ ...config, dag: buildDAG(setup.slices) });
      gateRunsAfterFirst = readFileSync(marker, "utf-8").length;
      // Re-entry with nothing changed.
      second = await runPipeline({ ...config, dag: buildDAG(setup.slices) });
      gateRunsAfterSecond = readFileSync(marker, "utf-8").length;
    }, 240_000);

    afterAll(() => {
      try {
        rmSync(repo, { recursive: true, force: true });
      } catch {
        // best effort
      }
    });

    it("recovers an infrastructure-failed architect review inside the run", () => {
      // The first failure did not become terminal: the retry recovered a
      // real verdict, and only the PM kept the run from shipping.
      expect(architectAttempts).toBe(2);
      expect(first.consoleSummary).toContain("Architect review: ACCEPT-WITH-NOTES");
    });

    it("gives the reviews the slow-agent inactivity budget", () => {
      // Not the 180 s provider default that killed the PRD 070 PM review
      // mid-run.
      expect(reviewOptions[0]!.idleTimeoutMs).toBe(600_000);
    });

    it("reports Not ready and fails the run on the unfavorable PM verdict (#43)", () => {
      // The slice itself passed and merged — the run is unsuccessful anyway.
      expect(first.consoleSummary).toContain("PM review: FIX-BEFORE-SHIP");
      expect(first.consoleSummary).toContain("Not ready");
      expect(first.success).toBe(false);
      expect(first.failureReason).toContain("draft PR");
      expect(first.failureReason).toContain("FIX-BEFORE-SHIP");
    });

    it("commits the guardian review artifacts even when Not ready", () => {
      // The Not-ready outcome must still leave the evidence committed on
      // the feature branch — nothing dirty in the (removed) review worktree.
      const log = git(repo, ["log", "--format=%s", featBranch]);
      expect(log).toContain(`docs(${slug}): add post-impl guardian reviews`);
      const show = (path: string) => git(repo, ["show", `${featBranch}:${path}`]);
      expect(show(`.kiro/specs/${slug}/review-pm.md`)).toContain("FIX-BEFORE-SHIP");
      expect(show(`.kiro/specs/${slug}/review-architect.md`)).toContain(
        "ACCEPT-WITH-NOTES",
      );
      expect(show("docs/governance/log.md")).toContain("review entry");
    });

    it("reuses the sanity gate result for an unchanged tree", () => {
      // The gate result is cached against the post-review-commit tree.
      expect(gateRunsAfterFirst).toBe(2);
      expect(gateRunsAfterSecond).toBe(2);
    });

    it("skips the favorable review for an unchanged HEAD and re-runs the blocking one", () => {
      expect(architectAttempts).toBe(2); // one failure + one success, in run 1
      expect(pmRuns).toBe(2);
      expect(second.success).toBe(false);
      expect(second.consoleSummary).toContain("Architect review: ACCEPT-WITH-NOTES");
      expect(second.consoleSummary).toContain("PM review: FIX-BEFORE-SHIP");
    });
  });

  it("classifies an idle-kill after real activity as DIED_MID_RUN", async () => {
    const slug = "review-idle-kill";
    const { repo, prdDir, specsDir, slices, baseProvider } =
      makePassingSliceSetup(slug, "7102");

    let pmAttempts = 0;
    const provider: AgentProvider = {
      name: baseProvider.name,
      async invoke(options) {
        if (options.role === "pm-review") {
          pmAttempts++;
          throw new Error("Agent pm-review idle for 600s - killed");
        }
        if (options.role === "architect-review") {
          writeReviewFile(options.cwd, slug, "review-architect.md", "SHIP");
          return { exitCode: 0, stdout: "", stats: {} };
        }
        return baseProvider.invoke(options);
      },
    };

    const result = await runPipeline({
      repoRoot: repo,
      prdSlug: slug,
      prdDir,
      specsDir,
      dag: buildDAG(slices),
      provider,
      infrastructureRetries: 1,
    });

    expect(result.success).toBe(false);
    expect(pmAttempts).toBe(2);
    expect(result.consoleSummary).toContain("PM review DIED_MID_RUN");
    const summary = readFileSync(
      join(repo, ".afk", "logs", `${slug}-stub`, "run-summary.md"),
      "utf-8",
    );
    expect(summary).toContain("PM review: DIED_MID_RUN — Agent pm-review idle for 600s - killed");
  }, 240_000);

  it("passes the run scope (selected vs skipped HITL) into the PM review prompt", async () => {
    const slug = "review-scope";
    const repo = makeRepo();
    const { prdDir, specsDir } = writePrdFixture(repo, slug);
    const slices: Slice[] = [
      {
        number: "01",
        ghIssue: "7201",
        title: "Selected AFK slice",
        type: "AFK",
        blockedBy: [],
        userStories: "",
      },
      {
        number: "02",
        ghIssue: "7202",
        title: "Activate paid production services",
        type: "HITL",
        blockedBy: [],
        userStories: "",
      },
    ];
    const fixtures = new Map<string, SliceFixture>([
      [
        "7201",
        {
          files: ["src/scope.txt"],
          qaPasses: true,
          outputFile: "src/scope.txt",
          outputContent: "scope",
        },
      ],
    ]);
    const records: InvocationRecord[] = [];
    const baseProvider = buildStubProvider({ fixtures, slices, records });

    let pmPrompt: string | undefined;
    let architectPrompt: string | undefined;
    const provider: AgentProvider = {
      name: baseProvider.name,
      async invoke(options) {
        if (options.role === "pm-review") pmPrompt = options.prompt;
        if (options.role === "architect-review") architectPrompt = options.prompt;
        return baseProvider.invoke(options);
      },
    };

    await runPipeline({
      repoRoot: repo,
      prdSlug: slug,
      prdDir,
      specsDir,
      dag: buildDAG(slices),
      provider,
    });

    expect(pmPrompt).toBeDefined();
    expect(pmPrompt!).toContain("01 (#7201) Selected AFK slice");
    expect(pmPrompt!).toContain(
      "02 (#7202) Activate paid production services (HITL — reserved for a human; AFK never runs it)",
    );
    expect(pmPrompt!).toContain("MUST NOT drive the verdict");
    // The architect prompt is scope-free; only the PM judges PRD coverage.
    expect(architectPrompt).toBeDefined();
    expect(architectPrompt!).not.toContain("Activate paid production services");
  }, 240_000);

  /**
   * A run that ends without a shippable branch must not report success
   * (issue #43). `PipelineResult.success` used to be computed purely from
   * slice outcomes, so all-slices-PASS plus a FIX-BEFORE-SHIP PM verdict
   * exited 0 and wrapper scripts could not tell a shipped run from a
   * blocked one. All-slices-PASS is now necessary but not sufficient.
   */
  describe("honest exit signal (issue #43)", () => {
    /** Wire both guardian reviews to fixed verdicts over the passing stub. */
    function withVerdicts(
      slug: string,
      baseProvider: AgentProvider,
      verdicts: { architect?: string; pm?: string },
    ): AgentProvider {
      return {
        name: baseProvider.name,
        async invoke(options) {
          if (options.role === "architect-review" && verdicts.architect) {
            writeReviewFile(
              options.cwd,
              slug,
              "review-architect.md",
              verdicts.architect,
            );
            return { exitCode: 0, stdout: "", stats: {} };
          }
          if (options.role === "pm-review" && verdicts.pm) {
            writeReviewFile(options.cwd, slug, "review-pm.md", verdicts.pm);
            return { exitCode: 0, stdout: "", stats: {} };
          }
          return baseProvider.invoke(options);
        },
      };
    }

    // The plain "unfavorable PM verdict keeps the PR closed" case lives
    // in "a run the PM blocked, and its re-entry" above, on the fixture
    // that already reaches that state.

    it("treats an unparseable guardian verdict the same way", async () => {
      const slug = "exit-unparseable";
      const { repo, prdDir, specsDir, slices, baseProvider } =
        makePassingSliceSetup(slug, "7402");

      // The PM finishes and writes a review, but with no recognizable
      // verdict marker — an absent judgment, not an unfavorable one, and
      // not an override the operator can record disagreement with.
      const provider: AgentProvider = {
        name: baseProvider.name,
        async invoke(options) {
          if (options.role === "architect-review") {
            writeReviewFile(options.cwd, slug, "review-architect.md", "SHIP");
            return { exitCode: 0, stdout: "", stats: {} };
          }
          if (options.role === "pm-review") {
            const dir = join(options.cwd, ".kiro", "specs", slug);
            mkdirSync(dir, { recursive: true });
            writeFileSync(
              join(dir, "review-pm.md"),
              "# Guardian Review\n\nI reviewed the branch and have thoughts.\n",
              "utf-8",
            );
            return { exitCode: 0, stdout: "", stats: {} };
          }
          return baseProvider.invoke(options);
        },
      };

      const result = await runPipeline({
        repoRoot: repo,
        prdSlug: slug,
        prdDir,
        specsDir,
        dag: buildDAG(slices),
        // Even with the override flag on, an absent judgment is not
        // overridable (ADR 0015) — so the run stays unsuccessful.
        openPrOnOverride: true,
        provider,
      });

      expect(result.success).toBe(false);
      expect(result.failureReason).toContain("PM: UNPARSEABLE");
    }, 240_000);

    it("is unsuccessful when cancellation landed after the last merge but before the ship gates", async () => {
      const slug = "exit-cancelled-preship";
      const { repo, prdDir, specsDir, slices, baseProvider } =
        makePassingSliceSetup(slug, "7406");

      // Cancel as soon as the slice's QA lands: the merge completes, so
      // every slice is PASS, but the sanity gate and guardians never run.
      const controller = new AbortController();
      const provider: AgentProvider = {
        name: baseProvider.name,
        async invoke(options) {
          const result = await baseProvider.invoke(options);
          if (options.role === "evaluator-qa") controller.abort();
          return result;
        },
      };

      const result = await runPipeline({
        repoRoot: repo,
        prdSlug: slug,
        prdDir,
        specsDir,
        dag: buildDAG(slices),
        provider,
        signal: controller.signal,
      });

      expect(result.success).toBe(false);
      expect(result.failureReason).toContain("cancelled");
    }, 240_000);

    it("is unsuccessful when the pre-ship sanity gate failed, naming the failing step", async () => {
      const slug = "exit-sanity-fail";
      const { repo, prdDir, specsDir, slices, baseProvider } =
        makePassingSliceSetup(slug, "7403");
      const marker = join(repo, ".afk-sanity-marker.txt").replace(/\\/g, "/");

      writeFileSync(
        join(repo, "package.json"),
        JSON.stringify(
          {
            name: "consumer-fixture",
            private: true,
            scripts: {
              typecheck: `node -e "const fs=require('fs');const p='${marker}';const n=fs.existsSync(p)?fs.readFileSync(p,'utf-8').length:0;fs.appendFileSync(p,'x');process.exit(n===0?0:1)"`,
            },
          },
          null,
          2,
        ),
        "utf-8",
      );
      git(repo, ["add", "package.json"]);
      git(repo, ["commit", "-m", "add failing typecheck"]);

      const result = await runPipeline({
        repoRoot: repo,
        prdSlug: slug,
        prdDir,
        specsDir,
        dag: buildDAG(slices),
        // Favorable verdicts would open the PR — but the gate short-circuits
        // the guardians, so the run is unsuccessful regardless.
        provider: withVerdicts(slug, baseProvider, {
          architect: "SHIP",
          pm: "SHIP",
        }),
      });

      expect(result.success).toBe(false);
      expect(result.failureReason).toContain("pre-ship sanity gate");
      expect(result.failureReason).toContain("typecheck");
    }, 240_000);

    it("stays successful when both guardian verdicts are favorable and the draft PR opened", async () => {
      const slug = "exit-shipped";
      const { repo, prdDir, specsDir, slices, baseProvider } =
        makePassingSliceSetup(slug, "7404");

      const result = await runPipeline({
        repoRoot: repo,
        prdSlug: slug,
        prdDir,
        specsDir,
        dag: buildDAG(slices),
        provider: withVerdicts(slug, baseProvider, {
          architect: "SHIP",
          pm: "ACCEPT-WITH-NOTES",
        }),
      });

      expect(result.success).toBe(true);
      expect(result.failureReason).toBeUndefined();
    }, 240_000);

    it("stays successful when --open-pr-on-override opened the draft PR, with the override note recorded", async () => {
      const slug = "exit-override";
      const { repo, prdDir, specsDir, slices, baseProvider } =
        makePassingSliceSetup(slug, "7405");

      const result = await runPipeline({
        repoRoot: repo,
        prdSlug: slug,
        prdDir,
        specsDir,
        dag: buildDAG(slices),
        openPrOnOverride: true,
        provider: withVerdicts(slug, baseProvider, {
          architect: "SHIP",
          pm: "FIX-BEFORE-SHIP",
        }),
      });

      // The override note is the operator's recorded acknowledgement, so a
      // deliberate override is not reported as a failure.
      expect(result.success).toBe(true);
      expect(result.failureReason).toBeUndefined();
      expect(result.summary).toContain(
        "PR opened via --open-pr-on-override despite PM verdict FIX-BEFORE-SHIP",
      );
    }, 240_000);
  });
});

describe("buildReviewScopeBlock", () => {
  const slice = (number: string, ghIssue: string, title: string, type: "AFK" | "HITL"): Slice => ({
    number,
    ghIssue,
    title,
    type,
    blockedBy: [],
    userStories: "",
  });

  it("lists selected slices and skipped slices with their reasons", () => {
    const selected = slice("01", "1", "Do the thing", "AFK");
    const block = buildReviewScopeBlock({
      persisted: { mode: "explicit", slices: [{ number: "01", ghIssue: "1" }] },
      members: [selected],
      selected: [selected],
      skipped: [
        { slice: slice("02", "2", "Human ceremony", "HITL"), reason: "hitl" },
        { slice: slice("03", "3", "Deferred work", "AFK"), reason: "not-selected" },
      ],
    });
    expect(block).toContain("- 01 (#1) Do the thing");
    expect(block).toContain(
      "- 02 (#2) Human ceremony (HITL — reserved for a human; AFK never runs it)",
    );
    expect(block).toContain("- 03 (#3) Deferred work (not selected for this run)");
  });

  it("tells the reviewer the invocation was narrowed and which members it left out", () => {
    const passed = slice("01", "1", "Passed earlier", "AFK");
    const selected = slice("02", "2", "Re-run of the failed slice", "AFK");
    const block = buildReviewScopeBlock({
      persisted: {
        mode: "all-afk",
        slices: [
          { number: "01", ghIssue: "1" },
          { number: "02", ghIssue: "2" },
        ],
      },
      members: [passed, selected],
      selected: [selected],
      skipped: [
        { slice: passed, reason: "narrowed" },
      ],
    });
    expect(block).toContain("- 02 (#2) Re-run of the failed slice");
    expect(block).toContain("narrowed");
    expect(block).toContain(
      "- 01 (#1) Passed earlier (in this run's scope of record but not run by this invocation)",
    );
  });

  it("notes when nothing was skipped", () => {
    const selected = slice("01", "1", "Everything", "AFK");
    const block = buildReviewScopeBlock({
      persisted: { mode: "all-afk", slices: [{ number: "01", ghIssue: "1" }] },
      members: [selected],
      selected: [selected],
      skipped: [],
    });
    expect(block).toContain("No manifest slices were skipped");
  });
});

describe("buildPrCreationPlan", () => {
  const base = {
    prdSlug: "demo",
    specsDir: ".kiro/specs/demo",
    closesIssues: ["41", "42"],
  };

  it("opens without override when both outcomes are favorable", () => {
    const plan = buildPrCreationPlan({
      ...base,
      architect: "SHIP",
      pm: "ACCEPT-WITH-NOTES",
      openPrOnOverride: false,
    });
    expect(plan.open).toBe(true);
    expect(plan.overridden).toBe(false);
    expect(plan.overrideNote).toBeUndefined();
    expect(plan.body).not.toContain("Human override");
    expect(plan.body).toContain("Closes #41");
    expect(plan.body).toContain("Closes #42");
  });

  it("stays closed on an unfavorable PM verdict without the flag", () => {
    const plan = buildPrCreationPlan({
      ...base,
      architect: "SHIP",
      pm: "FIX-BEFORE-SHIP",
      openPrOnOverride: false,
    });
    expect(plan.open).toBe(false);
  });

  it("overrides a real FIX-BEFORE-SHIP PM verdict and records both verdicts in the body", () => {
    const plan = buildPrCreationPlan({
      ...base,
      architect: "ACCEPT-WITH-NOTES",
      pm: "FIX-BEFORE-SHIP",
      openPrOnOverride: true,
    });
    expect(plan.open).toBe(true);
    expect(plan.overridden).toBe(true);
    expect(plan.body).toContain("## Human override (--open-pr-on-override)");
    expect(plan.body).toContain("- Architect review: **ACCEPT-WITH-NOTES**");
    expect(plan.body).toContain("- PM review: **FIX-BEFORE-SHIP** (overridden)");
    expect(plan.body).toContain("review-pm.md");
    expect(plan.overrideNote).toContain("--open-pr-on-override");
  });

  it("never overrides an unfavorable architect verdict", () => {
    const plan = buildPrCreationPlan({
      ...base,
      architect: "FIX-BEFORE-SHIP",
      pm: "FIX-BEFORE-SHIP",
      openPrOnOverride: true,
    });
    expect(plan.open).toBe(false);
    expect(plan.overridden).toBe(false);
  });

  it.each(["NEVER_RAN", "DIED_MID_RUN", "UNPARSEABLE"] as const)(
    "never overrides a %s PM outcome — overrides record disagreement with a judgment, not absence of one",
    (pm) => {
      const plan = buildPrCreationPlan({
        ...base,
        architect: "SHIP",
        pm,
        openPrOnOverride: true,
      });
      expect(plan.open).toBe(false);
      expect(plan.overridden).toBe(false);
    },
  );

  /**
   * `open` is what makes `PipelineResult.success` honest (issue #43): a
   * closed plan is a run with no shippable branch, and an overridden-open
   * plan is the one deliberate exception that still exits 0.
   */
  it("closes the plan for every unfavorable or absent verdict pair without the override", () => {
    const outcomes = [
      "FIX-BEFORE-SHIP",
      "NEVER_RAN",
      "DIED_MID_RUN",
      "UNPARSEABLE",
    ] as const;
    for (const architect of outcomes) {
      for (const pm of [...outcomes, "SHIP", "ACCEPT-WITH-NOTES"] as const) {
        const plan = buildPrCreationPlan({
          ...base,
          architect,
          pm,
          openPrOnOverride: false,
        });
        expect(plan.open, `${architect}/${pm}`).toBe(false);
        expect(plan.overrideNote, `${architect}/${pm}`).toBeUndefined();
      }
    }
  });

  it("the only open-with-override case carries the note that keeps the run successful", () => {
    for (const architect of ["SHIP", "ACCEPT-WITH-NOTES"] as const) {
      const plan = buildPrCreationPlan({
        ...base,
        architect,
        pm: "FIX-BEFORE-SHIP",
        openPrOnOverride: true,
      });
      expect(plan.open).toBe(true);
      expect(plan.overrideNote).toBeDefined();
    }
  });
});


/**
 * Observability (ADR 0017): every run gets its own log directory with a
 * run.log the orchestrator owns. Phase transitions must be readable
 * from disk — launcher stdio was lost on Windows (`pnpm exec ... 2>&1`
 * produced an empty file), leaving hangs indistinguishable from
 * progress.
 */
describe("run.log observability (ADR 0017)", () => {
  function runDirsOf(repo: string, slug: string): string[] {
    const parent = join(repo, ".afk", "logs", `${slug}-stub`);
    return readdirSync(parent)
      .filter((d) => /^run-\d{8}-\d{6}/.test(d))
      .map((d) => join(parent, d));
  }

  it("writes phase transitions, lane queueing, verdicts, and outcomes to run.log; agent logs live in the run dir", async () => {
    const repo = makeRepo();
    const slug = "runlog";
    const { prdDir, specsDir } = writePrdFixture(repo, slug);

    const slices: Slice[] = [
      { number: "01", ghIssue: "9101", title: "Lead", type: "AFK", blockedBy: [], userStories: "" },
      { number: "02", ghIssue: "9102", title: "Follower", type: "AFK", blockedBy: [], userStories: "" },
    ];
    // Shared file → one lane → the follower must emit a "queued behind"
    // line, the exact signal that was missing when a NEGOTIATING slice
    // looked dropped.
    const fixtures = new Map<string, SliceFixture>([
      ["9101", { files: ["src/shared.txt"], qaPasses: true, outputFile: "src/shared.txt", outputContent: "lead" }],
      ["9102", { files: ["src/shared.txt"], qaPasses: true, outputFile: "src/shared.txt", outputContent: "follower" }],
    ]);
    const records: InvocationRecord[] = [];

    await runPipeline({
      repoRoot: repo,
      prdSlug: slug,
      prdDir,
      specsDir,
      dag: buildDAG(slices),
      provider: buildStubProvider({ fixtures, slices, records }),
    });

    const runDirs = runDirsOf(repo, slug);
    expect(runDirs.length).toBe(1);
    const runDir = runDirs[0]!;

    const runLog = readFileSync(join(runDir, "run.log"), "utf-8");
    // Every line is timestamped.
    for (const line of runLog.trim().split("\n")) {
      expect(line).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] /);
    }
    // Startup line points at this run's directory.
    expect(runLog).toContain("Pipeline run started");
    // Wave and per-slice phase transitions.
    expect(runLog).toContain("Wave 1: dispatching 2 slice(s)");
    expect(runLog).toContain("Slice #9101 (Lead): exploring...");
    // Contract negotiation is observable: verdict and lock per slice.
    expect(runLog).toContain("contract verdict ACCEPT (round 1/3)");
    expect(runLog).toContain("Slice #9101 (Lead): contract LOCKED");
    // Lane queueing is explicit — a waiting successor is distinguishable
    // from a dropped one.
    expect(runLog).toContain(
      "Slice #9102 queued behind #9101 in its lane",
    );
    expect(runLog).toContain("not dropped");
    // Terminal outcomes land in the file too.
    expect(runLog).toContain(
      `Slice #9101 (Lead): PASS — merged into feat-stub/${slug}`,
    );
    expect(runLog).toContain(
      `Slice #9102 (Follower): PASS — merged into feat-stub/${slug}`,
    );

    // Agent invocation logs live inside the run directory…
    const filesInRunDir = readdirSync(runDir);
    expect(filesInRunDir).toContain("slice-01-explorer.log");
    expect(filesInRunDir).toContain("slice-01-generator-r1.log");
    // …and a per-run summary copy sits next to them.
    expect(filesInRunDir).toContain("run-summary.md");
    // The stable summary path is preserved for existing consumers.
    expect(
      existsSync(join(repo, ".afk", "logs", `${slug}-stub`, "run-summary.md")),
    ).toBe(true);
    // No agent logs leak into the shared prd dir (the cross-run append
    // defect surface).
    const parentEntries = readdirSync(join(repo, ".afk", "logs", `${slug}-stub`));
    expect(parentEntries.some((e) => e.endsWith(".log"))).toBe(false);
  }, 240_000);

  it("a re-run gets a fresh run directory and leaves the first run's logs untouched", async () => {
    const repo = makeRepo();
    const slug = "runlog-rerun";
    const { prdDir, specsDir } = writePrdFixture(repo, slug);

    const slices: Slice[] = [
      { number: "01", ghIssue: "9201", title: "Only", type: "AFK", blockedBy: [], userStories: "" },
    ];
    const fixtures = new Map<string, SliceFixture>([
      ["9201", { files: ["src/only.txt"], qaPasses: true, outputFile: "src/only.txt", outputContent: "only" }],
    ]);
    const config = {
      repoRoot: repo,
      prdSlug: slug,
      prdDir,
      specsDir,
      provider: buildStubProvider({ fixtures, slices, records: [] }),
    };

    await runPipeline({ ...config, dag: buildDAG(slices) });
    const [firstDir] = runDirsOf(repo, slug);
    const firstRunLog = readFileSync(join(firstDir!, "run.log"), "utf-8");
    const firstGenLog = statSync(join(firstDir!, "slice-01-generator-r1.log"));

    // Second run (resumes: slice already completed — still a run).
    await runPipeline({ ...config, dag: buildDAG(slices) });

    const dirs = runDirsOf(repo, slug);
    expect(dirs.length).toBe(2);
    // First run's files did not change — no cross-run append, so mtime
    // and size keep meaning what an operator assumes they mean.
    expect(readFileSync(join(firstDir!, "run.log"), "utf-8")).toBe(firstRunLog);
    expect(
      statSync(join(firstDir!, "slice-01-generator-r1.log")).mtimeMs,
    ).toBe(firstGenLog.mtimeMs);
    // The second run's run.log records the resume ("already completed").
    const secondDir = dirs.find((d) => d !== firstDir)!;
    const secondRunLog = readFileSync(join(secondDir, "run.log"), "utf-8");
    expect(secondRunLog).toContain("Pipeline run started");
    expect(secondRunLog).toContain("(already completed)");
  }, 240_000);
});

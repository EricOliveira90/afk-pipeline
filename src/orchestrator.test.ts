import { describe, it, expect, afterEach, vi } from "vitest";
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
  buildPrCreationPlan,
  buildReviewScopeBlock,
  makeAsyncMutex,
  makeSliceContext,
  resolveSanityCommands,
  resolveTestCommand,
  runPipeline,
  runSliceNegotiate,
  runPreShipSanity,
} from "./orchestrator.js";
import { buildDAG, parseIssuesMd, type Slice } from "./issues-parser.js";
import { Logger } from "./logger.js";
import type {
  AgentProvider,
  InvokeOptions,
  InvokeResult,
} from "./agent-provider.js";

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

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort
    }
  }
});

describe("runPreShipSanity", () => {
  it("returns ok with no failures when no package.json exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "afk-sanity-"));
    tempDirs.push(dir);
    expect(runPreShipSanity(dir)).toEqual({ ok: true, failures: [] });
  });

  it("skips steps not defined in package.json (lint absent → not a failure)", () => {
    const dir = makeProject({
      typecheck: "node -e \"process.exit(0)\"",
      "test:run": "node -e \"process.exit(0)\"",
    });
    expect(runPreShipSanity(dir)).toEqual({ ok: true, failures: [] });
  });

  it("passes when all defined scripts succeed", () => {
    const dir = makeProject({
      typecheck: "node -e \"process.exit(0)\"",
      lint: "node -e \"process.exit(0)\"",
      "test:run": "node -e \"process.exit(0)\"",
    });
    expect(runPreShipSanity(dir)).toEqual({ ok: true, failures: [] });
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
 * Drift test: the command set the evaluator-qa is told to run MUST equal
 * the command set the post-merge sanity gate runs. If they diverge, a
 * slice can pass QA on code the gate then rejects (the failure mode that
 * motivated this fix: typecheck/lint violations passing through QA
 * because QA only ran tests). Walks several package.json shapes; for
 * each, the scripts `runPreShipSanity` attempts via `execFileSync` must
 * exactly match — same scripts, same order — what `resolveSanityCommands`
 * reports.
 */
describe("evaluator-qa sanity command set matches the post-merge gate", () => {
  function recordedRuns(dir: string): string[] {
    // Use scripts that record their own name to a marker file as they
    // run, so we can read back the exact sequence runPreShipSanity
    // executed against this fixture without mocking execFileSync.
    const marker = join(dir, "ran.log");
    const scripts = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")).scripts as Record<string, string>;
    const rewritten: Record<string, string> = {};
    for (const [name, body] of Object.entries(scripts)) {
      const exit = body.includes("process.exit(1)") ? 1 : 0;
      rewritten[name] = `node -e "require('fs').appendFileSync('${marker.replace(/\\/g, "\\\\")}', '${name}\\n'); process.exit(${exit})"`;
    }
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "fixture", scripts: rewritten }),
      "utf-8",
    );
    runPreShipSanity(dir);
    if (!existsSync(marker)) return [];
    return readFileSync(marker, "utf-8").trim().split("\n").filter(Boolean);
  }

  it("matches when all three steps are defined", () => {
    const dir = makeProject({
      typecheck: "node -e \"process.exit(0)\"",
      lint: "node -e \"process.exit(0)\"",
      "test:run": "node -e \"process.exit(0)\"",
    });
    const reported = resolveSanityCommands(dir);
    const ran = recordedRuns(dir);
    expect(reported).toEqual(ran.map((s) => `pnpm run ${s}`));
    expect(reported).toEqual(["pnpm run typecheck", "pnpm run lint", "pnpm run test:run"]);
  });

  it("matches when lint is absent (skipped step is reported in neither)", () => {
    const dir = makeProject({
      typecheck: "node -e \"process.exit(0)\"",
      "test:run": "node -e \"process.exit(0)\"",
    });
    const reported = resolveSanityCommands(dir);
    const ran = recordedRuns(dir);
    expect(reported).toEqual(ran.map((s) => `pnpm run ${s}`));
    expect(reported).toEqual(["pnpm run typecheck", "pnpm run test:run"]);
  });

  it("matches when only the `test` fallback is defined", () => {
    const dir = makeProject({ test: "node -e \"process.exit(0)\"" });
    const reported = resolveSanityCommands(dir);
    const ran = recordedRuns(dir);
    expect(reported).toEqual(ran.map((s) => `pnpm run ${s}`));
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

const integrationTempDirs: string[] = [];

afterEach(() => {
  while (integrationTempDirs.length > 0) {
    const dir = integrationTempDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

interface SliceFixture {
  /** Files the planner declares in `contract.md`'s "Files expected to change". */
  files: string[];
  /**
   * Whether the QA evaluator should pass on the first generator round.
   * If `false`, the qa-report verdict is "FAIL" for all rounds, and the
   * slice should end up STUCK after MAX_GENERATOR_ROUNDS.
   */
  qaPasses: boolean;
  /** File the generator should create in the worktree (so commits have content). */
  outputFile: string;
  outputContent: string;
}

interface InvocationRecord {
  role: string;
  cwd: string;
  startedAt: number;
  finishedAt: number;
  /** ghIssue parsed from cwd (worktree directory contains the slice number) */
  ghIssue: string;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "afk-orch-"));
  integrationTempDirs.push(dir);
  git(dir, ["init", "--initial-branch=main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  // Need at least one commit before we can branch.
  writeFileSync(join(dir, "README.md"), "test\n", "utf-8");
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "-m", "root"]);
  return dir;
}

function writePrdFixture(repoDir: string, slug: string): { prdDir: string; specsDir: string } {
  const specsDir = join(".kiro", "specs", slug);
  const prdDir = join(repoDir, specsDir);
  mkdirSync(prdDir, { recursive: true });
  writeFileSync(
    join(prdDir, "prd.md"),
    `# ${slug}\n\n## Relevant Files\n- README.md — root readme\n`,
    "utf-8",
  );
  // Issues file is parsed externally; we build the DAG manually below.
  return { prdDir, specsDir };
}

/**
 * Extract the slice's gh issue id from a worktree path. Worktrees live
 * at `.afk/worktrees/<prefix>-<prd-slug>-s<NN>/` (truncated form, see
 * `makeSliceContext`); we match the trailing `-s<NN>` segment.
 */
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
  records: InvocationRecord[];
}): AgentProvider {
  const { fixtures, slices, records } = opts;
  // Track per-slice generator round so the stub can write fresh content
  // and decide PASS vs FAIL based on the round.
  const generatorRounds = new Map<string, number>();

  return {
    name: "stub",
    async invoke(options: InvokeOptions): Promise<InvokeResult> {
      const { role, cwd } = options;
      const slice = sliceFromCwd(cwd, slices);
      const ghIssue = slice?.ghIssue ?? "";
      const fixture = fixtures.get(ghIssue);
      const startedAt = Date.now();
      // Force a small delay so concurrent invocations can interleave
      // observably in timestamps.
      await new Promise((r) => setTimeout(r, 10));

      // The slice artifact dir lives under the worktree. We need the
      // slice's relative path to write contract.md / qa-report.md.
      // Tests pass slug-derived dirs, so we walk the tree to find the
      // unique slice subdir.
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
        writeFileSync(
          join(sliceArtifactDir, "feedback-r1.md"),
          "## Evaluator feedback — round 1\n\n**Verdict:** ACCEPT\n",
          "utf-8",
        );
      } else if (role === "generator" && sliceArtifactDir && fixture) {
        const round = (generatorRounds.get(ghIssue) ?? 0) + 1;
        generatorRounds.set(ghIssue, round);
        // Write the fixture's output file into the worktree so the
        // commit has real content.
        const outPath = join(cwd, fixture.outputFile);
        mkdirSync(join(outPath, ".."), { recursive: true });
        writeFileSync(
          outPath,
          `${fixture.outputContent}\n// generator round ${round} for #${ghIssue}\n`,
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
      // architect-review / pm-review are no-ops; verdicts will be
      // UNKNOWN, blocking PR creation. That path is fine for our tests.

      const finishedAt = Date.now();
      records.push({ role, cwd, startedAt, finishedAt, ghIssue });
      return { exitCode: 0, stdout: "", stats: {} };
    },
  };
}

/**
 * Locate the slice artifact directory inside a worktree by scanning
 * `.kiro/specs/<slug>/slices/<number>-<slug>`. We don't know the slug
 * here, but each slice has a single artifact dir whose name starts
 * with `<sliceNumber>-`, so we walk the slices folder.
 */
function findSliceArtifactDir(cwd: string, sliceNumber: string): string | null {
  // Walk `.kiro/specs/*/slices/<number>-*` for the slice's artifact dir.
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
  }, 60_000);

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
  }, 60_000);

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
  }, 60_000);
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

    expect(result.success).toBe(true);
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
    expect(handoff.runStatus).toBe("SUCCEEDED");
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

    expect(result.success).toBe(true);
    expect(result.consoleSummary).toContain(`AFK Pipeline Summary — ${slug}`);
    expect(result.consoleSummary).toMatch(/Succeeded \(1\)/);
    expect(result.consoleSummary).toContain("#5001 Only");
    expect(result.consoleSummary).toContain(`merged into feat-stub/${slug}`);
    expect(result.consoleSummary).toMatch(/Failed \/ Stuck \(0\)/);
    // No package.json in fixture → sanity gate skipped (returns ok); reviews
    // are no-ops in the stub → verdicts UNKNOWN → not ready.
    expect(result.consoleSummary).toContain("Not ready");
  }, 60_000);

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
  }, 60_000);

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

    // Pipeline returns normally; the slice succeeded.
    expect(result.success).toBe(true);
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
  }, 60_000);

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

    // Pipeline still returns normally.
    expect(result.success).toBe(true);
    expect(result.consoleSummary).toMatch(/Succeeded \(1\)/);
    expect(result.consoleSummary).toContain("Not ready");
    expect(result.consoleSummary).toContain("architect review NEVER_RAN");
    expect(result.consoleSummary).toContain("PM review NEVER_RAN");
    const summaryPath = join(repo, ".afk", "logs", `${slug}-stub`, "run-summary.md");
    expect(existsSync(summaryPath)).toBe(true);
  }, 60_000);
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

    await expect(runSliceNegotiate(ctx)).resolves.toBe("LOCKED");
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
      await expect(runSliceNegotiate(ctx)).resolves.toBe("LOCKED");
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
      await expect(runSliceNegotiate(ctx)).resolves.toBe("ESCALATE");
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
  }, 60_000);
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

  function makePassingSliceSetup(slug: string, ghIssue: string) {
    const repo = makeRepo();
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

  it("retries an infrastructure-failed review within the run and records the recovered verdict", async () => {
    const slug = "review-retry";
    const { repo, prdDir, specsDir, slices, baseProvider } =
      makePassingSliceSetup(slug, "7101");

    let architectAttempts = 0;
    const reviewOptions: InvokeOptions[] = [];
    const provider: AgentProvider = {
      name: baseProvider.name,
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
          writeReviewFile(options.cwd, slug, "review-architect.md", "SHIP");
          return { exitCode: 0, stdout: "", stats: {} };
        }
        if (options.role === "pm-review") {
          // Unfavorable real verdict so no PR/push path is exercised.
          writeReviewFile(options.cwd, slug, "review-pm.md", "FIX-BEFORE-SHIP");
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

    expect(result.success).toBe(true);
    // The first failure did not become terminal: the retry recovered SHIP.
    expect(architectAttempts).toBe(2);
    expect(result.consoleSummary).toContain("Architect review: SHIP");
    expect(result.consoleSummary).toContain("PM review: FIX-BEFORE-SHIP");
    expect(result.consoleSummary).toContain("Not ready");
    // Reviews run with the slow-agent inactivity budget, not the 180 s
    // provider default that killed the PRD 070 PM review mid-run.
    expect(reviewOptions[0]!.idleTimeoutMs).toBe(600_000);
  }, 60_000);

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

    expect(result.success).toBe(true);
    expect(pmAttempts).toBe(2);
    expect(result.consoleSummary).toContain("PM review DIED_MID_RUN");
    const summary = readFileSync(
      join(repo, ".afk", "logs", `${slug}-stub`, "run-summary.md"),
      "utf-8",
    );
    expect(summary).toContain("PM review: DIED_MID_RUN — Agent pm-review idle for 600s - killed");
  }, 60_000);

  it("commits guardian review artifacts to the feature branch even when Not ready", async () => {
    const slug = "review-commit-notready";
    const { repo, prdDir, specsDir, slices, baseProvider } =
      makePassingSliceSetup(slug, "7103");

    const provider: AgentProvider = {
      name: baseProvider.name,
      async invoke(options) {
        if (options.role === "architect-review") {
          writeReviewFile(options.cwd, slug, "review-architect.md", "ACCEPT-WITH-NOTES");
          return { exitCode: 0, stdout: "", stats: {} };
        }
        if (options.role === "pm-review") {
          writeReviewFile(options.cwd, slug, "review-pm.md", "FIX-BEFORE-SHIP");
          // Guardians also append to a governance log in consumer repos.
          const govDir = join(options.cwd, "docs", "governance");
          mkdirSync(govDir, { recursive: true });
          writeFileSync(join(govDir, "log.md"), "review entry\n", "utf-8");
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
    });

    expect(result.success).toBe(true);
    expect(result.consoleSummary).toContain("Not ready");
    // The Not-ready outcome must still leave the evidence committed on
    // the feature branch — nothing dirty in the (removed) review worktree.
    const featBranch = `feat-stub/${slug}`;
    const log = git(repo, ["log", "--format=%s", featBranch]);
    expect(log).toContain(`docs(${slug}): add post-impl guardian reviews`);
    const pmReview = git(repo, [
      "show",
      `${featBranch}:.kiro/specs/${slug}/review-pm.md`,
    ]);
    expect(pmReview).toContain("FIX-BEFORE-SHIP");
    const archReview = git(repo, [
      "show",
      `${featBranch}:.kiro/specs/${slug}/review-architect.md`,
    ]);
    expect(archReview).toContain("ACCEPT-WITH-NOTES");
    const governance = git(repo, [
      "show",
      `${featBranch}:docs/governance/log.md`,
    ]);
    expect(governance).toContain("review entry");
  }, 60_000);

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
  }, 60_000);

  it("cheap re-entry: reuses the sanity gate for an unchanged tree and skips favorable reviews for an unchanged HEAD", async () => {
    const slug = "review-reentry";
    const { repo, prdDir, specsDir, slices, baseProvider } =
      makePassingSliceSetup(slug, "7301");

    // A sanity `tests` step that counts its executions via a marker file.
    const marker = join(repo, ".afk-sanity-marker.txt").replace(/\\/g, "/");
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

    let architectRuns = 0;
    let pmRuns = 0;
    const provider: AgentProvider = {
      name: baseProvider.name,
      async invoke(options) {
        if (options.role === "architect-review") {
          architectRuns++;
          writeReviewFile(options.cwd, slug, "review-architect.md", "SHIP");
          return { exitCode: 0, stdout: "", stats: {} };
        }
        if (options.role === "pm-review") {
          pmRuns++;
          writeReviewFile(options.cwd, slug, "review-pm.md", "FIX-BEFORE-SHIP");
          return { exitCode: 0, stdout: "", stats: {} };
        }
        return baseProvider.invoke(options);
      },
    };

    const config = {
      repoRoot: repo,
      prdSlug: slug,
      prdDir,
      specsDir,
      provider,
    };

    const first = await runPipeline({ ...config, dag: buildDAG(slices) });
    expect(first.success).toBe(true);
    const gateRunsAfterFirst = readFileSync(marker, "utf-8").length;
    expect(gateRunsAfterFirst).toBe(1);
    expect(architectRuns).toBe(1);
    expect(pmRuns).toBe(1);

    // Re-entry with nothing changed: the gate result is cached against
    // the (post-review-commit) tree and the favorable architect verdict
    // against the unchanged HEAD; only the unfavorable PM review re-runs.
    const second = await runPipeline({ ...config, dag: buildDAG(slices) });
    expect(second.success).toBe(true);
    expect(readFileSync(marker, "utf-8").length).toBe(1);
    expect(architectRuns).toBe(1);
    expect(pmRuns).toBe(2);
    expect(second.consoleSummary).toContain("Architect review: SHIP");
    expect(second.consoleSummary).toContain("PM review: FIX-BEFORE-SHIP");
  }, 120_000);
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
    const block = buildReviewScopeBlock({
      persisted: { mode: "explicit", slices: [{ number: "01", ghIssue: "1" }] },
      selected: [slice("01", "1", "Do the thing", "AFK")],
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

  it("notes when nothing was skipped", () => {
    const block = buildReviewScopeBlock({
      persisted: { mode: "all-afk", slices: [{ number: "01", ghIssue: "1" }] },
      selected: [slice("01", "1", "Everything", "AFK")],
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
  }, 60_000);

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
  }, 60_000);
});


/**
 * Per-slice state persistence (ADR 0018). A slice's terminal outcome
 * must be on disk the moment it lands — for PASS, right after its merge
 * — not when its wave finishes. Observed failure mode this guards: a
 * slice merged mid-wave, the process was hard-killed hours later while
 * its serial lane was still running, and the re-run re-attempted the
 * already-merged slice against its own output.
 */
describe("runPipeline per-slice state persistence", () => {
  it("persists a mid-wave PASS before the lane successor starts; a crash there resumes skipping exactly that slice", async () => {
    const repo = makeRepo();
    const slug = "midwave-persist";
    const { prdDir, specsDir } = writePrdFixture(repo, slug);

    const slices: Slice[] = [
      { number: "01", ghIssue: "7001", title: "First", type: "AFK", blockedBy: [], userStories: "" },
      { number: "02", ghIssue: "7002", title: "Second", type: "AFK", blockedBy: [], userStories: "" },
    ];
    // Shared file → one serial lane → 7002 starts only after 7001 merged.
    const fixtures = new Map<string, SliceFixture>([
      ["7001", { files: ["src/lane.txt"], qaPasses: true, outputFile: "src/lane.txt", outputContent: "first slice content" }],
      ["7002", { files: ["src/lane.txt"], qaPasses: true, outputFile: "src/lane.txt", outputContent: "second slice content" }],
    ]);

    const statePath = join(repo, ".afk", "state", `${slug}-stub.json`);

    // --- Run 1: "crash" while the lane successor is running. ---
    // The wrapped provider snapshots the state file at 7002's
    // lane-refresh explorer (its second explorer invocation — the first
    // ran during parallel Phase A). That snapshot is byte-for-byte the
    // disk state a hard kill at that moment would leave. It then keeps
    // throwing so 7002 cannot complete in this run.
    let snapshot: string | null = null;
    const records1: InvocationRecord[] = [];
    const inner1 = buildStubProvider({ fixtures, slices, records: records1 });
    let explorer7002Count = 0;
    const crashingProvider: AgentProvider = {
      name: "stub",
      async invoke(options: InvokeOptions): Promise<InvokeResult> {
        const slice = sliceFromCwd(options.cwd, slices);
        if (slice?.ghIssue === "7002" && options.role === "explorer") {
          explorer7002Count++;
          if (explorer7002Count >= 2) {
            if (snapshot === null && existsSync(statePath)) {
              snapshot = readFileSync(statePath, "utf-8");
            }
            throw new Error("simulated hard crash");
          }
        }
        return inner1.invoke(options);
      },
    };

    await runPipeline({
      repoRoot: repo,
      prdSlug: slug,
      prdDir,
      specsDir,
      dag: buildDAG(slices),
      provider: crashingProvider,
    });

    // The core guarantee: while the wave was still open, 7001's PASS
    // (with mergedToFeature) was already on disk.
    expect(snapshot).not.toBeNull();
    const midWaveState = JSON.parse(snapshot!);
    expect(midWaveState.slices["7001"]).toMatchObject({
      phase: "PASS",
      mergedToFeature: true,
    });
    expect(midWaveState.slices["7002"]).toBeUndefined();

    // --- Simulate the hard kill: restore the state file to exactly what
    // disk held mid-wave (7001 PASS, 7002 absent). Run 1 exited
    // gracefully and wrote 7002's ERROR; a kill would not have. ---
    writeFileSync(statePath, snapshot!);

    // --- Run 2: everything passes. ---
    const records2: InvocationRecord[] = [];
    const provider2 = buildStubProvider({ fixtures, slices, records: records2 });
    const result = await runPipeline({
      repoRoot: repo,
      prdSlug: slug,
      prdDir,
      specsDir,
      dag: buildDAG(slices),
      provider: provider2,
    });

    expect(result.success).toBe(true);
    // The re-run skipped exactly the already-merged slice — zero agent
    // invocations for 7001 — and ran the crashed slice to completion.
    expect(records2.some((r) => r.ghIssue === "7001")).toBe(false);
    expect(records2.some((r) => r.ghIssue === "7002")).toBe(true);

    const finalState = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(finalState.slices["7001"]).toMatchObject({
      phase: "PASS",
      mergedToFeature: true,
    });
    expect(finalState.slices["7002"]).toMatchObject({
      phase: "PASS",
      mergedToFeature: true,
    });

    // The feature branch ends with the successor's content on top —
    // built on 7001's merge from run 1, which was not re-attempted.
    git(repo, ["checkout", `feat-stub/${slug}`]);
    const lane = readFileSync(join(repo, "src", "lane.txt"), "utf-8");
    expect(lane).toContain("second slice content");
  }, 120_000);
});



/**
 * Configurable wall-clock ceiling (ADR 0019). The 60 min provider
 * default killed a healthy generator mid-slice; generator and
 * evaluator-qa now get a role-aware 120 min default and
 * `--max-agent-duration-ms` overrides every role uniformly. A ceiling
 * kill during slice execution is terminal (no infrastructure retry) and
 * the persisted error points the operator at the remedy.
 */
describe("wall-clock ceiling configuration (ADR 0019)", () => {
  function makeSingleSliceSetup(slug: string, ghIssue: string) {
    const repo = makeRepo();
    const { prdDir, specsDir } = writePrdFixture(repo, slug);
    const slices: Slice[] = [
      {
        number: "01",
        ghIssue,
        title: "Ceiling slice",
        type: "AFK",
        blockedBy: [],
        userStories: "",
      },
    ];
    const fixtures = new Map<string, SliceFixture>([
      [
        ghIssue,
        {
          files: ["src/ceiling.txt"],
          qaPasses: true,
          outputFile: "src/ceiling.txt",
          outputContent: "ceiling",
        },
      ],
    ]);
    const records: InvocationRecord[] = [];
    const baseProvider = buildStubProvider({ fixtures, slices, records });
    return { repo, prdDir, specsDir, slices, baseProvider };
  }

  /** Wrap the stub to record the maxDurationMs each role received. */
  function recordingProvider(
    baseProvider: AgentProvider,
    seen: Map<string, Array<number | undefined>>,
  ): AgentProvider {
    return {
      name: baseProvider.name,
      async invoke(options) {
        const list = seen.get(options.role) ?? [];
        list.push(options.maxDurationMs);
        seen.set(options.role, list);
        return baseProvider.invoke(options);
      },
    };
  }

  it("gives generator and evaluator-qa the slow-agent 120 min ceiling and leaves fast roles on the provider default", async () => {
    const slug = "ceiling-defaults";
    const { repo, prdDir, specsDir, slices, baseProvider } =
      makeSingleSliceSetup(slug, "9301");
    const seen = new Map<string, Array<number | undefined>>();

    const result = await runPipeline({
      repoRoot: repo,
      prdSlug: slug,
      prdDir,
      specsDir,
      dag: buildDAG(slices),
      provider: recordingProvider(baseProvider, seen),
    });

    expect(result.success).toBe(true);
    // Slow roles: measured generator durations on a consuming project
    // ranged ~41–60+ min, so the 60 min provider default sat directly
    // on the real distribution. These two get double the budget.
    expect(seen.get("generator")).toEqual([7_200_000]);
    expect(seen.get("evaluator-qa")).toEqual([7_200_000]);
    // Fast roles pass no override → the provider's 60 min default applies.
    for (const role of ["explorer", "planner", "evaluator-contract"]) {
      expect(seen.get(role), role).toBeDefined();
      for (const value of seen.get(role)!) expect(value, role).toBeUndefined();
    }
  }, 60_000);

  it("applies --max-agent-duration-ms uniformly to every invocation", async () => {
    const slug = "ceiling-override";
    const { repo, prdDir, specsDir, slices, baseProvider } =
      makeSingleSliceSetup(slug, "9302");
    const seen = new Map<string, Array<number | undefined>>();

    const result = await runPipeline({
      repoRoot: repo,
      prdSlug: slug,
      prdDir,
      specsDir,
      dag: buildDAG(slices),
      provider: recordingProvider(baseProvider, seen),
      maxAgentDurationMs: 5_400_000,
    });

    expect(result.success).toBe(true);
    // Every role that ran — slice roles and guardian reviews alike —
    // received the uniform override.
    expect(seen.size).toBeGreaterThanOrEqual(5);
    for (const [role, values] of seen) {
      for (const value of values) expect(value, role).toBe(5_400_000);
    }
    expect(seen.has("generator")).toBe(true);
    expect(seen.has("architect-review")).toBe(true);
  }, 60_000);

  it("treats a generator ceiling kill as terminal — no retry — and records the remedy in the persisted error", async () => {
    const slug = "ceiling-terminal";
    const { repo, prdDir, specsDir, slices, baseProvider } =
      makeSingleSliceSetup(slug, "9303");

    let generatorAttempts = 0;
    const provider: AgentProvider = {
      name: baseProvider.name,
      async invoke(options) {
        if (options.role === "generator") {
          generatorAttempts++;
          throw new Error(
            "Agent generator exceeded 7200s wall-clock ceiling — killed",
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
      dag: buildDAG(slices),
      provider,
      infrastructureRetries: 2,
    });

    expect(result.success).toBe(false);
    // Terminal by design: a retry would restart the round from scratch
    // against the same ceiling. The infrastructure-retries budget must
    // not apply to the generator's ceiling kill.
    expect(generatorAttempts).toBe(1);
    // Persisted state keeps the ERROR distinction and carries the
    // operator-facing remedy; the summary collapses ERROR to STUCK.
    const state = JSON.parse(
      readFileSync(join(repo, ".afk", "state", `${slug}-stub.json`), "utf-8"),
    );
    expect(state.slices["9303"].phase).toBe("ERROR");
    expect(state.slices["9303"].error).toContain("wall-clock ceiling");
    expect(state.slices["9303"].error).toContain("--max-agent-duration-ms");
    expect(result.consoleSummary).toContain("[STUCK]");
  }, 60_000);
});

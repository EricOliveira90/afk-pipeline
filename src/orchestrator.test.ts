import { describe, it, expect, afterEach } from "vitest";
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
  makeAsyncMutex,
  runPipeline,
  runPreShipSanity,
  PipelineError,
} from "./orchestrator.js";
import { buildDAG, parseIssuesMd, type Slice } from "./issues-parser.js";
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
 * Tests for `makeAsyncMutex`. The mutex serialises lane merges across
 * concurrently-running lanes; correctness here pins that contract.
 */
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
 *  - A failure in lane position 1 marks lane position 2 as
 *    LANE-CANCELLED in run-state.
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
 * at `.afk/worktrees/<branch-with-slashes-as-dashes>/`, and the slice
 * branch contains `slice-<number>-<slug>`. Branch names embed the
 * slice *number* (e.g. "01"), but tests use ghIssue == number, so we
 * can look up by branch fragment directly.
 */
function sliceFromCwd(cwd: string, slices: Slice[]): Slice | null {
  const norm = cwd.replace(/\\/g, "/").toLowerCase();
  for (const s of slices) {
    if (norm.includes(`slice-${s.number}-`)) return s;
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
        // Append ACCEPT verdict to existing contract.md.
        const path = join(sliceArtifactDir, "contract.md");
        const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
        writeFileSync(
          path,
          existing + "\n\n**Verdict:** ACCEPT\n",
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

  it("marks the lane successor as LANE-CANCELLED when the predecessor fails", async () => {
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
    expect(state.slices["2001"].status).toBe("STUCK");
    expect(state.slices["2002"].status).toBe("LANE-CANCELLED");
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
    expect(state.slices["3001"].status).toBe("PASS");
    expect(state.slices["3002"].status).toBe("PASS");

    // Phase A invocations should overlap: one slice's planner starts
    // before the other's planner finishes (parallel lane leaders).
    const a = firstTimestamp(records, "3001", "planner");
    const aEnd = lastTimestamp(records, "3001", "planner");
    const b = firstTimestamp(records, "3002", "planner");
    const bEnd = lastTimestamp(records, "3002", "planner");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    // Overlap iff a < bEnd && b < aEnd.
    const overlap = a! < bEnd! && b! < aEnd!;
    expect(overlap).toBe(true);
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

  it("emits a PipelineError carrying the partial summary when an uncaught error fires mid-run", async () => {
    const repo = makeRepo();
    const slug = "summary-throw";
    const { prdDir, specsDir } = writePrdFixture(repo, slug);

    const slices: Slice[] = [
      {
        number: "01",
        ghIssue: "7001",
        title: "Passes then review explodes",
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

    // Wrap the stub so the post-impl architect-review invocation throws.
    // That call is outside the per-slice try/catch — this is exactly the
    // exit path that previously skipped the summary.
    const explodingProvider: AgentProvider = {
      name: baseProvider.name,
      async invoke(options) {
        if (options.role === "architect-review") {
          throw new Error("simulated architect-review failure");
        }
        return baseProvider.invoke(options);
      },
    };

    let caught: unknown;
    try {
      await runPipeline({
        repoRoot: repo,
        prdSlug: slug,
        prdDir,
        specsDir,
        dag,
        provider: explodingProvider,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PipelineError);
    const err = caught as PipelineError;
    expect(err.partialResult.success).toBe(false);
    expect(err.partialResult.consoleSummary).toContain(
      `AFK Pipeline Summary — ${slug}`,
    );
    // The slice itself completed before the review died, so it should
    // appear in the Succeeded group of the partial summary.
    expect(err.partialResult.consoleSummary).toMatch(/Succeeded \(1\)/);
    expect(err.partialResult.consoleSummary).toContain("#7001");
    // The cause is the original error.
    expect(err.cause).toBeInstanceOf(Error);
    expect((err.cause as Error).message).toContain(
      "simulated architect-review failure",
    );
    // The markdown summary file should also have been written despite
    // the throw — same finally-emit semantics.
    const summaryPath = join(repo, ".afk", "logs", `${slug}-stub`, "run-summary.md");
    expect(existsSync(summaryPath)).toBe(true);
  }, 60_000);
});

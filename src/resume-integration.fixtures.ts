/**
 * Shared fixtures for the resume integration suites.
 *
 * The resume tests live in two files — `resume-integration.test.ts`
 * (the two-run retry scenarios, spec #33) and `resume-worktree.test.ts`
 * (`prepareSliceWorktree`) — so one `vitest run` schedules them across
 * both workers (`maxWorkers: 2`); a single file always ran on one. This
 * module is the top-level helper section both halves used to share. Not
 * a test file itself: the `.fixtures.ts` suffix keeps it out of the
 * `src/**\/*.test.ts` include.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Slice } from "./issues-parser.js";
import { writeContractReview } from "./test-support.js";
import type { AgentProvider, InvokeOptions, InvokeResult } from "./agent-provider.js";

const tempDirs: string[] = [];

/**
 * Removes every test-lifetime repo `makeRepo` created since the last
 * call. Each test file registers this in its own `afterEach` — a hook
 * registered here at module scope would depend on vitest's per-file
 * module isolation, which is one refactor away from silently not
 * running.
 */
export function cleanupResumeTempDirs(): void {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

export function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

/**
 * A throwaway git repo. By default the per-test `afterEach` removes it;
 * pass `{ lifetime: "describe" }` when a block spawns its runs once in
 * `beforeAll` and splits the assertions across `it` cases — those cases
 * still need the repo on disk, so the caller owns cleanup in `afterAll`.
 */
export function makeRepo(opts: { lifetime?: "test" | "describe" } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "afk-resume-int-"));
  if (opts.lifetime !== "describe") tempDirs.push(dir);
  git(dir, ["init", "--initial-branch=main"]);
  writeFileSync(join(dir, "README.md"), "test\n", "utf-8");
  // A behavior's gate IDs must name a baseline gate backed by a
  // discovered command, so the fixture repo needs the one sanity script
  // the derived catalog reads (`resolveSanityPlan`). Without it no
  // manifest could bind, and every negotiation here would refuse (#76).
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "resume-fixture",
      private: true,
      scripts: { "test:run": "node -e \"process.exit(0)\"" },
    }),
    "utf-8",
  );
  git(dir, ["add", "README.md", "package.json"]);
  git(dir, ["commit", "-m", "root"]);
  return dir;
}

export function writePrdFixture(repoDir: string, slug: string): { prdDir: string; specsDir: string } {
  const specsDir = join(".kiro", "specs", slug);
  const prdDir = join(repoDir, specsDir);
  mkdirSync(prdDir, { recursive: true });
  writeFileSync(
    join(prdDir, "prd.md"),
    `# ${slug}\n\n## Relevant Files\n- README.md — root readme\n`,
    "utf-8",
  );
  return { prdDir, specsDir };
}

export function makeSlice(): Slice {
  return {
    number: "01",
    ghIssue: "4001",
    title: "Resumable",
    type: "AFK",
    blockedBy: [],
    userStories: "",
  };
}

/** Locate the slice artifact dir inside a worktree (same walk as orchestrator tests). */
export function findSliceArtifactDir(cwd: string, sliceNumber: string): string | null {
  const specsRoot = join(cwd, ".kiro", "specs");
  if (!existsSync(specsRoot)) return null;
  for (const slug of readdirSync(specsRoot)) {
    const slicesDir = join(specsRoot, slug, "slices");
    if (!existsSync(slicesDir)) continue;
    for (const entry of readdirSync(slicesDir)) {
      if (entry.startsWith(`${sliceNumber}-`)) return join(slicesDir, entry);
    }
  }
  return null;
}

/**
 * Slice number the invocation's worktree belongs to — worktrees live at
 * `.afk/worktrees/<prefix>-<slug>-s<NN>` (see `sliceWorktreeDir`). Empty
 * for the post-merge review worktree, which belongs to no slice.
 */
export function sliceNumberFromCwd(cwd: string): string {
  return /-s(\d+)$/.exec(cwd.replace(/\\/g, "/"))?.[1] ?? "";
}

export interface PromptRecord {
  role: string;
  /** Slice the invocation ran for, so merged multi-slice runs stay assertable. */
  sliceNumber: string;
  prompt: string;
  /** Whether run 1's uncommitted casualty file was visible at invocation time. */
  dirtyFilePresent: boolean;
  /** Whether the sibling commit that advanced the feature branch was visible. */
  featureFilePresent: boolean;
  /** Whether BOTH colliding migration files (slice's + feature's) were visible. */
  migrationCollisionPresent: boolean;
  /** Whether the previous run's UNCOMMITTED in-flight edit survived (#49). */
  inFlightPresent: boolean;
  /** Whether the preserved stuck.md diagnosis survived into this run (#49). */
  stuckFilePresent: boolean;
}

/**
 * Stub provider. Explorer/planner/evaluator behave like the standard
 * fixture stub; the generator behavior is injected per run.
 */
export function buildProvider(opts: {
  generator: (
    cwd: string,
    options: InvokeOptions,
    sliceNumber: string,
  ) => Promise<void> | void;
  records?: PromptRecord[];
  /** Deterministic QA verdict for every evaluator-qa invocation. */
  qaVerdict?: "PASS" | "FAIL";
}): AgentProvider {
  return {
    name: "stub",
    async invoke(options: InvokeOptions): Promise<InvokeResult> {
      const { role, cwd } = options;
      const sliceNumber = sliceNumberFromCwd(cwd);
      opts.records?.push({
        role,
        sliceNumber,
        prompt: options.prompt,
        dirtyFilePresent: existsSync(join(cwd, "src", "half-written.ts")),
        featureFilePresent: existsSync(join(cwd, "src", "sibling.ts")),
        migrationCollisionPresent:
          existsSync(join(cwd, "supabase", "migrations", "125_slice_work.sql")) &&
          existsSync(join(cwd, "supabase", "migrations", "125_sibling.sql")),
        inFlightPresent: existsSync(join(cwd, "src", "in-flight.ts")),
        stuckFilePresent: (() => {
          const dir = findSliceArtifactDir(cwd, sliceNumber);
          return dir !== null && existsSync(join(dir, "stuck.md"));
        })(),
      });
      const artifactDir = findSliceArtifactDir(cwd, sliceNumber);
      if (role === "explorer" && artifactDir) {
        writeFileSync(join(artifactDir, "context.md"), "# Context\n", "utf-8");
      } else if (role === "planner" && artifactDir) {
        writeFileSync(
          join(artifactDir, "contract.md"),
          // Per-slice declared file, so a merged multi-slice run gets
          // disjoint lanes and its slices really do overlap.
          `# Slice Contract\n\n**Status:** LOCKED\n\n## Files expected to change\n- src/work-${sliceNumber}.ts\n`,
          "utf-8",
        );
        writeFileSync(
          join(artifactDir, "acceptance-manifest.json"),
          JSON.stringify({
            version: 2,
            fileScope: { kind: "paths", paths: [`src/work-${sliceNumber}.ts`] },
            migrationCount: 0,
            behaviors: [
              {
                id: "B-01",
                source: "resume fixture",
                given: "a resumable slice",
                when: "its contract is negotiated",
                then: "the behavior lock passes",
                observableResult: "the slice reaches its own assertions",
                preservation: false,
                gateIds: ["tests"],
              },
            ],
          }),
          "utf-8",
        );
      } else if (role === "evaluator-contract" && artifactDir) {
        writeFileSync(
          join(artifactDir, "feedback-r1.md"),
          "## Evaluator feedback — round 1\n\nThe contract is testable.\n",
          "utf-8",
        );
        writeContractReview(artifactDir, "ACCEPT");
      } else if (role === "generator") {
        await opts.generator(cwd, options, sliceNumber);
      } else if (role === "evaluator-qa" && artifactDir) {
        writeFileSync(
          join(artifactDir, "qa-report.md"),
          `# QA Report\n\n**Verdict:** ${opts.qaVerdict ?? "PASS"}\n`,
          "utf-8",
        );
      } else if (role === "generator-stuck" && artifactDir) {
        writeFileSync(join(artifactDir, "stuck.md"), "# Stuck\n", "utf-8");
      }
      return { exitCode: 0, stdout: "", stats: {} };
    },
  };
}

/** Concatenated run.log content across every run directory for the slug. */
export function allRunLogs(repo: string, loggerSlug: string): string {
  const logsRoot = join(repo, ".afk", "logs", loggerSlug);
  if (!existsSync(logsRoot)) return "";
  let out = "";
  for (const entry of readdirSync(logsRoot)) {
    const logPath = join(logsRoot, entry, "run.log");
    if (existsSync(logPath)) out += readFileSync(logPath, "utf-8");
  }
  return out;
}

/**
 * The run.log lines belonging to one slice. Every per-slice line carries
 * the slice's tag (`[afk] Slice #<id> (<title>)`), so a merged run stays
 * as assertable as a single-slice one.
 */
export function sliceLogLines(repo: string, loggerSlug: string, ghIssue: string): string {
  return allRunLogs(repo, loggerSlug)
    .split(/\r?\n/)
    .filter((line) => line.includes(`Slice #${ghIssue}`))
    .join("\n");
}

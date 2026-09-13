/**
 * Shared fixtures for the QA orchestration integration suites.
 *
 * The QA tests live in two files — `qa-orchestration.test.ts` (the PRD
 * 070 retry loop and scope amendments) and
 * `qa-orchestration-gates.test.ts` (base gates, candidate evaluator
 * isolation, final evaluation) — so one `vitest run` schedules them
 * across both workers (`maxWorkers: 2`); a single file always ran on
 * one. The split is between `describe` blocks, balanced by measured
 * block time, and this module is the top-level helper section both
 * halves used to share. Not a test file itself: the `.fixtures.ts`
 * suffix keeps it out of the `src/**\/*.test.ts` include.
 *
 * `expect` is imported here, unlike the other `.fixtures.ts` modules,
 * because the gate-ID expectation both halves assert with is one shared
 * helper with one shared rationale; duplicating it per file is how the
 * two copies drift.
 */
import { expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import {
  execFileSync,
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDAG, type Slice } from "./issues-parser.js";
import { lifecycle } from "./slice-lifecycle.js";
import { RunJournal as Logger } from "./run-journal.js";
import type { PipelineConfig, SliceContext } from "./orchestrator.js";
import type { AgentProvider } from "./agent-provider.js";
import { parseGatePolicy } from "./gate-policy.js";
import { rmDirWithRetry } from "./test-support.js";

/**
 * Every directory the fixtures created, plus any a test made itself. Each
 * test file empties it in its own `afterEach` via `cleanupQATempDirs` — a
 * hook registered here at module scope would depend on vitest's per-file
 * module isolation, which is one refactor away from silently not running.
 */
export const dirs: string[] = [];
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
export const GENERATOR_FIXTURE_SCOPE = [
  "README.md",
  "change.txt",
  "provider-output.txt",
];

export const GENERATOR_FIXTURE_CONTRACT = [
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

export function spawnFixtureChild(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): ChildProcess {
  const child = spawn(command, args, options);
  fixtureChildren.add(child);
  child.once("close", () => fixtureChildren.delete(child));
  return child;
}

export async function terminateFixtureChildren(): Promise<void> {
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

/** Removes every directory registered in `dirs` since the last call. */
export function cleanupQATempDirs(): void {
  for (const dir of dirs.splice(0)) {
    rmDirWithRetry(dir);
  }
}

export function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

/**
 * Is every id in `expected` present in `actual`, in that relative order?
 *
 * A subsequence match, not an equality: ids may sit anywhere in `actual` as
 * long as they appear in the given order relative to one another.
 */
export function declaresInOrder(
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
 * The gate-ID expectation every post-QA scenario in both halves shares: the
 * named gates are **present** and in the named **relative order** (#231).
 *
 * Deliberately not exhaustive. These assertions exist to catch a gate that
 * fails to declare itself or declares itself in the wrong position, and
 * containment catches both. Exhaustiveness caught only "a gate was added",
 * which is the intended change of any gate-shipping slice and not a
 * regression — as exact arrays here it turned five assertions red for #86 and
 * #193, forcing an unrelated test file into a slice's `fileScope` both times.
 * No exhaustive gate-ID pin is kept anywhere in these suites for that reason;
 * a gate's own declaration is covered by `src/base-gates.test.ts`.
 */
export function expectDeclaresInOrder(
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
export function expectSomeAttemptDeclaresInOrder(
  attempts: readonly (readonly string[])[],
  expected: readonly string[],
): void {
  expect(
    attempts.some((ids) => declaresInOrder(ids, expected)),
    `expected one attempt to declare gate ids ${JSON.stringify(expected)} in that relative order, got ${JSON.stringify(attempts)}`,
  ).toBe(true);
}

export function makeRepo(): string {
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

export function makeContext(
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

/**
 * Gives a clean-policy scenario the production shape: a locked contract pair
 * on the feature branch and a separate registered slice worktree.
 *
 * The policy is parsed before the candidate can change its worktree, matching
 * the run-scoped snapshot that production carries into the quality stage.
 */
export function makeCleanPolicyWorktree(
  repo: string,
  ctx: SliceContext,
  clean: unknown,
): string {
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "lock the contract pair"]);

  const worktreeParent = mkdtempSync(join(tmpdir(), "afk-qa-070-wt-"));
  dirs.push(worktreeParent);
  const worktree = join(worktreeParent, "wt");
  git(repo, ["worktree", "add", "-b", "slice-01", worktree, "main"]);

  ctx.worktreeDir = worktree;
  ctx.branch = "slice-01";
  ctx.absSliceDir = join(worktree, ctx.relSliceDir);
  ctx.runGatePolicy = parseGatePolicy(
    { version: 1, clean },
    "fixture afk.config.json",
  );

  return worktree;
}

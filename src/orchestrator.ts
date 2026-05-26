import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { type Slice, type DAG } from "./issues-parser.js";
import * as git from "./git.js";
import { kiroProvider } from "./kiro.js";
import type { AgentProvider } from "./agent-provider.js";
import { CancelledError } from "./agent-provider.js";
import * as artifacts from "./artifacts.js";
import { Logger } from "./logger.js";
import { renderPrompt } from "./prompt-template.js";
import { readRelevantFiles, formatRelevantFiles, readSliceFile } from "./prd-reader.js";
import { runWave } from "./wave.js";
import { lifecycle, type SliceIdentity } from "./slice-lifecycle.js";

import {
  loadRunState,
  saveSliceState,
  isSliceComplete,
  projectForPersistence,
} from "./run-state.js";

const MAX_CONTRACT_ROUNDS = 3;
const MAX_GENERATOR_ROUNDS = 3;
const WAVE_TRANSITION_TIMEOUT_MS = 30_000;

/**
 * Idle timeout for generator and evaluator-qa invocations. These two
 * roles routinely shell out to a project's full test suite, which on
 * larger codebases can produce no stdout for several minutes (vitest
 * collecting fixtures, Jest type-checking). The provider default of
 * 180 s is too tight; 600 s avoids killing healthy sessions without
 * sacrificing the wedge-detection role of the floor. See ADR 0008.
 */
const SLOW_AGENT_IDLE_TIMEOUT_MS = 600_000;

/**
 * Pre-ship sanity gate steps, in order. Each step maps to a `package.json`
 * script name and a fallback. Steps whose primary AND fallback are absent
 * from `package.json` are skipped (not failed) — projects that don't have
 * a lint script aren't penalised. Order is intentional: typecheck first
 * because it's the cheapest fast-fail; tests last because they're the
 * slowest.
 */
const SANITY_STEPS: ReadonlyArray<{
  name: string;
  scripts: ReadonlyArray<string>;
}> = [
  { name: "typecheck", scripts: ["typecheck"] },
  { name: "lint", scripts: ["lint"] },
  { name: "tests", scripts: ["test:run", "test"] },
];

function readPackageScripts(cwd: string): Record<string, string> | null {
  try {
    const pkgRaw = readFileSync(join(cwd, "package.json"), "utf-8");
    return (JSON.parse(pkgRaw).scripts ?? {}) as Record<string, string>;
  } catch {
    return null;
  }
}

/**
 * Resolves the consumer project's test command from its `package.json`.
 * Prefers `test:run` (Vitest convention for one-shot, non-watch runs) over
 * `test`. Returns `undefined` if neither exists or `package.json` is
 * missing — callers fall back to a literal `pnpm test` and let the agent
 * report the absence. Shared with the pre-ship sanity gate so the QA
 * evaluator and the gate can't pick different runners.
 */
export function resolveTestCommand(cwd: string): string | undefined {
  const scripts = readPackageScripts(cwd);
  if (!scripts) return undefined;
  const scriptName = ["test:run", "test"].find((s) => scripts[s] != null);
  return scriptName ? `pnpm ${scriptName}` : undefined;
}

/**
 * Pre-ship sanity gate: runs the project's typecheck + lint + tests against
 * the merged feature branch in `cwd`, before opening the PR. This is the
 * same guard a human's pre-push hook would apply — necessary because every
 * AFK commit goes through `git.commitAll` with `--no-verify`, so husky never
 * runs and lint debt would otherwise surface only when a human tries to
 * push. Returns `{ ok, failures }`; `failures` lists step names that tripped.
 *
 * Skips steps whose script isn't defined in `package.json` so projects
 * without a lint script aren't false-failed.
 */
export function runPreShipSanity(cwd: string): {
  ok: boolean;
  failures: string[];
} {
  const scripts = readPackageScripts(cwd);
  if (!scripts) {
    // No package.json (or unreadable) — nothing to gate on.
    return { ok: true, failures: [] };
  }

  const failures: string[] = [];
  for (const step of SANITY_STEPS) {
    const scriptName = step.scripts.find((s) => scripts[s] != null);
    if (!scriptName) continue; // step not defined in this project — skip
    try {
      execFileSync("pnpm", ["run", scriptName], {
        cwd,
        encoding: "utf-8",
        stdio: ["ignore", "inherit", "inherit"],
      });
    } catch {
      failures.push(step.name);
    }
  }
  return { ok: failures.length === 0, failures };
}

/**
 * Verifies that every local migration file has been applied to the linked
 * remote Supabase project. Catches the failure mode where a prior slice's
 * `db:push` recorded a version in `schema_migrations` without actually
 * creating the table (silent prefix collision, aborted push, etc.).
 *
 * Returns `{ ok: true }` if everything is in sync, or `{ ok: false, error }`
 * with a human-readable description of the drift.
 *
 * MUST be run from a cwd where the Supabase CLI is installed and the project
 * is linked (i.e. the main repo root, not a worktree — worktrees don't get
 * `node_modules`, `.env.local`, or `supabase/.temp/linked-project.json`
 * because they're all gitignored).
 */
function verifyMigrationSync(
  cwd: string,
): { ok: true } | { ok: false; error: string } {
  try {
    const output = execFileSync(
      "pnpm",
      ["supabase", "migration", "list", "--linked"],
      { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
    );
    // The CLI prints a markdown-ish table. Rows with a Local value but
    // empty Remote indicate drift. We look for lines of the form:
    //   │ 011   │        │ 011        │
    // Strip ANSI, split lines, parse columns.
    const lines = output
      .replace(/\u001b\[[0-9;]*m/g, "")
      .split(/\r?\n/)
      .filter((l) => /^\s*[│|]/.test(l) && /\d/.test(l));
    const missing: string[] = [];
    for (const line of lines) {
      // Columns separated by │ or | — take first two after leading separator.
      const parts = line
        .split(/[│|]/)
        .map((p) => p.trim())
        .filter((p) => p !== "");
      if (parts.length < 2) continue;
      const [local, remote] = parts;
      if (local && /^\d+/.test(local) && (!remote || remote === "")) {
        missing.push(local);
      }
    }
    if (missing.length > 0) {
      return {
        ok: false,
        error: `Migration drift — local migrations not applied to remote: ${missing.join(", ")}. Re-apply via 'pnpm supabase db query --linked --file <migration>.sql' and verify the expected tables actually exist (pg_tables).`,
      };
    }
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `Could not verify migration sync: ${msg}`,
    };
  }
}

/**
 * Returns true if this slice's branch has any commit that touches files
 * under `supabase/migrations/` compared to the feature branch base.
 * Used to gate the migration drift check: there's no point running the
 * linked-remote check for a slice that didn't change any migrations.
 */
function sliceTouchedMigrations(
  worktreeDir: string,
  featBranch: string,
): boolean {
  try {
    const output = execFileSync(
      "git",
      [
        "diff",
        "--name-only",
        `${featBranch}...HEAD`,
        "--",
        "supabase/migrations/",
      ],
      {
        cwd: worktreeDir,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return output.trim().length > 0;
  } catch {
    // If the diff errors (e.g., feat branch not yet created on first run),
    // be conservative and skip the check rather than false-fail the slice.
    return false;
  }
}

export interface PipelineConfig {
  repoRoot: string;
  prdSlug: string;
  prdDir: string; // absolute path to the PRD folder
  specsDir: string; // e.g. .kiro/specs/<prd-slug>
  dag: DAG;
  dryRun?: boolean;
  /**
   * Agent provider. Drives branch namespacing (via `provider.name`) and
   * the spawn/parse logic for agent invocations. Defaults to the Kiro
   * provider.
   */
  provider?: AgentProvider;
  /**
   * Cancellation signal. When fired (typically from SIGINT), in-flight
   * agent invocations are killed and remaining slices are marked
   * CANCELLED. See ADR 0003.
   */
  signal?: AbortSignal;
}

export interface PipelineResult {
  success: boolean;
  /** Markdown summary written to `.afk/logs/<slug>/run-summary.md`. */
  summary: string;
  /** Grouped, scan-friendly summary for stdout. */
  consoleSummary: string;
}

/**
 * Thrown by `runPipeline` when an exception escapes the per-slice
 * try/catch blocks. Carries the partial `PipelineResult` so the CLI
 * can still emit a summary instead of just `Fatal error: …`.
 */
export class PipelineError extends Error {
  readonly cause: unknown;
  readonly partialResult: PipelineResult;
  constructor(cause: unknown, partialResult: PipelineResult) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "PipelineError";
    this.cause = cause;
    this.partialResult = partialResult;
  }
}

function sliceDir(specsDir: string, slice: Slice): string {
  return join(specsDir, "slices", `${slice.number}-${slugify(slice.title)}`);
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Branch namespacing is keyed off `provider.name` so two providers
 * running on the same PRD don't stomp each other's branches. See
 * ADR 0002.
 *
 * `kiro` keeps the legacy `afk/…` / `feat/…` prefixes for backwards
 * compat; every other provider gets its name appended.
 */
export function sliceBranchPrefix(provider: AgentProvider): string {
  return provider.name === "kiro" ? "afk" : `afk-${provider.name}`;
}

function featureBranchPrefix(provider: AgentProvider): string {
  return provider.name === "kiro" ? "feat" : `feat-${provider.name}`;
}

export function sliceBranch(
  prdSlug: string,
  slice: Slice,
  provider: AgentProvider,
): string {
  return `${sliceBranchPrefix(provider)}/${prdSlug}-slice-${slice.number}-${slugify(slice.title)}`;
}

function featureBranch(prdSlug: string, provider: AgentProvider): string {
  return `${featureBranchPrefix(provider)}/${prdSlug}`;
}

export function isCancelled(err: unknown, signal?: AbortSignal): boolean {
  return err instanceof CancelledError || signal?.aborted === true;
}

/**
 * Single-process async mutex. Returns a `withLock` function that
 * serialises every async caller against a shared promise chain. Used
 * to serialise lane merges + worktree cleanup against the shared
 * feature-branch checkout — concurrent `git merge` invocations on the
 * same checkout would race on `.git/index.lock`. Exported for unit
 * testing.
 */
export function makeAsyncMutex() {
  let chain: Promise<unknown> = Promise.resolve();
  return async function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = chain.then(fn, fn);
    // Swallow rejections on the chain so a thrown lock body doesn't
    // poison the next acquirer; the current caller still sees the
    // throw via its own `next`.
    chain = next.catch(() => undefined);
    return next;
  };
}

/**
 * Per-slice closure passed between Phase A (negotiate) and Phase B
 * (execute). Holds the worktree paths, branch name, slice-scoped
 * `invoke` (auto-tags stats with the slice's ghIssue), and rendered
 * prompt fragments — everything either phase needs from `runPipeline`'s
 * scope.
 *
 * `makeSliceContext` is pure: it derives paths and rendering helpers
 * from `PipelineConfig` + the slice. Worktree creation and artifact-dir
 * mkdir happen inside `runSliceNegotiate` so the context can be reused
 * after `recreateWorktreeFromBase` (lane-successor refresh).
 */
export interface SliceContext {
  config: PipelineConfig;
  slice: Slice;
  logger: Logger;
  featBranch: string;
  relevantFilesBlock: string;
  branch: string;
  worktreeDir: string;
  absSliceDir: string;
  relSliceDir: string;
  relSpecsDir: string;
  tag: string;
  /**
   * Test command discovered from the consumer's `package.json` (e.g.
   * `pnpm test:run` or `pnpm test`). Falls back to `pnpm test` when no
   * test script is defined. Injected into generator + evaluator-qa
   * prompts so they don't hardcode a runner-specific flag.
   */
  testCommand: string;
  invoke: (
    opts: Parameters<AgentProvider["invoke"]>[0],
  ) => ReturnType<AgentProvider["invoke"]>;
}

export function makeSliceContext(
  config: PipelineConfig,
  slice: Slice,
  logger: Logger,
  featBranch: string,
  relevantFilesBlock: string,
  testCommand: string,
): SliceContext {
  const { repoRoot, prdSlug, specsDir, signal } = config;
  const provider = config.provider ?? kiroProvider;
  const branch = sliceBranch(prdSlug, slice, provider);
  // Short worktree dir name to stay under Windows' 260-char MAX_PATH.
  // The full title remains in the branch name (visible in PRs and git
  // log) — the dir just needs to be unique per slice within the run.
  const worktreeDir = join(
    repoRoot,
    ".afk",
    "worktrees",
    `${sliceBranchPrefix(provider)}-${prdSlug}-s${slice.number}`,
  );
  const relSliceDir = join(
    specsDir,
    "slices",
    `${slice.number}-${slugify(slice.title)}`,
  ).replace(/\\/g, "/");
  const absSliceDir = join(worktreeDir, relSliceDir);
  const relSpecsDir = specsDir.replace(/\\/g, "/");
  const tag = `[afk] Slice #${slice.ghIssue} (${slice.title})`;

  const invoke = async (opts: Parameters<AgentProvider["invoke"]>[0]) => {
    const result = await provider.invoke({
      ...opts,
      signal,
      onIdleWarning: (minutes) => {
        if (opts.logStream) {
          logger.writeIdleWarning(opts.logStream, opts.role, minutes);
        }
      },
    });
    logger.addInvocationStats(slice.ghIssue, result.stats);
    return result;
  };

  return {
    config,
    slice,
    logger,
    featBranch,
    relevantFilesBlock,
    branch,
    worktreeDir,
    absSliceDir,
    relSliceDir,
    relSpecsDir,
    tag,
    testCommand,
    invoke,
  };
}

/**
 * Phase A — explorer + planner ↔ evaluator-contract. Writes
 * `contract.md`. Boundary: ends at the contract-LOCKED check.
 *
 * Outcome semantics:
 * - `LOCKED` — contract is ready for Phase B.
 * - `ESCALATE` — contract negotiation gave up after max rounds.
 * - `STUCK` — negotiation finished without LOCKED status.
 * - `ERROR` / `CANCELLED` — exception or external abort.
 */
export async function runSliceNegotiate(
  ctx: SliceContext,
): Promise<"LOCKED" | "STUCK" | "ESCALATE" | "ERROR" | "CANCELLED"> {
  const { config, slice, logger, featBranch, relevantFilesBlock, invoke } = ctx;
  const { repoRoot, prdDir, signal } = config;

  logger.transitionTo(
    slice.ghIssue,
    lifecycle.running(
      { ghIssue: slice.ghIssue, title: slice.title, branch: ctx.branch },
      logger.getSliceProgress(slice.ghIssue),
    ),
  );

  try {
    git.createWorktree(repoRoot, ctx.branch, ctx.worktreeDir, featBranch);
    mkdirSync(ctx.absSliceDir, { recursive: true });

    // --- Step 1: Explorer ---
    const contextPath = join(ctx.absSliceDir, "context.md");
    if (!existsSync(contextPath)) {
      const localSliceContent = readSliceFile(prdDir, slice.number);
      const sliceBodyNote = localSliceContent
        ? `The slice issue body is provided below (no need to fetch from GH):\n\n---\n${localSliceContent}\n---`
        : `Fetch the issue body with: gh issue view ${slice.ghIssue}`;

      console.error(`${ctx.tag}: exploring...`);
      const logStream = logger.agentLog(slice.number, "explorer");
      await invoke({
        role: "explorer",
        prompt: renderPrompt("explorer", {
          GH_ISSUE: slice.ghIssue,
          TITLE: slice.title,
          SLICE_DIR: ctx.relSliceDir,
          RELEVANT_FILES: relevantFilesBlock,
          SLICE_BODY: sliceBodyNote,
        }),
        cwd: ctx.worktreeDir,
        logStream,
      });
      logStream.end();
    }

    // --- Step 2: Planner (contract negotiation) ---
    const contractPath = join(ctx.absSliceDir, "contract.md");
    let contractStatus = artifacts.readContractStatus(contractPath);

    if (contractStatus !== "LOCKED") {
      for (let round = 1; round <= MAX_CONTRACT_ROUNDS; round++) {
        console.error(
          `${ctx.tag}: planning (round ${round}/${MAX_CONTRACT_ROUNDS})...`,
        );
        const plannerLog = logger.agentLog(slice.number, "planner", round);
        await invoke({
          role: "planner",
          prompt: renderPrompt("planner", {
            GH_ISSUE: slice.ghIssue,
            SPECS_DIR: ctx.relSpecsDir,
            SLICE_DIR: ctx.relSliceDir,
            ROUND: round,
            RELEVANT_FILES: relevantFilesBlock,
            REVISION_NOTE:
              round > 1
                ? `Revise based on evaluator feedback in ${ctx.relSliceDir}/contract.md.`
                : "",
          }),
          cwd: ctx.worktreeDir,
          logStream: plannerLog,
        });
        plannerLog.end();

        console.error(
          `${ctx.tag}: evaluating contract (round ${round}/${MAX_CONTRACT_ROUNDS})...`,
        );
        const evalLog = logger.agentLog(
          slice.number,
          "evaluator-contract",
          round,
        );
        await invoke({
          role: "evaluator-contract",
          prompt: renderPrompt("evaluator-contract", {
            SPECS_DIR: ctx.relSpecsDir,
            SLICE_DIR: ctx.relSliceDir,
            ROUND: round,
            RELEVANT_FILES: relevantFilesBlock,
          }),
          cwd: ctx.worktreeDir,
          logStream: evalLog,
        });
        evalLog.end();

        const verdict = artifacts.readEvaluatorVerdict(contractPath);
        if (verdict === "ACCEPT") {
          artifacts.lockContract(contractPath);
          contractStatus = "LOCKED";
          break;
        }
        contractStatus = artifacts.readContractStatus(contractPath);
        if (contractStatus === "LOCKED") break;
        if (verdict === "ESCALATE" || round === MAX_CONTRACT_ROUNDS) {
          console.error(`${ctx.tag}: ESCALATE — contract negotiation failed`);
          logger.bumpEvalRound(slice.ghIssue, round);
          logger.markEscalated(
            slice.ghIssue,
            "Contract negotiation escalated after max rounds",
          );
          return "ESCALATE";
        }
      }
    }

    contractStatus = artifacts.readContractStatus(contractPath);
    if (contractStatus !== "LOCKED") {
      logger.markStuck(slice.ghIssue, "Contract not locked after negotiation");
      return "STUCK";
    }
    return "LOCKED";
  } catch (err) {
    if (isCancelled(err, signal)) {
      logger.markCancelled(slice.ghIssue, "Cancelled by user");
      return "CANCELLED";
    }
    logger.markError(
      slice.ghIssue,
      err instanceof Error ? err.message : String(err),
    );
    return "ERROR";
  }
}

/**
 * Phase B — generator ↔ evaluator-qa + commit. Boundary: starts at the
 * generator loop. Does **not** merge the slice branch into the feature
 * branch — that's the orchestrator's job, under a mutex.
 */
export async function runSliceExecute(
  ctx: SliceContext,
): Promise<"PASS" | "STUCK" | "ERROR" | "CANCELLED"> {
  const { config, slice, logger, featBranch, relevantFilesBlock, invoke } = ctx;
  const { repoRoot, signal } = config;

  try {
    const qaPath = join(ctx.absSliceDir, "qa-report.md");

    for (let round = 1; round <= MAX_GENERATOR_ROUNDS; round++) {
      logger.bumpGenRound(slice.ghIssue, round);

      console.error(
        `${ctx.tag}: implementing (round ${round}/${MAX_GENERATOR_ROUNDS})...`,
      );
      const genLog = logger.agentLog(slice.number, "generator", round);
      await invoke({
        role: "generator",
        prompt: renderPrompt("generator", {
          SLICE_DIR: ctx.relSliceDir,
          RELEVANT_FILES: relevantFilesBlock,
          TEST_COMMAND: ctx.testCommand,
          RETRY_NOTE:
            round > 1
              ? `This is retry round ${round}. Read ${ctx.relSliceDir}/qa-report.md for findings to fix.`
              : "",
        }),
        cwd: ctx.worktreeDir,
        logStream: genLog,
        idleTimeoutMs: SLOW_AGENT_IDLE_TIMEOUT_MS,
      });
      genLog.end();

      console.error(
        `${ctx.tag}: evaluating QA (round ${round}/${MAX_GENERATOR_ROUNDS})...`,
      );
      const evalLog = logger.agentLog(slice.number, "evaluator-qa", round);
      await invoke({
        role: "evaluator-qa",
        prompt: renderPrompt("evaluator-qa", {
          SLICE_DIR: ctx.relSliceDir,
          RELEVANT_FILES: relevantFilesBlock,
          TEST_COMMAND: ctx.testCommand,
        }),
        cwd: ctx.worktreeDir,
        logStream: evalLog,
        idleTimeoutMs: SLOW_AGENT_IDLE_TIMEOUT_MS,
      });
      evalLog.end();

      logger.bumpEvalRound(slice.ghIssue, round);

      const qaVerdict = artifacts.readQAVerdict(qaPath);
      if (qaVerdict === "PASS") {
        // Commit FIRST — drift / post-hooks should not discard code that
        // already passed QA. The commit is preserved on the slice branch
        // either way.
        if (git.hasUncommittedChanges(ctx.worktreeDir)) {
          git.commitAll(
            ctx.worktreeDir,
            `feat(#${slice.ghIssue}): ${slice.title}`,
          );
        }

        const touchedMigrations = sliceTouchedMigrations(
          ctx.worktreeDir,
          featBranch,
        );
        if (touchedMigrations) {
          const migrationCheck = verifyMigrationSync(repoRoot);
          if (!migrationCheck.ok) {
            logger.markStuck(
              slice.ghIssue,
              `Migration sync check failed: ${migrationCheck.error}`,
            );
            return "STUCK";
          }
        }

        console.error(`${ctx.tag}: tests pass — committed`);
        logger.transitionTo(
          slice.ghIssue,
          lifecycle.pass(
            { ghIssue: slice.ghIssue, title: slice.title, branch: ctx.branch },
            logger.getSliceProgress(slice.ghIssue),
            false,
          ),
        );
        return "PASS";
      }

      if (round === MAX_GENERATOR_ROUNDS) {
        console.error(`${ctx.tag}: stuck — running fallback generator...`);
        const stuckLog = logger.agentLog(slice.number, "generator-stuck");
        await invoke({
          role: "generator-stuck",
          prompt: renderPrompt("generator-stuck", { SLICE_DIR: ctx.relSliceDir }),
          cwd: ctx.worktreeDir,
          logStream: stuckLog,
        });
        stuckLog.end();

        console.error(
          `${ctx.tag}: STUCK — QA failed after ${MAX_GENERATOR_ROUNDS} rounds`,
        );
        logger.markStuck(
          slice.ghIssue,
          `QA failed after ${MAX_GENERATOR_ROUNDS} rounds`,
        );
        return "STUCK";
      }
    }

    return "STUCK"; // Should not reach here
  } catch (err) {
    if (isCancelled(err, signal)) {
      logger.markCancelled(slice.ghIssue, "Cancelled by user");
      return "CANCELLED";
    }
    logger.markError(
      slice.ghIssue,
      err instanceof Error ? err.message : String(err),
    );
    return "ERROR";
  }
}

/**
 * Legacy single-call wrapper: negotiate → execute. Kept for callers
 * (and tests) that don't need the lane-aware split. The new wave loop
 * uses `runSliceNegotiate` + `runSliceExecute` directly so the
 * file-overlap partitioner can read each slice's contract between
 * phases.
 */
async function runSlice(
  config: PipelineConfig,
  slice: Slice,
  logger: Logger,
  featBranch: string,
  relevantFilesBlock: string,
  testCommand: string,
): Promise<"PASS" | "STUCK" | "ESCALATE" | "ERROR" | "CANCELLED"> {
  const ctx = makeSliceContext(
    config,
    slice,
    logger,
    featBranch,
    relevantFilesBlock,
    testCommand,
  );
  const negotiate = await runSliceNegotiate(ctx);
  if (negotiate !== "LOCKED") return negotiate;
  return runSliceExecute(ctx);
}

/** Main pipeline: process all slices respecting the DAG, then run reviews. */
export async function runPipeline(
  config: PipelineConfig,
): Promise<PipelineResult> {
  const { repoRoot, prdSlug, prdDir, specsDir, dag, signal } = config;
  const provider = config.provider ?? kiroProvider;
  const loggerSlug =
    provider.name === "kiro" ? prdSlug : `${prdSlug}-${provider.name}`;
  const logger = new Logger(repoRoot, loggerSlug);
  const invoke = (opts: Parameters<AgentProvider["invoke"]>[0]) =>
    provider.invoke({
      ...opts,
      signal,
      onIdleWarning: (minutes) => {
        if (opts.logStream) {
          logger.writeIdleWarning(opts.logStream, opts.role, minutes);
        }
      },
    });
  const featBranch = featureBranch(prdSlug, provider);
  logger.setFeatureBranch(featBranch);
  const relevantFilesBlock = formatRelevantFiles(readRelevantFiles(prdDir));
  // Resolve the consumer project's test command once per run. Falls back
  // to `pnpm test` when no test script is defined — matches the pre-ship
  // gate's forgiving stance.
  const testCommand = resolveTestCommand(repoRoot) ?? "pnpm test";

  try {
  // Detect the repo's default branch (main / master / etc.) once so
  // every base reference below — feat-branch init, review-worktree
  // creation, gh pr base — agrees on the same target.
  const defaultBranch = git.getDefaultBranch(repoRoot);

  // Initialize feature branch. Prefer `prd/<slug>` as the base if it
  // exists — that branch holds the human-authored `prd.md` + `issues.md`
  // that the planner/generator agents read from the worktree. If we
  // initialize from the default branch, worktrees won't have those files
  // and the planner will operate blind. Falls back to the default branch
  // when no PRD branch is present (e.g., PRD inlined directly on it).
  const prdBranch = `prd/${prdSlug}`;
  const baseBranch = git.branchExists(repoRoot, prdBranch)
    ? prdBranch
    : defaultBranch;
  git.createBranch(repoRoot, featBranch, baseBranch);

  // Mark HITL slices as skipped
  for (const [id, slice] of dag.slices) {
    if (slice.type === "HITL") {
      logger.transitionTo(
        id,
        lifecycle.skipped({ ghIssue: id, title: slice.title, branch: "—" }),
      );
    }
  }

  // --- DAG-driven execution ---
  const completed = new Set<string>();
  const failed = new Set<string>();
  // Slices deferred this run by lane-cancel (their lane predecessor
  // failed). They keep their `LANE-CANCELLED` state and remain
  // eligible on the *next* pipeline invocation, but we don't retry
  // them in the current run — that's the whole point of the status:
  // human resolution of the predecessor first.
  const laneCancelled = new Set<string>();

  // Load persistent run state for resumability
  const runState = loadRunState(repoRoot, loggerSlug);
  runState.featureBranch = featBranch;

  // Restore completed slices from persistent state
  for (const [id, slice] of dag.slices) {
    if (isSliceComplete(runState, id)) {
      completed.add(id);
      const branch =
        runState.slices[id]!.branch ?? sliceBranch(prdSlug, slice, provider);
      logger.transitionTo(
        id,
        lifecycle.pass(
          { ghIssue: id, title: slice.title, branch },
          { genRounds: 0, evalRounds: 0 },
          true,
        ),
      );
      console.log(`  Skipping #${id} ${slice.title} (already completed)`);
    }
  }

  // Process DAG level by level.
  //
  // Within a wave, ready siblings can touch the same files even when
  // the DAG declares no dependency between them (file-level coupling
  // is implicit). Running them all in parallel from the same stale
  // base produces silent semantic duplicates after merge. Solution:
  //
  //   1. Phase A in parallel — each slice negotiates its contract.
  //   2. Read each contract's "Files expected to change" list.
  //   3. Partition the wave into **lanes** (union-find on the shared-
  //      file graph). Lanes run in parallel; within a lane, slices
  //      execute serially with predecessor merges visible to the
  //      successor's negotiate phase. See ADR 0005.
  //
  // Only `completed` unblocks dependents — a failed slice must hold
  // its dependents so they don't run against a missing foundation.
  // Slices whose blocker is in `failed` will simply never become
  // ready and the loop will exit once no toRun remain.
  const mergeMutex = makeAsyncMutex();
  let waveNumber = 0;
  while (true) {
    waveNumber++;

    // Wave-transition watchdog: race the readiness check against a
    // timeout. If the event loop is blocked (dangling promise,
    // unresolved stream), the timeout rejects and we crash with
    // diagnostics.
    const readyResult = await Promise.race([
      Promise.resolve().then(() => {
        const ready = dag.ready(completed);
        return ready.filter(
          (id) => !failed.has(id) && !laneCancelled.has(id),
        );
      }),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(
            `[afk] Pipeline hung before wave ${waveNumber} started (>${WAVE_TRANSITION_TIMEOUT_MS / 1000}s).\n` +
            `Completed: [${[...completed].join(", ")}]\n` +
            `Failed: [${[...failed].join(", ")}]\n`
          ));
        }, WAVE_TRANSITION_TIMEOUT_MS);
        timer.unref();
      }),
    ]);

    const toRun = readyResult;
    if (toRun.length === 0) break;

    // Run the wave: Phase A (negotiate) → lane partition → Phase B
    // (execute + merge). Returns per-slice outcomes for persistence.
    const { outcomes } = await runWave({
      waveNumber,
      readyIds: toRun,
      config,
      dag,
      logger,
      featBranch,
      relevantFilesBlock,
      testCommand,
      mergeMutex,
    });

    // --- Persist results from this wave. ---
    for (const [id, outcome] of outcomes) {
      const slice = dag.slices.get(id)!;
      const branch = sliceBranch(prdSlug, slice, provider);
      const sliceId: SliceIdentity = {
        ghIssue: id,
        title: slice.title,
        branch,
      };
      const progress = logger.getSliceProgress(id);

      if (outcome.phase === "PASS") {
        const passed = lifecycle.pass(sliceId, progress, true);
        logger.transitionTo(id, passed);
        saveSliceState(repoRoot, loggerSlug, id, projectForPersistence(passed)!);
        completed.add(id);
        continue;
      }

      // All non-PASS outcomes carry an error message from wave.ts.
      const failedLifecycle =
        outcome.phase === "LANE-CANCELLED"
          ? lifecycle.laneCancelled(sliceId, progress, outcome.error)
          : outcome.phase === "CANCELLED"
            ? lifecycle.cancelled(sliceId, progress, outcome.error)
            : outcome.phase === "CONFLICT"
              ? lifecycle.conflict(sliceId, progress, outcome.error)
              : outcome.phase === "ESCALATE"
                ? lifecycle.escalate(sliceId, progress, outcome.error)
                : outcome.phase === "ERROR"
                  ? lifecycle.error(sliceId, progress, outcome.error)
                  : lifecycle.stuck(sliceId, progress, outcome.error);

      logger.transitionTo(id, failedLifecycle);
      saveSliceState(
        repoRoot,
        loggerSlug,
        id,
        projectForPersistence(failedLifecycle)!,
      );
      if (outcome.phase === "LANE-CANCELLED") {
        laneCancelled.add(id);
      } else {
        failed.add(id);
      }
    }

    // If cancelled, mark anything not yet completed/failed as CANCELLED
    // and exit the wave loop. Worktrees are preserved on disk so a
    // re-run resumes from the artifact state. See ADR 0003.
    if (signal?.aborted) {
      for (const [id, slice] of dag.slices) {
        if (slice.type === "HITL") continue;
        if (completed.has(id) || failed.has(id)) continue;
        const branch = sliceBranch(prdSlug, slice, provider);
        const cancelled = lifecycle.cancelled(
          { ghIssue: id, title: slice.title, branch },
          logger.getSliceProgress(id),
          "Cancelled by user",
        );
        logger.transitionTo(id, cancelled);
        saveSliceState(
          repoRoot,
          loggerSlug,
          id,
          projectForPersistence(cancelled)!,
        );
        failed.add(id);
      }
      break;
    }

    // If no progress was made this round, we're stuck.
    const newReady = dag.ready(completed);
    const newToRun = newReady.filter(
      (id) => !failed.has(id) && !laneCancelled.has(id),
    );
    if (newToRun.length === 0) break;
  }

  // --- Post-implementation reviews (only if all AFK slices passed) ---
  const afkSlices = [...dag.slices.values()].filter((s) => s.type === "AFK");
  const allPassed = afkSlices.every((s) => completed.has(s.ghIssue));

  if (allPassed && afkSlices.length > 0 && !signal?.aborted) {
    // Reviews need a worktree on the feature branch. Prefer an existing
    // checkout (commonly the main repo) — `git worktree add` refuses to
    // check out the same branch twice. Fall back to a scratch worktree
    // only when the feature branch isn't checked out anywhere. Same
    // pattern as mergeSliceBranch.
    const existingFeatWorktree = git.findWorktreeForBranch(
      repoRoot,
      featBranch,
    );
    let reviewDir: string;
    let cleanupReviewDir = false;
    if (existingFeatWorktree) {
      reviewDir = existingFeatWorktree;
    } else {
      reviewDir = join(
        repoRoot,
        ".afk",
        "worktrees",
        `${featBranch.replace(/\//g, "-")}-review`,
      );
      git.createWorktree(repoRoot, featBranch, reviewDir, defaultBranch);
      cleanupReviewDir = true;
    }

    try {
      // Relative specs path for prompts
      const relSpecsDir = specsDir.replace(/\\/g, "/");

      // --- Pre-ship sanity gate ---
      // Runs the project's typecheck + lint + tests against the merged
      // feature branch before any guardian review or PR creation. This is
      // the guard the human's pre-push hook would apply — necessary
      // because AFK commits use --no-verify (see git.commitAll), so husky
      // is bypassed throughout the run. Failing here skips the guardian
      // reviews and the PR: there's no point asking architect/PM to grade
      // code that won't pass the basic quality gate.
      console.log("Running pre-ship sanity gate...");
      const sanity = runPreShipSanity(reviewDir);
      logger.setSanityGate(sanity);
      if (!sanity.ok) {
        console.error(
          `  ❌ Pre-ship sanity gate failed: ${sanity.failures.join(", ")}. Skipping guardian reviews and PR creation.`,
        );
      } else {
        console.log("  ✅ Pre-ship sanity gate passed.");

        const runArchitectReview = async (): Promise<artifacts.ReviewVerdict> => {
          const log = logger.agentLog("all", "architect-review");
          try {
            await invoke({
              role: "architect-review",
              agent: "architect-review",
              // Bare mode: third-party Claude Code plugins (e.g.
              // `superpowers:using-superpowers`) install
              // `SessionStart` hooks that demand the agent invoke a
              // skill before responding. Guardian agents have no
              // skills loaded, so the hook coerces them into emitting
              // a fake `<tool_use>` block as plain text and ending
              // the turn — no review file is ever written. `--bare`
              // strips plugin hooks for this invocation only. See
              // ADR 0011.
              bare: true,
              prompt: renderPrompt("architect-review", { SPECS_DIR: relSpecsDir, RELEVANT_FILES: relevantFilesBlock }),
              cwd: reviewDir,
              logStream: log,
            });
          } finally {
            await new Promise<void>((res) => log.end(() => res()));
          }
          const path = join(reviewDir, specsDir, "review-architect.md");
          const verdict = artifacts.readReviewVerdict(path);
          if (verdict === "UNKNOWN") {
            console.warn(
              `  ⚠️  Could not parse architect review verdict from ${path} — expected a "**Verdict:** SHIP | ACCEPT-WITH-NOTES | FIX-BEFORE-SHIP" line. Treating as UNKNOWN (no PR will be opened).`,
            );
          }
          return verdict;
        };

        const runPmReview = async (): Promise<artifacts.ReviewVerdict> => {
          const log = logger.agentLog("all", "pm-review");
          try {
            await invoke({
              role: "pm-review",
              agent: "pm-review",
              // See architect-review above — same plugin-hook
              // hijack defense.
              bare: true,
              prompt: renderPrompt("pm-review", { SPECS_DIR: relSpecsDir, RELEVANT_FILES: relevantFilesBlock }),
              cwd: reviewDir,
              logStream: log,
            });
          } finally {
            await new Promise<void>((res) => log.end(() => res()));
          }
          const path = join(reviewDir, specsDir, "review-pm.md");
          const verdict = artifacts.readReviewVerdict(path);
          if (verdict === "UNKNOWN") {
            console.warn(
              `  ⚠️  Could not parse PM review verdict from ${path} — expected a "**Verdict:** SHIP | ACCEPT-WITH-NOTES | FIX-BEFORE-SHIP" line. Treating as UNKNOWN (no PR will be opened).`,
            );
          }
          return verdict;
        };

        const [archSettled, pmSettled] = await Promise.allSettled([
          runArchitectReview(),
          runPmReview(),
        ]);

        const archVerdict: artifacts.ReviewVerdict =
          archSettled.status === "fulfilled" ? archSettled.value : "UNKNOWN";
        const pmVerdict: artifacts.ReviewVerdict =
          pmSettled.status === "fulfilled" ? pmSettled.value : "UNKNOWN";

        if (archSettled.status === "rejected") {
          console.warn(
            `  ⚠️  Architect review failed: ${archSettled.reason instanceof Error ? archSettled.reason.message : String(archSettled.reason)}. Treating as UNKNOWN (no PR will be opened).`,
          );
        }
        if (pmSettled.status === "rejected") {
          console.warn(
            `  ⚠️  PM review failed: ${pmSettled.reason instanceof Error ? pmSettled.reason.message : String(pmSettled.reason)}. Treating as UNKNOWN (no PR will be opened).`,
          );
        }

        logger.setReviewVerdicts(archVerdict, pmVerdict);

        // Create draft PR if both reviews pass
        const shipVerdicts = ["SHIP", "ACCEPT-WITH-NOTES"];
        if (
          shipVerdicts.includes(archVerdict) &&
          shipVerdicts.includes(pmVerdict)
        ) {
          try {
            // First: commit the review files from the review worktree
            // to the feature branch. Without this step the reviews are
            // written to the worktree and then deleted on cleanup —
            // the feature branch never sees them, which breaks the
            // shipping.md pre-merge checklist.
            if (git.hasUncommittedChanges(reviewDir)) {
              git.commitAll(
                reviewDir,
                `docs(${prdSlug}): add post-impl guardian reviews`,
              );
            }
            // Push the feature branch (includes the review commit)
            execFileSync("git", ["push", "-u", "origin", featBranch], {
              cwd: repoRoot,
              encoding: "utf-8",
            });
            // Create draft PR
            const prUrl = execFileSync(
              "gh",
              [
                "pr",
                "create",
                "--draft",
                "--base",
                defaultBranch,
                "--head",
                featBranch,
                "--title",
                `feat: ${prdSlug}`,
                "--body",
                `Automated implementation of ${prdSlug}.\n\nSee ${specsDir}/ for artifacts (including review-architect.md and review-pm.md).`,
              ],
              { cwd: repoRoot, encoding: "utf-8" },
            ).trim();
            logger.setPrUrl(prUrl);
          } catch {
            // PR creation is best-effort
          }
        }
      }
    } finally {
      if (cleanupReviewDir) {
        git.removeWorktree(repoRoot, reviewDir);
      }
    }
  }

    const summary = logger.writeSummary();
    const consoleSummary = logger.formatConsoleSummary();
    const allSuccess = afkSlices.every((s) => completed.has(s.ghIssue));

    return { success: allSuccess, summary, consoleSummary };
  } catch (err) {
    // Mark any slice still in flight as STUCK so the summary doesn't
    // misreport them as RUNNING/PENDING. Status keys we touch here
    // are the only mutation; persistent run-state already reflects
    // whatever progress slice loops were able to record.
    for (const [id, slice] of dag.slices) {
      if (slice.type === "HITL") continue;
      const cur = logger.getSlice(id);
      if (!cur) {
        logger.transitionTo(
          id,
          lifecycle.stuck(
            { ghIssue: id, title: slice.title, branch: "" },
            { genRounds: 0, evalRounds: 0 },
            "Pipeline aborted before slice finished",
          ),
        );
      } else if (cur.phase === "RUNNING" || cur.phase === "PENDING") {
        logger.markStuck(id, "Pipeline aborted before slice finished");
      }
    }
    let summary = "";
    try {
      summary = logger.writeSummary();
    } catch {
      // best effort — never let summary writing eat the original error
    }
    const consoleSummary = logger.formatConsoleSummary();
    const partial: PipelineResult = {
      success: false,
      summary,
      consoleSummary,
    };
    throw new PipelineError(err, partial);
  }
}

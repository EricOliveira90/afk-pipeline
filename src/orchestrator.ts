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

import { loadRunState, saveSliceState, isSliceComplete } from "./run-state.js";

const MAX_CONTRACT_ROUNDS = 3;
const MAX_GENERATOR_ROUNDS = 3;

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
  let scripts: Record<string, string> = {};
  try {
    const pkgRaw = readFileSync(join(cwd, "package.json"), "utf-8");
    scripts = (JSON.parse(pkgRaw).scripts ?? {}) as Record<string, string>;
  } catch {
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
  summary: string;
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
function sliceBranchPrefix(provider: AgentProvider): string {
  return provider.name === "kiro" ? "afk" : `afk-${provider.name}`;
}

function featureBranchPrefix(provider: AgentProvider): string {
  return provider.name === "kiro" ? "feat" : `feat-${provider.name}`;
}

function sliceBranch(
  prdSlug: string,
  slice: Slice,
  provider: AgentProvider,
): string {
  return `${sliceBranchPrefix(provider)}/${prdSlug}-slice-${slice.number}-${slugify(slice.title)}`;
}

function featureBranch(prdSlug: string, provider: AgentProvider): string {
  return `${featureBranchPrefix(provider)}/${prdSlug}`;
}

function isCancelled(err: unknown, signal?: AbortSignal): boolean {
  return err instanceof CancelledError || signal?.aborted === true;
}

/** Run the full per-slice pipeline in a worktree. */
async function runSlice(
  config: PipelineConfig,
  slice: Slice,
  logger: Logger,
  featBranch: string,
): Promise<"PASS" | "STUCK" | "ESCALATE" | "ERROR" | "CANCELLED"> {
  const { repoRoot, prdSlug, specsDir, signal } = config;
  const provider = config.provider ?? kiroProvider;
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
  const branch = sliceBranch(prdSlug, slice, provider);
  const worktreeDir = join(
    repoRoot,
    ".afk",
    "worktrees",
    branch.replace(/\//g, "-"),
  );

  // Relative path from repo root to the slice artifact directory.
  // This is what agents see (their cwd is the worktree root).
  const relSliceDir = join(
    specsDir,
    "slices",
    `${slice.number}-${slugify(slice.title)}`,
  ).replace(/\\/g, "/");
  // Absolute path inside the worktree (for artifact parsing on the host).
  const absSliceDir = join(worktreeDir, relSliceDir);
  // Relative path to the specs dir (for PRD reference).
  const relSpecsDir = specsDir.replace(/\\/g, "/");

  logger.setSliceStatus(slice.ghIssue, {
    title: slice.title,
    status: "RUNNING",
    branch,
  });

  try {
    // Create worktree
    git.createWorktree(repoRoot, branch, worktreeDir, featBranch);

    // Ensure slice artifact directory exists in the worktree
    mkdirSync(absSliceDir, { recursive: true });

    // --- Step 1: Explorer ---
    const contextPath = join(absSliceDir, "context.md");
    if (!existsSync(contextPath)) {
      const logStream = logger.agentLog(slice.number, "explorer");
      await invoke({
        role: "explorer",
        prompt: renderPrompt("explorer", {
          GH_ISSUE: slice.ghIssue,
          TITLE: slice.title,
          SLICE_DIR: relSliceDir,
        }),
        cwd: worktreeDir,
        logStream,
      });
      logStream.end();
    }

    // --- Step 2: Planner (contract negotiation) ---
    const contractPath = join(absSliceDir, "contract.md");
    let contractStatus = artifacts.readContractStatus(contractPath);

    if (contractStatus !== "LOCKED") {
      for (let round = 1; round <= MAX_CONTRACT_ROUNDS; round++) {
        // Planner drafts/revises
        const plannerLog = logger.agentLog(slice.number, "planner", round);
        await invoke({
          role: "planner",
          prompt: renderPrompt("planner", {
            GH_ISSUE: slice.ghIssue,
            SPECS_DIR: relSpecsDir,
            SLICE_DIR: relSliceDir,
            ROUND: round,
            REVISION_NOTE:
              round > 1
                ? `Revise based on evaluator feedback in ${relSliceDir}/contract.md.`
                : "",
          }),
          cwd: worktreeDir,
          logStream: plannerLog,
        });
        plannerLog.end();

        // Evaluator reviews contract
        const evalLog = logger.agentLog(
          slice.number,
          "evaluator-contract",
          round,
        );
        await invoke({
          role: "evaluator-contract",
          prompt: renderPrompt("evaluator-contract", {
            SPECS_DIR: relSpecsDir,
            SLICE_DIR: relSliceDir,
            ROUND: round,
          }),
          cwd: worktreeDir,
          logStream: evalLog,
        });
        evalLog.end();

        const verdict = artifacts.readEvaluatorVerdict(contractPath);
        // Also re-check contract status — the evaluator or planner may have
        // set Status: LOCKED directly
        contractStatus = artifacts.readContractStatus(contractPath);
        if (verdict === "ACCEPT" || contractStatus === "LOCKED") {
          break;
        }
        if (verdict === "ESCALATE" || round === MAX_CONTRACT_ROUNDS) {
          logger.setSliceStatus(slice.ghIssue, {
            status: "STUCK",
            evalRounds: round,
            error: "Contract negotiation escalated after max rounds",
          });
          return "ESCALATE";
        }
      }
    }

    contractStatus = artifacts.readContractStatus(contractPath);
    if (contractStatus !== "LOCKED") {
      logger.setSliceStatus(slice.ghIssue, {
        status: "STUCK",
        error: "Contract not locked after negotiation",
      });
      return "STUCK";
    }

    // --- Step 3: Generator + Evaluator (implementation loop) ---
    const qaPath = join(absSliceDir, "qa-report.md");

    for (let round = 1; round <= MAX_GENERATOR_ROUNDS; round++) {
      logger.setSliceStatus(slice.ghIssue, { genRounds: round });

      // Generator implements
      const genLog = logger.agentLog(slice.number, "generator", round);
      await invoke({
        role: "generator",
        prompt: renderPrompt("generator", {
          SLICE_DIR: relSliceDir,
          RETRY_NOTE:
            round > 1
              ? `This is retry round ${round}. Read ${relSliceDir}/qa-report.md for findings to fix.`
              : "",
        }),
        cwd: worktreeDir,
        logStream: genLog,
      });
      genLog.end();

      // Evaluator grades
      const evalLog = logger.agentLog(slice.number, "evaluator-qa", round);
      await invoke({
        role: "evaluator-qa",
        prompt: renderPrompt("evaluator-qa", { SLICE_DIR: relSliceDir }),
        cwd: worktreeDir,
        logStream: evalLog,
      });
      evalLog.end();

      logger.setSliceStatus(slice.ghIssue, { evalRounds: round });

      const qaVerdict = artifacts.readQAVerdict(qaPath);
      if (qaVerdict === "PASS") {
        // Commit all changes FIRST — we don't want any downstream check
        // (migration drift, post-hooks, etc.) to discard code that
        // already passed QA. Drift is a deployment concern, not a
        // code-correctness one; the commit is preserved on the slice
        // branch either way.
        if (git.hasUncommittedChanges(worktreeDir)) {
          git.commitAll(worktreeDir, `feat(#${slice.ghIssue}): ${slice.title}`);
        }

        // If this slice added or modified any migrations, verify they are
        // in sync with the linked remote. Run from `repoRoot`, not the
        // worktree — the Supabase CLI + `.env.local` + `supabase/.temp/`
        // (linked-project ref) all live in the main checkout and are
        // gitignored, so they never propagate to worktrees.
        const touchedMigrations = sliceTouchedMigrations(
          worktreeDir,
          featBranch,
        );
        if (touchedMigrations) {
          const migrationCheck = verifyMigrationSync(repoRoot);
          if (!migrationCheck.ok) {
            logger.setSliceStatus(slice.ghIssue, {
              status: "STUCK",
              error: `Migration sync check failed: ${migrationCheck.error}`,
            });
            return "STUCK";
          }
        }

        logger.setSliceStatus(slice.ghIssue, { status: "PASS" });
        return "PASS";
      }

      if (round === MAX_GENERATOR_ROUNDS) {
        // Generator writes stuck.md on final failure
        const stuckLog = logger.agentLog(slice.number, "generator-stuck");
        await invoke({
          role: "generator-stuck",
          prompt: renderPrompt("generator-stuck", { SLICE_DIR: relSliceDir }),
          cwd: worktreeDir,
          logStream: stuckLog,
        });
        stuckLog.end();

        logger.setSliceStatus(slice.ghIssue, {
          status: "STUCK",
          error: `QA failed after ${MAX_GENERATOR_ROUNDS} rounds`,
        });
        return "STUCK";
      }
    }

    return "STUCK"; // Should not reach here
  } catch (err) {
    if (isCancelled(err, signal)) {
      logger.setSliceStatus(slice.ghIssue, {
        status: "CANCELLED",
        error: "Cancelled by user",
      });
      return "CANCELLED";
    }
    logger.setSliceStatus(slice.ghIssue, {
      status: "STUCK",
      error: err instanceof Error ? err.message : String(err),
    });
    return "ERROR";
  }
}

/** Main pipeline: process all slices respecting the DAG, then run reviews. */
export async function runPipeline(
  config: PipelineConfig,
): Promise<PipelineResult> {
  const { repoRoot, prdSlug, specsDir, dag, signal } = config;
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

  // Initialize feature branch. Prefer `prd/<slug>` as the base if it
  // exists — that branch holds the human-authored `prd.md` + `issues.md`
  // that the planner/generator agents read from the worktree. If we
  // initialize from `main`, worktrees won't have those files and the
  // planner will operate blind. Falls back to `main` when no PRD branch
  // is present (e.g., PRD inlined directly on main).
  const prdBranch = `prd/${prdSlug}`;
  const baseBranch = git.branchExists(repoRoot, prdBranch) ? prdBranch : "main";
  git.createBranch(repoRoot, featBranch, baseBranch);

  // Mark HITL slices as skipped
  for (const [id, slice] of dag.slices) {
    if (slice.type === "HITL") {
      logger.setSliceStatus(id, {
        title: slice.title,
        status: "SKIPPED",
        branch: "—",
      });
    }
  }

  // --- DAG-driven execution ---
  const completed = new Set<string>();
  const failed = new Set<string>();

  // Load persistent run state for resumability
  const runState = loadRunState(repoRoot, loggerSlug);
  runState.featureBranch = featBranch;

  // Restore completed slices from persistent state
  for (const [id, slice] of dag.slices) {
    if (isSliceComplete(runState, id)) {
      completed.add(id);
      logger.setSliceStatus(id, {
        title: slice.title,
        status: "PASS",
        branch:
          runState.slices[id]!.branch ?? sliceBranch(prdSlug, slice, provider),
      });
      console.log(`  Skipping #${id} ${slice.title} (already completed)`);
    }
  }

  // Process DAG level by level.
  // Only `completed` unblocks dependents — a failed slice must hold its
  // dependents so they don't run against a missing foundation. Slices
  // whose blocker is in `failed` will simply never become ready and the
  // loop will exit once no toRun remain.
  while (true) {
    const ready = dag.ready(completed);
    const toRun = ready.filter((id) => !failed.has(id));
    if (toRun.length === 0) break;

    // Phase 1: run ready slices in parallel. Each slice operates in its
    // own worktree, so this is safe to parallelize. We deliberately do
    // NOT merge into the feature branch here — `git merge` mutates a
    // single shared worktree (the main checkout, via mergeSliceBranch's
    // findWorktreeForBranch fast path), and concurrent merges would
    // race on `.git/index.lock` or apply against an unexpected parent.
    const sliceOutcomes = await Promise.allSettled(
      toRun.map(async (id) => {
        const slice = dag.slices.get(id)!;
        const result = await runSlice(config, slice, logger, featBranch);
        return { id, result };
      }),
    );

    // Phase 2: integrate (merge + persist) sequentially. PASS slices are
    // merged one at a time into the feature branch; failures are just
    // recorded. Order within a wave doesn't matter — DAG semantics only
    // require all wave members to be done before the next wave starts.
    for (let i = 0; i < sliceOutcomes.length; i++) {
      const r = sliceOutcomes[i]!;
      const id = toRun[i]!;
      const slice = dag.slices.get(id)!;
      const branch = sliceBranch(prdSlug, slice, provider);

      if (r.status === "rejected") {
        failed.add(id);
        if (isCancelled(r.reason, signal)) {
          logger.setSliceStatus(id, {
            status: "CANCELLED",
            error: "Cancelled by user",
          });
          saveSliceState(repoRoot, loggerSlug, id, {
            status: "CANCELLED",
            branch,
          });
        } else {
          logger.setSliceStatus(id, {
            status: "STUCK",
            error: `Unhandled rejection: ${r.reason}`,
          });
          saveSliceState(repoRoot, loggerSlug, id, {
            status: "ERROR" as any,
            branch,
          });
        }
        continue;
      }

      const { result } = r.value;

      if (result !== "PASS") {
        failed.add(id);
        saveSliceState(repoRoot, loggerSlug, id, {
          status: result as any,
          branch,
        });
        continue;
      }

      // PASS path — serialized merge into feature branch.
      if (!git.hasCommitsAhead(repoRoot, branch, featBranch)) {
        logger.setSliceStatus(id, {
          status: "STUCK",
          error: `Branch ${branch} has no commits ahead of ${featBranch} — generator produced no output`,
        });
        saveSliceState(repoRoot, loggerSlug, id, {
          status: "ERROR" as any,
          branch,
        });
        failed.add(id);
        continue;
      }

      const merged = git.mergeSliceBranch(repoRoot, branch, featBranch);
      if (!merged) {
        logger.setSliceStatus(id, {
          status: "CONFLICT",
          error: `Merge conflict merging ${branch} into ${featBranch}`,
        });
        saveSliceState(repoRoot, loggerSlug, id, {
          status: "CONFLICT" as any,
          branch,
        });
        failed.add(id);
        continue;
      }

      // Clean up worktree on success
      const worktreeDir = join(
        repoRoot,
        ".afk",
        "worktrees",
        branch.replace(/\//g, "-"),
      );
      git.removeWorktree(repoRoot, worktreeDir);

      saveSliceState(repoRoot, loggerSlug, id, {
        status: "PASS",
        branch,
        mergedToFeature: true,
      });
      completed.add(id);
    }

    // If cancelled, mark anything not yet completed/failed as CANCELLED
    // and exit the wave loop. Worktrees are preserved on disk so a
    // re-run resumes from the artifact state. See ADR 0003.
    if (signal?.aborted) {
      for (const [id, slice] of dag.slices) {
        if (slice.type === "HITL") continue;
        if (completed.has(id) || failed.has(id)) continue;
        logger.setSliceStatus(id, {
          title: slice.title,
          status: "CANCELLED",
          branch: sliceBranch(prdSlug, slice, provider),
        });
        saveSliceState(repoRoot, loggerSlug, id, {
          status: "CANCELLED",
          branch: sliceBranch(prdSlug, slice, provider),
        });
        failed.add(id);
      }
      break;
    }

    // If no progress was made this round, we're stuck.
    // Same DAG rule as above: only `completed` unblocks.
    const newReady = dag.ready(completed);
    const newToRun = newReady.filter((id) => !failed.has(id));
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
      git.createWorktree(repoRoot, featBranch, reviewDir);
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

        // Architect review
        const archLog = logger.agentLog("all", "architect-review");
        await invoke({
          role: "architect-review",
          agent: "architect-review",
          prompt: renderPrompt("architect-review", { SPECS_DIR: relSpecsDir }),
          cwd: reviewDir,
          logStream: archLog,
        });
        archLog.end();

        const archPath = join(reviewDir, specsDir, "review-architect.md");
        const archVerdict = artifacts.readReviewVerdict(archPath);
        if (archVerdict === "UNKNOWN") {
          console.warn(
            `  ⚠️  Could not parse architect review verdict from ${archPath} — expected a "**Verdict:** SHIP | ACCEPT-WITH-NOTES | FIX-BEFORE-SHIP" line. Treating as UNKNOWN (no PR will be opened).`,
          );
        }
        logger.setReviewVerdicts(archVerdict);

        // PM review
        const pmLog = logger.agentLog("all", "pm-review");
        await invoke({
          role: "pm-review",
          agent: "pm-review",
          prompt: renderPrompt("pm-review", { SPECS_DIR: relSpecsDir }),
          cwd: reviewDir,
          logStream: pmLog,
        });
        pmLog.end();

        const pmPath = join(reviewDir, specsDir, "review-pm.md");
        const pmVerdict = artifacts.readReviewVerdict(pmPath);
        if (pmVerdict === "UNKNOWN") {
          console.warn(
            `  ⚠️  Could not parse PM review verdict from ${pmPath} — expected a "**Verdict:** SHIP | ACCEPT-WITH-NOTES | FIX-BEFORE-SHIP" line. Treating as UNKNOWN (no PR will be opened).`,
          );
        }
        logger.setReviewVerdicts(undefined, pmVerdict);

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
                "main",
                "--head",
                featBranch,
                "--title",
                `feat: ${prdSlug}`,
                "--body",
                `Automated implementation of ${prdSlug}.\n\nSee .kiro/specs/${prdSlug}/ for artifacts (including review-architect.md and review-pm.md).`,
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
  const allSuccess = afkSlices.every((s) => completed.has(s.ghIssue));

  return { success: allSuccess, summary };
}

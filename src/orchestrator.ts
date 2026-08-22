import { join } from "node:path";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  type WriteStream,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { finished } from "node:stream/promises";
import { buildDAG, type Slice, type DAG } from "./issues-parser.js";
import * as git from "./git.js";
import { kiroProvider } from "./kiro.js";
import type { AgentProvider } from "./agent-provider.js";
import { CancelledError, isTransientProviderError } from "./agent-provider.js";
import { withTransientRetry, type TransientRetryOptions } from "./transient-retry.js";
import * as artifacts from "./artifacts.js";
import { Logger } from "./logger.js";
import { renderPrompt } from "./prompt-template.js";
import { readRelevantFiles, formatRelevantFiles, readSliceFile } from "./prd-reader.js";
import { runWave, type WaveOutcome } from "./wave.js";
import {
  lifecycle,
  type SliceIdentity,
  type SliceLifecycle,
} from "./slice-lifecycle.js";
import { DEFAULT_MAX_CONTRACT_ROUNDS } from "./cli-options.js";

import {
  runHeartbeatCommand,
  withCrossProcessLock,
} from "./command-runtime.js";
import {
  loadRunState,
  saveRunState,
  saveSliceState,
  saveReviewPhase,
  isSliceComplete,
  projectForPersistence,
  type PersistedReviewPhase,
  type RunState,
} from "./run-state.js";
import {
  resolveRunScope,
  type ResolvedRunScope,
} from "./slice-scope.js";
import {
  parseDraftPrNumber,
  writeTerminalHandoff,
  type RunStatus,
} from "./handoff.js";

const MAX_GENERATOR_ROUNDS = 3;
const WAVE_TRANSITION_TIMEOUT_MS = 30_000;
const DEFAULT_INFRASTRUCTURE_RETRIES = 2;
const DEFAULT_COMMAND_TIMEOUT_MS = 600_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;


async function closeAgentLog(log: WriteStream): Promise<void> {
  log.end();
  try {
    await finished(log);
  } catch {
    // Agent logs are best-effort and must not mask the invocation outcome.
  }
}

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
 * Wall-clock ceiling for generator and evaluator-qa invocations. The
 * 60 min provider default (ADR 0016) sits directly on top of the real
 * duration distribution for heavy slices — measured generator runs on
 * a consuming project ranged ~41–60+ min, and one healthy generator
 * with six real commits on its branch was killed at exactly the
 * ceiling. These two roles get double the budget; short-lived roles
 * (explorer, planner, evaluator-contract, guardians) keep the provider
 * default. `--max-agent-duration-ms` overrides both uniformly.
 * Mirrors the SLOW_AGENT_IDLE_TIMEOUT_MS precedent above. See ADR 0019.
 */
const SLOW_AGENT_MAX_DURATION_MS = 7_200_000;

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
 * Returns the exact `pnpm run <script>` invocations the pre-ship sanity
 * gate would execute against `cwd`, in the gate's order. Walks the same
 * `SANITY_STEPS` constant `runPreShipSanity` walks, applying the same
 * "skip steps whose primary AND fallback are absent" rule. Used to
 * inject the same command set into the evaluator-qa prompt so a slice
 * cannot pass QA on a state the gate would later reject for a typecheck
 * or lint failure. Returns `[]` when `package.json` is missing.
 */
export function resolveSanityCommands(cwd: string): string[] {
  const scripts = readPackageScripts(cwd);
  if (!scripts) return [];
  const cmds: string[] = [];
  for (const step of SANITY_STEPS) {
    const scriptName = step.scripts.find((s) => scripts[s] != null);
    if (scriptName) cmds.push(`pnpm run ${scriptName}`);
  }
  return cmds;
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

/** Outcome of one guardian review run, with failure detail when it died. */
export interface ReviewRunResult {
  outcome: artifacts.ReviewOutcome;
  /**
   * The failing invocation's error message — for the codex provider this
   * includes the agent's stderr (e.g. the codex-wrapper spawn error).
   * Surfaced in run-summary.md, not only in launcher stderr. ADR 0015.
   */
  detail?: string;
}

/**
 * Render the run's slice scope for the PM review prompt (ADR 0015): the
 * PM guardian must separate blockers within the selected slices from
 * PRD-level gaps that belong to skipped (typically HITL) slices — a PRD
 * with HITL slices would otherwise dead-end at FIX-BEFORE-SHIP forever.
 */
export function buildReviewScopeBlock(scope: ResolvedRunScope): string {
  const lines: string[] = [];
  lines.push("This run implemented ONLY the following slices:");
  lines.push("");
  for (const slice of scope.selected) {
    lines.push(`- ${slice.number} (#${slice.ghIssue}) ${slice.title}`);
  }
  // A narrowed invocation (a subset of the persisted scope, e.g.
  // `--only-failed`) must say so: the branch may already carry work from
  // earlier invocations, and the reviewer must not grade this invocation
  // against slices it never touched.
  if (scope.skipped.some(({ reason }) => reason === "narrowed")) {
    lines.push("");
    lines.push(
      "This invocation was narrowed to a subset of the run's scope of record. " +
        "Judge only the slices listed above: the narrowed-out slices below may " +
        "have been implemented by an earlier invocation on this branch, or not " +
        "at all — either way they are not this invocation's work.",
    );
  }
  if (scope.skipped.length > 0) {
    lines.push("");
    lines.push(
      "The following manifest slices were NOT executed by this run and are out of scope for this branch:",
    );
    lines.push("");
    for (const { slice, reason } of scope.skipped) {
      const label =
        reason === "hitl"
          ? "HITL — reserved for a human; AFK never runs it"
          : reason === "narrowed"
            ? "in this run's scope of record but not run by this invocation"
            : "not selected for this run";
      lines.push(`- ${slice.number} (#${slice.ghIssue}) ${slice.title} (${label})`);
    }
  } else {
    lines.push("");
    lines.push("No manifest slices were skipped — the full manifest ran.");
  }
  return lines.join("\n");
}

/** Draft-PR decision for the post-review gate. See ADR 0015. */
export interface PrCreationPlan {
  /** Whether the draft PR should be opened. */
  open: boolean;
  /** True when opened via --open-pr-on-override despite the PM verdict. */
  overridden: boolean;
  title: string;
  body: string;
  /** One-line note for logs and run-summary.md when overridden. */
  overrideNote?: string;
}

/**
 * Decide whether the draft PR opens, and build its title/body.
 *
 * Normal gate: both guardian outcomes favorable (SHIP or
 * ACCEPT-WITH-NOTES). With `openPrOnOverride`, a real FIX-BEFORE-SHIP PM
 * verdict can be overridden — but only when the architect verdict is
 * favorable, and never for infrastructure failures or UNPARSEABLE (an
 * override records disagreement with a judgment, not absence of one).
 * The override and both verdicts are recorded in the PR body.
 */
export function buildPrCreationPlan(args: {
  prdSlug: string;
  specsDir: string;
  architect: artifacts.ReviewOutcome;
  pm: artifacts.ReviewOutcome;
  openPrOnOverride: boolean;
  closesIssues: readonly string[];
}): PrCreationPlan {
  const archOk = artifacts.isFavorableReviewOutcome(args.architect);
  const pmOk = artifacts.isFavorableReviewOutcome(args.pm);
  const overridden =
    args.openPrOnOverride && archOk && !pmOk && args.pm === "FIX-BEFORE-SHIP";
  const open = (archOk && pmOk) || overridden;
  const specsPath = args.specsDir.replace(/\\/g, "/");

  const sections: string[] = [
    `Automated implementation of ${args.prdSlug}.`,
    `See ${specsPath}/ for artifacts (including review-architect.md and review-pm.md).`,
  ];
  if (overridden) {
    sections.push(
      [
        "## Human override (--open-pr-on-override)",
        "",
        "This draft PR was opened by explicit operator override despite an unfavorable PM verdict.",
        "",
        `- Architect review: **${args.architect}**`,
        `- PM review: **${args.pm}** (overridden)`,
        "",
        `Read ${specsPath}/review-pm.md for the blocking findings before merging.`,
      ].join("\n"),
    );
  }
  sections.push(
    args.closesIssues.map((issue) => `Closes #${issue}`).join("\n"),
  );

  return {
    open,
    overridden,
    title: `feat: ${args.prdSlug}`,
    body: sections.join("\n\n"),
    overrideNote: overridden
      ? `PR opened via --open-pr-on-override despite PM verdict ${args.pm} (architect: ${args.architect}).`
      : undefined,
  };
}

/**
/**
 * How the post-PASS migration gate validates a slice's new migrations.
 *
 *  - `"skip"`        — no gate (default). The consumer's CI already
 *                      validates migrations per-branch (see PR #350), so
 *                      the in-pipeline gate is redundant; leaving it on
 *                      can only produce false STUCKs for net-new
 *                      migrations the pipeline never pushes.
 *  - `"local-stack"` — boot a throwaway DB-only Supabase stack in the
 *                      slice worktree; `supabase start` auto-applies that
 *                      branch's `supabase/migrations/**`. Clean apply ==
 *                      valid. No remote, no push, no cross-branch
 *                      contamination. Requires Docker on the AFK host.
 *  - `"linked"`      — legacy: compare local migrations against a linked
 *                      cloud remote. Unsatisfiable for net-new migrations
 *                      (the pipeline never pushes) — opt-in only, never the
 *                      gating default.
 */
export type MigrationValidation = "skip" | "local-stack" | "linked";

export const DEFAULT_MIGRATION_VALIDATION: MigrationValidation = "skip";

type MigrationCheck = { ok: true } | { ok: false; error: string };

/** DB-only services for an ephemeral migration-apply stack (mirrors PR #350). */
const LOCAL_STACK_EXCLUDE =
  "studio,realtime,storage-api,imgproxy,edge-runtime,logflare,vector,mailpit,postgrest";

/**
 * Apply this worktree's `supabase/migrations/**` to a throwaway local
 * stack. A clean `supabase start` means the migrations are valid. `stop`
 * always runs in `finally`. If Docker is unavailable we skip with a
 * warning rather than STUCK — a missing optional validator must not fail
 * a slice that already passed QA.
 */
function verifyMigrationLocalStack(cwd: string): MigrationCheck {
  try {
    execFileSync("pnpm", ["supabase", "start", "-x", LOCAL_STACK_EXCLUDE], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/docker/i.test(msg) && /(not running|cannot connect|daemon|found)/i.test(msg)) {
      console.error(
        `[afk] Docker unavailable — skipping local-stack migration check: ${msg}`,
      );
      return { ok: true };
    }
    return {
      ok: false,
      error: `Migrations failed to apply on ephemeral local stack: ${msg}`,
    };
  } finally {
    try {
      execFileSync("pnpm", ["supabase", "stop", "--no-backup"], {
        cwd,
        stdio: "ignore",
      });
    } catch {
      // Best effort — leftover containers get reaped on the next start.
    }
  }
}

/**
 * Legacy linked-remote drift check. Flags any local migration row with no
 * matching remote. MUST run from a cwd where the Supabase project is linked
 * (worktrees aren't), and is unsatisfiable for net-new migrations the
 * pipeline never pushes — hence opt-in only.
 */
function verifyMigrationLinked(cwd: string): MigrationCheck {
  try {
    const output = execFileSync(
      "pnpm",
      ["supabase", "migration", "list", "--linked"],
      { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const lines = output
      .replace(/\u001b\[[0-9;]*m/g, "")
      .split(/\r?\n/)
      .filter((l) => /^\s*[│|]/.test(l) && /\d/.test(l));
    const missing: string[] = [];
    for (const line of lines) {
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
    return { ok: false, error: `Could not verify migration sync: ${msg}` };
  }
}

/**
 * Dispatch the migration gate by mode. `cwd` MUST be the slice worktree
 * (where the unmerged migration lives), not `repoRoot`.
 */
export function verifyMigrationSync(
  cwd: string,
  mode: MigrationValidation,
): MigrationCheck {
  switch (mode) {
    case "skip":
      return { ok: true };
    case "local-stack":
      return verifyMigrationLocalStack(cwd);
    case "linked":
      return verifyMigrationLinked(cwd);
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

export interface SharedPreviewConfig {
  /** Deterministic command that validates migrations before remote apply. */
  verifyMigrationCommand: string;
  /** The only command allowed to apply migrations to the shared preview. */
  applyMigrationCommand: string;
  /** Defaults to .afk/locks/shared-preview.lock under repoRoot. */
  lockPath?: string;
}

export interface PipelineConfig {
  repoRoot: string;
  prdSlug: string;
  prdDir: string; // absolute path to the PRD folder
  specsDir: string; // e.g. .kiro/specs/<prd-slug>
  dag: DAG;
  dryRun?: boolean;
  /** Slice numbers explicitly requested by the CLI, if any. */
  selectedSliceNumbers?: string[];
  /** Contract negotiation cap before convergence may grant one extra round. */
  maxContractRounds?: number;
  /**
   * Agent provider. Drives branch namespacing (via `provider.name`) and
   * the spawn/parse logic for agent invocations. Defaults to the Kiro
   * provider.
   */
  provider?: AgentProvider;
  /**
   * Post-PASS migration gate mode. Defaults to `"skip"` — the consumer's
   * CI validates migrations per-branch, so the in-pipeline gate is
   * redundant and the legacy `"linked"` path can only false-STUCK net-new
   * migrations. See {@link MigrationValidation}.
   */
  migrationValidation?: MigrationValidation;
  /** Inactivity timeout for agents and central preview commands. */
  commandTimeoutMs?: number;
  /** Activity polling and lock-heartbeat interval. */
  heartbeatIntervalMs?: number;
  /** Retries per QA stage that do not consume implementation rounds. */
  infrastructureRetries?: number;
  /**
   * Total elapsed-time window for retrying provider-classified
   * transient failures (model temporarily unavailable), measured from
   * the first such failure per invocation. Retries back off
   * exponentially (30s → 480s). Default: 15 min. 0 disables.
   * See ADR 0022.
   */
  transientRetryWindowMs?: number;
  /**
   * Test seam: overrides the backoff sleep used by transient retries
   * so integration tests don't wait through real 30s+ delays. Never
   * set outside tests.
   */
  transientRetrySleep?: TransientRetryOptions["sleep"];
  /**
   * Per-invocation wall-clock ceiling for every agent role, overriding
   * the role-aware defaults (120 min for generator/evaluator-qa, the
   * 60 min provider default otherwise). A ceiling kill during slice
   * execution is terminal for the slice, not infrastructure-retried:
   * a retry restarts the round from scratch against the same ceiling.
   * See ADR 0019.
   */
  maxAgentDurationMs?: number;
  /** Execute independent lanes serially to avoid shared-service contention. */
  serialLanes?: boolean;
  /**
   * Recognises a contract's declared path as a migration when
   * partitioning a wave into lanes, so every migration-bearing slice in
   * the wave serialises into one lane instead of racing on the next
   * free numeric prefix. Replaces (does not extend)
   * `DEFAULT_MIGRATION_PATH_PATTERN` in `src/lanes.ts`, which matches a
   * `migrations` path segment with a `.sql` extension. Matched against
   * normalised paths — forward slashes, no leading `./`, lowercased.
   * See ADR 0027.
   */
  migrationPathPattern?: RegExp;
  /**
   * Open the draft PR despite an unfavorable PM verdict, recording the
   * override and both guardian verdicts in the PR body. Only a real
   * FIX-BEFORE-SHIP PM verdict can be overridden, and only when the
   * architect verdict is favorable. See ADR 0015.
   */
  openPrOnOverride?: boolean;
  /** Enables remote UAT after deterministic QA. */
  sharedPreview?: SharedPreviewConfig;

  /**
   * Cancellation signal. When fired (typically from SIGINT), in-flight
   * agent invocations are killed and remaining slices are marked
   * CANCELLED. See ADR 0003.
   */
  signal?: AbortSignal;
}

export interface PipelineResult {
  /**
   * Whether the run produced a shippable branch. All slices passing is
   * necessary but not sufficient: a failed **pre-ship sanity gate** or a
   * guardian verdict that kept the draft PR closed makes a run
   * unsuccessful, so wrapper scripts and CI can tell a shipped run from a
   * blocked one. A draft PR opened via `--open-pr-on-override` is still a
   * success — the override note records the operator's acknowledgement.
   * See ADR 0015.
   */
  success: boolean;
  /** Markdown summary written to `.afk/logs/<slug>/run-summary.md`. */
  summary: string;
  /** Grouped, scan-friendly summary for stdout. */
  consoleSummary: string;
  /**
   * One operator-facing sentence explaining an unsuccessful run whose
   * per-slice outcomes do not show the cause — the CLI prints it instead
   * of its generic failure line. Undefined on a successful run, and on a
   * failure the slice summary already explains.
   */
  failureReason?: string;
}

/**
 * The line every entrypoint prints for an unsuccessful run. Lives here,
 * next to the result it reads, so `afk`, `afk-claude`, and `afk-codex`
 * cannot drift apart: the exit contract is the same for all three, and
 * ADR 0015 keeps it free of per-binary logic.
 */
export function formatRunFailure(result: PipelineResult): string {
  return result.failureReason
    ? `Pipeline did not ship: ${result.failureReason}`
    : "Pipeline completed with failures. Check logs and stuck.md files.";
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

export function pipelineRunSlug(prdSlug: string, provider: AgentProvider): string {
  return provider.name === "kiro" ? prdSlug : `${prdSlug}-${provider.name}`;
}

export function sliceBranch(
  prdSlug: string,
  slice: Slice,
  provider: AgentProvider,
): string {
  return `${sliceBranchPrefix(provider)}/${prdSlug}-slice-${slice.number}-${slugify(slice.title)}`;
}

/**
 * Where a slice's worktree lives. Short dir name to stay under Windows'
 * 260-char MAX_PATH — the full title remains in the branch name (visible
 * in PRs and git log); the dir just needs to be unique per slice within
 * the run.
 */
export function sliceWorktreeDir(
  repoRoot: string,
  prdSlug: string,
  slice: Slice,
  provider: AgentProvider,
): string {
  return join(
    repoRoot,
    ".afk",
    "worktrees",
    `${sliceBranchPrefix(provider)}-${prdSlug}-s${slice.number}`,
  );
}

/**
 * Throwaway checkout the merge of a slice branch happens in when the
 * feature branch has no worktree of its own. Shared by the wave's first
 * merge attempt and the next run's merge-only recovery (ADR 0029), which
 * must target the same directory.
 */
export function sliceScratchMergeDir(
  repoRoot: string,
  prdSlug: string,
  slice: Slice,
  provider: AgentProvider,
): string {
  return join(
    repoRoot,
    ".afk",
    `merge-${sliceBranchPrefix(provider)}-${prdSlug}-s${slice.number}`,
  );
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
  testCommand: string;
  sanityCommandsBlock: string;
  siblingHandoffsBlock: string;
  /**
   * Gate consulted the moment the contract reaches LOCKED, before
   * negotiation returns — the caller's chance to inspect the locked
   * contract and refuse it. Returning a string rejects the lock: the
   * contract is reopened and the planner gets another round with that
   * string as its objection. Returning `null` (or omitting the gate)
   * accepts the lock.
   *
   * A refusal costs one contract round and nothing more, which is the
   * whole point: it is the cheapest place to catch a contract that names
   * something the pipeline will refuse later. Exhausting the rounds on
   * an objection the planner cannot resolve escalates through the same
   * path any other unresolvable contract does.
   *
   * `runWave` supplies the migration-prefix gate (ADR 0028); other
   * callers leave it unset and negotiate exactly as before.
   */
  onContractLocked?: (contractPath: string) => string | null;
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
  const worktreeDir = sliceWorktreeDir(repoRoot, prdSlug, slice, provider);
  const relSliceDir = join(
    specsDir,
    "slices",
    `${slice.number}-${slugify(slice.title)}`,
  ).replace(/\\/g, "/");
  const absSliceDir = join(worktreeDir, relSliceDir);
  const relSpecsDir = specsDir.replace(/\\/g, "/");
  const tag = `[afk] Slice #${slice.ghIssue} (${slice.title})`;

  const sanityCommands = resolveSanityCommands(repoRoot);
  const sanityCommandsBlock =
    sanityCommands.length > 0
      ? sanityCommands.map((c) => `- \`${c}\``).join("\n")
      : "(no typecheck/lint/test scripts defined in this project — skip)";
  const siblingHandoffs = slice.blockedBy
    .map((issue) => config.dag.slices.get(issue))
    .filter((dependency): dependency is Slice => dependency !== undefined)
    .map((dependency) =>
      `${specsDir.replace(/\\/g, "/")}/slices/${dependency.number}-${slugify(dependency.title)}/handoff.md`,
    );
  const siblingHandoffsBlock = siblingHandoffs.length > 0
    ? siblingHandoffs.map((path) => `- \`${path}\``).join("\n")
    : "(none — this slice declares no AFK dependencies)";

  const invoke = async (opts: Parameters<AgentProvider["invoke"]>[0]) => {
    // Transient model outages (provider-classified) retry here with
    // backoff instead of failing the slice. See ADR 0022.
    const result = await withTransientRetry(
      () =>
        provider.invoke({
          ...opts,
          signal,
          onIdleWarning: (minutes) => {
            if (opts.logStream) {
              logger.writeIdleWarning(opts.logStream, opts.role, minutes);
            }
          },
          // Busy-probe deferrals (ADR 0021) become typed warn events so
          // `afk status` can show why a silent agent wasn't killed. The
          // provider already writes the human line into the agent log;
          // run.log stays untouched.
          onIdleDeferral: ({ silentSeconds, busyProcesses }) => {
            logger.event({
              type: "warn",
              reason: "idle-deferral",
              ghIssue: slice.ghIssue,
              message:
                `${opts.role} silent for ${silentSeconds}s but ` +
                `${busyProcesses} spawned process(es) still running — ` +
                `deferring idle kill (wall-clock ceiling still applies)`,
            });
          },
        }),
      {
        windowMs: config.transientRetryWindowMs,
        sleep: config.transientRetrySleep,
        signal,
        onRetry: ({ attempt, delayMs, error }) => {
          const line =
            `${tag}: ${opts.role} hit a transient model outage — ` +
            `retry ${attempt} in ${delayMs / 1000}s (${error.message})`;
          // The retry announcement tees a typed backoff warn event
          // (spec #26 / ADR 0022) from the same call site as its
          // run.log line.
          logger.phase(line, "error", {
            type: "warn",
            reason: "backoff-retry",
            ghIssue: slice.ghIssue,
            message:
              `${opts.role} hit a transient model outage — ` +
              `retry ${attempt} in ${delayMs / 1000}s (${error.message})`,
          });
          opts.logStream?.write(`\n[afk] ${line}\n`);
        },
      },
    );
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
    sanityCommandsBlock,
    siblingHandoffsBlock,
    invoke,
  };
}

export interface ContractExtensionEvidence {
  previousGapCount: number | null;
  currentGapCount: number | null;
  reRaisedGapCount: number | null;
  extensionAlreadyGranted: boolean;
}

export type ContractExtensionAssessment =
  | { grant: true; reason: string }
  | { grant: false; reason: string };

export function assessContractExtension(
  evidence: ContractExtensionEvidence,
): ContractExtensionAssessment {
  const {
    previousGapCount,
    currentGapCount,
    reRaisedGapCount,
    extensionAlreadyGranted,
  } = evidence;
  if (extensionAlreadyGranted) {
    return { grant: false, reason: "the one-round extension was already used" };
  }
  if (
    previousGapCount === null ||
    currentGapCount === null ||
    reRaisedGapCount === null
  ) {
    return { grant: false, reason: "gap metrics are missing or malformed" };
  }
  if (reRaisedGapCount > 0) {
    return {
      grant: false,
      reason: `${reRaisedGapCount} gap(s) from the prior round were re-raised`,
    };
  }
  if (currentGapCount >= previousGapCount) {
    const trend = currentGapCount === previousGapCount ? "flat" : "rising";
    return {
      grant: false,
      reason: `gap count is ${trend} (${previousGapCount} -> ${currentGapCount})`,
    };
  }
  return {
    grant: true,
    reason: `gap count decreased (${previousGapCount} -> ${currentGapCount}) with no re-raised gaps`,
  };
}

function preserveContractNegotiationFailure(
  ctx: SliceContext,
  outcome: "ESCALATE" | "STUCK",
  round: number,
  verdict: artifacts.EvaluatorVerdict,
  feedbackPath: string,
  capDecision: string,
): void {
  const provider = ctx.config.provider ?? kiroProvider;
  const result = artifacts.preserveNegotiationFailure({
    repoRoot: ctx.config.repoRoot,
    runSlug: pipelineRunSlug(ctx.config.prdSlug, provider),
    sliceDir: ctx.absSliceDir,
    sliceNumber: ctx.slice.number,
    ghIssue: ctx.slice.ghIssue,
    title: ctx.slice.title,
    round,
    outcome,
    verdict,
    feedbackPath,
    contractPath: join(ctx.absSliceDir, "contract.md"),
    contextPath: join(ctx.absSliceDir, "context.md"),
    capDecision,
  });
  if (result.archived) {
    ctx.logger.phase(
      `${ctx.tag}: archived negotiation artifacts to ${result.archiveDir}`,
    );
  }
}

/**
 * Which orchestrator-owned bound killed an agent invocation. See
 * ADR 0025 and CONTEXT.md "Agent failure cause".
 */
type AgentKillClass =
  | "idle-timeout"
  | "wall-clock-ceiling"
  | "tool-call-cap"
  | "unspecified";

/**
 * What ended a negotiate phase short of LOCKED.
 *
 * - `provider-exit` — the agent provider hung up with a non-zero exit.
 * - `orchestrator-kill` — the orchestrator killed the invocation itself.
 * - `transient-exhausted` — the transient-provider retry window closed
 *   without the outage clearing (ADR 0022).
 * - `verdict` — nothing died; the evaluator wrote a real verdict.
 * - `internal-error` — the pipeline itself threw (git, filesystem).
 *
 * The first three are *infrastructure* causes and are the only ones the
 * negotiate phase retries. See `isInfrastructureCause`.
 */
type NegotiateFailureKind =
  | "provider-exit"
  | "orchestrator-kill"
  | "transient-exhausted"
  | "verdict"
  | "internal-error";

interface NegotiateFailureCause {
  kind: NegotiateFailureKind;
  /**
   * Operator-facing one-liner. The wave records it verbatim as the
   * slice outcome's reason, replacing the fixed "Negotiation returned
   * ERROR" text, so it reaches the run state, the next run's retry
   * announcement, the event stream, and `afk status` unchanged.
   */
  summary: string;
  /** Agent role whose invocation died. Absent for `verdict`. */
  role?: string;
  /** `provider-exit` only — the agent provider's exit code. */
  exitCode?: number;
  /** `orchestrator-kill` only — which bound tripped. */
  killClass?: AgentKillClass;
  /** `verdict` only — what the evaluator actually wrote. */
  verdict?: artifacts.EvaluatorVerdict;
  /** Tail of the dead invocation's output. Absent for `verdict`. */
  outputTail?: string;
}

export type NegotiateOutcome =
  | { phase: "LOCKED" }
  | { phase: "CANCELLED" }
  | { phase: "STUCK" | "ESCALATE" | "ERROR"; cause: NegotiateFailureCause };

/**
 * Whether a negotiate failure is worth retrying. A genuine verdict
 * never is — retrying it would just re-run agents against a contract
 * the evaluator already judged — and neither is a pipeline-internal
 * throw, whose blast radius this change deliberately leaves unchanged.
 */
function isInfrastructureCause(cause: NegotiateFailureCause): boolean {
  return (
    cause.kind === "provider-exit" ||
    cause.kind === "orchestrator-kill" ||
    cause.kind === "transient-exhausted"
  );
}

/**
 * Kill-class signatures, matched against the provider's rejection
 * message. Every provider builds these strings from the same shapes
 * (`claude.ts`/`kiro.ts` use an em dash, `codex.ts` a hyphen), so the
 * patterns stay dash-agnostic — the same approach `classifyReviewFailure`
 * already takes for guardian reviews.
 */
const KILL_SIGNATURES: ReadonlyArray<readonly [RegExp, AgentKillClass]> = [
  [/exceeded \d+ tool calls/i, "tool-call-cap"],
  [/wall-clock ceiling/i, "wall-clock-ceiling"],
  [/idle for .*killed/i, "idle-timeout"],
  [/was killed/i, "unspecified"],
];

const KILL_CLASS_LABEL: Record<AgentKillClass, string> = {
  "idle-timeout": "idle timeout",
  "wall-clock-ceiling": "wall-clock ceiling",
  "tool-call-cap": "tool-call cap",
  unspecified: "kill class not recorded",
};

/** Bytes of agent log read to build an output tail. */
const OUTPUT_TAIL_BYTES = 8_192;
/** Characters of collapsed output kept in the failure reason. */
const OUTPUT_TAIL_CHARS = 240;

/**
 * Last few lines of a dead invocation's agent log, collapsed onto one
 * line so the tail can ride inside a run-state `error` string and the
 * single-line retry announcement built from it. Best-effort: an
 * unreadable log yields no tail rather than masking the real failure.
 */
function readInvocationOutputTail(
  logPath: string | undefined,
): string | undefined {
  if (!logPath || !existsSync(logPath)) return undefined;
  let text: string;
  try {
    const { size } = statSync(logPath);
    if (size === 0) return undefined;
    const length = Math.min(size, OUTPUT_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    const fd = openSync(logPath, "r");
    try {
      readSync(fd, buffer, 0, length, size - length);
    } finally {
      closeSync(fd);
    }
    text = buffer.toString("utf-8");
  } catch {
    return undefined;
  }
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return undefined;
  const tail = lines.slice(-3).join(" / ");
  return tail.length > OUTPUT_TAIL_CHARS
    ? `…${tail.slice(-OUTPUT_TAIL_CHARS)}`
    : tail;
}

/** `WriteStream.path` narrowed to the string form agent logs always use. */
function agentLogPath(log: WriteStream): string | undefined {
  return typeof log.path === "string" ? log.path : undefined;
}

/**
 * Classify a rejected negotiate-phase invocation. Transient errors are
 * recognised structurally (by `Error.name`, so classification survives
 * duplicate module instances); kills and exits fall back to the
 * provider's message, which is the only place either fact is recorded.
 */
function classifyNegotiateFailure(args: {
  role: string;
  error: unknown;
  outputTail?: string;
}): NegotiateFailureCause {
  const { role, error, outputTail } = args;
  const message = error instanceof Error ? error.message : String(error);
  const tail = outputTail ? ` [last output: ${outputTail}]` : "";
  const base = { role, ...(outputTail ? { outputTail } : {}) };

  if (isTransientProviderError(error)) {
    return {
      ...base,
      kind: "transient-exhausted",
      summary:
        `negotiate: ${role} exhausted its transient-provider retry window — ` +
        `${message}${tail}`,
    };
  }
  for (const [pattern, killClass] of KILL_SIGNATURES) {
    if (pattern.test(message)) {
      return {
        ...base,
        kind: "orchestrator-kill",
        killClass,
        summary:
          `negotiate: the orchestrator killed ${role} ` +
          `(${KILL_CLASS_LABEL[killClass]}) — ${message}${tail}`,
      };
    }
  }
  const exit = /exited with code (\d+)/i.exec(message);
  if (exit) {
    return {
      ...base,
      kind: "provider-exit",
      exitCode: Number(exit[1]),
      summary:
        `negotiate: the agent provider hung up on ${role} — ` +
        `exit code ${exit[1]} — ${message}${tail}`,
    };
  }
  return {
    ...base,
    kind: "internal-error",
    summary: `negotiate: ${role} failed — ${message}${tail}`,
  };
}

/**
 * A negotiate failure the evaluator decided, not one that killed it.
 * Labelled as a verdict so "the agent decided this is broken" never
 * reads like "the agent provider hung up".
 */
function negotiateVerdictCause(args: {
  outcome: "ESCALATE" | "STUCK";
  verdict: artifacts.EvaluatorVerdict;
  round: number;
}): NegotiateFailureCause {
  const { outcome, verdict, round } = args;
  return {
    kind: "verdict",
    verdict,
    summary:
      outcome === "ESCALATE"
        ? `negotiate: contract negotiation escalated after ${round} round(s) — ` +
          `evaluator verdict ${verdict} (a verdict, not an infrastructure death)`
        : `negotiate: contract not locked after negotiation — last evaluator ` +
          `verdict ${verdict} at round ${round} (a verdict, not an infrastructure death)`,
  };
}

/** A throw from the pipeline itself, with no dead invocation behind it. */
function internalNegotiateCause(error: unknown): NegotiateFailureCause {
  const message = error instanceof Error ? error.message : String(error);
  return { kind: "internal-error", summary: `negotiate: ${message}` };
}

/**
 * Carries a classified cause out of a failed invocation to
 * `negotiateAttempt`'s catch, so a dead agent is never confused with a
 * git or filesystem throw from the surrounding code.
 */
class NegotiateInvocationError extends Error {
  readonly failureCause: NegotiateFailureCause;
  constructor(failureCause: NegotiateFailureCause) {
    super(failureCause.summary);
    this.name = "NegotiateInvocationError";
    this.failureCause = failureCause;
  }
}

function negotiateFailureCauseOf(
  error: unknown,
): NegotiateFailureCause | undefined {
  return error instanceof Error && error.name === "NegotiateInvocationError"
    ? (error as NegotiateInvocationError).failureCause
    : undefined;
}

/**
 * Create the slice worktree and enforce its registration before dispatch.
 */
export function prepareSliceWorktree(ctx: SliceContext): void {
  git.createWorktree(
    ctx.config.repoRoot,
    ctx.branch,
    ctx.worktreeDir,
    ctx.featBranch,
  );
  git.assertWorktreeRegistered(
    ctx.config.repoRoot,
    ctx.branch,
    ctx.worktreeDir,
  );
}
/**
 * Phase A — explorer + planner ↔ evaluator-contract. Writes
 * `contract.md`. Boundary: ends at the contract-LOCKED check.
 *
 * Infrastructure deaths are retried at the failed invocation under
 * `--infrastructure-retries`. The prompt and round stay unchanged, and
 * successful explorer/planner work is not repeated.
 *
 * Outcome semantics:
 * - `LOCKED` — contract is ready for Phase B.
 * - `ESCALATE` — contract negotiation gave up after max rounds.
 * - `STUCK` — negotiation finished without LOCKED status.
 * - `ERROR` — a dead invocation or a pipeline-internal throw.
 * - `CANCELLED` — external cancellation.
 *
 * Every non-LOCKED, non-CANCELLED outcome carries a
 * `NegotiateFailureCause` naming what ended it. See ADR 0025.
 */
export async function runSliceNegotiate(
  ctx: SliceContext,
): Promise<NegotiateOutcome> {
  const { config, slice, logger } = ctx;
  const infrastructureRetries =
    config.infrastructureRetries ?? DEFAULT_INFRASTRUCTURE_RETRIES;
  if (
    !Number.isSafeInteger(infrastructureRetries) ||
    infrastructureRetries < 0
  ) {
    throw new Error("infrastructureRetries must be a non-negative integer");
  }

  return negotiateAttempt(ctx, infrastructureRetries);
}

async function negotiateAttempt(
  ctx: SliceContext,
  infrastructureRetries: number,
): Promise<NegotiateOutcome> {
  const { config, slice, logger, featBranch, relevantFilesBlock, invoke } = ctx;
  const { repoRoot, prdDir, signal } = config;

  /**
   * Run one negotiate invocation, closing its log before classifying a
   * failure — `closeAgentLog` awaits the stream's flush, so the output
   * tail read afterwards is complete.
   */
  const invokeAgent = async (
    opts: Omit<Parameters<SliceContext["invoke"]>[0], "logStream">,
    createLogStream: () => WriteStream,
    beforeAttempt?: () => void,
  ): Promise<void> => {
    for (let attempt = 1; ; attempt++) {
      beforeAttempt?.();
      const logStream = createLogStream();
      try {
        await invoke({ ...opts, logStream }).finally(() =>
          closeAgentLog(logStream),
        );
        return;
      } catch (err) {
        if (isCancelled(err, signal)) throw err;
        const cause = classifyNegotiateFailure({
          role: opts.role,
          error: err,
          outputTail: readInvocationOutputTail(agentLogPath(logStream)),
        });
        if (!isInfrastructureCause(cause) || attempt > infrastructureRetries) {
          throw new NegotiateInvocationError(cause);
        }
        const message =
          `negotiate infrastructure retry ${attempt}/${infrastructureRetries} — ` +
          cause.summary;
        logger.phase(`${ctx.tag}: ${message}`, "error", {
          type: "warn",
          reason: "infrastructure-retry",
          ghIssue: slice.ghIssue,
          message,
        });
      }
    }
  };

  logger.transitionTo(
    slice.ghIssue,
    lifecycle.running(
      { ghIssue: slice.ghIssue, title: slice.title, branch: ctx.branch },
      logger.getSliceProgress(slice.ghIssue),
    ),
  );

  try {
    prepareSliceWorktree(ctx);
    mkdirSync(ctx.absSliceDir, { recursive: true });

    // --- Step 1: Explorer ---
    const localSliceContent = readSliceFile(prdDir, slice.number);
    const sliceBodyNote = localSliceContent
      ? `The slice issue body is provided below (no need to fetch from GH):\n\n---\n${localSliceContent}\n---`
      : `No local issue manifest was found. Fetch the issue body with: gh issue view ${slice.ghIssue}`;
    const contextPath = join(ctx.absSliceDir, "context.md");
    if (!existsSync(contextPath)) {
      logger.phase(`${ctx.tag}: exploring...`, "error", {
        type: "phase-started",
        ghIssue: slice.ghIssue,
        sliceNumber: slice.number,
        agent: "explorer",
      });
      await invokeAgent(
        {
          role: "explorer",
          prompt: renderPrompt("explorer", {
            GH_ISSUE: slice.ghIssue,
            TITLE: slice.title,
            SLICE_DIR: ctx.relSliceDir,
            RELEVANT_FILES: relevantFilesBlock,
            SLICE_BODY: sliceBodyNote,
          }),
          cwd: ctx.worktreeDir,
          maxDurationMs: config.maxAgentDurationMs,
        },
        () => logger.agentLog(slice.number, "explorer"),
      );
      logger.event({
        type: "phase-ended",
        ghIssue: slice.ghIssue,
        sliceNumber: slice.number,
        agent: "explorer",
      });
    }

    // --- Step 2: Planner (contract negotiation) ---
    const contractPath = join(ctx.absSliceDir, "contract.md");
    let contractStatus = artifacts.readContractStatus(contractPath);
    const maxContractRounds = config.maxContractRounds ?? DEFAULT_MAX_CONTRACT_ROUNDS;
    if (!Number.isSafeInteger(maxContractRounds) || maxContractRounds < 1) {
      throw new Error("maxContractRounds must be a positive integer");
    }
    let allowedContractRounds = maxContractRounds;
    let extensionGranted = false;
    let previousMetrics: artifacts.EvaluatorFeedbackMetrics | null = null;
    let lastRound = 0;
    let lastVerdict: artifacts.EvaluatorVerdict = "UNKNOWN";
    let lastFeedbackPath = join(ctx.absSliceDir, "feedback-r0.md");
    const capDecisions: string[] = [];

    /**
     * Objection raised by `ctx.onContractLocked` and not yet handed to a
     * planner round. Non-null means the last contract to reach LOCKED was
     * refused after the evaluator had accepted it.
     */
    let gateObjection: string | null = null;

    /**
     * Consult the contract-lock gate on a contract that just reached
     * LOCKED. `true` means the gate refused it: the contract is back to
     * NEGOTIATING on disk and `gateObjection` holds the feedback the next
     * planner round must address.
     *
     * `lockedAt` describes where the refused lock came from, and reaches
     * the operator through `stuck.md` — so it says "a previous run" for a
     * contract found already locked on disk rather than inventing a
     * round number for a round this run never ran.
     */
    const lockRefusedByGate = (lockedAt: string): boolean => {
      const objection = ctx.onContractLocked?.(contractPath) ?? null;
      if (objection === null) return false;
      gateObjection = objection;
      artifacts.reopenContract(contractPath);
      contractStatus = "NEGOTIATING";
      capDecisions.push(
        `The contract-lock gate refused the contract locked at ${lockedAt}: ${objection}`,
      );
      logger.phase(
        `${ctx.tag}: contract lock refused before generation — ${objection}`,
        "error",
        {
          type: "warn",
          reason: "contract-lock-refused",
          ghIssue: slice.ghIssue,
          message: objection,
        },
      );
      return true;
    };

    /**
     * The planner's REVISION_NOTE for `round`. A pending gate objection
     * takes the lead: it is a concrete, mechanical correction, and the
     * evaluator feedback it supersedes said ACCEPT.
     */
    const revisionNote = (round: number, objection: string | null): string => {
      const priorFeedback =
        round > 1
          ? `${ctx.relSliceDir}/feedback-r${round - 1}.md`
          : null;
      if (objection === null) {
        return priorFeedback
          ? `Revise based only on evaluator feedback in ${priorFeedback}.`
          : "";
      }
      return (
        `The previous contract was accepted by the evaluator and then REJECTED by the ` +
        `pipeline, before any code was generated:\n\n${objection}\n\n` +
        `Resolve exactly that in this revision.` +
        (priorFeedback
          ? ` Keep the evaluator feedback in ${priorFeedback} satisfied too.`
          : "")
      );
    };

    // A contract left LOCKED on disk by an earlier run has never been
    // past the gate against *this* run's feature-branch tip. Consult it
    // before skipping negotiation altogether; a refusal reopens the
    // contract and the round loop below runs normally.
    if (contractStatus === "LOCKED") {
      lockRefusedByGate("a previous run");
    }

    if (contractStatus !== "LOCKED") {
      for (let round = 1; round <= allowedContractRounds; round++) {
        // Consume any pending gate objection: it belongs to this round's
        // planner prompt only. Leaving it set would re-deliver it after a
        // later ordinary REVISE, and would make the round-cap branch
        // below misattribute that REVISE to the gate.
        const pendingObjection = gateObjection;
        gateObjection = null;

        logger.phase(
          `${ctx.tag}: planning (round ${round}/${allowedContractRounds})...`,
          "error",
          {
            type: "phase-started",
            ghIssue: slice.ghIssue,
            sliceNumber: slice.number,
            agent: "planner",
            round,
          },
        );
        await invokeAgent(
          {
            role: "planner",
            prompt: renderPrompt("planner", {
              GH_ISSUE: slice.ghIssue,
              SPECS_DIR: ctx.relSpecsDir,
              SLICE_DIR: ctx.relSliceDir,
              ROUND: round,
              RELEVANT_FILES: relevantFilesBlock,
              SLICE_BODY: sliceBodyNote,
              REVISION_NOTE: revisionNote(round, pendingObjection),
            }),
            cwd: ctx.worktreeDir,
            maxDurationMs: config.maxAgentDurationMs,
          },
          () => logger.agentLog(slice.number, "planner", round),
        );
        logger.event({
          type: "phase-ended",
          ghIssue: slice.ghIssue,
          sliceNumber: slice.number,
          agent: "planner",
          round,
        });

        logger.phase(
          `${ctx.tag}: evaluating contract (round ${round}/${allowedContractRounds})...`,
          "error",
          {
            type: "phase-started",
            ghIssue: slice.ghIssue,
            sliceNumber: slice.number,
            agent: "evaluator-contract",
            round,
          },
        );
        const feedbackPath = join(ctx.absSliceDir, `feedback-r${round}.md`);
        await invokeAgent(
          {
            role: "evaluator-contract",
            prompt: renderPrompt("evaluator-contract", {
              SPECS_DIR: ctx.relSpecsDir,
              SLICE_DIR: ctx.relSliceDir,
              ROUND: round,
              RELEVANT_FILES: relevantFilesBlock,
              PREVIOUS_FEEDBACK_NOTE:
                round > 1
                  ? `Read ${ctx.relSliceDir}/feedback-r${round - 1}.md. Compare its gaps with this round and count materially repeated gaps as RE_RAISED_GAPS.`
                  : "There is no previous feedback round; set RE_RAISED_GAPS to 0.",
            }),
            cwd: ctx.worktreeDir,
            maxDurationMs: config.maxAgentDurationMs,
          },
          () => logger.agentLog(slice.number, "evaluator-contract", round),
          () => rmSync(feedbackPath, { force: true }),
        );

        const verdict = artifacts.readEvaluatorVerdict(feedbackPath);
        const metrics = artifacts.readEvaluatorFeedbackMetrics(feedbackPath);
        // An UNKNOWN verdict means the evaluator exited without writing
        // a parseable verdict — surface it instead of silently looping,
        // so an operator can tell a dropped negotiation from a pending
        // one. See ADR 0017.
        logger.phase(
          `${ctx.tag}: contract verdict ${verdict} (round ${round}/${allowedContractRounds})` +
            (verdict === "UNKNOWN"
              ? " — evaluator produced no parseable verdict"
              : ""),
          "error",
          {
            type: "phase-ended",
            ghIssue: slice.ghIssue,
            sliceNumber: slice.number,
            agent: "evaluator-contract",
            round,
            verdict,
          },
        );
        lastRound = round;
        lastVerdict = verdict;
        lastFeedbackPath = feedbackPath;
        if (verdict === "ACCEPT") {
          artifacts.lockContract(contractPath);
          contractStatus = "LOCKED";
        } else {
          contractStatus = artifacts.readContractStatus(contractPath);
        }
        // A refused lock falls through to the round-spending logic
        // below: the gate costs exactly what an evaluator REVISE costs.
        if (contractStatus === "LOCKED" && !lockRefusedByGate(`round ${round}`))
          break;

        if (verdict === "ESCALATE") {
          capDecisions.push(
            "Evaluator explicitly escalated; no cap extension was considered.",
          );
          logger.phase(`${ctx.tag}: contract extension not considered: explicit ESCALATE`);
        } else if (round === allowedContractRounds) {
          // A gate refusal earns no extension. The extension exists for
          // a planner making measurable progress on evaluator gaps; a
          // gate objection is a concrete mechanical correction the
          // planner already had every round to make, so failing it is
          // the escalation the operator should see.
          const assessment = gateObjection
            ? {
                grant: false as const,
                reason:
                  "the contract-lock gate refused the final round's contract",
              }
            : verdict === "REVISE"
              ? assessContractExtension({
                  previousGapCount: previousMetrics?.gapCount ?? null,
                  currentGapCount: metrics.gapCount,
                  reRaisedGapCount: metrics.reRaisedGapCount,
                  extensionAlreadyGranted: extensionGranted,
                })
              : {
                  grant: false as const,
                  reason: `verdict was ${verdict}, not REVISE`,
                };
          if (assessment.grant) {
            extensionGranted = true;
            allowedContractRounds = maxContractRounds + 1;
            capDecisions.push(
              `Granted one extra round because ${assessment.reason}.`,
            );
            logger.phase(
              `${ctx.tag}: granting contract round ${allowedContractRounds}: ${assessment.reason}`,
            );
            previousMetrics = metrics;
            continue;
          }
          capDecisions.push(`Extension refused: ${assessment.reason}.`);
          logger.phase(
            `${ctx.tag}: contract round extension refused: ${assessment.reason}`,
          );
        } else {
          previousMetrics = metrics;
          continue;
        }

        logger.phase(`${ctx.tag}: ESCALATE — contract negotiation failed`);
        preserveContractNegotiationFailure(
          ctx,
          "ESCALATE",
          round,
          verdict,
          feedbackPath,
          capDecisions.join(" "),
        );
        logger.bumpEvalRound(slice.ghIssue, round);
        const cause = negotiateVerdictCause({
          outcome: "ESCALATE",
          verdict,
          round,
        });
        logger.markEscalated(slice.ghIssue, cause.summary);
        return { phase: "ESCALATE", cause };
      }
    }

    contractStatus = artifacts.readContractStatus(contractPath);
    if (contractStatus !== "LOCKED") {
      preserveContractNegotiationFailure(
        ctx,
        "STUCK",
        lastRound,
        lastVerdict,
        lastFeedbackPath,
        capDecisions.length > 0
          ? capDecisions.join(" ")
          : "The configured round cap was not reached.",
      );
      const cause = negotiateVerdictCause({
        outcome: "STUCK",
        verdict: lastVerdict,
        round: lastRound,
      });
      logger.markStuck(slice.ghIssue, cause.summary);
      // Previously this path was silent — a slice could end negotiation
      // still NEGOTIATING with no visible trace, indistinguishable from
      // one awaiting a lane-successor refresh. See ADR 0017.
      logger.phase(
        `${ctx.tag}: STUCK — contract not locked after negotiation (last verdict: ${lastVerdict}, round ${lastRound})`,
      );
      return { phase: "STUCK", cause };
    }
    logger.phase(`${ctx.tag}: contract LOCKED`);
    return { phase: "LOCKED" };
  } catch (err) {
    if (isCancelled(err, signal)) {
      logger.markCancelled(slice.ghIssue, "Cancelled by user");
      return { phase: "CANCELLED" };
    }
    const cause = negotiateFailureCauseOf(err) ?? internalNegotiateCause(err);
    logger.markError(slice.ghIssue, cause.summary);
    return { phase: "ERROR", cause };
  }
}

/**
 * Phase B — generator ↔ evaluator-qa + commit. Boundary: starts at the
 * generator loop. Does **not** merge the slice branch into the feature
 * branch — that's the orchestrator's job, under a mutex.
 */
export type QAStageResult =
  | { outcome: "PASS"; report: string }
  | { outcome: "IMPLEMENTATION"; report: string };

export async function runQAStage(
  ctx: SliceContext,
  round: number,
  stage: "deterministic" | "shared-preview",
  previousReports: readonly string[],
): Promise<QAStageResult> {
  const { config, slice, logger, invoke } = ctx;
  const infrastructureRetries = config.infrastructureRetries ?? DEFAULT_INFRASTRUCTURE_RETRIES;
  if (!Number.isSafeInteger(infrastructureRetries) || infrastructureRetries < 0) {
    throw new Error("infrastructureRetries must be a non-negative integer");
  }
  const commandTimeoutMs = config.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const heartbeatIntervalMs = config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const reportName = stage === "deterministic" ? "qa-report.md" : "uat-report.md";
  const reportPath = join(ctx.absSliceDir, reportName);
  const reportDisplayPath = `${ctx.relSliceDir}/${reportName}`;
  const scope = stage === "deterministic"
    ? "Deterministic slice QA only. Do not access a shared preview database or run remote UAT."
    : "Shared-preview UAT only. Do not repeat deterministic sanity commands.";

  for (let attempt = 1; attempt <= infrastructureRetries + 1; attempt++) {
    const invokeEvaluator = async () => {
      rmSync(reportPath, { force: true });
      if (stage === "shared-preview") {
        const preview = config.sharedPreview!;
        const commandOptions = {
          cwd: ctx.worktreeDir,
          inactivityTimeoutMs: commandTimeoutMs,
          heartbeatIntervalMs,
          signal: config.signal,
          onOutput: (text: string) => process.stderr.write(text),
        };
        await runHeartbeatCommand(preview.verifyMigrationCommand, commandOptions);
        await runHeartbeatCommand(preview.applyMigrationCommand, commandOptions);
      }

      const logRole = stage === "deterministic" ? "evaluator-qa" : "evaluator-uat";
      const evalLog = logger.agentLog(slice.number, logRole, round * 10 + attempt);
      await invoke({
        role: "evaluator-qa",
        prompt: renderPrompt("evaluator-qa", {
          SLICE_DIR: ctx.relSliceDir,
          RELEVANT_FILES: ctx.relevantFilesBlock,
          SIBLING_HANDOFFS: ctx.siblingHandoffsBlock,
          TEST_COMMAND: ctx.testCommand,
          SANITY_COMMANDS: ctx.sanityCommandsBlock,
          QA_SCOPE: scope,
          REPORT_PATH: reportDisplayPath,
          PREVIOUS_QA_REPORTS: previousReports.length > 0
            ? previousReports.map((path) => `- \`${path}\``).join("\n")
            : "(none)",
          COMMAND_TIMEOUT_SECONDS: Math.ceil(commandTimeoutMs / 1_000),
          HEARTBEAT_SECONDS: Math.ceil(heartbeatIntervalMs / 1_000),
        }),
        cwd: ctx.worktreeDir,
        logStream: evalLog,
        idleTimeoutMs: commandTimeoutMs,
        idleWarningIntervalMs: heartbeatIntervalMs,
        maxDurationMs: config.maxAgentDurationMs ?? SLOW_AGENT_MAX_DURATION_MS,
      }).finally(() => closeAgentLog(evalLog));
    };

    try {
      if (stage === "shared-preview") {
        const lockPath = config.sharedPreview!.lockPath ??
          join(config.repoRoot, ".afk", "locks", "shared-preview.lock");
        await withCrossProcessLock(
          lockPath,
          {
            acquireTimeoutMs: commandTimeoutMs,
            heartbeatIntervalMs,
            staleAfterMs: commandTimeoutMs * 2,
            signal: config.signal,
          },
          invokeEvaluator,
        );
      } else {
        await invokeEvaluator();
      }
    } catch (error) {
      if (isCancelled(error, config.signal)) throw error;
      if (attempt <= infrastructureRetries) {
        logger.phase(
          `${ctx.tag}: ${stage} infrastructure retry ${attempt}/${infrastructureRetries}`,
          "error",
          {
            type: "warn",
            reason: "infrastructure-retry",
            ghIssue: slice.ghIssue,
            message: `${stage} infrastructure retry ${attempt}/${infrastructureRetries}`,
          },
        );
        continue;
      }
      throw new Error(
        `${stage} infrastructure failed after ${attempt} attempt(s): ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const archiveName = stage === "deterministic"
      ? `qa-report-r${round}-a${attempt}.md`
      : `uat-report-r${round}-a${attempt}.md`;
    const archivePath = join(ctx.absSliceDir, archiveName);
    if (!artifacts.archiveQAReport(reportPath, archivePath)) {
      if (attempt <= infrastructureRetries) continue;
      throw new Error(`${stage} evaluator produced no report after ${attempt} attempt(s)`);
    }
    const archiveDisplayPath = `${ctx.relSliceDir}/${archiveName}`;
    const verdict = artifacts.readQAVerdict(reportPath);
    if (verdict === "PASS") return { outcome: "PASS", report: archiveDisplayPath };
    if (artifacts.readQAFailureClass(reportPath) === "INFRASTRUCTURE") {
      if (attempt <= infrastructureRetries) {
        logger.phase(
          `${ctx.tag}: ${stage} report classified infrastructure; retrying without consuming round ${round}`,
          "error",
          {
            type: "warn",
            reason: "infrastructure-retry",
            ghIssue: slice.ghIssue,
            message: `${stage} report classified infrastructure; retrying without consuming round ${round}`,
          },
        );
        continue;
      }
      throw new Error(`${stage} infrastructure findings persisted after ${attempt} attempt(s)`);
    }
    return { outcome: "IMPLEMENTATION", report: archiveDisplayPath };
  }

  throw new Error(`${stage} QA exhausted without a result`);
}

export async function runSliceExecute(
  ctx: SliceContext,
): Promise<"PASS" | "STUCK" | "ERROR" | "CANCELLED"> {
  const { config, slice, logger, featBranch, invoke } = ctx;
  const { signal } = config;
  const qaReports: string[] = [];

  try {
    for (let round = 1; round <= MAX_GENERATOR_ROUNDS; round++) {
      logger.bumpGenRound(slice.ghIssue, round);
      logger.phase(
        `${ctx.tag}: implementing (round ${round}/${MAX_GENERATOR_ROUNDS})...`,
        "error",
        {
          type: "phase-started",
          ghIssue: slice.ghIssue,
          sliceNumber: slice.number,
          agent: "generator",
          round,
        },
      );
      const genLog = logger.agentLog(slice.number, "generator", round);
      const timeoutMs = config.commandTimeoutMs ?? SLOW_AGENT_IDLE_TIMEOUT_MS;
      const heartbeatMs =
        config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
      const generatorPrompt = renderPrompt("generator", {
        SLICE_DIR: ctx.relSliceDir,
        RELEVANT_FILES: ctx.relevantFilesBlock,
        SIBLING_HANDOFFS: ctx.siblingHandoffsBlock,
        TEST_COMMAND: ctx.testCommand,
        RETRY_NOTE:
          round > 1
            ? `This is implementation round ${round}. Fix every unresolved finding in these preserved reports:\n${qaReports.map((path) => `- \`${path}\``).join("\n")}`
            : "",
      });
      await invoke({
        role: "generator",
        prompt: generatorPrompt,
        cwd: ctx.worktreeDir,
        logStream: genLog,
        idleTimeoutMs: timeoutMs,
        idleWarningIntervalMs: heartbeatMs,
        maxDurationMs: config.maxAgentDurationMs ?? SLOW_AGENT_MAX_DURATION_MS,
      }).finally(() => closeAgentLog(genLog));
      logger.event({
        type: "phase-ended",
        ghIssue: slice.ghIssue,
        sliceNumber: slice.number,
        agent: "generator",
        round,
      });

      logger.phase(
        `${ctx.tag}: deterministic QA (round ${round}/${MAX_GENERATOR_ROUNDS})...`,
        "error",
        {
          type: "phase-started",
          ghIssue: slice.ghIssue,
          sliceNumber: slice.number,
          agent: "evaluator-qa",
          round,
        },
      );
      const deterministic = await runQAStage(ctx, round, "deterministic", qaReports);
      logger.event({
        type: "phase-ended",
        ghIssue: slice.ghIssue,
        sliceNumber: slice.number,
        agent: "evaluator-qa",
        round,
        verdict: deterministic.outcome,
      });
      let implementationFailed = deterministic.outcome === "IMPLEMENTATION";
      qaReports.push(deterministic.report);
      if (deterministic.outcome !== "IMPLEMENTATION" && config.sharedPreview) {
        logger.phase(
          `${ctx.tag}: shared-preview UAT (round ${round}/${MAX_GENERATOR_ROUNDS})...`,
          "error",
          {
            type: "phase-started",
            ghIssue: slice.ghIssue,
            sliceNumber: slice.number,
            agent: "evaluator-uat",
            round,
          },
        );
        const remote = await runQAStage(ctx, round, "shared-preview", qaReports);
        logger.event({
          type: "phase-ended",
          ghIssue: slice.ghIssue,
          sliceNumber: slice.number,
          agent: "evaluator-uat",
          round,
          verdict: remote.outcome,
        });
        qaReports.push(remote.report);
        if (remote.outcome === "IMPLEMENTATION") {
          implementationFailed = true;
        }
      }

      logger.bumpEvalRound(slice.ghIssue, round);
      if (!implementationFailed) {
        if (git.hasUncommittedChanges(ctx.worktreeDir)) {
          git.commitAll(ctx.worktreeDir, `feat(#${slice.ghIssue}): ${slice.title}`);
        }

        const migrationMode = config.migrationValidation ?? DEFAULT_MIGRATION_VALIDATION;
        if (!config.sharedPreview && migrationMode !== "skip" && sliceTouchedMigrations(ctx.worktreeDir, featBranch)) {
          const migrationCheck = verifyMigrationSync(ctx.worktreeDir, migrationMode);
          if (!migrationCheck.ok) {
            logger.markStuck(slice.ghIssue, `Migration sync check failed: ${migrationCheck.error}`);
            return "STUCK";
          }
        }

        logger.phase(`${ctx.tag}: deterministic QA and configured UAT pass — committed`);
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
        logger.phase(`${ctx.tag}: stuck — running fallback generator...`, "error", {
          type: "phase-started",
          ghIssue: slice.ghIssue,
          sliceNumber: slice.number,
          agent: "generator-stuck",
        });
        const stuckLog = logger.agentLog(slice.number, "generator-stuck");
        await invoke({
          role: "generator-stuck",
          prompt: renderPrompt("generator-stuck", {
            SLICE_DIR: ctx.relSliceDir,
            QA_REPORTS: qaReports.map((path) => `- \`${path}\``).join("\n"),
          }),
          cwd: ctx.worktreeDir,
          logStream: stuckLog,
          maxDurationMs: config.maxAgentDurationMs,
        }).finally(() => closeAgentLog(stuckLog));
        logger.event({
          type: "phase-ended",
          ghIssue: slice.ghIssue,
          sliceNumber: slice.number,
          agent: "generator-stuck",
        });
        logger.markStuck(slice.ghIssue, `QA failed after ${MAX_GENERATOR_ROUNDS} implementation rounds`);
        return "STUCK";
      }
    }
    return "STUCK";
  } catch (err) {
    if (isCancelled(err, signal)) {
      logger.markCancelled(slice.ghIssue, "Cancelled by user");
      return "CANCELLED";
    }
    const message = err instanceof Error ? err.message : String(err);
    // A wall-clock ceiling kill is terminal by design, not an
    // infrastructure failure: a retry restarts the round from scratch
    // against the same ceiling and doubles the wasted wall-clock.
    // Point the operator at the remedy instead. Committed work is
    // preserved on the slice branch. See ADR 0019.
    logger.markError(
      slice.ghIssue,
      /wall-clock ceiling/.test(message)
        ? `${message}. Terminal by design (ADR 0019): committed work is preserved on ${ctx.branch}; rerun with a larger --max-agent-duration-ms.`
        : message,
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
  if (negotiate.phase !== "LOCKED") return negotiate.phase;
  return runSliceExecute(ctx);
}

/** Main pipeline: process all slices respecting the DAG, then run reviews. */
export async function runPipeline(
  config: PipelineConfig,
): Promise<PipelineResult> {
  const {
    repoRoot,
    prdSlug,
    prdDir,
    specsDir,
    dag: manifestDag,
    signal,
  } = config;
  const provider = config.provider ?? kiroProvider;
  const loggerSlug = pipelineRunSlug(prdSlug, provider);
  const logger = new Logger(repoRoot, loggerSlug);
  // First run.log line — tells the operator where this run's logs live
  // and gives `tail -f` a stable target from second zero.
  logger.phase(
    `[afk] Pipeline run started (${provider.name}) — logs: ${logger.runDir}`,
    "error",
    { type: "run-started", provider: provider.name, runSlug: loggerSlug },
  );
  const invoke = (opts: Parameters<AgentProvider["invoke"]>[0]) =>
    withTransientRetry(
      () =>
        provider.invoke({
          ...opts,
          signal,
          onIdleWarning: (minutes) => {
            if (opts.logStream) {
              logger.writeIdleWarning(opts.logStream, opts.role, minutes);
            }
          },
        }),
      {
        windowMs: config.transientRetryWindowMs,
        sleep: config.transientRetrySleep,
        signal,
        onRetry: ({ attempt, delayMs, error }) => {
          logger.phase(
            `[afk] ${opts.role} hit a transient model outage — ` +
              `retry ${attempt} in ${delayMs / 1000}s (${error.message})`,
            "error",
            {
              type: "warn",
              reason: "backoff-retry",
              message:
                `${opts.role} hit a transient model outage — ` +
                `retry ${attempt} in ${delayMs / 1000}s (${error.message})`,
            },
          );
        },
      },
    );
  const featBranch = featureBranch(prdSlug, provider);
  logger.setFeatureBranch(featBranch);
  const relevantFilesBlock = formatRelevantFiles(readRelevantFiles(prdDir));
  // Resolve the consumer project's test command once per run. Falls back
  // to `pnpm test` when no test script is defined — matches the pre-ship
  // gate's forgiving stance.
  const testCommand = resolveTestCommand(repoRoot) ?? "pnpm test";
  let scope: ResolvedRunScope | undefined;
  let baseBranch: string | undefined;
  let draftPrUrl: string | null = null;
  let draftPrNumber: number | null = null;
  /**
   * Why the run ended without a shippable branch, when the per-slice
   * outcomes do not say. Set only by the post-merge phase: a failed
   * pre-ship sanity gate, or guardian verdicts that kept the draft PR
   * closed. Its presence makes the run unsuccessful even when every slice
   * passed (issue #43). A `--open-pr-on-override` PR leaves it unset.
   */
  let shipBlocker: string | undefined;

  const emitHandoff = (runStatus: RunStatus): void => {
    if (!scope) return;
    const finalCommitSha = git.resolveCommit(repoRoot, featBranch);
    writeTerminalHandoff(repoRoot, loggerSlug, {
      version: 1,
      runStatus,
      selectedSlices: scope.selected.map((slice) => ({
        number: slice.number,
        ghIssue: slice.ghIssue,
        title: slice.title,
        type: "AFK",
        status: logger.getSlice(slice.ghIssue)?.phase ?? "NOT-RUN",
      })),
      skippedSlices: scope.skipped.map(({ slice, reason }) => ({
        number: slice.number,
        ghIssue: slice.ghIssue,
        title: slice.title,
        type: slice.type,
        reason,
      })),
      featureBranch: featBranch,
      finalCommitSha,
      migrationFilesCreated:
        baseBranch && finalCommitSha
          ? git.listAddedMigrationFiles(repoRoot, baseBranch, featBranch)
          : [],
      githubIssuesToClose: scope.selected.map((slice) => slice.ghIssue),
      draftPr: {
        number: draftPrNumber ?? parseDraftPrNumber(draftPrUrl),
        url: draftPrUrl,
      },
    });
  };

  try {
  const runState = loadRunState(repoRoot, loggerSlug);
  scope = resolveRunScope(
    [...manifestDag.slices.values()],
    config.selectedSliceNumbers,
    runState.scope,
  );
  runState.scope = scope.persisted;
  runState.featureBranch = featBranch;
  saveRunState(repoRoot, runState);
  const dag = buildDAG(scope.selected);
  const selectedIssues = new Set(scope.selected.map((slice) => slice.ghIssue));

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
  baseBranch = git.branchExists(repoRoot, prdBranch)
    ? prdBranch
    : defaultBranch;
  git.createBranch(repoRoot, featBranch, baseBranch);

  // Mark manifest HITL slices as skipped for the human-readable summary.
  for (const [id, slice] of manifestDag.slices) {
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
  // Slices this invocation handed to a wave, skipped as already merged,
  // or merged during recovery. None is derivable from `completed`
  // afterwards because that set mixes all three; together they decide
  // whether the run did anything at all (issue #42).
  const dispatched = new Set<string>();
  const alreadyComplete = new Set<string>();
  const recoveredMerges = new Set<string>();
  // Slices whose merge is deferred (ADR 0029). Like `laneCancelled` they
  // are held out of readiness for the rest of this run — a slice that
  // just refused its merge must not be regenerated — and they never
  // unblock DAG dependents, because nothing of theirs is on the feature
  // branch. They are naturally re-eligible on the next run, where the
  // merge-only recovery pass tries the merge again before any agent runs.
  const mergePending = new Set<string>();

  /**
   * A slice this run will not dispatch again, for any reason short of
   * success. One predicate so a new hold-back reason is one edit, not
   * three filter sites plus a sweep condition.
   */
  const heldBack = (id: string): boolean =>
    failed.has(id) || laneCancelled.has(id) || mergePending.has(id);

  // Restore completed slices from persistent state. Per-slice
  // prior-run state announcements (issue #17) and their warn events
  // (spec #26) share one call site each, so the human line and its
  // machine form cannot drift apart.
  for (const [id, slice] of dag.slices) {
    if (isSliceComplete(runState, id)) {
      completed.add(id);
      alreadyComplete.add(id);
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
      logger.phase(
        `  Skipping #${id} ${slice.title} (already completed)`,
        "log",
        {
          type: "warn",
          reason: "prior-run-state",
          ghIssue: id,
          previousPhase: "PASS",
          message: `#${id} ${slice.title}: prior run ended PASS — skipped (already completed)`,
        },
      );
      continue;
    }
    // A slice with a persisted non-complete phase is about to be
    // retried. Say so — and say why it stopped — before any wave
    // dispatches. Without this line, an operator diffing the wave
    // composition against the manifest has no way to tell a retried
    // slice from a silently dropped one, and no way to see the prior
    // failure reason without opening .afk/state/<slug>.json by hand.
    // There is deliberately NO retry cap: failed slices are always
    // eligible again on the next run. See issue #17.
    //
    // A MERGE-PENDING slice is not being retried in that sense: its work
    // is intact and only its merge is outstanding, so it is announced as
    // a recovery. The merge-only pass below acts on it.
    const prior = runState.slices[id];
    if (prior) {
      const reason = prior.error ? ` — ${prior.error}` : "";
      const label =
        prior.phase === "PASS" ? "PASS (merge did not complete)" : prior.phase;
      const verb =
        prior.phase === "MERGE-PENDING"
          ? "Recovering the merge for"
          : "Retrying";
      logger.phase(
        `  ${verb} #${id} ${slice.title} (previous run: ${label}${reason})`,
        "log",
        {
          type: "warn",
          reason: "prior-run-state",
          ghIssue: id,
          previousPhase: prior.phase,
          previousError: prior.error,
          message: `#${id} ${slice.title}: prior run ended ${label}${reason}`,
        },
      );
    }
  }

  // Dependency satisfaction reads the run state, not only this
  // invocation's DAG. A slice recorded PASS with `mergedToFeature` is a
  // fact about the feature branch, so it unblocks its dependents whether
  // or not this invocation selected it — without this, narrowing the
  // selection to one failed slice dispatches nothing at all, because the
  // prerequisite is not a member of the current DAG and never counts as
  // satisfied (issue #41).
  //
  // Entries for slices no longer declared in `issues.md` are ignored
  // rather than fatal: a manifest edit must not wedge a re-run. They
  // still satisfy dependents that name them, and say so in the line.
  for (const id of Object.keys(runState.slices)) {
    if (dag.slices.has(id)) continue;
    if (!isSliceComplete(runState, id)) continue;
    completed.add(id);
    const manifestSlice = manifestDag.slices.get(id);
    const label = manifestSlice
      ? manifestSlice.title
      : "(no longer declared in issues.md)";
    logger.phase(
      `  Dependency #${id} ${label} satisfied from prior run state ` +
        `(PASS, merged into ${featBranch}) — not part of this invocation`,
      "log",
      {
        type: "warn",
        reason: "dependency-from-prior-run",
        ghIssue: id,
        previousPhase: "PASS",
        message:
          `#${id} ${label}: dependency satisfied from prior run state ` +
          `(PASS, merged into ${featBranch}) — outside this invocation's selection`,
      },
    );
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

  // Persist a slice's terminal outcome the moment it lands. `runWave`
  // invokes this via `onOutcome` right after each outcome is decided —
  // for PASS, immediately after the merge and worktree removal — so a
  // hard-kill mid-wave cannot lose the record of already-merged work.
  // See ADR 0018.
  //
  // The guard set makes the post-wave loop a reconciliation pass: it
  // re-issues persistence only for outcomes whose immediate write threw
  // (runWave contains callback errors), and never double-writes or
  // double-logs. The id is added to the set only after the write
  // succeeded, so a failed write stays eligible for the retry.
  //
  // Concurrency: lanes run in parallel, but `saveSliceState` is a fully
  // synchronous read-modify-write with no awaits, so two lanes can never
  // interleave inside it — no lost updates, no mutex needed.
  const persistedOutcomes = new Set<string>();
  const persistOutcome = (id: string, outcome: WaveOutcome) => {
    if (persistedOutcomes.has(id)) return;
    const slice = dag.slices.get(id)!;
    const branch = sliceBranch(prdSlug, slice, provider);
    const sliceId: SliceIdentity = {
      ghIssue: id,
      title: slice.title,
      branch,
    };
    const progress = logger.getSliceProgress(id);

    // The wave layer reports generic labels ("Phase B returned ERROR");
    // the failure site usually already recorded the specific detail on
    // the logger via markError/markStuck — e.g. a wall-clock ceiling
    // kill and its remedy (ADR 0019). When the phases agree, prefer
    // that detail so state.json and run.log say WHY the slice stopped,
    // not just where.
    const current = logger.getSlice(id);
    const detailOf = (waveError: string): string =>
      current &&
      current.phase === outcome.phase &&
      "error" in current &&
      current.error
        ? current.error
        : waveError;

    // PASS is only ever reported by runWave after the merge into the
    // feature branch succeeded, so `mergedToFeature: true` is safe here
    // and `isSliceComplete` will treat the slice as resumable-complete.
    const next = ((): SliceLifecycle => {
      switch (outcome.phase) {
        case "PASS":
          return lifecycle.pass(sliceId, progress, true);
        case "LANE-CANCELLED":
          return lifecycle.laneCancelled(
            sliceId,
            progress,
            detailOf(outcome.error),
          );
        case "CANCELLED":
          return lifecycle.cancelled(sliceId, progress, detailOf(outcome.error));
        case "CONFLICT":
          return lifecycle.conflict(sliceId, progress, detailOf(outcome.error));
        case "MERGE-PENDING":
          // Not `detailOf`: the wave's reason names the colliding
          // prefixes, which no earlier failure site could have recorded
          // on the logger.
          return lifecycle.mergePending(
            sliceId,
            progress,
            outcome.error,
            outcome.collidingPrefixes,
          );
        case "ESCALATE":
          return lifecycle.escalate(sliceId, progress, detailOf(outcome.error));
        case "ERROR":
          return lifecycle.error(sliceId, progress, detailOf(outcome.error));
        case "STUCK":
          return lifecycle.stuck(sliceId, progress, detailOf(outcome.error));
      }
    })();

    logger.transitionTo(id, next);
    saveSliceState(repoRoot, loggerSlug, id, projectForPersistence(next)!);
    persistedOutcomes.add(id);

    // Every terminal outcome gets a timestamped run.log line so an
    // operator can always tell WHY a slice stopped — a LANE-CANCELLED
    // deferral reads differently from a dropped negotiation. ADR 0017.
    if (outcome.phase === "PASS") {
      logger.phase(
        `[afk] Slice #${id} (${slice.title}): PASS — merged into ${featBranch}`,
        "error",
        { type: "slice-outcome", slice: next },
      );
    } else {
      // Read the reason off `next` so the run.log line and the persisted
      // record can never disagree about why the slice stopped.
      const reason = "error" in next ? next.error : outcome.error;
      logger.phase(
        `[afk] Slice #${id} (${slice.title}): ${outcome.phase} — ${reason}`,
        "error",
        { type: "slice-outcome", slice: next },
      );
    }
  };

  // Record an outcome the merge-only recovery pass decided. Same three
  // steps `persistOutcome` takes for a wave outcome — transition, persist,
  // emit the slice-outcome event — but the recovery pass owns the
  // lifecycle value itself, because it has facts (the refreshed colliding
  // prefixes) no wave produced.
  const recordRecovery = (id: string, next: SliceLifecycle) => {
    logger.transitionTo(id, next);
    saveSliceState(repoRoot, loggerSlug, id, projectForPersistence(next)!);
    persistedOutcomes.add(id);
    const suffix =
      next.phase === "PASS"
        ? `PASS — merged into ${featBranch} by merge-only recovery (no agent invoked)`
        : `${next.phase} — ${"error" in next ? next.error : ""}`;
    logger.phase(`[afk] Slice #${id} (${next.title}): ${suffix}`, "error", {
      type: "slice-outcome",
      slice: next,
    });
  };

  // --- Merge-only recovery, before the first wave dispatches (ADR 0029).
  //
  // A slice recorded MERGE-PENDING lost nothing but its merge: the work
  // is committed on its slice branch and QA passed. Retrying it costs one
  // git merge and zero tokens, so it runs ahead of any agent — and it
  // must, because a recovered slice may unblock DAG dependents that would
  // otherwise be held back for the whole run.
  //
  // The collision re-check happens inside the merge mutex against the
  // current feature-branch tip, exactly as the original attempt did: this
  // recovery is no less safe than the merge it is repeating.
  for (const slice of scope.members) {
    const id = slice.ghIssue;
    // Ctrl-C during recovery stops it where it stands; the wave loop's
    // cancellation sweep marks whatever is left (ADR 0003).
    if (signal?.aborted) break;
    const prior = runState.slices[id];
    if (prior?.phase !== "MERGE-PENDING") continue;

    const branch = prior.branch ?? sliceBranch(prdSlug, slice, provider);
    const sliceId: SliceIdentity = { ghIssue: id, title: slice.title, branch };
    const progress = logger.getSliceProgress(id);

    // The recoverable claim is "the work is committed on this branch". If
    // the branch is gone or carries nothing, the claim is false and there
    // is nothing to merge — fall through to ordinary dispatch rather than
    // inventing an outcome.
    if (
      !git.branchExists(repoRoot, branch) ||
      !git.hasCommitsAhead(repoRoot, branch, featBranch)
    ) {
      const selected = selectedIssues.has(id);
      logger.phase(
        `  #${id} ${slice.title}: MERGE-PENDING, but ${branch} is missing or has no ` +
          `commits ahead of ${featBranch} — nothing to recover; ` +
          (selected
            ? "dispatching normally"
            : "slice is outside this invocation's dispatch set"),
        "log",
        {
          type: "warn",
          reason: "prior-run-state",
          ghIssue: id,
          previousPhase: "MERGE-PENDING",
          message:
            `#${id} ${slice.title}: recoverable merge claim is false ` +
            `(${branch} missing or empty) — ` +
            (selected
              ? "dispatching normally"
              : "not selected for agent dispatch"),
        },
      );
      continue;
    }

    const scratchMergeDir = sliceScratchMergeDir(
      repoRoot,
      prdSlug,
      slice,
      provider,
    );
    const attempt = await mergeMutex(() =>
      Promise.resolve(
        git.attemptMerge(repoRoot, branch, featBranch, scratchMergeDir),
      ),
    );

    // Still colliding: stay MERGE-PENDING with a reason refreshed against
    // the current tip. Deliberately NOT escalated to a regeneration — a
    // repeated retry must never spend tokens the operator didn't ask for.
    if (attempt.kind === "collision") {
      recordRecovery(
        id,
        lifecycle.mergePending(
          sliceId,
          progress,
          git.mergePendingReason(attempt.prefixes, featBranch),
          attempt.prefixes,
        ),
      );
      mergePending.add(id);
      continue;
    }

    // A real merge conflict is a different animal: it needs a human, and
    // CONFLICT keeps meaning exactly that.
    if (attempt.result.status === "conflict") {
      recordRecovery(
        id,
        lifecycle.conflict(sliceId, progress, attempt.result.details),
      );
      failed.add(id);
      continue;
    }

    if (attempt.result.cleanupWarning) {
      logger.phase(`[afk] Warning: ${attempt.result.cleanupWarning}`);
    }
    await mergeMutex(() =>
      Promise.resolve(
        git.removeWorktree(
          repoRoot,
          sliceWorktreeDir(repoRoot, prdSlug, slice, provider),
        ),
      ),
    );
    recordRecovery(id, lifecycle.pass(sliceId, progress, true));
    completed.add(id);
    recoveredMerges.add(id);
  }

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
        return ready.filter((id) => !heldBack(id));
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
      onOutcome: persistOutcome,
    });

    // --- Reconcile results from this wave. ---
    //
    // Persistence already happened per-slice as each outcome landed
    // (onOutcome → persistOutcome, ADR 0018). This loop retries any
    // write that failed mid-wave — persistOutcome is a no-op for ids it
    // already persisted — and updates the in-memory scheduling sets,
    // which only matter between waves.
    for (const [id, outcome] of outcomes) {
      persistOutcome(id, outcome);
      dispatched.add(id);
      if (outcome.phase === "PASS") {
        completed.add(id);
      } else if (outcome.phase === "LANE-CANCELLED") {
        laneCancelled.add(id);
      } else if (outcome.phase === "MERGE-PENDING") {
        mergePending.add(id);
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
    const newToRun = newReady.filter((id) => !heldBack(id));
    if (newToRun.length === 0) break;
  }

  // Any selected slice that never received an outcome was held back by
  // an unresolved dependency — dag.ready() simply never surfaced it, so
  // no wave line, no state entry, and no failure message ever mentioned
  // it. Spell the hold-back out per slice, naming the blockers, so the
  // operator doesn't have to reverse-engineer the omission from the
  // wave composition (issue #17) — and tee the same hold as a typed
  // warn event for `afk status` (spec #26).
  //
  // The same per-slice hold is the diagnostic a zero-dispatch failure
  // has to report (issue #42), so it is computed once here and reused
  // below rather than re-derived from the log lines.
  const notRunHolds: Array<{ id: string; title: string; hold: string }> = [];
  for (const [id, slice] of dag.slices) {
    if (slice.type === "HITL") continue;
    if (completed.has(id) || heldBack(id)) continue;
    const unresolved = slice.blockedBy.filter((dep) => !completed.has(dep));
    const blockerText =
      unresolved.length > 0
        ? unresolved
            .map((dep) =>
              dag.slices.has(dep) ? `#${dep}` : `#${dep} (outside run scope)`,
            )
            .join(", ")
        : "(unknown)";
    const hold =
      `held back by unresolved ` +
      `dependenc${unresolved.length === 1 ? "y" : "ies"} [${blockerText}]`;
    notRunHolds.push({ id, title: slice.title, hold });
    logger.phase(
      `[afk] Slice #${id} (${slice.title}): NOT-RUN — ${hold}; ` +
        `fix the blocker(s) and re-run`,
      "error",
      {
        type: "warn",
        reason: "not-run-hold",
        ghIssue: id,
        blockedBy: unresolved,
        message: `#${id} ${slice.title}: NOT-RUN — ${hold}`,
      },
    );
  }

  // --- Post-implementation reviews (only if all AFK slices passed) ---
  const afkSlices = [...dag.slices.values()].filter((s) => s.type === "AFK");
  const allPassed = afkSlices.every((s) => completed.has(s.ghIssue));

  /** Every slice merged, so the branch is ready for the ship gates. */
  const readyForShipGates = allPassed && afkSlices.length > 0;

  if (readyForShipGates && signal?.aborted) {
    // Cancelled in the window between the last merge and the post-merge
    // phase: every slice passed, but nothing gated or reviewed the feature
    // branch and no PR opened, so the run did not ship (issue #43). The
    // cancellation exit path itself is untouched — a second Ctrl-C still
    // hard-exits 130 before this is ever read.
    shipBlocker =
      "cancelled before the pre-ship sanity gate and guardian reviews ran";
  }

  if (readyForShipGates && !signal?.aborted) {
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
      git.assertWorktreeRegistered(repoRoot, featBranch, reviewDir);
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
      logger.phase("Running pre-ship sanity gate...", "log");
      // Cache the gate by the reviewed tree's SHA (ADR 0015): a re-entry
      // run against the same content — e.g. after a review infrastructure
      // failure, or when only docs/review commits landed — must not pay
      // the full typecheck+lint+tests cost again. Only PASS is cached.
      const treeShaBefore = git.resolveTree(reviewDir);
      const cachedSanity = runState.reviewPhase?.sanity;
      let sanity: { ok: boolean; failures: string[] };
      if (treeShaBefore && cachedSanity?.treeSha === treeShaBefore) {
        sanity = { ok: true, failures: [] };
        logger.phase(
          `  ↩️  Reusing cached pre-ship sanity PASS for unchanged tree ${treeShaBefore.slice(0, 12)}.`,
          "log",
        );
      } else {
        sanity = runPreShipSanity(reviewDir);
      }
      logger.setSanityGate(sanity);
      if (!sanity.ok) {
        const failedSteps = sanity.failures.join(", ");
        shipBlocker = `pre-ship sanity gate failed (${failedSteps}) — guardian reviews and PR creation were skipped`;
        logger.phase(
          `  ❌ Pre-ship sanity gate failed: ${failedSteps}. Skipping guardian reviews and PR creation.`,
        );
      } else {
        logger.phase("  ✅ Pre-ship sanity gate passed.", "log");

        const reviewRetries =
          config.infrastructureRetries ?? DEFAULT_INFRASTRUCTURE_RETRIES;
        // Reviews inspect diffs and may run narrowly-scoped commands;
        // give them the same generous inactivity budget as generator /
        // evaluator-qa instead of the 180 s provider default that killed
        // the PRD 070 PM review mid-run.
        const reviewIdleTimeoutMs =
          config.commandTimeoutMs ?? SLOW_AGENT_IDLE_TIMEOUT_MS;
        const reviewHeartbeatMs =
          config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
        const runScopeBlock = buildReviewScopeBlock(scope);
        const headShaBefore = git.resolveCommit(reviewDir, "HEAD");

        /**
         * Run one guardian review with ADR 0014-style infrastructure
         * retries. NEVER_RAN / DIED_MID_RUN failures retry within the
         * run; only UNPARSEABLE and real verdicts are terminal. Throws
         * only on cancellation.
         */
        const runGuardianReview = async (
          kind: "architect" | "pm",
        ): Promise<ReviewRunResult> => {
          const role = kind === "architect" ? "architect-review" : "pm-review";
          const label = kind === "architect" ? "Architect" : "PM";
          const reviewFileName =
            kind === "architect" ? "review-architect.md" : "review-pm.md";
          const prompt =
            kind === "architect"
              ? renderPrompt("architect-review", {
                  SPECS_DIR: relSpecsDir,
                  RELEVANT_FILES: relevantFilesBlock,
                })
              : renderPrompt("pm-review", {
                  SPECS_DIR: relSpecsDir,
                  RELEVANT_FILES: relevantFilesBlock,
                  RUN_SCOPE: runScopeBlock,
                });
          let lastFailure: ReviewRunResult = { outcome: "NEVER_RAN" };
          for (let attempt = 1; attempt <= reviewRetries + 1; attempt++) {
            const log = logger.agentLog(
              "all",
              role,
              attempt > 1 ? attempt : undefined,
            );
            let sawOutput = false;
            try {
              await invoke({
                role,
                agent: role,
                // Bare mode: third-party Claude Code plugins (e.g.
                // `superpowers:using-superpowers`) install `SessionStart`
                // hooks that demand the agent invoke a skill before
                // responding. Guardian agents have no skills loaded, so
                // the hook coerces them into emitting a fake `<tool_use>`
                // block as plain text and ending the turn — no review
                // file is ever written. `--bare` strips plugin hooks for
                // this invocation only. See ADR 0011.
                bare: true,
                prompt,
                cwd: reviewDir,
                logStream: log,
                idleTimeoutMs: reviewIdleTimeoutMs,
                idleWarningIntervalMs: reviewHeartbeatMs,
                maxDurationMs: config.maxAgentDurationMs,
                onStreamEvent: () => {
                  sawOutput = true;
                },
              });
            } catch (error) {
              if (isCancelled(error, signal)) throw error;
              const failureClass = artifacts.classifyReviewFailure(
                error,
                sawOutput,
              );
              const message =
                error instanceof Error ? error.message : String(error);
              lastFailure = { outcome: failureClass, detail: message };
              if (attempt <= reviewRetries) {
                logger.phase(
                  `  ⚠️  ${label} review ${failureClass}: ${message}. Infrastructure retry ${attempt}/${reviewRetries}.`,
                );
                continue;
              }
              logger.phase(
                `  ⚠️  ${label} review ${failureClass} after ${attempt} attempt(s): ${message}. No PR will be opened.`,
              );
              return lastFailure;
            } finally {
              await closeAgentLog(log);
            }
            const reviewPath = join(reviewDir, specsDir, reviewFileName);
            const verdict = artifacts.readReviewVerdict(reviewPath);
            if (verdict === "UNPARSEABLE") {
              logger.phase(
                `  ⚠️  Could not parse ${label} review verdict from ${reviewPath} — expected a "**Verdict:** SHIP | ACCEPT-WITH-NOTES | FIX-BEFORE-SHIP" line. Treating as UNPARSEABLE (no PR will be opened).`,
                "warn",
              );
            }
            return { outcome: verdict };
          }
          return lastFailure;
        };

        /** Reuse a favorable verdict recorded against the current HEAD. */
        const reuseCachedReview = (
          cached: { headSha: string; verdict: "SHIP" | "ACCEPT-WITH-NOTES" } | undefined,
          label: string,
        ): ReviewRunResult | undefined => {
          if (cached && headShaBefore && cached.headSha === headShaBefore) {
            logger.phase(
              `  ↩️  Reusing cached ${label} review verdict ${cached.verdict} for unchanged HEAD ${headShaBefore.slice(0, 12)}.`,
              "log",
            );
            return { outcome: cached.verdict };
          }
          return undefined;
        };
        const cachedArch = reuseCachedReview(
          runState.reviewPhase?.architect,
          "architect",
        );
        const cachedPm = reuseCachedReview(runState.reviewPhase?.pm, "PM");

        let archResult: ReviewRunResult;
        let pmResult: ReviewRunResult;
        if (config.serialLanes) {
          // --serial-lanes also serializes the two guardian reviews:
          // operators pass it precisely to avoid concurrent agent
          // processes contending for shared local resources.
          archResult = cachedArch ?? (await runGuardianReview("architect"));
          pmResult = cachedPm ?? (await runGuardianReview("pm"));
        } else {
          const [archSettled, pmSettled] = await Promise.allSettled([
            cachedArch ? Promise.resolve(cachedArch) : runGuardianReview("architect"),
            cachedPm ? Promise.resolve(cachedPm) : runGuardianReview("pm"),
          ]);
          // runGuardianReview only rejects on cancellation — propagate
          // after both settle so neither rejection goes unobserved.
          if (archSettled.status === "rejected") throw archSettled.reason;
          if (pmSettled.status === "rejected") throw pmSettled.reason;
          archResult = archSettled.value;
          pmResult = pmSettled.value;
        }

        logger.setReviewOutcomes(archResult, pmResult);

        // Commit guardian artifacts regardless of verdict (ADR 0015).
        // review-architect.md / review-pm.md and any governance-log
        // append the guardians made are evidence either way; leaving
        // them dirty in the review worktree breaks consumer flows that
        // require a clean tree after the reviewed SHA (e.g. UAT
        // verify-draft) and loses them entirely when the scratch
        // worktree is removed below.
        if (git.hasUncommittedChanges(reviewDir)) {
          try {
            git.commitAll(
              reviewDir,
              `docs(${prdSlug}): add post-impl guardian reviews`,
            );
          } catch (error) {
            // On Windows, `git status` can report phantom modifications
            // when only line endings differ; `git add` normalizes them
            // away and the commit fails with "nothing to commit". If the
            // tree is clean after the attempt there was nothing real to
            // record — any other failure must surface.
            if (git.hasUncommittedChanges(reviewDir)) throw error;
          }
        }

        // Refresh the cheap re-entry cache (ADR 0015) against the
        // post-commit state: the review commit is docs-only, so a
        // passing sanity gate carries over to the new tree, and
        // favorable verdicts are recorded against the new HEAD so an
        // unchanged re-entry can skip them.
        const headShaAfter = git.resolveCommit(reviewDir, "HEAD");
        const treeShaAfter = git.resolveTree(reviewDir);
        const nextReviewPhase: PersistedReviewPhase = {};
        if (sanity.ok && treeShaAfter) {
          nextReviewPhase.sanity = { treeSha: treeShaAfter, ok: true };
        }
        if (headShaAfter) {
          if (artifacts.isFavorableReviewOutcome(archResult.outcome)) {
            nextReviewPhase.architect = {
              headSha: headShaAfter,
              verdict: archResult.outcome,
            };
          }
          if (artifacts.isFavorableReviewOutcome(pmResult.outcome)) {
            nextReviewPhase.pm = {
              headSha: headShaAfter,
              verdict: pmResult.outcome,
            };
          }
        }
        saveReviewPhase(
          repoRoot,
          loggerSlug,
          Object.keys(nextReviewPhase).length > 0
            ? nextReviewPhase
            : undefined,
        );

        // Create the draft PR when both reviews are favorable, or when
        // the operator explicitly overrides an unfavorable PM verdict
        // (--open-pr-on-override, ADR 0015).
        const prPlan = buildPrCreationPlan({
          prdSlug,
          specsDir,
          architect: archResult.outcome,
          pm: pmResult.outcome,
          openPrOnOverride: config.openPrOnOverride === true,
          closesIssues: scope.selected.map((slice) => slice.ghIssue),
        });
        if (!prPlan.open) {
          // No shippable branch: an unfavorable verdict, or an absent one
          // (UNPARSEABLE / an exhausted infrastructure retry). Either way
          // the operator has something to do, so the run is unsuccessful.
          shipBlocker = `guardian verdicts kept the draft PR closed (architect: ${archResult.outcome}, PM: ${pmResult.outcome})`;
        } else {
          if (prPlan.overridden) {
            logger.phase(`  ⚠️  ${prPlan.overrideNote}`, "warn");
            logger.setPrOverrideNote(prPlan.overrideNote!);
          }
          try {
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
                prPlan.title,
                "--body",
                prPlan.body,
              ],
              { cwd: repoRoot, encoding: "utf-8" },
            ).trim();
            draftPrUrl = prUrl;
            draftPrNumber = parseDraftPrNumber(prUrl);
            logger.setPrUrl(prUrl);
          } catch {
            // Creation may fail because a PR already exists for this branch.
            // Recover its URL so resumed runs still produce complete handoff data.
            try {
              const existing = JSON.parse(
                execFileSync(
                  "gh",
                  ["pr", "view", featBranch, "--json", "number,url"],
                  { cwd: repoRoot, encoding: "utf-8" },
                ),
              ) as { number?: number; url?: string };
              if (existing.url) {
                draftPrUrl = existing.url;
                draftPrNumber =
                  existing.number ?? parseDraftPrNumber(existing.url);
                logger.setPrUrl(existing.url);
              }
            } catch {
              // PR creation and lookup are best-effort.
            }
          }
        }
      }
    } finally {
      if (cleanupReviewDir) {
        git.removeWorktree(repoRoot, reviewDir);
      }
    }
  }

    // A run that handed no slice to a wave, skipped none as already
    // complete, and recovered no deferred merge did nothing at all. Without this it can report success —
    // an empty selection satisfies `every` vacuously — and a 0m00s no-op
    // reads exactly like a finished run (issue #42). Cancellation is
    // excluded: Ctrl-C keeps its own exit path, and a run cancelled
    // before its first wave is not a silent no-op.
    let zeroDispatchReason: string | undefined;
    if (
      !signal?.aborted &&
      dispatched.size === 0 &&
      alreadyComplete.size === 0 &&
      recoveredMerges.size === 0
    ) {
      const holds = notRunHolds.map(
        ({ id, title, hold }) => `  #${id} ${title} — ${hold}`,
      );
      zeroDispatchReason = [
        "Pipeline dispatched no slices and skipped none as already complete — nothing ran.",
        ...(holds.length > 0
          ? [...holds, "Fix the blocker(s) and re-run."]
          : ["No slice in the run scope was eligible to run."]),
      ].join("\n");
      logger.phase(`[afk] ${zeroDispatchReason}`, "error");
    }

    const summary = logger.writeSummary();
    const consoleSummary = logger.formatConsoleSummary();
    // Every slice passing is necessary but not sufficient: a ship blocker
    // or a zero-dispatch reason means the run must not exit 0.
    const failureReason = zeroDispatchReason ?? shipBlocker;
    const allSuccess = allPassed && failureReason === undefined;
    emitHandoff(
      signal?.aborted ? "ABORTED" : allSuccess ? "SUCCEEDED" : "FAILED",
    );

    return {
      success: allSuccess,
      summary,
      consoleSummary,
      failureReason,
    };
  } catch (err) {
    // Mark any slice still in flight as STUCK so the summary doesn't
    // misreport them as RUNNING/PENDING. Status keys we touch here
    // are the only mutation; persistent run-state already reflects
    // whatever progress slice loops were able to record.
    for (const slice of scope?.selected ?? []) {
      const id = slice.ghIssue;
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
    try {
      emitHandoff("ABORTED");
    } catch {
      // Best effort on an already-failing path.
    }
    const partial: PipelineResult = {
      success: false,
      summary,
      consoleSummary,
    };
    throw new PipelineError(err, partial);
  }
}

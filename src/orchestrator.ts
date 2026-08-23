import { join } from "node:path";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
  statSync,
  type WriteStream,
} from "node:fs";
import { finished } from "node:stream/promises";
import { buildDAG, type Slice, type DAG } from "./issues-parser.js";
import * as git from "./git.js";
import { kiroProvider } from "./kiro.js";
import type { AgentProvider } from "./agent-provider.js";
import { CancelledError, isTransientProviderError } from "./agent-provider.js";
import { withTransientRetry, type TransientRetryOptions } from "./transient-retry.js";
import * as artifacts from "./artifacts.js";
import { RunJournal, type TerminalOutcome } from "./run-journal.js";
import { renderPrompt } from "./prompt-template.js";
import { readRelevantFiles, formatRelevantFiles, readSliceFile } from "./prd-reader.js";
import { runWave, type WaveOutcome } from "./wave.js";
import {
  buildResumeHandoffNote,
  buildStuckDiagnosisNote,
  collectResumeFacts,
  decideResume,
  isForceRestarted,
  isResumeStuckRequested,
} from "./resume.js";
import {
  lifecycle,
  type SliceIdentity,
} from "./slice-lifecycle.js";
import { DEFAULT_MAX_CONTRACT_ROUNDS } from "./cli-options.js";

import {
  runHeartbeatCommand,
  withCrossProcessLock,
} from "./command-runtime.js";
import {
  loadRunState,
  saveRunState,
  isSliceComplete,
  getResumeAttempts,
  recordRetryDecision,
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
import {
  resolveSanityCommands,
  resolveTestCommand,
} from "./preship.js";
import { buildReviewScopeBlock, runShipGate } from "./ship-gate.js";
import {
  DEFAULT_MIGRATION_VALIDATION,
  sliceTouchedMigrations,
  verifyMigrationSync,
  type MigrationValidation,
} from "./migration-gate.js";

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

  /** Slices forced to restart from base regardless of resume eligibility (#37). */
  forceRestart?: string[];
  /** STUCK slices granted one more attempt on their preserved tree (#49). */
  resumeStuck?: string[];
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
  logger: RunJournal;
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
   * Set by `runSliceNegotiate` when the slice resumed from its
   * surviving branch tip instead of restarting from base (spec #33).
   * Drives the round-1 generator prompt: a resumed generator gets a
   * resume template (own commit log, verify-then-continue) instead of
   * the normal one. Absent for fresh and restarted slices.
   */
  resume?: {
    /**
     * Which resume this is, selecting the round-1 generator template.
     *
     * - `killed` — the default path (#33): the previous invocation died
     *   mid-run, so the tree was reset to its last commit and refreshed
     *   from the feature branch before the generator was handed
     *   `generator-resume`.
     * - `stuck` — the operator opted in with `--resume-stuck` (#49): the
     *   tree was left untouched, the stuck.md diagnosis survives, and
     *   the generator is handed `generator-resume-stuck`. The two are
     *   distinct templates because their situation sections state
     *   opposite facts about the worktree.
     */
    mode: "killed" | "stuck";
    /** Commits on the slice branch beyond the feature-branch base. */
    commitsAhead: number;
    /** `git log <base>..HEAD --stat` output for the resume prompt. */
    commitLog: string;
    /** Prior handoff.md block, or "" when stale/absent (#38). */
    handoffNote: string;
    /** `stuck` only — the preserved stuck.md diagnosis block (#49). */
    stuckNote?: string;
    /**
     * `stuck` only — whether the feature branch was merged in. False
     * when the refresh was declined to keep the preserved tree intact;
     * the prompt then says the verification world is stale rather than
     * claiming a merge that did not happen.
     */
    baseRefreshed?: boolean;
  };
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
  logger: RunJournal,
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
 * Create, resume, or deliberately recreate the slice worktree at
 * negotiate time (spec #33, design note on #15).
 *
 * On retry of a failed slice the surviving git state decides:
 * - **resume** — branch alive with commits beyond base in a registered
 *   worktree: re-attach, discard uncommitted changes (hard reset +
 *   clean, sparing the untracked slice artifacts so the locked
 *   contract survives verbatim), refresh the base by merging the
 *   current feature branch into the resumed branch (#35), and record
 *   the resume on `ctx.resume` so Phase B hands the generator the
 *   resume prompt. A refresh conflict falls back to restart — no agent
 *   is asked to resolve a merge it has no context for.
 * - **resume-stuck** — the operator named a STUCK slice in
 *   `--resume-stuck` (#49) and its preserved branch, registered
 *   worktree, and commits ahead of base all check out: re-attach and
 *   grant one more implementation/QA attempt *without* resetting or
 *   cleaning the tree and without deleting its stuck.md. The base
 *   refresh is still attempted, but a conflict here does NOT fall back
 *   to restart — the whole point of the opt-in is that this tree
 *   survives, so the refresh is simply declined and the generator is
 *   told its verification world is stale.
 * - **restart** — branch or worktree missing, or nothing committed:
 *   recreate from base deliberately. Today's accidental behavior
 *   (branch creation no-ops for existing branches, silently
 *   re-attaching to the old tip) must never restart implicitly.
 * - **fresh** — no evidence of a prior attempt: the normal first-run
 *   creation path, unchanged and unlogged.
 *
 * Every resume/restart decision is announced on console + run.log
 * (`resuming from <n> commits` / `restarting from base (<reason>)`)
 * so overnight runs are auditable.
 *
 * ADR 0010 holds throughout: a stale unregistered directory is never
 * auto-deleted (`createWorktree` throws its descriptive error), and
 * every path ends registered-and-asserted before agent dispatch.
 */
export function prepareSliceWorktree(ctx: SliceContext): void {
  const { repoRoot } = ctx.config;
  const provider = ctx.config.provider ?? kiroProvider;
  const runSlug = pipelineRunSlug(ctx.config.prdSlug, provider);
  const ghIssue = ctx.slice.ghIssue;
  const priorAttempts = getResumeAttempts(
    loadRunState(repoRoot, runSlug),
    ghIssue,
  );
  const facts = collectResumeFacts(
    repoRoot,
    ctx.branch,
    ctx.worktreeDir,
    ctx.featBranch,
    {
      sliceDir: ctx.absSliceDir,
      resumeAttempts: priorAttempts,
      forceRestart: isForceRestarted(ctx.config.forceRestart, ctx.slice),
      resumeStuck: isResumeStuckRequested(ctx.config.resumeStuck, ctx.slice),
    },
  );
  const plan = decideResume(facts);

  // Restart teardown + bookkeeping shared by the decision's restart
  // path and the refresh-conflict fallback. The attempt counter resets:
  // a fresh tree earns a fresh resume budget (#36).
  const restartFromBase = (reason: string): void => {
    ctx.logger.phase(`${ctx.tag}: restarting from base (${reason})`);
    git.recreateWorktreeFromBase(
      repoRoot,
      ctx.branch,
      ctx.worktreeDir,
      ctx.featBranch,
    );
    recordRetryDecision(repoRoot, runSlug, ghIssue, {
      attempts: 0,
      lastDecision: `restarted from base (${reason})`,
    });
  };

  if (plan.action === "resume") {
    git.resetWorktreeToHead(ctx.worktreeDir, [ctx.relSpecsDir]);
    // Capture the slice's OWN commit log and last-commit time before
    // the refresh merge — afterwards the feature branch's commits (and
    // the merge commit's fresh timestamp) would pollute both.
    const commitLog = git.logCommitsWithStat(ctx.worktreeDir, ctx.featBranch);
    const handoffNote = buildResumeHandoffNote(
      join(ctx.absSliceDir, "handoff.md"),
      git.lastCommitEpochSeconds(ctx.worktreeDir),
    );
    // Base refresh (#35): merge the current feature branch into the
    // resumed branch, inside the worktree, so the generator verifies
    // against the world it will eventually merge into.
    const refresh = git.mergeBranchIntoWorktree(ctx.worktreeDir, ctx.featBranch);
    if (refresh.status === "conflict") {
      restartFromBase("feature merge conflict");
    } else {
      ctx.resume = {
        mode: "killed",
        commitsAhead: plan.commitsAhead,
        commitLog,
        handoffNote,
      };
      recordRetryDecision(repoRoot, runSlug, ghIssue, {
        attempts: priorAttempts + 1,
        lastDecision: `resumed from ${plan.commitsAhead} commit(s)`,
      });
      ctx.logger.phase(
        `${ctx.tag}: resuming from ${plan.commitsAhead} commit(s) on ${ctx.branch}`,
      );
    }
  } else if (plan.action === "resume-stuck") {
    // No resetWorktreeToHead here, deliberately: the operator opted in
    // to keep this tree exactly as they inspected it, uncommitted edits
    // included. The generator-resume-stuck prompt tells the generator to
    // read `git status` first rather than assuming a clean tip.
    const commitLog = git.logCommitsWithStat(ctx.worktreeDir, ctx.featBranch);
    const handoffNote = buildResumeHandoffNote(
      join(ctx.absSliceDir, "handoff.md"),
      git.lastCommitEpochSeconds(ctx.worktreeDir),
    );
    const stuckNote = buildStuckDiagnosisNote(join(ctx.absSliceDir, "stuck.md"));
    // Base refresh is best-effort here. `mergeBranchIntoWorktree` aborts
    // on failure, leaving the branch tip and worktree byte-identical —
    // so a conflict, or a dirty tree git refuses to merge over, costs
    // only the refresh. Restarting from base instead (the #33 fallback)
    // would destroy the preserved work this flag exists to protect.
    const refresh = git.mergeBranchIntoWorktree(ctx.worktreeDir, ctx.featBranch);
    const baseRefreshed = refresh.status === "merged";
    ctx.resume = {
      mode: "stuck",
      commitsAhead: plan.commitsAhead,
      commitLog,
      handoffNote,
      stuckNote,
      baseRefreshed,
    };
    recordRetryDecision(repoRoot, runSlug, ghIssue, {
      attempts: priorAttempts + 1,
      lastDecision:
        `resumed STUCK tree from ${plan.commitsAhead} commit(s) via --resume-stuck` +
        (baseRefreshed ? "" : " (base refresh declined to preserve the tree)"),
    });
    const message =
      `resuming STUCK slice from ${plan.commitsAhead} commit(s) on ${ctx.branch} ` +
      `(--resume-stuck: tree not reset, diagnosis preserved)` +
      (baseRefreshed
        ? ""
        : `; base refresh declined — ${ctx.featBranch} did not merge cleanly, ` +
          `verification world is stale`);
    ctx.logger.phase(`${ctx.tag}: ${message}`, "error", {
      type: "warn",
      reason: "resume-stuck",
      ghIssue,
      message,
    });
  } else if (plan.action === "restart") {
    if (existsSync(ctx.worktreeDir) && !facts.worktreeRegistered) {
      // ADR 0010: never auto-delete a stale directory. createWorktree
      // throws the descriptive stale-dir error for exactly this state,
      // telling the operator to inspect and remove it manually.
      git.createWorktree(repoRoot, ctx.branch, ctx.worktreeDir, ctx.featBranch);
    }
    // A registered worktree already sitting clean on the base tip needs
    // no teardown — this is the lane-successor refresh arriving right
    // after its own recreateWorktreeFromBase. Recreating again would be
    // wasted work and a misleading "restarting" line in the run log.
    // A genuine retry can also land here (death before the first
    // commit, nothing dirty): its worktree is literally identical to a
    // fresh one, and the retry itself is already announced by
    // runPipeline's "Retrying #id (previous run: ...)" line.
    const alreadyAtBase =
      facts.worktreeRegistered &&
      git.resolveCommit(repoRoot, ctx.branch) ===
        git.resolveCommit(repoRoot, ctx.featBranch) &&
      !git.hasUncommittedChanges(ctx.worktreeDir);
    if (!alreadyAtBase) {
      restartFromBase(plan.reason);
    }
  } else {
    git.createWorktree(repoRoot, ctx.branch, ctx.worktreeDir, ctx.featBranch);
  }

  git.assertWorktreeRegistered(repoRoot, ctx.branch, ctx.worktreeDir);
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

  logger.trackSlice(
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
      return { phase: "CANCELLED" };
    }
    const cause = negotiateFailureCauseOf(err) ?? internalNegotiateCause(err);
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
): Promise<Extract<TerminalOutcome, { phase: "PASS" | "STUCK" | "ERROR" | "CANCELLED" }>> {
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
      const generatorPrompt =
        round === 1 && ctx.resume?.mode === "stuck"
          ? renderPrompt("generator-resume-stuck", {
              SLICE_DIR: ctx.relSliceDir,
              RELEVANT_FILES: ctx.relevantFilesBlock,
              SIBLING_HANDOFFS: ctx.siblingHandoffsBlock,
              TEST_COMMAND: ctx.testCommand,
              COMMITS_AHEAD: ctx.resume.commitsAhead,
              COMMIT_LOG: ctx.resume.commitLog,
              BASE_REFRESH_NOTE: ctx.resume.baseRefreshed
                ? `The feature branch \`${featBranch}\` was merged into your branch just\nbefore this run, so your verification world is current.`
                : `The feature branch \`${featBranch}\` could **not** be merged into your\nbranch cleanly, and your tree was preserved rather than rebuilt. Your\nverification world may be behind the feature branch — do not assume\nsibling work is visible here.`,
              STUCK_NOTE: ctx.resume.stuckNote ?? "",
              HANDOFF_NOTE: ctx.resume.handoffNote,
            })
          : round === 1 && ctx.resume
          ? renderPrompt("generator-resume", {
              SLICE_DIR: ctx.relSliceDir,
              RELEVANT_FILES: ctx.relevantFilesBlock,
              SIBLING_HANDOFFS: ctx.siblingHandoffsBlock,
              TEST_COMMAND: ctx.testCommand,
              COMMITS_AHEAD: ctx.resume.commitsAhead,
              COMMIT_LOG: ctx.resume.commitLog,
              FEAT_BRANCH: featBranch,
              HANDOFF_NOTE: ctx.resume.handoffNote,
            })
          : renderPrompt("generator", {
              SLICE_DIR: ctx.relSliceDir,
              RELEVANT_FILES: ctx.relevantFilesBlock,
              SIBLING_HANDOFFS: ctx.siblingHandoffsBlock,
              TEST_COMMAND: ctx.testCommand,
              RETRY_NOTE: round > 1
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
            return {
              phase: "STUCK",
              error: `Migration sync check failed: ${migrationCheck.error}`,
            };
          }
        }

        logger.phase(`${ctx.tag}: deterministic QA and configured UAT pass — committed`);
        return { phase: "PASS" };
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
        return {
          phase: "STUCK",
          error: `QA failed after ${MAX_GENERATOR_ROUNDS} implementation rounds`,
        };
      }
    }
    return {
      phase: "STUCK",
      error: `QA failed after ${MAX_GENERATOR_ROUNDS} implementation rounds`,
    };
  } catch (err) {
    if (isCancelled(err, signal)) {
      return { phase: "CANCELLED", error: "Cancelled by user" };
    }
    const message = err instanceof Error ? err.message : String(err);
    // A wall-clock ceiling kill is terminal by design, not an
    // infrastructure failure: a retry restarts the round from scratch
    // against the same ceiling and doubles the wasted wall-clock.
    // Point the operator at the remedy instead. Committed work is
    // preserved on the slice branch. See ADR 0019.
    return {
      phase: "ERROR",
      error: /wall-clock ceiling/.test(message)
        ? `${message}. Terminal by design (ADR 0019): committed work is preserved on ${ctx.branch}; rerun with a larger --max-agent-duration-ms.`
        : message,
    };
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
  logger: RunJournal,
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
  return (await runSliceExecute(ctx)).phase;
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
  const logger = new RunJournal(repoRoot, loggerSlug);
  // First run.log line — tells the operator where this run's logs live
  // and gives `tail -f` a stable target from second zero.
  logger.phase(
    `[afk] Pipeline run started (${provider.name}) — logs: ${logger.runDir}`,
    "error",
    {
      type: "run-started",
      provider: provider.name,
      runSlug: loggerSlug,
      contractRoundLimit:
        config.maxContractRounds ?? DEFAULT_MAX_CONTRACT_ROUNDS,
      implementationRoundLimit: MAX_GENERATOR_ROUNDS,
    },
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
      logger.trackSlice(
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
      logger.restoreCompleted({ ghIssue: id, title: slice.title, branch });
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

  // `runWave` reports terminal outcomes at the moment they land. The
  // journal turns that one report into the lifecycle, run-state, run-log,
  // and typed-event projections, and owns retry idempotency.
  const persistOutcome = (id: string, outcome: WaveOutcome) => {
    const slice = dag.slices.get(id)!;
    logger.recordTerminal(
      {
        ghIssue: id,
        title: slice.title,
        branch: sliceBranch(prdSlug, slice, provider),
      },
      outcome,
    );
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
      logger.recordTerminal(sliceId, {
        phase: "MERGE-PENDING",
        error: git.mergePendingReason(attempt.prefixes, featBranch),
        collidingPrefixes: attempt.prefixes,
      });
      mergePending.add(id);
      continue;
    }

    // A real merge conflict is a different animal: it needs a human, and
    // CONFLICT keeps meaning exactly that.
    if (attempt.result.status === "conflict") {
      logger.recordTerminal(sliceId, {
        phase: "CONFLICT",
        error: attempt.result.details,
      });
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
    logger.recordTerminal(sliceId, { phase: "PASS", recovered: true });
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
    logger.event({ type: "wave-completed", wave: waveNumber });

    // If cancelled, mark anything not yet completed/failed as CANCELLED
    // and exit the wave loop. Worktrees are preserved on disk so a
    // re-run resumes from the artifact state. See ADR 0003.
    if (signal?.aborted) {
      for (const [id, slice] of dag.slices) {
        if (slice.type === "HITL") continue;
        if (completed.has(id) || failed.has(id)) continue;
        const branch = sliceBranch(prdSlug, slice, provider);
        logger.recordTerminal(
          { ghIssue: id, title: slice.title, branch },
          { phase: "CANCELLED", error: "Cancelled by user" },
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

  // --- Post-implementation ship gate (only if all AFK slices passed) ---
  const afkSlices = [...dag.slices.values()].filter((s) => s.type === "AFK");
  const allPassed = afkSlices.every((s) => completed.has(s.ghIssue));
  const readyForShipGate = allPassed && afkSlices.length > 0;

  if (readyForShipGate) {
    const invokeShipGate = (reviewDir: string) =>
      runShipGate({
        repoRoot,
        reviewDir,
        featureBranch: featBranch,
        defaultBranch,
        prdSlug,
        runSlug: loggerSlug,
        specsDir,
        relevantFilesBlock,
        reviewScope: buildReviewScopeBlock(scope!),
        closesIssues: scope!.selected.map((slice) => slice.ghIssue),
        cachedReviewPhase: runState.reviewPhase,
        invoke,
        journal: logger,
        options: {
          reviewRetries:
            config.infrastructureRetries ?? DEFAULT_INFRASTRUCTURE_RETRIES,
          reviewIdleTimeoutMs:
            config.commandTimeoutMs ?? SLOW_AGENT_IDLE_TIMEOUT_MS,
          reviewIdleWarningIntervalMs:
            config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
          maxAgentDurationMs: config.maxAgentDurationMs,
          serialReviews: config.serialLanes === true,
          openPrOnOverride: config.openPrOnOverride === true,
        },
        signal,
      });

    let shipResult;
    if (signal?.aborted) {
      // runShipGate returns the issue #43 blocked-ship result before touching
      // the placeholder review directory.
      shipResult = await invokeShipGate(repoRoot);
    } else {
      // Prefer an existing feature-branch checkout. Git refuses to check out
      // the same branch in a second worktree, so create a scratch review
      // worktree only when needed.
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
        shipResult = await invokeShipGate(reviewDir);
      } finally {
        if (cleanupReviewDir) {
          git.removeWorktree(repoRoot, reviewDir);
        }
      }
    }

    shipBlocker = shipResult.failureReason;
    draftPrUrl = shipResult.pr.url;
    draftPrNumber = shipResult.pr.number;
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
    const runOutcome = signal?.aborted
      ? "ABORTED"
      : allSuccess
        ? "SUCCEEDED"
        : "FAILED";
    logger.event({ type: "run-ended", outcome: runOutcome });
    emitHandoff(runOutcome);

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
    logger.summarizeAborted(
      (scope?.selected ?? []).map((slice) => ({
        ghIssue: slice.ghIssue,
        title: slice.title,
        branch: logger.getSlice(slice.ghIssue)?.branch ?? "",
      })),
      "Pipeline aborted before slice finished",
    );
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
    logger.event({
      type: "run-ended",
      outcome: signal?.aborted ? "ABORTED" : "FAILED",
    });
    const partial: PipelineResult = {
      success: false,
      summary,
      consoleSummary,
    };
    throw new PipelineError(err, partial);
  }
}

import { basename, join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
  type WriteStream,
} from "node:fs";
import { finished } from "node:stream/promises";
import { buildDAG, type Slice, type DAG } from "./issues-parser.js";
import * as git from "./git.js";
import { kiroProvider } from "./kiro.js";
import type { AgentProvider, InvokeOptions } from "./agent-provider.js";
import { CancelledError, isTransientProviderError } from "./agent-provider.js";
import { withTransientRetry, type TransientRetryOptions } from "./transient-retry.js";
import * as artifacts from "./artifacts.js";
import {
  withContractTransaction,
  type ContractTransaction,
} from "./contract-transaction.js";
import { RunJournal, type TerminalOutcome } from "./run-journal.js";
import { renderPrompt } from "./prompt-template.js";
import { readRelevantFiles, formatRelevantFiles, readSliceFile } from "./prd-reader.js";
import { runWave, type WaveOutcome } from "./wave.js";
import {
  buildResumeHandoffNote,
  buildStuckDiagnosisNote,
  collectResumeFacts,
  decideResume,
  formatRestartRefusal,
  isForceRestarted,
  isResumeStuckRequested,
} from "./resume.js";
import {
  lifecycle,
  type SliceIdentity,
} from "./slice-lifecycle.js";
import { DEFAULT_MAX_CONTRACT_ROUNDS } from "./cli-options.js";
import {
  computeSliceBounds,
  formatSliceBounds,
  implementationRoundsRemaining,
} from "./bounds.js";
import {
  DEFAULT_MIN_FREE_DISK_GB,
  formatPreflightRefusal,
  formatPreflightReport,
  gbToBytes,
  runLaunchPreflight,
  type RunNamespace,
} from "./preflight.js";
import {
  clearStopSentinel,
  createStopSentinelWatcher,
  runIdFor,
  writeStopAck,
} from "./stop-sentinel.js";
import {
  crashRecorderFor,
  type CrashRecorderRegistrar,
} from "./crash-records.js";

import {
  ProcessTreeTerminationError,
  runHeartbeatCommand,
  withCrossProcessLock,
} from "./command-runtime.js";
import {
  createCandidateCheckpoint,
  resolveCandidateTreeId,
  runGates,
  verifyGateEvidence,
  type GateDeclaration,
  type GateEvidence,
  type GateEvidenceArtifact,
  type GateResult,
} from "./gate-runner.js";
import {
  authorizeBaseGateSkip,
  formatBaseGateSkipAuthorization,
  type BaseGateSkipAuthorization,
} from "./qa-gate-authorization.js";
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
  resolveGeneratorTestCommand,
  resolveSanityCommands,
  resolveSanityPlan,
} from "./preship.js";
import { buildReviewScopeBlock, runShipGate } from "./ship-gate.js";
import {
  DEFAULT_MIGRATION_VALIDATION,
  sliceTouchedMigrations,
  verifyMigrationSync,
  type MigrationValidation,
} from "./migration-gate.js";
import type { AfkManifest } from "./afk-manifest.js";
import {
  assertWithinManifestScope,
  trimUnclaimedMigrationPrefixes,
} from "./afk-manifest.js";
import {
  checkClaimedGeneratedMigrations,
  initializeMigrationClaims,
  migrationClaimFor,
  releaseUnmergedMigrationClaims,
} from "./migration-claims.js";
import {
  ACCEPTANCE_MANIFEST_FILENAME,
  acceptanceManifestPaths,
  loadAcceptanceManifest,
  normalizeAcceptanceManifestPath,
  type AcceptanceManifest,
  type AcceptanceManifestV2,
  validateAcceptanceManifestBindings,
  validateAcceptanceManifestCoverage,
  validateAcceptanceManifestStability,
} from "./acceptance-manifest.js";
import {
  CONTRACT_RESPONSE_FILENAME,
  CONTRACT_REVIEW_FILENAME,
  CONTRACT_NEGOTIATION_OUTCOME_FILENAME,
  buildContractNegotiationOutcome,
  buildContractReviewAttemptRecord,
  contractReviewGapMetrics,
  formatContractReviewFindings,
  loadContractResponse,
  loadContractReview,
  openContractReviewFindings,
  type ContractResponse,
  type ContractNegotiationOutcome,
  type ContractRevisionArtifacts,
  type ContractReview,
  type ContractReviewAttemptRecord,
  type ContractReviewFinding,
  type RecordedContractVerdict,
  validateRound1ContractReview,
  validateRound2ContractReview,
} from "./contract-review.js";
import {
  ADJUDICATION_DECISIONS_FILENAME,
  ADJUDICATION_FILENAME,
  adjudicatedLockIsProven,
  appendAdjudicationDecision,
  impasseFingerprint,
  loadAdjudicationDecisionLog,
  markAdjudicationDecisionsApplied,
  parseAdjudication,
  reconcileDiscardedDecisionLog,
  undecidedContestedFindingIds,
  unresolvedBlockingFindingIds,
  waitForAdjudication,
  type Adjudication,
  type AdjudicationWaitResult,
} from "./adjudication.js";
import {
  advanceQAReviewHistory,
  buildQAReviewAttemptRecord,
  loadQAReview,
  loadQAReviewResumeState,
  qaReviewFilename,
  scopeAmendmentRequests,
  spentImplementationRounds,
  type QAReview,
  type QAReviewAttemptFinding,
  type QAReviewLifecycleFinding,
  type QAReviewStage,
} from "./qa-review.js";
import {
  applyScopeAmendment,
  buildScopeAmendmentRecord,
  planScopeAmendment,
} from "./scope-amendment.js";
import {
  ESCALATION_FILENAME,
  outOfScopeChangedPaths,
  parseScopeEscalation,
} from "./escalation.js";

const MAX_GENERATOR_ROUNDS = 3;
const DEFAULT_ADJUDICATION_WAIT_MS = 60_000;
const DEFAULT_ADJUDICATION_POLL_MS = 1_000;

/**
 * Scope amendments granted per QA stage per round (#112).
 *
 * One, because the tree does not change between attempts in a round —
 * only the contract does. An evaluator that asks for a second amendment
 * after the first has landed is reporting a file it should have seen in
 * the same pass, and granting attempt after attempt on that basis is a
 * loop with no source change in it (ADR 0041). The next round's
 * generator work earns a fresh grant.
 */
const MAX_SCOPE_AMENDMENTS_PER_ROUND = 1;

/**
 * Focused scope revisions granted per implementation round (ADR 0050).
 *
 * The generator's escalation loop deliberately does not spend an
 * implementation round: the generator stopped *before* an undeclared
 * edit, so re-dispatching it under a widened contract is the same round's
 * work continuing. That is what made it unbounded — a generator that
 * discovers one undeclared path at a time could run fresh generator,
 * planner and contract-evaluator invocations forever without consuming
 * any budget, which is the loop ADR 0041 says an uncertain branch must
 * not take.
 *
 * Two, not one: unlike a QA scope amendment (ADR 0048), the tree *does*
 * change between escalations here — the generator commits work, then
 * stops at the next boundary — so a second genuinely distinct discovery
 * is honest work rather than a re-report of what the first pass should
 * have seen. A third in the same round is a generator trickling paths
 * instead of declaring the scope it needs; the round ends with a
 * persisted reason and the next round's escalations earn a fresh grant.
 */
const MAX_SCOPE_REVISIONS_PER_ROUND = 2;
const WAVE_TRANSITION_TIMEOUT_MS = 30_000;
/**
 * Persisted reason on every slice a cancellation stops, whether it was
 * marked when the signal fired or when its wave unwound (#114). One
 * string so the two paths cannot drift into two operator-visible reasons
 * for one stop.
 */
const CANCELLED_BY_USER = "Cancelled by user";
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
const DEFAULT_BASE_GATE_WALL_CLOCK_TIMEOUT_MS = 7_200_000;

/**
 * Invocation bounds for the long-command roles — generator and
 * evaluator-qa (including its shared-preview UAT stage), the roles
 * that legitimately shell out to a full test suite. One home for the
 * role→policy mapping: these roles get the slow-agent wall-clock
 * ceiling (ADR 0019) and earn busy-probe idle-kill deferral
 * (ADR 0021, ADR 0037); every other role keeps provider defaults and
 * the plain idle timeout.
 */
function longCommandRoleBounds(bounds: {
  idleTimeoutMs: number;
  idleWarningIntervalMs: number;
  maxDurationMs: number | undefined;
}): Pick<
  InvokeOptions,
  | "idleTimeoutMs"
  | "idleWarningIntervalMs"
  | "maxDurationMs"
  | "deferIdleKillWhenBusy"
> {
  return {
    idleTimeoutMs: bounds.idleTimeoutMs,
    idleWarningIntervalMs: bounds.idleWarningIntervalMs,
    maxDurationMs: bounds.maxDurationMs ?? SLOW_AGENT_MAX_DURATION_MS,
    deferIdleKillWhenBusy: true,
  };
}

const BASE_GATE_IDS = ["typecheck", "lint", "tests"] as const;

/**
 * Derive the policy-less base gate set shared by every agent provider. Reads
 * the same sanity plan the pre-ship gate executes (ADR 0012), so a gate and
 * the aggregate check cannot disagree about which script backs a step.
 */
export function resolveBaseGateDeclarations(cwd: string): GateDeclaration[] {
  const stepsByGate = new Map(
    resolveSanityPlan(cwd).steps.map((step) => [step.name, step]),
  );

  return BASE_GATE_IDS.map((id) => {
    const step = stepsByGate.get(id);
    return {
      id,
      stage: "base",
      required: step != null,
      ...(step ? { command: step.command, args: [...step.args] } : {}),
    };
  });
}

function formatBaseGateCatalog(catalog: readonly GateDeclaration[]): string {
  return catalog
    .map((gate) => {
      const command = gate.command
        ? [gate.command, ...(gate.args ?? [])].join(" ")
        : "(not executable)";
      return `- ${gate.id}: ${command}`;
    })
    .join("\n");
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
  /** Parsed `<prd-dir>/afk.json`; absent preserves legacy behavior. */
  manifest?: AfkManifest | null;
  /** Contract negotiation cap, bounded by the global two-round limit. */
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
  /**
   * The command the generator is told to verify with while it iterates,
   * overriding the `package.json` script `resolveTestCommand` would
   * pick. Does not reach the sanity gate or the QA evaluator — the
   * whole-suite guarantee moves per-checkpoint, not away. See ADR 0038.
   */
  testCommand?: string;
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
   * Free-space floor the launch preflight refuses below, in GB. Defaults
   * to `DEFAULT_MIN_FREE_DISK_GB`; 0 disables the floor. See ADR 0042.
   */
  minFreeDiskGb?: number;
  /**
   * Run the launch preflight but never let it refuse the launch. The
   * bypass is recorded in `run.log` — a preflight nobody can override
   * would be disabled permanently, and one nobody records would hide the
   * state the run started in.
   */
  preflightReportOnly?: boolean;

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
  /**
   * Fires the same abort path a stop signal fires. Supplied by the CLI,
   * which owns the `AbortController` behind `signal` — the pipeline only
   * ever sees the read-only half, so it needs a way to ask.
   *
   * Its presence is what enables the `afk stop` sentinel poll: a caller
   * that cannot be cancelled has nothing to poll for. See
   * `src/stop-sentinel.ts` and ADR 0043.
   */
  requestCancellation?: () => void;
  /** Sentinel poll interval override. Exists for tests. */
  stopSentinelIntervalMs?: number;
  /** Bounded adjudication hold. Private test seam; not a CLI option. */
  adjudicationWaitMs?: number;
  /** Adjudication filesystem poll interval. Private test seam. */
  adjudicationPollMs?: number;
  /**
   * Post-lock refusal injected by orchestration tests. The wave composes
   * this after its production migration-prefix gate.
   */
  onContractLocked?: (
    ghIssue: string,
    contractPath: string,
  ) => string | null;
  /**
   * The CLI's crash recorder (#121). Supplied only by an entry point that
   * owns the process, because the handlers behind it end the process: the
   * pipeline registers what to write, never when to die. In-process
   * callers pass nothing and keep Node's own behaviour.
   *
   * See `src/crash-records.ts` and ADR 0044.
   */
  crashRecords?: CrashRecorderRegistrar;
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
  return sliceBranchPrefixForProviderName(provider.name);
}

/**
 * `sliceBranchPrefix` for a caller that has a provider *name* and no
 * provider object — the same split `runSlugForProviderName` makes below,
 * and for the same reason: `afk adopt --provider codex` never constructs
 * one.
 */
export function sliceBranchPrefixForProviderName(providerName: string): string {
  return providerName === "kiro" ? "afk" : `afk-${providerName}`;
}

function featureBranchPrefix(provider: AgentProvider): string {
  return featureBranchPrefixForProviderName(provider.name);
}

function featureBranchPrefixForProviderName(providerName: string): string {
  return providerName === "kiro" ? "feat" : `feat-${providerName}`;
}

/**
 * The feature branch a given PRD slug and provider *name* produce — the
 * same formula `featureBranch` uses, for a caller holding a name and no
 * provider object.
 *
 * `afk adopt` needs it to *prove* that a discovered run state belongs to the
 * PRD the operator named. A prefix match on the state filename alone cannot:
 * `.afk/state/api-v2.json` matches PRD `api` with an apparent provider
 * `v2`, and adoption would then move `feat/api-v2` and write the slice into
 * another PRD's run (PM blocker 2, fifth adjudication gate round). The
 * recorded feature branch is the discriminator, because the run wrote it
 * from its own PRD slug and provider: a genuine `api` + `codex` run records
 * `feat-codex/api`, while the `api-v2` run records `feat/api-v2`.
 */
export function featureBranchForProviderName(
  prdSlug: string,
  providerName: string,
): string {
  return `${featureBranchPrefixForProviderName(providerName)}/${prdSlug}`;
}

export function pipelineRunSlug(prdSlug: string, provider: AgentProvider): string {
  return runSlugForProviderName(prdSlug, provider.name);
}

/**
 * `pipelineRunSlug` for a caller that has a provider *name* and no
 * provider object — `afk adopt --provider codex`, which never constructs
 * one. Same rule, one place, so the two cannot drift.
 */
export function runSlugForProviderName(
  prdSlug: string,
  providerName: string,
): string {
  return providerName === "kiro" ? prdSlug : `${prdSlug}-${providerName}`;
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
  return sliceWorktreeDirForProviderName(
    repoRoot,
    prdSlug,
    slice.number,
    provider.name,
  );
}

/**
 * `sliceWorktreeDir` for a caller holding a provider name and a slice
 * number — `afk adopt`, which needs the *expected* path of a slice's
 * worktree to ask whether one is registered there (ADR 0055 Seam 2 §8:
 * absence is proved, and a detached worktree has no branch to match on).
 * One formula, one place, so the guard and the pipeline cannot disagree
 * about where a slice's worktree lives.
 */
export function sliceWorktreeDirForProviderName(
  repoRoot: string,
  prdSlug: string,
  sliceNumber: string,
  providerName: string,
): string {
  return join(
    repoRoot,
    ".afk",
    "worktrees",
    `${sliceBranchPrefixForProviderName(providerName)}-${prdSlug}-s${sliceNumber}`,
  );
}

/** The provider name a run slug carries — the inverse of `runSlugForProviderName`. */
export function providerNameFromRunSlug(
  prdSlug: string,
  runSlug: string,
): string {
  return runSlug === prdSlug ? "kiro" : runSlug.slice(prdSlug.length + 1);
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

/**
 * Throwaway checkout the post-merge guardian reviews read the feature
 * branch from, when the feature branch has no worktree of its own. Named
 * here beside the other two worktree-naming functions so the launch
 * preflight can recognise it as part of the run's namespace.
 */
export function reviewWorktreeDir(repoRoot: string, featBranch: string): string {
  return join(
    repoRoot,
    ".afk",
    "worktrees",
    `${featBranch.replace(/\//g, "-")}-review`,
  );
}

/** Directory names under `.afk/worktrees` that are this run's slice worktrees. */
export function sliceWorktreeNamePattern(
  prdSlug: string,
  provider: AgentProvider,
): RegExp {
  return new RegExp(
    `^${escapeRegExp(`${sliceBranchPrefix(provider)}-${prdSlug}-s`)}\\d+$`,
  );
}

/** Directory names under `.afk` that are this run's scratch merge worktrees. */
export function scratchMergeNamePattern(
  prdSlug: string,
  provider: AgentProvider,
): RegExp {
  return new RegExp(
    `^${escapeRegExp(`merge-${sliceBranchPrefix(provider)}-${prdSlug}-s`)}\\d+$`,
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The filesystem region this run owns, for the launch preflight (ADR
 * 0042). Assembled here because this module owns every name in it.
 *
 * `intended` is only the slice worktrees this run will actually create or
 * resume; `retained` adds the ones other live slices of the same PRD
 * still own (a narrowed re-run must not call those leftovers). The
 * scratch merge worktrees and the review worktree appear in neither: they
 * are created and removed *within* a run, so one surviving to the next
 * launch is residue by definition and never something to adopt.
 */
export function buildRunNamespace(args: {
  repoRoot: string;
  prdSlug: string;
  provider: AgentProvider;
  featBranch: string;
  intended: ReadonlyArray<{ path: string; branch: string }>;
  retained?: ReadonlyArray<{ path: string; branch: string }>;
}): RunNamespace {
  const slicePattern = sliceWorktreeNamePattern(args.prdSlug, args.provider);
  const scratchPattern = scratchMergeNamePattern(args.prdSlug, args.provider);
  const reviewName = basename(reviewWorktreeDir(args.repoRoot, args.featBranch));
  return {
    roots: [
      {
        dir: join(args.repoRoot, ".afk", "worktrees"),
        owns: (name) => slicePattern.test(name) || name === reviewName,
      },
      {
        dir: join(args.repoRoot, ".afk"),
        owns: (name) => scratchPattern.test(name),
      },
    ],
    intended: args.intended,
    retained: args.retained ?? args.intended,
  };
}

function featureBranch(prdSlug: string, provider: AgentProvider): string {
  return `${featureBranchPrefix(provider)}/${prdSlug}`;
}

export function isCancelled(err: unknown, signal?: AbortSignal): boolean {
  if (err instanceof ProcessTreeTerminationError) return false;
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
     *   tree was left untouched and the stuck.md diagnosis survives.
     *   Both modes use `generator-resume`; explicit situation blocks
     *   carry their opposite worktree facts without template drift.
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

function migrationReservationBlock(
  config: PipelineConfig,
  ghIssue: string,
): string {
  if (!config.manifest) {
    return (
      "No afk.json reservation is active; preserve legacy behavior. " +
      "The contract predates merges from other slices, so for concrete identifiers " +
      "the current tree wins over the contract. If your migration prefix collides " +
      "with one merged from the feature branch, renumber yours to the next free prefix."
    );
  }
  const provider = config.provider ?? kiroProvider;
  const claim = migrationClaimFor(
    config.repoRoot,
    pipelineRunSlug(config.prdSlug, provider),
    ghIssue,
  );
  if (claim === undefined) {
    return (
      "AFK has not assigned this slice a prefix yet. Declare the exact count under " +
      '`## Migration requirements` as `- New migration files: N`. Use ' +
      "`RESERVED_PREFIX_<name>.sql` placeholders for new migration paths. " +
      "Never inspect the tree or calculate a prefix; AFK will assign it after this draft."
    );
  }
  if (claim.length === 0) {
    return (
      "This slice owns no migration prefixes. Declare `- New migration files: 0` " +
      "and do not create a migration file."
    );
  }
  return (
    `This slice owns exactly: ${claim.join(", ")}. Declare ` +
    `\`- New migration files: ${claim.length}\` and use those exact prefixes, in order, ` +
    "for the new migration paths. Never calculate or substitute another prefix."
  );
}

function preserveContractNegotiationFailure(
  ctx: SliceContext,
  outcome: "ESCALATE" | "STUCK",
  round: number,
  verdict: RecordedContractVerdict,
  feedbackPath: string,
  capDecision: string,
  findings?: readonly ContractReviewFinding[],
  negotiationOutcome?: ContractNegotiationOutcome,
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
    findings,
    negotiationOutcome,
  });
  if (result.archived) {
    ctx.logger.phase(
      `${ctx.tag}: archived negotiation artifacts to ${result.archiveDir}`,
    );
  }
}

/**
 * Keep one contract review attempt's artifacts. Best-effort: an audit
 * copy that cannot be written is a warning, never the thing that fails a
 * negotiation. The warning names the attempt so a gap in the archive is
 * traceable rather than invisible.
 */
function archiveContractReviewAttempt(
  ctx: SliceContext,
  archiveDir: string,
  round: number,
  attempt: number,
  previousReview: ContractReview | null,
  plannerResponse: ContractResponse | null,
  revisions: ContractRevisionArtifacts | null,
  lifecyclePrevious: ContractReview | null = previousReview,
  validateAsFresh = false,
): { record: ContractReviewAttemptRecord; review: ContractReview } | null {
  try {
    const archived = artifacts.archiveContractReviewAttempt({
      sliceDir: ctx.absSliceDir,
      archiveDir,
      round,
      attempt,
    });
    if (archived.length > 0) {
      ctx.logger.phase(
        `${ctx.tag}: archived contract review round ${round} attempt ${attempt} ` +
          `(${archived.join(", ")}) to ${archiveDir}`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.phase(
      `${ctx.tag}: Warning: failed to archive contract review round ${round} ` +
        `attempt ${attempt} to ${archiveDir}: ${message}`,
      "error",
      {
        type: "warn",
        reason: "contract-review-archive-failed",
        ghIssue: ctx.slice.ghIssue,
        message,
      },
    );
  }

  let review: ContractReview;
  try {
    review = loadContractReview(ctx.absSliceDir);
    if (round === 1 || validateAsFresh) {
      validateRound1ContractReview(review);
    } else if (previousReview && plannerResponse) {
      validateRound2ContractReview(
        previousReview,
        plannerResponse,
        review,
        revisions ?? undefined,
        lifecyclePrevious ?? previousReview,
      );
    }
  } catch {
    return null;
  }

  const record = buildContractReviewAttemptRecord(
    round,
    attempt,
    review,
    plannerResponse,
  );
  try {
    const archived = artifacts.archiveContractReviewRecord({
      archiveDir,
      record,
    });
    ctx.logger.phase(
      `${ctx.tag}: archived contract review lifecycle record ${archived} to ${archiveDir}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.phase(
      `${ctx.tag}: Warning: failed to archive contract review lifecycle record ` +
        `for round ${round} attempt ${attempt} to ${archiveDir}: ${message}`,
      "error",
      {
        type: "warn",
        reason: "contract-review-archive-failed",
        ghIssue: ctx.slice.ghIssue,
        message,
      },
    );
  }
  return { record, review };
}

/**
 * A focused scope revision replaces the slice's *accepted* lock — the
 * contract and its acceptance manifest — and ADR 0008 makes those files
 * the orchestrator-owned single source of truth for the slice. So the
 * revision is a transaction: nothing but an ACCEPTed, re-locked
 * replacement is allowed to be what the operator finds on disk.
 *
 * `reopenContract` and the manifest delete happen before the planner
 * runs, because the planner is what writes the replacement. Every exit
 * short of success — a planner or provider throw, a stability/coverage/
 * binding validation failure, an undeclared-path refusal, a malformed
 * review artifact, an evaluator REVISE, a cancellation — therefore has to
 * put the accepted pair back byte-for-byte. ADR 0039 decision 2 is the
 * reason it matters: the worktree copy of a slice's contract may be the
 * only copy, so a failure that leaves the contract reopened and the
 * manifest deleted has destroyed the state a restart would archive.
 *
 * The capture/restore/announce mechanics and the lock exit are
 * `withContractTransaction`'s, shared with the adjudication apply path
 * (ADR 0055 Seam 1 decision 3). This function is what is left once they
 * are factored out: the revision protocol itself.
 *
 * The escalation artifact is archived by the caller *before* this runs
 * (see `runSliceExecute`), so the evidence for a hand-declaration
 * survives the rollback either way.
 */
async function runFocusedScopeRevision(
  ctx: SliceContext,
  escalation: import("./escalation.js").ScopeEscalation,
): Promise<
  | { phase: "LOCKED"; manifest: AcceptanceManifest }
  | { phase: "ERROR"; error: string }
> {
  return await withContractTransaction(
    ctx,
    {
      reason: "focused scope revision did not complete",
      qualifier: "the previously accepted",
    },
    (tx) => reviseAcceptedContract(ctx, escalation, tx),
  );
}

async function reviseAcceptedContract(
  ctx: SliceContext,
  escalation: import("./escalation.js").ScopeEscalation,
  tx: ContractTransaction,
): Promise<
  | { phase: "LOCKED"; manifest: AcceptanceManifest }
  | { phase: "ERROR"; error: string }
> {
  const { config, slice, logger, invoke } = ctx;
  const { contractPath, manifestPath, previousContract } = tx;
  const previousManifest = loadAcceptanceManifest(ctx.absSliceDir);
  // `loadAcceptanceManifest` just proved the accepted manifest exists, so
  // the transaction captured its bytes before the reopen below.
  const previousManifestText = tx.previousManifestText ?? "";
  const reviewArchiveDir = artifacts.contractReviewArchiveDir(
    config.repoRoot,
    pipelineRunSlug(config.prdSlug, config.provider ?? kiroProvider),
    slice.number,
  );
  const revisionRound = artifacts.nextContractReviewRound(reviewArchiveDir);
  const evidence = JSON.stringify({
    findingIds: escalation.findingIds,
    paths: escalation.paths,
    reason: escalation.reason,
  });

  artifacts.reopenContract(contractPath);
  logger.phase(
    `${ctx.tag}: focused scope revision (contract round ${revisionRound})...`,
    "error",
    {
      type: "phase-started",
      ghIssue: slice.ghIssue,
      sliceNumber: slice.number,
      agent: "planner",
      round: revisionRound,
    },
  );
  rmSync(manifestPath, { force: true });
  const plannerLog = logger.agentLog(
    slice.number,
    "planner",
    revisionRound,
  );
  await invoke({
    role: "planner",
    prompt: renderPrompt("planner", {
      GH_ISSUE: slice.ghIssue,
      SPECS_DIR: ctx.relSpecsDir,
      SLICE_DIR: ctx.relSliceDir,
      ROUND: revisionRound,
      RELEVANT_FILES: ctx.relevantFilesBlock,
      SLICE_BODY:
        `This is a focused revision of the already accepted contract. ` +
        `The generator supplied this validated scope evidence:\n${evidence}`,
      REVISION_NOTE:
        `The generator stopped before an undeclared edit. Revise only the ` +
        `contract and acceptance manifest needed to declare this request:\n` +
        `${evidence}\n\nPreserve every other locked term.`,
      CONTRACT_RESPONSE_NOTE:
        `Do not write ${CONTRACT_RESPONSE_FILENAME} for this focused scope revision.`,
      MIGRATION_RESERVATION: migrationReservationBlock(
        config,
        slice.ghIssue,
      ),
      BASE_GATE_CATALOG: formatBaseGateCatalog(
        resolveBaseGateDeclarations(ctx.worktreeDir),
      ),
    }),
    cwd: ctx.worktreeDir,
    logStream: plannerLog,
    maxDurationMs: config.maxAgentDurationMs,
  }).finally(() => closeAgentLog(plannerLog));
  logger.event({
    type: "phase-ended",
    ghIssue: slice.ghIssue,
    sliceNumber: slice.number,
    agent: "planner",
    round: revisionRound,
  });

  const revisedManifest = loadAcceptanceManifest(ctx.absSliceDir);
  validateAcceptanceManifestStability(previousManifest, revisedManifest);
  validateAcceptanceManifestCoverage(
    readFileSync(contractPath, "utf-8"),
    revisedManifest,
    contractPath,
  );
  const gateCatalog = resolveBaseGateDeclarations(ctx.worktreeDir);
  validateAcceptanceManifestBindings(revisedManifest, gateCatalog);
  const requestedPaths = escalation.paths.map((path) =>
    normalizeAcceptanceManifestPath(path, ESCALATION_FILENAME),
  );
  const revisedManifestPaths = new Set(
    acceptanceManifestPaths(revisedManifest),
  );
  const revisedContractPaths = new Set(
    (artifacts.readContractFiles(contractPath) ?? []).map((path) =>
      normalizeAcceptanceManifestPath(path, contractPath),
    ),
  );
  const missingManifestPaths = requestedPaths.filter(
    (path) => !revisedManifestPaths.has(path),
  );
  const missingContractPaths = requestedPaths.filter(
    (path) => !revisedContractPaths.has(path),
  );
  if (missingManifestPaths.length > 0 || missingContractPaths.length > 0) {
    throw new Error(
      "Focused scope revision did not declare every requested path: " +
        `contract.md missing [${missingContractPaths.join(", ")}]; ` +
        `${ACCEPTANCE_MANIFEST_FILENAME} missing ` +
        `[${missingManifestPaths.join(", ")}]`,
    );
  }
  // A focused scope revision is *additive*: it repairs a too-narrow lock by
  // adding the escalation's requested paths, and Stories 1-2 (slice 01
  // B-03/B-04) require it to preserve the accepted contract. Verifying only
  // that the requested paths arrived left the other half unguarded — a
  // revision could add them while silently dropping paths already locked, so
  // the fresh generator would receive an incomplete scope and the transaction
  // would re-lock over lost, already-contracted work. So every previously
  // declared path must survive, in both artifacts, on top of the requested
  // ones. (Only this path is additive-only: the adjudication apply path
  // shares `validateAcceptanceManifestStability` but may legitimately narrow
  // scope per a human decision — ADR 0054 — so the check lives here, not
  // there.)
  const droppedManifestPaths = acceptanceManifestPaths(previousManifest).filter(
    (path) => !revisedManifestPaths.has(path),
  );
  const droppedContractPaths = (
    artifacts.parseContractFiles(previousContract) ?? []
  )
    .map((path) => normalizeAcceptanceManifestPath(path, contractPath))
    .filter((path) => !revisedContractPaths.has(path));
  if (droppedManifestPaths.length > 0 || droppedContractPaths.length > 0) {
    throw new Error(
      "Focused scope revision dropped previously locked path(s): " +
        `contract.md dropped [${droppedContractPaths.join(", ")}]; ` +
        `${ACCEPTANCE_MANIFEST_FILENAME} dropped ` +
        `[${droppedManifestPaths.join(", ")}]. A revision must preserve the ` +
        `accepted file scope and add the requested paths, never replace it.`,
    );
  }
  const revisions: ContractRevisionArtifacts = {
    "contract.md": {
      before: previousContract,
      after: readFileSync(contractPath, "utf-8"),
    },
    "acceptance-manifest.json": {
      before: previousManifestText,
      after: readFileSync(manifestPath, "utf-8"),
    },
  };

  logger.phase(
    `${ctx.tag}: evaluating focused scope revision ` +
      `(contract round ${revisionRound})...`,
    "error",
    {
      type: "phase-started",
      ghIssue: slice.ghIssue,
      sliceNumber: slice.number,
      agent: "evaluator-contract",
      round: revisionRound,
    },
  );
  const feedbackPath = join(
    ctx.absSliceDir,
    `feedback-r${revisionRound}.md`,
  );
  const reviewPath = join(ctx.absSliceDir, CONTRACT_REVIEW_FILENAME);
  rmSync(feedbackPath, { force: true });
  rmSync(reviewPath, { force: true });
  const evaluatorLog = logger.agentLog(
    slice.number,
    "evaluator-contract",
    revisionRound,
  );
  await invoke({
    role: "evaluator-contract",
    prompt: renderPrompt("evaluator-contract", {
      SPECS_DIR: ctx.relSpecsDir,
      SLICE_DIR: ctx.relSliceDir,
      ROUND: revisionRound,
      RELEVANT_FILES: ctx.relevantFilesBlock,
      PREVIOUS_REVIEW_NOTE:
        "This is a fresh evaluation of one focused generator scope revision.",
      ACCEPTANCE_MANIFEST: JSON.stringify(revisedManifest, null, 2),
      BASE_GATE_CATALOG: formatBaseGateCatalog(gateCatalog),
      CONTRACT_REVIEW_FILE: CONTRACT_REVIEW_FILENAME,
      PLANNER_RESPONSE:
        "(fresh scope revision; no contract-review finding response)",
      REVISION_CONTEXT: JSON.stringify(
        { scopeEscalation: escalation, revisions },
        null,
        2,
      ),
    }),
    cwd: ctx.worktreeDir,
    logStream: evaluatorLog,
    maxDurationMs: config.maxAgentDurationMs,
  }).finally(() => closeAgentLog(evaluatorLog));

  archiveContractReviewAttempt(
    ctx,
    reviewArchiveDir,
    revisionRound,
    1,
    null,
    null,
    revisions,
    null,
    true,
  );
  const review = loadContractReview(ctx.absSliceDir);
  validateRound1ContractReview(review);
  logger.event({
    type: "phase-ended",
    ghIssue: slice.ghIssue,
    sliceNumber: slice.number,
    agent: "evaluator-contract",
    round: revisionRound,
    verdict: review.verdict,
  });
  if (review.verdict !== "ACCEPT") {
    return {
      phase: "ERROR",
      error:
        `Focused scope revision was not accepted: ` +
        formatContractReviewFindings(review.findings),
    };
  }

  const locked = tx.lock({
    provenance: { kind: "focused-scope-revision", round: revisionRound },
  });
  if (!locked.locked) {
    logger.phase(
      `${ctx.tag}: focused scope revision lock refused — ${locked.refusal}`,
      "error",
    );
    return {
      phase: "ERROR",
      error: `Focused scope revision lock refused: ${locked.refusal}`,
    };
  }
  tx.onAccepted();
  logger.phase(`${ctx.tag}: focused scope revision LOCKED`);
  return { phase: "LOCKED", manifest: revisedManifest };
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
 * - `review-artifact` — the evaluator finished but its contract review
 *   artifact was missing, malformed, or self-contradictory. Terminal for
 *   the slice: there is no verdict to act on, and inventing a default
 *   would be the silent ACCEPT this failure mode exists to prevent.
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
  | "review-artifact"
  /**
   * The slice was not prepared because restarting it from base would have
   * force-reset unmerged commits away (#113). Terminal for this run and
   * deliberately not infrastructure-class: retrying the invocation would
   * hit the same refusal. The operator decides — `--force-restart` to
   * discard, `--resume-stuck` to keep a STUCK tree, or manual recovery.
   */
  | "restart-refused"
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
  verdict?: RecordedContractVerdict;
  /** Tail of the dead invocation's output. Absent for `verdict`. */
  outputTail?: string;
}

export type NegotiateOutcome =
  | { phase: "LOCKED" }
  | { phase: "CANCELLED" }
  | {
      phase:
        | "STUCK"
        | "ESCALATE"
        | "AWAITING-ADJUDICATION"
        | "ADJUDICATION-LOCK-REFUSED"
        | "ERROR";
      cause: NegotiateFailureCause;
    };

/**
 * Whether a negotiate failure is worth retrying. A genuine verdict
 * never is — retrying it would just re-run agents against a contract
 * the evaluator already judged — and neither is a pipeline-internal
 * throw, whose blast radius this change deliberately leaves unchanged.
 *
 * A `tool-call-cap` kill is excluded even though it is an
 * orchestrator kill: the cap only exists when a caller opted in
 * (ADR 0036), so tripping it is the configured bound doing its job,
 * not infrastructure flaking. Retrying the invocation verbatim would
 * spend another full budget re-hitting the same cap.
 */
function isInfrastructureCause(cause: NegotiateFailureCause): boolean {
  if (cause.killClass === "tool-call-cap") return false;
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
  verdict: RecordedContractVerdict;
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

/**
 * A NON_CONVERGENCE that also held a contest, named as such.
 *
 * The classification is deliberate (ADR 0055 §1: an OPEN blocker is not
 * adjudicable, so the mixed case takes the branch that cannot loop, ADR
 * 0041). The defect it left behind was one of *visibility* — the operator
 * was told only "negotiation escalated, verdict REVISE" and never that a
 * blocking finding had two held positions waiting. `null` for every other
 * exhaustion, so the ordinary summary stays exactly as it was.
 */
export function negotiationMixedExhaustionCause(
  outcome: ContractNegotiationOutcome | undefined,
  verdict: RecordedContractVerdict,
  round: number,
): NegotiateFailureCause | null {
  if (!outcome || outcome.classification !== "NON_CONVERGENCE") return null;
  const contested = outcome.findings
    .filter((finding) => finding.state === "CONTESTED")
    .map((finding) => finding.id);
  if (contested.length === 0) return null;
  const open = outcome.findings
    .filter((finding) => finding.state === "OPEN")
    .map((finding) => finding.id);
  return {
    kind: "verdict",
    verdict,
    summary:
      `negotiate: contract negotiation reached NON_CONVERGENCE after ` +
      `${round} round(s) — contested blocking finding${contested.length === 1 ? "" : "s"} ` +
      `${contested.join(", ")} ${contested.length === 1 ? "holds" : "hold"} two ` +
      `positions, but unresolved OPEN blocker${open.length === 1 ? "" : "s"} ` +
      `${open.join(", ")} cannot be settled by any human decision, so the ` +
      `slice routes to the operator instead of parking (ADR 0055 §1); both ` +
      `positions are in stuck.md`,
  };
}

function negotiateImpasseCause(
  outcome: ContractNegotiationOutcome,
  verdict: RecordedContractVerdict,
): NegotiateFailureCause {
  const contestedIds = outcome.findings
    .filter((finding) => finding.state === "CONTESTED")
    .map((finding) => finding.id);
  return {
    kind: "verdict",
    verdict,
    summary:
      `negotiate: contract negotiation reached IMPASSE after ${outcome.round} round(s) — ` +
      `contested blocking finding${contestedIds.length === 1 ? "" : "s"} ` +
      `${contestedIds.join(", ")} ` +
      `${contestedIds.length === 1 ? "requires" : "require"} human adjudication`,
  };
}

/**
 * The evaluator finished and its review artifact was refused. Distinct
 * from a `verdict` cause: nothing was decided about the contract, so the
 * summary names the artifact and the defect instead of a verdict, and the
 * slice stops where it is.
 */
function negotiationArtifactCause(
  role: "planner" | "evaluator-contract",
  label: string,
  defect: string,
): NegotiateFailureCause {
  return {
    kind: "review-artifact",
    role,
    summary:
      `negotiate: the ${label} artifact was refused, so no verdict ` +
      `was reached — ${defect}`,
  };
}

function reviewArtifactCause(defect: string): NegotiateFailureCause {
  return negotiationArtifactCause(
    "evaluator-contract",
    "contract review",
    defect,
  );
}

/** A throw from the pipeline itself, with no dead invocation behind it. */
function internalNegotiateCause(error: unknown): NegotiateFailureCause {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof RestartRefusedError) {
    // Reported verbatim, without the `negotiate:` prefix: nothing about
    // negotiation happened — the slice never started (#113). The wave
    // records this summary as the slice's outcome reason, so it is what
    // the next operator reads in `afk status` and in the retry line.
    return { kind: "restart-refused", summary: message };
  }
  return { kind: "internal-error", summary: `negotiate: ${message}` };
}

/**
 * A slice whose only remaining option was a from-base restart that would
 * have destroyed unmerged commits (#113). Thrown out of
 * `prepareSliceWorktree` before anything is mutated, so the branch, the
 * worktree, and every untracked slice artifact survive byte-identical for
 * the operator to inspect.
 */
export class RestartRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RestartRefusedError";
  }
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
 *   resume prompt. A refresh conflict refuses the slice (#113) — no
 *   agent is asked to resolve a merge it has no context for, and the
 *   conflicting commits are not destroyed to avoid asking.
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
 *   recreate from base deliberately, after archiving the slice's
 *   untracked spec artifacts to `.afk/artifacts/` (#113). Today's
 *   accidental behavior (branch creation no-ops for existing branches,
 *   silently re-attaching to the old tip) must never restart implicitly.
 * - **refuse** — the slice is not resumable and the restart that would
 *   follow holds unmerged commits: throw `RestartRefusedError` without
 *   touching anything, so the slice ends ERROR with a report naming the
 *   commits and the flags that resolve it (#113). `--force-restart` is
 *   the one route that still discards.
 * - **fresh** — no branch and no worktree: the normal first-run creation
 *   path, unlogged, except that a prior life's review archives left on
 *   disk by `clean-failed` or a manual branch deletion are moved aside
 *   first and that move is logged (#123).
 *
 * Every resume/restart decision is announced on console + run.log
 * (`resuming from <n> commits` / `restarting from base (<reason>)`)
 * so overnight runs are auditable.
 *
 * ADR 0010 holds throughout: a stale unregistered directory is never
 * auto-deleted (`createWorktree` throws its descriptive error), and
 * every path ends registered-and-asserted before agent dispatch.
 */
export async function prepareSliceWorktree(ctx: SliceContext): Promise<void> {
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

  /**
   * Put the previous life's artifacts out of this one's way, for the two
   * paths that start a slice at round 1 with no resume state.
   *
   * The slice's spec artifacts (contract.md, context.md, feedback-r*,
   * qa-report*, handoff.md, stuck.md) are untracked files inside the
   * worktree, so recreating it deletes the only copy — they are copied to
   * the same `.afk/artifacts/` path the ESCALATE/STUCK preserve path
   * writes to (#113). The `reviews/` archive dir is moved aside, because
   * the next round-1 evidence write targets the same `r1-a1` names and
   * fails closed on a collision — burning infrastructure retries and
   * possibly ending the run ERROR before the next re-launch's resume
   * self-heals past the occupied rounds (#123).
   *
   * Best-effort: a failure warns and the run proceeds, because the
   * operator asked for the restart and a half-copied archive must not
   * strand it. A `reviews/` dir left in place then fails closed at round
   * 1, exactly as it did before this relocation existed.
   */
  const archivePriorLife = (): string | null => {
    try {
      return artifacts.archiveArtifactsBeforeRestart(
        repoRoot,
        runSlug,
        ctx.slice.number,
        ctx.absSliceDir,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.logger.phase(
        `${ctx.tag}: warning — could not archive the slice's prior-life artifacts: ${message}`,
      );
      return null;
    }
  };

  // Restart teardown + bookkeeping shared by the decision's restart
  // path and the refresh-conflict fallback. The attempt counter resets:
  // a fresh tree earns a fresh resume budget (#36).
  const restartFromBase = async (reason: string): Promise<void> => {
    const archived = archivePriorLife();
    ctx.logger.phase(
      `${ctx.tag}: restarting from base (${reason})` +
        (archived
          ? `; slice artifacts archived to ${relative(repoRoot, archived).replace(/\\/g, "/")}`
          : ""),
    );
    await git.recreateWorktreeFromBase(
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

  /**
   * Refuse a restart that would force-reset unmerged commits away, and
   * end the slice with a report the next operator can act on (#113).
   * Nothing is mutated: the branch tip, the worktree and its untracked
   * artifacts are exactly as the previous run left them. The attempt
   * counter is deliberately NOT reset — no fresh tree was created, so no
   * fresh resume budget is earned.
   */
  const refuseRestart = (reason: string, commitsAhead: number): never => {
    const message = formatRestartRefusal({
      reason,
      commitsAhead,
      branch: ctx.branch,
      selector: ghIssue,
    });
    recordRetryDecision(repoRoot, runSlug, ghIssue, {
      attempts: priorAttempts,
      lastDecision: `refused to restart from base (${reason}) — ${commitsAhead} unmerged commit(s) preserved`,
    });
    ctx.logger.phase(`${ctx.tag}: ${message}`, "error", {
      type: "warn",
      reason: "restart-refused",
      ghIssue,
      message,
    });
    throw new RestartRefusedError(message);
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
      // `mergeBranchIntoWorktree` aborts on conflict, so the tip and the
      // worktree are byte-identical here. The old fallback restarted from
      // base, which threw away exactly the commits that conflicted — the
      // #113 defect in its most expensive form. Refuse and report: no
      // agent is asked to resolve a merge it has no context for, and no
      // work is destroyed to avoid asking.
      refuseRestart("feature merge conflict", plan.commitsAhead);
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
    // included. The shared resume prompt's worktree situation block tells
    // the generator to inspect it rather than assuming a clean tip.
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
      await restartFromBase(plan.reason);
    }
  } else if (plan.action === "refuse") {
    refuseRestart(plan.reason, plan.commitsAhead);
  } else {
    // "Fresh" is fresh in git only. A slice whose branch and worktree are
    // gone — `clean-failed`, a manual deletion — can still have a prior
    // life's review archives on disk, and nothing else ever clears them
    // (#123). Move them aside before round 1 writes over their names.
    // Logged only when something actually moved, so an ordinary first run
    // stays unlogged as documented above.
    const archived = archivePriorLife();
    if (archived) {
      ctx.logger.phase(
        `${ctx.tag}: prior-life artifacts archived to ` +
          `${relative(repoRoot, archived).replace(/\\/g, "/")} ` +
          `(no branch or worktree survived)`,
      );
    }
    git.createWorktree(repoRoot, ctx.branch, ctx.worktreeDir, ctx.featBranch);
  }

  git.assertWorktreeRegistered(repoRoot, ctx.branch, ctx.worktreeDir);
}

/**
 * The worktree-ownership check every dispatch owes, wherever it routes
 * afterwards (ADR 0010 decision item 3; ADR 0055 Seam 2).
 *
 * `prepareSliceWorktree` ends with `assertWorktreeRegistered`, but it is
 * only reached by the *ordinary* negotiate path. A slice that arrives with
 * a persisted IMPASSE goes straight to the adjudication branch, and an
 * adjudicated lane successor goes straight to a merge into its parked
 * worktree — both then run git commands, and can invoke the planner, in a
 * directory nobody proved git still owns. That is precisely the ADR 0010
 * corruption mode: a leaked directory no longer registered as a worktree
 * makes git walk up to the parent repository and commit onto whatever
 * branch the operator has checked out there.
 *
 * The check is deliberately narrower than `prepareSliceWorktree`: it
 * never creates, recreates, resets or deletes anything, because the two
 * callers that need it must preserve the parked estate byte-for-byte.
 *
 * A directory that does not exist at all is not a violation here — it is
 * the ordinary first-dispatch state, and creating it is the ordinary
 * path's job. Every state where something *is* on disk (or a branch
 * survives without its worktree) must prove registration, and today every
 * such state that cannot is a refusal in `prepareSliceWorktree` too; this
 * moves the refusal ahead of the routing fork instead of behind one arm
 * of it.
 */
export function assertSliceWorktreeOwnership(ctx: SliceContext): void {
  const { repoRoot } = ctx.config;
  if (!existsSync(ctx.worktreeDir)) return;
  git.assertWorktreeRegistered(repoRoot, ctx.branch, ctx.worktreeDir);
}

/**
 * Report this dispatch's budgets — one `run.log` line and one typed
 * `slice-bounds` event (plan §3.9, wave item 14). See `bounds.ts` for
 * why: these four numbers decide what a struggling slice may still do,
 * and until now the only way to read them was `.afk/state/<slug>.json`.
 *
 * Called once per slice dispatch, after `prepareSliceWorktree` — the
 * resume decision has landed by then, so the attempt counter and the
 * resume mode are the ones this dispatch actually runs under rather than
 * the ones it inherited.
 *
 * Reporting only. Every budget is still enforced where it was.
 */
export function reportSliceBounds(ctx: SliceContext): void {
  const { config, slice } = ctx;
  const provider = config.provider ?? kiroProvider;
  const runSlug = pipelineRunSlug(config.prdSlug, provider);
  const bounds = computeSliceBounds({
    resumeAttemptsSpent: getResumeAttempts(
      loadRunState(config.repoRoot, runSlug),
      slice.ghIssue,
    ),
    // A fresh or restarted slice starts at round 1 whatever is on disk;
    // only a resume inherits the rounds its prior lives spent.
    implementationRoundsSpent: ctx.resume
      ? spentImplementationRounds(
          artifacts.contractReviewArchiveDir(
            config.repoRoot,
            runSlug,
            slice.number,
          ),
          ctx.absSliceDir,
        )
      : 0,
    implementationRoundLimit: MAX_GENERATOR_ROUNDS,
    contractRoundLimit: Math.min(
      config.maxContractRounds ?? DEFAULT_MAX_CONTRACT_ROUNDS,
      DEFAULT_MAX_CONTRACT_ROUNDS,
    ),
    infrastructureRetries:
      config.infrastructureRetries ?? DEFAULT_INFRASTRUCTURE_RETRIES,
    ...(ctx.resume ? { resumeMode: ctx.resume.mode } : {}),
  });
  // Same stream as the resume/restart and round lines it sits between, so
  // the console order matches run.log's.
  ctx.logger.phase(`${ctx.tag}: ${formatSliceBounds(bounds)}`, "error", {
    type: "slice-bounds",
    ghIssue: slice.ghIssue,
    sliceNumber: slice.number,
    ...bounds,
  });
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
  const { config, logger } = ctx;
  const infrastructureRetries =
    config.infrastructureRetries ?? DEFAULT_INFRASTRUCTURE_RETRIES;
  if (
    !Number.isSafeInteger(infrastructureRetries) ||
    infrastructureRetries < 0
  ) {
    throw new Error("infrastructureRetries must be a non-negative integer");
  }

  // Before the routing fork, not inside one arm of it: whichever branch
  // this dispatch takes, it may run git commands and invoke agents in
  // `ctx.worktreeDir`, so the same ownership boundary is proved for both
  // (ADR 0010 item 3). The ordinary path re-asserts at the end of
  // `prepareSliceWorktree` — that assertion covers the worktree it just
  // created or recreated, which is a different claim from this one.
  assertSliceWorktreeOwnership(ctx);

  const outcomePath = join(
    ctx.absSliceDir,
    CONTRACT_NEGOTIATION_OUTCOME_FILENAME,
  );
  if (existsSync(outcomePath)) {
    const rawOutcome = readFileSync(outcomePath, "utf-8");
    const outcome = JSON.parse(rawOutcome) as ContractNegotiationOutcome;
    if (outcome.classification === "IMPASSE") {
      return await runImpasseAdjudication(ctx, { rawOutcome, outcome });
    }
  }

  return negotiateAttempt(ctx, infrastructureRetries);
}

/**
 * The IMPASSE branch of Phase A: collect human adjudications, then apply
 * them in one transaction (ADR 0054).
 *
 * Two rules the ordinary negotiate path does not need:
 *
 * 1. **A decision resolves a finding, not the contract.** One
 *    `adjudication.md` names one finding, so a multi-finding impasse needs
 *    one decision per contested finding. Each valid decision is recorded in
 *    `adjudication-decisions.json` and its file consumed; the slice parks
 *    again until every contested finding has one. Only then may the
 *    contract lock, so an on-disk `LOCKED` never claims a contract is
 *    settled while the structured impasse still records an undecided
 *    contested finding (ADR 0008).
 *
 * 2. **Applying the decisions is a transaction.** The apply step mutates
 *    the same authoritative `contract.md` + `acceptance-manifest.json` pair
 *    as `runFocusedScopeRevision`, so it owes the same guarantee (ADR
 *    0051): both files are captured before the planner runs and restored
 *    byte-for-byte on every exit that is not an accepted lock. It is
 *    literally the same transaction now — `withContractTransaction`, shared
 *    with the revision path (ADR 0055 Seam 1 decision 3), including the one
 *    lock exit that runs the completion predicate and the mechanical lock
 *    gate. A successful lock marks the record applied, so a later
 *    implementation retry that re-enters this branch does not apply the same
 *    decisions a second time.
 *
 * The decision record itself is *not* part of the transaction — like the
 * escalation archive in ADR 0051, human input must outlive a mechanical
 * refusal. A rolled-back apply is retried from the same decisions, not
 * from a fresh interrogation of the human.
 */
/**
 * Re-run the mechanical lock gate over an adjudication lock this dispatch
 * did not itself produce, and refuse the dispatch if it now objects.
 *
 * The two shortcuts that return `LOCKED` without entering the transaction —
 * a stamped lock beside a discarded record, and an already-applied decision
 * log (ADR 0055 §4–5) — prove something about the *decisions*: that this
 * exact set produced this lock. Neither proves anything about the base the
 * lock is about to be generated against, and the gate's checks
 * (migration-prefix allocation, run-specific claims — ADR 0028) are exactly
 * the ones a changed base invalidates.
 *
 * A lane successor is where that gap bites (ADR 0028, *Why the gate is a
 * callback*): `runWave` merges the new feature tip into the preserved parked
 * worktree and re-negotiates, so a prefix the predecessor's merge has since
 * claimed is a collision that only this call can see. Without it the
 * shortcut returned `LOCKED` and generation ran on a contract whose declared
 * migration prefix belonged to another slice.
 *
 * The refusal preserves the parked estate exactly as it stands — no reopen,
 * no rollback, nothing written. There is no transaction here to roll back
 * to, and the contract on disk is the one a passing gate did attest to at
 * the base it was locked on; the objection is about the base, which the next
 * dispatch re-reads anyway. So the refusal is idempotent: every dispatch
 * re-asks the gate, and the lock cannot be consumed while it objects. It
 * reads as a lock refusal (`ESCALATE`), the same phrasing the transaction's
 * own gate refusal produces, because to the operator it is the same event.
 */
function revalidateAdjudicatedLock(
  ctx: SliceContext,
  contractPath: string,
  proof: string,
): NegotiateOutcome | null {
  const objection = ctx.onContractLocked?.(contractPath) ?? null;
  if (objection === null) return null;
  ctx.logger.phase(
    `${ctx.tag}: adjudicated contract lock refused — ${proof}, but the ` +
      `mechanical lock gate objects on the current base: ${objection}; the ` +
      `parked branch, decision record and lock are preserved`,
    "error",
  );
  return {
    phase: "ADJUDICATION-LOCK-REFUSED",
    cause: {
      kind: "verdict",
      verdict: "REVISE",
      summary: `adjudication: contract lock refused — ${objection}`,
    },
  };
}

async function runImpasseAdjudication(
  ctx: SliceContext,
  impasse: { rawOutcome: string; outcome: ContractNegotiationOutcome },
): Promise<NegotiateOutcome> {
  const { config, logger } = ctx;
  const { rawOutcome, outcome } = impasse;
  const decisionPath = join(ctx.absSliceDir, ADJUDICATION_FILENAME);
  const contractPath = join(ctx.absSliceDir, "contract.md");
  const parkedCause = negotiateImpasseCause(outcome, "REVISE");

  // Re-dispatch is the reopen (ADR 0055 §9), and reaching this function *is*
  // the re-dispatch — so the reopen belongs here, before the decision is
  // read, not after the all-decided check. Behind that check it only fired
  // for the dispatch that completed the adjudication; a partial decision or
  // a refused one returned a fresh AWAITING-ADJUDICATION while the slice was
  // still marked parked, and `recordTerminal` kept the previous park because
  // the phase matched. The persisted reason then went on naming every
  // finding when only some were still undecided, which is the one thing
  // ADR 0054 item 3 requires each partial adjudication to update.
  logger.trackSlice(
    lifecycle.running(
      {
        ghIssue: ctx.slice.ghIssue,
        title: ctx.slice.title,
        branch: ctx.branch,
      },
      logger.getSliceProgress(ctx.slice.ghIssue),
    ),
  );

  const loaded = loadAdjudicationDecisionLog(ctx.absSliceDir, outcome);
  let decisionLog = loaded.log;
  if (loaded.discarded) {
    // The log is gone either way. What a `LOCKED` contract beside it means
    // is decided by the lock's own provenance stamp, not by policy
    // (ADR 0055 §4): blanket trust is the A2 defect, and blanket reopening
    // would throw away a human's completed adjudication every time its
    // receipt got corrupted.
    const reconciliation = reconcileDiscardedDecisionLog({
      locked: artifacts.readContractStatus(contractPath) === "LOCKED",
      provenance: artifacts.readContractLockProvenance(contractPath),
      outcome,
    });
    const discarded =
      `${ctx.tag}: discarded ${ADJUDICATION_DECISIONS_FILENAME} — ` +
      `${loaded.discarded}`;
    if (reconciliation.action === "lock-stands") {
      logger.phase(
        `${discarded}; ${reconciliation.because}, so the lock stands — only ` +
          `the record of which decisions produced it is lost`,
        "error",
      );
      const objected = revalidateAdjudicatedLock(
        ctx,
        contractPath,
        "the stamped lock stands over a discarded decision record",
      );
      return objected ?? { phase: "LOCKED" };
    }
    if (reconciliation.action === "reopen") {
      artifacts.reopenContract(contractPath);
      logger.phase(
        `${discarded}; ${reconciliation.because}, so the LOCKED contract is ` +
          `provably stale and has been reopened; every contested finding must ` +
          `be adjudicated again`,
        "error",
      );
    } else {
      logger.phase(
        `${discarded}; every contested finding must be adjudicated again`,
        "error",
      );
    }
  }

  // --- Consume whatever the human has written since the last dispatch.
  if (existsSync(decisionPath)) {
    const rawDecision = readFileSync(decisionPath, "utf-8");
    let decision: Adjudication;
    try {
      decision = parseAdjudication(
        rawDecision,
        outcome,
        ADJUDICATION_FILENAME,
        decisionLog.decisions.map((recorded) => recorded.decision.findingId),
      );
    } catch (error) {
      const defect = error instanceof Error ? error.message : String(error);
      logger.phase(
        `${ctx.tag}: adjudication refused — ${defect}; slice remains parked`,
        "error",
      );
      return {
        phase: "AWAITING-ADJUDICATION",
        cause: {
          kind: "verdict",
          verdict: "REVISE",
          summary: `${parkedCause.summary}; ${defect}`,
        },
      };
    }
    // Record before consuming: a crash between the two costs a re-write of
    // one decision, never a decision recorded nowhere.
    decisionLog = appendAdjudicationDecision(ctx.absSliceDir, decisionLog, {
      raw: rawDecision,
      decision,
    });
    rmSync(decisionPath, { force: true });
    logger.phase(
      `${ctx.tag}: recorded the human decision for ${decision.findingId} in ` +
        `${ADJUDICATION_DECISIONS_FILENAME} and consumed ${ADJUDICATION_FILENAME}`,
    );
  }

  if (decisionLog.decisions.length === 0) {
    return { phase: "AWAITING-ADJUDICATION", cause: parkedCause };
  }

  const decidedIds = decisionLog.decisions.map(
    (recorded) => recorded.decision.findingId,
  );
  // The single completion predicate (ADR 0055 §2) is the only thing the lock
  // path consults: every unresolved blocking finding, not just the contested
  // ones. The contested subset is rendered alongside it because that is what
  // the courier can still act on — and, when the two disagree, saying so is
  // the whole point of keeping the predicate wider than the classifier.
  const undecided = unresolvedBlockingFindingIds(outcome, decisionLog);
  if (undecided.length > 0) {
    const contested = undecidedContestedFindingIds(outcome, decisionLog);
    const inadjudicable = undecided.filter((id) => !contested.includes(id));
    const summary =
      `${parkedCause.summary}; decided ${decidedIds.join(", ")} — ` +
      `unresolved blocking finding${undecided.length === 1 ? "" : "s"} ` +
      `${undecided.join(", ")} still ` +
      `${undecided.length === 1 ? "requires" : "require"} human adjudication ` +
      `before the contract can lock` +
      (inadjudicable.length > 0
        ? `; ${inadjudicable.join(", ")} ` +
          `${inadjudicable.length === 1 ? "is" : "are"} not CONTESTED, so no ` +
          `decision can settle ${inadjudicable.length === 1 ? "it" : "them"} ` +
          `— this exhaustion should not have been classified IMPASSE`
        : "");
    logger.phase(`${ctx.tag}: ${summary}`, "error");
    return {
      phase: "AWAITING-ADJUDICATION",
      cause: { kind: "verdict", verdict: "REVISE", summary },
    };
  }

  // --- Every unresolved blocking finding is decided. Apply once, ever.
  //
  // A LOCKED contract with a complete record and no applied marker is the
  // crash window between `lockContract` and the marker write — but only if
  // the record's pending-lock witness proves it (ADR 0055 §5). A bare
  // LOCKED is what let a stale lock be inherited (A2), so it no longer
  // shortcuts anything: without proof the decisions are applied in full.
  if (
    adjudicatedLockIsProven({
      locked: artifacts.readContractStatus(contractPath) === "LOCKED",
      log: decisionLog,
    })
  ) {
    // The lock is proven for *these decisions*; it is not proven against
    // *this base*. Re-attest before anything is dispatched from it — the
    // applied mark below is bookkeeping about a lock the gate has to still
    // stand behind (see `revalidateAdjudicatedLock`).
    const objected = revalidateAdjudicatedLock(
      ctx,
      contractPath,
      `the adjudication for ${decidedIds.join(", ")} was already applied`,
    );
    if (objected) return objected;
    if (!decisionLog.applied) {
      decisionLog = markAdjudicationDecisionsApplied(
        ctx.absSliceDir,
        decisionLog,
      );
    }
    logger.phase(
      `${ctx.tag}: adjudication for ${decidedIds.join(", ")} already applied; ` +
        `contract LOCKED`,
    );
    return { phase: "LOCKED" };
  }

  // No `trackSlice` here — the dispatch already reopened the park at the
  // top of this function, which is where every arm of it gets the reopen.
  const refresh = git.mergeBranchIntoWorktree(ctx.worktreeDir, ctx.featBranch);
  if (refresh.status === "conflict") {
    return {
      phase: "ERROR",
      cause: {
        kind: "internal-error",
        summary:
          "adjudication: could not refresh the parked branch from " +
          `${ctx.featBranch} without conflicts; preserved the branch and decisions`,
      },
    };
  }

  return await withContractTransaction(
    ctx,
    {
      reason: "adjudication was not applied",
      qualifier: "the pre-apply",
      note:
        `the recorded decisions for ${decidedIds.join(", ")} are ` +
        `preserved`,
    },
    async (tx): Promise<NegotiateOutcome> => {
      const lockAdjudicatedContract = (
        previousManifest?: AcceptanceManifest,
      ): NegotiateOutcome => {
        try {
          const manifest = loadAcceptanceManifest(ctx.absSliceDir);
          if (previousManifest) {
            validateAcceptanceManifestStability(previousManifest, manifest);
          }
          validateAcceptanceManifestCoverage(
            readFileSync(contractPath, "utf-8"),
            manifest,
            contractPath,
          );
          validateAcceptanceManifestBindings(
            manifest,
            resolveBaseGateDeclarations(ctx.worktreeDir),
          );
        } catch (error) {
          const defect = error instanceof Error ? error.message : String(error);
          logger.phase(
            `${ctx.tag}: adjudicated contract lock refused — ${defect}`,
            "error",
          );
          return {
            phase: "ADJUDICATION-LOCK-REFUSED",
            cause: {
              kind: "verdict",
              verdict: "REVISE",
              summary: `adjudication: contract lock refused — ${defect}`,
            },
          };
        }

        const locked = tx.lock({
          provenance: {
            kind: "impasse-adjudication",
            impasse: impasseFingerprint(outcome),
          },
          completion: { outcome, log: decisionLog },
        });
        if (!locked.locked) {
          logger.phase(
            `${ctx.tag}: adjudicated contract lock refused — ${locked.refusal}`,
            "error",
          );
          return {
            phase: "ADJUDICATION-LOCK-REFUSED",
            cause: {
              kind: "verdict",
              verdict: "REVISE",
              summary: `adjudication: contract lock refused — ${locked.refusal}`,
            },
          };
        }
        logger.phase(
          `${ctx.tag}: accepted adjudication for ${decidedIds.join(", ")}; ` +
            `contract LOCKED`,
        );
        return { phase: "LOCKED" };
      };

      // A decision the planner has nothing to do for — the contract already
      // states the planner's position — locks without an invocation. One
      // invocation applies every other decision together.
      const plannerApplied = decisionLog.decisions.filter(
        (recorded) =>
          !("winningPosition" in recorded.decision) ||
          recorded.decision.winningPosition !== "PLANNER",
      );

      if (plannerApplied.length > 0) {
        const localSliceContent = readSliceFile(
          config.prdDir,
          ctx.slice.number,
        );
        const sliceBodyNote = localSliceContent
          ? `The slice issue body is provided below (no need to fetch from GH):\n\n---\n${localSliceContent}\n---`
          : `No local issue manifest was found. Fetch the issue body with: gh issue view ${ctx.slice.ghIssue}`;
        const preApplyManifest = loadAcceptanceManifest(ctx.absSliceDir);
        // An unproven LOCKED contract reaching here is stale debris the
        // reconciliation above could not clear (its log validated, so the
        // discard path never ran). The planner must not be handed a
        // contract still claiming LOCKED while its impasse is being
        // settled (ADR 0008); the rollback restores these bytes if the
        // apply fails, so nothing is lost by reopening now.
        if (artifacts.readContractStatus(contractPath) === "LOCKED") {
          artifacts.reopenContract(contractPath);
        }
        logger.phase(
          `${ctx.tag}: applying ${decisionLog.decisions.length} human ` +
            `adjudication(s) with one planner invocation...`,
          "error",
          {
            type: "phase-started",
            ghIssue: ctx.slice.ghIssue,
            sliceNumber: ctx.slice.number,
            agent: "planner",
          },
        );
        const plannerLog = logger.agentLog(ctx.slice.number, "planner");
        try {
          await ctx
            .invoke({
              role: "planner",
              prompt: renderPrompt("planner", {
                GH_ISSUE: ctx.slice.ghIssue,
                SPECS_DIR: ctx.relSpecsDir,
                SLICE_DIR: ctx.relSliceDir,
                ROUND: 2,
                RELEVANT_FILES: ctx.relevantFilesBlock,
                SLICE_BODY: sliceBodyNote,
                REVISION_NOTE: [
                  "A human has adjudicated the current contract impasse.",
                  "Apply every decision below exactly once, and only to the",
                  "finding each one names. Do not re-adjudicate any of them.",
                  "",
                  "Current IMPASSE record (verbatim):",
                  rawOutcome,
                  "Human adjudications (verbatim, one per decided finding):",
                  ...decisionLog.decisions.map((recorded) => recorded.raw),
                ].join("\n"),
                CONTRACT_RESPONSE_NOTE:
                  `Do not write ${CONTRACT_RESPONSE_FILENAME}; the human adjudication replaces another evaluator round.`,
                MIGRATION_RESERVATION: migrationReservationBlock(
                  config,
                  ctx.slice.ghIssue,
                ),
                BASE_GATE_CATALOG: formatBaseGateCatalog(
                  resolveBaseGateDeclarations(ctx.worktreeDir),
                ),
              }),
              cwd: ctx.worktreeDir,
              maxDurationMs: config.maxAgentDurationMs,
              logStream: plannerLog,
            })
            .finally(() => closeAgentLog(plannerLog));
        } catch (error) {
          if (isCancelled(error, config.signal)) return { phase: "CANCELLED" };
          return { phase: "ERROR", cause: internalNegotiateCause(error) };
        }
        logger.event({
          type: "phase-ended",
          ghIssue: ctx.slice.ghIssue,
          sliceNumber: ctx.slice.number,
          agent: "planner",
        });
        const locked = lockAdjudicatedContract(preApplyManifest);
        if (locked.phase === "LOCKED") {
          markAdjudicationDecisionsApplied(ctx.absSliceDir, decisionLog);
          tx.onAccepted();
        }
        return locked;
      }

      const locked = lockAdjudicatedContract();
      if (locked.phase === "LOCKED") {
        markAdjudicationDecisionsApplied(ctx.absSliceDir, decisionLog);
        tx.onAccepted();
      }
      return locked;
    },
  );
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
   *
   * `afterAttempt` runs once per attempt whatever the attempt did —
   * succeeded, died, or was cancelled — because an attempt that died can
   * still have written the artifact an operator needs to see. It runs
   * before the failure is classified so the archive is taken while the
   * working artifact is still on disk.
   */
  const invokeAgent = async (
    opts: Omit<Parameters<SliceContext["invoke"]>[0], "logStream">,
    createLogStream: () => WriteStream,
    beforeAttempt?: () => void,
    afterAttempt?: (attempt: number) => void,
  ): Promise<void> => {
    for (let attempt = 1; ; attempt++) {
      beforeAttempt?.();
      const logStream = createLogStream();
      let failure: { error: unknown } | null = null;
      try {
        await invoke({ ...opts, logStream }).finally(() =>
          closeAgentLog(logStream),
        );
      } catch (err) {
        failure = { error: err };
      }
      afterAttempt?.(attempt);
      if (failure === null) return;

      const { error } = failure;
      if (isCancelled(error, signal)) throw error;
      const cause = classifyNegotiateFailure({
        role: opts.role,
        error,
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
  };

  logger.trackSlice(
    lifecycle.running(
      { ghIssue: slice.ghIssue, title: slice.title, branch: ctx.branch },
      logger.getSliceProgress(slice.ghIssue),
    ),
  );

  try {
    await prepareSliceWorktree(ctx);
    mkdirSync(ctx.absSliceDir, { recursive: true });
    reportSliceBounds(ctx);

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
    const allowedContractRounds = Math.min(
      maxContractRounds,
      DEFAULT_MAX_CONTRACT_ROUNDS,
    );
    let evaluatorRound = 0;
    let lastRound = 0;
    let lastVerdict: RecordedContractVerdict = "NONE";
    let lastFeedbackPath = join(ctx.absSliceDir, "feedback-r0.md");
    const capDecisions: string[] = [];
    /**
     * The previous round's review, kept so this round's re-raised-gap
     * count can be derived from finding IDs rather than taken from the
     * evaluator's word.
     */
    let previousReview: ContractReview | null = null;
    let lastFindings: readonly ContractReviewFinding[] = [];
    let lastReviewAttemptRecord: ContractReviewAttemptRecord | null = null;
    let plannerResponse: ContractResponse | null = null;
    let revisionArtifacts: ContractRevisionArtifacts | null = null;
    const reviewArchiveDir = artifacts.contractReviewArchiveDir(
      config.repoRoot,
      pipelineRunSlug(config.prdSlug, config.provider ?? kiroProvider),
      slice.number,
    );

    /**
     * Objection raised by `ctx.onContractLocked` and not yet handed to a
     * planner round. Non-null means the last contract to reach LOCKED was
     * refused after the evaluator had accepted it.
     */
    let gateObjection: string | null = null;
    let previousSchemaValidManifest: AcceptanceManifestV2 | null = null;

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

    const refuseInvalidManifest = (
      objection: string,
      refusedAt: string,
    ): void => {
      gateObjection = objection;
      if (artifacts.readContractStatus(contractPath) === "LOCKED") {
        artifacts.reopenContract(contractPath);
      }
      contractStatus = "NEGOTIATING";
      capDecisions.push(
        `The acceptance-manifest scope gate refused ${refusedAt}: ${objection}`,
      );
      logger.phase(
        `${ctx.tag}: contract lock refused before evaluation — ${objection}`,
        "error",
        {
          type: "warn",
          reason: "contract-lock-refused",
          ghIssue: slice.ghIssue,
          message: objection,
        },
      );
    };

    /**
     * The planner's REVISION_NOTE for `round`. A pending gate objection
     * takes the lead: it is a concrete, mechanical correction, and the
     * review it supersedes said ACCEPT.
     *
     * A REVISE reaches the planner as the review's structured findings,
     * each with its clear-condition, rather than as a pointer to prose:
     * the planner is told the observable change that resolves every gap.
     * The markdown companion is named as further reading, not as the
     * carrier of the gaps.
     */
    const revisionNote = (objection: string | null): string => {
      const openFindings = openContractReviewFindings(lastFindings);
      const priorFindings =
        openFindings.length > 0
          ? `The contract review returned REVISE with these findings. ` +
            `Respond to each clear-condition:\n\n` +
            `${formatContractReviewFindings(openFindings)}`
          : null;
      if (objection === null) {
        return priorFindings ?? "";
      }
      return (
        `The pipeline REJECTED the previous contract before any code was generated:\n\n` +
        `${objection}\n\n` +
        `Resolve exactly that in this revision.` +
        (priorFindings
          ? `\n\nKeep the previous review's findings satisfied too.\n\n${priorFindings}`
          : "")
      );
    };

    const loadBehaviorLockArtifacts = () => {
      const manifest = loadAcceptanceManifest(ctx.absSliceDir);
      if (manifest.version === 2) {
        const previous = previousSchemaValidManifest;
        previousSchemaValidManifest = manifest;
        if (previous) {
          validateAcceptanceManifestStability(previous, manifest);
        }
      }
      validateAcceptanceManifestCoverage(
        readFileSync(contractPath, "utf-8"),
        manifest,
        contractPath,
      );
      const gateCatalog = resolveBaseGateDeclarations(ctx.worktreeDir);
      validateAcceptanceManifestBindings(manifest, gateCatalog);
      return { manifest, gateCatalog };
    };

    // A contract left LOCKED on disk by an earlier run has never been
    // past the gate against *this* run's feature-branch tip. Consult it
    // before skipping negotiation altogether; a refusal reopens the
    // contract and the round loop below runs normally.
    if (contractStatus === "LOCKED") {
      let manifestObjection: string | null = null;
      try {
        loadBehaviorLockArtifacts();
      } catch (error) {
        manifestObjection =
          error instanceof Error ? error.message : String(error);
      }
      if (manifestObjection !== null) {
        refuseInvalidManifest(
          manifestObjection,
          "a previous LOCKED contract",
        );
      } else {
        lockRefusedByGate("a previous run");
      }
    }

    if (contractStatus !== "LOCKED") {
      for (let round = 1; round <= allowedContractRounds; round++) {
        // Consume any pending gate objection: it belongs to this round's
        // planner prompt only. Leaving it set would re-deliver it after a
        // later ordinary REVISE, and would make the round-cap branch
        // below misattribute that REVISE to the gate.
        const pendingObjection = gateObjection;
        gateObjection = null;
        const routedFindings =
          round === 2 ? openContractReviewFindings(lastFindings) : [];
        const requiresPlannerResponse = round === 2 && previousReview !== null;
        const previousArtifactText = requiresPlannerResponse
          ? {
              contract: readFileSync(contractPath, "utf-8"),
              manifest: readFileSync(
                join(ctx.absSliceDir, ACCEPTANCE_MANIFEST_FILENAME),
                "utf-8",
              ),
            }
          : null;

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
        rmSync(join(ctx.absSliceDir, ACCEPTANCE_MANIFEST_FILENAME), {
          force: true,
        });
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
              REVISION_NOTE: revisionNote(pendingObjection),
              CONTRACT_RESPONSE_NOTE: requiresPlannerResponse
                ? [
                    `Write ${ctx.relSliceDir}/${CONTRACT_RESPONSE_FILENAME} after revising the contract.`,
                    "Use exactly this schema:",
                    '{"version":1,"round":2,"responses":[{"findingId":"F-01","position":"UNRESOLVED","evidence":""}]}',
                    `Include one response for each routed ID and no others: ${routedFindings.map(({ id }) => id).join(", ")}.`,
                    "CONDITION_MET and CONTESTED require non-blank evidence.",
                  ].join("\n")
                : `Do not write ${CONTRACT_RESPONSE_FILENAME} in this round.`,
              MIGRATION_RESERVATION: migrationReservationBlock(config, slice.ghIssue),
              // The planner must bind every behavior to a gate the
              // lock gate can verify, so it is told the same derived
              // catalog that check reads — otherwise it can only guess
              // IDs and burn rounds on refusals.
              BASE_GATE_CATALOG: formatBaseGateCatalog(
                resolveBaseGateDeclarations(ctx.worktreeDir),
              ),
            }),
            cwd: ctx.worktreeDir,
            maxDurationMs: config.maxAgentDurationMs,
          },
          () => logger.agentLog(slice.number, "planner", round),
          requiresPlannerResponse
            ? () => {
                rmSync(
                  join(ctx.absSliceDir, CONTRACT_RESPONSE_FILENAME),
                  { force: true },
                );
              }
            : undefined,
        );
        logger.event({
          type: "phase-ended",
          ghIssue: slice.ghIssue,
          sliceNumber: slice.number,
          agent: "planner",
          round,
        });

        let acceptanceManifestBlock = "";
        let baseGateCatalogBlock = "";
        try {
          const lockArtifacts = loadBehaviorLockArtifacts();
          acceptanceManifestBlock = JSON.stringify(
            lockArtifacts.manifest,
            null,
            2,
          );
          baseGateCatalogBlock = formatBaseGateCatalog(
            lockArtifacts.gateCatalog,
          );
        } catch (error) {
          const objection =
            error instanceof Error ? error.message : String(error);
          refuseInvalidManifest(objection, `planner round ${round}`);
          lastRound = round;
          lastVerdict = "NONE";
          if (round < allowedContractRounds) continue;

          const reason =
            "the acceptance-manifest scope gate refused the final planner round";
          capDecisions.push(`Negotiation stopped because ${reason}.`);
          logger.phase(`${ctx.tag}: contract negotiation stopped: ${reason}`);
          logger.phase(`${ctx.tag}: ESCALATE — contract negotiation failed`);
          preserveContractNegotiationFailure(
            ctx,
            "ESCALATE",
            round,
            "NONE",
            lastFeedbackPath,
            capDecisions.join(" "),
          );
          const cause = negotiateVerdictCause({
            outcome: "ESCALATE",
            verdict: "NONE",
            round,
          });
          return { phase: "ESCALATE", cause };
        }

        plannerResponse = null;
        revisionArtifacts = null;
        if (requiresPlannerResponse) {
          try {
            plannerResponse = loadContractResponse(
              ctx.absSliceDir,
              routedFindings.map(({ id }) => id),
            );
            revisionArtifacts = {
              "contract.md": {
                before: previousArtifactText!.contract,
                after: readFileSync(contractPath, "utf-8"),
              },
              "acceptance-manifest.json": {
                before: previousArtifactText!.manifest,
                after: readFileSync(
                  join(ctx.absSliceDir, ACCEPTANCE_MANIFEST_FILENAME),
                  "utf-8",
                ),
              },
            };
          } catch (error) {
            const defect =
              error instanceof Error ? error.message : String(error);
            const cause = negotiationArtifactCause(
              "planner",
              "contract response",
              defect,
            );
            logger.phase(`${ctx.tag}: ${cause.summary}`, "error", {
              type: "phase-ended",
              ghIssue: slice.ghIssue,
              sliceNumber: slice.number,
              agent: "planner",
              round,
              verdict: "NONE",
            });
            return { phase: "ERROR", cause };
          }
        }

        evaluatorRound++;
        logger.phase(
          `${ctx.tag}: evaluating contract (round ${round}/${allowedContractRounds})...`,
          "error",
          {
            type: "phase-started",
            ghIssue: slice.ghIssue,
            sliceNumber: slice.number,
            agent: "evaluator-contract",
            round: evaluatorRound,
          },
        );
        const feedbackPath = join(
          ctx.absSliceDir,
          `feedback-r${evaluatorRound}.md`,
        );
        const reviewPath = join(ctx.absSliceDir, CONTRACT_REVIEW_FILENAME);
        let latestValidAttemptReview: ContractReview | null = null;
        let attemptLifecyclePrevious: ContractReview | null = null;
        await invokeAgent(
          {
            role: "evaluator-contract",
            prompt: renderPrompt("evaluator-contract", {
              SPECS_DIR: ctx.relSpecsDir,
              SLICE_DIR: ctx.relSliceDir,
              ROUND: evaluatorRound,
              RELEVANT_FILES: relevantFilesBlock,
              PREVIOUS_REVIEW_NOTE:
                evaluatorRound > 1
                  ? `A previous round's findings were handed to the planner. ` +
                    `Its prose companion is ${ctx.relSliceDir}/feedback-r${evaluatorRound - 1}.md. ` +
                    `Reuse a finding's exact \`id\` when the same gap still stands — ` +
                    `the orchestrator measures repeated gaps by ID.`
                  : "This is the first review round; every finding ID is new.",
              ACCEPTANCE_MANIFEST: acceptanceManifestBlock,
              BASE_GATE_CATALOG: baseGateCatalogBlock,
              CONTRACT_REVIEW_FILE: CONTRACT_REVIEW_FILENAME,
              PLANNER_RESPONSE: plannerResponse
                ? JSON.stringify(plannerResponse, null, 2)
                : "(first review round; no planner response)",
              REVISION_CONTEXT: revisionArtifacts
                ? JSON.stringify(revisionArtifacts, null, 2)
                : "(first review round; no prior revision)",
            }),
            cwd: ctx.worktreeDir,
            maxDurationMs: config.maxAgentDurationMs,
          },
          () =>
            logger.agentLog(
              slice.number,
              "evaluator-contract",
              evaluatorRound,
            ),
          // Both artifacts are deleted before every attempt, so a stale
          // review from an earlier attempt or round can never be read as
          // this attempt's verdict.
          () => {
            attemptLifecyclePrevious = latestValidAttemptReview;
            rmSync(feedbackPath, { force: true });
            rmSync(reviewPath, { force: true });
          },
          (attempt) => {
            const archived = archiveContractReviewAttempt(
              ctx,
              reviewArchiveDir,
              evaluatorRound,
              attempt,
              previousReview,
              plannerResponse,
              revisionArtifacts,
              attemptLifecyclePrevious ?? previousReview,
            );
            if (archived) {
              latestValidAttemptReview = archived.review;
              lastReviewAttemptRecord = archived.record;
            }
          },
        );

        lastRound = round;
        lastFeedbackPath = feedbackPath;

        let review: ContractReview;
        try {
          review = loadContractReview(ctx.absSliceDir);
          if (evaluatorRound === 1) {
            validateRound1ContractReview(review);
          } else if (previousReview && plannerResponse) {
            validateRound2ContractReview(
              previousReview,
              plannerResponse,
              review,
              revisionArtifacts ?? undefined,
              attemptLifecyclePrevious ?? previousReview,
            );
          }
        } catch (error) {
          // The evaluator finished but said nothing the orchestrator can
          // act on. There is no default verdict and no extra round: a
          // malformed, missing, or self-contradictory review artifact is
          // terminal, and the operator gets the artifact named. See
          // ADR 0017 for the earlier, weaker version of this rule.
          const defect = error instanceof Error ? error.message : String(error);
          const cause = reviewArtifactCause(defect);
          logger.phase(`${ctx.tag}: ${cause.summary}`, "error", {
            type: "phase-ended",
            ghIssue: slice.ghIssue,
            sliceNumber: slice.number,
            agent: "evaluator-contract",
            round: evaluatorRound,
            verdict: "NONE",
          });
          logger.bumpEvalRound(slice.ghIssue, evaluatorRound);
          return { phase: "ERROR", cause };
        }

        const verdict = review.verdict;
        const metrics = contractReviewGapMetrics(review, previousReview);
        logger.phase(
          `${ctx.tag}: contract verdict ${verdict} (round ${round}/${allowedContractRounds})` +
            ` — ${metrics.gapCount} blocking finding(s)`,
          "error",
          {
            type: "phase-ended",
            ghIssue: slice.ghIssue,
            sliceNumber: slice.number,
            agent: "evaluator-contract",
            round: evaluatorRound,
            verdict,
          },
        );
        lastVerdict = verdict;
        lastFindings = review.findings;
        if (verdict === "ACCEPT") {
          // Deliberately not withContractTransaction: ordinary negotiation
          // has no previously-accepted contract/manifest pair to capture
          // and restore — the pair being written IS the first accepted
          // one. The stamp keeps lock provenance uniform (ADR 0055 §4);
          // the two revision paths, which do mutate an accepted pair, go
          // through the shared transaction's single lock exit.
          artifacts.lockContract(contractPath, {
            kind: "negotiation",
            round,
          });
          contractStatus = "LOCKED";
        } else {
          contractStatus = artifacts.readContractStatus(contractPath);
        }
        // A refused lock falls through to the round-spending logic
        // below: the gate costs exactly what an evaluator REVISE costs.
        if (contractStatus === "LOCKED" && !lockRefusedByGate(`round ${round}`))
          break;

        if (round === allowedContractRounds) {
          const reason = gateObjection
            ? "the contract-lock gate refused the final round's contract"
            : `the negotiation reached its hard cap of ${allowedContractRounds} planner round(s)`;
          capDecisions.push(`Negotiation stopped because ${reason}.`);
          logger.phase(`${ctx.tag}: contract negotiation stopped: ${reason}`);
        } else {
          previousReview = review;
          continue;
        }

        const negotiationOutcome =
          evaluatorRound === 2 && lastReviewAttemptRecord
            ? buildContractNegotiationOutcome(lastReviewAttemptRecord)
            : undefined;
        const impasse = negotiationOutcome?.classification === "IMPASSE";
        logger.phase(
          `${ctx.tag}: ${impasse ? "AWAITING-ADJUDICATION" : "ESCALATE"} — ` +
            `contract negotiation failed`,
        );
        preserveContractNegotiationFailure(
          ctx,
          "ESCALATE",
          round,
          verdict,
          feedbackPath,
          capDecisions.join(" "),
          review.findings,
          negotiationOutcome,
        );
        logger.bumpEvalRound(slice.ghIssue, evaluatorRound);
        if (impasse) {
          return {
            phase: "AWAITING-ADJUDICATION",
            cause: negotiateImpasseCause(negotiationOutcome, verdict),
          };
        }
        // A mixed exhaustion routes here on purpose (ADR 0055 §1), but the
        // contest must not vanish from what the operator reads: the summary
        // is the run-state reason `afk status` and the retry line show, and
        // it was silent about a held contest until now. stuck.md carries the
        // two positions themselves.
        const cause =
          negotiationMixedExhaustionCause(negotiationOutcome, verdict, round) ??
          negotiateVerdictCause({
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
        lastFindings,
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
  | {
      outcome: "PASS";
      report: string;
      history: readonly QAReviewLifecycleFinding[];
      unresolved: QAReviewAttemptFinding[];
    }
  | {
      outcome: "IMPLEMENTATION";
      report: string;
      history: readonly QAReviewLifecycleFinding[];
      unresolved: QAReviewAttemptFinding[];
    };

/**
 * The repair input a retry or resume round is handed for each finding it
 * must clear. Exported so the field set can be asserted without spawning
 * a pipeline: the contract is that *every* `QAReviewAttemptFinding` field
 * reaches the generator (#82 B-03), and a silently shrinking subset here
 * is invisible to a template test that supplies its own string.
 */
export function formatUnresolvedQAFindings(
  findings: readonly QAReviewAttemptFinding[],
): string {
  if (findings.length === 0) return "(none)";
  return findings
    .map(
      (finding) =>
        [
          `- Finding ID: \`${finding.id}\``,
          `  Severity: ${finding.severity}`,
          `  State: ${finding.state}`,
          `  Unresolved: ${finding.unresolved ? "yes" : "no"}`,
          `  Remedy: ${finding.remedy}`,
          `  Summary: ${finding.summary}`,
          `  Clear condition: ${finding.clearCondition}`,
          "  Artifact references:",
          ...finding.artifactReferences.map((path) => `  - \`${path}\``),
        ].join("\n"),
    )
    .join("\n");
}

/**
 * What the orchestrator knows about the base gates it ran for this round,
 * handed to QA so the evaluator can be authorized to cite them (ADR 0012's
 * 2026-08-28 amendment). Omitted by callers that have no gate run to offer;
 * QA then behaves exactly as it did before the amendment.
 */
export interface QABaseGateEvidence {
  evidence: GateEvidence;
  /** Repo-relative path of the verified evidence artifact. */
  evidenceArtifactId: string;
  declarations: readonly GateDeclaration[];
}

export async function runQAStage(
  ctx: SliceContext,
  round: number,
  stage: QAReviewStage,
  history: readonly QAReviewLifecycleFinding[],
  previousUnresolved: readonly QAReviewAttemptFinding[] = [],
  baseGate: QABaseGateEvidence | null = null,
): Promise<QAStageResult> {
  const { config, slice, logger, invoke, featBranch } = ctx;
  const infrastructureRetries = config.infrastructureRetries ?? DEFAULT_INFRASTRUCTURE_RETRIES;
  if (!Number.isSafeInteger(infrastructureRetries) || infrastructureRetries < 0) {
    throw new Error("infrastructureRetries must be a non-negative integer");
  }
  const commandTimeoutMs = config.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const heartbeatIntervalMs = config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const reportName = stage === "deterministic" ? "qa-report.md" : "uat-report.md";
  const reportPath = join(ctx.absSliceDir, reportName);
  const reportDisplayPath = `${ctx.relSliceDir}/${reportName}`;
  const reviewName = qaReviewFilename(stage);
  const reviewPath = join(ctx.absSliceDir, reviewName);
  const reviewArchiveDir = artifacts.contractReviewArchiveDir(
    config.repoRoot,
    pipelineRunSlug(config.prdSlug, config.provider ?? kiroProvider),
    slice.number,
  );
  const scope = stage === "deterministic"
    ? "Deterministic slice QA only. Do not access a shared preview database or run remote UAT."
    : "Shared-preview UAT only. Do not repeat deterministic sanity commands.";
  let currentHistory = history;
  let currentUnresolved = previousUnresolved;
  /**
   * Extra attempts this stage-round has earned by applying a scope
   * amendment (#112). An amendment changes the contract the tree is
   * graded against, so the grade has to be taken again — and only the
   * evaluator can take it, since a boundary failure in Pass 1 means
   * Pass 2 never ran.
   */
  let amendments = 0;
  /** Attempts this stage-round may still spend, amendments included. */
  const attemptLimit = () => infrastructureRetries + 1 + amendments;

  /**
   * Decide the skip authorization for one attempt (ADR 0012, 2026-08-28).
   *
   * Per attempt, not once per stage, because an attempt is only reached by an
   * infrastructure retry or a scope amendment's extra attempt (#112) — and
   * the previous attempt archived its report into the worktree, so the tree
   * has moved. Re-hashing lets that fall closed instead of citing a gate run
   * against a tree that no longer exists.
   *
   * Only the deterministic stage can be authorized: shared-preview UAT is
   * told to skip the sanity list outright and run remote scenarios, so there
   * is nothing to dedup.
   */
  const authorizeSkip = (): BaseGateSkipAuthorization => {
    if (stage !== "deterministic") {
      // Refusing is what denies the citation; the prompt renders its own UAT
      // wording, because the generic refusal ends by ordering the sanity run
      // that UAT's scope forbids.
      return {
        authorized: false,
        reason:
          "shared-preview UAT does not run the deterministic sanity list",
      };
    }
    if (!baseGate) {
      return {
        authorized: false,
        reason: "no base-gate run was handed to this QA stage",
      };
    }
    let reviewTreeId: string | null = null;
    try {
      reviewTreeId = resolveCandidateTreeId(ctx.worktreeDir);
    } catch (error) {
      // Hashing the candidate is the whole basis of the authorization, so a
      // failure here is not an error to propagate — it is simply no
      // authorization, and QA runs the gates as it always did.
      logger.phase(
        `${ctx.tag}: could not hash the tree under review; QA will re-run ` +
          `the base gates (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    return authorizeBaseGateSkip({ ...baseGate, reviewTreeId });
  };

  for (let attempt = 1; attempt <= attemptLimit(); attempt++) {
    const archiveName = stage === "deterministic"
      ? `qa-report-r${round}-a${attempt}.md`
      : `uat-report-r${round}-a${attempt}.md`;
    const archivePath = join(ctx.absSliceDir, archiveName);
    const skipAuthorization = authorizeSkip();
    type AttemptEvidence = {
      rawArchiveName: string | null;
      reportArchived: boolean;
      /**
       * Why the refusal evidence for an invalid canonical artifact could
       * not itself be preserved, or `null` when nothing was lost (#124).
       *
       * Carried out of the archive step instead of thrown from it because
       * the two callers must fail in different places: on the success
       * path the attempt already ends the slice a few lines below, and on
       * the invoke-failure path the attempt is about to be retried as
       * infrastructure — that retry is what has to stop, or a later
       * attempt's PASS ships without the refused attempt's evidence.
       */
      validationArchiveError: string | null;
      reviewResult:
        | {
            review: QAReview;
            nextHistory: readonly QAReviewLifecycleFinding[];
          }
        | { error: string };
    };
    type ValidAttemptEvidence = {
      review: QAReview;
      nextHistory: readonly QAReviewLifecycleFinding[];
      unresolved: QAReviewAttemptFinding[];
      reportArchived: boolean;
      archiveDisplayPath: string;
    };

    const archiveAttemptEvidence = (): AttemptEvidence => {
      // Required evidence fails closed (#79): a raw canonical artifact
      // that cannot be preserved must not let this attempt count. The
      // throw lands in the attempt-level catch, where it is treated as
      // an infrastructure failure — retried, then exhausted as ERROR —
      // never as a warning underneath a later PASS.
      let rawArchiveName: string | null;
      try {
        rawArchiveName = artifacts.archiveQAReviewAttempt({
          sliceDir: ctx.absSliceDir,
          archiveDir: reviewArchiveDir,
          stage,
          round,
          attempt,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `${stage} review round ${round} attempt ${attempt} could not ` +
            `preserve its raw canonical artifact in ${reviewArchiveDir}: ${message}`,
        );
      }
      const reportArchived = artifacts.archiveQAReport(reportPath, archivePath);

      try {
        const review = loadQAReview(ctx.absSliceDir, stage);
        return {
          rawArchiveName,
          reportArchived,
          validationArchiveError: null,
          reviewResult: {
            review,
            nextHistory: advanceQAReviewHistory(currentHistory, review),
          },
        };
      } catch (error) {
        const evidence = error instanceof Error ? error.message : String(error);
        let validationArchiveError: string | null = null;
        try {
          artifacts.archiveQAReviewValidation({
            archiveDir: reviewArchiveDir,
            stage,
            round,
            attempt,
            evidence,
          });
        } catch (archiveError) {
          validationArchiveError =
            archiveError instanceof Error
              ? archiveError.message
              : String(archiveError);
          logger.phase(
            `${ctx.tag}: ${stage} review round ${round} attempt ${attempt} ` +
              `could not preserve its validation evidence: ${validationArchiveError}`,
            "error",
            {
              type: "warn",
              reason: "qa-review-archive-failed",
              ghIssue: slice.ghIssue,
              message: validationArchiveError,
            },
          );
        }
        return {
          rawArchiveName,
          reportArchived,
          validationArchiveError,
          reviewResult: { error: evidence },
        };
      }
    };

    /**
     * How a lost validation write reads in the failure that carries it
     * (#124). Both throw sites name the archive dir, so an operator sees
     * the occupied or unwritable location, not only the OS message.
     */
    const validationArchiveNote = (lost: string): string =>
      `${stage} review round ${round} attempt ${attempt} could not ` +
      `preserve its validation evidence in ${reviewArchiveDir}: ${lost}`;

    /**
     * Read `validationArchiveError` off evidence that may be absent.
     * A function rather than a property access because the caller's
     * holder is only ever assigned from a closure: TypeScript's flow
     * analysis sees just the `null` initialiser and narrows the guarded
     * value to `never`, which has no properties.
     */
    const lostValidationEvidence = (
      evidence: AttemptEvidence | null,
    ): string | null => evidence?.validationArchiveError ?? null;

    const recordValidAttempt = (
      evidence: AttemptEvidence,
    ): ValidAttemptEvidence | null => {
      if ("error" in evidence.reviewResult) return null;

      const archiveDisplayPath = `${ctx.relSliceDir}/${archiveName}`;
      const { review, nextHistory } = evidence.reviewResult;
      const expectedRawArchiveName =
        `${stage === "deterministic" ? "qa" : "uat"}-review-r${round}-a${attempt}.json`;
      const canonicalArchivePath = relative(
        config.repoRoot,
        join(
          reviewArchiveDir,
          evidence.rawArchiveName ?? expectedRawArchiveName,
        ),
      ).replace(/\\/g, "/");
      const record = buildQAReviewAttemptRecord({
        stage,
        round,
        attempt,
        review,
        canonicalArchivePath,
        markdownArchivePath: archiveDisplayPath,
        baseGateCitation: skipAuthorization.authorized
          ? skipAuthorization.citation
          : null,
      });
      // Required evidence fails closed (#79): a lifecycle record that
      // cannot be preserved must not let the attempt's verdict stand.
      // The review outcome is already known, so a retry would re-invoke
      // the evaluator over a local write failure; instead the throw
      // propagates and ends the slice as ERROR without merging.
      try {
        artifacts.archiveQAReviewRecord({
          archiveDir: reviewArchiveDir,
          record,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `${stage} review round ${round} attempt ${attempt} could not ` +
            `preserve its lifecycle record in ${reviewArchiveDir}: ${message}`,
        );
      }
      const unresolved =
        review.failureClass === "INFRASTRUCTURE"
          ? [...currentUnresolved]
          : record.findings.filter((finding) => finding.unresolved);
      currentHistory = nextHistory;
      currentUnresolved = unresolved;
      return {
        review,
        nextHistory,
        unresolved,
        reportArchived: evidence.reportArchived,
        archiveDisplayPath,
      };
    };

    let failedAttemptEvidence: AttemptEvidence | null = null;
    const invokeEvaluator = async (): Promise<AttemptEvidence> => {
      rmSync(reportPath, { force: true });
      rmSync(reviewPath, { force: true });
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
      try {
        await invoke({
          role: "evaluator-qa",
          prompt: renderPrompt("evaluator-qa", {
            SLICE_DIR: ctx.relSliceDir,
            RELEVANT_FILES: ctx.relevantFilesBlock,
            SIBLING_HANDOFFS: ctx.siblingHandoffsBlock,
            // No TEST_COMMAND: QA is told the sanity command set and
            // nothing else, so a narrowed generator command cannot reach
            // it (ADR 0038). `renderPrompt` enforces this — the template
            // rejects an arg it does not reference.
            SANITY_COMMANDS: ctx.sanityCommandsBlock,
            // Orchestrator-asserted gate evidence, or the reason there is
            // none (ADR 0012, 2026-08-28). Always rendered: an evaluator
            // that reads "no authorization is in force" cannot mistake a
            // missing block for a granted skip. UAT gets its own line —
            // the formatter's refusal orders the sanity run, which is
            // exactly what the UAT scope forbids.
            BASE_GATE_AUTHORIZATION:
              stage === "deterministic"
                ? formatBaseGateSkipAuthorization(skipAuthorization)
                : "No skip authorization applies to shared-preview UAT — " +
                  "your scope already excludes the deterministic sanity list.",
            QA_SCOPE: scope,
            REPORT_PATH: reportDisplayPath,
            UNRESOLVED_FINDINGS:
              formatUnresolvedQAFindings(currentUnresolved),
            COMMAND_TIMEOUT_SECONDS: Math.ceil(commandTimeoutMs / 1_000),
            HEARTBEAT_SECONDS: Math.ceil(heartbeatIntervalMs / 1_000),
          }),
          cwd: ctx.worktreeDir,
          logStream: evalLog,
          ...longCommandRoleBounds({
            idleTimeoutMs: commandTimeoutMs,
            idleWarningIntervalMs: heartbeatIntervalMs,
            maxDurationMs: config.maxAgentDurationMs,
          }),
        }).finally(() => closeAgentLog(evalLog));
      } catch (error) {
        // `archiveAttemptEvidence` can itself throw (raw canonical
        // archive fails closed, #79). Without chaining, that throw
        // would replace the evaluator failure that got us here and the
        // root cause would vanish from the retry warns and the final
        // ERROR message. Cancellation is rethrown as-is so it stays
        // recognisable to `isCancelled`.
        try {
          failedAttemptEvidence = archiveAttemptEvidence();
        } catch (archiveError) {
          if (isCancelled(error, config.signal)) throw error;
          const archiveMessage =
            archiveError instanceof Error
              ? archiveError.message
              : String(archiveError);
          const invokeMessage =
            error instanceof Error ? error.message : String(error);
          throw new Error(
            `${archiveMessage} (while handling evaluator failure: ${invokeMessage})`,
            { cause: error },
          );
        }
        throw error;
      }
      return archiveAttemptEvidence();
    };

    let attemptEvidence: AttemptEvidence;
    try {
      if (stage === "shared-preview") {
        const lockPath = config.sharedPreview!.lockPath ??
          join(config.repoRoot, ".afk", "locks", "shared-preview.lock");
        attemptEvidence = await withCrossProcessLock(
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
        attemptEvidence = await invokeEvaluator();
      }
    } catch (error) {
      if (isCancelled(error, config.signal)) throw error;
      const failure = error instanceof Error ? error.message : String(error);
      const lostValidation = lostValidationEvidence(failedAttemptEvidence);
      if (failedAttemptEvidence) {
        recordValidAttempt(failedAttemptEvidence);
      }
      // Required evidence fails closed (#124). The refused attempt's
      // validation file is the only record that this attempt happened,
      // and the infrastructure retry below is what would bury the loss:
      // attempt N+1 can PASS and ship the slice with attempt N's evidence
      // missing. The evidence is already in hand — a retry re-invokes the
      // evaluator over a local write failure and can never recover it —
      // so the slice ends ERROR instead, the same way an unarchivable
      // lifecycle record does.
      if (lostValidation) {
        throw new Error(
          `${validationArchiveNote(lostValidation)} ` +
            `(while handling evaluator failure: ${failure})`,
          { cause: error },
        );
      }
      if (attempt < attemptLimit()) {
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
        `${stage} infrastructure failed after ${attempt} attempt(s): ${failure}`,
      );
    }

    const { reviewResult } = attemptEvidence;
    if ("error" in reviewResult) {
      // This attempt already ends the slice, so the lost validation write
      // (#124) changes no control flow here — it is reported so the
      // operator knows the refusal was never written down.
      const lost = attemptEvidence.validationArchiveError;
      throw new Error(
        `${stage} review artifact ERROR: ${reviewResult.error}` +
          (lost ? `; ${validationArchiveNote(lost)}` : ""),
      );
    }
    const validAttempt = recordValidAttempt(attemptEvidence)!;
    if (!validAttempt.reportArchived) {
      if (attempt < attemptLimit()) continue;
      throw new Error(`${stage} evaluator produced no report after ${attempt} attempt(s)`);
    }

    const {
      review,
      nextHistory,
      unresolved,
      archiveDisplayPath,
    } = validAttempt;

    // A scope-amendment finding is the orchestrator's to clear, never the
    // generator's (#112, ADR 0008). It is handled before the verdict is
    // acted on, so a finding whose only available remedy is deleting
    // correct work never reaches a generator round.
    const requests = scopeAmendmentRequests(review);
    if (requests.length > 0) {
      const requested = requests
        .map(
          (request) => `${request.findingId} (${request.paths.join(", ")})`,
        )
        .join("; ");
      // Fail closed on a probe that could not answer. `planScopeAmendment`
      // refuses any requested path that is not in `changedFiles`, so a
      // swallowed git failure used to make every requested path look
      // untouched and produce a refusal blaming the evaluator for a defect
      // git had (see `ChangedFilesProbe`). Same decision as the escalation
      // guard below and as the estate probe: prove it or refuse by name.
      const changed = git.listChangedFiles(ctx.worktreeDir, featBranch);
      if (!changed.ok) {
        throw new Error(
          `${stage} scope amendment refused in round ${round} attempt ` +
            `${attempt}: the set of files this slice changed could not be ` +
            `determined — ${changed.failure}. Requested: ${requested}. The ` +
            `contract is unchanged and no work was reverted; nothing may be ` +
            `added to or kept out of the locked scope on an unproven tree.`,
        );
      }
      const plan = planScopeAmendment({
        requests,
        manifest: loadAcceptanceManifest(ctx.absSliceDir),
        changedFiles: changed.paths,
        options: { migrationPathPattern: config.migrationPathPattern },
      });
      if (!plan.ok) {
        throw new Error(
          `${stage} scope amendment refused in round ${round} attempt ` +
            `${attempt}: ${plan.refusal}. Requested: ${requested}. The ` +
            `contract is unchanged and no work was reverted; amend the ` +
            `contract by hand or renegotiate it before resuming.`,
        );
      }
      if (amendments >= MAX_SCOPE_AMENDMENTS_PER_ROUND) {
        throw new Error(
          `${stage} scope amendment refused in round ${round} attempt ` +
            `${attempt}: round ${round} already spent its ` +
            `${MAX_SCOPE_AMENDMENTS_PER_ROUND} amendment(s) and the tree has ` +
            `not changed since. Requested: ${requested}. Add the path(s) to ` +
            `the contract by hand before resuming.`,
        );
      }
      // The third path that mutates the accepted pair, and so the third
      // caller of the one transaction (ADR 0055 Seam 1 §3). It writes the
      // manifest first and the contract second, and the contract write can
      // refuse (no `## Files expected to change` section) or simply fail —
      // which left a widened manifest beside an unwidened contract, exactly
      // the desync ADR 0048 makes the orchestrator responsible for, with a
      // *locked* contract to boot. It never locks, so no `tx.lock` here:
      // what it needs is the capture/restore boundary and the guarantee
      // that the archive is only written over a coherent pair.
      try {
        await withContractTransaction(
          ctx,
          {
            reason: `${stage} scope amendment did not complete`,
            qualifier: "the previously accepted",
            note:
              `the requested path(s) were not added, and the recorded QA ` +
              `finding(s) ${requested} still stand`,
          },
          async (tx) => {
            applyScopeAmendment({ sliceDir: ctx.absSliceDir, plan });
            artifacts.archiveScopeAmendment({
              archiveDir: reviewArchiveDir,
              record: buildScopeAmendmentRecord({
                stage,
                round,
                attempt,
                plan,
              }),
            });
            tx.onAccepted();
          },
        );
      } catch (error) {
        throw new Error(
          `${stage} scope amendment failed in round ${round} attempt ` +
            `${attempt}: ${
              error instanceof Error ? error.message : String(error)
            }. Requested: ${requested}. The accepted contract.md and ` +
            `acceptance-manifest.json were restored to the bytes the lock ` +
            `accepted and no work was reverted; add the path(s) by hand or ` +
            `renegotiate the contract before resuming.`,
        );
      }
      amendments++;
      const amended = plan.entries.map((entry) => entry.path).join(", ");
      const message =
        `${stage} scope amendment applied for ${requested}: added ${amended} ` +
        `to the locked file scope; re-grading round ${round} without ` +
        `consuming an implementation round`;
      logger.phase(`${ctx.tag}: ${message}`, "error", {
        type: "warn",
        reason: "scope-amended",
        ghIssue: slice.ghIssue,
        message,
      });
      continue;
    }

    if (review.verdict === "PASS") {
      return {
        outcome: "PASS",
        report: archiveDisplayPath,
        history: nextHistory,
        unresolved,
      };
    }
    if (review.failureClass === "INFRASTRUCTURE") {
      if (attempt < attemptLimit()) {
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
    return {
      outcome: "IMPLEMENTATION",
      report: archiveDisplayPath,
      history: nextHistory,
      unresolved,
    };
  }

  throw new Error(`${stage} QA exhausted without a result`);
}

function assertGateEvidenceReleasesEvaluation(
  evidence: GateEvidence,
  declarations: readonly GateDeclaration[],
  treeId: string,
): void {
  const complete =
    evidence.treeId === treeId &&
    evidence.results.length === declarations.length &&
    evidence.results.every((result, index) => {
      const declaration = declarations[index];
      return (
        declaration != null &&
        result.gateId === declaration.id &&
        result.stage === declaration.stage &&
        result.treeId === treeId &&
        (!declaration.required || result.status === "PASS")
      );
    });
  if (!complete) {
    throw new Error(
      `Gate evidence does not release evaluation for checkpoint ${treeId}`,
    );
  }
}

export function collectRequiredGateFailures(
  attempts: readonly { evidence: GateEvidence; evidencePath: string }[],
  declarations: readonly GateDeclaration[],
): Array<{ evidencePath: string; result: GateResult }> {
  const requiredGateIds = new Set(
    declarations
      .filter((declaration) => declaration.required)
      .map((declaration) => declaration.id),
  );
  return attempts.flatMap(({ evidence, evidencePath }) =>
    evidence.results
      .filter(
        (result) =>
          requiredGateIds.has(result.gateId) && result.status === "FAIL",
      )
      .map((result) => ({ evidencePath, result })),
  );
}

export async function runSliceExecute(
  ctx: SliceContext,
): Promise<Extract<TerminalOutcome, { phase: "PASS" | "STUCK" | "ERROR" | "CANCELLED" }>> {
  const { config, slice, logger, featBranch, invoke } = ctx;
  const { signal } = config;
  const stuckReferences = ctx.resume
    ? artifacts.readStuckDiagnosisAdditionalArtifactReferences(ctx.absSliceDir)
    : [];
  const gateArtifacts: GateEvidenceArtifact[] = [];
  let deterministicHistory: readonly QAReviewLifecycleFinding[] = [];
  let deterministicUnresolved: readonly QAReviewAttemptFinding[] = [];
  let sharedPreviewHistory: readonly QAReviewLifecycleFinding[] = [];
  let sharedPreviewUnresolved: readonly QAReviewAttemptFinding[] = [];
  let resumedUnresolved: readonly QAReviewAttemptFinding[] = [];
  let firstRound = 1;
  let retryNote = "";
  const reviewArchiveDir = artifacts.contractReviewArchiveDir(
    config.repoRoot,
    pipelineRunSlug(config.prdSlug, config.provider ?? kiroProvider),
    slice.number,
  );
  /**
   * The only constructor of a STUCK return in this function (ADR 0055 P1).
   * Every reason routes through here, so every STUCK outcome ships the
   * code-assembled `stuck.md` slice 04 promised — including the ones that
   * refuse late, after QA passed and the work was committed.
   */
  const finishStuck = (
    reason = `QA failed after ${MAX_GENERATOR_ROUNDS} implementation rounds`,
  ): Extract<TerminalOutcome, { phase: "STUCK" }> => {
    logger.phase(`${ctx.tag}: stuck — writing diagnosis...`, "error");
    artifacts.writeStuckDiagnosis(ctx.absSliceDir, {
      reason,
      reviewArchiveDir,
      additionalArtifactReferences: stuckReferences,
      commitLog: git.logCommitsWithStat(ctx.worktreeDir, featBranch),
    });
    return { phase: "STUCK", error: reason };
  };
  /**
   * A STUCK resume's `stuck.md` is the operator's audit record of why the
   * extra attempt was granted, so it must read the same after the attempt
   * as before it (#82 AC3). The shared resume prompt tells the generator
   * to leave it alone, but a prompt is guidance, not a guarantee: capture
   * the bytes at entry and put them back on the way out.
   *
   * Only on success. A failed attempt legitimately rewrites the diagnosis
   * from the new round's evidence, which is `finishStuck`'s job (B-04).
   */
  const stuckDiagnosisAtEntry =
    ctx.resume?.mode === "stuck"
      ? artifacts.readStuckDiagnosis(ctx.absSliceDir)
      : null;
  const restoreStuckDiagnosis = (): void => {
    if (stuckDiagnosisAtEntry === null) return;
    if (artifacts.restoreStuckDiagnosis(ctx.absSliceDir, stuckDiagnosisAtEntry))
      logger.phase(
        `${ctx.tag}: restored the preserved stuck.md diagnosis the resumed generator changed`,
        "error",
      );
  };

  try {
    if (ctx.resume) {
      const restored = loadQAReviewResumeState(
        reviewArchiveDir,
        ctx.absSliceDir,
      );
      deterministicHistory = restored.deterministic.history;
      deterministicUnresolved = restored.deterministic.unresolved;
      sharedPreviewHistory = restored.sharedPreview.history;
      sharedPreviewUnresolved = restored.sharedPreview.unresolved;
      resumedUnresolved =
        restored.retryStage === "deterministic"
          ? deterministicUnresolved
          : restored.retryStage === "shared-preview"
            ? sharedPreviewUnresolved
            : [];
      firstRound = restored.nextRound;
    }
    // The three-round cap is global across a slice's lives (ADR 0014):
    // an ordinary resume restores the round counter from archived
    // evidence and receives only the rounds still unspent under
    // MAX_GENERATOR_ROUNDS, not a fresh budget of three. Only a STUCK
    // resume earns headroom beyond the cap — its documented single
    // extra attempt. A resume whose evidence already shows the cap
    // spent gets zero attempts and falls through to the STUCK return.
    //
    // Shared with the dispatch bounds line so the number the operator
    // was told at dispatch is the number this loop runs on.
    const implementationAttemptLimit = implementationRoundsRemaining({
      limit: MAX_GENERATOR_ROUNDS,
      spent: firstRound - 1,
      resumeMode: ctx.resume?.mode,
    });
    const finalRound = firstRound + implementationAttemptLimit - 1;

    for (
      let implementationAttempt = 1;
      implementationAttempt <= implementationAttemptLimit;
      implementationAttempt++
    ) {
      const round = firstRound + implementationAttempt - 1;
      logger.bumpGenRound(slice.ghIssue, round);
      const timeoutMs = config.commandTimeoutMs ?? SLOW_AGENT_IDLE_TIMEOUT_MS;
      const heartbeatMs =
        config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
      const escalationPath = join(ctx.absSliceDir, ESCALATION_FILENAME);
      let generatorAttempt = 0;
      let scopeRevisions = 0;
      let scopeRevisionNote = "";
      while (true) {
        generatorAttempt++;
        logger.phase(
          `${ctx.tag}: implementing (round ${round}/${finalRound})...`,
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
        const generatorPromptBase =
          implementationAttempt === 1 && ctx.resume
              ? renderPrompt("generator-resume", {
                  SLICE_DIR: ctx.relSliceDir,
                  RELEVANT_FILES: ctx.relevantFilesBlock,
                  SIBLING_HANDOFFS: ctx.siblingHandoffsBlock,
                  TEST_COMMAND: ctx.testCommand,
                  COMMITS_AHEAD: ctx.resume.commitsAhead,
                  COMMIT_LOG: ctx.resume.commitLog,
                  WORKTREE_STATE:
                    ctx.resume.mode === "stuck"
                      ? "**Your worktree was not touched.** Nothing was reset, cleaned, or dropped. Every committed change and uncommitted edit remains exactly where the previous attempt left it. Treat dirty-tree state as real work-in-progress."
                      : "Your worktree was reset to your last commit. Uncommitted changes were discarded; anything after your last commit is gone and must be redone.",
                  BASE_REFRESH_NOTE:
                    ctx.resume.mode === "stuck"
                      ? ctx.resume.baseRefreshed
                        ? `The feature branch \`${featBranch}\` was merged into your branch just before this run, so your verification world is current.`
                        : `The feature branch \`${featBranch}\` could **not** be merged into your branch cleanly, and your tree was preserved rather than rebuilt. Your verification world may be behind the feature branch — do not assume sibling work is visible here.`
                      : `The feature branch \`${featBranch}\` was merged into your branch just before this run. Your verification world is current: work merged by sibling slices while you were away is now part of your tree.`,
                  STUCK_NOTE:
                    ctx.resume.mode === "stuck"
                      ? ctx.resume.stuckNote ?? ""
                      : "",
                  UNRESOLVED_FINDINGS:
                    formatUnresolvedQAFindings(resumedUnresolved),
                  HANDOFF_NOTE: ctx.resume.handoffNote,
                  MIGRATION_RESERVATION: migrationReservationBlock(
                    config,
                    slice.ghIssue,
                  ),
                })
              : renderPrompt("generator", {
                  SLICE_DIR: ctx.relSliceDir,
                  RELEVANT_FILES: ctx.relevantFilesBlock,
                  SIBLING_HANDOFFS: ctx.siblingHandoffsBlock,
                  TEST_COMMAND: ctx.testCommand,
                  RETRY_NOTE:
                    implementationAttempt > 1 ? retryNote : "",
                  MIGRATION_RESERVATION: migrationReservationBlock(
                    config,
                    slice.ghIssue,
                  ),
                });
        const generatorPrompt = scopeRevisionNote
          ? `${generatorPromptBase}\n\n${scopeRevisionNote}`
          : generatorPromptBase;
        rmSync(escalationPath, { force: true });
        await invoke({
          role: "generator",
          prompt: generatorPrompt,
          cwd: ctx.worktreeDir,
          logStream: genLog,
          ...longCommandRoleBounds({
            idleTimeoutMs: timeoutMs,
            idleWarningIntervalMs: heartbeatMs,
            maxDurationMs: config.maxAgentDurationMs,
          }),
        }).finally(() => closeAgentLog(genLog));
        logger.event({
          type: "phase-ended",
          ghIssue: slice.ghIssue,
          sliceNumber: slice.number,
          agent: "generator",
          round,
        });

        if (!existsSync(escalationPath)) break;

        artifacts.archiveScopeEscalationAttempt({
          sliceDir: ctx.absSliceDir,
          archiveDir: reviewArchiveDir,
          round,
          attempt: generatorAttempt,
        });
        const lockedManifest = loadAcceptanceManifest(ctx.absSliceDir);
        const escalation = parseScopeEscalation(
          readFileSync(escalationPath, "utf-8"),
          lockedManifest,
          { migrationPathPattern: config.migrationPathPattern },
          escalationPath,
        );
        if (scopeRevisions >= MAX_SCOPE_REVISIONS_PER_ROUND) {
          throw new Error(
            `Focused scope revision refused in round ${round}: round ` +
              `${round} already spent its ${MAX_SCOPE_REVISIONS_PER_ROUND} ` +
              `revision(s). Requested: [${escalation.paths.join(", ")}] ` +
              `(${escalation.reason}). The escalation is archived and the ` +
              `contract is unchanged; declare the remaining path(s) in the ` +
              `contract by hand, or resume the slice so the next round ` +
              `earns a fresh grant.`,
          );
        }
        // --- The grant is only for an edit that has NOT happened yet
        // (architect blocker 1, fifth adjudication gate round). ADR 0052
        // makes this route a pre-build discovery and both generator prompts
        // say "stop before making the undeclared edit"; nothing checked it,
        // so a generator could edit an undeclared path, name it in a valid
        // escalation, and have the revision legitimize the edit after the
        // fact. The full changed set is compared, not just the requested
        // paths — otherwise editing undeclared X and escalating for
        // unrelated Y keeps X. See `outOfScopeChangedPaths` for the
        // exemptions and for why this door is deliberately the mirror image
        // of the QA amendment door.
        //
        // Placed after the archive above, so the raw escalation evidence
        // survives the refusal, and before the revision, so the contract is
        // never touched. Refuses by throw like the revision bound it sits
        // next to: ERROR, nothing reverted, the tree left for the operator.
        const escalationTree = git.listChangedFiles(ctx.worktreeDir, featBranch);
        if (!escalationTree.ok) {
          throw new Error(
            `Focused scope revision refused in round ${round}: the set of ` +
              `files this worktree has changed could not be determined — ` +
              `${escalationTree.failure}. Requested: ` +
              `[${escalation.paths.join(", ")}] (${escalation.reason}). A ` +
              `grant may not be issued on an unproven tree; the escalation ` +
              `is archived and the contract is unchanged.`,
          );
        }
        const undeclaredChanges = outOfScopeChangedPaths({
          changedFiles: escalationTree.paths,
          manifest: lockedManifest,
          sliceArtifactDir: ctx.relSliceDir,
          options: { migrationPathPattern: config.migrationPathPattern },
        });
        if (undeclaredChanges.length > 0) {
          throw new Error(
            `Focused scope revision refused in round ${round}: this worktree ` +
              `already holds changes outside the locked file scope ` +
              `(${undeclaredChanges.join(", ")}). A scope escalation is a ` +
              `pre-build discovery (ADR 0052) — the generator must stop ` +
              `*before* the undeclared edit — so granting a revision now ` +
              `would authorize an edit that already happened. Requested: ` +
              `[${escalation.paths.join(", ")}] (${escalation.reason}). The ` +
              `escalation is archived, the contract is unchanged and nothing ` +
              `was reverted; review the listed path(s), then either declare ` +
              `them in the contract by hand or discard them and resume the ` +
              `slice so the next round earns a fresh grant.`,
          );
        }
        const revision = await runFocusedScopeRevision(ctx, escalation);
        if (revision.phase === "ERROR") return revision;
        scopeRevisions++;
        scopeRevisionNote =
          "# Focused scope revision accepted\n\n" +
          "The contract was revised and re-locked without spending this " +
          "implementation round. Continue under this complete accepted " +
          "file scope:\n\n" +
          JSON.stringify({ fileScope: revision.manifest.fileScope }, null, 2);
      }

      if (config.manifest) {
        const gate = checkClaimedGeneratedMigrations({
          repoRoot: config.repoRoot,
          runSlug: pipelineRunSlug(config.prdSlug, config.provider ?? kiroProvider),
          ghIssue: slice.ghIssue,
          worktreeDir: ctx.worktreeDir,
          featBranch,
          contractPath: join(ctx.absSliceDir, "contract.md"),
          options: { migrationPathPattern: config.migrationPathPattern },
        });
        if (!gate.ok) {
          return {
            phase: "ERROR",
            error: `Migration claim gate failed before QA: ${gate.error}`,
          };
        }
      }

      const checkpointDir = join(
        config.repoRoot,
        ".afk",
        "checkpoints",
        `${config.prdSlug}-s${slice.number}-r${round}-${randomUUID()}`,
      );
      const basePlan = resolveSanityPlan(ctx.worktreeDir);
      const gatePrepare: GateDeclaration | undefined = basePlan.prepare
        ? {
            id: basePlan.prepare.name,
            stage: "base",
            required: true,
            command: basePlan.prepare.command,
            args: [...basePlan.prepare.args],
          }
        : undefined;
      const declarations = resolveBaseGateDeclarations(ctx.worktreeDir);
      const checkpoint = declarations.some(
        (declaration) => declaration.command != null,
      )
        ? createCandidateCheckpoint(ctx.worktreeDir, checkpointDir)
        : createCandidateCheckpoint(ctx.worktreeDir, checkpointDir, {
            materialize: false,
          });
      const gateCwd = checkpoint.worktreeDir ?? checkpointDir;
      const evidenceDir = join(logger.runDir, "gates", `s${slice.number}`);
      const infrastructureRetries =
        config.infrastructureRetries ?? DEFAULT_INFRASTRUCTURE_RETRIES;
      if (
        !Number.isSafeInteger(infrastructureRetries) ||
        infrastructureRetries < 0
      ) {
        throw new Error("infrastructureRetries must be a non-negative integer");
      }
      const isRequired = (gateId: string) =>
        declarations.some(
          (declaration) =>
            declaration.id === gateId && declaration.required,
        );
      let gateEvidence: GateEvidence | undefined;
      let gateEvidencePath = "";
      const gateAttempts: Array<{
        evidence: GateEvidence;
        evidencePath: string;
      }> = [];
      try {
        for (
          let gateAttempt = 1;
          gateAttempt <= infrastructureRetries + 1;
          gateAttempt++
        ) {
          const gateRun = await runGates({
            treeId: checkpoint.treeId,
            cwd: gateCwd,
            evidenceDir,
            declarations,
            ...(gatePrepare ? { prepare: gatePrepare } : {}),
            signal,
            inactivityTimeoutMs:
              config.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
            wallClockTimeoutMs: DEFAULT_BASE_GATE_WALL_CLOCK_TIMEOUT_MS,
            heartbeatIntervalMs:
              config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
            onOutput: (_gateId, text) => process.stderr.write(text),
          });
          gateEvidencePath = gateRun.evidencePath;
          gateArtifacts.push(gateRun.artifact);
          gateEvidence = verifyGateEvidence(gateRun.artifact);
          gateAttempts.push({
            evidence: gateEvidence,
            evidencePath: gateEvidencePath,
          });
          const evidenceArtifactId = relative(
            config.repoRoot,
            gateEvidencePath,
          ).replace(/\\/g, "/");
          for (const result of gateEvidence.results) {
            logger.event({
              type: "gate-outcome",
              ghIssue: slice.ghIssue,
              sliceNumber: slice.number,
              round,
              attemptId: gateEvidence.attemptId,
              gateId: result.gateId,
              stage: result.stage,
              status: result.status,
              failureKind: result.failureKind,
              startedAt: result.startedAt,
              endedAt: result.endedAt,
              durationMs: result.durationMs,
              exitCode: result.exitCode,
              treeId: result.treeId,
              evidenceArtifactId,
              logArtifactId: result.logArtifactId,
            });
          }
          const infrastructureFailure = gateEvidence.results.some(
            (gate) =>
              isRequired(gate.gateId) &&
              gate.status === "INFRASTRUCTURE",
          );
          if (!infrastructureFailure || signal?.aborted) break;
          if (gateAttempt <= infrastructureRetries) {
            logger.phase(
              `${ctx.tag}: base gates infrastructure retry ${gateAttempt}/${infrastructureRetries}`,
              "error",
              {
                type: "warn",
                reason: "infrastructure-retry",
                ghIssue: slice.ghIssue,
                message: `base gates infrastructure retry ${gateAttempt}/${infrastructureRetries}`,
              },
            );
          }
        }
      } finally {
        if (checkpoint.worktreeDir) {
          await git.removeWorktreeOrWarn(
            ctx.worktreeDir,
            checkpoint.worktreeDir,
            {
              label: "checkpoint worktree",
              warn: (message) => logger.phase(`${ctx.tag}: ${message}`),
            },
            { signal },
          );
        }
      }

      if (!gateEvidence) {
        throw new Error("Base gates produced no evidence");
      }
      if (signal?.aborted) {
        return { phase: "CANCELLED", error: CANCELLED_BY_USER };
      }
      const evidenceDisplayPath = gateEvidencePath.replace(/\\/g, "/");
      const requiredInfrastructure = gateEvidence.results.filter(
        (gate) =>
          isRequired(gate.gateId) && gate.status === "INFRASTRUCTURE",
      );
      if (requiredInfrastructure.length > 0) {
        return {
          phase: "ERROR",
          error: `Base gate infrastructure failed: ${requiredInfrastructure.map((gate) => gate.gateId).join(", ")} (${evidenceDisplayPath})`,
        };
      }
      const requiredFailures = collectRequiredGateFailures(
        gateAttempts,
        declarations,
      );
      if (requiredFailures.length > 0) {
        const baseGateRepairReferences = [
          ...new Set(
            requiredFailures.map(({ evidencePath }) =>
              evidencePath.replace(/\\/g, "/"),
            ),
          ),
          ...requiredFailures.map(({ result }) =>
            join(evidenceDir, result.logArtifactId).replace(/\\/g, "/"),
          ),
        ];
        stuckReferences.push(...baseGateRepairReferences);
        retryNote =
          `This is implementation round ${round + 1}. Fix every unresolved ` +
          `base-gate failure in these preserved artifacts:\n` +
          baseGateRepairReferences
            .map((path) => `- \`${path}\``)
            .join("\n");
        if (implementationAttempt < implementationAttemptLimit) continue;
      } else {
        assertGateEvidenceReleasesEvaluation(
          gateEvidence,
          declarations,
          checkpoint.treeId,
        );
        for (const artifact of gateArtifacts) verifyGateEvidence(artifact);
        // The gates just passed on this tree; hand QA the evidence so it can
        // be authorized to cite them rather than run them again (ADR 0012,
        // 2026-08-28). `runQAStage` re-hashes the tree and refuses on any
        // mismatch, so passing the evidence never weakens the review.
        const qaBaseGate: QABaseGateEvidence = {
          evidence: gateEvidence,
          evidenceArtifactId: relative(
            config.repoRoot,
            gateEvidencePath,
          ).replace(/\\/g, "/"),
          declarations,
        };
        logger.phase(
          `${ctx.tag}: deterministic QA (round ${round}/${finalRound})...`,
          "error",
          {
            type: "phase-started",
            ghIssue: slice.ghIssue,
            sliceNumber: slice.number,
            agent: "evaluator-qa",
            round,
          },
        );
        const deterministic = await runQAStage(
          ctx,
          round,
          "deterministic",
          deterministicHistory,
          deterministicUnresolved,
          qaBaseGate,
        );
        deterministicHistory = deterministic.history;
        deterministicUnresolved = deterministic.unresolved;
        logger.event({
          type: "phase-ended",
          ghIssue: slice.ghIssue,
          sliceNumber: slice.number,
          agent: "evaluator-qa",
          round,
          verdict: deterministic.outcome,
        });
        let implementationFailed =
          deterministic.outcome === "IMPLEMENTATION";
        stuckReferences.push(deterministic.report);
        if (implementationFailed) {
          retryNote =
            `This is implementation round ${round + 1}. Fix every current ` +
            `unresolved deterministic QA finding:\n` +
            formatUnresolvedQAFindings(deterministic.unresolved);
        }
        if (
          deterministic.outcome !== "IMPLEMENTATION" &&
          config.sharedPreview
        ) {
          logger.phase(
            `${ctx.tag}: shared-preview UAT (round ${round}/${finalRound})...`,
            "error",
            {
              type: "phase-started",
              ghIssue: slice.ghIssue,
              sliceNumber: slice.number,
              agent: "evaluator-uat",
              round,
            },
          );
          const remote = await runQAStage(
            ctx,
            round,
            "shared-preview",
            sharedPreviewHistory,
            sharedPreviewUnresolved,
          );
          sharedPreviewHistory = remote.history;
          sharedPreviewUnresolved = remote.unresolved;
          logger.event({
            type: "phase-ended",
            ghIssue: slice.ghIssue,
            sliceNumber: slice.number,
            agent: "evaluator-uat",
            round,
            verdict: remote.outcome,
          });
          stuckReferences.push(remote.report);
          if (remote.outcome === "IMPLEMENTATION") {
            implementationFailed = true;
            retryNote =
              `This is implementation round ${round + 1}. Fix every current ` +
              `unresolved shared-preview UAT finding:\n` +
              formatUnresolvedQAFindings(remote.unresolved);
          }
        }

        logger.bumpEvalRound(slice.ghIssue, round);
        if (!implementationFailed) {
          for (const artifact of gateArtifacts) verifyGateEvidence(artifact);
          assertGateEvidenceReleasesEvaluation(
            verifyGateEvidence(gateArtifacts.at(-1)!),
            declarations,
            checkpoint.treeId,
          );
          // Before the commit, so the diagnosis this slice ships is the
          // one the operator read, not whatever the generator left.
          restoreStuckDiagnosis();
          if (git.hasUncommittedChanges(ctx.worktreeDir)) {
            git.commitAll(
              ctx.worktreeDir,
              `feat(#${slice.ghIssue}): ${slice.title}`,
            );
          }

          const migrationMode =
            config.migrationValidation ?? DEFAULT_MIGRATION_VALIDATION;
          if (
            !config.sharedPreview &&
            migrationMode !== "skip" &&
            sliceTouchedMigrations(ctx.worktreeDir, featBranch)
          ) {
            const migrationCheck = verifyMigrationSync(
              ctx.worktreeDir,
              migrationMode,
            );
            if (!migrationCheck.ok) {
              // Late refusal: QA passed and the work is already committed,
              // so the diagnosis describes a slice whose branch holds
              // finished work that one check would not certify.
              return finishStuck(
                `Migration sync check failed: ${migrationCheck.error}`,
              );
            }
          }

          logger.phase(
            `${ctx.tag}: deterministic QA and configured UAT pass — committed`,
          );
          return { phase: "PASS" };
        }
      }

      if (implementationAttempt === implementationAttemptLimit) {
        return finishStuck();
      }
    }
    return finishStuck();
  } catch (err) {
    if (isCancelled(err, signal)) {
      return { phase: "CANCELLED", error: CANCELLED_BY_USER };
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
): Promise<
  | "PASS"
  | "STUCK"
  | "ESCALATE"
  | "AWAITING-ADJUDICATION"
  | "ADJUDICATION-LOCK-REFUSED"
  | "ERROR"
  | "CANCELLED"
> {
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
  // --- The cancellation record, written when the signal fires (#114).
  //
  // The wave loop's cancellation sweep further down only runs once
  // `runWave` has returned. A stop that ends the process before then — a
  // second signal, a console close, an agent that will not die — used to
  // leave the in-flight slice with no run-state entry at all, and no stop
  // line in run.log. That gap is what makes the next `--only-failed`
  // dangerous: an unmerged slice branch with no state reads as "never
  // ran" (#113). So the record is contemporaneous with the *request* to
  // cancel, not with the wind-down that follows it.
  //
  // The slice list is a late-bound hook because the signal can fire
  // during setup, before the run scope is resolved: until then a
  // cancellation has no dispatched slice to record, only its own line.
  // The listener's lifetime is the run's — one `AbortController` per CLI
  // invocation — and `once` drops it as soon as it fires.
  let cancellableSlices: () => SliceIdentity[] = () => [];
  /**
   * What the abort listener recorded, kept for the sentinel's ack: that
   * is the whole point of the ack, so it has to report the real ids
   * rather than a promise that something was written.
   */
  let markedAtCancellation: string[] = [];
  const onCancellationRequested = () => {
    const marked = logger.markCancelledInFlight(
      cancellableSlices(),
      CANCELLED_BY_USER,
    );
    markedAtCancellation = marked;
    const detail =
      marked.length > 0
        ? `marked CANCELLED in run state: ${marked.map((id) => `#${id}`).join(", ")}`
        : "no slice had work in flight";
    logger.phase(`[afk] Cancellation requested — ${detail}`, "error", {
      type: "warn",
      reason: "cancellation-requested",
      message: `Cancellation requested — ${detail}`,
    });
  };
  if (signal?.aborted) onCancellationRequested();
  else {
    signal?.addEventListener("abort", onCancellationRequested, { once: true });
  }

  // --- The same record for the exit no signal announces (#121, ADR 0044).
  //
  // The listener above fires on the `AbortSignal`. A crash never touches
  // it: run 6 died on an unhandled `'error'` event from a log stream
  // (ENOSPC), so nothing was recorded and the state file still named
  // slice #79's typecheck failure from two runs earlier — already fixed
  // by then, and the first thing an operator read. The crash handlers
  // therefore reach the *same* `markCancelledInFlight`, with `CRASHED`
  // and the error text as the cause, and the recorded phase stays
  // CANCELLED so the slice branch is preserved exactly as a stop
  // preserves it.
  //
  // Only a CLI that owns the process supplies the handle — the handlers
  // behind it exit — and the same `cancellableSlices` hook feeds both
  // paths, so a crash during setup records its line and no slice, which
  // is the truth at that moment.
  const crashRecords = config.crashRecords;
  let unregisterCrashRecorder: (() => void) | undefined;
  if (crashRecords) {
    unregisterCrashRecorder = crashRecords.register(
      crashRecorderFor(logger, () => cancellableSlices()),
    );
    logger.onFatalStreamError((error, origin) =>
      crashRecords.reportFatalStreamError(error, origin),
    );
  }

  // --- `afk stop`: the same abort path, delivered as a file (ADR 0043).
  //
  // A signal is the wrong instrument for a detached Windows run:
  // `CTRL_C_EVENT` reported success twice into a live run without
  // delivering anything, and the `CTRL_BREAK_EVENT` that did land exited
  // the process before ADR 0040's record was written. So the run also
  // watches a file in its own log directory, and a sentinel that appears
  // there goes through `requestCancellation` — the CLI's own stop button,
  // the same `AbortController`, the same listener above.
  //
  // Cleared first: a run must never inherit a stop. The path is unique
  // per run (see src/stop-sentinel.ts), so this should find nothing; if
  // it finds something, that is worth a line rather than a silent delete.
  const clearedSentinels = clearStopSentinel(logger.runDir);
  if (clearedSentinels.length > 0) {
    logger.phase(
      `[afk] Cleared stale stop sentinel(s) in this run's log dir before launch: ${clearedSentinels.join(", ")}`,
      "error",
    );
  }
  const requestCancellation = config.requestCancellation;
  const stopWatcher = requestCancellation
    ? createStopSentinelWatcher({
        runDir: logger.runDir,
        intervalMs: config.stopSentinelIntervalMs,
        onOtherRun: (targetRunId) => {
          logger.phase(
            `[afk] Ignoring a stop sentinel in this run's log dir: it names run ${targetRunId}, not ${runIdFor(logger.runDir)}`,
            "error",
          );
        },
        onStop: (decision) => {
          // Already cancelling — a second request must not escalate into
          // the CLI's hard exit; the ack below still tells `afk stop` the
          // truth, which is that this run is winding down.
          const alreadyCancelling = signal?.aborted === true;
          const detail =
            decision.reason === "unreadable"
              ? `sentinel unreadable (${decision.detail}) — stopping anyway`
              : decision.request.source
                ? `requested by ${decision.request.source} at ${decision.request.requestedAt}`
                : `requested at ${decision.request.requestedAt}`;
          const message =
            `Stop requested via sentinel (${detail})` +
            (alreadyCancelling ? " — this run was already cancelling" : "");
          logger.phase(`[afk] ${message}`, "error", {
            type: "warn",
            reason: "stop-requested",
            message,
          });
          // The listener registered above runs synchronously inside
          // abort(), so by the time this returns the CANCELLED records
          // are on disk — which is what makes the ack worth writing.
          if (!alreadyCancelling) requestCancellation();
          const wrote = writeStopAck(logger.runDir, {
            runId: runIdFor(logger.runDir),
            ...(decision.reason === "requested"
              ? { requestedAt: decision.request.requestedAt }
              : {}),
            acknowledgedAt: new Date().toISOString(),
            cancelledSlices: markedAtCancellation,
          });
          if (!wrote) {
            logger.phase(
              `[afk] Warning: could not write the stop acknowledgement to ${logger.runDir} — ` +
                `the cancellation itself is unaffected; 'afk stop' will report it as unacknowledged`,
              "error",
            );
          }
        },
      })
    : null;

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
  // Resolve the generator's local verification command once per run.
  const testCommand = resolveGeneratorTestCommand(repoRoot, config.testCommand);
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
  initializeMigrationClaims(runState, config.manifest ?? null);
  const requestedSliceNumbers =
    config.selectedSliceNumbers ?? config.manifest?.selectedSlices;
  if (config.manifest && requestedSliceNumbers) {
    assertWithinManifestScope({
      selectedSlices: config.manifest.selectedSlices,
      candidates: requestedSliceNumbers,
      sliceNumberOf: (number) => number,
      describeConflict: (conflicting) =>
        `Run scope conflicts with afk.json selectedSlices: ${conflicting.join(", ")}`,
    });
  }
  scope = resolveRunScope(
    [...manifestDag.slices.values()],
    requestedSliceNumbers,
    runState.scope,
  );
  runState.scope = scope.persisted;
  runState.featureBranch = featBranch;
  // Recorded so `clean-failed` and `afk adopt` can *resolve* where this
  // run's slice artifacts live rather than search a worktree for them
  // (architect blocker 2; see `RunState.specsDir`). Written here, beside the
  // feature branch, because both are facts about the run that later commands
  // read and neither can be re-derived from a worktree alone.
  runState.specsDir = specsDir.replace(/\\/g, "/");
  saveRunState(repoRoot, runState);
  const dag = buildDAG(scope.selected);
  const selectedIssues = new Set(scope.selected.map((slice) => slice.ghIssue));

  // --- Launch preflight (ADR 0042). Runs here: late enough that the run
  // scope names the exact worktree paths this run will use, early enough
  // that nothing has been created or mutated yet. Detection, report and
  // fail-fast only — it never kills a process.
  //
  // `retained` is every incomplete AFK slice in the *manifest*, not just
  // this invocation's selection: a narrowed re-run leaves the worktrees of
  // MERGE-PENDING and STUCK slices registered on purpose, and those are
  // live work a later run recovers from, not previous-run debris. Both the
  // recorded branch and the derived one count as legitimate, so a slice
  // whose title changed since its branch was cut is not refused over it.
  const worktreePathFor = (slice: Slice) => ({
    path: sliceWorktreeDir(repoRoot, prdSlug, slice, provider),
    branch: sliceBranch(prdSlug, slice, provider),
  });
  const isIncomplete = (slice: Slice) =>
    slice.type === "AFK" && !isSliceComplete(runState, slice.ghIssue);
  const preflight = await runLaunchPreflight({
    repoRoot,
    namespace: buildRunNamespace({
      repoRoot,
      prdSlug,
      provider,
      featBranch,
      intended: scope.selected.filter(isIncomplete).map(worktreePathFor),
      retained: [...manifestDag.slices.values()]
        .filter(isIncomplete)
        .flatMap((slice) => {
          const derived = worktreePathFor(slice);
          const recorded = runState.slices[slice.ghIssue]?.branch;
          return recorded && recorded !== derived.branch
            ? [derived, { path: derived.path, branch: recorded }]
            : [derived];
        }),
    }),
    minFreeBytes: gbToBytes(config.minFreeDiskGb ?? DEFAULT_MIN_FREE_DISK_GB),
    reportOnly: config.preflightReportOnly,
  });
  const preflightBlock = formatPreflightReport(preflight);
  if (preflightBlock) {
    logger.phase(preflightBlock, "error", {
      type: "warn",
      reason: "preflight",
      message: preflightBlock,
    });
  }
  if (preflight.refuse) {
    const refusal = formatPreflightRefusal(preflight);
    logger.phase(`[afk] ${refusal}`);
    throw new Error(refusal);
  }
  if (
    config.preflightReportOnly &&
    preflight.findings.some((finding) => finding.severity === "refuse")
  ) {
    // The bypass is part of the run's record: the next reader of this
    // log has to know the launch started over a hard condition.
    logger.phase(
      `[afk] --preflight-report-only: launching despite ` +
        `${preflight.findings.filter((f) => f.severity === "refuse").length} ` +
        `preflight condition(s) that would otherwise refuse this run`,
      "error",
      {
        type: "warn",
        reason: "preflight",
        message: "launch bypassed the preflight refusal (--preflight-report-only)",
      },
    );
  }

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

  // Launch guard: the feature branch must contain the host worktree's
  // HEAD before any slice worktree is created from it. Slice worktrees
  // branch from the feature branch, while prompts and dist/ resolve
  // from the host checkout (src/prompt-template.ts) — a stale feature
  // branch hands agents source files older than the code orchestrating
  // them. Keyed on the host HEAD, NOT the default branch: hosts
  // legitimately run from prep branches ahead of main, and a
  // behind-main check would re-create the staleness on every prep
  // cycle. A plain-ancestor branch is fast-forwarded; divergence is a
  // refusal — the operator must reconcile the branches, the guard
  // mutates nothing.
  const freshness = git.ensureFeatureBranchContainsHostHead(
    repoRoot,
    featBranch,
  );
  if (freshness.kind === "diverged") {
    const refusal =
      `Refusing to launch: feature branch ${featBranch} (${freshness.featureTip}) ` +
      `and the host worktree HEAD (${freshness.hostHead}) have diverged — ` +
      `neither contains the other. Slice worktrees would branch from a tree ` +
      `that does not include the code this host is running. Reconcile the ` +
      `branches (merge or rebase ${featBranch} onto ${freshness.hostHead}, ` +
      `or move the host) and re-run.`;
    logger.phase(`[afk] ${refusal}`);
    throw new Error(refusal);
  }
  if (freshness.kind === "fast-forwarded") {
    logger.phase(
      `[afk] Fast-forwarded ${featBranch} (${freshness.previousTip} → ` +
        `${freshness.hostHead}) — the branch was a plain ancestor of the ` +
        `host worktree HEAD`,
      "error",
      {
        type: "warn",
        reason: "feature-branch-fast-forward",
        message:
          `${featBranch} fast-forwarded from ${freshness.previousTip} to ` +
          `host HEAD ${freshness.hostHead}`,
      },
    );
  }

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
  const awaitingAdjudication = new Set<string>();
  // Live bounded waits, one per parked slice. Recording a park starts the
  // wait; nothing awaits it until the scheduler runs out of runnable work
  // (ADR 0055 §7) — a human's think-time on one slice is not a dependency
  // of anyone else's (ADR 0024).
  const adjudicationWaits = new Map<
    string,
    ReturnType<typeof waitForAdjudication>
  >();
  // Results of waits that have already resolved. The idle wait races the
  // live set, then drains everything settled by then, so a wave picks up
  // every decision that arrived rather than one per idle round-trip.
  const settledAdjudications = new Map<string, AdjudicationWaitResult>();

  /**
   * A slice this run will not dispatch again, for any reason short of
   * success. One predicate so a new hold-back reason is one edit, not
   * three filter sites plus a sweep condition.
   */
  const heldBack = (id: string): boolean =>
    failed.has(id) ||
    laneCancelled.has(id) ||
    mergePending.has(id) ||
    awaitingAdjudication.has(id);

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
      logger.restoreCompleted(
        { ghIssue: id, title: slice.title, branch },
        runState.slices[id]!.adoption,
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

  // From here on a cancellation has slices to account for: everything in
  // this run's DAG that is neither a HITL skip nor already settled. The
  // hook feeds the abort listener installed at the top of the run (#114);
  // it reads the live sets, so it is correct at whatever moment the
  // signal happens to fire.
  cancellableSlices = () =>
    [...dag.slices]
      .filter(
        ([id, slice]) =>
          slice.type !== "HITL" &&
          !completed.has(id) &&
          !failed.has(id) &&
          !awaitingAdjudication.has(id),
      )
      .map(([id, slice]) => ({
        ghIssue: id,
        title: slice.title,
        branch: sliceBranch(prdSlug, slice, provider),
      }));

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
    if (
      outcome.phase === "AWAITING-ADJUDICATION" &&
      !adjudicationWaits.has(id)
    ) {
      awaitingAdjudication.add(id);
      const sliceContext = makeSliceContext(
        config,
        slice,
        logger,
        featBranch,
        relevantFilesBlock,
        testCommand,
      );
      const waitMs =
        config.adjudicationWaitMs ?? DEFAULT_ADJUDICATION_WAIT_MS;
      logger.phase(
        `${sliceContext.tag}: waiting up to ${waitMs}ms for ${ADJUDICATION_FILENAME}`,
      );
      const wait = waitForAdjudication({
        sliceDir: sliceContext.absSliceDir,
        waitMs,
        pollMs:
          config.adjudicationPollMs ?? DEFAULT_ADJUDICATION_POLL_MS,
        signal,
      });
      adjudicationWaits.set(id, wait);
      // Record the result as it lands so the idle wait can drain every
      // decision that arrived, not just the one that won its race. The
      // rejection arm is deliberately empty: the idle wait awaits the same
      // promise and re-throws there, and a wait the run never reaches
      // (abort, or an exit before idle) must not become an unhandled
      // rejection that takes the process down after the summary.
      void wait.then(
        (result) => {
          settledAdjudications.set(id, result);
        },
        () => {},
      );
    }
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
      git.attemptMerge(repoRoot, branch, featBranch, scratchMergeDir),
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
    await git.removeWorktreeOrWarn(
      repoRoot,
      sliceWorktreeDir(repoRoot, prdSlug, slice, provider),
      {
        label: `recovered slice ${sliceId} worktree`,
        warn: (message) => logger.phase(`[afk] Warning: ${message}`),
      },
      { gitAdminMutex: mergeMutex, signal },
    );
    logger.recordTerminal(sliceId, { phase: "PASS", recovered: true });
    completed.add(id);
    recoveredMerges.add(id);
  }

  // Wave-transition watchdog: race the readiness check against a
  // timeout. If the event loop is blocked (dangling promise,
  // unresolved stream), the timeout rejects and we crash with
  // diagnostics.
  const readyOrHang = (waveNumber: number): Promise<string[]> =>
    Promise.race([
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

  // One abort promise for the whole run, created the first time the
  // pipeline actually idles on a human. The idle wait races it so
  // cancellation ends the wait immediately (ADR 0003, ADR 0055 §7);
  // nothing is lost, because the park is durable on disk.
  let abortSignalled: Promise<"aborted"> | undefined;
  const abortRace = (): Promise<"aborted"> => {
    if (!signal) {
      // No signal to race: a promise that never settles leaves the live
      // waits as the only arms of the race.
      abortSignalled ??= new Promise<"aborted">(() => {});
      return abortSignalled;
    }
    abortSignalled ??= new Promise<"aborted">((resolve) => {
      if (signal.aborted) {
        resolve("aborted");
        return;
      }
      signal.addEventListener("abort", () => resolve("aborted"), {
        once: true,
      });
    });
    return abortSignalled;
  };

  /**
   * Wait for a human decision — but only once there is nothing else to
   * run. Every ready wave has already been dispatched by the time this is
   * called, so the only thing a park can delay is its own dependents
   * (ADR 0055 §7; ADR 0024's rule applied to parks).
   *
   * The wall-clock ceiling (ADR 0019) deliberately keeps running while the
   * pipeline idles here: the bounded wait is already sized by
   * configuration, and a park surviving run death is the point of the
   * durable park — exempting human think-time from the ceiling would let a
   * run live forever.
   *
   * - `"progress"` — at least one slice left `awaitingAdjudication`; its
   *   re-dispatch on the next loop turn is the park's reopen (step 4:
   *   `trackSlice` clears the mark and the persisted record).
   * - `"aborted"` — cancellation won the race; the caller runs the normal
   *   sweep and leaves every park untouched.
   * - `"exhausted"` — no live wait remains and nothing became runnable.
   */
  const awaitAdjudicationAtIdle = async (): Promise<
    "progress" | "aborted" | "exhausted"
  > => {
    while (adjudicationWaits.size > 0) {
      if (signal?.aborted) return "aborted";
      logger.phase(
        `[afk] No runnable slices; waiting on ${adjudicationWaits.size} ` +
          `adjudication decision(s): ` +
          `${[...adjudicationWaits.keys()].map((id) => `#${id}`).join(", ")}`,
      );
      await Promise.race([...adjudicationWaits.values(), abortRace()]);
      if (signal?.aborted) return "aborted";

      // Drain everything that resolved by now, not just the race winner:
      // several decisions can land while one wave runs, and each should
      // reach the same next wave.
      let progressed = false;
      for (const [id, result] of settledAdjudications) {
        settledAdjudications.delete(id);
        adjudicationWaits.delete(id);
        if (result.status === "accepted") {
          // Dropping the hold-back is the whole reopen: the next wave
          // dispatches the slice, and that dispatch clears the park's mark
          // and persisted record in the journal (ADR 0055 §9).
          awaitingAdjudication.delete(id);
          logger.phase(
            `[afk] Slice #${id}: valid adjudication received — redispatching`,
          );
          progressed = true;
        } else if (result.status === "expired") {
          if (result.defect) {
            logger.phase(
              `[afk] Slice #${id}: adjudication refused — ${result.defect}; slice remains parked`,
            );
          }
          logger.phase(
            `[afk] Slice #${id}: adjudication wait expired — slice remains AWAITING-ADJUDICATION`,
          );
        }
      }
      if (progressed) return "progress";
    }
    return "exhausted";
  };

  // Mark anything not yet completed/failed as CANCELLED. Worktrees are
  // preserved on disk so a re-run resumes from the artifact state, and a
  // parked slice keeps its own phase — its estate is durable (ADR 0003,
  // ADR 0055 Seam 2).
  const sweepCancelled = (): void => {
    for (const [id, slice] of dag.slices) {
      if (slice.type === "HITL") continue;
      if (
        completed.has(id) ||
        failed.has(id) ||
        awaitingAdjudication.has(id)
      ) {
        continue;
      }
      const branch = sliceBranch(prdSlug, slice, provider);
      logger.recordTerminal(
        { ghIssue: id, title: slice.title, branch },
        { phase: "CANCELLED", error: CANCELLED_BY_USER },
      );
      failed.add(id);
    }
  };

  let waveNumber = 0;
  waves: while (true) {
    waveNumber++;

    // Nothing ready is not necessarily the end: a parked slice may be one
    // human decision away from being runnable again. Only idle waits.
    let toRun = await readyOrHang(waveNumber);
    while (toRun.length === 0) {
      const idle = await awaitAdjudicationAtIdle();
      if (idle === "aborted") {
        sweepCancelled();
        break waves;
      }
      if (idle === "exhausted") break waves;
      toRun = await readyOrHang(waveNumber);
    }

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
      } else if (outcome.phase === "AWAITING-ADJUDICATION") {
        // The park is recorded and its bounded wait is already running
        // (persistOutcome). Reconciliation does NOT await it: the rest of
        // this wave's outcomes, and every wave they make ready, come first
        // (ADR 0055 §7). `awaitAdjudicationAtIdle` collects the decision
        // once there is nothing else to run.
        if (!adjudicationWaits.has(id) && !settledAdjudications.has(id)) {
          throw new Error(`Missing adjudication wait for slice #${id}`);
        }
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
    // and exit the wave loop. See ADR 0003.
    if (signal?.aborted) {
      sweepCancelled();
      break;
    }

    // No early exit when nothing is ready: the top of the loop decides
    // that, because "nothing ready" now has a second answer — idle on the
    // live adjudication waits before concluding the run is done.
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
    logger.recordDependencyHold(
      {
        ghIssue: id,
        title: slice.title,
        branch: sliceBranch(prdSlug, slice, provider),
      },
      unresolved.map((dep) => ({
        ghIssue: dep,
        status:
          logger.getSlice(dep)?.phase ??
          runState.slices[dep]?.phase ??
          "UNKNOWN",
      })),
    );
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
    const adoptions = Object.entries(runState.slices).flatMap(
      ([ghIssue, sliceState]) =>
        sliceState.adoption
          ? [{ ghIssue, ...sliceState.adoption }]
          : [],
    );
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
        adoptions,
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
        reviewDir = reviewWorktreeDir(repoRoot, featBranch);
        git.createWorktree(repoRoot, featBranch, reviewDir, defaultBranch);
        git.assertWorktreeRegistered(repoRoot, featBranch, reviewDir);
        cleanupReviewDir = true;
      }

      try {
        if (config.manifest) {
          const latestState = loadRunState(repoRoot, loggerSlug);
          // Keep only prefixes whose slice merged; a failed or descoped
          // slice's reservation must not ride into the verified draft
          // (#65). Releasing its claim record here keeps run state
          // consistent with the trimmed pool below.
          const release = releaseUnmergedMigrationClaims(latestState);
          const trimmed = trimUnclaimedMigrationPrefixes(
            join(reviewDir, specsDir),
            release.retained,
          );
          // Save on either half. A release with no trim happens when the
          // manifest already lists exactly the retained prefixes; gating
          // the save on the trim alone drops the claim in memory only.
          if (latestState.migrations && (trimmed.changed || release.released.length > 0)) {
            latestState.migrations.pool = [...trimmed.manifest.migrationPrefixes];
            saveRunState(repoRoot, latestState);
          }
          if (trimmed.changed) {
            git.commitAll(
              reviewDir,
              `chore(${prdSlug}): release unused migration reservations`,
            );
          }
        }
        shipResult = await invokeShipGate(reviewDir);
      } finally {
        if (cleanupReviewDir) {
          await git.removeWorktreeOrWarn(
            repoRoot,
            reviewDir,
            {
              label: "review worktree",
              warn: (message) => logger.phase(`[afk] Warning: ${message}`),
            },
            { signal },
          );
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
  } finally {
    // The timer is unref'd, so this is tidiness rather than a
    // requirement — but a watcher that outlives its run would keep
    // stat-ing a directory nobody writes to, and in-process callers
    // (the test suite runs many pipelines per worker) would accumulate
    // one per run.
    stopWatcher?.stop();
    // The handlers outlive this run — the CLI owns them — but the recorder
    // must not: it writes through this run's journal, and a crash after
    // the run has returned would record against a finished run.
    unregisterCrashRecorder?.();
  }
}

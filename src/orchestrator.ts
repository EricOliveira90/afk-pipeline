import { basename, dirname, join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
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
import { decideNegotiationArtifactRepair } from "./artifact-repair.js";
import {
  captureAcceptedContractPair,
  mutatedAcceptedContractFiles,
  restoreAcceptedContractPair,
  withContractTransaction,
  type ContractTransaction,
} from "./contract-transaction.js";
import { RunJournal, type TerminalOutcome } from "./run-journal.js";
import { renderPrompt } from "./prompt-template.js";
import {
  assembleExplorerEnvelope,
  assembleGeneratorEnvelope,
  mergeResolutionBlockRoom,
  projectGeneratorContractView,
  projectGeneratorPatternsAndHarness,
  validateExplorerEvidenceMap,
  withMergeResolutionSituation,
  type GeneratorEnvelopeInput,
  type GeneratorFailureSet,
} from "./context-envelope.js";
import {
  resolveRef,
  runMergeResolutionRound,
  type MergeResolutionRoundResult,
} from "./merge-resolution.js";
import {
  assembleAdjudicationPlannerPrompt,
  assembleFocusedScopeEvaluatorPrompt,
  assembleFocusedScopePlannerPrompt,
  assembleNegotiationEvaluatorPrompt,
  assembleNegotiationPlannerPrompt,
  promptAssemblyContext,
} from "./contract-prompt-orchestration.js";
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
  MAX_RESUME_ATTEMPTS,
} from "./resume.js";
import {
  resolveAcceptancePlan,
  resolveBindableGateCatalog,
  resolveCheapGateCatalog,
  resolveFullSuiteGateDeclarations,
  resolvePreQAGateDeclarations,
  resolveTestCostPlan,
  type BindableGate,
} from "./base-gates.js";
import {
  acceptanceGateDeclaration,
  type BehaviorCoverageRecord,
} from "./acceptance-gate.js";
import {
  lifecycle,
  type SliceIdentity,
} from "./slice-lifecycle.js";
import { cleanupEligibility } from "./cleanup-eligibility.js";
import { DEFAULT_MAX_CONTRACT_ROUNDS } from "./cli-options.js";
import {
  computeSliceBounds,
  finalEvaluationAttemptsRemaining,
  formatSliceBounds,
  MAX_FINAL_EVALUATION_ATTEMPTS,
} from "./bounds.js";
import {
  formatPreflightRefusal,
  formatPreflightReport,
  gbToBytes,
  resolveMinFreeDiskGb,
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
  ACCEPTANCE_GATE_ID,
  createCandidateCheckpoint,
  resolveCandidateTreeId,
  readGateEvidence,
  verifyGateEvidence,
  type GateDeclaration,
  type GateEvidence,
  type GateEvidenceArtifact,
  type GateResult,
} from "./gate-runner.js";
import {
  assertGateEvidenceReleasesEvaluation,
  runCandidateGatePhase,
} from "./candidate-gate-phase.js";
import {
  QA_WINDOW_ARTIFACT_NAME,
  reviewArtifactViolations,
  runPostQAGates,
} from "./post-qa-gates.js";
import {
  writeCandidateChangeSummary,
  writeFinalChangeSummary,
} from "./change-summary.js";
import { SCOPE_GATE_ID, scopeGateDeclaration } from "./scope-gate.js";
import { skipGateDeclaration } from "./skip-gate.js";
import {
  appliedWaiversFrom,
  feedbackIntegrityGateDeclaration,
} from "./feedback-integrity-gate.js";
import { loadGatePolicy, type GatePolicy } from "./gate-policy.js";
import {
  authorizeBaseGateSkip,
  formatBaseGateSkipAuthorization,
  type BaseGateSkipAuthorization,
} from "./qa-gate-authorization.js";
import {
  loadRunState,
  updateRunState,
  saveAppliedWaivers,
  isSliceComplete,
  getResumeAttempts,
  recordRetryDecision,
  chargeResumeAttempt,
  recordApprovedBaseline,
  approvedBaselineFor,
  finalEvaluationAttemptsSpent,
  finalEvaluationFor,
  invalidateFinalEvaluationBaseline,
  recordFinalEvaluation,
  type PersistedFinalEvaluationAttempt,
  type RunState,
} from "./run-state.js";
import {
  decideFinalReuse,
  decideFinalVerdict,
  FINAL_REPORT_FILENAME,
  FINAL_REVIEW_FILENAME,
  POST_APPROVAL_WRITING_STAGE_ID,
  routeFinalReviewFinding,
  validateFinalReview,
} from "./final-evaluation.js";
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
  resolveCandidateQACommands,
  resolveGeneratorTestCommand,
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
  featureBranchPrefixForProviderName,
  featureBranchForProviderName,
  providerNameFromRunSlug,
  runSlugForProviderName,
  sliceBranchPrefixForProviderName,
  sliceWorktreeDirForProviderName,
} from "./run-identity.js";
import {
  adoptedSlices,
  adoptionForCompletedSlice,
} from "./adoption-provenance.js";
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
  parseAcceptanceManifest,
  restoreAcceptanceManifestRevisionScope,
  type AcceptanceManifest,
  type AcceptanceManifestV2,
  validateAcceptanceManifestBindings,
  validateAcceptanceManifestCoverage,
  validateAcceptanceManifestRevisionScope,
  validateAcceptanceManifestStability,
} from "./acceptance-manifest.js";
import {
  CONTRACT_RESPONSE_FILENAME,
  CONTRACT_REVIEW_FILENAME,
  CONTRACT_NEGOTIATION_OUTCOME_FILENAME,
  buildContractNegotiationOutcome,
  buildContractReviewAttemptRecord,
  formatContractReviewFindings,
  loadContractResponse,
  loadContractReview,
  type ContractResponse,
  type ContractNegotiationOutcome,
  type ContractRevisionArtifacts,
  type ContractReview,
  type ContractReviewAttemptRecord,
  type ContractReviewFinding,
  type RecordedContractVerdict,
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
  buildQAReviewAttemptRecord,
  loadQAReview,
  loadQAReviewResumeState,
  qaReviewFilename,
  scanReviewWorktreeWrites,
  scopeAmendmentRequests,
  spentImplementationRounds,
  type QAReview,
  type QAReviewAttemptFinding,
  type QAReviewLifecycleFinding,
  type QAReviewStage,
} from "./qa-review.js";
import {
  loadQAConvergenceState,
  type QAConvergenceState,
} from "./qa-convergence.js";
import {
  INTERVENTION_FILENAME,
  type InterventionRequest,
} from "./non-progress.js";
import {
  ContractRoundLifecycle,
  QAAttemptLifecycle,
  validateFreshContractReview,
  type QAAttemptDispatch,
  type RecordedQAAttempt,
  type ValidatedContractReview,
} from "./convergence-coordinator.js";
import { findOrphanedContractLineage } from "./contract-convergence.js";
import { AcceptedCandidateLifecycle } from "./accepted-candidate.js";
import { decideCandidateGatePhase } from "./candidate-gate-policy.js";
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
import {
  clearPlannerEscalation,
  PLANNER_ESCALATION_FILENAME,
  plannerEscalationRequest,
  readPlannerEscalation,
  type PlannerEscalationRecord,
} from "./planner-escalation.js";

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

/**
 * The planner-facing catalog. Typed as {@link BindableGate} rather than
 * `GateDeclaration` because the acceptance entry has no stage or `required` of
 * its own — it is a binding target, and its declaration is built later.
 */
function formatBaseGateCatalog(catalog: readonly BindableGate[]): string {
  return catalog
    .map((gate) => {
      const command = gate.command
        ? [gate.command, ...(gate.args ?? [])].join(" ")
        : "(not executable)";
      return `- ${gate.id}: ${command}`;
    })
    .join("\n");
}
/**
 * The internal shape of a post-approval writing stage (#96 B-03). Not
 * exported: the stage is an implementation detail of this module's accepted-
 * candidate path, and a stage id plus a function is the whole of it.
 */
type PostApprovalWritingStage = (input: {
  /** The slice worktree, checked out at the approved candidate. */
  worktreeDir: string;
  /** The stage's own id, so a write can be attributed without guessing. */
  stageId: string;
  /**
   * Set only when a final-evaluation `PRESERVATION` (or restorable drift)
   * finding routed back here (#96 B-08): the stage is being asked to put back
   * what it wrote over, not to write again. Absent on the first call, which is
   * what lets a stage distinguish its own turn from its own repair.
   */
  repair?: "RESTORE";
}) => void;

/** Production behavior: nothing, until PRD 5 (#96 B-03). */
const noopPostApprovalWritingStage: PostApprovalWritingStage = () => {};

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
  /**
   * Normal contract negotiation cap. The one-time convergence extension is
   * awarded by artifact evidence, never requested through this setting.
   */
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
  /**
   * Whether this run's provider was wrapped to record every invocation's
   * prompt beside its log (`--record-prompts`, #264). Evidence only: the
   * recorder is a provider decorator the CLI entry applies, so the
   * orchestrator reads this for the `run-started` event and nothing else.
   */
  recordPrompts?: boolean;
  /** Effective inline byte limit for each assembled generator prompt. */
  generatorInlineSizeBudgetBytes?: number;
  /** Effective inline byte limit for each assembled explorer prompt. */
  explorerInlineSizeBudgetBytes?: number;
  /** Effective inline byte limit for each assembled planner prompt. */
  plannerInlineSizeBudgetBytes?: number;
  /** Effective inline byte limit for each assembled contract-evaluator prompt. */
  contractEvaluatorInlineSizeBudgetBytes?: number;
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
  /**
   * Unfavorable guardian review rounds before the gate stops fixing and takes
   * the recorded cap exit. Defaults to `DEFAULT_GUARDIAN_ROUND_CAP` (3); 0
   * disables the cap. See ADR 0057 decision 4.
   */
  guardianRoundCap?: number;
  /** Enables remote UAT after deterministic QA. */
  sharedPreview?: SharedPreviewConfig;
  /**
   * The post-approval writing stage (#96 B-03).
   *
   * One stage runs between the candidate checkpoint and the merge, and in
   * production it does nothing at all: PRD 5 gives it a cleaner and a hardener,
   * and until then the honest stub is a no-op. It is injectable so a test can
   * make it write, because the interesting property is what happens when it
   * does — a stub write changes the tree, and a changed tree makes the reuse
   * decision return `evaluate` (B-01, PRD D20).
   *
   * Deliberately not a new exported cross-module interface: the stage is named
   * by a single id ({@link POST_APPROVAL_WRITING_STAGE_ID}) and is a function
   * this module calls, so PRD 5 adds a second stage by extending that list
   * rather than by negotiating a new contract between modules.
   */
  postApprovalWritingStage?: PostApprovalWritingStage;

  /**
   * Free-space floor the launch preflight refuses below, in GB. Defaults
   * to `DEFAULT_MIN_FREE_DISK_GB`, or to `AFK_MIN_FREE_DISK_GB` when that
   * is set; 0 disables the floor. Resolved by `resolveMinFreeDiskGb`.
   * See ADR 0042.
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

function featureBranchPrefix(provider: AgentProvider): string {
  return featureBranchPrefixForProviderName(provider.name);
}

export function pipelineRunSlug(prdSlug: string, provider: AgentProvider): string {
  return runSlugForProviderName(prdSlug, provider.name);
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
  cleanable?: ReadonlyArray<{ path: string; branch: string }>;
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
    cleanable: args.cleanable ?? [],
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
   * The **run's** gate policy — read from the host checkout, never from
   * {@link worktreeDir} (#251). Any gate whose rulebook this is takes it from
   * here: a policy read out of the candidate's own worktree is a policy the
   * candidate's generator can author, and a gate that enforces the rules of the
   * thing it judges cannot fail closed (`docs/PRODUCT.md` operating principle
   * 6). The candidate's own copy stays evidence — see
   * `src/feedback-integrity-gate.ts`.
   */
  runGatePolicy: GatePolicy | null;
  /**
   * Set by `runSliceNegotiate` when the slice resumed from its
   * surviving branch tip instead of restarting from base (spec #33).
   * Drives the round-1 generator repair envelope with the surviving
   * situation facts. Absent for fresh and restarted slices.
   */
  resume?: {
    /**
     * Which resume situation the repair envelope describes.
     *
     * - `killed` — the default path (#33): the previous invocation died
     *   mid-run, so the tree was reset to its last commit and refreshed
     *   from the feature branch before the generator was handed
     *   the repair envelope.
     * - `stuck` — the operator opted in with `--resume-stuck` (#49): the
     *   tree was left untouched and the stuck.md diagnosis survives.
     *   Both modes use `generator-repair`; explicit situation blocks
     *   carry their opposite worktree facts.
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
   * Spend one resume attempt against the poison-tree cap — set alongside
   * `resume`, and called exactly once, immediately before the first generator
   * dispatch of this invocation (#188 defect 4).
   *
   * The counter answers "how many times has a generator already been let loose
   * on this tree", which is the only question `MAX_RESUME_ATTEMPTS` is a good
   * answer to. `prepareSliceWorktree` decides the resume long before that:
   * everything from the ADR 0010 ownership assert through the explorer,
   * contract negotiation, the contract-lock gate, adjudication routing,
   * exact-stage resume and prompt assembly runs first, and any of it can fail.
   * Charging at the decision made every one of those failures cost an attempt,
   * so two configuration faults exhausted the cap and pointed the operator at
   * `--force-restart` on a tree holding five good commits — the poisoned-tree
   * heuristic inverted, with the tree fine and the pipeline the thing failing.
   *
   * Idempotent by its own latch: the implementation loop runs several rounds
   * inside one invocation, and one *invocation* costs one attempt.
   */
  chargeResume?: () => void;
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
    opts: Parameters<AgentProvider["invoke"]>[0] & {
      /**
       * Identity for the post-return `invocation-completed` event when the
       * invocation carries no assembled envelope (candidate-QA, shared-preview
       * and final evaluators). Stripped before the provider call.
       */
      completionEvidence?: {
        ghIssue: string;
        sliceNumber: string;
        round: number;
        attempt?: number;
        role: "evaluator-qa" | "evaluator-uat" | "evaluator-final";
      };
    },
  ) => ReturnType<AgentProvider["invoke"]>;
}

export function makeSliceContext(
  config: PipelineConfig,
  slice: Slice,
  logger: RunJournal,
  featBranch: string,
  relevantFilesBlock: string,
  testCommand: string,
  /**
   * The run's gate-policy snapshot, taken by the launch path before any agent
   * ran (#251). Omitted, it is read from `config.repoRoot` here — still the
   * host checkout and still never the candidate worktree, just a read that a
   * concurrent edit to the base checkout could see. Callers that own a run
   * pass their snapshot.
   */
  runGatePolicy?: GatePolicy | null,
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

  const sanityCommands = resolveCandidateQACommands(repoRoot);
  const sanityCommandsBlock =
    sanityCommands.length > 0
      ? sanityCommands.map((c) => `- \`${c}\``).join("\n")
      : "(no pre-QA typecheck/lint scripts defined in this project — skip)";
  const siblingHandoffs = slice.blockedBy
    .map((issue) => config.dag.slices.get(issue))
    .filter((dependency): dependency is Slice => dependency !== undefined)
    .map((dependency) =>
      `${specsDir.replace(/\\/g, "/")}/slices/${dependency.number}-${slugify(dependency.title)}/handoff.md`,
    );
  const siblingHandoffsBlock = siblingHandoffs.length > 0
    ? siblingHandoffs.map((path) => `- \`${path}\``).join("\n")
    : "(none — this slice declares no AFK dependencies)";

  const invoke = async (
    opts: Parameters<AgentProvider["invoke"]>[0] & {
      /**
       * Identity for the post-return `invocation-completed` event when the
       * invocation carries no assembled envelope (candidate-QA and
       * shared-preview evaluators). Completion telemetry — token counts,
       * `nonCommandTimeMs` — is decoupled from PRD 3 envelope assembly
       * because evaluator reading time is the measurement the ROI rider
       * scores (plan §3 item 13; guardian round 6). Stripped before the
       * provider call: providers stay command/output adapters (ADR 0002).
       */
      completionEvidence?: {
        ghIssue: string;
        sliceNumber: string;
        round: number;
        attempt?: number;
        role: "evaluator-qa" | "evaluator-uat" | "evaluator-final";
      };
    },
  ) => {
    const { completionEvidence, ...providerOpts } = opts;
    // Transient model outages (provider-classified) retry here with
    // backoff instead of failing the slice. See ADR 0022.
    const result = await withTransientRetry(
      () => {
        // Assembly evidence is journaled immediately before EVERY provider
        // dispatch — inside the retry callback, so a transient-retry
        // re-dispatch also observes its matching `prompt-assembly` event
        // as the immediately preceding journal entry, and the record
        // exists even when the invocation dies before returning
        // (slice #83; guardian round 2 PM 4, round 3 PM 2). Post-return
        // facts arrive in `invocation-completed`.
        if (opts.contextEnvelope !== undefined) {
          logger.event({
            type: "prompt-assembly",
            ...opts.contextEnvelope,
          });
        }
        return provider.invoke({
          ...providerOpts,
          signal,
          onIdleWarning: (silentSeconds) => {
            if (opts.logStream) {
              logger.writeIdleWarning(opts.logStream, opts.role, silentSeconds);
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
        });
      },
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
    // Post-return completion telemetry: identity comes from the assembled
    // envelope when there is one, or from `completionEvidence` for the
    // evaluator invocations whose envelope path is deferred (guardian
    // round 6 — evaluator reading time is the ROI rider's measurement).
    const completionIdentity =
      opts.contextEnvelope !== undefined
        ? {
            ghIssue: opts.contextEnvelope.ghIssue,
            sliceNumber: opts.contextEnvelope.sliceNumber,
            round: opts.contextEnvelope.round,
            role: opts.contextEnvelope.role,
          }
        : completionEvidence;
    if (completionIdentity !== undefined) {
      const tokenCounts = result.stats.tokenCounts;
      // nonCommandTimeMs rides along as evidence only (ADR 0046
      // amendment) — recorded when the provider measured it, omitted
      // otherwise. Nothing branches on it.
      const nonCommandTimeMs = result.stats.nonCommandTimeMs;
      logger.event({
        type: "invocation-completed",
        ...completionIdentity,
        ...(tokenCounts !== undefined &&
        Object.keys(tokenCounts).length > 0
          ? { tokenCounts }
          : {}),
        ...(nonCommandTimeMs !== undefined ? { nonCommandTimeMs } : {}),
      });
    }
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
    runGatePolicy:
      runGatePolicy === undefined ? loadGatePolicy(repoRoot) : runGatePolicy,
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
 * The context an archive warning needs, and nothing more. Structural so a
 * unit test can prove the non-fatality without standing up a slice.
 */
export interface ArchiveWarningContext {
  tag: string;
  slice: { ghIssue: string };
  logger: Pick<RunJournal, "phase">;
}

/**
 * Run one evidence archive write for the record, never for the slice's
 * outcome (#258).
 *
 * An archive describes a run; it must not be able to end one. On #96 a
 * `cpSync(..., { errorOnExist: true })` refusing to overwrite a name a
 * *previous* run had already written threw out of the generator loop, ERRORed
 * a slice holding seven good commits, and was charged as a resume attempt —
 * half the slice's resume budget spent on a filesystem collision. Nothing
 * about the implementation was wrong, and nothing the archive protects was
 * lost: the refusal exists so an earlier attempt's evidence is never
 * overwritten, and warning satisfies that just as well as throwing.
 *
 * The warning names the archive path, because a gap in the archive has to be
 * traceable rather than invisible. Returns `null` when the write failed, so
 * a caller that reads the archived names can tell.
 *
 * Deliberately not applied to the QA raw-canonical artifact, which fails
 * closed on purpose (#79): that one is the evidence a PASS rests on, and an
 * attempt whose evidence could not be preserved must not count. Every caller
 * here archives a record of something that has *already* been decided.
 */
export function archiveForTheRecord<T>(
  ctx: ArchiveWarningContext,
  description: string,
  archiveDir: string,
  write: () => T,
): T | null {
  try {
    return write();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.phase(
      `${ctx.tag}: Warning: failed to archive ${description} to ` +
        `${archiveDir}: ${message}`,
      "error",
      {
        type: "warn",
        reason: "evidence-archive-failed",
        ghIssue: ctx.slice.ghIssue,
        message,
      },
    );
    return null;
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
  validated: ValidatedContractReview | null,
  plannerResponse: ContractResponse | null,
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

  if (validated === null) return null;
  const review = validated.review;

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
/**
 * Outcomes of one attempt at a focused scope revision.
 *
 * `REJECTED` is separated from `ERROR` because the two are recoverable in
 * different ways (#257): a rejection is the contract evaluator doing its job
 * and naming a clear condition, so the caller may spend another of the
 * round's revision grants on a retry that carries those findings. Every
 * `ERROR` here is terminal for the slice.
 */
type FocusedScopeRevisionResult =
  | { phase: "LOCKED"; manifest: AcceptanceManifest }
  | { phase: "REJECTED"; findings: readonly ContractReviewFinding[] }
  | { phase: "ERROR"; error: string };

async function runFocusedScopeRevision(
  ctx: SliceContext,
  escalation: import("./escalation.js").ScopeEscalation,
  rejectionFindings: readonly ContractReviewFinding[] = [],
): Promise<FocusedScopeRevisionResult> {
  return await withContractTransaction(
    ctx,
    {
      reason: "focused scope revision did not complete",
      qualifier: "the previously accepted",
    },
    (tx) => reviseAcceptedContract(ctx, escalation, rejectionFindings, tx),
  );
}

async function reviseAcceptedContract(
  ctx: SliceContext,
  escalation: import("./escalation.js").ScopeEscalation,
  rejectionFindings: readonly ContractReviewFinding[],
  tx: ContractTransaction,
): Promise<FocusedScopeRevisionResult> {
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
  clearPlannerEscalation(ctx.absSliceDir);
  const plannerLog = logger.agentLog(
    slice.number,
    "planner",
    revisionRound,
  );
  const promptContext = promptAssemblyContext(
    logger,
    slice,
    ctx.relSpecsDir,
    ctx.relSliceDir,
    revisionRound,
  );
  const plannerPrompt = assembleFocusedScopePlannerPrompt({
    context: promptContext,
    repoRoot: ctx.worktreeDir,
    currentContract: readFileSync(contractPath, "utf-8"),
    currentAcceptanceManifest: previousManifestText,
    scopeEvidence: evidence,
    rejectionFindings,
    contractResponseFilename: CONTRACT_RESPONSE_FILENAME,
    migrationReservation: migrationReservationBlock(config, slice.ghIssue),
    baseGateCatalog: formatBaseGateCatalog(
      resolveBindableGateCatalog(ctx.worktreeDir),
    ),
    inlineSizeBudgetBytes: config.plannerInlineSizeBudgetBytes,
  });
  await invoke({
    role: "planner",
    prompt: plannerPrompt.prompt,
    contextEnvelope: plannerPrompt.contextEnvelope,
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

  // `planner-revision.md` is this path's template too, so this planner can
  // also stop to request a design decision. Read the sentinel before the
  // manifest, for the same reason the negotiation loop does: the missing
  // manifest is the stop's consequence, and reporting it as the defect would
  // hide the request behind "acceptance-manifest.json is missing". The
  // transaction rolls the accepted pair back either way.
  const revisionEscalation = readPlannerEscalation(ctx.absSliceDir);
  if (revisionEscalation !== null) {
    return {
      phase: "ERROR",
      error: `focused scope revision stopped — ${plannerEscalationRequest(revisionEscalation)}`,
    };
  }
  const revisedManifest = loadAcceptanceManifest(ctx.absSliceDir);
  validateAcceptanceManifestStability(previousManifest, revisedManifest);
  validateAcceptanceManifestCoverage(
    readFileSync(contractPath, "utf-8"),
    revisedManifest,
    contractPath,
  );
  const gateCatalog = resolveBindableGateCatalog(ctx.worktreeDir);
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
  const evaluatorPrompt = assembleFocusedScopeEvaluatorPrompt({
    context: promptContext,
    contractReviewFile: CONTRACT_REVIEW_FILENAME,
    proposedContract: readFileSync(contractPath, "utf-8"),
    acceptanceManifest: revisedManifest,
    baseGateCatalog: formatBaseGateCatalog(gateCatalog),
    explorerContext: readFileSync(
      join(ctx.absSliceDir, "context.md"),
      "utf-8",
    ),
    inlineSizeBudgetBytes: config.contractEvaluatorInlineSizeBudgetBytes,
  });
  await invoke({
    role: "evaluator-contract",
    prompt: evaluatorPrompt.prompt,
    contextEnvelope: evaluatorPrompt.contextEnvelope,
    cwd: ctx.worktreeDir,
    logStream: evaluatorLog,
    maxDurationMs: config.maxAgentDurationMs,
  }).finally(() => closeAgentLog(evaluatorLog));

  const review = loadContractReview(ctx.absSliceDir);
  const validated = validateFreshContractReview(review);
  archiveContractReviewAttempt(
    ctx,
    reviewArchiveDir,
    revisionRound,
    1,
    validated,
    null,
  );
  logger.event({
    type: "phase-ended",
    ghIssue: slice.ghIssue,
    sliceNumber: slice.number,
    agent: "evaluator-contract",
    round: revisionRound,
    verdict: review.verdict,
  });
  // Not terminal by itself (#257). The transaction rolls the accepted pair
  // back on this exit, so the caller's retry starts from the same baseline
  // the first attempt did, plus these findings.
  if (review.verdict !== "ACCEPT") {
    return { phase: "REJECTED", findings: review.findings };
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
  /**
   * The planner stopped on purpose and asked for a design decision it is not
   * allowed to make (`docs/specs/afk-v2-plan.md` §3c policy 1). Not a
   * `verdict`: no evaluator ran and nothing judged the contract — the planner
   * declined to write one. Terminal and deliberately not
   * infrastructure-class: the same planner against the same specification
   * stops again, so the fix is a recorded decision, not a retry.
   */
  | "design-decision"
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
 * The planner's deliberate stop, reported as the request it is.
 *
 * The summary is what the wave records as the slice's outcome reason, so it is
 * what `afk status` and the next run's retry line show. It must never be the
 * missing-artifact sentence: a planner that obeyed its stop condition and a
 * planner that failed to write a manifest used to be indistinguishable in
 * this report, which sent the reader looking for a broken agent instead of an
 * unsettled decision.
 */
function plannerEscalationCause(
  record: PlannerEscalationRecord,
  round: number,
): NegotiateFailureCause {
  return {
    kind: "design-decision",
    role: "planner",
    summary:
      `negotiate: the planner stopped at round ${round} to request a design ` +
      `decision instead of writing a contract — ` +
      `${plannerEscalationRequest(record)}; record the decision, then rerun ` +
      `the slice`,
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

  // Every outcome below except the two resume arms starts from no pending
  // charge and no resume situation. Cleared here rather than in each arm so a
  // lane successor that resumed in Phase A and was then recreated from base
  // cannot carry either into its second pass.
  delete ctx.resume;
  delete ctx.chargeResume;

  /**
   * Arm the resume charge. The attempt is spent when a generator is
   * dispatched onto this tree, not when the decision to re-attach is made
   * (#188 defect 4) — see `SliceContext.chargeResume`. The latch is captured
   * per decision, so the several generator rounds of one invocation cost one
   * attempt between them.
   */
  const armResumeCharge = (describe: (attempts: number) => string): void => {
    let spent = false;
    ctx.chargeResume = () => {
      if (spent) return;
      spent = true;
      const attempts = chargeResumeAttempt(
        repoRoot,
        runSlug,
        ghIssue,
        describe,
      );
      ctx.logger.phase(
        `${ctx.tag}: resume attempt ${attempts}/${MAX_RESUME_ATTEMPTS} ` +
          `charged at generator dispatch`,
      );
    };
  };

  /**
   * Put the previous life's artifacts out of this one's way, for the two
   * paths that start a slice at round 1 with no resume state.
   *
   * The slice's spec artifacts (contract.md, context.md, feedback-r*,
   * qa-report*, handoff.md, stuck.md) are untracked files inside the
   * worktree, so recreating it deletes the only copy — they are copied to
   * the same `.afk/artifacts/` path the ESCALATE/STUCK preserve path
   * writes to (#113). The `reviews/` archive dir is moved aside, because
   * the next round-1 contract-review and QA evidence writes target the same
   * `r1-a1` names and fail closed on a collision — burning infrastructure
   * retries and possibly ending the run ERROR before the next re-launch's
   * resume self-heals past the occupied rounds (#123). Two lives inside one
   * run share a run id, so #258's spill does not free those slots for them;
   * moving the directory is still what does.
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
      // Recorded, not charged. The attempt is spent at the generator dispatch
      // (#188 defect 4): everything between here and there — negotiation, the
      // contract-lock gate, prompt assembly, the spawn itself — can fail
      // without a generator ever seeing this tree, and none of those failures
      // is evidence the tree is poisoned.
      recordRetryDecision(repoRoot, runSlug, ghIssue, {
        attempts: priorAttempts,
        lastDecision:
          `resume planned from ${plan.commitsAhead} commit(s); no attempt ` +
          `charged — the generator was not dispatched`,
      });
      armResumeCharge(
        (attempts) =>
          `resumed from ${plan.commitsAhead} commit(s) — attempt ` +
          `${attempts}/${MAX_RESUME_ATTEMPTS} charged at generator dispatch`,
      );
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
    // Recorded, not charged — same rule as the `killed` arm above. The stuck
    // path is exempt from the cap by construction (`--resume-stuck` must be
    // re-supplied every run, so the operator is the cap), but the counter has
    // to mean one thing on both paths or its audit trail lies.
    const stuckRefreshNote = baseRefreshed
      ? ""
      : " (base refresh declined to preserve the tree)";
    recordRetryDecision(repoRoot, runSlug, ghIssue, {
      attempts: priorAttempts,
      lastDecision:
        `resume of STUCK tree planned from ${plan.commitsAhead} commit(s) via ` +
        `--resume-stuck${stuckRefreshNote}; no attempt charged — the generator ` +
        `was not dispatched`,
    });
    armResumeCharge(
      (attempts) =>
        `resumed STUCK tree from ${plan.commitsAhead} commit(s) via ` +
        `--resume-stuck${stuckRefreshNote} — attempt ${attempts} charged at ` +
        `generator dispatch (not capped)`,
    );
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
    // A fresh tree earns a fresh resume budget, for the same reason
    // `restartFromBase` resets it: the count means "resumed generator
    // dispatches this tree has absorbed", and this is not that tree. Without
    // this, a slice whose branch and worktree `clean-failed` removed carries
    // its predecessor's spent count and can be capped on the new tree's first
    // real resume.
    if (priorAttempts > 0) {
      recordRetryDecision(repoRoot, runSlug, ghIssue, {
        attempts: 0,
        lastDecision:
          "fresh worktree created (no branch or worktree survived) — " +
          "resume budget reset",
      });
    }
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
 * The attempt count projects the pending charge. Since #188 defect 4 the
 * increment lands at the generator dispatch, which is after this line, so the
 * persisted value here is one short of what this dispatch will have spent if
 * it reaches the generator — and what it will have spent is the number the
 * operator needs. A dispatch that ends before the generator leaves a bounds
 * line that over-reported by one; its own failure line and the state file both
 * say the attempt was not charged.
 *
 * Reporting only. Every budget is still enforced where it was.
 */
export function reportSliceBounds(ctx: SliceContext): void {
  const { config, slice } = ctx;
  const provider = config.provider ?? kiroProvider;
  const runSlug = pipelineRunSlug(config.prdSlug, provider);
  const bounds = computeSliceBounds({
    resumeAttemptsSpent:
      getResumeAttempts(
        loadRunState(config.repoRoot, runSlug),
        slice.ghIssue,
      ) + (ctx.chargeResume ? 1 : 0),
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
            resolveBindableGateCatalog(ctx.worktreeDir),
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
        // Deleted here too, so "a sentinel on disk was written by the planner
        // invocation that just ran" holds for the whole file rather than only
        // for the negotiation loop. Without it, a survivor from an earlier
        // phase would be read below as this planner's stop.
        clearPlannerEscalation(ctx.absSliceDir);
        const plannerLog = logger.agentLog(ctx.slice.number, "planner");
        try {
          const plannerPrompt = assembleAdjudicationPlannerPrompt({
            context: promptAssemblyContext(
              logger,
              ctx.slice,
              ctx.relSpecsDir,
              ctx.relSliceDir,
              2,
            ),
            repoRoot: ctx.worktreeDir,
            currentContract: readFileSync(contractPath, "utf-8"),
            currentAcceptanceManifest: JSON.stringify(
              preApplyManifest,
              null,
              2,
            ),
            impasseRecord: rawOutcome,
            decisions: decisionLog.decisions.map((recorded) => recorded.raw),
            contractResponseFilename: CONTRACT_RESPONSE_FILENAME,
            migrationReservation: migrationReservationBlock(
              config,
              ctx.slice.ghIssue,
            ),
            baseGateCatalog: formatBaseGateCatalog(
              resolveBindableGateCatalog(ctx.worktreeDir),
            ),
            inlineSizeBudgetBytes: config.plannerInlineSizeBudgetBytes,
          });
          await ctx
            .invoke({
              role: "planner",
              prompt: plannerPrompt.prompt,
              contextEnvelope: plannerPrompt.contextEnvelope,
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
        // This planner reads `planner-revision.md` too, so it can stop to
        // request a design decision — a human decision that overrides a
        // recorded ADR fires escalation test 1 directly. Read before the
        // lock, because this path is the one where an ignored stop is
        // *worse* than a misreport: the pre-apply pair is still on disk and
        // still valid, so `lockAdjudicatedContract` would accept it and
        // `markAdjudicationDecisionsApplied` would mark the human's
        // decisions consumed by a contract that contains none of them.
        // Returning here instead leaves the decision log unapplied and lets
        // the transaction restore the pair, so the same decisions are
        // retried once the design question is settled.
        const applyEscalation = readPlannerEscalation(ctx.absSliceDir);
        if (applyEscalation !== null) {
          const request = plannerEscalationRequest(applyEscalation);
          // A plain phase line, no structured event: this round already
          // emitted its planner `phase-ended` above, and the run-event
          // `reason` vocabulary is not this patch's to extend.
          logger.phase(`${ctx.tag}: adjudication apply refused — ${request}`);
          return {
            phase: "ADJUDICATION-LOCK-REFUSED",
            cause: {
              kind: "design-decision",
              role: "planner",
              summary:
                `adjudication: the planner stopped instead of applying the ` +
                `human decision(s) — ${request}; the decisions stay ` +
                `unapplied, so record this one and rerun the slice`,
            },
          };
        }
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
    let hasValidContext = false;
    if (existsSync(contextPath)) {
      try {
        validateExplorerEvidenceMap(readFileSync(contextPath, "utf-8"));
        hasValidContext = true;
      } catch {
        // A malformed prior artifact is not accepted for planner dispatch.
        // The explorer gets one chance to replace it with the current format.
      }
    }
    if (!hasValidContext) {
      const assembled = assembleExplorerEnvelope({
        repoRoot: ctx.worktreeDir,
        ghIssue: slice.ghIssue,
        title: slice.title,
        sliceDir: ctx.relSliceDir,
        relevantFiles: relevantFilesBlock,
        sliceBody: sliceBodyNote,
        ...(config.explorerInlineSizeBudgetBytes !== undefined
          ? {
              inlineSizeBudgetBytes:
                config.explorerInlineSizeBudgetBytes,
            }
          : {}),
      });
      logger.phase(`${ctx.tag}: exploring...`, "error", {
        type: "phase-started",
        ghIssue: slice.ghIssue,
        sliceNumber: slice.number,
        agent: "explorer",
      });
      await invokeAgent(
        {
          role: "explorer",
          prompt: assembled.prompt,
          contextEnvelope: {
            ghIssue: slice.ghIssue,
            sliceNumber: slice.number,
            round: 1,
            ...assembled.evidence,
          },
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
    if (!existsSync(contextPath)) {
      throw new Error(
        `Explorer did not write required artifact ${ctx.relSliceDir}/context.md`,
      );
    }
    const explorerContext = readFileSync(contextPath, "utf-8");
    validateExplorerEvidenceMap(explorerContext);

    // --- Step 2: Planner (contract negotiation) ---
    const contractPath = join(ctx.absSliceDir, "contract.md");
    let contractStatus = artifacts.readContractStatus(contractPath);
    const maxContractRounds = config.maxContractRounds ?? DEFAULT_MAX_CONTRACT_ROUNDS;
    if (!Number.isSafeInteger(maxContractRounds) || maxContractRounds < 1) {
      throw new Error("maxContractRounds must be a positive integer");
    }
    if (maxContractRounds > DEFAULT_MAX_CONTRACT_ROUNDS) {
      throw new Error(
        `maxContractRounds supports 1-${DEFAULT_MAX_CONTRACT_ROUNDS}; ` +
          "the evidence-qualified final response is controlled by AFK",
      );
    }
    const allowedContractRounds = maxContractRounds;
    let contractRoundLimit = allowedContractRounds;
    let evaluatorRound = 0;
    let lastRound = 0;
    let lastVerdict: RecordedContractVerdict = "NONE";
    let lastFeedbackPath = join(ctx.absSliceDir, "feedback-r0.md");
    const capDecisions: string[] = [];
    let capIntervention: InterventionRequest | null = null;
    /**
     * The previous round's review, kept so this round's re-raised-gap
     * count can be derived from finding IDs rather than taken from the
     * evaluator's word.
     */
    let previousReview: ContractReview | null = null;
    const convergenceTarget = {
      repoRoot: config.repoRoot,
      prdSlug: config.prdSlug,
      ghIssue: slice.ghIssue,
      sliceDir: ctx.absSliceDir,
      runSlug: pipelineRunSlug(
        config.prdSlug,
        config.provider ?? kiroProvider,
      ),
    };
    // The one silent case in ADR 0061's lineage relocation: a pre-#178 build
    // wrote this slice's lineage under the bare PRD slug, so this run reads an
    // empty one and the tamper guard has nothing to enforce. Nothing is
    // adopted (see `findOrphanedContractLineage`) — it is named instead, once,
    // before the first round.
    const orphanedLineage = findOrphanedContractLineage(convergenceTarget);
    if (orphanedLineage !== null) {
      logger.phase(`${ctx.tag}: ${orphanedLineage}`, "error", {
        type: "warn",
        reason: "orphaned-contract-lineage",
        ghIssue: slice.ghIssue,
        message: orphanedLineage,
      });
    }
    const contractLifecycle = new ContractRoundLifecycle(convergenceTarget);
    let lastFindings: readonly ContractReviewFinding[] =
      contractLifecycle.openFindings;
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
     * planner round. Non-null means the last contract the evaluator
     * accepted — or the last one found already `LOCKED` on disk — was
     * refused by the gate, so it is NEGOTIATING and owes a planner round.
     */
    let gateObjection: string | null = null;
    let previousSchemaValidManifest: AcceptanceManifestV2 | null = null;

    /**
     * Route a gate objection to the next planner round: the contract is
     * NEGOTIATING, and `gateObjection` holds the feedback that round must
     * address.
     *
     * `refusedContract` describes which contract was refused, and reaches
     * the operator through `stuck.md` — so it says "locked by a previous
     * run" for a contract found already locked on disk rather than
     * inventing a round number for a round this run never ran.
     */
    const recordGateObjection = (
      objection: string,
      refusedContract: string,
    ): void => {
      gateObjection = objection;
      contractStatus = "NEGOTIATING";
      capDecisions.push(
        `The contract-lock gate refused the contract ${refusedContract}: ${objection}`,
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
    };

    /**
     * Consult the contract-lock gate on the contract the evaluator just
     * accepted, *before* anything writes `LOCKED`. `true` means the gate
     * refused it: nothing has been written, the contract still says
     * NEGOTIATING on disk, and the objection is routed to the next round.
     *
     * Gate before lock is ADR 0055 §5's mandated ordering, and it is what
     * makes `LOCKED` on disk the gate's own attestation (ADR 0008). The
     * gate reads the declared file scope, never the status line, so it
     * needs no lock to run.
     */
    const candidateRefusedByGate = (round: number): boolean => {
      const objection = ctx.onContractLocked?.(contractPath) ?? null;
      if (objection === null) return false;
      // The planner may have written `**Status:** LOCKED` into the candidate
      // itself. Nothing here wrote it, the gate has just refused it, and the
      // generator reads that line as permission (ADR 0008) — so it cannot be
      // left on disk. Under the old lock-then-gate ordering this
      // normalisation came for free from the reopen that followed
      // `lockContract`; with nothing written on the refusal path it has to be
      // explicit. An agent-authored lock surviving a *non*-ACCEPT verdict is
      // a wider hole than this one call site (architect A2 / PM P1 of the
      // round-9 review, filed separately); this closes only the case the
      // gate-before-lock reordering itself would otherwise have opened.
      if (artifacts.readContractStatus(contractPath) === "LOCKED") {
        artifacts.reopenContract(contractPath);
      }
      recordGateObjection(objection, `accepted in round ${round}`);
      return true;
    };

    /**
     * Consult the gate on a contract that is already `LOCKED` on disk — left
     * there by an earlier run. A refusal reopens the stale lock before it can
     * reach the generator, preserving ADR 0008's on-disk authority.
     */
    const lockRefusedByGate = (lockedAt: string): boolean => {
      const objection = ctx.onContractLocked?.(contractPath) ?? null;
      if (objection === null) return false;
      artifacts.reopenContract(contractPath);
      recordGateObjection(objection, lockedAt);
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
      const gateCatalog = resolveBindableGateCatalog(ctx.worktreeDir);
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
        lockRefusedByGate("locked by a previous run");
      }
    }

    if (contractStatus !== "LOCKED") {
      for (let round = 1; round <= contractRoundLimit; round++) {
        // Consume any pending gate objection: it belongs to this round's
        // planner prompt only. Leaving it set would re-deliver it after a
        // later ordinary REVISE, and would make the round-cap branch
        // below misattribute that REVISE to the gate.
        const pendingObjection = gateObjection;
        gateObjection = null;
        const plannerRound = contractLifecycle.preparePlannerRound(
          round,
          pendingObjection,
        );
        const routedFindings = plannerRound.routedFindings;
        const relevantResolvedFindings =
          plannerRound.relevantResolvedFindings;
        const requiresPlannerResponse = plannerRound.requiresResponse;
        const currentContractText = existsSync(contractPath)
          ? readFileSync(contractPath, "utf-8")
          : "";
        const currentManifestPath = join(
          ctx.absSliceDir,
          ACCEPTANCE_MANIFEST_FILENAME,
        );
        const currentManifestText = existsSync(currentManifestPath)
          ? readFileSync(currentManifestPath, "utf-8")
          : "(missing acceptance manifest)";
        const previousArtifactText = requiresPlannerResponse
          ? {
              contract: currentContractText,
              manifest: currentManifestText,
            }
          : null;
        const contractResponseInstructions = requiresPlannerResponse
          ? [
              `Write ${ctx.relSliceDir}/${CONTRACT_RESPONSE_FILENAME} after revising the contract.`,
              "Use exactly the required version-1 schema.",
              `Include one response for each routed ID and no others: ${routedFindings.map(({ id }) => id).join(", ")}.`,
              "CONDITION_MET and CONTESTED require non-blank evidence.",
            ].join("\n")
          : `Do not write ${CONTRACT_RESPONSE_FILENAME} in this round.`;
        const baseGateCatalog = formatBaseGateCatalog(
          resolveBindableGateCatalog(ctx.worktreeDir),
        );
        /**
         * Planner dispatch for this round. The loop runs more than once only
         * for an artifact repair pass: a refused `contract-response.json` is
         * handed back with its exact validation error instead of ending the
         * slice on a one-field schema slip (ADR 0061, #188 defect 1). The
         * round number, the routed findings and the pre-round artifact text
         * are all captured above, so a repair pass cannot buy a revision.
         */
        let plannerRepairsUsed = 0;
        let plannerRepairInstruction: string | null = null;
        /**
         * The behavior-ID stability baseline as the round began. A repair pass
         * re-runs `loadBehaviorLockArtifacts`, whose side effect is to advance
         * `previousSchemaValidManifest` — so without this restore the pass's
         * manifest would be checked against the *refused* pass's manifest
         * instead of the previous round's, and a renumbering introduced by an
         * attempt ADR 0061 declares "recorded no result" would become the
         * accepted baseline.
         */
        const roundStabilityBaseline: AcceptanceManifestV2 | null =
          previousSchemaValidManifest;
        /** Set when the round's manifest is refused; spends the round below. */
        let manifestObjection: string | null = null;
        /** Set when a refused response artifact is terminal for the slice. */
        let responseArtifactCause: NegotiateFailureCause | null = null;
        let baseGateCatalogBlock = "";
        let evaluatedManifest: AcceptanceManifest | null = null;
        for (;;) {
          const plannerPrompt = assembleNegotiationPlannerPrompt({
            context: promptAssemblyContext(
              logger,
              slice,
              ctx.relSpecsDir,
              ctx.relSliceDir,
              round,
            ),
            repoRoot: ctx.worktreeDir,
            // A repair pass answers a refused artifact, which only exists once
            // the planner has already written the pair, so it always takes the
            // revision envelope — the one with a control-plane slot to carry
            // the validation error.
            useInitialEnvelope:
              round === 1 &&
              pendingObjection === null &&
              plannerRepairInstruction === null,
            sliceBody: sliceBodyNote,
            explorerContext,
            currentContract: currentContractText,
            currentAcceptanceManifest: currentManifestText,
            findings: routedFindings,
            carriedFindings: plannerRound.carriedFindings,
            resolvedFindings: relevantResolvedFindings,
            pendingObjection,
            repairInstruction: plannerRepairInstruction,
            contractResponseInstructions,
            migrationReservation: migrationReservationBlock(
              config,
              slice.ghIssue,
            ),
            baseGateCatalog,
            inlineSizeBudgetBytes: config.plannerInlineSizeBudgetBytes,
          });

          logger.phase(
            `${ctx.tag}: planning (round ${round}/${contractRoundLimit})...`,
            "error",
            {
              type: "phase-started",
              ghIssue: slice.ghIssue,
              sliceNumber: slice.number,
              agent: "planner",
              round,
            },
          );
          // Only on a first pass. A repair pass asks for one corrected
          // artifact and says to change nothing else, so deleting the
          // manifest the round already wrote and validated would leave a
          // planner that obeys with no manifest at all — and the missing-file
          // throw is routed as an acceptance-manifest gate objection, which
          // spends the round a repair pass is defined not to spend
          // (ADR 0061 decision 1).
          if (plannerRepairInstruction === null) {
            rmSync(join(ctx.absSliceDir, ACCEPTANCE_MANIFEST_FILENAME), {
              force: true,
            });
          }
          await invokeAgent(
            {
              role: "planner",
              prompt: plannerPrompt.prompt,
              contextEnvelope: plannerPrompt.contextEnvelope,
              cwd: ctx.worktreeDir,
              maxDurationMs: config.maxAgentDurationMs,
            },
            () => logger.agentLog(slice.number, "planner", round),
            // Per *attempt*, not per round. An infrastructure retry re-runs the
            // planner, so a sentinel written by an attempt that was retried
            // away would otherwise survive into the successful attempt's output
            // and escalate a round that produced a perfectly good contract.
            // Nothing is lost by clearing it: when retries are exhausted
            // `invokeAgent` throws and negotiate returns ERROR without ever
            // reading the sentinel, so the only reachable reader is the attempt
            // that succeeded.
            () => {
              clearPlannerEscalation(ctx.absSliceDir);
              if (requiresPlannerResponse) {
                rmSync(
                  join(ctx.absSliceDir, CONTRACT_RESPONSE_FILENAME),
                  { force: true },
                );
              }
            },
          );
          logger.event({
            type: "phase-ended",
            ghIssue: slice.ghIssue,
            sliceNumber: slice.number,
            agent: "planner",
            round,
          });

          // A deliberate stop, read on its own terms rather than out of the
          // manifest loader's throw. The planner writes this sentinel *instead
          // of* the contract pair, so the missing `acceptance-manifest.json` is
          // that stop's consequence and not an independent defect — reporting
          // it as the defect is what made an obeyed stop condition look
          // identical to a failed planner, and then cost a second, unchanged
          // round to reach the same place.
          //
          // Read before `loadBehaviorLockArtifacts`, not inside its catch: a
          // planner that wrote the sentinel *and* a valid pair does not throw,
          // so a check in the catch would evaluate a contract whose own author
          // declared the specification unsettled and discard the request
          // silently. The sentinel was deleted at the top of every attempt of
          // this invocation, so its presence proves the attempt whose output is
          // being read wrote it, and it wins over any pair sitting beside it.
          const plannerEscalation = readPlannerEscalation(ctx.absSliceDir);
          if (plannerEscalation !== null) {
            // Only an ACCEPT may leave a lock (ADR 0008). Nothing here wrote
            // one, but the planner may have written it into the `contract.md`
            // this round started from — and the generator reads that line as
            // permission while the next run's status fork skips negotiation on
            // it. This is the one thing `refuseInvalidManifest` does that
            // bypassing it must not drop.
            if (artifacts.readContractStatus(contractPath) === "LOCKED") {
              artifacts.reopenContract(contractPath);
            }
            const request = plannerEscalationRequest(plannerEscalation);
            lastRound = round;
            lastVerdict = "NONE";
            capDecisions.push(
              `The planner stopped at round ${round} to request a design ` +
                `decision instead of writing a contract: ${request}. Record the ` +
                `decision in the source issue or an ADR, then rerun the slice. ` +
                `Report: ${ctx.relSliceDir}/${PLANNER_ESCALATION_FILENAME}.`,
            );
            logger.phase(
              `${ctx.tag}: contract negotiation stopped: ${request}`,
            );
            logger.phase(
              `${ctx.tag}: ESCALATE — the planner requested a design decision`,
            );
            preserveContractNegotiationFailure(
              ctx,
              "ESCALATE",
              round,
              "NONE",
              lastFeedbackPath,
              capDecisions.join(" "),
            );
            return {
              phase: "ESCALATE",
              cause: plannerEscalationCause(plannerEscalation, round),
            };
          }

          try {
            const lockArtifacts = loadBehaviorLockArtifacts();
            evaluatedManifest = lockArtifacts.manifest;
            baseGateCatalogBlock = formatBaseGateCatalog(
              lockArtifacts.gateCatalog,
            );
          } catch (error) {
            // Not a repair pass: a refused manifest is scope evidence the
            // *next* planner round owes an answer to (ADR 0050), and it is
            // routed as a gate objection below rather than re-prompted here.
            manifestObjection =
              error instanceof Error ? error.message : String(error);
            break;
          }

          plannerResponse = null;
          revisionArtifacts = null;
          if (requiresPlannerResponse) {
            /**
             * Only `contract-response.json`'s own validation earns a repair
             * pass, and it is read alone for exactly that reason. All three
             * planner-side defects #188 reports throw from here, and nothing
             * else does: the manifest read/write/parse and the revision-scope
             * validator below are not the agent's response artifact. Handing
             * a manifest refusal back as "your contract-response.json was
             * refused" would tell the planner to rewrite a file that was
             * never wrong — and a refused *manifest* is scope evidence the
             * next round owes an answer to (ADR 0050), deliberately outside
             * the repair pass's scope (ADR 0061 decision 1). Those throws
             * keep their pre-ADR-0061 terminal exit, below.
             */
            let responseDefect: string | null = null;
            try {
              plannerResponse = loadContractResponse(
                ctx.absSliceDir,
                routedFindings.map(({ id }) => id),
                round,
              );
            } catch (error) {
              responseDefect =
                error instanceof Error ? error.message : String(error);
            }
            if (responseDefect !== null) {
              const repair = decideNegotiationArtifactRepair({
                artifact: CONTRACT_RESPONSE_FILENAME,
                defect: responseDefect,
                artifactWritten: existsSync(
                  join(ctx.absSliceDir, CONTRACT_RESPONSE_FILENAME),
                ),
                repairsUsed: plannerRepairsUsed,
              });
              if (repair.action === "repair") {
                plannerRepairsUsed++;
                plannerRepairInstruction = repair.instruction;
                // The refused pass advanced the stability baseline; a pass
                // that recorded no result must not move it.
                previousSchemaValidManifest = roundStabilityBaseline;
                const message =
                  `negotiate: ${CONTRACT_RESPONSE_FILENAME} was refused; ` +
                  `repair pass ${plannerRepairsUsed} in round ${round} — ${responseDefect}`;
                logger.phase(`${ctx.tag}: ${message}`, "error", {
                  type: "warn",
                  reason: "negotiation-artifact-repair",
                  ghIssue: slice.ghIssue,
                  message,
                });
                continue;
              }
              // Journal the denial too. A grant logged and a denial silent
              // reads as "the other artifact was never considered".
              const denial =
                `negotiate: ${CONTRACT_RESPONSE_FILENAME} was refused and no ` +
                `repair pass was granted — ${repair.reason}`;
              logger.phase(`${ctx.tag}: ${denial}`, "error", {
                type: "warn",
                reason: "negotiation-artifact-repair",
                ghIssue: slice.ghIssue,
                message: denial,
              });
              responseArtifactCause = negotiationArtifactCause(
                "planner",
                "contract response",
                responseDefect,
              );
              break;
            }
            try {
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
              const allowedBehaviorIds = [
                ...new Set(
                  routedFindings.flatMap(({ behaviorIds }) => behaviorIds),
                ),
              ];
              const restoredRevision =
                restoreAcceptanceManifestRevisionScope(
                  parseAcceptanceManifest(previousArtifactText!.manifest),
                  loadAcceptanceManifest(ctx.absSliceDir),
                  allowedBehaviorIds,
                );
              if (restoredRevision.restoredBehaviorIds.length > 0) {
                writeFileSync(
                  join(ctx.absSliceDir, ACCEPTANCE_MANIFEST_FILENAME),
                  `${JSON.stringify(restoredRevision.manifest, null, 2)}\n`,
                  "utf-8",
                );
                revisionArtifacts["acceptance-manifest.json"].after =
                  readFileSync(
                    join(ctx.absSliceDir, ACCEPTANCE_MANIFEST_FILENAME),
                    "utf-8",
                  );
                logger.phase(
                  `${ctx.tag}: restored unrelated planner revision drift in ` +
                    `${restoredRevision.restoredBehaviorIds.join(", ")}`,
                  "error",
                );
              }
              validateAcceptanceManifestRevisionScope(
                parseAcceptanceManifest(previousArtifactText!.manifest),
                loadAcceptanceManifest(ctx.absSliceDir),
                allowedBehaviorIds,
              );
            } catch (error) {
              // Not repair-eligible: see the comment above the response read.
              responseArtifactCause = negotiationArtifactCause(
                "planner",
                "contract revision",
                error instanceof Error ? error.message : String(error),
              );
              break;
            }
          }
          break;
        }

        if (responseArtifactCause !== null) {
          logger.phase(
            `${ctx.tag}: ${responseArtifactCause.summary}`,
            "error",
            {
              type: "phase-ended",
              ghIssue: slice.ghIssue,
              sliceNumber: slice.number,
              agent: "planner",
              round,
              verdict: "NONE",
            },
          );
          return { phase: "ERROR", cause: responseArtifactCause };
        }

        if (manifestObjection !== null) {
          refuseInvalidManifest(manifestObjection, `planner round ${round}`);
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

        evaluatorRound++;
        logger.phase(
          `${ctx.tag}: evaluating contract (round ${round}/${contractRoundLimit})...`,
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
        let latestValidatedReview: ValidatedContractReview | null = null;
        let latestValidationError: unknown = null;
        let attemptLifecyclePrevious: ContractReview | null = null;
        const currentContract = readFileSync(contractPath, "utf-8");
        /**
         * The informing half of durable lineage. `validateContractReviewAgainstLineage`
         * refuses a review that drops an open blocker, so every round that is
         * enforced against lineage has to be told what lineage holds — the
         * initial envelope included, which is the round a restart lands on
         * (#178).
         */
        const durableLineageNote = contractLifecycle.hasDurableLineage
          ? contractLifecycle.evaluatorHistoryNote(
              evaluatorRound,
              ctx.relSliceDir,
            )
          : null;
        /**
         * Attempts already archived for this round, across repair passes.
         * `invokeAgent` counts attempts per invocation and the archive refuses
         * to overwrite, so a repair pass has to continue the round's numbering
         * rather than restart it at 1.
         */
        let archivedAttempts = 0;
        let reviewRepairsUsed = 0;
        let reviewRepairInstruction: string | null = null;
        for (;;) {
          const evaluatorPrompt = assembleNegotiationEvaluatorPrompt({
            context: promptAssemblyContext(
              logger,
              slice,
              ctx.relSpecsDir,
              ctx.relSliceDir,
              evaluatorRound,
            ),
            useInitialEnvelope: evaluatorRound === 1,
            contractReviewFile: CONTRACT_REVIEW_FILENAME,
            proposedContract: currentContract,
            acceptanceManifest: evaluatedManifest!,
            baseGateCatalog: baseGateCatalogBlock,
            explorerContext,
            previousFindings: previousReview?.findings ?? [],
            durableLineage: durableLineageNote,
            repairInstruction: reviewRepairInstruction,
            plannerResponse,
            revisions: revisionArtifacts,
            inlineSizeBudgetBytes:
              config.contractEvaluatorInlineSizeBudgetBytes,
          });
          let attemptsThisPass = 0;
          await invokeAgent(
            {
              role: "evaluator-contract",
              prompt: evaluatorPrompt.prompt,
              contextEnvelope: evaluatorPrompt.contextEnvelope,
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
              attemptsThisPass = attempt;
              let validated: ValidatedContractReview | null = null;
              try {
                validated = contractLifecycle.validateAttempt({
                  review: loadContractReview(ctx.absSliceDir),
                  evaluatorRound,
                  plannerResponse,
                  revisionArtifacts,
                  attemptLifecyclePrevious:
                    attemptLifecyclePrevious ?? previousReview,
                });
              } catch (error) {
                latestValidationError = error;
                // The invocation retry policy decides whether another attempt
                // may replace this malformed artifact; the repair policy below
                // decides whether the agent gets told why it was refused.
              }
              const archived = archiveContractReviewAttempt(
                ctx,
                reviewArchiveDir,
                evaluatorRound,
                archivedAttempts + attempt,
                validated,
                plannerResponse,
              );
              if (archived) {
                latestValidatedReview = validated;
                latestValidAttemptReview = archived.review;
                lastReviewAttemptRecord = archived.record;
              }
            },
          );
          archivedAttempts += attemptsThisPass;
          if (latestValidatedReview !== null) break;
          const defect =
            latestValidationError instanceof Error
              ? latestValidationError.message
              : latestValidationError === null
                ? ""
                : String(latestValidationError);
          const repair = decideNegotiationArtifactRepair({
            artifact: CONTRACT_REVIEW_FILENAME,
            defect,
            artifactWritten: existsSync(reviewPath),
            repairsUsed: reviewRepairsUsed,
          });
          if (repair.action !== "repair") {
            // Journal the denial too, so the operator can tell a repair the
            // policy refused from one that was never considered.
            const denial =
              `negotiate: ${CONTRACT_REVIEW_FILENAME} was refused and no ` +
              `repair pass was granted — ${repair.reason}`;
            logger.phase(`${ctx.tag}: ${denial}`, "error", {
              type: "warn",
              reason: "negotiation-artifact-repair",
              ghIssue: slice.ghIssue,
              message: denial,
            });
            break;
          }
          reviewRepairsUsed++;
          reviewRepairInstruction = repair.instruction;
          const message =
            `negotiate: ${CONTRACT_REVIEW_FILENAME} was refused; repair pass ` +
            `${reviewRepairsUsed} in round ${round} — ${defect}`;
          logger.phase(`${ctx.tag}: ${message}`, "error", {
            type: "warn",
            reason: "negotiation-artifact-repair",
            ghIssue: slice.ghIssue,
            message,
          });
        }

        lastRound = round;
        lastFeedbackPath = feedbackPath;

        let validatedReview: ValidatedContractReview;
        try {
          if (latestValidatedReview === null) {
            throw (
              latestValidationError ??
              new Error(
                `${reviewPath} did not produce a lifecycle-valid review artifact`,
              )
            );
          }
          validatedReview = latestValidatedReview;
        } catch (error) {
          // The evaluator finished but said nothing the orchestrator can
          // act on, and its repair pass is spent. There is no default verdict
          // and no extra round: a malformed, missing, or self-contradictory
          // review artifact is terminal, and the operator gets the artifact
          // named. See ADR 0017 for the earlier, weaker version of this rule
          // and ADR 0061 for the repair pass that now precedes this exit.
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
        const review = validatedReview.review;

        const verdict = review.verdict;
        lastVerdict = verdict;
        lastFindings = review.findings;
        if (verdict !== "ACCEPT") {
          contractStatus = artifacts.readContractStatus(contractPath);
          // Only an ACCEPT may leave a lock. Normalize the candidate before
          // any terminal non-progress return so recovery never trusts a
          // planner-authored lock that the evaluator rejected.
          if (contractStatus === "LOCKED") {
            artifacts.reopenContract(contractPath);
            contractStatus = "NEGOTIATING";
          }
        }
        const hasContestedBlocker = review.findings.some(
          (finding) =>
            finding.severity === "BLOCKING" &&
            finding.state === "CONTESTED",
        );
        let acceptedByGate = false;
        if (verdict === "ACCEPT") {
          // Gate before lock, per ADR 0055 §5's mandated ordering. With
          // `lockContract` first, a process stop between the two calls left
          // an authoritative `LOCKED` contract whose gate had never passed
          // — a status ADR 0008 makes the generator trust, forged by a
          // crash window. Evaluating the gate against the accepted
          // candidate first means the only thing that can write `LOCKED`
          // here is a gate that already passed, so the status on disk *is*
          // the attestation. A refusal writes nothing at all.
          //
          // Deliberately not withContractTransaction: ordinary negotiation
          // has no previously-accepted contract/manifest pair to capture
          // and restore — the pair being written IS the first accepted
          // one. The stamp keeps lock provenance uniform (ADR 0055 §4);
          // the two revision paths, which do mutate an accepted pair, go
          // through the shared transaction's single lock exit, which
          // carries this same ordering.
          acceptedByGate = !candidateRefusedByGate(round);
        }
        // A refused lock falls through to the round-spending logic below:
        // the gate costs exactly what an evaluator REVISE costs. The deep
        // lifecycle operation validates, records, persists, classifies, and
        // writes any terminal intervention for this completed review.
        let coordinated: ReturnType<ContractRoundLifecycle["recordRound"]>;
        try {
          coordinated = contractLifecycle.recordRound({
            validated: validatedReview,
            evaluatorRound,
            plannerResponse,
            revisionArtifacts,
            attemptLifecyclePrevious,
            candidate: {
              branch: ctx.branch,
              treeId: resolveCandidateTreeId(ctx.worktreeDir),
            },
            supportingEvidence: [
              relative(config.repoRoot, feedbackPath).replace(/\\/g, "/"),
              relative(config.repoRoot, reviewArchiveDir).replace(/\\/g, "/"),
            ],
            round,
            normalRoundLimit: allowedContractRounds,
            semanticRoundLimit: contractRoundLimit,
            gateObjection: gateObjection !== null,
            hasContestedBlocker,
          });
        } catch (error) {
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
        lastFindings = coordinated.openFindings;
        logger.phase(
          `${ctx.tag}: contract verdict ${verdict} (round ${round}/${contractRoundLimit})` +
            ` — ${coordinated.metrics.gapCount} blocking finding(s)`,
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
        if (acceptedByGate) {
          artifacts.lockContract(contractPath, {
            kind: "negotiation",
            round,
          });
          contractStatus = "LOCKED";
          break;
        }
        if (
          coordinated.dispatch.action === "STOP" &&
          coordinated.dispatch.intervention &&
          round < contractRoundLimit
        ) {
          const request = coordinated.dispatch.intervention;
          const interventionPath =
            `${ctx.relSliceDir}/${INTERVENTION_FILENAME}`;
          capDecisions.push(request.summary);
          capDecisions.push(
            `Operator action: ${request.requiredOperatorAction}`,
          );
          preserveContractNegotiationFailure(
            ctx,
            "ESCALATE",
            round,
            verdict,
            feedbackPath,
            capDecisions.join(" "),
            review.findings,
          );
          logger.bumpEvalRound(slice.ghIssue, evaluatorRound);
          return {
            phase: "ESCALATE",
            cause: {
              kind: "verdict",
              verdict,
              summary:
                `negotiate: ${request.summary} Structured intervention: ` +
                `${interventionPath}. ${request.requiredOperatorAction}`,
            },
          };
        }

        if (round === contractRoundLimit) {
          if (coordinated.dispatch.action === "FINAL_RESPONSE") {
            contractRoundLimit = allowedContractRounds + 1;
            capDecisions.push(
              `Granted one final contract response for fresh blocking ` +
                `finding(s) ${coordinated.dispatch.findingIds.join(", ")}.`,
            );
            logger.phase(
              `${ctx.tag}: granting final contract response for fresh ` +
                `blocking finding(s) ${coordinated.dispatch.findingIds.join(", ")}`,
              "error",
            );
            previousReview = review;
            continue;
          }
          if (coordinated.dispatch.action === "STOP") {
            capDecisions.push(
              `No final contract response granted: ${coordinated.dispatch.reason}.`,
            );
          }
          if (
            coordinated.dispatch.action === "STOP" &&
            coordinated.dispatch.intervention
          ) {
            capIntervention = coordinated.dispatch.intervention;
            capDecisions.push(coordinated.dispatch.intervention.summary);
            capDecisions.push(
              `Operator action: ${coordinated.dispatch.intervention.requiredOperatorAction}`,
            );
          }
          const reason = gateObjection
            ? "the contract-lock gate refused the final round's contract"
            : `the negotiation reached its hard cap of ${contractRoundLimit} planner round(s)`;
          capDecisions.push(`Negotiation stopped because ${reason}.`);
          logger.phase(`${ctx.tag}: contract negotiation stopped: ${reason}`);
        } else {
          previousReview = review;
          continue;
        }

        const negotiationOutcome =
          evaluatorRound >= 2 && lastReviewAttemptRecord
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
          capIntervention
            ? (() => {
                const verdictCause = negotiateVerdictCause({
                  outcome: "ESCALATE",
                  verdict,
                  round,
                });
                return {
                  ...verdictCause,
                  summary:
                    `${verdictCause.summary}. ${capIntervention.summary} ` +
                    `Structured intervention: ` +
                    `${ctx.relSliceDir}/${INTERVENTION_FILENAME}. ` +
                    capIntervention.requiredOperatorAction,
                };
              })()
            :
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
      convergence: QAConvergenceState;
      dispatch: { action: "CONTINUE" };
      /**
       * Exact bytes of the accepted pair as the orchestrator's scope
       * amendment transaction left them, recorded as repo-relative path →
       * git blob ID immediately after the write. Present only when this
       * stage applied an amendment. The tree-authority guard admits those
       * paths only at exactly these blobs, and the stage itself re-verifies
       * them before returning, so a later evaluator edit to either
       * artifact invalidates the verdict (guardian round 4, architect A1).
       */
      amendedPairBlobs?: Readonly<Record<string, string>>;
    }
  | {
      outcome: "IMPLEMENTATION";
      report: string;
      history: readonly QAReviewLifecycleFinding[];
      unresolved: QAReviewAttemptFinding[];
      convergence: QAConvergenceState;
      dispatch: QAAttemptDispatch;
      /** See the PASS variant. */
      amendedPairBlobs?: Readonly<Record<string, string>>;
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
  /**
   * Git tree object ID captured for the candidate QA is about to review.
   * This is not a commit ID and must not be compared with HEAD.
   */
  candidateTreeId?: string;
}

/**
 * A PASS after a scope amendment is only valid over the exact pair bytes
 * the orchestrator's transaction wrote. The evaluator re-grade runs in the
 * mutable worktree, so re-hash both artifacts before honoring the verdict
 * and fail closed on any drift (guardian round 4, architect A1; ADR 0048:
 * agents never edit the locked file list).
 */
function assertAmendedPairIntact(
  ctx: SliceContext,
  amendedPairBlobs: Readonly<Record<string, string>> | undefined,
  stage: QAReviewStage,
  round: number,
): void {
  if (!amendedPairBlobs) return;
  const drifted = Object.entries(amendedPairBlobs).filter(
    ([path, blobId]) =>
      git.hashFileAsBlob(ctx.worktreeDir, path) !== blobId,
  );
  if (drifted.length > 0) {
    throw new Error(
      `${stage} PASS in round ${round} is not honored: the accepted pair ` +
        `changed after the orchestrator's scope amendment transaction ` +
        `(${drifted.map(([path]) => path).join(", ")}). Agents never edit ` +
        `the locked contract pair (ADR 0048); the verdict does not ` +
        `authorize these bytes.`,
    );
  }
}

/** Canonical filename of one slice's approved baseline, beside its change summary. */
export const APPROVED_BASELINE_FILENAME = "approved-baseline.json";

/**
 * What one deterministic PASS approved (#91 AC5, PRD D10).
 *
 * Written by the orchestrator and never by the evaluator: the evaluator's
 * writes are discarded outside two artifacts, and a baseline it authored would
 * be a verdict certifying itself. The artifact is canonical — run state only
 * records where it is — so a baseline survives a run-state rewrite.
 */
export interface ApprovedBaselineRecord {
  version: 1;
  ghIssue: string;
  sliceNumber: string;
  round: number;
  /** The candidate checkpoint tree the evaluator graded. */
  treeId: string;
  /** The checkpoint commit holding that tree. */
  commit: string;
  /**
   * Repo-relative path → git blob ID of the pair the verdict was taken
   * against, so a later stage can prove it is reading the same contract.
   */
  contractBlobs: Record<string, string>;
  /** Repo-relative gate evidence artifacts covering this exact tree. */
  gateEvidenceArtifactIds: string[];
}

/**
 * Write the approved baseline artifact, point run state at it, and journal it.
 * The order matters: the locator is recorded after the artifact exists, so it
 * never names a missing file.
 */
function writeApprovedBaseline(
  ctx: SliceContext,
  round: number,
  input: {
    treeId: string;
    commit: string;
    gateArtifacts: readonly GateEvidenceArtifact[];
  },
): ApprovedBaselineRecord {
  const { config, slice, logger } = ctx;
  const artifactDir = artifacts.negotiationArchiveDir(
    config.repoRoot,
    pipelineRunSlug(config.prdSlug, config.provider ?? kiroProvider),
    slice.number,
  );
  const record: ApprovedBaselineRecord = {
    version: 1,
    ghIssue: slice.ghIssue,
    sliceNumber: slice.number,
    round,
    treeId: input.treeId,
    commit: input.commit,
    contractBlobs: Object.fromEntries(
      REVIEW_SEED_ARTIFACTS.map((name) => [
        `${ctx.relSliceDir}/${name}`,
        git.hashFileAsBlob(ctx.worktreeDir, `${ctx.relSliceDir}/${name}`),
      ]),
    ),
    gateEvidenceArtifactIds: [
      ...new Set(
        input.gateArtifacts
          // Only evidence about this tree: an earlier attempt's gates
          // authorize a candidate this baseline is not.
          .filter((artifact) => artifact.treeId === input.treeId)
          .map((artifact) =>
            relative(config.repoRoot, artifact.evidencePath).replace(/\\/g, "/"),
          ),
      ),
    ].sort(),
  };
  mkdirSync(artifactDir, { recursive: true });
  const path = join(artifactDir, APPROVED_BASELINE_FILENAME);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, "utf-8");
  const artifactPath = relative(config.repoRoot, path).replace(/\\/g, "/");
  recordApprovedBaseline(config.repoRoot, config.prdSlug, slice.ghIssue, {
    treeId: record.treeId,
    commit: record.commit,
    artifactPath,
  });
  logger.event({
    type: "approved-baseline",
    ghIssue: slice.ghIssue,
    sliceNumber: slice.number,
    round,
    treeId: record.treeId,
    commit: record.commit,
    artifactId: artifactPath,
  });
  return record;
}

/**
 * Options both `runQAStage` and the attempt loop it wraps receive.
 */
interface QAStageOptions {
  candidateTreeId?: string;
  /**
   * The candidate checkpoint *commit* whose tree the pre-QA gates graded. The
   * deterministic review worktree is built from it, so the evaluator reads
   * exactly the tree the verdict will be tied to (#91 AC1, ADR 0012's
   * 2026-08-28 amendment).
   */
  candidateCommitSha?: string;
  position?: {
    implementationAttempt: number;
    implementationAttemptLimit: number;
    round: number;
    normalRoundLimit: number;
  };
}

/**
 * The disposable worktree one deterministic QA stage reads in (#91 AC1–AC3,
 * PRD D8/D9), and the four things that only make sense together: its
 * lifecycle, the per-attempt seeding of the inputs the evaluator must have,
 * the positive copy-back allowlist that is the only way bytes leave it, and
 * the scan that records what else the reviewer touched.
 *
 * The generator's worktree is never handed to the evaluator, so a reviewer
 * edit cannot become part of the tree its own verdict authorizes. Nothing
 * enforces that by asking the evaluator nicely: the worktree is deleted when
 * the stage ends, and only allowlisted basenames in the slice directory are
 * copied out.
 */
interface ReviewIsolation {
  /** Working directory handed to the evaluator instead of `ctx.worktreeDir`. */
  cwd: string;
  /**
   * Seed one attempt's inputs and return the repo-relative paths written.
   *
   * Called per attempt, because an attempt is only reached after an
   * infrastructure retry or a scope amendment — and an amendment rewrites the
   * very pair being seeded, so a once-per-stage copy would grade the new
   * candidate against the old contract.
   *
   * The returned list is the attempt's *seed manifest*, distinct from the
   * copy-back allowlist and used for one purpose: keeping the orchestrator's
   * own writes out of the reviewer-write scan (#91 AC2).
   */
  seed(): string[];
  /**
   * Copy the allowlisted artifacts out of the review worktree's slice
   * directory into the generator worktree, so the rest of the pipeline reads
   * the verdict where it always did.
   */
  copyBack(): void;
  dispose(): Promise<void>;
}

/**
 * The two authority-bearing inputs the evaluator grades against. Seeded
 * rather than trusted from the checkpoint tree because a scope amendment
 * rewrites them mid-stage in the generator worktree only.
 */
const REVIEW_SEED_ARTIFACTS = ["contract.md", "acceptance-manifest.json"] as const;

function createReviewIsolation(
  ctx: SliceContext,
  round: number,
  commitSha: string,
): ReviewIsolation {
  const { config, slice, logger } = ctx;
  // The slice suffix stays last, matching every other AFK working directory:
  // a slice's identity is read off the tail of its path (`-s01`), so a review
  // worktree that buried it mid-name would read as "no slice" to anything
  // resolving a slice from a cwd.
  const label = `${config.prdSlug}-qa-review-r${round}-${randomUUID()}-s${slice.number}`;
  const dir = join(config.repoRoot, ".afk", "checkpoints", label);
  // A fresh UUID branch every stage: `git.createBranch` reuses an existing
  // branch name, which would silently pin the review worktree to a stale
  // round's commit.
  const branch = `afk/qa-review/${label}`;
  mkdirSync(dirname(dir), { recursive: true });
  git.createWorktree(ctx.worktreeDir, branch, dir, commitSha);
  git.assertWorktreeRegistered(ctx.worktreeDir, branch, dir);
  const sliceDir = join(dir, ctx.relSliceDir);
  const artifactNames = (): string[] =>
    existsSync(sliceDir)
      ? readdirSync(sliceDir, { withFileTypes: true })
          .filter(
            (entry) => entry.isFile() && QA_WINDOW_ARTIFACT_NAME.test(entry.name),
          )
          .map((entry) => entry.name)
      : [];
  return {
    cwd: dir,
    seed() {
      mkdirSync(sliceDir, { recursive: true });
      // Start each attempt with no review artifact in the worktree: the
      // checkpoint tree can carry a previous round's report, and copy-back
      // would then hand a stale verdict back as this attempt's.
      for (const name of artifactNames()) {
        rmSync(join(sliceDir, name), { force: true });
      }
      const seeded: string[] = [];
      for (const name of REVIEW_SEED_ARTIFACTS) {
        const source = join(ctx.absSliceDir, name);
        if (!existsSync(source)) continue;
        copyFileSync(source, join(sliceDir, name));
        // Recorded at write time, not derived afterwards: the manifest's job
        // is to prove which paths the orchestrator itself wrote.
        seeded.push(`${ctx.relSliceDir}/${name}`);
      }
      return seeded;
    },
    copyBack() {
      // A positive allowlist by basename over this one directory. Nested
      // paths never match (`readdirSync` files only), unmatched names are
      // left behind, and anything outside the slice directory is unreachable
      // from here — the worktree is about to be deleted, so "not copied" is
      // "discarded".
      for (const name of artifactNames()) {
        copyFileSync(join(sliceDir, name), join(ctx.absSliceDir, name));
      }
    },
    async dispose() {
      // No signal: a cancelled run still has to take its review worktree
      // with it, and `removeWorktreeOrWarn` warns rather than throws when
      // the tree survives, so cleanup cannot mask the cancellation.
      try {
        await git.removeWorktreeOrWarn(ctx.worktreeDir, dir, {
          label: "QA review worktree",
          warn: (message) => logger.phase(`${ctx.tag}: ${message}`, "error"),
        });
      } finally {
        git.deleteBranch(ctx.worktreeDir, branch);
      }
    },
  };
}

/**
 * The checkpoint commit the review worktree is built from. The pre-QA phase
 * hands its own; a direct caller that has none gets one captured the same way,
 * without materializing it — falling back to `ctx.worktreeDir` would quietly
 * undo the isolation instead of failing.
 */
function reviewCandidateCommit(
  ctx: SliceContext,
  options: QAStageOptions,
): string {
  if (options.candidateCommitSha) return options.candidateCommitSha;
  return createCandidateCheckpoint(
    ctx.worktreeDir,
    join(
      ctx.config.repoRoot,
      ".afk",
      "checkpoints",
      `qa-review-capture-${randomUUID()}`,
    ),
    { materialize: false },
  ).commitSha;
}

/**
 * Run one QA stage. The deterministic stage reads a disposable worktree at the
 * candidate checkpoint and is handed a git-generated change summary before the
 * evaluator is invoked (#91 AC1/AC7); shared-preview UAT keeps running in
 * `ctx.worktreeDir` against the live preview, with no review worktree and no
 * copy-back (PRD D8 non-goal).
 */
export async function runQAStage(
  ctx: SliceContext,
  round: number,
  stage: QAReviewStage,
  history: readonly QAReviewLifecycleFinding[],
  previousUnresolved: readonly QAReviewAttemptFinding[] = [],
  baseGate: QABaseGateEvidence | null = null,
  options: QAStageOptions = {},
): Promise<QAStageResult> {
  if (stage !== "deterministic") {
    return runQAStageAttempts(
      ctx,
      round,
      stage,
      history,
      previousUnresolved,
      baseGate,
      options,
      null,
      null,
    );
  }
  const commitSha = reviewCandidateCommit(ctx, options);
  const { path: changeSummaryPath } = writeCandidateChangeSummary({
    cwd: ctx.worktreeDir,
    artifactDir: artifacts.negotiationArchiveDir(
      ctx.config.repoRoot,
      pipelineRunSlug(
        ctx.config.prdSlug,
        ctx.config.provider ?? kiroProvider,
      ),
      ctx.slice.number,
    ),
    featureBaseRef: ctx.featBranch,
    candidateRef: commitSha,
  });
  const isolation = createReviewIsolation(ctx, round, commitSha);
  try {
    return await runQAStageAttempts(
      ctx,
      round,
      stage,
      history,
      previousUnresolved,
      baseGate,
      options,
      isolation,
      changeSummaryPath,
    );
  } finally {
    // Every exit path — PASS, IMPLEMENTATION, a thrown infrastructure
    // failure, cancellation — leaves no review worktree behind (#91 AC1).
    await isolation.dispose();
  }
}

async function runQAStageAttempts(
  ctx: SliceContext,
  round: number,
  stage: QAReviewStage,
  history: readonly QAReviewLifecycleFinding[],
  previousUnresolved: readonly QAReviewAttemptFinding[],
  baseGate: QABaseGateEvidence | null,
  options: QAStageOptions,
  isolation: ReviewIsolation | null,
  changeSummaryPath: string | null,
): Promise<QAStageResult> {
  const { config, slice, logger, invoke, featBranch } = ctx;
  const convergenceTarget = {
    repoRoot: config.repoRoot,
    prdSlug: config.prdSlug,
    ghIssue: slice.ghIssue,
    sliceDir: ctx.absSliceDir,
    runSlug: pipelineRunSlug(
      config.prdSlug,
      config.provider ?? kiroProvider,
    ),
  };
  const qaLifecycle = new QAAttemptLifecycle(convergenceTarget, stage);
  let convergenceState = qaLifecycle.convergence;
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
  /**
   * Exact accepted-pair bytes as the latest amendment transaction left
   * them (repo-relative path → git blob ID), recorded inside the
   * transaction so no other writer can interleave. `undefined` until an
   * amendment applies (guardian round 4, architect A1).
   */
  let amendedPairBlobs: Record<string, string> | undefined;
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
  const authorizeSkip = (attempt: number): BaseGateSkipAuthorization => {
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
    let reviewTreeId: string | null =
      attempt === 1 ? (baseGate.candidateTreeId ?? null) : null;
    if (reviewTreeId == null) {
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
    }
    return authorizeBaseGateSkip({ ...baseGate, reviewTreeId });
  };

  for (let attempt = 1; attempt <= attemptLimit(); attempt++) {
    const archiveName = stage === "deterministic"
      ? `qa-report-r${round}-a${attempt}.md`
      : `uat-report-r${round}-a${attempt}.md`;
    const archivePath = join(ctx.absSliceDir, archiveName);
    const skipAuthorization = authorizeSkip(attempt);
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
          }
        | { error: string };
    };
    type ValidAttemptEvidence = {
      review: QAReview;
      nextHistory: readonly QAReviewLifecycleFinding[];
      unresolved: QAReviewAttemptFinding[];
      reportArchived: boolean;
      archiveDisplayPath: string;
      recordedAttempt: RecordedQAAttempt;
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
      const { review } = evidence.reviewResult;
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
      const candidateTreeId =
        options.candidateTreeId ?? resolveCandidateTreeId(ctx.worktreeDir);
      const recordedAttempt = qaLifecycle.recordAttempt({
        review,
        attemptFindings: record.findings,
        candidateTreeId,
        restoredOpenFindings: currentUnresolved,
      });
      convergenceState = qaLifecycle.convergence;
      const nextHistory = recordedAttempt.history;
      const unresolved = recordedAttempt.unresolved;
      currentHistory = nextHistory;
      currentUnresolved = unresolved;
      return {
        review,
        nextHistory,
        unresolved,
        reportArchived: evidence.reportArchived,
        archiveDisplayPath,
        recordedAttempt,
      };
    };

    let failedAttemptEvidence: AttemptEvidence | null = null;
    /**
     * Copy the allowlisted artifacts back and record every other reviewer
     * write, once per attempt (#91 AC2/AC3/AC6).
     *
     * Runs in a `finally` around the invocation alone, so it happens before
     * `archiveAttemptEvidence` reads the slice directory on the success path
     * *and* on the failure path, and cannot replace the evaluator's error with
     * one of its own.
     */
    const collectReviewerWrites = (seeded: readonly string[]): void => {
      if (!isolation) return;
      try {
        collectReviewerWritesOrThrow(seeded);
      } catch (error) {
        // Never the failure the attempt reports: an unwritable copy-back
        // leaves no canonical artifact, and the attempt already fails closed
        // on that a few lines below. Swallowing here keeps the evaluator's own
        // error — or the missing-report error — as the cause an operator reads.
        const message = error instanceof Error ? error.message : String(error);
        logger.phase(
          `${ctx.tag}: ${stage} review round ${round} attempt ${attempt} ` +
            `could not collect the review worktree's artifacts: ${message}`,
          "error",
          {
            type: "warn",
            reason: "qa-review-archive-failed",
            ghIssue: slice.ghIssue,
            message,
          },
        );
      }
    };
    const collectReviewerWritesOrThrow = (seeded: readonly string[]): void => {
      if (!isolation) return;
      isolation.copyBack();
      for (const path of scanReviewWorktreeWrites({
        cwd: isolation.cwd,
        reviewArtifactDir: ctx.relSliceDir,
        copyBackAllowlist: QA_WINDOW_ARTIFACT_NAME,
        seededPaths: seeded,
      })) {
        // Non-fatal by construction: the write was already discarded by not
        // being copied back, so this is the record that it happened.
        logger.event({
          type: "reviewer-write-violation",
          ghIssue: slice.ghIssue,
          sliceNumber: slice.number,
          round,
          attempt,
          path,
        });
      }
    };
    const invokeEvaluator = async (): Promise<AttemptEvidence> => {
      rmSync(reportPath, { force: true });
      rmSync(reviewPath, { force: true });
      const seeded = isolation ? isolation.seed() : [];
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
          // No assembled envelope: the candidate-evaluator prompt redesign
          // is deferred, but completion telemetry still lands in
          // events.jsonl with full identity (plan §3 item 13; guardian
          // round 6).
          completionEvidence: {
            ghIssue: slice.ghIssue,
            sliceNumber: slice.number,
            round,
            attempt,
            role: stage === "deterministic" ? "evaluator-qa" : "evaluator-uat",
          },
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
            CHANGE_SUMMARY_PATH: changeSummaryPath
              ? relative(config.repoRoot, changeSummaryPath).replace(/\\/g, "/")
              : "not generated for this stage",
          }),
          // The disposable review worktree for deterministic QA (#91 AC1);
          // shared-preview UAT still runs where the preview was applied.
          cwd: isolation?.cwd ?? ctx.worktreeDir,
          logStream: evalLog,
          ...longCommandRoleBounds({
            idleTimeoutMs: commandTimeoutMs,
            idleWarningIntervalMs: heartbeatIntervalMs,
            maxDurationMs: config.maxAgentDurationMs,
          }),
        }).finally(() => {
          closeAgentLog(evalLog);
          // Before `archiveAttemptEvidence` on either path, and before the
          // attempt-level catch can retry: the artifacts have to be out of the
          // review worktree by the time anything reads the slice directory.
          collectReviewerWrites(seeded);
        });
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
            // Bind later authority boundaries to these exact bytes: the
            // blob IDs are recorded inside the transaction, immediately
            // after the orchestrator's own write, so an evaluator edit in
            // any later re-grade cannot masquerade as the amendment
            // (guardian round 4, architect A1).
            amendedPairBlobs = Object.fromEntries(
              ["contract.md", "acceptance-manifest.json"].map((name) => [
                `${ctx.relSliceDir}/${name}`,
                git.hashFileAsBlob(
                  ctx.worktreeDir,
                  `${ctx.relSliceDir}/${name}`,
                ),
              ]),
            );
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
      const resolved = qaLifecycle.resolveScopeAmendments(
        requests.map(({ findingId }) => findingId),
      );
      convergenceState = resolved.convergence;
      currentHistory = resolved.history;
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
      assertAmendedPairIntact(ctx, amendedPairBlobs, stage, round);
      return {
        outcome: "PASS",
        report: archiveDisplayPath,
        history: nextHistory,
        unresolved,
        convergence: convergenceState,
        dispatch: { action: "CONTINUE" },
        ...(amendedPairBlobs ? { amendedPairBlobs } : {}),
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
    const candidateTreeId =
      options.candidateTreeId ?? resolveCandidateTreeId(ctx.worktreeDir);
    const coordinated = qaLifecycle.completeImplementation({
      attempt: validAttempt.recordedAttempt,
      candidate: {
        branch: ctx.branch,
        treeId: candidateTreeId,
      },
      supportingEvidence: [
        validAttempt.archiveDisplayPath,
        ...validAttempt.unresolved.flatMap(
          (finding) => finding.artifactReferences,
        ),
      ],
      ...(options.candidateTreeId !== undefined && options.position
        ? { position: options.position }
        : {}),
    });
    convergenceState = coordinated.convergence;
    return {
      outcome: "IMPLEMENTATION",
      report: archiveDisplayPath,
      history: nextHistory,
      unresolved,
      convergence: convergenceState,
      dispatch: coordinated.dispatch,
      ...(amendedPairBlobs ? { amendedPairBlobs } : {}),
    };
  }

  throw new Error(`${stage} QA exhausted without a result`);
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
  let repairStage: QAReviewStage | null = null;
  let firstRound = 1;
  let retryNote = "";
  let generatorFailureSet: GeneratorFailureSet = {
    findings: [],
    gates: [],
  };
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
  const finishIntervention = (
    request: InterventionRequest,
  ): Extract<TerminalOutcome, { phase: "STUCK" }> => {
    const reference = `${ctx.relSliceDir}/${INTERVENTION_FILENAME}`;
    if (!stuckReferences.includes(reference)) stuckReferences.push(reference);
    logger.phase(
      `${ctx.tag}: non-progress intervention — ${request.summary} ` +
        `Action: ${request.requiredOperatorAction}`,
      "error",
    );
    return finishStuck(
      `${request.summary} Structured intervention: ${reference}. ` +
        request.requiredOperatorAction,
    );
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
  const exactStageLocation = {
    repoRoot: config.repoRoot,
    prdSlug: config.prdSlug,
    ghIssue: slice.ghIssue,
  };
  const convergenceTarget = {
    ...exactStageLocation,
    sliceDir: ctx.absSliceDir,
    runSlug: pipelineRunSlug(
      config.prdSlug,
      config.provider ?? kiroProvider,
    ),
  };
  let qaConvergence = loadQAConvergenceState(exactStageLocation);
  const candidateLifecycle = new AcceptedCandidateLifecycle({
    ...convergenceTarget,
    worktreeDir: ctx.worktreeDir,
    featureBranch: featBranch,
    branch: ctx.branch,
    sharedPreview: config.sharedPreview !== undefined,
    ...(config.migrationValidation !== undefined
      ? { migrationValidation: config.migrationValidation }
      : {}),
  });
  const dispatchAcceptedCandidate = (
    dispatch: ReturnType<AcceptedCandidateLifecycle["finalize"]>,
  ): Extract<TerminalOutcome, { phase: "PASS" | "STUCK" }> => {
    if (dispatch.action === "INTERVENE") {
      return finishIntervention(dispatch.request);
    }
    logger.phase(
      `${ctx.tag}: candidate evaluation and pending deterministic stage pass — committed`,
    );
    return { phase: "PASS" };
  };

  try {
    if (ctx.resume) {
      let currentCandidateTreeId: string | null = null;
      try {
        currentCandidateTreeId = resolveCandidateTreeId(ctx.worktreeDir);
      } catch {
        // The checkpoint decision reports the fail-closed reason below.
      }
      const exactStage = candidateLifecycle.inspectResume(
        currentCandidateTreeId,
        MAX_GENERATOR_ROUNDS + 1,
      );
      if (exactStage.action === "FINALIZE") {
        logger.phase(
          `${ctx.tag}: exact-stage resume — ${exactStage.checkpoint.completedStage} ` +
            `completed on tree ${exactStage.checkpoint.candidateTreeId}; running ` +
            `${exactStage.checkpoint.nextPendingStage} before any agent dispatch`,
          "error",
        );
        return dispatchAcceptedCandidate(
          candidateLifecycle.finalize(exactStage.checkpoint.candidateTreeId),
        );
      }
      logger.phase(
        `${ctx.tag}: exact-stage resume unavailable — ${exactStage.reason}; ` +
          `candidate preserved, falling back to normal re-evaluation`,
        "error",
      );
    } else {
      candidateLifecycle.resetCheckpoint();
    }

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
      generatorFailureSet = {
        findings: resumedUnresolved.map((finding) => ({
          id: finding.id,
          clearCondition: finding.clearCondition,
          artifactReferences: finding.artifactReferences,
        })),
        gates: [],
      };
      repairStage = restored.retryStage;
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
    const attemptPlan = candidateLifecycle.planImplementationAttempts({
      firstRound,
      normalRoundLimit: MAX_GENERATOR_ROUNDS,
      ...(ctx.resume?.mode ? { resumeMode: ctx.resume.mode } : {}),
    });
    let implementationAttemptLimit = attemptPlan.attemptLimit;
    let finalRound = attemptPlan.finalRound;
    const implementationCandidateTreeIds: string[] = [];

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
      // Proof, not assumption, that the accepted `contract.md` /
      // `acceptance-manifest.json` pair still holds the orchestrator's bytes —
      // the attestation `outOfScopeChangedPaths` refuses to default
      // (`src/escalation.ts`). Latched true only after the integrity check
      // below passed for *this* generator attempt, and reset to false at the
      // top of every attempt: a reordering that skips the check leaves it
      // false, and the scope gate then names both pair files and fails closed
      // rather than exempting a lock the generator may have widened.
      let acceptedPairIntact = false;
      while (true) {
        generatorAttempt++;
        acceptedPairIntact = false;
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
        const contract = readFileSync(
          join(ctx.absSliceDir, "contract.md"),
          "utf-8",
        );
        const acceptanceManifest = loadAcceptanceManifest(ctx.absSliceDir);
        if (acceptanceManifest.version !== 2) {
          throw new Error(
            "Generator envelope requires an acceptance manifest with behavior bindings",
          );
        }
        const contextPath = join(ctx.absSliceDir, "context.md");
        const hasExplorerContext = existsSync(contextPath);
        const context = hasExplorerContext
          ? readFileSync(contextPath, "utf-8")
          : "(no explorer context artifact is available for this legacy direct-execution path)";
        const mode =
          implementationAttempt === 1 &&
          !ctx.resume &&
          generatorAttempt === 1
            ? "initial"
            : "repair";
        const worktreeState =
          ctx.resume?.mode === "stuck"
            ? "**Your worktree was not touched.** Nothing was reset, cleaned, or dropped. Every committed change and uncommitted edit remains exactly where the previous attempt left it. Treat dirty-tree state as real work-in-progress."
            : "Your worktree was reset to your last commit. Uncommitted changes were discarded; anything after your last commit is gone and must be redone.";
        const baseRefreshNote =
          ctx.resume?.mode === "stuck"
            ? ctx.resume.baseRefreshed
              ? `The feature branch \`${featBranch}\` was merged into your branch just before this run, so your verification world is current.`
              : `The feature branch \`${featBranch}\` could **not** be merged into your branch cleanly, and your tree was preserved rather than rebuilt. Your verification world may be behind the feature branch — do not assume sibling work is visible here.`
            : `The feature branch \`${featBranch}\` was merged into your branch just before this run. Your verification world is current: work merged by sibling slices while you were away is now part of your tree.`;
        const repairSituation =
          mode === "repair"
            ? [
                `Implementation round: ${round} of ${finalRound}.`,
                `Generator dispatch in this round: ${generatorAttempt}.`,
                ...(ctx.resume
                  ? [
                      `Resume mode: ${ctx.resume.mode}.`,
                      `Commits ahead of base: ${ctx.resume.commitsAhead}.`,
                      "# Commit log",
                      ctx.resume.commitLog || "(none)",
                      "# Worktree state",
                      worktreeState,
                      "# Base refresh",
                      baseRefreshNote,
                      ...(ctx.resume.mode === "stuck" && ctx.resume.stuckNote
                        ? ["# Preserved STUCK evidence", ctx.resume.stuckNote]
                        : []),
                      ...(ctx.resume.handoffNote
                        ? ["# Prior handoff", ctx.resume.handoffNote]
                        : []),
                    ]
                  : []),
                ...(retryNote ? [retryNote] : []),
                ...(scopeRevisionNote ? [scopeRevisionNote] : []),
              ].join("\n\n")
            : undefined;
        const assembled = assembleGeneratorEnvelope({
          mode,
          sliceDir: ctx.relSliceDir,
          contractView: projectGeneratorContractView(contract),
          acceptanceManifest,
          patternsAndHarness: projectGeneratorPatternsAndHarness(context),
          ...(!hasExplorerContext
            ? { patternsAndHarnessArtifactId: null }
            : {}),
          testCommand: ctx.testCommand,
          migrationReservation: migrationReservationBlock(
            config,
            slice.ghIssue,
          ),
          failureSet: generatorFailureSet,
          additionalArtifactIds: [
            ...(ctx.resume?.mode === "stuck" && ctx.resume.stuckNote
              ? [`${ctx.relSliceDir}/stuck.md`]
              : []),
            ...(ctx.resume?.handoffNote
              ? [`${ctx.relSliceDir}/handoff.md`]
              : []),
          ],
          ...(config.generatorInlineSizeBudgetBytes !== undefined
            ? {
                inlineSizeBudgetBytes:
                  config.generatorInlineSizeBudgetBytes,
              }
            : {}),
          ...(repairSituation !== undefined ? { repairSituation } : {}),
        });
        rmSync(escalationPath, { force: true });
        // The accepted pair's bytes, captured before the generator can
        // touch them (architect A1, seventh gate round). Re-captured every
        // iteration of this loop, because an accepted focused revision
        // legitimately replaces the pair and the next dispatch must be
        // measured against the *new* accepted bytes, not the round's first
        // ones.
        const acceptedPair = captureAcceptedContractPair(ctx.absSliceDir);
        // The resume attempt is spent here and nowhere earlier (#188 defect 4).
        // Written *before* the call, not after it returns: a poisoned tree's
        // whole symptom is that the generator never returns, so charging on
        // the way out would leave the cap unable to see the case it exists
        // for. The residual window — a kill between this write and the process
        // actually starting — over-charges by one, which is both far narrower
        // than the old window (all of negotiation) and the safe direction to
        // err in. Latched, so the rounds of this loop cost one attempt.
        ctx.chargeResume?.();
        await invoke({
          role: "generator",
          prompt: assembled.prompt,
          contextEnvelope: {
            ghIssue: slice.ghIssue,
            sliceNumber: slice.number,
            round,
            ...assembled.evidence,
          },
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

        // --- The generator does not get to write its own lock (architect
        // A1, seventh gate round). ADR 0055 Seam 1 §3 makes the shared
        // contract transaction the only mutation path for the accepted
        // `contract.md` / `acceptance-manifest.json` pair and ADR 0048
        // assigns scope mutation to the orchestrator; nothing enforced it
        // across a generator dispatch. A generator could add an undeclared
        // source path to *both* files and then escalate for some unrelated
        // path: the manifest read below became `lockedManifest`, the
        // changed-set guard exempted everything under the slice directory,
        // and `runFocusedScopeRevision` captured the generator's bytes as
        // "the previously accepted pair" — so its additive guard preserved
        // the smuggled path instead of catching it. The fresh generator
        // then received a lock it had widened itself.
        //
        // Placed here, before `existsSync(escalationPath)`, on purpose: the
        // pair is protected across *every* generator invocation, not only
        // the escalating ones, and the refusal lands before escalation
        // parsing, the focused revision's planner and evaluator, the
        // migration claim gate, the base gates and QA. Refuses by throw
        // like the two revision bounds below it: ERROR, and the operator
        // gets the tree.
        //
        // Evidence first, then restore. The restore is what makes the
        // refusal safe — the next dispatch, a resume, or a hand-declared
        // scope all read the orchestrator's bytes and not the generator's —
        // but it also erases the incident, so the attempted bytes are
        // archived beside the round's other evidence before they go.
        const mutatedOwned = mutatedAcceptedContractFiles(
          ctx.absSliceDir,
          acceptedPair,
        );
        if (mutatedOwned.length > 0) {
          // For the record only (#258): the refusal below is the outcome, and
          // an archive that cannot be written must not replace it with a
          // filesystem error naming a different problem.
          const archived =
            archiveForTheRecord(
              ctx,
              `the rejected contract mutation of round ${round} attempt ` +
                `${generatorAttempt}`,
              reviewArchiveDir,
              () =>
                artifacts.archiveRejectedContractMutation({
                  sliceDir: ctx.absSliceDir,
                  archiveDir: reviewArchiveDir,
                  round,
                  attempt: generatorAttempt,
                  files: mutatedOwned,
                  runId: runIdFor(logger.runDir),
                }),
            ) ?? [];
          restoreAcceptedContractPair(ctx.absSliceDir, acceptedPair);
          throw new Error(
            `Generator round ${round} attempt ${generatorAttempt} changed ` +
              `orchestrator-owned contract file(s) ` +
              `(${mutatedOwned.join(", ")}). The accepted contract.md and ` +
              `${ACCEPTANCE_MANIFEST_FILENAME} pair is mutated only by the ` +
              `orchestrator's contract transaction (ADR 0055 Seam 1, ` +
              `ADR 0048) — a generator that rewrites its own lock has ` +
              `widened its own file scope, so no escalation, revision, gate ` +
              `or QA runs on this tree. The accepted bytes were restored` +
              (archived.length > 0
                ? `; the attempted bytes are preserved as ` +
                  `${archived.join(", ")} in ${reviewArchiveDir}`
                : ``) +
              `. Review them, then either declare the path(s) in the ` +
              `contract by hand or resume the slice.`,
          );
        }
        // Reached only because the check above found no mutation, so the pair
        // on disk is byte-for-byte the accepted pair. This is the one place
        // the attestation is earned.
        acceptedPairIntact = true;

        if (!existsSync(escalationPath)) break;

        // #258, and the write that killed #96: the archive dir is keyed by
        // slice while this name is keyed by round and attempt, so a resumed
        // slice whose prior life died before QA re-derives round 1 and asks
        // for a name the prior run already wrote. The prior file is kept —
        // it is the only record of the earlier escalation — and this run's
        // copy spills into its own subdirectory instead, so neither run's
        // evidence is lost. And if even the spill fails, the seam warns: the
        // escalation the loop is about to act on is still on disk in the
        // slice dir, and the grant that follows is unaffected either way.
        archiveForTheRecord(
          ctx,
          `the scope escalation of round ${round} attempt ${generatorAttempt}`,
          reviewArchiveDir,
          () =>
            artifacts.archiveScopeEscalationAttempt({
              sliceDir: ctx.absSliceDir,
              archiveDir: reviewArchiveDir,
              round,
              attempt: generatorAttempt,
              runId: runIdFor(logger.runDir),
            }),
        );
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
          // Proven above, not assumed: the integrity check threw unless
          // both files still hold the bytes captured before dispatch. Both
          // files show up in this changed set on every honest escalation
          // too — they are written into the worktree during negotiation —
          // so the guard needs the attestation to tell the honest tree from
          // the laundered one.
          acceptedPairIntact: true,
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
        // A REJECTED revision is not terminal while the round still holds a
        // grant (#257). The rejecting findings ride the next attempt's
        // planner prompt, so a revision blocked on a precise clear condition
        // can converge here — the carry-forward property ADR 0061 gave the
        // normal negotiation loop, which this focused path was built as an
        // optimization of and had lost.
        //
        // A rejection-driven retry is charged a *revision grant*, never a
        // resume attempt: the grant is the round's own budget, and the run
        // must not pay a resume for the pipeline failing to pass feedback
        // along. So the count below is of revision *attempts*, not of
        // accepted revisions — two distinct discoveries still spend the two
        // grants and a third is still refused, and a rejection plus its retry
        // spends them the same way.
        let rejectionFindings: readonly ContractReviewFinding[] = [];
        let revisedManifest: AcceptanceManifest | null = null;
        while (revisedManifest === null) {
          const revision = await runFocusedScopeRevision(
            ctx,
            escalation,
            rejectionFindings,
          );
          scopeRevisions++;
          if (revision.phase === "ERROR") return revision;
          if (revision.phase === "REJECTED") {
            if (scopeRevisions >= MAX_SCOPE_REVISIONS_PER_ROUND) {
              return {
                phase: "ERROR",
                error:
                  `Focused scope revision was not accepted, and round ` +
                  `${round} has spent its ` +
                  `${MAX_SCOPE_REVISIONS_PER_ROUND} revision(s): ` +
                  formatContractReviewFindings(revision.findings),
              };
            }
            rejectionFindings = revision.findings;
            logger.phase(
              `${ctx.tag}: focused scope revision REJECTED; retrying with ` +
                `the rejecting finding(s) ` +
                `(revision ${scopeRevisions + 1}/` +
                `${MAX_SCOPE_REVISIONS_PER_ROUND} of round ${round})...`,
              "error",
            );
            continue;
          }
          revisedManifest = revision.manifest;
        }
        scopeRevisionNote =
          "# Focused scope revision accepted\n\n" +
          "The contract was revised and re-locked without spending this " +
          "implementation round. Continue under this complete accepted " +
          "file scope:\n\n" +
          JSON.stringify({ fileScope: revisedManifest.fileScope }, null, 2);
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
      // Automatic related-suite selection is PRD 4 scope (#86). PRD 3 keeps
      // the ADR 0012 amendment sequence: cheap typecheck/lint, then candidate
      // QA, then the full slice suite (architect A1).
      /**
       * Per-behavior records the acceptance gate pushes as each filtered run
       * settles, drained in `onGateOutcome` below. A buffer and not a callback
       * straight into the journal because the artifact ids the event carries
       * only exist once the attempt is written — and because
       * `src/candidate-gate-phase.ts` must stay unedited (D22), so it cannot
       * learn about this gate.
       */
      const acceptanceCoverage: BehaviorCoverageRecord[] = [];
      // Undefined unless the locked manifest binds at least one behavior, which
      // is what keeps every project that never opted in on today's path.
      const acceptanceDeclaration = acceptanceGateDeclaration({
        absSliceDir: ctx.absSliceDir,
        plan: resolveAcceptancePlan(ctx.worktreeDir),
        bounds: {
          inactivityTimeoutMs:
            config.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
          heartbeatIntervalMs:
            config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
          wallClockTimeoutMs: DEFAULT_BASE_GATE_WALL_CLOCK_TIMEOUT_MS,
        },
        onBehaviorResult: (record) => acceptanceCoverage.push(record),
      });
      const preQaDeclarations = [
        ...resolvePreQAGateDeclarations(ctx.worktreeDir),
        // Pre-QA, not post-QA: an untested behavior must go back to the
        // generator instead of costing an evaluator read (#85 AC1, D19).
        ...(acceptanceDeclaration ? [acceptanceDeclaration] : []),
      ];
      const fullSuiteDeclarations =
        resolveFullSuiteGateDeclarations(ctx.worktreeDir);
      // Both predicates widen on *bound work*, never on plan presence: the
      // acceptance gate spawns the project's runner inside `gateCwd`, so it
      // needs the materialized checkpoint and the `prepare` install exactly
      // when it is going to run. A resolved plan with nothing bound to it must
      // still leave a scriptless project paying neither.
      const preQaHasExecutable =
        acceptanceDeclaration != null ||
        preQaDeclarations.some((declaration) => declaration.command != null);
      const checkpoint =
        acceptanceDeclaration != null ||
        [...preQaDeclarations, ...fullSuiteDeclarations].some(
          (declaration) => declaration.command != null,
        )
          ? createCandidateCheckpoint(ctx.worktreeDir, checkpointDir)
          : createCandidateCheckpoint(ctx.worktreeDir, checkpointDir, {
              materialize: false,
            });
      implementationCandidateTreeIds.push(checkpoint.treeId);
      const gateCwd = checkpoint.worktreeDir ?? checkpointDir;
      const evidenceDir = join(logger.runDir, "gates", `s${slice.number}`);
      // One read of the test-cost policy for this round, shared by the gate
      // cache and the skip gate below (#86 B-01: `resolveTestCostPlan` is the
      // only production reader of `gatePolicy.cost`).
      const costPlan = resolveTestCostPlan(ctx.worktreeDir);
      /**
       * The human-authored protected-change waivers, read once at launch from
       * the PRD directory's `afk.json` (#193 D5). Deliberately taken from the
       * launch manifest and not re-read from `ctx.worktreeDir`: a waiver a
       * candidate wrote for itself is not an authorization, and re-reading here
       * is exactly how it would become one.
       */
      const launchWaivers = config.manifest?.protectedChangeWaivers ?? [];
      // Per-run, under this run's own artifact directory: reuse is scoped to a
      // run's attempts, never shared across runs (#86 B-03).
      const gateCache = {
        path: join(
          config.repoRoot,
          ".afk",
          "artifacts",
          pipelineRunSlug(config.prdSlug, config.provider ?? kiroProvider),
          "gate-cache.json",
        ),
        enabled: costPlan.cacheEnabled,
      };
      try {
        const preQaGateRun = await runCandidateGatePhase({
          repoRoot: config.repoRoot,
          ghIssue: slice.ghIssue,
          sliceNumber: slice.number,
          tag: ctx.tag,
          round,
          treeId: checkpoint.treeId,
          cwd: gateCwd,
          evidenceDir,
          declarations: preQaDeclarations,
          ...(gatePrepare && preQaHasExecutable
              ? { prepare: gatePrepare }
              : {}),
          cache: gateCache,
          label: "pre-QA gates",
          signal,
          infrastructureRetries:
            config.infrastructureRetries ?? DEFAULT_INFRASTRUCTURE_RETRIES,
          inactivityTimeoutMs:
            config.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
          wallClockTimeoutMs: DEFAULT_BASE_GATE_WALL_CLOCK_TIMEOUT_MS,
          heartbeatIntervalMs:
            config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
          onGateOutcome: (outcome) => {
            logger.event({
              type: "gate-outcome",
              ghIssue: slice.ghIssue,
              sliceNumber: slice.number,
              round,
              ...outcome,
            });
            if (outcome.gateId !== ACCEPTANCE_GATE_ID) return;
            // Drained, not copied: an infrastructure retry runs the gate
            // again, and each attempt's records belong to that attempt's tree
            // and artifacts.
            for (const record of acceptanceCoverage.splice(0)) {
              logger.event({
                type: "behavior-coverage",
                ghIssue: slice.ghIssue,
                sliceNumber: slice.number,
                round,
                attemptId: outcome.attemptId,
                behaviorId: record.behaviorId,
                gateId: outcome.gateId,
                status: record.status,
                matched: record.matched,
                passed: record.passed,
                failed: record.failed,
                treeId: outcome.treeId,
                evidenceArtifactId: outcome.evidenceArtifactId,
                logArtifactId: outcome.logArtifactId,
              });
            }
          },
          onInfrastructureRetry: (message) => {
            logger.phase(message, "error", {
              type: "warn",
              reason: "infrastructure-retry",
              ghIssue: slice.ghIssue,
              message,
            });
          },
        });
        gateArtifacts.push(...preQaGateRun.artifacts);
        const gateEvidence = preQaGateRun.evidence;
        const gateEvidencePath = preQaGateRun.evidencePath;
        if (signal?.aborted) {
          return { phase: "CANCELLED", error: CANCELLED_BY_USER };
        }
        const evidenceDisplayPath = gateEvidencePath.replace(/\\/g, "/");
        const requiredPreQaIds = new Set(
          preQaDeclarations
            .filter((declaration) => declaration.required)
            .map((declaration) => declaration.id),
        );
        const requiredInfrastructure = gateEvidence.results.filter(
          (gate) =>
            requiredPreQaIds.has(gate.gateId) &&
            gate.status === "INFRASTRUCTURE",
        );
        if (requiredInfrastructure.length > 0) {
          return {
            phase: "ERROR",
            error: `Pre-QA gate infrastructure failed: ${requiredInfrastructure.map((gate) => gate.gateId).join(", ")} (${evidenceDisplayPath})`,
          };
        }
        const requiredFailures = collectRequiredGateFailures(
          preQaGateRun.attempts,
          preQaDeclarations,
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
        generatorFailureSet = {
          findings: generatorFailureSet.findings,
          gates: requiredFailures.map(({ evidencePath, result }) => ({
            id: result.gateId,
            evidence: [
              evidencePath.replace(/\\/g, "/"),
              join(evidenceDir, result.logArtifactId).replace(/\\/g, "/"),
            ],
          })),
        };
        // The retry note is control-plane text only; failure content —
        // failed gate IDs, evidence, and any still-open finding's ID,
        // clear condition, and references — travels exclusively in the
        // compact failure set the envelope renders as the single final
        // failure block (guardian round 2, PM 2).
        retryNote =
          `This is implementation round ${round + 1}. Base gates failed on ` +
          `the current candidate. Fix every entry in the current failure ` +
          `set at the end of this prompt without regressing behavior that ` +
          `already passes.`;
        if (implementationAttempt < implementationAttemptLimit) continue;
        logger.bumpEvalRound(slice.ghIssue, round);
        return finishIntervention(
          candidateLifecycle.exhaustDeterministicGates({
            candidateTreeId: checkpoint.treeId,
            revision: Math.max(qaConvergence.revision, round),
            failedGateIds: requiredFailures.map(({ result }) => result.gateId),
            attemptTreeIds: implementationCandidateTreeIds,
            supportingEvidence: baseGateRepairReferences,
          }).request,
        );
      } else {
        assertGateEvidenceReleasesEvaluation(
          gateEvidence,
          preQaDeclarations,
          checkpoint.treeId,
        );
        for (const artifact of gateArtifacts) verifyGateEvidence(artifact);
        // The gates just passed on this tree; hand QA the evidence so it can
        // be authorized to cite them rather than run them again (ADR 0012,
        // 2026-08-28). The first attempt uses the captured Git tree object ID
        // directly; later attempts re-hash and fail closed after any mutation.
        const qaBaseGate: QABaseGateEvidence = {
          evidence: gateEvidence,
          evidenceArtifactId: relative(
            config.repoRoot,
            gateEvidencePath,
          ).replace(/\\/g, "/"),
          declarations: preQaDeclarations,
          candidateTreeId: checkpoint.treeId,
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
          {
            candidateTreeId: checkpoint.treeId,
            candidateCommitSha: checkpoint.commitSha,
            position: {
              implementationAttempt,
              implementationAttemptLimit,
              round,
              normalRoundLimit: MAX_GENERATOR_ROUNDS,
            },
          },
        );
        deterministicHistory = deterministic.history;
        deterministicUnresolved = deterministic.unresolved;
        qaConvergence = deterministic.convergence;
        logger.event({
          type: "phase-ended",
          ghIssue: slice.ghIssue,
          sliceNumber: slice.number,
          agent: "evaluator-qa",
          round,
          verdict: deterministic.outcome,
        });
        if (deterministic.outcome === "PASS") {
          // The orchestrator establishes the baseline, not the evaluator
          // (#91 AC5): the tree the gates and the verdict both covered, plus
          // the bytes of the contract it was graded against.
          writeApprovedBaseline(ctx, round, {
            treeId: checkpoint.treeId,
            commit: checkpoint.commitSha,
            gateArtifacts,
          });
        }
        let implementationFailed =
          deterministic.outcome === "IMPLEMENTATION";
        stuckReferences.push(deterministic.report);
        // An applied scope amendment is the one orchestrator-owned write
        // that legitimately changes the accepted pair inside the QA
        // window; carry its exact bytes to the tree-authority guard
        // (architect A1, rounds 3–4).
        let amendedPairBlobsThisAttempt = deterministic.amendedPairBlobs;
        if (deterministic.dispatch.action === "INTERVENE") {
          logger.bumpEvalRound(slice.ghIssue, round);
          return finishIntervention(deterministic.dispatch.request);
        }
        let qaDispatch = deterministic.dispatch;
        if (implementationFailed) {
          generatorFailureSet = {
            findings: deterministic.unresolved.map((finding) => ({
              id: finding.id,
              clearCondition: finding.clearCondition,
              artifactReferences: finding.artifactReferences,
            })),
            gates: [],
          };
          repairStage = "deterministic";
          // Control-plane text only; the open findings' IDs, clear
          // conditions, and references ride solely in the compact failure
          // set above, rendered last in the prompt (guardian round 2, PM 2).
          retryNote =
            `This is implementation round ${round + 1}. Candidate QA left ` +
            `open findings. Repair every finding in the current failure ` +
            `set at the end of this prompt without regressing behavior ` +
            `that already passes.`;
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
            null,
            {
              candidateTreeId: checkpoint.treeId,
              position: {
                implementationAttempt,
                implementationAttemptLimit,
                round,
                normalRoundLimit: MAX_GENERATOR_ROUNDS,
              },
            },
          );
          sharedPreviewHistory = remote.history;
          sharedPreviewUnresolved = remote.unresolved;
          qaConvergence = remote.convergence;
          logger.event({
            type: "phase-ended",
            ghIssue: slice.ghIssue,
            sliceNumber: slice.number,
            agent: "evaluator-uat",
            round,
            verdict: remote.outcome,
          });
          stuckReferences.push(remote.report);
          amendedPairBlobsThisAttempt = remote.amendedPairBlobs
            ? {
                ...(amendedPairBlobsThisAttempt ?? {}),
                ...remote.amendedPairBlobs,
              }
            : amendedPairBlobsThisAttempt;
          if (remote.dispatch.action === "INTERVENE") {
            logger.bumpEvalRound(slice.ghIssue, round);
            return finishIntervention(remote.dispatch.request);
          }
          if (remote.outcome === "IMPLEMENTATION") {
            implementationFailed = true;
            generatorFailureSet = {
              findings: remote.unresolved.map((finding) => ({
                id: finding.id,
                clearCondition: finding.clearCondition,
                artifactReferences: finding.artifactReferences,
              })),
              gates: [],
            };
            repairStage = "shared-preview";
            qaDispatch = remote.dispatch;
            retryNote =
              `This is implementation round ${round + 1}. Repair the current ` +
              `shared-preview QA findings using the compact current failure ` +
              `set below. Preserve deterministic behavior that already passed.`;
          }
        }

        logger.bumpEvalRound(slice.ghIssue, round);
        if (!implementationFailed) {
          if (signal?.aborted) {
            return { phase: "CANCELLED", error: CANCELLED_BY_USER };
          }
          // The file-scope gate goes first, and this is its only declaration
          // site (ADR 0048; #195 AC1, AC6). Prepended rather than appended for
          // two reasons: a deterministic comparison that needs no toolchain
          // must not sit behind the ~7-minute suite, and it must not be
          // skippable by an earlier declaration's INFRASTRUCTURE or
          // checkpoint `break`. A red `scope` does not short-circuit the rest
          // — `runGates` continues past FAIL — so the suite still runs and
          // `decideCandidateGatePhase` returns REPAIR naming `scope`, which
          // becomes the next generator round instead of a merge. The candidate
          // still reaches the evaluator, which ADR 0048's amendment warrant
          // requires; what it does not reach is the feature branch.
          const postQaDeclarations = [
            scopeGateDeclaration({
              source: {
                kind: "candidate",
                // The live worktree, not the checkpoint directory: only it
                // carries the working-tree and untracked changes, and the
                // candidate is not committed until after these gates pass.
                worktreeDir: ctx.worktreeDir,
                featureRef: featBranch,
              },
              absSliceDir: ctx.absSliceDir,
              sliceArtifactDir: ctx.relSliceDir,
              acceptedPairIntact,
              options: { migrationPathPattern: config.migrationPathPattern },
            }),
            // Between the file-scope gate and the suite (#86 B-06): a candidate
            // that went green by disabling a test is caught by comparison, not
            // by running anything, so it must not sit behind the ~7-minute
            // suite — and unlike the suite it cannot be made green by a
            // toolchain that is missing.
            skipGateDeclaration({
              worktreeDir: ctx.worktreeDir,
              featureRef: featBranch,
              detectors: costPlan.skipDetectors,
              testFileGlobs: costPlan.testFileGlobs,
              // Launch authorization, never candidate authorization (#193 D5).
              waivers: launchWaivers,
            }),
            // Beside the skip gate and for the same reasons (#193 D22): the
            // verdict is a comparison of the candidate against the feature
            // branch, so it needs no toolchain and must not sit behind the
            // suite. `acceptedPairIntact` is the value the orchestrator's own
            // pre-dispatch integrity check already produced — never a fresh
            // check here, which would read the bytes the candidate left.
            feedbackIntegrityGateDeclaration({
              worktreeDir: ctx.worktreeDir,
              featureRef: featBranch,
              waivers: launchWaivers,
              // The run's policy, never a `loadGatePolicy` read of the
              // candidate's own worktree (#251, and a test in
              // `src/feedback-integrity-gate.test.ts` pins that this line does
              // not become one): the generator owns that tree for the whole
              // round, so a rulebook read from it is a rulebook the candidate
              // can author — it could strike `gate-policy` from `riskClasses`
              // and walk past this gate. The candidate's copy is still
              // inspected, as evidence, inside the gate.
              runPolicy: ctx.runGatePolicy,
              acceptedPairIntact,
            }),
            ...fullSuiteDeclarations,
          ];
          const postQaGates = await runPostQAGates({
            repoRoot: config.repoRoot,
            worktreeDir: ctx.worktreeDir,
            prdSlug: config.prdSlug,
            ghIssue: slice.ghIssue,
            sliceNumber: slice.number,
            tag: ctx.tag,
            round,
            evidenceDir,
            declarations: postQaDeclarations,
            ...(gatePrepare ? { prepare: gatePrepare } : {}),
            cache: gateCache,
            signal,
            infrastructureRetries:
              config.infrastructureRetries ?? DEFAULT_INFRASTRUCTURE_RETRIES,
            inactivityTimeoutMs:
              config.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
            wallClockTimeoutMs: DEFAULT_BASE_GATE_WALL_CLOCK_TIMEOUT_MS,
            heartbeatIntervalMs:
              config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
            priorAttemptTreeIds: implementationCandidateTreeIds,
            priorArtifacts: gateArtifacts,
            // The QA verdict is tied to this exact captured tree; the full
            // suite may only run on a tree that differs from it by the
            // exact expected QA-window artifacts, plus the accepted pair
            // at exactly the bytes an audited scope amendment wrote
            // (architect A1, ADR 0012).
            qaApprovedTreeId: checkpoint.treeId,
            reviewArtifactDir: ctx.relSliceDir,
            ...(amendedPairBlobsThisAttempt
              ? {
                  orchestratorAuthorizedBlobs: amendedPairBlobsThisAttempt,
                }
              : {}),
            onGateOutcome: (outcome) => {
              logger.event({
                type: "gate-outcome",
                ghIssue: slice.ghIssue,
                sliceNumber: slice.number,
                round,
                ...outcome,
              });
            },
            onInfrastructureRetry: (message) => {
              logger.phase(message, "error", {
                type: "warn",
                reason: "infrastructure-retry",
                ghIssue: slice.ghIssue,
                message,
              });
            },
            onCleanupWarning: (message) =>
              logger.phase(`${ctx.tag}: ${message}`),
          });
          gateArtifacts.push(...postQaGates.artifacts);
          /**
           * Record the human authorizations this gate phase actually spent
           * (#193 D23), before any of the branches below can return: an applied
           * waiver is a fact about what ran, and it is the same fact whether the
           * phase ends in a merge, a repair or an error. The evidence artifact
           * is the source — a gate reports its applied waivers in
           * `findings.appliedWaivers`, and reading them back means the record
           * and the audit trail cannot disagree.
           */
          for (const artifact of postQaGates.artifacts) {
            let applied: ReturnType<typeof appliedWaiversFrom> = [];
            try {
              applied = appliedWaiversFrom(
                readGateEvidence(artifact.evidencePath),
              );
            } catch {
              // Unreadable evidence is the gate phase's own failure to report,
              // not a reason to abandon a round that otherwise succeeded; the
              // verified-evidence checks own that refusal.
              continue;
            }
            for (const waiver of applied) {
              logger.event({
                type: "waiver-applied",
                ghIssue: slice.ghIssue,
                sliceNumber: slice.number,
                round,
                riskClass: waiver.riskClass,
                path: waiver.path,
                author: waiver.author,
                reason: waiver.reason,
              });
            }
            // The run's own state file, keyed by the provider-suffixed run
            // slug every other writer uses — the bare PRD slug would create a
            // second state file no reader ever opens.
            saveAppliedWaivers(
              config.repoRoot,
              pipelineRunSlug(config.prdSlug, config.provider ?? kiroProvider),
              slice.ghIssue,
              applied,
            );
          }
          if (postQaGates.action === "CANCELLED") {
            return { phase: "CANCELLED", error: CANCELLED_BY_USER };
          }
          if (postQaGates.action === "ERROR") {
            return { phase: "ERROR", error: postQaGates.error };
          }
          if (postQaGates.action === "REPAIR") {
            stuckReferences.push(...postQaGates.references);
            // QA passed this candidate before the full suite ran, so the
            // finding set is resolved by construction. Replace the failure
            // set with the gates-only projection instead of carrying the
            // previous round's now-resolved findings into the next repair
            // envelope (architect A2, PM P-02).
            generatorFailureSet = postQaGates.failureSet;
            retryNote = postQaGates.retryNote;
            if (implementationAttempt < implementationAttemptLimit) continue;
            return finishIntervention(
              candidateLifecycle.exhaustDeterministicGates({
                candidateTreeId: postQaGates.candidateTreeId,
                revision: Math.max(qaConvergence.revision, round),
                failedGateIds: postQaGates.failedGateIds,
                attemptTreeIds: postQaGates.attemptTreeIds,
                supportingEvidence: postQaGates.references,
              }).request,
            );
          }
          // Before the commit, so the diagnosis this slice ships is the
          // one the operator read, not whatever the generator left.
          restoreStuckDiagnosis();
          // The accepted tree must be the one the suite just authorized,
          // modulo the exact expected QA-window artifacts (the restored
          // diagnosis above is `stuck.md`, an allowed name). Fail closed
          // on anything else — including the accepted pair, since no
          // amendment can occur in this window (architect A1, ADR 0012).
          const acceptedTreeId = resolveCandidateTreeId(ctx.worktreeDir);
          const acceptViolations = reviewArtifactViolations({
            cwd: ctx.worktreeDir,
            fromTree: postQaGates.candidateTreeId,
            toTree: acceptedTreeId,
            reviewArtifactDir: ctx.relSliceDir,
          });
          if (acceptViolations.length > 0) {
            return {
              phase: "ERROR",
              error:
                `Accepted candidate tree ${acceptedTreeId} differs from ` +
                `the suite-authorized tree ${postQaGates.candidateTreeId} ` +
                `beyond the expected QA-window artifacts ` +
                `(${ctx.relSliceDir}/): ${acceptViolations.join(", ")}. ` +
                `The gate evidence does not authorize this tree (ADR 0012).`,
            };
          }
          if (git.hasUncommittedChanges(ctx.worktreeDir)) {
            git.commitAll(
              ctx.worktreeDir,
              `feat(#${slice.ghIssue}): ${slice.title}`,
            );
          }
          /**
           * The post-approval writing stage, and the reuse decision it decides
           * (#96 B-03/B-01/B-02).
           *
           * Here and only here: after the candidate checkpoint the gates
           * authorized and the QA verdict is tied to, and before the merge —
           * which happens later, in `src/wave.ts`, under the one merge mutex
           * this slice does not touch (#96 P-01).
           *
           * The stage is a no-op in production until PRD 5. The decision is
           * `reuse` exactly when the final tree is the approved baseline's tree
           * — string-equal, with no cosmetic-change exception, because "only
           * formatting moved" is a claim a preservation review exists to check
           * rather than a reason to skip checking. A stub write changes the
           * tree, so it can only ever move the decision to `evaluate`.
           */
          const writingStage =
            config.postApprovalWritingStage ?? noopPostApprovalWritingStage;
          writingStage({
            worktreeDir: ctx.worktreeDir,
            stageId: POST_APPROVAL_WRITING_STAGE_ID,
          });
          if (git.hasUncommittedChanges(ctx.worktreeDir)) {
            git.commitAll(
              ctx.worktreeDir,
              `chore(#${slice.ghIssue}): ${POST_APPROVAL_WRITING_STAGE_ID}`,
            );
          }
          const finalTreeId = resolveCandidateTreeId(ctx.worktreeDir);
          const finalRunSlug = pipelineRunSlug(
            config.prdSlug,
            config.provider ?? kiroProvider,
          );
          const stateBeforeFinal = loadRunState(
            config.repoRoot,
            finalRunSlug,
          );
          /**
           * `recordApprovedBaseline` is called with the bare PRD slug — it is
           * the single baseline writer (#96 P-03) and stays that way — while
           * every other reader in this block uses the provider-suffixed run
           * slug. Read the run slug first and fall back to the bare slug:
           * treating a recorded baseline as absent would send a tree that has
           * an approval on record through a full evaluation, and would make
           * `citesBaseline` false for every run.
           */
          const persistedBaseline =
            approvedBaselineFor(stateBeforeFinal, slice.ghIssue) ??
            (config.prdSlug === finalRunSlug
              ? undefined
              : approvedBaselineFor(
                  loadRunState(config.repoRoot, config.prdSlug),
                  slice.ghIssue,
                ));
          const priorFinalEvaluation = finalEvaluationFor(
            stateBeforeFinal,
            slice.ghIssue,
          );
          const invalidatedCandidateTreeIds = [
            ...(priorFinalEvaluation?.invalidatedCandidateTreeIds ?? []),
          ];
          // The persisted shape, without the `invalidated` flag
          // `finalEvaluationFor` derives on read: the invalidation list is the
          // one authority for that, and writing a second copy back could
          // disagree with it.
          const priorAttemptEntries: PersistedFinalEvaluationAttempt[] = (
            priorFinalEvaluation?.attempts ?? []
          ).map(({ attempt, candidateTreeId, verdict, outcome }) => ({
            attempt,
            candidateTreeId,
            verdict,
            outcome,
          }));
          /**
           * The tree the recorded approval authorizes, which is what the reuse
           * decision compares against (#96 B-01).
           *
           * #91 records the baseline at `checkpoint.treeId` — before the QA
           * evaluator wrote its report and review. Those bytes are committed
           * into the accepted tree above, so the baseline tree and the accepted
           * tree are never string-equal, and a run whose post-approval stage
           * wrote nothing would answer `evaluate` forever.
           *
           * So the accepted tree is offered as the baseline's authorized tree,
           * and only after the same window check the accept seam itself uses
           * proves the QA-window artifacts (plus any audited scope amendment)
           * explain every differing path. If they do not, no authorized tree is
           * offered and the run fails closed into a full final evaluation
           * rather than reusing an approval that covers a different tree.
           */
          const baselineAuthorizedTreeId = ((): string | undefined => {
            if (persistedBaseline === undefined) return undefined;
            if (persistedBaseline.treeId === acceptedTreeId) {
              return acceptedTreeId;
            }
            const beyondTheWindow = reviewArtifactViolations({
              cwd: ctx.worktreeDir,
              fromTree: persistedBaseline.treeId,
              toTree: acceptedTreeId,
              reviewArtifactDir: ctx.relSliceDir,
              ...(amendedPairBlobsThisAttempt
                ? { orchestratorAuthorizedBlobs: amendedPairBlobsThisAttempt }
                : {}),
            });
            return beyondTheWindow.length === 0 ? acceptedTreeId : undefined;
          })();
          const reuse = decideFinalReuse({
            finalTreeId,
            baseline: persistedBaseline
              ? {
                  treeId: persistedBaseline.treeId,
                  ...(baselineAuthorizedTreeId
                    ? { approvedTreeId: baselineAuthorizedTreeId }
                    : {}),
                }
              : null,
            invalidatedCandidateTreeIds,
          });
          // The citation is dropped exactly when this run must not stand on it:
          // an invalidated tree (#96 B-09). The `approved-baseline.json`
          // artifact and every gate-evidence ID it names are untouched — this
          // record cites, and withdrawing a citation is not erasing what was
          // cited (#96 P-03).
          const citesBaseline =
            persistedBaseline !== undefined &&
            !invalidatedCandidateTreeIds.includes(persistedBaseline.treeId);
          recordFinalEvaluation(config.repoRoot, finalRunSlug, slice.ghIssue, {
            decision: reuse.decision,
            finalTreeId,
            ...(citesBaseline
              ? {
                  baselineTreeId: persistedBaseline!.treeId,
                  baselineArtifactPath: persistedBaseline!.artifactPath,
                }
              : {}),
            attempts: priorAttemptEntries,
            invalidatedCandidateTreeIds,
          });
          logger.phase(`${ctx.tag}: ${reuse.reason}`);
          if (reuse.decision === "reuse") {
            // The second of the three stores the reuse is recorded in, with the
            // run-state decision above and the `run-summary.md` section the
            // logger renders from this event. Not a `GateEvidence` field and not
            // D17's gate-cache `reused` flag: those say a gate did not re-run,
            // which is a different claim about a different subject.
            logger.event({
              type: "final-evaluation-reuse",
              ghIssue: slice.ghIssue,
              sliceNumber: slice.number,
              round,
              finalTreeId,
              baselineTreeId: persistedBaseline!.treeId,
            });
          } else {
            /**
             * The bounded final evaluation (#96 B-06/B-08/B-10/B-11).
             *
             * A post-approval stage wrote, so the tree about to merge is not
             * the tree that was approved: it gets a real evaluator, in a
             * disposable worktree at the final checkpoint, at most
             * {@link MAX_FINAL_EVALUATION_ATTEMPTS} times. Each attempt
             * re-resolves the tree it grades, re-runs the `scope` gate *on that
             * tree* (the accepted candidate's gate evidence is keyed to a
             * different tree and can say nothing about this one), dispatches
             * exactly one evaluator, and validates `final-review.json` once.
             *
             * The verdict fails closed: an evaluator that wrote nothing, a
             * review keyed to another tree, an absent final scope gate and an
             * exhausted attempt budget are all refusals to merge, with the
             * conditions they failed named.
             */
            const attemptEntries: PersistedFinalEvaluationAttempt[] = [
              ...priorAttemptEntries,
            ];
            const finalReviewPath = join(
              ctx.absSliceDir,
              FINAL_REVIEW_FILENAME,
            );
            const finalReportPath = join(ctx.absSliceDir, FINAL_REPORT_FILENAME);
            /**
             * The candidate half of the verdict's tree-identity check, read
             * back out of the evidence file's own bytes rather than reused from
             * the gate result: the two agreeing is the fact being checked.
             */
            const candidateEvidence = (() => {
              const artifact =
                postQaGates.artifacts[postQaGates.artifacts.length - 1];
              if (!artifact) return null;
              try {
                return readGateEvidence(artifact.evidencePath);
              } catch {
                return null;
              }
            })();
            const statusIn = (
              evidence: GateEvidence | null,
              gateId: string,
            ): string | null =>
              evidence?.results.find((result) => result.gateId === gateId)
                ?.status ?? null;
            /**
             * Persist the attempt entries after every attempt, not once at the
             * end: an attempt that happened is a fact about the budget, and a
             * run killed between the dispatch and the verdict must not come
             * back with the attempt unspent.
             */
            const persistAttempts = (): void => {
              recordFinalEvaluation(
                config.repoRoot,
                finalRunSlug,
                slice.ghIssue,
                {
                  decision: "evaluate",
                  finalTreeId,
                  ...(citesBaseline
                    ? {
                        baselineTreeId: persistedBaseline!.treeId,
                        baselineArtifactPath: persistedBaseline!.artifactPath,
                      }
                    : {}),
                  attempts: [...attemptEntries],
                  invalidatedCandidateTreeIds,
                },
              );
            };
            let returnToGenerator = false;
            let finalBlockers: string[] = [];
            let passedFinalEvaluation = false;
            while (!passedFinalEvaluation && !returnToGenerator) {
              if (signal?.aborted) {
                return { phase: "CANCELLED", error: CANCELLED_BY_USER };
              }
              const spent = finalEvaluationAttemptsSpent({
                attempts: attemptEntries,
              });
              if (finalEvaluationAttemptsRemaining({ spent }) === 0) {
                finalBlockers = [
                  `all ${MAX_FINAL_EVALUATION_ATTEMPTS} final-evaluation ` +
                    `attempt(s) are spent, so no further evaluator runs`,
                  ...finalBlockers,
                ];
                break;
              }
              // Numbered across the slice's whole final evaluation, so the
              // archived names stay unique even when a previous round already
              // spent attempts on an earlier tree.
              const finalAttempt = attemptEntries.length + 1;
              // The tree the evaluator grades has to be committed before it is
              // named: a restore the writing stage just performed, and the
              // previous attempt's artifacts, are both still loose here.
              rmSync(finalReviewPath, { force: true });
              rmSync(finalReportPath, { force: true });
              if (git.hasUncommittedChanges(ctx.worktreeDir)) {
                git.commitAll(
                  ctx.worktreeDir,
                  `chore(#${slice.ghIssue}): ${POST_APPROVAL_WRITING_STAGE_ID}`,
                );
              }
              /**
               * One capture, so the tree the evaluator is told about and the
               * commit its worktree is checked out at cannot disagree — the
               * same reason `reviewCandidateCommit` captures rather than
               * resolving `HEAD`. Nothing is materialized here; the disposable
               * worktree below is built from the commit.
               */
              const finalCheckpoint = createCandidateCheckpoint(
                ctx.worktreeDir,
                join(
                  config.repoRoot,
                  ".afk",
                  "checkpoints",
                  `final-eval-capture-${randomUUID()}`,
                ),
                { materialize: false },
              );
              const currentFinalTreeId = finalCheckpoint.treeId;
              // The evaluator's leading input (#96 B-04/B-06): baseline →
              // final, with the range attributed to the one post-approval
              // writing stage that produced it. A verdict reached without it
              // would be a verdict on an unattributed diff.
              const changeSummaryPath = citesBaseline
                ? relative(
                    config.repoRoot,
                    writeFinalChangeSummary({
                      cwd: ctx.worktreeDir,
                      artifactDir: artifacts.negotiationArchiveDir(
                        config.repoRoot,
                        finalRunSlug,
                        slice.number,
                      ),
                      baselineRef: persistedBaseline!.treeId,
                      finalRef: currentFinalTreeId,
                      stages: [
                        {
                          stageId: POST_APPROVAL_WRITING_STAGE_ID,
                          fromRef: persistedBaseline!.treeId,
                          toRef: currentFinalTreeId,
                        },
                      ],
                    }).path,
                  ).replace(/\\/g, "/")
                : "not generated — no approved baseline is cited for this slice";
              /**
               * The `scope` gate on the *final* candidate (#96 B-11).
               *
               * A second gate run, on the tree that is about to merge. The
               * accepted candidate's evidence was captured on a different tree,
               * and D10 keys evidence to trees, so it authorizes nothing about
               * this one. Nothing is materialized — the declaration carries no
               * command — and the evidence filename is per-attempt unique, so
               * this cannot collide with the post-QA run's evidence.
               */
              const finalScopeGates = await runPostQAGates({
                repoRoot: config.repoRoot,
                worktreeDir: ctx.worktreeDir,
                prdSlug: config.prdSlug,
                ghIssue: slice.ghIssue,
                sliceNumber: slice.number,
                tag: ctx.tag,
                round,
                evidenceDir,
                declarations: [
                  scopeGateDeclaration({
                    source: {
                      kind: "candidate",
                      worktreeDir: ctx.worktreeDir,
                      featureRef: featBranch,
                    },
                    absSliceDir: ctx.absSliceDir,
                    sliceArtifactDir: ctx.relSliceDir,
                    acceptedPairIntact,
                    options: {
                      migrationPathPattern: config.migrationPathPattern,
                    },
                  }),
                ],
                signal,
                infrastructureRetries:
                  config.infrastructureRetries ??
                  DEFAULT_INFRASTRUCTURE_RETRIES,
                inactivityTimeoutMs:
                  config.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
                wallClockTimeoutMs: DEFAULT_BASE_GATE_WALL_CLOCK_TIMEOUT_MS,
                heartbeatIntervalMs:
                  config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
                priorAttemptTreeIds: [],
                priorArtifacts: [],
                qaApprovedTreeId: currentFinalTreeId,
                reviewArtifactDir: ctx.relSliceDir,
                onGateOutcome: (outcome) => {
                  logger.event({
                    type: "gate-outcome",
                    ghIssue: slice.ghIssue,
                    sliceNumber: slice.number,
                    round,
                    ...outcome,
                  });
                },
                onInfrastructureRetry: (message) => {
                  logger.phase(message, "error", {
                    type: "warn",
                    reason: "infrastructure-retry",
                    ghIssue: slice.ghIssue,
                    message,
                  });
                },
                onCleanupWarning: (message) =>
                  logger.phase(`${ctx.tag}: ${message}`),
              });
              if (finalScopeGates.action === "CANCELLED") {
                return { phase: "CANCELLED", error: CANCELLED_BY_USER };
              }
              const finalScopeEvidence = (() => {
                const artifact =
                  finalScopeGates.artifacts[
                    finalScopeGates.artifacts.length - 1
                  ];
                if (!artifact) return null;
                try {
                  return readGateEvidence(artifact.evidencePath);
                } catch {
                  return null;
                }
              })();
              /**
               * One evaluator invocation, in a disposable worktree at the final
               * checkpoint (#96 B-06, PRD D8/D9). Only `final-review.json` and
               * `final-report.md` come back out of it; every other reviewer
               * write is discarded with the worktree and journaled.
               */
              logger.phase(
                `${ctx.tag}: final evaluation attempt ${finalAttempt} on ` +
                  `${currentFinalTreeId}...`,
                "error",
                {
                  type: "phase-started",
                  ghIssue: slice.ghIssue,
                  sliceNumber: slice.number,
                  agent: "evaluator-final",
                  round,
                },
              );
              const isolation = createReviewIsolation(
                ctx,
                round,
                finalCheckpoint.commitSha,
              );
              let dispatchFailure: string | null = null;
              try {
                const seeded = isolation.seed();
                const evalLog = logger.agentLog(
                  slice.number,
                  "evaluator-final",
                  round * 10 + finalAttempt,
                );
                await invoke({
                  role: "evaluator-final",
                  completionEvidence: {
                    ghIssue: slice.ghIssue,
                    sliceNumber: slice.number,
                    round,
                    attempt: finalAttempt,
                    role: "evaluator-final",
                  },
                  prompt: renderPrompt("evaluator-final", {
                    SLICE_DIR: ctx.relSliceDir,
                    CHANGE_SUMMARY_PATH: changeSummaryPath,
                    // Facts about the checkpoints, handed over rather than
                    // re-derived: the review is refused unless it names this
                    // exact final tree.
                    BASELINE_TREE_ID:
                      persistedBaseline?.treeId ??
                      "(no approved baseline is recorded for this slice)",
                    FINAL_TREE_ID: currentFinalTreeId,
                  }),
                  cwd: isolation.cwd,
                  logStream: evalLog,
                  ...longCommandRoleBounds({
                    idleTimeoutMs: timeoutMs,
                    idleWarningIntervalMs: heartbeatMs,
                    maxDurationMs: config.maxAgentDurationMs,
                  }),
                }).finally(() => {
                  closeAgentLog(evalLog);
                  // Before anything reads the slice directory: the artifacts
                  // have to be out of the review worktree, and every other
                  // write it made has to be on the record.
                  isolation.copyBack();
                  for (const path of scanReviewWorktreeWrites({
                    cwd: isolation.cwd,
                    reviewArtifactDir: ctx.relSliceDir,
                    copyBackAllowlist: QA_WINDOW_ARTIFACT_NAME,
                    seededPaths: seeded,
                  })) {
                    logger.event({
                      type: "reviewer-write-violation",
                      ghIssue: slice.ghIssue,
                      sliceNumber: slice.number,
                      round,
                      attempt: finalAttempt,
                      path,
                    });
                  }
                });
              } catch (error) {
                if (isCancelled(error, signal)) throw error;
                // An evaluator that died still spent its attempt: the tree is
                // unreviewed either way, and a free retry is how a broken
                // dispatch loops forever.
                dispatchFailure =
                  error instanceof Error ? error.message : String(error);
                logger.phase(
                  `${ctx.tag}: final evaluation attempt ${finalAttempt} ` +
                    `failed: ${dispatchFailure}`,
                  "error",
                );
              } finally {
                // Every exit path leaves no review worktree behind (#91 AC1).
                await isolation.dispose();
              }
              // Validated once, and the parsed value is what the verdict is
              // given: a second parse could describe a different document than
              // the validation result did.
              const reviewValidation = validateFinalReview(
                existsSync(finalReviewPath)
                  ? readFileSync(finalReviewPath, "utf-8")
                  : null,
              );
              try {
                artifacts.archiveQAReviewAttempt({
                  sliceDir: ctx.absSliceDir,
                  archiveDir: reviewArchiveDir,
                  stage: "final-evaluation",
                  round,
                  attempt: finalAttempt,
                });
                artifacts.archiveQAReport(
                  finalReportPath,
                  join(
                    reviewArchiveDir,
                    `final-report-r${round}-a${finalAttempt}.md`,
                  ),
                );
                if (!reviewValidation.ok) {
                  artifacts.archiveQAReviewValidation({
                    archiveDir: reviewArchiveDir,
                    stage: "final-evaluation",
                    round,
                    attempt: finalAttempt,
                    evidence: dispatchFailure
                      ? `${reviewValidation.error} (evaluator failed: ${dispatchFailure})`
                      : reviewValidation.error,
                  });
                }
              } catch (error) {
                const message =
                  error instanceof Error ? error.message : String(error);
                logger.phase(
                  `${ctx.tag}: could not archive final evaluation attempt ` +
                    `${finalAttempt}: ${message}`,
                  "error",
                  {
                    type: "warn",
                    reason: "qa-review-archive-failed",
                    ghIssue: slice.ghIssue,
                    message,
                  },
                );
              }
              /**
               * Routing before the verdict (#96 B-08, ADR 0048).
               *
               * A FAIL names its own remedy, and the verdict function grades
               * conditions rather than reading the review's verdict — so a
               * review that failed is routed here and never reaches it.
               */
              if (reviewValidation.ok && reviewValidation.review.verdict === "FAIL") {
                const routes = reviewValidation.review.findings.map(
                  (finding) => ({
                    finding,
                    route: routeFinalReviewFinding(finding, {
                      candidateTreeId: currentFinalTreeId,
                    }),
                  }),
                );
                const returns = routes.filter(
                  ({ route }) => route.target === "generator-loop",
                );
                if (returns.length > 0) {
                  // D19: the return consumes one generator round and zero
                  // final-evaluation attempts, which is what the
                  // `RETURNED_TO_GENERATOR` outcome records.
                  attemptEntries.push({
                    attempt: finalAttempt,
                    candidateTreeId: currentFinalTreeId,
                    verdict: "FAIL",
                    outcome: "RETURNED_TO_GENERATOR",
                  });
                  persistAttempts();
                  invalidateFinalEvaluationBaseline(
                    config.repoRoot,
                    finalRunSlug,
                    slice.ghIssue,
                    currentFinalTreeId,
                  );
                  generatorFailureSet = {
                    findings: returns.map(({ finding }) => ({
                      id: finding.id,
                      clearCondition: finding.expected,
                      artifactReferences: [
                        `${ctx.relSliceDir}/${FINAL_REVIEW_FILENAME}`,
                      ],
                    })),
                    gates: [],
                  };
                  retryNote =
                    `The final evaluation returned this slice to the ` +
                    `generator: the approved candidate itself must change. ` +
                    `${returns
                      .map(({ finding }) => `${finding.id}: ${finding.summary}`)
                      .join(" ")}`;
                  logger.phase(
                    `${ctx.tag}: final evaluation returned the slice to the ` +
                      `generator loop and invalidated the baseline ` +
                      `${currentFinalTreeId}`,
                    "error",
                  );
                  returnToGenerator = true;
                  break;
                }
                // Every finding restores, so the writing stage that wrote over
                // the approved behavior gets it back — and the attempt is
                // spent, because an evaluator read the tree.
                attemptEntries.push({
                  attempt: finalAttempt,
                  candidateTreeId: currentFinalTreeId,
                  verdict: "FAIL",
                  outcome: "GRADED",
                });
                persistAttempts();
                finalBlockers = reviewValidation.review.findings.map(
                  (finding) => `${finding.id}: ${finding.summary}`,
                );
                logger.phase(
                  `${ctx.tag}: final evaluation asked the post-approval ` +
                    `writing stage to restore ` +
                    `${reviewValidation.review.findings
                      .map((finding) => finding.id)
                      .join(", ")}`,
                  "error",
                );
                writingStage({
                  worktreeDir: ctx.worktreeDir,
                  stageId: POST_APPROVAL_WRITING_STAGE_ID,
                  repair: "RESTORE",
                });
                continue;
              }
              const finalVerdict = decideFinalVerdict({
                gates: postQaDeclarations.map((declaration) => ({
                  gateId: declaration.id,
                  required: declaration.required,
                  status:
                    statusIn(candidateEvidence, declaration.id) ?? "ABSENT",
                })),
                candidateTreeId: postQaGates.candidateTreeId,
                candidateArtifactTreeId: candidateEvidence?.treeId ?? null,
                finalTreeId: currentFinalTreeId,
                // The final artifacts are keyed by the tree the review names,
                // and a review of another tree is not evidence about this one.
                finalArtifactTreeId: reviewValidation.ok
                  ? reviewValidation.review.finalTreeId
                  : null,
                reviewValidation,
                // Only the evidence captured on the final tree can say
                // anything about the final candidate's scope.
                scopeGateStatus:
                  finalScopeEvidence?.treeId === currentFinalTreeId
                    ? statusIn(finalScopeEvidence, SCOPE_GATE_ID)
                    : null,
              });
              attemptEntries.push({
                attempt: finalAttempt,
                candidateTreeId: currentFinalTreeId,
                verdict: finalVerdict.verdict,
                outcome: "GRADED",
              });
              persistAttempts();
              finalBlockers = dispatchFailure
                ? [
                    ...finalVerdict.blockers,
                    `the evaluator invocation failed: ${dispatchFailure}`,
                  ]
                : finalVerdict.blockers;
              if (finalVerdict.verdict === "PASS") {
                passedFinalEvaluation = true;
                logger.phase(
                  `${ctx.tag}: final evaluation passed the tree ` +
                    `${currentFinalTreeId} on attempt ${finalAttempt}`,
                );
                break;
              }
              logger.phase(
                `${ctx.tag}: final evaluation attempt ${finalAttempt} did ` +
                  `not pass ${currentFinalTreeId}: ` +
                  `${finalBlockers.join("; ")}`,
                "error",
              );
            }
            if (returnToGenerator) {
              // Exactly one generator round, spent by the round loop itself
              // (`logger.bumpGenRound` at the top of the next iteration).
              if (implementationAttempt < implementationAttemptLimit) continue;
              return finishStuck(
                `The final evaluation returned slice #${slice.ghIssue} to the ` +
                  `generator with no implementation round left to spend. ` +
                  retryNote,
              );
            }
            if (!passedFinalEvaluation) {
              return {
                phase: "ERROR",
                error:
                  `Final evaluation cannot pass the tree ${finalTreeId}: ` +
                  `${finalBlockers.join("; ")}. The approved baseline ` +
                  `authorizes ${persistedBaseline?.treeId ?? "no tree"} ` +
                  `(#96 B-11).`,
              };
            }
            // The evaluator's own artifacts are QA-window names, so committing
            // them keeps the tree that merges identical to the graded tree
            // outside that allowlist (ADR 0012).
            if (git.hasUncommittedChanges(ctx.worktreeDir)) {
              git.commitAll(
                ctx.worktreeDir,
                `chore(#${slice.ghIssue}): final evaluation artifacts`,
              );
            }
          }
          return dispatchAcceptedCandidate(candidateLifecycle.accept({
            round,
            candidateTreeId: acceptedTreeId,
          }));
        }
        if (qaDispatch.action === "FINAL_REPAIR") {
          implementationAttemptLimit++;
          finalRound++;
          logger.phase(
            `${ctx.tag}: granting one final candidate-QA repair for fresh ` +
              `blocking finding(s) ${qaDispatch.findingIds.join(", ")}`,
            "error",
          );
        } else if (
          implementationFailed &&
          round === MAX_GENERATOR_ROUNDS &&
          qaDispatch.action === "STOP"
        ) {
          logger.phase(
            `${ctx.tag}: no final candidate-QA repair granted — ` +
              qaDispatch.reason,
            "error",
          );
        }
      }

      if (implementationAttempt === implementationAttemptLimit) {
        const phase =
          repairStage === "shared-preview"
            ? "shared-preview-uat"
            : "deterministic-qa";
        const archivedUnresolved =
          repairStage === "shared-preview"
            ? sharedPreviewUnresolved
            : deterministicUnresolved;
        return finishIntervention(
          candidateLifecycle.exhaustImplementation({
            phase,
            candidateTreeId: resolveCandidateTreeId(ctx.worktreeDir),
            firstRound,
            attemptLimit: implementationAttemptLimit,
            archivedUnresolved,
            supportingEvidence: stuckReferences,
          }).request,
        );
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
    }
    return finishIntervention(
      candidateLifecycle.exhaustImplementation({
        phase:
          repairStage === "shared-preview"
            ? "shared-preview-uat"
            : "deterministic-qa",
        candidateTreeId: resolveCandidateTreeId(ctx.worktreeDir),
        firstRound,
        attemptLimit: implementationAttemptLimit,
        archivedUnresolved: resumedUnresolved,
        supportingEvidence: stuckReferences,
      }).request,
    );
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
 * One scoped merge-resolution round for a slice whose merge git refused with a
 * real textual conflict (#132).
 *
 * Wired into `WaveInput.resolveMergeConflict` by `runPipeline`, and called from
 * the one new call site in `src/wave.ts` — inside the merge mutex the refused
 * attempt already holds. Everything expensive the round needs is assembled
 * here, because `src/merge-resolution.ts` owns the git and verdict mechanics
 * and this function owns the orchestrator's knowledge: the repair envelope, the
 * slice's own required gate declarations, and the journal.
 *
 * Nothing in here re-acquires `mergeMutex`.
 *
 * Never throws for a round that merely failed — a failed round's fallback is
 * the terminal `CONFLICT` the merge path would have recorded anyway, and a
 * throw would turn that into `ERROR` and hide git's own details. A cancellation
 * is the one exception: it belongs to the wave's own CANCELLED path.
 */
export async function runSliceMergeResolution(args: {
  slice: Slice;
  ctx: SliceContext;
  branch: string;
  conflictDetails: string;
}): Promise<MergeResolutionRoundResult> {
  const { slice, ctx, conflictDetails } = args;
  const { config, logger, featBranch } = ctx;
  const signal = config.signal;
  // Round 0: the implementation rounds are 1..n and this dispatch is none of
  // them — it happens after the candidate passed its gates and its QA, on the
  // merge path. The number is event and log identity only.
  const round = 0;
  let genLog: WriteStream | undefined;
  try {
    // The tip, proven, not the branch label: the scope gate's comparison and
    // the merge the round performs must name the same commit (B-07), and under
    // the held mutex this sha cannot move for the rest of the round.
    const featureTip = resolveRef(ctx.worktreeDir, featBranch);
    const contract = readFileSync(
      join(ctx.absSliceDir, "contract.md"),
      "utf-8",
    );
    const acceptanceManifest = loadAcceptanceManifest(ctx.absSliceDir);
    if (acceptanceManifest.version !== 2) {
      throw new Error(
        "Generator envelope requires an acceptance manifest with behavior bindings",
      );
    }
    const contextPath = join(ctx.absSliceDir, "context.md");
    const hasExplorerContext = existsSync(contextPath);
    const situationFacts = [
      "Merge resolution round: 1 of 1.",
      `This slice's candidate is already committed on \`${ctx.branch}\` and ` +
        `already passed its gates and review; the only thing left is merging ` +
        `it into \`${featBranch}\`, and that merge conflicted. This is the ` +
        `only resolution round the slice gets: if the in-progress merge is ` +
        `not resolved and committed when you stop, the slice ends in ` +
        `CONFLICT and a human finishes the merge by hand.`,
      `Your slice's own required gates — including the file-scope gate and the ` +
        `acceptance behavior bindings — are re-run on the tree you commit, and ` +
        `the tree is refused if any conflict marker survives in a conflicted ` +
        `path.`,
    ].join("\n\n");
    const envelopeInput: GeneratorEnvelopeInput & { repairSituation: string } = {
      mode: "repair",
      sliceDir: ctx.relSliceDir,
      contractView: projectGeneratorContractView(contract),
      acceptanceManifest,
      patternsAndHarness: projectGeneratorPatternsAndHarness(
        hasExplorerContext
          ? readFileSync(contextPath, "utf-8")
          : "(no explorer context artifact is available for this slice)",
      ),
      ...(!hasExplorerContext ? { patternsAndHarnessArtifactId: null } : {}),
      testCommand: ctx.testCommand,
      migrationReservation: migrationReservationBlock(config, slice.ghIssue),
      failureSet: { findings: [], gates: [] },
      ...(config.generatorInlineSizeBudgetBytes !== undefined
        ? { inlineSizeBudgetBytes: config.generatorInlineSizeBudgetBytes }
        : {}),
      repairSituation: situationFacts,
    };

    // --- The slice's own required declarations, built here and passed in.
    const acceptanceCoverage: BehaviorCoverageRecord[] = [];
    const acceptanceDeclaration = acceptanceGateDeclaration({
      absSliceDir: ctx.absSliceDir,
      plan: resolveAcceptancePlan(ctx.worktreeDir),
      bounds: {
        inactivityTimeoutMs:
          config.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
        heartbeatIntervalMs:
          config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
        wallClockTimeoutMs: DEFAULT_BASE_GATE_WALL_CLOCK_TIMEOUT_MS,
      },
      onBehaviorResult: (record) => acceptanceCoverage.push(record),
    });
    /**
     * Mutable on purpose: `scopeGateDeclaration` reads this object inside its
     * `run` closure, so the attestation the gate sees is the one proven after
     * the generator returned — never the literal `true` the gate refuses to
     * default (B-07). It starts `false`, which is the failing-closed answer if
     * the round never gets as far as proving anything.
     */
    const scopeGateInput = {
      source: {
        kind: "candidate" as const,
        worktreeDir: ctx.worktreeDir,
        featureRef: featureTip,
      },
      absSliceDir: ctx.absSliceDir,
      sliceArtifactDir: ctx.relSliceDir,
      acceptedPairIntact: false,
      options: { migrationPathPattern: config.migrationPathPattern },
    };
    const declarations: GateDeclaration[] = [
      scopeGateDeclaration(scopeGateInput),
      ...resolvePreQAGateDeclarations(ctx.worktreeDir),
      ...(acceptanceDeclaration ? [acceptanceDeclaration] : []),
      ...resolveFullSuiteGateDeclarations(ctx.worktreeDir),
    ];
    const costPlan = resolveTestCostPlan(ctx.worktreeDir);
    const gateCache = {
      path: join(
        config.repoRoot,
        ".afk",
        "artifacts",
        pipelineRunSlug(config.prdSlug, config.provider ?? kiroProvider),
        "gate-cache.json",
      ),
      enabled: costPlan.cacheEnabled,
    };
    // No `prepare`: the gates run in the slice's own worktree — the one the
    // generator has been verifying in all along — so its install already
    // happened, and re-running one under the held merge mutex would stall every
    // other lane's merge for nothing.
    const evidenceDir = join(logger.runDir, "gates", `s${slice.number}`);
    // Captured before the dispatch, so the attestation below is a comparison
    // and not a hope (ADR 0055 Seam 1; the implementation loop does the same).
    const acceptedPair = captureAcceptedContractPair(ctx.absSliceDir);
    genLog = logger.agentLog(slice.number, "generator-merge-resolution");
    const dispatchLog = genLog;

    const result = await runMergeResolutionRound({
      worktreeDir: ctx.worktreeDir,
      featureRef: featureTip,
      conflictDetails,
      blockBudgetBytes: mergeResolutionBlockRoom(envelopeInput),
      dispatchGenerator: async (block) => {
        const assembled = assembleGeneratorEnvelope({
          ...envelopeInput,
          repairSituation: withMergeResolutionSituation(
            situationFacts,
            block,
          ),
        });
        await ctx.invoke({
          role: "generator",
          prompt: assembled.prompt,
          contextEnvelope: {
            ghIssue: slice.ghIssue,
            sliceNumber: slice.number,
            round,
            ...assembled.evidence,
          },
          cwd: ctx.worktreeDir,
          logStream: dispatchLog,
          ...longCommandRoleBounds({
            idleTimeoutMs: config.commandTimeoutMs ?? SLOW_AGENT_IDLE_TIMEOUT_MS,
            idleWarningIntervalMs:
              config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
            maxDurationMs: config.maxAgentDurationMs,
          }),
        });
        // Earned here and nowhere else: the pair on disk is byte-for-byte the
        // accepted pair, so the scope gate may exempt it. A round that widened
        // its own lock leaves this `false` and gets both files named.
        const mutated = mutatedAcceptedContractFiles(
          ctx.absSliceDir,
          acceptedPair,
        );
        scopeGateInput.acceptedPairIntact = mutated.length === 0;
        if (mutated.length > 0) {
          logger.phase(
            `${ctx.tag}: merge resolution round changed ` +
              `orchestrator-owned contract file(s) (${mutated.join(", ")}) — ` +
              `the file-scope gate will name them and refuse the tree`,
            "error",
          );
        }
      },
      gatePhase: {
        repoRoot: config.repoRoot,
        ghIssue: slice.ghIssue,
        sliceNumber: slice.number,
        tag: ctx.tag,
        round,
        evidenceDir,
        declarations,
        cache: gateCache,
        label: "merge resolution gates",
        ...(signal ? { signal } : {}),
        infrastructureRetries:
          config.infrastructureRetries ?? DEFAULT_INFRASTRUCTURE_RETRIES,
        inactivityTimeoutMs:
          config.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
        wallClockTimeoutMs: DEFAULT_BASE_GATE_WALL_CLOCK_TIMEOUT_MS,
        heartbeatIntervalMs:
          config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
        onGateOutcome: (outcome) => {
          logger.event({
            type: "gate-outcome",
            ghIssue: slice.ghIssue,
            sliceNumber: slice.number,
            round,
            ...outcome,
          });
          if (outcome.gateId !== ACCEPTANCE_GATE_ID) return;
          for (const record of acceptanceCoverage.splice(0)) {
            logger.event({
              type: "behavior-coverage",
              ghIssue: slice.ghIssue,
              sliceNumber: slice.number,
              round,
              attemptId: outcome.attemptId,
              behaviorId: record.behaviorId,
              gateId: outcome.gateId,
              status: record.status,
              matched: record.matched,
              passed: record.passed,
              failed: record.failed,
              treeId: outcome.treeId,
              evidenceArtifactId: outcome.evidenceArtifactId,
              logArtifactId: outcome.logArtifactId,
            });
          }
        },
        onInfrastructureRetry: (message) => {
          logger.phase(message, "error", {
            type: "warn",
            reason: "infrastructure-retry",
            ghIssue: slice.ghIssue,
            message,
          });
        },
      },
      log: (message) => logger.phase(`${ctx.tag}: ${message}`),
    });
    logger.event({
      type: "merge-resolution-round",
      ghIssue: slice.ghIssue,
      sliceNumber: slice.number,
      verdict: result.verdict,
      durationMs: result.durationMs,
      conflictedPaths: [...result.conflictedPaths],
      ...(result.treeId ? { treeId: result.treeId } : {}),
      detail: result.detail,
    });
    return result;
  } catch (err) {
    if (isCancelled(err, signal)) throw err;
    const message = err instanceof Error ? err.message : String(err);
    // The slice falls back to terminal CONFLICT, which is where it was before
    // this round existed. The worktree is left exactly as the failure found it
    // — including an in-progress merge, if the throw landed mid-merge — because
    // nothing here may destroy work (ADR 0039); the operator gets the tree.
    const failed: MergeResolutionRoundResult = {
      verdict: "UNRESOLVED",
      durationMs: 0,
      conflictedPaths: [],
      detail: `The merge resolution round could not run: ${message}`,
    };
    logger.event({
      type: "merge-resolution-round",
      ghIssue: slice.ghIssue,
      sliceNumber: slice.number,
      verdict: failed.verdict,
      durationMs: failed.durationMs,
      detail: failed.detail,
    });
    return failed;
  } finally {
    if (genLog) await closeAgentLog(genLog);
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
  runGatePolicy: GatePolicy | null,
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
    runGatePolicy,
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
      recordPrompts: config.recordPrompts ?? false,
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
          onIdleWarning: (silentSeconds) => {
            if (opts.logStream) {
              logger.writeIdleWarning(opts.logStream, opts.role, silentSeconds);
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
  // Resolve the generator's local verification command once per run, derived
  // from the cheap-gate catalog so what the generator iterates on cannot drop a
  // gate the candidate must pass (#86 B-05, D18). The catalog is passed in
  // rather than imported by `preship.ts`, because `base-gates.ts` imports it.
  const testCommand = resolveGeneratorTestCommand(
    repoRoot,
    resolveCheapGateCatalog(repoRoot),
    config.testCommand,
  );
  // The run's gate policy, snapshotted here — beside the cheap-gate catalog,
  // which already resolves this same policy once per run — and before any agent
  // has run. Every gate whose rulebook it is reads it from the snapshot, so no
  // gate can be handed the policy the candidate it is judging now presents
  // (#251), and a mid-run edit to the base checkout cannot move the rules
  // either.
  const runGatePolicy = loadGatePolicy(repoRoot);
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
  const initialized = updateRunState(repoRoot, loggerSlug, (current) => {
    initializeMigrationClaims(current, config.manifest ?? null);
    const resolvedScope = resolveRunScope(
      [...manifestDag.slices.values()],
      requestedSliceNumbers,
      current.scope,
    );
    current.scope = resolvedScope.persisted;
    current.featureBranch = featBranch;
    // Recorded so `clean-failed` can *resolve* where this run's slice
    // artifacts live rather than search a worktree for them.
    current.specsDir = specsDir.replace(/\\/g, "/");
    return { runState: current, scope: resolvedScope };
  });
  const runState = initialized.runState;
  scope = initialized.scope;
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
      cleanable: [...manifestDag.slices.values()].flatMap((slice) => {
        const persisted = runState.slices[slice.ghIssue];
        if (!persisted) return [];
        const derived = worktreePathFor(slice);
        const branch = persisted.branch ?? derived.branch;
        const registeredDir = git.findWorktreeForBranch(repoRoot, branch);
        const path = registeredDir ?? derived.path;
        const worktreeIsClean =
          !existsSync(path) || !git.hasUncommittedChanges(path);
        return cleanupEligibility(persisted, worktreeIsClean) ===
          "completed-clean"
          ? [{ path, branch }]
          : [];
      }),
    }),
    minFreeBytes: gbToBytes(resolveMinFreeDiskGb(config.minFreeDiskGb)),
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
        adoptionForCompletedSlice(runState, id),
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
        runGatePolicy,
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
      runGatePolicy,
      mergeMutex,
      // One scoped resolution round per conflicted merge (#132 B-01). Supplied
      // here and only here: the pre-wave MERGE-PENDING recovery path is
      // explicitly out of its scope, and a caller that leaves this unset keeps
      // today's terminal CONFLICT exactly as it was.
      resolveMergeConflict: runSliceMergeResolution,
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
        adoptions: adoptedSlices(runState),
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
          guardianRoundCap: config.guardianRoundCap,
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
          const { trimmed } = updateRunState(
            repoRoot,
            loggerSlug,
            (latestState) => {
              // Keep only prefixes whose slice merged; a failed or descoped
              // slice's reservation must not ride into the verified draft
              // (#65).
              const release = releaseUnmergedMigrationClaims(latestState);
              const trimmed = trimUnclaimedMigrationPrefixes(
                join(reviewDir, specsDir),
                release.retained,
              );
              if (
                latestState.migrations &&
                (trimmed.changed || release.released.length > 0)
              ) {
                latestState.migrations.pool = [
                  ...trimmed.manifest.migrationPrefixes,
                ];
              }
              return { trimmed };
            },
          );
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

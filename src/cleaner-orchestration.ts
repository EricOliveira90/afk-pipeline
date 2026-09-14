import { randomUUID } from "node:crypto";
import { rmSync, type WriteStream } from "node:fs";
import { join, relative } from "node:path";
import { finished } from "node:stream/promises";
import * as artifacts from "./artifacts.js";
import {
  cleanerRoundsRemaining,
  MAX_CLEANER_ROUNDS,
} from "./bounds.js";
import {
  cleanerExhaustionReason,
  CLEANER_ESCALATION_FILENAME,
  renderCleanerQualityFailures,
  resetCleanerRangeTo,
  runCleanerStage,
  type CleanerStageInput,
  type CleanerStageResult,
} from "./cleaner-stage.js";
import type { AgentProvider, InvokeOptions } from "./agent-provider.js";
import { ACCEPTANCE_MANIFEST_FILENAME } from "./acceptance-manifest.js";
import type { GeneratorFailureSet } from "./context-envelope.js";
import type { FinalReviewFinding } from "./final-evaluation.js";
import * as git from "./git.js";
import { renderPrompt } from "./prompt-template.js";
import { RunJournal } from "./run-journal.js";
import {
  cleanerRoundsSpent,
  invalidateFinalEvaluationBaseline,
  loadRunState,
  qualityStagesFor,
  recordQualityStageOutcome,
  recordQualityStageRound,
} from "./run-state.js";
import { runIdFor } from "./stop-sentinel.js";

type CleanerInvokeOptions = Parameters<AgentProvider["invoke"]>[0] & {
  completionEvidence?: {
    ghIssue: string;
    sliceNumber: string;
    round: number;
    attempt?: number;
    role: "cleaner";
  };
};

type CleanerInvoke = (
  options: CleanerInvokeOptions,
) => ReturnType<AgentProvider["invoke"]>;

type CleanerInvocationBounds = Pick<
  InvokeOptions,
  | "idleTimeoutMs"
  | "idleWarningIntervalMs"
  | "maxDurationMs"
  | "deferIdleKillWhenBusy"
>;

export interface CleanerOrchestrationSessionInput {
  run: {
    repoRoot: string;
    runSlug: string;
    prdSlug: string;
    reviewArchiveDir: string;
    logger: RunJournal;
  };
  slice: {
    ghIssue: string;
    number: string;
    tag: string;
    worktreeDir: string;
    relSliceDir: string;
    absSliceDir: string;
    featureRef: string;
  };
  generatorRound: number;
  accepted: {
    treeId: string;
    commitSha: string | null;
  };
  invoke: CleanerInvoke;
  invocationBounds: CleanerInvocationBounds;
  stageInput: Omit<
    CleanerStageInput,
    | "acceptedTreeId"
    | "repair"
    | "checkpointDirFor"
    | "disposeCheckpoint"
    | "gatePhase"
  > & {
    gatePhase: Omit<
      CleanerStageInput["gatePhase"],
      "onGateOutcome" | "onInfrastructureRetry"
    >;
  };
  signal?: AbortSignal;
}

export type CleanerAdvance =
  | { kind: "INITIAL" }
  | {
      kind: "RESTORE";
      findings: readonly FinalReviewFinding[];
      discardArtifacts: readonly string[];
    };

export type CleanerDecision =
  | { kind: "PROCEED"; result: CleanerStageResult }
  | {
      kind: "RETURN_TO_GENERATOR";
      result: CleanerStageResult;
      failureSet: GeneratorFailureSet;
      retryNote: string;
    }
  | {
      kind: "STUCK";
      result: CleanerStageResult;
      reason: string;
      artifactReferences: string[];
    };

export interface CleanerOrchestrationSession {
  advance(request: CleanerAdvance): Promise<CleanerDecision>;
}

async function closeAgentLog(log: WriteStream): Promise<void> {
  log.end();
  try {
    await finished(log);
  } catch {
    // Agent logs are best-effort and must not mask the invocation outcome.
  }
}

/**
 * Own one accepted candidate's cleaner lifecycle across its initial run and
 * every final-evaluation restore. The caller keeps generator and slice
 * lifecycle authority; this module keeps cleaner state and terminal policy
 * local to the stage that produces it.
 */
export function createCleanerOrchestrationSession(
  input: CleanerOrchestrationSessionInput,
): CleanerOrchestrationSession {
  const { run, slice } = input;
  let standing: CleanerStageResult | undefined;

  const dispatch = (options: {
    roundsAlreadySpent: number;
    repair?: { findings: readonly FinalReviewFinding[] };
  }) =>
    runCleanerStage(
      {
        repoRoot: run.repoRoot,
        worktreeDir: slice.worktreeDir,
        ghIssue: slice.ghIssue,
        sliceNumber: slice.number,
        relSliceDir: slice.relSliceDir,
        absSliceDir: slice.absSliceDir,
        featureRef: slice.featureRef,
        dispatch: async (cleanerInput) => {
          const cleanerRound = cleanerInput.round;
          // Open the stream before phase-started so every open journal stage
          // reaches this try/finally and can emit a duration sample.
          const cleanerLog = run.logger.agentLog(
            slice.number,
            "cleaner",
            input.generatorRound * 10 + cleanerRound,
          );
          run.logger.phase(
            `${slice.tag}: cleaner round ${cleanerRound} of ` +
              `${cleanerInput.roundLimit} on ${cleanerInput.inputTreeId}...`,
            "error",
            {
              type: "phase-started",
              ghIssue: slice.ghIssue,
              sliceNumber: slice.number,
              agent: "cleaner",
              round: cleanerRound,
            },
          );
          try {
            await input.invoke({
              role: "cleaner",
              completionEvidence: {
                ghIssue: slice.ghIssue,
                sliceNumber: slice.number,
                round: input.generatorRound,
                attempt: cleanerRound,
                role: "cleaner",
              },
              prompt: renderPrompt("cleaner", {
                SLICE_DIR: slice.relSliceDir,
                ROUND: String(cleanerRound),
                ROUND_LIMIT: String(cleanerInput.roundLimit),
                BASELINE_TREE_ID: cleanerInput.baselineTreeId,
                INPUT_TREE_ID: cleanerInput.inputTreeId,
                WRITE_SCOPE: [
                  `- Every path in the locked ` +
                    `\`${slice.relSliceDir}/${ACCEPTANCE_MANIFEST_FILENAME}\`` +
                    ` \`fileScope\`.`,
                  ...(input.stageInput.clean?.additionalWriteScope ?? []).map(
                    (glob) =>
                      `- \`${glob}\` (this project's ` +
                      `\`gatePolicy.clean.additionalWriteScope\`).`,
                  ),
                  `- \`${slice.relSliceDir}/${CLEANER_ESCALATION_FILENAME}\`,` +
                    ` and only to escalate.`,
                ].join("\n"),
                QUALITY_FAILURES: renderCleanerQualityFailures(cleanerInput),
                REGRESSION_NOTE: cleanerInput.regressionNote,
              }),
              cwd: slice.worktreeDir,
              logStream: cleanerLog,
              ...input.invocationBounds,
            });
          } finally {
            await closeAgentLog(cleanerLog);
            run.logger.event({
              type: "phase-ended",
              ghIssue: slice.ghIssue,
              sliceNumber: slice.number,
              agent: "cleaner",
              round: cleanerRound,
            });
          }
        },
        archiveRound: ({ round: cleanerRound, hasEscalation }) => {
          let escalationArtifactId: string | undefined;
          try {
            if (hasEscalation) {
              const name = artifacts.archiveQAReviewAttempt({
                sliceDir: slice.absSliceDir,
                archiveDir: run.reviewArchiveDir,
                stage: "cleaner",
                round: input.generatorRound,
                attempt: cleanerRound,
              });
              if (name !== null) {
                escalationArtifactId = relative(
                  run.repoRoot,
                  join(run.reviewArchiveDir, name),
                ).replace(/\\/g, "/");
              }
            }
            artifacts.archiveCleanerLog({
              source: join(
                run.logger.runDir,
                `slice-${slice.number}-cleaner-r` +
                  `${input.generatorRound * 10 + cleanerRound}.log`,
              ),
              archiveDir: run.reviewArchiveDir,
              round: input.generatorRound,
              attempt: cleanerRound,
              runId: runIdFor(run.logger.runDir),
            });
          } catch (error) {
            run.logger.phase(
              `${slice.tag}: could not archive cleaner round ` +
                `${cleanerRound}: ` +
                `${error instanceof Error ? error.message : String(error)}`,
              "error",
            );
          }
          return escalationArtifactId ? { escalationArtifactId } : undefined;
        },
        recordRound: (record) =>
          recordQualityStageRound(
            run.repoRoot,
            run.runSlug,
            slice.ghIssue,
            { ...record, gateIds: [...record.gateIds] },
            { startNewEntry: record.round === 1 },
          ),
        recordOutcome: (outcome) =>
          recordQualityStageOutcome(
            run.repoRoot,
            run.runSlug,
            slice.ghIssue,
            outcome,
          ),
        observeRoundAttempt: (attempt) => {
          run.logger.recordQualityStageAttempt({
            ghIssue: slice.ghIssue,
            sliceNumber: slice.number,
            round: input.generatorRound,
            stage: "cleaner",
            stageRound: attempt.round,
            attempt: attempt.round,
            inputTreeId: attempt.inputTreeId,
            ...(attempt.outputTreeId !== undefined
              ? { outputTreeId: attempt.outputTreeId }
              : {}),
            gateIds: attempt.gateIds,
            outcome: attempt.outcome,
            startedAt: attempt.startedAt,
            endedAt: attempt.endedAt,
            durationMs: attempt.durationMs,
            cacheReusedGateIds: attempt.cacheReusedGateIds,
          });
        },
        log: (message, level) =>
          run.logger.phase(`${slice.tag}: ${message}`, level),
        roundsAlreadySpent: options.roundsAlreadySpent,
        ...(input.signal ? { signal: input.signal } : {}),
      },
      input.generatorRound,
      {
        ...input.stageInput,
        gatePhase: {
          ...input.stageInput.gatePhase,
          onGateOutcome: (outcome) => {
            run.logger.event({
              type: "gate-outcome",
              ghIssue: slice.ghIssue,
              sliceNumber: slice.number,
              round: input.generatorRound,
              ...outcome,
            });
          },
          onInfrastructureRetry: (message) => {
            run.logger.phase(message, "error", {
              type: "warn",
              reason: "infrastructure-retry",
              ghIssue: slice.ghIssue,
              message,
            });
          },
        },
        acceptedTreeId: input.accepted.treeId,
        ...(options.repair ? { repair: options.repair } : {}),
        checkpointDirFor: (cleanerRound) =>
          join(
            run.repoRoot,
            ".afk",
            "checkpoints",
            `${run.prdSlug}-s${slice.number}-r${input.generatorRound}-` +
              `cleaner-a${cleanerRound}-${randomUUID()}`,
          ),
        disposeCheckpoint: async (checkpointWorktreeDir) => {
          await git.removeWorktreeOrWarn(
            slice.worktreeDir,
            checkpointWorktreeDir,
            {
              label: slice.tag,
              warn: (message) =>
                run.logger.phase(`${slice.tag}: ${message}`),
            },
            ...(input.signal ? [{ signal: input.signal }] : []),
          );
        },
      },
    );

  const mergeStanding = (result: CleanerStageResult): CleanerStageResult => {
    if (!standing) {
      standing = result;
      return result;
    }
    standing = {
      ...result,
      ran: standing.ran || result.ran,
      inputTreeId: standing.inputTreeId,
      roundsSpent: Math.max(standing.roundsSpent, result.roundsSpent),
    };
    return standing;
  };

  const decide = (result: CleanerStageResult): CleanerDecision => {
    if (result.outcome === "ESCALATED" && result.escalation) {
      if (input.accepted.commitSha !== null) {
        resetCleanerRangeTo(
          slice.worktreeDir,
          input.accepted.commitSha,
        );
      }
      invalidateFinalEvaluationBaseline(
        run.repoRoot,
        run.runSlug,
        slice.ghIssue,
        input.accepted.treeId,
      );
      const failureSet: GeneratorFailureSet = {
        findings: [
          {
            id: result.escalation.id,
            clearCondition: result.escalation.expected,
            artifactReferences: result.escalationArtifactId
              ? [result.escalationArtifactId]
              : [
                  `${slice.relSliceDir}/${CLEANER_ESCALATION_FILENAME}`,
                ],
          },
        ],
        gates: [],
      };
      const retryNote =
        `The cleaner escalated the approved baseline: ` +
        `${result.escalation.id}: ${result.escalation.summary} ` +
        `Expected: ${result.escalation.expected} Observed: ` +
        `${result.escalation.observed}`;
      run.logger.phase(
        `${slice.tag}: the cleaner returned the slice to the generator ` +
          `loop and invalidated the baseline ${input.accepted.treeId}`,
        "error",
      );
      return {
        kind: "RETURN_TO_GENERATOR",
        result,
        failureSet,
        retryNote,
      };
    }
    if (result.outcome === "EXHAUSTED") {
      const remaining = result.remainingFailures ?? [];
      return {
        kind: "STUCK",
        result,
        reason: cleanerExhaustionReason({
          ghIssue: slice.ghIssue,
          roundsSpent: result.roundsSpent,
          failures: remaining,
          treeId: result.outputTreeId,
        }),
        artifactReferences: remaining.map(
          (failure) => failure.logArtifactId,
        ),
      };
    }
    return { kind: "PROCEED", result };
  };

  return {
    async advance(request) {
      if (request.kind === "INITIAL") {
        const prior = qualityStagesFor(
          loadRunState(run.repoRoot, run.runSlug),
          slice.ghIssue,
        ).at(-1);
        const resumable =
          prior !== undefined &&
          prior.outcome !== "ESCALATED" &&
          prior.outcome !== "PASS"
            ? prior
            : undefined;
        const result = mergeStanding(
          await dispatch({
            roundsAlreadySpent: cleanerRoundsSpent(resumable),
          }),
        );
        return decide(result);
      }

      if (!standing) {
        throw new Error("Cleaner RESTORE requires an INITIAL advance");
      }
      if (
        cleanerRoundsRemaining({
          spent: standing.roundsSpent,
          limit: MAX_CLEANER_ROUNDS,
        }) === 0
      ) {
        if (input.accepted.commitSha !== null) {
          resetCleanerRangeTo(
            slice.worktreeDir,
            input.accepted.commitSha,
          );
        }
        recordQualityStageOutcome(
          run.repoRoot,
          run.runSlug,
          slice.ghIssue,
          "EXHAUSTED",
        );
        run.logger.phase(
          `${slice.tag}: the cleaner has no round left to restore ` +
            `${request.findings.map((finding) => finding.id).join(", ")}, ` +
            `so its ${standing.roundsSpent} round(s) were reset to the ` +
            `accepted commit ${input.accepted.commitSha ?? "(unresolved)"}`,
          "error",
        );
        return { kind: "PROCEED", result: standing };
      }

      for (const artifactPath of request.discardArtifacts) {
        rmSync(artifactPath, { force: true });
      }
      const result = mergeStanding(
        await dispatch({
          roundsAlreadySpent: standing.roundsSpent,
          repair: { findings: request.findings },
        }),
      );
      return decide(result);
    },
  };
}

import {
  loadRunState,
  transactRunState,
  updateRunState,
  type RunState,
} from "./run-state.js";
import {
  DEFAULT_MIGRATION_VALIDATION,
  sliceTouchedMigrations,
  verifyMigrationSync,
  type MigrationValidation,
} from "./migration-gate.js";

export type CompletedCandidateStage =
  | "deterministic-qa"
  | "shared-preview-uat";

export type PendingDeterministicStage = "post-qa-deterministic";

export interface ExactStageCheckpoint {
  version: 1;
  completedStage: CompletedCandidateStage;
  candidateTreeId: string;
  nextPendingStage: PendingDeterministicStage;
  round: number;
}

export type ExactStageResumeDecision =
  | { action: "resume"; checkpoint: ExactStageCheckpoint }
  | { action: "reevaluate"; reason: string };

interface CheckpointLocation {
  repoRoot: string;
  prdSlug: string;
  ghIssue: string;
}

interface InspectCheckpointInput extends CheckpointLocation {
  currentCandidateTreeId: string | null;
  expectedCompletedStage: CompletedCandidateStage;
  maximumRound: number;
}

interface PendingStageInput extends CheckpointLocation {
  worktreeDir: string;
  featureBranch: string;
  sharedPreview: boolean;
  migrationValidation?: MigrationValidation;
}

export type PendingStageResult =
  | { ok: true }
  | { ok: false; error: string };

const TREE_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

function checkpointMap(
  state: RunState,
): Record<string, unknown> | null {
  const value = state.stageCheckpoints;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function parseCheckpoint(
  value: unknown,
  expectedCompletedStage: CompletedCandidateStage,
  maximumRound: number,
): ExactStageCheckpoint | string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "the recorded stage checkpoint is malformed";
  }
  const input = value as Partial<Record<keyof ExactStageCheckpoint, unknown>>;
  if (input.version !== 1) {
    return "the recorded stage checkpoint has an unsupported version";
  }
  if (
    input.completedStage !== "deterministic-qa" &&
    input.completedStage !== "shared-preview-uat"
  ) {
    return "the recorded completed stage is malformed";
  }
  if (input.completedStage !== expectedCompletedStage) {
    return (
      `the recorded completed stage ${input.completedStage} contradicts ` +
      `the current candidate flow (${expectedCompletedStage})`
    );
  }
  if (
    typeof input.candidateTreeId !== "string" ||
    !TREE_ID.test(input.candidateTreeId)
  ) {
    return "the recorded candidate tree identity is malformed";
  }
  if (input.nextPendingStage !== "post-qa-deterministic") {
    return "the recorded next pending stage is malformed or contradictory";
  }
  if (
    typeof input.round !== "number" ||
    !Number.isSafeInteger(input.round) ||
    input.round < 1 ||
    input.round > maximumRound
  ) {
    return "the recorded implementation round is malformed or contradictory";
  }
  return input as ExactStageCheckpoint;
}

/**
 * Persist an accepted candidate at the exact seam before its pending
 * deterministic finalization. One synchronous run-state write makes the
 * completed stage, candidate identity, pending stage, and round durable.
 */
export function recordExactStageCheckpoint(
  location: CheckpointLocation,
  checkpoint: ExactStageCheckpoint,
): void {
  updateRunState(location.repoRoot, location.prdSlug, (state) => {
    const existing = checkpointMap(state) ?? {};
    state.stageCheckpoints = {
      ...existing,
      [location.ghIssue]: checkpoint,
    };
  });
}

/**
 * Decide whether a restart may continue at the recorded deterministic stage.
 * Every incomplete or contradictory fact falls closed to normal evaluation.
 */
export function inspectExactStageCheckpoint(
  input: InspectCheckpointInput,
): ExactStageResumeDecision {
  const state = loadRunState(input.repoRoot, input.prdSlug);
  const checkpoints = checkpointMap(state);
  if (checkpoints === null) {
    return {
      action: "reevaluate",
      reason:
        state.stageCheckpoints === undefined
          ? "no exact-stage checkpoint was recorded"
          : "the exact-stage checkpoint collection is malformed",
    };
  }
  if (!(input.ghIssue in checkpoints)) {
    return {
      action: "reevaluate",
      reason: "no exact-stage checkpoint was recorded for this slice",
    };
  }
  const parsed = parseCheckpoint(
    checkpoints[input.ghIssue],
    input.expectedCompletedStage,
    input.maximumRound,
  );
  if (typeof parsed === "string") {
    return { action: "reevaluate", reason: parsed };
  }
  if (input.currentCandidateTreeId === null) {
    return {
      action: "reevaluate",
      reason: "the preserved candidate could not be hashed",
    };
  }
  if (parsed.candidateTreeId !== input.currentCandidateTreeId) {
    return {
      action: "reevaluate",
      reason:
        `the preserved candidate tree ${input.currentCandidateTreeId} does ` +
        `not match recorded tree ${parsed.candidateTreeId}`,
    };
  }
  return { action: "resume", checkpoint: parsed };
}

/** Remove one slice's checkpoint after it is consumed or invalidated. */
export function clearExactStageCheckpoint(
  location: CheckpointLocation,
): void {
  transactRunState(location.repoRoot, location.prdSlug, (state) => {
    const checkpoints = checkpointMap(state);
    if (checkpoints === null) {
      if (state.stageCheckpoints === undefined) {
        return { changed: false, result: undefined };
      }
      delete state.stageCheckpoints;
      return { changed: true, result: undefined };
    }
    if (!(location.ghIssue in checkpoints)) {
      return { changed: false, result: undefined };
    }
    const next = { ...checkpoints };
    delete next[location.ghIssue];
    if (Object.keys(next).length === 0) {
      delete state.stageCheckpoints;
    } else {
      state.stageCheckpoints = next;
    }
    return { changed: true, result: undefined };
  });
}

/**
 * Execute the deterministic work that remains after candidate evaluation.
 * A returned result consumes the checkpoint; an interruption or throw leaves
 * it durable so the next process can retry this same stage on the exact tree.
 */
export function runPendingDeterministicStage(
  input: PendingStageInput,
): PendingStageResult {
  const migrationMode =
    input.migrationValidation ?? DEFAULT_MIGRATION_VALIDATION;
  if (
    !input.sharedPreview &&
    migrationMode !== "skip" &&
    sliceTouchedMigrations(input.worktreeDir, input.featureBranch)
  ) {
    const migrationCheck = verifyMigrationSync(
      input.worktreeDir,
      migrationMode,
    );
    clearExactStageCheckpoint(input);
    return migrationCheck.ok
      ? { ok: true }
      : {
          ok: false,
          error: `Migration sync check failed: ${migrationCheck.error}`,
        };
  }
  clearExactStageCheckpoint(input);
  return { ok: true };
}

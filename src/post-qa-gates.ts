import { randomUUID } from "node:crypto";
import { join } from "node:path";
import * as git from "./git.js";
import {
  createCandidateCheckpoint,
  verifyGateEvidence,
  type GateDeclaration,
  type GateEvidenceArtifact,
} from "./gate-runner.js";
import {
  assertGateEvidenceReleasesEvaluation,
  runCandidateGatePhase,
  type CandidateGateOutcome,
} from "./candidate-gate-phase.js";
import { decideCandidateGatePhase } from "./candidate-gate-policy.js";
import type { GeneratorFailureSet } from "./context-envelope.js";

/**
 * Paths by which `toTree` differs from the QA-approved `fromTree` outside
 * the slice's review-artifact directory. ADR 0012's amendment ties the QA
 * verdict to one captured candidate tree; the only tree drift a later step
 * may accept is the QA evaluator's own review artifacts inside the slice
 * directory. Anything else — an evaluator source edit, stray build output —
 * voids the verdict's authority over the new tree, and the caller must fail
 * closed (guardian round 2, architect A1).
 */
export function reviewArtifactViolations(input: {
  cwd: string;
  fromTree: string;
  toTree: string;
  /** Repo-relative slice directory (forward slashes), e.g. `specs/x/slices/01-y`. */
  reviewArtifactDir: string;
}): string[] {
  if (input.fromTree === input.toTree) return [];
  const prefix = `${input.reviewArtifactDir.replace(/\\/g, "/").replace(/\/+$/, "")}/`;
  return git
    .diffTreePaths(input.cwd, input.fromTree, input.toTree)
    .filter((path) => !path.startsWith(prefix));
}

export type PostQAGateResult =
  | {
      action: "PASS";
      candidateTreeId: string;
      artifacts: GateEvidenceArtifact[];
    }
  | {
      action: "CANCELLED";
      candidateTreeId: string;
      artifacts: GateEvidenceArtifact[];
    }
  | {
      action: "ERROR";
      error: string;
      candidateTreeId: string;
      artifacts: GateEvidenceArtifact[];
    }
  | {
      action: "REPAIR";
      failedGateIds: string[];
      references: string[];
      retryNote: string;
      /** Gates-only projection for the next generator (see policy module). */
      failureSet: GeneratorFailureSet;
      candidateTreeId: string;
      attemptTreeIds: string[];
      artifacts: GateEvidenceArtifact[];
    };

/**
 * Own the full post-QA checkpoint lifecycle: capture the reviewed tree, run
 * the full-suite gates, classify the result, verify evidence, and clean up the
 * temporary worktree.
 */
export async function runPostQAGates(args: {
  repoRoot: string;
  worktreeDir: string;
  prdSlug: string;
  ghIssue: string;
  sliceNumber: string;
  tag: string;
  round: number;
  evidenceDir: string;
  declarations: readonly GateDeclaration[];
  prepare?: GateDeclaration;
  signal?: AbortSignal;
  infrastructureRetries: number;
  inactivityTimeoutMs: number;
  wallClockTimeoutMs: number;
  heartbeatIntervalMs: number;
  priorAttemptTreeIds: readonly string[];
  priorArtifacts: readonly GateEvidenceArtifact[];
  /**
   * The candidate tree the QA verdict is tied to. The post-QA checkpoint
   * must equal it except under `reviewArtifactDir` (architect A1).
   */
  qaApprovedTreeId: string;
  /** Repo-relative slice directory the QA evaluator legitimately writes. */
  reviewArtifactDir: string;
  onGateOutcome: (outcome: CandidateGateOutcome) => void;
  onInfrastructureRetry: (message: string) => void;
  onCleanupWarning: (message: string) => void;
}): Promise<PostQAGateResult> {
  const executable = args.declarations.some(
    (declaration) => declaration.command != null,
  );
  const checkpointDir = join(
    args.repoRoot,
    ".afk",
    "checkpoints",
    `${args.prdSlug}-s${args.sliceNumber}-r${args.round}-post-qa-${randomUUID()}`,
  );
  const checkpoint = executable
    ? createCandidateCheckpoint(args.worktreeDir, checkpointDir)
    : createCandidateCheckpoint(args.worktreeDir, checkpointDir, {
        materialize: false,
      });
  const cwd = checkpoint.worktreeDir ?? checkpointDir;

  try {
    // The full suite must authorize the tree QA approved, not merely a tree
    // that came later from the same worktree. Fail closed before paying the
    // suite when the post-QA tree drifted outside the review-artifact
    // allowlist (ADR 0012; guardian round 2, architect A1).
    const violations = reviewArtifactViolations({
      cwd: args.worktreeDir,
      fromTree: args.qaApprovedTreeId,
      toTree: checkpoint.treeId,
      reviewArtifactDir: args.reviewArtifactDir,
    });
    if (violations.length > 0) {
      return {
        action: "ERROR",
        error:
          `Post-QA candidate tree ${checkpoint.treeId} differs from the ` +
          `QA-approved tree ${args.qaApprovedTreeId} outside the ` +
          `review-artifact allowlist (${args.reviewArtifactDir}/): ` +
          `${violations.join(", ")}. The QA verdict does not authorize ` +
          `this tree (ADR 0012).`,
        candidateTreeId: checkpoint.treeId,
        artifacts: [],
      };
    }
    const run = await runCandidateGatePhase({
      repoRoot: args.repoRoot,
      ghIssue: args.ghIssue,
      sliceNumber: args.sliceNumber,
      tag: args.tag,
      round: args.round,
      treeId: checkpoint.treeId,
      cwd,
      evidenceDir: args.evidenceDir,
      declarations: args.declarations,
      ...(args.prepare && executable ? { prepare: args.prepare } : {}),
      label: "full slice suite",
      signal: args.signal,
      infrastructureRetries: args.infrastructureRetries,
      inactivityTimeoutMs: args.inactivityTimeoutMs,
      wallClockTimeoutMs: args.wallClockTimeoutMs,
      heartbeatIntervalMs: args.heartbeatIntervalMs,
      onGateOutcome: args.onGateOutcome,
      onInfrastructureRetry: args.onInfrastructureRetry,
    });
    const artifacts = [...run.artifacts];
    if (args.signal?.aborted) {
      return {
        action: "CANCELLED",
        candidateTreeId: checkpoint.treeId,
        artifacts,
      };
    }
    const decision = decideCandidateGatePhase({
      run,
      declarations: args.declarations,
      evidenceDir: args.evidenceDir,
      nextRound: args.round + 1,
    });
    if (decision.action === "ERROR") {
      return {
        action: "ERROR",
        error: decision.error,
        candidateTreeId: checkpoint.treeId,
        artifacts,
      };
    }
    if (decision.action === "REPAIR") {
      return {
        ...decision,
        candidateTreeId: checkpoint.treeId,
        attemptTreeIds: [
          ...args.priorAttemptTreeIds.slice(0, -1),
          checkpoint.treeId,
        ],
        artifacts,
      };
    }
    assertGateEvidenceReleasesEvaluation(
      run.evidence,
      args.declarations,
      checkpoint.treeId,
    );
    for (const artifact of [...args.priorArtifacts, ...artifacts]) {
      verifyGateEvidence(artifact);
    }
    return {
      action: "PASS",
      candidateTreeId: checkpoint.treeId,
      artifacts,
    };
  } finally {
    if (checkpoint.worktreeDir) {
      await git.removeWorktreeOrWarn(
        args.worktreeDir,
        checkpoint.worktreeDir,
        {
          label: "post-QA checkpoint worktree",
          warn: args.onCleanupWarning,
        },
        { signal: args.signal },
      );
    }
  }
}

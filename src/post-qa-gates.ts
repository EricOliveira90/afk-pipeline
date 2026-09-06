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
 * The exact artifacts that may legitimately appear or change inside the
 * slice directory between the QA-approved checkpoint and a later authority
 * boundary (the post-QA suite checkpoint, then the accepted commit):
 *
 * - `qa-report.md` / `uat-report.md` and `qa-review.json` /
 *   `uat-review.json` — the evaluator's only instructed writes
 *   (`prompts/evaluator-qa.md`; canonical names in `src/qa-review.ts`).
 * - `qa-report-rN-aM.md` / `uat-report-rN-aM.md` — the orchestrator's
 *   in-slice-dir report archives (`archiveQAReport`).
 * - `stuck.md` — the orchestrator restores the operator's diagnosis bytes
 *   before the accepted commit (#82 AC3).
 *
 * Everything else in the slice directory is authority-bearing input —
 * `contract.md`, `acceptance-manifest.json`, `context.md`, `handoff.md` —
 * and a change there voids the QA verdict (guardian round 3, architect
 * A1), except when the orchestrator itself amended the locked scope and
 * says so via `orchestratorAuthorizedPaths`.
 */
const QA_WINDOW_ARTIFACT_NAME =
  /^(?:qa|uat)-report(?:-r[1-9]\d*-a[1-9]\d*)?\.md$|^(?:qa|uat)-review\.json$|^stuck\.md$/;

/**
 * Paths by which `toTree` differs from the QA-approved `fromTree` that no
 * legitimate QA-window write explains. ADR 0012's amendment ties the QA
 * verdict to one captured candidate tree; the evaluator may add its
 * expected review artifacts and the orchestrator its diagnosis restore and
 * explicitly declared scope-amendment writes — nothing else. An evaluator
 * edit to the locked contract, the acceptance manifest, the explorer
 * context, the handoff, or any source path voids the verdict's authority
 * over the new tree, and the caller must fail closed (guardian rounds 2–3,
 * architect A1).
 */
export function reviewArtifactViolations(input: {
  cwd: string;
  fromTree: string;
  toTree: string;
  /** Repo-relative slice directory (forward slashes), e.g. `specs/x/slices/01-y`. */
  reviewArtifactDir: string;
  /**
   * Exact bytes the orchestrator itself wrote under an audited authority in
   * this window, as repo-relative path → git blob ID recorded immediately
   * after the write (today: `contract.md` and `acceptance-manifest.json`
   * after an applied scope amendment, archived as
   * `qa|uat-scope-amendment-rN-aM.json` evidence). A path is admitted only
   * when the candidate tree holds exactly the recorded blob — any later
   * edit, evaluator or otherwise, is a violation (guardian round 4,
   * architect A1: typed byte provenance, never a path waiver).
   */
  orchestratorAuthorizedBlobs?: Readonly<Record<string, string>>;
}): string[] {
  if (input.fromTree === input.toTree) return [];
  const dir = input.reviewArtifactDir.replace(/\\/g, "/").replace(/\/+$/, "");
  const prefix = `${dir}/`;
  const authorizedBlobs = new Map(
    Object.entries(input.orchestratorAuthorizedBlobs ?? {}).map(
      ([path, blobId]) => [path.replace(/\\/g, "/"), blobId],
    ),
  );
  return git
    .diffTreePaths(input.cwd, input.fromTree, input.toTree)
    .filter((path) => {
      const authorizedBlobId = authorizedBlobs.get(path);
      if (authorizedBlobId !== undefined) {
        // Authorized means these exact bytes, not this path: the candidate
        // tree must hold precisely the blob recorded at the orchestrator's
        // transaction. `null` (entry missing) fails closed.
        return (
          git.treeEntryBlobId(input.cwd, input.toTree, path) !==
          authorizedBlobId
        );
      }
      if (!path.startsWith(prefix)) return true;
      const name = path.slice(prefix.length);
      // Nested paths and unexpected names inside the slice directory are
      // violations too: the allowlist is exact artifacts, not a directory.
      return !QA_WINDOW_ARTIFACT_NAME.test(name);
    });
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
   * must equal it except for the exact expected QA-window artifacts
   * (architect A1).
   */
  qaApprovedTreeId: string;
  /** Repo-relative slice directory the QA evaluator legitimately writes. */
  reviewArtifactDir: string;
  /** Exact orchestrator-written bytes (path → blob ID) from applied scope amendments. */
  orchestratorAuthorizedBlobs?: Readonly<Record<string, string>>;
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
      ...(args.orchestratorAuthorizedBlobs
        ? { orchestratorAuthorizedBlobs: args.orchestratorAuthorizedBlobs }
        : {}),
    });
    if (violations.length > 0) {
      return {
        action: "ERROR",
        error:
          `Post-QA candidate tree ${checkpoint.treeId} differs from the ` +
          `QA-approved tree ${args.qaApprovedTreeId} beyond the expected ` +
          `QA-window artifacts (${args.reviewArtifactDir}/): ` +
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

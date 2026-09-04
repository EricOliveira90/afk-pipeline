import { relative } from "node:path";
import {
  runGates,
  verifyGateEvidence,
  type GateDeclaration,
  type GateEvidence,
  type GateEvidenceArtifact,
  type GateResult,
} from "./gate-runner.js";

export interface CandidateGatePhaseResult {
  evidence: GateEvidence;
  evidencePath: string;
  attempts: Array<{ evidence: GateEvidence; evidencePath: string }>;
  artifacts: GateEvidenceArtifact[];
}

export interface CandidateGateOutcome {
  attemptId: string;
  gateId: string;
  stage: GateResult["stage"];
  status: GateResult["status"];
  failureKind: GateResult["failureKind"];
  startedAt: string;
  endedAt: string;
  durationMs: number;
  exitCode: number | null;
  treeId: string;
  evidenceArtifactId: string;
  logArtifactId: string;
}

/**
 * Run one candidate gate phase with bounded infrastructure retries and emit
 * the evidence metadata that the run journal records.
 */
export async function runCandidateGatePhase(args: {
  repoRoot: string;
  ghIssue: string;
  sliceNumber: string;
  tag: string;
  round: number;
  treeId: string;
  cwd: string;
  evidenceDir: string;
  declarations: readonly GateDeclaration[];
  prepare?: GateDeclaration;
  label: string;
  signal?: AbortSignal;
  infrastructureRetries: number;
  inactivityTimeoutMs: number;
  wallClockTimeoutMs: number;
  heartbeatIntervalMs: number;
  onGateOutcome: (outcome: CandidateGateOutcome) => void;
  onInfrastructureRetry: (message: string) => void;
}): Promise<CandidateGatePhaseResult> {
  const {
    repoRoot,
    ghIssue,
    sliceNumber,
    tag,
    round,
    treeId,
    cwd,
    evidenceDir,
    declarations,
    prepare,
    label,
    signal,
    infrastructureRetries,
    inactivityTimeoutMs,
    wallClockTimeoutMs,
    heartbeatIntervalMs,
    onGateOutcome,
    onInfrastructureRetry,
  } = args;
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
  let evidence: GateEvidence | undefined;
  let evidencePath = "";
  const attempts: CandidateGatePhaseResult["attempts"] = [];
  const artifacts: GateEvidenceArtifact[] = [];

  for (
    let gateAttempt = 1;
    gateAttempt <= infrastructureRetries + 1;
    gateAttempt++
  ) {
    const gateRun = await runGates({
      treeId,
      cwd,
      evidenceDir,
      declarations,
      ...(prepare ? { prepare } : {}),
      signal,
      inactivityTimeoutMs,
      wallClockTimeoutMs,
      heartbeatIntervalMs,
      onOutput: (_gateId, text) => process.stderr.write(text),
    });
    evidencePath = gateRun.evidencePath;
    artifacts.push(gateRun.artifact);
    evidence = verifyGateEvidence(gateRun.artifact);
    attempts.push({ evidence, evidencePath });
    const evidenceArtifactId = relative(repoRoot, evidencePath).replace(
      /\\/g,
      "/",
    );
    for (const result of evidence.results) {
      onGateOutcome({
        attemptId: evidence.attemptId,
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
    const infrastructureFailure = evidence.results.some(
      (gate) =>
        isRequired(gate.gateId) && gate.status === "INFRASTRUCTURE",
    );
    if (!infrastructureFailure || signal?.aborted) break;
    if (gateAttempt <= infrastructureRetries) {
      onInfrastructureRetry(
        `${tag}: ${label} infrastructure retry ${gateAttempt}/${infrastructureRetries}`,
      );
    }
  }

  if (!evidence) {
    throw new Error(
      `${label} for #${ghIssue} slice ${sliceNumber} produced no evidence`,
    );
  }
  return { evidence, evidencePath, attempts, artifacts };
}

export function assertGateEvidenceReleasesEvaluation(
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

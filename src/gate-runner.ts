import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { runBoundedCommand } from "./command-runtime.js";
import { createCandidateCheckpointRestorer } from "./git.js";

export const GATE_EVIDENCE_VERSION = 1;

export type GateStatus = "PASS" | "FAIL" | "INFRASTRUCTURE" | "SKIPPED";
export type GateFailureKind = "CONFIGURATION" | "IMPLEMENTATION" | null;

export interface GateDeclaration {
  id: string;
  stage: string;
  required: boolean;
  command?: string;
  args?: readonly string[];
}

export interface GateResult {
  gateId: string;
  stage: string;
  status: GateStatus;
  failureKind: GateFailureKind;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  exitCode: number | null;
  treeId: string;
  logArtifactId: string;
  detail?: string;
}

export interface GateEvidence {
  version: typeof GATE_EVIDENCE_VERSION;
  attemptId: string;
  treeId: string;
  results: GateResult[];
}

export interface RunGatesOptions {
  treeId: string;
  cwd: string;
  evidenceDir: string;
  declarations: readonly GateDeclaration[];
  signal?: AbortSignal;
  inactivityTimeoutMs: number;
  wallClockTimeoutMs: number;
  heartbeatIntervalMs: number;
  onOutput?: (gateId: string, text: string) => void;
}

export interface RunGatesResult {
  evidence: GateEvidence;
  evidencePath: string;
}

export async function runGates(
  options: RunGatesOptions,
): Promise<RunGatesResult> {
  const attemptId = randomUUID();
  mkdirSync(options.evidenceDir, { recursive: true });
  const logsDir = join(options.evidenceDir, "gate-logs");
  mkdirSync(logsDir, { recursive: true });
  const results: GateResult[] = [];
  let restoreCheckpoint: (() => void) | undefined;
  let checkpointError: string | undefined;
  if (existsSync(options.cwd)) {
    try {
      restoreCheckpoint = createCandidateCheckpointRestorer(
        options.cwd,
        options.treeId,
      );
    } catch (error) {
      checkpointError =
        error instanceof Error ? error.message : String(error);
    }
  }

  for (const [index, declaration] of options.declarations.entries()) {
    const safeId =
      declaration.id.replace(/[^a-zA-Z0-9._-]/g, "_") ||
      `gate-${index + 1}`;
    const logArtifactId = join(
      "gate-logs",
      `${attemptId}-${String(index + 1).padStart(3, "0")}-${safeId}.log`,
    );
    const logPath = join(options.evidenceDir, logArtifactId);
    const emit = (text: string) => {
      appendFileSync(logPath, text);
      options.onOutput?.(declaration.id, text);
    };
    emit(`[gate:${declaration.id}] START\n`);

    const invalid =
      declaration.id.trim() === "" ||
      declaration.stage.trim() === "" ||
      declaration.command?.trim() === "";
    if (invalid || declaration.command == null) {
      const now = new Date().toISOString();
      const status =
        !invalid && !declaration.required ? "SKIPPED" : "FAIL";
      const result: GateResult = {
        gateId: declaration.id,
        stage: declaration.stage,
        status,
        failureKind: status === "FAIL" ? "CONFIGURATION" : null,
        startedAt: now,
        endedAt: now,
        durationMs: 0,
        exitCode: null,
        treeId: options.treeId,
        logArtifactId,
        detail:
          status === "SKIPPED"
            ? "Optional gate has no command"
            : "Invalid required gate declaration",
      };
      emit(`[gate:${declaration.id}] ${result.status} (0ms)\n`);
      results.push(result);
      continue;
    }

    if (!existsSync(options.cwd)) {
      const now = new Date().toISOString();
      const result: GateResult = {
        gateId: declaration.id,
        stage: declaration.stage,
        status: "INFRASTRUCTURE",
        failureKind: null,
        startedAt: now,
        endedAt: now,
        durationMs: 0,
        exitCode: null,
        treeId: options.treeId,
        logArtifactId,
        detail: `Gate working directory is unavailable: ${options.cwd}`,
      };
      emit(`[gate:${declaration.id}] INFRASTRUCTURE (0ms)\n`);
      results.push(result);
      break;
    }

    if (checkpointError || !restoreCheckpoint) {
      const now = new Date().toISOString();
      const result: GateResult = {
        gateId: declaration.id,
        stage: declaration.stage,
        status: "INFRASTRUCTURE",
        failureKind: null,
        startedAt: now,
        endedAt: now,
        durationMs: 0,
        exitCode: null,
        treeId: options.treeId,
        logArtifactId,
        detail: checkpointError ?? "Gate checkpoint is unavailable",
      };
      emit(`[gate:${declaration.id}] INFRASTRUCTURE (0ms)\n`);
      results.push(result);
      break;
    }

    try {
      restoreCheckpoint();
    } catch (error) {
      const now = new Date().toISOString();
      const detail = error instanceof Error ? error.message : String(error);
      const result: GateResult = {
        gateId: declaration.id,
        stage: declaration.stage,
        status: "INFRASTRUCTURE",
        failureKind: null,
        startedAt: now,
        endedAt: now,
        durationMs: 0,
        exitCode: null,
        treeId: options.treeId,
        logArtifactId,
        detail,
      };
      emit(`[gate:${declaration.id}] INFRASTRUCTURE (0ms)\n`);
      results.push(result);
      break;
    }

    const execution = await runBoundedCommand(
      declaration.command,
      declaration.args ?? [],
      {
        cwd: options.cwd,
        signal: options.signal,
        inactivityTimeoutMs: options.inactivityTimeoutMs,
        wallClockTimeoutMs: options.wallClockTimeoutMs,
        heartbeatIntervalMs: options.heartbeatIntervalMs,
        onOutput: emit,
      },
    );
    try {
      restoreCheckpoint();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const result: GateResult = {
        gateId: declaration.id,
        stage: declaration.stage,
        status: "INFRASTRUCTURE",
        failureKind: null,
        startedAt: execution.startedAt,
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - Date.parse(execution.startedAt),
        exitCode: null,
        treeId: options.treeId,
        logArtifactId,
        detail,
      };
      emit(
        `[gate:${declaration.id}] INFRASTRUCTURE (${result.durationMs}ms)\n`,
      );
      results.push(result);
      break;
    }
    const classification = classifyExecution(
      execution.outcome,
      execution.exitCode,
      execution.errorCode,
    );
    const result: GateResult = {
      gateId: declaration.id,
      stage: declaration.stage,
      status: classification.status,
      failureKind: classification.failureKind,
      startedAt: execution.startedAt,
      endedAt: execution.endedAt,
      durationMs: execution.durationMs,
      exitCode: execution.exitCode,
      treeId: options.treeId,
      logArtifactId,
      ...(execution.detail ? { detail: execution.detail } : {}),
    };
    emit(
      `[gate:${declaration.id}] ${result.status} (${result.durationMs}ms)\n`,
    );
    results.push(result);
    if (execution.outcome === "CANCELLED") break;
  }

  const evidence: GateEvidence = {
    version: GATE_EVIDENCE_VERSION,
    attemptId,
    treeId: options.treeId,
    results,
  };
  const evidencePath = join(options.evidenceDir, `gate-attempt-${attemptId}.json`);
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + "\n", {
    encoding: "utf-8",
    flag: "wx",
  });
  return { evidence, evidencePath };
}

export function readGateEvidence(path: string): GateEvidence {
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
  if (!isRecord(parsed) || !("version" in parsed)) {
    throw new Error("Missing gate evidence version");
  }
  if (parsed.version !== GATE_EVIDENCE_VERSION) {
    throw new Error(`Unsupported gate evidence version: ${String(parsed.version)}`);
  }
  if (
    typeof parsed.attemptId !== "string" ||
    typeof parsed.treeId !== "string" ||
    !Array.isArray(parsed.results) ||
    !parsed.results.every(isGateResult)
  ) {
    throw new Error("Invalid gate evidence");
  }
  return parsed as unknown as GateEvidence;
}

function classifyExecution(
  outcome:
    | "EXITED"
    | "SPAWN_ERROR"
    | "CANCELLED"
    | "INACTIVITY_TIMEOUT"
    | "WALL_CLOCK_TIMEOUT",
  exitCode: number | null,
  errorCode?: string,
): Pick<GateResult, "status" | "failureKind"> {
  if (outcome === "EXITED") {
    return exitCode === 0
      ? { status: "PASS", failureKind: null }
      : { status: "FAIL", failureKind: "IMPLEMENTATION" };
  }
  if (outcome === "INACTIVITY_TIMEOUT" || outcome === "WALL_CLOCK_TIMEOUT") {
    return { status: "FAIL", failureKind: "IMPLEMENTATION" };
  }
  if (outcome === "SPAWN_ERROR" && errorCode === "ENOENT") {
    return { status: "FAIL", failureKind: "CONFIGURATION" };
  }
  return { status: "INFRASTRUCTURE", failureKind: null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isGateResult(value: unknown): value is GateResult {
  if (!isRecord(value)) return false;
  return (
    typeof value.gateId === "string" &&
    typeof value.stage === "string" &&
    ["PASS", "FAIL", "INFRASTRUCTURE", "SKIPPED"].includes(
      String(value.status),
    ) &&
    [null, "CONFIGURATION", "IMPLEMENTATION"].includes(
      value.failureKind as null | string,
    ) &&
    typeof value.startedAt === "string" &&
    typeof value.endedAt === "string" &&
    typeof value.durationMs === "number" &&
    (value.exitCode === null || typeof value.exitCode === "number") &&
    typeof value.treeId === "string" &&
    typeof value.logArtifactId === "string"
  );
}

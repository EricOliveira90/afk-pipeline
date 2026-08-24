import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { runBoundedCommand } from "./command-runtime.js";
import { resolveCommit, resolveTree } from "./git.js";

export const GATE_EVIDENCE_VERSION = 1;

export type GateStatus = "PASS" | "FAIL" | "INFRASTRUCTURE" | "SKIPPED";
export type GateFailureKind = "COMMAND" | "CONFIGURATION" | null;

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
  artifact: GateEvidenceArtifact;
}

export interface GateEvidenceArtifact {
  evidencePath: string;
  evidenceSha256: string;
  attemptId: string;
  treeId: string;
  declarations: readonly {
    gateId: string;
    stage: string;
    required: boolean;
  }[];
  logs: readonly {
    logArtifactId: string;
    path: string;
    sha256: string;
  }[];
}

export interface CandidateCheckpoint {
  commitSha: string;
  treeId: string;
  worktreeDir?: string;
}

export interface MaterializedCandidateCheckpoint extends CandidateCheckpoint {
  worktreeDir: string;
}

/**
 * Capture the current candidate without moving the source branch. A temporary
 * index includes tracked and untracked output while leaving the generator
 * worktree and its real index untouched.
 */
export function createCandidateCheckpoint(
  cwd: string,
  worktreeDir: string,
): MaterializedCandidateCheckpoint;
export function createCandidateCheckpoint(
  cwd: string,
  worktreeDir: string,
  options: { materialize: false },
): CandidateCheckpoint;
export function createCandidateCheckpoint(
  cwd: string,
  worktreeDir: string,
  options: { materialize?: boolean } = {},
): CandidateCheckpoint | MaterializedCandidateCheckpoint {
  if (existsSync(worktreeDir)) {
    throw new Error(`Candidate checkpoint path already exists: ${worktreeDir}`);
  }

  const baseCommit = resolveCommit(cwd, "HEAD");
  const baseTree = resolveTree(cwd, "HEAD");
  if (!baseCommit || !baseTree) {
    throw new Error("Cannot checkpoint a candidate without a committed HEAD");
  }

  const indexDir = mkdtempSync(join(tmpdir(), "afk-checkpoint-index-"));
  const env = {
    ...process.env,
    GIT_INDEX_FILE: join(indexDir, "index"),
  };
  let commitSha = baseCommit;
  let treeId = baseTree;
  try {
    execFileSync("git", ["read-tree", baseCommit], { cwd, env });
    execFileSync("git", ["add", "-A"], { cwd, env });
    treeId = execFileSync("git", ["write-tree"], {
      cwd,
      env,
      encoding: "utf-8",
    }).trim();
    if (treeId !== baseTree) {
      commitSha = execFileSync(
        "git",
        ["commit-tree", treeId, "-p", baseCommit, "-m", "AFK candidate checkpoint"],
        { cwd, encoding: "utf-8" },
      ).trim();
    }
  } finally {
    rmSync(indexDir, { recursive: true, force: true });
  }

  if (options.materialize === false) {
    return { commitSha, treeId };
  }

  mkdirSync(dirname(worktreeDir), { recursive: true });
  execFileSync("git", ["worktree", "add", "--detach", worktreeDir, commitSha], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return { commitSha, treeId, worktreeDir };
}

export async function runGates(
  options: RunGatesOptions,
): Promise<RunGatesResult> {
  const attemptId = randomUUID();
  const attemptKey = attemptId.replace(/-/g, "").slice(0, 12);
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
      declaration.id.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 24) ||
      `gate-${index + 1}`;
    const logArtifactId = join(
      "gate-logs",
      `${attemptKey}-${String(index + 1).padStart(2, "0")}-${safeId}.log`,
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
    if (execution.outcome === "CANCELLED") break;

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
        exitCode: execution.exitCode,
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
  }

  const evidence: GateEvidence = {
    version: GATE_EVIDENCE_VERSION,
    attemptId,
    treeId: options.treeId,
    results,
  };
  const evidencePath = join(options.evidenceDir, `attempt-${attemptKey}.json`);
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + "\n", {
    encoding: "utf-8",
    flag: "wx",
  });
  const artifact: GateEvidenceArtifact = {
    evidencePath,
    evidenceSha256: sha256(readFileSync(evidencePath)),
    attemptId,
    treeId: options.treeId,
    declarations: options.declarations.map((declaration) => ({
      gateId: declaration.id,
      stage: declaration.stage,
      required: declaration.required,
    })),
    logs: results.map((result) => {
      const path = join(options.evidenceDir, result.logArtifactId);
      return {
        logArtifactId: result.logArtifactId,
        path,
        sha256: sha256(readFileSync(path)),
      };
    }),
  };
  return { evidence, evidencePath, artifact };
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
    parsed.attemptId.trim() === "" ||
    typeof parsed.treeId !== "string" ||
    !Array.isArray(parsed.results) ||
    !parsed.results.every(isGateResult)
  ) {
    throw new Error("Invalid gate evidence");
  }
  const evidence = parsed as unknown as GateEvidence;
  if (
    evidence.results.some((result) => result.treeId !== evidence.treeId) ||
    new Set(evidence.results.map((result) => result.gateId)).size !==
      evidence.results.length ||
    new Set(evidence.results.map((result) => result.logArtifactId)).size !==
      evidence.results.length
  ) {
    throw new Error("Invalid gate evidence");
  }
  return evidence;
}

/**
 * Revalidate bytes retained by the orchestrator, not only their JSON shape.
 * The digest reference stays in process memory while agents can write files.
 */
export function verifyGateEvidence(
  artifact: GateEvidenceArtifact,
): GateEvidence {
  if (
    !existsSync(artifact.evidencePath) ||
    sha256(readFileSync(artifact.evidencePath)) !== artifact.evidenceSha256
  ) {
    throw new Error(
      `Gate evidence integrity check failed: ${artifact.evidencePath}`,
    );
  }
  const evidence = readGateEvidence(artifact.evidencePath);
  if (
    evidence.attemptId !== artifact.attemptId ||
    evidence.treeId !== artifact.treeId ||
    evidence.results.length > artifact.declarations.length
  ) {
    throw new Error(
      `Gate evidence checkpoint binding failed: ${artifact.evidencePath}`,
    );
  }

  for (const [index, result] of evidence.results.entries()) {
    const declaration = artifact.declarations[index];
    const log = artifact.logs[index];
    if (
      !declaration ||
      declaration.gateId !== result.gateId ||
      declaration.stage !== result.stage ||
      !log ||
      log.logArtifactId !== result.logArtifactId
    ) {
      throw new Error(
        `Gate evidence declaration binding failed: ${artifact.evidencePath}`,
      );
    }
    if (!existsSync(log.path) || sha256(readFileSync(log.path)) !== log.sha256) {
      throw new Error(`Gate log integrity check failed: ${log.path}`);
    }
  }
  return evidence;
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
      : { status: "FAIL", failureKind: "COMMAND" };
  }
  if (outcome === "INACTIVITY_TIMEOUT" || outcome === "WALL_CLOCK_TIMEOUT") {
    return { status: "FAIL", failureKind: "COMMAND" };
  }
  if (outcome === "SPAWN_ERROR" && errorCode === "ENOENT") {
    return { status: "FAIL", failureKind: "CONFIGURATION" };
  }
  return { status: "INFRASTRUCTURE", failureKind: null };
}

function createCandidateCheckpointRestorer(
  cwd: string,
  expectedTreeId: string,
): () => void {
  const commitSha = resolveCommit(cwd, "HEAD");
  const treeId = resolveTree(cwd, "HEAD");
  if (!commitSha || treeId !== expectedTreeId) {
    throw new Error(
      `Gate checkout tree does not match checkpoint ${expectedTreeId}`,
    );
  }

  return () => {
    execFileSync("git", ["reset", "--hard", commitSha], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    execFileSync("git", ["clean", "-fdx"], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (resolveTree(cwd, "HEAD") !== expectedTreeId) {
      throw new Error(
        `Could not restore gate checkout to checkpoint ${expectedTreeId}`,
      );
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isGateResult(value: unknown): value is GateResult {
  if (!isRecord(value)) return false;
  const status = String(value.status);
  const failureKind = value.failureKind as null | string;
  const startedAt = Date.parse(String(value.startedAt));
  const endedAt = Date.parse(String(value.endedAt));
  return (
    typeof value.gateId === "string" &&
    value.gateId.trim() !== "" &&
    typeof value.stage === "string" &&
    value.stage.trim() !== "" &&
    ["PASS", "FAIL", "INFRASTRUCTURE", "SKIPPED"].includes(status) &&
    [null, "COMMAND", "CONFIGURATION"].includes(
      failureKind,
    ) &&
    (status === "FAIL"
      ? failureKind !== null
      : failureKind === null) &&
    typeof value.startedAt === "string" &&
    typeof value.endedAt === "string" &&
    Number.isFinite(startedAt) &&
    Number.isFinite(endedAt) &&
    endedAt >= startedAt &&
    typeof value.durationMs === "number" &&
    Number.isFinite(value.durationMs) &&
    value.durationMs >= 0 &&
    (value.exitCode === null || typeof value.exitCode === "number") &&
    typeof value.treeId === "string" &&
    typeof value.logArtifactId === "string" &&
    isSafeLogArtifactId(value.logArtifactId)
  );
}

function isSafeLogArtifactId(value: string): boolean {
  const normalized = value.replace(/\\/g, "/");
  return (
    normalized.startsWith("gate-logs/") &&
    !isAbsolute(value) &&
    !normalized.split("/").includes("..")
  );
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

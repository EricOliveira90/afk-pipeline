import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { runBoundedCommand } from "./command-runtime.js";
import { resolveCommit, resolveTree } from "./git.js";
import type { GateRiskClass } from "./gate-policy.js";

/**
 * Bumped 1 → 2 for {@link GateFindings} (`prd.md` D22). Additive and
 * backward-readable: {@link readGateEvidence} still accepts a version-1
 * document, and refuses one that carries `findings` — only version 2 may.
 */
export const GATE_EVIDENCE_VERSION = 2;

/** Every evidence version a reader in this process accepts. */
const SUPPORTED_GATE_EVIDENCE_VERSIONS = [1, 2] as const;

export type GateEvidenceVersion =
  (typeof SUPPORTED_GATE_EVIDENCE_VERSIONS)[number];

export type GateStatus = "PASS" | "FAIL" | "INFRASTRUCTURE" | "SKIPPED";
export type GateFailureKind = "COMMAND" | "CONFIGURATION" | null;

/**
 * What an in-process gate reports. Structured, not prose: `detail` is
 * human-facing and nothing parses it, while `findings` is the machine-readable
 * half a later round or an operator surface reads.
 */
export interface GateRunOutcome {
  status: GateStatus;
  failureKind?: GateFailureKind;
  detail?: string;
  findings?: GateFindings;
}

/**
 * The typed payload a content-derived gate names its offenders in
 * (`prd.md` D22). All four fields are declared in this one version bump so
 * evidence version 2 has a single shape regardless of the order the gates
 * that populate them ship in: the file-scope gate populates
 * `outOfScopePaths`, and `deletedTests` / `protectedChanges` /
 * `appliedWaivers` stay typed and unpopulated until the feedback-integrity
 * gate lands (#193).
 *
 * `riskClass` is `GateRiskClass` and not a bare `string` on purpose: a
 * persisted waiver naming a class the policy reader refuses would be a record
 * nothing can act on.
 */
export interface GateFindings {
  outOfScopePaths?: readonly string[];
  deletedTests?: readonly string[];
  protectedChanges?: readonly string[];
  appliedWaivers?: readonly {
    riskClass: GateRiskClass;
    path: string;
    author: string;
    reason: string;
  }[];
}

export interface GateDeclaration {
  id: string;
  stage: string;
  required: boolean;
  command?: string;
  args?: readonly string[];
  /**
   * An in-process check, for a gate that needs no toolchain and no working
   * directory — a comparison the orchestrator can make itself. Exactly one of
   * `command` and `run` may be supplied; see {@link classifyDeclaration}.
   */
  run?: (ctx: {
    treeId: string;
    cwd: string;
    signal?: AbortSignal;
  }) => GateRunOutcome | Promise<GateRunOutcome>;
  /** Project policy's expected wall-clock cost, for budgeting/reporting. */
  expectedCostMs?: number;
  /** Per-gate wall-clock ceiling; falls back to the phase default. */
  wallClockTimeoutMs?: number;
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
  findings?: GateFindings;
}

export interface GateEvidence {
  version: GateEvidenceVersion;
  attemptId: string;
  treeId: string;
  results: GateResult[];
}

export interface RunGatesOptions {
  treeId: string;
  cwd: string;
  evidenceDir: string;
  declarations: readonly GateDeclaration[];
  /**
   * Dependency install that makes the declarations runnable at all. A
   * candidate checkpoint is materialized from a git tree, so it carries
   * tracked files only and never `node_modules` — without this every
   * `pnpm run` exits instantly and the gate reads a missing toolchain as a
   * red suite (#101, and the same bug on the per-round path). Runs once
   * before the gates and outside the evidence declarations. Its failure is
   * classified by who can fix it. Two things the candidate owns are recorded
   * as FAIL/CONFIGURATION against every declaration for the generator to
   * repair: a lockfile that no longer matches its `package.json`, and a
   * lifecycle script of its own (`prepare` running the project's compiler)
   * that exited non-zero — both fail deterministically for a given tree, so
   * an identical retry can only fail identically. Environment faults (`pnpm`
   * absent, network, registry, timeout) are INFRASTRUCTURE, so the
   * orchestrator's retry applies instead of blaming the generator. ADR 0041
   * records why the tie is broken toward the branch that cannot loop.
   */
  prepare?: GateDeclaration;
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
 * Hash the candidate exactly as {@link createCandidateCheckpoint} would —
 * tracked plus untracked output, through a throwaway index so the source
 * worktree's own index is untouched — without materializing anything.
 *
 * Two callers need the same answer for opposite reasons: the checkpoint needs
 * a tree to build a gate worktree from, and the QA-dedup skip authorization
 * needs to prove the tree it is handing an evaluator is byte-identical to the
 * one the gates ran on (ADR 0012's 2026-08-28 amendment). Sharing one
 * implementation is the point: a second way of hashing the candidate would let
 * the two disagree, and the authorization would then be asserting something
 * about a tree nobody tested.
 */
export function resolveCandidateTreeId(cwd: string): string {
  return readCandidateTree(cwd).treeId;
}

interface CandidateTree {
  baseCommit: string;
  baseTree: string;
  treeId: string;
}

function readCandidateTree(cwd: string): CandidateTree {
  let candidateBase: string[];
  try {
    candidateBase = execFileSync(
      "git",
      ["rev-parse", "HEAD^{commit}", "HEAD^{tree}", "--git-path", "index"],
      {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      },
    )
      .trim()
      .split(/\r?\n/);
  } catch {
    throw new Error("Cannot checkpoint a candidate without a committed HEAD");
  }
  const [baseCommit, baseTree, sourceIndexPath] = candidateBase;
  if (!baseCommit || !baseTree || !sourceIndexPath) {
    throw new Error("Cannot checkpoint a candidate without a committed HEAD");
  }

  const indexDir = mkdtempSync(join(tmpdir(), "afk-checkpoint-index-"));
  const indexPath = join(indexDir, "index");
  const env = {
    ...process.env,
    GIT_INDEX_FILE: indexPath,
  };
  try {
    copyFileSync(resolve(cwd, sourceIndexPath), indexPath);
    execFileSync("git", ["add", "-A"], { cwd, env });
    const treeId = execFileSync("git", ["write-tree"], {
      cwd,
      env,
      encoding: "utf-8",
    }).trim();
    return { baseCommit, baseTree, treeId };
  } finally {
    rmSync(indexDir, { recursive: true, force: true });
  }
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

  const { baseCommit, baseTree, treeId } = readCandidateTree(cwd);
  let commitSha = baseCommit;
  if (treeId !== baseTree) {
    commitSha = execFileSync(
      "git",
      ["commit-tree", treeId, "-p", baseCommit, "-m", "AFK candidate checkpoint"],
      { cwd, encoding: "utf-8" },
    ).trim();
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

/**
 * pnpm's marker for a lockfile that no longer matches `package.json` under
 * `--frozen-lockfile`. For a given tree the failure is deterministic — the
 * candidate itself is what is broken — so it is routed to the generator as a
 * gate FAIL rather than to the infrastructure retry, which would re-run the
 * identical install against the identical tree forever (ADR 0036).
 */
const LOCKFILE_DRIFT_MARKER = /ERR_PNPM_OUTDATED_LOCKFILE/;

/**
 * Exit code a package manager reserves for its own install failures, and the
 * one exit code that therefore cannot be blamed on the candidate.
 *
 * pnpm reports what it did itself — lockfile drift, a registry or network
 * fault, an unresolvable version — by printing an `ERR_PNPM_*` code and
 * exiting 1, but it reports a failing *lifecycle script* by propagating that
 * script's own exit code. Measured 2026-08-28 with the pnpm on this machine: a
 * `prepare` script exiting 3 makes `pnpm install` exit 3, while a refused
 * registry (`ERR_PNPM_META_FETCH_FAIL`) and lockfile drift
 * (`ERR_PNPM_OUTDATED_LOCKFILE`) both exit 1. The #120 incident's `prepare`
 * ran `tsc`, which exits 2 when it emits with errors — recorded in the
 * evidence as `(EXITED, exit 2)`.
 *
 * So a prepare that exits non-zero with anything other than this code ran a
 * lifecycle script from the candidate's own `package.json` and that script
 * failed. Keying on the code rather than on message text means the rule does
 * not have to be kept in step with a package manager's wording, and it is
 * narrow: everything that fails *before* lifecycle scripts run — fetch,
 * network, registry — exits 1 and stays INFRASTRUCTURE (ADR 0041).
 */
const PACKAGE_MANAGER_ERROR_EXIT_CODE = 1;

/**
 * How much prepare output is retained for classification and the failure
 * detail. A tail window bounds memory on chatty installs while keeping the
 * error block, which pnpm prints last.
 */
const PREPARE_OUTPUT_WINDOW = 65_536;

/** Last few non-empty output lines, flattened onto one line. */
function outputTail(output: string, maxLines = 5, maxChars = 500): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const tail = lines.slice(-maxLines).join(" | ");
  return tail.length > maxChars ? `${tail.slice(0, maxChars)}…` : tail;
}

/**
 * Which of the four shapes one declaration is, resolved once so the loop
 * cannot read `command` and `run` as independent options.
 *
 * A declaration supplies **either** `command` or `run`. Supplying both is as
 * invalid as a blank id — two answers to "how does this gate run" is a
 * configuration defect, not a preference. Supplying neither keeps today's
 * split exactly, and that split is load-bearing rather than tidy:
 * `projectSanityGateDeclarations` derives `{ id: "lint", stage: "base",
 * required: false }` with no command for a project with no lint script, and
 * `src/adopt-command.ts` counts that gate as passing only while its status is
 * `SKIPPED` (`prd.md` D22, corrected 2026-09-08).
 */
type GateDeclarationShape =
  | { kind: "invalid" }
  | { kind: "undeclared" }
  | { kind: "in-process"; run: NonNullable<GateDeclaration["run"]> }
  | { kind: "command"; command: string; args: readonly string[] };

function classifyDeclaration(
  declaration: GateDeclaration,
): GateDeclarationShape {
  const { command, run } = declaration;
  if (
    declaration.id.trim() === "" ||
    declaration.stage.trim() === "" ||
    command?.trim() === "" ||
    (command != null && run != null)
  ) {
    return { kind: "invalid" };
  }
  if (run != null) return { kind: "in-process", run };
  if (command == null) return { kind: "undeclared" };
  return { kind: "command", command, args: declaration.args ?? [] };
}

export async function runGates(
  options: RunGatesOptions,
): Promise<RunGatesResult> {  const attemptId = randomUUID();
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

  // Prepare the environment inside the checkpoint before any gate runs. A
  // failure here is classified by who can fix it, and the test is whether a
  // retry could plausibly change the result. Two failures are the
  // candidate's: a `pnpm-lock.yaml` that no longer matches its
  // `package.json`, and a lifecycle script of the candidate's own that
  // exited non-zero (see `PACKAGE_MANAGER_ERROR_EXIT_CODE`). Both are
  // deterministic for a given tree — an infrastructure retry re-runs the
  // identical install against the identical tree and can never succeed (the
  // ADR 0036 anti-pattern) — so they become `prepareFailure` and the loop
  // below records that as FAIL/CONFIGURATION against every declaration,
  // routing the repair to the generator, which is the only actor able to
  // change the tree. Everything that fails before lifecycle scripts run
  // (`pnpm` absent, network, registry, timeout) is an environment fault: it
  // joins `checkpointError`, which the loop below records as INFRASTRUCTURE
  // against the first declaration it reaches and then stops, leaving the
  // orchestrator's retry to apply. ADR 0041 has the reasoning and the known
  // residual case (a lifecycle script that itself exits 1).
  const prepareCommand = options.prepare?.command;
  let prepareFailure: string | undefined;
  if (options.prepare && prepareCommand && restoreCheckpoint && !checkpointError) {
    const prepare = options.prepare;
    const logPath = join(
      logsDir,
      `${attemptKey}-00-${
        prepare.id.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 24) || "prepare"
      }.log`,
    );
    let captured = "";
    const emit = (text: string) => {
      captured = (captured + text).slice(-PREPARE_OUTPUT_WINDOW);
      appendFileSync(logPath, text);
      options.onOutput?.(prepare.id, text);
    };
    emit(`[gate:${prepare.id}] START\n`);
    try {
      restoreCheckpoint();
      const execution = await runBoundedCommand(
        prepareCommand,
        prepare.args ?? [],
        {
          cwd: options.cwd,
          signal: options.signal,
          inactivityTimeoutMs: options.inactivityTimeoutMs,
          wallClockTimeoutMs: options.wallClockTimeoutMs,
          heartbeatIntervalMs: options.heartbeatIntervalMs,
          onOutput: emit,
        },
      );
      if (
        execution.outcome !== "CANCELLED" &&
        (execution.outcome !== "EXITED" || execution.exitCode !== 0)
      ) {
        const summary =
          `Gate environment preparation failed: ` +
          `${[prepare.command, ...(prepare.args ?? [])].join(" ")} ` +
          `(${execution.outcome}, exit ${String(execution.exitCode)})`;
        const tail = outputTail(captured);
        const candidateFailure = (cause: string) =>
          `${summary}: ${cause}` + (tail ? ` — ${tail}` : "");
        if (
          execution.outcome === "EXITED" &&
          LOCKFILE_DRIFT_MARKER.test(captured)
        ) {
          prepareFailure = candidateFailure(
            `the candidate's pnpm-lock.yaml does not match its ` +
              `package.json (ERR_PNPM_OUTDATED_LOCKFILE)`,
          );
        } else if (
          execution.outcome === "EXITED" &&
          execution.exitCode !== null &&
          execution.exitCode !== PACKAGE_MANAGER_ERROR_EXIT_CODE
        ) {
          prepareFailure = candidateFailure(
            `a package lifecycle script in the candidate exited ` +
              `${String(execution.exitCode)} (the exit code the package ` +
              `manager propagates from a script such as \`prepare\` running ` +
              `the project's compiler), so the candidate's own tree is what ` +
              `needs repair`,
          );
        } else {
          checkpointError = summary;
        }
      }
      emit(
        `[gate:${prepare.id}] ${
          checkpointError
            ? "INFRASTRUCTURE"
            : prepareFailure
              ? "FAIL"
              : "PASS"
        } (${execution.durationMs}ms)\n`,
      );
    } catch (error) {
      checkpointError = error instanceof Error ? error.message : String(error);
      emit(`[gate:${prepare.id}] INFRASTRUCTURE (0ms)\n`);
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

    const shape = classifyDeclaration(declaration);
    if (shape.kind === "invalid" || shape.kind === "undeclared") {
      const now = new Date().toISOString();
      const status =
        shape.kind === "undeclared" && !declaration.required
          ? "SKIPPED"
          : "FAIL";
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

    // --- The in-process gate, ahead of the three command-path preconditions
    // below (`prd.md` D22). It needs none of them: there is no working
    // directory to test, no toolchain to prepare and nothing to restore
    // between runs — and a post-QA checkpoint captured with
    // `materialize: false` has no directory at all, so testing `options.cwd`
    // first would record INFRASTRUCTURE for a check that never touches it.
    if (shape.kind === "in-process") {
      // Same rule as the command path's CANCELLED break: a cancelled run
      // records nothing rather than inventing a result (`:543`).
      if (options.signal?.aborted) break;
      const startedAtMs = Date.now();
      const startedAt = new Date(startedAtMs).toISOString();
      let outcome: GateRunOutcome;
      try {
        outcome = await shape.run({
          treeId: options.treeId,
          cwd: options.cwd,
          ...(options.signal ? { signal: options.signal } : {}),
        });
      } catch (error) {
        // INFRASTRUCTURE, not FAIL: the checks that throw here throw because
        // they could not read the world (a tree that cannot be diffed, a
        // manifest that cannot be parsed), and no generator edit repairs
        // that. This is the branch that cannot loop, so it goes to the
        // bounded retry and then to the operator (ADR 0041).
        outcome = {
          status: "INFRASTRUCTURE",
          failureKind: null,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
      const endedAtMs = Date.now();
      // Before the status line, so the paths a red gate names travel in the
      // log the repair round receives as a reference.
      if (outcome.detail != null && outcome.detail !== "") {
        emit(`${outcome.detail}\n`);
      }
      const result: GateResult = {
        gateId: declaration.id,
        stage: declaration.stage,
        status: outcome.status,
        failureKind: outcome.failureKind ?? null,
        startedAt,
        endedAt: new Date(endedAtMs).toISOString(),
        durationMs: endedAtMs - startedAtMs,
        exitCode: null,
        treeId: options.treeId,
        logArtifactId,
        ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
        ...(outcome.findings !== undefined
          ? { findings: outcome.findings }
          : {}),
      };
      emit(
        `[gate:${declaration.id}] ${result.status} (${result.durationMs}ms)\n`,
      );
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

    if (prepareFailure) {
      // The candidate itself made the toolchain unpreparable, so no declared
      // gate can pass and none is allowed to run. Recording the same
      // FAIL/CONFIGURATION against every declaration keeps the evidence's
      // declaration-to-result binding intact and lets
      // `collectRequiredGateFailures` hand the repair to the generator.
      const now = new Date().toISOString();
      const result: GateResult = {
        gateId: declaration.id,
        stage: declaration.stage,
        status: "FAIL",
        failureKind: "CONFIGURATION",
        startedAt: now,
        endedAt: now,
        durationMs: 0,
        exitCode: null,
        treeId: options.treeId,
        logArtifactId,
        detail: prepareFailure,
      };
      emit(`[gate:${declaration.id}] FAIL (0ms)\n`);
      results.push(result);
      continue;
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
      shape.command,
      shape.args,
      {
        cwd: options.cwd,
        signal: options.signal,
        inactivityTimeoutMs: options.inactivityTimeoutMs,
        wallClockTimeoutMs:
          declaration.wallClockTimeoutMs ?? options.wallClockTimeoutMs,
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
  if (
    !SUPPORTED_GATE_EVIDENCE_VERSIONS.includes(
      parsed.version as GateEvidenceVersion,
    )
  ) {
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
  // Only version 2 declares `findings`, so a version-1 document carrying it
  // was written by something that did not know what it was stamping. Refused
  // rather than read past: the version is the reader's contract with the
  // writer (`prd.md` D22).
  if (
    evidence.version === 1 &&
    evidence.results.some((result) => result.findings !== undefined)
  ) {
    throw new Error(
      "Gate evidence version 1 cannot carry findings; findings require version 2",
    );
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
    // `node_modules` is excluded deliberately. The restore runs before and
    // after every gate, so cleaning it would delete the prepared toolchain
    // between gates and leave every gate after the first with nothing to
    // run. It is ignored content, so keeping it cannot change the tree
    // identity asserted below, and the candidate stays exactly the
    // checkpoint.
    execFileSync("git", ["clean", "-ffdx", "-e", "node_modules"], {
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
    isSafeLogArtifactId(value.logArtifactId) &&
    isGateFindingsField(value.findings)
  );
}

/**
 * `findings` is absent, or every field it declares has the declared shape.
 * The waiver record's `riskClass` is checked as a string only: the policy
 * reader owns which classes exist, and this slice populates no waivers.
 */
function isGateFindingsField(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  const isStringList = (candidate: unknown): boolean =>
    candidate === undefined ||
    (Array.isArray(candidate) &&
      candidate.every((entry) => typeof entry === "string"));
  const waivers = value.appliedWaivers;
  return (
    isStringList(value.outOfScopePaths) &&
    isStringList(value.deletedTests) &&
    isStringList(value.protectedChanges) &&
    (waivers === undefined ||
      (Array.isArray(waivers) &&
        waivers.every(
          (entry) =>
            isRecord(entry) &&
            typeof entry.riskClass === "string" &&
            typeof entry.path === "string" &&
            typeof entry.author === "string" &&
            typeof entry.reason === "string",
        )))
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

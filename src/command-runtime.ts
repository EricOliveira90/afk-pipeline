import {
  mkdirSync,
  readFileSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import {
  formatTerminationWarning,
  terminateProcessTree,
} from "./kill-tree.js";

export interface CommandTimeoutOptions {
  cwd: string;
  inactivityTimeoutMs: number;
  heartbeatIntervalMs: number;
  signal?: AbortSignal;
  onOutput?: (text: string) => void;
}

export type CommandOutcome =
  | "EXITED"
  | "SPAWN_ERROR"
  | "CANCELLED"
  | "INACTIVITY_TIMEOUT"
  | "WALL_CLOCK_TIMEOUT";

export interface BoundedCommandOptions extends CommandTimeoutOptions {
  wallClockTimeoutMs?: number;
  shell?: boolean;
}

export interface CommandExecutionResult {
  outcome: CommandOutcome;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  exitCode: number | null;
  errorCode?: string;
  detail?: string;
}

/**
 * Run one process with output-driven inactivity, wall-clock, and cancellation
 * bounds. Timeout and cancellation outcomes settle only after verified
 * process-tree termination completes.
 */
export function runBoundedCommand(
  command: string,
  args: readonly string[],
  options: BoundedCommandOptions,
): Promise<CommandExecutionResult> {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();

  return new Promise((resolve) => {
    const proc = spawn(command, [...args], {
      cwd: options.cwd,
      shell: options.shell ?? false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    let terminating = false;
    let lastActivity = Date.now();
    let heartbeat: NodeJS.Timeout | undefined;
    let wallClock: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (heartbeat) clearInterval(heartbeat);
      if (wallClock) clearTimeout(wallClock);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const settle = (
      outcome: CommandOutcome,
      exitCode: number | null,
      detail?: string,
      errorCode?: string,
    ) => {
      if (settled) return;
      settled = true;
      cleanup();
      const endedAtMs = Date.now();
      resolve({
        outcome,
        startedAt,
        endedAt: new Date(endedAtMs).toISOString(),
        durationMs: endedAtMs - startedAtMs,
        exitCode,
        ...(errorCode ? { errorCode } : {}),
        ...(detail ? { detail } : {}),
      });
    };
    const terminate = (outcome: CommandOutcome, detail: string) => {
      if (settled || terminating) return;
      terminating = true;
      cleanup();
      void terminateProcessTree(proc).then((report) => {
        const warning = formatTerminationWarning(report);
        if (warning) options.onOutput?.(`\n${warning}\n`);
        settle(
          outcome,
          null,
          warning ? `${detail} - ${warning}` : detail,
        );
      });
    };
    const onAbort = () =>
      terminate("CANCELLED", `Command cancelled: ${command}`);
    const onData = (chunk: Buffer) => {
      lastActivity = Date.now();
      options.onOutput?.(chunk.toString());
    };

    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.on("error", (error: NodeJS.ErrnoException) => {
      if (terminating) return;
      settle("SPAWN_ERROR", null, error.message, error.code);
    });
    proc.on("exit", (code) => {
      if (terminating) return;
      settle("EXITED", code);
    });

    heartbeat = setInterval(() => {
      if (Date.now() - lastActivity < options.inactivityTimeoutMs) return;
      terminate(
        "INACTIVITY_TIMEOUT",
        `Command produced no heartbeat for ${options.inactivityTimeoutMs}ms: ${command}`,
      );
    }, Math.min(options.heartbeatIntervalMs, options.inactivityTimeoutMs));
    heartbeat.unref();

    if (options.wallClockTimeoutMs != null) {
      wallClock = setTimeout(
        () =>
          terminate(
            "WALL_CLOCK_TIMEOUT",
            `Command exceeded wall-clock ceiling of ${options.wallClockTimeoutMs}ms: ${command}`,
          ),
        options.wallClockTimeoutMs,
      );
      wallClock.unref();
    }

    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
  });
}

/** Run a command whose inactivity timeout resets on stdout or stderr. */
export async function runHeartbeatCommand(
  command: string,
  options: CommandTimeoutOptions,
): Promise<void> {
  const result = await runBoundedCommand(command, [], {
    ...options,
    shell: true,
  });
  if (result.outcome === "EXITED" && result.exitCode === 0) return;
  if (result.outcome === "EXITED") {
    throw new Error(
      `Command exited with code ${result.exitCode ?? 1}: ${command}`,
    );
  }
  throw new Error(result.detail ?? `Command failed: ${command}`);
}

export interface CrossProcessLockOptions {
  acquireTimeoutMs: number;
  heartbeatIntervalMs: number;
  staleAfterMs: number;
  signal?: AbortSignal;
}

const heartbeatPath = (lockDir: string) => join(lockDir, "owner.json");

function isStale(lockDir: string, staleAfterMs: number): boolean {
  try {
    return Date.now() - statSync(heartbeatPath(lockDir)).mtimeMs > staleAfterMs;
  } catch {
    try {
      return Date.now() - statSync(lockDir).mtimeMs > staleAfterMs;
    } catch {
      return false;
    }
  }
}

function releaseLock(lockDir: string): void {
  try {
    rmSync(heartbeatPath(lockDir), { force: true });
    rmdirSync(lockDir);
  } catch {
    // A stale-lock contender may already have removed it.
  }
}

function writeHeartbeat(lockDir: string): void {
  writeFileSync(
    heartbeatPath(lockDir),
    JSON.stringify({ pid: process.pid, heartbeatAt: new Date().toISOString() }),
    "utf-8",
  );
}

/** Serialize access across AFK processes using atomic directory creation. */
export async function withCrossProcessLock<T>(
  lockDir: string,
  options: CrossProcessLockOptions,
  fn: () => Promise<T>,
): Promise<T> {
  mkdirSync(dirname(lockDir), { recursive: true });
  const startedAt = Date.now();
  while (true) {
    if (options.signal?.aborted) throw new Error("Lock acquisition cancelled");
    try {
      mkdirSync(lockDir);
      writeHeartbeat(lockDir);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (isStale(lockDir, options.staleAfterMs)) {
        releaseLock(lockDir);
        continue;
      }
      if (Date.now() - startedAt >= options.acquireTimeoutMs) {
        let owner = "";
        try {
          owner = ` (${readFileSync(heartbeatPath(lockDir), "utf-8")})`;
        } catch {
          // No owner detail available.
        }
        throw new Error(`Timed out waiting for shared-preview lock${owner}`);
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(options.heartbeatIntervalMs, 1_000)),
      );
    }
  }

  const heartbeat = setInterval(
    () => writeHeartbeat(lockDir),
    options.heartbeatIntervalMs,
  );
  heartbeat.unref();
  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    releaseLock(lockDir);
  }
}

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
import { killProcessTree } from "./kill-tree.js";

export interface CommandTimeoutOptions {
  cwd: string;
  inactivityTimeoutMs: number;
  heartbeatIntervalMs: number;
  signal?: AbortSignal;
  onOutput?: (text: string) => void;
}

/** Run a command whose inactivity timeout resets on stdout or stderr. */
export function runHeartbeatCommand(
  command: string,
  options: CommandTimeoutOptions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, {
      cwd: options.cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    let terminalError: Error | undefined;
    let lastActivity = Date.now();

    const cleanup = () => {
      clearInterval(heartbeat);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const terminate = (error: Error) => {
      if (settled || terminalError) return;
      terminalError = error;
      cleanup();
      killProcessTree(proc);
    };
    const heartbeat = setInterval(() => {
      if (Date.now() - lastActivity < options.inactivityTimeoutMs) return;
      terminate(
        new Error(
          `Command produced no heartbeat for ${options.inactivityTimeoutMs}ms: ${command}`,
        ),
      );
    }, Math.min(options.heartbeatIntervalMs, options.inactivityTimeoutMs));
    heartbeat.unref();

    const onAbort = () => terminate(new Error(`Command cancelled: ${command}`));
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const onData = (chunk: Buffer) => {
      lastActivity = Date.now();
      options.onOutput?.(chunk.toString());
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    proc.on("exit", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (terminalError) reject(terminalError);
      else if (code !== 0) {
        reject(new Error(`Command exited with code ${code ?? 1}: ${command}`));
      } else resolve();
    });
  });
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

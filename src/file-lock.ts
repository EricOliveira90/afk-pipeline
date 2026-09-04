import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_MS = 20;
const sleeper = new Int32Array(new SharedArrayBuffer(4));

interface LockOwner {
  version: 1;
  pid: number;
  token: string;
  acquiredAt: string;
}

function sleep(ms: number): void {
  Atomics.wait(sleeper, 0, 0, ms);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

function readOwner(lockPath: string): LockOwner | null {
  try {
    const path = existsSync(join(lockPath, "owner.json"))
      ? join(lockPath, "owner.json")
      : lockPath;
    const value = JSON.parse(readFileSync(path, "utf-8")) as Partial<LockOwner>;
    if (
      value.version !== 1 ||
      typeof value.pid !== "number" ||
      !Number.isSafeInteger(value.pid) ||
      value.pid <= 0 ||
      typeof value.token !== "string" ||
      value.token === "" ||
      typeof value.acquiredAt !== "string"
    ) {
      return null;
    }
    return value as LockOwner;
  } catch {
    return null;
  }
}

function releaseOwnedLock(lockPath: string, token: string): void {
  const owner = readOwner(lockPath);
  if (owner?.token !== token) return;
  rmSync(lockPath, { recursive: true, force: true });
}

/**
 * Reclaim a lock whose owner process no longer exists.
 *
 * Atomically renaming the dead lock to the reaper path closes the
 * stale-recovery race. The reaper path is a quarantined dead lock, never a
 * live owner, so a later process may safely remove it if this reaper dies.
 * New locks publish their complete owner record atomically, so missing or
 * malformed ownership is never guessed stale. A legacy incomplete lock fails
 * closed and times out rather than risking theft from a live initializer.
 */
function reapDeadOwner(lockPath: string, reaperPath: string): void {
  if (existsSync(reaperPath)) {
    rmSync(reaperPath, { recursive: true, force: true });
    return;
  }
  if (!existsSync(lockPath)) return;
  const owner = readOwner(lockPath);
  if (!owner || processIsAlive(owner.pid)) return;
  try {
    renameSync(lockPath, reaperPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "EEXIST") return;
    throw error;
  }
  rmSync(reaperPath, { recursive: true, force: true });
}

/**
 * Synchronous cross-process exclusion for one file.
 *
 * Run-state writers are synchronous already, so the lock keeps their existing
 * call shape while extending the critical section across Node processes.
 */
export function withFileLock<T>(
  targetPath: string,
  action: () => T,
  options: {
    timeoutMs?: number;
    pollMs?: number;
    /** Test seam after the complete owner record becomes visible. */
    afterLockPublished?: () => void;
  } = {},
): T {
  const lockPath = `${targetPath}.lock`;
  const reaperPath = `${targetPath}.lock-reaper`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  mkdirSync(dirname(targetPath), { recursive: true });

  while (true) {
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for cross-process lock ${lockPath}`,
      );
    }
    if (existsSync(reaperPath)) {
      reapDeadOwner(lockPath, reaperPath);
      sleep(pollMs);
      continue;
    }

    const token = randomUUID();
    const owner: LockOwner = {
      version: 1,
      pid: process.pid,
      token,
      acquiredAt: new Date().toISOString(),
    };
    const pendingPath = `${lockPath}.pending-${token}`;
    writeFileSync(pendingPath, JSON.stringify(owner));
    let acquired = false;
    try {
      linkSync(pendingPath, lockPath);
      acquired = true;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    } finally {
      rmSync(pendingPath, { force: true });
    }
    if (!acquired) {
      reapDeadOwner(lockPath, reaperPath);
      sleep(pollMs);
      continue;
    }

    // A reaper can start between our first check and atomic publication.
    // Yield this acquisition so it never overlaps the quarantined predecessor.
    if (existsSync(reaperPath)) {
      releaseOwnedLock(lockPath, token);
      sleep(pollMs);
      continue;
    }

    try {
      options.afterLockPublished?.();
      return action();
    } finally {
      releaseOwnedLock(lockPath, token);
    }
  }
}

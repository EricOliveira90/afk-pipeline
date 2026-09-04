import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_MS = 20;
const INCOMPLETE_OWNER_GRACE_MS = 1_000;
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

function readOwner(path: string): LockOwner | null {
  try {
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

function releaseOwnedLock(lockDir: string, token: string): void {
  const owner = readOwner(join(lockDir, "owner.json"));
  if (owner?.token !== token) return;
  rmSync(lockDir, { recursive: true, force: true });
}

/**
 * Reclaim a lock whose owner process no longer exists.
 *
 * The reaper directory closes the stale-recovery race: contenders refuse to
 * acquire while it exists, and the reaper re-reads the owner only after it
 * has excluded new acquisitions. A freshly created lock with no owner record
 * gets a short grace period for the mkdir -> owner.json initialization gap.
 */
function reapDeadOwner(lockDir: string, reaperDir: string): void {
  try {
    mkdirSync(reaperDir);
  } catch (error) {
    if (errorCode(error) === "EEXIST") return;
    throw error;
  }

  try {
    if (!existsSync(lockDir)) return;
    const owner = readOwner(join(lockDir, "owner.json"));
    if (owner && processIsAlive(owner.pid)) return;
    if (!owner) {
      const ageMs = Date.now() - statSync(lockDir).mtimeMs;
      if (ageMs < INCOMPLETE_OWNER_GRACE_MS) return;
    }
    rmSync(lockDir, { recursive: true, force: true });
  } finally {
    rmSync(reaperDir, { recursive: true, force: true });
  }
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
  options: { timeoutMs?: number; pollMs?: number } = {},
): T {
  const lockDir = `${targetPath}.lock`;
  const reaperDir = `${targetPath}.lock-reaper`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  mkdirSync(dirname(targetPath), { recursive: true });

  while (true) {
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for cross-process lock ${lockDir}`,
      );
    }
    if (existsSync(reaperDir)) {
      sleep(pollMs);
      continue;
    }

    const token = randomUUID();
    try {
      mkdirSync(lockDir);
      const owner: LockOwner = {
        version: 1,
        pid: process.pid,
        token,
        acquiredAt: new Date().toISOString(),
      };
      try {
        writeFileSync(join(lockDir, "owner.json"), JSON.stringify(owner));
      } catch (error) {
        rmSync(lockDir, { recursive: true, force: true });
        throw error;
      }

      // A reaper can start between our first check and mkdir. Yield this
      // acquisition so it never mistakes a new owner for the stale one.
      if (existsSync(reaperDir)) {
        releaseOwnedLock(lockDir, token);
        sleep(pollMs);
        continue;
      }

      try {
        return action();
      } finally {
        releaseOwnedLock(lockDir, token);
      }
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      reapDeadOwner(lockDir, reaperDir);
      sleep(pollMs);
    }
  }
}

import { spawnSync, type ChildProcess } from "node:child_process";

/**
 * Force-kill a child process and any children it spawned.
 *
 * On Windows, `proc.kill('SIGTERM')` only kills the immediate child —
 * which for our agents is `cmd.exe` wrapping `claude.exe`. The wrapped
 * process survives, the wrapper's exit doesn't propagate, and `close`
 * never fires on the parent side. We use `taskkill /T /F` to terminate
 * the whole tree by PID.
 *
 * On POSIX, SIGKILL is enough.
 *
 * Best-effort — never throws.
 */
export function killProcessTree(proc: ChildProcess): void {
  if (process.platform === "win32" && proc.pid !== undefined) {
    try {
      spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], {
        stdio: "ignore",
      });
    } catch {
      // Fall through to SIGKILL below.
    }
  }
  try {
    proc.kill("SIGKILL");
  } catch {
    // Already exited.
  }
}

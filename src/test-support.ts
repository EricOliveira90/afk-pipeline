import { rmSync } from "node:fs";

/** Errors Windows raises while another process still holds a handle. */
const TRANSIENT_CODES = new Set(["EBUSY", "ENOTEMPTY", "EPERM", "EACCES"]);

/**
 * Remove a fixture directory, tolerating Windows handle contention.
 *
 * The integration suites spawn hundreds of real `git` processes against
 * temporary repositories. On Windows a child can still hold a handle on a
 * `.git` file for a short window after it exits, so a bare
 * `rmSync(dir, { recursive: true, force: true })` in an `afterEach` hook
 * intermittently throws `EBUSY`/`ENOTEMPTY` and fails an otherwise green
 * test. Retry with a bounded backoff instead of failing the suite.
 *
 * Synchronous on purpose: cleanup hooks in these suites are synchronous, and
 * making them async would reorder fixture teardown between sibling tests.
 */
export function rmDirWithRetry(dir: string, attempts = 12): void {
  for (let attempt = 1; ; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (attempt >= attempts || !TRANSIENT_CODES.has(code)) {
        throw error;
      }
      sleepSync(Math.min(50 * attempt, 400));
    }
  }
}

/**
 * Block the thread briefly. `Atomics.wait` is used rather than a busy loop so
 * the retry backoff does not burn CPU on an already-contended host.
 */
function sleepSync(ms: number): void {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

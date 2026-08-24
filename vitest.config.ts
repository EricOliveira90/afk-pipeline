import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Integration suites spawn many synchronous git/pnpm processes. Bound
    // Windows process contention and avoid the fork-pool RPC timeout.
    pool: "threads",
    maxWorkers: 2,
    // A single git-heavy case can spend well over 15s on Windows when the
    // host is busy, and the timeout then cascades: the timed-out test's
    // cleanup hook races the next case's fixture. Budget generously — the
    // only cost of a high ceiling is how long a genuine hang takes to
    // report, and suites that want a tighter bound set it per `describe`.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // The orchestrator suites log every pipeline step to stderr, and the
    // worker forwards each write to the main thread over the reporter RPC.
    // On a loaded host that backs up until vitest reports
    // `[vitest-worker]: Timeout calling "onTaskUpdate"` as an unhandled
    // error, which fails the run with exit 1 even when every test passes.
    // Keep the output for tests that fail, drop it for the ones that pass.
    silent: "passed-only",
  },
});

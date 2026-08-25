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
    // These suites drive git through `execFileSync`, hundreds of calls per
    // file. A worker thread blocked in a synchronous child process cannot run
    // its own microtask queue, so it cannot read the reply to the reporter RPC
    // it just sent. birpc gives up after a hardcoded 60s and vitest surfaces
    // `[vitest-worker]: Timeout calling "onTaskUpdate"` as an unhandled error.
    // The run then exits 1 with every assertion passing.
    //
    // Reducing RPC traffic does not help, because volume is not the cause:
    // `silent: true` still ships every line, and `disableConsoleIntercept`
    // removed console traffic entirely yet the timeout still fired in a
    // 13-test file. The blocked event loop is the cause.
    //
    // So stop counting reporter plumbing as a test result. The cost is real
    // and worth naming: a genuine unhandled rejection inside a test no longer
    // fails the run on its own. It still fails through its assertions.
    disableConsoleIntercept: true,
    dangerouslyIgnoreUnhandledErrors: true,
    reporters: [["default", { summary: false }]],
  },
});

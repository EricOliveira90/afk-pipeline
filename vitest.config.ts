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
    // The orchestrator suites log every pipeline step, and the worker sends
    // each write to the main thread over the reporter RPC. The RPC timeout is
    // 60s. On a loaded host the main thread stops answering `onTaskUpdate`
    // inside that window, and vitest reports
    // `[vitest-worker]: Timeout calling "onTaskUpdate"` as an unhandled
    // error — exit 1 even when every test passed.
    //
    // Neither `silent: "passed-only"` nor `silent: true` removes the RPC
    // traffic. Both act on printing; the worker still hands every line to the
    // main thread. Stop the interception itself, so worker output goes straight
    // to the process stdout and never crosses the RPC. Drop the live summary
    // too, because the default reporter re-renders it on every task update.
    disableConsoleIntercept: true,
    reporters: [["default", { summary: false }]],
  },
});

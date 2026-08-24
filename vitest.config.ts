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
    // `silent: "passed-only"` is not enough: it suppresses printing but still
    // ships every line to the main thread so it can be replayed if the test
    // later fails. Suppress the capture itself, and drop the live summary the
    // default reporter re-renders on every task update. Tests here assert on
    // artifacts, events, and run state, not on captured stdout.
    silent: true,
    reporters: [["default", { summary: false }]],
  },
});

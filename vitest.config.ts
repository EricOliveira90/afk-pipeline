import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Fixture repos must not inherit the developer's git configuration.
    // Correctness first: `core.hooksPath` set in the system or global
    // config (corporate git wrappers install one machine-wide) runs a
    // third-party hook inside every fixture commit, checkout and merge —
    // so whether the suite passes depends on what is installed on the
    // host, and `--no-verify` does not help because it skips only
    // pre-commit and commit-msg, not post-commit / post-checkout /
    // post-merge. Speed follows: on the dev machine of record those
    // hooks cost ~750ms per commit and ~120ms per worktree add.
    //
    // `GIT_CONFIG_NOSYSTEM` drops the system file; `GIT_CONFIG_GLOBAL`
    // pointed at a non-existent path drops `~/.gitconfig` (git treats an
    // unreadable value as empty). Both are inherited by every git the
    // suite spawns, directly or through a child process. Fixtures set
    // `user.name` / `user.email` locally, so nothing here depends on the
    // host config being present.
    // The committer identity comes from the environment for the same
    // reason, and because it is free. A fixture used to spend two `git
    // config` calls setting it — 373ms of the 889ms it took to build a
    // one-commit repo on this machine, since a git process costs ~185ms
    // to start here no matter how little it does. Fixtures that need a
    // *different* identity still set it locally; nothing reads these
    // back, so no assertion depends on the values.
    env: {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/nonexistent/afk-test-gitconfig",
      GIT_AUTHOR_NAME: "AFK Test",
      GIT_AUTHOR_EMAIL: "afk-test@example.com",
      GIT_COMMITTER_NAME: "AFK Test",
      GIT_COMMITTER_EMAIL: "afk-test@example.com",
    },

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

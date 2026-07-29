import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Integration suites spawn many synchronous git/pnpm processes. Bound
    // Windows process contention and avoid the fork-pool RPC timeout.
    pool: "threads",
    maxWorkers: 2,
    testTimeout: 15_000,
  },
});

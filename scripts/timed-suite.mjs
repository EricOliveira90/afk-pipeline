#!/usr/bin/env node
/**
 * Runs one test suite and records how long it took, for
 * `scripts/check-suite-budgets.mjs`.
 *
 * Wall clock is the metric on purpose. Vitest's JSON reporter times only
 * test bodies, and the consolidated suites deliberately do their spawning
 * in `beforeAll` — budgeting the reporter's number would hand out hook
 * time for free, which is the whole cost we are trying to hold down.
 *
 * Usage: node scripts/timed-suite.mjs <suite-name> <command> [args...]
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [suite, command, ...args] = process.argv.slice(2);
if (suite === undefined || command !== "vitest") {
  console.error(
    "usage: node scripts/timed-suite.mjs <suite-name> vitest [args...]",
  );
  process.exit(2);
}

// Run vitest's ESM entry directly rather than the `.cmd` shim: no shell
// means the glob arguments reach vitest exactly as written, instead of
// being brace-expanded on the way through.
const startedAt = Date.now();
const result = spawnSync(
  process.execPath,
  ["node_modules/vitest/vitest.mjs", ...args],
  { stdio: "inherit" },
);
const seconds = (Date.now() - startedAt) / 1000;

const dir = ".vitest-reports";
mkdirSync(dir, { recursive: true });
writeFileSync(
  join(dir, `${suite}.json`),
  `${JSON.stringify({ suite, seconds, exitCode: result.status ?? 1 }, null, 2)}\n`,
  "utf-8",
);

console.log(`[suite-time] ${suite}: ${seconds.toFixed(1)}s`);
process.exit(result.status ?? 1);

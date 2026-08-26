#!/usr/bin/env node
/**
 * Per-suite time budget check — the ratchet on `pnpm test`.
 *
 * The integration suites spawn real git processes, so every new scenario
 * that spawns a pipeline costs seconds of wall clock forever. Nothing used
 * to notice that, and the suite grew from minutes to twenty of them one
 * reasonable-looking test at a time. Each `test:*` script now records its
 * own wall clock (see `timed-suite.mjs`); this compares those against
 * `suite-budgets.json` and fails when one is over.
 *
 * Raising a budget is a normal thing to do — but do it with a recorded
 * measurement in the commit message, not because the number went red.
 * AGENTS.md has the ladder to try first.
 *
 * Usage: node scripts/check-suite-budgets.mjs [reportsDir]
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const reportsDir = process.argv[2] ?? ".vitest-reports";
const budgetsPath = "suite-budgets.json";

if (!existsSync(reportsDir)) {
  console.error(
    `No suite timings in ${reportsDir}/. Run \`pnpm test\` first — its ` +
      `test:* scripts write the timings this check reads.`,
  );
  process.exit(1);
}

const budgets = JSON.parse(readFileSync(budgetsPath, "utf-8"));
const measured = new Map();
for (const entry of readdirSync(reportsDir)) {
  if (!entry.endsWith(".json")) continue;
  const report = JSON.parse(readFileSync(join(reportsDir, entry), "utf-8"));
  measured.set(report.suite, report.seconds);
}

const failures = [];
const notes = [];
let total = 0;

for (const [suite, seconds] of [...measured].sort((a, b) => b[1] - a[1])) {
  total += seconds;
  const budget = budgets.suites[suite];
  console.log(
    `  ${suite.padEnd(20)} ${seconds.toFixed(1).padStart(7)}s` +
      (budget === undefined ? "  (no budget)" : ` / ${budget}s`),
  );
  if (budget === undefined) {
    // A new suite script without a budget is how the ratchet gets
    // bypassed, so it is a failure and not a warning.
    failures.push(
      `${suite}: ran for ${seconds.toFixed(1)}s with no entry in ${budgetsPath}.`,
    );
  } else if (seconds > budget) {
    failures.push(
      `${suite}: ${seconds.toFixed(1)}s over its ${budget}s budget ` +
        `(+${(seconds - budget).toFixed(1)}s).`,
    );
  }
}

for (const suite of Object.keys(budgets.suites)) {
  if (!measured.has(suite)) {
    notes.push(`${suite}: no timing recorded — did that suite run?`);
  }
}

console.log(`  ${"TOTAL".padEnd(20)} ${total.toFixed(1).padStart(7)}s / ${budgets.totalSeconds}s`);
if (total > budgets.totalSeconds) {
  // Every suite can sit just inside its own budget while the whole thing
  // drifts, so the total gets a ceiling of its own.
  failures.push(
    `the whole suite: ${total.toFixed(1)}s over the ${budgets.totalSeconds}s total budget.`,
  );
}

for (const note of notes) console.log(`  note: ${note}`);

if (failures.length > 0) {
  console.error("\nSuite-time budget exceeded:\n");
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(
    "\nA new scenario that spawns a pipeline costs this on every run, forever." +
      "\nSee AGENTS.md: attach the assertion to an existing spawned scenario or" +
      "\nto a unit test before adding a new spawn. If the cost really is" +
      `\nnecessary, raise the number in ${budgetsPath} and record the` +
      "\nmeasurement in the commit message.",
  );
  process.exit(1);
}

console.log("\nEvery suite is within its budget.");

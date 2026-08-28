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
 * It also reads the recorded measurement blocks in that file and says which
 * one this run was compared against — and which it refused to compare. That
 * half is advisory: it warns, it never changes the exit code.
 *
 * Usage: node scripts/check-suite-budgets.mjs [reportsDir]
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const BUDGETS_PATH = "suite-budgets.json";

/**
 * Measurement blocks carry the branch they were measured on, extending the
 * dated block names that were already in the file:
 *
 *     _measured<YYYY_MM_DD>[_<qualifier>]@<branch>
 *
 * e.g. `_measured2026_08_27@main`, `_measured2026_08_27_afk_run5@afk-codex/…`.
 * The branch is verbatim after the first `@`, slashes and all.
 *
 * A block measured on another branch describes another tree, and no prose
 * inside the block can make it describe yours. Run 3's babysitter compared a
 * feature-branch measurement against main's and raised a budget for a
 * slowdown that was not there — the labels were already present; nothing
 * read them. So this reader reads them.
 */
export const MEASUREMENT_PREFIX = "_measured";

/** The branch a measurement block was measured on, or null if unlabelled. */
export function measurementBranch(blockName) {
  if (!blockName.startsWith(MEASUREMENT_PREFIX)) return null;
  const at = blockName.indexOf("@");
  return at === -1 ? null : blockName.slice(at + 1);
}

/**
 * Which recorded measurement this run may be compared against: the last
 * block in file order labelled with the branch we are on (the file is
 * appended to, so last is newest). Everything else is refused, including
 * every block when the branch is unknown.
 */
export function chooseBaseline(blockNames, currentBranch) {
  const blocks = blockNames.filter((name) =>
    name.startsWith(MEASUREMENT_PREFIX),
  );
  const mine =
    currentBranch === null
      ? []
      : blocks.filter((name) => measurementBranch(name) === currentBranch);
  const baseline = mine.length === 0 ? null : mine[mine.length - 1];
  return {
    baseline,
    refused: blocks
      .filter((name) => name !== baseline)
      .map((name) => ({ name, branch: measurementBranch(name) })),
  };
}

/** The numbers that actually govern a run: the budgets, not the history. */
function governing(budgets) {
  return { suites: budgets.suites ?? {}, totalSeconds: budgets.totalSeconds };
}

/** Human-readable differences between two trees' governing numbers. */
export function describeDivergence(ours, theirs) {
  const differences = [];
  const suites = new Set([
    ...Object.keys(ours.suites),
    ...Object.keys(theirs.suites),
  ]);
  for (const suite of [...suites].sort()) {
    if (ours.suites[suite] !== theirs.suites[suite]) {
      differences.push(`${suite} ${theirs.suites[suite]} vs ${ours.suites[suite]} here`);
    }
  }
  if (ours.totalSeconds !== theirs.totalSeconds) {
    differences.push(`total ${theirs.totalSeconds} vs ${ours.totalSeconds} here`);
  }
  return differences;
}

function currentBranch() {
  try {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf-8",
    }).trim();
    return branch === "HEAD" || branch === "" ? null : branch;
  } catch {
    return null;
  }
}

/**
 * Other worktrees of this repo whose governing numbers differ from ours.
 *
 * The debate that asked for this check reproduced the failure live: two
 * checkouts held different budgets (`fast: 90` in one, a recorded raise to
 * 170 in the other) and neither file could say which one governs. So say it
 * — the numbers above come from *this* worktree — and name the others.
 */
function divergentWorktrees(ours) {
  const samePath = (a, b) =>
    process.platform === "win32"
      ? a.toLowerCase() === b.toLowerCase()
      : a === b;
  const divergent = [];
  try {
    const listed = execFileSync("git", ["worktree", "list", "--porcelain"], {
      encoding: "utf-8",
    });
    const here = resolve(".");
    for (const line of listed.split("\n")) {
      if (!line.startsWith("worktree ")) continue;
      const path = resolve(line.slice("worktree ".length).trim());
      if (samePath(path, here)) continue;
      const file = join(path, BUDGETS_PATH);
      if (!existsSync(file)) continue;
      const differences = describeDivergence(
        ours,
        governing(JSON.parse(readFileSync(file, "utf-8"))),
      );
      if (differences.length > 0) divergent.push({ path, differences });
    }
  } catch {
    // No git, no worktrees, an unparseable sibling file: this half of the
    // check is advisory, so a failure to look is silence, never a failure.
  }
  return divergent;
}

function main() {
  const reportsDir = process.argv[2] ?? ".vitest-reports";

  if (!existsSync(reportsDir)) {
    console.error(
      `No suite timings in ${reportsDir}/. Run \`pnpm test\` first — its ` +
        `test:* scripts write the timings this check reads.`,
    );
    process.exit(1);
  }

  const budgets = JSON.parse(readFileSync(BUDGETS_PATH, "utf-8"));
  const measured = new Map();
  const finishedAt = [];
  for (const entry of readdirSync(reportsDir)) {
    if (!entry.endsWith(".json")) continue;
    const report = JSON.parse(readFileSync(join(reportsDir, entry), "utf-8"));
    measured.set(report.suite, report.seconds);
    if (typeof report.finishedAt === "number")
      finishedAt.push(report.finishedAt);
  }

  // A total assembled from timings hours apart is not a total. `pnpm test`
  // clears the directory first; this catches the ad-hoc case.
  const STALE_MS = 3 * 60 * 60 * 1000;
  if (
    finishedAt.length > 1 &&
    Math.max(...finishedAt) - Math.min(...finishedAt) > STALE_MS
  ) {
    console.error(
      `The timings in ${reportsDir}/ span more than 3 hours, so they are not ` +
        `one run. Re-run \`pnpm test\` (it clears them first).`,
    );
    process.exit(1);
  }

  const failures = [];
  const notes = [];
  const warnings = [];
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
        `${suite}: ran for ${seconds.toFixed(1)}s with no entry in ${BUDGETS_PATH}.`,
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

  console.log(
    `  ${"TOTAL".padEnd(20)} ${total.toFixed(1).padStart(7)}s / ${budgets.totalSeconds}s`,
  );
  if (total > budgets.totalSeconds) {
    // Every suite can sit just inside its own budget while the whole thing
    // drifts, so the total gets a ceiling of its own.
    failures.push(
      `the whole suite: ${total.toFixed(1)}s over the ${budgets.totalSeconds}s total budget.`,
    );
  }

  // Everything from here to the failure report is advisory: it names the
  // baseline it compared against and warns about the rest. It must never
  // push onto `failures` — a red gate on a labelling problem would only
  // teach people to delete the labels.
  const branch = currentBranch();
  const { baseline, refused } = chooseBaseline(Object.keys(budgets), branch);
  if (baseline === null) {
    console.log(
      `\n  baseline: none — ${
        branch === null
          ? "could not read the current branch"
          : `no measurement block is labelled @${branch}`
      }, so this run was compared against no recorded measurement.`,
    );
  } else {
    console.log(`\n  vs ${baseline}:`);
    for (const [suite, seconds] of [...measured].sort((a, b) => b[1] - a[1])) {
      const before = budgets[baseline][suite];
      if (typeof before !== "number") continue;
      const delta = seconds - before;
      console.log(
        `  ${suite.padEnd(20)} ${before.toFixed(1)}s -> ${seconds.toFixed(1)}s` +
          ` (${delta >= 0 ? "+" : ""}${delta.toFixed(1)}s)`,
      );
    }
  }
  if (refused.length > 0) {
    const elsewhere = [
      ...new Set(refused.map(({ branch }) => branch ?? "unlabelled")),
    ];
    console.log(
      `  ${refused.length} measurement block(s) not compared — they were ` +
        `measured on: ${elsewhere.join(", ")}.`,
    );
  }
  for (const { path, differences } of divergentWorktrees(governing(budgets))) {
    warnings.push(
      `${path} holds different budgets (${differences.join("; ")}). The ` +
        `numbers above are this worktree's ${BUDGETS_PATH}.`,
    );
  }

  for (const note of notes) console.log(`  note: ${note}`);
  for (const warning of warnings) console.log(`  warn: ${warning}`);

  if (failures.length > 0) {
    console.error("\nSuite-time budget exceeded:\n");
    for (const failure of failures) console.error(`  - ${failure}`);
    console.error(
      "\nA new scenario that spawns a pipeline costs this on every run, forever." +
        "\nSee AGENTS.md: attach the assertion to an existing spawned scenario or" +
        "\nto a unit test before adding a new spawn. If the cost really is" +
        `\nnecessary, raise the number in ${BUDGETS_PATH} and record the` +
        "\nmeasurement in the commit message.",
    );
    process.exit(1);
  }

  console.log("\nEvery suite is within its budget.");
}

// Importable for its unit test; only the CLI invocation runs the check.
if (
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  main();
}

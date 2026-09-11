#!/usr/bin/env node
/**
 * Per-suite time budget check — the ratchet on `pnpm test:ratchet`.
 *
 * The integration suites spawn real git processes, so every new scenario
 * that spawns a pipeline costs seconds of wall clock forever. Nothing used
 * to notice that, and the suite grew from minutes to twenty of them one
 * reasonable-looking test at a time. Each `test:*` script now records its
 * own wall clock (see `timed-suite.mjs`); this compares those against
 * `suite-budgets.json` and fails when one is over.
 *
 * Deliberately NOT part of `pnpm test`, which is the command AFK's own
 * deterministic gates and its pre-ship sanity gate run (ADR 0063). A budget
 * is a measurement of the host, so an agent inside a run cannot act on a red
 * one: it cannot make the machine faster, and the only move left to it is to
 * raise the number. Wire it to a human or to CI, where the reader can
 * actually decide. `suite-budgets.json` records what the other arrangement
 * cost — slice #78 took a blocking Major finding for a 130.5s `fast` against
 * a 110s budget with zero failing tests.
 *
 * Raising a budget is a normal thing to do — but do it with a recorded
 * measurement in the commit message, not because the number went red.
 * AGENTS.md has the ladder to try first.
 *
 * An overrun does not fail on its own: the check attributes it first. An
 * overrun spread uniformly across the whole chain is the host and warns; one
 * concentrated in a suite while its siblings sit at baseline is the ratchet
 * and fails. See `attributeOverruns` for the thresholds and why they are
 * those numbers.
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

/**
 * How the check tells host contention from a regression.
 *
 * A budget is a measurement of the host, so anything else running on that
 * host can push a suite over it with no failing test and nothing in the
 * diff to explain it. That happened twice — the #195 pre-merge chain and
 * the #144 chain of 2026-09-10, which passed 1698 tests with every suite
 * 1.2-1.8x over on a machine at 100% CPU with 13 concurrent node/git
 * processes. Both times an agent re-derived the attribution argument by
 * hand, and the only advice the output gave was to raise the number,
 * which is how a budget measured on a saturated machine becomes the floor.
 *
 * So the shape of the overrun decides the exit code:
 *
 *   - `load` — effectively every budgeted suite is over, none of them
 *     disproportionately. Nothing a diff does slows down suites it never
 *     touched, so this is the host. Warns, exits 0.
 *   - `concentrated` — one suite (or a few) over while the rest of the
 *     chain sits at baseline, or one suite far over the chain's general
 *     inflation. That is the ratchet this file exists to defend. Fails.
 *
 * The three thresholds are calibrated against the numbers
 * `suite-budgets.json`'s own `_comment` records:
 *
 *   - `UNIFORM_SHARE` — how much of the chain has to be over before
 *     "everything is over" is a fair description. Three quarters, not
 *     all of it: `clean-failed` is 46s against `orchestrator`'s 842s and
 *     can absorb a load spike inside its own headroom while the long
 *     suites cannot.
 *   - `UNIFORM_MINIMUM_SUITES` — below three budgeted suites there is no
 *     population to compare against, so an overrun cannot be attributed
 *     and stays a failure. (`pnpm test` runs six.)
 *   - `CONCENTRATION_RATIO` — how far above the chain's general inflation
 *     one suite may sit and still be part of it. 1.45x, because the file
 *     already records that the same suite lands up to 45% higher in-chain
 *     than alone purely from scheduling: a suite may legitimately be that
 *     much worse off than its siblings, and more than that is the suite.
 *     The #144 shape sits at 1.29x of its median and warns; a suite 1.5x
 *     over while its siblings scrape 1.01x is 1.49x and fails.
 */
export const UNIFORM_SHARE = 0.75;
export const UNIFORM_MINIMUM_SUITES = 3;
export const CONCENTRATION_RATIO = 1.45;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Attributes a set of measured-vs-budget suite times.
 *
 * Takes `{ suite, seconds, budget }` records — suites with no budget are
 * not attributable and are handled by the caller, which still fails on
 * them. Returns the shape, the suites over budget worst-first, the
 * `culprits` a failure should name, the chain's general inflation
 * (`level`, the median factor), and a `reason` fit to print.
 */
export function attributeOverruns(records) {
  const rated = records
    .filter(({ budget }) => typeof budget === "number" && budget > 0)
    .map(({ suite, seconds, budget }) => ({
      suite,
      factor: seconds / budget,
    }))
    .sort((a, b) => b.factor - a.factor);
  const over = rated.filter(({ factor }) => factor > 1);
  const level = rated.length === 0 ? 1 : median(rated.map((r) => r.factor));
  const x = (factor) => `${factor.toFixed(2)}x`;

  if (over.length === 0) {
    return { shape: "within", over, culprits: [], level, reason: "" };
  }
  const concentrated = (reason, culprits) => ({
    shape: "concentrated",
    over,
    culprits,
    level,
    reason,
  });
  if (rated.length < UNIFORM_MINIMUM_SUITES) {
    return concentrated(
      `only ${rated.length} budgeted suite(s) ran, which is too few to tell ` +
        `host load from a regression — run the whole chain to attribute it`,
      over,
    );
  }
  if (over.length / rated.length < UNIFORM_SHARE) {
    return concentrated(
      `${over.length} of ${rated.length} budgeted suites are over budget, so ` +
        `the rest of the chain is at baseline and the host was not the cause`,
      over,
    );
  }
  const outliers = over.filter(
    ({ factor }) => factor > level * CONCENTRATION_RATIO,
  );
  if (outliers.length > 0) {
    return concentrated(
      `${outliers.map(({ suite }) => suite).join(", ")} ran more than ` +
        `${CONCENTRATION_RATIO}x this chain's ${x(level)} general inflation, ` +
        `so the overrun is concentrated there and not host-wide`,
      outliers,
    );
  }
  return {
    shape: "load",
    over,
    culprits: [],
    level,
    reason:
      `all ${over.length} of ${rated.length} budgeted suites are over, by ` +
      `${x(over[over.length - 1].factor)}-${x(over[0].factor)} around a ` +
      `${x(level)} median, none of them disproportionately`,
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
  const host = new Map();
  const finishedAt = [];
  for (const entry of readdirSync(reportsDir)) {
    if (!entry.endsWith(".json")) continue;
    const timing = JSON.parse(readFileSync(join(reportsDir, entry), "utf-8"));
    measured.set(timing.suite, timing.seconds);
    // A coarse host reading, if whatever wrote the timing took one. Records
    // without it are the norm today and must stay readable.
    if (typeof timing.host === "string") host.set(timing.suite, timing.host);
    if (typeof timing.finishedAt === "number")
      finishedAt.push(timing.finishedAt);
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

  const records = [];
  for (const [suite, seconds] of [...measured].sort((a, b) => b[1] - a[1])) {
    total += seconds;
    const budget = budgets.suites[suite];
    records.push({ suite, seconds, budget });
    console.log(
      `  ${suite.padEnd(20)} ${seconds.toFixed(1).padStart(7)}s` +
        (budget === undefined ? "  (no budget)" : ` / ${budget}s`) +
        (seconds > budget ? ` (${(seconds / budget).toFixed(2)}x)` : "") +
        (host.has(suite) ? `  host: ${host.get(suite)}` : ""),
    );
    if (budget === undefined) {
      // A new suite script without a budget is how the ratchet gets
      // bypassed, so it is a failure and not a warning.
      failures.push(
        `${suite}: ran for ${seconds.toFixed(1)}s with no entry in ${BUDGETS_PATH}.`,
      );
    }
  }

  // Which overruns fail is a question about the shape of all of them
  // together, so it is decided once, after the whole table is in hand.
  const overrun = attributeOverruns(records);
  const describeOverrun = ({ suite, factor }) => {
    const { seconds, budget } = records.find((r) => r.suite === suite);
    return (
      `${suite}: ${seconds.toFixed(1)}s over its ${budget}s budget ` +
      `(+${(seconds - budget).toFixed(1)}s, ${factor.toFixed(2)}x).`
    );
  };
  if (overrun.shape === "concentrated") {
    for (const suite of overrun.culprits) failures.push(describeOverrun(suite));
  } else if (overrun.shape === "load") {
    for (const suite of overrun.over) warnings.push(describeOverrun(suite));
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
    // drifts, so the total gets a ceiling of its own — but a total is a sum
    // of the same measurements, so load that only warned per-suite cannot
    // fail here through the back door.
    const overTotal = `the whole suite: ${total.toFixed(1)}s over the ${budgets.totalSeconds}s total budget.`;
    (overrun.shape === "load" ? warnings : failures).push(overTotal);
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
    if (overrun.shape === "concentrated") {
      console.error(`\nAttributed to the diff: ${overrun.reason}.`);
    }
    console.error(
      "\nA new scenario that spawns a pipeline costs this on every run, forever." +
        "\nSee AGENTS.md: attach the assertion to an existing spawned scenario or" +
        "\nto a unit test before adding a new spawn. If the cost really is" +
        `\nnecessary, raise the number in ${BUDGETS_PATH} and record the` +
        "\nmeasurement in the commit message.",
    );
    process.exit(1);
  }

  if (overrun.shape === "load") {
    // Warn, exit 0. Nothing in a diff slows down suites it never touched,
    // and telling the reader to raise a budget for this is how a saturated
    // host's numbers become permanent.
    console.log(
      `\nSuspected host contention, not a regression: ${overrun.reason}.` +
        "\nNo budget failed. To confirm, re-run an over-budget suite alone" +
        "\n(`pnpm run test:heavy:<name>` / `pnpm test:fast`) on a quiet host and" +
        "\ncompare — an alone-run is stable to ~2% and should land BELOW its" +
        "\nin-chain number. Do not raise a budget for this; a budget measured" +
        "\nunder load becomes the new floor.",
    );
    return;
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

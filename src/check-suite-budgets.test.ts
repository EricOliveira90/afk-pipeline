/**
 * Unit tests for the reader-side half of the suite-budget check: which
 * recorded measurement block a run may be compared against.
 *
 * The check itself is a script (`scripts/check-suite-budgets.mjs`) so it can
 * run on bare node at the end of `pnpm test`; the decision it makes is a pure
 * function, and this is where it is pinned.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CONCENTRATION_RATIO,
  attributeOverruns,
  baselineEntry,
  chooseBaseline,
  describeDivergence,
  formatBaselineRow,
  formatSuiteRow,
  measurementBranch,
} from "../scripts/check-suite-budgets.mjs";

describe("chooseBaseline", () => {
  const blocks = [
    "_comment",
    "_measured2026_08_26@main",
    "_measured2026_08_27@main",
    "_measured2026_08_27_afk_run4@afk-codex/slice-04",
    "suites",
    "totalSeconds",
  ];

  it("compares against the newest block labelled with the current branch", () => {
    const { baseline } = chooseBaseline(blocks, "main");
    expect(baseline).toBe("_measured2026_08_27@main");
  });

  it("refuses the blocks measured on another branch, naming it", () => {
    const { refused } = chooseBaseline(blocks, "main");
    expect(refused).toEqual([
      { name: "_measured2026_08_26@main", branch: "main" },
      {
        name: "_measured2026_08_27_afk_run4@afk-codex/slice-04",
        branch: "afk-codex/slice-04",
      },
    ]);
  });

  it("has no baseline on a branch nothing was measured on", () => {
    // The case this check exists for: on a fresh branch every recorded
    // number describes somebody else's tree, so none of them is a baseline.
    const { baseline, refused } = chooseBaseline(blocks, "wave/some-item");
    expect(baseline).toBeNull();
    expect(refused).toHaveLength(3);
  });

  it("refuses every block when the current branch is unknown", () => {
    const { baseline, refused } = chooseBaseline(blocks, null);
    expect(baseline).toBeNull();
    expect(refused).toHaveLength(3);
  });

  it("never compares an unlabelled block, even on a branch with none", () => {
    const { baseline, refused } = chooseBaseline(
      ["_measured2026_08_26_round1"],
      "main",
    );
    expect(baseline).toBeNull();
    expect(refused).toEqual([
      { name: "_measured2026_08_26_round1", branch: null },
    ]);
  });

  it("ignores keys that are not measurement blocks", () => {
    expect(chooseBaseline(["suites", "totalSeconds"], "main")).toEqual({
      baseline: null,
      refused: [],
    });
  });
});

describe("attributeOverruns", () => {
  /** The governing budgets, so a fixture is written as a factor of one. */
  const BUDGETS = {
    fast: 258,
    orchestrator: 842,
    wave: 423,
    "resume-integration": 219,
    "qa-orchestration": 151,
    "clean-failed": 46,
  };

  /** A chain where each suite ran `factor` times its budget. */
  const chain = (factors: Record<string, number>) =>
    Object.entries(factors).map(([suite, factor]) => ({
      suite,
      seconds: BUDGETS[suite as keyof typeof BUDGETS] * factor,
      budget: BUDGETS[suite as keyof typeof BUDGETS],
    }));

  it("warns instead of failing when the whole chain inflated together", () => {
    // The #144 shape, 2026-09-10: 1698 tests passed, zero failures, every
    // suite 1.2-1.8x over, host at 100% CPU with 13 node/git processes. The
    // clinching datapoint was qa-orchestration — a suite that run's diff
    // never touched — at 241.7s in-chain and 345.0s ALONE minutes later,
    // which nothing in the repo can explain.
    const { shape, over, reason } = attributeOverruns(
      chain({
        fast: 1.35,
        orchestrator: 1.5,
        wave: 1.8,
        "resume-integration": 1.2,
        "qa-orchestration": 1.6,
        "clean-failed": 1.4,
      }),
    );
    expect(shape).toBe("load");
    expect(over).toHaveLength(6);
    expect(reason).toContain("all 6 of 6");
  });

  it("fails when one suite is over and its siblings sit at baseline", () => {
    // The ratchet's own case: a new spawned scenario in one suite.
    const { shape, culprits, reason } = attributeOverruns(
      chain({
        fast: 0.9,
        orchestrator: 0.95,
        wave: 1.4,
        "resume-integration": 0.8,
        "qa-orchestration": 0.85,
        "clean-failed": 0.7,
      }),
    );
    expect(shape).toBe("concentrated");
    expect(culprits.map((c: { suite: string }) => c.suite)).toEqual(["wave"]);
    expect(reason).toContain("1 of 6");
  });

  it("fails a suite far above the chain's inflation, load or not", () => {
    // Every suite over, so the share test passes — but one of them is over
    // by much more than the rest, which load does not do.
    const { shape, culprits } = attributeOverruns(
      chain({
        fast: 1.02,
        orchestrator: 1.01,
        wave: 1.5,
        "resume-integration": 1.03,
        "qa-orchestration": 1.01,
        "clean-failed": 1.02,
      }),
    );
    expect(shape).toBe("concentrated");
    expect(culprits.map((c: { suite: string }) => c.suite)).toEqual(["wave"]);
  });

  it("is within budget, with nothing to attribute, when nothing is over", () => {
    const { shape, over, reason } = attributeOverruns(
      chain({ fast: 0.99, orchestrator: 0.5, wave: 0.8 }),
    );
    expect(shape).toBe("within");
    expect(over).toEqual([]);
    expect(reason).toBe("");
  });

  it("cannot attribute an overrun to load without a chain to compare", () => {
    // One suite run on its own is its own whole population; `pnpm test` runs
    // six. Refuse rather than let `pnpm vitest run one-file` warn its way out.
    const { shape, reason } = attributeOverruns(
      chain({ wave: 1.4, "clean-failed": 1.4 }),
    );
    expect(shape).toBe("concentrated");
    expect(reason).toContain("too few");
  });

  it("ignores suites with no budget, which the caller fails on anyway", () => {
    const { shape, over } = attributeOverruns([
      ...chain({ fast: 1.3, orchestrator: 1.3, wave: 1.35 }),
      { suite: "brand-new", seconds: 90, budget: undefined },
    ]);
    expect(shape).toBe("load");
    expect(over.map((o: { suite: string }) => o.suite)).not.toContain(
      "brand-new",
    );
  });

  it("ties its concentration threshold to the in-chain spread on record", () => {
    // suite-budgets.json records that the same suite lands up to 45% higher
    // in-chain than alone from scheduling alone. That is the spread between
    // siblings the check must tolerate, so it is the threshold.
    expect(CONCENTRATION_RATIO).toBe(1.45);
  });
});

describe("measurementBranch", () => {
  it("reads the branch verbatim after the first @, slashes included", () => {
    expect(measurementBranch("_measured2026_08_27_x@feat/a/b")).toBe("feat/a/b");
  });

  it("is null for a block with no label and for a non-block key", () => {
    expect(measurementBranch("_measured2026_08_27")).toBeNull();
    expect(measurementBranch("suites@main")).toBeNull();
  });
});

describe("describeDivergence", () => {
  it("names the budgets another worktree disagrees about", () => {
    // The live reproduction that asked for this: `fast: 90` in one checkout
    // against a recorded raise to 170 in the other.
    const differences = describeDivergence(
      { suites: { fast: 170, wave: 295 }, totalSeconds: 1287 },
      { suites: { fast: 90, wave: 295 }, totalSeconds: 1200 },
    );
    expect(differences).toEqual(["fast 90 vs 170 here", "total 1200 vs 1287 here"]);
  });

  it("is empty when the governing numbers agree", () => {
    const numbers = { suites: { fast: 170 }, totalSeconds: 1287 };
    expect(describeDivergence(numbers, structuredClone(numbers))).toEqual([]);
  });
});

describe("baselineEntry", () => {
  it("reads a bare number as seconds with no recorded git count", () => {
    // Every block in the file today is this shape, and each one has to stay
    // comparable on the half it has.
    expect(baselineEntry(23.9)).toEqual({ seconds: 23.9, gitProcesses: null });
  });

  it("reads both halves of a block that recorded the git count", () => {
    expect(baselineEntry({ seconds: 23.9, gitProcesses: 1204 })).toEqual({
      seconds: 23.9,
      gitProcesses: 1204,
    });
  });

  it("is null-for-null on a missing half and on a non-measurement value", () => {
    expect(baselineEntry({ gitProcesses: 1204 })).toEqual({
      seconds: null,
      gitProcesses: 1204,
    });
    // `_note` strings and arrays sit in the same blocks as the suite entries.
    expect(baselineEntry("Two full-chain runs")).toEqual({
      seconds: null,
      gitProcesses: null,
    });
    expect(baselineEntry(undefined)).toEqual({
      seconds: null,
      gitProcesses: null,
    });
  });
});

describe("formatSuiteRow", () => {
  it("prints the git process count next to the seconds", () => {
    const row = formatSuiteRow({
      suite: "clean-failed",
      seconds: 23.5,
      budget: 46,
      gitProcesses: 1204,
    });
    expect(row).toContain("23.5s / 46s");
    expect(row).toContain("git   1204");
  });

  it("stays readable for a timing that recorded no count", () => {
    // The count is a measurement, not a gate: a record written without one
    // prints the row it always printed rather than a misleading zero.
    const row = formatSuiteRow({
      suite: "clean-failed",
      seconds: 23.5,
      budget: 46,
    });
    expect(row).toContain("23.5s / 46s");
    expect(row).not.toContain("git");
    expect(row).not.toContain("0");
  });

  it("keeps the overrun factor, the no-budget note and the host reading", () => {
    expect(
      formatSuiteRow({
        suite: "clean-failed",
        seconds: 92,
        budget: 46,
        gitProcesses: 1204,
        host: "busy",
      }),
    ).toContain("(2.00x)");
    expect(
      formatSuiteRow({ suite: "brand-new", seconds: 90, gitProcesses: 12 }),
    ).toContain("(no budget)");
    expect(
      formatSuiteRow({ suite: "fast", seconds: 90, budget: 258, host: "busy" }),
    ).toContain("host: busy");
  });
});

describe("formatBaselineRow", () => {
  const measured = { suite: "clean-failed", seconds: 20.5, gitProcesses: 1100 };

  it("diffs the git count when the recorded block has one", () => {
    // The reason the count exists: seconds move with the host, so a chain
    // that got 3s faster proves nothing, while 104 fewer git processes is
    // the diff.
    const row = formatBaselineRow(measured, { seconds: 23.5, gitProcesses: 1204 });
    expect(row).toBe(
      "  clean-failed         23.5s -> 20.5s (-3.0s), git 1204 -> 1100 (-104)",
    );
  });

  it("signs a rise in the count", () => {
    expect(
      formatBaselineRow(measured, { seconds: 20.0, gitProcesses: 1000 }),
    ).toContain("git 1000 -> 1100 (+100)");
  });

  it("compares seconds only against a block recorded without a count", () => {
    const row = formatBaselineRow(measured, 23.5);
    expect(row).toBe("  clean-failed         23.5s -> 20.5s (-3.0s)");
  });

  it("omits the count when the run recorded none, block or not", () => {
    const row = formatBaselineRow(
      { suite: "clean-failed", seconds: 20.5 },
      { seconds: 23.5, gitProcesses: 1204 },
    );
    expect(row).toBe("  clean-failed         23.5s -> 20.5s (-3.0s)");
  });

  it("is null when the block records nothing comparable for the suite", () => {
    expect(formatBaselineRow(measured, undefined)).toBeNull();
    expect(formatBaselineRow(measured, "9 tests")).toBeNull();
  });
});

describe("suite-budgets.json", () => {
  it("labels every measurement block with the branch it was measured on", () => {
    // Unlabelled blocks are invisible to the check, so keep the file honest
    // here rather than letting the next reader silently lose a baseline.
    const path = fileURLToPath(
      new URL("../suite-budgets.json", import.meta.url),
    );
    const keys = Object.keys(JSON.parse(readFileSync(path, "utf-8")));
    const unlabelled = keys.filter(
      (key) => key.startsWith("_measured") && measurementBranch(key) === null,
    );
    expect(unlabelled).toEqual([]);
  });
});

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
  chooseBaseline,
  describeDivergence,
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

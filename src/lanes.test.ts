import { describe, it, expect } from "vitest";
import type { Slice } from "./issues-parser.js";
import { partitionLanes } from "./lanes.js";

/**
 * Tests for the lane partitioner. A lane is a serial chain of slices
 * that share at least one declared file (transitive closure). Lanes
 * run in parallel; within a lane, slices execute serially.
 */

function slice(
  number: string,
  files?: string[] | undefined,
  blockedBy: string[] = [],
): Slice {
  return {
    number,
    ghIssue: number, // tests treat the slice number as the issue id
    title: `Slice ${number}`,
    type: "AFK",
    blockedBy,
    userStories: "",
    files,
  };
}

describe("partitionLanes", () => {
  it("returns no lanes when given no slices", () => {
    expect(partitionLanes([])).toEqual([]);
  });

  it("wraps a single slice in a lane of size 1", () => {
    const s = slice("01", ["src/cli.py"]);
    expect(partitionLanes([s])).toEqual([[s]]);
  });

  it("splits two slices with disjoint files into two lanes", () => {
    const a = slice("01", ["src/foo.ts"]);
    const b = slice("02", ["src/bar.ts"]);
    const lanes = partitionLanes([a, b]);
    expect(lanes).toHaveLength(2);
    expect(lanes[0]).toEqual([a]);
    expect(lanes[1]).toEqual([b]);
  });

  it("merges two slices that share a file into one lane", () => {
    const a = slice("01", ["src/cli.py", "src/foo.ts"]);
    const b = slice("02", ["src/cli.py", "src/bar.ts"]);
    const lanes = partitionLanes([a, b]);
    expect(lanes).toHaveLength(1);
    expect(lanes[0]).toEqual([a, b]);
  });

  it("forms a transitive lane: A↔B (file X), B↔C (file Y) → all three", () => {
    const a = slice("01", ["src/x.ts"]);
    const b = slice("02", ["src/x.ts", "src/y.ts"]);
    const c = slice("03", ["src/y.ts"]);
    const lanes = partitionLanes([a, b, c]);
    expect(lanes).toHaveLength(1);
    expect(lanes[0]).toEqual([a, b, c]);
  });

  it("collapses the whole wave into one lane when any slice is undeclared", () => {
    // The conservative undeclared rule from ADR 0005: a slice with
    // `files === undefined` could touch anything, so it must serialise
    // with every sibling in the wave.
    const a = slice("01", ["src/foo.ts"]);
    const b = slice("02", undefined);
    const c = slice("03", ["src/bar.ts"]);
    const lanes = partitionLanes([a, b, c]);
    expect(lanes).toHaveLength(1);
    expect(lanes[0]).toEqual([a, b, c]);
  });

  it("treats `src/Cli.py` and `src/cli.py` as the same file (case-insensitive)", () => {
    const a = slice("01", ["src/Cli.py"]);
    const b = slice("02", ["src/cli.py"]);
    const lanes = partitionLanes([a, b]);
    expect(lanes).toHaveLength(1);
    expect(lanes[0]).toEqual([a, b]);
  });

  it("normalises `./src/cli.py` and `src/cli.py` and `src\\cli.py`", () => {
    const a = slice("01", ["./src/cli.py"]);
    const b = slice("02", ["src\\cli.py"]);
    const c = slice("03", ["src/cli.py"]);
    const lanes = partitionLanes([a, b, c]);
    expect(lanes).toHaveLength(1);
    expect(lanes[0]).toEqual([a, b, c]);
  });

  it("orders slices within a lane by ascending slice number", () => {
    const c = slice("03", ["src/x.ts"]);
    const a = slice("01", ["src/x.ts"]);
    const b = slice("02", ["src/x.ts"]);
    // Insertion order is shuffled to ensure sort, not insertion, drives output.
    const lanes = partitionLanes([c, a, b]);
    expect(lanes).toHaveLength(1);
    expect(lanes[0]!.map((s) => s.number)).toEqual(["01", "02", "03"]);
  });

  it("orders lanes deterministically by lowest slice number", () => {
    // Lane A: slices 02, 04. Lane B: slices 01, 03.
    // Insertion order of the input shouldn't change lane order.
    const s2 = slice("02", ["src/a.ts"]);
    const s4 = slice("04", ["src/a.ts"]);
    const s1 = slice("01", ["src/b.ts"]);
    const s3 = slice("03", ["src/b.ts"]);
    const lanes = partitionLanes([s2, s4, s1, s3]);
    expect(lanes).toHaveLength(2);
    expect(lanes[0]!.map((s) => s.number)).toEqual(["01", "03"]);
    expect(lanes[1]!.map((s) => s.number)).toEqual(["02", "04"]);
  });

  it("treats two-digit slice numbers as numeric, not lexicographic", () => {
    // Lexicographic sort would put "10" before "9" — break that.
    const s9 = slice("9", ["src/x.ts"]);
    const s10 = slice("10", ["src/x.ts"]);
    const lanes = partitionLanes([s10, s9]);
    expect(lanes[0]!.map((s) => s.number)).toEqual(["9", "10"]);
  });

  it("places empty-files slices (`[]`) in their own singleton lanes", () => {
    // An empty list means the planner explicitly declared "no files
    // change". That's not the same as undefined and shouldn't collapse
    // the wave; the slice runs alone.
    const a = slice("01", []);
    const b = slice("02", ["src/x.ts"]);
    const lanes = partitionLanes([a, b]);
    expect(lanes).toHaveLength(2);
  });
});

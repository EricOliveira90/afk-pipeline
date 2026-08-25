import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadAfkManifest,
  parseAfkManifest,
  trimUnclaimedMigrationPrefixes,
} from "./afk-manifest.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempPrd(): string {
  const root = mkdtempSync(join(tmpdir(), "afk-manifest-"));
  roots.push(root);
  const prd = join(root, "prd");
  mkdirSync(prd);
  return prd;
}

describe("afk.json", () => {
  it("uses documented compatibility behavior when absent", () => {
    expect(loadAfkManifest(tempPrd())).toBeNull();
  });

  it("normalizes slices and legacy protected issue numbers", () => {
    expect(parseAfkManifest({
      version: 1,
      selectedSlices: ["1", "02"],
      migrationPrefixes: ["144", "145"],
      protectedIssues: [758, { number: 759, state: "closed" }],
    })).toEqual({
      version: 1,
      selectedSlices: ["01", "02"],
      migrationPrefixes: ["144", "145"],
      protectedIssues: [
        { number: 758, state: "OPEN" },
        { number: 759, state: "CLOSED" },
      ],
    });
  });

  it("rejects duplicate reservations", () => {
    expect(() => parseAfkManifest({
      version: 1,
      selectedSlices: ["01"],
      migrationPrefixes: ["144", "144"],
      protectedIssues: [],
    })).toThrow(/unique numeric prefixes/);
  });

  it("removes unclaimed reservations before draft verification", () => {
    const prd = tempPrd();
    writeFileSync(join(prd, "afk.json"), JSON.stringify({
      version: 1,
      selectedSlices: ["01"],
      migrationPrefixes: ["144", "145", "146"],
      protectedIssues: [],
    }));

    const result = trimUnclaimedMigrationPrefixes(prd, ["145"]);

    expect(result.changed).toBe(true);
    expect(result.manifest.migrationPrefixes).toEqual(["145"]);
    expect(JSON.parse(readFileSync(join(prd, "afk.json"), "utf-8")).migrationPrefixes)
      .toEqual(["145"]);
  });
});

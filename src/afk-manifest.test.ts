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
      protectedChangeWaivers: [],
    });
  });

  it("[behavior:B-01] reads protected-change waivers, normalizing the path", () => {
    const manifest = parseAfkManifest({
      version: 1,
      selectedSlices: ["01"],
      protectedChangeWaivers: [
        {
          riskClass: "gate-policy",
          path: "./src\\thing.ts",
          author: "eric",
          reason: "the budget moved with the split",
        },
        {
          riskClass: "deleted-test",
          path: "src/old.test.ts",
          author: "eric",
          reason: "the suite it covered was removed",
        },
      ],
    });
    expect(manifest.protectedChangeWaivers).toEqual([
      {
        riskClass: "gate-policy",
        path: "src/thing.ts",
        author: "eric",
        reason: "the budget moved with the split",
      },
      {
        riskClass: "deleted-test",
        path: "src/old.test.ts",
        author: "eric",
        reason: "the suite it covered was removed",
      },
    ]);
  });

  it("[behavior:B-01] reads an absent protectedChangeWaivers as no waiver at all", () => {
    expect(
      parseAfkManifest({ version: 1, selectedSlices: ["01"] })
        .protectedChangeWaivers,
    ).toEqual([]);
  });

  it.each([
    [
      "a riskClass outside the declared set",
      { riskClass: "vibes", path: "src/a.ts", author: "eric", reason: "why" },
      /does not recognise riskClass "vibes"/,
    ],
    [
      "a glob instead of one exact path",
      {
        riskClass: "gate-policy",
        path: "src/*.ts",
        author: "eric",
        reason: "why",
      },
      /looks like a glob/,
    ],
    [
      "a character-class path",
      {
        riskClass: "gate-policy",
        path: "src/[ab].ts",
        author: "eric",
        reason: "why",
      },
      /looks like a glob/,
    ],
    [
      "a blank author",
      {
        riskClass: "gate-policy",
        path: "src/a.ts",
        author: "   ",
        reason: "why",
      },
      /non-blank author/,
    ],
    [
      "a missing reason",
      { riskClass: "gate-policy", path: "src/a.ts", author: "eric" },
      /non-blank reason/,
    ],
    [
      "a non-object entry",
      "src/a.ts",
      /must be JSON objects holding/,
    ],
  ])(
    "[behavior:B-01] refuses %s",
    (_label, waiver: unknown, expected: RegExp) => {
      expect(() =>
        parseAfkManifest({
          version: 1,
          selectedSlices: ["01"],
          protectedChangeWaivers: [waiver],
        }),
      ).toThrow(expected);
    },
  );

  it("[behavior:B-01] refuses two waivers for one riskClass and path", () => {
    const waiver = {
      riskClass: "gate-policy",
      path: "src/a.ts",
      author: "eric",
      reason: "why",
    };
    expect(() =>
      parseAfkManifest({
        version: 1,
        selectedSlices: ["01"],
        protectedChangeWaivers: [waiver, { ...waiver, author: "someone else" }],
      }),
    ).toThrow(/must not repeat a riskClass and path pair/);
    // The same path under a different risk class is a different decision.
    expect(
      parseAfkManifest({
        version: 1,
        selectedSlices: ["01"],
        protectedChangeWaivers: [
          waiver,
          { ...waiver, riskClass: "skipped-test" },
        ],
      }).protectedChangeWaivers,
    ).toHaveLength(2);
  });

  it("[behavior:B-01] refuses a protectedChangeWaivers that is not an array", () => {
    expect(() =>
      parseAfkManifest({
        version: 1,
        selectedSlices: ["01"],
        protectedChangeWaivers: { riskClass: "gate-policy" },
      }),
    ).toThrow(/protectedChangeWaivers must be an array/);
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

  it("[behavior:B-02] keeps every waiver when the ship gate rewrites the manifest", () => {
    const prd = tempPrd();
    const waivers = [
      {
        riskClass: "skipped-test",
        path: "src/legacy.test.ts",
        author: "eric",
        reason: "the upstream fixture is broken",
      },
    ];
    writeFileSync(
      join(prd, "afk.json"),
      JSON.stringify({
        version: 1,
        selectedSlices: ["01"],
        migrationPrefixes: ["144", "145"],
        protectedIssues: [],
        protectedChangeWaivers: waivers,
      }),
    );

    const result = trimUnclaimedMigrationPrefixes(prd, ["145"]);

    expect(result.changed).toBe(true);
    expect(result.manifest.protectedChangeWaivers).toEqual(waivers);
    // The rewrite is what a later run reads, so the audit record has to be in
    // the bytes on disk and not only in the returned object.
    expect(
      JSON.parse(readFileSync(join(prd, "afk.json"), "utf-8"))
        .protectedChangeWaivers,
    ).toEqual(waivers);
  });
});

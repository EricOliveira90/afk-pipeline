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

  it("[behavior:#303:B-02] reads the mutation declaration, normalizing the report path", () => {
    const manifest = parseAfkManifest({
      version: 1,
      selectedSlices: ["01"],
      mutationReport: {
        command: "  pnpm run mutate  ",
        reportPath: "./reports\\mutation\\mutation.json",
      },
    });
    // Same path normalization the waivers get: one repo-relative form, so the
    // step opens the file the declaration meant on every platform.
    expect(manifest.mutationReport).toEqual({
      command: "pnpm run mutate",
      reportPath: "reports/mutation/mutation.json",
    });
  });

  it("[behavior:#303:B-04] [behavior:#304:P-01] reads a manifest with no mutationReport exactly as before", () => {
    const manifest = parseAfkManifest({
      version: 1,
      selectedSlices: ["01"],
      migrationPrefixes: ["144"],
      protectedIssues: [758],
    });
    // Absent means absent, not an empty declaration: `refuseUndeclaredMutationReport`
    // reads this member, and a stub would turn the launch refusal into a run
    // that reported nothing.
    expect(manifest).toEqual({
      version: 1,
      selectedSlices: ["01"],
      migrationPrefixes: ["144"],
      protectedIssues: [{ number: 758, state: "OPEN" }],
      protectedChangeWaivers: [],
    });
    expect("mutationReport" in manifest).toBe(false);
    expect(manifest.version).toBe(1);
  });

  it.each([
    [
      "a blank command",
      { command: "   ", reportPath: "reports/mutation.json" },
      /mutationReport requires a non-blank command/,
    ],
    [
      "a missing command",
      { reportPath: "reports/mutation.json" },
      /mutationReport requires a non-blank command/,
    ],
    [
      "a blank reportPath",
      { command: "pnpm run mutate", reportPath: "" },
      /mutationReport requires a non-blank reportPath/,
    ],
    [
      "a missing reportPath",
      { command: "pnpm run mutate" },
      /mutationReport requires a non-blank reportPath/,
    ],
    [
      "a glob reportPath",
      { command: "pnpm run mutate", reportPath: "reports/*.json" },
      /mutationReport reportPath "reports\/\*\.json" looks like a glob/,
    ],
    [
      "a character-class reportPath",
      { command: "pnpm run mutate", reportPath: "reports/mutation-[12].json" },
      /looks like a glob/,
    ],
    [
      "an absolute reportPath",
      { command: "pnpm run mutate", reportPath: "/var/tmp/mutation.json" },
      /must be repo-relative, not absolute/,
    ],
    [
      "a drive-absolute reportPath",
      { command: "pnpm run mutate", reportPath: "C:\\tmp\\mutation.json" },
      /must be repo-relative, not absolute/,
    ],
    [
      "a traversing reportPath",
      { command: "pnpm run mutate", reportPath: "../outside/mutation.json" },
      /must not traverse outside the worktree/,
    ],
    [
      "a non-object declaration",
      "pnpm run mutate",
      /mutationReport must be a JSON object holding command and reportPath/,
    ],
  ])(
    "[behavior:#303:B-03] [behavior:#304:P-02] refuses %s, naming the member at fault",
    (_label, mutationReport: unknown, expected: RegExp) => {
      expect(() =>
        parseAfkManifest({
          version: 1,
          selectedSlices: ["01"],
          mutationReport,
        }),
      ).toThrow(expected);
    },
  );

  it("[behavior:#304:B-01] returns both attribution paths, normalized the way reportPath is", () => {
    const manifest = parseAfkManifest({
      version: 1,
      selectedSlices: ["01"],
      mutationReport: {
        command: "pnpm run mutate",
        reportPath: "reports/mutation.json",
        baselinePath: "./reports\\mutation\\incremental.json",
        decisionsPath: "docs/mutation-decisions.json",
      },
    });
    // Returned, not merely validated: the ship gate rewrites `afk.json` from
    // this object, so a key the parser dropped would be deleted from the
    // reviewed branch.
    expect(manifest.mutationReport).toEqual({
      command: "pnpm run mutate",
      reportPath: "reports/mutation.json",
      baselinePath: "reports/mutation/incremental.json",
      decisionsPath: "docs/mutation-decisions.json",
    });
    // `version` is untouched: both members are optional, and every existing
    // reader already tolerates their absence.
    expect(manifest.version).toBe(1);
  });

  it("[behavior:#304:B-01] leaves an undeclared attribution path absent, never undefined-valued", () => {
    const manifest = parseAfkManifest({
      version: 1,
      selectedSlices: ["01"],
      mutationReport: {
        command: "pnpm run mutate",
        reportPath: "reports/mutation.json",
      },
    });
    // The absence discipline `mutationReport` itself is under: an
    // `undefined`-valued key would survive into the rewritten manifest as
    // `"baselinePath": null` on some writers, and "no baseline declared" is not
    // "a baseline nobody named".
    expect(manifest.mutationReport).toEqual({
      command: "pnpm run mutate",
      reportPath: "reports/mutation.json",
    });
    expect("baselinePath" in manifest.mutationReport!).toBe(false);
    expect("decisionsPath" in manifest.mutationReport!).toBe(false);
  });

  it.each(
    (["baselinePath", "decisionsPath"] as const).flatMap((member) => [
      [
        `a blank ${member}`,
        { [member]: "   " },
        new RegExp(`mutationReport ${member} must be a non-blank string`),
      ],
      [
        `a non-string ${member}`,
        { [member]: 7 },
        new RegExp(`mutationReport ${member} must be a non-blank string`),
      ],
      [
        `a glob ${member}`,
        { [member]: "reports/*.json" },
        new RegExp(
          `mutationReport ${member} "reports/\\*\\.json" looks like a glob`,
        ),
      ],
      [
        `a character-class ${member}`,
        { [member]: "reports/mutation-[12].json" },
        new RegExp(`mutationReport ${member} .* looks like a glob`),
      ],
      [
        `an absolute ${member}`,
        { [member]: "/var/tmp/baseline.json" },
        new RegExp(`mutationReport ${member} .* must be repo-relative`),
      ],
      [
        `a drive-absolute ${member}`,
        { [member]: "C:\\tmp\\baseline.json" },
        new RegExp(`mutationReport ${member} .* must be repo-relative`),
      ],
      [
        `a traversing ${member}`,
        { [member]: "../outside/baseline.json" },
        new RegExp(
          `mutationReport ${member} .* must not traverse outside the worktree`,
        ),
      ],
    ]),
  )(
    "[behavior:#304:B-02] refuses %s, naming the member at fault",
    (_label, extra: Record<string, unknown>, expected: RegExp) => {
      expect(() =>
        parseAfkManifest({
          version: 1,
          selectedSlices: ["01"],
          mutationReport: {
            command: "pnpm run mutate",
            reportPath: "reports/mutation.json",
            ...extra,
          },
        }),
      ).toThrow(expected);
    },
  );

  it("[behavior:#303:P-02] [behavior:#304:P-02] still refuses a foreign version and still returns every existing member", () => {
    expect(() => parseAfkManifest({ version: 2, selectedSlices: ["01"] })).toThrow();
    expect(() => parseAfkManifest({ selectedSlices: ["01"] })).toThrow();
    // The new optional member did not loosen anything that was already checked.
    expect(() =>
      parseAfkManifest({
        version: 1,
        selectedSlices: ["01"],
        migrationPrefixes: ["144", "144"],
      }),
    ).toThrow(/unique numeric prefixes/);
    expect(
      parseAfkManifest({
        version: 1,
        selectedSlices: ["2"],
        migrationPrefixes: ["144"],
        protectedIssues: [{ number: 759, state: "closed" }],
        protectedChangeWaivers: [
          {
            riskClass: "gate-policy",
            path: "./src\\a.ts",
            author: "eric",
            reason: "why",
          },
        ],
        mutationReport: {
          command: "pnpm run mutate",
          reportPath: "reports/mutation.json",
        },
      }),
    ).toEqual({
      version: 1,
      selectedSlices: ["02"],
      migrationPrefixes: ["144"],
      protectedIssues: [{ number: 759, state: "CLOSED" }],
      protectedChangeWaivers: [
        {
          riskClass: "gate-policy",
          path: "src/a.ts",
          author: "eric",
          reason: "why",
        },
      ],
      mutationReport: {
        command: "pnpm run mutate",
        reportPath: "reports/mutation.json",
      },
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

  it("[behavior:#303:B-05] keeps the mutation declaration when the ship gate rewrites the manifest", () => {
    const prd = tempPrd();
    const mutationReport = {
      command: "pnpm run mutate",
      reportPath: "reports/mutation.json",
    };
    writeFileSync(
      join(prd, "afk.json"),
      JSON.stringify({
        version: 1,
        selectedSlices: ["01"],
        migrationPrefixes: ["144", "145"],
        protectedIssues: [],
        mutationReport,
      }),
    );

    const result = trimUnclaimedMigrationPrefixes(prd, ["145"]);

    expect(result.changed).toBe(true);
    expect(result.manifest.mutationReport).toEqual(mutationReport);
    // The trim rewrites the whole file, and the ship gate's own mutation step
    // reads this declaration on a later run: dropping it here would silently
    // turn a declared run into `MUTATION_NOT_RUN`.
    expect(
      JSON.parse(readFileSync(join(prd, "afk.json"), "utf-8")).mutationReport,
    ).toEqual(mutationReport);
  });

  it("[behavior:#304:B-03] keeps both attribution paths when the ship gate rewrites the manifest", () => {
    const prd = tempPrd();
    const mutationReport = {
      command: "pnpm run mutate",
      reportPath: "reports/mutation.json",
      baselinePath: "reports/mutation/incremental.json",
      decisionsPath: "docs/mutation-decisions.json",
    };
    writeFileSync(
      join(prd, "afk.json"),
      JSON.stringify({
        version: 1,
        selectedSlices: ["01"],
        migrationPrefixes: ["144", "145"],
        protectedIssues: [],
        mutationReport,
      }),
    );

    const result = trimUnclaimedMigrationPrefixes(prd, ["145"]);

    expect(result.changed).toBe(true);
    expect(result.manifest.mutationReport).toEqual(mutationReport);
    // The bytes on disk are what a later run reads: a key the rewrite dropped
    // would silently turn an attributed run into an unattributed one, with no
    // diagnosis anywhere.
    expect(
      JSON.parse(readFileSync(join(prd, "afk.json"), "utf-8")).mutationReport,
    ).toEqual(mutationReport);
  });
});

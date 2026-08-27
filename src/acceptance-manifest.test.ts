import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseAcceptanceManifest,
  validateAcceptanceManifestCoverage,
  validateAcceptanceManifestStability,
} from "./acceptance-manifest.js";

const validBehavior = {
  id: "B-01",
  source: "GH #76 AC3",
  given: "a version 2 manifest",
  when: "the manifest is parsed",
  then: "the behavior is accepted",
  observableResult: "parsing returns the behavior declaration",
  preservation: false,
  gateIds: ["tests"],
};

function version2Manifest(
  behaviors: unknown = [validBehavior],
): Record<string, unknown> {
  return {
    version: 2,
    fileScope: { kind: "paths", paths: ["src/a.ts"] },
    migrationCount: 0,
    behaviors,
  };
}

describe("acceptance-manifest.json", () => {
  it("parses version 1 and version 2 while preserving scope behavior", () => {
    expect(
      parseAcceptanceManifest({
        version: 1,
        fileScope: { kind: "paths", paths: [" ./SRC\\a.ts ", "docs/b.md"] },
        migrationCount: 1,
      }),
    ).toEqual({
      version: 1,
      fileScope: { kind: "paths", paths: ["src/a.ts", "docs/b.md"] },
      migrationCount: 1,
    });

    expect(
      parseAcceptanceManifest({
        version: 1,
        fileScope: { kind: "no-repository-changes" },
        migrationCount: 0,
      }),
    ).toEqual({
      version: 1,
      fileScope: { kind: "no-repository-changes" },
      migrationCount: 0,
    });

    expect(parseAcceptanceManifest(version2Manifest())).toEqual(
      version2Manifest(),
    );
  });

  it.each([
    [{ version: 3, fileScope: { kind: "paths", paths: ["src/a.ts"] }, migrationCount: 0 }, /version 1 or 2/],
    [{ version: 1, fileScope: { kind: "paths", paths: [] }, migrationCount: 0 }, /non-empty paths/],
    [{ version: 1, fileScope: { kind: "paths", paths: ["<unknown>"] }, migrationCount: 0 }, /placeholder/],
    [{ version: 1, fileScope: { kind: "paths", paths: ["src/*.ts"] }, migrationCount: 0 }, /glob/],
    [{ version: 1, fileScope: { kind: "paths", paths: ["../outside.ts"] }, migrationCount: 0 }, /repo-relative/],
    [{ version: 1, fileScope: { kind: "paths", paths: ["/outside.ts"] }, migrationCount: 0 }, /repo-relative/],
    [{ version: 1, fileScope: { kind: "paths", paths: ["C:\\outside.ts"] }, migrationCount: 0 }, /repo-relative/],
    [{ version: 1, fileScope: { kind: "paths", paths: ["C:outside.ts"] }, migrationCount: 0 }, /repo-relative/],
    [{ version: 1, fileScope: { kind: "paths", paths: ["src//a.ts"] }, migrationCount: 0 }, /repo-relative/],
    [{ version: 1, fileScope: { kind: "paths", paths: ["src/"] }, migrationCount: 0 }, /file path/],
    [{ version: 1, fileScope: { kind: "paths", paths: ["./SRC/a.ts", "src/a.ts"] }, migrationCount: 0 }, /unique/],
    [{ version: 1, fileScope: { kind: "paths", paths: ["src/a.ts"] }, migrationCount: -1 }, /non-negative safe integer/],
    [{ version: 1, fileScope: { kind: "paths", paths: ["src/a.ts"] }, migrationCount: 1.5 }, /non-negative safe integer/],
    [{ version: 1, fileScope: { kind: "paths", paths: ["src/a.ts"] }, migrationCount: 9_007_199_254_740_992 }, /non-negative safe integer/],
    [{ version: 1, fileScope: { kind: "no-repository-changes" }, migrationCount: 1 }, /migrationCount 0/],
  ])("rejects an invalid declaration: %j", (value, defect) => {
    expect(() => parseAcceptanceManifest(value)).toThrow(defect);
  });

  const behaviorStringFields = [
    "id",
    "source",
    "given",
    "when",
    "then",
    "observableResult",
  ] as const;
  const behaviorStringDefects = behaviorStringFields.flatMap<
    [string, unknown, RegExp]
  >((field) => [
    [
      `missing ${field}`,
      version2Manifest([{ ...validBehavior, [field]: undefined }]),
      new RegExp(field),
    ],
    [
      `numeric ${field}`,
      version2Manifest([{ ...validBehavior, [field]: 42 }]),
      new RegExp(field),
    ],
    [
      `blank ${field}`,
      version2Manifest([{ ...validBehavior, [field]: "   " }]),
      new RegExp(field),
    ],
  ]);

  const behaviorSchemaDefects: Array<[string, unknown, RegExp]> = [
    ["missing behaviors", { ...version2Manifest(), behaviors: undefined }, /behaviors/],
    ["object behaviors", version2Manifest(validBehavior), /behaviors.*array/],
    ["empty behaviors", version2Manifest([]), /behaviors.*non-empty/],
    ...behaviorStringDefects,
    [
      "missing preservation",
      version2Manifest([{ ...validBehavior, preservation: undefined }]),
      /preservation/,
    ],
    [
      "string preservation",
      version2Manifest([{ ...validBehavior, preservation: "false" }]),
      /preservation/,
    ],
    [
      "missing gateIds",
      version2Manifest([{ ...validBehavior, gateIds: undefined }]),
      /gateIds/,
    ],
    [
      "string gateIds",
      version2Manifest([{ ...validBehavior, gateIds: "tests" }]),
      /gateIds.*array/,
    ],
    [
      "empty gateIds",
      version2Manifest([{ ...validBehavior, gateIds: [] }]),
      /gateIds.*non-empty/,
    ],
    [
      "numeric gate ID",
      version2Manifest([{ ...validBehavior, gateIds: [1] }]),
      /gateIds.*strings/,
    ],
    [
      "blank gate ID",
      version2Manifest([{ ...validBehavior, gateIds: [" "] }]),
      /gateIds.*non-blank/,
    ],
    [
      "duplicate gate ID",
      version2Manifest([{ ...validBehavior, gateIds: ["tests", "tests"] }]),
      /gateIds.*unique.*tests/,
    ],
    [
      "extra behavior key",
      version2Manifest([{ ...validBehavior, note: "unexpected" }]),
      /behavior.*exactly/,
    ],
    [
      "duplicate behavior ID",
      version2Manifest([
        validBehavior,
        { ...validBehavior, source: "GH #76 duplicate" },
      ]),
      /behavior IDs.*unique.*B-01/,
    ],
  ];

  it.each(behaviorSchemaDefects)(
    "rejects version 2 behavior schema defect: %s",
    (_name, value, defect) => {
      expect(() => parseAcceptanceManifest(value)).toThrow(defect);
    },
  );

  it("reports every missing and duplicate controlled behavior anchor", () => {
    const contract = [
      "### In scope",
      "- [behavior:B-01] First controlled behavior.",
      "- [behavior:B-02] Second controlled behavior.",
      "- [behavior:B-03] Duplicate controlled behavior.",
      "- [behavior:B-03] Duplicate controlled behavior again.",
      "Ordinary prose mentions [behavior:B-DECOY] but is not an anchor.",
      "### Existing behavior to preserve",
      "- [behavior:P-01] First preserved behavior.",
      "- [behavior:P-02] Second preserved behavior.",
      "### Test plan",
      "- [behavior:B-DECOY] An anchor-shaped line outside controlled sections.",
    ].join("\n");
    const manifest = parseAcceptanceManifest(
      version2Manifest([
        validBehavior,
        { ...validBehavior, id: "B-03" },
        { ...validBehavior, id: "P-01", preservation: true },
      ]),
    );

    expect(() =>
      validateAcceptanceManifestCoverage(contract, manifest),
    ).toThrow(
      /missing behavior anchors: B-02, P-02; duplicate behavior anchors: B-03/,
    );
  });

  it("allows gate changes but refuses case-sensitive behavior ID changes", () => {
    const previous = parseAcceptanceManifest(version2Manifest());
    const gateChanged = parseAcceptanceManifest(
      version2Manifest([{ ...validBehavior, gateIds: ["typecheck"] }]),
    );
    const idChanged = parseAcceptanceManifest(
      version2Manifest([{ ...validBehavior, id: "b-01" }]),
    );

    expect(() =>
      validateAcceptanceManifestStability(previous, gateChanged),
    ).not.toThrow();
    expect(() =>
      validateAcceptanceManifestStability(previous, idChanged),
    ).toThrow(/B-01.*b-01/);
  });

  it("requires the planner to write the machine declaration beside the contract", () => {
    const prompt = readFileSync(
      join(process.cwd(), "prompts", "planner.md"),
      "utf-8",
    );

    expect(prompt).toContain("acceptance-manifest.json");
    expect(prompt).toContain('"version": 1');
    expect(prompt).toContain('"no-repository-changes"');
  });
});

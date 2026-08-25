import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAcceptanceManifest } from "./acceptance-manifest.js";

describe("acceptance-manifest.json", () => {
  it("normalizes concrete paths and preserves explicit no-change scope", () => {
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
  });

  it.each([
    [{ version: 2, fileScope: { kind: "paths", paths: ["src/a.ts"] }, migrationCount: 0 }, /version 1/],
    [{ version: 1, fileScope: { kind: "paths", paths: [] }, migrationCount: 0 }, /non-empty paths/],
    [{ version: 1, fileScope: { kind: "paths", paths: ["<unknown>"] }, migrationCount: 0 }, /placeholder/],
    [{ version: 1, fileScope: { kind: "paths", paths: ["src/*.ts"] }, migrationCount: 0 }, /glob/],
    [{ version: 1, fileScope: { kind: "paths", paths: ["../outside.ts"] }, migrationCount: 0 }, /repo-relative/],
    [{ version: 1, fileScope: { kind: "paths", paths: ["/outside.ts"] }, migrationCount: 0 }, /repo-relative/],
    [{ version: 1, fileScope: { kind: "paths", paths: ["C:\\outside.ts"] }, migrationCount: 0 }, /repo-relative/],
    [{ version: 1, fileScope: { kind: "paths", paths: ["C:outside.ts"] }, migrationCount: 0 }, /repo-relative/],
    [{ version: 1, fileScope: { kind: "paths", paths: ["src/"] }, migrationCount: 0 }, /file path/],
    [{ version: 1, fileScope: { kind: "paths", paths: ["./SRC/a.ts", "src/a.ts"] }, migrationCount: 0 }, /unique/],
    [{ version: 1, fileScope: { kind: "paths", paths: ["src/a.ts"] }, migrationCount: -1 }, /non-negative safe integer/],
    [{ version: 1, fileScope: { kind: "paths", paths: ["src/a.ts"] }, migrationCount: 1.5 }, /non-negative safe integer/],
    [{ version: 1, fileScope: { kind: "paths", paths: ["src/a.ts"] }, migrationCount: 9_007_199_254_740_992 }, /non-negative safe integer/],
    [{ version: 1, fileScope: { kind: "no-repository-changes" }, migrationCount: 1 }, /migrationCount 0/],
  ])("rejects an invalid declaration: %j", (value, defect) => {
    expect(() => parseAcceptanceManifest(value)).toThrow(defect);
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

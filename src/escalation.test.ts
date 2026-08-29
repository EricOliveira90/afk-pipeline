import { describe, expect, it } from "vitest";
import { parseAcceptanceManifest } from "./acceptance-manifest.js";
import {
  PRE_BUILD_SCOPE_FINDING_ID,
  parseScopeEscalation,
} from "./escalation.js";

const MANIFEST = parseAcceptanceManifest({
  version: 1,
  fileScope: {
    kind: "paths",
    paths: ["src/declared.ts"],
  },
  migrationCount: 0,
});

const VALID = {
  version: 1,
  findingIds: ["F-17", "F-18"],
  paths: ["src/extra-a.ts", "src/extra-b.ts"],
  reason: "both parser modules must change",
};

describe("parseScopeEscalation", () => {
  it("accepts exact, non-empty evidence for undeclared non-migration paths", () => {
    expect(parseScopeEscalation(JSON.stringify(VALID), MANIFEST)).toEqual(VALID);
  });

  it.each([
    ["invalid JSON", "{", /not valid JSON/],
    ["a non-object root", "[]", /must contain a JSON object/],
    [
      "a missing findingIds field",
      JSON.stringify({ ...VALID, findingIds: undefined }),
      /must contain exactly/,
    ],
    [
      "a missing paths field",
      JSON.stringify({ ...VALID, paths: undefined }),
      /must contain exactly/,
    ],
    [
      "an extra field",
      JSON.stringify({ ...VALID, extra: true }),
      /must contain exactly/,
    ],
    [
      "the wrong version",
      JSON.stringify({ ...VALID, version: 2 }),
      /must declare version 1/,
    ],
    [
      "wrong-typed findingIds",
      JSON.stringify({ ...VALID, findingIds: "F-17" }),
      /findingIds must be a non-empty array/,
    ],
    [
      "wrong-typed paths",
      JSON.stringify({ ...VALID, paths: {} }),
      /paths must be a non-empty array/,
    ],
    [
      "a wrong-typed reason",
      JSON.stringify({ ...VALID, reason: 7 }),
      /reason must be a non-blank string/,
    ],
    [
      "empty findingIds",
      JSON.stringify({ ...VALID, findingIds: [] }),
      /findingIds must be a non-empty array/,
    ],
    [
      "empty paths",
      JSON.stringify({ ...VALID, paths: [] }),
      /paths must be a non-empty array/,
    ],
    [
      "a blank finding ID",
      JSON.stringify({ ...VALID, findingIds: [" "] }),
      /findingIds must contain only non-blank strings/,
    ],
    [
      "a blank path",
      JSON.stringify({ ...VALID, paths: [" "] }),
      /paths must contain only non-blank strings/,
    ],
    [
      "a blank reason",
      JSON.stringify({ ...VALID, reason: " \t" }),
      /reason must be a non-blank string/,
    ],
    [
      "duplicate finding IDs",
      JSON.stringify({ ...VALID, findingIds: ["F-17", "F-17"] }),
      /findingIds must be unique/,
    ],
    [
      "normalized duplicate paths",
      JSON.stringify({ ...VALID, paths: ["src/extra.ts", "./SRC/extra.ts"] }),
      /normalized paths must be unique/,
    ],
    [
      "a non-declarable path",
      JSON.stringify({ ...VALID, paths: ["../outside.ts"] }),
      /exact repo-relative path/,
    ],
    [
      "an already-declared path",
      JSON.stringify({ ...VALID, paths: ["./SRC/declared.ts"] }),
      /already on the locked file scope/,
    ],
    [
      "a migration path",
      JSON.stringify({
        ...VALID,
        paths: ["supabase/migrations/0042_add_table.sql"],
      }),
      /migration prefixes are allocated at contract lock/,
    ],
  ])("refuses %s", (_name, raw, expected) => {
    expect(() => parseScopeEscalation(raw, MANIFEST)).toThrow(expected);
  });

  it("uses the configured migration path pattern", () => {
    expect(() =>
      parseScopeEscalation(
        JSON.stringify({ ...VALID, paths: ["db/changes/0042.sql"] }),
        MANIFEST,
        { migrationPathPattern: /(^|\/)changes\/.*\.sql$/ },
      ),
    ).toThrow(/migration prefixes are allocated at contract lock/);
  });

  it("preserves path casing while normalizing separators for planner evidence", () => {
    expect(
      parseScopeEscalation(
        JSON.stringify({
          ...VALID,
          findingIds: [" F-17 "],
          paths: [".\\src\\Extra.ts"],
          reason: "  required by the parser  ",
        }),
        MANIFEST,
      ),
    ).toEqual({
      version: 1,
      findingIds: ["F-17"],
      paths: ["src/Extra.ts"],
      reason: "required by the parser",
    });
  });

  // The pre-build identity (ADR 0052). It exists so an initial generator
  // handed no findings has a legal identity to cite; it must not become a
  // way to widen scope with no reason, and it must not become a way to
  // slip an uncited path in beside a cited one.
  describe(`the reserved ${PRE_BUILD_SCOPE_FINDING_ID} identity`, () => {
    it("is accepted alone, as a pre-build scope discovery", () => {
      const artifact = {
        ...VALID,
        findingIds: [PRE_BUILD_SCOPE_FINDING_ID],
      };
      expect(parseScopeEscalation(JSON.stringify(artifact), MANIFEST)).toEqual(
        artifact,
      );
    });

    it("is refused alongside a cited finding ID", () => {
      expect(() =>
        parseScopeEscalation(
          JSON.stringify({
            ...VALID,
            findingIds: [PRE_BUILD_SCOPE_FINDING_ID, "F-17"],
          }),
          MANIFEST,
        ),
      ).toThrow(/must not mix PRE-BUILD-SCOPE with cited finding IDs \(F-17\)/);
    });

    it("does not relax the empty-findingIds refusal", () => {
      expect(() =>
        parseScopeEscalation(
          JSON.stringify({ ...VALID, findingIds: [] }),
          MANIFEST,
        ),
      ).toThrow(/findingIds must be a non-empty array/);
    });

    it("does not relax the blank-reason refusal", () => {
      expect(() =>
        parseScopeEscalation(
          JSON.stringify({
            ...VALID,
            findingIds: [PRE_BUILD_SCOPE_FINDING_ID],
            reason: "   ",
          }),
          MANIFEST,
        ),
      ).toThrow(/reason must be a non-blank string/);
    });

    it("does not relax the already-declared-path refusal", () => {
      expect(() =>
        parseScopeEscalation(
          JSON.stringify({
            ...VALID,
            findingIds: [PRE_BUILD_SCOPE_FINDING_ID],
            paths: ["src/declared.ts"],
          }),
          MANIFEST,
        ),
      ).toThrow(/paths already on the locked file scope/);
    });
  });
});

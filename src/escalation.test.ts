import { describe, expect, it } from "vitest";
import { parseAcceptanceManifest } from "./acceptance-manifest.js";
import {
  PRE_BUILD_SCOPE_FINDING_ID,
  outOfScopeChangedPaths,
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
    [
      // Two `findingIds` in one artifact claims both a cited-finding fix and
      // a pre-build discovery. `requireExactKeys` reads the *parsed* object
      // and sees one well-formed field, so the raw bytes have to be scanned
      // (PM blocker 1, fifth adjudication gate round).
      "a repeated key",
      '{"version":1,"findingIds":["F-17"],"findingIds":["PRE-BUILD-SCOPE"],' +
        '"paths":["src/extra.ts"],"reason":"needed"}',
      /repeats the key "findingIds"/,
    ],
    [
      "a repeated key whose duplicate is the one JSON.parse keeps",
      '{"version":1,"findingIds":["F-17"],"paths":["src/extra.ts"],' +
        '"reason":"needed","reason":"also needed"}',
      /repeats the key "reason"/,
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

/**
 * The grant guard's unit half (architect blocker 1, fifth adjudication gate
 * round). Which changed paths count as out of scope is a pure decision over
 * three inputs, so it belongs here and not in a spawned pipeline (AGENTS.md,
 * "where a new assertion goes"). The spawned scenarios in
 * `orchestrator.test.ts` carry only the two claims a unit test cannot: that
 * the guard runs before the revision, and that an honest escalation still
 * gets its grant.
 */
describe("outOfScopeChangedPaths", () => {
  const SLICE_DIR = ".kiro/specs/demo/slices/01-thing";
  const call = (changedFiles: string[], manifest = MANIFEST) =>
    outOfScopeChangedPaths({
      changedFiles,
      manifest,
      sliceArtifactDir: SLICE_DIR,
    });

  it("passes a tree that changed only declared paths", () => {
    expect(call(["src/declared.ts"])).toEqual([]);
  });

  it("names an undeclared change", () => {
    expect(call(["src/declared.ts", "src/undeclared.ts"])).toEqual([
      "src/undeclared.ts",
    ]);
  });

  it("reports every undeclared change, not just the first", () => {
    expect(call(["b/two.ts", "a/one.ts"])).toEqual(["a/one.ts", "b/two.ts"]);
  });

  /**
   * The exemption is a directory prefix, and it has to be: a filename-list
   * exemption built from `artifacts.sliceArtifactNames()` omits
   * `escalation.md`, `acceptance-manifest.json` and both adjudication files,
   * so it would refuse every honest escalation on the very artifact that
   * raised it.
   */
  it("exempts anything under the slice artifact directory", () => {
    expect(
      call([
        `${SLICE_DIR}/escalation.md`,
        `${SLICE_DIR}/handoff.md`,
        `${SLICE_DIR}/acceptance-manifest.json`,
        `${SLICE_DIR}/adjudication-decisions.json`,
        `${SLICE_DIR}/nested/anything.txt`,
      ]),
    ).toEqual([]);
  });

  it("does not exempt a sibling slice, or the specs dir above it", () => {
    expect(
      call([
        ".kiro/specs/demo/slices/02-other/contract.md",
        ".kiro/specs/demo/prd.md",
        ".kiro/specs/demo/slices/01-thing-extra/x.md",
      ]),
    ).toEqual([
      ".kiro/specs/demo/prd.md",
      ".kiro/specs/demo/slices/01-thing-extra/x.md",
      ".kiro/specs/demo/slices/02-other/contract.md",
    ]);
  });

  it("matches the exemption by the manifest's own normalization", () => {
    // Backslashes, a `./` prefix and a different case all name the same
    // file. A second normalization dialect here would exempt a path on one
    // platform and refuse it on another.
    expect(
      call([
        `./${SLICE_DIR}/escalation.md`,
        [SLICE_DIR, "handoff.md"].join("/").split("/").join(String.fromCharCode(92)),
        `${SLICE_DIR.toUpperCase()}/contract.md`,
      ]),
    ).toEqual([]);
  });

  /**
   * `fileScope` forbids placeholders and globs and a migration's filename is
   * chosen at build time, so a migration can never be a declared path —
   * `planScopeAmendment` refuses migration paths for that exact reason.
   * Refusing them here would refuse every escalation from every slice with a
   * migration to write; the reserved-prefix claim gate owns them instead
   * (ADR 0028/0034).
   */
  it("exempts migration files, which no file scope can declare", () => {
    expect(call(["supabase/migrations/0012_add_thing.sql"])).toEqual([]);
  });

  it("reports a path it cannot normalize rather than skipping it", () => {
    // An unclassifiable path is not evidence that the tree is clean.
    expect(call(["src/weird[1].ts"])).toEqual(["src/weird[1].ts"]);
  });

  it("treats every change as out of scope for a no-repository-changes lock", () => {
    const noChanges = parseAcceptanceManifest({
      version: 1,
      fileScope: { kind: "no-repository-changes" },
      migrationCount: 0,
    });
    expect(call(["src/declared.ts"], noChanges)).toEqual(["src/declared.ts"]);
    // The slice's own artifacts are still its own.
    expect(call([`${SLICE_DIR}/escalation.md`], noChanges)).toEqual([]);
  });
});

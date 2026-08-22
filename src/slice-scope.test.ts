import { describe, expect, it } from "vitest";
import type { Slice } from "./issues-parser.js";
import { resolveOnlyFailedSelection, resolveRunScope } from "./slice-scope.js";

const SLICES: Slice[] = [
  {
    number: "01",
    ghIssue: "101",
    title: "Foundation",
    type: "AFK",
    blockedBy: [],
    userStories: "",
  },
  {
    number: "02",
    ghIssue: "102",
    title: "Automation",
    type: "AFK",
    blockedBy: ["101"],
    userStories: "",
  },
  {
    number: "03",
    ghIssue: "103",
    title: "Manual review",
    type: "HITL",
    blockedBy: [],
    userStories: "",
  },
];

describe("resolveRunScope", () => {
  it("resolves an explicit AFK-only selection in manifest order", () => {
    const scope = resolveRunScope(SLICES, ["02", "01"]);

    expect(scope.persisted).toEqual({
      mode: "explicit",
      slices: [
        { number: "01", ghIssue: "101" },
        { number: "02", ghIssue: "102" },
      ],
    });
    expect(scope.selected.map((slice) => slice.number)).toEqual(["01", "02"]);
    expect(scope.skipped).toMatchObject([
      { slice: { number: "03" }, reason: "hitl" },
    ]);
  });

  it("rejects selecting a declared HITL slice", () => {
    expect(() => resolveRunScope(SLICES, ["03"])).toThrow(
      /declared HITL; only AFK slices can run/,
    );
  });

  it("uses the persisted scope on retry and refuses a changed selection", () => {
    const first = resolveRunScope(SLICES, ["01"]);
    const expandedManifest = [
      ...SLICES,
      {
        number: "04",
        ghIssue: "104",
        title: "New AFK work",
        type: "AFK" as const,
        blockedBy: [],
        userStories: "",
      },
    ];

    const retry = resolveRunScope(
      expandedManifest,
      undefined,
      first.persisted,
    );
    expect(retry.selected.map((slice) => slice.number)).toEqual(["01"]);
    expect(retry.skipped).toMatchObject([
      { slice: { number: "02" }, reason: "not-selected" },
      { slice: { number: "03" }, reason: "hitl" },
      { slice: { number: "04" }, reason: "not-selected" },
    ]);

    expect(() =>
      resolveRunScope(expandedManifest, ["01", "04"], first.persisted),
    ).toThrow(/do not match the persisted run scope/);
  });

  it("accepts a strict subset of the persisted scope and marks the excluded members narrowed", () => {
    const first = resolveRunScope(SLICES, undefined);

    const narrowed = resolveRunScope(SLICES, ["02"], first.persisted);

    expect(narrowed.members.map((slice) => slice.number)).toEqual(["01", "02"]);
    expect(narrowed.selected.map((slice) => slice.number)).toEqual(["02"]);
    // The persisted scope of record is untouched by the narrowing, so a
    // later full re-run still knows the original selection.
    expect(narrowed.persisted).toEqual(first.persisted);
    expect(narrowed.skipped).toMatchObject([
      { slice: { number: "01" }, reason: "narrowed" },
      { slice: { number: "03" }, reason: "hitl" },
    ]);
  });

  it("ignores persisted members removed from issues.md without rewriting the scope of record", () => {
    const first = resolveRunScope(SLICES, undefined);
    const currentManifest = SLICES.filter((slice) => slice.number !== "01");

    const retry = resolveRunScope(currentManifest, undefined, first.persisted);

    expect(retry.persisted).toEqual(first.persisted);
    expect(retry.members.map((slice) => slice.number)).toEqual(["02"]);
    expect(retry.selected.map((slice) => slice.number)).toEqual(["02"]);
  });

  it("still rejects newly added work after a persisted member was removed", () => {
    const first = resolveRunScope(SLICES, ["01", "02"]);
    const currentManifest = [
      SLICES[1]!,
      {
        number: "04",
        ghIssue: "104",
        title: "New AFK work",
        type: "AFK" as const,
        blockedBy: [],
        userStories: "",
      },
    ];

    expect(() =>
      resolveRunScope(currentManifest, ["02", "04"], first.persisted),
    ).toThrow(/do not match the persisted run scope/);
  });

  it("rejects a selection that adds work outside the persisted scope", () => {
    const first = resolveRunScope(SLICES, ["01"]);

    expect(() => resolveRunScope(SLICES, ["01", "02"], first.persisted)).toThrow(
      /do not match the persisted run scope/,
    );
    expect(() => resolveRunScope(SLICES, ["02"], first.persisted)).toThrow(
      /do not match the persisted run scope/,
    );
  });

  it("preserves legacy behavior by selecting every AFK slice when omitted", () => {
    const scope = resolveRunScope(SLICES, undefined);

    expect(scope.persisted.mode).toBe("all-afk");
    expect(scope.selected.map((slice) => slice.number)).toEqual(["01", "02"]);
    expect(scope.skipped).toMatchObject([
      { slice: { number: "03" }, reason: "hitl" },
    ]);
  });
});

describe("resolveOnlyFailedSelection", () => {
  const persisted = {
    mode: "all-afk" as const,
    slices: [
      { number: "01", ghIssue: "101" },
      { number: "02", ghIssue: "102" },
    ],
  };

  it("selects the persisted-scope members that are not recorded complete", () => {
    expect(resolveOnlyFailedSelection(SLICES.slice(0, 2), (id) => id === "101")).toEqual([
      "02",
    ]);
  });

  it("selects every member when none is recorded complete", () => {
    expect(resolveOnlyFailedSelection(SLICES.slice(0, 2), () => false)).toEqual([
      "01",
      "02",
    ]);
  });

  it("selects nothing when every member is recorded complete", () => {
    expect(resolveOnlyFailedSelection(SLICES.slice(0, 2), () => true)).toEqual([]);
  });

  it("feeds resolveRunScope a subset the persisted scope accepts", () => {
    const failed = resolveOnlyFailedSelection(SLICES.slice(0, 2), (id) => id === "101");

    const scope = resolveRunScope(SLICES, failed, persisted);

    expect(scope.selected.map((slice) => slice.ghIssue)).toEqual(["102"]);
  });

  it("does not select persisted identities that are absent from issues.md", () => {
    const extant = [SLICES[1]!];

    expect(resolveOnlyFailedSelection(extant, () => false)).toEqual(["02"]);
  });
});

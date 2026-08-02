import { describe, expect, it } from "vitest";
import type { Slice } from "./issues-parser.js";
import { resolveRunScope } from "./slice-scope.js";

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

  it("preserves legacy behavior by selecting every AFK slice when omitted", () => {
    const scope = resolveRunScope(SLICES, undefined);

    expect(scope.persisted.mode).toBe("all-afk");
    expect(scope.selected.map((slice) => slice.number)).toEqual(["01", "02"]);
    expect(scope.skipped).toMatchObject([
      { slice: { number: "03" }, reason: "hitl" },
    ]);
  });
});

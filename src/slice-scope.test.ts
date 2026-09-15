import { describe, expect, it } from "vitest";
import type { Slice } from "./issues-parser.js";
import {
  appendScopeExtensions,
  resolveOnlyFailedSelection,
  resolveRunScope,
  type PersistedRunScope,
  type PersistedScopeSlice,
} from "./slice-scope.js";

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

/*
 * ---------------------------------------------------------------------------
 * Appending admitted scope extensions (#278 B-08)
 * ---------------------------------------------------------------------------
 *
 * The one widening a run's scope of record can undergo. It lives here rather
 * than in the recovery module so it is reviewable beside `resolveRunScope`'s
 * narrow-only rule, and it is pure so the locked completion that publishes both
 * the terminal lineage event and the widened scope has no second writer.
 */
describe("[behavior:#278:B-08] appendScopeExtensions", () => {
  const SCOPE: PersistedRunScope = {
    mode: "explicit",
    slices: [
      { number: "02", ghIssue: "102" },
      { number: "01", ghIssue: "101" },
    ],
  };

  it("[behavior:#278:B-08] preserves every existing entry and its order and appends in canonical set order", () => {
    const widened = appendScopeExtensions(SCOPE, [
      { number: "10", ghIssue: "110" },
      { number: "03", ghIssue: "103" },
    ]);

    // The existing pair keeps the order it was persisted in — not re-sorted —
    // and the additions land after them, canonically ordered among themselves.
    expect(widened.slices).toEqual([
      { number: "02", ghIssue: "102" },
      { number: "01", ghIssue: "101" },
      { number: "03", ghIssue: "103" },
      { number: "10", ghIssue: "110" },
    ]);
  });

  it("[behavior:#278:B-08] orders canonical slice numbers numerically, then by GH issue", () => {
    // "10" after "9" is the case a string comparison gets wrong, and zero
    // padding is not part of the identity `canonicalSliceNumber` compares.
    const widened = appendScopeExtensions(
      { mode: "all-afk", slices: [] },
      [
        { number: "9", ghIssue: "209" },
        { number: "010", ghIssue: "210" },
        { number: "2", ghIssue: "202" },
        { number: "02", ghIssue: "201" },
      ],
    );

    expect(widened.slices).toEqual([
      { number: "02", ghIssue: "201" },
      { number: "2", ghIssue: "202" },
      { number: "9", ghIssue: "209" },
      { number: "010", ghIssue: "210" },
    ]);
  });

  it("[behavior:#278:B-08] leaves scope.mode unchanged", () => {
    for (const mode of ["all-afk", "explicit"] as const) {
      expect(
        appendScopeExtensions({ mode, slices: [] }, [
          { number: "03", ghIssue: "103" },
        ]).mode,
      ).toBe(mode);
    }
  });

  it("[behavior:#278:B-08] is pure: neither the scope nor the addition list is mutated", () => {
    const scope: PersistedRunScope = {
      mode: "explicit",
      slices: [{ number: "01", ghIssue: "101" }],
    };
    const additions = [
      { number: "03", ghIssue: "103" },
      { number: "02", ghIssue: "102" },
    ];

    const widened = appendScopeExtensions(scope, additions);

    expect(scope.slices).toEqual([{ number: "01", ghIssue: "101" }]);
    expect(additions).toEqual([
      { number: "03", ghIssue: "103" },
      { number: "02", ghIssue: "102" },
    ]);
    // A fresh document, entry by entry: the locked write publishes this, so a
    // shared entry object would let a later mutation reach the persisted scope.
    expect(widened).not.toBe(scope);
    expect(widened.slices[0]).not.toBe(scope.slices[0]);
    expect(widened.slices[0]).toEqual(scope.slices[0]);
  });

  it("[behavior:#278:B-08] appends a set: a repeated addition lands once", () => {
    const widened = appendScopeExtensions(SCOPE, [
      { number: "03", ghIssue: "103" },
      { number: "003", ghIssue: "103" },
      { number: "3", ghIssue: "103" },
    ]);

    expect(widened.slices.slice(2)).toEqual([{ number: "03", ghIssue: "103" }]);
  });

  it("[behavior:#278:B-08] returns the same scope shape for an empty addition set", () => {
    expect(appendScopeExtensions(SCOPE, [])).toEqual(SCOPE);
  });

  it("[behavior:#278:B-08] carries only the two members a persisted scope entry has", () => {
    const widened = appendScopeExtensions(SCOPE, [
      { number: "03", ghIssue: "103", extra: "ignored" } as PersistedScopeSlice,
    ]);

    for (const entry of widened.slices) {
      expect(Object.keys(entry).sort()).toEqual(["ghIssue", "number"]);
    }
  });

  it("[behavior:#278:P-02] leaves resolveRunScope narrow-only — the widened scope is what it reads, never what it makes", () => {
    const slices: Slice[] = [
      ...SLICES,
      {
        number: "04",
        ghIssue: "104",
        title: "Late addition",
        type: "AFK",
        blockedBy: [],
        userStories: "",
      },
    ];
    const before: PersistedRunScope = {
      mode: "explicit",
      slices: [{ number: "01", ghIssue: "101" }],
    };

    // Before the append, naming the addition still throws the superset refusal.
    expect(() => resolveRunScope(slices, ["04"], before)).toThrow(
      /never add to it/,
    );

    // After it, the same request resolves — because the persisted scope grew,
    // not because resolveRunScope learned to grow one.
    const after = appendScopeExtensions(before, [
      { number: "04", ghIssue: "104" },
    ]);
    const scope = resolveRunScope(slices, ["04"], after);

    expect(scope.persisted).toBe(after);
    expect(scope.members.map((slice) => slice.ghIssue)).toEqual(["101", "104"]);
    expect(scope.selected.map((slice) => slice.ghIssue)).toEqual(["104"]);
    expect(scope.skipped).toMatchObject([
      { slice: { number: "01" }, reason: "narrowed" },
      { slice: { number: "02" }, reason: "not-selected" },
      { slice: { number: "03" }, reason: "hitl" },
    ]);
  });
});

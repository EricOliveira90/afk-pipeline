/**
 * Unit tests for the learning-proposal schema (ADR 0066). A pure parser over
 * a JSON document - no git, no agents, no spawned scenario (AGENTS.md, "where
 * a new assertion goes", rung 1).
 */
import { describe, expect, it } from "vitest";
import {
  LEARNING_PROPOSAL_VERSION,
  SUPPORTED_LEARNING_PROPOSAL_VERSIONS,
  parseLearningProposals,
  type LearningProposal,
} from "./learning-proposal.js";

/**
 * The shape a rumo-app findings-ledger entry fills when
 * `post-merge-cleanup` reaches count 2: the class is the ledger's kebab-case
 * identifier, the two links are the ledger's "both occurrence links", the
 * target is the routed asset and the change is the skill's proposed diff.
 * Exactly the five fields, nothing the ledger cannot supply.
 */
const ledgerShapedProposal: LearningProposal = {
  findingClass: "migration-missing-rollback",
  occurrenceCount: 2,
  occurrences: [
    "https://github.com/EricOliveira90/rumo-app/pull/812#discussion_r1",
    "docs/governance/findings-ledger.md#2026-09-02-migration-missing-rollback",
  ],
  targetAsset: ".agents/skills/post-merge-cleanup/SKILL.md",
  proposedChange: [
    "--- a/.agents/skills/post-merge-cleanup/SKILL.md",
    "+++ b/.agents/skills/post-merge-cleanup/SKILL.md",
    "@@ -10,3 +10,4 @@",
    " - Check every migration has a rollback.",
    "+- Refuse to close when a migration lacks one.",
  ].join("\n"),
};

function document(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: LEARNING_PROPOSAL_VERSION,
    proposals: [ledgerShapedProposal],
    ...overrides,
  });
}

function withProposal(overrides: Record<string, unknown>): string {
  const proposal: Record<string, unknown> = {
    ...ledgerShapedProposal,
    ...overrides,
  };
  // `undefined` in an override means "omit the field" - JSON.stringify would
  // drop it anyway, but deleting keeps the intent visible.
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete proposal[key];
  }
  return document({ proposals: [proposal] });
}

describe("learning-proposals.json", () => {
  it("declares version 1 and accepts exactly that version", () => {
    expect(LEARNING_PROPOSAL_VERSION).toBe(1);
    expect([...SUPPORTED_LEARNING_PROPOSAL_VERSIONS]).toEqual([1]);
  });

  it("parses a valid document from text and from a parsed value alike", () => {
    const expected = {
      version: 1,
      proposals: [ledgerShapedProposal],
    };
    expect(parseLearningProposals(document())).toEqual(expected);
    expect(parseLearningProposals(JSON.parse(document()))).toEqual(expected);
  });

  it("accepts a rumo-app ledger-shaped proposal with the five fields only", () => {
    const parsed = parseLearningProposals(document());
    expect(Object.keys(parsed.proposals[0]!).sort()).toEqual([
      "findingClass",
      "occurrenceCount",
      "occurrences",
      "proposedChange",
      "targetAsset",
    ]);
  });

  it("accepts a non-file target as a stable token and prose as the change", () => {
    const parsed = parseLearningProposals(
      withProposal({
        occurrenceCount: 3,
        occurrences: ["#192", "#194", ".afk/artifacts/run-5/slice-03"],
        targetAsset: "eval-scenario",
        proposedChange:
          "Add a planner case where the ADR index already settles the question.",
      }),
    );
    expect(parsed.proposals[0]!.targetAsset).toBe("eval-scenario");
    expect(parsed.proposals[0]!.occurrenceCount).toBe(3);
  });

  it("accepts an empty proposals list", () => {
    expect(parseLearningProposals(document({ proposals: [] }))).toEqual({
      version: 1,
      proposals: [],
    });
  });

  it("trims string fields", () => {
    const parsed = parseLearningProposals(
      withProposal({ targetAsset: "  AGENTS.md  " }),
    );
    expect(parsed.proposals[0]!.targetAsset).toBe("AGENTS.md");
  });

  it("names the source in every error", () => {
    expect(() => parseLearningProposals("{", "custom.json")).toThrow(
      /^custom\.json is not valid JSON/,
    );
    expect(() =>
      parseLearningProposals(withProposal({ occurrenceCount: 1 }), "custom.json"),
    ).toThrow(/^custom\.json proposals\[0\]/);
  });

  describe("refuses, never skips", () => {
    it("invalid JSON", () => {
      expect(() => parseLearningProposals("{ not json")).toThrow(
        /learning-proposals\.json is not valid JSON/,
      );
    });

    it("a document that is not an object", () => {
      expect(() => parseLearningProposals("[]")).toThrow(
        /must contain a JSON object/,
      );
      expect(() => parseLearningProposals("null")).toThrow(
        /must contain a JSON object/,
      );
    });

    it("an unsupported version, including a future one", () => {
      expect(() => parseLearningProposals(document({ version: 2 }))).toThrow(
        /declares version 2; this reader accepts 1/,
      );
      expect(() => parseLearningProposals(document({ version: "1" }))).toThrow(
        /declares version "1"/,
      );
      expect(() =>
        parseLearningProposals(JSON.stringify({ proposals: [] })),
      ).toThrow(/declares version undefined/);
    });

    it("an unknown top-level field", () => {
      expect(() =>
        parseLearningProposals(document({ generatedAt: "2026-09-12" })),
      ).toThrow(/top-level fields version 1 does not define: generatedAt/);
    });

    it("a proposals member that is not an array", () => {
      expect(() => parseLearningProposals(document({ proposals: {} }))).toThrow(
        /proposals must be an array/,
      );
    });

    it("a proposal that is not an object", () => {
      expect(() =>
        parseLearningProposals(document({ proposals: ["x"] })),
      ).toThrow(/proposals\[0\] must be a JSON object/);
    });

    it("an unknown per-proposal field, naming the ledger fields it does not carry", () => {
      expect(() =>
        parseLearningProposals(
          withProposal({ disposition: "proposal opened", date: "2026-09-02" }),
        ),
      ).toThrow(
        /proposals\[0\] carries fields version 1 does not define: disposition, date/,
      );
    });

    it.each([
      "findingClass",
      "targetAsset",
      "proposedChange",
    ] as const)("a missing or blank %s", (field) => {
      expect(() =>
        parseLearningProposals(withProposal({ [field]: undefined })),
      ).toThrow(new RegExp(`proposals\\[0\\] requires a non-blank ${field}`));
      expect(() =>
        parseLearningProposals(withProposal({ [field]: "   " })),
      ).toThrow(new RegExp(`proposals\\[0\\] requires a non-blank ${field}`));
    });

    it("a missing occurrenceCount or occurrences", () => {
      expect(() =>
        parseLearningProposals(withProposal({ occurrenceCount: undefined })),
      ).toThrow(/occurrenceCount must be an integer of at least 2/);
      expect(() =>
        parseLearningProposals(withProposal({ occurrences: undefined })),
      ).toThrow(/occurrences must be an array of links/);
    });

    it.each([1, 0, -2, 2.5, "2", null])(
      "an occurrenceCount of %j",
      (occurrenceCount) => {
        expect(() =>
          parseLearningProposals(withProposal({ occurrenceCount })),
        ).toThrow(/occurrenceCount must be an integer of at least 2/);
      },
    );

    it("fewer than two occurrences", () => {
      expect(() =>
        parseLearningProposals(
          withProposal({ occurrences: ["#192"] }),
        ),
      ).toThrow(/occurrences must name at least two links/);
      expect(() =>
        parseLearningProposals(withProposal({ occurrences: [] })),
      ).toThrow(/occurrences must name at least two links/);
    });

    it("a blank occurrence link", () => {
      expect(() =>
        parseLearningProposals(withProposal({ occurrences: ["#192", ""] })),
      ).toThrow(/requires a non-blank occurrences\[1\]/);
    });

    it.each([
      "Migration-Missing-Rollback",
      "migration_missing_rollback",
      "migration missing rollback",
      "-leading",
      "trailing-",
      "double--hyphen",
      "café-finding",
    ])("a findingClass that is not kebab-case: %s", (findingClass) => {
      expect(() =>
        parseLearningProposals(withProposal({ findingClass })),
      ).toThrow(/findingClass .* is not kebab-case/);
    });

    it("an occurrenceCount that disagrees with occurrences.length, in either direction", () => {
      expect(() =>
        parseLearningProposals(withProposal({ occurrenceCount: 3 })),
      ).toThrow(/occurrenceCount \(3\) must equal the number of occurrences \(2\)/);
      expect(() =>
        parseLearningProposals(
          withProposal({
            occurrenceCount: 2,
            occurrences: ["#192", "#194", "#196"],
          }),
        ),
      ).toThrow(/occurrenceCount \(2\) must equal the number of occurrences \(3\)/);
    });

    it("stops at the first defective proposal and names its index", () => {
      expect(() =>
        parseLearningProposals(
          document({
            proposals: [
              ledgerShapedProposal,
              { ...ledgerShapedProposal, findingClass: "Bad Class" },
            ],
          }),
        ),
      ).toThrow(/proposals\[1\] findingClass "Bad Class" is not kebab-case/);
    });
  });
});

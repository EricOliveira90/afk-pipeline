import { describe, expect, it } from "vitest";
import {
  contractRevisionRegions,
  renderContractRevisionEvidence,
} from "./contract-revision-evidence.js";
import {
  parseContractReview,
  validateRound2ContractReview,
  type ContractResponse,
  type ContractReview,
} from "./contract-review.js";

const lines = (count: number, tag: string): string =>
  Array.from({ length: count }, (_, index) => `${tag} line ${index + 1}`).join(
    "\n",
  );

describe("contractRevisionRegions", () => {
  it("returns nothing for an unchanged artifact", () => {
    expect(contractRevisionRegions("same\ntext", "same\ntext")).toEqual([]);
  });

  it("names a replacement by prior and revised line span", () => {
    const before = "a\nb\nc\nd";
    const after = "a\nB1\nB2\nc\nd";
    expect(contractRevisionRegions(before, after)).toEqual([
      {
        beforeStart: 2,
        beforeLines: ["b"],
        afterStart: 2,
        afterLines: ["B1", "B2"],
      },
    ]);
  });

  it("marks a pure insertion with no prior lines", () => {
    expect(contractRevisionRegions("a\nb", "a\nnew\nb")).toEqual([
      { beforeStart: 0, beforeLines: [], afterStart: 2, afterLines: ["new"] },
    ]);
  });

  it("marks a pure deletion with no revised lines", () => {
    expect(contractRevisionRegions("a\ngone\nb", "a\nb")).toEqual([
      { beforeStart: 2, beforeLines: ["gone"], afterStart: 0, afterLines: [] },
    ]);
  });

  it("separates edits that are apart into one region each", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g"].join("\n");
    const after = ["a", "B", "c", "d", "e", "F", "g"].join("\n");
    const regions = contractRevisionRegions(before, after);
    expect(regions).toHaveLength(2);
    expect(regions.map(({ beforeLines }) => beforeLines)).toEqual([
      ["b"],
      ["f"],
    ]);
  });
});

describe("renderContractRevisionEvidence", () => {
  const revisions = {
    "contract.md": {
      before: "intro\nthe gate is advisory\noutro",
      after: "intro\nthe gate is required\noutro",
    },
    "acceptance-manifest.json": {
      before: '{\n  "version": 2\n}',
      after: '{\n  "version": 2\n}',
    },
  };

  it("quotes the changed region exactly on both sides", () => {
    const evidence = renderContractRevisionEvidence(revisions, 65_536);
    expect(evidence).toContain("the gate is advisory");
    expect(evidence).toContain("the gate is required");
    expect(evidence).toContain(
      "prior lines 2-2 became revised lines 2-2",
    );
  });

  it("says so when an artifact did not change, rather than quoting it", () => {
    const evidence = renderContractRevisionEvidence(revisions, 65_536);
    expect(evidence).toContain(
      "This revision left `acceptance-manifest.json` unchanged",
    );
    expect(evidence).not.toContain('"version": 2');
  });

  it("carries only the changed regions, not the artifact bulk", () => {
    // The #196 defect in one assertion: the block used to be
    // JSON.stringify(revisions, null, 2) — both whole artifacts, twice over.
    const bulky = {
      "contract.md": {
        before: `${lines(400, "shared")}\nprior tail`,
        after: `${lines(400, "shared")}\nrevised tail`,
      },
    };
    const evidence = renderContractRevisionEvidence(bulky, 65_536);
    expect(Buffer.byteLength(evidence, "utf-8")).toBeLessThan(600);
    expect(evidence).toContain("prior tail");
    expect(evidence).toContain("revised tail");
    expect(evidence).not.toContain("shared line 200");
  });

  it("fences content that itself contains a fence", () => {
    const evidence = renderContractRevisionEvidence(
      {
        "contract.md": {
          before: "head\nthe shape is undocumented\ntail",
          after: "head\n```json\n{ \"a\": 1 }\n```\ntail",
        },
      },
      65_536,
    );
    expect(evidence).toContain("````text");
  });

  it("drops whole regions and names the count when the budget is small", () => {
    const many = {
      "contract.md": {
        before: Array.from({ length: 12 }, (_, index) =>
          index % 2 === 0 ? `keep ${index}` : `prior body ${index}`,
        ).join("\n"),
        after: Array.from({ length: 12 }, (_, index) =>
          index % 2 === 0 ? `keep ${index}` : `revised body ${index}`,
        ).join("\n"),
      },
    };
    const evidence = renderContractRevisionEvidence(many, 1_200);
    expect(Buffer.byteLength(evidence, "utf-8")).toBeLessThanOrEqual(1_200);
    expect(evidence).toMatch(/## \d+ changed regions? omitted/);
    expect(evidence).toContain("A fresh finding must cite text");
  });

  it("returns nothing when there is no room at all", () => {
    expect(renderContractRevisionEvidence(revisions, 0)).toBe("");
  });

  it("never exceeds a positive byte budget too small for an omission note", () => {
    const evidence = renderContractRevisionEvidence(revisions, 10);
    expect(Buffer.byteLength(evidence, "utf-8")).toBeLessThanOrEqual(10);
  });

  it("records the absence of revision artifacts instead of inventing them", () => {
    expect(renderContractRevisionEvidence(null, 65_536)).toBe(
      "(no revision evidence was recorded for this round)",
    );
  });
});

describe("evidence sufficiency for a fresh revisionCitation", () => {
  const previous: ContractReview = {
    version: 2,
    verdict: "REVISE",
    findings: [
      {
        id: "F-01",
        severity: "BLOCKING",
        behaviorIds: ["B-01"],
        evidence: '"the gate is advisory"',
        expected: "a required gate",
        observed: "an advisory gate",
        clearCondition: "the gate is declared required",
        state: "OPEN",
        revisionCitation: null,
      },
    ],
  };
  const response: ContractResponse = {
    version: 1,
    round: 2,
    responses: [
      {
        findingId: "F-01",
        position: "CONDITION_MET",
        evidence: "the gate is now required",
      },
    ],
  };

  it("a citation copied out of the rendered evidence validates", () => {
    const revisions = {
      "contract.md": {
        before: "intro\nthe gate is advisory\noutro",
        after: "intro\nthe gate is required\noutro",
      },
      "acceptance-manifest.json": {
        before: '{"version":2}',
        after: '{"version":2}',
      },
    };
    const evidence = renderContractRevisionEvidence(revisions, 65_536);
    // Both strings are lifted from the rendered block, which is all a fresh
    // finding is given now that the pair travels by reference.
    const before = "the gate is advisory";
    const after = "the gate is required";
    expect(evidence).toContain(before);
    expect(evidence).toContain(after);

    const current: ContractReview = {
      version: 2,
      verdict: "REVISE",
      findings: [
        { ...previous.findings[0]!, state: "RESOLVED" },
        {
          id: "F-02",
          severity: "BLOCKING",
          behaviorIds: [],
          evidence: `"${after}"`,
          expected: "a gate the slice can run",
          observed: "a gate with no runner",
          clearCondition: "the runner is named",
          state: "OPEN",
          revisionCitation: { artifact: "contract.md", before, after },
        },
      ],
    };
    expect(() =>
      validateRound2ContractReview(previous, response, current, revisions),
    ).not.toThrow();
  });

  it("an append-only insertion uses an empty prior side and validates", () => {
    const revisions = {
      "contract.md": {
        before: "intro",
        after: "intro\nnew blocking claim",
      },
      "acceptance-manifest.json": {
        before: '{"version":2}',
        after: '{"version":2}',
      },
    };
    const evidence = renderContractRevisionEvidence(revisions, 65_536);
    expect(evidence).toContain(
      'Prior text: `""` (empty because this region is an insertion).',
    );
    expect(evidence).toContain("new blocking claim");

    const current: ContractReview = {
      version: 2,
      verdict: "REVISE",
      findings: [
        {
          id: "F-02",
          severity: "BLOCKING",
          behaviorIds: [],
          evidence: '"new blocking claim"',
          expected: "no unsupported claim",
          observed: "the revision added one",
          clearCondition: "remove or support the claim",
          state: "OPEN",
          revisionCitation: {
            artifact: "contract.md",
            before: "",
            after: "new blocking claim",
          },
        },
      ],
    };
    expect(() =>
      validateRound2ContractReview(
        { version: 2, verdict: "ACCEPT", findings: [] },
        { version: 1, round: 2, responses: [] },
        current,
        revisions,
      ),
    ).not.toThrow();
  });

  it("a deletion uses an empty revised side and validates", () => {
    const revisions = {
      "contract.md": {
        before: "intro\nrequired gate",
        after: "intro",
      },
      "acceptance-manifest.json": {
        before: '{"version":2}',
        after: '{"version":2}',
      },
    };
    const evidence = renderContractRevisionEvidence(revisions, 65_536);
    expect(evidence).toContain("required gate");
    expect(evidence).toContain(
      'Revised text: `""` (empty because this region is a deletion).',
    );

    const current: ContractReview = {
      version: 2,
      verdict: "REVISE",
      findings: [
        {
          id: "F-02",
          severity: "BLOCKING",
          behaviorIds: [],
          evidence: '"required gate"',
          expected: "the gate remains required",
          observed: "the revision deleted it",
          clearCondition: "restore the requirement",
          state: "OPEN",
          revisionCitation: {
            artifact: "contract.md",
            before: "required gate",
            after: "",
          },
        },
      ],
    };
    expect(() =>
      validateRound2ContractReview(
        { version: 2, verdict: "ACCEPT", findings: [] },
        { version: 1, round: 2, responses: [] },
        current,
        revisions,
      ),
    ).not.toThrow();
  });

  it("repeated text expands to a citation that is unique across revisions", () => {
    const revisions = {
      "contract.md": {
        before: "A\nX\nB\nX",
        after: "A\nY\nB\nX",
      },
      "acceptance-manifest.json": {
        before: '{"version":2}',
        after: '{"version":2}',
      },
    };
    const evidence = renderContractRevisionEvidence(revisions, 65_536);
    expect(evidence).toContain("A\nX\nB");
    expect(evidence).toContain("A\nY\nB");

    const current: ContractReview = {
      version: 2,
      verdict: "REVISE",
      findings: [
        {
          id: "F-02",
          severity: "BLOCKING",
          behaviorIds: [],
          evidence: '"Y"',
          expected: "X remains at the first position",
          observed: "the revision changed it to Y",
          clearCondition: "restore X",
          state: "OPEN",
          revisionCitation: {
            artifact: "contract.md",
            before: "A\nX\nB",
            after: "A\nY\nB",
          },
        },
      ],
    };
    expect(() =>
      validateRound2ContractReview(
        { version: 2, verdict: "ACCEPT", findings: [] },
        { version: 1, round: 2, responses: [] },
        current,
        revisions,
      ),
    ).not.toThrow();
  });

  it("normalizes CRLF consistently between rendered evidence and validation", () => {
    const revisions = {
      "contract.md": {
        before: "head\r\nold one\r\nold two\r\ntail",
        after: "head\r\nnew one\r\nnew two\r\ntail",
      },
      "acceptance-manifest.json": {
        before: '{"version":2}',
        after: '{"version":2}',
      },
    };
    const evidence = renderContractRevisionEvidence(revisions, 65_536);
    expect(evidence).toContain("old one\nold two");
    expect(evidence).toContain("new one\nnew two");

    const current: ContractReview = {
      version: 2,
      verdict: "REVISE",
      findings: [
        {
          id: "F-02",
          severity: "BLOCKING",
          behaviorIds: [],
          evidence: '"new one"',
          expected: "the old pair",
          observed: "the new pair",
          clearCondition: "restore the old pair",
          state: "OPEN",
          revisionCitation: {
            artifact: "contract.md",
            before: "old one\nold two",
            after: "new one\nnew two",
          },
        },
      ],
    };
    expect(() =>
      validateRound2ContractReview(
        { version: 2, verdict: "ACCEPT", findings: [] },
        { version: 1, round: 2, responses: [] },
        current,
        revisions,
      ),
    ).not.toThrow();
  });

  it("the canonical parser accepts exactly one empty insertion or deletion side", () => {
    const base = {
      version: 2,
      verdict: "REVISE",
      findings: [
        {
          id: "F-02",
          severity: "BLOCKING",
          behaviorIds: [],
          evidence: "changed text",
          expected: "expected",
          observed: "observed",
          clearCondition: "clear",
          state: "OPEN",
          revisionCitation: {
            artifact: "contract.md",
            before: "",
            after: "inserted text",
          },
        },
      ],
    };
    expect(parseContractReview(JSON.stringify(base))).toMatchObject(base);
    expect(() =>
      parseContractReview(
        JSON.stringify({
          ...base,
          findings: [
            {
              ...base.findings[0],
              revisionCitation: {
                artifact: "contract.md",
                before: "",
                after: "",
              },
            },
          ],
        }),
      ),
    ).toThrow(/at least one non-empty side/);
  });
});

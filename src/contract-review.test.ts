import { describe, it, expect, afterEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import * as artifacts from "./artifacts.js";
import {
  buildContractNegotiationOutcome,
  buildContractReviewAttemptRecord,
  contractReviewGapMetrics,
  formatContractReviewFindings,
  loadContractReview,
  openContractReviewFindings,
  parseContractResponse,
  parseContractReview,
  validateRound2ContractReview,
  type ContractReview,
  type ContractReviewFinding,
} from "./contract-review.js";

/**
 * The parser is the fail-closed boundary of the negotiate stage: every
 * verdict the orchestrator acts on comes through it, and there is no
 * default on the other side. So each *conjunct* of each validity rule
 * gets its own rejection fixture with a concrete counterexample value —
 * a fixture that "covers" a compound rule proves only that one of its
 * conjuncts holds.
 */

const FINDING: ContractReviewFinding = {
  id: "F-01",
  severity: "BLOCKING",
  behaviorIds: ["B-01"],
  evidence: '"the header is validated"',
  expected: "a test plan entry that can fail",
  observed: "no entry names a command",
  clearCondition: "the B-01 entry names a command that exits non-zero",
  state: "OPEN",
  revisionCitation: null,
};

function review(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 2,
    verdict: "ACCEPT",
    findings: [],
    ...overrides,
  });
}

/** One review carrying exactly one finding, built from `FINDING` plus edits. */
function withFinding(overrides: Record<string, unknown>): string {
  return review({
    verdict: "REVISE",
    findings: [{ ...FINDING, ...overrides }],
  });
}

describe("parseContractReview accepts the canonical artifact", () => {
  it("parses an ACCEPT with no findings", () => {
    expect(parseContractReview(review())).toEqual({
      version: 2,
      verdict: "ACCEPT",
      findings: [],
    });
  });

  it("parses an ACCEPT carrying only advisory findings", () => {
    const parsed = parseContractReview(
      review({ findings: [{ ...FINDING, severity: "ADVISORY" }] }),
    );
    expect(parsed.verdict).toBe("ACCEPT");
    expect(parsed.findings).toHaveLength(1);
  });

  it("parses a REVISE with a full blocking finding", () => {
    expect(parseContractReview(withFinding({}))).toEqual({
      version: 2,
      verdict: "REVISE",
      findings: [FINDING],
    });
  });

  it("accepts a finding attributed to no behavior", () => {
    expect(
      parseContractReview(withFinding({ behaviorIds: [] })).findings[0]!
        .behaviorIds,
    ).toEqual([]);
  });

  it("accepts several behavior IDs on one finding", () => {
    expect(
      parseContractReview(withFinding({ behaviorIds: ["B-01", "B-02"] }))
        .findings[0]!.behaviorIds,
    ).toEqual(["B-01", "B-02"]);
  });
});

describe("parseContractReview refuses a contradictory artifact", () => {
  it("refuses ACCEPT coexisting with a blocking finding, naming the finding", () => {
    expect(() =>
      parseContractReview(review({ verdict: "ACCEPT", findings: [FINDING] })),
    ).toThrow(/verdict ACCEPT contradicts 1 BLOCKING finding\(s\): F-01/);
  });

  it("names every blocking finding an ACCEPT contradicts", () => {
    expect(() =>
      parseContractReview(
        review({
          verdict: "ACCEPT",
          findings: [FINDING, { ...FINDING, id: "F-02" }],
        }),
      ),
    ).toThrow(/contradicts 2 BLOCKING finding\(s\): F-01, F-02/);
  });

  it("refuses REVISE with no blocking finding", () => {
    expect(() =>
      parseContractReview(review({ verdict: "REVISE", findings: [] })),
    ).toThrow(/REVISE requires at least one BLOCKING finding/);
  });

  it("refuses REVISE carrying only advisory findings", () => {
    expect(() =>
      parseContractReview(
        review({
          verdict: "REVISE",
          findings: [{ ...FINDING, severity: "ADVISORY" }],
        }),
      ),
    ).toThrow(/REVISE requires at least one BLOCKING finding/);
  });

  it("refuses two verdicts, which JSON.parse would silently collapse to one", () => {
    const text = '{"version":1,"verdict":"ACCEPT","verdict":"REVISE","findings":[]}';
    // Proof the defect is invisible after parsing: without the raw-text
    // scan this artifact reads as a clean single-verdict REVISE.
    expect((JSON.parse(text) as { verdict: string }).verdict).toBe("REVISE");
    expect(() => parseContractReview(text)).toThrow(
      /declares the key "verdict" more than once/,
    );
  });

  it("refuses a duplicated findings key", () => {
    expect(() =>
      parseContractReview(
        '{"version":1,"verdict":"ACCEPT","findings":[],"findings":[]}',
      ),
    ).toThrow(/declares the key "findings" more than once/);
  });

  it("refuses a duplicated version key", () => {
    expect(() =>
      parseContractReview(
        '{"version":1,"version":1,"verdict":"ACCEPT","findings":[]}',
      ),
    ).toThrow(/declares the key "version" more than once/);
  });

  it("refuses a duplicated key inside a finding", () => {
    const finding = JSON.stringify(FINDING).replace(
      '"severity":"BLOCKING"',
      '"severity":"BLOCKING","severity":"ADVISORY"',
    );
    expect(() =>
      parseContractReview(
        `{"version":1,"verdict":"REVISE","findings":[${finding}]}`,
      ),
    ).toThrow(/declares the key "severity" more than once/);
  });

  it("does not mistake a colon inside a string value for a key separator", () => {
    // Two findings whose string values contain `":"` — a naive duplicate
    // scanner reads those as repeated keys and refuses a valid artifact.
    const parsed = parseContractReview(
      review({
        verdict: "REVISE",
        findings: [
          { ...FINDING, evidence: '"id": "B-01", "id": "B-02"' },
          { ...FINDING, id: "F-02", observed: 'said "expected": twice' },
        ],
      }),
    );
    expect(parsed.findings).toHaveLength(2);
  });

  it("does not mistake repeated keys in sibling objects for duplicates", () => {
    expect(
      parseContractReview(
        review({
          verdict: "REVISE",
          findings: [FINDING, { ...FINDING, id: "F-02" }],
        }),
      ).findings,
    ).toHaveLength(2);
  });
});

describe("parseContractReview refuses a malformed or missing artifact", () => {
  it("refuses invalid JSON", () => {
    expect(() => parseContractReview("{")).toThrow(/is not valid JSON/);
  });

  it("refuses a JSON array at the root", () => {
    expect(() => parseContractReview("[]")).toThrow(
      /must contain a JSON object/,
    );
  });

  it("refuses JSON null", () => {
    expect(() => parseContractReview("null")).toThrow(
      /must contain a JSON object/,
    );
  });

  it("refuses a missing version", () => {
    expect(() =>
      parseContractReview('{"verdict":"ACCEPT","findings":[]}'),
    ).toThrow(/must declare version 2/);
  });

  it("refuses an unknown version", () => {
    expect(() => parseContractReview(review({ version: 1 }))).toThrow(
      /must declare version 2/,
    );
  });

  it("refuses a version given as a string", () => {
    expect(() => parseContractReview(review({ version: "1" }))).toThrow(
      /must declare version 2/,
    );
  });

  it("refuses an extra root key", () => {
    expect(() => parseContractReview(review({ gaps: 0 }))).toThrow(
      /root object must contain exactly version, verdict, findings/,
    );
  });

  it("refuses a missing verdict", () => {
    expect(() =>
      parseContractReview('{"version":2,"findings":[]}'),
    ).toThrow(/root object must contain exactly version, verdict, findings/);
  });

  it("refuses a missing findings array", () => {
    expect(() =>
      parseContractReview('{"version":2,"verdict":"ACCEPT"}'),
    ).toThrow(/root object must contain exactly version, verdict, findings/);
  });

  it("refuses an unrecognized verdict", () => {
    expect(() => parseContractReview(review({ verdict: "ESCALATE" }))).toThrow(
      /verdict must be ACCEPT or REVISE/,
    );
  });

  it("refuses a lowercase verdict", () => {
    expect(() => parseContractReview(review({ verdict: "accept" }))).toThrow(
      /verdict must be ACCEPT or REVISE/,
    );
  });

  it("refuses a verdict given as an array of two values", () => {
    expect(() =>
      parseContractReview(review({ verdict: ["ACCEPT", "REVISE"] })),
    ).toThrow(/verdict must be ACCEPT or REVISE/);
  });

  it("refuses findings given as an object", () => {
    expect(() => parseContractReview(review({ findings: {} }))).toThrow(
      /findings must be an array/,
    );
  });

  it("refuses a finding that is not an object", () => {
    expect(() =>
      parseContractReview(review({ verdict: "REVISE", findings: ["F-01"] })),
    ).toThrow(/findings\[0\] finding must be an object/);
  });

  it("refuses a finding with an extra key", () => {
    expect(() => parseContractReview(withFinding({ note: "extra" }))).toThrow(
      /findings\[0\] finding must contain exactly id, severity, behaviorIds, evidence, expected, observed, clearCondition/,
    );
  });

  it("refuses duplicate finding IDs", () => {
    expect(() =>
      parseContractReview(
        review({ verdict: "REVISE", findings: [FINDING, FINDING] }),
      ),
    ).toThrow(/finding IDs must be unique; duplicate "F-01"/);
  });

  it("refuses an unrecognized severity", () => {
    expect(() => parseContractReview(withFinding({ severity: "MINOR" }))).toThrow(
      /severity must be BLOCKING or ADVISORY/,
    );
  });

  it("refuses a numeric severity", () => {
    expect(() => parseContractReview(withFinding({ severity: 1 }))).toThrow(
      /severity must be BLOCKING or ADVISORY/,
    );
  });
});

describe("parseContractReview refuses field-type violations in valid JSON", () => {
  it("refuses behaviorIds given as a string rather than an array", () => {
    expect(() =>
      parseContractReview(withFinding({ behaviorIds: "B-01" })),
    ).toThrow(/behaviorIds must be an array/);
  });

  // The issue names both counterexamples explicitly; each gets its own
  // fixture, because `[1]` exercises "the only element is a number" and
  // `["a", 2]` exercises "a later element is a number" — a scan that
  // checks only the first element passes one and fails the other.
  it("refuses behaviorIds [1]", () => {
    expect(() => parseContractReview(withFinding({ behaviorIds: [1] }))).toThrow(
      /behaviorIds must contain only strings/,
    );
  });

  it('refuses behaviorIds ["a", 2]', () => {
    expect(() =>
      parseContractReview(withFinding({ behaviorIds: ["a", 2] })),
    ).toThrow(/behaviorIds must contain only strings/);
  });

  it("refuses a null element in behaviorIds", () => {
    expect(() =>
      parseContractReview(withFinding({ behaviorIds: ["B-01", null] })),
    ).toThrow(/behaviorIds must contain only strings/);
  });

  it("refuses a nested array in behaviorIds", () => {
    expect(() =>
      parseContractReview(withFinding({ behaviorIds: [["B-01"]] })),
    ).toThrow(/behaviorIds must contain only strings/);
  });

  it("refuses a blank string in behaviorIds", () => {
    expect(() =>
      parseContractReview(withFinding({ behaviorIds: ["B-01", "  "] })),
    ).toThrow(/behaviorIds must contain only non-blank strings/);
  });

  it("refuses duplicate behaviorIds", () => {
    expect(() =>
      parseContractReview(withFinding({ behaviorIds: ["B-01", "B-01"] })),
    ).toThrow(/behaviorIds must be unique; duplicate "B-01"/);
  });

  // Each required string field is named, not summarized: the field list
  // is the rule, and a loop over "all other strings" would not notice a
  // field that stopped being checked.
  const STRING_FIELDS = [
    "id",
    "evidence",
    "expected",
    "observed",
    "clearCondition",
  ] as const;

  it("checks exactly the five required string fields", () => {
    expect([...STRING_FIELDS]).toEqual([
      "id",
      "evidence",
      "expected",
      "observed",
      "clearCondition",
    ]);
  });

  for (const field of STRING_FIELDS) {
    it(`refuses a number in ${field}`, () => {
      expect(() => parseContractReview(withFinding({ [field]: 7 }))).toThrow(
        new RegExp(`finding ${field} must be a non-blank string`),
      );
    });

    it(`refuses null in ${field}`, () => {
      expect(() => parseContractReview(withFinding({ [field]: null }))).toThrow(
        new RegExp(`finding ${field} must be a non-blank string`),
      );
    });

    it(`refuses a boolean in ${field}`, () => {
      expect(() => parseContractReview(withFinding({ [field]: true }))).toThrow(
        new RegExp(`finding ${field} must be a non-blank string`),
      );
    });

    it(`refuses an array in ${field}`, () => {
      expect(() =>
        parseContractReview(withFinding({ [field]: ["x"] })),
      ).toThrow(new RegExp(`finding ${field} must be a non-blank string`));
    });

    it(`refuses an object in ${field}`, () => {
      expect(() =>
        parseContractReview(withFinding({ [field]: { text: "x" } })),
      ).toThrow(new RegExp(`finding ${field} must be a non-blank string`));
    });

    it(`refuses a whitespace-only ${field}`, () => {
      expect(() => parseContractReview(withFinding({ [field]: "   " }))).toThrow(
        new RegExp(`finding ${field} must be a non-blank string`),
      );
    });
  }
});

describe("loadContractReview", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length > 0) {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    }
  });

  function sliceDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "afk-review-"));
    dirs.push(dir);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  it("names the missing file rather than defaulting to a verdict", () => {
    const dir = sliceDir();
    expect(() => loadContractReview(dir)).toThrow(
      /contract-review\.json is missing/,
    );
  });

  it("names the artifact path in a malformed-artifact refusal", () => {
    const dir = sliceDir();
    writeFileSync(join(dir, "contract-review.json"), "{", "utf-8");
    expect(() => loadContractReview(dir)).toThrow(
      /contract-review\.json is not valid JSON/,
    );
  });

  it("returns the parsed review for a valid artifact", () => {
    const dir = sliceDir();
    writeFileSync(join(dir, "contract-review.json"), review(), "utf-8");
    expect(loadContractReview(dir).verdict).toBe("ACCEPT");
  });
});

describe("contractReviewGapMetrics", () => {
  function parsed(verdict: "ACCEPT" | "REVISE", findings: ContractReviewFinding[]): ContractReview {
    return { version: 2, verdict, findings };
  }

  it("counts blocking findings and ignores advisory ones", () => {
    const current = parsed("REVISE", [
      FINDING,
      { ...FINDING, id: "F-02" },
      { ...FINDING, id: "F-03", severity: "ADVISORY" },
    ]);
    expect(contractReviewGapMetrics(current, null)).toEqual({
      gapCount: 2,
      reRaisedGapCount: null,
    });
  });

  it("reports no re-raised count when there is no previous round", () => {
    expect(contractReviewGapMetrics(parsed("ACCEPT", []), null)).toEqual({
      gapCount: 0,
      reRaisedGapCount: null,
    });
  });

  it("counts a reused finding ID as a re-raised gap", () => {
    const previous = parsed("REVISE", [FINDING, { ...FINDING, id: "F-02" }]);
    const current = parsed("REVISE", [FINDING]);
    expect(contractReviewGapMetrics(current, previous)).toEqual({
      gapCount: 1,
      reRaisedGapCount: 1,
    });
  });

  it("counts fresh IDs as no re-raised gaps", () => {
    const previous = parsed("REVISE", [FINDING]);
    const current = parsed("REVISE", [{ ...FINDING, id: "F-09" }]);
    expect(contractReviewGapMetrics(current, previous)).toEqual({
      gapCount: 1,
      reRaisedGapCount: 0,
    });
  });

  it("does not count a previously advisory ID as re-raised", () => {
    const previous = parsed("ACCEPT", [{ ...FINDING, severity: "ADVISORY" }]);
    const current = parsed("REVISE", [FINDING]);
    expect(contractReviewGapMetrics(current, previous)).toEqual({
      gapCount: 1,
      reRaisedGapCount: 0,
    });
  });
});

describe("formatContractReviewFindings", () => {
  it("renders each finding's clear-condition", () => {
    const rendered = formatContractReviewFindings([FINDING]);
    expect(rendered).toContain("[F-01] BLOCKING OPEN — behaviors: B-01");
    expect(rendered).toContain(
      "Clear when: the B-01 entry names a command that exits non-zero",
    );
    expect(rendered).toContain("Expected: a test plan entry that can fail");
    expect(rendered).toContain("Observed: no entry names a command");
    expect(rendered).toContain('Evidence: "the header is validated"');
  });

  it("says so when a finding names no behavior", () => {
    expect(
      formatContractReviewFindings([{ ...FINDING, behaviorIds: [] }]),
    ).toContain("[F-01] BLOCKING OPEN — no single behavior");
  });

  it("renders a placeholder for an empty finding list", () => {
    expect(formatContractReviewFindings([])).toBe("(no findings were recorded)");
  });
});

describe("openContractReviewFindings", () => {
  it("routes only OPEN findings in review order", () => {
    const findings = [
      { ...FINDING, id: "F-OPEN-1", state: "OPEN" },
      { ...FINDING, id: "F-RESOLVED", state: "RESOLVED" },
      { ...FINDING, id: "F-OPEN-2", state: "OPEN" },
      { ...FINDING, id: "F-WITHDRAWN", state: "WITHDRAWN" },
      { ...FINDING, id: "F-CONTESTED", state: "CONTESTED" },
    ] as const;

    expect(openContractReviewFindings(findings).map(({ id }) => id)).toEqual([
      "F-OPEN-1",
      "F-OPEN-2",
    ]);
  });
});

describe("parseContractResponse", () => {
  function response(
    responses: Array<Record<string, unknown>>,
    overrides: Record<string, unknown> = {},
  ): string {
    return JSON.stringify({ version: 1, round: 2, responses, ...overrides });
  }

  it("requires exactly one valid round-2 position per routed finding", () => {
    const text = JSON.stringify({
      version: 1,
      round: 2,
      responses: [
        { findingId: "F-01", position: "UNRESOLVED", evidence: "" },
        {
          findingId: "F-02",
          position: "CONDITION_MET",
          evidence: "contract.md now names the failing command",
        },
        {
          findingId: "F-03",
          position: "CONTESTED",
          evidence: "the cited gate already proves the behavior",
        },
      ],
    });

    expect(parseContractResponse(text, ["F-01", "F-02", "F-03"])).toEqual({
      version: 1,
      round: 2,
      responses: [
        { findingId: "F-01", position: "UNRESOLVED", evidence: "" },
        {
          findingId: "F-02",
          position: "CONDITION_MET",
          evidence: "contract.md now names the failing command",
        },
        {
          findingId: "F-03",
          position: "CONTESTED",
          evidence: "the cited gate already proves the behavior",
        },
      ],
    });
  });

  it("refuses duplicate response IDs", () => {
    expect(() =>
      parseContractResponse(
        response([
          { findingId: "F-01", position: "UNRESOLVED", evidence: "" },
          { findingId: "F-01", position: "UNRESOLVED", evidence: "" },
        ]),
        ["F-01"],
      ),
    ).toThrow(/response IDs must be unique; duplicate "F-01"/);
  });

  it("refuses missing and unexpected routed IDs", () => {
    expect(() =>
      parseContractResponse(
        response([
          { findingId: "F-01", position: "UNRESOLVED", evidence: "" },
          { findingId: "F-03", position: "UNRESOLVED", evidence: "" },
        ]),
        ["F-01", "F-02"],
      ),
    ).toThrow(/missing F-02; unexpected F-03/);
  });

  it.each(["CONDITION_MET", "CONTESTED"])(
    "requires evidence for %s",
    (position) => {
      expect(() =>
        parseContractResponse(
          response([{ findingId: "F-01", position, evidence: " " }]),
          ["F-01"],
        ),
      ).toThrow(new RegExp(`evidence must be non-blank for ${position}`));
    },
  );

  it("refuses duplicate JSON keys before parsing positions", () => {
    expect(() =>
      parseContractResponse(
        '{"version":1,"round":2,"round":2,"responses":[]}',
        [],
      ),
    ).toThrow(/declares the key "round" more than once/);
  });
});

describe("validateRound2ContractReview", () => {
  function responseFor(
    position: "UNRESOLVED" | "CONDITION_MET" | "CONTESTED",
  ) {
    return parseContractResponse(
      JSON.stringify({
        version: 1,
        round: 2,
        responses: [
          {
            findingId: "F-01",
            position,
            evidence: position === "UNRESOLVED" ? "" : "planner evidence",
          },
        ],
      }),
      ["F-01"],
    );
  }

  it("requires one legal evaluator disposition for every planner position", () => {
    const previous: ContractReview = {
      version: 2,
      verdict: "REVISE",
      findings: [
        FINDING,
        { ...FINDING, id: "F-02", clearCondition: "the claim is withdrawn" },
      ],
    };
    const response = parseContractResponse(
      JSON.stringify({
        version: 1,
        round: 2,
        responses: [
          {
            findingId: "F-01",
            position: "CONDITION_MET",
            evidence: "the command is now explicit",
          },
          {
            findingId: "F-02",
            position: "CONTESTED",
            evidence: "the cited gate already proves the claim",
          },
        ],
      }),
      ["F-01", "F-02"],
    );
    const current: ContractReview = {
      version: 2,
      verdict: "REVISE",
      findings: [
        { ...FINDING, state: "RESOLVED" },
        { ...FINDING, id: "F-02", state: "CONTESTED" },
      ],
    };

    expect(() =>
      validateRound2ContractReview(previous, response, current),
    ).not.toThrow();
    expect(() =>
      validateRound2ContractReview(previous, response, {
        ...current,
        findings: [
          current.findings[0]!,
          { ...current.findings[1]!, state: "OPEN" },
        ],
      }),
    ).toThrow(/F-02.*CONTESTED.*must be CONTESTED or WITHDRAWN/);
  });

  it.each([
    ["UNRESOLVED", "OPEN"],
    ["CONDITION_MET", "OPEN"],
    ["CONDITION_MET", "RESOLVED"],
    ["CONTESTED", "CONTESTED"],
    ["CONTESTED", "WITHDRAWN"],
  ] as const)("accepts %s -> %s", (position, state) => {
    const current: ContractReview = {
      version: 2,
      verdict:
        state === "OPEN" || state === "CONTESTED" ? "REVISE" : "ACCEPT",
      findings: [{ ...FINDING, state }],
    };
    expect(() =>
      validateRound2ContractReview(
        { version: 2, verdict: "REVISE", findings: [FINDING] },
        responseFor(position),
        current,
      ),
    ).not.toThrow();
  });

  it("refuses an omitted routed finding", () => {
    expect(() =>
      validateRound2ContractReview(
        { version: 2, verdict: "REVISE", findings: [FINDING] },
        responseFor("UNRESOLVED"),
        { version: 2, verdict: "ACCEPT", findings: [] },
      ),
    ).toThrow(/omitted routed finding F-01/);
  });

  it("refuses terminal reactivation and uncited fresh findings", () => {
    const noResponses = parseContractResponse(
      '{"version":1,"round":2,"responses":[]}',
      [],
    );
    const terminalPrevious: ContractReview = {
      version: 2,
      verdict: "ACCEPT",
      findings: [{ ...FINDING, state: "RESOLVED" }],
    };
    const activeCurrent: ContractReview = {
      version: 2,
      verdict: "REVISE",
      findings: [FINDING],
    };
    const revisions = {
      "contract.md": {
        before: "old contract text",
        after: "new contract text",
      },
      "acceptance-manifest.json": {
        before: '{"observableResult":"old"}',
        after: '{"observableResult":"new"}',
      },
    };

    expect(() =>
      validateRound2ContractReview(
        terminalPrevious,
        noResponses,
        activeCurrent,
        revisions,
      ),
    ).toThrow(/terminal finding F-01 cannot reactivate as OPEN/);

    expect(() =>
      validateRound2ContractReview(
        { version: 2, verdict: "ACCEPT", findings: [] },
        noResponses,
        {
          version: 2,
          verdict: "REVISE",
          findings: [{ ...FINDING, id: "F-FRESH" }],
        },
        revisions,
      ),
    ).toThrow(/fresh finding F-FRESH requires a revisionCitation/);
  });

  it("accepts only exact unequal revision excerpts for a fresh OPEN ID", () => {
    const previous: ContractReview = {
      version: 2,
      verdict: "ACCEPT",
      findings: [],
    };
    const response = parseContractResponse(
      '{"version":1,"round":2,"responses":[]}',
      [],
    );
    const revisions = {
      "contract.md": {
        before: "The old observable is absent.",
        after: "The new observable is explicit.",
      },
      "acceptance-manifest.json": {
        before: '{"observableResult":"old"}',
        after: '{"observableResult":"new"}',
      },
    };
    const fresh = {
      ...FINDING,
      id: "F-FRESH",
      revisionCitation: {
        artifact: "contract.md" as const,
        before: "old observable",
        after: "new observable",
      },
    };

    expect(() =>
      validateRound2ContractReview(
        previous,
        response,
        { version: 2, verdict: "REVISE", findings: [fresh] },
        revisions,
      ),
    ).not.toThrow();

    for (const [label, revisionCitation, expected] of [
      [
        "unchanged",
        { ...fresh.revisionCitation, after: "old observable" },
        /before and after must differ/,
      ],
      [
        "prior mismatch",
        { ...fresh.revisionCitation, before: "missing prior text" },
        /before does not match prior contract\.md/,
      ],
      [
        "current mismatch",
        { ...fresh.revisionCitation, after: "missing current text" },
        /after does not match current contract\.md/,
      ],
    ] as const) {
      expect(
        () =>
          validateRound2ContractReview(
            previous,
            response,
            {
              version: 2,
              verdict: "REVISE",
              findings: [{ ...fresh, revisionCitation }],
            },
            revisions,
          ),
        label,
      ).toThrow(expected);
    }
  });

  it("requires familiar IDs to carry a null revision citation", () => {
    expect(() =>
      validateRound2ContractReview(
        { version: 2, verdict: "REVISE", findings: [FINDING] },
        responseFor("UNRESOLVED"),
        {
          version: 2,
          verdict: "REVISE",
          findings: [
            {
              ...FINDING,
              revisionCitation: {
                artifact: "contract.md",
                before: "old",
                after: "new",
              },
            },
          ],
        },
      ),
    ).toThrow(/familiar finding F-01 must use revisionCitation null/);
  });
});

describe("buildContractReviewAttemptRecord", () => {
  it("derives unresolved identity and preserves both parties' evidence", () => {
    const response = parseContractResponse(
      JSON.stringify({
        version: 1,
        round: 2,
        responses: [
          {
            findingId: "F-01",
            position: "CONTESTED",
            evidence: "planner says the existing gate is sufficient",
          },
          {
            findingId: "F-02",
            position: "CONDITION_MET",
            evidence: "planner points to the new failing command",
          },
        ],
      }),
      ["F-01", "F-02"],
    );
    const review: ContractReview = {
      version: 2,
      verdict: "REVISE",
      findings: [
        {
          ...FINDING,
          state: "CONTESTED",
          evidence: "evaluator observes the gate misses the negative path",
        },
        {
          ...FINDING,
          id: "F-02",
          state: "RESOLVED",
          evidence: "evaluator observes the command fail as required",
        },
      ],
    };

    expect(buildContractReviewAttemptRecord(2, 3, review, response)).toEqual({
      version: 1,
      round: 2,
      attempt: 3,
      verdict: "REVISE",
      findings: [
        {
          id: "F-01",
          severity: "BLOCKING",
          state: "CONTESTED",
          unresolved: true,
          plannerPosition: "CONTESTED",
          plannerEvidence: "planner says the existing gate is sufficient",
          evaluatorEvidence:
            "evaluator observes the gate misses the negative path",
        },
        {
          id: "F-02",
          severity: "BLOCKING",
          state: "RESOLVED",
          unresolved: false,
          plannerPosition: "CONDITION_MET",
          plannerEvidence: "planner points to the new failing command",
          evaluatorEvidence:
            "evaluator observes the command fail as required",
        },
      ],
    });
  });
});

describe("buildContractNegotiationOutcome", () => {
  it("classifies a held BLOCKING contest as IMPASSE with both positions", () => {
    expect(
      buildContractNegotiationOutcome({
        version: 1,
        round: 2,
        attempt: 1,
        verdict: "REVISE",
        findings: [
          {
            id: "F-CONTEST",
            severity: "BLOCKING",
            state: "CONTESTED",
            unresolved: true,
            plannerPosition: "CONTESTED",
            plannerEvidence: "the gate already covers this path",
            evaluatorEvidence: "the gate omits the negative case",
          },
          {
            id: "F-ADVICE",
            severity: "ADVISORY",
            state: "OPEN",
            unresolved: true,
            plannerPosition: null,
            plannerEvidence: null,
            evaluatorEvidence: "rename the section",
          },
        ],
      }),
    ).toEqual({
      version: 1,
      classification: "IMPASSE",
      round: 2,
      attempt: 1,
      findings: [
        {
          id: "F-CONTEST",
          severity: "BLOCKING",
          state: "CONTESTED",
          unresolved: true,
          plannerPosition: "CONTESTED",
          plannerEvidence: "the gate already covers this path",
          evaluatorEvidence: "the gate omits the negative case",
        },
      ],
    });
  });
});

/**
 * The marker vocabulary has to be gone, not merely unused: a surviving
 * `readEvaluatorVerdict` or a stray `GAPS:` regex is a second, weaker
 * path to a verdict, and the whole point of the artifact is that there
 * is only one. Asserted against the source rather than through behaviour
 * because "no other path exists" is not observable from any one run.
 */
describe("the negotiate control flow keeps no marker parsing", () => {
  /**
   * A module's code with comments removed. Prose *about* the markers is
   * legitimate — the module that replaced them says what it replaced —
   * so the guard has to look at code, not at documentation.
   */
  function source(name: string): string {
    return readFileSync(
      fileURLToPath(new URL(`./${name}`, import.meta.url)),
      "utf-8",
    )
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");
  }

  it("no longer exports the marker readers", () => {
    expect(Object.keys(artifacts)).not.toContain("readEvaluatorVerdict");
    expect(Object.keys(artifacts)).not.toContain("readEvaluatorFeedbackMetrics");
  });

  it("parses no VERDICT: marker in the orchestrator", () => {
    expect(source("orchestrator.ts")).not.toMatch(/VERDICT/);
  });

  it("parses no GAPS: self-count anywhere in the negotiate path", () => {
    for (const name of ["orchestrator.ts", "artifacts.ts", "contract-review.ts"]) {
      expect(source(name)).not.toMatch(/\bGAPS\b/);
      expect(source(name)).not.toMatch(/RE_RAISED_GAPS/);
    }
  });

  it("asks the evaluator prompt for neither counts nor a verdict marker", () => {
    const prompt = readFileSync(
      fileURLToPath(new URL("../prompts/evaluator-contract.md", import.meta.url)),
      "utf-8",
    );
    expect(prompt).not.toMatch(/\bGAPS\b/);
    expect(prompt).not.toMatch(/RE_RAISED_GAPS/);
    expect(prompt).not.toMatch(/VERDICT:/);
    expect(prompt).toContain("{{CONTRACT_REVIEW_FILE}}");
    expect(prompt).toContain("clearCondition");
  });
});

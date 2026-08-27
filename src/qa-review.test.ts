import { describe, expect, it } from "vitest";
import {
  advanceQAReviewHistory,
  buildQAReviewAttemptRecord,
  openQAReviewFindings,
  parseQAReview,
  type QAReview,
} from "./qa-review.js";

const FINDING = {
  id: "QA-01",
  severity: "BLOCKING",
  behaviorIds: ["B-01"],
  summary: "Canonical verdict is ignored",
  evidence: "The Markdown marker controls the result",
  expected: "The JSON artifact controls the result",
  observed: "A Markdown-only pass advances",
  clearCondition: "A missing JSON artifact ends the slice as ERROR",
  state: "OPEN",
} as const;

function review(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    verdict: "PASS",
    failureClass: "NONE",
    infrastructureEvidence: null,
    findings: [],
    ...overrides,
  });
}

function implementationReview(
  findingOverrides: Record<string, unknown> = {},
): string {
  return review({
    verdict: "FAIL",
    failureClass: "IMPLEMENTATION",
    findings: [{ ...FINDING, ...findingOverrides }],
  });
}

describe("parseQAReview accepts canonical version-1 combinations", () => {
  it("accepts PASS/NONE with no findings", () => {
    expect(parseQAReview(review())).toEqual({
      version: 1,
      verdict: "PASS",
      failureClass: "NONE",
      infrastructureEvidence: null,
      findings: [],
    });
  });

  it("accepts PASS/NONE with an open advisory and a resolved blocker", () => {
    const parsed = parseQAReview(
      review({
        findings: [
          { ...FINDING, severity: "ADVISORY" },
          { ...FINDING, id: "QA-02", state: "RESOLVED" },
        ],
      }),
    );

    expect(parsed.findings.map(({ id, state }) => ({ id, state }))).toEqual([
      { id: "QA-01", state: "OPEN" },
      { id: "QA-02", state: "RESOLVED" },
    ]);
  });

  it("accepts FAIL/IMPLEMENTATION with an open blocking finding", () => {
    expect(parseQAReview(implementationReview()).findings).toEqual([FINDING]);
  });

  it("accepts FAIL/INFRASTRUCTURE with evidence and no findings", () => {
    expect(
      parseQAReview(
        review({
          verdict: "FAIL",
          failureClass: "INFRASTRUCTURE",
          infrastructureEvidence: "Preview database refused connections",
        }),
      ),
    ).toMatchObject({
      verdict: "FAIL",
      failureClass: "INFRASTRUCTURE",
      infrastructureEvidence: "Preview database refused connections",
      findings: [],
    });
  });
});

describe("parseQAReview refuses malformed canonical data", () => {
  it.each([
    ["invalid JSON", "{", /is not valid JSON/],
    ["an array root", "[]", /must contain a JSON object/],
    ["a null root", "null", /must contain a JSON object/],
    ["a missing root key", '{"version":1,"verdict":"PASS"}', /root object must contain exactly/],
    ["an extra root key", review({ note: "extra" }), /root object must contain exactly/],
    ["an unknown version", review({ version: 2 }), /must declare version 1/],
    ["a mistyped version", review({ version: "1" }), /must declare version 1/],
    ["an unknown verdict", review({ verdict: "ACCEPT" }), /verdict must be PASS or FAIL/],
    ["an unknown failure class", review({ failureClass: "CODE" }), /failureClass must be NONE, IMPLEMENTATION, or INFRASTRUCTURE/],
    ["mistyped infrastructure evidence", review({ infrastructureEvidence: 7 }), /infrastructureEvidence must be a non-blank string or null/],
    ["object findings", review({ findings: {} }), /findings must be an array/],
    ["a scalar finding", review({ findings: ["QA-01"] }), /findings\[0\] finding must be an object/],
    ["an extra finding key", implementationReview({ note: "extra" }), /finding must contain exactly/],
    ["a missing finding key", implementationReview({ summary: undefined }), /finding must contain exactly/],
    ["an unknown severity", implementationReview({ severity: "MAJOR" }), /severity must be BLOCKING or ADVISORY/],
    ["an unknown state", implementationReview({ state: "CONTESTED" }), /state must be OPEN or RESOLVED/],
    ["a scalar behaviorIds", implementationReview({ behaviorIds: "B-01" }), /behaviorIds must be an array/],
    ["a mistyped behavior ID", implementationReview({ behaviorIds: ["B-01", 2] }), /behaviorIds must contain only strings/],
    ["a blank behavior ID", implementationReview({ behaviorIds: [" "] }), /behaviorIds must contain only non-blank strings/],
    ["duplicate behavior IDs", implementationReview({ behaviorIds: ["B-01", "B-01"] }), /behaviorIds must be unique/],
    ["duplicate finding IDs", review({ verdict: "FAIL", failureClass: "IMPLEMENTATION", findings: [FINDING, FINDING] }), /finding IDs must be unique/],
  ])("refuses %s", (_name, text, pattern) => {
    expect(() => parseQAReview(text)).toThrow(pattern);
  });

  it("refuses a duplicate JSON key before trusting JSON.parse", () => {
    const text =
      '{"version":1,"verdict":"PASS","verdict":"FAIL","failureClass":"NONE","infrastructureEvidence":null,"findings":[]}';
    expect((JSON.parse(text) as { verdict: string }).verdict).toBe("FAIL");
    expect(() => parseQAReview(text)).toThrow(
      /declares the key "verdict" more than once/,
    );
  });

  it("does not mistake repeated keys in sibling findings for duplicates", () => {
    expect(() =>
      parseQAReview(
        review({
          verdict: "FAIL",
          failureClass: "IMPLEMENTATION",
          findings: [FINDING, { ...FINDING, id: "QA-02" }],
        }),
      ),
    ).not.toThrow();
  });

  const STRING_FIELDS = [
    "id",
    "summary",
    "evidence",
    "expected",
    "observed",
    "clearCondition",
  ] as const;

  it("pins every non-blank finding string field", () => {
    expect(STRING_FIELDS).toEqual([
      "id",
      "summary",
      "evidence",
      "expected",
      "observed",
      "clearCondition",
    ]);
  });

  for (const field of STRING_FIELDS) {
    it.each([
      ["number", 7],
      ["null", null],
      ["boolean", true],
      ["array", ["x"]],
      ["object", { text: "x" }],
      ["blank string", "  "],
    ])(`refuses a %s in finding ${field}`, (_kind, value) => {
      expect(() => implementationReview({ [field]: value })).not.toThrow();
      expect(() =>
        parseQAReview(implementationReview({ [field]: value })),
      ).toThrow(new RegExp(`${field} must be a non-blank string`));
    });
  }
});

describe("parseQAReview refuses contradictory combinations", () => {
  it.each([
    ["PASS/IMPLEMENTATION", { failureClass: "IMPLEMENTATION" }],
    ["PASS/INFRASTRUCTURE", { failureClass: "INFRASTRUCTURE", infrastructureEvidence: "outage" }],
    ["FAIL/NONE", { verdict: "FAIL" }],
    ["FAIL/IMPLEMENTATION without an open blocker", {
      verdict: "FAIL",
      failureClass: "IMPLEMENTATION",
      findings: [{ ...FINDING, severity: "ADVISORY" }],
    }],
    ["FAIL/IMPLEMENTATION with infrastructure evidence", {
      verdict: "FAIL",
      failureClass: "IMPLEMENTATION",
      infrastructureEvidence: "outage",
      findings: [FINDING],
    }],
    ["FAIL/INFRASTRUCTURE without evidence", {
      verdict: "FAIL",
      failureClass: "INFRASTRUCTURE",
    }],
    ["FAIL/INFRASTRUCTURE with findings", {
      verdict: "FAIL",
      failureClass: "INFRASTRUCTURE",
      infrastructureEvidence: "outage",
      findings: [FINDING],
    }],
    ["PASS/NONE with infrastructure evidence", {
      infrastructureEvidence: "outage",
    }],
    ["PASS/NONE with an open blocker", {
      findings: [FINDING],
    }],
  ])("refuses %s", (_name, overrides) => {
    expect(() => parseQAReview(review(overrides))).toThrow(
      /must be one of PASS\/NONE, FAIL\/IMPLEMENTATION, or FAIL\/INFRASTRUCTURE/,
    );
  });
});

describe("advanceQAReviewHistory enforces the QA lifecycle", () => {
  function parsedImplementation(
    findings: Array<Record<string, unknown>> = [FINDING],
  ): QAReview {
    return parseQAReview(
      review({
        verdict: "FAIL",
        failureClass: "IMPLEMENTATION",
        findings,
      }),
    );
  }

  it("requires every finding in the first non-infrastructure attempt to open", () => {
    const passingWithResolved = parseQAReview(
      review({ findings: [{ ...FINDING, state: "RESOLVED" }] }),
    );

    expect(() => advanceQAReviewHistory([], passingWithResolved)).toThrow(
      /first non-infrastructure attempt must start finding QA-01 as OPEN/,
    );
  });

  it("repeats open IDs, resolves one, and adds a fresh open ID", () => {
    const previous = advanceQAReviewHistory(
      [],
      parsedImplementation([
        FINDING,
        { ...FINDING, id: "QA-02", severity: "ADVISORY" },
      ]),
    );
    const current = parseQAReview(
      review({
        findings: [
          { ...FINDING, state: "RESOLVED" },
          {
            ...FINDING,
            id: "QA-02",
            severity: "ADVISORY",
            state: "OPEN",
          },
          {
            ...FINDING,
            id: "QA-03",
            severity: "ADVISORY",
            state: "OPEN",
          },
        ],
      }),
    );

    expect(
      advanceQAReviewHistory(previous, current).map(({ id, state }) => ({
        id,
        state,
      })),
    ).toEqual([
      { id: "QA-01", state: "RESOLVED" },
      { id: "QA-02", state: "OPEN" },
      { id: "QA-03", state: "OPEN" },
    ]);
  });

  it("refuses omission of a currently open ID", () => {
    const previous = advanceQAReviewHistory([], parsedImplementation());
    expect(() =>
      advanceQAReviewHistory(previous, parseQAReview(review())),
    ).toThrow(/must repeat open finding QA-01 exactly once; received 0/);
  });

  it("refuses a duplicate currently open ID", () => {
    const previous = advanceQAReviewHistory([], parsedImplementation());
    const duplicate = parsedImplementation();
    duplicate.findings.push({ ...duplicate.findings[0]! });

    expect(() => advanceQAReviewHistory(previous, duplicate)).toThrow(
      /must repeat open finding QA-01 exactly once; received 2/,
    );
  });

  it("refuses a fresh finding that starts resolved", () => {
    const previous = advanceQAReviewHistory([], parsedImplementation());
    const current = parsedImplementation([
      FINDING,
      { ...FINDING, id: "QA-02", state: "RESOLVED" },
    ]);

    expect(() => advanceQAReviewHistory(previous, current)).toThrow(
      /fresh finding QA-02 must start as OPEN/,
    );
  });

  it("refuses a resolved ID returning in a later attempt", () => {
    const opened = advanceQAReviewHistory([], parsedImplementation());
    const resolved = advanceQAReviewHistory(
      opened,
      parseQAReview(
        review({ findings: [{ ...FINDING, state: "RESOLVED" }] }),
      ),
    );

    expect(() =>
      advanceQAReviewHistory(
        resolved,
        parsedImplementation([{ ...FINDING, state: "OPEN" }]),
      ),
    ).toThrow(/resolved finding QA-01 cannot return/);
  });

  it("leaves history unchanged for an infrastructure attempt", () => {
    const previous = advanceQAReviewHistory([], parsedImplementation());
    const infrastructure = parseQAReview(
      review({
        verdict: "FAIL",
        failureClass: "INFRASTRUCTURE",
        infrastructureEvidence: "Preview database unavailable",
      }),
    );

    expect(advanceQAReviewHistory(previous, infrastructure)).toBe(previous);
  });

  it("keeps deterministic and shared-preview histories independent", () => {
    const deterministic = advanceQAReviewHistory(
      [],
      parsedImplementation([FINDING]),
    );
    const sharedPreview = advanceQAReviewHistory(
      [],
      parsedImplementation([{ ...FINDING, id: "UAT-01" }]),
    );

    expect(deterministic.map(({ id }) => id)).toEqual(["QA-01"]);
    expect(sharedPreview.map(({ id }) => id)).toEqual(["UAT-01"]);
  });
});

describe("openQAReviewFindings", () => {
  it("treats every open finding as unresolved, including advisory findings", () => {
    const findings = [
      { ...FINDING, state: "RESOLVED" as const },
      {
        ...FINDING,
        id: "QA-02",
        severity: "ADVISORY" as const,
        state: "OPEN" as const,
      },
    ];

    expect(openQAReviewFindings(findings).map(({ id }) => id)).toEqual([
      "QA-02",
    ]);
  });
});

describe("buildQAReviewAttemptRecord", () => {
  it("derives unresolved state and artifact references for a valid attempt", () => {
    const parsed = parseQAReview(
      review({
        findings: [
          { ...FINDING, severity: "ADVISORY" },
          { ...FINDING, id: "QA-02", state: "RESOLVED" },
        ],
      }),
    );

    expect(
      buildQAReviewAttemptRecord({
        stage: "deterministic",
        round: 2,
        attempt: 3,
        review: parsed,
        canonicalArchivePath:
          ".afk/artifacts/demo/slice-01/reviews/qa-review-r2-a3.json",
        markdownArchivePath:
          "specs/slices/01-demo/qa-report-r2-a3.md",
      }),
    ).toEqual({
      version: 1,
      stage: "deterministic",
      round: 2,
      attempt: 3,
      verdict: "PASS",
      failureClass: "NONE",
      findings: [
        {
          id: "QA-01",
          severity: "ADVISORY",
          state: "OPEN",
          unresolved: true,
          summary: "Canonical verdict is ignored",
          clearCondition: "A missing JSON artifact ends the slice as ERROR",
          artifactReferences: [
            ".afk/artifacts/demo/slice-01/reviews/qa-review-r2-a3.json",
            "specs/slices/01-demo/qa-report-r2-a3.md",
          ],
        },
        {
          id: "QA-02",
          severity: "BLOCKING",
          state: "RESOLVED",
          unresolved: false,
          summary: "Canonical verdict is ignored",
          clearCondition: "A missing JSON artifact ends the slice as ERROR",
          artifactReferences: [
            ".afk/artifacts/demo/slice-01/reviews/qa-review-r2-a3.json",
            "specs/slices/01-demo/qa-report-r2-a3.md",
          ],
        },
      ],
    });
  });

  it("records an infrastructure attempt without findings", () => {
    const parsed = parseQAReview(
      review({
        verdict: "FAIL",
        failureClass: "INFRASTRUCTURE",
        infrastructureEvidence: "Preview database unavailable",
      }),
    );

    expect(
      buildQAReviewAttemptRecord({
        stage: "shared-preview",
        round: 1,
        attempt: 2,
        review: parsed,
        canonicalArchivePath: "uat-review-r1-a2.json",
        markdownArchivePath: "uat-report-r1-a2.md",
      }),
    ).toMatchObject({
      stage: "shared-preview",
      verdict: "FAIL",
      failureClass: "INFRASTRUCTURE",
      findings: [],
    });
  });
});

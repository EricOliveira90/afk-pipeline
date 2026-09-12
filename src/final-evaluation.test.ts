import { describe, expect, it } from "vitest";
import {
  decideFinalReuse,
  decideFinalVerdict,
  FINAL_REPORT_FILENAME,
  FINAL_REVIEW_FILENAME,
  POST_APPROVAL_WRITING_STAGE_ID,
  parseFinalReview,
  routeFinalReviewFinding,
  validateFinalReview,
  type FinalReviewFinding,
} from "./final-evaluation.js";

const BASELINE_TREE = "a".repeat(40);
const OTHER_TREE = "b".repeat(40);

describe("decideFinalReuse", () => {
  it("[behavior:B-01] reuses the approval when the final tree is the baseline tree", () => {
    const outcome = decideFinalReuse({
      finalTreeId: BASELINE_TREE,
      baseline: { treeId: BASELINE_TREE },
    });

    expect(outcome.decision).toBe("reuse");
    expect(outcome.reason).toContain(BASELINE_TREE);
  });

  it("[behavior:B-01] evaluates when the tree IDs differ by so much as one byte", () => {
    expect(
      decideFinalReuse({
        finalTreeId: `${"a".repeat(39)}b`,
        baseline: { treeId: BASELINE_TREE },
      }).decision,
    ).toBe("evaluate");
  });

  it("[behavior:B-01] has no cosmetic-change exception — only exact string equality reuses (D20)", () => {
    // Same tree spelled differently is a different tree: no trimming, no
    // case folding, no "it's only whitespace" escape hatch.
    for (const finalTreeId of [
      ` ${BASELINE_TREE}`,
      `${BASELINE_TREE} `,
      BASELINE_TREE.toUpperCase(),
      BASELINE_TREE.slice(0, 39),
    ]) {
      expect(
        decideFinalReuse({ finalTreeId, baseline: { treeId: BASELINE_TREE } })
          .decision,
      ).toBe("evaluate");
    }
  });

  it("[behavior:B-01] evaluates when no approved baseline is recorded — fails closed", () => {
    const outcome = decideFinalReuse({
      finalTreeId: BASELINE_TREE,
      baseline: null,
    });

    expect(outcome.decision).toBe("evaluate");
    expect(outcome.reason).toContain("No approved baseline");
  });

  it("[behavior:B-03] names the post-approval writing stage by a single stage id", () => {
    // A stub write that changes the tree is what makes B-01 evaluate; the
    // stage identity is a string constant, not a cross-module interface.
    expect(POST_APPROVAL_WRITING_STAGE_ID).toBe("post-approval-writing");
    expect(
      decideFinalReuse({
        finalTreeId: OTHER_TREE,
        baseline: { treeId: BASELINE_TREE },
      }).decision,
    ).toBe("evaluate");
  });

  it("[behavior:B-09] refuses reuse against an invalidated candidate tree even on exact equality", () => {
    const outcome = decideFinalReuse({
      finalTreeId: BASELINE_TREE,
      baseline: { treeId: BASELINE_TREE },
      invalidatedCandidateTreeIds: [BASELINE_TREE],
    });

    expect(outcome.decision).toBe("evaluate");
    expect(outcome.reason).toContain("baseline-is-wrong");
  });

  it("[behavior:B-09] still reuses when the invalidated list names some other tree", () => {
    expect(
      decideFinalReuse({
        finalTreeId: BASELINE_TREE,
        baseline: { treeId: BASELINE_TREE },
        invalidatedCandidateTreeIds: [OTHER_TREE],
      }).decision,
    ).toBe("reuse");
  });
});

const FINDING = {
  id: "FE-01",
  class: "PRESERVATION",
  summary: "The --json flag no longer prints machine-readable output",
  evidence: "afk status --json printed a table",
  expected: "JSON on stdout",
  observed: "A human table on stdout",
  repair: "RESTORE",
};

function review(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    verdict: "FAIL",
    baselineTreeId: BASELINE_TREE,
    finalTreeId: OTHER_TREE,
    findings: [FINDING],
    ...overrides,
  });
}

describe("validateFinalReview", () => {
  it("[behavior:B-08] carries the parsed review out of the one validation", () => {
    const result = validateFinalReview(review({ verdict: "PASS", findings: [] }));

    // The point of the return shape: the caller that validated is the caller
    // that holds the tree IDs, so nothing has to parse the file a second time
    // to key a verdict on it.
    expect(result.ok).toBe(true);
    expect(result.ok && result.review.finalTreeId).toBe(OTHER_TREE);
    expect(result.ok && result.review.baselineTreeId).toBe(BASELINE_TREE);
  });

  it("[behavior:B-08] reports an absent artifact by name rather than throwing", () => {
    const result = validateFinalReview(null);

    expect(result).toEqual({
      ok: false,
      error: "final-review.json was not written",
    });
  });

  it("[behavior:B-08] reports the parse failure as a message on the same shape", () => {
    const result = validateFinalReview(review({ verdict: "MAYBE" }));

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("verdict");
  });

  it("[behavior:B-08] names the source it was given in its errors", () => {
    const result = validateFinalReview(null, "final-review-r1-a2.json");

    expect(!result.ok && result.error).toContain("final-review-r1-a2.json");
  });
});

describe("parseFinalReview", () => {
  it("[behavior:B-08] parses a canonical final review with its typed repair vocabulary", () => {
    const parsed = parseFinalReview(review());

    expect(parsed.version).toBe(1);
    expect(parsed.verdict).toBe("FAIL");
    expect(parsed.baselineTreeId).toBe(BASELINE_TREE);
    expect(parsed.findings[0]!.class).toBe("PRESERVATION");
    expect(parsed.findings[0]!.repair).toBe("RESTORE");
  });

  it("[behavior:B-08] names the two final artifacts canonically", () => {
    expect(FINAL_REVIEW_FILENAME).toBe("final-review.json");
    expect(FINAL_REPORT_FILENAME).toBe("final-report.md");
  });

  it.each([
    ["invalid JSON", "{"],
    ["a non-object root", "[]"],
    ["an unknown extra key", review({ notes: "extra" })],
    ["a missing key", JSON.stringify({ version: 1, verdict: "PASS" })],
    ["a version it does not understand", review({ version: 2 })],
    ["a verdict outside the vocabulary", review({ verdict: "MAYBE" })],
    ["a blank baseline tree ID", review({ baselineTreeId: "  " })],
    ["a blank final tree ID", review({ finalTreeId: "" })],
    ["findings that are not an array", review({ findings: {} })],
    [
      "a finding class outside the vocabulary",
      review({ findings: [{ ...FINDING, class: "VIBES" }] }),
    ],
    [
      "a repair outside the vocabulary",
      review({ findings: [{ ...FINDING, repair: "REWRITE" }] }),
    ],
    [
      "a blank finding field",
      review({ findings: [{ ...FINDING, evidence: " " }] }),
    ],
    [
      "duplicate finding IDs",
      review({ findings: [FINDING, { ...FINDING, summary: "Another" }] }),
    ],
    ["a PASS carrying findings", review({ verdict: "PASS" })],
    ["a FAIL carrying none", review({ verdict: "FAIL", findings: [] })],
  ])("[behavior:B-08] refuses %s", (_label, text) => {
    expect(() => parseFinalReview(text)).toThrow();
  });

  it("[behavior:B-08] refuses a duplicate JSON key the parser would silently forgive", () => {
    const text = `{"version":1,"verdict":"PASS","verdict":"FAIL",` +
      `"baselineTreeId":"${BASELINE_TREE}","finalTreeId":"${OTHER_TREE}","findings":[]}`;

    expect(() => parseFinalReview(text)).toThrow(/more than once/);
  });

  it("[behavior:B-08] accepts a PASS with an empty findings array", () => {
    const parsed = parseFinalReview(review({ verdict: "PASS", findings: [] }));

    expect(parsed.verdict).toBe("PASS");
    expect(parsed.findings).toEqual([]);
  });

  it("[behavior:B-08] refuses a preservation finding that asks for anything but a restore", () => {
    expect(() =>
      parseFinalReview(
        review({
          findings: [{ ...FINDING, repair: "RETURN_TO_GENERATOR" }],
        }),
      ),
    ).toThrow(/PRESERVATION admits only RESTORE/);
  });

  it("[behavior:B-09] refuses a baseline-is-wrong finding that asks for a restore", () => {
    expect(() =>
      parseFinalReview(
        review({
          findings: [
            { ...FINDING, class: "BASELINE_IS_WRONG", repair: "RESTORE" },
          ],
        }),
      ),
    ).toThrow(/BASELINE_IS_WRONG admits only RETURN_TO_GENERATOR/);
  });
});

describe("routeFinalReviewFinding", () => {
  const finding = (
    overrides: Partial<FinalReviewFinding> = {},
  ): FinalReviewFinding =>
    ({ ...FINDING, ...overrides }) as FinalReviewFinding;

  it("[behavior:B-08] routes a preservation finding to the single post-approval writing stage", () => {
    expect(
      routeFinalReviewFinding(finding(), { candidateTreeId: BASELINE_TREE }),
    ).toEqual({
      target: "writing-stage",
      stageId: POST_APPROVAL_WRITING_STAGE_ID,
      repair: "RESTORE",
    });
  });

  it("[behavior:B-09] returns a baseline-is-wrong finding to the generator loop for one generator round and no evaluator attempt", () => {
    expect(
      routeFinalReviewFinding(
        finding({
          class: "BASELINE_IS_WRONG",
          repair: "RETURN_TO_GENERATOR",
        }),
        { candidateTreeId: BASELINE_TREE },
      ),
    ).toEqual({
      target: "generator-loop",
      invalidateCandidateTreeId: BASELINE_TREE,
      generatorRoundsConsumed: 1,
      finalEvaluationAttemptsConsumed: 0,
    });
  });
});

describe("decideFinalVerdict", () => {
  const green = {
    gates: [
      { gateId: "tests", required: true, status: "PASS" },
      { gateId: "scope", required: true, status: "PASS" },
      { gateId: "advisory", required: false, status: "FAIL" },
    ],
    candidateTreeId: BASELINE_TREE,
    finalTreeId: OTHER_TREE,
    candidateArtifactTreeId: BASELINE_TREE,
    finalArtifactTreeId: OTHER_TREE,
    reviewValidation: { ok: true } as const,
    scopeGateStatus: "PASS",
  };

  it("[behavior:B-11] returns PASS only when every condition holds", () => {
    expect(decideFinalVerdict(green)).toEqual({ verdict: "PASS", blockers: [] });
  });

  it("[behavior:B-11] fails closed when a required gate is not green", () => {
    const outcome = decideFinalVerdict({
      ...green,
      gates: [{ gateId: "tests", required: true, status: "FAIL" }],
    });

    expect(outcome.verdict).toBe("FAIL");
    expect(outcome.blockers).toContain("required gate tests is FAIL, not PASS");
  });

  it("[behavior:B-11] fails closed when no required gate outcome was supplied at all", () => {
    const outcome = decideFinalVerdict({
      ...green,
      gates: [{ gateId: "advisory", required: false, status: "PASS" }],
    });

    expect(outcome.verdict).toBe("FAIL");
    expect(outcome.blockers.join(" ")).toContain("no required gate outcomes");
  });

  it.each([
    ["candidate artifacts keyed to another tree", { candidateArtifactTreeId: OTHER_TREE }],
    ["candidate artifacts keyed to no tree", { candidateArtifactTreeId: null }],
    ["final artifacts keyed to another tree", { finalArtifactTreeId: BASELINE_TREE }],
    ["final artifacts keyed to no tree", { finalArtifactTreeId: null }],
    [
      "a final review that did not validate",
      { reviewValidation: { ok: false as const, error: "bad verdict" } },
    ],
    ["a scope gate that did not run", { scopeGateStatus: null }],
    ["a scope gate that is not green", { scopeGateStatus: "FAIL" }],
  ])("[behavior:B-11] fails closed on %s", (_label, overrides) => {
    const outcome = decideFinalVerdict({ ...green, ...overrides });

    expect(outcome.verdict).toBe("FAIL");
    expect(outcome.blockers.length).toBeGreaterThan(0);
  });

  it("[behavior:B-11] names every unmet condition rather than only the first", () => {
    const outcome = decideFinalVerdict({
      ...green,
      gates: [{ gateId: "tests", required: true, status: "FAIL" }],
      finalArtifactTreeId: null,
      scopeGateStatus: null,
    });

    expect(outcome.blockers).toHaveLength(3);
  });
});

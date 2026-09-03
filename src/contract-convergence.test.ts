import { describe, expect, it } from "vitest";
import type {
  ContractReview,
  ContractReviewFinding,
} from "./contract-review.js";
import {
  advanceContractFindingLineage,
  contractPlannerContext,
  decideContractContinuation,
  emptyContractFindingLineage,
  parseContractFindingLineage,
} from "./contract-convergence.js";

const finding = (
  id: string,
  state: ContractReviewFinding["state"] = "OPEN",
  overrides: Partial<ContractReviewFinding> = {},
): ContractReviewFinding => ({
  id,
  severity: "BLOCKING",
  behaviorIds: ["B-01"],
  evidence: `"${id} evidence"`,
  expected: `${id} expected`,
  observed: `${id} observed`,
  clearCondition: `${id} clears`,
  state,
  revisionCitation: null,
  ...overrides,
});

const review = (
  findings: ContractReviewFinding[],
  verdict: ContractReview["verdict"] = "REVISE",
): ContractReview => ({ version: 2, verdict, findings });

describe("contract finding lineage", () => {
  it("retains stable identity and classifies repetition, reopening, and regression", () => {
    const first = advanceContractFindingLineage(
      emptyContractFindingLineage(),
      review([finding("F-01")]),
    );
    const repeated = advanceContractFindingLineage(
      first.lineage,
      review([finding("F-01")]),
    );
    expect(repeated.repeatedBlockingIds).toEqual(["F-01"]);

    const resolved = advanceContractFindingLineage(
      repeated.lineage,
      review([finding("F-01", "RESOLVED")], "ACCEPT"),
    );
    const reopened = advanceContractFindingLineage(
      resolved.lineage,
      review([finding("F-01")]),
    );
    expect(reopened.reopenedBlockingIds).toEqual(["F-01"]);

    const regressed = advanceContractFindingLineage(
      resolved.lineage,
      review([
        finding("F-99", "OPEN", {
          expected: "F-01 expected",
          clearCondition: "F-01 clears",
        }),
      ]),
    );
    expect(regressed.regressedBlockingIds).toEqual(["F-99"]);
    expect(regressed.lineage.findings["F-01"]?.stableId).toBe("F-01");
  });

  it("routes open findings plus only overlapping resolved history", () => {
    let lineage = advanceContractFindingLineage(
      emptyContractFindingLineage(),
      review([
        finding("F-01", "RESOLVED"),
        finding("F-02", "RESOLVED", { behaviorIds: ["B-02"] }),
      ], "ACCEPT"),
    ).lineage;
    lineage = advanceContractFindingLineage(
      lineage,
      review([finding("F-03", "OPEN", { behaviorIds: ["B-01"] })]),
    ).lineage;

    const context = contractPlannerContext(lineage);
    expect(context.open.map(({ id }) => id)).toEqual(["F-03"]);
    expect(context.relevantResolved.map(({ id }) => id)).toEqual(["F-01"]);
  });

  it("fails closed on malformed persisted roots and nested findings", () => {
    expect(() => parseContractFindingLineage({})).toThrow(
      /must contain version 1/,
    );
    const valid = advanceContractFindingLineage(
      emptyContractFindingLineage(),
      review([finding("F-01")]),
    ).lineage;
    expect(() =>
      parseContractFindingLineage({
        ...valid,
        extensionUsed: true,
        findings: {
          ...valid.findings,
          "F-01": {
            ...valid.findings["F-01"],
            finding: {
              ...valid.findings["F-01"]!.finding,
              clearCondition: "",
            },
          },
        },
      }),
    ).toThrow(/clearCondition must be a non-blank string/);
  });
});

describe("contract continuation policy", () => {
  function stopReason(
    decision: ReturnType<typeof decideContractContinuation>,
  ): string {
    expect(decision.action).toBe("stop");
    return decision.action === "stop" ? decision.reason : "";
  }

  function lateFreshFinding() {
    const first = advanceContractFindingLineage(
      emptyContractFindingLineage(),
      review([finding("F-01")]),
    );
    const currentReview = review([
      finding("F-01", "RESOLVED"),
      finding("F-02", "OPEN", {
        revisionCitation: {
          artifact: "contract.md",
          before: "before",
          after: "after",
        },
      }),
    ]);
    const update = advanceContractFindingLineage(first.lineage, currentReview);
    return { before: first.lineage, update, currentReview };
  }

  it("models the PRD 3 boundary: resolved prior blockers plus a fresh cited blocker earn one response", () => {
    const { before, update, currentReview } = lateFreshFinding();
    expect(
      decideContractContinuation({
        before,
        update,
        review: currentReview,
        gateObjection: false,
        revisionCitationValidated: true,
      }),
    ).toEqual({ action: "extend", findingIds: ["F-02"] });
  });

  it("is deterministic and provider-independent at the structured policy seam", () => {
    const { before, update, currentReview } = lateFreshFinding();
    const input = {
      before,
      update,
      review: currentReview,
      gateObjection: false,
      revisionCitationValidated: true,
    };
    expect(decideContractContinuation(input)).toEqual(
      decideContractContinuation(structuredClone(input)),
    );
    expect(Object.keys(input)).not.toContain("provider");
  });

  it("denies repeated, unresolved, reopened, regressed, gate-refused, uncited, no-fresh, and already-used cases", () => {
    const first = advanceContractFindingLineage(
      emptyContractFindingLineage(),
      review([finding("F-01")]),
    );
    const repeated = advanceContractFindingLineage(
      first.lineage,
      review([finding("F-01")]),
    );
    expect(
      decideContractContinuation({
        before: first.lineage,
        update: repeated,
        review: review([finding("F-01")]),
        gateObjection: false,
        revisionCitationValidated: true,
      }).action,
    ).toBe("stop");

    const late = lateFreshFinding();
    expect(
      stopReason(decideContractContinuation({
        before: first.lineage,
        update: { ...repeated, repeatedBlockingIds: [] },
        review: review([finding("F-01")]),
        gateObjection: false,
        revisionCitationValidated: true,
      })),
    ).toContain("remain unresolved");

    const resolved = advanceContractFindingLineage(
      first.lineage,
      review([finding("F-01", "RESOLVED")], "ACCEPT"),
    );
    const reopenedReview = review([finding("F-01")]);
    const reopened = advanceContractFindingLineage(
      resolved.lineage,
      reopenedReview,
    );
    expect(
      stopReason(decideContractContinuation({
        before: resolved.lineage,
        update: reopened,
        review: reopenedReview,
        gateObjection: false,
        revisionCitationValidated: true,
      })),
    ).toContain("reopened");

    const regressedReview = review([
      finding("F-99", "OPEN", {
        expected: "F-01 expected",
        clearCondition: "F-01 clears",
      }),
    ]);
    const regressed = advanceContractFindingLineage(
      resolved.lineage,
      regressedReview,
    );
    expect(
      stopReason(decideContractContinuation({
        before: resolved.lineage,
        update: regressed,
        review: regressedReview,
        gateObjection: false,
        revisionCitationValidated: true,
      })),
    ).toContain("regressed");

    expect(
      stopReason(decideContractContinuation({
        before: late.before,
        update: late.update,
        review: late.currentReview,
        gateObjection: true,
        revisionCitationValidated: true,
      })),
    ).toContain("gate-refused");
    expect(
      stopReason(decideContractContinuation({
        before: late.before,
        update: late.update,
        review: late.currentReview,
        gateObjection: false,
        revisionCitationValidated: false,
      })),
    ).toContain("no validated changed-text");
    expect(
      stopReason(decideContractContinuation({
        before: late.before,
        update: { ...late.update, freshBlockingIds: [] },
        review: late.currentReview,
        gateObjection: false,
        revisionCitationValidated: true,
      })),
    ).toContain("not genuinely fresh");

    const used = { ...late.before, extensionUsed: true };
    expect(
      decideContractContinuation({
        before: used,
        update: late.update,
        review: late.currentReview,
        gateObjection: false,
        revisionCitationValidated: true,
      }),
    ).toMatchObject({ action: "stop", reason: expect.stringContaining("already used") });
  });
});

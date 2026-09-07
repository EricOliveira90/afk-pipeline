import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ContractReview,
  ContractReviewFinding,
} from "./contract-review.js";
import { ContractRoundLifecycle } from "./convergence-coordinator.js";
import {
  advanceContractFindingLineage,
  contractPlannerContext,
  decideContractContinuation,
  emptyContractFindingLineage,
  findOrphanedContractLineage,
  loadContractFindingLineage,
  parseContractFindingLineage,
  saveContractFindingLineage,
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

describe("contract round routing", () => {
  it("routes every distinct finding from the exact previous review", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "afk-contract-routing-"));
    try {
      const lifecycle = new ContractRoundLifecycle({
        repoRoot,
        prdSlug: "contract-routing",
        ghIssue: "9081",
        sliceDir: repoRoot,
        runSlug: "contract-routing",
      });
      const firstReview = review([
        finding("F-01", "OPEN", {
          expected: "one agreed interpretation",
          observed: "planner and evaluator disagree",
          clearCondition: "a human adjudicates",
        }),
        finding("F-02", "OPEN", {
          expected: "one agreed interpretation",
          observed: "planner and evaluator disagree",
          clearCondition: "a human adjudicates",
        }),
      ]);
      const validated = lifecycle.validateAttempt({
        review: firstReview,
        evaluatorRound: 1,
        plannerResponse: null,
        revisionArtifacts: null,
        attemptLifecyclePrevious: null,
      });
      lifecycle.recordRound({
        validated,
        evaluatorRound: 1,
        plannerResponse: null,
        revisionArtifacts: null,
        attemptLifecyclePrevious: null,
        candidate: {
          branch: "fix/contract-routing",
          treeId: "1111111111111111111111111111111111111111",
        },
        supportingEvidence: ["feedback-r1.md"],
        round: 1,
        normalRoundLimit: 2,
        semanticRoundLimit: 2,
        gateObjection: false,
        hasContestedBlocker: false,
      });

      const next = lifecycle.preparePlannerRound(2, null);

      expect(next.routedFindings.map(({ id }) => id)).toEqual([
        "F-01",
        "F-02",
      ]);
      expect(next.revisionNote).toContain("[F-01]");
      expect(next.revisionNote).toContain("[F-02]");
      expect(next.carriedFindings).toEqual([]);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("informs a fresh round 1 of the lineage its review is enforced against", () => {
    // #178: a restart renegotiates from base while lineage survives, and the
    // anti-amnesia validator refuses a review that omits an open blocker. Both
    // prompts for that round have to carry the findings, or the slice wedges:
    // planner round 1 through `carriedFindings`, evaluator round 1 through the
    // history note that had no caller at all.
    const repoRoot = mkdtempSync(join(tmpdir(), "afk-contract-restart-"));
    try {
      const location = {
        repoRoot,
        prdSlug: "contract-restart",
        ghIssue: "9082",
        sliceDir: repoRoot,
        runSlug: "contract-restart-codex",
      };
      saveContractFindingLineage(
        location,
        advanceContractFindingLineage(
          emptyContractFindingLineage(),
          review([finding("F-01"), finding("F-02")]),
        ).lineage,
      );

      const restarted = new ContractRoundLifecycle(location);
      expect(restarted.hasDurableLineage).toBe(true);

      const firstRound = restarted.preparePlannerRound(1, null);
      expect(firstRound.carriedFindings.map(({ id }) => id)).toEqual([
        "F-01",
        "F-02",
      ]);
      expect(firstRound.routedFindings).toEqual([]);
      expect(firstRound.requiresResponse).toBe(false);

      const note = restarted.evaluatorHistoryNote(1, "specs/slices/01-x");
      expect(note).toContain("fresh attempt with durable finding lineage");
      expect(note).toContain("[F-01]");
      expect(note).toContain("[F-02]");
      expect(note).toContain("F-01 clears");
      // Resolved history stays out of both role envelopes, which declare
      // `resolved-findings` omitted.
      expect(note).not.toContain("Relevant resolved history");
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("keeps durable lineage in the provider-qualified run-state file", () => {
    // #178 comment: lineage keyed on the bare PRD slug landed in
    // `.afk/state/<slug>.json` while every other read and write of this run's
    // state used `<slug>-<provider>.json`. The tamper guard then survived a
    // state reset it should have been cleared by, and an operator editing "the"
    // state file could not reach it.
    const repoRoot = mkdtempSync(join(tmpdir(), "afk-contract-slug-"));
    try {
      const lineage = advanceContractFindingLineage(
        emptyContractFindingLineage(),
        review([finding("F-01")]),
      ).lineage;
      saveContractFindingLineage(
        { repoRoot, ghIssue: "9083", runSlug: "split-brain-codex" },
        lineage,
      );

      const qualified = join(
        repoRoot,
        ".afk",
        "state",
        "split-brain-codex.json",
      );
      expect(existsSync(qualified)).toBe(true);
      expect(existsSync(join(repoRoot, ".afk", "state", "split-brain.json")))
        .toBe(false);
      expect(
        JSON.parse(readFileSync(qualified, "utf-8")).contractConvergence,
      ).toMatchObject({ "9083": { revision: 1 } });
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("names lineage stranded under the bare PRD slug, and adopts nothing", () => {
    // The one silent case in ADR 0061's relocation: the schema did not change,
    // so a build on either side of the move reads an *empty* lineage from the
    // other's file instead of failing. Nothing is adopted — on a non-kiro run
    // the bare-slug file may be a live kiro run's state for the same PRD, and
    // importing another run's tamper-guard memory is worse than not seeing
    // this one's.
    const repoRoot = mkdtempSync(join(tmpdir(), "afk-contract-orphan-"));
    try {
      const lineage = advanceContractFindingLineage(
        emptyContractFindingLineage(),
        review([finding("F-01")]),
      ).lineage;
      saveContractFindingLineage(
        { repoRoot, ghIssue: "9083", runSlug: "orphan" },
        lineage,
      );
      const location = {
        repoRoot,
        prdSlug: "orphan",
        runSlug: "orphan-codex",
        ghIssue: "9083",
      };

      const message = findOrphanedContractLineage(location);
      expect(message).toContain(".afk/state/orphan.json");
      expect(message).toContain(".afk/state/orphan-codex.json");
      expect(message).toContain("#9083");
      // Reading it does not move it.
      expect(
        loadContractFindingLineage({
          repoRoot,
          runSlug: "orphan-codex",
          ghIssue: "9083",
        }),
      ).toEqual(emptyContractFindingLineage());
      expect(findOrphanedContractLineage(location)).toBe(message);

      // Silent in the three cases that are not a split: a kiro run (the two
      // slugs are the same file), another slice, and a run whose qualified
      // file already holds its own lineage.
      expect(
        findOrphanedContractLineage({ ...location, runSlug: "orphan" }),
      ).toBeNull();
      expect(
        findOrphanedContractLineage({ ...location, ghIssue: "9999" }),
      ).toBeNull();
      saveContractFindingLineage(
        { repoRoot, ghIssue: "9083", runSlug: "orphan-codex" },
        lineage,
      );
      expect(findOrphanedContractLineage(location)).toBeNull();
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
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

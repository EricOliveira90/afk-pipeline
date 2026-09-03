import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  QAReview,
  QAReviewAttemptFinding,
  QAReviewFinding,
  QAReviewStage,
} from "./qa-review.js";
import {
  advanceQAFindingLineage,
  decideQAFinalRepair,
  emptyQAConvergenceState,
  formatQAGeneratorContext,
  hasPendingQAFinalRepair,
  loadQAConvergenceState,
  markQAFinalRepairUsed,
  parseQAConvergenceState,
  qaGeneratorContext,
  resolveQAScopeAmendments,
  saveQAConvergenceState,
  validateQAReviewAgainstLineage,
} from "./qa-convergence.js";

const TREE_A = "a".repeat(40);
const TREE_B = "b".repeat(40);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function finding(
  id: string,
  state: QAReviewFinding["state"] = "OPEN",
  overrides: Partial<QAReviewFinding> = {},
): QAReviewFinding {
  return {
    id,
    severity: "BLOCKING",
    behaviorIds: ["B-01"],
    summary: `${id} summary`,
    evidence: `${id} evidence`,
    expected: `${id} expected`,
    observed: `${id} observed`,
    clearCondition: `${id} clear`,
    state,
    remedy: "SOURCE_CHANGE",
    amendmentPaths: [],
    ...overrides,
  };
}

function review(
  findings: QAReviewFinding[],
  verdict: QAReview["verdict"] = findings.some(
    (entry) => entry.severity === "BLOCKING" && entry.state === "OPEN",
  )
    ? "FAIL"
    : "PASS",
): QAReview {
  return {
    version: 2,
    verdict,
    failureClass: verdict === "FAIL" ? "IMPLEMENTATION" : "NONE",
    infrastructureEvidence: null,
    findings,
  };
}

function attemptFinding(entry: QAReviewFinding): QAReviewAttemptFinding {
  return {
    id: entry.id,
    severity: entry.severity,
    state: entry.state,
    unresolved: entry.state === "OPEN",
    summary: entry.summary,
    clearCondition: entry.clearCondition,
    artifactReferences: [
      `.afk/reviews/${entry.id}.json`,
      `.kiro/specs/${entry.id}.md`,
    ],
    remedy: entry.remedy,
  };
}

function advance(
  prior: ReturnType<typeof emptyQAConvergenceState>,
  findings: QAReviewFinding[],
  options: {
    stage?: QAReviewStage;
    tree?: string;
    verdict?: QAReview["verdict"];
  } = {},
) {
  const currentReview = review(findings, options.verdict);
  return {
    currentReview,
    update: advanceQAFindingLineage(prior, {
      stage: options.stage ?? "deterministic",
      review: currentReview,
      attemptFindings: findings.map(attemptFinding),
      candidateTreeId: options.tree ?? TREE_A,
    }),
  };
}

describe("candidate-QA finding lineage", () => {
  it("retains stable identity and classifies repetition, reopening, and renamed regression", () => {
    const first = advance(emptyQAConvergenceState(), [finding("QA-01")]);
    const repeated = advance(first.update.state, [finding("QA-01")]);
    expect(repeated.update.repeatedBlockingIds).toEqual(["QA-01"]);

    const resolved = advance(repeated.update.state, [
      finding("QA-01", "RESOLVED"),
    ]);
    const reopened = advance(resolved.update.state, [finding("QA-01")]);
    expect(reopened.update.reopenedBlockingIds).toEqual(["QA-01"]);

    const regressed = advance(resolved.update.state, [
      finding("QA-99", "OPEN", {
        expected: "QA-01 expected",
        clearCondition: "QA-01 clear",
      }),
    ]);
    expect(regressed.update.regressedBlockingIds).toEqual(["QA-99"]);
    expect(
      regressed.update.state.findings["deterministic:QA-01"]?.stableId,
    ).toBe("QA-01");
  });

  it("fails closed when a resumed review omits a durable open finding", () => {
    const first = advance(emptyQAConvergenceState(), [finding("QA-01")]);
    expect(() =>
      validateQAReviewAgainstLineage(
        first.update.state,
        "deterministic",
        review([finding("QA-02")]),
      ),
    ).toThrow(/omitted durable open finding QA-01/);
  });

  it("adopts an archived pre-lineage open finding when an upgraded resume resolves it", () => {
    const resolved = finding("QA-OLD", "RESOLVED");
    const update = advanceQAFindingLineage(emptyQAConvergenceState(), {
      stage: "deterministic",
      review: review([resolved]),
      attemptFindings: [attemptFinding(resolved)],
      candidateTreeId: TREE_A,
      restoredOpenFindings: [attemptFinding(finding("QA-OLD"))],
    });
    expect(
      update.state.findings["deterministic:QA-OLD"],
    ).toMatchObject({
      stableId: "QA-OLD",
      disposition: "RESOLVED",
      finding: { state: "RESOLVED" },
    });
  });

  it("routes active source-change findings and only overlapping resolved constraints", () => {
    let state = advance(emptyQAConvergenceState(), [
      finding("QA-01", "OPEN", { behaviorIds: ["B-01"] }),
      finding("QA-02", "OPEN", { behaviorIds: ["B-02"] }),
    ]).update.state;
    state = advance(state, [
      finding("QA-01", "RESOLVED", { behaviorIds: ["B-01"] }),
      finding("QA-02", "RESOLVED", { behaviorIds: ["B-02"] }),
      finding("QA-03", "OPEN", { behaviorIds: ["B-01"] }),
    ]).update.state;

    const context = qaGeneratorContext(state);
    expect(context.open.map(({ currentId }) => currentId)).toEqual(["QA-03"]);
    expect(
      context.relevantResolved.map(({ currentId }) => currentId),
    ).toEqual(["QA-01"]);
    const rendered = formatQAGeneratorContext(state, ["gate.json", "test.log"]);
    expect(rendered).toContain("Current deterministic gate failures");
    expect(rendered).toContain("QA-03");
    expect(rendered).toContain("State: OPEN");
    expect(rendered).toContain("Unresolved: yes");
    expect(rendered).toContain("Remedy: SOURCE_CHANGE");
    expect(rendered).toContain("Relevant resolved QA findings");
    expect(rendered).toContain("QA-01");
    expect(rendered).toContain("State: RESOLVED");
    expect(rendered).toContain("Unresolved: no");
    expect(rendered).not.toContain("QA-02");
  });

  it("settles applied scope amendments so they never route to a resumed generator", () => {
    const amendment = finding("QA-SCOPE", "OPEN", {
      remedy: "SCOPE_AMENDMENT",
      amendmentPaths: ["src/support.ts"],
    });
    const first = advance(emptyQAConvergenceState(), [amendment]);
    const settled = resolveQAScopeAmendments(
      first.update.state,
      "deterministic",
      ["QA-SCOPE"],
    );
    expect(
      settled.findings["deterministic:QA-SCOPE"]?.finding.state,
    ).toBe("RESOLVED");
    expect(formatQAGeneratorContext(settled)).toBe("(none)");
  });
});

describe("candidate-QA final repair policy", () => {
  function lateFreshFinding() {
    const first = advance(emptyQAConvergenceState(), [
      finding("QA-01"),
      finding("QA-02", "OPEN", { behaviorIds: ["B-02"] }),
    ]);
    const late = advance(
      first.update.state,
      [
        finding("QA-01", "RESOLVED"),
        finding("QA-02", "RESOLVED", { behaviorIds: ["B-02"] }),
        finding("QA-03", "OPEN", { behaviorIds: ["B-03"] }),
      ],
      { tree: TREE_B },
    );
    return { before: first.update.state, ...late };
  }

  it("models PRD 3 QA-01 and QA-02 resolving before fresh QA-03 at the boundary", () => {
    const late = lateFreshFinding();
    expect(
      decideQAFinalRepair({
        before: late.before,
        update: late.update,
        review: late.currentReview,
        stage: "deterministic",
        candidateTreeId: TREE_B,
      }),
    ).toEqual({ action: "extend", findingIds: ["QA-03"] });
  });

  it("denies repeated, unresolved, reopened, regressed, wrong-tree, non-source, and already-used blockers", () => {
    const first = advance(emptyQAConvergenceState(), [finding("QA-01")]);
    const repeated = advance(first.update.state, [finding("QA-01")]);
    expect(
      decideQAFinalRepair({
        before: first.update.state,
        update: repeated.update,
        review: repeated.currentReview,
        stage: "deterministic",
        candidateTreeId: TREE_A,
      }).action,
    ).toBe("stop");

    const late = lateFreshFinding();
    const unresolved = {
      ...late.update,
      state: {
        ...late.update.state,
        findings: {
          ...late.update.state.findings,
          "deterministic:QA-01": {
            ...late.update.state.findings["deterministic:QA-01"]!,
            finding: finding("QA-01"),
          },
        },
      },
    };
    expect(
      decideQAFinalRepair({
        before: late.before,
        update: unresolved,
        review: late.currentReview,
        stage: "deterministic",
        candidateTreeId: TREE_B,
      }).action,
    ).toBe("stop");

    for (const field of [
      "reopenedBlockingIds",
      "regressedBlockingIds",
    ] as const) {
      expect(
        decideQAFinalRepair({
          before: late.before,
          update: { ...late.update, [field]: ["QA-03"] },
          review: late.currentReview,
          stage: "deterministic",
          candidateTreeId: TREE_B,
        }).action,
      ).toBe("stop");
    }
    expect(
      decideQAFinalRepair({
        before: late.before,
        update: late.update,
        review: late.currentReview,
        stage: "deterministic",
        candidateTreeId: TREE_A,
      }).action,
    ).toBe("stop");

    const scopeReview = review([
      finding("QA-01", "RESOLVED"),
      finding("QA-02", "RESOLVED", { behaviorIds: ["B-02"] }),
      finding("QA-SCOPE", "OPEN", {
        behaviorIds: ["B-03"],
        remedy: "SCOPE_AMENDMENT",
        amendmentPaths: ["src/support.ts"],
      }),
    ]);
    const scopeUpdate = advanceQAFindingLineage(late.before, {
      stage: "deterministic",
      review: scopeReview,
      attemptFindings: scopeReview.findings.map(attemptFinding),
      candidateTreeId: TREE_B,
    });
    expect(
      decideQAFinalRepair({
        before: late.before,
        update: scopeUpdate,
        review: scopeReview,
        stage: "deterministic",
        candidateTreeId: TREE_B,
      }).action,
    ).toBe("stop");

    expect(
      decideQAFinalRepair({
        before: markQAFinalRepairUsed(late.before),
        update: late.update,
        review: late.currentReview,
        stage: "deterministic",
        candidateTreeId: TREE_B,
      }).action,
    ).toBe("stop");
  });

  it("makes the granted fourth round durable but never grants a fifth", () => {
    const used = markQAFinalRepairUsed(emptyQAConvergenceState());
    expect(
      hasPendingQAFinalRepair({
        state: used,
        nextRound: 4,
        normalRoundLimit: 3,
      }),
    ).toBe(true);
    expect(
      hasPendingQAFinalRepair({
        state: used,
        nextRound: 5,
        normalRoundLimit: 3,
      }),
    ).toBe(false);
  });
});

describe("candidate-QA lineage persistence", () => {
  it("survives a fresh process load and fails closed on malformed state", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "afk-qa-convergence-"));
    roots.push(repoRoot);
    const location = {
      repoRoot,
      prdSlug: "prd",
      ghIssue: "156",
    };
    const state = advance(emptyQAConvergenceState(), [
      finding("QA-01"),
    ]).update.state;
    saveQAConvergenceState(location, state);
    expect(loadQAConvergenceState(location)).toEqual(state);

    expect(() => parseQAConvergenceState({})).toThrow(/version 1/);
    expect(() =>
      parseQAConvergenceState({
        ...state,
        findings: {
          ...state.findings,
          "deterministic:QA-01": {
            ...state.findings["deterministic:QA-01"],
            candidateTreeId: "not-a-tree",
          },
        },
      }),
    ).toThrow(/candidateTreeId is invalid/);
  });
});

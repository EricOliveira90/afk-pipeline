import { describe, expect, it } from "vitest";
import {
  authorizeBaseGateSkip,
  formatBaseGateSkipAuthorization,
  type BaseGateSkipInput,
} from "./qa-gate-authorization.js";
import type {
  GateDeclaration,
  GateEvidence,
  GateResult,
  GateStatus,
} from "./gate-runner.js";

const REVIEW_TREE = "1111111111111111111111111111111111111111";
const OTHER_TREE = "2222222222222222222222222222222222222222";
const EVIDENCE_ID = ".afk/runs/run-1/gates/s01/gate-evidence.json";

const DECLARATIONS: GateDeclaration[] = [
  { id: "typecheck", stage: "base", required: true, command: "pnpm", args: ["run", "typecheck"] },
  { id: "lint", stage: "base", required: true, command: "pnpm", args: ["run", "lint"] },
  { id: "tests", stage: "base", required: true, command: "pnpm", args: ["run", "test"] },
];

function result(
  gateId: string,
  overrides: Partial<GateResult> = {},
): GateResult {
  return {
    gateId,
    stage: "base",
    status: "PASS",
    failureKind: null,
    startedAt: "2026-08-28T10:00:00.000Z",
    endedAt: "2026-08-28T10:01:00.000Z",
    durationMs: 60_000,
    exitCode: 0,
    treeId: REVIEW_TREE,
    logArtifactId: `${gateId}.log`,
    ...overrides,
  };
}

function evidence(overrides: Partial<GateEvidence> = {}): GateEvidence {
  return {
    version: 1,
    attemptId: "attempt-abc",
    treeId: REVIEW_TREE,
    results: DECLARATIONS.map((declaration) => result(declaration.id)),
    ...overrides,
  };
}

function input(overrides: Partial<BaseGateSkipInput> = {}): BaseGateSkipInput {
  return {
    evidence: evidence(),
    evidenceArtifactId: EVIDENCE_ID,
    declarations: DECLARATIONS,
    reviewTreeId: REVIEW_TREE,
    ...overrides,
  };
}

describe("authorizeBaseGateSkip grants only on an exact tree match", () => {
  it("authorizes when every executable gate passed on the tree under review", () => {
    const authorization = authorizeBaseGateSkip(input());

    expect(authorization).toEqual({
      authorized: true,
      citation: {
        evidenceArtifactId: EVIDENCE_ID,
        attemptId: "attempt-abc",
        treeId: REVIEW_TREE,
        gateIds: ["typecheck", "lint", "tests"],
      },
      gates: [
        {
          gateId: "typecheck",
          command: "pnpm run typecheck",
          endedAt: "2026-08-28T10:01:00.000Z",
          durationMs: 60_000,
        },
        {
          gateId: "lint",
          command: "pnpm run lint",
          endedAt: "2026-08-28T10:01:00.000Z",
          durationMs: 60_000,
        },
        {
          gateId: "tests",
          command: "pnpm run test",
          endedAt: "2026-08-28T10:01:00.000Z",
          durationMs: 60_000,
        },
      ],
    });
  });

  it("covers only the gates the project can actually run", () => {
    // A project with no lint script declares the gate non-executable. The
    // authorization must not claim it ran; the evaluator still owns it.
    const declarations: GateDeclaration[] = [
      DECLARATIONS[0]!,
      { id: "lint", stage: "base", required: false },
      DECLARATIONS[2]!,
    ];
    const authorization = authorizeBaseGateSkip(
      input({
        declarations,
        evidence: evidence({
          results: [
            result("typecheck"),
            result("lint", { status: "SKIPPED", exitCode: null }),
            result("tests"),
          ],
        }),
      }),
    );

    expect(authorization).toMatchObject({
      authorized: true,
      citation: { gateIds: ["typecheck", "tests"] },
    });
  });

  it("refuses when the tree moved between the gate run and the review", () => {
    const authorization = authorizeBaseGateSkip(
      input({ evidence: evidence({ treeId: OTHER_TREE }) }),
    );

    expect(authorization.authorized).toBe(false);
    expect(authorization.authorized === false && authorization.reason).toContain(
      OTHER_TREE,
    );
    expect(authorization.authorized === false && authorization.reason).toContain(
      REVIEW_TREE,
    );
  });

  it("refuses when one gate result disagrees with the evidence header", () => {
    const authorization = authorizeBaseGateSkip(
      input({
        evidence: evidence({
          results: [
            result("typecheck"),
            result("lint", { treeId: OTHER_TREE }),
            result("tests"),
          ],
        }),
      }),
    );

    expect(authorization).toEqual({
      authorized: false,
      reason:
        `base gate lint recorded tree ${OTHER_TREE}, not the tree under ` +
        `review ${REVIEW_TREE}`,
    });
  });

  it("refuses when the tree under review could not be hashed", () => {
    for (const reviewTreeId of [null, "", "   "]) {
      expect(authorizeBaseGateSkip(input({ reviewTreeId }))).toEqual({
        authorized: false,
        reason:
          "the tree under review could not be hashed, so no sha comparison is possible",
      });
    }
  });

  it("refuses when there is no evidence or no citable artifact path", () => {
    expect(authorizeBaseGateSkip(input({ evidence: null }))).toMatchObject({
      authorized: false,
      reason: "this round produced no base-gate evidence",
    });
    expect(
      authorizeBaseGateSkip(input({ evidenceArtifactId: "" })),
    ).toMatchObject({
      authorized: false,
      reason: "the base-gate evidence artifact has no citable path",
    });
  });

  it("refuses when a declared gate has no result at all", () => {
    expect(
      authorizeBaseGateSkip(
        input({
          evidence: evidence({
            results: [result("typecheck"), result("tests")],
          }),
        }),
      ),
    ).toEqual({
      authorized: false,
      reason: "base gate lint has no result in the evidence",
    });
  });

  it.each<GateStatus>(["FAIL", "INFRASTRUCTURE", "SKIPPED"])(
    "refuses when an executable gate is %s rather than PASS",
    (status) => {
      expect(
        authorizeBaseGateSkip(
          input({
            evidence: evidence({
              results: [
                result("typecheck"),
                result("lint", { status }),
                result("tests"),
              ],
            }),
          }),
        ),
      ).toEqual({
        authorized: false,
        reason: `base gate lint is ${status}, not PASS`,
      });
    },
  );

  it("refuses when the project declares no executable gate", () => {
    expect(
      authorizeBaseGateSkip(
        input({
          declarations: [{ id: "tests", stage: "base", required: false }],
          evidence: evidence({
            results: [result("tests", { status: "SKIPPED" })],
          }),
        }),
      ),
    ).toEqual({
      authorized: false,
      reason: "no base gate had an executable command on this project",
    });
  });
});

describe("formatBaseGateSkipAuthorization", () => {
  it("renders a citable grant naming every covered command, sha and artifact", () => {
    const block = formatBaseGateSkipAuthorization(
      authorizeBaseGateSkip(input()),
    );

    expect(block).toContain("Skip authorization");
    expect(block).toContain("`pnpm run typecheck`");
    expect(block).toContain("PASS at 2026-08-28T10:01:00.000Z (60.0s)");
    expect(block).toContain(`\`${EVIDENCE_ID}\``);
    expect(block).toContain(`\`${REVIEW_TREE}\``);
    expect(block).toContain("`attempt-abc`");
    // The install ran in the gate's own checkout, so it is never covered.
    expect(block).toContain("including the dependency install");
  });

  it("renders a refusal that states the reason and orders the full run", () => {
    const block = formatBaseGateSkipAuthorization(
      authorizeBaseGateSkip(input({ evidence: null })),
    );

    expect(block).toContain("No skip authorization is in force");
    expect(block).toContain("this round produced no base-gate evidence");
    expect(block).toContain("Run every sanity command above yourself");
    expect(block).not.toContain("may skip");
  });
});

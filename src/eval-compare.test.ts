import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compareProjection,
  projectOutput,
  roleDispatch,
} from "./eval-compare.js";
import type { EvalRole } from "./eval-pack.js";
import {
  writeEvalContractReview,
  writeEvalFinalReview,
  writeEvalGuardianReview,
  writeEvalMalformedPlannerEscalation,
  writeEvalPlannerContract,
  writeEvalPlannerEscalation,
  writeEvalQAReview,
  writeEvalUnparseableGuardianReview,
} from "./eval.fixtures.js";
import { rmDirWithRetry } from "./test-support.js";

describe("roleDispatch", () => {
  it("B-09 returns the D9 row for every role, with agent and bare absent where production omits them", () => {
    const rows: Array<[EvalRole, Record<string, unknown>, string]> = [
      ["evaluator-contract", { role: "evaluator-contract" }, "contract-review.json"],
      ["evaluator-qa", { role: "evaluator-qa" }, "qa-review.json"],
      ["evaluator-final", { role: "evaluator-final" }, "final-review.json"],
      ["planner", { role: "planner" }, "acceptance-manifest.json"],
      [
        "pm",
        { role: "pm-review", agent: "pm-review", bare: true },
        "review-pm.md",
      ],
      [
        "architect",
        { role: "architect-review", agent: "architect-review", bare: true },
        "review-architect.md",
      ],
    ];

    for (const [role, invokeOptions, artifactFile] of rows) {
      const row = roleDispatch(role);
      expect(row.role).toBe(role);
      expect(row.invokeOptions).toEqual(invokeOptions);
      // Absent keys, not undefined ones: the recorded call is the evidence.
      expect(Object.keys(row.invokeOptions).sort()).toEqual(
        Object.keys(invokeOptions).sort(),
      );
      expect(row.artifactFile).toBe(artifactFile);
      expect(typeof row.parse).toBe("function");
      expect(typeof row.project).toBe("function");
    }
  });
});

describe("projectOutput", () => {
  const dirs: string[] = [];
  const scratch = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "afk-eval-project-"));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmDirWithRetry(dir);
  });

  it("B-10 projects the three evaluators' verdicts through the production parsers", () => {
    const contract = scratch();
    writeEvalContractReview(contract, "REVISE");
    expect(projectOutput("evaluator-contract", contract)).toEqual({
      verdict: "REVISE",
    });

    const qa = scratch();
    writeEvalQAReview(qa, "FAIL", "INFRASTRUCTURE");
    expect(projectOutput("evaluator-qa", qa)).toEqual({
      verdict: "FAIL",
      failureClass: "INFRASTRUCTURE",
    });

    const final = scratch();
    writeEvalFinalReview(final, "PASS");
    expect(projectOutput("evaluator-final", final)).toEqual({
      verdict: "PASS",
    });
  });

  it("B-10 projects no findings, ids, prose or tree ids", () => {
    const dir = scratch();
    // A FAIL carries a finding and two tree ids; the projection keeps neither.
    writeEvalFinalReview(dir, "FAIL");

    expect(projectOutput("evaluator-final", dir)).toEqual({ verdict: "FAIL" });
  });

  it("B-10 finds the artifact recursively, not only at the scratch root", () => {
    const dir = scratch();
    const nested = join(dir, "slice", "reviews");
    mkdirSync(nested, { recursive: true });
    writeEvalContractReview(nested, "ACCEPT");

    expect(projectOutput("evaluator-contract", dir)).toEqual({
      verdict: "ACCEPT",
    });
  });

  it("B-11 projects an escalation sentinel to ESCALATION", () => {
    const dir = scratch();
    const nested = join(dir, "slice");
    mkdirSync(nested, { recursive: true });
    writeEvalPlannerEscalation(nested);

    expect(projectOutput("planner", dir)).toEqual({ artifact: "ESCALATION" });
  });

  it("B-11 projects a manifest with a contract.md beside it to CONTRACT", () => {
    const dir = scratch();
    writeEvalPlannerContract(dir);

    expect(projectOutput("planner", dir)).toEqual({ artifact: "CONTRACT" });
  });

  it("B-11 errors on a manifest with no contract.md beside it", () => {
    const dir = scratch();
    writeEvalPlannerContract(dir);
    rmSync(join(dir, "slice", "contract.md"));

    expect(() => projectOutput("planner", dir)).toThrow(
      /with no contract\.md beside it/,
    );
  });

  it("B-11 errors carrying the defect when the sentinel is malformed", () => {
    const dir = scratch();
    writeEvalMalformedPlannerEscalation(dir);

    expect(() => projectOutput("planner", dir)).toThrow(
      /planner-escalation\.md is malformed: /,
    );
  });

  it("B-12 projects a guardian review's outcome, and UNPARSEABLE as a value", () => {
    for (const guardian of ["pm", "architect"] as const) {
      const shipped = scratch();
      writeEvalGuardianReview(shipped, guardian, "SHIP");
      expect(projectOutput(guardian, shipped)).toEqual({ outcome: "SHIP" });

      const blocked = scratch();
      writeEvalGuardianReview(blocked, guardian, "FIX-BEFORE-SHIP");
      expect(projectOutput(guardian, blocked)).toEqual({
        outcome: "FIX-BEFORE-SHIP",
      });

      // `parseGuardianReview` never throws, so this is a projection and not a
      // parser failure — the MISMATCH a maintainer wants to see as data.
      const unparseable = scratch();
      writeEvalUnparseableGuardianReview(unparseable, guardian);
      expect(projectOutput(guardian, unparseable)).toEqual({
        outcome: "UNPARSEABLE",
      });
      expect(
        compareProjection({ outcome: "SHIP" }, { outcome: "UNPARSEABLE" }),
      ).toBe("MISMATCH");
    }
  });

  it("B-13 throws naming the filename searched for when the role wrote no artifact", () => {
    const dir = scratch();

    expect(() => projectOutput("evaluator-contract", dir)).toThrow(
      /role wrote no contract-review\.json/,
    );
    expect(() => projectOutput("planner", dir)).toThrow(
      /role wrote neither planner-escalation\.md nor acceptance-manifest\.json/,
    );
  });

  it("B-13 throws listing them when the role wrote two matching artifacts", () => {
    const dir = scratch();
    writeEvalQAReview(dir, "PASS");
    const nested = join(dir, "second");
    mkdirSync(nested, { recursive: true });
    writeEvalQAReview(nested, "FAIL", "IMPLEMENTATION");

    expect(() => projectOutput("evaluator-qa", dir)).toThrow(
      /role wrote 2 qa-review\.json files: qa-review\.json, second\/qa-review\.json/,
    );
  });

  it("B-13 throws carrying the parser's message when the parser refuses the artifact", () => {
    const dir = scratch();
    writeFileSync(
      join(dir, "final-review.json"),
      JSON.stringify({ version: 1, verdict: "PASS" }),
      "utf-8",
    );

    expect(() => projectOutput("evaluator-final", dir)).toThrow(
      /final-review\.json/,
    );
  });
});

describe("compareProjection", () => {
  it("B-17 is field-by-field string equality returning MATCH or MISMATCH", () => {
    expect(compareProjection({ verdict: "ACCEPT" }, { verdict: "ACCEPT" })).toBe(
      "MATCH",
    );
    expect(compareProjection({ verdict: "ACCEPT" }, { verdict: "REVISE" })).toBe(
      "MISMATCH",
    );
    expect(
      compareProjection(
        { verdict: "FAIL", failureClass: "IMPLEMENTATION" },
        { verdict: "FAIL", failureClass: "IMPLEMENTATION" },
      ),
    ).toBe("MATCH");
    // The secondary enum alone differing is still a MISMATCH: it is the field
    // an INFRASTRUCTURE misread hides in.
    expect(
      compareProjection(
        { verdict: "FAIL", failureClass: "IMPLEMENTATION" },
        { verdict: "FAIL", failureClass: "INFRASTRUCTURE" },
      ),
    ).toBe("MISMATCH");
    // A key present on one side only is compared, never ignored.
    expect(
      compareProjection({ verdict: "FAIL", failureClass: "NONE" } as never, {
        verdict: "FAIL",
      } as never),
    ).toBe("MISMATCH");
  });
});

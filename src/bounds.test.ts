import { describe, expect, it } from "vitest";
import {
  computeSliceBounds,
  formatSliceBounds,
  implementationRoundsRemaining,
} from "./bounds.js";
import { MAX_RESUME_ATTEMPTS } from "./resume.js";

describe("implementationRoundsRemaining", () => {
  it("gives a fresh slice the whole cap", () => {
    expect(implementationRoundsRemaining({ limit: 3, spent: 0 })).toBe(3);
  });

  it("charges a resume for the rounds its prior lives spent (ADR 0014)", () => {
    expect(
      implementationRoundsRemaining({ limit: 3, spent: 2, resumeMode: "killed" }),
    ).toBe(1);
  });

  it("reports zero — never a negative budget — once the cap is spent", () => {
    expect(
      implementationRoundsRemaining({ limit: 3, spent: 5, resumeMode: "killed" }),
    ).toBe(0);
  });

  it("grants a --resume-stuck dispatch its one documented extra attempt", () => {
    expect(
      implementationRoundsRemaining({ limit: 3, spent: 3, resumeMode: "stuck" }),
    ).toBe(1);
  });
});

describe("computeSliceBounds", () => {
  const base = {
    resumeAttemptsSpent: 0,
    implementationRoundsSpent: 0,
    implementationRoundLimit: 3,
    contractRoundLimit: 2,
    infrastructureRetries: 2,
  };

  it("reports every budget of a first dispatch", () => {
    expect(computeSliceBounds(base)).toEqual({
      resumeAttemptsRemaining: MAX_RESUME_ATTEMPTS,
      resumeAttemptLimit: MAX_RESUME_ATTEMPTS,
      implementationRoundsRemaining: 3,
      implementationRoundLimit: 3,
      contractRoundsRemaining: 2,
      contractRoundLimit: 2,
      infrastructureRetriesPerInvocation: 2,
    });
  });

  it("subtracts the resumes already spent on the tree", () => {
    const bounds = computeSliceBounds({ ...base, resumeAttemptsSpent: 1 });

    expect(bounds.resumeAttemptsRemaining).toBe(MAX_RESUME_ATTEMPTS - 1);
  });

  it("floors the resume attempts at zero — the #79 cliff, stated", () => {
    const bounds = computeSliceBounds({
      ...base,
      resumeAttemptsSpent: MAX_RESUME_ATTEMPTS + 1,
    });

    expect(bounds.resumeAttemptsRemaining).toBe(0);
  });

  it("carries the resume mode so the report can name the exempt case", () => {
    const bounds = computeSliceBounds({
      ...base,
      resumeAttemptsSpent: 2,
      implementationRoundsSpent: 3,
      resumeMode: "stuck",
    });

    expect(bounds.resumeMode).toBe("stuck");
    expect(bounds.implementationRoundsRemaining).toBe(1);
  });

  it("reports the contract budget unspent — negotiation restarts each invocation", () => {
    const bounds = computeSliceBounds({ ...base, contractRoundLimit: 1 });

    expect(bounds.contractRoundsRemaining).toBe(1);
    expect(bounds.contractRoundLimit).toBe(1);
  });
});

describe("formatSliceBounds", () => {
  it("states all four budgets in one line", () => {
    const line = formatSliceBounds(
      computeSliceBounds({
        resumeAttemptsSpent: 1,
        implementationRoundsSpent: 1,
        implementationRoundLimit: 3,
        contractRoundLimit: 2,
        infrastructureRetries: 2,
        resumeMode: "killed",
      }),
    );

    expect(line).toBe(
      "bounds: 1/2 resume attempts left · 2/3 implementation rounds left · " +
        "2/2 contract rounds left · 2 infrastructure retries per invocation",
    );
  });

  it("says the resume cap does not govern a --resume-stuck dispatch", () => {
    const line = formatSliceBounds(
      computeSliceBounds({
        resumeAttemptsSpent: 2,
        implementationRoundsSpent: 3,
        implementationRoundLimit: 3,
        contractRoundLimit: 2,
        infrastructureRetries: 2,
        resumeMode: "stuck",
      }),
    );

    expect(line).toContain("0/2 resume attempts left (--resume-stuck is not capped)");
    expect(line).toContain("1/3 implementation rounds left");
  });

  it("carries no warning marker — the budgets are not a failure signal", () => {
    const line = formatSliceBounds(
      computeSliceBounds({
        resumeAttemptsSpent: 2,
        implementationRoundsSpent: 3,
        implementationRoundLimit: 3,
        contractRoundLimit: 2,
        infrastructureRetries: 0,
      }),
    );

    expect(line).toBe(
      "bounds: 0/2 resume attempts left · 0/3 implementation rounds left · " +
        "2/2 contract rounds left · 0 infrastructure retries per invocation",
    );
    expect(line).not.toMatch(/⚠|warn|WARN/);
  });
});

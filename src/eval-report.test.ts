import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EVAL_REPORT_VERSION,
  type EvalCaseResult,
  type EvalReport,
  formatCaseLine,
  formatEvalSummary,
  readEvalReport,
  writeEvalReport,
} from "./eval-report.js";
import { rmDirWithRetry } from "./test-support.js";

function caseResult(overrides: Partial<EvalCaseResult> = {}): EvalCaseResult {
  return {
    id: "case-01",
    role: "evaluator-contract",
    source: "#194",
    outcome: "MATCH",
    expected: { verdict: "ACCEPT" },
    actual: { verdict: "ACCEPT" },
    callsUsed: 1,
    durationMs: 12,
    ...overrides,
  };
}

function report(overrides: Partial<EvalReport> = {}): EvalReport {
  const cases = overrides.cases ?? [caseResult()];
  return {
    version: 1,
    status: "COMPLETE",
    provider: "eval-stub",
    pack: join(tmpdir(), "pack"),
    packVersion: 1,
    startedAt: "2026-09-12T10:00:00.000Z",
    finishedAt: "2026-09-12T10:00:03.000Z",
    maxCalls: 50,
    callsUsed: 1,
    counts: { MATCH: 1, MISMATCH: 0, "NOT-RUN": 0, ERROR: 0 },
    ...overrides,
    cases,
  };
}

describe("writeEvalReport and readEvalReport", () => {
  const dirs: string[] = [];
  const runDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "afk-eval-report-"));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmDirWithRetry(dir);
  });

  it("B-18 writes report.json with the declared top-level keys and reads it back", () => {
    const dir = runDir();
    const written = report();

    const path = writeEvalReport(dir, written);

    expect(path).toBe(join(dir, "report.json"));
    const document = JSON.parse(readFileSync(path, "utf-8")) as Record<
      string,
      unknown
    >;
    expect(Object.keys(document)).toEqual([
      "version",
      "status",
      "provider",
      "pack",
      "packVersion",
      "startedAt",
      "finishedAt",
      "maxCalls",
      "callsUsed",
      "counts",
      "cases",
    ]);
    expect(document.version).toBe(EVAL_REPORT_VERSION);
    expect(Object.keys(document.counts as object)).toEqual([
      "MATCH",
      "MISMATCH",
      "NOT-RUN",
      "ERROR",
    ]);
    expect(readEvalReport(path)).toEqual(written);
  });

  it("B-18 keeps cases in declared order", () => {
    const dir = runDir();
    const path = writeEvalReport(
      dir,
      report({
        cases: [
          caseResult({ id: "first" }),
          caseResult({ id: "second" }),
          caseResult({ id: "third" }),
        ],
        counts: { MATCH: 3, MISMATCH: 0, "NOT-RUN": 0, ERROR: 0 },
        callsUsed: 3,
      }),
    );

    expect(readEvalReport(path).cases.map((entry) => entry.id)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("B-18 refuses a version other than 1, naming the path", () => {
    const dir = runDir();
    const path = join(dir, "report.json");
    writeFileSync(
      path,
      JSON.stringify({ ...report(), version: 2 }, null, 2),
      "utf-8",
    );

    expect(() => readEvalReport(path)).toThrow(
      /report\.json version 2 is not a supported eval report version \(1\)/,
    );
  });

  it("B-19 writes exactly the keys each outcome admits and no other", () => {
    const dir = runDir();
    const path = writeEvalReport(
      dir,
      report({
        status: "INCOMPLETE",
        counts: { MATCH: 1, MISMATCH: 1, "NOT-RUN": 1, ERROR: 1 },
        callsUsed: 3,
        cases: [
          caseResult({ id: "matched" }),
          caseResult({
            id: "mismatched",
            outcome: "MISMATCH",
            actual: { verdict: "REVISE" },
            scratchDir: join(tmpdir(), "afk-eval-mismatched-x"),
          }),
          caseResult({
            id: "errored",
            outcome: "ERROR",
            actual: undefined,
            error: "role exited 7",
            scratchDir: join(tmpdir(), "afk-eval-errored-x"),
          }),
          {
            id: "skipped",
            role: "planner",
            source: "#192",
            outcome: "NOT-RUN",
            expected: { artifact: "CONTRACT" },
            callsUsed: 0,
          },
        ],
      }),
    );

    const cases = (
      JSON.parse(readFileSync(path, "utf-8")) as {
        cases: Array<Record<string, unknown>>;
      }
    ).cases;
    expect(cases.map((entry) => Object.keys(entry).sort())).toEqual([
      // MATCH: actual, no error, no scratchDir, durationMs because dispatched.
      ["actual", "callsUsed", "durationMs", "expected", "id", "outcome", "role", "source"],
      // MISMATCH: actual and the kept scratch directory.
      [
        "actual",
        "callsUsed",
        "durationMs",
        "expected",
        "id",
        "outcome",
        "role",
        "scratchDir",
        "source",
      ],
      // ERROR: error and the kept scratch directory, never `actual`.
      [
        "callsUsed",
        "durationMs",
        "error",
        "expected",
        "id",
        "outcome",
        "role",
        "scratchDir",
        "source",
      ],
      // NOT-RUN: nothing optional at all — it was never dispatched.
      ["callsUsed", "expected", "id", "outcome", "role", "source"],
    ]);
  });

  it("B-20 omits costUsd and toolCallCount rather than writing 0", () => {
    const dir = runDir();
    const path = writeEvalReport(
      dir,
      report({
        cases: [
          caseResult({ id: "unreported" }),
          caseResult({ id: "reported", costUsd: 0.42, toolCallCount: 0 }),
        ],
        counts: { MATCH: 2, MISMATCH: 0, "NOT-RUN": 0, ERROR: 0 },
        callsUsed: 2,
      }),
    );

    const document = JSON.parse(readFileSync(path, "utf-8")) as {
      costUsd?: number;
      cases: Array<Record<string, unknown>>;
    };
    // Top-level sum absent because one dispatched case reported no cost.
    expect("costUsd" in document).toBe(false);
    expect("costUsd" in (document.cases[0] ?? {})).toBe(false);
    expect("toolCallCount" in (document.cases[0] ?? {})).toBe(false);
    // A reported 0 is kept: it is a measurement, not an absence.
    expect(document.cases[1]?.costUsd).toBe(0.42);
    expect(document.cases[1]?.toolCallCount).toBe(0);
  });

  it("B-20 writes the top-level costUsd only when every dispatched case reported one", () => {
    const dir = runDir();
    const path = writeEvalReport(
      dir,
      report({ costUsd: 0.75, cases: [caseResult({ costUsd: 0.75 })] }),
    );

    expect(readEvalReport(path).costUsd).toBe(0.75);
  });
});

describe("the stdout shapes", () => {
  it("B-21 formats the summary line exactly, with no rate, ratio or percentage", () => {
    const reportPath = join(tmpdir(), "eval-20260912-100000", "report.json");
    const line = formatEvalSummary(
      report({
        status: "INCOMPLETE",
        maxCalls: 2,
        callsUsed: 2,
        counts: { MATCH: 1, MISMATCH: 2, "NOT-RUN": 3, ERROR: 4 },
      }),
      reportPath,
    );

    expect(line).toBe(
      `afk eval INCOMPLETE: MATCH 1 / MISMATCH 2 / NOT-RUN 3 / ERROR 4 — calls 2/2 — ${reportPath}`,
    );
    expect(line).not.toMatch(/%|rate|ratio|percent/i);
  });

  it("B-22 formats a per-case line as [<k>/<n>] <id> (<role>) <outcome>", () => {
    expect(
      formatCaseLine(2, 7, caseResult({ id: "planner-01", role: "planner", outcome: "MISMATCH" })),
    ).toBe("[2/7] planner-01 (planner) MISMATCH");
  });
});

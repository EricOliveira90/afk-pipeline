import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PLANNER_ESCALATION_FILENAME,
  clearPlannerEscalation,
  parsePlannerEscalation,
  plannerEscalationRequest,
  readPlannerEscalation,
} from "./planner-escalation.js";

const VALID = {
  version: 1 as const,
  criterion: "LOAD_BEARING_SILENCE" as const,
  decision: "Which wire format the status endpoint emits",
  options: ["newline-delimited JSON", "one JSON array"],
  citation: "prd.md:212",
};

function sliceDir(): string {
  return mkdtempSync(join(tmpdir(), "afk-planner-escalation-"));
}

function writeSentinel(dir: string, body: unknown): void {
  writeFileSync(
    join(dir, PLANNER_ESCALATION_FILENAME),
    typeof body === "string" ? body : JSON.stringify(body),
    "utf-8",
  );
}

describe("parsePlannerEscalation", () => {
  it.each(["SPEC_CONTRADICTION", "LOAD_BEARING_SILENCE", "DECLARED_RISK_CLASS"])(
    "accepts a cited request under %s",
    (criterion) => {
      expect(
        parsePlannerEscalation(JSON.stringify({ ...VALID, criterion })),
      ).toEqual({ ...VALID, criterion });
    },
  );

  it("trims the decision, the citation, and every option", () => {
    expect(
      parsePlannerEscalation(
        JSON.stringify({
          ...VALID,
          decision: "  a decision  ",
          citation: "  ADR 0057  ",
          options: ["  first  ", "  second  "],
        }),
      ),
    ).toEqual({
      ...VALID,
      decision: "a decision",
      citation: "ADR 0057",
      options: ["first", "second"],
    });
  });

  it.each([
    ["blank content", "", /is not valid JSON/],
    ["prose instead of JSON", "The PRD contradicts ADR 0057.\n", /is not valid JSON/],
    ["an array root", "[]", /must contain a JSON object/],
    ["a null root", "null", /must contain a JSON object/],
    [
      "a missing citation",
      { version: 1, criterion: "SPEC_CONTRADICTION", decision: "d", options: ["a", "b"] },
      /must contain exactly/,
    ],
    ["an extra key", { ...VALID, urgency: "high" }, /must contain exactly/],
    ["an unknown version", { ...VALID, version: 2 }, /must declare version 1/],
    [
      "an unknown criterion",
      { ...VALID, criterion: "JUST_UNSURE" },
      /criterion must be one of/,
    ],
    ["a blank decision", { ...VALID, decision: "  " }, /decision must be a non-blank string/],
    ["a blank citation", { ...VALID, citation: "" }, /citation must be a non-blank string/],
    [
      // One candidate is a preference, not a decision to make.
      "a single option",
      { ...VALID, options: ["only one"] },
      /at least two candidate answers/,
    ],
    ["a blank option", { ...VALID, options: ["a", " "] }, /only non-blank strings/],
    [
      // A record claiming two criteria has made no request; `JSON.parse`
      // would silently keep the last one.
      "a duplicated criterion key",
      '{"version":1,"criterion":"SPEC_CONTRADICTION","criterion":"DECLARED_RISK_CLASS",' +
        '"decision":"d","options":["a","b"],"citation":"c"}',
      /repeats the key "criterion"/,
    ],
  ])("refuses %s", (_name, body, expected) => {
    expect(() =>
      parsePlannerEscalation(typeof body === "string" ? body : JSON.stringify(body)),
    ).toThrow(expected as RegExp);
  });
});

describe("readPlannerEscalation", () => {
  it("returns null when the planner wrote no sentinel", () => {
    const dir = sliceDir();
    try {
      expect(readPlannerEscalation(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns the parsed request when the planner stopped on purpose", () => {
    const dir = sliceDir();
    try {
      writeSentinel(dir, VALID);
      expect(readPlannerEscalation(dir)).toEqual({
        kind: "escalation",
        escalation: VALID,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ["blank", ""],
    ["garbage", "not json at all"],
    ["schema-invalid", JSON.stringify({ version: 1 })],
  ])("reports a %s sentinel as malformed, never as absent", (_name, body) => {
    // Absent and malformed must not collapse: a planner that stopped on
    // purpose and wrote a broken record still stopped on purpose, and reading
    // it as "no sentinel" puts the run straight back into reporting a
    // deliberate stop as a missing acceptance-manifest.json.
    const dir = sliceDir();
    try {
      writeSentinel(dir, body);
      const record = readPlannerEscalation(dir);
      expect(record?.kind).toBe("malformed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("clearPlannerEscalation", () => {
  it("removes a sentinel so a survivor cannot be read as this round's stop", () => {
    const dir = sliceDir();
    try {
      writeSentinel(dir, VALID);
      clearPlannerEscalation(dir);
      expect(readPlannerEscalation(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is a no-op when there is nothing to clear", () => {
    const dir = sliceDir();
    try {
      expect(() => clearPlannerEscalation(dir)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("plannerEscalationRequest", () => {
  it("reports a well-formed stop as a cited design decision request", () => {
    const request = plannerEscalationRequest({
      kind: "escalation",
      escalation: VALID,
    });
    expect(request).toContain("design decision");
    expect(request).toContain("LOAD_BEARING_SILENCE");
    expect(request).toContain("prd.md:212");
    expect(request).toContain("newline-delimited JSON");
    expect(request).not.toContain("acceptance-manifest");
  });

  it("reports a malformed stop as a design decision request too", () => {
    // The headline requirement in machine-checkable form: neither kind may
    // report this event as a missing artifact.
    const request = plannerEscalationRequest({
      kind: "malformed",
      defect: "planner-escalation.md is not valid JSON",
    });
    expect(request).toContain("design decision");
    expect(request).toContain("cannot be read");
    expect(request).not.toContain("acceptance-manifest");
  });
});

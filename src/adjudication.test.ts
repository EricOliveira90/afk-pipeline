import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseAdjudication,
  type Adjudication,
  waitForAdjudication,
} from "./adjudication.js";
import type { ContractNegotiationOutcome } from "./contract-review.js";

const IMPASSE: ContractNegotiationOutcome = {
  version: 1,
  classification: "IMPASSE",
  round: 2,
  attempt: 1,
  findings: [
    {
      id: "F-01",
      severity: "BLOCKING",
      state: "CONTESTED",
      unresolved: true,
      plannerPosition: "CONTESTED",
      plannerEvidence: "planner evidence",
      evaluatorEvidence: "evaluator evidence",
    },
    {
      id: "F-OPEN",
      severity: "BLOCKING",
      state: "OPEN",
      unresolved: true,
      plannerPosition: "UNRESOLVED",
      plannerEvidence: null,
      evaluatorEvidence: "open evidence",
    },
  ],
};

describe("parseAdjudication", () => {
  const valid: Adjudication[] = [
    {
      version: 1,
      findingId: "F-01",
      winningPosition: "PLANNER",
      author: "Ada",
    },
    {
      version: 1,
      findingId: "F-01",
      winningPosition: "EVALUATOR",
      author: "Grace",
    },
    {
      version: 1,
      findingId: "F-01",
      thirdInstruction: "Keep the API, narrow the file scope.",
      author: "Lin",
    },
  ];

  it.each(valid)("accepts the exact version-1 form %#", (decision) => {
    expect(parseAdjudication(JSON.stringify(decision), IMPASSE)).toEqual(
      decision,
    );
  });

  const invalid: Array<[string, string, RegExp]> = [
    ["invalid JSON", "{", /is not valid JSON/],
    ["an array root", "[]", /must contain a JSON object/],
    [
      "a missing field",
      '{"version":1,"findingId":"F-01","winningPosition":"PLANNER"}',
      /must contain exactly version, findingId, author and one of winningPosition or thirdInstruction/,
    ],
    [
      "an extra field",
      '{"version":1,"findingId":"F-01","winningPosition":"PLANNER","author":"Ada","note":"x"}',
      /must contain exactly/,
    ],
    [
      "both decision forms",
      '{"version":1,"findingId":"F-01","winningPosition":"PLANNER","thirdInstruction":"use both","author":"Ada"}',
      /exactly one of winningPosition or thirdInstruction/,
    ],
    [
      "an unsupported version",
      '{"version":2,"findingId":"F-01","winningPosition":"PLANNER","author":"Ada"}',
      /must declare version 1/,
    ],
    [
      "an unsupported position",
      '{"version":1,"findingId":"F-01","winningPosition":"HUMAN","author":"Ada"}',
      /winningPosition must be PLANNER or EVALUATOR/,
    ],
    [
      "a blank finding id",
      '{"version":1,"findingId":"  ","winningPosition":"PLANNER","author":"Ada"}',
      /findingId must be a non-blank string/,
    ],
    [
      "a blank author",
      '{"version":1,"findingId":"F-01","winningPosition":"PLANNER","author":"  "}',
      /author must be a non-blank string/,
    ],
    [
      "a blank third instruction",
      '{"version":1,"findingId":"F-01","thirdInstruction":"  ","author":"Ada"}',
      /thirdInstruction must be a non-blank string/,
    ],
    [
      "an unknown finding",
      '{"version":1,"findingId":"F-99","winningPosition":"PLANNER","author":"Ada"}',
      /findingId F-99 is absent from the current IMPASSE/,
    ],
    [
      "a non-contested finding",
      '{"version":1,"findingId":"F-OPEN","winningPosition":"PLANNER","author":"Ada"}',
      /findingId F-OPEN is not CONTESTED in the current IMPASSE/,
    ],
  ];

  it.each(invalid)("rejects %s", (_name, raw, expected) => {
    expect(() => parseAdjudication(raw, IMPASSE)).toThrow(expected);
  });
});

describe("waitForAdjudication", () => {
  it("accepts a valid decision that appears during the bounded wait", async () => {
    const sliceDir = mkdtempSync(join(tmpdir(), "afk-adjudication-"));
    try {
      writeFileSync(
        join(sliceDir, "contract-negotiation-outcome.json"),
        JSON.stringify(IMPASSE),
        "utf-8",
      );
      let now = 0;
      let polls = 0;

      const result = await waitForAdjudication({
        sliceDir,
        waitMs: 100,
        pollMs: 10,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
          polls++;
          writeFileSync(
            join(sliceDir, "adjudication.md"),
            JSON.stringify({
              version: 1,
              findingId: "F-01",
              winningPosition: "PLANNER",
              author: "Ada",
            }),
            "utf-8",
          );
        },
      });

      expect(result).toEqual({ status: "accepted" });
      expect(polls).toBe(1);
    } finally {
      rmSync(sliceDir, { recursive: true, force: true });
    }
  });
});

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendAdjudicationDecision,
  impasseFingerprint,
  loadAdjudicationDecisionLog,
  markAdjudicationDecisionsApplied,
  parseAdjudication,
  type Adjudication,
  undecidedContestedFindingIds,
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

describe("the adjudication decision log", () => {
  const CONTESTED_PAIR: ContractNegotiationOutcome = {
    ...IMPASSE,
    findings: [
      IMPASSE.findings[0]!,
      { ...IMPASSE.findings[0]!, id: "F-02" },
    ],
  };
  const decisionFor = (findingId: string) =>
    JSON.stringify({
      version: 1,
      findingId,
      winningPosition: "PLANNER",
      author: "Ada",
    });
  const withSliceDir = (body: (sliceDir: string) => void) => {
    const sliceDir = mkdtempSync(join(tmpdir(), "afk-adjudication-"));
    try {
      body(sliceDir);
    } finally {
      rmSync(sliceDir, { recursive: true, force: true });
    }
  };

  it("reports the contested findings a log has no decision for", () => {
    withSliceDir((sliceDir) => {
      const empty = loadAdjudicationDecisionLog(sliceDir, CONTESTED_PAIR);
      expect(empty.discarded).toBeNull();
      expect(undecidedContestedFindingIds(CONTESTED_PAIR, empty.log)).toEqual([
        "F-01",
        "F-02",
      ]);

      const raw = decisionFor("F-01");
      const one = appendAdjudicationDecision(sliceDir, empty.log, {
        raw,
        decision: parseAdjudication(raw, CONTESTED_PAIR),
      });
      expect(undecidedContestedFindingIds(CONTESTED_PAIR, one)).toEqual([
        "F-02",
      ]);

      const reloaded = loadAdjudicationDecisionLog(sliceDir, CONTESTED_PAIR);
      expect(reloaded.discarded).toBeNull();
      expect(reloaded.log).toEqual(one);
      expect(reloaded.log.applied).toBe(false);
      expect(
        loadAdjudicationDecisionLog(
          sliceDir,
          CONTESTED_PAIR,
        ).log.applied,
      ).toBe(false);
      markAdjudicationDecisionsApplied(sliceDir, reloaded.log);
      expect(
        loadAdjudicationDecisionLog(sliceDir, CONTESTED_PAIR).log.applied,
      ).toBe(true);
    });
  });

  const rejected: Array<[string, string, RegExp]> = [
    ["a malformed log", "{", /Unexpected|JSON/],
    [
      "an unsupported version",
      '{"version":2,"impasse":"x","decisions":[],"applied":false}',
      /must declare version 1/,
    ],
    [
      "a log recorded against another impasse",
      '{"version":1,"impasse":"stale","decisions":[],"applied":false}',
      /recorded against a different IMPASSE/,
    ],
  ];

  it.each(rejected)("discards %s", (_name, contents, expected) => {
    withSliceDir((sliceDir) => {
      writeFileSync(
        join(sliceDir, "adjudication-decisions.json"),
        contents,
        "utf-8",
      );
      const loaded = loadAdjudicationDecisionLog(sliceDir, CONTESTED_PAIR);
      expect(loaded.discarded).toMatch(expected);
      expect(loaded.log.decisions).toEqual([]);
      expect(loaded.log.applied).toBe(false);
    });
  });

  it("discards a log whose recorded decision does not parse", () => {
    withSliceDir((sliceDir) => {
      // A log carrying the right fingerprint is still re-validated
      // decision by decision: the log is evidence, never authority.
      writeFileSync(
        join(sliceDir, "adjudication-decisions.json"),
        JSON.stringify({
          version: 1,
          impasse: impasseFingerprint(CONTESTED_PAIR),
          applied: true,
          decisions: [{ raw: decisionFor("F-99") }],
        }),
        "utf-8",
      );
      const loaded = loadAdjudicationDecisionLog(sliceDir, CONTESTED_PAIR);
      expect(loaded.discarded).toMatch(/F-99 is absent from the current IMPASSE/);
      expect(loaded.log.decisions).toEqual([]);
      expect(loaded.log.applied).toBe(false);
    });
  });

  it("refuses a duplicated decision recorded in the log", () => {
    withSliceDir((sliceDir) => {
      writeFileSync(
        join(sliceDir, "adjudication-decisions.json"),
        JSON.stringify({
          version: 1,
          impasse: impasseFingerprint(CONTESTED_PAIR),
          applied: false,
          decisions: [
            { raw: decisionFor("F-01") },
            { raw: decisionFor("F-01") },
          ],
        }),
        "utf-8",
      );
      expect(
        loadAdjudicationDecisionLog(sliceDir, CONTESTED_PAIR).discarded,
      ).toMatch(/F-01 was already adjudicated/);
    });
  });

  it("refuses a second decision for an already-decided finding", () => {
    expect(() =>
      parseAdjudication(decisionFor("F-01"), CONTESTED_PAIR, undefined, [
        "F-01",
      ]),
    ).toThrow(/F-01 was already adjudicated in the current IMPASSE/);
  });
});

describe("waitForAdjudication", () => {
  it("wakes from its polling delay when cancellation occurs", async () => {
    const sliceDir = mkdtempSync(join(tmpdir(), "afk-adjudication-"));
    try {
      writeFileSync(
        join(sliceDir, "contract-negotiation-outcome.json"),
        JSON.stringify(IMPASSE),
        "utf-8",
      );
      const controller = new AbortController();
      const waiting = waitForAdjudication({
        sliceDir,
        waitMs: 10_000,
        pollMs: 10_000,
        signal: controller.signal,
      });

      controller.abort();

      await expect(waiting).resolves.toEqual({ status: "cancelled" });
    } finally {
      rmSync(sliceDir, { recursive: true, force: true });
    }
  });

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

  it("keeps waiting when the decision names an already-decided finding", async () => {
    const sliceDir = mkdtempSync(join(tmpdir(), "afk-adjudication-"));
    try {
      const impasse: ContractNegotiationOutcome = {
        ...IMPASSE,
        findings: [IMPASSE.findings[0]!, { ...IMPASSE.findings[0]!, id: "F-02" }],
      };
      writeFileSync(
        join(sliceDir, "contract-negotiation-outcome.json"),
        JSON.stringify(impasse),
        "utf-8",
      );
      const raw =
        '{"version":1,"findingId":"F-01","winningPosition":"PLANNER","author":"Ada"}';
      writeFileSync(
        join(sliceDir, "adjudication-decisions.json"),
        JSON.stringify({
          version: 1,
          impasse: impasseFingerprint(impasse),
          applied: false,
          decisions: [{ raw }],
        }),
        "utf-8",
      );
      writeFileSync(join(sliceDir, "adjudication.md"), raw, "utf-8");

      const result = await waitForAdjudication({
        sliceDir,
        waitMs: 0,
        pollMs: 10,
      });

      expect(result).toMatchObject({
        status: "expired",
        defect: expect.stringContaining("F-01 was already adjudicated"),
      });
    } finally {
      rmSync(sliceDir, { recursive: true, force: true });
    }
  });

  it("expires with the latest validation defect and retains the raw file", async () => {
    const sliceDir = mkdtempSync(join(tmpdir(), "afk-adjudication-"));
    try {
      writeFileSync(
        join(sliceDir, "contract-negotiation-outcome.json"),
        JSON.stringify(IMPASSE),
        "utf-8",
      );
      const decisionPath = join(sliceDir, "adjudication.md");
      const raw = '{"version":1,"findingId":"F-99"}\r\n';
      writeFileSync(decisionPath, raw, "utf-8");

      const result = await waitForAdjudication({
        sliceDir,
        waitMs: 0,
        pollMs: 10,
      });

      expect(result).toMatchObject({
        status: "expired",
        defect: expect.stringContaining("must contain exactly"),
      });
      expect(readFileSync(decisionPath, "utf-8")).toBe(raw);
    } finally {
      rmSync(sliceDir, { recursive: true, force: true });
    }
  });
});

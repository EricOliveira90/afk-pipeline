import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  adjudicatedLockIsProven,
  appendAdjudicationDecision,
  decisionSetFingerprint,
  impasseFingerprint,
  loadAdjudicationDecisionLog,
  markAdjudicationDecisionsApplied,
  parseAdjudication,
  pendingLockWitnessProves,
  reconcileDiscardedDecisionLog,
  recordPendingLock,
  type Adjudication,
  undecidedContestedFindingIds,
  unresolvedBlockingFindingIds,
  waitForAdjudication,
} from "./adjudication.js";
import type { ContractLockProvenance } from "./artifacts.js";
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

/** IMPASSE with one field of its first (contested) finding overridden. */
function mutateFirstFinding(
  patch: Partial<ContractNegotiationOutcome["findings"][number]>,
): ContractNegotiationOutcome {
  return {
    ...IMPASSE,
    findings: [
      { ...IMPASSE.findings[0]!, ...patch },
      IMPASSE.findings[1]!,
    ],
  };
}

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

/**
 * ADR 0054 Consequences / ADR 0055 Seam 1 §4-5, architect blocker 1: the
 * fingerprint is the identity of the dispute a human decided, so it must
 * bind the two positions and their evidence, not merely id/severity/state.
 * Two impasses that share IDs and state but hold different positions or
 * evidence are different questions; a decision log or a stamped lock made
 * for one must not validate against the other.
 */
describe("impasseFingerprint binds the full question", () => {
  const decisionFor = (findingId: string) =>
    JSON.stringify({
      version: 1,
      findingId,
      winningPosition: "PLANNER",
      author: "Ada",
    });
  const withSliceDir = (body: (sliceDir: string) => void) => {
    const sliceDir = mkdtempSync(join(tmpdir(), "afk-fingerprint-"));
    try {
      body(sliceDir);
    } finally {
      rmSync(sliceDir, { recursive: true, force: true });
    }
  };

  // Each variant shares F-01's id, severity, and state with IMPASSE but
  // changes one question-bearing field. The pre-fix fingerprint collided
  // on all of these.
  const variants: Array<[string, ContractNegotiationOutcome]> = [
    [
      "the planner's position",
      mutateFirstFinding({ plannerPosition: "CONDITION_MET" }),
    ],
    [
      "the planner's evidence",
      mutateFirstFinding({ plannerEvidence: "a different argument" }),
    ],
    [
      "the evaluator's evidence",
      mutateFirstFinding({ evaluatorEvidence: "a different objection" }),
    ],
    ["the unresolved flag", mutateFirstFinding({ unresolved: false })],
  ];

  it.each(variants)(
    "produces a different fingerprint when %s changes",
    (_name, variant) => {
      expect(impasseFingerprint(variant)).not.toBe(impasseFingerprint(IMPASSE));
    },
  );

  it.each(variants)(
    "discards a decision log recorded against a dispute that differed in %s",
    (_name, variant) => {
      withSliceDir((sliceDir) => {
        // A log recorded against the original impasse, complete with the
        // matching fingerprint on disk.
        writeFileSync(
          join(sliceDir, "adjudication-decisions.json"),
          JSON.stringify({
            version: 1,
            impasse: impasseFingerprint(IMPASSE),
            applied: true,
            decisions: [{ raw: decisionFor("F-01") }],
          }),
          "utf-8",
        );
        // Loaded against the new dispute, it is stale and discarded.
        const loaded = loadAdjudicationDecisionLog(sliceDir, variant);
        expect(loaded.discarded).toMatch(/recorded against a different IMPASSE/);
        expect(loaded.log.decisions).toEqual([]);
        expect(loaded.log.applied).toBe(false);
      });
    },
  );

  it.each(variants)(
    "reopens a lock stamped for a dispute that differed in %s",
    (_name, variant) => {
      // A stamped lock can no longer self-certify against the new dispute:
      // the stamp binds the old fingerprint, which the new outcome does not
      // match, so the contract is reopened rather than inherited.
      expect(
        reconcileDiscardedDecisionLog({
          locked: true,
          provenance: {
            kind: "impasse-adjudication",
            impasse: impasseFingerprint(IMPASSE),
          },
          outcome: variant,
        }),
      ).toEqual({
        action: "reopen",
        because: "the lock is stamped with a different IMPASSE",
      });
    },
  );
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

  it("reports the blocking findings a log has no decision for", () => {
    withSliceDir((sliceDir) => {
      const empty = loadAdjudicationDecisionLog(sliceDir, CONTESTED_PAIR);
      expect(empty.discarded).toBeNull();
      expect(unresolvedBlockingFindingIds(CONTESTED_PAIR, empty.log)).toEqual([
        "F-01",
        "F-02",
      ]);

      const raw = decisionFor("F-01");
      const one = appendAdjudicationDecision(sliceDir, empty.log, {
        raw,
        decision: parseAdjudication(raw, CONTESTED_PAIR),
      });
      expect(unresolvedBlockingFindingIds(CONTESTED_PAIR, one)).toEqual([
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

  /**
   * ADR 0055 §2: the completion predicate spans every unresolved BLOCKING
   * finding, contested and open alike. Under §1 an impasse never contains
   * an OPEN blocker, so this shape only reaches the lock path when the
   * classifier and the predicate have drifted apart — which is exactly
   * what A1 was. The predicate is the last line of defence: the lock is
   * refused and the disagreement is visible, rather than the contract
   * locking over an unresolved blocker.
   */
  it("refuses to call a mixed exhaustion complete when only the contest is decided", () => {
    withSliceDir((sliceDir) => {
      const empty = loadAdjudicationDecisionLog(sliceDir, IMPASSE);
      expect(unresolvedBlockingFindingIds(IMPASSE, empty.log)).toEqual([
        "F-01",
        "F-OPEN",
      ]);

      const raw = decisionFor("F-01");
      const decided = appendAdjudicationDecision(sliceDir, empty.log, {
        raw,
        decision: parseAdjudication(raw, IMPASSE),
      });

      // The contested subset is settled — what the courier's park message
      // renders — yet the exhaustion is not complete.
      expect(undecidedContestedFindingIds(IMPASSE, decided)).toEqual([]);
      expect(unresolvedBlockingFindingIds(IMPASSE, decided)).toEqual([
        "F-OPEN",
      ]);
      // And no decision can ever settle it: an OPEN finding is not
      // adjudicable, so the park would never unlock.
      expect(() => parseAdjudication(decisionFor("F-OPEN"), IMPASSE)).toThrow(
        /F-OPEN is not CONTESTED/,
      );
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

/**
 * ADR 0055 Seam 1 decisions 4–5. Two questions, asked of the same pair of
 * artifacts, that used to be answered by `readContractStatus === "LOCKED"`
 * alone — which is what let a stale lock be inherited (A2):
 *
 * - The log had to be discarded. Was the lock beside it the one those
 *   decisions produced? Answered by the lock's provenance stamp.
 * - The log is valid and complete but unapplied, over a `LOCKED` contract.
 *   Is that the crash window between the lock and the applied mark?
 *   Answered by the log's own pending-lock witness.
 */
describe("reconciling a lock against the decision log", () => {
  const OUTCOME: ContractNegotiationOutcome = {
    ...IMPASSE,
    findings: [IMPASSE.findings[0]!, { ...IMPASSE.findings[0]!, id: "F-02" }],
  };
  const OTHER: ContractNegotiationOutcome = { ...OUTCOME, round: 3 };
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
  /** A log with `ids` decided, written to disk exactly as the apply path leaves it. */
  const logWith = (sliceDir: string, ...ids: string[]) => {
    let log = loadAdjudicationDecisionLog(sliceDir, OUTCOME).log;
    for (const id of ids) {
      const raw = decisionFor(id);
      log = appendAdjudicationDecision(sliceDir, log, {
        raw,
        decision: parseAdjudication(raw, OUTCOME, undefined, ids.slice(0, ids.indexOf(id))),
      });
    }
    return log;
  };

  it("proves the crash window with a witness over its own decision set", () => {
    withSliceDir((sliceDir) => {
      const complete = logWith(sliceDir, "F-01", "F-02");
      expect(pendingLockWitnessProves(complete)).toBe(false);

      const witnessed = recordPendingLock(sliceDir, complete);
      expect(witnessed.pendingLock).toEqual({
        impasse: impasseFingerprint(OUTCOME),
        decisions: decisionSetFingerprint(complete.decisions),
      });
      // The witness survives a reload — the loader validates it like
      // everything else rather than dropping the field.
      const reloaded = loadAdjudicationDecisionLog(sliceDir, OUTCOME);
      expect(reloaded.discarded).toBeNull();
      expect(pendingLockWitnessProves(reloaded.log)).toBe(true);

      // The applied mark is the stronger proof, so it clears the witness.
      const applied = markAdjudicationDecisionsApplied(sliceDir, reloaded.log);
      expect(applied.pendingLock).toBeUndefined();
      expect(
        readFileSync(join(sliceDir, "adjudication-decisions.json"), "utf-8"),
      ).not.toContain("pendingLock");
      expect(pendingLockWitnessProves(applied)).toBe(false);
    });
  });

  it("does not let a witness prove a decision set it was not written for", () => {
    withSliceDir((sliceDir) => {
      const partial = recordPendingLock(sliceDir, logWith(sliceDir, "F-01"));
      const raw = decisionFor("F-02");
      const grown = appendAdjudicationDecision(sliceDir, partial, {
        raw,
        decision: parseAdjudication(raw, OUTCOME, undefined, ["F-01"]),
      });

      expect(pendingLockWitnessProves(grown)).toBe(false);
      expect(adjudicatedLockIsProven({ locked: true, log: grown })).toBe(false);
    });
  });

  const badWitnesses: Array<[string, unknown, RegExp]> = [
    ["a non-object witness", "yes", /must be an object when present/],
    [
      "a witness missing a field",
      { impasse: "x" },
      /must contain exactly decisions and impasse/,
    ],
    [
      "a witness for another impasse",
      { decisions: "d", impasse: "stale" },
      /recorded against a different IMPASSE/,
    ],
  ];

  it.each(badWitnesses)(
    "discards the whole log for %s",
    (_name, pendingLock, expected) => {
      withSliceDir((sliceDir) => {
        writeFileSync(
          join(sliceDir, "adjudication-decisions.json"),
          JSON.stringify({
            version: 1,
            impasse: impasseFingerprint(OUTCOME),
            applied: false,
            decisions: [{ raw: decisionFor("F-01") }],
            pendingLock,
          }),
          "utf-8",
        );
        // Fail-closed: the witness is the one field a lock can be inherited
        // on, so a malformed one costs the log, not just the field.
        const loaded = loadAdjudicationDecisionLog(sliceDir, OUTCOME);
        expect(loaded.discarded).toMatch(expected);
        expect(loaded.log.decisions).toEqual([]);
      });
    },
  );

  it("returns LOCKED without re-applying only on proof", () => {
    withSliceDir((sliceDir) => {
      const complete = logWith(sliceDir, "F-01", "F-02");
      const witnessed = recordPendingLock(sliceDir, complete);
      const applied = { ...complete, applied: true };

      // The crash window: LOCKED, complete, unapplied, witnessed.
      expect(adjudicatedLockIsProven({ locked: true, log: witnessed })).toBe(
        true,
      );
      expect(adjudicatedLockIsProven({ locked: true, log: applied })).toBe(true);
      // A bare LOCKED beside an unproven log is A2: no shortcut.
      expect(adjudicatedLockIsProven({ locked: true, log: complete })).toBe(
        false,
      );
      // And nothing is "already applied" while no lock is on disk.
      expect(adjudicatedLockIsProven({ locked: false, log: applied })).toBe(
        false,
      );
    });
  });

  it("keeps a legitimate lock when the discarded log's own stamp certifies it", () => {
    // Scenario Y: the human's adjudication completed and locked; only its
    // receipt got corrupted. Blanket reopening would silently invalidate
    // completed human work every time a file got mangled.
    expect(
      reconcileDiscardedDecisionLog({
        locked: true,
        provenance: {
          kind: "impasse-adjudication",
          impasse: impasseFingerprint(OUTCOME),
        },
        outcome: OUTCOME,
      }),
    ).toEqual({
      action: "lock-stands",
      because: "the lock is stamped with the current IMPASSE",
    });
  });

  const reopens: Array<[string, ContractLockProvenance | null, string]> = [
    ["an unstamped lock", null, "the lock carries no provenance stamp"],
    [
      "an ordinary negotiation's lock",
      { kind: "negotiation", round: 2 },
      "the lock was produced by negotiation round 2",
    ],
    [
      "a focused revision's lock",
      { kind: "focused-scope-revision", round: 3 },
      "the lock was produced by focused-scope-revision round 3",
    ],
    [
      "another impasse's lock",
      { kind: "impasse-adjudication", impasse: impasseFingerprint(OTHER) },
      "the lock is stamped with a different IMPASSE",
    ],
  ];

  it.each(reopens)("reopens %s", (_name, provenance, because) => {
    expect(
      reconcileDiscardedDecisionLog({ locked: true, provenance, outcome: OUTCOME }),
    ).toEqual({ action: "reopen", because });
  });

  it("has nothing to reconcile when no lock is claimed", () => {
    expect(
      reconcileDiscardedDecisionLog({
        locked: false,
        provenance: null,
        outcome: OUTCOME,
      }),
    ).toEqual({ action: "none" });
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

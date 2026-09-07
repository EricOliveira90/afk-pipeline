import { describe, expect, it } from "vitest";
import {
  foldGuardianLedger,
  guardianFindingFingerprint,
  unresolvedBlockingFindings,
  unresolvedNoteFindings,
} from "./guardian-finding-ledger.js";
import type {
  PersistedGuardianFinding,
  PersistedGuardianReviewRecord,
  PersistedGuardianReviewRound,
} from "./run-state.js";

function finding(
  overrides: Partial<PersistedGuardianFinding> & { stableId: string },
): PersistedGuardianFinding {
  return {
    currentId: overrides.stableId,
    title: `${overrides.stableId} title`,
    class: "INTEGRITY",
    clearCondition: `Clear ${overrides.stableId}.`,
    disposition: "OPEN",
    reachableTrigger: "A normal retry reads the invalid durable state.",
    introducedByReviewedDiff: true,
    ...overrides,
  };
}

function record(
  overrides: Partial<PersistedGuardianReviewRecord> = {},
): PersistedGuardianReviewRecord {
  return {
    source: "INVOKED",
    outcome: "SHIP",
    findings: [],
    findingsOriginRound: 1,
    ...overrides,
  };
}

function round(
  number: number,
  architect: PersistedGuardianReviewRecord,
  pm: PersistedGuardianReviewRecord = record({
    findingsOriginRound: number,
  }),
): PersistedGuardianReviewRound {
  return {
    round: number,
    reviewedHeadSha: `reviewed-${number}`,
    headSha: `head-${number}`,
    architect,
    pm,
  };
}

describe("guardianFindingFingerprint", () => {
  it("normalizes case and whitespace so a reworded repeat still matches", () => {
    expect(
      guardianFindingFingerprint({
        class: "INTEGRITY",
        clearCondition: "The  round\npersists  first.",
      }),
    ).toBe(
      guardianFindingFingerprint({
        class: " integrity ",
        clearCondition: "the round persists first.",
      }),
    );
  });

  it("separates a different class from a different clear condition", () => {
    expect(
      guardianFindingFingerprint({ class: "A", clearCondition: "B" }),
    ).not.toBe(guardianFindingFingerprint({ class: "AB", clearCondition: "" }));
  });
});

describe("foldGuardianLedger", () => {
  it("classifies a blocker under FIX-BEFORE-SHIP and a note under ACCEPT-WITH-NOTES", () => {
    const folded = foldGuardianLedger([
      round(
        1,
        record({
          outcome: "FIX-BEFORE-SHIP",
          findingsOriginRound: 1,
          findings: [
            finding({ stableId: "A-01" }),
            finding({
              stableId: "A-02",
              // No reachable trigger, so #172's floor makes it a note even
              // inside a blocking round.
              reachableTrigger: null,
            }),
          ],
        }),
        record({
          outcome: "ACCEPT-WITH-NOTES",
          findingsOriginRound: 1,
          findings: [finding({ stableId: "P-01", class: "PRODUCT" })],
        }),
      ),
    ]);

    expect(
      folded.map((entry) => [
        entry.guardian,
        entry.finding.stableId,
        entry.blocking,
      ]),
    ).toEqual([
      ["architect", "A-01", true],
      ["architect", "A-02", false],
      ["pm", "P-01", false],
    ]);
  });

  it("makes every PM finding a blocker when the PM blocks, its verdict being the only signal", () => {
    const folded = foldGuardianLedger([
      round(
        1,
        record({ findingsOriginRound: 1 }),
        record({
          outcome: "FIX-BEFORE-SHIP",
          findingsOriginRound: 1,
          findings: [
            finding({
              stableId: "P-01",
              class: "PRODUCT",
              reachableTrigger: null,
              introducedByReviewedDiff: null,
            }),
          ],
        }),
      ),
    ]);

    expect(folded).toEqual([
      expect.objectContaining({ guardian: "pm", blocking: true }),
    ]);
  });

  it("keeps a later round's disposition and drops the blocker once it resolves", () => {
    const rounds = [
      round(
        1,
        record({
          outcome: "FIX-BEFORE-SHIP",
          findingsOriginRound: 1,
          findings: [finding({ stableId: "A-01" })],
        }),
      ),
      round(
        2,
        record({
          outcome: "ACCEPT-WITH-NOTES",
          findingsOriginRound: 2,
          findings: [finding({ stableId: "A-01", disposition: "RESOLVED" })],
        }),
      ),
    ];
    const folded = foldGuardianLedger(rounds);

    expect(folded).toHaveLength(1);
    expect(folded[0]).toMatchObject({ round: 2, blocking: false });
    expect(unresolvedBlockingFindings(folded)).toEqual([]);
    expect(unresolvedNoteFindings(folded)).toEqual([]);
  });

  it("keeps a later-round repeat blocking through its prior lineage", () => {
    // Round 2's repeat is neither INTEGRITY-new nor attributed to the fix diff,
    // but prior lineage keeps its authority (#172 / ADR 0057 decision 3).
    const folded = foldGuardianLedger([
      round(
        1,
        record({
          outcome: "FIX-BEFORE-SHIP",
          findingsOriginRound: 1,
          findings: [finding({ stableId: "A-01" })],
        }),
      ),
      round(
        2,
        record({
          outcome: "FIX-BEFORE-SHIP",
          findingsOriginRound: 2,
          findings: [
            finding({
              stableId: "A-01",
              disposition: "REPEATED",
              class: "CONVENTION",
              introducedByReviewedDiff: false,
            }),
          ],
        }),
      ),
    ]);

    expect(unresolvedBlockingFindings(folded)).toEqual([
      expect.objectContaining({ round: 2, blocking: true }),
    ]);
  });

  it("demotes a later-new finding that is neither integrity nor data-loss", () => {
    const folded = foldGuardianLedger([
      round(1, record({ findingsOriginRound: 1 })),
      round(
        2,
        record({
          outcome: "FIX-BEFORE-SHIP",
          findingsOriginRound: 2,
          findings: [
            finding({ stableId: "A-09", class: "CONVENTION" }),
            finding({ stableId: "A-10", class: "DATA_LOSS" }),
          ],
        }),
      ),
    ]);

    expect(
      folded.map((entry) => [entry.finding.stableId, entry.blocking]),
    ).toEqual([
      ["A-09", false],
      ["A-10", true],
    ]);
  });

  it("keeps an omitted open finding at its last recorded entry", () => {
    const folded = foldGuardianLedger([
      round(
        1,
        record({
          outcome: "FIX-BEFORE-SHIP",
          findingsOriginRound: 1,
          findings: [
            finding({ stableId: "A-01" }),
            finding({ stableId: "A-02" }),
          ],
        }),
      ),
      round(
        2,
        record({
          outcome: "FIX-BEFORE-SHIP",
          findingsOriginRound: 2,
          findings: [finding({ stableId: "A-01", disposition: "REPEATED" })],
        }),
      ),
    ]);

    expect(unresolvedBlockingFindings(folded).map((e) => [
      e.finding.stableId,
      e.round,
    ])).toEqual([
      ["A-01", 2],
      ["A-02", 1],
    ]);
  });

  it("ignores cache-sourced records but counts them as prior lineage", () => {
    const carried = finding({ stableId: "A-01", disposition: "OPEN" });
    const folded = foldGuardianLedger([
      round(
        1,
        record({
          outcome: "ACCEPT-WITH-NOTES",
          findingsOriginRound: 1,
          findings: [carried],
        }),
      ),
      round(
        2,
        record({
          source: "CACHE",
          outcome: "ACCEPT-WITH-NOTES",
          findingsOriginRound: 1,
          findings: [carried],
        }),
      ),
      round(
        3,
        record({
          outcome: "FIX-BEFORE-SHIP",
          findingsOriginRound: 3,
          findings: [
            finding({
              stableId: "A-01",
              disposition: "REPEATED",
              class: "CONVENTION",
              introducedByReviewedDiff: false,
            }),
          ],
        }),
      ),
    ]);

    // The cached round never becomes the entry's round, and the identity is
    // still known to round 3, so its repeat keeps prior-lineage authority.
    expect(folded).toEqual([
      expect.objectContaining({ round: 3, blocking: true }),
    ]);
  });
});

describe("unresolvedNoteFindings", () => {
  it("returns every non-blocking finding no round has cleared", () => {
    const folded = foldGuardianLedger([
      round(
        1,
        record({
          outcome: "ACCEPT-WITH-NOTES",
          findingsOriginRound: 1,
          findings: [
            finding({ stableId: "A-01" }),
            finding({ stableId: "A-02", disposition: "RESOLVED" }),
          ],
        }),
        record({
          outcome: "ACCEPT-WITH-NOTES",
          findingsOriginRound: 1,
          findings: [finding({ stableId: "P-01", class: "PRODUCT" })],
        }),
      ),
    ]);

    expect(
      unresolvedNoteFindings(folded).map((e) => e.finding.stableId),
    ).toEqual(["A-01", "P-01"]);
  });
});

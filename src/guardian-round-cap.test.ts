import { describe, expect, it } from "vitest";
import type { ReviewOutcome } from "./artifacts.js";
import {
  countUnfavorableGuardianRounds,
  decideGuardianRoundCapExit,
  DEFAULT_GUARDIAN_ROUND_CAP,
} from "./guardian-round-cap.js";
import type {
  PersistedGuardianReviewRecord,
  PersistedGuardianReviewRound,
} from "./guardian-round-records.js";

function record(
  outcome: ReviewOutcome,
  round: number,
): PersistedGuardianReviewRecord {
  const blank =
    outcome === "SHIP" ||
    outcome === "UNPARSEABLE" ||
    outcome === "NEVER_RAN" ||
    outcome === "DIED_MID_RUN";
  return {
    source: "INVOKED",
    outcome,
    findings: blank
      ? []
      : [
          {
            stableId: `S-${round}`,
            currentId: `S-${round}`,
            title: `finding ${round}`,
            class: "INTEGRITY",
            clearCondition: `Clear finding ${round}.`,
            disposition: "OPEN",
            reachableTrigger: "A normal retry reads the invalid state.",
            introducedByReviewedDiff: true,
          },
        ],
    findingsOriginRound: round,
  };
}

function rounds(
  ...verdicts: Array<[ReviewOutcome, ReviewOutcome]>
): PersistedGuardianReviewRound[] {
  return verdicts.map(([architect, pm], index) => ({
    round: index + 1,
    reviewedHeadSha: `reviewed-${index + 1}`,
    headSha: `head-${index + 1}`,
    architect: record(architect, index + 1),
    pm: record(pm, index + 1),
  }));
}

describe("countUnfavorableGuardianRounds", () => {
  it("counts a round once when either guardian blocks, and once when both do", () => {
    expect(
      countUnfavorableGuardianRounds(
        rounds(
          ["FIX-BEFORE-SHIP", "SHIP"],
          ["SHIP", "FIX-BEFORE-SHIP"],
          ["FIX-BEFORE-SHIP", "FIX-BEFORE-SHIP"],
        ),
      ),
    ).toBe(3);
  });

  it("does not count a round whose only unfavorable signal is operational", () => {
    expect(
      countUnfavorableGuardianRounds(
        rounds(
          ["UNPARSEABLE", "SHIP"],
          ["NEVER_RAN", "ACCEPT-WITH-NOTES"],
          ["DIED_MID_RUN", "SHIP"],
          ["ACCEPT-WITH-NOTES", "SHIP"],
        ),
      ),
    ).toBe(0);
  });

  it("counts only the blocking rounds in a mixed ledger", () => {
    expect(
      countUnfavorableGuardianRounds(
        rounds(
          ["FIX-BEFORE-SHIP", "SHIP"],
          ["DIED_MID_RUN", "SHIP"],
          ["FIX-BEFORE-SHIP", "SHIP"],
        ),
      ),
    ).toBe(2);
  });

  it("reads an empty ledger as zero", () => {
    expect(countUnfavorableGuardianRounds([])).toBe(0);
  });
});

describe("decideGuardianRoundCapExit", () => {
  const blocking = rounds(
    ["FIX-BEFORE-SHIP", "SHIP"],
    ["FIX-BEFORE-SHIP", "SHIP"],
    ["FIX-BEFORE-SHIP", "SHIP"],
  );

  it("defaults to ADR 0014's implementation cap of 3", () => {
    expect(DEFAULT_GUARDIAN_ROUND_CAP).toBe(3);
  });

  it("takes the exit on the round that reaches the cap", () => {
    expect(
      decideGuardianRoundCapExit({
        rounds: blocking,
        architect: "FIX-BEFORE-SHIP",
        pm: "SHIP",
        prWouldOpen: false,
        cap: 3,
      }),
    ).toEqual({ capReached: true, cap: 3, unfavorableRounds: 3 });
  });

  it("holds the exit one round short of the cap", () => {
    const decision = decideGuardianRoundCapExit({
      rounds: blocking.slice(0, 2),
      architect: "FIX-BEFORE-SHIP",
      pm: "SHIP",
      prWouldOpen: false,
      cap: 3,
    });
    expect(decision.capReached).toBe(false);
    expect(decision.reason).toBe("2 unfavorable round(s) of 3");
  });

  it("never fires when the draft PR opens on its own — including under override", () => {
    const decision = decideGuardianRoundCapExit({
      rounds: blocking,
      architect: "FIX-BEFORE-SHIP",
      pm: "SHIP",
      prWouldOpen: true,
      cap: 3,
    });
    expect(decision.capReached).toBe(false);
    expect(decision.reason).toBe("the draft PR opens without a cap exit");
  });

  it("refuses the exit when either outcome is operational, cap or no cap", () => {
    for (const operational of [
      "UNPARSEABLE",
      "NEVER_RAN",
      "DIED_MID_RUN",
    ] as const) {
      for (const [architect, pm] of [
        [operational, "FIX-BEFORE-SHIP"],
        ["FIX-BEFORE-SHIP", operational],
      ] as Array<[ReviewOutcome, ReviewOutcome]>) {
        const decision = decideGuardianRoundCapExit({
          rounds: blocking,
          architect,
          pm,
          prWouldOpen: false,
          cap: 3,
        });
        expect(decision.capReached).toBe(false);
        expect(decision.reason).toContain("operational outcome");
      }
    }
  });

  it("refuses the exit when this round carries no block of its own", () => {
    // Three earlier rounds spent the cap, but this round's only unfavorable
    // signal is that a verdict never arrived — there is no disagreement to
    // acknowledge, so nothing to exit on.
    const decision = decideGuardianRoundCapExit({
      rounds: blocking,
      architect: "ACCEPT-WITH-NOTES",
      pm: "ACCEPT-WITH-NOTES",
      prWouldOpen: false,
      cap: 3,
    });
    expect(decision.capReached).toBe(false);
    expect(decision.reason).toBe("neither guardian blocked this round");
  });

  it("treats cap 0 as the cap disabled", () => {
    const decision = decideGuardianRoundCapExit({
      rounds: blocking,
      architect: "FIX-BEFORE-SHIP",
      pm: "FIX-BEFORE-SHIP",
      prWouldOpen: false,
      cap: 0,
    });
    expect(decision.capReached).toBe(false);
    expect(decision.reason).toBe("the round cap is disabled");
  });

  it("fires at cap 1 on the first blocking round", () => {
    expect(
      decideGuardianRoundCapExit({
        rounds: rounds(["FIX-BEFORE-SHIP", "FIX-BEFORE-SHIP"]),
        architect: "FIX-BEFORE-SHIP",
        pm: "FIX-BEFORE-SHIP",
        prWouldOpen: false,
        cap: 1,
      }).capReached,
    ).toBe(true);
  });

  it("does not let operational rounds carry a run to the cap", () => {
    // Two real blocks plus two dead rounds is two unfavorable rounds, not four.
    const decision = decideGuardianRoundCapExit({
      rounds: rounds(
        ["FIX-BEFORE-SHIP", "SHIP"],
        ["DIED_MID_RUN", "SHIP"],
        ["NEVER_RAN", "SHIP"],
        ["FIX-BEFORE-SHIP", "SHIP"],
      ),
      architect: "FIX-BEFORE-SHIP",
      pm: "SHIP",
      prWouldOpen: false,
      cap: 3,
    });
    expect(decision.unfavorableRounds).toBe(2);
    expect(decision.capReached).toBe(false);
  });
});

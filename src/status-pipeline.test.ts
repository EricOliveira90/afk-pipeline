import { describe, expect, it } from "vitest";
import type { Slice } from "./issues-parser.js";
import type { RunSnapshot } from "./run-snapshot.js";
import type { FutureSection, ManifestReadResult } from "./status-future.js";
import { buildPipelineSection } from "./status-pipeline.js";
import type { PresentSection } from "./status-present.js";

const MANIFEST: Slice[] = [
  {
    number: "01",
    ghIssue: "101",
    title: "First slice",
    type: "AFK",
    blockedBy: [],
    userStories: "",
  },
  {
    number: "02",
    ghIssue: "102",
    title: "Serial successor",
    type: "AFK",
    blockedBy: [],
    userStories: "",
  },
  {
    number: "03",
    ghIssue: "103",
    title: "Dependent slice",
    type: "AFK",
    blockedBy: ["101"],
    userStories: "",
  },
];

function snapshotFixture(): RunSnapshot {
  return {
    run: {
      slug: "demo-stub",
      provider: "stub",
      startedTs: "2026-08-22T01:00:00.100Z",
      contractRoundLimit: 2,
      implementationRoundLimit: 3,
    },
    chronology: [],
    slices: {
      "101": {
        ghIssue: "101",
        sliceNumber: "01",
        title: "",
        dispatched: true,
        blockedBy: [],
        invocations: [
          {
            ghIssue: "101",
            sliceNumber: "01",
            agent: "planner",
            round: 1,
            attempt: 1,
            startedTs: "2026-08-22T01:00:03.000Z",
            endedTs: "2026-08-22T01:00:05.000Z",
            closedTs: "2026-08-22T01:00:05.000Z",
            closeReason: "phase-ended",
          },
          {
            ghIssue: "101",
            sliceNumber: "01",
            agent: "evaluator-contract",
            round: 1,
            attempt: 1,
            startedTs: "2026-08-22T01:00:05.000Z",
            endedTs: "2026-08-22T01:00:06.000Z",
            closedTs: "2026-08-22T01:00:06.000Z",
            closeReason: "phase-ended",
            verdict: "REVISE",
          },
          {
            ghIssue: "101",
            sliceNumber: "01",
            agent: "planner",
            round: 3,
            attempt: 1,
            startedTs: "2026-08-22T01:00:07.000Z",
          },
        ],
      },
      "102": {
        ghIssue: "102",
        sliceNumber: "02",
        title: "",
        dispatched: true,
        blockedBy: [],
        invocations: [],
      },
    },
    sliceOrder: ["101", "102"],
    waves: [
      {
        wave: 1,
        slices: ["101", "102"],
        lanes: [["101", "102"]],
        serial: false,
        startedTs: "2026-08-22T01:00:01.000Z",
      },
    ],
    maxDispatchedWave: 1,
    currentLanes: {
      wave: 1,
      lanes: [["101", "102"]],
      serial: false,
    },
    runPhases: [],
  };
}

describe("buildPipelineSection", () => {
  it("projects waves, serial lanes, observed rounds, and active elapsed time from RunSnapshot", () => {
    const snapshot = snapshotFixture();
    const manifest: ManifestReadResult = {
      status: "available",
      slices: MANIFEST,
    };
    const future: FutureSection = {
      pending: [
        {
          ghIssue: "101",
          title: "First slice",
          remainingPhases: ["planner", "generator", "evaluator-qa"],
          inFlight: true,
          waitsOn: [],
        },
      ],
      upcomingWaves: [],
      currentLanes: snapshot.currentLanes,
      skipped: [],
      notes: [],
    };
    const present: PresentSection = {
      active: [
        {
          ghIssue: "101",
          agent: "planner",
          round: 3,
          startedTs: "2026-08-22T01:00:07.000Z",
          timeInPhaseMs: 3_000,
          stale: false,
        },
      ],
    };

    const pipeline = buildPipelineSection({
      snapshot,
      manifest,
      future,
      present,
      now: new Date("2026-08-22T01:00:10.000Z"),
    });

    expect(pipeline.run).toMatchObject({
      slug: "demo-stub",
      provider: "stub",
      contractRoundLimit: 2,
      implementationRoundLimit: 3,
      state: "active",
    });
    expect(
      pipeline.waves[0]?.lanes[0]?.slices.map((slice) => slice.ghIssue),
    ).toEqual(["101", "102"]);
    const first = pipeline.waves[0]?.lanes[0]?.slices[0];
    expect(first?.contractRounds.map((round) => round.round)).toEqual([1, 3]);
    expect(first?.contractRounds[0]?.evaluator?.verdict).toBe("REVISE");
    expect(first?.contractRounds[1]?.primary).toMatchObject({
      state: "active",
      elapsedMs: 3_000,
    });
  });
});

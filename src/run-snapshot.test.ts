import { describe, expect, it } from "vitest";
import type { RunEvent, RunEventPayload } from "./run-events.js";
import type { RunState } from "./run-state.js";
import { foldEvents } from "./run-snapshot.js";
import { lifecycle } from "./slice-lifecycle.js";

const EMPTY_STATE: RunState = {
  version: 3,
  prdSlug: "demo-stub",
  featureBranch: "feat/demo",
  slices: {},
};

function event<T extends RunEventPayload>(ts: string, payload: T): T & { ts: string } {
  return { ...payload, ts };
}

function realisticStream(): RunEvent[] {
  return [
    event("2026-08-22T10:00:00.000Z", { type: "header", version: 1 }),
    event("2026-08-22T10:00:00.100Z", {
      type: "run-started",
      provider: "stub",
      runSlug: "demo-stub",
      contractRoundLimit: 2,
      implementationRoundLimit: 3,
    }),
    event("2026-08-22T10:00:01.000Z", {
      type: "wave-dispatched",
      wave: 1,
      slices: ["101", "102"],
    }),
    event("2026-08-22T10:00:02.000Z", {
      type: "lanes-partitioned",
      wave: 1,
      lanes: [["101", "102"]],
      serial: true,
    }),
    event("2026-08-22T10:00:03.000Z", {
      type: "phase-started",
      ghIssue: "101",
      sliceNumber: "01",
      agent: "planner",
      round: 1,
    }),
    event("2026-08-22T10:00:04.000Z", {
      type: "phase-started",
      ghIssue: "101",
      sliceNumber: "01",
      agent: "planner",
      round: 1,
    }),
    event("2026-08-22T10:00:09.000Z", {
      type: "phase-ended",
      ghIssue: "101",
      sliceNumber: "01",
      agent: "planner",
      round: 1,
    }),
    event("2026-08-22T10:00:10.000Z", {
      type: "phase-started",
      ghIssue: "101",
      sliceNumber: "01",
      agent: "generator",
      round: 1,
    }),
    event("2026-08-22T10:00:20.000Z", {
      type: "slice-outcome",
      slice: lifecycle.stuck(
        { ghIssue: "101", title: "Foundation", branch: "afk/101" },
        { genRounds: 3, evalRounds: 3 },
        "generator rounds exhausted",
      ),
    }),
    event("2026-08-22T10:00:21.000Z", {
      type: "phase-started",
      ghIssue: "102",
      sliceNumber: "02",
      agent: "planner",
      round: 1,
    }),
    event("2026-08-22T10:00:22.000Z", {
      type: "run-phase-started",
      phase: "sanity",
      attempt: 1,
    }),
    event("2026-08-22T10:00:24.000Z", {
      type: "run-phase-ended",
      phase: "sanity",
      attempt: 1,
      verdict: "PASS",
    }),
  ];
}

describe("foldEvents", () => {
  it("pairs repeated phase starts as a stack and closes every remaining phase on outcome", () => {
    const snapshot = foldEvents(realisticStream(), EMPTY_STATE);
    const planner = snapshot.slices["101"]!.invocations.filter(
      (invocation) => invocation.agent === "planner",
    );

    expect(planner).toHaveLength(2);
    expect(planner[1]).toMatchObject({
      attempt: 2,
      startedTs: "2026-08-22T10:00:04.000Z",
      endedTs: "2026-08-22T10:00:09.000Z",
      closeReason: "phase-ended",
    });
    expect(planner[0]).toMatchObject({
      attempt: 1,
      closeReason: "slice-outcome",
      closedTs: "2026-08-22T10:00:20.000Z",
    });
    expect(snapshot.slices["101"]!.invocations[2]).toMatchObject({
      agent: "generator",
      closeReason: "slice-outcome",
    });

    const phaseLine = snapshot.chronology.find(
      (entry) => entry.type === "phase-ended",
    );
    expect(phaseLine).toMatchObject({ durationMs: 5_000 });
  });

  it("owns run identity, titles, lanes, wave counts, and aggregate phases", () => {
    const snapshot = foldEvents(realisticStream(), EMPTY_STATE);

    expect(snapshot.run).toMatchObject({
      slug: "demo-stub",
      provider: "stub",
      contractRoundLimit: 2,
      implementationRoundLimit: 3,
    });
    expect(snapshot.slices["101"]!.title).toBe("Foundation");
    expect(snapshot.maxDispatchedWave).toBe(1);
    expect(snapshot.currentLanes).toEqual({
      wave: 1,
      lanes: [["101", "102"]],
      serial: true,
    });
    expect(snapshot.runPhases).toEqual([
      {
        phase: "sanity",
        attempt: 1,
        cached: undefined,
        startedTs: "2026-08-22T10:00:22.000Z",
        endedTs: "2026-08-22T10:00:24.000Z",
        verdict: "PASS",
      },
    ]);
  });

  it("fills both successful and failed event-stream gaps from run state", () => {
    const state: RunState = {
      ...EMPTY_STATE,
      slices: {
        "100": { phase: "PASS", mergedToFeature: true },
        "102": { phase: "ERROR", error: "state write beat event flush" },
      },
    };

    const snapshot = foldEvents(realisticStream(), state);

    expect(snapshot.slices["100"]!.outcome).toMatchObject({
      phase: "PASS",
      source: "run-state",
      mergedToFeature: true,
    });
    expect(snapshot.slices["102"]!.outcome).toMatchObject({
      phase: "ERROR",
      source: "run-state",
      error: "state write beat event flush",
    });
    expect(snapshot.slices["102"]!.invocations[0]).toMatchObject({
      closeReason: "run-state",
    });
  });

  it("lets this run's event outcome override an older persisted outcome", () => {
    const state: RunState = {
      ...EMPTY_STATE,
      slices: {
        "101": { phase: "ERROR", error: "prior run" },
      },
    };

    const snapshot = foldEvents(realisticStream(), state);

    expect(snapshot.slices["101"]!.outcome).toMatchObject({
      phase: "STUCK",
      source: "event",
      error: "generator rounds exhausted",
    });
    expect(snapshot.outcomeMismatches).toEqual([]);
  });

  /**
   * The reader-side half of #111. `.afk/state/<slug>.json` is cumulative
   * across every run of a slug, and `afk status --run <dir>` folds it into
   * *one* run's events — so a gap-filling record has to be attributable to
   * that run, and since a dispatch clears the slice's record, a record for
   * a dispatched slice is not. It still fills the gap; it no longer does
   * so silently.
   */
  describe("records this run cannot account for", () => {
    it("reports a dispatched slice's persisted outcome, and stays quiet about an undispatched one", () => {
      const state: RunState = {
        ...EMPTY_STATE,
        slices: {
          // Dispatched by this run's wave 1: a later run wrote this.
          "102": { phase: "ERROR", error: "exceeded 100 tool calls" },
          // Never dispatched here — this genuinely is a prior run's record
          // and reads correctly as one.
          "100": { phase: "PASS", mergedToFeature: true },
        },
      };

      const snapshot = foldEvents(realisticStream(), state);

      expect(snapshot.outcomeMismatches).toHaveLength(1);
      expect(snapshot.outcomeMismatches[0]).toMatchObject({
        ghIssue: "102",
        phase: "ERROR",
      });
      expect(snapshot.outcomeMismatches[0]!.message).toContain(
        "comes from the run-state file, not from this run's events",
      );
      // Reported, not withheld: it is still the only outcome on offer.
      expect(snapshot.slices["102"]!.outcome).toMatchObject({
        phase: "ERROR",
        source: "run-state",
      });
    });

    it("stays quiet about the provisional CANCELLED records a stop writes", () => {
      // A stop writes CANCELLED straight to run state with no per-slice
      // event (#114), so those records ARE this run's. Reporting them
      // would fire on every interrupted run and train operators to
      // ignore the line.
      const stream = [
        ...realisticStream(),
        event("2026-08-22T10:00:25.000Z", {
          type: "warn",
          reason: "cancellation-requested",
          message: "Cancellation requested — marked CANCELLED in run state: #102",
        }),
      ];
      const state: RunState = {
        ...EMPTY_STATE,
        slices: { "102": { phase: "CANCELLED", error: "Cancelled by user" } },
      };

      expect(foldEvents(stream, state).outcomeMismatches).toEqual([]);
    });

    it("still reports a non-cancelled record on a run that was stopped", () => {
      const stream = [
        ...realisticStream(),
        event("2026-08-22T10:00:25.000Z", {
          type: "warn",
          reason: "stop-requested",
          message: "afk stop sentinel found",
        }),
      ];
      const state: RunState = {
        ...EMPTY_STATE,
        slices: { "102": { phase: "STUCK", error: "QA never passed" } },
      };

      expect(foldEvents(stream, state).outcomeMismatches).toMatchObject([
        { ghIssue: "102", phase: "STUCK" },
      ]);
    });

    it("is empty when the state file holds nothing for the dispatched slices", () => {
      expect(foldEvents(realisticStream(), EMPTY_STATE).outcomeMismatches).toEqual(
        [],
      );
      expect(foldEvents(realisticStream(), undefined).outcomeMismatches).toEqual([]);
    });
  });
  it("projects a slice's dispatch bounds and keeps them out of the warn stream", () => {
    const snapshot = foldEvents(
      [
        ...realisticStream(),
        event("2026-08-22T10:00:21.000Z", {
          type: "slice-bounds",
          ghIssue: "102",
          sliceNumber: "02",
          resumeAttemptsRemaining: 1,
          resumeAttemptLimit: 2,
          implementationRoundsRemaining: 2,
          implementationRoundLimit: 3,
          contractRoundsRemaining: 2,
          contractRoundLimit: 2,
          infrastructureRetriesPerInvocation: 2,
          resumeMode: "killed",
        }),
      ],
      EMPTY_STATE,
    );

    expect(snapshot.slices["102"]!.bounds).toEqual({
      resumeAttemptsRemaining: 1,
      resumeAttemptLimit: 2,
      implementationRoundsRemaining: 2,
      implementationRoundLimit: 3,
      contractRoundsRemaining: 2,
      contractRoundLimit: 2,
      infrastructureRetriesPerInvocation: 2,
      resumeMode: "killed",
    });
    expect(
      snapshot.chronology.filter((entry) => entry.type === "slice-bounds"),
    ).toHaveLength(1);
    expect(snapshot.chronology.some((entry) => entry.type === "warn" &&
      entry.event.message.includes("bounds"))).toBe(false);
  });

  it("keeps the latest dispatch's bounds when a slice is dispatched twice", () => {
    const bounds = {
      type: "slice-bounds" as const,
      ghIssue: "101",
      resumeAttemptLimit: 2,
      implementationRoundLimit: 3,
      contractRoundsRemaining: 2,
      contractRoundLimit: 2,
      infrastructureRetriesPerInvocation: 2,
    };
    const snapshot = foldEvents(
      [
        event("2026-08-22T10:00:00.500Z", {
          ...bounds,
          resumeAttemptsRemaining: 2,
          implementationRoundsRemaining: 3,
        }),
        event("2026-08-22T10:30:00.000Z", {
          ...bounds,
          resumeAttemptsRemaining: 1,
          implementationRoundsRemaining: 1,
        }),
      ],
      EMPTY_STATE,
    );

    expect(snapshot.slices["101"]!.bounds).toMatchObject({
      resumeAttemptsRemaining: 1,
      implementationRoundsRemaining: 1,
    });
  });

  it("ignores stage-duration events — they are harvest data, not a status view", () => {
    const baseline = foldEvents(realisticStream(), EMPTY_STATE);
    const withDuration = foldEvents(
      [
        ...realisticStream(),
        event("2026-08-22T10:00:22.000Z", {
          type: "stage-duration",
          ghIssue: "101",
          agent: "generator",
          round: 1,
          durationMs: 600_000,
          history: { samples: 3, medianMs: 120_000, maxMs: 300_000 },
          // A 5× round emits no signal here: no chronology entry, no
          // warn, nothing for a reader to be alarmed by (plan debate §2).
          ratioToMedian: 5,
        }),
      ],
      EMPTY_STATE,
    );

    expect(withDuration).toEqual(baseline);
  });
});

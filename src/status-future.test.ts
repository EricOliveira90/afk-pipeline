import { describe, expect, it } from "vitest";
import type { Slice } from "./issues-parser.js";
import type {
  RunSnapshot,
  SnapshotSliceOutcome,
} from "./run-snapshot.js";
import {
  buildFutureSection,
  renderFutureSection,
  type FutureSection,
  type ManifestReadResult,
} from "./status-future.js";

const MANIFEST: Slice[] = [
  {
    number: "01",
    ghIssue: "100",
    title: "Foundation",
    type: "AFK",
    blockedBy: [],
    userStories: "1",
  },
  {
    number: "02",
    ghIssue: "101",
    title: "Widget on foundation",
    type: "AFK",
    blockedBy: ["100"],
    userStories: "2",
  },
  {
    number: "03",
    ghIssue: "102",
    title: "Mobile gestures on widget",
    type: "AFK",
    blockedBy: ["101"],
    userStories: "3",
  },
  {
    number: "04",
    ghIssue: "103",
    title: "Cron on foundation",
    type: "AFK",
    blockedBy: ["100"],
    userStories: "4",
  },
  {
    number: "05",
    ghIssue: "200",
    title: "Manual setup",
    type: "HITL",
    blockedBy: [],
    userStories: "5",
  },
];

const AVAILABLE: ManifestReadResult = {
  status: "available",
  slices: MANIFEST,
};

function snapshotFixture(): RunSnapshot {
  return {
    run: {
      slug: "demo-stub",
      provider: "stub",
      startedTs: "2025-01-01T00:00:01.000Z",
    },
    outcomeMismatches: [],
    chronology: [],
    slices: {
      "100": {
        ghIssue: "100",
        title: "",
        dispatched: true,
        blockedBy: [],
        invocations: [
          {
            ghIssue: "100",
            agent: "explorer",
            attempt: 1,
            startedTs: "2025-01-01T00:00:02.000Z",
            endedTs: "2025-01-01T00:00:03.000Z",
            closedTs: "2025-01-01T00:00:03.000Z",
            closeReason: "phase-ended",
          },
          {
            ghIssue: "100",
            agent: "planner",
            round: 1,
            attempt: 1,
            startedTs: "2025-01-01T00:00:04.000Z",
            endedTs: "2025-01-01T00:00:05.000Z",
            closedTs: "2025-01-01T00:00:05.000Z",
            closeReason: "phase-ended",
          },
          {
            ghIssue: "100",
            agent: "evaluator-contract",
            round: 1,
            attempt: 1,
            startedTs: "2025-01-01T00:00:06.000Z",
            endedTs: "2025-01-01T00:00:07.000Z",
            closedTs: "2025-01-01T00:00:07.000Z",
            closeReason: "phase-ended",
          },
          {
            ghIssue: "100",
            agent: "generator",
            round: 1,
            attempt: 1,
            startedTs: "2025-01-01T00:00:08.000Z",
          },
        ],
      },
    },
    sliceOrder: ["100"],
    waves: [
      {
        wave: 1,
        slices: ["100"],
        lanes: [["100"]],
        serial: false,
        startedTs: "2025-01-01T00:00:01.500Z",
      },
    ],
    maxDispatchedWave: 1,
    currentLanes: { wave: 1, lanes: [["100"]], serial: false },
    runPhases: [],
  };
}

function addOutcome(
  snapshot: RunSnapshot,
  ghIssue: string,
  outcome: SnapshotSliceOutcome,
): void {
  snapshot.slices[ghIssue] ??= {
    ghIssue,
    title: outcome.title ?? "",
    dispatched: false,
    blockedBy: [],
    invocations: [],
  };
  snapshot.slices[ghIssue]!.outcome = outcome;
  if (!snapshot.sliceOrder.includes(ghIssue)) snapshot.sliceOrder.push(ghIssue);
}

function build(
  snapshot = snapshotFixture(),
  manifest: ManifestReadResult = AVAILABLE,
): FutureSection {
  return buildFutureSection({ snapshot, manifest });
}

function pendingFor(future: FutureSection, ghIssue: string) {
  const entry = future.pending.find((pending) => pending.ghIssue === ghIssue);
  expect(entry, `expected pending entry for #${ghIssue}`).toBeDefined();
  return entry!;
}

describe("buildFutureSection", () => {
  it("derives remaining phases, blockers, waves, titles, lanes, and HITL from a snapshot fixture", () => {
    const future = build();

    expect(pendingFor(future, "100").remainingPhases).toEqual([
      "generator",
      "evaluator-qa",
    ]);
    expect(pendingFor(future, "101")).toMatchObject({
      title: "Widget on foundation",
      inFlight: false,
      waitsOn: [{ ghIssue: "100", status: "in flight" }],
    });
    expect(future.upcomingWaves).toEqual([
      { wave: 1, slices: ["100"] },
      { wave: 2, slices: ["101", "103"] },
      { wave: 3, slices: ["102"] },
    ]);
    expect(future.currentLanes).toEqual({
      wave: 1,
      lanes: [["100"]],
      serial: false,
    });
    expect(future.skipped).toEqual([
      { ghIssue: "200", title: "Manual setup" },
    ]);
  });

  it("gives an untouched manifest slice the whole agent sequence", () => {
    expect(pendingFor(build(), "101").remainingPhases).toEqual([
      "explorer",
      "planner",
      "evaluator-contract",
      "generator",
      "evaluator-qa",
    ]);
  });

  it("treats event PASS and merged persisted PASS as completed", () => {
    for (const source of ["event", "run-state"] as const) {
      const snapshot = snapshotFixture();
      addOutcome(snapshot, "100", {
        phase: "PASS",
        source,
        mergedToFeature: true,
      });
      const future = build(snapshot);
      expect(future.pending.map((pending) => pending.ghIssue)).not.toContain(
        "100",
      );
      expect(pendingFor(future, "101").waitsOn).toEqual([]);
    }
  });

  it("continues projected wave numbers after an event-derived PASS", () => {
    const snapshot = snapshotFixture();
    addOutcome(snapshot, "100", {
      phase: "PASS",
      source: "event",
      mergedToFeature: true,
    });

    expect(build(snapshot).upcomingWaves).toEqual([
      { wave: 2, slices: ["101", "103"] },
      { wave: 3, slices: ["102"] },
    ]);
  });

  it("starts projected waves at one after a persisted PASS with no dispatch", () => {
    const snapshot = snapshotFixture();
    snapshot.waves = [];
    snapshot.maxDispatchedWave = 0;
    snapshot.slices["100"]!.dispatched = false;
    addOutcome(snapshot, "100", {
      phase: "PASS",
      source: "run-state",
      mergedToFeature: true,
    });

    expect(build(snapshot).upcomingWaves).toEqual([
      { wave: 1, slices: ["101", "103"] },
      { wave: 2, slices: ["102"] },
    ]);
  });

  it("does not complete an unmerged persisted PASS record", () => {
    const snapshot = snapshotFixture();
    addOutcome(snapshot, "100", {
      phase: "PASS",
      source: "run-state",
      mergedToFeature: false,
    });

    expect(build(snapshot).pending.map((pending) => pending.ghIssue)).toContain(
      "100",
    );
  });

  it("uses a persisted failure when events.jsonl has no matching outcome", () => {
    const snapshot = snapshotFixture();
    addOutcome(snapshot, "100", {
      phase: "ERROR",
      source: "run-state",
      error: "state write beat event flush",
    });

    const future = build(snapshot);

    expect(future.pending.map((pending) => pending.ghIssue)).not.toContain(
      "100",
    );
    expect(pendingFor(future, "101").waitsOn).toEqual([
      { ghIssue: "100", status: "ERROR" },
    ]);
    expect(future.upcomingWaves).toEqual([]);
  });

  it("marks MERGE-PENDING terminal while explaining its automatic retry", () => {
    const snapshot = snapshotFixture();
    addOutcome(snapshot, "100", {
      phase: "MERGE-PENDING",
      source: "run-state",
      error: "migration prefix collision",
      collidingPrefixes: ["042"],
    });

    const future = build(snapshot);
    expect(future.pending.map((pending) => pending.ghIssue)).not.toContain(
      "100",
    );
    expect(pendingFor(future, "101").waitsOn).toEqual([
      {
        ghIssue: "100",
        status: "MERGE-PENDING — the next run retries the merge",
      },
    ]);
  });

  it("names a parked adjudication issue as the dependent's blocker", () => {
    const snapshot = snapshotFixture();
    addOutcome(snapshot, "100", {
      phase: "AWAITING-ADJUDICATION",
      source: "event",
      branch: "afk/100",
      error: "contract impasse on F-01",
    });

    const future = build(snapshot);

    expect(pendingFor(future, "101").waitsOn).toEqual([
      { ghIssue: "100", status: "AWAITING-ADJUDICATION" },
    ]);
    expect(renderFutureSection(future).join("\n")).toContain(
      "#101 — waits on #100 (AWAITING-ADJUDICATION)",
    );
  });

  it("degrades to observed snapshot slices when issues.md is missing", () => {
    const future = build(snapshotFixture(), {
      status: "missing",
      path: "C:\\repo\\.kiro\\specs\\demo\\issues.md",
    });

    expect(future.notes[0]).toContain("issues.md");
    expect(future.pending).toHaveLength(1);
    expect(pendingFor(future, "100").remainingPhases).toEqual([
      "generator",
      "evaluator-qa",
    ]);
    expect(future.upcomingWaves).toEqual([]);
  });

  it("reports an invalid manifest without discarding observed progress", () => {
    const future = build(snapshotFixture(), {
      status: "invalid",
      path: "C:\\repo\\.kiro\\specs\\demo\\issues.md",
      error: "No slice table found",
    });

    expect(future.notes[0]).toContain("No slice table found");
    expect(pendingFor(future, "100").remainingPhases).toEqual([
      "generator",
      "evaluator-qa",
    ]);
  });

  it("explains when run identity is unavailable", () => {
    const snapshot = snapshotFixture();
    snapshot.run = {};

    const future = build(snapshot, { status: "unavailable" });
    expect(future.notes[0]).toContain("no run-started event");
    expect(future.pending.map((pending) => pending.ghIssue)).toEqual(["100"]);
  });
});

describe("renderFutureSection", () => {
  it("renders phases, projected waves, blockers, lanes, and skipped slices", () => {
    const lines = renderFutureSection(build());
    const rendered = lines.join("\n");

    expect(lines.every((line) => line.startsWith("  "))).toBe(true);
    expect(lines.every((line) => !line.endsWith("\n"))).toBe(true);
    expect(rendered).toContain("#100 Foundation — generator → evaluator-qa");
    expect(rendered).toContain("waits on #100 (in flight)");
    expect(rendered).toContain("wave 1");
    expect(rendered).toContain("wave 2");
    expect(rendered).toContain("Lanes (wave 1): [#100]");
    expect(rendered).toContain("Skipped (HITL)");
    expect(rendered).toContain("#200 Manual setup");
  });

  it("renders persisted failure blockers with their canonical phase", () => {
    const snapshot = snapshotFixture();
    addOutcome(snapshot, "100", {
      phase: "STUCK",
      source: "run-state",
      error: "generator rounds exhausted",
    });

    expect(renderFutureSection(build(snapshot)).join("\n")).toContain(
      "waits on #100 (STUCK)",
    );
  });

  it("says so when nothing is ahead and round-trips through JSON", () => {
    const snapshot = snapshotFixture();
    for (const ghIssue of ["100", "101", "102", "103"]) {
      addOutcome(snapshot, ghIssue, {
        phase: "PASS",
        source: "event",
        mergedToFeature: true,
      });
    }

    const future = build(snapshot);
    expect(future.pending).toEqual([]);
    expect(renderFutureSection(future).some((line) => line.includes("nothing")))
      .toBe(true);
    expect(JSON.parse(JSON.stringify(future))).toEqual(future);
  });
});

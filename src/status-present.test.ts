/**
 * `afk status` present section (spec #26, slice #32) — asserted at the
 * filesystem contract with fixture run directories (in-flight and
 * finished). Liveness is derived, not emitted: the active agent's log
 * file in the run directory is `stat`ed for last activity.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPresentSection,
  readAgentLogActivity,
  renderPresentSection,
} from "./status-present.js";
import { runStatus } from "./status.js";
import type { RunSnapshot } from "./run-snapshot.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

function makeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "afk-present-"));
  tempDirs.push(dir);
  return dir;
}

function writeRunDir(
  root: string,
  slug: string,
  runName: string,
  events: Array<Record<string, unknown>>,
): string {
  const runDir = join(root, ".afk", "logs", slug, runName);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "events.jsonl"),
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    "utf-8",
  );
  return runDir;
}

const NOW = new Date("2026-08-18T10:30:00.000Z");

function inFlightSnapshot(): RunSnapshot {
  return {
    run: {
      slug: "demo-stub",
      provider: "stub",
      startedTs: "2026-08-18T10:00:00.100Z",
    },
    outcomeMismatches: [],
    chronology: [],
    slices: {
      "9401": {
        ghIssue: "9401",
        sliceNumber: "01",
        title: "",
        dispatched: true,
        blockedBy: [],
        invocations: [
          {
            ghIssue: "9401",
            sliceNumber: "01",
            agent: "generator",
            round: 2,
            attempt: 1,
            startedTs: "2026-08-18T10:12:00.000Z",
          },
        ],
      },
      "9402": {
        ghIssue: "9402",
        sliceNumber: "02",
        title: "",
        dispatched: true,
        blockedBy: [],
        invocations: [
          {
            ghIssue: "9402",
            sliceNumber: "02",
            agent: "explorer",
            attempt: 1,
            startedTs: "2026-08-18T10:01:00.000Z",
            endedTs: "2026-08-18T10:02:00.000Z",
            closedTs: "2026-08-18T10:02:00.000Z",
            closeReason: "phase-ended",
          },
          {
            ghIssue: "9402",
            sliceNumber: "02",
            agent: "planner",
            round: 1,
            attempt: 1,
            startedTs: "2026-08-18T10:28:00.000Z",
          },
        ],
      },
    },
    sliceOrder: ["9401", "9402"],
    waves: [],
    maxDispatchedWave: 1,
    currentLanes: null,
    runPhases: [],
  };
}

function buildPresent(runDir: string, snapshot = inFlightSnapshot()) {
  return buildPresentSection({
    snapshot,
    activity: readAgentLogActivity(runDir, snapshot),
    now: NOW,
  });
}

describe("buildPresentSection (filesystem contract)", () => {
  it("derives active slices from open phase-started events with agent, round, and time in phase", () => {
    const root = makeRoot();
    const runDir = writeRunDir(root, "demo-stub", "run-20260818-100000", []);
    // Fresh agent log for 9401's generator → recent activity.
    writeFileSync(join(runDir, "slice-01-generator-r2.log"), "working...\n", "utf-8");

    const present = buildPresent(runDir);

    expect(present.active).toHaveLength(2);
    const gen = present.active.find((a) => a.ghIssue === "9401")!;
    expect(gen.agent).toBe("generator");
    expect(gen.round).toBe(2);
    expect(gen.timeInPhaseMs).toBe(18 * 60_000);
    const plan = present.active.find((a) => a.ghIssue === "9402")!;
    expect(plan.agent).toBe("planner");
    expect(plan.timeInPhaseMs).toBe(2 * 60_000);
  });

  it("reads last activity from the active agent log's mtime and flags stale logs with long time-in-phase", () => {
    const root = makeRoot();
    const runDir = writeRunDir(root, "demo-stub", "run-20260818-100000", []);
    const logPath = join(runDir, "slice-01-generator-r2.log");
    writeFileSync(logPath, "started\n", "utf-8");
    // Last write 15 minutes before NOW — stale for an 18m-old phase.
    const staleTime = new Date(NOW.getTime() - 15 * 60_000);
    utimesSync(logPath, staleTime, staleTime);

    const present = buildPresent(runDir);

    const gen = present.active.find((a) => a.ghIssue === "9401")!;
    expect(gen.lastActivityTs).toBe(staleTime.toISOString());
    expect(gen.stale).toBe(true);

    const rendered = renderPresentSection(present).join("\n");
    expect(rendered).toMatch(/#9401 generator \(round 2\)/);
    expect(rendered).toContain("18m00s in phase");
    // The stale entry is visibly flagged.
    expect(rendered).toMatch(/#9401.*⚠.*15m00s/);
  });

  it("flags a long-open phase with no agent log at all as possibly hung", () => {
    const root = makeRoot();
    const runDir = writeRunDir(root, "demo-stub", "run-20260818-100000", []);
    // No log file is ever written for 9401's generator — deader than a
    // stale log after 18 minutes in phase.

    const present = buildPresent(runDir);

    const gen = present.active.find((a) => a.ghIssue === "9401")!;
    expect(gen.lastActivityTs).toBeUndefined();
    expect(gen.stale).toBe(true);
    const rendered = renderPresentSection(present).join("\n");
    expect(rendered).toMatch(/#9401.*⚠.*no agent log after 18m00s/);
  });

  it("treats a slice with a terminal outcome as inactive even if a phase-started never closed", () => {
    const root = makeRoot();
    const snapshot = inFlightSnapshot();
    const invocation = snapshot.slices["9401"]!.invocations[0]!;
    invocation.closeReason = "slice-outcome";
    invocation.closedTs = "2026-08-18T10:29:00.000Z";
    const runDir = writeRunDir(root, "demo-stub", "run-20260818-100000", []);

    const present = buildPresent(runDir, snapshot);

    expect(present.active.map((a) => a.ghIssue)).toEqual(["9402"]);
  });

  it("renders an empty present section for a finished run without errors", () => {
    const root = makeRoot();
    const snapshot = inFlightSnapshot();
    for (const slice of Object.values(snapshot.slices)) {
      for (const invocation of slice.invocations) {
        invocation.closeReason ??= "slice-outcome";
        invocation.closedTs ??= "2026-08-18T10:29:00.000Z";
      }
    }
    const runDir = writeRunDir(root, "demo-stub", "run-20260818-100000", []);

    const present = buildPresent(runDir, snapshot);

    expect(present.active).toEqual([]);
    expect(renderPresentSection(present)).toEqual(["  (nothing running)"]);
  });
});

describe("afk status present section integration (#32)", () => {
  it("shows the Present section between Past and Future for an in-flight run directory", () => {
    const root = makeRoot();
    // Timestamps relative to the real clock so runStatus (real now)
    // reports a sane time-in-phase.
    const startedTs = new Date(Date.now() - 90_000).toISOString();
    const runDir = writeRunDir(root, "demo-stub", "run-20260818-100000", [
      { type: "header", version: 1, ts: startedTs },
      { type: "run-started", provider: "stub", runSlug: "demo-stub", ts: startedTs },
      { type: "phase-started", ghIssue: "9401", sliceNumber: "01", agent: "generator", round: 1, ts: startedTs },
    ]);
    writeFileSync(join(runDir, "slice-01-generator-r1.log"), "alive\n", "utf-8");

    const { output, exitCode } = runStatus([], root);

    expect(exitCode).toBe(0);
    expect(output).toContain("Present:");
    expect(output).toMatch(/#9401 generator \(round 1\)/);
    const pastIdx = output.indexOf("Past:");
    const presentIdx = output.indexOf("Present:");
    const futureIdx = output.indexOf("Future:");
    expect(presentIdx).toBeGreaterThan(pastIdx);
    expect(futureIdx).toBeGreaterThan(presentIdx);

    // --json carries the same present model.
    const { output: jsonOut } = runStatus(["--json"], root);
    const model = JSON.parse(jsonOut);
    expect(model.present.active).toHaveLength(1);
    expect(model.present.active[0]).toMatchObject({
      ghIssue: "9401",
      agent: "generator",
      round: 1,
    });
  });
});

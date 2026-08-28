import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunEvent, RunEventPayload } from "./run-events.js";
import {
  pairStageDurations,
  ratioToMedian,
  readStageDurationHistory,
  stageInvocationKey,
  summarizeStageHistory,
} from "./stage-durations.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function event<T extends RunEventPayload>(ts: string, payload: T): RunEvent {
  return { ...payload, ts } as RunEvent;
}

function writeRun(logDir: string, name: string, events: RunEvent[]): string {
  const runDir = join(logDir, name);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "events.jsonl"),
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
  return runDir;
}

function makeLogDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "afk-stage-durations-"));
  tempDirs.push(dir);
  return dir;
}

describe("summarizeStageHistory", () => {
  it("returns null with no prior samples — a first invocation invents no baseline", () => {
    expect(summarizeStageHistory([])).toBeNull();
  });

  it("summarizes odd sample counts by the middle value", () => {
    expect(summarizeStageHistory([300, 100, 200])).toEqual({
      samples: 3,
      medianMs: 200,
      maxMs: 300,
    });
  });

  it("averages the middle pair on even sample counts", () => {
    expect(summarizeStageHistory([100, 200, 300, 500])).toEqual({
      samples: 4,
      medianMs: 250,
      maxMs: 500,
    });
  });
});

describe("ratioToMedian", () => {
  it("expresses the duration as a multiple of the median, two decimals", () => {
    expect(
      ratioToMedian(3_000, { samples: 4, medianMs: 900, maxMs: 2_000 }),
    ).toBe(3.33);
  });

  it("declines to divide by a zero median rather than report a fake comparison", () => {
    expect(
      ratioToMedian(3_000, { samples: 1, medianMs: 0, maxMs: 0 }),
    ).toBeUndefined();
  });
});

describe("pairStageDurations", () => {
  it("pools every round of one agent role into that stage's samples", () => {
    const durations = pairStageDurations([
      event("2026-08-28T10:00:00.000Z", {
        type: "phase-started",
        ghIssue: "79",
        agent: "generator",
        round: 1,
      }),
      event("2026-08-28T10:01:00.000Z", {
        type: "phase-ended",
        ghIssue: "79",
        agent: "generator",
        round: 1,
      }),
      event("2026-08-28T10:02:00.000Z", {
        type: "phase-started",
        ghIssue: "79",
        agent: "generator",
        round: 2,
      }),
      event("2026-08-28T10:05:00.000Z", {
        type: "phase-ended",
        ghIssue: "79",
        agent: "generator",
        round: 2,
      }),
    ]);

    expect(durations.get("generator")).toEqual([60_000, 180_000]);
  });

  it("drops a start whose phase never ended — a killed round is not a duration", () => {
    const durations = pairStageDurations([
      event("2026-08-28T10:00:00.000Z", {
        type: "phase-started",
        ghIssue: "79",
        agent: "generator",
        round: 1,
      }),
      event("2026-08-28T10:00:10.000Z", {
        type: "phase-started",
        ghIssue: "80",
        agent: "explorer",
      }),
      event("2026-08-28T10:00:40.000Z", {
        type: "phase-ended",
        ghIssue: "80",
        agent: "explorer",
      }),
    ]);

    expect(durations.has("generator")).toBe(false);
    expect(durations.get("explorer")).toEqual([30_000]);
  });

  it("matches a retried attempt against its own start, not the first one", () => {
    const durations = pairStageDurations([
      event("2026-08-28T10:00:00.000Z", {
        type: "phase-started",
        ghIssue: "79",
        agent: "evaluator-qa",
        round: 1,
      }),
      event("2026-08-28T10:10:00.000Z", {
        type: "phase-started",
        ghIssue: "79",
        agent: "evaluator-qa",
        round: 1,
      }),
      event("2026-08-28T10:11:00.000Z", {
        type: "phase-ended",
        ghIssue: "79",
        agent: "evaluator-qa",
        round: 1,
      }),
    ]);

    expect(durations.get("evaluator-qa")).toEqual([60_000]);
  });
});

describe("stageInvocationKey", () => {
  it("separates rounds of the same agent on the same slice", () => {
    expect(stageInvocationKey({ ghIssue: "79", agent: "generator", round: 1 }))
      .not.toBe(
        stageInvocationKey({ ghIssue: "79", agent: "generator", round: 2 }),
      );
  });

  it("treats a roundless stage as its own key", () => {
    expect(stageInvocationKey({ ghIssue: "79", agent: "explorer" })).toBe(
      "79|explorer|",
    );
  });
});

describe("readStageDurationHistory", () => {
  it("merges samples across the PRD's earlier runs and skips the current one", () => {
    const logDir = makeLogDir();
    writeRun(logDir, "run-20260826-100000", [
      event("2026-08-26T10:00:00.000Z", { type: "header", version: 1 }),
      event("2026-08-26T10:00:00.000Z", {
        type: "phase-started",
        ghIssue: "79",
        agent: "generator",
        round: 1,
      }),
      event("2026-08-26T10:01:00.000Z", {
        type: "phase-ended",
        ghIssue: "79",
        agent: "generator",
        round: 1,
      }),
    ]);
    writeRun(logDir, "run-20260827-100000", [
      event("2026-08-27T10:00:00.000Z", {
        type: "phase-started",
        ghIssue: "79",
        agent: "generator",
        round: 1,
      }),
      event("2026-08-27T10:02:00.000Z", {
        type: "phase-ended",
        ghIssue: "79",
        agent: "generator",
        round: 1,
      }),
    ]);
    const current = writeRun(logDir, "run-20260828-100000", [
      event("2026-08-28T10:00:00.000Z", {
        type: "phase-started",
        ghIssue: "79",
        agent: "generator",
        round: 1,
      }),
      event("2026-08-28T11:00:00.000Z", {
        type: "phase-ended",
        ghIssue: "79",
        agent: "generator",
        round: 1,
      }),
    ]);

    const history = readStageDurationHistory(logDir, current);

    expect(history.get("generator")?.sort((a, b) => a - b)).toEqual([
      60_000, 120_000,
    ]);
  });

  it("ignores non-run directories and runs with no events file", () => {
    const logDir = makeLogDir();
    mkdirSync(join(logDir, "scratch"), { recursive: true });
    mkdirSync(join(logDir, "run-20260827-100000"), { recursive: true });
    writeRun(logDir, "run-20260826-100000", [
      event("2026-08-26T10:00:00.000Z", {
        type: "phase-started",
        ghIssue: "79",
        agent: "explorer",
      }),
      event("2026-08-26T10:00:30.000Z", {
        type: "phase-ended",
        ghIssue: "79",
        agent: "explorer",
      }),
    ]);

    expect(readStageDurationHistory(logDir).get("explorer")).toEqual([30_000]);
  });

  it("returns nothing rather than throwing when the log directory is absent", () => {
    expect(readStageDurationHistory(join(makeLogDir(), "missing")).size).toBe(0);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunJournal } from "./run-journal.js";
import { loadRunState } from "./run-state.js";
import { lifecycle, type SliceIdentity } from "./slice-lifecycle.js";

const tempDirs: string[] = [];
const SLICE: SliceIdentity = {
  ghIssue: "40",
  title: "Preserve cause",
  branch: "afk/demo-slice-01",
};

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "afk-run-journal-"));
  tempDirs.push(repo);
  return repo;
}

function eventsOf(journal: RunJournal): Array<Record<string, unknown>> {
  return readFileSync(join(journal.runDir, "events.jsonl"), "utf-8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("RunJournal.recordTerminal", () => {
  it("rejects terminal phases at the non-terminal tracking interface", () => {
    const journal = new RunJournal(makeRepo(), "guard");

    expect(() =>
      journal.trackSlice(
        lifecycle.error(SLICE, { genRounds: 0, evalRounds: 0 }, "bypassed"),
      ),
    ).toThrow(/must use recordTerminal/);
  });

  it("preserves one real cause across lifecycle, run state, run log, and event", () => {
    const repo = makeRepo();
    const journal = new RunJournal(repo, "demo");
    journal.setFeatureBranch("feat/demo");
    journal.trackSlice(
      lifecycle.running(SLICE, { genRounds: 2, evalRounds: 1 }),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});

    const cause =
      "Agent evaluator-contract exited with code 1 after provider disconnect";
    const recorded = journal.recordTerminal(SLICE, {
      phase: "ERROR",
      error: cause,
    });

    expect(recorded).toEqual({
      ...SLICE,
      phase: "ERROR",
      progress: { genRounds: 2, evalRounds: 1 },
      error: cause,
    });
    expect(journal.getSlice("40")).toEqual(recorded);
    expect(loadRunState(repo, "demo").slices["40"]).toEqual({
      phase: "ERROR",
      branch: SLICE.branch,
      error: cause,
    });
    expect(readFileSync(join(journal.runDir, "run.log"), "utf-8")).toContain(
      `ERROR — ${cause}`,
    );
    const outcomes = eventsOf(journal).filter(
      (event) => event.type === "slice-outcome",
    );
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.slice).toEqual(recorded);
  });

  it("retries after state persistence fails, then deduplicates completed calls", () => {
    const repo = makeRepo();
    const journal = new RunJournal(repo, "retry");
    journal.trackSlice(lifecycle.running(SLICE));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const stateBlocker = join(repo, ".afk", "state");
    mkdirSync(join(repo, ".afk"), { recursive: true });
    writeFileSync(stateBlocker, "not a directory", "utf-8");

    const outcome = { phase: "STUCK", error: "QA failed" } as const;
    expect(() => journal.recordTerminal(SLICE, outcome)).toThrow();
    expect(journal.getSlice("40")?.phase).toBe("RUNNING");
    expect(eventsOf(journal).filter((event) => event.type === "slice-outcome"))
      .toHaveLength(0);

    rmSync(stateBlocker, { force: true });
    journal.recordTerminal(SLICE, outcome);
    journal.recordTerminal(SLICE, outcome);

    expect(loadRunState(repo, "retry").slices["40"]?.error).toBe("QA failed");
    expect(eventsOf(journal).filter((event) => event.type === "slice-outcome"))
      .toHaveLength(1);
    expect(
      readFileSync(join(journal.runDir, "run.log"), "utf-8").match(
        /STUCK — QA failed/g,
      ),
    ).toHaveLength(1);
  });

  it("records MERGE-PENDING prefixes through the unchanged lifecycle event", () => {
    const repo = makeRepo();
    const journal = new RunJournal(repo, "merge-pending");
    vi.spyOn(console, "error").mockImplementation(() => {});

    const recorded = journal.recordTerminal(SLICE, {
      phase: "MERGE-PENDING",
      error: "Migration prefix collision: 042",
      collidingPrefixes: ["042"],
    });

    expect(loadRunState(repo, "merge-pending").slices["40"]).toEqual({
      phase: "MERGE-PENDING",
      branch: SLICE.branch,
      error: "Migration prefix collision: 042",
      collidingPrefixes: ["042"],
    });
    expect(
      eventsOf(journal).find((event) => event.type === "slice-outcome")?.slice,
    ).toEqual(recorded);
  });
});

/**
 * The record a stop writes at the moment it is requested (issue #114).
 * Before this, cancellation bookkeeping happened only after the wave
 * unwound, so a process that ended during the wind-down left the
 * in-flight slice with no run-state entry at all — indistinguishable
 * from a slice that never ran, which is what makes the next
 * `--only-failed` destructive (#113).
 */
describe("RunJournal.markCancelledInFlight", () => {
  const OTHER: SliceIdentity = {
    ghIssue: "41",
    title: "Not started",
    branch: "afk/demo-slice-02",
  };

  it("persists CANCELLED for an in-flight and an unstarted slice", () => {
    const repo = makeRepo();
    const journal = new RunJournal(repo, "cancel-inflight");
    vi.spyOn(console, "error").mockImplementation(() => {});
    // 40 is mid-generator; 41 was never dispatched. Both are stopped.
    journal.trackSlice(lifecycle.running(SLICE, { genRounds: 2, evalRounds: 1 }));

    const marked = journal.markCancelledInFlight([SLICE, OTHER], "Cancelled by user");

    expect(marked).toEqual(["40", "41"]);
    const state = loadRunState(repo, "cancel-inflight");
    expect(state.slices["40"]).toEqual({
      phase: "CANCELLED",
      branch: SLICE.branch,
      error: "Cancelled by user",
    });
    expect(state.slices["41"]?.phase).toBe("CANCELLED");
  });

  it("leaves a decided outcome alone", () => {
    const repo = makeRepo();
    const journal = new RunJournal(repo, "cancel-decided");
    journal.setFeatureBranch("feat/demo");
    vi.spyOn(console, "error").mockImplementation(() => {});
    journal.recordTerminal(SLICE, { phase: "PASS" });

    expect(journal.markCancelledInFlight([SLICE], "Cancelled by user")).toEqual([]);
    expect(loadRunState(repo, "cancel-decided").slices["40"]).toMatchObject({
      phase: "PASS",
      mergedToFeature: true,
    });
  });

  it("is provisional: a real outcome landing during the wind-down still wins", () => {
    const repo = makeRepo();
    const journal = new RunJournal(repo, "cancel-provisional");
    journal.setFeatureBranch("feat/demo");
    vi.spyOn(console, "error").mockImplementation(() => {});
    journal.trackSlice(lifecycle.running(SLICE));

    journal.markCancelledInFlight([SLICE], "Cancelled by user");
    // The merge this slice had already started completes after the stop.
    journal.recordTerminal(SLICE, { phase: "PASS" });

    expect(loadRunState(repo, "cancel-provisional").slices["40"]).toMatchObject({
      phase: "PASS",
      mergedToFeature: true,
    });
  });

  it("keeps going when one slice's write fails", () => {
    const repo = makeRepo();
    const journal = new RunJournal(repo, "cancel-write-failure");
    vi.spyOn(console, "error").mockImplementation(() => {});

    const stateBlocker = join(repo, ".afk", "state");
    mkdirSync(join(repo, ".afk"), { recursive: true });
    writeFileSync(stateBlocker, "not a directory", "utf-8");

    // Every write fails here; the point is that the sweep returns rather
    // than throwing out of an abort listener that has slices left to mark.
    expect(journal.markCancelledInFlight([SLICE, OTHER], "Cancelled by user")).toEqual([]);
  });
});

/**
 * The stage-duration journal event (afk-v2 plan, riding wave item 14).
 * Derived inside the journal from the phase events every stage already
 * reports, so these assert at the seam rather than through a pipeline.
 */
describe("RunJournal stage durations", () => {
  function durationEvents(journal: RunJournal) {
    return eventsOf(journal).filter((e) => e.type === "stage-duration");
  }

  it("records a stage's duration after its phase-ended, with no history on the first", () => {
    const journal = new RunJournal(makeRepo(), "stage-first");
    const started = new Date("2026-08-28T10:00:00.000Z");
    vi.useFakeTimers();
    try {
      vi.setSystemTime(started);
      journal.event({ type: "phase-started", ghIssue: "79", sliceNumber: "01", agent: "generator", round: 1 });
      vi.setSystemTime(new Date(started.getTime() + 90_000));
      journal.event({ type: "phase-ended", ghIssue: "79", sliceNumber: "01", agent: "generator", round: 1 });
    } finally {
      vi.useRealTimers();
    }

    expect(durationEvents(journal)).toEqual([
      {
        type: "stage-duration",
        ts: "2026-08-28T10:01:30.000Z",
        ghIssue: "79",
        sliceNumber: "01",
        agent: "generator",
        round: 1,
        durationMs: 90_000,
        history: null,
      },
    ]);
  });

  it("compares a later round against the earlier rounds of the same stage", () => {
    const journal = new RunJournal(makeRepo(), "stage-history");
    const base = new Date("2026-08-28T10:00:00.000Z").getTime();
    const runStage = (round: number, at: number, durationMs: number) => {
      vi.setSystemTime(new Date(at));
      journal.event({ type: "phase-started", ghIssue: "79", agent: "generator", round });
      vi.setSystemTime(new Date(at + durationMs));
      journal.event({ type: "phase-ended", ghIssue: "79", agent: "generator", round });
    };
    vi.useFakeTimers();
    try {
      runStage(1, base, 60_000);
      runStage(2, base + 600_000, 120_000);
      runStage(3, base + 1_200_000, 360_000);
    } finally {
      vi.useRealTimers();
    }

    expect(durationEvents(journal).map((e) => [e.durationMs, e.history, e.ratioToMedian])).toEqual([
      [60_000, null, undefined],
      [120_000, { samples: 1, medianMs: 60_000, maxMs: 60_000 }, 2],
      [360_000, { samples: 2, medianMs: 90_000, maxMs: 120_000 }, 4],
    ]);
  });

  it("emits the duration after the phase-ended it derives from", () => {
    const journal = new RunJournal(makeRepo(), "stage-order");
    journal.event({ type: "phase-started", ghIssue: "79", agent: "explorer" });
    journal.event({ type: "phase-ended", ghIssue: "79", agent: "explorer" });

    expect(eventsOf(journal).map((e) => e.type)).toEqual([
      "header",
      "phase-started",
      "phase-ended",
      "stage-duration",
    ]);
  });

  it("records nothing for a stage whose phase-ended never arrives", () => {
    const journal = new RunJournal(makeRepo(), "stage-killed");
    journal.event({ type: "phase-started", ghIssue: "79", agent: "generator", round: 1 });

    expect(durationEvents(journal)).toEqual([]);
  });

  it("seeds the history from the PRD's earlier runs", () => {
    const repo = makeRepo();
    const logDir = join(repo, ".afk", "logs", "prior-runs");
    const priorRun = join(logDir, "run-20260101-000000");
    mkdirSync(priorRun, { recursive: true });
    writeFileSync(
      join(priorRun, "events.jsonl"),
      [
        { type: "phase-started", ghIssue: "12", agent: "generator", round: 1, ts: "2026-01-01T00:00:00.000Z" },
        { type: "phase-ended", ghIssue: "12", agent: "generator", round: 1, ts: "2026-01-01T00:05:00.000Z" },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n") + "\n",
      "utf-8",
    );
    const journal = new RunJournal(repo, "prior-runs");
    const started = new Date("2026-08-28T10:00:00.000Z");
    vi.useFakeTimers();
    try {
      vi.setSystemTime(started);
      journal.event({ type: "phase-started", ghIssue: "79", agent: "generator", round: 1 });
      vi.setSystemTime(new Date(started.getTime() + 600_000));
      journal.event({ type: "phase-ended", ghIssue: "79", agent: "generator", round: 1 });
    } finally {
      vi.useRealTimers();
    }

    expect(durationEvents(journal)[0]).toMatchObject({
      durationMs: 600_000,
      history: { samples: 1, medianMs: 300_000, maxMs: 300_000 },
      ratioToMedian: 2,
    });
  });

  it("emits data only — no warn event, no run.log line, no threshold", () => {
    const repo = makeRepo();
    const journal = new RunJournal(repo, "stage-data-only");
    journal.event({ type: "phase-started", ghIssue: "79", agent: "generator", round: 1 });
    journal.event({ type: "phase-ended", ghIssue: "79", agent: "generator", round: 1 });

    expect(eventsOf(journal).some((e) => e.type === "warn")).toBe(false);
    expect(existsSync(join(journal.runDir, "run.log"))).toBe(false);
  });
});

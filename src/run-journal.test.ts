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
 * Clear-on-dispatch (issue #111). A slice going RUNNING is this run
 * taking ownership of its record, so the previous attempt's persisted
 * record goes at that moment. Before this, memory said RUNNING while
 * disk still said `ERROR — exceeded 100 tool calls` from two runs back,
 * and every reader believed the disk.
 */
describe("RunJournal.trackSlice clears stale records on dispatch", () => {
  /** The #111 record: a failure reason from an already-fixed defect. */
  const STALE = {
    version: 1,
    prdSlug: "dispatch",
    featureBranch: "feat/dispatch",
    slices: {
      "40": {
        phase: "ERROR",
        branch: "afk/demo-slice-01",
        error: "exceeded 100 tool calls",
      },
      "41": { phase: "STUCK", branch: "afk/demo-slice-02", error: "QA never passed" },
    },
    resume: { "40": { attempts: 1, lastDecision: "resumed from 3 commits" } },
  };

  function seedStale(repo: string, slug = "dispatch"): void {
    mkdirSync(join(repo, ".afk", "state"), { recursive: true });
    writeFileSync(
      join(repo, ".afk", "state", `${slug}.json`),
      JSON.stringify({ ...STALE, prdSlug: slug }),
      "utf-8",
    );
  }

  it("drops the dispatched slice's record and keeps its resume budget", () => {
    const repo = makeRepo();
    seedStale(repo);
    const journal = new RunJournal(repo, "dispatch");
    vi.spyOn(console, "log").mockImplementation(() => {});

    journal.trackSlice(lifecycle.running(SLICE));

    const state = loadRunState(repo, "dispatch");
    expect(state.slices["40"]).toBeUndefined();
    // Untouched: the resume cap is what stops an unattended launcher
    // resuming a poisoned tree forever (#36).
    expect(state.resume?.["40"]?.attempts).toBe(1);
    // Untouched: #41 was not dispatched, so its record still describes
    // the last run that decided it.
    expect(state.slices["41"]?.error).toBe("QA never passed");
  });

  it("announces what it cleared on run.log and as a typed event", () => {
    const repo = makeRepo();
    seedStale(repo);
    const journal = new RunJournal(repo, "dispatch");
    vi.spyOn(console, "log").mockImplementation(() => {});

    journal.trackSlice(lifecycle.running(SLICE));

    expect(readFileSync(join(journal.runDir, "run.log"), "utf-8")).toContain(
      "cleared the previous attempt's persisted record (ERROR — exceeded 100 tool calls)",
    );
    expect(
      eventsOf(journal).find((event) => event.reason === "stale-record-cleared"),
    ).toMatchObject({
      type: "warn",
      ghIssue: "40",
      previousPhase: "ERROR",
      previousError: "exceeded 100 tool calls",
    });
  });

  it("says nothing on a first run, and creates no state file", () => {
    const repo = makeRepo();
    const journal = new RunJournal(repo, "first-run");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    journal.trackSlice(lifecycle.running(SLICE));

    expect(log).not.toHaveBeenCalled();
    expect(existsSync(join(repo, ".afk", "state", "first-run.json"))).toBe(false);
  });

  it("does not clear a record this run already decided", () => {
    const repo = makeRepo();
    const journal = new RunJournal(repo, "redispatch");
    journal.setFeatureBranch("feat/demo");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    journal.trackSlice(lifecycle.running(SLICE));
    journal.recordTerminal(SLICE, { phase: "PASS" });

    // A re-dispatch after a decided outcome must not wipe a record this
    // run is entitled to.
    journal.trackSlice(lifecycle.running(SLICE));

    expect(loadRunState(repo, "redispatch").slices["40"]).toMatchObject({
      phase: "PASS",
      mergedToFeature: true,
    });
  });

  it("warns and dispatches anyway when the clear cannot be written", () => {
    const repo = makeRepo();
    const journal = new RunJournal(repo, "dispatch");
    seedStale(repo);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Make the read-modify-write fail: the record is unparseable, so
    // loadRunState throws inside the clear.
    writeFileSync(join(repo, ".afk", "state", "dispatch.json"), "{ not json", "utf-8");

    journal.trackSlice(lifecycle.running(SLICE));

    expect(journal.getSlice("40")?.phase).toBe("RUNNING");
    expect(warn.mock.calls.flat().join("\n")).toContain(
      "could not clear slice #40's stale run-state record at dispatch",
    );
  });

  it("leaves PENDING and SKIPPED records alone — neither is a dispatch", () => {
    const repo = makeRepo();
    seedStale(repo);
    const journal = new RunJournal(repo, "dispatch");

    journal.trackSlice(lifecycle.pending(SLICE));
    journal.trackSlice(
      lifecycle.skipped({ ghIssue: "41", title: "HITL", branch: "—" }),
    );

    const state = loadRunState(repo, "dispatch");
    expect(state.slices["40"]?.error).toBe("exceeded 100 tool calls");
    expect(state.slices["41"]?.phase).toBe("STUCK");
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

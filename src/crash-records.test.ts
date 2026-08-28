import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CRASH_CAUSE,
  crashRecordText,
  crashRecorderFor,
  installCrashRecorder,
  type Crash,
  type CrashHost,
} from "./crash-records.js";
import { RunJournal } from "./run-journal.js";
import { loadRunState, saveSliceState } from "./run-state.js";
import { lifecycle, type SliceIdentity } from "./slice-lifecycle.js";

/**
 * A fake `process` that records registrations and lets a test deliver a
 * crash event by name, with its argument.
 */
function makeHost() {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const exits: number[] = [];
  const host: CrashHost = {
    on(event, listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return host;
    },
    off(event, listener) {
      listeners.set(
        event,
        (listeners.get(event) ?? []).filter((l) => l !== listener),
      );
      return host;
    },
    exit(code) {
      exits.push(code);
      return undefined;
    },
  };
  return {
    host,
    exits,
    registered: () =>
      [...listeners.keys()].filter((k) => listeners.get(k)!.length > 0),
    deliver(event: string, ...args: unknown[]) {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(...args);
    },
  };
}

function makeRecorder() {
  const crashes: Crash[] = [];
  return { crashes, recorder: (crash: Crash) => void crashes.push(crash) };
}

/**
 * Issue #121: run 6 died on an unhandled `'error'` event from a log
 * `WriteStream` (ENOSPC). No signal fired, so ADR 0040's abort listener
 * never ran, and the state file kept slice #79's entry from two runs
 * earlier — a typecheck failure that had already been fixed.
 */
describe("installCrashRecorder", () => {
  it("registers the two process-fatal events, and only those", () => {
    const fake = makeHost();
    const handle = installCrashRecorder({ host: fake.host, log: () => {} });

    expect(fake.registered()).toEqual([
      "uncaughtException",
      "unhandledRejection",
    ]);
    expect(handle.events).toEqual(["uncaughtException", "unhandledRejection"]);
  });

  it("records an uncaught exception with the CRASHED cause, then exits non-zero", () => {
    const fake = makeHost();
    const { crashes, recorder } = makeRecorder();
    const logged: string[] = [];
    installCrashRecorder({
      host: fake.host,
      log: (m) => logged.push(m),
    }).register(recorder);

    fake.deliver("uncaughtException", new Error("ENOSPC: no space left on device, write"));

    expect(crashes).toHaveLength(1);
    expect(crashes[0]!.source).toBe("uncaughtException");
    expect(crashes[0]!.record).toBe(
      "CRASHED (uncaughtException): ENOSPC: no space left on device, write",
    );
    // The stack goes to the operator, not into the record field.
    expect(crashes[0]!.detail).toContain("Error: ENOSPC");
    expect(crashes[0]!.detail).toContain("at ");
    // Not swallowed: the process still dies, and visibly.
    expect(fake.exits).toEqual([1]);
    expect(logged.join("\n")).toContain(CRASH_CAUSE);
  });

  it("records an unhandled rejection from its reason, ignoring the promise argument", () => {
    const fake = makeHost();
    const { crashes, recorder } = makeRecorder();
    installCrashRecorder({ host: fake.host, log: () => {} }).register(recorder);

    fake.deliver("unhandledRejection", new Error("gate write failed"), Promise.resolve());

    expect(crashes[0]!.source).toBe("unhandledRejection");
    expect(crashes[0]!.record).toBe("CRASHED (unhandledRejection): gate write failed");
    expect(fake.exits).toEqual([1]);
  });

  it("records a fatal stream error against the log file it was writing", () => {
    const fake = makeHost();
    const { crashes, recorder } = makeRecorder();
    const handle = installCrashRecorder({ host: fake.host, log: () => {} });
    handle.register(recorder);

    handle.reportFatalStreamError(
      new Error("ENOSPC: no space left on device, write"),
      "slice-05-generator-r2.log",
    );

    // Which stream failed is the diagnosis: "the disk refused this log" is
    // not the same finding as "an agent threw".
    expect(crashes[0]!.record).toBe(
      "CRASHED (stream-error: slice-05-generator-r2.log): ENOSPC: no space left on device, write",
    );
    expect(crashes[0]!.origin).toBe("slice-05-generator-r2.log");
    expect(fake.exits).toEqual([1]);
  });

  /**
   * The accepted limitation: the condition most worth recording is the
   * condition that can defeat the write. Say so and exit anyway — no
   * reserved-space machinery (the debate rejected it).
   */
  it("still exits non-zero, and says so, when the record itself cannot be written", () => {
    const fake = makeHost();
    const logged: string[] = [];
    installCrashRecorder({ host: fake.host, log: (m) => logged.push(m) }).register(
      () => {
        throw new Error("ENOSPC: no space left on device, write");
      },
    );

    fake.deliver("uncaughtException", new Error("boom"));

    expect(logged.join("\n")).toContain("Could not write the crash record");
    expect(logged.join("\n")).toContain("may still name an earlier failure");
    expect(fake.exits).toEqual([1]);
  });

  it("records the first crash only — a crash raised while recording must reach the exit, not recurse", () => {
    const fake = makeHost();
    const { crashes } = makeRecorder();
    const handle = installCrashRecorder({ host: fake.host, log: () => {} });
    handle.register((crash) => {
      crashes.push(crash);
      // A failing record write is itself a fatal stream error.
      handle.reportFatalStreamError(new Error("and the log failed too"));
    });

    fake.deliver("uncaughtException", new Error("boom"));
    fake.deliver("uncaughtException", new Error("boom again"));

    expect(crashes.map((c) => c.record)).toEqual([
      "CRASHED (uncaughtException): boom",
    ]);
    expect(fake.exits).toEqual([1]);
  });

  it("exits non-zero with no recorder registered — a crash before the run has one", () => {
    const fake = makeHost();
    const logged: string[] = [];
    installCrashRecorder({ host: fake.host, log: (m) => logged.push(m) });

    fake.deliver("uncaughtException", new Error("died during setup"));

    expect(fake.exits).toEqual([1]);
    expect(logged.join("\n")).toContain("died during setup");
  });

  it("stops recording through a run's journal once that run unregisters", () => {
    const fake = makeHost();
    const { crashes, recorder } = makeRecorder();
    const handle = installCrashRecorder({ host: fake.host, log: () => {} });
    handle.register(recorder)();

    fake.deliver("uncaughtException", new Error("after the run returned"));

    expect(crashes).toEqual([]);
    expect(fake.exits).toEqual([1]);
  });

  it("removes every listener on dispose", () => {
    const fake = makeHost();
    installCrashRecorder({ host: fake.host, log: () => {} }).dispose();

    expect(fake.registered()).toEqual([]);
  });
});

describe("crashRecordText", () => {
  it("collapses a multi-line message — the record is read out of a JSON field", () => {
    const error = new Error("write failed\n  at the log stream\n\n  disk full");

    expect(crashRecordText("uncaughtException", error)).toBe(
      "CRASHED (uncaughtException): write failed at the log stream disk full",
    );
  });

  it("caps a runaway message rather than persisting it whole", () => {
    const text = crashRecordText("uncaughtException", new Error("x".repeat(1000)));

    expect(text.length).toBeLessThan(450);
    expect(text.endsWith("...")).toBe(true);
  });

  it("names a non-Error rejection value, and refuses to invent one", () => {
    expect(crashRecordText("unhandledRejection", "just a string")).toBe(
      "CRASHED (unhandledRejection): just a string",
    );
    expect(crashRecordText("unhandledRejection", { code: "ENOSPC" })).toBe(
      'CRASHED (unhandledRejection): {"code":"ENOSPC"}',
    );
    // `Promise.reject()` rejects with undefined; "undefined" is not a reason.
    expect(crashRecordText("unhandledRejection", undefined)).toBe(
      "CRASHED (unhandledRejection): no error text",
    );
  });
});

/**
 * The mapping from a crash to the run's record — the whole fix for #121,
 * checked without spawning a pipeline.
 */
describe("crashRecorderFor", () => {
  const tempDirs: string[] = [];
  const SLICE: SliceIdentity = {
    ghIssue: "79",
    title: "Evidence backbone",
    branch: "afk/prd-1-slice-05",
  };
  const CRASH: Crash = {
    source: "stream-error",
    origin: "slice-05-generator-r2.log",
    record:
      "CRASHED (stream-error: slice-05-generator-r2.log): ENOSPC: no space left on device, write",
    detail: "Error: ENOSPC: no space left on device, write\n    at WriteStream",
  };

  afterEach(() => {
    vi.restoreAllMocks();
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  function makeRepo(): string {
    const repo = mkdtempSync(join(tmpdir(), "afk-crash-"));
    tempDirs.push(repo);
    return repo;
  }

  it("replaces a previous run's stale failure text with the crash that actually happened", () => {
    const repo = makeRepo();
    // Run 6's real state: slice #79 still carrying the typecheck failure
    // from two runs earlier, fixed before this run even started.
    saveSliceState(repo, "prd-1", "79", {
      phase: "ERROR",
      branch: SLICE.branch,
      error:
        "Base gate infrastructure failed: typecheck (.../run-20260827-144209/gates/s05/attempt-11c8af51245d.json)",
    });
    const journal = new RunJournal(repo, "prd-1");
    journal.trackSlice(lifecycle.running(SLICE, { genRounds: 2, evalRounds: 2 }));
    vi.spyOn(console, "error").mockImplementation(() => {});

    crashRecorderFor(journal, () => [SLICE])(CRASH);

    const persisted = loadRunState(repo, "prd-1").slices["79"]!;
    // CANCELLED, as a stop records: the branch and its 12 commits are the
    // truth, and this phase is the one that preserves them.
    expect(persisted.phase).toBe("CANCELLED");
    expect(persisted.branch).toBe(SLICE.branch);
    expect(persisted.error).toBe(CRASH.record);
    expect(persisted.error).not.toContain("typecheck");
  });

  it("names the slices it recorded in run.log and in the event stream", () => {
    const repo = makeRepo();
    const journal = new RunJournal(repo, "prd-1");
    journal.trackSlice(lifecycle.running(SLICE, { genRounds: 1, evalRounds: 0 }));
    vi.spyOn(console, "error").mockImplementation(() => {});

    crashRecorderFor(journal, () => [SLICE])(CRASH);

    const runLog = readFileSync(join(journal.runDir, "run.log"), "utf-8");
    expect(runLog).toContain(CRASH.record);
    expect(runLog).toContain("marked CANCELLED in run state: #79");

    const events = readFileSync(join(journal.runDir, "events.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const warn = events.find((e) => e.type === "warn");
    expect(warn?.reason).toBe("crashed");
    expect(warn?.message).toContain(CRASH.record);
    // Nothing runs after the recorder returns, so the run's end is
    // recorded here or not at all.
    expect(events.at(-1)).toMatchObject({ type: "run-ended", outcome: "FAILED" });
  });

  it("says so when the crash caught no slice in flight", () => {
    const repo = makeRepo();
    const journal = new RunJournal(repo, "prd-1");
    vi.spyOn(console, "error").mockImplementation(() => {});

    crashRecorderFor(journal, () => [])(CRASH);

    expect(readFileSync(join(journal.runDir, "run.log"), "utf-8")).toContain(
      "no slice had work in flight",
    );
    expect(loadRunState(repo, "prd-1").slices).toEqual({});
  });

  it("leaves a slice that already reached a real outcome alone", () => {
    const repo = makeRepo();
    const journal = new RunJournal(repo, "prd-1");
    journal.trackSlice(lifecycle.running(SLICE, { genRounds: 1, evalRounds: 1 }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    journal.setFeatureBranch("feat/prd-1");
    journal.recordTerminal(SLICE, { phase: "PASS" });

    crashRecorderFor(journal, () => [SLICE])(CRASH);

    const persisted = loadRunState(repo, "prd-1").slices["79"]!;
    expect(persisted.phase).toBe("PASS");
    expect(persisted.error).toBeUndefined();
  });
});

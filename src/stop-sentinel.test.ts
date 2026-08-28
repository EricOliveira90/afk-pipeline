/**
 * The stop sentinel's detection half (ADR 0043). The decision a run makes
 * once per poll is a pure function of one file's contents, so it is
 * asserted here rather than by spawning a pipeline — the run-level proof
 * that the decision reaches ADR 0040's abort path lives on the existing
 * mid-slice cancellation fixture in `orchestrator-runs.test.ts`.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearStopSentinel,
  createStopSentinelWatcher,
  decideStopRequest,
  pollStopSentinel,
  readStopAck,
  readStopRequest,
  runIdFor,
  stopAckPath,
  stopRequestPath,
  writeStopAck,
  writeStopRequest,
  type StopDecision,
} from "./stop-sentinel.js";

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

/** A run directory named the way `runDirNameFor` names them (ADR 0017). */
function makeRunDir(name = "run-20260828-101500"): string {
  const root = mkdtempSync(join(tmpdir(), "afk-stop-sentinel-"));
  tempDirs.push(root);
  const runDir = join(root, name);
  mkdirSync(runDir, { recursive: true });
  return runDir;
}

describe("decideStopRequest", () => {
  it("stops when the sentinel names this run", () => {
    const decision = decideStopRequest(
      "run-20260828-101500",
      JSON.stringify({
        runId: "run-20260828-101500",
        requestedAt: "2026-08-28T10:20:00.000Z",
        source: "afk stop",
      }),
    );
    expect(decision).toMatchObject({
      stop: true,
      reason: "requested",
      request: { requestedAt: "2026-08-28T10:20:00.000Z", source: "afk stop" },
    });
  });

  it("does not stop for a sentinel addressed to another run", () => {
    // The property the run-ID namespacing exists for: a stop that was
    // meant for the previous run must never abort this one.
    const decision = decideStopRequest(
      "run-20260828-101500",
      JSON.stringify({ runId: "run-20260827-090000", requestedAt: "x" }),
    );
    expect(decision).toEqual({
      stop: false,
      reason: "other-run",
      targetRunId: "run-20260827-090000",
    });
  });

  it("does not stop when there is no sentinel", () => {
    expect(decideStopRequest("run-20260828-101500", null)).toEqual({
      stop: false,
      reason: "absent",
    });
  });

  it.each([
    ["truncated JSON", '{"runId": "run-2026'],
    ["a JSON scalar", '"stop"'],
    ["an object naming no run", '{"requestedAt": "2026-08-28T10:20:00.000Z"}'],
  ])("stops on a sentinel it cannot read — %s", (_label, raw) => {
    // Asymmetric costs (see the module doc): a stop that fires on a torn
    // write ends a run whose work is committed and recorded, while one
    // that ignores the operator sends them to the hard kill ADR 0040
    // exists to make unnecessary.
    const decision = decideStopRequest("run-20260828-101500", raw);
    expect(decision.stop).toBe(true);
    expect(decision).toMatchObject({ reason: "unreadable" });
  });
});

describe("the sentinel on disk", () => {
  it("round-trips a request through the run's own log directory", () => {
    const runDir = makeRunDir();
    const written = writeStopRequest(runDir, {
      requestedAt: "2026-08-28T10:20:00.000Z",
      source: "afk stop",
    });

    // The run ID defaults to the directory name — the path is what makes
    // the sentinel run-namespaced.
    expect(written.runId).toBe(runIdFor(runDir));
    expect(stopRequestPath(runDir)).toBe(join(runDir, "stop.request"));
    expect(readStopRequest(runDir)).toEqual(written);
    expect(pollStopSentinel(runDir)).toMatchObject({ stop: true });
  });

  it("reads as absent when no sentinel was written", () => {
    const runDir = makeRunDir();
    expect(pollStopSentinel(runDir)).toEqual({ stop: false, reason: "absent" });
    expect(readStopRequest(runDir)).toBeNull();
  });

  it("ignores a request copied in from a different run's directory", () => {
    const runDir = makeRunDir("run-20260828-101500");
    writeFileSync(
      stopRequestPath(runDir),
      JSON.stringify({ runId: "run-20260827-090000", requestedAt: "x" }),
    );
    expect(pollStopSentinel(runDir)).toMatchObject({
      stop: false,
      reason: "other-run",
    });
  });

  it("round-trips an ack, and rejects one it cannot parse", () => {
    const runDir = makeRunDir();
    expect(readStopAck(runDir)).toBeNull();

    expect(
      writeStopAck(runDir, {
        runId: runIdFor(runDir),
        requestedAt: "2026-08-28T10:20:00.000Z",
        acknowledgedAt: "2026-08-28T10:20:02.000Z",
        cancelledSlices: ["8101", "8102"],
      }),
    ).toBe(true);
    expect(readStopAck(runDir)).toMatchObject({
      acknowledgedAt: "2026-08-28T10:20:02.000Z",
      cancelledSlices: ["8101", "8102"],
    });

    writeFileSync(stopAckPath(runDir), "not json");
    expect(readStopAck(runDir)).toBeNull();
  });
});

describe("clearStopSentinel at launch", () => {
  it("removes this run's own request and ack, and names what it removed", () => {
    const runDir = makeRunDir();
    writeStopRequest(runDir, { requestedAt: "2026-08-28T10:20:00.000Z" });
    writeStopAck(runDir, {
      runId: runIdFor(runDir),
      acknowledgedAt: "2026-08-28T10:20:02.000Z",
      cancelledSlices: [],
    });

    expect(clearStopSentinel(runDir).sort()).toEqual([
      "stop.ack",
      "stop.request",
    ]);
    expect(pollStopSentinel(runDir)).toEqual({ stop: false, reason: "absent" });
    expect(readStopAck(runDir)).toBeNull();
  });

  it("reports nothing removed for a fresh run directory — the normal case", () => {
    expect(clearStopSentinel(makeRunDir())).toEqual([]);
  });

  it("leaves another run's sentinel alone", () => {
    // A crashed `afk stop` leaves its sentinel in the run directory it
    // targeted. Nothing polls a finished run, so it is inert — and a new
    // run never shares that directory.
    const stale = makeRunDir("run-20260827-090000");
    writeStopRequest(stale, { requestedAt: "2026-08-27T09:00:00.000Z" });
    const fresh = join(stale, "..", "run-20260828-101500");
    mkdirSync(fresh, { recursive: true });

    expect(clearStopSentinel(fresh)).toEqual([]);
    expect(readStopRequest(stale)).not.toBeNull();
  });
});

describe("createStopSentinelWatcher", () => {
  const absent: StopDecision = { stop: false, reason: "absent" };
  const requested: StopDecision = {
    stop: true,
    reason: "requested",
    request: { runId: "run-1", requestedAt: "2026-08-28T10:20:00.000Z" },
  };

  /** Drive `tick()` directly; the interval only exists to call it. */
  function watcherOver(decisions: StopDecision[]) {
    const stops: StopDecision[] = [];
    const others: string[] = [];
    let polls = 0;
    const watcher = createStopSentinelWatcher({
      runDir: "run-1",
      // Long enough that the timer never fires inside a test.
      intervalMs: 3_600_000,
      poll: () => decisions[Math.min(polls++, decisions.length - 1)]!,
      onStop: (decision) => stops.push(decision),
      onOtherRun: (id) => others.push(id),
    });
    return { watcher, stops, others, polls: () => polls };
  }

  it("fires once, on the first tick that finds the sentinel", () => {
    const { watcher, stops } = watcherOver([absent, absent, requested]);
    watcher.tick();
    watcher.tick();
    expect(stops).toEqual([]);
    watcher.tick();
    expect(stops).toEqual([requested]);
    watcher.stop();
  });

  it("never fires twice, and stops polling once it has", () => {
    // A second stop request escalates to a hard exit in the CLI, so a
    // poller that kept re-firing would turn one `afk stop` into a kill on
    // the next tick.
    const { watcher, stops, polls } = watcherOver([requested]);
    watcher.tick();
    const pollsAfterFiring = polls();
    watcher.tick();
    watcher.tick();
    expect(stops).toHaveLength(1);
    expect(polls()).toBe(pollsAfterFiring);
    watcher.stop();
  });

  it("reports a foreign sentinel once instead of on every tick", () => {
    const other: StopDecision = {
      stop: false,
      reason: "other-run",
      targetRunId: "run-0",
    };
    const { watcher, stops, others } = watcherOver([other]);
    watcher.tick();
    watcher.tick();
    expect(others).toEqual(["run-0"]);
    expect(stops).toEqual([]);
    watcher.stop();
  });

  it("polls the real sentinel when no poll function is injected", () => {
    const runDir = makeRunDir();
    const stops: StopDecision[] = [];
    const watcher = createStopSentinelWatcher({
      runDir,
      intervalMs: 3_600_000,
      onStop: (decision) => stops.push(decision),
    });

    expect(watcher.tick()).toEqual({ stop: false, reason: "absent" });
    writeStopRequest(runDir, { requestedAt: "2026-08-28T10:20:00.000Z" });
    expect(watcher.tick()).toMatchObject({ stop: true });
    expect(stops).toHaveLength(1);
    watcher.stop();
  });
});

describe("the sentinel file's shape", () => {
  it("is JSON an operator can read and hand-write", () => {
    // Reachable by `echo` when the CLI is unavailable — a stop mechanism
    // whose only client is its own binary is one dependency too many for
    // the situation it exists for.
    const runDir = makeRunDir();
    writeStopRequest(runDir, {
      requestedAt: "2026-08-28T10:20:00.000Z",
      source: "afk stop",
    });
    const raw = readFileSync(stopRequestPath(runDir), "utf-8");
    expect(raw).toContain(`"runId": "${runIdFor(runDir)}"`);
    expect(raw.endsWith("\n")).toBe(true);
  });
});

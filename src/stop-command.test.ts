/**
 * `afk stop` — the writer half of the stop sentinel (ADR 0043), tested at
 * its filesystem contract: fixture log directories in, resolved target
 * plus exit code out. No pipeline is spawned; the run side of the
 * handshake is a fixture ack file here, and is proved for real on the
 * mid-slice cancellation scenario in `orchestrator-runs.test.ts`.
 *
 * The exit code carries the answer the old stop mechanism could not give:
 * 0 acknowledged, 1 written but unacknowledged, 2 nothing written.
 */
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseStopArgs,
  resolveStopTarget,
  runEndedOutcome,
  runStopCli,
} from "./stop-command.js";
import {
  readStopRequest,
  runIdFor,
  writeStopAck,
  writeStopRequest,
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

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "afk-stop-cli-"));
  tempDirs.push(dir);
  return dir;
}

/** A run directory under `.afk/logs/<logSlug>/`, with optional events. */
function makeRun(
  repo: string,
  logSlug: string,
  runName: string,
  events: Array<Record<string, unknown>> = [{ type: "header", version: 1 }],
): string {
  const runDir = join(repo, ".afk", "logs", logSlug, runName);
  mkdirSync(runDir, { recursive: true });
  if (events.length > 0) {
    writeFileSync(
      join(runDir, "events.jsonl"),
      events.map((event) => JSON.stringify(event)).join("\n") + "\n",
    );
  }
  return runDir;
}

/**
 * A clock that advances only when the command sleeps, so the ack wait is
 * bounded by tick count rather than wall time. `onSleep` lets a test make
 * the run "answer" after a given number of polls.
 */
function fakeClock(onSleep?: (call: number) => void) {
  let ms = Date.parse("2026-08-28T10:20:00.000Z");
  let calls = 0;
  return {
    now: () => new Date(ms),
    sleep: async (waited: number) => {
      ms += waited;
      calls++;
      onSleep?.(calls);
    },
    calls: () => calls,
  };
}

describe("parseStopArgs", () => {
  it("takes a bare PRD slug, matching the other subcommands", () => {
    expect(parseStopArgs(["contacts-crud"])).toMatchObject({
      slug: "contacts-crud",
    });
  });

  it("accepts --run and --wait-ms", () => {
    expect(parseStopArgs(["--run", "some/dir", "--wait-ms", "0"])).toMatchObject({
      runDir: "some/dir",
      waitMs: 0,
    });
  });

  it.each([
    [["--run"], "--run requires"],
    [["--wait-ms", "soon"], "--wait-ms must be"],
    [["--bogus"], "unknown flag"],
    [["one", "two"], "one PRD slug at a time"],
    [["slug", "--run", "dir"], "not both"],
  ])("rejects %j", (args, expected) => {
    const parsed = parseStopArgs(args);
    expect(parsed).toHaveProperty("error");
    expect((parsed as { error: string }).error).toContain(expected);
  });
});

describe("resolving which run to stop", () => {
  it("finds a PRD's latest run through its provider-suffixed log slug", () => {
    const repo = makeRepo();
    makeRun(repo, "contacts-crud-codex", "run-20260827-090000");
    const newest = makeRun(repo, "contacts-crud-codex", "run-20260828-101500");
    makeRun(repo, "other-prd", "run-20260828-120000");

    const target = resolveStopTarget(repo, { slug: "contacts-crud" });
    expect(target).toMatchObject({ ok: true, runDir: newest });
  });

  it("auto-detects the newest run across every PRD when given no slug", () => {
    const repo = makeRepo();
    makeRun(repo, "contacts-crud", "run-20260828-101500");
    const newest = makeRun(repo, "other-prd", "run-20260828-120000");

    expect(resolveStopTarget(repo, {})).toMatchObject({
      ok: true,
      runDir: newest,
      autoDetected: true,
    });
  });

  it("names the log directories it can see when the slug matches none", () => {
    const repo = makeRepo();
    makeRun(repo, "contacts-crud-codex", "run-20260828-101500");

    const target = resolveStopTarget(repo, { slug: "typo-slug" });
    expect(target.ok).toBe(false);
    expect((target as { message: string }).message).toContain(
      "contacts-crud-codex",
    );
  });

  it("resolves --run against the repo root, and refuses a missing one", () => {
    const repo = makeRepo();
    const runDir = makeRun(repo, "contacts-crud", "run-20260828-101500");

    expect(
      resolveStopTarget(repo, {
        runDir: ".afk/logs/contacts-crud/run-20260828-101500",
      }),
    ).toMatchObject({ ok: true, runDir });
    expect(resolveStopTarget(repo, { runDir: "nope" })).toMatchObject({
      ok: false,
    });
  });
});

describe("runEndedOutcome", () => {
  it("reads the run's own last word", () => {
    const repo = makeRepo();
    const runDir = makeRun(repo, "slug", "run-20260828-101500", [
      { type: "header", version: 1 },
      { type: "run-ended", outcome: "FAILED", ts: "2026-08-28T10:00:00.000Z" },
    ]);
    expect(runEndedOutcome(runDir)).toEqual({
      outcome: "FAILED",
      ts: "2026-08-28T10:00:00.000Z",
    });
  });

  it("is null for a live run, and for a run dir with no event stream", () => {
    const repo = makeRepo();
    expect(runEndedOutcome(makeRun(repo, "a", "run-20260828-101500"))).toBeNull();
    expect(
      runEndedOutcome(makeRun(repo, "b", "run-20260828-101500", [])),
    ).toBeNull();
  });
});

describe("runStopCli", () => {
  it("writes the sentinel and reports the run's acknowledgement", async () => {
    const repo = makeRepo();
    const runDir = makeRun(repo, "contacts-crud-codex", "run-20260828-101500");
    // The run answers on its second poll — the handshake this command
    // exists for, since a written file is not a delivered stop.
    const clock = fakeClock((call) => {
      if (call === 2) {
        writeStopAck(runDir, {
          runId: runIdFor(runDir),
          requestedAt: readStopRequest(runDir)!.requestedAt,
          acknowledgedAt: "2026-08-28T10:20:01.000Z",
          cancelledSlices: ["8101", "8102"],
        });
      }
    });

    const result = await runStopCli(["contacts-crud"], repo, clock);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Wrote stop sentinel");
    expect(result.output).toContain("marked CANCELLED in run state: #8101, #8102");
    expect(readStopRequest(runDir)?.source).toBe("afk stop");
  });

  it("exits 1 when nothing acknowledges, and leaves the sentinel in place", async () => {
    const repo = makeRepo();
    const runDir = makeRun(repo, "contacts-crud", "run-20260828-101500");
    const clock = fakeClock();

    const result = await runStopCli(
      ["contacts-crud", "--wait-ms", "4000"],
      repo,
      clock,
    );

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("No acknowledgement within 4s");
    // The fallback is today's status quo, named explicitly rather than
    // left for the operator to rediscover under pressure.
    expect(result.output).toContain("Ctrl-Break");
    expect(readStopRequest(runDir)).not.toBeNull();
    // Bounded by the wait window, not by luck.
    expect(clock.calls()).toBe(8);
  });

  it("writes without waiting on --wait-ms 0", async () => {
    const repo = makeRepo();
    const runDir = makeRun(repo, "contacts-crud", "run-20260828-101500");
    const clock = fakeClock();

    const result = await runStopCli(
      ["contacts-crud", "--wait-ms", "0"],
      repo,
      clock,
    );

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Not waiting");
    expect(clock.calls()).toBe(0);
    expect(readStopRequest(runDir)).not.toBeNull();
  });

  it("refuses to litter a run that already ended, and says which run it looked at", async () => {
    const repo = makeRepo();
    const runDir = makeRun(repo, "contacts-crud", "run-20260828-101500", [
      { type: "header", version: 1 },
      { type: "run-ended", outcome: "SUCCEEDED", ts: "2026-08-28T10:00:00.000Z" },
    ]);

    const result = await runStopCli(["contacts-crud"], repo, fakeClock());

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("already ended (SUCCEEDED)");
    expect(result.output).toContain(runDir);
    expect(existsSync(join(runDir, "stop.request"))).toBe(false);
  });

  it("reports an ack the run already wrote instead of waiting for a second one", async () => {
    // Second `afk stop` against the same run. A run acknowledges once, so
    // waiting again would time out on a run that is already winding down.
    const repo = makeRepo();
    const runDir = makeRun(repo, "contacts-crud", "run-20260828-101500");
    writeStopAck(runDir, {
      runId: runIdFor(runDir),
      acknowledgedAt: "2026-08-28T10:19:00.000Z",
      cancelledSlices: ["8101"],
    });
    const clock = fakeClock();

    const result = await runStopCli(["contacts-crud"], repo, clock);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("already acknowledged");
    expect(result.output).toContain("Nothing further written");
    expect(clock.calls()).toBe(0);
  });

  it("flags a prior unacknowledged request when it rewrites one", async () => {
    // The signature of a wedged run: the sentinel is there and nothing
    // has read it. Worth saying out loud, since the next step differs.
    const repo = makeRepo();
    const runDir = makeRun(repo, "contacts-crud", "run-20260828-101500");
    writeStopRequest(runDir, { requestedAt: "2026-08-28T10:00:00.000Z" });

    const result = await runStopCli(
      ["contacts-crud", "--wait-ms", "0"],
      repo,
      fakeClock(),
    );

    expect(result.output).toContain("already in place and unacknowledged");
    expect(readStopRequest(runDir)?.requestedAt).toBe("2026-08-28T10:20:00.000Z");
  });

  it("exits 2 without writing anything when the target cannot be resolved", async () => {
    const repo = makeRepo();
    expect(await runStopCli([], repo, fakeClock())).toMatchObject({
      exitCode: 2,
    });
    expect(await runStopCli(["--wait-ms", "x"], repo, fakeClock())).toMatchObject({
      exitCode: 2,
    });
  });
});

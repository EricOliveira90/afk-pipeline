import { describe, it, expect, beforeEach } from "vitest";
import type { ChildProcess } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { TerminationReport } from "./kill-tree.js";
import {
  formatQuiesceDetail,
  isInsideDir,
  quiesceWorktree,
  registerWorktreeProcess,
  resetWorktreeProcessRegistry,
} from "./worktree-processes.js";

/**
 * ADR 0035 / issue #102: teardown must wait for (or terminate and
 * confirm) every process AFK spawned inside a worktree before deleting
 * it. Process tables and terminators are injected, so these run the real
 * decision logic on fabricated trees — the same technique kill-tree.test
 * uses.
 */

/** A `ChildProcess` stand-in with just the liveness fields we read. */
function fakeProc(pid: number, alive = true): ChildProcess {
  return {
    pid,
    exitCode: alive ? null : 0,
    signalCode: null,
  } as unknown as ChildProcess;
}

const WT = join(tmpdir(), "afk-102-wt");
const noSleep = async () => {};

beforeEach(() => {
  resetWorktreeProcessRegistry();
});

describe("isInsideDir", () => {
  it("accepts the directory itself and anything under it", () => {
    expect(isInsideDir(WT, WT)).toBe(true);
    expect(isInsideDir(join(WT, "src", "deep"), WT)).toBe(true);
  });

  it("rejects a sibling that merely shares a name prefix", () => {
    expect(isInsideDir(`${WT}-other`, WT)).toBe(false);
    expect(isInsideDir(join(tmpdir(), "elsewhere"), WT)).toBe(false);
  });
});

describe("quiesceWorktree", () => {
  it("is a no-op when nothing was ever spawned in the tree", async () => {
    registerWorktreeProcess(join(tmpdir(), "afk-102-other"), fakeProc(10));

    const report = await quiesceWorktree(WT, {
      listPidPpid: async () => new Map([[10, 1]]),
      sleep: noSleep,
    });

    expect(report).toEqual({
      observed: [],
      terminated: [],
      survivors: [],
      verified: true,
    });
  });

  it("waits for a live process to exit on its own instead of killing it", async () => {
    const proc = fakeProc(20);
    registerWorktreeProcess(join(WT, "src"), proc);
    // Alive for the first two polls, then gone.
    const tables = [
      new Map([[20, 1]]),
      new Map([[20, 1]]),
      new Map<number, number>(),
    ];
    let terminations = 0;

    const report = await quiesceWorktree(WT, {
      waitMs: 10_000,
      sleep: noSleep,
      listPidPpid: async () => tables.shift() ?? new Map(),
      terminateProcessTree: async () => {
        terminations++;
        return { rootDead: true, survivors: [], verified: true };
      },
    });

    expect(terminations).toBe(0);
    expect(report).toEqual({
      observed: [],
      terminated: [],
      survivors: [],
      verified: true,
    });
  });

  it("terminates and confirms a process that outlives the wait", async () => {
    const proc = fakeProc(30);
    registerWorktreeProcess(WT, proc);
    let killed: ChildProcess | undefined;
    let elapsed = 0;

    const report = await quiesceWorktree(WT, {
      waitMs: 500,
      sleep: async () => {
        elapsed += 250;
      },
      now: () => elapsed,
      // Never exits on its own; the child (31) is part of its tree.
      listPidPpid: async () =>
        new Map([
          [30, 1],
          [31, 30],
        ]),
      terminateProcessTree: async (p) => {
        killed = p;
        return { rootDead: true, survivors: [], verified: true };
      },
    });

    expect(killed).toBe(proc);
    expect(report.terminated).toEqual([30]);
    expect(report.observed).toEqual(expect.arrayContaining([30, 31]));
    expect(report.survivors).toEqual([]);
    expect(report.verified).toBe(true);
  });

  it("sweeps an orphaned descendant of an invocation that already exited", async () => {
    // The exact shape natural-exit settlement never verifies (ADR 0020):
    // the root is gone but a grandchild still holds handles inside the
    // tree, and Windows keeps its stale parent PID so the BFS finds it.
    registerWorktreeProcess(WT, fakeProc(40, false));
    let killedPid: number | undefined;

    const report = await quiesceWorktree(WT, {
      waitMs: 0,
      sleep: noSleep,
      now: () => 0,
      listPidPpid: async () => new Map([[41, 40]]),
      terminatePidTree: async (pid) => {
        killedPid = pid;
        return { rootDead: true, survivors: [], verified: true };
      },
      terminateProcessTree: async () => {
        throw new Error("must not kill through a dead handle");
      },
    });

    expect(killedPid).toBe(40);
    expect(report.terminated).toEqual([40]);
    expect(report.survivors).toEqual([]);
  });

  it("reports survivors rather than claiming a quiet tree", async () => {
    registerWorktreeProcess(WT, fakeProc(50));

    const report = await quiesceWorktree(WT, {
      waitMs: 0,
      sleep: noSleep,
      now: () => 0,
      listPidPpid: async () => new Map([[50, 1]]),
      terminateProcessTree: async (): Promise<TerminationReport> => ({
        rootDead: false,
        survivors: [50],
        verified: true,
      }),
    });

    expect(report.survivors).toEqual([50]);
    expect(formatQuiesceDetail(report)).toContain("PIDs 50");
  });

  it("keeps a survivor registered so the next teardown sees it again", async () => {
    registerWorktreeProcess(WT, fakeProc(60));
    const stubborn = {
      waitMs: 0,
      sleep: noSleep,
      now: () => 0,
      listPidPpid: async () => new Map([[60, 1]]),
      terminateProcessTree: async (): Promise<TerminationReport> => ({
        rootDead: false,
        survivors: [60],
        verified: true,
      }),
    };

    await quiesceWorktree(WT, stubborn);
    const second = await quiesceWorktree(WT, stubborn);

    expect(second.terminated).toEqual([60]);
  });

  it("cuts the wait short on abort and goes straight to terminating", async () => {
    const controller = new AbortController();
    controller.abort();
    registerWorktreeProcess(WT, fakeProc(70));
    let terminated = false;

    const report = await quiesceWorktree(WT, {
      waitMs: 60_000,
      signal: controller.signal,
      sleep: async () => {
        throw new Error("must not sleep once aborted");
      },
      listPidPpid: async () => new Map([[70, 1]]),
      terminateProcessTree: async () => {
        terminated = true;
        return { rootDead: true, survivors: [], verified: true };
      },
    });

    expect(terminated).toBe(true);
    expect(report.terminated).toEqual([70]);
  });

  it("says so when the process table cannot be listed", async () => {
    registerWorktreeProcess(WT, fakeProc(80));

    const report = await quiesceWorktree(WT, {
      waitMs: 0,
      sleep: noSleep,
      now: () => 0,
      listPidPpid: async () => undefined,
      terminateProcessTree: async () => ({
        rootDead: true,
        survivors: [],
        verified: false,
      }),
    });

    expect(report.verified).toBe(false);
    expect(formatQuiesceDetail(report)).toMatch(/could not be verified/);
  });

  it("ignores a process that never got a PID", async () => {
    registerWorktreeProcess(WT, {
      pid: undefined,
      exitCode: null,
      signalCode: null,
    } as unknown as ChildProcess);

    const report = await quiesceWorktree(WT, {
      listPidPpid: async () => new Map(),
      sleep: noSleep,
    });

    expect(report.observed).toEqual([]);
  });
});

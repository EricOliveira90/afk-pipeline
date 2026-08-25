import { describe, expect, it, vi } from "vitest";
import {
  collectTree,
  formatTerminationWarning,
  parsePidPpidOutput,
  terminatePidTree,
  terminateProcessTree,
} from "./kill-tree.js";
import { asChildProcess, makeFakeProc } from "./test/fake-proc.js";

/**
 * A mutable fake Windows process table: pid -> ppid. Kill primitives
 * mutate it; the injected lister reads it.
 */
function makeTable(entries: Array<[number, number]>) {
  const table = new Map(entries);
  return {
    table,
    listPidPpid: async () => new Map(table),
    remove(...pids: number[]) {
      for (const pid of pids) table.delete(pid);
    },
  };
}

const FAST = { pollIntervalMs: 5, confirmTimeoutMs: 40 };

describe("terminateProcessTree on win32", () => {
  it("tree-kills the live root and confirms every descendant died", async () => {
    const proc = makeFakeProc(100);
    // Toolbox shim (100) -> real CLI (200) -> worker child (300);
    // 999 is an unrelated process that must not be touched.
    const state = makeTable([
      [100, 1],
      [200, 100],
      [300, 200],
      [999, 1],
    ]);
    const killTree = vi.fn(async (pid: number) => {
      expect(pid).toBe(100);
      state.remove(100, 200, 300);
      proc.exitCode = 1;
    });
    const killPid = vi.fn(async () => {});

    const report = await terminateProcessTree(asChildProcess(proc), {
      platform: "win32",
      listPidPpid: state.listPidPpid,
      killTree,
      killPid,
      ...FAST,
    });

    expect(killTree).toHaveBeenCalledTimes(1);
    expect(killPid).not.toHaveBeenCalled();
    expect(report).toEqual({ rootDead: true, survivors: [], verified: true });
    expect(state.table.has(999)).toBe(true);
    expect(formatTerminationWarning(report)).toBe("");
  });

  it("force-kills stragglers individually and reports the ones that refuse to die", async () => {
    const proc = makeFakeProc(100);
    const state = makeTable([
      [100, 1],
      [200, 100],
      [300, 200],
    ]);
    // The tree kill misses the grandchild; the individual kill also fails.
    const killTree = vi.fn(async () => {
      state.remove(100, 200);
      proc.exitCode = 1;
    });
    const killPid = vi.fn(async () => {});

    const report = await terminateProcessTree(asChildProcess(proc), {
      platform: "win32",
      listPidPpid: state.listPidPpid,
      killTree,
      killPid,
      ...FAST,
    });

    expect(killPid).toHaveBeenCalledWith(300);
    expect(report.rootDead).toBe(true);
    expect(report.survivors).toEqual([300]);
    expect(formatTerminationWarning(report)).toMatch(
      /WARNING: 1 process\(es\) survived the kill \(PIDs 300\)/,
    );
  });

  it("enumerates orphans through stale parent PIDs after the root already died", async () => {
    const proc = makeFakeProc(100);
    proc.exitCode = 1; // shim died on its own; grandchildren carried on
    // Windows keeps the recorded PPID of orphans pointing at the dead
    // parent, so the chain 100 -> 200 -> 300 stays navigable.
    const state = makeTable([
      [200, 100],
      [300, 200],
    ]);
    const killTree = vi.fn(async () => {}); // taskkill on a dead PID: no-op
    const killPid = vi.fn(async (pid: number) => state.remove(pid));

    const report = await terminateProcessTree(asChildProcess(proc), {
      platform: "win32",
      listPidPpid: state.listPidPpid,
      killTree,
      killPid,
      ...FAST,
    });

    expect(killPid).toHaveBeenCalledWith(200);
    expect(killPid).toHaveBeenCalledWith(300);
    expect(report).toEqual({ rootDead: true, survivors: [], verified: true });
  });

  it("reports unverified when the process table cannot be listed", async () => {
    const proc = makeFakeProc(100);
    const killTree = vi.fn(async () => {
      proc.exitCode = 1;
    });

    const report = await terminateProcessTree(asChildProcess(proc), {
      platform: "win32",
      listPidPpid: async () => undefined,
      killTree,
      killPid: vi.fn(async () => {}),
      ...FAST,
    });

    expect(report).toEqual({ rootDead: true, survivors: [], verified: false });
    expect(formatTerminationWarning(report)).toMatch(
      /could not verify process-tree termination/,
    );
  });
});

describe("terminateProcessTree on POSIX", () => {
  it("terminates every recorded descendant before reporting success", async () => {
    const proc = makeFakeProc(100);
    const state = makeTable([
      [100, 1],
      [200, 100],
      [300, 200],
    ]);
    proc.kill = vi.fn(() => {
      state.remove(100);
      proc.exitCode = 1;
      proc.emit("exit", 1);
      return true;
    });
    const killPid = vi.fn(async (pid: number) => state.remove(pid));

    const report = await terminateProcessTree(asChildProcess(proc), {
      platform: "linux",
      listPidPpid: state.listPidPpid,
      killPid,
      ...FAST,
    });

    expect(killPid).toHaveBeenCalledWith(300);
    expect(killPid).toHaveBeenCalledWith(200);
    expect(state.table.size).toBe(0);
    expect(report).toEqual({ rootDead: true, survivors: [], verified: true });
  });

  it("escalates SIGTERM to SIGKILL after the grace and confirms the exit", async () => {
    const proc = makeFakeProc(100);
    const state = makeTable([[100, 1]]);
    proc.kill = vi.fn((signal: NodeJS.Signals) => {
      if (signal === "SIGKILL") {
        state.remove(100);
        proc.exitCode = null;
        proc.signalCode = "SIGKILL";
        proc.emit("exit", null);
      }
      return true;
    });

    const report = await terminateProcessTree(asChildProcess(proc), {
      platform: "linux",
      graceMs: 20,
      listPidPpid: state.listPidPpid,
      ...FAST,
    });

    expect(proc.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(proc.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    expect(report).toEqual({ rootDead: true, survivors: [], verified: true });
  });

  it("skips SIGKILL when the child exits within the grace", async () => {
    const proc = makeFakeProc(100);
    const state = makeTable([[100, 1]]);
    proc.kill = vi.fn((signal: NodeJS.Signals) => {
      if (signal === "SIGTERM") {
        setTimeout(() => {
          state.remove(100);
          proc.exitCode = 0;
          proc.emit("exit", 0);
        }, 5);
      }
      return true;
    });

    const report = await terminateProcessTree(asChildProcess(proc), {
      platform: "linux",
      graceMs: 100,
      listPidPpid: state.listPidPpid,
      ...FAST,
    });

    expect(proc.kill).toHaveBeenCalledTimes(1);
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
    expect(report.rootDead).toBe(true);
  });
});

describe("collectTree", () => {
  it("walks descendants breadth-first from the root", () => {
    const table = new Map<number, number>([
      [100, 1],
      [200, 100],
      [300, 200],
      [400, 100],
      [999, 1],
    ]);
    expect(collectTree(100, table).sort()).toEqual([100, 200, 300, 400].sort());
  });

  it("is safe against parent-PID cycles fabricated by PID reuse", () => {
    const table = new Map<number, number>([
      [100, 200],
      [200, 100],
    ]);
    expect(collectTree(100, table).sort()).toEqual([100, 200].sort());
  });

  it("omits a dead root but still returns orphans chained to it", () => {
    const table = new Map<number, number>([
      [200, 100],
      [300, 200],
    ]);
    expect(collectTree(100, table)).toEqual([200, 300]);
  });
});

// Real-process integration proof of the ADR 0020 defect and fix: a
// parent that spawns a grandchild — the shim shape that survived every
// production kill. win32 only: the POSIX path deliberately signals the
// direct child alone (see kill-tree.ts).
describe.runIf(process.platform === "win32")(
  "terminateProcessTree against real Windows processes",
  () => {
    function isAlive(pid: number): boolean {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    }

    it(
      "kills a real parent AND its grandchild, and both are verifiably gone",
      { timeout: 240_000 },
      async () => {
        const { spawn: realSpawn } = await import("node:child_process");
        // Parent prints the grandchild's PID, then both idle for 60s —
        // only a working tree kill can end them.
        const parentScript = [
          "const cp = require('child_process');",
          "const g = cp.spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], {stdio: 'ignore'});",
          "console.log('grandchild=' + g.pid);",
          "setTimeout(()=>{}, 60000);",
        ].join(" ");
        const proc = realSpawn(process.execPath, ["-e", parentScript], {
          stdio: ["ignore", "pipe", "ignore"],
        });

        const grandchildPid = await new Promise<number>((resolve, reject) => {
          let out = "";
          const timer = setTimeout(
            () => reject(new Error(`no grandchild pid in: ${out}`)),
            15_000,
          );
          proc.stdout!.on("data", (chunk: Buffer) => {
            out += chunk.toString();
            const match = /grandchild=(\d+)/.exec(out);
            if (match) {
              clearTimeout(timer);
              resolve(Number(match[1]));
            }
          });
        });
        expect(isAlive(proc.pid!)).toBe(true);
        expect(isAlive(grandchildPid)).toBe(true);

        const report = await terminateProcessTree(proc);

        expect(report.rootDead).toBe(true);
        expect(report.verified).toBe(true);
        expect(report.survivors).toEqual([]);
        // Independent proof, not just the report's word: the pre-fix
        // mechanism (SIGTERM on the parent) left exactly this
        // grandchild running.
        expect(isAlive(proc.pid!)).toBe(false);
        expect(isAlive(grandchildPid)).toBe(false);
      },
    );
  },
);


describe("parsePidPpidOutput", () => {
  it("parses pid/ppid pairs from both Windows (CRLF) and POSIX (ps, right-aligned) output", () => {
    const windows = "100 1\r\n200 100\r\n\r\n";
    expect([...parsePidPpidOutput(windows)]).toEqual([
      [100, 1],
      [200, 100],
    ]);

    // `ps -A -o pid=,ppid=` right-aligns columns with leading spaces.
    const posix = "    1     0\n  512     1\n 1024   512\n";
    expect([...parsePidPpidOutput(posix)]).toEqual([
      [1, 0],
      [512, 1],
      [1024, 512],
    ]);
  });

  it("ignores malformed lines", () => {
    const noisy = "header\n100 1\nnot a pid\n200\n300 100 extra\n";
    expect([...parsePidPpidOutput(noisy)]).toEqual([[100, 1]]);
  });
});

/**
 * `terminatePidTree` is the handle-less path worktree teardown needs
 * (issue #102 / ADR 0035): an invocation has settled, so its
 * `ChildProcess` is useless, but an orphaned descendant still holds
 * handles inside the worktree.
 */
describe("terminatePidTree", () => {
  it("kills the orphaned descendants of a root that is already gone", async () => {
    // Root 100 is dead; 200 and 300 survive it with stale parent PIDs.
    const state = makeTable([
      [200, 100],
      [300, 200],
      [999, 1],
    ]);
    const killTree = vi.fn(async (pid: number) => {
      expect(pid).toBe(100);
      state.remove(200, 300);
    });
    const killPid = vi.fn(async () => {});

    const report = await terminatePidTree(100, {
      platform: "win32",
      listPidPpid: state.listPidPpid,
      killTree,
      killPid,
      ...FAST,
    });

    expect(killTree).toHaveBeenCalledTimes(1);
    expect(report).toEqual({ rootDead: true, survivors: [], verified: true });
    expect(state.table.has(999)).toBe(true);
  });

  it("is a no-op when nothing of the tree is left", async () => {
    const state = makeTable([[999, 1]]);
    const killTree = vi.fn(async () => {});

    const report = await terminatePidTree(100, {
      platform: "win32",
      listPidPpid: state.listPidPpid,
      killTree,
      killPid: async () => {},
      ...FAST,
    });

    expect(killTree).not.toHaveBeenCalled();
    expect(report).toEqual({ rootDead: true, survivors: [], verified: true });
  });

  it("reports survivors it could not kill", async () => {
    const state = makeTable([[200, 100]]);

    const report = await terminatePidTree(100, {
      platform: "win32",
      listPidPpid: state.listPidPpid,
      killTree: async () => {},
      killPid: async () => {},
      ...FAST,
    });

    expect(report.survivors).toEqual([200]);
    expect(report.verified).toBe(true);
    expect(formatTerminationWarning(report)).toContain("PIDs 200");
  });

  it("never claims a confirmed kill when the process table is unavailable", async () => {
    const report = await terminatePidTree(100, {
      platform: "win32",
      listPidPpid: async () => undefined,
      killTree: async () => {},
      killPid: async () => {},
      ...FAST,
    });

    expect(report).toEqual({
      rootDead: false,
      survivors: [],
      verified: false,
    });
  });
});

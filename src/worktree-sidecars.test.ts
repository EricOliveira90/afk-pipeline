import { describe, expect, it } from "vitest";
import type { ProcessPathRow } from "./kill-tree.js";
import type { TerminationReport } from "./kill-tree.js";
import {
  findDetachedSidecars,
  formatSidecarDetail,
  isDetachedSidecarRow,
  sweepDetachedSidecars,
  type SidecarSweepReport,
} from "./worktree-sidecars.js";

// Issue #166 / ADR 0058: the codex OTel supervisor pair is identified by
// name because nothing else about it is observable — its argv names no
// worktree path and Win32_Process exposes no cwd. These rows mirror the
// live pair captured on 2026-09-06.
const SUPERVISOR: ProcessPathRow = {
  pid: 4196,
  name: "codex.exe",
  executablePath:
    "C:\\Users\\u\\AppData\\Local\\Toolbox\\tools\\codex\\0.153.4.427\\bin\\codex.exe",
  commandLine:
    '"\\\\?\\C:\\Users\\u\\AppData\\Local\\Toolbox\\tools\\codex\\0.153.4.427\\bin\\codex.exe" __otel-server',
};

const COLLECTOR: ProcessPathRow = {
  pid: 2288,
  name: "otelcol-contrib.exe",
  executablePath:
    "C:\\Users\\u\\AppData\\Local\\Toolbox\\tools\\codex\\0.153.4.427\\otelcol-contrib.exe",
  commandLine: '"otelcol-contrib.exe" --config "yaml:receivers: ..."',
};

/** A working codex agent invocation — must never be swept. */
const WORKING_CODEX: ProcessPathRow = {
  pid: 7001,
  name: "codex.exe",
  commandLine:
    "codex exec --json --ephemeral --dangerously-bypass-approvals-and-sandbox -",
};

const INNOCENT: ProcessPathRow = {
  pid: 7002,
  name: "node.exe",
  commandLine: "node dist/cli.js",
};

function goneReport(): TerminationReport {
  return { rootDead: true, survivors: [], verified: true };
}

describe("isDetachedSidecarRow", () => {
  it("matches the supervisor by its __otel-server argv marker", () => {
    expect(isDetachedSidecarRow(SUPERVISOR)).toBe(true);
  });

  it("matches the collector by image name, without its supervisor", () => {
    expect(isDetachedSidecarRow(COLLECTOR)).toBe(true);
    expect(
      isDetachedSidecarRow({ pid: 1, name: "otelcol-contrib" }),
    ).toBe(true);
  });

  it("never matches a working codex agent invocation", () => {
    expect(isDetachedSidecarRow(WORKING_CODEX)).toBe(false);
  });

  it("never matches unrelated processes", () => {
    expect(isDetachedSidecarRow(INNOCENT)).toBe(false);
  });

  it("does not match a name that merely contains the collector's", () => {
    expect(
      isDetachedSidecarRow({ pid: 1, name: "my-otelcol-contrib-viewer.exe" }),
    ).toBe(false);
  });
});

describe("sweepDetachedSidecars", () => {
  it("kills the supervisor before the collector and reports both", async () => {
    const killed: number[] = [];
    const report = await sweepDetachedSidecars({
      listProcesses: async () => [
        COLLECTOR,
        WORKING_CODEX,
        SUPERVISOR,
        INNOCENT,
      ],
      terminatePidTree: async (pid) => {
        killed.push(pid);
        return goneReport();
      },
    });
    // Supervisor tree-killed first so the collector dies as its child.
    expect(killed).toEqual([SUPERVISOR.pid, COLLECTOR.pid]);
    expect(report.scanned).toBe(true);
    expect(report.matched.map((m) => m.pid).sort()).toEqual([2288, 4196]);
    expect(report.terminated.sort()).toEqual([2288, 4196]);
    expect(report.survivors).toEqual([]);
  });

  it("reports an unlistable process table as scanned: false", async () => {
    const report = await sweepDetachedSidecars({
      listProcesses: async () => undefined,
      terminatePidTree: async () => {
        throw new Error("must not be called");
      },
    });
    expect(report).toEqual({
      scanned: false,
      matched: [],
      terminated: [],
      survivors: [],
    });
  });

  it("reports termination survivors instead of claiming success", async () => {
    const report = await sweepDetachedSidecars({
      listProcesses: async () => [SUPERVISOR],
      terminatePidTree: async () => ({
        rootDead: false,
        survivors: [SUPERVISOR.pid],
        verified: true,
      }),
    });
    expect(report.terminated).toEqual([]);
    expect(report.survivors).toEqual([SUPERVISOR.pid]);
  });

  it("treats an unverifiable kill as a survivor, not a success", async () => {
    const report = await sweepDetachedSidecars({
      listProcesses: async () => [COLLECTOR],
      terminatePidTree: async () => ({
        rootDead: false,
        survivors: [],
        verified: false,
      }),
    });
    expect(report.terminated).toEqual([]);
    expect(report.survivors).toEqual([COLLECTOR.pid]);
  });

  it("never throws when the terminator does", async () => {
    const report = await sweepDetachedSidecars({
      listProcesses: async () => [SUPERVISOR],
      terminatePidTree: async () => {
        throw new Error("taskkill exploded");
      },
    });
    expect(report.survivors).toEqual([SUPERVISOR.pid]);
  });

  it("finds nothing on a clean machine and says so", async () => {
    const report = await sweepDetachedSidecars({
      listProcesses: async () => [WORKING_CODEX, INNOCENT],
      terminatePidTree: async () => {
        throw new Error("must not be called");
      },
    });
    expect(report.matched).toEqual([]);
  });
});

describe("findDetachedSidecars", () => {
  it("filters a listing down to the known shapes only", () => {
    expect(
      findDetachedSidecars([COLLECTOR, WORKING_CODEX, SUPERVISOR, INNOCENT]),
    ).toEqual([COLLECTOR, SUPERVISOR]);
  });
});

describe("formatSidecarDetail", () => {
  it("names terminated sidecars", () => {
    const report: SidecarSweepReport = {
      scanned: true,
      matched: [
        { pid: 4196, name: "codex.exe" },
        { pid: 2288, name: "otelcol-contrib.exe" },
      ],
      terminated: [4196, 2288],
      survivors: [],
    };
    expect(formatSidecarDetail(report)).toBe(
      "terminated known detached sidecar(s): codex.exe (PID 4196), " +
        "otelcol-contrib.exe (PID 2288)",
    );
  });

  it("names survivors when termination did not stick", () => {
    const report: SidecarSweepReport = {
      scanned: true,
      matched: [{ pid: 4196, name: "codex.exe" }],
      terminated: [],
      survivors: [4196],
    };
    expect(formatSidecarDetail(report)).toContain("PIDs 4196");
    expect(formatSidecarDetail(report)).toContain("codex.exe (PID 4196)");
  });

  it("is silent when the sweep found nothing", () => {
    expect(
      formatSidecarDetail({
        scanned: true,
        matched: [],
        terminated: [],
        survivors: [],
      }),
    ).toBeUndefined();
  });

  it("says when it could not scan at all", () => {
    expect(
      formatSidecarDetail({
        scanned: false,
        matched: [],
        terminated: [],
        survivors: [],
      }),
    ).toBe("sidecar scan could not list the process table");
  });
});

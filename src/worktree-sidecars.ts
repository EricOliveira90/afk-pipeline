import {
  listProcessPaths,
  terminatePidTree,
  type ProcessPathRow,
} from "./kill-tree.js";

/**
 * Known detached telemetry sidecars that hold worktrees hostage. See
 * issue #166 and ADR 0058.
 *
 * The Toolbox codex wrapper spawns a machine-wide OTel collector
 * supervisor (`codex.exe __otel-server`, which itself spawns
 * `otelcol-contrib`) the first time codex runs. The supervisor is spawned
 * deliberately detached — `CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS |
 * CREATE_BREAKAWAY_FROM_JOB` on Windows, `setsid()` on POSIX — and it
 * inherits the cwd of whichever invocation won the spawn race. When that
 * invocation ran inside an AFK worktree (guardian reviews always do), the
 * pair holds the directory as its working directory forever: on Windows
 * a live cwd is an open handle, so the worktree cannot be deleted until
 * the pair dies.
 *
 * Neither existing defense can see it. ADR 0020's tree kill and ADR
 * 0035's quiesce both walk (pid -> ppid) edges from AFK's own spawn
 * roots, and on a *natural* exit the wrapper chain between the root and
 * the sidecar is gone before teardown runs — the BFS has no bridge to a
 * breakaway process whose recorded parent is dead. The preflight holder
 * scan reads argv and exe paths only; the sidecar's argv names no
 * worktree path, so it is structurally invisible there too (the caveat
 * `src/preflight.ts` prints is exactly this shape).
 *
 * So teardown identifies the pair *by name* and kills it. That is safe:
 * the pair is a singleton keyed by a lock file under the codex home, it
 * serves only telemetry, and the next codex invocation respawns it on
 * demand (with that invocation's cwd — which is why one review can
 * orphan a fresh pair right after teardown killed the last one; the
 * sweep runs at removal time, after the invocations are settled). The
 * cost of a false positive is one lost telemetry batch, not lost work.
 */

/** Substring that marks the codex OTel collector supervisor's argv. */
const OTEL_SERVER_MARKER = "__otel-server";

/** Image names of the collector the supervisor spawns. */
const COLLECTOR_NAME = /^otelcol(-contrib)?(\.exe)?$/i;

/**
 * True when the row is one of the known detached-sidecar shapes: the
 * codex OTel supervisor (any executable invoked with `__otel-server`) or
 * an `otelcol-contrib` collector. Matched independently so a collector
 * whose supervisor already died is still found.
 */
export function isDetachedSidecarRow(row: ProcessPathRow): boolean {
  if (row.commandLine?.includes(OTEL_SERVER_MARKER)) return true;
  return COLLECTOR_NAME.test(row.name);
}

/** The known-sidecar rows in a process listing. */
export function findDetachedSidecars(
  rows: readonly ProcessPathRow[],
): ProcessPathRow[] {
  return rows.filter(isDetachedSidecarRow);
}

export interface SidecarSweepReport {
  /** False when the process table could not be listed — nothing swept. */
  scanned: boolean;
  /** Known-sidecar rows found alive, before any kill. */
  matched: Array<{ pid: number; name: string }>;
  /** PIDs whose trees were confirmed gone after termination. */
  terminated: number[];
  /** PIDs still alive (or unverifiable) after termination attempts. */
  survivors: number[];
}

export interface SweepSidecarOptions {
  /** Injectable for tests. */
  listProcesses?: typeof listProcessPaths;
  /** Injectable for tests. */
  terminatePidTree?: typeof terminatePidTree;
}

/**
 * Find and terminate every known detached sidecar on the machine.
 *
 * Machine-wide by necessity: the sidecar's cwd is invisible to every
 * listing available to us, so there is no way to scope the kill to the
 * worktree being removed. Callers invoke this only after a removal has
 * actually failed with a handle-shaped error, so an idle machine never
 * pays for it and an unrelated codex session loses at most one
 * telemetry batch.
 *
 * Supervisors are tree-killed first (taking their collector child with
 * them); any collector row that still remains is then killed by its own
 * PID. Never throws — this runs inside teardown.
 */
export async function sweepDetachedSidecars(
  options: SweepSidecarOptions = {},
): Promise<SidecarSweepReport> {
  const list = options.listProcesses ?? listProcessPaths;
  const terminate = options.terminatePidTree ?? terminatePidTree;

  let rows: ProcessPathRow[] | undefined;
  try {
    rows = await list();
  } catch {
    rows = undefined;
  }
  if (rows === undefined) {
    return { scanned: false, matched: [], terminated: [], survivors: [] };
  }

  const matched = findDetachedSidecars(rows);
  const report: SidecarSweepReport = {
    scanned: true,
    matched: matched.map((row) => ({ pid: row.pid, name: row.name })),
    terminated: [],
    survivors: [],
  };

  // Supervisors first: the tree kill takes the collector child along,
  // so the collector's own pass below usually finds it already gone.
  const supervisors = matched.filter((row) =>
    row.commandLine?.includes(OTEL_SERVER_MARKER),
  );
  const collectors = matched.filter(
    (row) => !row.commandLine?.includes(OTEL_SERVER_MARKER),
  );

  for (const row of [...supervisors, ...collectors]) {
    try {
      const result = await terminate(row.pid);
      if (result.verified && result.survivors.length === 0) {
        report.terminated.push(row.pid);
      } else if (result.survivors.length > 0) {
        report.survivors.push(...result.survivors);
      } else {
        // Unverifiable listing: neither confirmed dead nor seen alive.
        report.survivors.push(row.pid);
      }
    } catch {
      report.survivors.push(row.pid);
    }
  }
  report.survivors = [...new Set(report.survivors)];
  return report;
}

/** Operator-facing sentence for a sweep that ran. */
export function formatSidecarDetail(
  report: SidecarSweepReport,
): string | undefined {
  if (!report.scanned) {
    return "sidecar scan could not list the process table";
  }
  if (report.matched.length === 0) return undefined;
  const names = report.matched
    .map((m) => `${m.name} (PID ${m.pid})`)
    .join(", ");
  if (report.survivors.length > 0) {
    return (
      `known detached sidecar(s) found holding handles — ${names} — but ` +
      `${report.survivors.length} process(es) survived termination ` +
      `(PIDs ${report.survivors.join(", ")})`
    );
  }
  return `terminated known detached sidecar(s): ${names}`;
}

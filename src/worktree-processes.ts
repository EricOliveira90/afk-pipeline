import type { ChildProcess } from "node:child_process";
import { resolve, sep } from "node:path";
import {
  collectTree,
  listPidPpid,
  terminatePidTree,
  terminateProcessTree,
  type TerminationReport,
} from "./kill-tree.js";

/**
 * Which processes are alive inside a worktree, so teardown can wait for
 * them — or terminate and confirm them — before deleting the directory.
 * See ADR 0035 and issue #102.
 *
 * The race this closes: AFK spawns agents (`invocation-runtime.ts`) and
 * gate/QA commands (`command-runtime.ts`) with `cwd` inside a slice
 * worktree. On Windows a live cwd is itself an open handle, so the
 * directory cannot be deleted while any of them runs — and neither can
 * a *descendant* the agent left behind, because natural-exit settlement
 * verifies nothing about the tree (only kills do, per ADR 0020). The old
 * teardown inferred handle release from a failed `rmSync`, which is a
 * side-effect, not an answer.
 *
 * So every spawn registers here against its `cwd`, and the entry is kept
 * after the root exits: an orphaned descendant holds handles the dead
 * root does not, and Windows keeps its recorded parent PID, so a BFS
 * from the retained root PID still finds it (ADR 0020). Entries live
 * until the worktree containing them is quiesced, which is also when
 * they are discarded — a run accumulates one small record per
 * invocation, nothing more.
 *
 * Failure posture matches the busy probe: when the process table cannot
 * be listed, quiescing reports `verified: false` rather than claiming a
 * quiet tree it could not observe, and teardown proceeds to its own
 * bounded retries.
 */

interface Entry {
  /** Absolute `cwd` the process was spawned in. */
  cwd: string;
  /** Held so a live root can be killed through its own handle. */
  proc: ChildProcess;
  pid: number;
}

const entries = new Set<Entry>();

/** Test hook: forget every registration. */
export function resetWorktreeProcessRegistry(): void {
  entries.clear();
}

/**
 * Record a process spawned with `cwd` inside (or at) a worktree. Safe to
 * call for any cwd — teardown only ever looks at the worktree it is
 * removing. A process that never got a PID (spawn failure) is ignored:
 * it holds nothing.
 */
export function registerWorktreeProcess(
  cwd: string,
  proc: ChildProcess,
): void {
  if (proc.pid === undefined) return;
  entries.add({ cwd: resolve(cwd), proc, pid: proc.pid });
}

export interface WorktreeQuiesceReport {
  /**
   * PIDs of ours still alive in the tree when the natural-exit wait
   * ended. Empty when everything finished on its own.
   */
  observed: number[];
  /** Roots (and trees) we had to terminate because they outlived the wait. */
  terminated: number[];
  /** PIDs still alive after every termination attempt. */
  survivors: number[];
  /**
   * False when the process table could not be listed, so "no survivors"
   * could not be confirmed. Mirrors `TerminationReport.verified`.
   */
  verified: boolean;
}

export interface QuiesceWorktreeOptions {
  /**
   * How long spawned processes get to exit on their own before we
   * terminate them. A gate command that is still finishing deserves to
   * finish; teardown is not a kill path by intent.
   */
  waitMs?: number;
  /** Delay between liveness polls during the natural-exit wait. */
  pollIntervalMs?: number;
  /**
   * Hard-stop (ADR 0003): a fired signal cuts the natural-exit wait
   * short and goes straight to terminate-and-confirm.
   */
  signal?: AbortSignal;
  /** Injectable for tests. */
  listPidPpid?: () => Promise<Map<number, number> | undefined>;
  /** Injectable for tests. */
  terminateProcessTree?: typeof terminateProcessTree;
  /** Injectable for tests. */
  terminatePidTree?: typeof terminatePidTree;
  /** Injectable for tests. */
  now?: () => number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_QUIESCE_WAIT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 250;

/** True when `path` is `root` itself or sits underneath it. */
export function isInsideDir(path: string, root: string): boolean {
  const a = normalisePath(path);
  const b = normalisePath(root);
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
}

function normalisePath(p: string): string {
  const abs = resolve(p);
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

function rootExited(proc: ChildProcess): boolean {
  return proc.exitCode !== null || proc.signalCode !== null;
}

/**
 * Wait for every process AFK spawned inside `worktreeDir` to be gone,
 * terminating (and confirming, per ADR 0020) whatever outlives the wait.
 *
 * Returns once nothing of ours is alive in the tree, or once termination
 * has been attempted on everything that is. Never throws: teardown runs
 * in `finally` blocks where an exception would mask the real outcome.
 */
export async function quiesceWorktree(
  worktreeDir: string,
  options: QuiesceWorktreeOptions = {},
): Promise<WorktreeQuiesceReport> {
  const waitMs = options.waitMs ?? DEFAULT_QUIESCE_WAIT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const list = options.listPidPpid ?? (() => listPidPpid());
  const terminateTree = options.terminateProcessTree ?? terminateProcessTree;
  const terminateByPid = options.terminatePidTree ?? terminatePidTree;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;

  const mine = [...entries].filter((e) => isInsideDir(e.cwd, worktreeDir));
  if (mine.length === 0) {
    return { observed: [], terminated: [], survivors: [], verified: true };
  }

  // Phase 1 — let them finish. Live root, or a dead root with surviving
  // descendants, both count as "still in there".
  const deadline = now() + waitMs;
  let alive = await aliveIn(mine, list);
  while (alive.total > 0) {
    if (options.signal?.aborted || now() >= deadline) break;
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - now())));
    alive = await aliveIn(mine, list);
  }
  const observed = [...new Set([...alive.byEntry.values()].flat())];

  if (observed.length === 0) {
    for (const entry of mine) entries.delete(entry);
    return {
      observed: [],
      terminated: [],
      survivors: [],
      verified: alive.verified,
    };
  }

  // Phase 2 — terminate and confirm what outlived the wait.
  const terminated: number[] = [];
  const survivors = new Set<number>();
  let verified = alive.verified;
  for (const entry of mine) {
    if ((alive.byEntry.get(entry) ?? []).length === 0) continue;
    terminated.push(entry.pid);
    const report: TerminationReport = rootExited(entry.proc)
      ? await terminateByPid(entry.pid)
      : await terminateTree(entry.proc);
    if (!report.verified) verified = false;
    for (const pid of report.survivors) survivors.add(pid);
    if (!report.rootDead && report.verified) survivors.add(entry.pid);
  }

  // Entries whose tree is confirmed gone are done with; anything that
  // survived stays registered so a later teardown attempt sees it again.
  for (const entry of mine) {
    if (!survivors.has(entry.pid)) entries.delete(entry);
  }

  return {
    observed,
    terminated,
    survivors: [...survivors],
    verified,
  };
}

/**
 * Live PIDs per registered entry, from one process-table listing. An
 * entry with an empty list holds nothing inside the worktree any more.
 */
async function aliveIn(
  mine: Entry[],
  list: () => Promise<Map<number, number> | undefined>,
): Promise<{ byEntry: Map<Entry, number[]>; total: number; verified: boolean }> {
  const byEntry = new Map<Entry, number[]>();
  const table = await list();
  let total = 0;
  for (const entry of mine) {
    // Unverifiable listing: fall back to what Node knows about our root.
    const pids =
      table === undefined
        ? rootExited(entry.proc)
          ? []
          : [entry.pid]
        : collectTree(entry.pid, table);
    byEntry.set(entry, pids);
    total += pids.length;
  }
  return { byEntry, total, verified: table !== undefined };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    // Deliberately ref'd: teardown waiting out a live handle is exactly
    // when the event loop must stay alive.
    setTimeout(resolve, ms);
  });
}

/** Operator-facing detail for a worktree that would not go quiet. */
export function formatQuiesceDetail(
  report: WorktreeQuiesceReport,
): string | undefined {
  if (report.survivors.length > 0) {
    return (
      `${report.survivors.length} process(es) survived termination ` +
      `(PIDs ${report.survivors.join(", ")})`
    );
  }
  if (!report.verified) {
    return "process-tree state could not be verified (process listing unavailable)";
  }
  if (report.terminated.length > 0) {
    return `terminated ${report.terminated.length} straggler process tree(s)`;
  }
  return undefined;
}

import { spawn, type ChildProcess } from "node:child_process";

/**
 * Deterministic process-tree termination. See ADR 0020.
 *
 * On Windows, `proc.kill("SIGTERM")` is an immediate `TerminateProcess`
 * of the DIRECT child only — for our agents that is a Toolbox shim
 * (`Toolbox\bin\kiro-cli.exe`) or a `cmd.exe` wrapper, never the real
 * worker. The shim dies, `exit` fires, the invocation settles, and the
 * real agent tree keeps running as orphans that hold the inherited
 * stdio pipe ends open (which can wedge the orchestrator's event loop
 * at exit). A kill on Windows must therefore be tree-first — `taskkill
 * /T /F` while the root is still alive so the tree walk can enumerate
 * descendants — and must be VERIFIED afterwards, because a "successful"
 * kill that leaves survivors is exactly the failure mode observed in
 * production.
 *
 * Windows never rewrites a process's recorded parent PID when the
 * parent dies, so a BFS over (pid, ppid) pairs rooted at the original
 * child still finds orphaned descendants even after the root is gone —
 * that is what makes post-kill verification (and cleanup of stragglers)
 * possible at all.
 *
 * On POSIX there is a real SIGTERM, so the child gets a grace period
 * before SIGKILL. The grace timer is a plain (ref'd) timer: a kill in
 * progress is precisely the situation where keeping the event loop
 * alive is correct. Nothing here relies on an `unref`'d timer firing.
 */

export interface TerminationReport {
  /** True when the direct child is confirmed dead. */
  rootDead: boolean;
  /**
   * PIDs from the child's process tree that were still alive after all
   * kill attempts.
   */
  survivors: number[];
  /**
   * False when the process table could not be listed (e.g. PowerShell
   * unavailable) and the tree outcome is therefore unknown beyond what
   * Node reports about the direct child.
   */
  verified: boolean;
}

export interface TerminateOptions {
  /** POSIX only: grace between SIGTERM and SIGKILL. */
  graceMs?: number;
  /** Delay between verification polls of the process table. */
  pollIntervalMs?: number;
  /** How long each verification phase waits for the tree to vanish. */
  confirmTimeoutMs?: number;
  /** Injectable for tests. */
  platform?: NodeJS.Platform;
  /** Injectable process-table lister: pid -> ppid, or undefined on failure. */
  listPidPpid?: () => Promise<Map<number, number> | undefined>;
  /** Injectable `taskkill /PID <pid> /T /F`. */
  killTree?: (pid: number) => Promise<void>;
  /** Injectable `taskkill /PID <pid> /F`. */
  killPid?: (pid: number) => Promise<void>;
}

const DEFAULT_GRACE_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 200;
const DEFAULT_CONFIRM_TIMEOUT_MS = 5_000;

/** One-line operator-facing warning for a kill that cannot be trusted. */
export function formatTerminationWarning(report: TerminationReport): string {
  if (!report.verified) {
    return (
      "WARNING: could not verify process-tree termination (process " +
      "listing unavailable) — orphaned agent processes may still be running"
    );
  }
  if (report.survivors.length > 0) {
    return (
      `WARNING: ${report.survivors.length} process(es) survived the kill ` +
      `(PIDs ${report.survivors.join(", ")}) — terminate them manually ` +
      `(taskkill /PID <pid> /T /F)`
    );
  }
  return "";
}

/**
 * Kill a child process and its whole tree, then confirm the kill.
 * Resolves only after termination has been verified (or verification
 * has conclusively failed). Never rejects.
 */
export async function terminateProcessTree(
  proc: ChildProcess,
  options: TerminateOptions = {},
): Promise<TerminationReport> {
  const platform = options.platform ?? process.platform;
  const resolved: Required<Omit<TerminateOptions, "platform">> = {
    graceMs: options.graceMs ?? DEFAULT_GRACE_MS,
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    confirmTimeoutMs: options.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS,
    listPidPpid:
      options.listPidPpid ?? (() => listPidPpid(platform)),
    killTree: options.killTree ?? defaultKillTree,
    killPid:
      options.killPid ??
      (platform === "win32" ? defaultKillPid : defaultKillPidPosix),
  };
  try {
    if (platform === "win32") return await terminateWin32(proc, resolved);
    return await terminatePosix(proc, resolved);
  } catch {
    // Best effort — a kill helper must never throw into a kill path.
    return { rootDead: rootExited(proc), survivors: [], verified: false };
  }
}

type ResolvedOptions = Required<Omit<TerminateOptions, "platform">>;

async function terminateWin32(
  proc: ChildProcess,
  o: ResolvedOptions,
): Promise<TerminationReport> {
  const root = proc.pid;
  if (root === undefined) {
    // spawn failed before a PID existed — nothing to kill.
    return { rootDead: true, survivors: [], verified: true };
  }

  // Snapshot the tree BEFORE killing: `taskkill /T` walks the live tree,
  // and verification needs to know which PIDs to check afterwards.
  const table = await o.listPidPpid();
  const snapshot = table ? collectTree(root, table) : [root];

  return killAndConfirmTree(root, snapshot, () => rootExited(proc), o);
}

/**
 * Kill a process tree identified only by its root PID, then verify.
 *
 * The handle-less sibling of `terminateProcessTree`, for callers that
 * hold a PID but no `ChildProcess` — worktree teardown (issue #102)
 * sweeps the descendants of invocations that have already settled, whose
 * child handle is long gone but whose orphans can still hold file
 * handles inside the tree. Windows keeps an orphan's recorded parent PID
 * after the parent dies, which is what makes that BFS possible (see the
 * module doc). `rootDead` is reported from the process table alone, so
 * an unverifiable listing reports `false` rather than guessing.
 */
export async function terminatePidTree(
  root: number,
  options: TerminateOptions = {},
): Promise<TerminationReport> {
  const platform = options.platform ?? process.platform;
  const o: ResolvedOptions = {
    graceMs: options.graceMs ?? DEFAULT_GRACE_MS,
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    confirmTimeoutMs: options.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS,
    listPidPpid: options.listPidPpid ?? (() => listPidPpid(platform)),
    killTree: options.killTree ?? defaultKillTree,
    killPid:
      options.killPid ??
      (platform === "win32" ? defaultKillPid : defaultKillPidPosix),
  };
  try {
    const table = await o.listPidPpid();
    if (table !== undefined && !table.has(root)) {
      // Nothing left of this tree to kill.
      const orphans = collectTree(root, table);
      if (orphans.length === 0) {
        return { rootDead: true, survivors: [], verified: true };
      }
    }
    const snapshot = table ? collectTree(root, table) : [root];
    if (platform !== "win32") {
      for (const pid of [...snapshot].reverse()) await o.killPid(pid);
      return killAndConfirmTree(root, snapshot, () => false, o, false);
    }
    return killAndConfirmTree(root, snapshot, () => false, o);
  } catch {
    // A kill helper must never throw into a kill path.
    return { rootDead: false, survivors: [root], verified: false };
  }
}

/**
 * `taskkill /T /F` the root (when asked), confirm the whole tree is
 * gone, then force-kill and re-confirm any straggler — e.g. an orphan
 * whose parent died between the snapshot and taskkill's own tree walk.
 */
async function killAndConfirmTree(
  root: number,
  snapshot: number[],
  rootExitedFallback: () => boolean,
  o: ResolvedOptions,
  killTreeFirst = true,
): Promise<TerminationReport> {
  if (killTreeFirst) await o.killTree(root);
  let report = await confirmGone(rootExitedFallback, root, snapshot, o);
  if (report.verified && report.survivors.length > 0) {
    for (const pid of report.survivors) {
      await o.killPid(pid);
    }
    report = await confirmGone(rootExitedFallback, root, report.survivors, o);
  }
  return report;
}

async function terminatePosix(
  proc: ChildProcess,
  o: ResolvedOptions,
): Promise<TerminationReport> {
  const root = proc.pid;
  if (root === undefined) {
    return { rootDead: true, survivors: [], verified: true };
  }

  const table = await o.listPidPpid();
  if (table === undefined) {
    await terminatePosixRoot(proc, o);
    return {
      rootDead: rootExited(proc),
      survivors: rootExited(proc) ? [] : [root],
      verified: false,
    };
  }

  const snapshot = collectTree(root, table);
  for (const pid of [...snapshot].reverse()) {
    if (pid !== root) await o.killPid(pid);
  }
  await terminatePosixRoot(proc, o);
  return confirmGone(() => rootExited(proc), root, snapshot, o);
}

async function terminatePosixRoot(
  proc: ChildProcess,
  o: ResolvedOptions,
): Promise<void> {
  if (!rootExited(proc)) {
    try {
      proc.kill("SIGTERM");
    } catch {
      // Already gone.
    }
    if (!(await waitForExit(proc, o.graceMs))) {
      try {
        proc.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      await waitForExit(proc, o.confirmTimeoutMs);
    }
  }
}

/**
 * Poll the process table until every PID belonging to the tree is gone
 * or the confirmation window closes. Survivors are the union of the
 * pre-kill snapshot and a fresh BFS from the root (stale parent PIDs
 * keep orphan chains navigable on Windows).
 */
async function confirmGone(
  rootExitedFallback: () => boolean,
  root: number,
  snapshot: number[],
  o: ResolvedOptions,
): Promise<TerminationReport> {
  const deadline = Date.now() + o.confirmTimeoutMs;
  for (;;) {
    const table = await o.listPidPpid();
    if (table === undefined) {
      // Verification is unavailable — report only what the caller knows
      // about the root from outside the process table.
      return { rootDead: rootExitedFallback(), survivors: [], verified: false };
    }
    const inTree = collectTree(root, table);
    const alive = [
      ...new Set([...inTree, ...snapshot.filter((pid) => table.has(pid))]),
    ];
    if (alive.length === 0 || Date.now() >= deadline) {
      return { rootDead: !alive.includes(root), survivors: alive, verified: true };
    }
    await sleep(o.pollIntervalMs);
  }
}

/**
 * BFS over (pid -> ppid) pairs from `root`. Includes the root itself
 * when it is still in the table. Cycle-safe (PID reuse can fabricate
 * parent loops).
 */
export function collectTree(
  root: number,
  table: Map<number, number>,
): number[] {
  const children = new Map<number, number[]>();
  for (const [pid, ppid] of table) {
    if (pid === ppid) continue;
    const list = children.get(ppid);
    if (list) list.push(pid);
    else children.set(ppid, [pid]);
  }
  const result: number[] = table.has(root) ? [root] : [];
  const queue = [root];
  const seen = new Set<number>([root]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const child of children.get(current) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      result.push(child);
      queue.push(child);
    }
  }
  return result;
}

function rootExited(proc: ChildProcess): boolean {
  return proc.exitCode !== null || proc.signalCode !== null;
}

function waitForExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (rootExited(proc)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    // Deliberately NOT unref'd — see module doc.
    const timer = setTimeout(() => {
      proc.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    proc.once("exit", onExit);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run a command, collect stdout; never throws. */
function runCollect(
  command: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch {
      resolve({ ok: false, stdout: "" });
      return;
    }
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on("error", () => resolve({ ok: false, stdout: "" }));
    child.on("close", (code) => resolve({ ok: code === 0, stdout }));
  });
}

/**
 * Parse `pid ppid` pairs (one per line) into a table. Shared by the
 * PowerShell (Windows) and `ps` (POSIX) listers — both are coerced to
 * this format at the command line.
 */
export function parsePidPpidOutput(stdout: string): Map<number, number> {
  const table = new Map<number, number>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^(\d+)\s+(\d+)$/.exec(line.trim());
    if (match) table.set(Number(match[1]), Number(match[2]));
  }
  return table;
}

/**
 * List every process as (pid -> ppid) via CIM. PowerShell rather than
 * `wmic` (removed from current Windows 11) or `tasklist` (localized
 * output). Returns undefined when the listing fails.
 */
async function listPidPpidWin32(): Promise<Map<number, number> | undefined> {
  const result = await runCollect("powershell", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.ParentProcessId }",
  ]);
  if (!result.ok) return undefined;
  const table = parsePidPpidOutput(result.stdout);
  return table.size > 0 ? table : undefined;
}

/** POSIX equivalent of the CIM listing, via `ps`. */
async function listPidPpidPosix(): Promise<Map<number, number> | undefined> {
  const result = await runCollect("ps", ["-A", "-o", "pid=,ppid="]);
  if (!result.ok) return undefined;
  const table = parsePidPpidOutput(result.stdout);
  return table.size > 0 ? table : undefined;
}

/**
 * Cross-platform process-table lister. Used by the kill verifier below
 * and by the busy probe (src/busy-probe.ts) that defers idle kills
 * while an agent's spawned command is still running.
 */
export async function listPidPpid(
  platform: NodeJS.Platform = process.platform,
): Promise<Map<number, number> | undefined> {
  return platform === "win32" ? listPidPpidWin32() : listPidPpidPosix();
}

async function defaultKillTree(pid: number): Promise<void> {
  // Exit code intentionally ignored: "process not found" is success here.
  await runCollect("taskkill", ["/PID", String(pid), "/T", "/F"]);
}

async function defaultKillPid(pid: number): Promise<void> {
  await runCollect("taskkill", ["/PID", String(pid), "/F"]);
}

async function defaultKillPidPosix(pid: number): Promise<void> {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

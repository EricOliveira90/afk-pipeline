import { collectTree, listPidPpid } from "./kill-tree.js";

/**
 * Detects "the agent is silently running a command" vs "the agent is
 * hung". See ADR 0021 and issue #14.
 *
 * The idle watcher judges liveness by output, but generators routinely
 * shell out to test suites whose output is piped through a filter
 * (`... | Select-Object -Last N`) — a legitimately long-running suite
 * then produces zero stdout until completion and used to be
 * indistinguishable from a wedged session, guaranteeing an idle kill
 * at the timeout.
 *
 * The probe answers the distinction at the process level: shortly
 * after spawn it snapshots the agent's process tree (the CLI shim, the
 * real CLI, its helpers — the "quiescent baseline"). When the idle
 * timeout later fires, `check()` re-lists the tree; any live PID that
 * was NOT in the baseline is a process the agent started afterwards —
 * i.e. a running command — and the kill is deferred. A wedged agent
 * whose tree never grew beyond its baseline is killed exactly as
 * before. The wall-clock ceiling (ADR 0019) still bounds the total
 * invocation either way, so a spawned-but-also-hung command cannot
 * defer forever.
 *
 * Failure posture is conservative: when the process table cannot be
 * listed, or the baseline was never captured, `check()` reports 0 new
 * descendants and the idle kill proceeds — exactly the pre-probe
 * behavior.
 */

export interface BusyProbe {
  /**
   * Number of live processes in the agent's tree that were not present
   * in the baseline snapshot. 0 when idle, unverifiable, or the root
   * process never had a PID.
   */
  check(): Promise<number>;
}

export interface BusyProbeOptions {
  /**
   * How long after creation the baseline snapshot is taken. Long
   * enough for the CLI's own helper processes to settle, short enough
   * that a real agent command (which requires a full model round-trip
   * first) can't start before it. The baseline timer is unref'd.
   */
  baselineDelayMs?: number;
  /** Injectable for tests. */
  listPidPpid?: () => Promise<Map<number, number> | undefined>;
}

export const DEFAULT_BASELINE_DELAY_MS = 5_000;

export function createBusyProbe(
  pid: number | undefined,
  options: BusyProbeOptions = {},
): BusyProbe {
  const list = options.listPidPpid ?? (() => listPidPpid());
  const baselineDelayMs =
    options.baselineDelayMs ?? DEFAULT_BASELINE_DELAY_MS;

  let baseline: Set<number> | undefined;

  if (pid !== undefined) {
    const timer = setTimeout(() => {
      void list().then((table) => {
        if (table !== undefined) {
          baseline = new Set(collectTree(pid, table));
        }
      });
    }, baselineDelayMs);
    timer.unref();
  }

  return {
    async check(): Promise<number> {
      if (pid === undefined || baseline === undefined) return 0;
      const table = await list();
      if (table === undefined) return 0;
      const tree = collectTree(pid, table);
      let fresh = 0;
      for (const p of tree) {
        if (!baseline.has(p)) fresh++;
      }
      return fresh;
    },
  };
}

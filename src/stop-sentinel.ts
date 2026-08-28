/**
 * The stop button that does not depend on signal delivery: a file the
 * run polls for, and the acknowledgement it writes back.
 *
 * ADR 0040 made every stop signal reach the same abort path and made the
 * cancellation record contemporaneous with the request. It could not make
 * the signal *arrive*. Run 3 of the v2 recovery evidence
 * (`docs/specs/afk-v2-recovery-plan.md`, "CTRL_C into a detached run is
 * unreliable") measured the remaining gap on Windows:
 * `AttachConsole` + `GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0)` returned
 * success **twice** while the orchestrator kept running, and the delivery
 * that finally worked — `CTRL_BREAK_EVENT` at the parent console group —
 * left no cancellation record at all.
 *
 * A file needs no console, no process group and no PID. The operator
 * writes it, the run notices on its next poll, and from there the stop is
 * ADR 0040's stop exactly: the same `AbortController`, the same abort
 * listener, the same CANCELLED run-state records written before the
 * wind-down begins. Nothing about cancellation semantics is new here —
 * only the delivery.
 *
 * ## Where the sentinel lives, and why there
 *
 * `<runDir>/stop.request`, where `runDir` is the per-run log directory
 * (`.afk/logs/<run-slug>/run-<timestamp>/`, ADR 0017). The run directory
 * name *is* the run ID, so the path is run-namespaced by construction:
 * a sentinel a crashed `afk stop` left behind names a directory that no
 * future run will ever be handed, because `runDirNameFor` never reuses a
 * name. A stale sentinel cannot abort the next launch, and that property
 * comes from the layout rather than from a check that could be wrong.
 *
 * Two cheap belts on top of it:
 *
 * - The file records the run ID it was written for, and a poller ignores
 *   a request naming a different run (`decideStopRequest`). This only
 *   catches hand-copied or hand-edited run directories, which is exactly
 *   when a structural guarantee stops being one.
 * - A run clears its own directory's sentinel and ack at launch
 *   (`clearStopSentinel`), so "no live poller ever sees a stale request"
 *   holds unconditionally instead of resting on the uniqueness of a
 *   directory name.
 *
 * Sweeping stale sentinels out of *other* runs' directories is not
 * needed and deliberately absent: nothing polls a finished run's
 * directory, so those files are inert. Preflight housekeeping is a
 * separate job.
 *
 * ## The acknowledgement
 *
 * The run writes `<runDir>/stop.ack` **after** the abort path has
 * returned, which is after the abort listener has synchronously written
 * the CANCELLED records (ADR 0040). So the ack carries a real guarantee
 * for `afk stop` to report: if it exists, the bookkeeping the previous
 * stop mechanism lost is already on disk. Absence of an ack means only
 * that — not that the run ignored the request.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

/** Sentinel written by `afk stop`, polled by the run. */
export const STOP_REQUEST_FILE = "stop.request";

/** Written by the run once the abort path has fired. */
export const STOP_ACK_FILE = "stop.ack";

/**
 * How often a run checks for the sentinel: one `existsSync` per tick,
 * and a `readFileSync` only on the tick that finds one. Two seconds is
 * chosen against what the operator is waiting for — a stop that takes
 * effect inside a couple of seconds reads as immediate — and the cost is
 * a stat every two seconds against a path the OS has cached.
 */
export const STOP_SENTINEL_POLL_INTERVAL_MS = 2_000;

/** What `afk stop` writes. */
export interface StopRequest {
  /** Run directory name the request targets — see the module doc. */
  runId: string;
  /** ISO-8601, stamped by the writer. */
  requestedAt: string;
  /** What asked for the stop, for the run log. */
  source?: string;
}

/** What the run writes back once it has fired the abort path. */
export interface StopAck {
  runId: string;
  /** Echoed from the request, so a reader can pair the two. */
  requestedAt?: string;
  acknowledgedAt: string;
  /** Slice ids marked CANCELLED in run state by the abort listener. */
  cancelledSlices: string[];
}

export type StopDecision =
  /** No sentinel — the overwhelmingly common tick. */
  | { stop: false; reason: "absent" }
  /** A sentinel for some other run: not ours to act on. */
  | { stop: false; reason: "other-run"; targetRunId: string }
  /** Stop, with the request that asked for it. */
  | { stop: true; reason: "requested"; request: StopRequest }
  /** Stop, but the request could not be read — see `decideStopRequest`. */
  | { stop: true; reason: "unreadable"; detail: string };

/** The run ID is the run directory's name (ADR 0017). */
export function runIdFor(runDir: string): string {
  return basename(runDir);
}

export function stopRequestPath(runDir: string): string {
  return join(runDir, STOP_REQUEST_FILE);
}

export function stopAckPath(runDir: string): string {
  return join(runDir, STOP_ACK_FILE);
}

/**
 * Whether the sentinel's contents mean "stop this run".
 *
 * A file that is present but unparseable still stops the run. The path is
 * private to one run directory and nothing but `afk stop` writes it, so
 * the realistic cause of garbage is a torn write from an operator who did
 * ask to stop — and the two outcomes are not symmetric. Stopping on a bad
 * read costs a run that ends early with its work committed on slice
 * branches and its records written; ignoring one costs an operator who
 * asked twice, was told nothing, and reaches for the hard kill that
 * ADR 0040 exists to make unnecessary.
 *
 * A request naming a *different* run is the one case that does not stop:
 * that is not a damaged instruction, it is an instruction addressed to
 * somebody else.
 */
export function decideStopRequest(
  runId: string,
  raw: string | null,
): StopDecision {
  if (raw === null) return { stop: false, reason: "absent" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      stop: true,
      reason: "unreadable",
      detail: "sentinel is not valid JSON",
    };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return {
      stop: true,
      reason: "unreadable",
      detail: "sentinel is not a JSON object",
    };
  }
  const request = parsed as Partial<StopRequest>;
  if (typeof request.runId !== "string" || request.runId === "") {
    return {
      stop: true,
      reason: "unreadable",
      detail: "sentinel names no run",
    };
  }
  if (request.runId !== runId) {
    return { stop: false, reason: "other-run", targetRunId: request.runId };
  }
  return {
    stop: true,
    reason: "requested",
    request: {
      runId: request.runId,
      requestedAt:
        typeof request.requestedAt === "string" ? request.requestedAt : "",
      ...(typeof request.source === "string" ? { source: request.source } : {}),
    },
  };
}

/**
 * One poll: an `existsSync` on every tick, a `readFileSync` only on the
 * tick that finds a sentinel. A file that vanishes between the two reads
 * as absent rather than throwing — `afk stop` never deletes its own
 * request, but a run that ends and gets cleaned up underneath us can.
 */
export function pollStopSentinel(runDir: string): StopDecision {
  const path = stopRequestPath(runDir);
  if (!existsSync(path)) return { stop: false, reason: "absent" };
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return { stop: false, reason: "absent" };
  }
  return decideStopRequest(runIdFor(runDir), raw);
}

/** Write the sentinel for `runDir`. Used by `afk stop`. */
export function writeStopRequest(
  runDir: string,
  request: Omit<StopRequest, "runId"> & { runId?: string },
): StopRequest {
  const full: StopRequest = {
    runId: request.runId ?? runIdFor(runDir),
    requestedAt: request.requestedAt,
    ...(request.source ? { source: request.source } : {}),
  };
  writeFileSync(stopRequestPath(runDir), JSON.stringify(full, null, 2) + "\n");
  return full;
}

export function readStopRequest(runDir: string): StopRequest | null {
  const decision = pollStopSentinel(runDir);
  return decision.stop && decision.reason === "requested"
    ? decision.request
    : null;
}

/** Best-effort: a failed ack must not derail the cancellation it reports. */
export function writeStopAck(runDir: string, ack: StopAck): boolean {
  try {
    writeFileSync(stopAckPath(runDir), JSON.stringify(ack, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}

export function readStopAck(runDir: string): StopAck | null {
  const path = stopAckPath(runDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<StopAck>;
    if (typeof parsed.acknowledgedAt !== "string") return null;
    return {
      runId: typeof parsed.runId === "string" ? parsed.runId : runIdFor(runDir),
      ...(typeof parsed.requestedAt === "string"
        ? { requestedAt: parsed.requestedAt }
        : {}),
      acknowledgedAt: parsed.acknowledgedAt,
      cancelledSlices: Array.isArray(parsed.cancelledSlices)
        ? parsed.cancelledSlices.filter(
            (id): id is string => typeof id === "string",
          )
        : [],
    };
  } catch {
    return null;
  }
}

/**
 * Remove this run directory's sentinel and ack, and report what was
 * actually there. Called at launch: see the module doc on why the answer
 * should always be "nothing", and why the run does not rely on that.
 */
export function clearStopSentinel(runDir: string): string[] {
  const removed: string[] = [];
  for (const file of [STOP_REQUEST_FILE, STOP_ACK_FILE]) {
    const path = join(runDir, file);
    if (!existsSync(path)) continue;
    try {
      rmSync(path, { force: true });
      removed.push(file);
    } catch {
      // Best effort. A sentinel we cannot delete would stop this run
      // immediately, which is loud rather than silent — and the run ID
      // check means it can only do so if it also names this run.
    }
  }
  return removed;
}

export interface StopSentinelWatcher {
  /**
   * One poll. Returns the decision so a caller can drive the watcher
   * directly instead of waiting on the timer. Fires `onStop` at most
   * once per watcher: the abort path is idempotent but the CLI's second
   * stop request is an escalation to a hard exit, so a poller that kept
   * re-firing would turn one `afk stop` into a kill two seconds later.
   */
  tick(): StopDecision;
  /** Clear the timer. Idempotent. */
  stop(): void;
}

export interface StopSentinelWatcherOptions {
  runDir: string;
  /** Fired at most once, on the first tick that decides to stop. */
  onStop: (decision: Extract<StopDecision, { stop: true }>) => void;
  /** Fired for a sentinel addressed to another run — reported, not acted on. */
  onOtherRun?: (targetRunId: string) => void;
  intervalMs?: number;
  /** Injected in tests; defaults to `pollStopSentinel`. */
  poll?: (runDir: string) => StopDecision;
}

/**
 * Poll `runDir` for the sentinel until it fires or the run ends.
 *
 * The timer is unref'd: a run that finishes with the watcher still
 * installed must exit anyway, and polling is never a reason to keep the
 * event loop alive. The flip side is the accepted limitation — a wedged
 * event loop never runs the tick, and the fallback there is what it is
 * today: Ctrl-Break, or a hard kill.
 */
export function createStopSentinelWatcher(
  options: StopSentinelWatcherOptions,
): StopSentinelWatcher {
  const poll = options.poll ?? pollStopSentinel;
  const intervalMs = options.intervalMs ?? STOP_SENTINEL_POLL_INTERVAL_MS;
  let fired = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  /** Report a foreign sentinel once, not every two seconds. */
  let reportedOtherRun: string | null = null;

  const watcher: StopSentinelWatcher = {
    tick() {
      if (fired) return { stop: false, reason: "absent" };
      const decision = poll(options.runDir);
      if (decision.stop) {
        fired = true;
        watcher.stop();
        options.onStop(decision);
      } else if (
        decision.reason === "other-run" &&
        reportedOtherRun !== decision.targetRunId
      ) {
        reportedOtherRun = decision.targetRunId;
        options.onOtherRun?.(decision.targetRunId);
      }
      return decision;
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };

  timer = setInterval(() => watcher.tick(), intervalMs);
  timer.unref();
  return watcher;
}

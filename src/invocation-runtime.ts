import { spawn, type ChildProcess } from "node:child_process";
import type {
  InvocationStats,
  InvokeOptions,
  InvokeResult,
  StreamEvent,
} from "./agent-provider.js";
import { CancelledError } from "./agent-provider.js";
import { createBusyProbe } from "./busy-probe.js";
import { createIdleWatcher, type IdleWatcher } from "./idle-watcher.js";
import {
  formatTerminationWarning,
  terminateProcessTree,
  type TerminationReport,
} from "./kill-tree.js";
import { registerWorktreeProcess } from "./worktree-processes.js";

const DEFAULT_IDLE_TIMEOUT_MS = 180_000;
const DEFAULT_IDLE_WARNING_INTERVAL_MS = 60_000;
const DEFAULT_MAX_DURATION_MS = 3_600_000;

export type InvocationStream = "stdout" | "stderr";

export interface InvocationExit {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface PreparedInvocation {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  shell?: boolean | string;
  stdin?: string;
  parseStreamLine?: (line: string) => StreamEvent[];
  activityFilter?: (stream: InvocationStream, text: string) => boolean;
  onOutput?: (stream: InvocationStream, text: string) => Error | undefined;
  classifyExit?: (exit: InvocationExit) => Error;
  stats?: () => InvocationStats;
  /**
   * Total provider-attributed command/tool execution time in ms, read
   * once at successful exit. Return `undefined` when attribution is
   * unavailable or incomplete — the runtime then OMITS
   * `nonCommandTimeMs` from the stats rather than inventing a value.
   * Providers typically implement this with `createCommandTimeTracker`.
   * Evidence only; the runtime never branches on the value.
   */
  commandTimeMs?: () => number | undefined;
  /**
   * Whether a provider-observed command/tool execution is open RIGHT NOW
   * — i.e. its start record has been seen and its completion record has
   * not. Gates busy-probe idle-kill deferral (ADR 0059): a live spawned
   * descendant only counts as work when a command is actually running,
   * so leftover orphans from an already-finished command can no longer
   * hold a stalled invocation past its idle timeout (issue #182).
   *
   * Providers that track command lifecycle implement this with
   * `createCommandTimeTracker().hasOpenCommand`. Providers with no
   * structured stream (kiro, ADR 0004) OMIT it, which preserves the
   * ADR 0021 descendant-only rule for them rather than guessing.
   */
  isCommandOpen?: () => boolean;
  onSettled?: () => void;
}

export type PrepareInvocation = () => PreparedInvocation;

/**
 * Accumulates provider-attributed command/tool execution intervals for
 * one invocation. Feeds `PreparedInvocation.commandTimeMs`, which the
 * runtime subtracts from the invocation wall clock to derive the
 * evidence-only `InvocationStats.nonCommandTimeMs` (see its TSDoc in
 * `agent-provider.ts` for the clock boundaries).
 *
 * Semantics:
 * - `begin(id)`/`end(id)` bracket one execution, correlated by the
 *   provider's own id. Overlapping executions are merged into a union
 *   of busy time, not summed — the derived non-command time can never
 *   go negative from parallel tools.
 * - `end` for an unknown id poisons the tracker: a completion record
 *   with no matching start means the stream's attribution cannot be
 *   trusted, so it must yield "unavailable", never "zero command
 *   time" (guardian round 2, architect A4). `begin` for an
 *   already-open id is ignored.
 * - `markUnattributable()` poisons the tracker for records that cannot
 *   be correlated (e.g. a tool record with no id).
 * - `totalMs()` returns `undefined` when poisoned or when any interval
 *   is still open — incomplete attribution yields NO value, never a
 *   guess.
 * - `hasOpenCommand()` exposes that same open-interval state as a live
 *   signal rather than an attribution verdict, for the busy-probe
 *   deferral gate (ADR 0059). Unlike `totalMs()` it is NOT affected by
 *   `markUnattributable()`: a stream whose durations cannot be summed
 *   can still say truthfully whether a bracket is currently open.
 */
export interface CommandTimeTracker {
  begin(id: string): void;
  end(id: string): void;
  markUnattributable(): void;
  totalMs(): number | undefined;
  hasOpenCommand(): boolean;
}

export function createCommandTimeTracker(
  now: () => number = Date.now,
): CommandTimeTracker {
  const open = new Set<string>();
  let busySince = 0;
  let totalMs = 0;
  let unattributable = false;
  return {
    begin(id) {
      if (open.has(id)) return;
      if (open.size === 0) busySince = now();
      open.add(id);
    },
    end(id) {
      if (!open.delete(id)) {
        // A completion with no matching start: attribution is incomplete
        // in a way this tracker cannot repair, so the whole invocation's
        // command time becomes unavailable rather than under-counted.
        unattributable = true;
        return;
      }
      if (open.size === 0) totalMs += now() - busySince;
    },
    markUnattributable() {
      unattributable = true;
    },
    totalMs() {
      if (unattributable || open.size > 0) return undefined;
      return totalMs;
    },
    hasOpenCommand() {
      return open.size > 0;
    },
  };
}

/**
 * Execute one agent invocation.
 *
 * Providers prepare only their command and policy hooks. This module owns
 * spawning, stream teeing and line framing, liveness, bounds, cancellation,
 * verified tree termination, and settlement ordering. See ADR 0030.
 */
export function runInvocation(
  options: InvokeOptions,
  prepare: PrepareInvocation,
): Promise<InvokeResult> {
  const {
    role,
    cwd,
    logStream,
    idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
    idleWarningIntervalMs = DEFAULT_IDLE_WARNING_INTERVAL_MS,
    maxToolCalls,
    maxDurationMs = DEFAULT_MAX_DURATION_MS,
    deferIdleKillWhenBusy = false,
    signal,
    onIdleWarning,
    onIdleDeferral,
    onStreamEvent,
  } = options;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CancelledError());
      return;
    }

    const invocation = prepare();
    let proc: ChildProcess;
    // Invocation clock start: taken immediately before the provider
    // process is spawned. Pairs with the `exit` observation below to
    // form the wall clock behind `nonCommandTimeMs`.
    const invocationStartedAt = Date.now();
    try {
      proc = spawn(invocation.command, invocation.args, {
        cwd,
        env: invocation.env,
        shell: invocation.shell,
        stdio: [
          invocation.stdin === undefined ? "ignore" : "pipe",
          "pipe",
          "pipe",
        ],
      });
    } catch (error) {
      invocation.onSettled?.();
      reject(error);
      return;
    }

    // Teardown of `cwd`'s worktree must wait for this tree, not race it
    // (ADR 0035 / issue #102).
    registerWorktreeProcess(cwd, proc);

    if (invocation.stdin !== undefined) {
      proc.stdin!.write(invocation.stdin);
      proc.stdin!.end();
    }

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let stdoutBuffer = "";
    let toolCallCount = 0;
    let idleTimedOut = false;
    let ceilingHit = false;
    let toolCapExceeded = false;
    let cancelled = false;
    let providerKillError: Error | undefined;
    let settled = false;
    let termination: Promise<TerminationReport> | undefined;
    let watcher: IdleWatcher | undefined;
    let ceilingTimer: ReturnType<typeof setTimeout> | undefined;
    // The busy probe is role-scoped (ADR 0037): only invocations
    // expected to run long commands opt in. Without it the idle
    // timeout kills unconditionally.
    const busyProbe = deferIdleKillWhenBusy
      ? createBusyProbe(proc.pid)
      : undefined;
    let busyDescendants = 0;

    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      watcher?.stop();
      if (ceilingTimer) clearTimeout(ceilingTimer);
      signal?.removeEventListener("abort", onAbort);
      invocation.onSettled?.();
      finish();
    };

    const releaseChildHandles = () => {
      proc.stdout?.destroy();
      proc.stderr?.destroy();
      proc.stdin?.destroy();
      proc.unref();
    };

    const killedError = (): Error => {
      if (cancelled) return new CancelledError(`Agent ${role} cancelled`);
      if (providerKillError) return providerKillError;
      if (toolCapExceeded) {
        return new Error(
          `Agent ${role} exceeded ${maxToolCalls} tool calls — killed`,
        );
      }
      if (ceilingHit) {
        return new Error(
          `Agent ${role} exceeded ${maxDurationMs / 1000}s wall-clock ceiling — killed`,
        );
      }
      if (idleTimedOut) {
        return new Error(
          `Agent ${role} idle for ${idleTimeoutMs / 1000}s — killed`,
        );
      }
      return new Error(`Agent ${role} was killed`);
    };

    const settleKill = (report: TerminationReport) =>
      settle(() => {
        releaseChildHandles();
        const error = killedError();
        const warning = formatTerminationWarning(report);
        if (warning) {
          error.message += ` — ${warning}`;
          logStream?.write(`\n${warning}\n`);
        }
        reject(error);
      });

    const stopProcess = () => {
      if (termination) return;
      termination = terminateProcessTree(proc);
      void termination.then((report) => {
        if (!report.rootDead) settleKill(report);
      });
    };

    const onAbort = () => {
      cancelled = true;
      stopProcess();
    };

    watcher = createIdleWatcher({
      idleTimeoutMs,
      idleWarningIntervalMs,
      onTimeout: () => {
        idleTimedOut = true;
        stopProcess();
      },
      onWarning: onIdleWarning,
      ...(busyProbe
        ? {
            // ADR 0059: a live descendant is necessary but no longer
            // sufficient. A descendant that outlives the command that
            // spawned it — an orphaned vitest worker, a codex
            // credential sidecar — used to hold a stalled invocation
            // alive indefinitely (issue #182, twice at ~80 min each).
            // Requiring an open command as well is decisive: it needs
            // no process-name allowlist and no CPU sampling, which
            // would kill the I/O-bound suites ADR 0021 exists to
            // protect.
            shouldDefer: async () => {
              busyDescendants = await busyProbe.check();
              if (busyDescendants === 0) return false;
              // No lifecycle signal from this provider → keep the
              // ADR 0021 descendant-only rule rather than guessing.
              if (invocation.isCommandOpen === undefined) return true;
              if (invocation.isCommandOpen()) return true;
              logStream?.write(
                `\n[afk] ${role} silent for ${idleTimeoutMs / 1000}s with ` +
                  `${busyDescendants} leftover process(es) but no command ` +
                  `running — killing as idle (ADR 0059)\n`,
              );
              return false;
            },
            onDefer: () => {
              logStream?.write(
                `\n[afk] ${role} silent for ${idleTimeoutMs / 1000}s but ` +
                  `${busyDescendants} spawned process(es) still running — ` +
                  `deferring idle kill (wall-clock ceiling still applies)\n`,
              );
              onIdleDeferral?.({
                silentSeconds: idleTimeoutMs / 1000,
                busyProcesses: busyDescendants,
              });
            },
          }
        : {}),
    });

    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();

    ceilingTimer = setTimeout(() => {
      ceilingHit = true;
      stopProcess();
    }, maxDurationMs);
    ceilingTimer.unref();

    const processLine = (rawLine: string) => {
      const line = rawLine.trim();
      if (!line || !invocation.parseStreamLine) return;
      try {
        for (const event of invocation.parseStreamLine(line)) {
          if (event.type === "tool_call") {
            watcher!.reset();
            toolCallCount++;
            // Kill only when a caller opted into a cap (no default —
            // the wall-clock ceiling is the backstop; ADR 0036). The
            // count itself always feeds InvocationStats.
            if (
              maxToolCalls !== undefined &&
              toolCallCount > maxToolCalls &&
              !toolCapExceeded
            ) {
              toolCapExceeded = true;
            }
          }
          onStreamEvent?.(event);
          if (toolCapExceeded) stopProcess();
        }
      } catch (error) {
        if (!providerKillError) {
          providerKillError =
            error instanceof Error ? error : new Error(String(error));
          stopProcess();
        }
      }
    };

    const observeOutput = (stream: InvocationStream, text: string) => {
      if (stream === "stdout") stdoutChunks.push(text);
      else stderrChunks.push(text);
      logStream?.write(text);

      const activity =
        invocation.activityFilter?.(stream, text) ?? true;
      if (activity) watcher!.reset();

      let sniffedError: Error | undefined;
      try {
        sniffedError = invocation.onOutput?.(stream, text);
      } catch (error) {
        sniffedError = error instanceof Error ? error : new Error(String(error));
      }
      if (sniffedError && !providerKillError) {
        providerKillError = sniffedError;
        stopProcess();
      }

      if (stream !== "stdout" || !invocation.parseStreamLine) return;
      stdoutBuffer += text;
      let newlineIndex: number;
      while ((newlineIndex = stdoutBuffer.indexOf("\n")) !== -1) {
        processLine(stdoutBuffer.slice(0, newlineIndex));
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      }
    };

    proc.stdout!.on("data", (chunk: Buffer) => {
      observeOutput("stdout", chunk.toString());
    });

    proc.stderr!.on("data", (chunk: Buffer) => {
      observeOutput("stderr", chunk.toString());
    });

    proc.on("error", (error) => {
      if (termination) {
        void termination.then(settleKill);
        return;
      }
      settle(() => reject(error));
    });

    proc.on("exit", (code) => {
      // Invocation clock end: taken the moment successful exit is
      // observed, before `settle` runs provider `onSettled` cleanup —
      // cleanup time is not model time (guardian round 2, architect A4).
      const invocationEndedAt = Date.now();
      if (stdoutBuffer) {
        processLine(stdoutBuffer);
        stdoutBuffer = "";
      }
      if (termination) {
        void termination.then(settleKill);
        return;
      }
      settle(() => {
        const exitCode = code ?? 1;
        const stdout = stdoutChunks.join("");
        const stderr = stderrChunks.join("");
        if (exitCode !== 0) {
          reject(
            invocation.classifyExit?.({ exitCode, stdout, stderr }) ??
              new Error(`Agent ${role} exited with code ${exitCode}`),
          );
          return;
        }
        const stats = invocation.stats?.() ?? {};
        // Evidence only (ADR 0046 amendment): derived and recorded,
        // never branched on. Omitted — not zeroed — when the provider
        // cannot attribute command time.
        const commandTime = invocation.commandTimeMs?.();
        const nonCommandTimeMs =
          commandTime === undefined
            ? undefined
            : Math.max(0, invocationEndedAt - invocationStartedAt - commandTime);
        resolve({
          exitCode,
          stdout,
          stats: {
            ...(invocation.parseStreamLine
              ? { ...stats, toolCallCount }
              : stats),
            ...(nonCommandTimeMs === undefined ? {} : { nonCommandTimeMs }),
          },
        });
      });
    });
  });
}

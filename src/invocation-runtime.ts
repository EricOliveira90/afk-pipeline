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
const DEFAULT_MAX_TOOL_CALLS = 100;
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
  onSettled?: () => void;
}

export type PrepareInvocation = () => PreparedInvocation;

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
    maxToolCalls = DEFAULT_MAX_TOOL_CALLS,
    maxDurationMs = DEFAULT_MAX_DURATION_MS,
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
    const busyProbe = createBusyProbe(proc.pid);
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
      shouldDefer: async () => {
        busyDescendants = await busyProbe.check();
        return busyDescendants > 0;
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
            if (toolCallCount > maxToolCalls && !toolCapExceeded) {
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
        resolve({
          exitCode,
          stdout,
          stats: invocation.parseStreamLine
            ? { ...stats, toolCallCount }
            : stats,
        });
      });
    });
  });
}

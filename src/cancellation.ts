/**
 * The CLI entry points' stop button: the signals that fire the run's
 * `AbortController`, and what a second one does.
 *
 * ADR 0003 gave the pipeline one cancellation path (`AbortSignal` →
 * SIGTERM to in-flight agents → CANCELLED slices) and wired SIGINT to
 * it. That wiring was Ctrl-C only, which on Windows is not enough
 * (issue #114): a run launched into its own process group never receives
 * CTRL_C_EVENT at all, so the only signal that reached the orchestrator
 * was CTRL_BREAK_EVENT — and with no SIGBREAK listener registered, Node
 * took the default action and terminated the process, skipping the abort
 * path and its bookkeeping entirely.
 *
 * Hence: every signal that can plausibly mean "stop this run" is
 * registered on the same handler.
 *
 * - `SIGINT` — Ctrl-C in a foreground console (all platforms).
 * - `SIGBREAK` — Ctrl-Break, and `GenerateConsoleCtrlEvent`
 *   (`CTRL_BREAK_EVENT`). Windows only, and the *only* console event
 *   deliverable to a process group created with
 *   `CREATE_NEW_PROCESS_GROUP` — which is what `child_process` gives a
 *   `detached: true` launch, i.e. how a babysat run is started. Ctrl-C
 *   is disabled for such a group by Windows itself, so no amount of
 *   handler registration makes `CTRL_C_EVENT` arrive.
 * - `SIGTERM` / `SIGHUP` — `kill` and terminal-close on POSIX. Windows
 *   never delivers these (a `taskkill /F` is an unconditional
 *   `TerminateProcess`, which no handler can intercept), so listening
 *   for them there is inert rather than wrong.
 *
 * The first signal cancels; a second one exits hard. That escalation is
 * only safe because cancellation bookkeeping is written *when the signal
 * fires* rather than when the wind-down finishes — see the abort
 * listener in `runPipeline`.
 *
 * One stop request does not arrive as a signal at all: `requestStop` is
 * the same button, pressed by the pipeline when it finds this run's stop
 * sentinel on disk (ADR 0043). Windows made that necessary — a detached
 * run lives in a process group the OS will not deliver `CTRL_C_EVENT` to,
 * and the API says otherwise — but it is the delivery that differs.
 * Everything past `controller.abort()` is identical whichever pressed it.
 */

/** Node's `process`, narrowed to what the installer touches. */
export interface SignalHost {
  platform: string;
  on(event: string, listener: () => void): unknown;
  off(event: string, listener: () => void): unknown;
  exit(code: number): unknown;
}

export interface CancellationOptions {
  /** Defaults to `process`; injected in tests. */
  host?: SignalHost;
  /** Defaults to `console.error` — operator-facing, so not stdout. */
  log?: (message: string) => void;
  /** Exit code for the second signal. 130 is SIGINT's shell convention. */
  hardExitCode?: number;
}

export interface CancellationHandle {
  /** Pass to `runPipeline({ signal })`. */
  readonly signal: AbortSignal;
  /** Signal names actually registered on this host. */
  readonly signals: readonly string[];
  /**
   * Press the same stop button without a signal, naming what asked.
   *
   * The pipeline calls this when it finds this run's stop sentinel — the
   * delivery mechanism for a detached run no console event reaches
   * (ADR 0043). It shares the escalation counter with the signal
   * listeners deliberately: two stop requests are two stop requests, and
   * an operator who sends both a sentinel and a Ctrl-Break has asked
   * twice.
   */
  requestStop(source: string): void;
  /** Remove the listeners once the run has finished. */
  dispose(): void;
}

/**
 * Signals wired to cancellation, in the order they are registered.
 * `SIGBREAK` is Windows-only: on POSIX the name is not a signal, so
 * registering it would create a plain event listener that never fires.
 */
export function cancellationSignalsFor(platform: string): readonly string[] {
  return platform === "win32"
    ? ["SIGINT", "SIGBREAK"]
    : ["SIGINT", "SIGTERM", "SIGHUP"];
}

/**
 * Register the stop signals and return the run's `AbortSignal`.
 *
 * The first signal aborts the controller; the second exits with
 * `hardExitCode`, on the assumption that an operator pressing it twice
 * has stopped caring about a clean wind-down.
 */
export function installCancellationSignals(
  options: CancellationOptions = {},
): CancellationHandle {
  const host = options.host ?? (process as unknown as SignalHost);
  const log = options.log ?? ((message: string) => console.error(message));
  const hardExitCode = options.hardExitCode ?? 130;

  const controller = new AbortController();
  const signals = cancellationSignalsFor(host.platform);
  let count = 0;

  /** One stop request, whatever delivered it. */
  const stop = (description: string, label: string) => {
    count++;
    if (count === 1) {
      log(`\n${description} — cancelling pipeline...`);
      controller.abort();
    } else {
      log(`Second stop request (${label}) — exiting hard.`);
      host.exit(hardExitCode);
    }
  };

  const listeners = signals.map((name) => {
    const listener = () => stop(`Received ${name}`, name);
    host.on(name, listener);
    return { name, listener };
  });

  return {
    signal: controller.signal,
    signals,
    requestStop(source: string) {
      stop(`Stop requested by ${source}`, source);
    },
    dispose() {
      for (const { name, listener } of listeners) host.off(name, listener);
    },
  };
}

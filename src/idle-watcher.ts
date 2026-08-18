/**
 * Pairs the hard idle-timeout (kill) with a periodic idle-warning
 * (informational). Reset on every chunk of activity. See CONTEXT.md
 * ("Idle warning" / "Idle timeout").
 *
 * An optional `shouldDefer` probe can veto a kill at the moment the
 * timeout fires: when it resolves true, the timers restart and
 * `onDefer` is notified instead of `onTimeout`. Providers use this
 * with the busy probe (src/busy-probe.ts) so a silent-but-working
 * agent — e.g. one running a 30-minute integration suite whose output
 * is piped through a filter — is not killed as idle. See ADR 0021.
 */
export interface IdleWatcher {
  /** Call on every stdout/stderr chunk to reset both timers. */
  reset(): void;
  /** Call once on process exit / cancellation to clear timers. */
  stop(): void;
}

export interface IdleWatcherOptions {
  idleTimeoutMs: number;
  idleWarningIntervalMs: number;
  onTimeout: () => void;
  onWarning?: (minutes: number) => void;
  /**
   * Consulted when the idle timeout fires. Resolving true defers the
   * kill: both timers restart (the warning counter keeps counting —
   * the agent genuinely is silent) and `onDefer` fires. Resolving
   * false — or rejecting — proceeds to `onTimeout`. A `reset()` or
   * `stop()` that lands while the probe is in flight invalidates its
   * outcome: fresh activity means the kill decision is stale.
   */
  shouldDefer?: () => Promise<boolean>;
  /** Informational callback for each deferred kill. */
  onDefer?: () => void;
}

export function createIdleWatcher(opts: IdleWatcherOptions): IdleWatcher {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let warningHandle: ReturnType<typeof setInterval> | null = null;
  let warningCount = 0;
  let stopped = false;
  // Bumped by every reset() and every deferral. A probe started under
  // an older generation must not decide anything: activity (or another
  // cycle) superseded it.
  let generation = 0;

  const onTimeoutFired = () => {
    // Stop the warning interval before delegating: if onTimeout's
    // SIGTERM doesn't kill the child (Windows reality), the watcher
    // would otherwise log idle warnings forever.
    clearTimers();
    if (!opts.shouldDefer) {
      opts.onTimeout();
      return;
    }
    const gen = generation;
    const decide = (defer: boolean) => {
      if (stopped || gen !== generation) return;
      if (defer) {
        generation++;
        opts.onDefer?.();
        startTimers();
      } else {
        opts.onTimeout();
      }
    };
    opts.shouldDefer().then(
      (busy) => decide(busy),
      () => decide(false),
    );
  };

  const startTimers = () => {
    timeoutHandle = setTimeout(onTimeoutFired, opts.idleTimeoutMs);
    if (opts.onWarning) {
      warningHandle = setInterval(() => {
        warningCount++;
        opts.onWarning!(warningCount);
      }, opts.idleWarningIntervalMs);
    }
  };

  const clearTimers = () => {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (warningHandle) clearInterval(warningHandle);
    timeoutHandle = null;
    warningHandle = null;
  };

  startTimers();

  return {
    reset() {
      clearTimers();
      generation++;
      warningCount = 0;
      startTimers();
    },
    stop() {
      stopped = true;
      clearTimers();
    },
  };
}

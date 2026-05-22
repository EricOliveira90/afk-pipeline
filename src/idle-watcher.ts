/**
 * Pairs the hard idle-timeout (kill) with a periodic idle-warning
 * (informational). Reset on every chunk of activity. See CONTEXT.md
 * ("Idle warning" / "Idle timeout").
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
}

export function createIdleWatcher(opts: IdleWatcherOptions): IdleWatcher {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let warningHandle: ReturnType<typeof setInterval> | null = null;
  let warningCount = 0;

  const startTimers = () => {
    timeoutHandle = setTimeout(opts.onTimeout, opts.idleTimeoutMs);
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
      warningCount = 0;
      startTimers();
    },
    stop() {
      clearTimers();
    },
  };
}

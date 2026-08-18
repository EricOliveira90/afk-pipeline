import { CancelledError, isTransientProviderError } from "./agent-provider.js";

/**
 * Retry-with-backoff for provider-classified transient failures
 * (`TransientProviderError`). See ADR 0022 and issue #16.
 *
 * The observed failure mode: a model outage lasting minutes, while the
 * agent CLI's internal retries span ~30 seconds — so the CLI gives up,
 * the invocation rejects, and the slice (plus any lane behind it)
 * dies for a condition that would have cleared on its own. This helper
 * sits between the orchestrator and `provider.invoke`, re-invoking on
 * transient errors with exponential backoff for as long as the
 * configured window allows.
 *
 * Window semantics are elapsed-time based, measured from the FIRST
 * transient failure: a retry is scheduled only when its full delay
 * still fits inside the window. Attempt duration counts against the
 * window too — a CLI that spends a minute failing eats a minute of
 * budget — which keeps the worst-case slice delay predictable for the
 * operator. `windowMs: 0` disables retries entirely.
 *
 * Only transient errors are retried; everything else (idle kills,
 * ceiling kills, nonzero exits without the transient marker,
 * cancellation) propagates immediately. An abort during the backoff
 * sleep rejects with `CancelledError` so Ctrl-C is never delayed by a
 * pending retry.
 */

/** 15 minutes — covers the outages observed in the PRD 075 run. */
export const DEFAULT_TRANSIENT_RETRY_WINDOW_MS = 900_000;

/**
 * Exponential schedule; the last delay repeats until the window
 * closes. First retry is quick (the outage may already be over), later
 * ones spread out to avoid hammering a struggling backend.
 */
const BACKOFF_DELAYS_MS = [30_000, 60_000, 120_000, 240_000, 480_000];

export interface TransientRetryOptions {
  /** Total retry window in ms measured from the first transient failure. 0 disables. */
  windowMs?: number;
  /** Abort signal — cancels a pending backoff sleep with CancelledError. */
  signal?: AbortSignal;
  /** Notified before each backoff sleep begins. */
  onRetry?: (info: { attempt: number; delayMs: number; error: Error }) => void;
  /** Injectable for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Injectable for tests. */
  now?: () => number;
}

export async function withTransientRetry<T>(
  fn: () => Promise<T>,
  options: TransientRetryOptions = {},
): Promise<T> {
  const windowMs = options.windowMs ?? DEFAULT_TRANSIENT_RETRY_WINDOW_MS;
  const sleep = options.sleep ?? abortableSleep;
  const now = options.now ?? Date.now;
  let firstFailureAt: number | undefined;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransientProviderError(err)) throw err;
      if (options.signal?.aborted) throw err;
      firstFailureAt ??= now();
      const delayMs =
        BACKOFF_DELAYS_MS[Math.min(attempt, BACKOFF_DELAYS_MS.length - 1)]!;
      const elapsed = now() - firstFailureAt;
      if (windowMs <= 0 || elapsed + delayMs > windowMs) throw err;
      options.onRetry?.({ attempt: attempt + 1, delayMs, error: err });
      await sleep(delayMs, options.signal);
    }
  }
}

/**
 * Sleep that a fired AbortSignal interrupts with `CancelledError`.
 * The timer is deliberately ref'd: a pipeline waiting out a model
 * outage is legitimate work and must keep the event loop alive.
 */
export function abortableSleep(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CancelledError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CancelledError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

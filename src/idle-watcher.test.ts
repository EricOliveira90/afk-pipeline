import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createIdleWatcher } from "./idle-watcher.js";

describe("createIdleWatcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops emitting warnings once the timeout fires", () => {
    const onWarning = vi.fn();
    const onTimeout = vi.fn();

    const watcher = createIdleWatcher({
      idleTimeoutMs: 1_000,
      idleWarningIntervalMs: 200,
      onTimeout,
      onWarning,
    });

    // Warnings fire at 200, 400, 600, 800 — four before the 1_000ms timeout.
    vi.advanceTimersByTime(1_000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    const warningsAtTimeout = onWarning.mock.calls.length;
    expect(warningsAtTimeout).toBeGreaterThan(0);

    // Simulate the orphaned-Windows-process scenario: the child never
    // closes, so `watcher.stop()` is never called. The interval must
    // not keep firing.
    vi.advanceTimersByTime(60_000);
    expect(onWarning).toHaveBeenCalledTimes(warningsAtTimeout);
    expect(onTimeout).toHaveBeenCalledTimes(1);

    watcher.stop();
  });

  it("reset() restarts both timers and resets the warning counter", () => {
    const warningCounts: number[] = [];
    const watcher = createIdleWatcher({
      idleTimeoutMs: 10_000,
      idleWarningIntervalMs: 1_000,
      onTimeout: () => {},
      onWarning: (n) => warningCounts.push(n),
    });

    vi.advanceTimersByTime(2_500);
    expect(warningCounts).toEqual([1, 2]);

    watcher.reset();
    vi.advanceTimersByTime(1_000);
    expect(warningCounts).toEqual([1, 2, 1]);

    watcher.stop();
  });
});

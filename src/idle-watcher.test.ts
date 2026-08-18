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


/**
 * Deferral probe (ADR 0021, issue #14): when `shouldDefer` resolves
 * true at the timeout, the kill is skipped, `onDefer` fires, and the
 * timers restart — so a generator silently running a long test suite
 * survives as long as its spawned process lives. False (or a rejected
 * probe) proceeds to the kill; reset()/stop() during the async probe
 * invalidate its decision.
 */
describe("createIdleWatcher — deferral probe", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("defers the kill and restarts the cycle while shouldDefer resolves true", async () => {
    const onTimeout = vi.fn();
    const onDefer = vi.fn();
    let busy = true;

    const watcher = createIdleWatcher({
      idleTimeoutMs: 1_000,
      idleWarningIntervalMs: 400,
      onTimeout,
      shouldDefer: () => Promise.resolve(busy),
      onDefer,
    });

    // First timeout: busy → deferred, timers restarted.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(onDefer).toHaveBeenCalledTimes(1);

    // Second timeout: still busy → deferred again.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(onDefer).toHaveBeenCalledTimes(2);

    // Third timeout: the spawned process finished → kill proceeds.
    busy = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onDefer).toHaveBeenCalledTimes(2);

    watcher.stop();
  });

  it("keeps counting warnings across a deferral (the agent really is silent)", async () => {
    const warningCounts: number[] = [];
    const watcher = createIdleWatcher({
      idleTimeoutMs: 1_000,
      idleWarningIntervalMs: 400,
      onTimeout: () => {},
      onWarning: (n) => warningCounts.push(n),
      shouldDefer: () => Promise.resolve(true),
    });

    // 400, 800 → warnings 1, 2; timeout at 1_000 defers and restarts.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(warningCounts).toEqual([1, 2]);
    // Next cycle continues the count: 3, 4 — not back to 1.
    await vi.advanceTimersByTimeAsync(800);
    expect(warningCounts).toEqual([1, 2, 3, 4]);

    watcher.stop();
  });

  it("treats a rejected probe as not-busy and kills", async () => {
    const onTimeout = vi.fn();
    const watcher = createIdleWatcher({
      idleTimeoutMs: 1_000,
      idleWarningIntervalMs: 400,
      onTimeout,
      shouldDefer: () => Promise.reject(new Error("listing failed")),
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(onTimeout).toHaveBeenCalledTimes(1);

    watcher.stop();
  });

  it("a reset() while the probe is in flight invalidates the kill decision", async () => {
    const onTimeout = vi.fn();
    let resolveProbe!: (v: boolean) => void;
    const watcher = createIdleWatcher({
      idleTimeoutMs: 1_000,
      idleWarningIntervalMs: 400,
      onTimeout,
      shouldDefer: () =>
        new Promise<boolean>((resolve) => {
          resolveProbe = resolve;
        }),
    });

    // Timeout fires; the probe is pending.
    await vi.advanceTimersByTimeAsync(1_000);
    // Fresh output arrives before the probe resolves.
    watcher.reset();
    // The probe then reports "not busy" — but the decision is stale.
    resolveProbe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(onTimeout).not.toHaveBeenCalled();

    // The restarted cycle still kills at its own timeout.
    watcher.stop();
  });

  it("a stop() while the probe is in flight prevents both kill and restart", async () => {
    const onTimeout = vi.fn();
    const onDefer = vi.fn();
    let resolveProbe!: (v: boolean) => void;
    const watcher = createIdleWatcher({
      idleTimeoutMs: 1_000,
      idleWarningIntervalMs: 400,
      onTimeout,
      onDefer,
      shouldDefer: () =>
        new Promise<boolean>((resolve) => {
          resolveProbe = resolve;
        }),
    });

    await vi.advanceTimersByTimeAsync(1_000);
    watcher.stop(); // process exited while the probe was in flight
    resolveProbe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(onDefer).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createBusyProbe, DEFAULT_BASELINE_DELAY_MS } from "./busy-probe.js";

/**
 * Busy probe (ADR 0021, issue #14): distinguishes an agent silently
 * running a spawned command from a hung agent by comparing the live
 * process tree against a baseline snapshot taken shortly after spawn.
 * Failure posture is conservative — unverifiable means "not busy",
 * which preserves the pre-probe kill behavior.
 */
describe("createBusyProbe", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** pid→ppid table builder. */
  const table = (pairs: Array<[number, number]>) => new Map<number, number>(pairs);

  it("reports fresh descendants that were not in the baseline snapshot", async () => {
    // Baseline: shim (100) → cli (101). Later: cli spawned pwsh (200) → vitest (201).
    let now = table([
      [100, 1],
      [101, 100],
    ]);
    const probe = createBusyProbe(100, {
      listPidPpid: () => Promise.resolve(now),
    });

    await vi.advanceTimersByTimeAsync(DEFAULT_BASELINE_DELAY_MS);

    // Quiescent: nothing beyond the baseline.
    expect(await probe.check()).toBe(0);

    // The agent's shell tool starts a test suite.
    now = table([
      [100, 1],
      [101, 100],
      [200, 101],
      [201, 200],
    ]);
    expect(await probe.check()).toBe(2);

    // Suite finishes; back to the quiescent tree.
    now = table([
      [100, 1],
      [101, 100],
    ]);
    expect(await probe.check()).toBe(0);
  });

  it("reports 0 before the baseline snapshot is captured", async () => {
    const probe = createBusyProbe(100, {
      listPidPpid: () =>
        Promise.resolve(
          table([
            [100, 1],
            [200, 100],
          ]),
        ),
    });
    // No timer advance: baseline not captured yet → conservative 0.
    expect(await probe.check()).toBe(0);
  });

  it("reports 0 when the process table cannot be listed", async () => {
    let available = true;
    const probe = createBusyProbe(100, {
      listPidPpid: () =>
        Promise.resolve(available ? table([[100, 1]]) : undefined),
    });
    await vi.advanceTimersByTimeAsync(DEFAULT_BASELINE_DELAY_MS);

    available = false;
    expect(await probe.check()).toBe(0);
  });

  it("reports 0 when the baseline capture itself failed", async () => {
    let available = false;
    const probe = createBusyProbe(100, {
      listPidPpid: () =>
        Promise.resolve(
          available
            ? table([
                [100, 1],
                [200, 100],
              ])
            : undefined,
        ),
    });
    await vi.advanceTimersByTimeAsync(DEFAULT_BASELINE_DELAY_MS);
    available = true;
    // Listing works now, but there is no baseline to diff against.
    expect(await probe.check()).toBe(0);
  });

  it("reports 0 for a root that never had a PID (spawn failure)", async () => {
    const probe = createBusyProbe(undefined, {
      listPidPpid: () => Promise.resolve(table([[100, 1]])),
    });
    await vi.advanceTimersByTimeAsync(DEFAULT_BASELINE_DELAY_MS);
    expect(await probe.check()).toBe(0);
  });

  it("does not count a dead root's absence as business (kill verification unaffected)", async () => {
    let now = table([
      [100, 1],
      [101, 100],
    ]);
    const probe = createBusyProbe(100, {
      listPidPpid: () => Promise.resolve(now),
    });
    await vi.advanceTimersByTimeAsync(DEFAULT_BASELINE_DELAY_MS);

    // Whole tree died: nothing fresh, nothing busy.
    now = table([[900, 1]]);
    expect(await probe.check()).toBe(0);
  });

  it("respects a custom baseline delay", async () => {
    let now = table([[100, 1]]);
    const probe = createBusyProbe(100, {
      baselineDelayMs: 50,
      listPidPpid: () => Promise.resolve(now),
    });
    await vi.advanceTimersByTimeAsync(50);
    now = table([
      [100, 1],
      [300, 100],
    ]);
    expect(await probe.check()).toBe(1);
  });
});

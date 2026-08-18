import { describe, it, expect, vi } from "vitest";
import {
  CancelledError,
  TransientProviderError,
  isTransientProviderError,
} from "./agent-provider.js";
import {
  abortableSleep,
  withTransientRetry,
  DEFAULT_TRANSIENT_RETRY_WINDOW_MS,
} from "./transient-retry.js";

/**
 * Retry-with-backoff for transient model outages (ADR 0022, issue #16).
 * Time is injected (`now` + `sleep`) so the schedule is tested without
 * real waits: sleeps advance a fake clock and are recorded.
 */
describe("withTransientRetry", () => {
  function fakeClock() {
    let t = 0;
    const sleeps: number[] = [];
    return {
      now: () => t,
      sleep: (ms: number) => {
        sleeps.push(ms);
        t += ms;
        return Promise.resolve();
      },
      advance: (ms: number) => {
        t += ms;
      },
      sleeps,
    };
  }

  it("retries transient failures with the exponential schedule and returns the eventual success", async () => {
    const clock = fakeClock();
    let calls = 0;
    const result = await withTransientRetry(
      () => {
        calls++;
        if (calls <= 3) {
          return Promise.reject(
            new TransientProviderError("model temporarily unavailable"),
          );
        }
        return Promise.resolve("ok");
      },
      { now: clock.now, sleep: clock.sleep },
    );

    expect(result).toBe("ok");
    expect(calls).toBe(4);
    expect(clock.sleeps).toEqual([30_000, 60_000, 120_000]);
  });

  it("rethrows non-transient errors immediately without sleeping", async () => {
    const clock = fakeClock();
    let calls = 0;
    await expect(
      withTransientRetry(
        () => {
          calls++;
          return Promise.reject(new Error("Agent generator idle for 600s — killed"));
        },
        { now: clock.now, sleep: clock.sleep },
      ),
    ).rejects.toThrow(/idle for 600s/);
    expect(calls).toBe(1);
    expect(clock.sleeps).toEqual([]);
  });

  it("stops retrying when the next delay would overrun the window and rethrows the transient error", async () => {
    const clock = fakeClock();
    let calls = 0;
    // Window fits exactly one 30s retry: 30s + 60s > 80s.
    await expect(
      withTransientRetry(
        () => {
          calls++;
          return Promise.reject(new TransientProviderError("unavailable"));
        },
        { windowMs: 80_000, now: clock.now, sleep: clock.sleep },
      ),
    ).rejects.toSatisfy((e: unknown) => isTransientProviderError(e));
    expect(calls).toBe(2);
    expect(clock.sleeps).toEqual([30_000]);
  });

  it("counts attempt duration against the window, not just sleep time", async () => {
    const clock = fakeClock();
    let calls = 0;
    await expect(
      withTransientRetry(
        () => {
          calls++;
          clock.advance(50_000); // each failing attempt burns 50s
          return Promise.reject(new TransientProviderError("unavailable"));
        },
        { windowMs: 100_000, now: clock.now, sleep: clock.sleep },
      ),
    ).rejects.toSatisfy((e: unknown) => isTransientProviderError(e));
    // Attempt 1 fails at t=50s → 30s retry fits (80s ≤ 100s). Attempt 2
    // fails at t=130s → next delay overruns → rethrow. NOTE: the window
    // is measured from the FIRST failure (t=50s), so elapsed is 80s and
    // 80s + 60s > 100s.
    expect(calls).toBe(2);
    expect(clock.sleeps).toEqual([30_000]);
  });

  it("windowMs 0 disables retries entirely", async () => {
    const clock = fakeClock();
    let calls = 0;
    await expect(
      withTransientRetry(
        () => {
          calls++;
          return Promise.reject(new TransientProviderError("unavailable"));
        },
        { windowMs: 0, now: clock.now, sleep: clock.sleep },
      ),
    ).rejects.toSatisfy((e: unknown) => isTransientProviderError(e));
    expect(calls).toBe(1);
    expect(clock.sleeps).toEqual([]);
  });

  it("repeats the last delay once the schedule is exhausted", async () => {
    const clock = fakeClock();
    let calls = 0;
    await expect(
      withTransientRetry(
        () => {
          calls++;
          return Promise.reject(new TransientProviderError("unavailable"));
        },
        {
          windowMs: 2_000_000, // roomy: 30+60+120+240+480+480+480 …
          now: clock.now,
          sleep: clock.sleep,
        },
      ),
    ).rejects.toSatisfy((e: unknown) => isTransientProviderError(e));
    expect(clock.sleeps.slice(0, 7)).toEqual([
      30_000, 60_000, 120_000, 240_000, 480_000, 480_000, 480_000,
    ]);
  });

  it("notifies onRetry with attempt number, delay, and the error", async () => {
    const clock = fakeClock();
    const retries: Array<{ attempt: number; delayMs: number }> = [];
    let calls = 0;
    await withTransientRetry(
      () => {
        calls++;
        return calls === 1
          ? Promise.reject(new TransientProviderError("unavailable"))
          : Promise.resolve("ok");
      },
      {
        now: clock.now,
        sleep: clock.sleep,
        onRetry: ({ attempt, delayMs, error }) => {
          retries.push({ attempt, delayMs });
          expect(error.message).toContain("unavailable");
        },
      },
    );
    expect(retries).toEqual([{ attempt: 1, delayMs: 30_000 }]);
  });

  it("an aborted signal short-circuits instead of scheduling a retry", async () => {
    const clock = fakeClock();
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await expect(
      withTransientRetry(
        () => {
          calls++;
          return Promise.reject(new TransientProviderError("unavailable"));
        },
        { signal: controller.signal, now: clock.now, sleep: clock.sleep },
      ),
    ).rejects.toSatisfy((e: unknown) => isTransientProviderError(e));
    expect(calls).toBe(1);
    expect(clock.sleeps).toEqual([]);
  });

  it("uses the 15 min default window", () => {
    expect(DEFAULT_TRANSIENT_RETRY_WINDOW_MS).toBe(900_000);
  });
});

describe("abortableSleep", () => {
  it("resolves after the delay", async () => {
    vi.useFakeTimers();
    try {
      const p = abortableSleep(1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(p).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects with CancelledError when the signal fires mid-sleep", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const p = abortableSleep(60_000, controller.signal);
      const rejection = expect(p).rejects.toBeInstanceOf(CancelledError);
      await vi.advanceTimersByTimeAsync(1_000);
      controller.abort();
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects immediately on an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(abortableSleep(1, controller.signal)).rejects.toBeInstanceOf(
      CancelledError,
    );
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamEvent } from "./agent-provider.js";
import type { TerminationReport } from "./kill-tree.js";
import {
  deferred,
  emitExit,
  makeFakeProc,
  type FakeProc,
} from "./test/fake-proc.js";

const spawnMock = vi.hoisted(() => vi.fn());
const terminateMock = vi.hoisted(() => vi.fn());
const busyCheckMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ spawn: spawnMock }));
vi.mock("./busy-probe.js", () => ({
  createBusyProbe: () => ({ check: busyCheckMock }),
}));
vi.mock("./kill-tree.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./kill-tree.js")>();
  return { ...actual, terminateProcessTree: terminateMock };
});

const { runInvocation } = await import("./invocation-runtime.js");

const CLEAN_KILL: TerminationReport = {
  rootDead: true,
  survivors: [],
  verified: true,
};

function options(overrides: Record<string, unknown> = {}) {
  return {
    role: "generator",
    prompt: "build it",
    cwd: "/tmp/worktree",
    idleTimeoutMs: 1_000,
    idleWarningIntervalMs: 200,
    maxDurationMs: 10_000,
    ...overrides,
  };
}

function start(
  proc: FakeProc,
  overrides: Record<string, unknown> = {},
  prepared: Record<string, unknown> = {},
) {
  spawnMock.mockReturnValue(proc);
  return runInvocation(options(overrides), () => ({
    command: "agent-cli",
    args: ["run"],
    stdin: "build it",
    ...prepared,
  }));
}

beforeEach(() => {
  spawnMock.mockReset();
  terminateMock.mockReset();
  terminateMock.mockResolvedValue(CLEAN_KILL);
  busyCheckMock.mockReset();
  busyCheckMock.mockResolvedValue(0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("invocation runtime streams", () => {
  it("owns spawn, teeing, line framing, stream events, and stats", async () => {
    const proc = makeFakeProc();
    const events: StreamEvent[] = [];
    const logged: string[] = [];
    let costUsd: number | undefined;
    const promise = start(
      proc,
      {
        onStreamEvent: (event: StreamEvent) => events.push(event),
        logStream: { write: (text: string) => logged.push(text) },
      },
      {
        shell: true,
        parseStreamLine: (line: string) => {
          const event = JSON.parse(line) as { type: string; cost?: number };
          if (event.cost !== undefined) costUsd = event.cost;
          return event.type === "tool"
            ? [{ type: "tool_call", name: "shell", args: "pnpm test" }]
            : [{ type: "result", result: "done" }];
        },
        stats: () => ({ costUsd }),
      },
    );

    proc.stdout.emit("data", Buffer.from('{"type":"tool"}\n{"type":'));
    proc.stdout.emit("data", Buffer.from('"result","cost":1.25}\n'));
    proc.stderr.emit("data", Buffer.from("diagnostic\n"));
    emitExit(proc, 0);

    await expect(promise).resolves.toEqual({
      exitCode: 0,
      stdout: '{"type":"tool"}\n{"type":"result","cost":1.25}\n',
      stats: { costUsd: 1.25, toolCallCount: 1 },
    });
    expect(events).toEqual([
      { type: "tool_call", name: "shell", args: "pnpm test" },
      { type: "result", result: "done" },
    ]);
    expect(logged.join("")).toContain("diagnostic");
    expect(proc.stdinText).toBe("build it");
    expect(spawnMock).toHaveBeenCalledWith(
      "agent-cli",
      ["run"],
      expect.objectContaining({ cwd: "/tmp/worktree", shell: true }),
    );
  });

  it("flushes a final stdout line without a trailing newline", async () => {
    const proc = makeFakeProc();
    const onStreamEvent = vi.fn();
    const promise = start(
      proc,
      { onStreamEvent },
      {
        parseStreamLine: () => [{ type: "result", result: "done" }],
      },
    );
    proc.stdout.emit("data", Buffer.from("final record"));
    emitExit(proc, 0);
    await promise;
    expect(onStreamEvent).toHaveBeenCalledWith({
      type: "result",
      result: "done",
    });
  });
});

describe("invocation runtime lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("kills an idle invocation with the pinned message", async () => {
    const proc = makeFakeProc();
    const promise = start(proc);
    const rejection = promise.catch((error: unknown) => error as Error);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(terminateMock).toHaveBeenCalledWith(proc);
    emitExit(proc, null);

    await expect(rejection).resolves.toMatchObject({
      message: "Agent generator idle for 1s — killed",
    });
  });

  it("defers an idle kill while the busy probe sees spawned work", async () => {
    const proc = makeFakeProc();
    const onIdleDeferral = vi.fn();
    const logged: string[] = [];
    busyCheckMock.mockResolvedValueOnce(2).mockResolvedValueOnce(0);
    const promise = start(proc, {
      onIdleDeferral,
      logStream: { write: (text: string) => logged.push(text) },
    });
    const rejection = promise.catch((error: unknown) => error as Error);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(terminateMock).not.toHaveBeenCalled();
    expect(onIdleDeferral).toHaveBeenCalledWith({
      silentSeconds: 1,
      busyProcesses: 2,
    });
    expect(logged.join("")).toContain("deferring idle kill");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(terminateMock).toHaveBeenCalledTimes(1);
    emitExit(proc, null);
    await rejection;
  });

  it("enforces the wall-clock ceiling despite steady activity", async () => {
    const proc = makeFakeProc();
    const promise = start(proc, {
      idleTimeoutMs: 5_000,
      maxDurationMs: 2_000,
    });
    const rejection = promise.catch((error: unknown) => error as Error);

    for (let i = 0; i < 4; i++) {
      proc.stdout.emit("data", Buffer.from(`progress ${i}\n`));
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(terminateMock).toHaveBeenCalledTimes(1);
    emitExit(proc, null);
    await expect(rejection).resolves.toMatchObject({
      message: "Agent generator exceeded 2s wall-clock ceiling — killed",
    });
  });

  it("cancels an in-flight invocation and never spawns when already cancelled", async () => {
    const proc = makeFakeProc();
    const controller = new AbortController();
    const promise = start(proc, { signal: controller.signal });
    const rejection = promise.catch((error: unknown) => error as Error);

    controller.abort();
    expect(terminateMock).toHaveBeenCalledTimes(1);
    emitExit(proc, null);
    await expect(rejection).resolves.toMatchObject({
      name: "CancelledError",
      message: "Agent generator cancelled",
    });

    spawnMock.mockReset();
    const alreadyCancelled = new AbortController();
    alreadyCancelled.abort();
    await expect(
      runInvocation(
        options({ signal: alreadyCancelled.signal }),
        () => ({ command: "never", args: [] }),
      ),
    ).rejects.toMatchObject({ name: "CancelledError" });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("holds an exit outcome until kill verification completes", async () => {
    const proc = makeFakeProc();
    const report = deferred<TerminationReport>();
    terminateMock.mockReturnValue(report.promise);
    const promise = start(proc);
    let settled = false;
    const rejection = promise.catch((error: unknown) => error as Error);
    void rejection.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(1_000);
    emitExit(proc, null);
    await Promise.resolve();
    expect(settled).toBe(false);

    report.resolve(CLEAN_KILL);
    await expect(rejection).resolves.toMatchObject({
      message: "Agent generator idle for 1s — killed",
    });
  });

  it("surfaces survivor warnings in the rejection and invocation log", async () => {
    const proc = makeFakeProc();
    const logged: string[] = [];
    terminateMock.mockResolvedValue({
      rootDead: true,
      survivors: [4242, 777],
      verified: true,
    });
    const promise = start(proc, {
      logStream: { write: (text: string) => logged.push(text) },
    });
    const rejection = promise.catch((error: unknown) => error as Error);

    await vi.advanceTimersByTimeAsync(1_000);
    emitExit(proc, null);
    await expect(rejection).resolves.toMatchObject({
      message: expect.stringContaining(
        "WARNING: 2 process(es) survived the kill (PIDs 4242, 777)",
      ),
    });
    expect(logged.join("")).toContain("survived the kill (PIDs 4242, 777)");
  });

  it("settles from an unkillable-root report and releases child handles", async () => {
    const proc = makeFakeProc();
    terminateMock.mockResolvedValue({
      rootDead: false,
      survivors: [1234],
      verified: true,
    });
    const promise = start(proc);
    const rejection = promise.catch((error: unknown) => error as Error);

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(rejection).resolves.toMatchObject({
      message: expect.stringContaining("survived the kill (PIDs 1234)"),
    });
    expect(proc.stdout.destroyed).toBe(true);
    expect(proc.stderr.destroyed).toBe(true);
    expect(proc.stdin.destroyed).toBe(true);
    expect(proc.unref).toHaveBeenCalledOnce();
  });

  it("counts tool calls and kills only after the opt-in cap", async () => {
    const proc = makeFakeProc();
    const promise = start(
      proc,
      { maxToolCalls: 2 },
      {
        parseStreamLine: () => [
          { type: "tool_call", name: "shell", args: "command" },
        ],
      },
    );
    const rejection = promise.catch((error: unknown) => error as Error);

    proc.stdout.emit("data", Buffer.from("one\ntwo\n"));
    expect(terminateMock).not.toHaveBeenCalled();
    proc.stdout.emit("data", Buffer.from("three\n"));
    expect(terminateMock).toHaveBeenCalledTimes(1);
    emitExit(proc, null);
    await expect(rejection).resolves.toMatchObject({
      message: "Agent generator exceeded 2 tool calls — killed",
    });
  });

  it("never kills on tool-call volume by default, but still counts", async () => {
    const proc = makeFakeProc();
    // No maxToolCalls: the wall-clock ceiling is the backstop
    // (ADR 0036). 150 calls comfortably exceeds the retired 100 default.
    const promise = start(proc, {}, {
      parseStreamLine: () => [
        { type: "tool_call", name: "shell", args: "command" },
      ],
    });

    for (let i = 0; i < 150; i++) {
      proc.stdout.emit("data", Buffer.from(`call ${i}\n`));
    }
    expect(terminateMock).not.toHaveBeenCalled();
    emitExit(proc, 0);
    await expect(promise).resolves.toMatchObject({
      stats: { toolCallCount: 150 },
    });
  });

  it("places provider hook errors above standard kill reasons", async () => {
    const proc = makeFakeProc();
    const providerError = new Error("provider stream failed");
    const promise = start(proc, {}, {
      onOutput: () => providerError,
    });
    const rejection = promise.catch((error: unknown) => error as Error);

    proc.stderr.emit("data", Buffer.from("failure"));
    emitExit(proc, null);
    await expect(rejection).resolves.toBe(providerError);
  });

  it("does not let busy deferral extend the wall-clock ceiling", async () => {
    const proc = makeFakeProc();
    busyCheckMock.mockResolvedValue(3);
    const promise = start(proc, { maxDurationMs: 1_500 });
    const rejection = promise.catch((error: unknown) => error as Error);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(terminateMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(terminateMock).toHaveBeenCalledTimes(1);
    emitExit(proc, null);
    await expect(rejection).resolves.toMatchObject({
      message: "Agent generator exceeded 1.5s wall-clock ceiling — killed",
    });
  });

  it("runs settle cleanup when spawn throws synchronously", async () => {
    const cleanup = vi.fn();
    const spawnError = new Error("spawn failed");
    spawnMock.mockImplementationOnce(() => {
      throw spawnError;
    });

    await expect(
      runInvocation(options(), () => ({
        command: "missing-cli",
        args: [],
        onSettled: cleanup,
      })),
    ).rejects.toBe(spawnError);
    expect(cleanup).toHaveBeenCalledOnce();
  });
  it("runs settle cleanup for natural exits and kill outcomes", async () => {
    const cleanup = vi.fn();
    const natural = makeFakeProc();
    const naturalPromise = start(natural, {}, { onSettled: cleanup });
    emitExit(natural, 0);
    await naturalPromise;

    const killed = makeFakeProc();
    const killedPromise = start(killed, {}, { onSettled: cleanup }).catch(
      () => undefined,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    emitExit(killed, null);
    await killedPromise;
    expect(cleanup).toHaveBeenCalledTimes(2);
  });
});

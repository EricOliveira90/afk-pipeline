import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import type { StreamEvent } from "./agent-provider.js";
import type { TerminationReport } from "./kill-tree.js";

const spawnMock = vi.hoisted(() => vi.fn());
const terminateMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

// Kill paths delegate to the tree terminator (ADR 0020); unit tests
// stub it and emit `exit` the way a real kill would.
vi.mock("./kill-tree.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./kill-tree.js")>();
  return { ...actual, terminateProcessTree: terminateMock };
});

const CLEAN_KILL: TerminationReport = {
  rootDead: true,
  survivors: [],
  verified: true,
};

// Imported AFTER the mock is wired.
const { handleStreamEvent, invoke, parseStreamLine } = await import("./claude.js");

interface FakeProc extends EventEmitter {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  kill: ReturnType<typeof vi.fn>;
  unref: ReturnType<typeof vi.fn>;
}

function makeFakeProc(): FakeProc {
  const proc = new EventEmitter() as FakeProc;
  // Sinks that swallow writes — invoke pipes the prompt into stdin.
  proc.stdin = new Writable({ write(_c, _e, cb) { cb(); } });
  proc.stdout = new Readable({ read() {} });
  proc.stderr = new Readable({ read() {} });
  proc.kill = vi.fn(() => true);
  proc.unref = vi.fn();
  return proc;
}

beforeEach(() => {
  terminateMock.mockReset();
  // Mirror a successful real kill: the tree dies, `exit` follows.
  terminateMock.mockImplementation(async (proc: FakeProc) => {
    setImmediate(() => proc.emit("exit", null));
    return CLEAN_KILL;
  });
});

function toolUseLine(name = "Bash", command = "ls"): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", name, input: { command } },
      ],
    },
  }) + "\n";
}

describe("parseStreamLine", () => {
  it("extracts tool_call events from a Bash tool_use line", () => {
    const events = parseStreamLine(toolUseLine("Bash", "pnpm test").trim());
    expect(events).toEqual([
      { type: "tool_call", name: "Bash", args: "pnpm test" },
    ]);
  });
});

describe("invoke spawn args", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it("default invocation passes --agent and skips permissions", async () => {
    const proc = makeFakeProc();
    spawnMock.mockReturnValue(proc);

    const promise = invoke({
      role: "planner",
      agent: "planner",
      prompt: "go",
      cwd: "/tmp/x",
    });
    proc.stdout.push(null);
    proc.emit("exit", 0);
    await promise;

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args).toContain("--agent");
    expect(args).toContain("planner");
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-opus-5");
    expect(args).not.toContain("--bare");
  });

  it("uses Sonnet for explorer and Opus for other roles", async () => {
    const explorerProc = makeFakeProc();
    const plannerProc = makeFakeProc();
    spawnMock
      .mockReturnValueOnce(explorerProc)
      .mockReturnValueOnce(plannerProc);

    const explorerPromise = invoke({
      role: "explorer",
      prompt: "explore",
      cwd: "/tmp/x",
    });
    explorerProc.emit("exit", 0);
    await explorerPromise;

    const plannerPromise = invoke({
      role: "planner",
      prompt: "plan",
      cwd: "/tmp/x",
    });
    plannerProc.emit("exit", 0);
    await plannerPromise;

    const explorerArgs = spawnMock.mock.calls[0]![1] as string[];
    const plannerArgs = spawnMock.mock.calls[1]![1] as string[];
    expect(explorerArgs[explorerArgs.indexOf("--model") + 1]).toBe(
      "claude-sonnet-5",
    );
    expect(plannerArgs[plannerArgs.indexOf("--model") + 1]).toBe(
      "claude-opus-5",
    );
  });

  it("bare invocation passes --bare, drops --agent, and adds --tools default", async () => {
    const proc = makeFakeProc();
    spawnMock.mockReturnValue(proc);

    const promise = invoke({
      role: "architect-review",
      agent: "architect-review",
      bare: true,
      prompt: "go",
      cwd: "/tmp/x",
    });
    proc.stdout.push(null);
    proc.emit("exit", 0);
    await promise;

    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args).toContain("--bare");
    expect(args).toContain("--tools");
    expect(args[args.indexOf("--tools") + 1]).toBe("default");
    // --bare drops CLAUDE.md auto-discovery, so cwd context is added
    // explicitly.
    expect(args).toContain("--add-dir");
    expect(args[args.indexOf("--add-dir") + 1]).toBe("/tmp/x");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-opus-5");
    // --bare strips plugin-loaded agents, so passing --agent would
    // resolve to the default agent and waste a CLI flag.
    expect(args).not.toContain("--agent");
  });
});

describe("invoke maxToolCalls cap", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it("kills the session and rejects with a cap message when tool calls exceed maxToolCalls", async () => {
    const proc = makeFakeProc();
    spawnMock.mockReturnValue(proc);

    const promise = invoke({
      role: "evaluator-qa",
      prompt: "noop",
      cwd: "/tmp",
      maxToolCalls: 2,
    });

    // Push 3 tool_use lines — the 3rd trips the cap (count > 2).
    proc.stdout.push(toolUseLine());
    proc.stdout.push(toolUseLine());
    proc.stdout.push(toolUseLine());

    await expect(promise).rejects.toThrow(
      /Agent evaluator-qa exceeded 2 tool calls — killed/,
    );
    expect(terminateMock).toHaveBeenCalledTimes(1);
  });

  it("does not fire the cap when tool calls stay at or below the limit", async () => {
    const proc = makeFakeProc();
    spawnMock.mockReturnValue(proc);

    const promise = invoke({
      role: "evaluator-qa",
      prompt: "noop",
      cwd: "/tmp",
      maxToolCalls: 5,
    });

    proc.stdout.push(toolUseLine());
    proc.stdout.push(toolUseLine());
    // `Readable.push` schedules `data` events on nextTick — let them
    // fire before closing, otherwise the buffered chunks are dropped.
    await new Promise((r) => setImmediate(r));
    proc.stdout.push(null); // EOF
    proc.emit("exit", 0);

    const result = await promise;
    expect(result.exitCode).toBe(0);
    expect(result.stats.toolCallCount).toBe(2);
    expect(terminateMock).not.toHaveBeenCalled();
  });
});

describe("invoke maxDurationMs ceiling", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("kills a session that outlives the wall-clock ceiling despite steady output", async () => {
    const proc = makeFakeProc();
    spawnMock.mockReturnValue(proc);

    const promise = invoke({
      role: "generator",
      prompt: "build",
      cwd: "/tmp",
      idleTimeoutMs: 10_000,
      maxDurationMs: 30_000,
    });

    // Output every 5s keeps the idle watcher happy forever; only the
    // ceiling can end this session.
    for (let i = 0; i < 7; i++) {
      proc.stdout.emit("data", Buffer.from(`{"type":"noise"}\n`));
      vi.advanceTimersByTime(5_000);
    }

    expect(terminateMock).toHaveBeenCalledTimes(1);
    proc.emit("exit", null);
    await expect(promise).rejects.toThrow(/wall-clock ceiling/);
  });

  it("appends surviving PIDs to the kill error when the tree outlives the kill", async () => {
    const proc = makeFakeProc();
    spawnMock.mockReturnValue(proc);
    terminateMock.mockImplementation(async () => ({
      rootDead: true,
      survivors: [4242, 777],
      verified: true,
    }));

    const promise = invoke({
      role: "generator",
      prompt: "build",
      cwd: "/tmp",
      idleTimeoutMs: 10_000,
      maxDurationMs: 30_000,
    });

    vi.advanceTimersByTime(30_000);
    proc.emit("exit", null);
    await expect(promise).rejects.toThrow(
      /wall-clock ceiling.*WARNING: 2 process\(es\) survived the kill \(PIDs 4242, 777\)/s,
    );
  });

  it("settles even when the child never emits exit because the root would not die", async () => {
    const proc = makeFakeProc();
    spawnMock.mockReturnValue(proc);
    terminateMock.mockImplementation(async () => ({
      rootDead: false,
      survivors: [1234],
      verified: true,
    }));

    const promise = invoke({
      role: "generator",
      prompt: "build",
      cwd: "/tmp",
      idleTimeoutMs: 10_000,
      maxDurationMs: 30_000,
    });

    vi.advanceTimersByTime(30_000);
    // No `exit` is ever emitted — settlement must come from the
    // termination report alone.
    await expect(promise).rejects.toThrow(/survived the kill \(PIDs 1234\)/);
  });
});

describe("handleStreamEvent", () => {
  function makeCounters() {
    const resets: number[] = [];
    const events: StreamEvent[] = [];
    return {
      watcher: {
        reset: () => resets.push(Date.now()),
        stop: () => {},
      },
      onStreamEvent: (e: StreamEvent) => events.push(e),
      resets,
      events,
    };
  }

  it("calls watcher.reset() for a tool_call event", () => {
    const c = makeCounters();
    const result = handleStreamEvent({
      event: { type: "tool_call", name: "Bash", args: "echo x" },
      watcher: c.watcher,
      toolCallCount: 0,
      maxToolCalls: 100,
      onStreamEvent: c.onStreamEvent,
    });
    expect(c.resets.length).toBe(1);
    expect(result.toolCallCount).toBe(1);
    expect(result.capExceeded).toBe(false);
    expect(c.events).toEqual([{ type: "tool_call", name: "Bash", args: "echo x" }]);
  });

  it("does NOT call watcher.reset() for a text event", () => {
    const c = makeCounters();
    handleStreamEvent({
      event: { type: "text", text: "thinking..." },
      watcher: c.watcher,
      toolCallCount: 0,
      maxToolCalls: 100,
      onStreamEvent: c.onStreamEvent,
    });
    expect(c.resets.length).toBe(0);
  });

  it("flags capExceeded when tool calls exceed maxToolCalls", () => {
    const c = makeCounters();
    const result = handleStreamEvent({
      event: { type: "tool_call", name: "Bash", args: "x" },
      watcher: c.watcher,
      toolCallCount: 100,
      maxToolCalls: 100,
      onStreamEvent: c.onStreamEvent,
    });
    expect(result.toolCallCount).toBe(101);
    expect(result.capExceeded).toBe(true);
  });

  it("forwards the event to onStreamEvent before counting", () => {
    const c = makeCounters();
    handleStreamEvent({
      event: { type: "result", result: "done" },
      watcher: c.watcher,
      toolCallCount: 0,
      maxToolCalls: 100,
      onStreamEvent: c.onStreamEvent,
    });
    expect(c.events).toEqual([{ type: "result", result: "done" }]);
  });
});

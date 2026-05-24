import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import type { StreamEvent } from "./agent-provider.js";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

// Imported AFTER the mock is wired.
const { handleStreamEvent, invoke, parseStreamLine } = await import("./claude.js");

interface FakeProc extends EventEmitter {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  kill: ReturnType<typeof vi.fn>;
}

function makeFakeProc(): FakeProc {
  const proc = new EventEmitter() as FakeProc;
  // Sinks that swallow writes — invoke pipes the prompt into stdin.
  proc.stdin = new Writable({ write(_c, _e, cb) { cb(); } });
  proc.stdout = new Readable({ read() {} });
  proc.stderr = new Readable({ read() {} });
  proc.kill = vi.fn(() => {
    // Mirror spawn semantics: kill triggers an `exit` on the next tick.
    setImmediate(() => proc.emit("exit", null));
    return true;
  });
  return proc;
}

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
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
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
    expect(proc.kill).not.toHaveBeenCalled();
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

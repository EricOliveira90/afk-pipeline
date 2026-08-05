import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

// Imported AFTER the mock is wired.
const { invoke } = await import("./kiro.js");

interface FakeProc extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
  kill: ReturnType<typeof vi.fn>;
}

function makeFakeProc(): FakeProc {
  const proc = new EventEmitter() as FakeProc;
  proc.stdout = new Readable({ read() {} });
  proc.stderr = new Readable({ read() {} });
  proc.kill = vi.fn(() => {
    setImmediate(() => proc.emit("exit", null));
    return true;
  });
  return proc;
}

describe("kiro invoke spawn args", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it("passes --agent, trusts all tools, and defaults to Fable", async () => {
    const proc = makeFakeProc();
    spawnMock.mockReturnValue(proc);

    const promise = invoke({
      role: "planner",
      agent: "planner",
      prompt: "go",
      cwd: "/tmp/x",
    });
    proc.emit("exit", 0);
    await promise;

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]![0]).toBe("kiro-cli");
    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args).toContain("--no-interactive");
    expect(args).toContain("--trust-all-tools");
    expect(args[args.indexOf("--agent") + 1]).toBe("planner");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-fable-5");
    expect(args[args.length - 1]).toBe("go");
  });

  it("uses Sonnet for explorer and Fable for other roles", async () => {
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
      "claude-fable-5",
    );
  });

  it("an explicit model option overrides the role policy", async () => {
    const proc = makeFakeProc();
    spawnMock.mockReturnValue(proc);

    const promise = invoke({
      role: "explorer",
      prompt: "explore",
      cwd: "/tmp/x",
      model: "claude-opus-5",
    });
    proc.emit("exit", 0);
    await promise;

    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args[args.indexOf("--model") + 1]).toBe("claude-opus-5");
  });

  it("skips --agent when no agent config is given", async () => {
    const proc = makeFakeProc();
    spawnMock.mockReturnValue(proc);

    const promise = invoke({
      role: "generator",
      prompt: "build",
      cwd: "/tmp/x",
    });
    proc.emit("exit", 0);
    await promise;

    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args).not.toContain("--agent");
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TerminationReport } from "./kill-tree.js";
import { makeFakeProc, type FakeProc } from "./test/fake-proc.js";

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
const { invoke, parseStreamLine } = await import("./claude.js");

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
  it("extracts cost while the runtime dispatches parsed result events", async () => {
    const proc = makeFakeProc();
    const onStreamEvent = vi.fn();
    spawnMock.mockReturnValue(proc);
    const promise = invoke({
      role: "planner",
      prompt: "go",
      cwd: "/tmp/x",
      onStreamEvent,
    });

    proc.stdout.push(
      JSON.stringify({
        type: "result",
        result: "done",
        total_cost_usd: 1.25,
      }) + "\n",
    );
    await new Promise((resolve) => setImmediate(resolve));
    proc.emit("exit", 0);

    await expect(promise).resolves.toMatchObject({
      stats: { costUsd: 1.25, toolCallCount: 0 },
    });
    expect(onStreamEvent).toHaveBeenCalledWith({
      type: "result",
      result: "done",
    });
  });
});

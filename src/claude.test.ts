import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

  it("P-05 keeps the exact prompt on stdin with existing Claude flags", async () => {
    const proc = makeFakeProc();
    spawnMock.mockReturnValue(proc);
    const exactPrompt = "EXACT-CLAUDE-ENVELOPE";

    const promise = invoke({
      role: "planner",
      agent: "planner",
      prompt: exactPrompt,
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
    expect(proc.stdinText).toBe(exactPrompt);
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
        usage: {
          input_tokens: 21,
          output_tokens: 8,
          cache_read_input_tokens: 5,
        },
      }) + "\n",
    );
    await new Promise((resolve) => setImmediate(resolve));
    proc.emit("exit", 0);

    await expect(promise).resolves.toMatchObject({
      stats: {
        costUsd: 1.25,
        toolCallCount: 0,
        tokenCounts: {
          input_tokens: 21,
          output_tokens: 8,
          cache_read_input_tokens: 5,
        },
      },
    });
    expect(onStreamEvent).toHaveBeenCalledWith({
      type: "result",
      result: "done",
    });
  });
});


describe("nonCommandTimeMs evidence (A4)", () => {
  // Fake only Date so line-arrival timestamps are deterministic while
  // stream flushing keeps real setImmediate.
  beforeEach(() => {
    spawnMock.mockReset();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(100_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const flush = () => new Promise((resolve) => setImmediate(resolve));

  function toolUseWithId(id: string): string {
    return JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id, name: "Bash", input: { command: "ls" } },
        ],
      },
    }) + "\n";
  }

  function toolResult(toolUseId: string): string {
    return JSON.stringify({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: toolUseId }],
      },
    }) + "\n";
  }

  it("computes wall clock minus tool_use→tool_result intervals", async () => {
    const proc = makeFakeProc();
    spawnMock.mockReturnValue(proc);
    const promise = invoke({ role: "generator", prompt: "go", cwd: "/tmp/x" });

    vi.setSystemTime(101_000);
    proc.stdout.push(toolUseWithId("toolu_1"));
    await flush();
    vi.setSystemTime(103_500);
    proc.stdout.push(toolResult("toolu_1"));
    await flush();
    vi.setSystemTime(105_000);
    proc.emit("exit", 0);

    const result = await promise;
    // wall 5000ms − command 2500ms
    expect(result.stats.nonCommandTimeMs).toBe(2_500);
  });

  it("omits the field when a tool_use never gets its tool_result", async () => {
    const proc = makeFakeProc();
    spawnMock.mockReturnValue(proc);
    const promise = invoke({ role: "generator", prompt: "go", cwd: "/tmp/x" });

    proc.stdout.push(toolUseWithId("toolu_orphan"));
    await flush();
    vi.setSystemTime(104_000);
    proc.emit("exit", 0);

    const result = await promise;
    expect("nonCommandTimeMs" in result.stats).toBe(false);
  });

  it("omits the field when a tool_use block carries no correlatable id", async () => {
    const proc = makeFakeProc();
    spawnMock.mockReturnValue(proc);
    const promise = invoke({ role: "generator", prompt: "go", cwd: "/tmp/x" });

    // The shared fixture emits a tool_use block with no `id`.
    proc.stdout.push(toolUseLine("Bash", "ls"));
    await flush();
    vi.setSystemTime(104_000);
    proc.emit("exit", 0);

    const result = await promise;
    expect("nonCommandTimeMs" in result.stats).toBe(false);
  });

  it("omits the field when a tool_result carries no correlatable tool_use_id", async () => {
    // ADR 0046 (guardian round 5, architect A1): an uncorrelatable
    // completion record means the stream's attribution cannot be trusted.
    // Ignoring it would leave zero measured command time and synthesize
    // the whole wall clock as model time.
    const proc = makeFakeProc();
    spawnMock.mockReturnValue(proc);
    const promise = invoke({ role: "generator", prompt: "go", cwd: "/tmp/x" });

    proc.stdout.push(
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result" }] },
      }) + "\n",
    );
    await flush();
    vi.setSystemTime(104_000);
    proc.emit("exit", 0);

    const result = await promise;
    expect("nonCommandTimeMs" in result.stats).toBe(false);
  });

  it("records the full wall clock when the measured stream ran no tools", async () => {
    const proc = makeFakeProc();
    spawnMock.mockReturnValue(proc);
    const promise = invoke({ role: "planner", prompt: "go", cwd: "/tmp/x" });

    vi.setSystemTime(103_000);
    proc.emit("exit", 0);

    const result = await promise;
    // Zero command time is a measurement here, not an invented value:
    // the stream was parsed and reported no tool executions.
    expect(result.stats.nonCommandTimeMs).toBe(3_000);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { join } from "node:path";
import type { TerminationReport } from "./kill-tree.js";

const spawnMock = vi.hoisted(() => vi.fn());
const terminateMock = vi.hoisted(() => vi.fn());
const fsMock = vi.hoisted(() => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn((): string => {
    throw new Error("ENOENT");
  }),
}));

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

// The provider materialises the worker agent config on disk; keep unit
// tests off the real home directory.
vi.mock("node:fs", () => ({ ...fsMock, WriteStream: class {} }));
vi.mock("node:os", () => ({ homedir: () => "/home/tester" }));

// Imported AFTER the mocks are wired.
const { invoke, ensureWorkerAgentConfig, KIRO_WORKER_AGENT, WORKER_AGENT_CONFIG } =
  await import("./kiro.js");

const WORKER_CONFIG_PATH = join(
  "/home/tester",
  ".kiro",
  "agents",
  `${KIRO_WORKER_AGENT}.json`,
);

/** A spinner frame as kiro-cli paints it — CR-rewritten, never committed. */
const SPINNER_FRAME = "\r⠋ Dividing up the work...";

interface FakeProc extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
  kill: ReturnType<typeof vi.fn>;
  unref: ReturnType<typeof vi.fn>;
}

function makeFakeProc(): FakeProc {
  const proc = new EventEmitter() as FakeProc;
  proc.stdout = new Readable({ read() {} });
  proc.stderr = new Readable({ read() {} });
  proc.kill = vi.fn(() => true);
  proc.unref = vi.fn();
  return proc;
}

beforeEach(() => {
  spawnMock.mockReset();
  terminateMock.mockReset();
  // Mirror a successful real kill: the tree dies, `exit` follows.
  terminateMock.mockImplementation(async (proc: FakeProc) => {
    setImmediate(() => proc.emit("exit", null));
    return CLEAN_KILL;
  });
  fsMock.mkdirSync.mockClear();
  fsMock.writeFileSync.mockClear();
  fsMock.readFileSync.mockReset();
  fsMock.readFileSync.mockImplementation(() => {
    throw new Error("ENOENT");
  });
});

describe("kiro invoke spawn args", () => {
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
    // Caller-supplied agent configs are the caller's responsibility —
    // the managed worker config is not written.
    expect(fsMock.writeFileSync).not.toHaveBeenCalled();
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

  it("runs prompt-only invocations under the managed worker agent", async () => {
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
    expect(args[args.indexOf("--agent") + 1]).toBe(KIRO_WORKER_AGENT);
  });
});

describe("worker agent config", () => {
  it("writes a config with no sub-agent tools and no MCP servers", async () => {
    const proc = makeFakeProc();
    spawnMock.mockReturnValue(proc);

    const promise = invoke({
      role: "generator",
      prompt: "build",
      cwd: "/tmp/x",
    });
    proc.emit("exit", 0);
    await promise;

    expect(fsMock.writeFileSync).toHaveBeenCalledTimes(1);
    const [path, body] = fsMock.writeFileSync.mock.calls[0]! as [
      string,
      string,
    ];
    expect(path).toBe(WORKER_CONFIG_PATH);
    const config = JSON.parse(body);
    expect(config.name).toBe(KIRO_WORKER_AGENT);
    // The whole point: nothing that can spawn a nested agent.
    for (const banned of ["subagent", "use_subagent", "delegate"]) {
      expect(config.tools).not.toContain(banned);
      expect(config.excludedTools).toContain(banned);
    }
    // No MCP servers, and no inheritance from user/workspace mcp.json.
    expect(config.mcpServers).toEqual({});
    expect(config.useLegacyMcpJson).toBe(false);
    // `includeMcpJson` is a serde alias of `useLegacyMcpJson`; carrying
    // both makes the whole config invalid and kiro-cli falls back to
    // the unrestricted default agent.
    expect(config.includeMcpJson).toBeUndefined();
    // The worker still needs to do real work.
    expect(config.tools).toContain("fs_read");
    expect(config.tools).toContain("fs_write");
    expect(config.tools).toContain("execute_bash");
  });

  it("skips the write when the on-disk config is already current", () => {
    fsMock.readFileSync.mockReturnValue(
      JSON.stringify(WORKER_AGENT_CONFIG, null, 2) + "\n",
    );
    expect(ensureWorkerAgentConfig()).toBe(KIRO_WORKER_AGENT);
    expect(fsMock.writeFileSync).not.toHaveBeenCalled();
  });

  it("overwrites a drifted on-disk config", () => {
    fsMock.readFileSync.mockReturnValue('{"name":"afk-worker","tools":["*"]}');
    ensureWorkerAgentConfig();
    expect(fsMock.writeFileSync).toHaveBeenCalledTimes(1);
  });
});

describe("agent fail-open tripwire", () => {
  it("kills the session when kiro-cli falls back to the default agent", async () => {
    const proc = makeFakeProc();
    spawnMock.mockReturnValue(proc);

    const promise = invoke({
      role: "planner",
      prompt: "go",
      cwd: "/tmp/x",
    });

    proc.stderr.emit(
      "data",
      Buffer.from(
        "Error: no agent with name afk-worker found. Falling back to user specified default\n",
      ),
    );

    await expect(promise).rejects.toThrow(
      /could not load agent config "afk-worker"/,
    );
    expect(terminateMock).toHaveBeenCalledTimes(1);
  });

  it("catches a marker split across chunk boundaries", async () => {
    const proc = makeFakeProc();
    spawnMock.mockReturnValue(proc);

    const promise = invoke({
      role: "planner",
      prompt: "go",
      cwd: "/tmp/x",
    });

    proc.stderr.emit("data", Buffer.from("Error: no agent with na"));
    proc.stderr.emit(
      "data",
      Buffer.from("me afk-worker found. Falling back\n"),
    );

    await expect(promise).rejects.toThrow(/could not load agent config/);
  });
});

describe("liveness and bounds", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("spinner frames do not reset the idle watcher — a hung session dies", async () => {
    const proc = makeFakeProc();
    spawnMock.mockReturnValue(proc);

    const promise = invoke({
      role: "generator",
      prompt: "build",
      cwd: "/tmp/x",
      idleTimeoutMs: 1_000,
      idleWarningIntervalMs: 60_000,
    });

    // Spinner paints a frame every 100ms, forever — the pre-fix
    // behaviour reset the watcher on each frame and never fired.
    proc.stdout.emit("data", Buffer.from(SPINNER_FRAME));
    for (let i = 0; i < 12; i++) {
      vi.advanceTimersByTime(100);
      proc.stdout.emit("data", Buffer.from(SPINNER_FRAME));
    }

    expect(terminateMock).toHaveBeenCalledTimes(1);
    proc.emit("exit", null);
    await expect(promise).rejects.toThrow(/idle for 1s/);
  });

  it("real output lines keep resetting the idle watcher", async () => {
    const proc = makeFakeProc();
    spawnMock.mockReturnValue(proc);

    const promise = invoke({
      role: "generator",
      prompt: "build",
      cwd: "/tmp/x",
      idleTimeoutMs: 1_000,
      idleWarningIntervalMs: 60_000,
    });

    // 4s of wall clock — far past the idle timeout — but with a real
    // line landing every 800ms the watcher must never fire.
    for (let i = 0; i < 5; i++) {
      proc.stdout.emit("data", Buffer.from(`step ${i} done\n`));
      vi.advanceTimersByTime(800);
    }

    expect(terminateMock).not.toHaveBeenCalled();
    proc.emit("exit", 0);
    await expect(promise).resolves.toMatchObject({ exitCode: 0 });
  });

  it("the wall-clock ceiling kills a session even while output flows", async () => {
    const proc = makeFakeProc();
    spawnMock.mockReturnValue(proc);

    const promise = invoke({
      role: "generator",
      prompt: "build",
      cwd: "/tmp/x",
      idleTimeoutMs: 10_000,
      idleWarningIntervalMs: 60_000,
      maxDurationMs: 2_000,
    });

    for (let i = 0; i < 4; i++) {
      proc.stdout.emit("data", Buffer.from(`still going ${i}\n`));
      vi.advanceTimersByTime(500);
    }

    expect(terminateMock).toHaveBeenCalledTimes(1);
    proc.emit("exit", null);
    await expect(promise).rejects.toThrow(/wall-clock ceiling/);
  });
});

describe("kill termination confirmation (ADR 0020)", () => {
  it("appends surviving PIDs to the kill error and the log stream", async () => {
    const proc = makeFakeProc();
    spawnMock.mockReturnValue(proc);
    terminateMock.mockImplementation(async (p: FakeProc) => {
      setImmediate(() => p.emit("exit", null));
      return { rootDead: true, survivors: [4242, 777], verified: true };
    });
    const logged: string[] = [];
    const logStream = { write: (text: string) => logged.push(text) };

    const promise = invoke({
      role: "planner",
      prompt: "go",
      cwd: "/tmp/x",
      logStream: logStream as never,
    });
    proc.stderr.emit(
      "data",
      Buffer.from("Error: no agent with name afk-worker found\n"),
    );

    await expect(promise).rejects.toThrow(
      /WARNING: 2 process\(es\) survived the kill \(PIDs 4242, 777\)/,
    );
    expect(logged.join("")).toContain("survived the kill (PIDs 4242, 777)");
  });

  it("settles even when the child never emits exit because the root would not die", async () => {
    const proc = makeFakeProc();
    spawnMock.mockReturnValue(proc);
    // Root refuses to die: no `exit` will ever fire.
    terminateMock.mockImplementation(async () => ({
      rootDead: false,
      survivors: [1234, 5678],
      verified: true,
    }));

    const promise = invoke({
      role: "planner",
      prompt: "go",
      cwd: "/tmp/x",
    });
    proc.stderr.emit(
      "data",
      Buffer.from("Error: no agent with name afk-worker found\n"),
    );

    await expect(promise).rejects.toThrow(
      /survived the kill \(PIDs 1234, 5678\)/,
    );
    // The kill path releases our ends of the child's handles so
    // orphans cannot wedge the orchestrator's event loop at exit.
    expect(proc.unref).toHaveBeenCalled();
    expect(proc.stdout.destroyed).toBe(true);
    expect(proc.stderr.destroyed).toBe(true);
  });

  it("warns loudly when tree termination could not be verified", async () => {
    const proc = makeFakeProc();
    spawnMock.mockReturnValue(proc);
    terminateMock.mockImplementation(async (p: FakeProc) => {
      setImmediate(() => p.emit("exit", null));
      return { rootDead: true, survivors: [], verified: false };
    });

    const promise = invoke({
      role: "planner",
      prompt: "go",
      cwd: "/tmp/x",
    });
    proc.stderr.emit(
      "data",
      Buffer.from("Error: no agent with name afk-worker found\n"),
    );

    await expect(promise).rejects.toThrow(
      /could not verify process-tree termination/,
    );
  });
});

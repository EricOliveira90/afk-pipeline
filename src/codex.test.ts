import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamEvent } from "./agent-provider.js";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
  spawnSync: vi.fn(),
}));

const {
  codexProvider,
  findManagedCodexAwsProfile,
  handleStreamEvent,
  invoke,
  isRecoverableStreamError,
  parseStreamLine,
  prepareCodexSpawnEnv,
  resolveCodexSpawnEnv,
} = await import("./codex.js");

interface FakeProc extends EventEmitter {
  stdin: Writable;
  stdinText: string;
  stdout: Readable;
  stderr: Readable;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: ReturnType<typeof vi.fn>;
}

function makeFakeProc(): FakeProc {
  const proc = new EventEmitter() as FakeProc;
  proc.stdinText = "";
  proc.stdin = new Writable({
    write(chunk, _encoding, callback) {
      proc.stdinText += chunk.toString();
      callback();
    },
  });
  proc.stdout = new Readable({ read() {} });
  proc.stderr = new Readable({ read() {} });
  proc.exitCode = null;
  proc.signalCode = null;
  proc.kill = vi.fn((signal: NodeJS.Signals) => {
    proc.signalCode = signal;
    setImmediate(() => proc.emit("exit", null));
    return true;
  });
  return proc;
}

function exit(proc: FakeProc, code: number): void {
  proc.exitCode = code;
  proc.emit("exit", code);
}

function jsonLine(value: unknown): string {
  return JSON.stringify(value) + "\n";
}

function commandLine(command = "pnpm test"): string {
  return jsonLine({
    type: "item.started",
    item: { id: "item-1", type: "command_execution", command },
  });
}

describe("Codex JSONL parsing", () => {
  it("maps thread, agent-message, and command events", () => {
    expect(
      parseStreamLine(
        JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
      ),
    ).toEqual([{ type: "session_id", sessionId: "thread-123" }]);
    expect(
      parseStreamLine(
        JSON.stringify({
          type: "item.updated",
          item: { type: "agent_message", text: "working" },
        }),
      ),
    ).toEqual([{ type: "text", text: "working" }]);
    expect(
      parseStreamLine(
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "done" },
        }),
      ),
    ).toEqual([{ type: "result", result: "done" }]);
    expect(parseStreamLine(commandLine("pnpm test").trim())).toEqual([
      { type: "tool_call", name: "command_execution", args: "pnpm test" },
    ]);
  });

  it("ignores malformed and unrelated records", () => {
    expect(parseStreamLine("not json")).toEqual([]);
    expect(parseStreamLine("{broken")).toEqual([]);
    expect(parseStreamLine('{"type":"turn.started"}')).toEqual([]);
  });

  it("turns error and failed records into actionable errors", () => {
    expect(() =>
      parseStreamLine('{"type":"error","message":"authentication expired"}'),
    ).toThrow("Codex error: authentication expired");
    expect(() =>
      parseStreamLine('{"type":"error","message":"Internal server error"}'),
    ).toThrow("Codex error: Internal server error");
    expect(() =>
      parseStreamLine(
        '{"type":"turn.failed","error":{"message":"model unavailable"}}',
      ),
    ).toThrow("Codex turn.failed: model unavailable");
  });

  it("ignores recoverable reconnect error events while Codex retries", () => {
    expect(
      parseStreamLine(
        JSON.stringify({
          type: "error",
          message:
            "Reconnecting... 1/5 (stream disconnected before completion: The server had an error while processing your request. Sorry about that!)",
        }),
      ),
    ).toEqual([]);
    expect(
      parseStreamLine(
        JSON.stringify({
          type: "error",
          message:
            "Reconnecting... 5/5 (stream disconnected before completion: failed to load AWS credentials: the credential provider was not enabled)",
        }),
      ),
    ).toEqual([]);
  });

  it("keeps reconnect wording terminal for turn.failed records", () => {
    expect(() =>
      parseStreamLine(
        JSON.stringify({
          type: "turn.failed",
          error: { message: "Reconnecting... 5/5 (gave up)" },
        }),
      ),
    ).toThrow("Codex turn.failed: Reconnecting... 5/5 (gave up)");
  });

  it("classifies only retry-counter messages as recoverable", () => {
    expect(isRecoverableStreamError("Reconnecting... 1/5 (reason)")).toBe(
      true,
    );
    expect(isRecoverableStreamError("reconnecting 2/5")).toBe(true);
    expect(isRecoverableStreamError("Internal server error")).toBe(false);
    expect(isRecoverableStreamError("Reconnecting failed")).toBe(false);
    expect(isRecoverableStreamError("")).toBe(false);
  });
});

describe("Codex command construction", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it("uses the exact model, ephemeral JSON mode, full trust, and stdin", async () => {
    const proc = makeFakeProc();
    spawnMock.mockReturnValue(proc);

    const promise = invoke({
      role: "planner",
      agent: "ignored-agent",
      bare: true,
      model: "ignored-model",
      prompt: "prompt with & shell characters",
      cwd: "/tmp/repo",
    });
    exit(proc, 0);
    await promise;

    expect(spawnMock).toHaveBeenCalledWith(
      "codex",
      [
        "exec",
        "--json",
        "--ephemeral",
        "--dangerously-bypass-approvals-and-sandbox",
        "--model",
        "openai.gpt-5.6-sol",
        "-c",
        'model_reasoning_effort="high"',
        "-",
      ],
      expect.objectContaining({ cwd: "/tmp/repo" }),
    );
    expect(proc.stdinText).toBe("prompt with & shell characters");
    expect(spawnMock.mock.calls[0]![2]).toEqual(
      expect.objectContaining({ env: expect.any(Object) }),
    );
    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args).not.toContain("ignored-agent");
    expect(args).not.toContain("ignored-model");
    expect(args).not.toContain("--bare");
  });

  it("uses medium reasoning only for explorer", async () => {
    const explorerProc = makeFakeProc();
    const evaluatorProc = makeFakeProc();
    spawnMock
      .mockReturnValueOnce(explorerProc)
      .mockReturnValueOnce(evaluatorProc);

    const explorer = invoke({ role: "explorer", prompt: "x", cwd: "/tmp" });
    exit(explorerProc, 0);
    await explorer;
    const evaluator = invoke({
      role: "evaluator-qa",
      prompt: "x",
      cwd: "/tmp",
    });
    exit(evaluatorProc, 0);
    await evaluator;

    expect(spawnMock.mock.calls[0]![1]).toContain(
      'model_reasoning_effort="medium"',
    );
    expect(spawnMock.mock.calls[1]![1]).toContain(
      'model_reasoning_effort="high"',
    );
  });
});

describe("Codex Bedrock credential inheritance", () => {
  it("finds a managed Codex credential_process profile", () => {
    expect(
      findManagedCodexAwsProfile(`
[profile unrelated]
credential_process = helper credentials

[profile managed-codex]
credential_process = "C:\\Program Files\\Codex\\codex.exe" credential-process
`),
    ).toBe("managed-codex");
  });

  it("selects the managed profile when no inheritable source is set", () => {
    const readConfig = vi.fn(() => `
[profile managed-codex]
credential_process = codex credential-process
`);

    expect(
      resolveCodexSpawnEnv(
        { AWS_CONFIG_FILE: "/custom/aws-config", OTHER: "kept" },
        readConfig,
      ),
    ).toEqual({
      AWS_CONFIG_FILE: "/custom/aws-config",
      AWS_PROFILE: "managed-codex",
      OTHER: "kept",
    });
    expect(readConfig).toHaveBeenCalledWith("/custom/aws-config");
  });

  it.each([
    { AWS_PROFILE: "configured" },
    { AWS_DEFAULT_PROFILE: "configured" },
    { AWS_BEARER_TOKEN_BEDROCK: "configured" },
    { AWS_ACCESS_KEY_ID: "id", AWS_SECRET_ACCESS_KEY: "secret" },
    { AWS_WEB_IDENTITY_TOKEN_FILE: "token", AWS_ROLE_ARN: "role" },
    { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/credentials" },
    { AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://credentials" },
  ])("preserves an existing credential source: $env", (env) => {
    const readConfig = vi.fn();

    expect(resolveCodexSpawnEnv(env, readConfig)).toBe(env);
    expect(readConfig).not.toHaveBeenCalled();
  });

  it("does not treat a partial static credential as usable", () => {
    const env = { AWS_ACCESS_KEY_ID: "id-only" };

    expect(
      resolveCodexSpawnEnv(
        env,
        () => `[profile managed]\ncredential_process = codex credential-process`,
      ),
    ).toEqual({ ...env, AWS_PROFILE: "managed" });
  });
});

describe("Codex invocation lifecycle", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it("counts tools and resolves a successful completion", async () => {
    const proc = makeFakeProc();
    const events: StreamEvent[] = [];
    spawnMock.mockReturnValue(proc);
    const promise = invoke({
      role: "generator",
      prompt: "go",
      cwd: "/tmp",
      onStreamEvent: (event) => events.push(event),
    });

    proc.stdout.push(
      jsonLine({ type: "thread.started", thread_id: "thread-1" }) +
        commandLine("git status") +
        jsonLine({
          type: "item.completed",
          item: { type: "agent_message", text: "complete" },
        }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    exit(proc, 0);

    const result = await promise;
    expect(result.exitCode).toBe(0);
    expect(result.stats.toolCallCount).toBe(1);
    expect(events).toEqual([
      { type: "session_id", sessionId: "thread-1" },
      { type: "tool_call", name: "command_execution", args: "git status" },
      { type: "result", result: "complete" },
    ]);
  });

  it("kills and rejects when the tool-call cap is exceeded", async () => {
    const proc = makeFakeProc();
    spawnMock.mockReturnValue(proc);
    const promise = invoke({
      role: "evaluator-qa",
      prompt: "go",
      cwd: "/tmp",
      maxToolCalls: 2,
    });

    proc.stdout.push(commandLine("one") + commandLine("two") + commandLine("three"));
    await expect(promise).rejects.toThrow(
      "Agent evaluator-qa exceeded 2 tool calls - killed",
    );
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("rejects provider-reported stdout errors", async () => {
    const proc = makeFakeProc();
    spawnMock.mockReturnValue(proc);
    const promise = invoke({ role: "planner", prompt: "go", cwd: "/tmp" });
    proc.stdout.push(jsonLine({ type: "error", message: "login required" }));
    await expect(promise).rejects.toThrow("Codex error: login required");
  });

  it("survives a reconnect error event and resolves on success", async () => {
    const proc = makeFakeProc();
    const events: StreamEvent[] = [];
    spawnMock.mockReturnValue(proc);
    const promise = invoke({
      role: "generator",
      prompt: "go",
      cwd: "/tmp",
      onStreamEvent: (event) => events.push(event),
    });

    proc.stdout.push(
      commandLine("pnpm test") +
        jsonLine({
          type: "error",
          message:
            "Reconnecting... 1/5 (stream disconnected before completion: The server had an error while processing your request. Sorry about that!)",
        }) +
        jsonLine({
          type: "item.completed",
          item: { type: "agent_message", text: "recovered and finished" },
        }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    exit(proc, 0);

    const result = await promise;
    expect(result.exitCode).toBe(0);
    expect(result.stats.toolCallCount).toBe(1);
    expect(proc.kill).not.toHaveBeenCalled();
    expect(events).toEqual([
      { type: "tool_call", name: "command_execution", args: "pnpm test" },
      { type: "result", result: "recovered and finished" },
    ]);
  });

  it("still fails terminally after reconnects when the turn fails", async () => {
    const proc = makeFakeProc();
    spawnMock.mockReturnValue(proc);
    const promise = invoke({ role: "generator", prompt: "go", cwd: "/tmp" });

    proc.stdout.push(
      jsonLine({
        type: "error",
        message: "Reconnecting... 5/5 (stream disconnected before completion)",
      }) +
        jsonLine({
          type: "turn.failed",
          error: { message: "Internal server error" },
        }),
    );
    await expect(promise).rejects.toThrow(
      "Codex turn.failed: Internal server error",
    );
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("includes stderr in nonzero-exit errors", async () => {
    const proc = makeFakeProc();
    spawnMock.mockReturnValue(proc);
    const promise = invoke({ role: "planner", prompt: "go", cwd: "/tmp" });
    proc.stderr.push("unknown model\n");
    await new Promise((resolve) => setImmediate(resolve));
    exit(proc, 2);
    await expect(promise).rejects.toThrow(
      "Agent planner exited with code 2: unknown model",
    );
  });

  it("cancels an in-flight process", async () => {
    const proc = makeFakeProc();
    const controller = new AbortController();
    spawnMock.mockReturnValue(proc);
    const promise = invoke({
      role: "generator",
      prompt: "go",
      cwd: "/tmp",
      signal: controller.signal,
    });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: "CancelledError" });
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("rejects immediately when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      invoke({
        role: "generator",
        prompt: "go",
        cwd: "/tmp",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "CancelledError" });
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe("Codex provider metadata and event handling", () => {
  it("uses the codex namespace", () => {
    expect(codexProvider.name).toBe("codex");
    expect(codexProvider.parseStreamLine).toBe(parseStreamLine);
  });

  it("resets liveness and increments only for tool calls", () => {
    const reset = vi.fn();
    const onStreamEvent = vi.fn();
    const result = handleStreamEvent({
      event: { type: "tool_call", name: "command_execution", args: "ls" },
      watcher: { reset },
      toolCallCount: 0,
      maxToolCalls: 1,
      onStreamEvent,
    });
    expect(result).toEqual({ toolCallCount: 1, capExceeded: false });
    expect(reset).toHaveBeenCalledOnce();
    expect(onStreamEvent).toHaveBeenCalledOnce();
  });
});


/**
 * ADR 0015: the codex wrapper persists the file named by AWS_CONFIG_FILE.
 * Concurrent invocations sharing that file race on the persist rename and
 * the loser dies at spawn ("failed to persist AWS config file: … Access is
 * denied. (os error 5)" — observed in the PRD 070 run). Each invocation
 * must therefore get its own throwaway copy.
 */
describe("prepareCodexSpawnEnv AWS config isolation", () => {
  function makeConfigDir(content: string): { dir: string; source: string } {
    const dir = mkdtempSync(join(tmpdir(), "afk-awscfg-"));
    const source = join(dir, "config");
    writeFileSync(source, content, "utf-8");
    return { dir, source };
  }

  it("gives each invocation its own temp copy of AWS_CONFIG_FILE and cleans it up", () => {
    const { dir, source } = makeConfigDir("[profile p]\nregion = us-east-1\n");
    const env: NodeJS.ProcessEnv = { AWS_CONFIG_FILE: source };
    const a = prepareCodexSpawnEnv(env);
    const b = prepareCodexSpawnEnv(env);
    try {
      expect(a.env.AWS_CONFIG_FILE).toBeDefined();
      expect(a.env.AWS_CONFIG_FILE).not.toBe(source);
      expect(b.env.AWS_CONFIG_FILE).not.toBe(source);
      // The regression: two concurrent invocations must never share a file.
      expect(a.env.AWS_CONFIG_FILE).not.toBe(b.env.AWS_CONFIG_FILE);
      expect(readFileSync(a.env.AWS_CONFIG_FILE!, "utf-8")).toBe(
        readFileSync(source, "utf-8"),
      );
      const aCopy = a.env.AWS_CONFIG_FILE!;
      a.cleanup();
      expect(existsSync(aCopy)).toBe(false);
      // Cleanup never touches the operator's real config.
      expect(existsSync(source)).toBe(true);
    } finally {
      a.cleanup();
      b.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still resolves the managed codex profile while isolating the config copy", () => {
    const { dir, source } = makeConfigDir(
      '[profile codex-managed]\ncredential_process = codex credential-process\n',
    );
    const prepared = prepareCodexSpawnEnv({ AWS_CONFIG_FILE: source });
    try {
      expect(prepared.env.AWS_PROFILE).toBe("codex-managed");
      expect(prepared.env.AWS_CONFIG_FILE).not.toBe(source);
    } finally {
      prepared.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the shared env when the config file does not exist", () => {
    const missing = join(tmpdir(), "afk-awscfg-does-not-exist", "config");
    const prepared = prepareCodexSpawnEnv({ AWS_CONFIG_FILE: missing });
    expect(prepared.env.AWS_CONFIG_FILE).toBe(missing);
    expect(() => prepared.cleanup()).not.toThrow();
  });
});

describe("codex invoke AWS config isolation (regression: PRD 070 persist race)", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it("spawns concurrent invocations with distinct config copies and removes them on exit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "afk-awscfg-invoke-"));
    const source = join(dir, "config");
    writeFileSync(source, "[profile p]\nregion = us-east-1\n", "utf-8");
    const saved = process.env.AWS_CONFIG_FILE;
    process.env.AWS_CONFIG_FILE = source;
    try {
      const procA = makeFakeProc();
      const procB = makeFakeProc();
      spawnMock.mockReturnValueOnce(procA).mockReturnValueOnce(procB);

      const promiseA = invoke({ role: "architect-review", prompt: "go", cwd: "/tmp" });
      const promiseB = invoke({ role: "pm-review", prompt: "go", cwd: "/tmp" });

      const envA = (spawnMock.mock.calls[0]![2] as { env: NodeJS.ProcessEnv }).env;
      const envB = (spawnMock.mock.calls[1]![2] as { env: NodeJS.ProcessEnv }).env;
      expect(envA.AWS_CONFIG_FILE).not.toBe(source);
      expect(envB.AWS_CONFIG_FILE).not.toBe(source);
      expect(envA.AWS_CONFIG_FILE).not.toBe(envB.AWS_CONFIG_FILE);
      expect(existsSync(envA.AWS_CONFIG_FILE!)).toBe(true);
      expect(existsSync(envB.AWS_CONFIG_FILE!)).toBe(true);

      exit(procA, 0);
      exit(procB, 0);
      await promiseA;
      await promiseB;

      // Per-invocation copies are reaped once the child exits.
      expect(existsSync(envA.AWS_CONFIG_FILE!)).toBe(false);
      expect(existsSync(envB.AWS_CONFIG_FILE!)).toBe(false);
      expect(existsSync(source)).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.AWS_CONFIG_FILE;
      else process.env.AWS_CONFIG_FILE = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

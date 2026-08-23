import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { TerminationReport } from "./kill-tree.js";
import { emitExit, makeFakeProc, type FakeProc } from "./test/fake-proc.js";

const spawnMock = vi.hoisted(() => vi.fn());
const terminateMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
  spawnSync: vi.fn(),
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

beforeEach(() => {
  terminateMock.mockReset();
  // Mirror a successful real kill: the tree dies, `exit` follows.
  terminateMock.mockImplementation(async (proc: FakeProc) => {
    setImmediate(() => proc.emit("exit", null));
    return CLEAN_KILL;
  });
});

const {
  codexProvider,
  findManagedCodexAwsProfile,
  invoke,
  isRecoverableStreamError,
  parseStreamLine,
  prepareCodexSpawnEnv,
  resolveCodexSpawnEnv,
} = await import("./codex.js");

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
    emitExit(proc, 0);
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
    emitExit(explorerProc, 0);
    await explorer;
    const evaluator = invoke({
      role: "evaluator-qa",
      prompt: "x",
      cwd: "/tmp",
    });
    emitExit(evaluatorProc, 0);
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

describe("Codex runtime hooks", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it("rejects provider-reported stdout errors", async () => {
    const proc = makeFakeProc();
    spawnMock.mockReturnValue(proc);
    const promise = invoke({ role: "planner", prompt: "go", cwd: "/tmp" });
    proc.stdout.push(jsonLine({ type: "error", message: "login required" }));
    await expect(promise).rejects.toThrow("Codex error: login required");
  });

  it("includes stderr detail in nonzero-exit errors", async () => {
    const proc = makeFakeProc();
    spawnMock.mockReturnValue(proc);
    const promise = invoke({ role: "planner", prompt: "go", cwd: "/tmp" });
    proc.stderr.push("unknown model\n");
    await new Promise((resolve) => setImmediate(resolve));
    emitExit(proc, 2);
    await expect(promise).rejects.toThrow(
      "Agent planner exited with code 2: unknown model",
    );
  });
});
describe("Codex provider metadata", () => {
  it("uses the codex namespace and parser", () => {
    expect(codexProvider.name).toBe("codex");
    expect(codexProvider.parseStreamLine).toBe(parseStreamLine);
  });
});
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

      emitExit(procA, 0);
      emitExit(procB, 0);
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

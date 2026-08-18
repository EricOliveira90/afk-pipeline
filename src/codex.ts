import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentProvider,
  InvokeOptions,
  InvokeResult,
  StreamEvent,
} from "./agent-provider.js";
import { CancelledError } from "./agent-provider.js";
import { createIdleWatcher } from "./idle-watcher.js";
import { createBusyProbe } from "./busy-probe.js";
import {
  formatTerminationWarning,
  terminateProcessTree,
  type TerminationReport,
} from "./kill-tree.js";

const MODEL = "openai.gpt-5.6-sol";

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null
    ? (value as JsonObject)
    : undefined;
}

function eventError(obj: JsonObject): string | undefined {
  const error = asObject(obj.error);
  if (typeof obj.message === "string") return obj.message;
  if (typeof error?.message === "string") return error.message;
  return undefined;
}

/** Find an AWS profile whose credential_process delegates to managed Codex. */
export function findManagedCodexAwsProfile(
  awsConfig: string,
): string | undefined {
  let profile: string | undefined;

  for (const rawLine of awsConfig.split(/\r?\n/)) {
    const section = rawLine.match(/^\s*\[(?:profile\s+)?([^\]]+)\]\s*$/i);
    if (section) {
      profile = section[1]?.trim();
      continue;
    }

    const setting = rawLine.match(/^\s*credential_process\s*=\s*(.+?)\s*$/i);
    if (
      profile &&
      setting?.[1] &&
      /\bcodex(?:\.exe)?["']?\s+credential-process(?:\s|$)/i.test(setting[1])
    ) {
      return profile;
    }
  }

  return undefined;
}

/**
 * Toolbox's top-level Codex wrapper can use managed credentials directly, but
 * nested codex processes need an AWS SDK source they can inherit. Select the
 * generated credential_process profile without resolving or copying secrets.
 */
export function resolveCodexSpawnEnv(
  env: NodeJS.ProcessEnv,
  readConfig: (path: string) => string = (path) =>
    readFileSync(path, "utf-8"),
): NodeJS.ProcessEnv {
  const hasCredentialSource = Boolean(
    env.AWS_PROFILE ||
      env.AWS_DEFAULT_PROFILE ||
      env.AWS_BEARER_TOKEN_BEDROCK ||
      (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) ||
      (env.AWS_WEB_IDENTITY_TOKEN_FILE && env.AWS_ROLE_ARN) ||
      env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ||
      env.AWS_CONTAINER_CREDENTIALS_FULL_URI,
  );
  if (hasCredentialSource) {
    return env;
  }

  const configPath =
    env.AWS_CONFIG_FILE ?? join(homedir(), ".aws", "config");
  try {
    const profile = findManagedCodexAwsProfile(readConfig(configPath));
    return profile ? { ...env, AWS_PROFILE: profile } : env;
  } catch {
    return env;
  }
}

/** Env plus the teardown that removes any per-invocation temp state. */
export interface PreparedCodexEnv {
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
}

const NO_CLEANUP = () => {};

/**
 * Build the child env for one codex invocation, giving it a private copy
 * of the AWS config file.
 *
 * The codex wrapper persists the file named by `AWS_CONFIG_FILE` (default
 * `~/.aws/config`) via a write-temp-then-rename. When two invocations run
 * concurrently — the architect and PM guardian reviews always used to —
 * the renames race and the loser dies at spawn with `failed to persist
 * AWS config file: … Access is denied. (os error 5)` (PRD 070, ADR 0015).
 * Pointing each child at its own throwaway copy removes the shared file.
 *
 * Wrapper writes land in the copy and are discarded on cleanup; that is
 * intended — ephemeral agent invocations must not mutate the operator's
 * real AWS config. Any failure to isolate falls back to the shared file
 * rather than blocking the invocation.
 */
export function prepareCodexSpawnEnv(
  env: NodeJS.ProcessEnv,
  readConfig?: (path: string) => string,
): PreparedCodexEnv {
  const resolved = readConfig
    ? resolveCodexSpawnEnv(env, readConfig)
    : resolveCodexSpawnEnv(env);
  const sourcePath =
    resolved.AWS_CONFIG_FILE ?? join(homedir(), ".aws", "config");
  try {
    if (!existsSync(sourcePath)) {
      return { env: resolved, cleanup: NO_CLEANUP };
    }
    const scratchDir = mkdtempSync(join(tmpdir(), "afk-codex-aws-"));
    const configCopy = join(scratchDir, "config");
    copyFileSync(sourcePath, configCopy);
    return {
      env: { ...resolved, AWS_CONFIG_FILE: configCopy },
      cleanup: () => {
        try {
          rmSync(scratchDir, { recursive: true, force: true });
        } catch {
          // Temp cleanup is best-effort; the OS reaps tmpdir eventually.
        }
      },
    };
  } catch {
    return { env: resolved, cleanup: NO_CLEANUP };
  }
}

export class CodexProviderError extends Error {
  constructor(eventType: string, message: string) {
    super(`Codex ${eventType}: ${message}`);
    this.name = "CodexProviderError";
  }
}

/**
 * Codex emits `type: "error"` records for recoverable transport drops while
 * it retries internally, e.g. `Reconnecting... 1/5 (stream disconnected
 * before completion: ...)`. These must not kill the invocation: Codex either
 * recovers and continues the turn, or exhausts its retries and reports a
 * terminal `turn.failed` / nonzero exit. Only messages carrying the retry
 * counter are treated as recoverable, so unknown error shapes stay terminal.
 */
export function isRecoverableStreamError(message: string): boolean {
  return /^\s*reconnecting\b\D*\d+\s*\/\s*\d+/i.test(message);
}

/** Parse one `codex exec --json` JSONL record. */
export function parseStreamLine(line: string): StreamEvent[] {
  if (!line.trimStart().startsWith("{")) return [];

  let obj: JsonObject;
  try {
    obj = JSON.parse(line) as JsonObject;
  } catch {
    return [];
  }

  const eventType = typeof obj.type === "string" ? obj.type : "";
  if (eventType === "error" || eventType.endsWith(".failed")) {
    const message =
      eventError(obj) ?? "the CLI reported an unspecified failure";
    if (eventType === "error" && isRecoverableStreamError(message)) {
      return [];
    }
    throw new CodexProviderError(eventType || "error", message);
  }

  if (
    eventType === "thread.started" &&
    typeof obj.thread_id === "string"
  ) {
    return [{ type: "session_id", sessionId: obj.thread_id }];
  }

  const item = asObject(obj.item);
  if (!item || typeof item.type !== "string") return [];

  if (
    eventType === "item.started" &&
    item.type === "command_execution"
  ) {
    const command =
      typeof item.command === "string"
        ? item.command
        : JSON.stringify(item.command ?? "");
    return [{ type: "tool_call", name: "command_execution", args: command }];
  }

  if (
    eventType === "item.updated" &&
    item.type === "agent_message" &&
    typeof item.text === "string"
  ) {
    return [{ type: "text", text: item.text }];
  }

  if (
    eventType === "item.completed" &&
    item.type === "agent_message" &&
    typeof item.text === "string"
  ) {
    return [{ type: "result", result: item.text }];
  }

  return [];
}

export function handleStreamEvent(args: {
  event: StreamEvent;
  watcher: { reset: () => void };
  toolCallCount: number;
  maxToolCalls: number;
  onStreamEvent?: (event: StreamEvent) => void;
}): { toolCallCount: number; capExceeded: boolean } {
  const { event, watcher, maxToolCalls, onStreamEvent } = args;
  let { toolCallCount } = args;
  let capExceeded = false;

  if (event.type === "tool_call") {
    watcher.reset();
    toolCallCount++;
    capExceeded = toolCallCount > maxToolCalls;
  }

  onStreamEvent?.(event);
  return { toolCallCount, capExceeded };
}

export function invoke(options: InvokeOptions): Promise<InvokeResult> {
  const {
    role,
    prompt,
    cwd,
    logStream,
    idleTimeoutMs = 180_000,
    idleWarningIntervalMs = 60_000,
    maxToolCalls = 100,
    maxDurationMs = 3_600_000,
    signal,
    onIdleWarning,
    onStreamEvent,
  } = options;
  const reasoningEffort = role === "explorer" ? "medium" : "high";

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CancelledError());
      return;
    }

    const args = [
      "exec",
      "--json",
      "--ephemeral",
      "--dangerously-bypass-approvals-and-sandbox",
      "--model",
      MODEL,
      "-c",
      `model_reasoning_effort="${reasoningEffort}"`,
      "-",
    ];
    const preparedEnv = prepareCodexSpawnEnv(process.env);
    const proc = spawn("codex", args, {
      cwd,
      env: preparedEnv.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
    });

    proc.stdin!.write(prompt);
    proc.stdin!.end();

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let buffer = "";
    let toolCallCount = 0;
    let killed = false;
    let ceilingHit = false;
    let toolCapExceeded = false;
    let cancelled = false;
    let providerError: Error | undefined;
    let settled = false;
    let termination: Promise<TerminationReport> | undefined;
    const busyProbe = createBusyProbe(proc.pid);
    let busyDescendants = 0;

    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      watcher.stop();
      clearTimeout(ceilingTimer);
      signal?.removeEventListener("abort", onAbort);
      preparedEnv.cleanup();
      finish();
    };

    // See kiro.ts / ADR 0020 for the rationale of the shared kill
    // machinery below: tree-first verified kills, settlement decoupled
    // from the `exit` event, and stdio release so surviving orphans
    // cannot hold the orchestrator's event loop open.
    const releaseChildHandles = () => {
      proc.stdout?.destroy();
      proc.stderr?.destroy();
      proc.stdin?.destroy();
      proc.unref();
    };

    const killedError = (): Error => {
      if (cancelled) return new CancelledError(`Agent ${role} cancelled`);
      if (providerError) return providerError;
      if (toolCapExceeded) {
        return new Error(
          `Agent ${role} exceeded ${maxToolCalls} tool calls - killed`,
        );
      }
      if (ceilingHit) {
        return new Error(
          `Agent ${role} exceeded ${maxDurationMs / 1000}s wall-clock ceiling - killed`,
        );
      }
      if (killed) {
        return new Error(
          `Agent ${role} idle for ${idleTimeoutMs / 1000}s - killed`,
        );
      }
      return new Error(`Agent ${role} was killed`);
    };

    const settleKill = (report: TerminationReport) =>
      settle(() => {
        releaseChildHandles();
        const error = killedError();
        const warning = formatTerminationWarning(report);
        if (warning) {
          error.message += ` - ${warning}`;
          logStream?.write(`\n${warning}\n`);
        }
        reject(error);
      });

    const stopProcess = () => {
      if (termination) return;
      termination = terminateProcessTree(proc);
      void termination.then((report) => {
        if (!report.rootDead) settleKill(report);
      });
    };

    const onAbort = () => {
      cancelled = true;
      stopProcess();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const watcher = createIdleWatcher({
      idleTimeoutMs,
      idleWarningIntervalMs,
      onTimeout: () => {
        killed = true;
        stopProcess();
      },
      onWarning: onIdleWarning,
      // The tool_call reset (handleStreamEvent) only fires once when a
      // command STARTS; a suite that then runs silently past the idle
      // floor still got killed. Defer while the process tree holds
      // PIDs outside the post-spawn baseline — a live spawned command.
      // The wall-clock ceiling still bounds the invocation. ADR 0021.
      shouldDefer: async () => {
        busyDescendants = await busyProbe.check();
        return busyDescendants > 0;
      },
      onDefer: () => {
        logStream?.write(
          `\n[afk] ${role} silent for ${idleTimeoutMs / 1000}s but ` +
            `${busyDescendants} spawned process(es) still running — ` +
            `deferring idle kill (wall-clock ceiling still applies)\n`,
        );
      },
    });

    // Wall-clock ceiling — independent of the idle watcher and the
    // tool-call cap, so a hung session that keeps emitting output
    // still dies. See ADR 0016.
    const ceilingTimer = setTimeout(() => {
      ceilingHit = true;
      stopProcess();
    }, maxDurationMs);
    ceilingTimer.unref();

    const processLine = (line: string) => {
      if (!line) return;
      try {
        for (const event of parseStreamLine(line)) {
          const next = handleStreamEvent({
            event,
            watcher,
            toolCallCount,
            maxToolCalls,
            onStreamEvent,
          });
          toolCallCount = next.toolCallCount;
          if (next.capExceeded && !toolCapExceeded) {
            toolCapExceeded = true;
            killed = true;
            stopProcess();
          }
        }
      } catch (error) {
        if (!providerError) {
          providerError =
            error instanceof Error ? error : new Error(String(error));
          stopProcess();
        }
      }
    };

    proc.stdout!.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdoutChunks.push(text);
      logStream?.write(text);
      watcher.reset();

      buffer += text;
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        processLine(buffer.slice(0, newlineIndex).trim());
        buffer = buffer.slice(newlineIndex + 1);
      }
    });

    proc.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderrChunks.push(text);
      logStream?.write(text);
      watcher.reset();
    });

    proc.on("error", (error) => {
      settle(() => reject(error));
    });

    proc.on("exit", (code) => {
      processLine(buffer.trim());
      // A kill was issued: hold the outcome until the termination
      // report confirms (or denies) that the whole tree is gone.
      if (termination) {
        void termination.then(settleKill);
        return;
      }
      settle(() => {
        const exitCode = code ?? 1;
        if (providerError) {
          reject(providerError);
        } else if (exitCode !== 0) {
          const detail = stderrChunks.join("").trim();
          reject(
            new Error(
              `Agent ${role} exited with code ${exitCode}${
                detail ? `: ${detail}` : ""
              }`,
            ),
          );
        } else {
          resolve({
            exitCode,
            stdout: stdoutChunks.join(""),
            stats: { toolCallCount },
          });
        }
      });
    });
  });
}

export const codexProvider: AgentProvider = {
  name: "codex",
  invoke,
  parseStreamLine,
};

import { spawn } from "node:child_process";
import type {
  AgentProvider,
  InvokeOptions,
  InvokeResult,
  StreamEvent,
} from "./agent-provider.js";
import { CancelledError } from "./agent-provider.js";
import { createIdleWatcher } from "./idle-watcher.js";
import { killProcessTree } from "./kill-tree.js";

/**
 * After SIGTERM, give the child this long to exit cleanly before we
 * force-kill the whole tree. Important on Windows where SIGTERM on a
 * shell-wrapped process doesn't propagate to the wrapped binary.
 */
const FORCE_KILL_GRACE_MS = 10_000;

interface ClaudeInvokeOptions extends InvokeOptions {
  /** Model alias or full ID. Default: opus */
  model?: string;
}

/** Tools whose calls we surface as stream events. Mirrors src/AgentProvider.ts. */
const TOOL_ARG_FIELDS: Record<string, string> = {
  Bash: "command",
  WebSearch: "query",
  WebFetch: "url",
  Agent: "description",
};

/**
 * Parse one line of `claude --output-format stream-json` output into
 * zero or more stream events. Mirrors src/AgentProvider.ts
 * `parseStreamJsonLine`. See ADR 0004.
 */
export function parseStreamLine(line: string): StreamEvent[] {
  if (!line.startsWith("{")) return [];
  try {
    const obj = JSON.parse(line);
    if (obj.type === "assistant" && Array.isArray(obj.message?.content)) {
      const events: StreamEvent[] = [];
      const texts: string[] = [];
      for (const block of obj.message.content as {
        type: string;
        text?: string;
        name?: string;
        input?: Record<string, unknown>;
      }[]) {
        if (block.type === "text" && typeof block.text === "string") {
          texts.push(block.text);
        } else if (
          block.type === "tool_use" &&
          typeof block.name === "string" &&
          block.input !== undefined
        ) {
          const argField = TOOL_ARG_FIELDS[block.name];
          if (argField === undefined) continue;
          const argValue = block.input[argField];
          if (typeof argValue !== "string") continue;
          if (texts.length > 0) {
            events.push({ type: "text", text: texts.join("") });
            texts.length = 0;
          }
          events.push({
            type: "tool_call",
            name: block.name,
            args: argValue,
          });
        }
      }
      if (texts.length > 0) {
        events.push({ type: "text", text: texts.join("") });
      }
      return events;
    }
    if (obj.type === "result" && typeof obj.result === "string") {
      return [{ type: "result", result: obj.result }];
    }
    if (
      obj.type === "system" &&
      obj.subtype === "init" &&
      typeof obj.session_id === "string"
    ) {
      return [{ type: "session_id", sessionId: obj.session_id }];
    }
  } catch {
    // Not valid JSON — skip
  }
  return [];
}

/**
 * Per-event handler for the parsed stream. Centralises the idle-watcher
 * reset and the tool-call cap so they can be unit-tested without
 * spawning a child process. See ADR 0008.
 *
 * Idle reset on `tool_call` matters because the agent may emit a Bash
 * tool_call and then wait silently while the harness backgrounds the
 * command — chunks of stdout from the agent stop, but the session is
 * healthy. Without this reset, a long `pnpm test` invocation would
 * trip the idle floor and the agent would be killed mid-implementation.
 */
export function handleStreamEvent(args: {
  event: StreamEvent;
  watcher: { reset: () => void };
  toolCallCount: number;
  maxToolCalls: number;
  onStreamEvent?: (e: StreamEvent) => void;
}): { toolCallCount: number; capExceeded: boolean } {
  const { event, watcher, maxToolCalls, onStreamEvent } = args;
  let { toolCallCount } = args;
  let capExceeded = false;

  if (event.type === "tool_call") {
    watcher.reset();
    toolCallCount++;
    if (toolCallCount > maxToolCalls) capExceeded = true;
  }

  onStreamEvent?.(event);
  return { toolCallCount, capExceeded };
}

/**
 * Invoke `claude -p` in non-interactive mode with a specific agent and prompt.
 * Streams stream-json output line-by-line, parses events, and surfaces them
 * via onStreamEvent. The final `result` event carries cost/usage; we surface
 * cost on the resolved value.
 */
export function invoke(options: ClaudeInvokeOptions): Promise<InvokeResult> {
  const {
    role,
    agent,
    prompt,
    cwd,
    logStream,
    idleTimeoutMs = 180_000,
    idleWarningIntervalMs = 60_000,
    maxToolCalls = 100,
    signal,
    onIdleWarning,
    onStreamEvent,
    model = "opus",
  } = options;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CancelledError());
      return;
    }

    // Pass the prompt via stdin instead of argv. Avoids Windows cmd.exe
    // argv-reparsing breakage where prompts containing `:`, `"`, `&`, `(`,
    // `)`, etc. get truncated or mangled.
    const args = [
      "-p",
      ...(agent ? ["--agent", agent] : []),
      "--dangerously-skip-permissions",
      "--model",
      model,
      "--output-format",
      "stream-json",
      "--verbose",
    ];

    const proc = spawn("claude", args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
    });

    proc.stdin!.write(prompt);
    proc.stdin!.end();

    const stdoutChunks: string[] = [];
    let buffer = "";
    let costUsd: number | undefined;
    let toolCallCount = 0;
    let killed = false;
    let toolCapExceeded = false;
    let cancelled = false;

    const scheduleForceKill = () => {
      const timer = setTimeout(() => {
        if (proc.exitCode === null && proc.signalCode === null) {
          killProcessTree(proc);
        }
      }, FORCE_KILL_GRACE_MS);
      timer.unref();
    };

    const onAbort = () => {
      cancelled = true;
      proc.kill("SIGTERM");
      scheduleForceKill();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const watcher = createIdleWatcher({
      idleTimeoutMs,
      idleWarningIntervalMs,
      onTimeout: () => {
        killed = true;
        proc.kill("SIGTERM");
        scheduleForceKill();
      },
      onWarning: onIdleWarning,
    });

    proc.stdout!.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdoutChunks.push(text);
      logStream?.write(text);
      watcher.reset();

      buffer += text;
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;

        // Cost extraction — direct JSON peek (the parsed StreamEvent
        // doesn't carry total_cost_usd; that field lives only on the
        // raw `result` envelope).
        if (line.startsWith("{")) {
          try {
            const evt = JSON.parse(line);
            if (evt.type === "result" && typeof evt.total_cost_usd === "number") {
              costUsd = evt.total_cost_usd;
            }
          } catch {
            // not JSON — fine, parseStreamLine returns [] below
          }
        }

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
            proc.kill("SIGTERM");
            scheduleForceKill();
          }
        }
      }
    });

    proc.stderr!.on("data", (chunk: Buffer) => {
      logStream?.write(chunk.toString());
      watcher.reset();
    });

    proc.on("error", (err) => {
      watcher.stop();
      signal?.removeEventListener("abort", onAbort);
      reject(err);
    });

    proc.on("exit", (code) => {
      watcher.stop();
      signal?.removeEventListener("abort", onAbort);
      const exitCode = code ?? 1;
      if (cancelled) {
        reject(new CancelledError(`Agent ${role} cancelled`));
      } else if (toolCapExceeded) {
        reject(
          new Error(
            `Agent ${role} exceeded ${maxToolCalls} tool calls — killed`,
          ),
        );
      } else if (killed) {
        reject(
          new Error(
            `Agent ${role} idle for ${idleTimeoutMs / 1000}s — killed`,
          ),
        );
      } else if (exitCode !== 0) {
        reject(new Error(`Agent ${role} exited with code ${exitCode}`));
      } else {
        resolve({
          exitCode,
          stdout: stdoutChunks.join(""),
          stats: { costUsd, toolCallCount },
        });
      }
    });
  });
}

export const claudeProvider: AgentProvider = {
  name: "claude-code",
  invoke,
  parseStreamLine,
};

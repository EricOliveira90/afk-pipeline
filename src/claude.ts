import type {
  AgentProvider,
  InvokeOptions,
  InvokeResult,
  StreamEvent,
} from "./agent-provider.js";
import { runInvocation } from "./invocation-runtime.js";

const DEFAULT_MODEL = "claude-opus-5";
const EXPLORER_MODEL = "claude-sonnet-5";

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
 * Invoke `claude -p` in non-interactive mode with a specific agent and prompt.
 * Streams stream-json output line-by-line, parses events, and surfaces them
 * via onStreamEvent. The final `result` event carries cost/usage; we surface
 * cost on the resolved value.
 */
export function invoke(options: InvokeOptions): Promise<InvokeResult> {
  return runInvocation(options, () => {
    const { role, agent, prompt, cwd } = options;
    const bare = options.bare === true;
    const model =
      options.model ?? (role === "explorer" ? EXPLORER_MODEL : DEFAULT_MODEL);

    // Pass the prompt via stdin instead of argv. Avoids Windows cmd.exe
    // argv-reparsing breakage where prompts containing `:`, `"`, `&`, `(`,
    // `)`, etc. get truncated or mangled.
    //
    // `--bare` mode strips plugin SessionStart hooks (which can hijack
    // the agent into producing fake `<tool_use>` text — see ADR 0011),
    // MCP servers, and CLAUDE.md auto-discovery. In return we re-grant
    // the standard tool set and `cwd` access explicitly, and drop
    // `--agent` because plugin-provided agents are not loaded in bare
    // mode (the persona has to live in the prompt).
    const args = bare
      ? [
          "-p",
          "--bare",
          "--tools",
          "default",
          "--add-dir",
          cwd,
          "--dangerously-skip-permissions",
          "--model",
          model,
          "--output-format",
          "stream-json",
          "--verbose",
        ]
      : [
          "-p",
          ...(agent ? ["--agent", agent] : []),
          // Isolate subagents from the invoking session's MCP servers. Unlike
          // `--bare` (above), the `--agent` path keeps MCP auto-discovery, so
          // user-level servers connect into each `claude -p` child
          // non-deterministically. Strict loads no inherited MCP servers, so
          // the per-agent allowlist remains deterministic.
          "--strict-mcp-config",
          "--dangerously-skip-permissions",
          "--model",
          model,
          "--output-format",
          "stream-json",
          "--verbose",
        ];
    let costUsd: number | undefined;

    return {
      command: "claude",
      args,
      shell: process.platform === "win32",
      stdin: prompt,
      parseStreamLine: (line) => {
        if (line.startsWith("{")) {
          try {
            const event = JSON.parse(line);
            if (
              event.type === "result" &&
              typeof event.total_cost_usd === "number"
            ) {
              costUsd = event.total_cost_usd;
            }
          } catch {
            // parseStreamLine handles malformed input below.
          }
        }
        return parseStreamLine(line);
      },
      stats: () => ({ costUsd }),
    };
  });
}

export const claudeProvider: AgentProvider = {
  name: "claude-code",
  invoke,
  parseStreamLine,
};

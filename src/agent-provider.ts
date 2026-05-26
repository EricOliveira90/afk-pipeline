import { WriteStream } from "node:fs";

/**
 * Typed event parsed from a provider's streamed stdout. Mirrors
 * Sandcastle's ParsedStreamEvent (src/AgentProvider.ts) so codex's
 * existing parser can lift in verbatim. See ADR 0004.
 */
export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; name: string; args: string }
  | { type: "result"; result: string }
  | { type: "session_id"; sessionId: string };

export interface InvokeOptions {
  /**
   * Identifier for logs and error messages (e.g. "planner",
   * "evaluator-contract"). Always set, regardless of whether the
   * invocation uses an agent config.
   */
  role: string;
  /**
   * Agent config name passed via `--agent`. When undefined, providers
   * skip the flag — the persona must live in the prompt itself
   * (prompt-only invocation, like Sandcastle).
   */
  agent?: string;
  prompt: string;
  cwd: string;
  /** Optional log stream to write raw stdout to */
  logStream?: WriteStream;
  /** Idle timeout in ms — hard kill threshold. Default: 180_000 (3 min). See ADR 0007. */
  idleTimeoutMs?: number;
  /** Idle-warning interval in ms. Default: 60_000 (1 min). See CONTEXT.md "Idle warning". */
  idleWarningIntervalMs?: number;
  /**
   * Hard cap on tool calls per invocation — kills the session when
   * exceeded. Catches "talky" loops where the agent keeps emitting
   * tool calls without making progress (which never trips the idle
   * watcher). Default: 100. Only enforced by providers that parse
   * a structured stream. See ADR 0007.
   */
  maxToolCalls?: number;
  /** Cancellation signal — when fired, the spawned process is killed. */
  signal?: AbortSignal;
  /**
   * Run the underlying CLI in "bare" mode — strips plugin hooks,
   * MCP servers, and CLAUDE.md auto-discovery. Used for guardian
   * reviews where third-party `SessionStart` hooks (e.g. the
   * `superpowers:using-superpowers` plugin) inject directives that
   * coerce the agent into emitting fake `<tool_use>` text and
   * exiting after one turn — see ADR 0011. The persona must be
   * carried in the prompt; `agent` is ignored. Provider-specific:
   * only the `claude` provider implements this; other providers
   * silently ignore it.
   */
  bare?: boolean;
  /** Called periodically while the agent produces no stdout. `minutes` = elapsed idle minutes. */
  onIdleWarning?: (minutes: number) => void;
  /** Called for each parsed stream event. Only fires when the provider implements parseStreamLine. */
  onStreamEvent?: (event: StreamEvent) => void;
}

/**
 * Per-invocation aggregates. Populated by providers that parse stream
 * events; left undefined otherwise. See CONTEXT.md "Invocation stats".
 */
export interface InvocationStats {
  costUsd?: number;
  toolCallCount?: number;
}

export interface InvokeResult {
  exitCode: number;
  stdout: string;
  stats: InvocationStats;
}

/**
 * Pluggable adapter that knows how to invoke a specific agent system.
 * See afk/CONTEXT.md ("Agent provider") and ADR 0002.
 *
 * `parseStreamLine` is optional — only providers whose CLI emits a
 * structured stream implement it. See ADR 0004.
 */
export interface AgentProvider {
  /** Stable identifier used for branch namespacing and logs. */
  readonly name: string;
  invoke(options: InvokeOptions): Promise<InvokeResult>;
  /** Parse one line of stdout into stream events. Optional. */
  parseStreamLine?(line: string): StreamEvent[];
}

export class CancelledError extends Error {
  constructor(message = "Pipeline cancelled") {
    super(message);
    this.name = "CancelledError";
  }
}

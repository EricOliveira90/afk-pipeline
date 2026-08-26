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
   * Opt-in hard cap on tool calls per invocation — kills the session
   * when exceeded. No default: unset means no tool-call kill, and the
   * wall-clock ceiling (`maxDurationMs`) is the backstop for runaway
   * sessions. Tool calls are always counted for `InvocationStats`
   * either way. Only enforced by providers that parse a structured
   * stream. Rationale for retiring the former 100-call default:
   * ADR 0036 (see also ADR 0007).
   */
  maxToolCalls?: number;
  /**
   * Hard wall-clock ceiling per invocation in ms — kills the session
   * when total runtime exceeds it, regardless of output activity.
   * Backstop for hung sessions whose decorative output (spinners,
   * animated status lines) defeats idle detection. Provider default:
   * 3_600_000 (60 min). The orchestrator overrides this per role
   * (120 min for generator/evaluator-qa) and via
   * `--max-agent-duration-ms`. See ADR 0016 and ADR 0019.
   */
  maxDurationMs?: number;
  /** Cancellation signal — when fired, the spawned process is killed. */
  signal?: AbortSignal;
  /**
   * Model alias or full ID to invoke this agent with. Provider-specific:
   * the `claude` and `kiro` providers read this (passed through as
   * `--model`). Codex silently ignores it. Defaults to the provider's
   * own model policy when omitted.
   */
  model?: string;
  /**
   * Run the underlying CLI in "bare" mode — strips plugin hooks,
   * MCP servers, and CLAUDE.md auto-discovery. Used for guardian
   * reviews where third-party `SessionStart` hooks (e.g. the
   * `superpowers:using-superpowers` plugin) inject directives that
   * coerce the agent into emitting fake `<tool_use>` text and
   * exiting after one turn — see ADR 0011. The persona must be
   * carried in the prompt; `agent` is ignored. Provider-specific:
   * only the `claude` provider implements this; Codex and Kiro silently
   * ignore it.
   */
  bare?: boolean;
  /** Called periodically while the agent produces no stdout. `minutes` = elapsed idle minutes. */
  onIdleWarning?: (minutes: number) => void;
  /**
   * Allow the busy probe (ADR 0021) to defer idle kills while live
   * spawned processes are found in the agent's tree. Opt-in per role:
   * the orchestrator sets it only for roles expected to shell out to
   * long-running commands (generator, evaluator-qa). Roles that have
   * no business running a test suite (explorer, planner,
   * evaluator-contract, guardians) hit the plain idle timeout instead
   * of being kept alive by their own spawned processes. Default:
   * false. See ADR 0037.
   */
  deferIdleKillWhenBusy?: boolean;
  /**
   * Called when an idle kill is deferred because the busy probe found
   * live spawned processes in the agent's tree (ADR 0021). The
   * orchestrator tees this into the structured event stream; the
   * provider also writes a line into the agent log either way.
   */
  onIdleDeferral?: (info: {
    silentSeconds: number;
    busyProcesses: number;
  }) => void;
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

/**
 * A provider-classified transient failure: the invocation died for a
 * reason expected to clear on its own — e.g. the backend reporting
 * "model temporarily unavailable" after the CLI exhausted its own
 * short internal retries. The orchestrator retries these with
 * exponential backoff inside a configurable window instead of failing
 * the slice; every other error still fails fast. See ADR 0022.
 */
export class TransientProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientProviderError";
  }
}

/**
 * Name-based check so classification survives duplicate module
 * instances (e.g. a provider bundled separately from the orchestrator).
 */
export function isTransientProviderError(
  err: unknown,
): err is TransientProviderError {
  return err instanceof Error && err.name === "TransientProviderError";
}

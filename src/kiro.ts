import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  AgentProvider,
  InvokeOptions,
  InvokeResult,
} from "./agent-provider.js";
import { TransientProviderError } from "./agent-provider.js";
import { runInvocation } from "./invocation-runtime.js";
import { createProgressFilter } from "./liveness.js";

/**
 * Role-based model policy: the read-only explorer runs on the cheaper
 * Sonnet; every other role gets the stronger model.
 * Model IDs match `kiro-cli chat --list-models`.
 */
const DEFAULT_MODEL = "claude-fable-5";
const EXPLORER_MODEL = "claude-sonnet-5";

/**
 * Name of the locked-down agent config every prompt-only invocation
 * runs under. Materialised into the global agent directory
 * (`~/.kiro/agents/`) by `ensureWorkerAgentConfig` — kiro-cli resolves
 * `--agent` by the JSON `name` field against that directory (and the
 * cwd's `.kiro/agents/`, which wins on conflict), so the config works
 * from any worktree without polluting the consuming repo. See ADR 0016.
 */
export const KIRO_WORKER_AGENT = "afk-worker";

/**
 * The worker toolset: filesystem, shell, and bookkeeping tools only.
 *
 * Deliberately absent: `subagent` / `use_subagent` / `delegate`
 * (nested-agent spawning — the activity of a nested agent is invisible
 * to the orchestrator's liveness signal and has hung real runs, see
 * ADR 0016) and every MCP tool (`mcpServers: {}` +
 * `useLegacyMcpJson: false` stop user/workspace mcp.json servers from
 * leaking into headless children).
 *
 * The list mixes kiro-cli v2 tool names (`fs_read`, `execute_bash`)
 * with v3 category names (`read`, `shell`) — unknown entries are
 * ignored, so one config covers both generations. `excludedTools` is
 * a v3-only third layer of defence, ignored by v2.
 */
const WORKER_AGENT_TOOLS = [
  "fs_read",
  "fs_write",
  "execute_bash",
  "read",
  "write",
  "shell",
  "grep",
  "glob",
  "code",
  "knowledge",
  "thinking",
  "todo_list",
];

export const WORKER_AGENT_CONFIG = {
  name: KIRO_WORKER_AGENT,
  description:
    "AFK pipeline worker: filesystem + shell only. No sub-agent " +
    "delegation, no MCP servers. Managed by afk-pipeline — edits are " +
    "overwritten on the next run.",
  tools: WORKER_AGENT_TOOLS,
  excludedTools: ["subagent", "use_subagent", "delegate"],
  mcpServers: {},
  // NOTE: alias of `includeMcpJson` — a config carrying BOTH spellings
  // is rejected as invalid JSON (duplicate field), and an invalid
  // config makes kiro-cli fall back to the unrestricted default agent.
  useLegacyMcpJson: false,
  allowedTools: WORKER_AGENT_TOOLS,
};

/**
 * Write (or refresh) the worker agent config in the global agent
 * directory. Idempotent; overwrites drifted or stale copies so config
 * changes in newer afk versions self-heal. Returns the agent name.
 */
export function ensureWorkerAgentConfig(
  agentDir: string = join(homedir(), ".kiro", "agents"),
): string {
  const file = join(agentDir, `${KIRO_WORKER_AGENT}.json`);
  const body = JSON.stringify(WORKER_AGENT_CONFIG, null, 2) + "\n";
  let existing: string | undefined;
  try {
    existing = readFileSync(file, "utf8");
  } catch {
    // Missing or unreadable — write below.
  }
  if (existing !== body) {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(file, body);
  }
  return KIRO_WORKER_AGENT;
}

/**
 * When `--agent` can't be resolved (config missing or invalid JSON),
 * kiro-cli does NOT exit — it prints this marker and falls back to the
 * default agent, which carries the sub-agent tool and every MCP server
 * from mcp.json. That fail-open silently reintroduces the exact defect
 * the worker config exists to prevent, so the invocation is killed
 * instead. See ADR 0016.
 */
function agentFallbackMarker(agentName: string): string {
  return `no agent with name ${agentName} found`;
}

/**
 * Output marker for a backend-side model outage. kiro-cli retries a
 * handful of times over ~30 s, prints this, and exits nonzero — while
 * observed outages last minutes. Matching it lets the orchestrator
 * retry the invocation with real backoff instead of failing the slice
 * (and the lane behind it). See ADR 0022 and issue #16.
 */
const TRANSIENT_OUTPUT_PATTERN = /temporarily unavailable/i;

/** Bounded window of recent output kept for exit-failure classification. */
const OUTPUT_TAIL_LIMIT = 16_384;

/**
 * Classify a nonzero exit: transient (model outage marker in the
 * recent output) vs. everything else. Exported for tests.
 */
export function classifyExitError(
  role: string,
  exitCode: number,
  outputTail: string,
): Error {
  if (TRANSIENT_OUTPUT_PATTERN.test(outputTail)) {
    return new TransientProviderError(
      `Agent ${role} exited with code ${exitCode} — model temporarily unavailable`,
    );
  }
  return new Error(`Agent ${role} exited with code ${exitCode}`);
}

/**
 * Invoke kiro-cli chat in headless mode with a specific agent and prompt.
 * Streams stdout line-by-line for liveness detection. Kiro doesn't emit a
 * structured stream — see ADR 0004 for why we don't implement
 * parseStreamLine here.
 *
 * Liveness is judged by a progress filter, not raw chunk arrival:
 * kiro-cli paints spinner frames to stdout several times a second even
 * when the underlying session is wedged, and counting those frames as
 * activity held hung invocations alive past every idle warning. See
 * ADR 0016 and src/liveness.ts.
 */
export function invoke(options: InvokeOptions): Promise<InvokeResult> {
  return runInvocation(options, () => {
    const { role, agent, prompt } = options;
    const model =
      options.model ?? (role === "explorer" ? EXPLORER_MODEL : DEFAULT_MODEL);
    const agentName = agent ?? ensureWorkerAgentConfig();
    const args = [
      "chat",
      "--no-interactive",
      "--trust-all-tools",
      "--model",
      model,
      "--agent",
      agentName,
      prompt,
    ];
    const stdoutProgress = createProgressFilter();
    const stderrProgress = createProgressFilter();
    const marker = agentFallbackMarker(agentName);
    let headText = "";
    let outputTail = "";

    return {
      command: "kiro-cli",
      args,
      activityFilter: (stream, text) =>
        stream === "stdout"
          ? stdoutProgress.update(text)
          : stderrProgress.update(text),
      onOutput: (_stream, text) => {
        outputTail = (outputTail + text).slice(-OUTPUT_TAIL_LIMIT);
        if (headText.length > 16_384) return undefined;
        headText += text;
        if (!headText.includes(marker)) return undefined;
        return new Error(
          `Agent ${role}: kiro-cli could not load agent config ` +
            `"${agentName}" and would fall back to the unrestricted ` +
            `default agent — killed`,
        );
      },
      classifyExit: ({ exitCode }) =>
        classifyExitError(role, exitCode, outputTail),
    };
  });
}

export const kiroProvider: AgentProvider = {
  name: "kiro",
  invoke,
};

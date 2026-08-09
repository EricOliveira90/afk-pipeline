import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  AgentProvider,
  InvokeOptions,
  InvokeResult,
} from "./agent-provider.js";
import { CancelledError } from "./agent-provider.js";
import { createIdleWatcher } from "./idle-watcher.js";
import {
  formatTerminationWarning,
  terminateProcessTree,
  type TerminationReport,
} from "./kill-tree.js";
import { createProgressFilter } from "./liveness.js";

/** Wall-clock ceiling default — see ADR 0016 and agent-provider.ts. */
const DEFAULT_MAX_DURATION_MS = 3_600_000;

/**
 * Role-based model policy, mirroring claude.ts: the read-only explorer
 * runs on the cheaper Sonnet; every other role gets the stronger model.
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
  const {
    role,
    agent,
    prompt,
    cwd,
    logStream,
    idleTimeoutMs = 180_000,
    idleWarningIntervalMs = 60_000,
    maxDurationMs = DEFAULT_MAX_DURATION_MS,
    signal,
    onIdleWarning,
  } = options;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CancelledError());
      return;
    }

    const model =
      options.model ?? (role === "explorer" ? EXPLORER_MODEL : DEFAULT_MODEL);

    // Prompt-only invocations (no caller-supplied agent config) run
    // under the managed worker config so the toolset is deterministic:
    // no nested sub-agents, no MCP leakage. Throws inside the executor
    // reject the returned promise.
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

    const proc = spawn("kiro-cli", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: string[] = [];
    let killed = false;
    let ceilingHit = false;
    let agentLoadFailed = false;
    let cancelled = false;
    let settled = false;
    let termination: Promise<TerminationReport> | undefined;

    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      watcher.stop();
      clearTimeout(ceilingTimer);
      signal?.removeEventListener("abort", onAbort);
      finish();
    };

    /**
     * Drop our ends of the child's stdio and the process handle from
     * the event loop. Orphaned grandchildren inherit the pipe write
     * ends; without this a survived kill holds the orchestrator's
     * event loop open forever after the run. Kill paths only — natural
     * exits close their pipes on their own. See ADR 0020.
     */
    const releaseChildHandles = () => {
      proc.stdout?.destroy();
      proc.stderr?.destroy();
      proc.unref();
    };

    const killedError = (): Error => {
      if (cancelled) return new CancelledError(`Agent ${role} cancelled`);
      if (agentLoadFailed) {
        return new Error(
          `Agent ${role}: kiro-cli could not load agent config ` +
            `"${agentName}" and would fall back to the unrestricted ` +
            `default agent — killed`,
        );
      }
      if (ceilingHit) {
        return new Error(
          `Agent ${role} exceeded ${maxDurationMs / 1000}s wall-clock ceiling — killed`,
        );
      }
      if (killed) {
        return new Error(
          `Agent ${role} idle for ${idleTimeoutMs / 1000}s — killed`,
        );
      }
      return new Error(`Agent ${role} was killed`);
    };

    /**
     * Settle a killed invocation — but only once the termination
     * report is in, so a terminal outcome is never recorded while the
     * process tree may still be alive. Survivors are surfaced loudly
     * in both the rejection and the invocation log.
     */
    const settleKill = (report: TerminationReport) =>
      settle(() => {
        releaseChildHandles();
        const error = killedError();
        const warning = formatTerminationWarning(report);
        if (warning) {
          error.message += ` — ${warning}`;
          logStream?.write(`\n${warning}\n`);
        }
        reject(error);
      });

    /**
     * Tree-first kill (ADR 0020): terminate and verify the whole tree
     * while its root is still alive. No SIGTERM-then-grace on Windows —
     * Node's "SIGTERM" there is already an ungraceful TerminateProcess
     * of the shim only, which is how zombie agents were born. If even
     * the root refuses to die, `exit` never fires — settle from the
     * termination report instead of awaiting the event forever.
     */
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
    });

    // Wall-clock ceiling — independent of the idle watcher, so a hung
    // session that keeps painting decorative output still dies.
    const ceilingTimer = setTimeout(() => {
      ceilingHit = true;
      stopProcess();
    }, maxDurationMs);
    ceilingTimer.unref();

    // Separate filter per stream — each keeps its own line state.
    const stdoutProgress = createProgressFilter();
    const stderrProgress = createProgressFilter();

    // The fallback marker appears in kiro-cli's startup banner; keep a
    // bounded head of combined output so a marker split across chunk
    // boundaries is still caught.
    const marker = agentFallbackMarker(agentName);
    let headText = "";
    const checkAgentFallback = (text: string) => {
      if (agentLoadFailed || headText.length > 16_384) return;
      headText += text;
      if (headText.includes(marker)) {
        agentLoadFailed = true;
        stopProcess();
      }
    };

    proc.stdout!.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdoutChunks.push(text);
      logStream?.write(text);
      checkAgentFallback(text);
      if (stdoutProgress.update(text)) watcher.reset();
    });

    proc.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      logStream?.write(text);
      checkAgentFallback(text);
      if (stderrProgress.update(text)) watcher.reset();
    });

    proc.on("error", (err) => {
      settle(() => reject(err));
    });

    proc.on("exit", (code) => {
      // A kill was issued: hold the outcome until the termination
      // report confirms (or denies) that the whole tree is gone.
      if (termination) {
        void termination.then(settleKill);
        return;
      }
      settle(() => {
        const exitCode = code ?? 1;
        if (exitCode !== 0) {
          reject(new Error(`Agent ${role} exited with code ${exitCode}`));
        } else {
          resolve({ exitCode, stdout: stdoutChunks.join(""), stats: {} });
        }
      });
    });
  });
}

export const kiroProvider: AgentProvider = {
  name: "kiro",
  invoke,
};

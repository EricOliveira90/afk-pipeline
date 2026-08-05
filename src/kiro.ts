import { spawn } from "node:child_process";
import type {
  AgentProvider,
  InvokeOptions,
  InvokeResult,
} from "./agent-provider.js";
import { CancelledError } from "./agent-provider.js";
import { createIdleWatcher } from "./idle-watcher.js";
import { killProcessTree } from "./kill-tree.js";

/** See claude.ts for rationale. */
const FORCE_KILL_GRACE_MS = 10_000;

/**
 * Role-based model policy, mirroring claude.ts: the read-only explorer
 * runs on the cheaper Sonnet; every other role gets the stronger model.
 * Model IDs match `kiro-cli chat --list-models`.
 */
const DEFAULT_MODEL = "claude-fable-5";
const EXPLORER_MODEL = "claude-sonnet-5";

/**
 * Invoke kiro-cli chat in headless mode with a specific agent and prompt.
 * Streams stdout line-by-line for liveness detection. Kiro doesn't emit a
 * structured stream — see ADR 0004 for why we don't implement
 * parseStreamLine here.
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

    const args = [
      "chat",
      "--no-interactive",
      "--trust-all-tools",
      "--model",
      model,
      ...(agent ? ["--agent", agent] : []),
      prompt,
    ];

    const proc = spawn("kiro-cli", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: string[] = [];
    let killed = false;
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
      } else if (killed) {
        reject(
          new Error(
            `Agent ${role} idle for ${idleTimeoutMs / 1000}s — killed`,
          ),
        );
      } else if (exitCode !== 0) {
        reject(new Error(`Agent ${role} exited with code ${exitCode}`));
      } else {
        resolve({ exitCode, stdout: stdoutChunks.join(""), stats: {} });
      }
    });
  });
}

export const kiroProvider: AgentProvider = {
  name: "kiro",
  invoke,
};

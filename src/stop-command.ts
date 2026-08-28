/**
 * `afk stop [<prd-slug>]` — the writer half of the stop sentinel
 * (ADR 0041). Resolves the run being addressed, drops the sentinel in its
 * log directory, and then reports whether the run **acknowledged** it.
 *
 * The reporting is the part that matters. Every stop mechanism AFK had
 * before this one could claim success without delivering anything:
 * `GenerateConsoleCtrlEvent` returns TRUE whether or not the event
 * arrives, so the operator in the Run 3 recovery evidence sent two stops
 * that reported success into a run that kept going. Writing a file is not
 * an improvement on its own — it is just as easy to write a file nobody
 * reads. So this command waits for the run to write back
 * `<runDir>/stop.ack`, and the exit code is the answer:
 *
 * - `0` — the run acknowledged. The ack is written after the abort path
 *   returns, so the CANCELLED run-state records (ADR 0040) are already on
 *   disk, and the command names the slices they cover.
 * - `1` — the sentinel is in place and unacknowledged. That is a real
 *   answer too, and the fallback it points at (Ctrl-Break, then a hard
 *   kill) is today's status quo rather than a regression.
 * - `2` — nothing was written, because the target could not be resolved.
 */
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { readRunEvents } from "./run-events.js";
import { findLatestRunDir, listLogSlugs } from "./status.js";
import {
  readStopAck,
  readStopRequest,
  stopRequestPath,
  writeStopRequest,
  type StopAck,
} from "./stop-sentinel.js";

/** Default window to wait for an ack: several of the run's 2s polls. */
export const DEFAULT_STOP_WAIT_MS = 30_000;

/** How often this command re-reads the ack while it waits. */
export const STOP_ACK_POLL_INTERVAL_MS = 500;

export interface StopResult {
  output: string;
  /** 0 acknowledged · 1 written, unacknowledged · 2 nothing written. */
  exitCode: number;
}

export interface StopCliDeps {
  /** Injected in tests so the wait is not real time. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export interface StopArgs {
  slug?: string;
  runDir?: string;
  waitMs: number;
}

/**
 * A log directory belongs to `slug` when it is the slug itself (the kiro
 * provider keeps the bare name) or the slug plus a provider suffix — see
 * `pipelineRunSlug`. Matching the prefix rather than enumerating
 * providers keeps this from needing a provider registry, at the cost of
 * also matching a hypothetical PRD slug that starts with another one; the
 * command prints the run directory it picked, so that stays visible.
 */
export function logSlugMatches(slug: string): (logSlug: string) => boolean {
  return (logSlug) => logSlug === slug || logSlug.startsWith(`${slug}-`);
}

export function parseStopArgs(args: readonly string[]): StopArgs | { error: string } {
  let slug: string | undefined;
  let runDir: string | undefined;
  let waitMs = DEFAULT_STOP_WAIT_MS;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--run") {
      const value = args[++i];
      if (value === undefined || value.startsWith("--")) {
        return { error: "--run requires a run directory argument" };
      }
      runDir = value;
    } else if (arg === "--wait-ms") {
      const value = args[++i];
      if (value === undefined || !/^\d+$/.test(value)) {
        return { error: "--wait-ms must be a non-negative integer" };
      }
      waitMs = Number(value);
    } else if (arg.startsWith("--")) {
      return { error: `unknown flag ${arg}` };
    } else if (slug === undefined) {
      slug = arg;
    } else {
      return { error: `unexpected argument ${arg} — one PRD slug at a time` };
    }
  }

  if (slug !== undefined && runDir !== undefined) {
    return { error: "pass a PRD slug or --run <dir>, not both" };
  }
  return { slug, runDir, waitMs };
}

export type StopTarget =
  | { ok: true; runDir: string; autoDetected: boolean }
  | { ok: false; message: string };

/** Which run directory this invocation addresses. Read-only. */
export function resolveStopTarget(
  repoRoot: string,
  args: Pick<StopArgs, "slug" | "runDir">,
): StopTarget {
  if (args.runDir !== undefined) {
    const runDir = isAbsolute(args.runDir)
      ? args.runDir
      : resolve(repoRoot, args.runDir);
    if (!existsSync(runDir)) {
      return { ok: false, message: `Run directory not found: ${runDir}` };
    }
    return { ok: true, runDir, autoDetected: false };
  }

  const logsDir = join(repoRoot, ".afk", "logs");
  if (!existsSync(logsDir)) {
    return {
      ok: false,
      message: `No .afk/logs directory under ${repoRoot} — has a pipeline run happened here?`,
    };
  }

  if (args.slug === undefined) {
    const latest = findLatestRunDir(repoRoot);
    if (latest === null) {
      return {
        ok: false,
        message: `No run directories found under ${logsDir}.`,
      };
    }
    return { ok: true, runDir: latest, autoDetected: true };
  }

  const latest = findLatestRunDir(repoRoot, {
    matchSlug: logSlugMatches(args.slug),
  });
  if (latest === null) {
    const slugs = listLogSlugs(repoRoot);
    return {
      ok: false,
      message:
        `No run directories for '${args.slug}' under ${logsDir}.` +
        (slugs.length > 0
          ? `\nLog directories present: ${slugs.join(", ")}`
          : ""),
    };
  }
  return { ok: true, runDir: latest, autoDetected: false };
}

/**
 * The run's own record of having ended (`run-ended`, the last event a run
 * writes). Checked before writing: a sentinel dropped into a finished
 * run's directory would sit there forever, unacknowledged, and the
 * command would report that as if the stop had failed. Saying "this run
 * already ended" is both the truth and the more useful answer — usually
 * it means the operator addressed the wrong PRD or the wrong provider.
 *
 * A run directory with no `events.jsonl` predates the event tee; that is
 * unknown rather than ended, so the sentinel is written.
 */
export function runEndedOutcome(runDir: string): { outcome: string; ts: string } | null {
  const parsed = readRunEvents(runDir);
  if (parsed === null) return null;
  for (let i = parsed.events.length - 1; i >= 0; i--) {
    const event = parsed.events[i]!;
    if (event.type === "run-ended") return { outcome: event.outcome, ts: event.ts };
  }
  return null;
}

function describeAck(ack: StopAck): string {
  const slices =
    ack.cancelledSlices.length > 0
      ? `marked CANCELLED in run state: ${ack.cancelledSlices.map((id) => `#${id}`).join(", ")}`
      : "no slice had work in flight";
  return `acknowledged at ${ack.acknowledgedAt} — ${slices}`;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((r) => {
    setTimeout(r, ms).unref();
  });

/**
 * Entry point for the `afk stop` subcommand.
 *
 * Writes exactly one file, and only after checking that the run it
 * addresses has not already ended or already acknowledged a stop.
 */
export async function runStopCli(
  args: readonly string[],
  repoRoot: string,
  deps: StopCliDeps = {},
): Promise<StopResult> {
  const parsed = parseStopArgs(args);
  if ("error" in parsed) {
    return { output: `Error: ${parsed.error}`, exitCode: 2 };
  }
  const target = resolveStopTarget(repoRoot, parsed);
  if (!target.ok) return { output: target.message, exitCode: 2 };

  const { runDir } = target;
  const lines: string[] = [];
  if (target.autoDetected) {
    lines.push(`Auto-detected latest run: ${runDir}`);
  } else {
    lines.push(`Run: ${runDir}`);
  }

  // Already acknowledged — including by an earlier `afk stop` against the
  // same run. A run acknowledges once, so re-reporting the existing ack
  // is the honest answer; waiting for a second one would time out on a
  // run that is already winding down.
  const existingAck = readStopAck(runDir);
  if (existingAck !== null) {
    lines.push(
      `This run has already ${describeAck(existingAck)}.`,
      "It is winding down: in-flight agents are killed and worktrees are preserved.",
      "Nothing further written.",
    );
    return { output: lines.join("\n"), exitCode: 0 };
  }

  const ended = runEndedOutcome(runDir);
  if (ended !== null) {
    lines.push(
      `This run already ended (${ended.outcome}) at ${ended.ts} — nothing to stop, and no sentinel written.`,
      "If a different run is live, name its PRD slug or pass --run <dir>.",
    );
    return { output: lines.join("\n"), exitCode: 1 };
  }

  const pending = readStopRequest(runDir);
  if (pending !== null) {
    lines.push(
      `A stop request from ${pending.requestedAt} is already in place and unacknowledged — rewriting it.`,
    );
  }

  const now = deps.now ?? (() => new Date());
  const request = writeStopRequest(runDir, {
    requestedAt: now().toISOString(),
    source: "afk stop",
  });
  lines.push(
    `Wrote stop sentinel: ${stopRequestPath(runDir)} (run ${request.runId})`,
  );

  if (parsed.waitMs === 0) {
    lines.push(
      "Not waiting for an acknowledgement (--wait-ms 0). Check the run log, or `afk status`.",
    );
    return { output: lines.join("\n"), exitCode: 1 };
  }

  const sleep = deps.sleep ?? defaultSleep;
  const deadline = now().getTime() + parsed.waitMs;
  let ack = readStopAck(runDir);
  while (ack === null && now().getTime() < deadline) {
    await sleep(STOP_ACK_POLL_INTERVAL_MS);
    ack = readStopAck(runDir);
  }

  if (ack !== null) {
    lines.push(
      `Run ${describeAck(ack)}.`,
      "Those records are on disk already — the run is now winding down: in-flight agents",
      "are killed and slice worktrees are preserved for the next run.",
    );
    return { output: lines.join("\n"), exitCode: 0 };
  }

  lines.push(
    `No acknowledgement within ${Math.round(parsed.waitMs / 1000)}s.`,
    "The sentinel stays in place: a live run picks it up on its next poll (every 2s).",
    "If nothing happens, the run's event loop is wedged and the sentinel cannot reach it —",
    "fall back to Ctrl-Break in the run's console, then a hard kill. Check `afk status` first:",
    "the run may have finished on its own before the sentinel landed.",
  );
  return { output: lines.join("\n"), exitCode: 1 };
}

/** Shared `afk`/`afk-claude`/`afk-codex` usage line for the subcommand. */
export const STOP_USAGE = "stop [<prd-slug>] [--run <dir>] [--wait-ms <n>]";

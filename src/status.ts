/**
 * `afk status` (spec #26) — a one-shot, read-only view over a run
 * directory's `events.jsonl`. Renders one chronological pipeline log;
 * `--json` emits the same model the renderer consumes. Never writes.
 *
 * Run selection: `--run <dir>` renders a specific run directory
 * (absolute or repo-relative). With no arguments, auto-detects the
 * most recently active PRD's latest run directory under `.afk/logs/`
 * (run directory names encode their start time — ADR 0017 — so
 * lexicographic order is chronological order) and announces which
 * run it picked.
 */
import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { readRunEvents, type RunEvent } from "./run-events.js";
import {
  buildFutureSection,
  renderFutureSection,
  type FutureSection,
} from "./status-future.js";

/** The model the renderer consumes; `--json` emits it verbatim. */
export interface StatusModel {
  schemaVersion: number;
  runDir: string;
  events: RunEvent[];
  /** What comes next and what unblocks what (spec #30). */
  future: FutureSection;
}

export interface StatusResult {
  output: string;
  exitCode: number;
}

const RUN_DIR_RE = /^run-\d{8}-\d{6}/;

/**
 * Latest run directory across all PRD slugs. "Most recently active
 * PRD" = the PRD owning the chronologically newest run directory.
 */
export function findLatestRunDir(repoRoot: string): string | null {
  const logsDir = join(repoRoot, ".afk", "logs");
  if (!existsSync(logsDir)) return null;
  let best: { name: string; path: string } | null = null;
  for (const slug of readdirSync(logsDir, { withFileTypes: true })) {
    if (!slug.isDirectory()) continue;
    const slugDir = join(logsDir, slug.name);
    for (const entry of readdirSync(slugDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !RUN_DIR_RE.test(entry.name)) continue;
      if (!best || entry.name > best.name) {
        best = { name: entry.name, path: join(slugDir, entry.name) };
      }
    }
  }
  return best?.path ?? null;
}

/** Build the status model from a run directory, or explain why not. */
export function buildStatusModel(
  runDir: string,
  repoRoot: string,
): { ok: true; model: StatusModel } | { ok: false; message: string } {
  const parsed = readRunEvents(runDir);
  if (parsed === null) {
    return {
      ok: false,
      message: `No events.jsonl in ${runDir} — this run predates events.jsonl.`,
    };
  }
  return {
    ok: true,
    model: {
      schemaVersion: parsed.version,
      runDir,
      events: parsed.events,
      future: buildFutureSection({ repoRoot, runDir, events: parsed.events }),
    },
  };
}

/** hh:mm:ss slice of an ISO timestamp, for compact chronology lines. */
function clock(ts: string): string {
  return ts.length >= 19 ? ts.slice(11, 19) : ts;
}

/** Compact human duration: 12s, 4m05s, 1h02m. */
export function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) {
    return `${totalMin}m${String(totalSec % 60).padStart(2, "0")}s`;
  }
  return `${Math.floor(totalMin / 60)}h${String(totalMin % 60).padStart(2, "0")}m`;
}

/** Key that pairs a phase-ended with its phase-started. */
function phaseKey(e: { ghIssue: string; agent: string; round?: number }): string {
  return `${e.ghIssue}|${e.agent}|${e.round ?? ""}`;
}

export function renderStatus(model: StatusModel): string {
  const lines: string[] = [];
  lines.push(`Run: ${model.runDir}`);
  lines.push("");
  lines.push("Past:");
  let any = false;
  // Start timestamps of phases whose end we haven't rendered yet, so a
  // phase-ended line can carry its computed duration. Keyed per
  // slice × agent × round; a re-opened phase (lane successor re-runs)
  // pairs with its most recent start.
  const openPhases = new Map<string, string[]>();
  for (const event of model.events) {
    switch (event.type) {
      case "header":
        break;
      case "run-started":
        any = true;
        lines.push(`  ${clock(event.ts)}  run started (${event.provider})`);
        break;
      case "wave-dispatched":
        any = true;
        lines.push(
          `  ${clock(event.ts)}  wave ${event.wave} dispatched — ${event.slices.length} slice(s): ${event.slices.map((s) => `#${s}`).join(", ")}`,
        );
        break;
      case "phase-started": {
        const starts = openPhases.get(phaseKey(event)) ?? [];
        starts.push(event.ts);
        openPhases.set(phaseKey(event), starts);
        break;
      }
      case "phase-ended": {
        any = true;
        const starts = openPhases.get(phaseKey(event));
        const startTs = starts?.pop();
        const duration =
          startTs !== undefined
            ? ` — ${formatDuration(Date.parse(event.ts) - Date.parse(startTs))}`
            : "";
        const round = event.round !== undefined ? ` (round ${event.round})` : "";
        const verdict = event.verdict ? ` — ${event.verdict}` : "";
        lines.push(
          `  ${clock(event.ts)}  #${event.ghIssue} ${event.agent}${round}${duration}${verdict}`,
        );
        break;
      }
      case "warn": {
        any = true;
        // Warn lines carry a marker so failure signals stand out from
        // the phase chronology around them. Producers may already
        // prefix the slice reference into the message — don't double it.
        const prefix =
          event.ghIssue !== undefined &&
          !event.message.startsWith(`#${event.ghIssue} `)
            ? `#${event.ghIssue} `
            : "";
        lines.push(`  ${clock(event.ts)}  ⚠ ${prefix}${event.message}`);
        break;
      }
      case "slice-outcome": {
        any = true;
        const s = event.slice;
        const reason =
          "error" in s && s.error ? ` — ${s.error}` : "";
        lines.push(
          `  ${clock(event.ts)}  #${s.ghIssue} ${s.title}: ${s.phase}${reason}`,
        );
        break;
      }
      default:
        // Forward compatibility: an events.jsonl written by a newer
        // pipeline may carry event types this renderer predates.
        break;
    }
  }
  if (!any) lines.push("  (no events)");
  lines.push("");
  lines.push("Future:");
  lines.push(...renderFutureSection(model.future));
  return lines.join("\n");
}

/**
 * Entry point for the `afk status` subcommand. Pure over the
 * filesystem: run directory (`--run <dir>` or auto-detected under
 * `repoRoot`) in, rendered text / JSON out. Read-only by
 * construction. `exitCode !== 0` marks `output` as error text the
 * caller should route to stderr.
 */
export function runStatus(args: readonly string[], repoRoot: string): StatusResult {
  const json = args.includes("--json");

  // Post-mortem selection (#31): `--run <dir>` renders a specific run
  // directory and bypasses auto-detect. Relative paths resolve
  // against repoRoot.
  let runDir: string;
  let autoDetected = false;
  const runFlagIdx = args.indexOf("--run");
  if (runFlagIdx !== -1) {
    const value = args[runFlagIdx + 1];
    if (value === undefined || value.startsWith("--")) {
      return { output: "--run requires a run directory argument.", exitCode: 1 };
    }
    runDir = isAbsolute(value) ? value : resolve(repoRoot, value);
    if (!existsSync(runDir)) {
      return { output: `Run directory not found: ${runDir}`, exitCode: 1 };
    }
  } else {
    const latest = findLatestRunDir(repoRoot);
    if (latest === null) {
      return {
        output: `No runs found under ${join(repoRoot, ".afk", "logs")}.`,
        exitCode: 1,
      };
    }
    runDir = latest;
    autoDetected = true;
  }

  const built = buildStatusModel(runDir, repoRoot);
  if (!built.ok) {
    return { output: built.message, exitCode: 1 };
  }

  if (json) {
    // A single valid JSON document — the model already carries
    // runDir, so no prose announcement line.
    return { output: JSON.stringify(built.model, null, 2), exitCode: 0 };
  }

  const view = renderStatus(built.model);
  return {
    output: autoDetected
      ? `Auto-detected latest run: ${runDir}\n\n${view}`
      : view,
    exitCode: 0,
  };
}

/**
 * `afk status` (spec #26) — a one-shot, read-only view over a run
 * directory's `events.jsonl`. Renders one chronological pipeline log;
 * `--json` emits the same model the renderer consumes. Never writes.
 *
 * Run selection: with no arguments, auto-detects the most recently
 * active PRD's latest run directory under `.afk/logs/` (run directory
 * names encode their start time — ADR 0017 — so lexicographic order is
 * chronological order).
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readRunEvents, type RunEvent } from "./run-events.js";

/** The model the renderer consumes; `--json` emits it verbatim. */
export interface StatusModel {
  schemaVersion: number;
  runDir: string;
  events: RunEvent[];
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
    model: { schemaVersion: parsed.version, runDir, events: parsed.events },
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
  return lines.join("\n");
}

/**
 * Entry point for the `afk status` subcommand. Pure over the
 * filesystem: run directory (auto-detected under `repoRoot`) in,
 * rendered text / JSON out. Read-only by construction.
 */
export function runStatus(args: readonly string[], repoRoot: string): StatusResult {
  const json = args.includes("--json");

  const runDir = findLatestRunDir(repoRoot);
  if (runDir === null) {
    return {
      output: `No runs found under ${join(repoRoot, ".afk", "logs")}.`,
      exitCode: 1,
    };
  }

  const built = buildStatusModel(runDir);
  if (!built.ok) {
    return { output: built.message, exitCode: 1 };
  }

  return {
    output: json
      ? JSON.stringify(built.model, null, 2)
      : renderStatus(built.model),
    exitCode: 0,
  };
}

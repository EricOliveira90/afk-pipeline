/**
 * `afk status` present section (spec #26, slice #32) — answers "what
 * is running right now, and is it dead or just slow?".
 *
 * Active slices are derived from the event stream: a `phase-started`
 * with no matching `phase-ended` and no terminal `slice-outcome`
 * means that slice's agent is running now. Liveness is derived, not
 * emitted (an accepted limitation of spec #26): the active agent's
 * log file in the run directory is `stat`ed for last activity — safe
 * because every file in a run directory belongs to this run
 * (ADR 0017).
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { RunEvent } from "./run-events.js";

/**
 * Both thresholds must hold before an entry is flagged: the phase has
 * been open long enough to matter, and the log has been silent long
 * enough to look dead. Scaled to the pipeline's idle-timeout order of
 * magnitude (10 minutes, see CONTEXT.md "Idle timeout").
 */
const STALE_AFTER_MS = 10 * 60_000;

export interface PresentActiveSlice {
  ghIssue: string;
  /** Agent role currently running (explorer, planner, generator, ...). */
  agent: string;
  round?: number;
  /** When the open phase started (ISO timestamp from the event). */
  startedTs: string;
  /** now − startedTs. */
  timeInPhaseMs: number;
  /** mtime of the freshest matching agent log, when one exists. */
  lastActivityTs?: string;
  /** Size of that log, for "is it still growing?" glances. */
  logBytes?: number;
  /**
   * Long time-in-phase with a long-silent log — or with no log at
   * all, which is even deader — possibly hung.
   */
  stale: boolean;
}

/** JSON-serializable — `--json` embeds it verbatim. */
export interface PresentSection {
  active: PresentActiveSlice[];
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

interface OpenPhase {
  ghIssue: string;
  sliceNumber?: string;
  agent: string;
  round?: number;
  startedTs: string;
}

function keyOf(e: { ghIssue: string; agent: string; round?: number }): string {
  return `${e.ghIssue}|${e.agent}|${e.round ?? ""}`;
}

/**
 * Freshest log for this invocation, by prefix match on
 * `slice-<number>-<agent>`. Prefix (not exact name) because QA
 * evaluator logs encode round × attempt in their suffix
 * (`-r11`, `-r12`, ...) while the event carries the plain round.
 */
function freshestAgentLog(
  runDir: string,
  sliceNumber: string,
  agent: string,
): { mtime: Date; size: number } | null {
  const prefix = `slice-${sliceNumber}-${agent}`;
  let best: { mtime: Date; size: number } | null = null;
  let entries: string[];
  try {
    entries = readdirSync(runDir);
  } catch {
    return null;
  }
  for (const name of entries) {
    if (!name.startsWith(prefix) || !name.endsWith(".log")) continue;
    try {
      const s = statSync(join(runDir, name));
      if (!best || s.mtime > best.mtime) {
        best = { mtime: s.mtime, size: s.size };
      }
    } catch {
      // File vanished between readdir and stat — a finished run being
      // cleaned up; skip.
    }
  }
  return best;
}

export function buildPresentSection(input: {
  runDir: string;
  events: RunEvent[];
  now: Date;
}): PresentSection {
  const { runDir, events, now } = input;

  // Open phases per slice×agent×round; a terminal outcome closes
  // everything the slice still had open (the invocation died with it).
  const open = new Map<string, OpenPhase>();
  for (const event of events) {
    switch (event.type) {
      case "phase-started":
        open.set(keyOf(event), {
          ghIssue: event.ghIssue,
          sliceNumber: event.sliceNumber,
          agent: event.agent,
          round: event.round,
          startedTs: event.ts,
        });
        break;
      case "phase-ended":
        open.delete(keyOf(event));
        break;
      case "slice-outcome":
        for (const [key, phase] of open) {
          if (phase.ghIssue === event.slice.ghIssue) open.delete(key);
        }
        break;
      default:
        break;
    }
  }

  const active: PresentActiveSlice[] = [];
  for (const phase of open.values()) {
    const timeInPhaseMs = Math.max(
      0,
      now.getTime() - Date.parse(phase.startedTs),
    );
    const log =
      phase.sliceNumber !== undefined
        ? freshestAgentLog(runDir, phase.sliceNumber, phase.agent)
        : null;
    const silentMs = log ? now.getTime() - log.mtime.getTime() : null;
    active.push({
      ghIssue: phase.ghIssue,
      agent: phase.agent,
      round: phase.round,
      startedTs: phase.startedTs,
      timeInPhaseMs,
      lastActivityTs: log?.mtime.toISOString(),
      logBytes: log?.size,
      stale:
        timeInPhaseMs >= STALE_AFTER_MS &&
        (silentMs === null || silentMs >= STALE_AFTER_MS),
    });
  }
  // Stable order for rendering and JSON consumers.
  active.sort((a, b) =>
    a.ghIssue === b.ghIssue
      ? a.agent.localeCompare(b.agent)
      : a.ghIssue.localeCompare(b.ghIssue),
  );
  return { active };
}

/**
 * Indented lines for the present section, no trailing newline. Sits
 * under a "Present:" header the caller prints.
 */
export function renderPresentSection(present: PresentSection): string[] {
  if (present.active.length === 0) return ["  (nothing running)"];
  const lines: string[] = [];
  for (const a of present.active) {
    const round = a.round !== undefined ? ` (round ${a.round})` : "";
    lines.push(
      `  #${a.ghIssue} ${a.agent}${round} — ${formatDuration(a.timeInPhaseMs)} in phase${activityCell(a)}`,
    );
  }
  return lines;
}

function activityCell(a: PresentActiveSlice): string {
  if (a.lastActivityTs === undefined) {
    return a.stale
      ? ` — ⚠ possibly hung: no agent log after ${formatDuration(a.timeInPhaseMs)} in phase`
      : " — no agent log yet";
  }
  return a.stale
    ? ` — ⚠ possibly hung: no log activity for ${sinceActivity(a)}`
    : ` — last activity ${sinceActivity(a)} ago`;
}

/** Silence duration derived from the entry's own timestamps. */
function sinceActivity(a: PresentActiveSlice): string {
  const started = Date.parse(a.startedTs);
  const lastActivity = Date.parse(a.lastActivityTs!);
  const reference = started + a.timeInPhaseMs; // = `now` used at build time
  return formatDuration(Math.max(0, reference - lastActivity));
}

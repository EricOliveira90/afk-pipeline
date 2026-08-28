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
import { formatSliceBounds } from "./bounds.js";
import type {
  RunSnapshot,
  SnapshotPhaseInvocation,
  SnapshotSliceBounds,
} from "./run-snapshot.js";

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
  /** now − lastActivityTs at build time: how long the log has been silent. */
  silentMs?: number;
  /** Size of that log, for "is it still growing?" glances. */
  logBytes?: number;
  /**
   * Long time-in-phase with a long-silent log — or with no log at
   * all, which is even deader — possibly hung.
   */
  stale: boolean;
  /**
   * Budgets reported at this slice's dispatch (wave item 14) — how much
   * headroom the thing you are watching has left. Absent for runs that
   * predate the `slice-bounds` event.
   */
  bounds?: SnapshotSliceBounds;
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

export interface AgentLogActivity {
  lastActivityTs: string;
  logBytes: number;
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
  snapshot: RunSnapshot;
  activity: ReadonlyMap<SnapshotPhaseInvocation, AgentLogActivity>;
  now: Date;
}): PresentSection {
  const { snapshot, activity, now } = input;

  const active: PresentActiveSlice[] = [];
  for (const ghIssue of snapshot.sliceOrder) {
    const slice = snapshot.slices[ghIssue]!;
    for (const phase of slice.invocations) {
      if (phase.closeReason !== undefined || phase.startedTs === undefined) {
        continue;
      }
      const timeInPhaseMs = Math.max(
        0,
        now.getTime() - Date.parse(phase.startedTs),
      );
      const log = activity.get(phase);
      const lastActivityMs =
        log === undefined ? Number.NaN : Date.parse(log.lastActivityTs);
      const silentMs = Number.isFinite(lastActivityMs)
        ? now.getTime() - lastActivityMs
        : null;
      active.push({
        ghIssue: phase.ghIssue,
        agent: phase.agent,
        round: phase.round,
        startedTs: phase.startedTs,
        timeInPhaseMs,
        lastActivityTs: log?.lastActivityTs,
        silentMs: silentMs !== null ? Math.max(0, silentMs) : undefined,
        logBytes: log?.logBytes,
        stale:
          timeInPhaseMs >= STALE_AFTER_MS &&
          (silentMs === null || silentMs >= STALE_AFTER_MS),
        ...(slice.bounds ? { bounds: slice.bounds } : {}),
      });
    }
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
 * Read the latest matching agent log for each invocation the snapshot
 * still considers open. The section builder above has no filesystem I/O.
 */
export function readAgentLogActivity(
  runDir: string,
  snapshot: RunSnapshot,
): ReadonlyMap<SnapshotPhaseInvocation, AgentLogActivity> {
  const activity = new Map<SnapshotPhaseInvocation, AgentLogActivity>();
  for (const slice of Object.values(snapshot.slices)) {
    for (const invocation of slice.invocations) {
      if (
        invocation.closeReason !== undefined ||
        invocation.sliceNumber === undefined
      ) {
        continue;
      }
      const log = freshestAgentLog(
        runDir,
        invocation.sliceNumber,
        invocation.agent,
      );
      if (log) {
        activity.set(invocation, {
          lastActivityTs: log.mtime.toISOString(),
          logBytes: log.size,
        });
      }
    }
  }
  return activity;
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
    // The dispatch's budgets, indented under the slice they belong to:
    // "is it dead or just slow?" is usually followed by "and how many
    // tries does it have left?" (wave item 14).
    if (a.bounds) lines.push(`      ${formatSliceBounds(a.bounds)}`);
  }
  return lines;
}

function activityCell(a: PresentActiveSlice): string {
  if (a.lastActivityTs === undefined || a.silentMs === undefined) {
    return a.stale
      ? ` — ⚠ possibly hung: no agent log after ${formatDuration(a.timeInPhaseMs)} in phase`
      : " — no agent log yet";
  }
  return a.stale
    ? ` — ⚠ possibly hung: no log activity for ${formatDuration(a.silentMs)}`
    : ` — last activity ${formatDuration(a.silentMs)} ago`;
}

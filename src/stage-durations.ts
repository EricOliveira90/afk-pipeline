/**
 * Stage-duration journal events (afk-v2 plan, riding wave item 14).
 *
 * Every agent invocation's wall-clock duration is recorded against the
 * durations the same stage took before it, as a run-journal event
 * (ADR 0031). That is the whole feature.
 *
 * **This deliberately emits data and never acts.** The soft per-stage
 * watchdog ping was cut in the plan debate (§2) by the argument that
 * killed it: an advisory ping into an unattended run at 3 a.m. has no
 * receiver who can act on it, and nothing in the record shows that the
 * 109.6-minute generator round was *doomed* rather than merely *large* —
 * a watchdog tuned on one data point either never fires or fires on
 * healthy long rounds. So there is no threshold here, no alert, no
 * notification, and no cancellation. The consumers are the morning
 * babysitter reading `events.jsonl` and PRD 5 story 17's ROI dataset. A
 * watchdog may be re-proposed only once these events show a bimodal
 * doomed-vs-large distribution, through the debate document's recorded
 * re-open trigger — not from here.
 *
 * History is per *stage*, meaning the agent role with rounds pooled:
 * "how long does a generator round take on this PRD" is the question
 * worth asking, and every round is a sample of it. It spans runs,
 * because a fresh run's first generator round is exactly the invocation
 * whose duration nobody could place. Prior samples are recovered by
 * pairing `phase-started`/`phase-ended` in each sibling run's
 * `events.jsonl`, so runs that predate this feature contribute their
 * history too.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readRunEvents, type RunEvent } from "./run-events.js";

const RUN_DIR_RE = /^run-\d{8}-\d{6}/;

/**
 * Sibling runs scanned for prior samples, most recent first. A bound,
 * not a policy: the history only has to be dense enough to place one
 * duration, and an unbounded scan would grow the startup cost of every
 * run in a long-lived PRD directory.
 */
export const HISTORY_RUN_LIMIT = 20;

/** Summary of the durations a stage recorded *before* the reported one. */
export interface StageDurationHistory {
  /** How many prior durations the summary is over. Always ≥ 1. */
  samples: number;
  medianMs: number;
  maxMs: number;
}

/**
 * Identity of one in-flight invocation, for pairing a `phase-ended` with
 * its `phase-started`. Rounds are part of it here (they identify the
 * invocation) even though the history pools them.
 */
export function stageInvocationKey(event: {
  ghIssue: string;
  agent: string;
  round?: number;
}): string {
  return `${event.ghIssue}|${event.agent}|${event.round ?? ""}`;
}

/** Median over an unsorted sample list; even counts average the middle pair. */
function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/**
 * Summarize prior samples, or `null` when there are none — the first
 * invocation of a stage has nothing to be compared against and says so
 * rather than inventing a baseline of itself.
 */
export function summarizeStageHistory(
  samples: readonly number[],
): StageDurationHistory | null {
  if (samples.length === 0) return null;
  return {
    samples: samples.length,
    medianMs: median(samples),
    maxMs: Math.max(...samples),
  };
}

/**
 * This duration as a multiple of the historical median, to two decimals.
 * A descriptive ratio, not a verdict: `undefined` when the median is
 * zero, because dividing by it would report a comparison nobody made.
 */
export function ratioToMedian(
  durationMs: number,
  history: StageDurationHistory,
): number | undefined {
  if (history.medianMs <= 0) return undefined;
  return Math.round((durationMs / history.medianMs) * 100) / 100;
}

/**
 * Per-stage durations recovered from one run's event stream by pairing
 * each `phase-ended` with the newest unmatched `phase-started` for the
 * same invocation. Pure over the events, so it reads a finished run's
 * file and a live one identically.
 *
 * Unpaired starts (an invocation the run died inside) contribute
 * nothing: an unfinished stage has no duration, and guessing one from
 * the run's end would put a killed generator's death into the baseline
 * for healthy ones.
 */
export function pairStageDurations(
  events: readonly RunEvent[],
): Map<string, number[]> {
  const open = new Map<string, number[]>();
  const durations = new Map<string, number[]>();
  for (const event of events) {
    if (event.type !== "phase-started" && event.type !== "phase-ended") continue;
    const key = stageInvocationKey(event);
    const startedMs = Date.parse(event.ts);
    if (!Number.isFinite(startedMs)) continue;
    if (event.type === "phase-started") {
      const starts = open.get(key) ?? [];
      starts.push(startedMs);
      open.set(key, starts);
      continue;
    }
    const starts = open.get(key);
    const start = starts?.pop();
    if (starts?.length === 0) open.delete(key);
    if (start === undefined) continue;
    const samples = durations.get(event.agent) ?? [];
    samples.push(Math.max(0, startedMs - start));
    durations.set(event.agent, samples);
  }
  return durations;
}

/**
 * Per-stage durations from the PRD's earlier runs. `logDir` is the
 * per-PRD log directory (`.afk/logs/<prd-slug>`); `excludeRunDir` is the
 * current run, which is still being written and supplies its own samples
 * in memory.
 *
 * Best-effort throughout: a log directory that cannot be listed, or a
 * run whose `events.jsonl` is absent or torn, yields fewer samples. The
 * events this feeds are data for a later reader, so degrading to a
 * thinner history is always better than failing a dispatch over it.
 */
export function readStageDurationHistory(
  logDir: string,
  excludeRunDir?: string,
): Map<string, number[]> {
  const merged = new Map<string, number[]>();
  let names: string[];
  try {
    names = readdirSync(logDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && RUN_DIR_RE.test(entry.name))
      .map((entry) => entry.name)
      // Run directory names are timestamped, so lexicographic order is
      // chronological — newest first, then truncated.
      .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
      .slice(0, HISTORY_RUN_LIMIT);
  } catch {
    return merged;
  }
  for (const name of names) {
    const runDir = join(logDir, name);
    if (excludeRunDir !== undefined && runDir === excludeRunDir) continue;
    if (!existsSync(runDir)) continue;
    let events: readonly RunEvent[];
    try {
      events = readRunEvents(runDir)?.events ?? [];
    } catch {
      continue;
    }
    for (const [agent, samples] of pairStageDurations(events)) {
      const existing = merged.get(agent);
      if (existing) existing.push(...samples);
      else merged.set(agent, [...samples]);
    }
  }
  return merged;
}

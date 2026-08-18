/**
 * Structured run events (spec #26). The orchestrator's logging funnel
 * tees operator-meaningful transitions into `events.jsonl` in the
 * per-run log directory (ADR 0017), beside the human `run.log` — which
 * stays byte-for-byte unchanged. One JSON line per event; the first
 * line is a `version: 1` header event, copying the handoff.json
 * convention.
 *
 * Payloads serialize the existing `SliceLifecycle` vocabulary — there
 * is no parallel status vocabulary to keep in sync. The schema is
 * versioned and the union is open for new event types (e.g. the
 * future in-invocation liveness signals sketched in #14) without
 * breaking existing consumers.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SliceLifecycle } from "./slice-lifecycle.js";

export const EVENTS_FILE = "events.jsonl";
export const EVENTS_SCHEMA_VERSION = 1;

/**
 * Event payloads as emitted at call sites — the Logger stamps `ts`.
 */
export type RunEventPayload =
  | { type: "header"; version: typeof EVENTS_SCHEMA_VERSION }
  | { type: "run-started"; provider: string; runSlug: string }
  | { type: "wave-dispatched"; wave: number; slices: string[] }
  | {
      type: "lanes-partitioned";
      wave: number;
      /**
       * Lane composition for the wave (ADR 0005): lanes run in
       * parallel; within a lane, slices run serially in the listed
       * order. Known only mid-run, after contracts declare their
       * file lists.
       */
      lanes: string[][];
      serial?: boolean;
    }
  | {
      type: "phase-started";
      ghIssue: string;
      /**
       * The slice's two-digit manifest number — names the agent log
       * file (`slice-<number>-<agent>[-r<n>].log`) so a status reader
       * can `stat` the active log for liveness without the DAG.
       */
      sliceNumber?: string;
      /** Agent role for this invocation (explorer, planner, evaluator-contract, generator, evaluator-qa, evaluator-uat, generator-stuck). */
      agent: string;
      round?: number;
    }
  | {
      type: "phase-ended";
      ghIssue: string;
      sliceNumber?: string;
      agent: string;
      round?: number;
      /**
       * Verdict/outcome where the phase produces one, in the existing
       * artifact vocabulary: evaluator-contract → ACCEPT/REVISE/
       * ESCALATE/UNKNOWN; evaluator-qa/-uat → PASS/IMPLEMENTATION.
       */
      verdict?: string;
    }
  | { type: "slice-outcome"; slice: SliceLifecycle }
  | {
      type: "warn";
      /**
       * Which warn-class signal this is. One per signal the pipeline
       * already logs: lane continuation after a member failure
       * (ADR 0024), QA infrastructure retries that don't consume a
       * round, transient-outage backoff retries (ADR 0022), per-slice
       * prior-run state at run start (retry announcement), NOT-RUN
       * dependency holds, and idle-kill deferrals from the busy probe
       * (ADR 0021).
       */
      reason:
        | "lane-continuation"
        | "infrastructure-retry"
        | "backoff-retry"
        | "prior-run-state"
        | "not-run-hold"
        | "idle-deferral";
      ghIssue?: string;
      /** Human-readable one-liner rendered inline in the chronology. */
      message: string;
      /** prior-run-state: the phase persisted by the previous run. */
      previousPhase?: string;
      /** prior-run-state: the failure reason persisted by the previous run. */
      previousError?: string;
      /** not-run-hold: unresolved blockers this slice waits on. */
      blockedBy?: string[];
    };

export type RunEvent = RunEventPayload & {
  /** ISO-8601 timestamp stamped when the event line was appended. */
  ts: string;
};

export interface RunEvents {
  version: number;
  events: RunEvent[];
}

/** Serialize one event as a single JSON line (newline-terminated). */
export function serializeRunEvent(event: RunEvent): string {
  return JSON.stringify(event) + "\n";
}

/**
 * Read a run directory's `events.jsonl`. Returns `null` when the file
 * is absent (a run that predates the tee). Malformed lines — e.g. a
 * partially flushed last line while the run is live — are skipped, so
 * a reader polling an in-flight run never crashes on a torn write.
 */
export function readRunEvents(runDir: string): RunEvents | null {
  const path = join(runDir, EVENTS_FILE);
  if (!existsSync(path)) return null;
  const events: RunEvent[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      events.push(JSON.parse(line) as RunEvent);
    } catch {
      // Torn or foreign line — skip, keep the rest readable.
    }
  }
  const header = events[0];
  const version =
    header && header.type === "header" ? header.version : EVENTS_SCHEMA_VERSION;
  return { version, events };
}

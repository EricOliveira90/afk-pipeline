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
 * versioned and the union is open for new event types (e.g. future
 * heartbeats, #14) without breaking existing consumers.
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
  | { type: "slice-outcome"; slice: SliceLifecycle };

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

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
import type {
  GateFailureKind,
  GateStatus,
} from "./gate-runner.js";

export const EVENTS_FILE = "events.jsonl";
export const EVENTS_SCHEMA_VERSION = 1;

/**
 * Event payloads as emitted at call sites — the RunJournal stamps `ts`.
 */
export type RunEventPayload =
  | { type: "header"; version: typeof EVENTS_SCHEMA_VERSION }
  | {
      type: "run-started";
      provider: string;
      runSlug: string;
      /** Configured convergence limits; absent in historical streams. */
      contractRoundLimit?: number;
      implementationRoundLimit?: number;
    }
  | { type: "wave-dispatched"; wave: number; slices: string[] }
  | { type: "wave-completed"; wave: number }
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
      /**
       * Slices unioned into one lane by a shared *resource* rather than
       * a shared path (ADR 0027), keyed by resource — today only
       * `migrations`. Present only when at least two slices in the wave
       * contend for the same resource; a lone declarer is contending
       * with nobody.
       */
      sharedResources?: Record<string, string[]>;
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
  | {
      type: "gate-outcome";
      ghIssue: string;
      sliceNumber: string;
      round: number;
      attemptId: string;
      gateId: string;
      stage: string;
      status: GateStatus;
      failureKind: GateFailureKind;
      startedAt: string;
      endedAt: string;
      durationMs: number;
      exitCode: number | null;
      treeId: string;
      evidenceArtifactId: string;
      logArtifactId: string;
    }
  | {
      type: "run-phase-started";
      phase: "sanity" | "architect-review" | "pm-review" | "draft-pr";
      attempt?: number;
      cached?: boolean;
    }
  | {
      type: "run-phase-ended";
      phase: "sanity" | "architect-review" | "pm-review" | "draft-pr";
      attempt?: number;
      cached?: boolean;
      verdict: string;
      /**
       * Set on a `FAIL` verdict, in the same vocabulary the per-slice base
       * gates emit: `"CONFIGURATION"` when the phase never really ran
       * (missing toolchain), `"COMMAND"` when the reviewed tree is red
       * (#101). A status reader can tell the two apart without parsing prose.
       */
      failureKind?: GateFailureKind;
    }
  | { type: "run-ended"; outcome: "SUCCEEDED" | "FAILED" | "ABORTED" }
  | { type: "slice-outcome"; slice: SliceLifecycle }
  | {
      type: "warn";
      /**
       * Which warn-class signal this is. One per signal the pipeline
       * already logs: lane continuation after a member failure
       * (ADR 0024), QA infrastructure retries that don't consume a
       * round, transient-outage backoff retries (ADR 0022), per-slice
       * prior-run state at run start (retry announcement), a dependency
       * counted as satisfied from prior run state rather than from this
       * invocation (issue #41), NOT-RUN dependency holds, idle-kill
       * deferrals from the busy probe (ADR 0021), operator-granted
       * resumes of a STUCK slice's preserved tree (`--resume-stuck`,
       * #49), a locked contract
       * sent back to the planner by the contract-lock gate (ADR 0028),
       * the launch guard fast-forwarding a stale feature branch to
       * the host worktree's HEAD before any wave dispatches, a
       * contract review attempt whose audit copy could not be written,
       * a from-base restart refused because the slice branch still holds
       * unmerged commits (#113), the cancellation record written
       * the moment a stop signal fires, naming the slices it marked
       * CANCELLED in run state (#114), the launch preflight's report
       * — swept shells, reported conditions, and a refusal bypassed with
       * `--preflight-report-only` (ADR 0042) — and the `afk stop`
       * sentinel this run found in its own log directory (ADR 0043),
       * which is immediately followed by the `cancellation-requested`
       * line it triggers.
       */
      reason:
        | "cancellation-requested"
        | "stop-requested"
        | "lane-continuation"
        | "infrastructure-retry"
        | "backoff-retry"
        | "prior-run-state"
        | "dependency-from-prior-run"
        | "not-run-hold"
        | "idle-deferral"
        | "resume-stuck"
        | "contract-lock-refused"
        | "contract-review-archive-failed"
        | "qa-review-archive-failed"
        | "feature-branch-fast-forward"
        | "restart-refused"
        | "preflight";
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

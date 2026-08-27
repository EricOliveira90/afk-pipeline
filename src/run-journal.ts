import { appendFileSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import type { InvocationStats } from "./agent-provider.js";
import { Logger, type SanityGateResult } from "./logger.js";
import {
  EVENTS_FILE,
  EVENTS_SCHEMA_VERSION,
  serializeRunEvent,
  type RunEventPayload,
} from "./run-events.js";
import {
  lifecycle,
  type FailurePhase,
  type SliceIdentity,
  type SliceLifecycle,
  type SliceProgress,
} from "./slice-lifecycle.js";
import { projectForPersistence, saveSliceState } from "./run-state.js";

const ZERO_PROGRESS: SliceProgress = { genRounds: 0, evalRounds: 0 };

export type TerminalOutcome =
  | { phase: "PASS"; recovered?: true }
  | {
      phase: "MERGE-PENDING";
      error: string;
      collidingPrefixes: string[];
    }
  | { [Phase in FailurePhase]: { phase: Phase; error: string } }[FailurePhase];

/**
 * The single seam for a run's observable record. Callers report phase
 * transitions and terminal outcomes; the journal owns all projections.
 */
export class RunJournal {
  private readonly slices = new Map<string, SliceLifecycle>();
  private readonly terminalSlices = new Set<string>();
  private readonly logger: Logger;
  private featureBranch?: string;

  readonly runDir: string;

  constructor(
    private readonly repoRoot: string,
    private readonly prdSlug: string,
  ) {
    this.logger = new Logger(repoRoot, prdSlug, this.slices);
    this.runDir = this.logger.runDir;
    this.event({ type: "header", version: EVENTS_SCHEMA_VERSION });
  }

  /** Record a human phase line and its optional typed event together. */
  phase(
    message: string,
    via: "error" | "log" | "warn" = "error",
    event?: RunEventPayload,
  ) {
    try {
      appendFileSync(
        join(this.runDir, "run.log"),
        `[${new Date().toISOString()}] ${message}\n`,
      );
    } catch {
      // Console echo below still happens.
    }
    if (event) this.event(event);
    console[via](message);
  }

  /** Append a timestamped typed event without a human run-log line. */
  event(payload: RunEventPayload) {
    try {
      appendFileSync(
        join(this.runDir, EVENTS_FILE),
        serializeRunEvent({ ...payload, ts: new Date().toISOString() }),
      );
    } catch {
      // Best effort: run state remains authoritative.
    }
  }

  /** Track an in-flight slice or a HITL skip; terminal phases use recordTerminal. */
  trackSlice(next: SliceLifecycle) {
    if (!["PENDING", "RUNNING", "SKIPPED"].includes(next.phase)) {
      throw new Error(
        `RunJournal.trackSlice: terminal phase ${next.phase} must use recordTerminal`,
      );
    }
    this.slices.set(next.ghIssue, next);
  }

  /** Restore an already-persisted PASS for this run's summary. */
  restoreCompleted(sliceId: SliceIdentity) {
    this.slices.set(
      sliceId.ghIssue,
      lifecycle.pass(sliceId, ZERO_PROGRESS, true),
    );
  }

  /**
   * Summarize slices left in flight by a pipeline-level exception. This
   * is not a decided slice outcome, so it deliberately does not persist.
   */
  summarizeAborted(slices: SliceIdentity[], error: string) {
    for (const sliceId of slices) {
      const current = this.slices.get(sliceId.ghIssue);
      if (current && current.phase !== "PENDING" && current.phase !== "RUNNING") {
        continue;
      }
      this.slices.set(
        sliceId.ghIssue,
        lifecycle.stuck(sliceId, progressOf(current), error),
      );
    }
  }

  /**
   * Persist a provisional `CANCELLED` record for every slice that has no
   * decided outcome yet, and return the ids written.
   *
   * This exists for the moment cancellation is *requested* (issue #114).
   * The pipeline's own cancellation sweep runs after the wave returns,
   * which is too late if the process dies during the wind-down: the
   * in-flight slice then has no run-state entry at all, and the next
   * `--only-failed` cannot tell "cancelled mid-generator, work preserved
   * on its branch" from "never ran" (#113).
   *
   * Provisional means exactly two things:
   *
   * - it does not close the slice in the journal, so a real outcome that
   *   still lands during the wind-down (a merge already underway)
   *   overwrites this record rather than being suppressed by it, and
   * - it is skipped for any slice whose outcome is already decided.
   *
   * Failures to write are swallowed per slice: a stop must record what it
   * can, not abandon the remaining slices on the first bad write.
   */
  markCancelledInFlight(slices: SliceIdentity[], error: string): string[] {
    const written: string[] = [];
    for (const sliceId of slices) {
      if (this.terminalSlices.has(sliceId.ghIssue)) continue;
      const current = this.slices.get(sliceId.ghIssue);
      if (
        current &&
        current.phase !== "PENDING" &&
        current.phase !== "RUNNING"
      ) {
        continue;
      }
      try {
        saveSliceState(this.repoRoot, this.prdSlug, sliceId.ghIssue, {
          phase: "CANCELLED",
          ...(sliceId.branch ? { branch: sliceId.branch } : {}),
          error,
        });
        written.push(sliceId.ghIssue);
      } catch {
        // Best effort — keep going for the other slices.
      }
    }
    return written;
  }

  /**
   * Persist one terminal outcome. State lands first (ADR 0018), then the
   * in-memory lifecycle, run.log line, and unchanged slice-outcome event.
   * A completed call is idempotent for the rest of this run.
   */
  recordTerminal(
    sliceId: SliceIdentity,
    outcome: TerminalOutcome,
  ): SliceLifecycle {
    const existing = this.slices.get(sliceId.ghIssue);
    if (this.terminalSlices.has(sliceId.ghIssue) && existing) return existing;

    const progress = progressOf(existing);
    const next = terminalLifecycle(sliceId, progress, outcome);
    const persisted = projectForPersistence(next);
    if (!persisted) {
      throw new Error(`RunJournal.recordTerminal: ${next.phase} is not persistent`);
    }

    saveSliceState(this.repoRoot, this.prdSlug, sliceId.ghIssue, persisted);
    this.slices.set(sliceId.ghIssue, next);

    const suffix =
      next.phase === "PASS"
        ? `PASS — merged into ${this.featureBranch ?? "(unknown feature branch)"}` +
          (outcome.phase === "PASS" && outcome.recovered
            ? " by merge-only recovery (no agent invoked)"
            : "")
        : `${next.phase} — ${"error" in next ? next.error : ""}`;
    this.phase(
      `[afk] Slice #${sliceId.ghIssue} (${sliceId.title}): ${suffix}`,
      "error",
      { type: "slice-outcome", slice: next },
    );
    this.terminalSlices.add(sliceId.ghIssue);
    return next;
  }

  bumpGenRound(ghIssue: string, round: number) {
    this.bumpRound(ghIssue, "genRounds", round);
  }

  bumpEvalRound(ghIssue: string, round: number) {
    this.bumpRound(ghIssue, "evalRounds", round);
  }

  getSlice(ghIssue: string): SliceLifecycle | undefined {
    return this.slices.get(ghIssue);
  }

  getSliceProgress(ghIssue: string): SliceProgress {
    return progressOf(this.slices.get(ghIssue));
  }

  addInvocationStats(ghIssue: string, stats: InvocationStats) {
    this.logger.addInvocationStats(ghIssue, stats);
  }

  writeIdleWarning(stream: WriteStream, agent: string, minutes: number) {
    this.logger.writeIdleWarning(stream, agent, minutes);
  }

  agentLog(sliceId: string, agent: string, round?: number): WriteStream {
    return this.logger.agentLog(sliceId, agent, round);
  }

  setReviewOutcomes(
    architect?: { outcome: string; detail?: string },
    pm?: { outcome: string; detail?: string },
  ) {
    this.logger.setReviewOutcomes(architect, pm);
  }

  setPrOverrideNote(note: string) {
    this.logger.setPrOverrideNote(note);
  }

  setFeatureBranch(name: string) {
    this.featureBranch = name;
    this.logger.setFeatureBranch(name);
  }

  setSanityGate(result: SanityGateResult) {
    this.logger.setSanityGate(result);
  }

  setPrUrl(url: string) {
    this.logger.setPrUrl(url);
  }

  writeSummary() {
    return this.logger.writeSummary();
  }

  formatConsoleSummary() {
    return this.logger.formatConsoleSummary();
  }

  private bumpRound(
    ghIssue: string,
    field: keyof SliceProgress,
    round: number,
  ) {
    const current = this.slices.get(ghIssue);
    if (!current) {
      throw new Error(`RunJournal.bumpRound: slice ${ghIssue} is not tracked yet`);
    }
    if (current.phase === "SKIPPED") {
      throw new Error("RunJournal.bumpRound: cannot bump rounds on a SKIPPED slice");
    }
    this.slices.set(ghIssue, {
      ...current,
      progress: { ...current.progress, [field]: round },
    });
  }
}

function progressOf(slice: SliceLifecycle | undefined): SliceProgress {
  return slice && slice.phase !== "SKIPPED" ? slice.progress : ZERO_PROGRESS;
}

function terminalLifecycle(
  sliceId: SliceIdentity,
  progress: SliceProgress,
  outcome: TerminalOutcome,
): SliceLifecycle {
  switch (outcome.phase) {
    case "PASS":
      return lifecycle.pass(sliceId, progress, true);
    case "STUCK":
      return lifecycle.stuck(sliceId, progress, outcome.error);
    case "ESCALATE":
      return lifecycle.escalate(sliceId, progress, outcome.error);
    case "ERROR":
      return lifecycle.error(sliceId, progress, outcome.error);
    case "CONFLICT":
      return lifecycle.conflict(sliceId, progress, outcome.error);
    case "MERGE-PENDING":
      return lifecycle.mergePending(
        sliceId,
        progress,
        outcome.error,
        outcome.collidingPrefixes,
      );
    case "CANCELLED":
      return lifecycle.cancelled(sliceId, progress, outcome.error);
    case "LANE-CANCELLED":
      return lifecycle.laneCancelled(sliceId, progress, outcome.error);
  }
}

import { appendFileSync, type WriteStream } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { InvocationStats } from "./agent-provider.js";
import {
  Logger,
  type DependencyBlocker,
  type SanityGateResult,
} from "./logger.js";
import {
  EVENTS_FILE,
  EVENTS_SCHEMA_VERSION,
  serializeRunEvent,
  type RunEventPayload,
} from "./run-events.js";
import {
  ratioToMedian,
  readStageDurationHistory,
  stageInvocationKey,
  summarizeStageHistory,
} from "./stage-durations.js";
import {
  lifecycle,
  traitsFor,
  type FailurePhase,
  type SliceIdentity,
  type SliceLifecycle,
  type SliceProgress,
} from "./slice-lifecycle.js";
import {
  clearSliceStateForDispatch,
  projectForPersistence,
  saveSliceState,
  type PersistedSliceState,
} from "./run-state.js";

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
  /**
   * Slices closed by a *replaceable* outcome — the adjudication park (ADR
   * 0055 §9). Recorded exactly like a terminal, but a dispatch may replace
   * it, so it is marked here instead of in `terminalSlices`.
   */
  private readonly parkedSlices = new Set<string>();
  private readonly logger: Logger;
  private featureBranch?: string;
  private fatalStreamError?: (error: unknown, origin: string) => void;
  /** Start epoch-ms of each `phase-started` still awaiting its `phase-ended`. */
  private readonly openStages = new Map<string, number>();
  /**
   * Per-stage durations, seeded from the PRD's earlier runs on first use
   * and grown by this run's own invocations. Lazy because a run that
   * closes no stage — every unit test that only records outcomes — should
   * not pay a directory scan for it.
   */
  private stageHistory?: Map<string, number[]>;

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
    const ts = new Date().toISOString();
    this.append(payload, ts);
    this.observeStageDuration(payload, ts);
  }

  private append(payload: RunEventPayload, ts: string) {
    try {
      appendFileSync(
        join(this.runDir, EVENTS_FILE),
        serializeRunEvent({ ...payload, ts }),
      );
    } catch {
      // Best effort: run state remains authoritative.
    }
  }

  /**
   * Derive the stage-duration event from the phase events already
   * flowing through this seam (plan riding item; see
   * `stage-durations.ts`). Doing it here rather than at each call site
   * is what makes it free: every stage already reports its start and end
   * through the journal, so no invocation site changes and none can
   * forget.
   *
   * Data only — it records a duration beside its history and stops
   * there. A stage whose `phase-ended` never arrives (the run died
   * inside it) simply produces no event.
   */
  private observeStageDuration(payload: RunEventPayload, ts: string) {
    if (payload.type === "phase-started") {
      const startedMs = Date.parse(ts);
      if (Number.isFinite(startedMs)) {
        // Last start wins: an infrastructure retry re-opens the same
        // round, and the duration that matters is the attempt that ended.
        this.openStages.set(stageInvocationKey(payload), startedMs);
      }
      return;
    }
    if (payload.type !== "phase-ended") return;
    const key = stageInvocationKey(payload);
    const startedMs = this.openStages.get(key);
    const endedMs = Date.parse(ts);
    if (startedMs === undefined || !Number.isFinite(endedMs)) return;
    this.openStages.delete(key);
    const durationMs = Math.max(0, endedMs - startedMs);
    const samples = this.stageSamples(payload.agent);
    const history = summarizeStageHistory(samples);
    samples.push(durationMs);
    const ratio = history ? ratioToMedian(durationMs, history) : undefined;
    this.append(
      {
        type: "stage-duration",
        ghIssue: payload.ghIssue,
        ...(payload.sliceNumber !== undefined
          ? { sliceNumber: payload.sliceNumber }
          : {}),
        agent: payload.agent,
        ...(payload.round !== undefined ? { round: payload.round } : {}),
        durationMs,
        history,
        ...(ratio !== undefined ? { ratioToMedian: ratio } : {}),
      },
      ts,
    );
  }

  /** This stage's prior durations, seeding the cross-run history on first use. */
  private stageSamples(agent: string): number[] {
    this.stageHistory ??= readStageDurationHistory(
      dirname(this.runDir),
      this.runDir,
    );
    const existing = this.stageHistory.get(agent);
    if (existing) return existing;
    const created: number[] = [];
    this.stageHistory.set(agent, created);
    return created;
  }

  /** Track an in-flight slice or a HITL skip; terminal phases use recordTerminal. */
  trackSlice(next: SliceLifecycle) {
    if (!["PENDING", "RUNNING", "SKIPPED"].includes(next.phase)) {
      throw new Error(
        `RunJournal.trackSlice: terminal phase ${next.phase} must use recordTerminal`,
      );
    }
    if (next.phase === "RUNNING") {
      // Re-dispatch is the reopen (ADR 0055 §9): the parked mark goes here,
      // and `clearRecordsOnDispatch` takes the persisted park with it.
      this.parkedSlices.delete(next.ghIssue);
      this.clearRecordsOnDispatch(next);
    }
    this.slices.set(next.ghIssue, next);
  }

  /**
   * A slice going RUNNING is this run taking ownership of its record, so
   * the previous attempt's persisted record is dropped here (#111).
   *
   * This is the dispatch moment in the journal's own vocabulary, and it
   * is where ADR 0018's "RUNNING is never persisted" was only half true:
   * memory said RUNNING while disk still said `ERROR — exceeded 100 tool
   * calls` from two runs back, and every reader believed the disk. A run
   * killed mid-round then handed the *next* run a failure story about a
   * defect that was already fixed. Clearing at dispatch makes disk agree
   * with memory: a dispatched slice has no persisted outcome until this
   * run decides one.
   *
   * Nothing is cleared for a slice this run has already closed
   * (`recordTerminal`): a re-dispatch after a decided outcome would
   * otherwise wipe a record this run is entitled to. An adjudication park
   * is not closed in that sense and *is* cleared here: per ADR 0055 §9 the
   * park's durable estate is the slice directory and its branch, and the
   * state record is only the announcement, so a dispatch that supersedes
   * the park supersedes its record too.
   *
   * Best effort. A failed clear warns and the slice runs anyway — the
   * cost is the misleading record we already live with, and refusing to
   * dispatch over it would be strictly worse.
   */
  private clearRecordsOnDispatch(slice: SliceLifecycle) {
    if (this.terminalSlices.has(slice.ghIssue)) return;
    let previous: PersistedSliceState | null;
    try {
      previous = clearSliceStateForDispatch(
        this.repoRoot,
        this.prdSlug,
        slice.ghIssue,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.phase(
        `[afk] Warning: could not clear slice #${slice.ghIssue}'s stale run-state ` +
          `record at dispatch (${message}) — a reader may still be shown the ` +
          `previous run's outcome for it`,
        "warn",
      );
      return;
    }
    if (!previous) return;
    const reason = previous.error ? ` — ${previous.error}` : "";
    const message =
      `#${slice.ghIssue} ${slice.title}: dispatched — cleared the previous ` +
      `attempt's persisted record (${previous.phase}${reason}); this run owns ` +
      `the record from here`;
    this.phase(`[afk] ${message}`, "log", {
      type: "warn",
      reason: "stale-record-cleared",
      ghIssue: slice.ghIssue,
      message,
      previousPhase: previous.phase,
      ...(previous.error !== undefined ? { previousError: previous.error } : {}),
    });
  }

  /** Restore an already-persisted PASS for this run's summary. */
  restoreCompleted(sliceId: SliceIdentity) {
    this.slices.set(sliceId.ghIssue, lifecycle.pass(sliceId, ZERO_PROGRESS, true));
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
   * Persist one terminal or parked outcome. State lands first (ADR 0018),
   * then the in-memory lifecycle, run.log line, and unchanged
   * slice-outcome event — one ordering for both classes.
   *
   * A completed terminal call is idempotent for the rest of this run. A
   * park (ADR 0055 §9) is idempotent the same way for a re-record of the
   * *same* park, but it is replaceable: a **different** outcome may only
   * follow an intervening `trackSlice` dispatch, and asking for one
   * without that dispatch throws rather than silently overwriting the
   * record a human is being asked to act on (ADR 0031's protection).
   *
   * "Same park" means the whole record, phase and reason alike — not the
   * phase alone. Phase-only idempotency looked like ADR 0031's retry rule
   * and behaved like a data-loss bug: a partial adjudication parks again
   * naming only the findings still undecided (ADR 0054 item 3), same phase,
   * different reason, and the phase check silently kept the stale reason
   * listing findings the human had already decided. A caller that reaches
   * here with a changed park has skipped its reopen; that is a defect in
   * the caller, so it is raised, not absorbed.
   */
  recordTerminal(
    sliceId: SliceIdentity,
    outcome: TerminalOutcome,
  ): SliceLifecycle {
    const existing = this.slices.get(sliceId.ghIssue);
    if (this.terminalSlices.has(sliceId.ghIssue) && existing) return existing;
    if (this.parkedSlices.has(sliceId.ghIssue) && existing) {
      const sameError =
        ("error" in existing ? existing.error : undefined) ===
        ("error" in outcome ? outcome.error : undefined);
      // "The same park" is the whole record (ADR 0055 §9): phase, reason, and
      // branch identity. Branch naming is deterministic within a run today,
      // so comparing it changes no current behaviour — but the invariant is
      // stated over the whole record, and a re-park onto a different branch
      // with no intervening dispatch is a missing reopen in the caller, not a
      // retry, so it must throw rather than silently keep the old branch.
      const sameBranch = existing.branch === sliceId.branch;
      if (existing.phase === outcome.phase && sameError && sameBranch)
        return existing;
      const replacement =
        existing.phase === outcome.phase
          ? `a changed ${outcome.phase}`
          : outcome.phase;
      throw new Error(
        `RunJournal.recordTerminal: slice ${sliceId.ghIssue} is parked ` +
          `(lifecycle shows ${existing.phase}); ${replacement} may only ` +
          `follow a trackSlice dispatch that reopens the park`,
      );
    }

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
    if (traitsFor(next.phase).replaceableThisRun) {
      this.parkedSlices.add(sliceId.ghIssue);
    } else {
      this.terminalSlices.add(sliceId.ghIssue);
    }
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

  /**
   * Route a fatal `'error'` event on an agent log stream to the crash
   * recorder (#121). Run 6 died exactly here: a `WriteStream` hit ENOSPC,
   * nothing listened, and Node's unhandled-`'error'` throw ended the
   * process before any record was written.
   *
   * Registered by `runPipeline` only when the CLI supplied a crash
   * recorder. Without one, no listener is attached and an unhandled
   * `'error'` stays process-fatal exactly as before — a stream failure
   * must not become a silence just because nobody is recording.
   */
  onFatalStreamError(handler: (error: unknown, origin: string) => void) {
    this.fatalStreamError = handler;
  }

  agentLog(sliceId: string, agent: string, round?: number): WriteStream {
    const stream = this.logger.agentLog(sliceId, agent, round);
    if (this.fatalStreamError) {
      // Named by the file being written: "the disk refused this log" is a
      // different diagnosis from "an agent threw", and the record should
      // not make the operator guess which one happened.
      const origin = basename(String(stream.path));
      stream.on("error", (error) => this.fatalStreamError?.(error, origin));
    }
    return stream;
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

  recordDependencyHold(
    sliceId: SliceIdentity,
    blockers: DependencyBlocker[],
  ) {
    this.logger.recordDependencyHold(sliceId, blockers);
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
    case "AWAITING-ADJUDICATION":
      return lifecycle.awaitingAdjudication(sliceId, progress, outcome.error);
    case "ADJUDICATION-LOCK-REFUSED":
      return lifecycle.adjudicationLockRefused(
        sliceId,
        progress,
        outcome.error,
      );
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

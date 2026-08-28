import { buildDAG, type Slice } from "./issues-parser.js";
import type { RunEvent } from "./run-events.js";
import type { PersistedSliceState, RunState } from "./run-state.js";
import {
  traitsFor,
  type SliceLifecycle,
  type SlicePhase,
} from "./slice-lifecycle.js";

type RunStartedEvent = Extract<RunEvent, { type: "run-started" }>;
type RunEndedEvent = Extract<RunEvent, { type: "run-ended" }>;
type PhaseEndedEvent = Extract<RunEvent, { type: "phase-ended" }>;
type RunPhase =
  Extract<RunEvent, { type: "run-phase-started" }>["phase"];

export type SnapshotChronologyEntry =
  | { type: "run-started"; event: RunStartedEvent }
  | {
      type: "wave-dispatched";
      event: Extract<RunEvent, { type: "wave-dispatched" }>;
    }
  | {
      type: "phase-ended";
      event: PhaseEndedEvent;
      durationMs?: number;
    }
  | { type: "warn"; event: Extract<RunEvent, { type: "warn" }> }
  | {
      type: "slice-outcome";
      event: Extract<RunEvent, { type: "slice-outcome" }>;
    };

export type SnapshotPhaseCloseReason =
  | "phase-ended"
  | "slice-outcome"
  | "run-state";

export interface SnapshotPhaseInvocation {
  ghIssue: string;
  sliceNumber?: string;
  agent: string;
  round?: number;
  attempt: number;
  startedTs?: string;
  endedTs?: string;
  closedTs?: string;
  closeReason?: SnapshotPhaseCloseReason;
  verdict?: string;
}

export interface SnapshotSliceOutcome {
  phase: SlicePhase;
  source: "event" | "run-state";
  title?: string;
  branch?: string;
  mergedToFeature?: boolean;
  error?: string;
  collidingPrefixes?: string[];
}

export interface SnapshotSlice {
  ghIssue: string;
  sliceNumber?: string;
  title: string;
  dispatched: boolean;
  invocations: SnapshotPhaseInvocation[];
  outcome?: SnapshotSliceOutcome;
  blockedBy: string[];
}

/**
 * A displayed outcome this run cannot claim as its own (#111).
 *
 * `afk status --run <dir>` folds one run's event stream together with
 * `.afk/state/<slug>.json`, which is cumulative across every run of that
 * slug. A record in that file is only attributable to the run being read
 * if the run's own events say so — and since a dispatch now clears the
 * slice's record, a record for a slice *this* run dispatched, with no
 * `slice-outcome` event behind it, was written after that dispatch. It
 * may belong to a later run sharing the file. Presenting it as this
 * run's result is precisely how #111's two-runs-stale error text reached
 * a post-mortem, so it is reported rather than silently adopted.
 */
export interface SnapshotOutcomeMismatch {
  ghIssue: string;
  /** The phase carried by the unattributable record. */
  phase: SlicePhase;
  /** Operator-facing one-liner; rendered by `afk status`. */
  message: string;
}

export interface SnapshotWave {
  wave: number;
  slices: string[];
  lanes?: string[][];
  serial: boolean;
  startedTs?: string;
  endedTs?: string;
}

export interface SnapshotRunPhaseInvocation {
  phase: RunPhase;
  attempt?: number;
  cached?: boolean;
  startedTs?: string;
  endedTs?: string;
  verdict?: string;
}

export interface SnapshotProjectedWave {
  wave: number;
  slices: string[];
}

export interface RunSnapshot {
  run: {
    slug?: string;
    provider?: string;
    startedTs?: string;
    endedTs?: string;
    contractRoundLimit?: number;
    implementationRoundLimit?: number;
    outcome?: RunEndedEvent["outcome"];
  };
  chronology: SnapshotChronologyEntry[];
  slices: Record<string, SnapshotSlice>;
  sliceOrder: string[];
  /**
   * Persisted records shown as this run's outcomes that this run's events
   * do not account for. Empty in the ordinary case. See
   * {@link SnapshotOutcomeMismatch}.
   */
  outcomeMismatches: SnapshotOutcomeMismatch[];
  waves: SnapshotWave[];
  maxDispatchedWave: number;
  currentLanes: {
    wave: number;
    lanes: string[][];
    serial: boolean;
  } | null;
  runPhases: SnapshotRunPhaseInvocation[];
}

function invocationKey(input: {
  ghIssue: string;
  agent: string;
  round?: number;
}): string {
  return `${input.ghIssue}|${input.agent}|${input.round ?? ""}`;
}

function runPhaseKey(input: { phase: RunPhase; attempt?: number }): string {
  return `${input.phase}|${input.attempt ?? ""}`;
}

/** Phases a stop writes provisionally, without a per-slice event (#114). */
function isCancelledPhase(phase: SlicePhase): boolean {
  return traitsFor(phase).bucket === "cancelled";
}

function fromPersisted(state: PersistedSliceState): SnapshotSliceOutcome {
  return {
    phase: state.phase,
    source: "run-state",
    branch: state.branch,
    mergedToFeature: state.mergedToFeature,
    error: state.error,
    collidingPrefixes: state.collidingPrefixes,
  };
}

function fromEvent(slice: SliceLifecycle): SnapshotSliceOutcome {
  return {
    phase: slice.phase,
    source: "event",
    title: slice.title,
    branch: slice.branch,
    ...("mergedToFeature" in slice
      ? { mergedToFeature: slice.mergedToFeature }
      : {}),
    ...("error" in slice ? { error: slice.error } : {}),
    ...("collidingPrefixes" in slice
      ? { collidingPrefixes: slice.collidingPrefixes }
      : {}),
  };
}

function closeSliceInvocations(
  open: Map<string, SnapshotPhaseInvocation[]>,
  ghIssue: string,
  reason: "slice-outcome" | "run-state",
  closedTs?: string,
): void {
  for (const [key, invocations] of open) {
    const remaining: SnapshotPhaseInvocation[] = [];
    for (const invocation of invocations) {
      if (invocation.ghIssue !== ghIssue) {
        remaining.push(invocation);
        continue;
      }
      invocation.closeReason = reason;
      invocation.closedTs = closedTs;
    }
    if (remaining.length === 0) open.delete(key);
    else open.set(key, remaining);
  }
}

/**
 * Project the append-only run events and persisted run state into the
 * status read model. Event outcomes describe this run and therefore
 * override persisted records; persisted records fill event-stream gaps.
 *
 * A gap-filling record that this run's own dispatch should have cleared
 * is still used — it is the only outcome on offer — but it is also listed
 * in `outcomeMismatches`, because the run-state file is shared across
 * runs and this reader is the one that presents its contents as a
 * particular run's result (#111).
 */
export function foldEvents(
  events: readonly RunEvent[],
  runState: RunState | undefined,
): RunSnapshot {
  const slices: Record<string, SnapshotSlice> = {};
  const sliceOrder: string[] = [];
  const chronology: SnapshotChronologyEntry[] = [];
  const waves = new Map<number, SnapshotWave>();
  const openInvocations = new Map<string, SnapshotPhaseInvocation[]>();
  const invocationOccurrences = new Map<string, number>();
  const runPhases: SnapshotRunPhaseInvocation[] = [];
  const openRunPhases = new Map<string, SnapshotRunPhaseInvocation[]>();
  const eventOutcomes = new Set<string>();
  // A stop this run requested writes provisional CANCELLED records
  // straight to run state without a per-slice event (#114), so those are
  // this run's own records even though the event stream cannot name them.
  // Tracked here so the mismatch report below does not fire on every
  // interrupted run and train operators to ignore it.
  let cancellationRequested = false;
  let currentLanes: RunSnapshot["currentLanes"] = null;
  let runStarted: RunStartedEvent | undefined;
  let runEnded: RunEndedEvent | undefined;

  const sliceFor = (ghIssue: string): SnapshotSlice => {
    const existing = slices[ghIssue];
    if (existing) return existing;
    const created: SnapshotSlice = {
      ghIssue,
      title: "",
      dispatched: false,
      invocations: [],
      blockedBy: [],
    };
    slices[ghIssue] = created;
    sliceOrder.push(ghIssue);
    return created;
  };

  for (const [ghIssue, state] of Object.entries(runState?.slices ?? {})) {
    sliceFor(ghIssue).outcome = fromPersisted(state);
  }

  for (const event of events) {
    switch (event.type) {
      case "header":
        break;
      case "run-started":
        runStarted = event;
        chronology.push({ type: "run-started", event });
        break;
      case "run-ended":
        runEnded = event;
        break;
      case "wave-dispatched": {
        chronology.push({ type: "wave-dispatched", event });
        const wave = waves.get(event.wave) ?? {
          wave: event.wave,
          slices: [],
          serial: false,
        };
        wave.slices = [...event.slices];
        wave.startedTs = event.ts;
        waves.set(event.wave, wave);
        for (const ghIssue of event.slices) {
          sliceFor(ghIssue).dispatched = true;
        }
        break;
      }
      case "wave-completed": {
        const wave = waves.get(event.wave) ?? {
          wave: event.wave,
          slices: [],
          serial: false,
        };
        wave.endedTs = event.ts;
        waves.set(event.wave, wave);
        break;
      }
      case "lanes-partitioned": {
        const wave = waves.get(event.wave) ?? {
          wave: event.wave,
          slices: event.lanes.flat(),
          serial: false,
        };
        wave.lanes = event.lanes.map((lane) => [...lane]);
        wave.serial = event.serial === true;
        waves.set(event.wave, wave);
        currentLanes = {
          wave: event.wave,
          lanes: event.lanes.map((lane) => [...lane]),
          serial: event.serial === true,
        };
        for (const lane of event.lanes) {
          for (const ghIssue of lane) sliceFor(ghIssue);
        }
        break;
      }
      case "phase-started": {
        const slice = sliceFor(event.ghIssue);
        slice.sliceNumber = event.sliceNumber ?? slice.sliceNumber;
        const key = invocationKey(event);
        const invocation: SnapshotPhaseInvocation = {
          ghIssue: event.ghIssue,
          sliceNumber: event.sliceNumber,
          agent: event.agent,
          round: event.round,
          attempt: (invocationOccurrences.get(key) ?? 0) + 1,
          startedTs: event.ts,
        };
        invocationOccurrences.set(key, invocation.attempt);
        slice.invocations.push(invocation);
        const open = openInvocations.get(key) ?? [];
        open.push(invocation);
        openInvocations.set(key, open);
        break;
      }
      case "phase-ended": {
        const slice = sliceFor(event.ghIssue);
        slice.sliceNumber = event.sliceNumber ?? slice.sliceNumber;
        const key = invocationKey(event);
        const open = openInvocations.get(key);
        const invocation = open?.pop();
        if (open?.length === 0) openInvocations.delete(key);
        const matched =
          invocation ??
          ({
            ghIssue: event.ghIssue,
            sliceNumber: event.sliceNumber,
            agent: event.agent,
            round: event.round,
            attempt: (invocationOccurrences.get(key) ?? 0) + 1,
          } satisfies SnapshotPhaseInvocation);
        if (!invocation) {
          invocationOccurrences.set(key, matched.attempt);
          slice.invocations.push(matched);
        }
        matched.endedTs = event.ts;
        matched.closedTs = event.ts;
        matched.closeReason = "phase-ended";
        matched.verdict = event.verdict;
        const startMs =
          matched.startedTs === undefined ? Number.NaN : Date.parse(matched.startedTs);
        const endMs = Date.parse(event.ts);
        chronology.push({
          type: "phase-ended",
          event,
          ...(Number.isFinite(startMs) && Number.isFinite(endMs)
            ? { durationMs: Math.max(0, endMs - startMs) }
            : {}),
        });
        break;
      }
      case "slice-outcome": {
        const slice = sliceFor(event.slice.ghIssue);
        slice.title = event.slice.title;
        slice.outcome = fromEvent(event.slice);
        eventOutcomes.add(event.slice.ghIssue);
        closeSliceInvocations(
          openInvocations,
          event.slice.ghIssue,
          "slice-outcome",
          event.ts,
        );
        chronology.push({ type: "slice-outcome", event });
        break;
      }
      case "warn":
        if (event.ghIssue !== undefined) {
          const slice = sliceFor(event.ghIssue);
          if (event.reason === "not-run-hold" && event.blockedBy) {
            slice.blockedBy = [...event.blockedBy];
          }
        }
        if (
          event.reason === "cancellation-requested" ||
          event.reason === "stop-requested"
        ) {
          cancellationRequested = true;
        }
        chronology.push({ type: "warn", event });
        break;
      case "run-phase-started": {
        const invocation: SnapshotRunPhaseInvocation = {
          phase: event.phase,
          attempt: event.attempt,
          cached: event.cached,
          startedTs: event.ts,
        };
        runPhases.push(invocation);
        const key = runPhaseKey(event);
        const open = openRunPhases.get(key) ?? [];
        open.push(invocation);
        openRunPhases.set(key, open);
        break;
      }
      case "run-phase-ended": {
        const key = runPhaseKey(event);
        const open = openRunPhases.get(key);
        const invocation = open?.pop();
        if (open?.length === 0) openRunPhases.delete(key);
        const matched =
          invocation ??
          ({
            phase: event.phase,
            attempt: event.attempt,
          } satisfies SnapshotRunPhaseInvocation);
        if (!invocation) runPhases.push(matched);
        matched.endedTs = event.ts;
        matched.verdict = event.verdict;
        matched.cached = event.cached ?? matched.cached;
        break;
      }
    }
  }

  const outcomeMismatches: SnapshotOutcomeMismatch[] = [];
  for (const [ghIssue, state] of Object.entries(runState?.slices ?? {})) {
    if (eventOutcomes.has(ghIssue)) continue;
    const slice = sliceFor(ghIssue);
    slice.outcome = fromPersisted(state);
    closeSliceInvocations(openInvocations, ghIssue, "run-state");
    // The record still fills the gap — it is the only outcome on offer —
    // but a record for a slice *this* run dispatched cannot be this run's,
    // because dispatch clears it and a decided outcome emits an event.
    // Say so rather than presenting it as this run's result (#111).
    if (!slice.dispatched) continue;
    if (cancellationRequested && isCancelledPhase(state.phase)) continue;
    outcomeMismatches.push({
      ghIssue,
      phase: state.phase,
      message:
        `#${ghIssue}: the ${state.phase} record shown for this slice comes from ` +
        `the run-state file, not from this run's events — this run dispatched ` +
        `#${ghIssue}, and a dispatch clears the slice's record, so this one was ` +
        `written afterwards (most likely by a later run of the same PRD)`,
    });
  }

  const renderedWaves = [...waves.values()].sort((a, b) => a.wave - b.wave);
  return {
    run: {
      slug: runStarted?.runSlug,
      provider: runStarted?.provider,
      startedTs: runStarted?.ts,
      endedTs: runEnded?.ts,
      contractRoundLimit: runStarted?.contractRoundLimit,
      implementationRoundLimit: runStarted?.implementationRoundLimit,
      outcome: runEnded?.outcome,
    },
    chronology,
    slices,
    sliceOrder,
    outcomeMismatches,
    waves: renderedWaves,
    maxDispatchedWave: renderedWaves.reduce(
      (max, wave) => Math.max(max, wave.startedTs === undefined ? 0 : wave.wave),
      0,
    ),
    currentLanes,
    runPhases,
  };
}

function completedBy(snapshot: RunSnapshot, ghIssue: string): boolean {
  const outcome = snapshot.slices[ghIssue]?.outcome;
  return (
    outcome?.phase === "PASS" &&
    (outcome.source === "event" || outcome.mergedToFeature === true)
  );
}

function terminalWithoutCompletion(
  snapshot: RunSnapshot,
  ghIssue: string,
): boolean {
  const phase = snapshot.slices[ghIssue]?.outcome?.phase;
  return (
    phase !== undefined &&
    phase !== "PASS" &&
    phase !== "SKIPPED" &&
    traitsFor(phase).terminalThisRun
  );
}

/**
 * Project the remaining manifest into waves from the snapshot's current
 * completion and dispatch facts. Scheduling simulation stays beside the
 * fold instead of being reimplemented by a status view.
 */
export function projectUpcomingWaves(
  snapshot: RunSnapshot,
  manifest: readonly Slice[],
): SnapshotProjectedWave[] {
  const completed = new Set(
    manifest
      .filter((slice) => completedBy(snapshot, slice.ghIssue))
      .map((slice) => slice.ghIssue),
  );
  const pending = new Set(
    manifest
      .filter(
        (slice) =>
          slice.type === "AFK" &&
          !completed.has(slice.ghIssue) &&
          !terminalWithoutCompletion(snapshot, slice.ghIssue),
      )
      .map((slice) => slice.ghIssue),
  );
  const dag = buildDAG([...manifest]);
  const simulatedDone = new Set(completed);
  const projected: SnapshotProjectedWave[] = [];
  let wave = snapshot.maxDispatchedWave + 1;
  let first = true;

  while (true) {
    const ready = dag.ready(simulatedDone).filter((id) => pending.has(id));
    if (ready.length === 0) break;
    if (
      first &&
      snapshot.maxDispatchedWave > 0 &&
      ready.some((id) => snapshot.slices[id]?.dispatched === true)
    ) {
      wave = snapshot.maxDispatchedWave;
    }
    first = false;
    projected.push({ wave, slices: ready });
    for (const id of ready) simulatedDone.add(id);
    wave++;
  }
  return projected;
}

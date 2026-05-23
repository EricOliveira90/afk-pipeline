/**
 * Explicit slice state machine. Each `SliceLifecycle` value represents
 * the slice's current phase plus the fields that phase carries; invalid
 * combinations (e.g. PASS without `mergedToFeature`, terminal without
 * `error`) are rejected at compile time.
 *
 * Logger and run-state both consume this type. Run-state persists a
 * trimmed JSON projection (`PersistedSliceState` in run-state.ts).
 */

export interface SliceIdentity {
  ghIssue: string;
  title: string;
  /** "" while PENDING / before a worktree exists; "—" for HITL skips. */
  branch: string;
}

export interface SliceProgress {
  genRounds: number;
  evalRounds: number;
}

/** Phases that carry an `error` payload. Used to widen union helpers. */
export type FailurePhase =
  | "STUCK"
  | "ESCALATE"
  | "ERROR"
  | "CONFLICT"
  | "CANCELLED"
  | "LANE-CANCELLED";

export type SliceLifecycle =
  | ({ phase: "PENDING" } & SliceIdentity & { progress: SliceProgress })
  | ({ phase: "RUNNING" } & SliceIdentity & { progress: SliceProgress })
  | ({ phase: "PASS" } & SliceIdentity & {
      progress: SliceProgress;
      mergedToFeature: boolean;
    })
  | ({ phase: FailurePhase } & SliceIdentity & {
      progress: SliceProgress;
      error: string;
    })
  | ({ phase: "SKIPPED" } & SliceIdentity);

export type SlicePhase = SliceLifecycle["phase"];

export const ALL_PHASES = [
  "PENDING",
  "RUNNING",
  "PASS",
  "STUCK",
  "ESCALATE",
  "ERROR",
  "CONFLICT",
  "CANCELLED",
  "LANE-CANCELLED",
  "SKIPPED",
] as const satisfies ReadonlyArray<SlicePhase>;

const ZERO_PROGRESS: SliceProgress = { genRounds: 0, evalRounds: 0 };

/** Construct each variant via a named factory — keeps call sites readable. */
export const lifecycle = {
  pending: (id: SliceIdentity, progress: SliceProgress = ZERO_PROGRESS): SliceLifecycle => ({
    phase: "PENDING",
    ...id,
    progress,
  }),
  running: (id: SliceIdentity, progress: SliceProgress = ZERO_PROGRESS): SliceLifecycle => ({
    phase: "RUNNING",
    ...id,
    progress,
  }),
  pass: (
    id: SliceIdentity,
    progress: SliceProgress,
    mergedToFeature: boolean,
  ): SliceLifecycle => ({
    phase: "PASS",
    ...id,
    progress,
    mergedToFeature,
  }),
  stuck: (id: SliceIdentity, progress: SliceProgress, error: string): SliceLifecycle => ({
    phase: "STUCK",
    ...id,
    progress,
    error,
  }),
  escalate: (id: SliceIdentity, progress: SliceProgress, error: string): SliceLifecycle => ({
    phase: "ESCALATE",
    ...id,
    progress,
    error,
  }),
  error: (id: SliceIdentity, progress: SliceProgress, error: string): SliceLifecycle => ({
    phase: "ERROR",
    ...id,
    progress,
    error,
  }),
  conflict: (id: SliceIdentity, progress: SliceProgress, error: string): SliceLifecycle => ({
    phase: "CONFLICT",
    ...id,
    progress,
    error,
  }),
  cancelled: (id: SliceIdentity, progress: SliceProgress, error: string): SliceLifecycle => ({
    phase: "CANCELLED",
    ...id,
    progress,
    error,
  }),
  laneCancelled: (
    id: SliceIdentity,
    progress: SliceProgress,
    error: string,
  ): SliceLifecycle => ({
    phase: "LANE-CANCELLED",
    ...id,
    progress,
    error,
  }),
  skipped: (id: SliceIdentity): SliceLifecycle => ({ phase: "SKIPPED", ...id }),
};

/** Exhaustiveness helper — every switch on `phase` should end with `assertNever(value)`. */
export function assertNever(x: never): never {
  throw new Error(`Unhandled SliceLifecycle phase: ${JSON.stringify(x)}`);
}

export type SliceBucket =
  | "succeeded"
  | "failed"
  | "cancelled"
  | "skipped"
  | "inFlight";

export function bucketFor(phase: SlicePhase): SliceBucket {
  switch (phase) {
    case "PASS":
      return "succeeded";
    case "STUCK":
    case "ESCALATE":
    case "ERROR":
    case "CONFLICT":
      return "failed";
    case "CANCELLED":
    case "LANE-CANCELLED":
      return "cancelled";
    case "SKIPPED":
      return "skipped";
    case "RUNNING":
    case "PENDING":
      return "inFlight";
  }
}

/**
 * Display label for status columns. ESCALATE / ERROR collapse to STUCK
 * for byte-stable run-summary.md output (see plan §run-summary stability).
 * Persisted JSON keeps the distinction.
 */
export function summaryStatusLabel(phase: SlicePhase): string {
  if (phase === "ESCALATE" || phase === "ERROR") return "STUCK";
  return phase;
}

export function statusIconFor(phase: SlicePhase): string {
  switch (phase) {
    case "PASS":
      return "✅";
    case "STUCK":
    case "ESCALATE":
    case "ERROR":
      return "🔴";
    case "CONFLICT":
      return "⚠️";
    case "RUNNING":
      return "🔄";
    case "PENDING":
      return "⏳";
    case "CANCELLED":
      return "🚫";
    case "LANE-CANCELLED":
      return "⛔";
    case "SKIPPED":
      return "⏭️";
  }
}

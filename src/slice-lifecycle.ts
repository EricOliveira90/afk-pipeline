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
  /**
   * Deferred merge (ADR 0029): the work is complete and committed on the
   * slice branch, QA passed, and only the migration prefix collision
   * detected inside the merge mutex refused the merge. Carries the
   * colliding prefixes so the next run can retry the merge without
   * re-deriving them. Not a `FailurePhase` — nothing here needs a human.
   */
  | ({ phase: "MERGE-PENDING" } & SliceIdentity & {
      progress: SliceProgress;
      error: string;
      collidingPrefixes: string[];
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
  "MERGE-PENDING",
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
  mergePending: (
    id: SliceIdentity,
    progress: SliceProgress,
    error: string,
    collidingPrefixes: string[],
  ): SliceLifecycle => ({
    phase: "MERGE-PENDING",
    ...id,
    progress,
    error,
    collidingPrefixes,
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
  /** Merge deferred, recoverable without an agent on the next run. */
  | "deferred"
  | "cancelled"
  | "skipped"
  | "inFlight";

export type BranchDisposition = "branch" | "merged" | "preserved" | "none";

export interface SlicePhaseTraits {
  bucket: SliceBucket;
  icon: string;
  summaryLabel: string;
  persisted: boolean;
  terminalThisRun: boolean;
  branchDisposition: BranchDisposition;
}

export const PHASE_TRAITS = {
  PENDING: {
    bucket: "inFlight",
    icon: "⏳",
    summaryLabel: "PENDING",
    persisted: false,
    terminalThisRun: false,
    branchDisposition: "branch",
  },
  RUNNING: {
    bucket: "inFlight",
    icon: "🔄",
    summaryLabel: "RUNNING",
    persisted: false,
    terminalThisRun: false,
    branchDisposition: "branch",
  },
  PASS: {
    bucket: "succeeded",
    icon: "✅",
    summaryLabel: "PASS",
    persisted: true,
    terminalThisRun: true,
    branchDisposition: "merged",
  },
  STUCK: {
    bucket: "failed",
    icon: "🔴",
    summaryLabel: "STUCK",
    persisted: true,
    terminalThisRun: true,
    branchDisposition: "preserved",
  },
  ESCALATE: {
    bucket: "failed",
    icon: "🔴",
    summaryLabel: "STUCK",
    persisted: true,
    terminalThisRun: true,
    branchDisposition: "branch",
  },
  ERROR: {
    bucket: "failed",
    icon: "🔴",
    summaryLabel: "STUCK",
    persisted: true,
    terminalThisRun: true,
    branchDisposition: "branch",
  },
  CONFLICT: {
    bucket: "failed",
    icon: "⚠️",
    summaryLabel: "CONFLICT",
    persisted: true,
    terminalThisRun: true,
    branchDisposition: "preserved",
  },
  "MERGE-PENDING": {
    bucket: "deferred",
    icon: "⏸️",
    summaryLabel: "MERGE-PENDING",
    persisted: true,
    terminalThisRun: true,
    branchDisposition: "preserved",
  },
  CANCELLED: {
    bucket: "cancelled",
    icon: "🚫",
    summaryLabel: "CANCELLED",
    persisted: true,
    terminalThisRun: true,
    branchDisposition: "branch",
  },
  "LANE-CANCELLED": {
    bucket: "cancelled",
    icon: "⛔",
    summaryLabel: "LANE-CANCELLED",
    persisted: true,
    terminalThisRun: true,
    branchDisposition: "branch",
  },
  SKIPPED: {
    bucket: "skipped",
    icon: "⏭️",
    summaryLabel: "SKIPPED",
    persisted: true,
    terminalThisRun: true,
    branchDisposition: "none",
  },
} as const satisfies Record<SlicePhase, SlicePhaseTraits>;

export function traitsFor(phase: SlicePhase): SlicePhaseTraits {
  return PHASE_TRAITS[phase];
}

export function isSlicePhase(value: string): value is SlicePhase {
  return Object.prototype.hasOwnProperty.call(PHASE_TRAITS, value);
}

export function bucketFor(phase: SlicePhase): SliceBucket {
  return traitsFor(phase).bucket;
}

/**
 * Display label for status columns. ESCALATE / ERROR collapse to STUCK
 * for byte-stable run-summary.md output (see plan §run-summary stability).
 * Persisted JSON keeps the distinction.
 */
export function summaryStatusLabel(phase: SlicePhase): string {
  return traitsFor(phase).summaryLabel;
}

export function statusIconFor(phase: SlicePhase): string {
  return traitsFor(phase).icon;
}

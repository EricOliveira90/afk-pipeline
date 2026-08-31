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

export interface SliceAdoption {
  adopter: string;
  reason: string;
  branch: string;
  commit: string;
}

/** Phases that carry an `error` payload. Used to widen union helpers. */
export type FailurePhase =
  | "STUCK"
  | "ESCALATE"
  | "AWAITING-ADJUDICATION"
  | "ADJUDICATION-LOCK-REFUSED"
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
      adoption?: SliceAdoption;
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
  "AWAITING-ADJUDICATION",
  "ADJUDICATION-LOCK-REFUSED",
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
    adoption?: SliceAdoption,
  ): SliceLifecycle => ({
    phase: "PASS",
    ...id,
    progress,
    mergedToFeature,
    ...(adoption ? { adoption } : {}),
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
  awaitingAdjudication: (
    id: SliceIdentity,
    progress: SliceProgress,
    error: string,
  ): SliceLifecycle => ({
    phase: "AWAITING-ADJUDICATION",
    ...id,
    progress,
    error,
  }),
  adjudicationLockRefused: (
    id: SliceIdentity,
    progress: SliceProgress,
    error: string,
  ): SliceLifecycle => ({
    phase: "ADJUDICATION-LOCK-REFUSED",
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

/**
 * What `afk clean-failed` may dispose of when a slice sits in this phase
 * (ADR 0055 Seam 2 §6). Deliberately its own axis: `bucket` is about
 * rendering, and deriving disposability from it is what let the command
 * delete an adjudication park's estate.
 *
 * - `disposable` — the worktree is debris, and so is the branch once the
 *   command's own guard proves it holds nothing unmerged.
 * - `preserve-branch` — the worktree is debris, the branch is the next
 *   run's input (MERGE-PENDING, ADR 0029).
 * - `preserve-all` — nothing is debris: the estate is a human's pending
 *   input, and only the slice's own re-dispatch replaces it. Skipped, and
 *   reported by name, so the operator learns why. Only the park declares
 *   it, and it is a *secondary* signal: an adjudication estate's owner is
 *   proved from disk (`findAdjudicationEstate`), because every other exit
 *   that can leave one behind ends in an ordinary failure phase. This
 *   value is what still preserves a park whose worktree is already gone.
 * - `out-of-scope` — cleanup never considers this slice; nothing failed.
 */
export type DebrisDisposition =
  | "disposable"
  | "preserve-branch"
  | "preserve-all"
  | "out-of-scope";

export interface SlicePhaseTraits {
  bucket: SliceBucket;
  icon: string;
  summaryLabel: string;
  persisted: boolean;
  terminalThisRun: boolean;
  /**
   * A phase that is recorded like a terminal — persisted, projected, logged
   * — but that a later dispatch in the same run may replace (ADR 0055 §9,
   * the journal's third transition class). Absent means "immutable once
   * recorded this run", which is every phase but the adjudication park.
   */
  replaceableThisRun?: true;
  /**
   * Cleanup eligibility. Independent of `replaceableThisRun` above (the
   * journal's axis) and of `bucket` (the renderer's): the park happens to
   * be the one phase that is both replaceable and fully preserved, and
   * nothing should read either fact off the other.
   */
  debris: DebrisDisposition;
  branchDisposition: BranchDisposition;
}

export const PHASE_TRAITS = {
  PENDING: {
    bucket: "inFlight",
    icon: "⏳",
    summaryLabel: "PENDING",
    persisted: false,
    terminalThisRun: false,
    debris: "out-of-scope",
    branchDisposition: "branch",
  },
  RUNNING: {
    bucket: "inFlight",
    icon: "🔄",
    summaryLabel: "RUNNING",
    persisted: false,
    terminalThisRun: false,
    debris: "out-of-scope",
    branchDisposition: "branch",
  },
  PASS: {
    bucket: "succeeded",
    icon: "✅",
    summaryLabel: "PASS",
    persisted: true,
    terminalThisRun: true,
    debris: "out-of-scope",
    branchDisposition: "merged",
  },
  STUCK: {
    bucket: "failed",
    icon: "🔴",
    summaryLabel: "STUCK",
    persisted: true,
    terminalThisRun: true,
    debris: "disposable",
    branchDisposition: "preserved",
  },
  ESCALATE: {
    bucket: "failed",
    icon: "🔴",
    summaryLabel: "STUCK",
    persisted: true,
    terminalThisRun: true,
    debris: "disposable",
    branchDisposition: "branch",
  },
  "AWAITING-ADJUDICATION": {
    bucket: "failed",
    icon: "⏸️",
    summaryLabel: "AWAITING-ADJUDICATION",
    persisted: true,
    terminalThisRun: true,
    // The park: durable, but a human decision plus a re-dispatch replaces
    // it within this run.
    replaceableThisRun: true,
    debris: "preserve-all",
    branchDisposition: "branch",
  },
  "ADJUDICATION-LOCK-REFUSED": {
    // The mechanical lock gate refused an adjudicated lock on the current
    // base (ADR 0055 Seam 1 §5): the human decisions are complete and
    // recorded, but a migration prefix (or other run-specific claim) now
    // collides. To the operator it reads as a lock refusal — the same event
    // as the transaction's own gate refusal, so it presents as ESCALATE
    // does (failed bucket, STUCK label).
    //
    // The estate that refusal leaves behind must still survive
    // clean-failed and adopt — but the phase is not what says so. This
    // phase carried `preserve-all` for one round and it was the wrong
    // place for it: ownership of an adjudication estate is a fact about
    // the worktree, and every *other* post-decision apply exit (planner or
    // provider failure, feature-refresh conflict, cancellation mid-apply,
    // a post-lock bookkeeping throw the wave flattens) lands in ordinary
    // `ERROR` or `CONFLICT` with the same estate on disk. So the phase is
    // presentation-only again, exactly like ESCALATE, and clean-failed and
    // adopt read ownership from `findAdjudicationEstate` (ADR 0055 Seam 2
    // §6, fourth adjudication gate round).
    bucket: "failed",
    icon: "🔴",
    summaryLabel: "STUCK",
    persisted: true,
    terminalThisRun: true,
    debris: "disposable",
    branchDisposition: "branch",
  },
  ERROR: {
    bucket: "failed",
    icon: "🔴",
    summaryLabel: "STUCK",
    persisted: true,
    terminalThisRun: true,
    debris: "disposable",
    branchDisposition: "branch",
  },
  CONFLICT: {
    bucket: "failed",
    icon: "⚠️",
    summaryLabel: "CONFLICT",
    persisted: true,
    terminalThisRun: true,
    debris: "disposable",
    branchDisposition: "preserved",
  },
  "MERGE-PENDING": {
    bucket: "deferred",
    icon: "⏸️",
    summaryLabel: "MERGE-PENDING",
    persisted: true,
    terminalThisRun: true,
    debris: "preserve-branch",
    branchDisposition: "preserved",
  },
  CANCELLED: {
    bucket: "cancelled",
    icon: "🚫",
    summaryLabel: "CANCELLED",
    persisted: true,
    terminalThisRun: true,
    debris: "disposable",
    branchDisposition: "branch",
  },
  "LANE-CANCELLED": {
    bucket: "cancelled",
    icon: "⛔",
    summaryLabel: "LANE-CANCELLED",
    persisted: true,
    terminalThisRun: true,
    debris: "disposable",
    branchDisposition: "branch",
  },
  SKIPPED: {
    bucket: "skipped",
    icon: "⏭️",
    summaryLabel: "SKIPPED",
    persisted: true,
    terminalThisRun: true,
    debris: "out-of-scope",
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

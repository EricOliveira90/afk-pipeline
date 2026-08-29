import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import {
  ALL_PHASES,
  traitsFor,
  type SliceAdoption,
  type SliceLifecycle,
  type SlicePhase,
} from "./slice-lifecycle.js";
import type { PersistedRunScope } from "./slice-scope.js";

/** Phases that get persisted. RUNNING / PENDING never touch disk. */
export type PersistedPhase = Exclude<SlicePhase, "RUNNING" | "PENDING">;

const PERSISTED_PHASES = new Set<string>(
  ALL_PHASES.filter((phase) => traitsFor(phase).persisted),
);

export interface PersistedSliceState {
  phase: PersistedPhase;
  branch?: string;
  /** Only meaningful when `phase === "PASS"`. */
  mergedToFeature?: boolean;
  /** Free-text reason for failure phases; useful for postmortem after load. */
  error?: string;
  /**
   * Only meaningful when `phase === "MERGE-PENDING"`: the numeric
   * migration prefixes that refused the merge. Persisted so the next
   * run's merge-only recovery can report them without re-deriving
   * anything (ADR 0029).
   */
  collidingPrefixes?: string[];
  /** Audit trail for a slice completed outside the pipeline and adopted. */
  adoption?: SliceAdoption;
}

export interface RunState {
  version: 1;
  prdSlug: string;
  featureBranch: string;
  /** Immutable executable slice identities resolved at the first run. */
  scope?: PersistedRunScope;
  slices: Record<string, PersistedSliceState>;
  /** Cached post-merge review-phase results for cheap re-entry (ADR 0015). */
  reviewPhase?: PersistedReviewPhase;
  /**
   * Per-slice resume-attempt counters + last retry decision (spec #33 /
   * #36). Kept beside `slices` rather than inside `PersistedSliceState`
   * because a slice that died mid-generator may have NO slice record at
   * all (RUNNING is never persisted, ADR 0018) yet still needs its
   * resume counted on the next retry. Absent entries read as zero, so
   * state files that predate the field stay loadable unchanged.
   */
  resume?: Record<string, SliceResumeState>;
  /** Manifest-owned pool and issue-owned allocations, persisted across retries. */
  migrations?: MigrationClaimState;
}

export interface MigrationClaimState {
  pool: string[];
  claims: Record<string, string[]>;
}

/** Resume bookkeeping for one slice — see `RunState.resume`. */
export interface SliceResumeState {
  /** Resumes so far on the current tree. Reset to 0 on restart-from-base. */
  attempts: number;
  /** Human-readable last retry decision, for post-run audits. */
  lastDecision?: string;
}

/**
 * Pre-ship sanity gate result cached by the reviewed tree's SHA. Only
 * passing results are cached: a FAIL could be an environment flake, and
 * fixing a real failure changes the tree anyway.
 */
export interface PersistedSanityResult {
  treeSha: string;
  ok: true;
}

/** A favorable guardian verdict recorded against the reviewed HEAD. */
export interface PersistedReviewResult {
  headSha: string;
  verdict: "SHIP" | "ACCEPT-WITH-NOTES";
}

export interface PersistedReviewPhase {
  sanity?: PersistedSanityResult;
  architect?: PersistedReviewResult;
  pm?: PersistedReviewResult;
}

const FAVORABLE_VERDICTS = new Set(["SHIP", "ACCEPT-WITH-NOTES"]);

function sanitizeReviewResult(value: unknown): PersistedReviewResult | undefined {
  const v = (value ?? {}) as { headSha?: unknown; verdict?: unknown };
  if (
    typeof v.headSha === "string" &&
    v.headSha.length > 0 &&
    typeof v.verdict === "string" &&
    FAVORABLE_VERDICTS.has(v.verdict)
  ) {
    return { headSha: v.headSha, verdict: v.verdict as "SHIP" | "ACCEPT-WITH-NOTES" };
  }
  return undefined;
}

/**
 * Validate a loaded `reviewPhase`, dropping malformed or unfavorable
 * entries instead of throwing — a broken cache entry must degrade to a
 * re-run, never block resumption.
 */
export function sanitizeReviewPhase(value: unknown): PersistedReviewPhase | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as { sanity?: unknown; architect?: unknown; pm?: unknown };
  const out: PersistedReviewPhase = {};
  const sanity = (v.sanity ?? {}) as { treeSha?: unknown; ok?: unknown };
  if (typeof sanity.treeSha === "string" && sanity.treeSha.length > 0 && sanity.ok === true) {
    out.sanity = { treeSha: sanity.treeSha, ok: true };
  }
  const architect = sanitizeReviewResult(v.architect);
  if (architect) out.architect = architect;
  const pm = sanitizeReviewResult(v.pm);
  if (pm) out.pm = pm;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Validate a loaded `resume` map, dropping malformed entries instead of
 * throwing — bad bookkeeping must degrade to "zero attempts", never
 * block resumption.
 */
export function sanitizeResumeMap(
  value: unknown,
): Record<string, SliceResumeState> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const out: Record<string, SliceResumeState> = {};
  for (const [id, entry] of Object.entries(value as Record<string, unknown>)) {
    const e = (entry ?? {}) as { attempts?: unknown; lastDecision?: unknown };
    if (typeof e.attempts !== "number" || !Number.isSafeInteger(e.attempts) || e.attempts < 0) {
      continue;
    }
    out[id] = {
      attempts: e.attempts,
      ...(typeof e.lastDecision === "string" ? { lastDecision: e.lastDecision } : {}),
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Structural half of migration-claim validation: the pool is a
 * duplicate-free string array and claims map issue keys to string
 * arrays. Shared by load-time sanitising below and by
 * `validateClaimState` in migration-claims.ts, which layers
 * pool-membership and single-owner checks on top.
 */
export function assertMigrationClaimShape(value: {
  pool?: unknown;
  claims?: unknown;
}): asserts value is MigrationClaimState {
  if (
    !Array.isArray(value.pool) ||
    value.pool.some((prefix) => typeof prefix !== "string") ||
    new Set(value.pool).size !== value.pool.length
  ) {
    throw new Error("Run state contains an invalid migration prefix pool");
  }
  if (
    typeof value.claims !== "object" ||
    value.claims === null ||
    Array.isArray(value.claims)
  ) {
    throw new Error("Run state contains invalid migration claims");
  }
  for (const [issue, prefixes] of Object.entries(value.claims)) {
    if (
      !Array.isArray(prefixes) ||
      prefixes.some((prefix) => typeof prefix !== "string")
    ) {
      throw new Error(`Run state contains invalid migration claims for #${issue}`);
    }
  }
}

function sanitizeMigrationClaims(value: unknown): MigrationClaimState | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null) {
    throw new Error("Run state contains invalid migration claims");
  }
  const input = value as { pool?: unknown; claims?: unknown };
  assertMigrationClaimShape(input);
  const claims: Record<string, string[]> = {};
  for (const [issue, prefixes] of Object.entries(input.claims)) {
    claims[issue] = [...prefixes];
  }
  return { pool: [...input.pool], claims };
}

function statePath(repoRoot: string, prdSlug: string): string {
  return join(repoRoot, ".afk", "state", `${prdSlug}.json`);
}

/**
 * Load run state, adapting unversioned (v0) files in place. v0 files used
 * a per-slice `status` field whose values were a strict subset of v1's
 * `phase` enum, so the migration is a field rename. Throws on unknown
 * status strings rather than silently producing an invalid record.
 */
export function loadRunState(repoRoot: string, prdSlug: string): RunState {
  const p = statePath(repoRoot, prdSlug);
  if (!existsSync(p)) {
    return { version: 1, prdSlug, featureBranch: `feat/${prdSlug}`, slices: {} };
  }
  const raw = JSON.parse(readFileSync(p, "utf-8")) as unknown;
  return adaptLoadedState(raw, prdSlug);
}

export function adaptLoadedState(raw: unknown, prdSlug: string): RunState {
  const r = (raw ?? {}) as {
    version?: unknown;
    prdSlug?: string;
    featureBranch?: string;
    scope?: PersistedRunScope;
    slices?: Record<string, unknown>;
    reviewPhase?: unknown;
    resume?: unknown;
    migrations?: unknown;
  };
  const featureBranch = r.featureBranch ?? `feat/${prdSlug}`;
  const slicesIn = r.slices ?? {};

  if (r.version === 1) {
    const slices: Record<string, PersistedSliceState> = {};
    for (const [id, val] of Object.entries(slicesIn)) {
      slices[id] = validateV1Slice(id, val);
    }
    const reviewPhase = sanitizeReviewPhase(r.reviewPhase);
    const resume = sanitizeResumeMap(r.resume);
    const migrations = sanitizeMigrationClaims(r.migrations);
    return {
      version: 1,
      prdSlug,
      featureBranch,
      ...(r.scope !== undefined ? { scope: r.scope } : {}),
      slices,
      ...(reviewPhase !== undefined ? { reviewPhase } : {}),
      ...(resume !== undefined ? { resume } : {}),
      ...(migrations !== undefined ? { migrations } : {}),
    };
  }

  // v0: per-slice `status` instead of `phase`. Rename and validate.
  const slices: Record<string, PersistedSliceState> = {};
  for (const [id, val] of Object.entries(slicesIn)) {
    const v = (val ?? {}) as {
      status?: string;
      branch?: string;
      mergedToFeature?: boolean;
      error?: string;
      collidingPrefixes?: unknown;
      adoption?: unknown;
    };
    if (typeof v.status !== "string" || !PERSISTED_PHASES.has(v.status)) {
      throw new Error(
        `Unknown phase "${v.status}" while loading v0 run-state for slice ${id}`,
      );
    }
    slices[id] = {
      phase: v.status as PersistedPhase,
      ...(v.branch !== undefined ? { branch: v.branch } : {}),
      ...(v.mergedToFeature !== undefined
        ? { mergedToFeature: v.mergedToFeature }
        : {}),
      ...(v.error !== undefined ? { error: v.error } : {}),
      ...prefixesOf(v.collidingPrefixes),
      ...adoptionOf(v.adoption),
    };
  }
  return {
    version: 1,
    prdSlug,
    featureBranch,
    ...(r.scope !== undefined ? { scope: r.scope } : {}),
    slices,
  };
}

/**
 * Keep only a well-formed string array. A malformed list degrades to
 * absent rather than throwing: the phase and the reason text still carry
 * the operator-visible facts, so a broken field must not wedge a re-run.
 */
function prefixesOf(value: unknown): { collidingPrefixes?: string[] } {
  if (!Array.isArray(value)) return {};
  const prefixes = value.filter((p): p is string => typeof p === "string");
  return prefixes.length > 0 ? { collidingPrefixes: prefixes } : {};
}

function adoptionOf(value: unknown): { adoption?: SliceAdoption } {
  if (typeof value !== "object" || value === null) return {};
  const adoption = value as Partial<Record<keyof SliceAdoption, unknown>>;
  if (
    typeof adoption.adopter !== "string" ||
    adoption.adopter.trim() === "" ||
    typeof adoption.reason !== "string" ||
    adoption.reason.trim() === "" ||
    typeof adoption.branch !== "string" ||
    adoption.branch.trim() === "" ||
    typeof adoption.commit !== "string" ||
    adoption.commit.trim() === ""
  ) {
    return {};
  }
  return {
    adoption: {
      adopter: adoption.adopter,
      reason: adoption.reason,
      branch: adoption.branch,
      commit: adoption.commit,
    },
  };
}

function validateV1Slice(id: string, val: unknown): PersistedSliceState {
  const v = (val ?? {}) as {
    phase?: string;
    branch?: string;
    mergedToFeature?: boolean;
    error?: string;
    collidingPrefixes?: unknown;
    adoption?: unknown;
  };
  if (typeof v.phase !== "string" || !PERSISTED_PHASES.has(v.phase)) {
    throw new Error(
      `Unknown phase "${v.phase}" in run-state for slice ${id}`,
    );
  }
  return {
    phase: v.phase as PersistedPhase,
    ...(v.branch !== undefined ? { branch: v.branch } : {}),
    ...(v.mergedToFeature !== undefined
      ? { mergedToFeature: v.mergedToFeature }
      : {}),
    ...(v.error !== undefined ? { error: v.error } : {}),
    ...prefixesOf(v.collidingPrefixes),
    ...adoptionOf(v.adoption),
  };
}

/**
 * Project an in-memory `SliceLifecycle` to its persisted form. Returns
 * `null` for non-terminal phases that don't belong on disk.
 */
export function projectForPersistence(
  s: SliceLifecycle,
): PersistedSliceState | null {
  switch (s.phase) {
    case "PENDING":
    case "RUNNING":
      return null;
    case "PASS":
      return {
        phase: "PASS",
        ...(s.branch ? { branch: s.branch } : {}),
        mergedToFeature: s.mergedToFeature,
        ...(s.adoption ? { adoption: s.adoption } : {}),
      };
    case "SKIPPED":
      return {
        phase: "SKIPPED",
        ...(s.branch ? { branch: s.branch } : {}),
      };
    case "MERGE-PENDING":
      return {
        phase: "MERGE-PENDING",
        ...(s.branch ? { branch: s.branch } : {}),
        error: s.error,
        collidingPrefixes: s.collidingPrefixes,
      };
    case "STUCK":
    case "ESCALATE":
    case "AWAITING-ADJUDICATION":
    case "ERROR":
    case "CONFLICT":
    case "CANCELLED":
    case "LANE-CANCELLED":
      return {
        phase: s.phase,
        ...(s.branch ? { branch: s.branch } : {}),
        error: s.error,
      };
  }
}

/**
 * Atomically update a single slice in the run state.
 * Re-reads the file before writing to avoid clobbering parallel updates.
 * Auto-upgrades v0 files to v1 on next save.
 */
export function saveSliceState(
  repoRoot: string,
  prdSlug: string,
  ghIssue: string,
  result: PersistedSliceState,
) {
  const p = statePath(repoRoot, prdSlug);
  mkdirSync(dirname(p), { recursive: true });
  const current = loadRunState(repoRoot, prdSlug);
  current.slices[ghIssue] = result;
  writeFileSync(p, JSON.stringify(current, null, 2));
}

/**
 * Drop a slice's persisted record because this run is dispatching it
 * again (#111). Returns the record that was removed, or `null` when
 * there was nothing to remove — the file is then left untouched, so a
 * first run does not create a state file just to prove it had nothing
 * to clear.
 *
 * Every field of `PersistedSliceState` is a claim about a *decided*
 * outcome of a previous attempt: the phase, the branch it was decided
 * on, the failure reason, `mergedToFeature`, and the prefixes that
 * refused a merge. The moment the slice is dispatched again none of them
 * describes anything true, and nothing in the file says so. After run
 * 6's crash, #79's persisted `error` still named a typecheck failure
 * from two runs earlier — already fixed — and the next run's retry
 * announcement pointed the operator at the wrong defect.
 *
 * So the whole record goes, not only the error text. ADR 0018 already
 * makes absence mean "no decided outcome" (RUNNING is never persisted),
 * so removal is the one state that is honest for a slice in flight, and
 * `--only-failed` reads "not complete" rather than "recorded failed", so
 * a cleared slice stays eligible for the next run exactly as before.
 *
 * Deliberately NOT cleared: `resume` bookkeeping (its `attempts` is the
 * poison-tree cap, and the dispatch this clearing accompanies is about
 * to increment it), `scope`, `migrations`, and `reviewPhase`. None of
 * those is a per-attempt outcome claim.
 */
export function clearSliceStateForDispatch(
  repoRoot: string,
  prdSlug: string,
  ghIssue: string,
): PersistedSliceState | null {
  const p = statePath(repoRoot, prdSlug);
  if (!existsSync(p)) return null;
  const current = loadRunState(repoRoot, prdSlug);
  const previous = current.slices[ghIssue];
  if (!previous) return null;
  delete current.slices[ghIssue];
  writeFileSync(p, JSON.stringify(current, null, 2));
  return previous;
}

export function saveRunState(repoRoot: string, state: RunState) {
  const p = statePath(repoRoot, state.prdSlug);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(state, null, 2));
}

/**
 * Atomically replace the cached review-phase results. Re-reads the file
 * first (same pattern as `saveSliceState`) so parallel slice updates are
 * never clobbered. Pass `undefined` to clear the cache.
 */
export function saveReviewPhase(
  repoRoot: string,
  prdSlug: string,
  reviewPhase: PersistedReviewPhase | undefined,
) {
  const p = statePath(repoRoot, prdSlug);
  mkdirSync(dirname(p), { recursive: true });
  const current = loadRunState(repoRoot, prdSlug);
  if (reviewPhase === undefined) {
    delete current.reviewPhase;
  } else {
    current.reviewPhase = reviewPhase;
  }
  writeFileSync(p, JSON.stringify(current, null, 2));
}

export function markSliceComplete(
  state: RunState,
  ghIssue: string,
  result: PersistedSliceState,
) {
  state.slices[ghIssue] = result;
}

export function isSliceComplete(state: RunState, ghIssue: string): boolean {
  const s = state.slices[ghIssue];
  return s?.phase === "PASS" && s.mergedToFeature === true;
}

/** Resume attempts recorded for a slice; absent reads as zero (#36). */
export function getResumeAttempts(state: RunState, ghIssue: string): number {
  return state.resume?.[ghIssue]?.attempts ?? 0;
}

/**
 * Atomically record a slice's retry decision (resume-attempt count +
 * human-readable decision). Same read-modify-write pattern as
 * `saveSliceState` so parallel per-slice outcome writes are never
 * clobbered — and vice versa.
 */
export function recordRetryDecision(
  repoRoot: string,
  prdSlug: string,
  ghIssue: string,
  decision: SliceResumeState,
) {
  const p = statePath(repoRoot, prdSlug);
  mkdirSync(dirname(p), { recursive: true });
  const current = loadRunState(repoRoot, prdSlug);
  current.resume = { ...current.resume, [ghIssue]: decision };
  writeFileSync(p, JSON.stringify(current, null, 2));
}

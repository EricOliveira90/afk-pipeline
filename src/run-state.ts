import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import {
  ALL_PHASES,
  type SliceLifecycle,
  type SlicePhase,
} from "./slice-lifecycle.js";
import type { PersistedRunScope } from "./slice-scope.js";

/** Phases that get persisted. RUNNING / PENDING never touch disk. */
export type PersistedPhase = Exclude<SlicePhase, "RUNNING" | "PENDING">;

const PERSISTED_PHASES = new Set<string>(
  ALL_PHASES.filter((p) => p !== "RUNNING" && p !== "PENDING"),
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
   * anything (ADR 0025).
   */
  collidingPrefixes?: string[];
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
  };
  const featureBranch = r.featureBranch ?? `feat/${prdSlug}`;
  const slicesIn = r.slices ?? {};

  if (r.version === 1) {
    const slices: Record<string, PersistedSliceState> = {};
    for (const [id, val] of Object.entries(slicesIn)) {
      slices[id] = validateV1Slice(id, val);
    }
    const reviewPhase = sanitizeReviewPhase(r.reviewPhase);
    return {
      version: 1,
      prdSlug,
      featureBranch,
      ...(r.scope !== undefined ? { scope: r.scope } : {}),
      slices,
      ...(reviewPhase !== undefined ? { reviewPhase } : {}),
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

function validateV1Slice(id: string, val: unknown): PersistedSliceState {
  const v = (val ?? {}) as {
    phase?: string;
    branch?: string;
    mergedToFeature?: boolean;
    error?: string;
    collidingPrefixes?: unknown;
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

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import {
  ALL_PHASES,
  type SliceLifecycle,
  type SlicePhase,
} from "./slice-lifecycle.js";

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
}

export interface RunState {
  version: 1;
  prdSlug: string;
  featureBranch: string;
  slices: Record<string, PersistedSliceState>;
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
    slices?: Record<string, unknown>;
  };
  const featureBranch = r.featureBranch ?? `feat/${prdSlug}`;
  const slicesIn = r.slices ?? {};

  if (r.version === 1) {
    const slices: Record<string, PersistedSliceState> = {};
    for (const [id, val] of Object.entries(slicesIn)) {
      slices[id] = validateV1Slice(id, val);
    }
    return { version: 1, prdSlug, featureBranch, slices };
  }

  // v0: per-slice `status` instead of `phase`. Rename and validate.
  const slices: Record<string, PersistedSliceState> = {};
  for (const [id, val] of Object.entries(slicesIn)) {
    const v = (val ?? {}) as {
      status?: string;
      branch?: string;
      mergedToFeature?: boolean;
      error?: string;
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
    };
  }
  return { version: 1, prdSlug, featureBranch, slices };
}

function validateV1Slice(id: string, val: unknown): PersistedSliceState {
  const v = (val ?? {}) as {
    phase?: string;
    branch?: string;
    mergedToFeature?: boolean;
    error?: string;
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

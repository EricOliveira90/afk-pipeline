import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

export interface SliceState {
  status:
    | "PASS"
    | "STUCK"
    | "CONFLICT"
    | "ESCALATE"
    | "ERROR"
    | "CANCELLED"
    | "LANE-CANCELLED";
  branch?: string;
  mergedToFeature?: boolean;
}

export interface RunState {
  prdSlug: string;
  featureBranch: string;
  slices: Record<string, SliceState>;
}

function statePath(repoRoot: string, prdSlug: string): string {
  return join(repoRoot, ".afk", "state", `${prdSlug}.json`);
}

export function loadRunState(repoRoot: string, prdSlug: string): RunState {
  const p = statePath(repoRoot, prdSlug);
  if (existsSync(p)) {
    return JSON.parse(readFileSync(p, "utf-8"));
  }
  return { prdSlug, featureBranch: `feat/${prdSlug}`, slices: {} };
}

/**
 * Atomically update a single slice in the run state.
 * Re-reads the file before writing to avoid clobbering parallel updates.
 */
export function saveSliceState(
  repoRoot: string,
  prdSlug: string,
  ghIssue: string,
  result: SliceState,
) {
  const p = statePath(repoRoot, prdSlug);
  mkdirSync(dirname(p), { recursive: true });
  // Re-read current state to avoid overwriting parallel slice updates
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
  result: SliceState,
) {
  state.slices[ghIssue] = result;
}

export function isSliceComplete(state: RunState, ghIssue: string): boolean {
  return (
    state.slices[ghIssue]?.status === "PASS" &&
    state.slices[ghIssue]?.mergedToFeature === true
  );
}

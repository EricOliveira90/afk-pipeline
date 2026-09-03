import type { PersistedSliceState } from "./run-state.js";
import { traitsFor } from "./slice-lifecycle.js";

export type CleanupEligibility = "failed-debris" | "completed-clean" | null;

/**
 * One eligibility rule for launch advice and `clean-failed`.
 *
 * Failure-state debris keeps its lifecycle policy. A completed slice is an
 * extra cleanup target only when its merge is recorded and its worktree is
 * clean, so cleanup cannot discard post-PASS edits.
 */
export function cleanupEligibility(
  slice: PersistedSliceState,
  worktreeIsClean: boolean,
): CleanupEligibility {
  if (traitsFor(slice.phase).debris !== "out-of-scope") {
    return "failed-debris";
  }
  if (
    slice.phase === "PASS" &&
    slice.mergedToFeature === true &&
    worktreeIsClean
  ) {
    return "completed-clean";
  }
  return null;
}

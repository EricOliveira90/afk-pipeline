import type { RunState } from "./run-state.js";
import type { SliceAdoption } from "./slice-lifecycle.js";

export interface AdoptedSlice extends SliceAdoption {
  ghIssue: string;
}

export function adoptionForCompletedSlice(
  state: RunState,
  ghIssue: string,
): SliceAdoption | undefined {
  return state.slices[ghIssue]?.adoption;
}

export function adoptedSlices(state: RunState): AdoptedSlice[] {
  return Object.entries(state.slices).flatMap(([ghIssue, sliceState]) =>
    sliceState.adoption ? [{ ghIssue, ...sliceState.adoption }] : [],
  );
}

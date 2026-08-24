import type { AgentProvider } from "./agent-provider.js";
import type { Slice } from "./issues-parser.js";
import { pipelineRunSlug } from "./orchestrator.js";
import { isSliceComplete, loadRunState } from "./run-state.js";
import {
  resolveOnlyFailedSelection,
  resolveRunScope,
  type ResolvedRunScope,
} from "./slice-scope.js";

export interface CliRunScope {
  requestedSliceNumbers: string[] | undefined;
  priorCompleted: Set<string>;
  scope: ResolvedRunScope;
}

/** Resolve the selection once for CLI display, dry-run, and dispatch. */
export function resolveCliRunScope(args: {
  repoRoot: string;
  prdSlug: string;
  provider: AgentProvider;
  slices: Slice[];
  selectedSliceNumbers?: string[];
  manifestSelectedSliceNumbers?: string[];
  onlyFailed: boolean;
}): CliRunScope {
  if (args.onlyFailed && args.selectedSliceNumbers) {
    throw new Error(
      "--only-failed cannot be combined with --slices; it derives the selection from the persisted run scope",
    );
  }

  const state = loadRunState(
    args.repoRoot,
    pipelineRunSlug(args.prdSlug, args.provider),
  );
  let requestedSliceNumbers = args.selectedSliceNumbers;
  if (args.onlyFailed) {
    if (!state.scope) {
      throw new Error(
        "--only-failed needs a persisted run scope; run the pipeline once before narrowing it to the failed slices",
      );
    }
    const fullScope = resolveRunScope(args.slices, undefined, state.scope);
    requestedSliceNumbers = resolveOnlyFailedSelection(
      fullScope.members,
      (id) => isSliceComplete(state, id),
    );
  } else if (requestedSliceNumbers === undefined && args.manifestSelectedSliceNumbers) {
    requestedSliceNumbers = [...args.manifestSelectedSliceNumbers];
  }

  if (args.manifestSelectedSliceNumbers) {
    const allowed = new Set(
      args.manifestSelectedSliceNumbers.map((number) => String(Number(number))),
    );
    const conflicting = (requestedSliceNumbers ?? []).filter(
      (number) => !allowed.has(String(Number(number))),
    );
    if (conflicting.length > 0) {
      throw new Error(
        `CLI scope conflicts with afk.json: slice${conflicting.length === 1 ? "" : "s"} ` +
          `${conflicting.join(", ")} ${conflicting.length === 1 ? "is" : "are"} outside selectedSlices`,
      );
    }
  }

  const scope = resolveRunScope(args.slices, requestedSliceNumbers, state.scope);
  if (args.manifestSelectedSliceNumbers) {
    const allowed = new Set(
      args.manifestSelectedSliceNumbers.map((number) => String(Number(number))),
    );
    const conflicting = scope.members.filter(
      (slice) => !allowed.has(String(Number(slice.number))),
    );
    if (conflicting.length > 0) {
      throw new Error(
        `Persisted run scope conflicts with afk.json: ${conflicting
          .map((slice) => `${slice.number} (#${slice.ghIssue})`)
          .join(", ")}`,
      );
    }
  }

  return {
    requestedSliceNumbers,
    priorCompleted: new Set(
      Object.keys(state.slices).filter((id) => isSliceComplete(state, id)),
    ),
    scope,
  };
}

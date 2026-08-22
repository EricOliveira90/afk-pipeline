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
  }

  return {
    requestedSliceNumbers,
    priorCompleted: new Set(
      Object.keys(state.slices).filter((id) => isSliceComplete(state, id)),
    ),
    scope: resolveRunScope(
      args.slices,
      requestedSliceNumbers,
      state.scope,
    ),
  };
}

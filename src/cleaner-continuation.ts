import type { GeneratorFailureSet } from "./context-envelope.js";
import type {
  CleanerAdvance,
  CleanerOrchestrationSession,
} from "./cleaner-orchestration.js";
import type { CleanerStageResult } from "./cleaner-stage.js";

export type CleanerContinuationControl<TTerminal> =
  | { kind: "PROCEED" }
  | { kind: "RETURN_TO_GENERATOR" }
  | { kind: "STUCK"; terminal: TTerminal };

export interface CleanerContinuation<TTerminal> {
  readonly current: CleanerStageResult;
  advance(
    request: CleanerAdvance,
  ): Promise<CleanerContinuationControl<TTerminal>>;
}

interface CleanerContinuationAdapter<TTerminal> {
  returnToGenerator(
    failureSet: GeneratorFailureSet,
    retryNote: string,
  ): void;
  finishStuck(
    reason: string,
    artifactReferences: readonly string[],
  ): TTerminal;
}

/**
 * Translate cleaner-owned decisions once at the seam with the orchestrator.
 * The cleaner keeps stage state and terminal policy; the adapter keeps
 * generator-loop and slice-lifecycle authority with the orchestrator.
 */
export function createCleanerContinuation<TTerminal>(
  session: CleanerOrchestrationSession,
  adapter: CleanerContinuationAdapter<TTerminal>,
): CleanerContinuation<TTerminal> {
  let current: CleanerStageResult | undefined;

  return {
    get current() {
      if (!current) {
        throw new Error("Cleaner continuation has not advanced");
      }
      return current;
    },
    async advance(request) {
      const decision = await session.advance(request);
      current = decision.result;

      if (decision.kind === "RETURN_TO_GENERATOR") {
        adapter.returnToGenerator(
          decision.failureSet,
          decision.retryNote,
        );
        return { kind: "RETURN_TO_GENERATOR" };
      }
      if (decision.kind === "STUCK") {
        return {
          kind: "STUCK",
          terminal: adapter.finishStuck(
            decision.reason,
            decision.artifactReferences,
          ),
        };
      }
      return { kind: "PROCEED" };
    },
  };
}

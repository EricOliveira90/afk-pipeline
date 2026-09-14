import { describe, expect, it, vi } from "vitest";
import type { GeneratorFailureSet } from "./context-envelope.js";
import {
  createCleanerContinuation,
  type CleanerContinuationControl,
} from "./cleaner-continuation.js";
import type {
  CleanerDecision,
  CleanerOrchestrationSession,
} from "./cleaner-orchestration.js";
import type { CleanerStageResult } from "./cleaner-stage.js";

const result: CleanerStageResult = {
  ran: true,
  outcome: "PASS",
  inputTreeId: "accepted-tree",
  outputTreeId: "cleaner-tree",
  roundsSpent: 1,
};

const failureSet: GeneratorFailureSet = {
  findings: [
    {
      id: "CL-01",
      clearCondition: "restore the accepted behavior",
      artifactReferences: ["slice/cleaner-escalation.json"],
    },
  ],
  gates: [],
};

function sessionReturning(
  ...decisions: CleanerDecision[]
): CleanerOrchestrationSession {
  const queue = [...decisions];
  return {
    advance: vi.fn(async () => {
      const decision = queue.shift();
      if (!decision) throw new Error("No queued cleaner decision");
      return decision;
    }),
  };
}

describe("createCleanerContinuation", () => {
  it("keeps the current result and hides a proceeding decision", async () => {
    const returnToGenerator = vi.fn();
    const finishStuck = vi.fn();
    const continuation = createCleanerContinuation(
      sessionReturning({ kind: "PROCEED", result }),
      { returnToGenerator, finishStuck },
    );

    expect(() => continuation.current).toThrow(
      "Cleaner continuation has not advanced",
    );
    await expect(
      continuation.advance({ kind: "INITIAL" }),
    ).resolves.toEqual({ kind: "PROCEED" });
    expect(continuation.current).toBe(result);
    expect(returnToGenerator).not.toHaveBeenCalled();
    expect(finishStuck).not.toHaveBeenCalled();
  });

  it("routes generator and stuck terminals through one adapter", async () => {
    const returnToGenerator = vi.fn();
    const finishStuck = vi.fn(() => ({ phase: "STUCK" as const }));
    const controls: CleanerContinuationControl<{ phase: "STUCK" }>[] = [];
    const continuation = createCleanerContinuation(
      sessionReturning(
        {
          kind: "RETURN_TO_GENERATOR",
          result,
          failureSet,
          retryNote: "retry the implementation",
        },
        {
          kind: "STUCK",
          result: { ...result, outcome: "EXHAUSTED" },
          reason: "clean gates remain red",
          artifactReferences: [".afk/evidence/clean.log"],
        },
      ),
      { returnToGenerator, finishStuck },
    );

    controls.push(await continuation.advance({ kind: "INITIAL" }));
    controls.push(
      await continuation.advance({
        kind: "RESTORE",
        findings: [],
        discardArtifacts: [],
      }),
    );

    expect(controls).toEqual([
      { kind: "RETURN_TO_GENERATOR" },
      { kind: "STUCK", terminal: { phase: "STUCK" } },
    ]);
    expect(returnToGenerator).toHaveBeenCalledOnce();
    expect(returnToGenerator).toHaveBeenCalledWith(
      failureSet,
      "retry the implementation",
    );
    expect(finishStuck).toHaveBeenCalledOnce();
    expect(finishStuck).toHaveBeenCalledWith(
      "clean gates remain red",
      [".afk/evidence/clean.log"],
    );
    expect(continuation.current.outcome).toBe("EXHAUSTED");
  });
});

import { describe, expect, it } from "vitest";
import type { AcceptanceManifestV2 } from "./acceptance-manifest.js";
import {
  assembleContractEvaluatorPrompt,
  assemblePlannerPrompt,
} from "./contract-prompt-orchestration.js";
import type { RunEventPayload } from "./run-events.js";

const acceptanceManifest: AcceptanceManifestV2 = {
  version: 2,
  fileScope: { kind: "paths", paths: ["src/feature.ts"] },
  migrationCount: 0,
  behaviors: [
    {
      id: "B-01",
      source: "GH #95",
      given: "a contract",
      when: "it is reviewed",
      then: "the focused prompt is assembled",
      observableResult: "the event records its evidence",
      preservation: false,
      gateIds: ["tests"],
    },
  ],
};

function captureEvents() {
  const events: RunEventPayload[] = [];
  return {
    events,
    context: {
      journal: { event: (event: RunEventPayload) => events.push(event) },
      ghIssue: "95",
      sliceNumber: "03",
      specsDir: ".kiro/specs/demo",
      sliceDir: ".kiro/specs/demo/slices/03-envelope",
      round: 2,
    },
  };
}

describe("contract prompt orchestration", () => {
  it("assembles and records a planner prompt behind one seam", () => {
    const { events, context } = captureEvents();
    const prompt = assemblePlannerPrompt(
      {
        mode: "revision",
        input: {
          ghIssue: "95",
          specsDir: ".kiro/specs/demo",
          sliceDir: ".kiro/specs/demo/slices/03-envelope",
          round: 2,
          currentContract: "contract",
          currentAcceptanceManifest: JSON.stringify(acceptanceManifest),
          findings: [],
          contractResponseInstructions: "Do not write a response.",
          baseGateCatalog: "- tests: pnpm test:fast",
          migrationReservation: "none",
        },
      },
      context,
    );

    expect(prompt).toContain("# Routed OPEN findings");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "prompt-assembly",
      ghIssue: "95",
      sliceNumber: "03",
      round: 2,
      role: "planner",
    });
  });

  it("assembles and records an evaluator prompt behind the same seam", () => {
    const { events, context } = captureEvents();
    const prompt = assembleContractEvaluatorPrompt(
      {
        mode: "initial",
        input: {
          sliceDir: ".kiro/specs/demo/slices/03-envelope",
          round: 2,
          contractReviewFile: "contract-review.json",
          proposedContract: "contract",
          acceptanceManifest,
          baseGateCatalog: "- tests: pnpm test:fast",
          explorerContext: "context",
        },
      },
      context,
    );

    expect(prompt).toContain("# Proposed contract");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "prompt-assembly",
      role: "evaluator-contract",
    });
  });
});

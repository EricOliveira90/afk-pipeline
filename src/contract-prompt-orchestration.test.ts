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
  it("B-01 prepares planner prompt evidence behind one seam", () => {
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

    expect(prompt.prompt).toContain("# Routed OPEN findings");
    expect(events).toHaveLength(0);
    expect(prompt.contextEnvelope).toMatchObject({
      ghIssue: "95",
      sliceNumber: "03",
      round: 2,
      role: "planner",
    });
    expect(prompt.contextEnvelope.includedArtifactClasses).toEqual([
      "current-contract-pair",
      "current-contract-pair",
      "base-gate-catalog",
      "migration-reservation",
    ]);
    expect(prompt.contextEnvelope.includedArtifactIds).toEqual([
      ".kiro/specs/demo/slices/03-envelope/contract.md",
      ".kiro/specs/demo/slices/03-envelope/acceptance-manifest.json",
      "base-gate-catalog",
      "migration-reservation",
    ]);
  });

  it("B-05 prepares evaluator evidence for completion-time journaling", () => {
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

    expect(prompt.prompt).toContain("# Proposed contract");
    expect(events).toHaveLength(0);
    expect(prompt.contextEnvelope).toMatchObject({
      role: "evaluator-contract",
    });
    expect(prompt.contextEnvelope.includedArtifactClasses).toEqual([
      "proposed-contract",
      "acceptance-manifest",
      "base-gate-catalog",
      "explorer-evidence-map",
    ]);
    expect(prompt.contextEnvelope.includedArtifactIds).toEqual([
      ".kiro/specs/demo/slices/03-envelope/contract.md",
      ".kiro/specs/demo/slices/03-envelope/acceptance-manifest.json",
      "base-gate-catalog",
      ".kiro/specs/demo/slices/03-envelope/context.md",
    ]);
  });
});

import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import type { AcceptanceManifestV2 } from "./acceptance-manifest.js";
import {
  assembleContractEvaluatorPrompt,
  assembleNegotiationPlannerPrompt,
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
          // src/ exists but carries no docs/adr or ARCHITECTURE.md, so the
          // revision envelope exercises the no-entry fallback here.
          repoRoot: fileURLToPath(new URL(".", import.meta.url)),
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

  it("ADR 0061 concatenates a gate objection and a repair instruction, objection first", () => {
    const { context } = captureEvents();
    const revisionInput = {
      ghIssue: "95",
      specsDir: ".kiro/specs/demo",
      sliceDir: ".kiro/specs/demo/slices/03-envelope",
      repoRoot: fileURLToPath(new URL(".", import.meta.url)),
      useInitialEnvelope: false,
      sliceBody: "SLICE-REQUEST",
      explorerContext: "context",
      currentContract: "contract",
      currentAcceptanceManifest: JSON.stringify(acceptanceManifest),
      findings: [],
      contractResponseInstructions: "Do not write a response.",
      baseGateCatalog: "- tests: pnpm test:fast",
      migrationReservation: "none",
    };
    const objection = "migration prefix 0042 already exists on the feature branch";
    const repair = "contract-response.json must declare round 2";

    // Both at once. The round that answers a gate objection is exactly the
    // round whose response artifact can be refused, so one must not silently
    // replace the other.
    const both = assembleNegotiationPlannerPrompt({
      context,
      ...revisionInput,
      pendingObjection: objection,
      repairInstruction: repair,
    });
    expect(both.prompt).toContain(objection);
    expect(both.prompt).toContain(repair);
    expect(both.prompt.indexOf(objection)).toBeLessThan(
      both.prompt.indexOf(repair),
    );

    // ...and each alone still renders, without the other's framing.
    const objectionOnly = assembleNegotiationPlannerPrompt({
      context,
      ...revisionInput,
      pendingObjection: objection,
      repairInstruction: null,
    });
    expect(objectionOnly.prompt).toContain(objection);
    expect(objectionOnly.prompt).not.toContain(repair);

    const repairOnly = assembleNegotiationPlannerPrompt({
      context,
      ...revisionInput,
      pendingObjection: null,
      repairInstruction: repair,
    });
    expect(repairOnly.prompt).toContain(repair);
    expect(repairOnly.prompt).not.toContain(objection);
    expect(repairOnly.prompt).not.toContain("REJECTED the previous contract");

    // Neither: the control-plane slot renders its own absence rather than an
    // empty block that reads as a fact.
    const neither = assembleNegotiationPlannerPrompt({
      context,
      ...revisionInput,
      pendingObjection: null,
      repairInstruction: null,
    });
    expect(neither.prompt).not.toContain(objection);
    expect(neither.prompt).not.toContain(repair);
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
      "explorer-behavior-preservation",
    ]);
    expect(prompt.contextEnvelope.includedArtifactIds).toEqual([
      ".kiro/specs/demo/slices/03-envelope/contract.md",
      ".kiro/specs/demo/slices/03-envelope/acceptance-manifest.json",
      "base-gate-catalog",
      ".kiro/specs/demo/slices/03-envelope/context.md",
    ]);
  });
});

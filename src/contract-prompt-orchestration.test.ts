import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import type { AcceptanceManifestV2 } from "./acceptance-manifest.js";
import {
  assembleContractEvaluatorPrompt,
  assembleFocusedScopePlannerPrompt,
  assembleNegotiationPlannerPrompt,
  assemblePlannerPrompt,
} from "./contract-prompt-orchestration.js";
import type { ContractReviewFinding } from "./contract-review.js";
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

  // #257: a focused revision the contract evaluator rejected retries within
  // its round, and the retry must be able to act on the rejection. Asserted
  // on the assembled prompt — the defect was invisible in the assembler's
  // arguments, which named a `findings` field that was hard-coded empty.
  it("#257 routes a rejecting revision's findings into the retry's focused prompt", () => {
    const { context } = captureEvents();
    const focusedInput = {
      context,
      repoRoot: fileURLToPath(new URL(".", import.meta.url)),
      currentContract: "contract",
      currentAcceptanceManifest: JSON.stringify(acceptanceManifest),
      scopeEvidence: JSON.stringify({
        findingIds: ["F-40"],
        paths: ["src/extra.ts"],
        reason: "the declared module delegates to an undeclared one",
      }),
      contractResponseFilename: "contract-response.json",
      migrationReservation: "none",
      baseGateCatalog: "- tests: pnpm test:fast",
    };
    const rejection: ContractReviewFinding = {
      id: "F-REVISION",
      severity: "BLOCKING",
      behaviorIds: ["B-01"],
      evidence: '"the revised file scope"',
      expected: "every line of src/extra.ts enumerated",
      observed: "the revision enumerated one line too few",
      clearCondition: "the planner enumerates every line",
      state: "OPEN",
      revisionCitation: null,
    };

    const first = assembleFocusedScopePlannerPrompt(focusedInput);
    const retry = assembleFocusedScopePlannerPrompt({
      ...focusedInput,
      rejectionFindings: [rejection],
    });

    // The first attempt has nothing to carry, and must not imply it does.
    expect(first.prompt).not.toContain(rejection.id);
    expect(first.prompt).not.toContain("was\nREJECTED");
    expect(first.contextEnvelope.includedArtifactClasses).not.toContain(
      "open-contract-findings",
    );

    // The retry carries the rejection through the same channel a normal
    // negotiation round uses, and says what it is.
    expect(retry.prompt).toContain(rejection.id);
    expect(retry.prompt).toContain(rejection.clearCondition);
    expect(retry.prompt).toContain(rejection.observed);
    expect(retry.prompt).toMatch(/previous attempt at this same focused/);
    expect(retry.contextEnvelope.includedArtifactClasses).toContain(
      "open-contract-findings",
    );
    // The retry's prompt differs from the first attempt's — the property
    // whose absence made #96's revision unable to converge.
    expect(retry.prompt).not.toBe(first.prompt);
    // ...while still asking for the same request the escalation named.
    expect(retry.prompt).toContain("src/extra.ts");
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

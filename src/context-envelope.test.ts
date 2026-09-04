import { describe, expect, it } from "vitest";
import type { AgentProvider } from "./agent-provider.js";
import type { AcceptanceManifestV2 } from "./acceptance-manifest.js";
import type { RunEventPayload } from "./run-events.js";
import {
  CONTRACT_EVALUATOR_CONTEXT_MANIFEST,
  EXPLORER_CONTEXT_MANIFEST,
  GENERATOR_CONTEXT_MANIFEST,
  PLANNER_CONTEXT_MANIFEST,
  assembleContractEvaluatorInitialEnvelope,
  assembleContractEvaluatorRevisionEnvelope,
  assembleContextEnvelope,
  assembleExplorerEnvelope,
  assembleGeneratorEnvelope,
  assemblePlannerInitialEnvelope,
  assemblePlannerRevisionEnvelope,
  buildExplorerRepositoryContext,
  projectGeneratorContractView,
  projectGeneratorPatternsAndHarness,
  validateExplorerEvidenceMap,
} from "./context-envelope.js";
import type { ContractReviewFinding } from "./contract-review.js";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const acceptanceManifest: AcceptanceManifestV2 = {
  version: 2,
  fileScope: {
    kind: "paths",
    paths: ["src/feature.ts", "src/feature.test.ts"],
  },
  migrationCount: 0,
  behaviors: [
    {
      id: "B-01",
      source: "GH #83 AC1",
      given: "a locked slice",
      when: "generation starts",
      then: "focused context is assembled",
      observableResult: "the prompt is focused",
      preservation: false,
      gateIds: ["tests"],
    },
  ],
};

const openFinding: ContractReviewFinding = {
  id: "F-OPEN",
  severity: "BLOCKING",
  behaviorIds: ["B-01"],
  evidence: '"old text"',
  expected: "a falsifiable scenario",
  observed: "the scenario is vague",
  clearCondition: "B-01 names the command and failure signal",
  state: "OPEN",
  revisionCitation: null,
};

const resolvedFinding: ContractReviewFinding = {
  ...openFinding,
  id: "F-RESOLVED",
  clearCondition: "RESOLVED-CLEAR-CONDITION",
  state: "RESOLVED",
};

describe("explorer context envelope", () => {
  it("B-01 accepts only the ordered evidence-map sections and requires Unknowns", () => {
    const minimal = [
      "## Files and current behavior",
      "",
      "- files",
      "",
      "## Patterns and test harness",
      "",
      "- tests",
      "",
      "## Unknowns",
      "",
    ].join("\n");
    const withData = minimal.replace(
      "## Unknowns",
      "## Data and integration\n\n- data\n\n## Unknowns",
    );

    expect(() => validateExplorerEvidenceMap(minimal)).not.toThrow();
    expect(() => validateExplorerEvidenceMap(withData)).not.toThrow();
    for (const malformed of [
      minimal.replace("## Unknowns\n", ""),
      minimal.replace(
        "## Patterns and test harness",
        "## Unknowns\n\n## Patterns and test harness",
      ),
      minimal.replace(
        "## Unknowns",
        "## Extra\n\n- no\n\n## Unknowns",
      ),
      minimal.concat("\n## Unknowns\n"),
    ]) {
      expect(() => validateExplorerEvidenceMap(malformed)).toThrow(
        /requires exactly these level-two sections in order/,
      );
    }
  });

  it("B-02 projects only the complete Patterns and test harness section byte-for-byte", () => {
    const context = [
      "## Files and current behavior\r\n",
      "\r\n",
      "FILES-MARKER\r\n",
      "\r\n",
      "## Patterns and test harness\r\n",
      "\r\n",
      "PATTERNS-MARKER\r\n",
      "\r\n",
      "### Nested harness\r\n",
      "NESTED-MARKER\r\n",
      "\r\n",
      "## Data and integration\r\n",
      "\r\n",
      "DATA-MARKER\r\n",
      "\r\n",
      "## Unknowns\r\n",
      "\r\n",
      "UNKNOWNS-MARKER\r\n",
    ].join("");
    const expected = [
      "## Patterns and test harness\r\n",
      "\r\n",
      "PATTERNS-MARKER\r\n",
      "\r\n",
      "### Nested harness\r\n",
      "NESTED-MARKER\r\n",
      "\r\n",
    ].join("");

    validateExplorerEvidenceMap(context);
    expect(Buffer.from(projectGeneratorPatternsAndHarness(context))).toEqual(
      Buffer.from(expected),
    );
  });

  it("B-01 B-02 QA-01 preserves heading-shaped lines inside fenced samples", () => {
    const context = [
      "## Files and current behavior\n",
      "\n",
      "FILES-MARKER\n",
      "\n",
      "## Patterns and test harness\n",
      "\n",
      "~~~md\n",
      "## Example heading inside a fenced sample\n",
      "\n",
      "SAMPLE-MARKER\n",
      "~~~\n",
      "\n",
      "PATTERNS-MARKER\n",
      "\n",
      "## Unknowns\n",
      "\n",
      "UNKNOWNS-MARKER\n",
    ].join("");
    const expected = [
      "## Patterns and test harness\n",
      "\n",
      "~~~md\n",
      "## Example heading inside a fenced sample\n",
      "\n",
      "SAMPLE-MARKER\n",
      "~~~\n",
      "\n",
      "PATTERNS-MARKER\n",
      "\n",
    ].join("");
    const projected = projectGeneratorPatternsAndHarness(context);

    expect(() => validateExplorerEvidenceMap(context)).not.toThrow();
    expect(Buffer.from(projected)).toEqual(Buffer.from(expected));
    expect(projected).not.toContain("FILES-MARKER");
    expect(projected).not.toContain("UNKNOWNS-MARKER");
  });

  it("B-03 indexes every ADR file including both 0029 entries and includes architecture without ADR bodies", () => {
    const repoRoot = fileURLToPath(new URL("..", import.meta.url));
    const repositoryContext = buildExplorerRepositoryContext(repoRoot);

    expect(repositoryContext.content).toContain(
      "0029 — Guardian prompts use Bash for file writes",
    );
    expect(repositoryContext.content).toContain(
      "0029 — Recoverable merge deferral: the MERGE-PENDING phase",
    );
    expect(repositoryContext.content).toContain("## ARCHITECTURE.md");
    expect(repositoryContext.content).toContain(
      "AFK is a standalone CLI that orchestrates multi-agent pipelines",
    );
    expect(repositoryContext.content).not.toContain(
      "PRD 031 in `rumo-app` produced two consecutive guardian-review runs",
    );
    expect(repositoryContext.content).not.toContain(
      "In the PRD 076 babysit session a slice negotiated its contract",
    );
    const expectedAdrPaths = readdirSync(join(repoRoot, "docs", "adr"))
      .filter((name) => name.endsWith(".md"))
      .map((name) => `docs/adr/${name}`)
      .sort();
    expect(
      repositoryContext.includedArtifactIds
        .filter((path) => path.startsWith("docs/adr/"))
        .sort(),
    ).toEqual(expectedAdrPaths);
  });

  it("B-04 QA-01 assembles the ordered focused prompt and exact evidence", () => {
    const repoRoot = fileURLToPath(new URL("..", import.meta.url));
    const repositoryContext = buildExplorerRepositoryContext(repoRoot);
    const result = assembleExplorerEnvelope({
      repoRoot,
      ghIssue: "90",
      title: "Explorer context",
      sliceDir: ".kiro/specs/demo/slices/02-explorer",
      relevantFiles: "RELEVANT-FILES-MARKER",
      sliceBody: "SLICE-BODY-MARKER",
    });

    expect(EXPLORER_CONTEXT_MANIFEST).toMatchObject({
      version: 1,
      role: "explorer",
      inlineSizeBudgetBytes: 65_536,
    });
    const orderedMarkers = [
      "# Objective",
      "# Write boundary",
      "# Stop condition",
      "# Citation rule",
      "# Four-section task",
      "# Slice inputs",
      "RELEVANT-FILES-MARKER",
      "SLICE-BODY-MARKER",
      "# Repository context",
      "# Budget",
    ];
    let previous = -1;
    for (const marker of orderedMarkers) {
      const index = result.prompt.indexOf(marker);
      expect(index, marker).toBeGreaterThan(previous);
      previous = index;
    }
    expect(result.prompt).not.toContain("senior engineer");
    expect(result.prompt).not.toMatch(/\bFACT\b|\bINFERENCE\b|\bUNKNOWN\b/);
    expect(result.prompt).not.toContain("Label every statement");
    expect(result.evidence.includedArtifactClasses).toEqual([
      "slice-request",
      ...repositoryContext.includedArtifactIds.map((artifactId) =>
        artifactId.startsWith("docs/adr/")
          ? "repository-adr"
          : "repository-architecture",
      ),
    ]);
    expect(result.evidence.includedArtifactIds).toEqual([
      "issue:90",
      ...repositoryContext.includedArtifactIds,
    ]);
  });

  it("B-06 fails closed with actual and allowed explorer byte counts", () => {
    const repoRoot = fileURLToPath(new URL("..", import.meta.url));
    const input = {
      repoRoot,
      ghIssue: "90",
      title: "Explorer context",
      sliceDir: ".kiro/specs/demo/slices/02-explorer",
      relevantFiles: "RELEVANT-FILES-MARKER",
      sliceBody: "SLICE-BODY-MARKER",
    };
    const requiredBytes = assembleExplorerEnvelope(input).evidence
      .assembledByteSize;

    expect(() =>
      assembleExplorerEnvelope({
        ...input,
        inlineSizeBudgetBytes: requiredBytes - 1,
      }),
    ).toThrow(
      `Explorer prompt exceeds inline-size budget: actual ${requiredBytes} bytes, allowed ${requiredBytes - 1} bytes`,
    );
  });
});

describe("planner and contract-evaluator context envelopes", () => {
  const explorerContext = [
    "## Files and current behavior",
    "",
    "FILES-EVIDENCE",
    "",
    "## Patterns and test harness",
    "",
    "PATTERNS-EVIDENCE",
    "",
    "## Data and integration",
    "",
    "DATA-EVIDENCE",
    "",
    "## Unknowns",
    "",
    "UNKNOWNS-EVIDENCE",
  ].join("\n");

  it("B-01 QA-01 assembles planner initial evidence in exact prompt order", () => {
    const repoRoot = fileURLToPath(new URL("..", import.meta.url));
    const repositoryContext = buildExplorerRepositoryContext(repoRoot);
    const result = assemblePlannerInitialEnvelope({
      repoRoot,
      ghIssue: "95",
      specsDir: ".kiro/specs/demo",
      sliceDir: ".kiro/specs/demo/slices/03-envelope",
      round: 1,
      sliceBody: "SLICE-REQUEST",
      explorerContext,
      baseGateCatalog: "- tests: pnpm test:fast",
      migrationReservation: "No migration reservation is active.",
    });

    expect(PLANNER_CONTEXT_MANIFEST).toMatchObject({
      version: 1,
      role: "planner",
      inlineSizeBudgetBytes: 65_536,
    });
    const markers = [
      "# Objective",
      "# Write boundary",
      "# Stop condition",
      "# Slice request",
      "SLICE-REQUEST",
      "# Explorer evidence map",
      "FILES-EVIDENCE",
      "PATTERNS-EVIDENCE",
      "DATA-EVIDENCE",
      "UNKNOWNS-EVIDENCE",
      "# Executable gate catalog",
      "- tests: pnpm test:fast",
      "# Migration reservation",
      "# Repository context",
      "## ADR index",
      "## ARCHITECTURE.md",
      "# Required output contract",
      "Rewrite `.kiro/specs/demo/slices/03-envelope/contract.md`",
      "Rewrite `.kiro/specs/demo/slices/03-envelope/acceptance-manifest.json`",
    ];
    let previous = -1;
    for (const marker of markers) {
      const index = result.prompt.indexOf(marker);
      expect(index, marker).toBeGreaterThan(previous);
      previous = index;
    }
    expect(result.prompt).toContain(
      "Copy every ADR citation the contract actually relies on",
    );
    expect(result.prompt).not.toContain("grep for `docs/adr/`");
    expect(result.prompt).not.toContain("sibling handoffs");
    expect(result.prompt).not.toContain(
      "PRD 031 in `rumo-app` produced two consecutive guardian-review runs",
    );
    expect(result.evidence).toMatchObject({
      role: "planner",
      contextManifestVersion: 1,
    });
    expect(result.evidence.includedArtifactClasses).toEqual([
      "slice-request",
      "explorer-evidence-map",
      "base-gate-catalog",
      "migration-reservation",
      ...repositoryContext.includedArtifactIds.map((artifactId) =>
        artifactId.startsWith("docs/adr/")
          ? "repository-adr"
          : "repository-architecture",
      ),
    ]);
    expect(result.evidence.includedArtifactIds).toEqual([
      "slice-request",
      ".kiro/specs/demo/slices/03-envelope/context.md",
      "base-gate-catalog",
      "migration-reservation",
      ...repositoryContext.includedArtifactIds,
    ]);
  });

  it("B-02 P-02 QA-01 QA-02 projects planner revision evidence in exact prompt order without resolved history", () => {
    const result = assemblePlannerRevisionEnvelope({
      ghIssue: "95",
      specsDir: ".kiro/specs/demo",
      sliceDir: ".kiro/specs/demo/slices/03-envelope",
      round: 2,
      currentContract: "CURRENT-CONTRACT",
      currentAcceptanceManifest: '{"version":2}',
      findings: [openFinding, resolvedFinding],
      resolvedFindings: [resolvedFinding],
      controlSituation: "MECHANICAL-OBJECTION",
      contractResponseInstructions: "Write the routed response.",
      baseGateCatalog: "- tests: pnpm test:fast",
      migrationReservation: "No migration reservation is active.",
    });
    const findingsBlock = result.prompt
      .split("# Routed OPEN findings")[1]!
      .split("# Control-plane situation")[0]!;
    const occurrences = (text: string, marker: string) =>
      text.split(marker).length - 1;

    expect(occurrences(findingsBlock, "F-OPEN")).toBe(1);
    expect(
      occurrences(
        findingsBlock,
        "B-01 names the command and failure signal",
      ),
    ).toBe(1);
    expect(findingsBlock).not.toContain("F-RESOLVED");
    expect(findingsBlock).not.toContain("RESOLVED-CLEAR-CONDITION");
    expect(result.prompt).not.toContain("F-RESOLVED");
    expect(result.prompt).not.toContain("RESOLVED-CLEAR-CONDITION");
    expect(
      PLANNER_CONTEXT_MANIFEST.acceptedInputArtifactClasses,
    ).not.toContain("relevant-resolved-contract-findings");
    expect(PLANNER_CONTEXT_MANIFEST.inputOrder.revision).toEqual([
      "current-contract-pair",
      "open-contract-findings",
      "control-plane-situation",
      "base-gate-catalog",
      "migration-reservation",
    ]);
    expect(PLANNER_CONTEXT_MANIFEST.omittedArtifactClasses).toContain(
      "resolved-findings",
    );
    expect(result.prompt).toContain(
      "# Control-plane situation\n\nMECHANICAL-OBJECTION",
    );
    expect(result.prompt).toContain("`CONTESTED`");
    expect(result.prompt).toContain(
      "Revise only sections and manifest behavior entries affected",
    );
    expect(result.evidence.includedArtifactClasses).toEqual([
      "current-contract-pair",
      "current-contract-pair",
      "open-contract-findings",
      "control-plane-situation",
      "base-gate-catalog",
      "migration-reservation",
    ]);
    expect(result.evidence.includedArtifactIds).toEqual([
      ".kiro/specs/demo/slices/03-envelope/contract.md",
      ".kiro/specs/demo/slices/03-envelope/acceptance-manifest.json",
      "contract-review:open-findings",
      "control-plane-situation",
      "base-gate-catalog",
      "migration-reservation",
    ]);
  });

  it("B-03 QA-01 records exact initial evaluator classes in prompt order", () => {
    const result = assembleContractEvaluatorInitialEnvelope({
      sliceDir: ".kiro/specs/demo/slices/03-envelope",
      round: 1,
      contractReviewFile: "contract-review.json",
      proposedContract: "PROPOSED-CONTRACT",
      acceptanceManifest,
      baseGateCatalog: "- tests: pnpm test:fast",
      explorerContext,
    });

    expect(CONTRACT_EVALUATOR_CONTEXT_MANIFEST).toMatchObject({
      version: 1,
      role: "evaluator-contract",
    });
    expect(
      CONTRACT_EVALUATOR_CONTEXT_MANIFEST.acceptedInputArtifactClasses,
    ).not.toContain("proposed-contract-pair");
    const markers = [
      "# Proposed contract",
      "PROPOSED-CONTRACT",
      "# Acceptance manifest",
      '"id": "B-01"',
      "# Executable gate catalog",
      "- tests: pnpm test:fast",
      "# Explorer evidence map",
      "FILES-EVIDENCE",
      "# Judgment boundary",
      "Gate aptness",
      "Scenario honesty",
      "Evidence-backed scope",
      "Blocking UNKNOWNs",
      "Single-session feasibility",
      "Explicit non-goals",
      "# Canonical review artifacts",
    ];
    let previous = -1;
    for (const marker of markers) {
      const index = result.prompt.indexOf(marker);
      expect(index, marker).toBeGreaterThan(previous);
      previous = index;
    }
    expect(result.prompt).not.toContain("generator output");
    expect(result.prompt).not.toContain("feedback-r0.md");
    expect(result.evidence.includedArtifactClasses).toEqual([
      "proposed-contract",
      "acceptance-manifest",
      "base-gate-catalog",
      "explorer-evidence-map",
    ]);
    expect(result.evidence.includedArtifactIds).toEqual([
      ".kiro/specs/demo/slices/03-envelope/contract.md",
      ".kiro/specs/demo/slices/03-envelope/acceptance-manifest.json",
      "base-gate-catalog",
      ".kiro/specs/demo/slices/03-envelope/context.md",
    ]);
  });

  it("B-04 QA-01 records exact evaluator revision classes in prompt order", () => {
    const result = assembleContractEvaluatorRevisionEnvelope({
      sliceDir: ".kiro/specs/demo/slices/03-envelope",
      round: 2,
      contractReviewFile: "contract-review.json",
      proposedContract: "REVISED-CONTRACT",
      acceptanceManifest,
      baseGateCatalog: "- tests: pnpm test:fast",
      explorerContext,
      previousFindings: [openFinding, resolvedFinding],
      plannerResponse: {
        version: 1,
        round: 2,
        responses: [
          {
            findingId: "F-OPEN",
            position: "CONDITION_MET",
            evidence: "the command is now named",
          },
        ],
      },
      revisions: {
        "contract.md": {
          before: "old contract",
          after: "REVISED-CONTRACT",
        },
        "acceptance-manifest.json": {
          before: '{"version":2,"old":true}',
          after: JSON.stringify(acceptanceManifest),
        },
      },
      controlSituation: "REVISION-CONTROL-SITUATION",
    });
    const findingsBlock = result.prompt
      .split("# Prior OPEN findings")[1]!
      .split("# Planner response")[0]!;

    expect(findingsBlock.match(/F-OPEN/g)).toHaveLength(1);
    expect(findingsBlock).not.toContain("F-RESOLVED");
    expect(result.prompt).toMatch(
      /independently judge whether its clear-condition is\s+met/,
    );
    expect(result.prompt).toContain(
      '"revisionCitation": {\n' +
        '  "artifact": "contract.md",\n' +
        '  "before": "exact text from the prior artifact",\n' +
        '  "after": "exact text from the revised artifact"\n' +
        "}",
    );
    expect(result.prompt).toContain(
      "`artifact` must be exactly `contract.md` or `acceptance-manifest.json`",
    );
    expect(result.prompt).toContain('"before": "old contract"');
    expect(result.prompt).not.toContain("RESOLVED-CLEAR-CONDITION");
    expect(result.evidence.includedArtifactClasses).toEqual([
      "revised-contract",
      "revised-acceptance-manifest",
      "prior-open-contract-findings",
      "planner-response",
      "contract-revision-evidence",
      "control-plane-situation",
      "base-gate-catalog",
      "explorer-evidence-map",
    ]);
    expect(result.evidence.includedArtifactIds).toEqual([
      ".kiro/specs/demo/slices/03-envelope/contract.md",
      ".kiro/specs/demo/slices/03-envelope/acceptance-manifest.json",
      "contract-review:prior-open-findings",
      ".kiro/specs/demo/slices/03-envelope/contract-response.json",
      "contract-revision-evidence",
      "control-plane-situation",
      "base-gate-catalog",
      ".kiro/specs/demo/slices/03-envelope/context.md",
    ]);
  });

  it("P-02 uses distinct fresh templates and excludes undeclared context", () => {
    const plannerInitial = assemblePlannerInitialEnvelope({
      repoRoot: fileURLToPath(new URL("..", import.meta.url)),
      ghIssue: "95",
      specsDir: "specs",
      sliceDir: "slice",
      round: 1,
      sliceBody: "request",
      explorerContext,
      baseGateCatalog: "- tests: pnpm test",
      migrationReservation: "none",
    }).prompt;
    const plannerRevision = assemblePlannerRevisionEnvelope({
      ghIssue: "95",
      specsDir: "specs",
      sliceDir: "slice",
      round: 2,
      currentContract: "contract",
      currentAcceptanceManifest: '{"version":2}',
      findings: [],
      contractResponseInstructions: "none",
      baseGateCatalog: "- tests: pnpm test",
      migrationReservation: "none",
    }).prompt;
    const evaluatorInitial = assembleContractEvaluatorInitialEnvelope({
      sliceDir: "slice",
      round: 1,
      contractReviewFile: "contract-review.json",
      proposedContract: "contract",
      acceptanceManifest,
      baseGateCatalog: "- tests: pnpm test",
      explorerContext,
    }).prompt;
    const evaluatorRevision = assembleContractEvaluatorRevisionEnvelope({
      sliceDir: "slice",
      round: 2,
      contractReviewFile: "contract-review.json",
      proposedContract: "contract",
      acceptanceManifest,
      baseGateCatalog: "- tests: pnpm test",
      explorerContext,
      previousFindings: [],
      plannerResponse: null,
      revisions: {
        "contract.md": { before: "old", after: "new" },
        "acceptance-manifest.json": { before: "old", after: "new" },
      },
    }).prompt;

    expect(plannerInitial).not.toBe(plannerRevision);
    expect(evaluatorInitial).not.toBe(evaluatorRevision);
    expect(plannerRevision).toContain("# Routed OPEN findings");
    expect(evaluatorRevision).toContain("# Prior OPEN findings");
    for (const prompt of [
      plannerInitial,
      plannerRevision,
      evaluatorInitial,
      evaluatorRevision,
    ]) {
      expect(prompt).not.toContain("PRIOR-CONVERSATION-MARKER");
      expect(prompt).not.toContain("sibling handoffs");
      expect(prompt).not.toContain("grep for `docs/adr/`");
      expect(prompt).not.toContain("prose companion is");
    }
  });

  it("B-03 is deterministic, fail-closed, and exposes role-attributed evidence", () => {
    const plannerInput = {
      ghIssue: "95",
      specsDir: "specs",
      sliceDir: "slice",
      round: 2,
      currentContract: "contract",
      currentAcceptanceManifest: '{"version":2}',
      findings: [openFinding, resolvedFinding],
      contractResponseInstructions: "write response",
      baseGateCatalog: "- tests: pnpm test",
      migrationReservation: "none",
    };
    const evaluatorInput = {
      sliceDir: "slice",
      round: 1,
      contractReviewFile: "contract-review.json",
      proposedContract: "contract",
      acceptanceManifest,
      baseGateCatalog: "- tests: pnpm test",
      explorerContext,
    };
    const plannerFirst = assemblePlannerRevisionEnvelope(plannerInput);
    const plannerSecond = assemblePlannerRevisionEnvelope(plannerInput);
    const evaluatorFirst =
      assembleContractEvaluatorInitialEnvelope(evaluatorInput);
    const evaluatorSecond =
      assembleContractEvaluatorInitialEnvelope(evaluatorInput);

    expect(Buffer.from(plannerSecond.prompt)).toEqual(
      Buffer.from(plannerFirst.prompt),
    );
    expect(plannerSecond.evidence).toEqual(plannerFirst.evidence);
    expect(Buffer.from(evaluatorSecond.prompt)).toEqual(
      Buffer.from(evaluatorFirst.prompt),
    );
    expect(evaluatorSecond.evidence).toEqual(evaluatorFirst.evidence);
    expect(plannerFirst.prompt).not.toContain("\r");
    expect(evaluatorFirst.prompt).not.toContain("\r");
    expect(plannerFirst.evidence.role).toBe("planner");
    expect(evaluatorFirst.evidence.role).toBe("evaluator-contract");

    const plannerAllowed = plannerFirst.evidence.assembledByteSize - 1;
    expect(() =>
      assemblePlannerRevisionEnvelope({
        ...plannerInput,
        inlineSizeBudgetBytes: plannerAllowed,
      }),
    ).toThrow(
      `Planner prompt exceeds inline-size budget: actual ${plannerFirst.evidence.assembledByteSize} bytes, allowed ${plannerAllowed} bytes`,
    );
    const evaluatorAllowed = evaluatorFirst.evidence.assembledByteSize - 1;
    expect(() =>
      assembleContractEvaluatorInitialEnvelope({
        ...evaluatorInput,
        inlineSizeBudgetBytes: evaluatorAllowed,
      }),
    ).toThrow(
      `Contract evaluator prompt exceeds inline-size budget: actual ${evaluatorFirst.evidence.assembledByteSize} bytes, allowed ${evaluatorAllowed} bytes`,
    );

    const events = [
      {
        type: "prompt-assembly",
        ghIssue: "95",
        sliceNumber: "03",
        round: 2,
        ...plannerFirst.evidence,
      },
      {
        type: "prompt-assembly",
        ghIssue: "95",
        sliceNumber: "03",
        round: 1,
        ...evaluatorFirst.evidence,
      },
    ] satisfies RunEventPayload[];
    expect(events.map(({ role }) => role)).toEqual([
      "planner",
      "evaluator-contract",
    ]);
  });

  it("B-04 rejects an undeclared context class as CONFIGURATION before dispatch", () => {
    expect(() =>
      assembleContextEnvelope({
        prompt: "required prompt",
        manifest: PLANNER_CONTEXT_MANIFEST,
        includedArtifacts: [
          {
            artifactClass: "other-role-conversation",
            artifactId: "conversation:generator",
          },
        ],
      }),
    ).toThrow(
      'CONFIGURATION: planner context class "other-role-conversation" is not declared by manifest version 1',
    );
  });

  it("P-01 fails closed one byte over budget without truncating required content", () => {
    const prompt = "required-content";
    expect(() =>
      assembleContextEnvelope({
        prompt,
        manifest: PLANNER_CONTEXT_MANIFEST,
        includedArtifacts: [
          { artifactClass: "slice-request", artifactId: "slice-request" },
        ],
        inlineSizeBudgetBytes: Buffer.byteLength(prompt) - 1,
        roleLabel: "Planner",
      }),
    ).toThrow(
      `actual ${Buffer.byteLength(prompt)} bytes, allowed ${Buffer.byteLength(prompt) - 1} bytes`,
    );
  });
});

describe("generator context envelope", () => {
  it("B-02 QA-03 independently assembles identical logical evidence through Kiro, Claude, and Codex stubs and preserves stable IDs", async () => {
    const input: Parameters<typeof assembleGeneratorEnvelope>[0] = {
      mode: "repair",
      sliceDir: ".kiro/specs/demo/slices/01-focused",
      contractView: "checkpointId: CHECKPOINT-07",
      acceptanceManifest,
      patternsAndHarness: "PATTERNS-AND-HARNESS",
      testCommand: "pnpm test:focused",
      migrationReservation: "NO-MIGRATIONS",
      repairSituation: "Repair FINDING-09 without changing CHECKPOINT-07.",
      failureSet: {
        findings: [
          {
            id: "FINDING-09",
            clearCondition: "Preserve behavior B-01.",
            artifactReferences: ["reviews/FINDING-09.json"],
          },
        ],
        gates: [
          {
            id: "tests",
            evidence: ["gates/tests-attempt-1.json"],
          },
        ],
      },
    };
    type GeneratorResult = ReturnType<typeof assembleGeneratorEnvelope>;
    const captures = new Map<
      string,
      { prompt: string; evidence: GeneratorResult["evidence"] }
    >();
    const independentlyAssembled = new Map<string, GeneratorResult>();
    const adapters: AgentProvider[] = ["kiro", "claude", "codex"].map(
      (name) => ({
        name,
        async invoke(options) {
          const assembled = independentlyAssembled.get(name)!;
          captures.set(name, {
            prompt: options.prompt,
            evidence: assembled.evidence,
          });
          return { exitCode: 0, stdout: "", stats: {} };
        },
      }),
    );

    for (const adapter of adapters) {
      const assembled = assembleGeneratorEnvelope(input);
      independentlyAssembled.set(adapter.name, assembled);
      await adapter.invoke({
        role: "generator",
        prompt: assembled.prompt,
        cwd: "/stub",
      });
    }

    const captured = (name: string) => {
      const capture = captures.get(name);
      if (capture === undefined) {
        throw new Error(`Missing ${name} stub capture`);
      }
      return capture;
    };
    const kiro = captured("kiro");
    const claude = captured("claude");
    const codex = captured("codex");
    expect(Buffer.from(claude.prompt)).toEqual(Buffer.from(kiro.prompt));
    expect(Buffer.from(codex.prompt)).toEqual(Buffer.from(kiro.prompt));
    expect(claude.evidence).toEqual(kiro.evidence);
    expect(codex.evidence).toEqual(kiro.evidence);
    for (const capture of [kiro, claude, codex]) {
      expect(capture.prompt).not.toContain("\r");
      expect(capture.prompt).toContain('"id": "B-01"');
      expect(capture.prompt).toContain('"tests"');
      expect(capture.prompt).toContain("FINDING-09");
      expect(capture.prompt).toContain("CHECKPOINT-07");
    }
  });

  it("B-01 QA-01 assembles exact initial generator evidence in prompt order", () => {
    const result = assembleGeneratorEnvelope({
      mode: "initial",
      sliceDir: ".kiro/specs/demo/slices/01-focused",
      contractView: "LOCKED-CONTRACT-VIEW",
      acceptanceManifest,
      patternsAndHarness: "PATTERNS-AND-HARNESS",
      testCommand: "pnpm test:focused",
      migrationReservation: "NO-MIGRATIONS",
      failureSet: { findings: [], gates: [] },
    });

    expect(GENERATOR_CONTEXT_MANIFEST).toMatchObject({
      version: 1,
      role: "generator",
      inputOrder: {
        initial: [
          "file-scope",
          "migration-reservation",
          "contract-view",
          "acceptance-manifest",
          "verification-command",
          "patterns-and-harness",
          "failure-set",
        ],
        repair: [
          "file-scope",
          "migration-reservation",
          "repair-situation",
          "repair-context",
          "contract-view",
          "acceptance-manifest",
          "verification-command",
          "patterns-and-harness",
          "failure-set",
          "finding-evidence",
          "gate-evidence",
        ],
      },
    });

    const orderedMarkers = [
      "# Objective",
      "# Write boundary",
      "src/feature.ts",
      "`.kiro/specs/demo/slices/01-focused/escalation.md`",
      "LOCKED-CONTRACT-VIEW",
      '"id": "B-01"',
      "PATTERNS-AND-HARNESS",
      "# Current failure set",
    ];
    let previous = -1;
    for (const marker of orderedMarkers) {
      const index = result.prompt.indexOf(marker);
      expect(index, marker).toBeGreaterThan(previous);
      previous = index;
    }

    expect(result.prompt.trimEnd()).toMatch(
      /# Current failure set\r?\n\r?\n\(none\)$/,
    );
    expect(result.prompt).toContain("# What shipped");
    expect(result.prompt).toContain("# Decisions made during implementation");
    expect(result.prompt).toContain("# Gotchas / learnings");
    expect(result.prompt).not.toContain("# Status");
    expect(result.prompt).not.toContain("Reasoning Protocol");
    expect(result.prompt).not.toContain("sibling handoffs");
    expect(result.prompt).not.toContain("grep for `docs/adr/`");
    expect(result.evidence.includedArtifactClasses).toEqual([
      "file-scope",
      "migration-reservation",
      "contract-view",
      "acceptance-manifest",
      "verification-command",
      "patterns-and-harness",
      "failure-set",
    ]);
    expect(result.evidence.includedArtifactIds).toEqual([
      "acceptance-manifest:file-scope",
      "migration-reservation",
      ".kiro/specs/demo/slices/01-focused/contract.md",
      ".kiro/specs/demo/slices/01-focused/acceptance-manifest.json",
      "generator:test-command",
      ".kiro/specs/demo/slices/01-focused/context.md",
      "generator:failure-set",
    ]);
  });

  it("B-02 projects the six complete contract section bodies byte-for-byte", () => {
    const contract = [
      "# Contract\r\n",
      "\r\n",
      "OUTSIDE-MARKER\r\n",
      "\r\n",
      "## Scope lock\r\n",
      "scope body\r\n",
      "\r\n",
      "### In scope\r\n",
      "in-scope body\r\n",
      "\r\n",
      "#### Nested detail\r\n",
      "NESTED-IN-SCOPE-MARKER\r\n",
      "\r\n",
      "#### In scope\r\n",
      "NESTED-RESERVED-IN-SCOPE-MARKER\r\n",
      "\r\n",
      "#### Test plan\r\n",
      "NESTED-RESERVED-TEST-PLAN-MARKER\r\n",
      "\r\n",
      "### Non-goals (explicit out-of-scope)\r\n",
      "non-goals body\r\n",
      "\r\n",
      "### Existing behavior to preserve\r\n",
      "preservation body\r\n",
      "\r\n",
      "### Changes to existing behavior (only if the issue asks for it)\r\n",
      "changes body\r\n",
      "\r\n",
      "## Files expected to change\r\n",
      "EXCLUDED-FILES-MARKER\r\n",
      "\r\n",
      "## New patterns / deps / schema (if any)\r\n",
      "patterns body\r\n",
      "\r\n",
      "## Test plan\r\n",
      "EXCLUDED-TEST-MARKER\r\n",
    ].join("");

    expect(projectGeneratorContractView(contract)).toBe(
      [
        "\r\nscope body\r\n\r\n",
        "\r\nin-scope body\r\n\r\n#### Nested detail\r\nNESTED-IN-SCOPE-MARKER\r\n\r\n#### In scope\r\nNESTED-RESERVED-IN-SCOPE-MARKER\r\n\r\n#### Test plan\r\nNESTED-RESERVED-TEST-PLAN-MARKER\r\n\r\n",
        "\r\nnon-goals body\r\n\r\n",
        "\r\npreservation body\r\n\r\n",
        "\r\nchanges body\r\n\r\n",
        "\r\npatterns body\r\n\r\n",
      ].join(""),
    );
  });

  it("B-03 QA-01 records exact repair generator evidence in prompt order", () => {
    const input = {
      mode: "repair" as const,
      sliceDir: ".kiro/specs/demo/slices/01-focused",
      contractView: "LOCKED-CONTRACT-VIEW",
      acceptanceManifest,
      patternsAndHarness: "PATTERNS-AND-HARNESS",
      testCommand: "pnpm test:focused",
      migrationReservation: "NO-MIGRATIONS",
      repairSituation: "ROUND-TWO-SITUATION",
      additionalArtifactIds: [
        ".kiro/specs/demo/slices/01-focused/stuck.md",
        ".kiro/specs/demo/slices/01-focused/handoff.md",
      ],
      failureSet: {
        findings: [
          {
            id: "QA-OPEN",
            clearCondition: "OPEN-CLEAR-CONDITION",
            artifactReferences: [
              "reviews/qa-open.json",
              "reviews/qa-open.md",
            ],
          },
        ],
        gates: [
          {
            id: "typecheck",
            evidence: [
              "gates/attempt-2.json",
              "gates/typecheck-attempt-2.log",
            ],
          },
        ],
      },
      resolvedFindings: "RESOLVED-FINDING-MARKER",
      passingLogs: "PASSING-LOG-MARKER",
      priorConversation: "PRIOR-CONVERSATION-MARKER",
      otherRoleConversation: "OTHER-ROLE-CONVERSATION-MARKER",
    };

    const result = assembleGeneratorEnvelope(input);
    const templateLineEnding = result.prompt.includes("\r\n") ? "\r\n" : "\n";
    const expectedFailureSet = [
      "- Finding ID: `QA-OPEN`",
      "  Clear condition: OPEN-CLEAR-CONDITION",
      "  Artifact references:",
      "  - `reviews/qa-open.json`",
      "  - `reviews/qa-open.md`",
      "- Gate ID: `typecheck`",
      "  Evidence:",
      "  - `gates/attempt-2.json`",
      "  - `gates/typecheck-attempt-2.log`",
    ].join("\n");

    expect(result.prompt.trimEnd()).toBe(
      result.prompt
        .slice(0, result.prompt.indexOf("# Current failure set"))
        .concat(
          `# Current failure set${templateLineEnding}${templateLineEnding}`,
          expectedFailureSet,
        ),
    );
    expect(result.prompt).toContain("ROUND-TWO-SITUATION");
    expect(result.prompt).toContain("Fix causes, not only listed examples.");
    expect(result.prompt).not.toContain("RESOLVED-FINDING-MARKER");
    expect(result.prompt).not.toContain("PASSING-LOG-MARKER");
    expect(result.prompt).not.toContain("PRIOR-CONVERSATION-MARKER");
    expect(result.prompt).not.toContain("OTHER-ROLE-CONVERSATION-MARKER");
    expect(result.evidence.includedArtifactClasses).toEqual([
      "file-scope",
      "migration-reservation",
      "repair-situation",
      "repair-context",
      "repair-context",
      "contract-view",
      "acceptance-manifest",
      "verification-command",
      "patterns-and-harness",
      "failure-set",
      "finding-evidence",
      "finding-evidence",
      "gate-evidence",
      "gate-evidence",
    ]);
    expect(result.evidence.includedArtifactIds).toEqual([
      "acceptance-manifest:file-scope",
      "migration-reservation",
      "generator:repair-situation",
      ".kiro/specs/demo/slices/01-focused/stuck.md",
      ".kiro/specs/demo/slices/01-focused/handoff.md",
      ".kiro/specs/demo/slices/01-focused/contract.md",
      ".kiro/specs/demo/slices/01-focused/acceptance-manifest.json",
      "generator:test-command",
      ".kiro/specs/demo/slices/01-focused/context.md",
      "generator:failure-set",
      "reviews/qa-open.json",
      "reviews/qa-open.md",
      "gates/attempt-2.json",
      "gates/typecheck-attempt-2.log",
    ]);
  });

  it("B-05 fails closed one byte below the required prompt size", () => {
    const input = {
      mode: "initial" as const,
      sliceDir: ".kiro/specs/demo/slices/01-focused",
      contractView: "LOCKED-CONTRACT-VIEW",
      acceptanceManifest,
      patternsAndHarness: "PATTERNS-AND-HARNESS",
      testCommand: "pnpm test:focused",
      migrationReservation: "NO-MIGRATIONS",
      failureSet: { findings: [], gates: [] },
    };
    const requiredBytes = assembleGeneratorEnvelope(input).evidence
      .assembledByteSize;

    expect(() =>
      assembleGeneratorEnvelope({
        ...input,
        inlineSizeBudgetBytes: requiredBytes - 1,
      }),
    ).toThrow(
      `Generator prompt exceeds inline-size budget: actual ${requiredBytes} bytes, allowed ${requiredBytes - 1} bytes`,
    );
  });

  it("B-06 exposes complete prompt-assembly evidence as a typed event", () => {
    const result = assembleGeneratorEnvelope({
      mode: "initial",
      sliceDir: ".kiro/specs/demo/slices/01-focused",
      contractView: "LOCKED-CONTRACT-VIEW",
      acceptanceManifest,
      patternsAndHarness: "PATTERNS-AND-HARNESS",
      testCommand: "pnpm test:focused",
      migrationReservation: "NO-MIGRATIONS",
      failureSet: { findings: [], gates: [] },
    });
    const event = {
      type: "prompt-assembly",
      ghIssue: "83",
      sliceNumber: "01",
      round: 1,
      ...result.evidence,
    } satisfies RunEventPayload;

    expect(event).toMatchObject(result.evidence);
  });

  it("B-03 produces byte-identical prompts and evidence for identical inputs", () => {
    const input = {
      mode: "repair" as const,
      sliceDir: ".kiro/specs/demo/slices/01-focused",
      contractView: "LOCKED-CONTRACT-VIEW",
      acceptanceManifest,
      patternsAndHarness: "PATTERNS-AND-HARNESS",
      testCommand: "pnpm test:focused",
      migrationReservation: "NO-MIGRATIONS",
      repairSituation: "ROUND-TWO-SITUATION",
      inlineSizeBudgetBytes: 32_768,
      failureSet: {
        findings: [
          {
            id: "QA-OPEN",
            clearCondition: "OPEN-CLEAR-CONDITION",
            artifactReferences: ["reviews/qa-open.json", "reviews/qa-open.md"],
          },
        ],
        gates: [
          {
            id: "typecheck",
            evidence: ["gates/attempt-2.json", "gates/typecheck.log"],
          },
        ],
      },
    };

    const first = assembleGeneratorEnvelope(input);
    const second = assembleGeneratorEnvelope(input);

    expect(Buffer.from(second.prompt)).toEqual(Buffer.from(first.prompt));
    expect(second.evidence).toEqual(first.evidence);
  });

  it("P-03 preserves generator assembly and the legacy full-context fallback", () => {
    const legacyContext =
      "## Patterns in Use\n\nlegacy patterns\n\n## Test Infrastructure\n\nlegacy tests\n";
    expect(projectGeneratorPatternsAndHarness(legacyContext)).toBe(
      legacyContext,
    );

    const result = assembleGeneratorEnvelope({
      mode: "initial",
      sliceDir: ".kiro/specs/demo/slices/01-focused",
      contractView: "LOCKED-CONTRACT-VIEW",
      acceptanceManifest,
      patternsAndHarness: legacyContext,
      testCommand: "pnpm test:focused",
      migrationReservation: "NO-MIGRATIONS",
      failureSet: { findings: [], gates: [] },
    });
    expect(result.prompt).toContain(legacyContext);
    expect(result.evidence.contextManifestVersion).toBe(
      GENERATOR_CONTEXT_MANIFEST.version,
    );
  });
});

import { describe, expect, it } from "vitest";
import type { AgentProvider } from "./agent-provider.js";
import type { AcceptanceManifestV2 } from "./acceptance-manifest.js";
import type { RunEventPayload } from "./run-events.js";
import {
  CANDIDATE_EVALUATOR_CONTEXT_MANIFEST,
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
  projectContractEvaluatorEvidence,
  projectGeneratorContractView,
  projectGeneratorPatternsAndHarness,
  validateContextEnvelopeManifest,
  validateExplorerEvidenceMap,
  type ContextEnvelopeManifest,
} from "./context-envelope.js";
import type { ContractReviewFinding } from "./contract-review.js";
import { PLANNER_ESCALATION_FILENAME } from "./planner-escalation.js";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PROMPTS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "prompts",
);

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

/** Unresolved, not retired: durable lineage still enforces it (#178). */
const contestedFinding: ContractReviewFinding = {
  ...openFinding,
  id: "F-CONTESTED",
  clearCondition: "CONTESTED-CLEAR-CONDITION",
  state: "CONTESTED",
};

/** The repository root: carries docs/adr/*.md and ARCHITECTURE.md. */
const repoRootWithDocs = fileURLToPath(new URL("..", import.meta.url));
/** src/ exists but has neither docs/adr nor ARCHITECTURE.md. */
const repoRootWithoutDocs = fileURLToPath(new URL(".", import.meta.url));

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
    // PRD story 9 / slice #90: every explorer statement must be
    // distinguishable as FACT, INFERENCE, or UNKNOWN (guardian round 2,
    // architect A2 / PM 1).
    expect(result.prompt).toContain("Label every statement");
    expect(result.prompt).toMatch(/`FACT`/);
    expect(result.prompt).toMatch(/`INFERENCE`/);
    expect(result.prompt).toMatch(/`UNKNOWN`/);
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

  it("#178 carries durable open findings into the initial planner envelope", () => {
    const result = assemblePlannerInitialEnvelope({
      repoRoot: repoRootWithoutDocs,
      ghIssue: "95",
      specsDir: ".kiro/specs/demo",
      sliceDir: ".kiro/specs/demo/slices/03-envelope",
      round: 1,
      sliceBody: "SLICE-REQUEST",
      explorerContext,
      carriedFindings: [openFinding, contestedFinding, resolvedFinding],
      baseGateCatalog: "- tests: pnpm test:fast",
      migrationReservation: "No migration reservation is active.",
    });

    const markers = [
      "# Slice request",
      "SLICE-REQUEST",
      "# Carried open findings",
      "F-OPEN",
      "# Explorer evidence map",
    ];
    let previous = -1;
    for (const marker of markers) {
      const index = result.prompt.indexOf(marker);
      expect(index, marker).toBeGreaterThan(previous);
      previous = index;
    }
    // Exactly the set `validateContractReviewAgainstLineage` enforces travels:
    // CONTESTED is unresolved, so dropping it would enforce against a prompt
    // that was never shown it. Resolved findings stay out — the manifest
    // declares them omitted for this role and that holds on the initial path.
    expect(result.prompt).toContain("F-CONTESTED");
    expect(result.prompt).toContain("CONTESTED-CLEAR-CONDITION");
    expect(result.prompt).not.toContain("F-RESOLVED");
    expect(result.prompt).not.toContain("RESOLVED-CLEAR-CONDITION");
    expect(result.evidence.includedArtifactClasses.slice(0, 3)).toEqual([
      "slice-request",
      "open-contract-findings",
      "explorer-evidence-map",
    ]);
    expect(result.evidence.includedArtifactIds[1]).toBe(
      "contract-review:durable-open-findings",
    );

    // A first attempt has no lineage, so the block says so and claims no
    // artifact — the evidence stays an honest record of what was supplied.
    const firstAttempt = assemblePlannerInitialEnvelope({
      repoRoot: repoRootWithoutDocs,
      ghIssue: "95",
      specsDir: ".kiro/specs/demo",
      sliceDir: ".kiro/specs/demo/slices/03-envelope",
      round: 1,
      sliceBody: "SLICE-REQUEST",
      explorerContext,
      baseGateCatalog: "- tests: pnpm test:fast",
      migrationReservation: "No migration reservation is active.",
    });
    expect(firstAttempt.prompt).toContain(
      "(none — this slice has no durable finding lineage)",
    );
    expect(firstAttempt.evidence.includedArtifactClasses).not.toContain(
      "open-contract-findings",
    );
  });

  it("#178 ADR 0061 carries durable lineage and a repair situation into both evaluator envelopes", () => {
    const durableLineage =
      "This is a fresh attempt with durable finding lineage.\n\nDURABLE-F-01";
    const repair =
      "Your contract-review.json was refused. Exact validation error:\n" +
      "contract-review.json findings[2] finding severity must be BLOCKING or ADVISORY";
    const initial = assembleContractEvaluatorInitialEnvelope({
      sliceDir: ".kiro/specs/demo/slices/03-envelope",
      round: 1,
      contractReviewFile: "contract-review.json",
      proposedContract: "PROPOSED-CONTRACT",
      acceptanceManifest,
      baseGateCatalog: "- tests: pnpm test:fast",
      explorerContext,
      durableLineage,
      controlSituation: repair,
    });

    const markers = [
      "# Acceptance manifest",
      "# Durable finding lineage",
      "DURABLE-F-01",
      "# Control-plane situation",
      "severity must be BLOCKING or ADVISORY",
      "# Executable gate catalog",
    ];
    let previous = -1;
    for (const marker of markers) {
      const index = initial.prompt.indexOf(marker);
      expect(index, marker).toBeGreaterThan(previous);
      previous = index;
    }
    expect(initial.evidence.includedArtifactClasses).toEqual([
      "proposed-contract",
      "acceptance-manifest",
      "prior-open-contract-findings",
      "control-plane-situation",
      "base-gate-catalog",
      "explorer-behavior-preservation",
    ]);
    expect(initial.evidence.includedArtifactIds[2]).toBe(
      "contract-review:durable-open-findings",
    );
    // Round 1 of a first attempt carries neither block.
    const bare = assembleContractEvaluatorInitialEnvelope({
      sliceDir: ".kiro/specs/demo/slices/03-envelope",
      round: 1,
      contractReviewFile: "contract-review.json",
      proposedContract: "PROPOSED-CONTRACT",
      acceptanceManifest,
      baseGateCatalog: "- tests: pnpm test:fast",
      explorerContext,
    });
    expect(bare.evidence.includedArtifactClasses).toEqual([
      "proposed-contract",
      "acceptance-manifest",
      "base-gate-catalog",
      "explorer-behavior-preservation",
    ]);

    const revision = assembleContractEvaluatorRevisionEnvelope({
      sliceDir: ".kiro/specs/demo/slices/03-envelope",
      round: 2,
      contractReviewFile: "contract-review.json",
      proposedContract: "REVISED-CONTRACT",
      acceptanceManifest,
      baseGateCatalog: "- tests: pnpm test:fast",
      explorerContext,
      previousFindings: [openFinding],
      plannerResponse: null,
      revisions: {
        "contract.md": { before: "old contract", after: "REVISED-CONTRACT" },
        "acceptance-manifest.json": {
          before: '{"version":2,"old":true}',
          after: JSON.stringify(acceptanceManifest),
        },
      },
      durableLineage,
    });
    expect(revision.prompt.indexOf("# Durable finding lineage")).toBeGreaterThan(
      revision.prompt.indexOf("# Prior OPEN findings"),
    );
    expect(revision.evidence.includedArtifactIds).toEqual([
      ".kiro/specs/demo/slices/03-envelope/contract.md",
      ".kiro/specs/demo/slices/03-envelope/acceptance-manifest.json",
      "contract-review:prior-open-findings",
      "contract-review:durable-open-findings",
      "contract-revision-evidence",
      "base-gate-catalog",
      ".kiro/specs/demo/slices/03-envelope/context.md",
    ]);
  });

  it("B-02 P-02 QA-01 QA-02 projects planner revision evidence in exact prompt order without resolved history", () => {
    const result = assemblePlannerRevisionEnvelope({
      ghIssue: "95",
      specsDir: ".kiro/specs/demo",
      sliceDir: ".kiro/specs/demo/slices/03-envelope",
      round: 2,
      repoRoot: repoRootWithoutDocs,
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
      "repository-context",
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
      "`.kiro/specs/demo/slices/03-envelope/contract.md`",
      "# Acceptance manifest",
      "`.kiro/specs/demo/slices/03-envelope/acceptance-manifest.json`",
      "# Executable gate catalog",
      "- tests: pnpm test:fast",
      "# Explorer behavior and preservation evidence",
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
    expect(result.prompt).not.toContain("PROPOSED-CONTRACT");
    expect(result.prompt).not.toContain('"id": "B-01"');
    expect(result.evidence.includedArtifactClasses).toEqual([
      "proposed-contract",
      "acceptance-manifest",
      "base-gate-catalog",
      "explorer-behavior-preservation",
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
    // #196: the revision block carries the changed regions verbatim, not a
    // JSON copy of both whole artifacts, and the pair itself is named rather
    // than inlined.
    expect(result.prompt).toContain("old contract");
    expect(result.prompt).toContain(
      "- `.kiro/specs/demo/slices/03-envelope/contract.md`",
    );
    expect(result.prompt).not.toContain('"before": "old contract"');
    expect(result.prompt).not.toContain("RESOLVED-CLEAR-CONDITION");
    expect(result.evidence.includedArtifactClasses).toEqual([
      "revised-contract",
      "revised-acceptance-manifest",
      "prior-open-contract-findings",
      "planner-response",
      "contract-revision-evidence",
      "control-plane-situation",
      "base-gate-catalog",
      "explorer-behavior-preservation",
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

  it("PM4-1 derives repository context for the planner revision envelope when docs exist", () => {
    const repositoryContext = buildExplorerRepositoryContext(repoRootWithDocs);
    const result = assemblePlannerRevisionEnvelope({
      ghIssue: "95",
      specsDir: ".kiro/specs/demo",
      sliceDir: ".kiro/specs/demo/slices/03-envelope",
      round: 2,
      repoRoot: repoRootWithDocs,
      currentContract: "CURRENT-CONTRACT",
      currentAcceptanceManifest: '{"version":2}',
      findings: [openFinding],
      contractResponseInstructions: "Write the routed response.",
      baseGateCatalog: "- tests: pnpm test:fast",
      migrationReservation: "No migration reservation is active.",
    });

    // The template renders the block in the manifest's declared revision
    // order: after the migration reservation, before the response
    // instructions.
    const markers = [
      "# Migration reservation",
      "# Repository context",
      "## ADR index",
      "## ARCHITECTURE.md",
      "# Contract response instructions",
    ];
    let previous = -1;
    for (const marker of markers) {
      const index = result.prompt.indexOf(marker);
      expect(index, marker).toBeGreaterThan(previous);
      previous = index;
    }
    expect(repositoryContext.includedArtifactIds.length).toBeGreaterThan(0);
    expect(result.evidence.includedArtifactClasses).toEqual([
      "current-contract-pair",
      "current-contract-pair",
      "open-contract-findings",
      "base-gate-catalog",
      "migration-reservation",
      ...repositoryContext.includedArtifactIds.map((artifactId) =>
        artifactId.startsWith("docs/adr/")
          ? "repository-adr"
          : "repository-architecture",
      ),
    ]);
    expect(result.evidence.includedArtifactIds).toEqual([
      ".kiro/specs/demo/slices/03-envelope/contract.md",
      ".kiro/specs/demo/slices/03-envelope/acceptance-manifest.json",
      "contract-review:open-findings",
      "base-gate-catalog",
      "migration-reservation",
      ...repositoryContext.includedArtifactIds,
    ]);
  });

  it("PM4-1 preserves the no-entry fallback: a repo without docs/adr or ARCHITECTURE.md renders (none available) and omits repository evidence", () => {
    const result = assemblePlannerRevisionEnvelope({
      ghIssue: "95",
      specsDir: ".kiro/specs/demo",
      sliceDir: ".kiro/specs/demo/slices/03-envelope",
      round: 2,
      repoRoot: repoRootWithoutDocs,
      currentContract: "CURRENT-CONTRACT",
      currentAcceptanceManifest: '{"version":2}',
      findings: [],
      contractResponseInstructions: "Do not write a response.",
      baseGateCatalog: "- tests: pnpm test:fast",
      migrationReservation: "No migration reservation is active.",
    });

    expect(result.prompt).toContain(
      "# Repository context\n\n(none available)",
    );
    expect(result.evidence.includedArtifactClasses).not.toContain(
      "repository-adr",
    );
    expect(result.evidence.includedArtifactClasses).not.toContain(
      "repository-architecture",
    );
    expect(result.evidence.includedArtifactIds).toEqual([
      ".kiro/specs/demo/slices/03-envelope/contract.md",
      ".kiro/specs/demo/slices/03-envelope/acceptance-manifest.json",
      "base-gate-catalog",
      "migration-reservation",
    ]);
  });

  // Guardian round 4, PM 2: the contract evaluators receive only the
  // behavior/preservation and unknowns sections of the explorer map —
  // never the generator-facing patterns/harness or data sections.
  const markedExplorerContext = [
    "## Files and current behavior",
    "",
    "BEHAVIOR-MARKER-ONLY",
    "",
    "## Patterns and test harness",
    "",
    "PATTERN-MARKER-ONLY",
    "",
    "## Data and integration",
    "",
    "DATA-MARKER-ONLY",
    "",
    "## Unknowns",
    "",
    "UNKNOWN-MARKER-ONLY",
  ].join("\n");

  it("PM4-2 projects behavior and unknowns sections byte-for-byte and passes free-form context through", () => {
    expect(projectContractEvaluatorEvidence(markedExplorerContext)).toBe(
      "## Files and current behavior\n\nBEHAVIOR-MARKER-ONLY\n\n" +
        "## Unknowns\n\nUNKNOWN-MARKER-ONLY",
    );
    const freeForm = "free-form legacy context without evidence sections";
    expect(projectContractEvaluatorEvidence(freeForm)).toBe(freeForm);
  });

  it("PM4-2 keeps PATTERN-only and DATA-only content out of the initial evaluator prompt while behavior and unknown markers survive", () => {
    const result = assembleContractEvaluatorInitialEnvelope({
      sliceDir: ".kiro/specs/demo/slices/03-envelope",
      round: 1,
      contractReviewFile: "contract-review.json",
      proposedContract: "PROPOSED-CONTRACT",
      acceptanceManifest,
      baseGateCatalog: "- tests: pnpm test:fast",
      explorerContext: markedExplorerContext,
    });

    expect(result.prompt).toContain("BEHAVIOR-MARKER-ONLY");
    expect(result.prompt).toContain("UNKNOWN-MARKER-ONLY");
    expect(result.prompt).not.toContain("PATTERN-MARKER-ONLY");
    expect(result.prompt).not.toContain("DATA-MARKER-ONLY");
    expect(result.prompt).not.toContain("## Patterns and test harness");
    expect(result.prompt).not.toContain("## Data and integration");
    expect(
      CONTRACT_EVALUATOR_CONTEXT_MANIFEST.acceptedInputArtifactClasses,
    ).not.toContain("explorer-evidence-map");
    expect(
      CONTRACT_EVALUATOR_CONTEXT_MANIFEST.omittedArtifactClasses,
    ).toEqual(
      expect.arrayContaining([
        "explorer-patterns-and-harness",
        "explorer-data-and-integration",
      ]),
    );
    expect(result.evidence.includedArtifactClasses).toContain(
      "explorer-behavior-preservation",
    );
    // The artifactId still names the source evidence map on disk.
    expect(result.evidence.includedArtifactIds).toContain(
      ".kiro/specs/demo/slices/03-envelope/context.md",
    );
    expect(result.evidence.omittedArtifactClasses).toEqual(
      expect.arrayContaining([
        "explorer-patterns-and-harness",
        "explorer-data-and-integration",
      ]),
    );
  });

  it("PM4-2 applies the same section projection to the evaluator revision prompt", () => {
    const result = assembleContractEvaluatorRevisionEnvelope({
      sliceDir: ".kiro/specs/demo/slices/03-envelope",
      round: 2,
      contractReviewFile: "contract-review.json",
      proposedContract: "REVISED-CONTRACT",
      acceptanceManifest,
      baseGateCatalog: "- tests: pnpm test:fast",
      explorerContext: markedExplorerContext,
      previousFindings: [],
      plannerResponse: null,
      revisions: {
        "contract.md": { before: "old", after: "REVISED-CONTRACT" },
        "acceptance-manifest.json": {
          before: '{"version":2,"old":true}',
          after: JSON.stringify(acceptanceManifest),
        },
      },
    });

    expect(result.prompt).toContain("BEHAVIOR-MARKER-ONLY");
    expect(result.prompt).toContain("UNKNOWN-MARKER-ONLY");
    expect(result.prompt).not.toContain("PATTERN-MARKER-ONLY");
    expect(result.prompt).not.toContain("DATA-MARKER-ONLY");
    expect(result.evidence.includedArtifactClasses).toContain(
      "explorer-behavior-preservation",
    );
    expect(result.evidence.includedArtifactIds).toContain(
      ".kiro/specs/demo/slices/03-envelope/context.md",
    );
    expect(result.evidence.omittedArtifactClasses).toEqual(
      expect.arrayContaining([
        "explorer-patterns-and-harness",
        "explorer-data-and-integration",
      ]),
    );
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
      repoRoot: repoRootWithoutDocs,
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
      repoRoot: repoRootWithoutDocs,
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
        inputOrderKey: "initial",
        inlineSizeBudgetBytes: Buffer.byteLength(prompt) - 1,
        roleLabel: "Planner",
      }),
    ).toThrow(
      `actual ${Buffer.byteLength(prompt)} bytes, allowed ${Buffer.byteLength(prompt) - 1} bytes`,
    );
  });

  /**
   * #196. Slice #195 drew a REVISE at round 1 with a 45,862-byte evaluator
   * prompt and then died at CONFIGURATION on the revision with 151,315 bytes.
   * The figures below are the artifact sizes measured on that slice's
   * preserved worktree, so the fixture is the failure's shape, not a guess:
   * contract.md 22,495, acceptance-manifest.json 17,035 (21 behaviors),
   * context.md 14,147, contract-review.json 9,253, contract-response.json
   * 5,198, prior pair 29,734.
   */
  describe("#196 a #195-sized contract revision round", () => {
    const padTo = (seed: string, bytes: number): string => {
      const lines: string[] = [];
      let used = 0;
      for (let index = 0; used < bytes; index += 1) {
        const line = `${seed} clause ${index}: the gate records its own evidence path.`;
        lines.push(line);
        used += Buffer.byteLength(line, "utf-8") + 1;
      }
      return lines.join("\n");
    };
    const priorContract = padTo("prior", 15_461);
    const revisedContract = [
      padTo("prior", 12_000),
      padTo("revised", 10_400),
    ].join("\n");
    const behaviors = Array.from({ length: 21 }, (_, index) => ({
      id: `B-${String(index + 1).padStart(2, "0")}`,
      source: `GH #195 D${index + 1}; prd.md D${index + 1}`,
      given: padTo(`given-${index}`, 120),
      when: padTo(`when-${index}`, 200),
      then: padTo(`then-${index}`, 200),
      observableResult: padTo(`observable-${index}`, 160),
      preservation: false,
      gateIds: ["typecheck", "tests"],
    }));
    const revisedManifest: AcceptanceManifestV2 = {
      version: 2,
      fileScope: { kind: "paths", paths: ["src/gate-runner.ts"] },
      migrationCount: 0,
      behaviors,
    };
    const priorManifestText = JSON.stringify(
      { ...revisedManifest, behaviors: behaviors.slice(0, 15) },
      null,
      2,
    );
    const findings: ContractReviewFinding[] = [1, 2, 3].map((index) => ({
      id: `F-0${index}`,
      severity: "BLOCKING",
      behaviorIds: [`B-0${index}`],
      evidence: padTo(`evidence-${index}`, 700),
      expected: padTo(`expected-${index}`, 700),
      observed: padTo(`observed-${index}`, 700),
      clearCondition: padTo(`clear-${index}`, 700),
      state: "OPEN",
      revisionCitation: null,
    }));
    const bigExplorerContext = [
      "## Files and current behavior",
      "",
      padTo("files", 6_000),
      "",
      "## Patterns and test harness",
      "",
      padTo("patterns", 3_500),
      "",
      "## Data and integration",
      "",
      padTo("data", 1_000),
      "",
      "## Unknowns",
      "",
      padTo("unknowns", 3_500),
    ].join("\n");
    const revisions = {
      "contract.md": { before: priorContract, after: revisedContract },
      "acceptance-manifest.json": {
        before: priorManifestText,
        after: JSON.stringify(revisedManifest, null, 2),
      },
    };
    const assemble = () =>
      assembleContractEvaluatorRevisionEnvelope({
        sliceDir: ".kiro/specs/demo/slices/08-file-scope-gate",
        round: 2,
        contractReviewFile: "contract-review.json",
        proposedContract: revisedContract,
        acceptanceManifest: revisedManifest,
        baseGateCatalog: padTo("gate", 1_520),
        explorerContext: bigExplorerContext,
        previousFindings: findings,
        plannerResponse: {
          version: 1,
          round: 2,
          responses: findings.map((finding) => ({
            findingId: finding.id,
            position: "CONDITION_MET" as const,
            evidence: padTo(`response-${finding.id}`, 1_600),
          })),
        },
        revisions,
        durableLineage: padTo("lineage", 10_700),
      });

    it("names the dominant revision artifact: whole-file evidence alone overran the whole budget", () => {
      // The pre-fix block was exactly this value. It is 1.4x the entire
      // 65,536-byte evaluator budget on its own, which is why no amount of
      // slicing could make a revision round fit.
      const wholeFileEvidence = Buffer.byteLength(
        JSON.stringify(revisions, null, 2),
        "utf-8",
      );
      expect(wholeFileEvidence).toBeGreaterThan(
        CONTRACT_EVALUATOR_CONTEXT_MANIFEST.inlineSizeBudgetBytes,
      );
    });

    it("fits under the 65,536-byte budget and still carries citable revision evidence", () => {
      const result = assemble();
      expect(result.evidence.assembledByteSize).toBeLessThanOrEqual(
        CONTRACT_EVALUATOR_CONTEXT_MANIFEST.inlineSizeBudgetBytes,
      );
      const evidenceBlock = result.prompt
        .split("# Exact revision evidence")[1]!
        .split("# Control-plane situation")[0]!;
      expect(evidenceBlock).toContain("revised clause 0");
      expect(evidenceBlock).toContain("`revisionCitation.before`");
      // It fits with the whole delta carried, not by truncating it.
      expect(evidenceBlock).not.toMatch(/changed regions? omitted/);
      // Both sides of the change are quoted: the prior text a fresh finding
      // needs for `before`, and the revised text it needs for `after`.
      expect(evidenceBlock).toContain(priorContract.split("\n").at(-1)!);
      expect(evidenceBlock).toContain(revisedContract.split("\n").at(-1)!);
      // The pair is named, not copied.
      expect(result.prompt).toContain(
        "- `.kiro/specs/demo/slices/08-file-scope-gate/contract.md`",
      );
      expect(
        result.evidence.includedArtifactClasses.slice(0, 2),
      ).toEqual(["revised-contract", "revised-acceptance-manifest"]);
    });

    it("keeps the round's required evidence whole while the delta yields", () => {
      const prompt = assemble().prompt;
      for (const finding of findings) {
        expect(prompt).toContain(finding.clearCondition);
      }
      expect(prompt).toContain("lineage clause 0");
      expect(prompt).toContain("unknowns clause 0");
      expect(prompt).toContain("response-F-01 clause 0");
    });
  });

  it("#196 a regenerated #195 round-1 pair travels by reference and fits", () => {
    const result = assembleContractEvaluatorInitialEnvelope({
      sliceDir:
        ".kiro/specs/afk-v2-acceptance-scope-gates/slices/08-file-scope-gate",
      round: 1,
      contractReviewFile: "contract-review.json",
      proposedContract: "C".repeat(25_043),
      acceptanceManifest: {
        ...acceptanceManifest,
        behaviors: Array.from({ length: 22 }, (_, index) => ({
          id: `B-${String(index + 1).padStart(2, "0")}`,
          source: "GH #195 D22",
          given: "G".repeat(180),
          when: "W".repeat(180),
          then: "T".repeat(300),
          observableResult: "O".repeat(220),
          preservation: false,
          gateIds: ["tests"],
        })),
      },
      baseGateCatalog: "- tests: pnpm test:fast",
      explorerContext: [
        "## Files and current behavior",
        "F".repeat(6_000),
        "## Unknowns",
        "U".repeat(4_500),
      ].join("\n"),
      durableLineage: "L".repeat(8_612),
    });

    expect(result.evidence.assembledByteSize).toBeLessThanOrEqual(
      CONTRACT_EVALUATOR_CONTEXT_MANIFEST.inlineSizeBudgetBytes,
    );
    expect(result.prompt).not.toContain("C".repeat(1_000));
    expect(
      result.evidence.includedArtifactClasses.slice(0, 2),
    ).toEqual(["proposed-contract", "acceptance-manifest"]);
  });

  it("#196 an overflow error names the byte weight of each inlined artifact class", () => {
    expect(() =>
      assembleContractEvaluatorInitialEnvelope({
        sliceDir: ".kiro/specs/demo/slices/03-envelope",
        round: 1,
        contractReviewFile: "contract-review.json",
        proposedContract: "contract travels by reference",
        acceptanceManifest,
        baseGateCatalog: "- tests: pnpm test:fast",
        explorerContext: [
          "## Files and current behavior",
          "F".repeat(70_000),
          "## Unknowns",
          "none",
        ].join("\n"),
      }),
    ).toThrow(
      /inlined bytes by artifact class: explorer-behavior-preservation 70047/,
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


describe("role contract manifests", () => {
  const registeredManifests: ContextEnvelopeManifest[] = [
    EXPLORER_CONTEXT_MANIFEST,
    PLANNER_CONTEXT_MANIFEST,
    CONTRACT_EVALUATOR_CONTEXT_MANIFEST,
    CANDIDATE_EVALUATOR_CONTEXT_MANIFEST,
    GENERATOR_CONTEXT_MANIFEST,
  ];

  it("every registered manifest satisfies the complete role-contract schema", () => {
    for (const manifest of registeredManifests) {
      expect(
        () => validateContextEnvelopeManifest(manifest),
        manifest.role,
      ).not.toThrow();
      expect(manifest.objective.trim(), manifest.role).not.toBe("");
      expect(manifest.nonGoals.length, manifest.role).toBeGreaterThan(0);
      expect(
        manifest.stopConditions.length,
        manifest.role,
      ).toBeGreaterThan(0);
      expect(
        manifest.escalationConditions.length,
        manifest.role,
      ).toBeGreaterThan(0);
      expect(
        manifest.acceptedInputArtifactClasses.length,
        manifest.role,
      ).toBeGreaterThan(0);
      expect(manifest.outputArtifact.trim(), manifest.role).not.toBe("");
      expect(manifest.inlineSizeBudgetBytes, manifest.role).toBeGreaterThan(0);
      const writeScope =
        typeof manifest.allowedWriteScope === "string"
          ? [manifest.allowedWriteScope]
          : manifest.allowedWriteScope;
      expect(writeScope.length, manifest.role).toBeGreaterThan(0);
    }
  });

  it("declares the generator's complete write contract, matching both templates", () => {
    // PRD user story 1 (guardian round 5, PM 1): the manifest's allowed
    // write scope is the complete role boundary. Both shipped generator
    // templates instruct writing the slice handoff and, on escalation,
    // the structured escalation artifact — so the manifest must declare
    // them beside the acceptance-manifest file scope.
    const writeScope = [...GENERATOR_CONTEXT_MANIFEST.allowedWriteScope];
    expect(writeScope).toContain("acceptance-manifest.fileScope");
    expect(
      writeScope.some((entry) => entry.includes("handoff.md")),
    ).toBe(true);
    expect(
      writeScope.some((entry) => entry.includes("escalation.md")),
    ).toBe(true);
    for (const template of ["generator", "generator-repair"]) {
      const body = readFileSync(
        join(PROMPTS_DIR, `${template}.md`),
        "utf-8",
      );
      expect(body, template).toContain("{{SLICE_DIR}}/handoff.md");
      expect(body, template).toContain("{{SLICE_DIR}}/escalation.md");
    }
  });

  it("declares the planner's complete write contract, matching both templates", () => {
    // The twin of the generator assertion above. Both shipped planner
    // templates instruct writing `planner-escalation.md` instead of the
    // contract pair when a §3c escalation test fires, so the manifest — where
    // a reader looks for the role's boundary — must declare it beside the
    // pair rather than describing a write scope the prompts contradict.
    const writeScope = [...PLANNER_CONTEXT_MANIFEST.allowedWriteScope];
    expect(
      writeScope.some((entry) => entry.includes(PLANNER_ESCALATION_FILENAME)),
    ).toBe(true);
    for (const template of ["planner", "planner-revision"]) {
      const body = readFileSync(join(PROMPTS_DIR, `${template}.md`), "utf-8");
      expect(body, template).toContain(
        `{{SLICE_DIR}}/${PLANNER_ESCALATION_FILENAME}`,
      );
    }
  });

  it("rejects a manifest missing part of the role contract as CONFIGURATION", () => {
    expect(() =>
      validateContextEnvelopeManifest({
        ...PLANNER_CONTEXT_MANIFEST,
        escalationConditions: [],
      }),
    ).toThrow(
      'CONFIGURATION: planner manifest field "escalationConditions" must declare at least one entry',
    );
    expect(() =>
      validateContextEnvelopeManifest({
        ...PLANNER_CONTEXT_MANIFEST,
        acceptedInputArtifactClasses: [
          ...PLANNER_CONTEXT_MANIFEST.acceptedInputArtifactClasses,
          "unslotted-class",
        ],
      }),
    ).toThrow(
      'CONFIGURATION: planner manifest accepted class "unslotted-class" has no inputOrder slot',
    );
  });

  it("declares the deferred candidate-evaluator role contract as manifest-only", () => {
    expect(CANDIDATE_EVALUATOR_CONTEXT_MANIFEST).toMatchObject({
      version: 1,
      role: "evaluator-qa",
      outputArtifact: "qa-review-pair",
      inlineSizeBudgetBytes: 65_536,
    });
    expect(
      () => validateContextEnvelopeManifest(CANDIDATE_EVALUATOR_CONTEXT_MANIFEST),
    ).not.toThrow();
    expect(
      CANDIDATE_EVALUATOR_CONTEXT_MANIFEST.acceptedInputArtifactClasses,
    ).toContain("locked-contract");
    expect(
      CANDIDATE_EVALUATOR_CONTEXT_MANIFEST.acceptedInputArtifactClasses,
    ).toContain("base-gate-authorization");
    expect(
      CANDIDATE_EVALUATOR_CONTEXT_MANIFEST.omittedArtifactClasses,
    ).toContain("other-qa-stage-findings");
  });

  it("pins the candidate-evaluator include/exclude contract to the governing docs", () => {
    // afk-v2-agent-roles.md M7: "handoff.md is excluded from all reviewer
    // inputs: judge the tree, not the author's story." Handoffs are
    // deliberate omissions, never accepted classes.
    for (const handoffClass of [
      "candidate-handoff",
      "dependency-sibling-handoffs",
    ]) {
      expect(
        CANDIDATE_EVALUATOR_CONTEXT_MANIFEST.acceptedInputArtifactClasses,
        handoffClass,
      ).not.toContain(handoffClass);
      expect(
        CANDIDATE_EVALUATOR_CONTEXT_MANIFEST.omittedArtifactClasses,
        handoffClass,
      ).toContain(handoffClass);
    }
    // afk-v2-plan.md §3 item 5: the slice diff change summary plus the
    // acceptance manifest lead the candidate evaluator's envelope.
    expect(
      CANDIDATE_EVALUATOR_CONTEXT_MANIFEST.inputOrder.slice(0, 2),
    ).toEqual(["change-summary", "acceptance-manifest"]);
    // afk-v2-agent-roles.md §1: explorer evidence enters the candidate
    // evaluator's include list — evaluators get behavior and preservation.
    expect(
      CANDIDATE_EVALUATOR_CONTEXT_MANIFEST.acceptedInputArtifactClasses,
    ).toContain("explorer-preservation-evidence");
    expect(
      CANDIDATE_EVALUATOR_CONTEXT_MANIFEST.acceptedInputArtifactClasses,
    ).toEqual([
      "change-summary",
      "acceptance-manifest",
      "qa-scope",
      "locked-contract",
      "explorer-preservation-evidence",
      "cited-adr",
      "unresolved-qa-findings",
      "sanity-command-set",
      "base-gate-authorization",
    ]);
  });

  it("clamps a budget override larger than the manifest budget and applies a smaller one", () => {
    const oversizedPrompt = "x".repeat(
      PLANNER_CONTEXT_MANIFEST.inlineSizeBudgetBytes + 1,
    );
    // A larger override must not relax the manifest budget: min() clamps it.
    expect(() =>
      assembleContextEnvelope({
        prompt: oversizedPrompt,
        manifest: PLANNER_CONTEXT_MANIFEST,
        includedArtifacts: [
          { artifactClass: "slice-request", artifactId: "slice-request" },
        ],
        inputOrderKey: "initial",
        inlineSizeBudgetBytes:
          PLANNER_CONTEXT_MANIFEST.inlineSizeBudgetBytes * 10,
        roleLabel: "Planner",
      }),
    ).toThrow(
      `actual ${PLANNER_CONTEXT_MANIFEST.inlineSizeBudgetBytes + 1} bytes, allowed ${PLANNER_CONTEXT_MANIFEST.inlineSizeBudgetBytes} bytes`,
    );

    // Clamping is silent: a within-budget prompt assembles under a larger override.
    const withinBudget = assembleContextEnvelope({
      prompt: "small prompt",
      manifest: PLANNER_CONTEXT_MANIFEST,
      includedArtifacts: [
        { artifactClass: "slice-request", artifactId: "slice-request" },
      ],
      inputOrderKey: "initial",
      inlineSizeBudgetBytes:
        PLANNER_CONTEXT_MANIFEST.inlineSizeBudgetBytes * 10,
      roleLabel: "Planner",
    });
    expect(withinBudget.evidence.assembledByteSize).toBe(
      Buffer.byteLength("small prompt"),
    );

    // A stricter override still applies as before.
    expect(() =>
      assembleContextEnvelope({
        prompt: "small prompt",
        manifest: PLANNER_CONTEXT_MANIFEST,
        includedArtifacts: [
          { artifactClass: "slice-request", artifactId: "slice-request" },
        ],
        inputOrderKey: "initial",
        inlineSizeBudgetBytes: 4,
        roleLabel: "Planner",
      }),
    ).toThrow(
      `actual ${Buffer.byteLength("small prompt")} bytes, allowed 4 bytes`,
    );
  });

  it("derives evidence ordering from the manifest input order, not caller order", () => {
    const shuffled = assembleContextEnvelope({
      prompt: "prompt",
      manifest: PLANNER_CONTEXT_MANIFEST,
      includedArtifacts: [
        {
          artifactClass: "migration-reservation",
          artifactId: "migration-reservation",
        },
        {
          artifactClass: "base-gate-catalog",
          artifactId: "base-gate-catalog",
        },
        {
          artifactClass: "open-contract-findings",
          artifactId: "contract-review:open-findings",
        },
        {
          artifactClass: "current-contract-pair",
          artifactId: "slice/contract.md",
        },
        {
          artifactClass: "current-contract-pair",
          artifactId: "slice/acceptance-manifest.json",
        },
      ],
      inputOrderKey: "revision",
      roleLabel: "Planner",
    });

    expect(shuffled.evidence.includedArtifactClasses).toEqual([
      "current-contract-pair",
      "current-contract-pair",
      "open-contract-findings",
      "base-gate-catalog",
      "migration-reservation",
    ]);
    expect(shuffled.evidence.includedArtifactIds).toEqual([
      "slice/contract.md",
      "slice/acceptance-manifest.json",
      "contract-review:open-findings",
      "base-gate-catalog",
      "migration-reservation",
    ]);
  });

  it("rejects an artifact class with no slot in the named input-order variant", () => {
    expect(() =>
      assembleContextEnvelope({
        prompt: "prompt",
        manifest: PLANNER_CONTEXT_MANIFEST,
        includedArtifacts: [
          {
            artifactClass: "current-contract-pair",
            artifactId: "slice/contract.md",
          },
        ],
        inputOrderKey: "initial",
        roleLabel: "Planner",
      }),
    ).toThrow(
      'CONFIGURATION: planner context class "current-contract-pair" has no slot in the declared input order variant "initial"',
    );
    expect(() =>
      assembleContextEnvelope({
        prompt: "prompt",
        manifest: PLANNER_CONTEXT_MANIFEST,
        includedArtifacts: [
          { artifactClass: "slice-request", artifactId: "slice-request" },
        ],
        inputOrderKey: "unknown-variant",
        roleLabel: "Planner",
      }),
    ).toThrow(
      'CONFIGURATION: planner manifest declares no input-order variant "unknown-variant"',
    );
  });

  it("maps grouped repository classes onto their shared input-order slot", () => {
    const repoRoot = fileURLToPath(new URL("..", import.meta.url));
    const result = assembleExplorerEnvelope({
      repoRoot,
      ghIssue: "90",
      title: "Explorer context",
      sliceDir: ".kiro/specs/demo/slices/02-explorer",
      relevantFiles: "RELEVANT-FILES-MARKER",
      sliceBody: "SLICE-BODY-MARKER",
    });
    // slice-request occupies the "slice-inputs" slot ahead of every
    // repository-context artifact, so the manifest — not the caller — fixes
    // the evidence order.
    expect(result.evidence.includedArtifactClasses[0]).toBe("slice-request");
    expect(
      new Set(result.evidence.includedArtifactClasses.slice(1)),
    ).toEqual(new Set(["repository-adr", "repository-architecture"]));
  });
});

describe("rendered block order validation", () => {
  // Guardian round 2, architect A3: the assembler must not report
  // manifest-ordered evidence over a prompt whose rendered blocks disagree
  // with that order.
  it("fails closed on the guardian probe: prompt renders SECOND before FIRST while the manifest orders FIRST first", () => {
    expect(() =>
      assembleContextEnvelope({
        prompt: "SECOND BEFORE FIRST",
        manifest: PLANNER_CONTEXT_MANIFEST,
        includedArtifacts: [
          {
            artifactClass: "slice-request",
            artifactId: "slice-request",
            locator: "FIRST",
          },
          {
            artifactClass: "explorer-evidence-map",
            artifactId: "slice/context.md",
            locator: "SECOND",
          },
        ],
        inputOrderKey: "initial",
        roleLabel: "Planner",
      }),
    ).toThrow(
      'CONFIGURATION: Planner rendered prompt places artifact "slice/context.md" (explorer-evidence-map) before "slice-request" (slice-request), violating the manifest\'s declared input order',
    );
  });

  it("accepts the same artifacts when the rendered blocks follow the manifest order", () => {
    const result = assembleContextEnvelope({
      prompt: "FIRST BEFORE SECOND",
      manifest: PLANNER_CONTEXT_MANIFEST,
      includedArtifacts: [
        {
          artifactClass: "explorer-evidence-map",
          artifactId: "slice/context.md",
          locator: "SECOND",
        },
        {
          artifactClass: "slice-request",
          artifactId: "slice-request",
          locator: "FIRST",
        },
      ],
      inputOrderKey: "initial",
      roleLabel: "Planner",
    });
    expect(result.evidence.includedArtifactClasses).toEqual([
      "slice-request",
      "explorer-evidence-map",
    ]);
  });

  it("rejects a locator absent from the rendered prompt as CONFIGURATION", () => {
    expect(() =>
      assembleContextEnvelope({
        prompt: "prompt without the block",
        manifest: PLANNER_CONTEXT_MANIFEST,
        includedArtifacts: [
          {
            artifactClass: "slice-request",
            artifactId: "slice-request",
            locator: "MISSING-BLOCK",
          },
        ],
        inputOrderKey: "initial",
        roleLabel: "Planner",
      }),
    ).toThrow(
      'CONFIGURATION: Planner artifact "slice-request" (slice-request) locator was not found in the rendered prompt',
    );
  });

  it("rejects a blank locator and requires a reasoned explicit exemption instead", () => {
    expect(() =>
      assembleContextEnvelope({
        prompt: "prompt",
        manifest: PLANNER_CONTEXT_MANIFEST,
        includedArtifacts: [
          {
            artifactClass: "slice-request",
            artifactId: "slice-request",
            locator: "  ",
          },
        ],
        inputOrderKey: "initial",
        roleLabel: "Planner",
      }),
    ).toThrow(/declares a blank locator; use an explicit locator exemption/);
    expect(() =>
      assembleContextEnvelope({
        prompt: "prompt",
        manifest: PLANNER_CONTEXT_MANIFEST,
        includedArtifacts: [
          {
            artifactClass: "slice-request",
            artifactId: "slice-request",
            locatorExemption: " ",
          },
        ],
        inputOrderKey: "initial",
        roleLabel: "Planner",
      }),
    ).toThrow(/declares a blank locator exemption; exemption must state a reason/);
    expect(() =>
      assembleContextEnvelope({
        prompt: "prompt",
        manifest: PLANNER_CONTEXT_MANIFEST,
        includedArtifacts: [
          {
            artifactClass: "slice-request",
            artifactId: "slice-request",
            locatorExemption: "artifact travels by reference only",
          },
        ],
        inputOrderKey: "initial",
        roleLabel: "Planner",
      }),
    ).not.toThrow();
  });

  it("validates rendered order for every per-role assembler via wired locators", () => {
    // The per-role assemblers pass a locator (or explicit exemption) for
    // every included artifact, so the assemblies exercised across this file
    // run the rendered-order check for real. Prove the wiring is live for a
    // representative role: a generator assembly whose rendered block order
    // is violated must fail closed before returning evidence.
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
    const assembled = assembleGeneratorEnvelope(input);
    // The genuine template renders blocks in manifest order.
    expect(assembled.prompt.indexOf("LOCKED-CONTRACT-VIEW")).toBeLessThan(
      assembled.prompt.indexOf("PATTERNS-AND-HARNESS"),
    );
    // Feeding the same locators a reversed rendering through the generic
    // assembler throws — the check is order-sensitive, not presence-only.
    expect(() =>
      assembleContextEnvelope({
        prompt: "PATTERNS-AND-HARNESS then LOCKED-CONTRACT-VIEW",
        manifest: GENERATOR_CONTEXT_MANIFEST,
        includedArtifacts: [
          {
            artifactClass: "contract-view",
            artifactId: "slice/contract.md",
            locator: "LOCKED-CONTRACT-VIEW",
          },
          {
            artifactClass: "patterns-and-harness",
            artifactId: "slice/context.md",
            locator: "PATTERNS-AND-HARNESS",
          },
        ],
        inputOrderKey: "initial",
        roleLabel: "Generator",
      }),
    ).toThrow(/violating the manifest's declared input order/);
  });
});

import { describe, expect, it } from "vitest";
import type { AcceptanceManifestV2 } from "./acceptance-manifest.js";
import type { RunEventPayload } from "./run-events.js";
import {
  EXPLORER_CONTEXT_MANIFEST,
  GENERATOR_CONTEXT_MANIFEST,
  assembleExplorerEnvelope,
  assembleGeneratorEnvelope,
  buildExplorerRepositoryContext,
  projectGeneratorContractView,
  projectGeneratorPatternsAndHarness,
  validateExplorerEvidenceMap,
} from "./context-envelope.js";
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
    expect(
      repositoryContext.includedArtifactIds.filter((path) =>
        path.startsWith("docs/adr/"),
      ),
    ).toHaveLength(55);
  });

  it("B-04 assembles the ordered focused prompt without a persona or role tags", () => {
    const repoRoot = fileURLToPath(new URL("..", import.meta.url));
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

describe("generator context envelope", () => {
  it("B-01 assembles the focused initial envelope in manifest order", () => {
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
      inputOrder: [
        "contract-view",
        "acceptance-manifest",
        "file-scope",
        "patterns-and-harness",
        "failure-set",
      ],
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

  it("B-03 ends a repair envelope with only open findings and failed gates", () => {
    const input = {
      mode: "repair" as const,
      sliceDir: ".kiro/specs/demo/slices/01-focused",
      contractView: "LOCKED-CONTRACT-VIEW",
      acceptanceManifest,
      patternsAndHarness: "PATTERNS-AND-HARNESS",
      testCommand: "pnpm test:focused",
      migrationReservation: "NO-MIGRATIONS",
      repairSituation: "ROUND-TWO-SITUATION",
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

  it("B-07 produces byte-identical prompts and evidence for identical inputs", () => {
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

  it("P-04 preserves generator assembly and the legacy full-context fallback", () => {
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

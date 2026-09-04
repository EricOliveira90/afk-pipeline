import type { AcceptanceManifestV2 } from "./acceptance-manifest.js";
import { renderPrompt } from "./prompt-template.js";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

const EXPLORER_REQUIRED_SECTIONS = [
  "Files and current behavior",
  "Patterns and test harness",
  "Unknowns",
] as const;
const EXPLORER_OPTIONAL_SECTION = "Data and integration";

interface MarkdownSection {
  title: string;
  level: number;
  headingStart: number;
  bodyStart: number;
  bodyEnd: number;
}

export const EXPLORER_CONTEXT_MANIFEST = {
  version: 1,
  role: "explorer",
  objective:
    "Build a cited four-section evidence map for planner and generator use.",
  allowedWriteScope: "slice/context.md",
  outputArtifact: "four-section-evidence-map",
  inputOrder: [
    "objective",
    "write-boundary",
    "stop-condition",
    "citation-rule",
    "four-section-task",
    "slice-inputs",
    "repository-context",
    "budget",
  ],
  inlineSizeBudgetBytes: 65_536,
  omittedArtifactClasses: [
    "persona",
    "full-adr-bodies",
    "prior-conversation",
    "other-role-conversation",
  ],
} as const;

export interface ExplorerEnvelopeInput {
  repoRoot: string;
  ghIssue: string;
  title: string;
  sliceDir: string;
  relevantFiles: string;
  sliceBody: string;
  inlineSizeBudgetBytes?: number;
}

export interface ExplorerEnvelopeResult {
  prompt: string;
  evidence: {
    assembledByteSize: number;
    includedArtifactIds: string[];
    omittedArtifactClasses: string[];
    contextManifestVersion: number;
  };
}

const GENERATOR_CONTRACT_SECTIONS = new Set([
  "Scope lock",
  "In scope",
  "Non-goals (explicit out-of-scope)",
  "Existing behavior to preserve",
  "Changes to existing behavior (only if the issue asks for it)",
  "New patterns / deps / schema (if any)",
]);

const CONTRACT_SECTION_LEVELS = new Map([
  ["Scope lock", 2],
  ["In scope", 3],
  ["Non-goals (explicit out-of-scope)", 3],
  ["Existing behavior to preserve", 3],
  ["Changes to existing behavior (only if the issue asks for it)", 3],
  ["Files expected to change", 2],
  ["Migration requirements", 2],
  ["New patterns / deps / schema (if any)", 2],
  ["Test plan", 2],
  ["Definition of done", 2],
]);

export const GENERATOR_CONTEXT_MANIFEST = {
  version: 1,
  role: "generator",
  objective:
    "Implement every locked manifest behavior inside the declared file scope and commit the candidate.",
  nonGoals: [
    "Changing the locked contract or acceptance manifest",
    "Reconstructing resolved findings or prior conversations",
    "Claiming verification status",
  ],
  allowedWriteScope: "acceptance-manifest.fileScope",
  stopConditions: [
    "A committed candidate and three-section handoff exist",
    "A required change is outside the declared file scope",
  ],
  escalationConditions: [
    "A correct fix requires an undeclared path",
    "The specification contradicts itself",
    "The specification is silent on a load-bearing decision",
    "The contract declares the decision as a risk",
  ],
  acceptedInputArtifactClasses: [
    "contract-view",
    "acceptance-manifest",
    "patterns-and-harness",
    "failure-set",
  ],
  outputArtifact: "committed-candidate-and-handoff",
  inputOrder: [
    "contract-view",
    "acceptance-manifest",
    "file-scope",
    "patterns-and-harness",
    "failure-set",
  ],
  inlineSizeBudgetBytes: 65_536,
  omittedArtifactClasses: [
    "resolved-findings",
    "passing-logs",
    "prior-conversation",
    "other-role-conversation",
    "sibling-handoffs",
    "full-adr-bodies",
  ],
} as const;

export interface GeneratorFailureSet {
  findings: readonly {
    id: string;
    clearCondition: string;
    artifactReferences: readonly string[];
  }[];
  gates: readonly {
    id: string;
    evidence: readonly string[];
  }[];
}

export interface GeneratorEnvelopeInput {
  mode: "initial" | "repair";
  sliceDir: string;
  contractView: string;
  acceptanceManifest: AcceptanceManifestV2;
  patternsAndHarness: string;
  /** Null when a legacy direct-execution caller has no explorer artifact. */
  patternsAndHarnessArtifactId?: string | null;
  testCommand: string;
  migrationReservation: string;
  failureSet: GeneratorFailureSet;
  repairSituation?: string;
  additionalArtifactIds?: readonly string[];
  inlineSizeBudgetBytes?: number;
}

export interface GeneratorEnvelopeEvidence {
  assembledByteSize: number;
  includedArtifactIds: string[];
  omittedArtifactClasses: string[];
  contextManifestVersion: number;
}

export interface GeneratorEnvelopeResult {
  prompt: string;
  evidence: GeneratorEnvelopeEvidence;
}

function markdownSections(content: string): MarkdownSection[] {
  const headings: Omit<MarkdownSection, "bodyEnd">[] = [];
  let lineStart = 0;
  let fence: { marker: "`" | "~"; length: number } | undefined;

  while (lineStart < content.length) {
    const lineFeed = content.indexOf("\n", lineStart);
    const nextLineStart =
      lineFeed === -1 ? content.length : lineFeed + 1;
    const lineEnd =
      lineFeed === -1
        ? content.length
        : lineFeed > lineStart && content[lineFeed - 1] === "\r"
          ? lineFeed - 1
          : lineFeed;
    const line = content.slice(lineStart, lineEnd);
    const fenceMatch = /^(?: {0,3})(`{3,}|~{3,})(.*)$/.exec(line);

    if (fence !== undefined) {
      if (
        fenceMatch !== null &&
        fenceMatch[1]![0] === fence.marker &&
        fenceMatch[1]!.length >= fence.length &&
        /^[ \t]*$/.test(fenceMatch[2]!)
      ) {
        fence = undefined;
      }
    } else if (
      fenceMatch !== null &&
      !(
        fenceMatch[1]![0] === "`" &&
        fenceMatch[2]!.includes("`")
      )
    ) {
      fence = {
        marker: fenceMatch[1]![0] as "`" | "~",
        length: fenceMatch[1]!.length,
      };
    } else {
      const headingMatch = /^(#{1,6})[ \t]+(.+?)$/.exec(line);
      if (headingMatch !== null) {
        headings.push({
          title: headingMatch[2]!,
          level: headingMatch[1]!.length,
          headingStart: lineStart,
          bodyStart: lineEnd,
        });
      }
    }

    lineStart = nextLineStart;
  }

  return headings.map((heading, index) => ({
    ...heading,
    bodyEnd:
      headings
        .slice(index + 1)
        .find((candidate) => candidate.level <= heading.level)?.headingStart ??
      content.length,
  }));
}

function explorerEvidenceSections(content: string): MarkdownSection[] {
  return markdownSections(content).filter((heading) => heading.level === 2);
}

export function validateExplorerEvidenceMap(content: string): void {
  const actual = explorerEvidenceSections(content).map(
    (section) => section.title,
  );
  const withoutOptional = actual.filter(
    (title) => title !== EXPLORER_OPTIONAL_SECTION,
  );
  const optionalCount = actual.filter(
    (title) => title === EXPLORER_OPTIONAL_SECTION,
  ).length;
  const requiredMatches =
    withoutOptional.length === EXPLORER_REQUIRED_SECTIONS.length &&
    withoutOptional.every(
      (title, index) => title === EXPLORER_REQUIRED_SECTIONS[index],
    );
  const optionalPositionIsValid =
    optionalCount === 0 ||
    (optionalCount === 1 &&
      actual[2] === EXPLORER_OPTIONAL_SECTION &&
      actual[3] === "Unknowns");

  if (!requiredMatches || !optionalPositionIsValid) {
    throw new Error(
      "Explorer evidence map requires exactly these level-two sections in order: " +
        "Files and current behavior, Patterns and test harness, optional Data and integration, Unknowns; " +
        `found: ${actual.length > 0 ? actual.join(", ") : "(none)"}`,
    );
  }
}

function adrTitle(path: string): string {
  const firstLine = readFileSync(path, "utf-8").split(/\r?\n/, 1)[0] ?? "";
  return firstLine
    .replace(/^#[ \t]+/, "")
    .replace(/^ADR[ \t]+\d+[ \t]+[—-][ \t]+/i, "")
    .trim();
}

export function buildExplorerRepositoryContext(repoRoot: string): {
  content: string;
  includedArtifactIds: string[];
} {
  const blocks: string[] = [];
  const includedArtifactIds: string[] = [];
  const adrDir = join(repoRoot, "docs", "adr");
  if (existsSync(adrDir)) {
    const adrFiles = readdirSync(adrDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .sort((left, right) => left.name.localeCompare(right.name));
    if (adrFiles.length > 0) {
      blocks.push(
        [
          "## ADR index",
          "",
          ...adrFiles.map((entry) => {
            const number =
              /^(\d+)/.exec(entry.name)?.[1] ??
              basename(entry.name, ".md");
            const relativePath = `docs/adr/${entry.name}`;
            includedArtifactIds.push(relativePath);
            return `- ${number} — ${adrTitle(join(adrDir, entry.name))} (\`${relativePath}\`)`;
          }),
        ].join("\n"),
      );
    }
  }

  const architecturePath = join(repoRoot, "ARCHITECTURE.md");
  if (existsSync(architecturePath)) {
    includedArtifactIds.push("ARCHITECTURE.md");
    blocks.push(
      [
        "## ARCHITECTURE.md",
        "",
        readFileSync(architecturePath, "utf-8").trimEnd(),
      ].join("\n"),
    );
  }

  return {
    content: blocks.length > 0 ? blocks.join("\n\n") : "(none available)",
    includedArtifactIds,
  };
}

export function assembleExplorerEnvelope(
  input: ExplorerEnvelopeInput,
): ExplorerEnvelopeResult {
  const allowedByteSize =
    input.inlineSizeBudgetBytes ??
    EXPLORER_CONTEXT_MANIFEST.inlineSizeBudgetBytes;
  const repositoryContext = buildExplorerRepositoryContext(input.repoRoot);
  const prompt = renderPrompt("explorer", {
    GH_ISSUE: input.ghIssue,
    TITLE: input.title,
    SLICE_DIR: input.sliceDir,
    RELEVANT_FILES: input.relevantFiles,
    SLICE_BODY: input.sliceBody,
    REPOSITORY_CONTEXT: repositoryContext.content,
    INLINE_SIZE_BUDGET_BYTES: allowedByteSize,
  });
  const assembledByteSize = Buffer.byteLength(prompt, "utf-8");
  if (assembledByteSize > allowedByteSize) {
    throw new Error(
      `Explorer prompt exceeds inline-size budget: actual ${assembledByteSize} bytes, allowed ${allowedByteSize} bytes`,
    );
  }

  return {
    prompt,
    evidence: {
      assembledByteSize,
      includedArtifactIds: repositoryContext.includedArtifactIds,
      omittedArtifactClasses: [
        ...EXPLORER_CONTEXT_MANIFEST.omittedArtifactClasses,
      ],
      contextManifestVersion: EXPLORER_CONTEXT_MANIFEST.version,
    },
  };
}

export function projectGeneratorContractView(contract: string): string {
  const headings = [
    ...contract.matchAll(/^(#{1,6})[ \t]+(.+?)(\r?\n|$)/gm),
  ].map((match) => ({
    title: match[2]!,
    level: match[1]!.length,
    headingStart: match.index,
    bodyStart: match.index + match[0].length - match[3]!.length,
  }));

  const standardSections = headings.filter(
    (heading) =>
      CONTRACT_SECTION_LEVELS.get(heading.title) === heading.level,
  );
  const selected = standardSections
    .map((heading, index) => ({
      ...heading,
      bodyEnd: standardSections[index + 1]?.headingStart ?? contract.length,
    }))
    .filter((heading) => GENERATOR_CONTRACT_SECTIONS.has(heading.title));
  const counts = new Map<string, number>();
  for (const heading of selected) {
    counts.set(heading.title, (counts.get(heading.title) ?? 0) + 1);
  }
  const duplicated = [...GENERATOR_CONTRACT_SECTIONS].filter(
    (title) => (counts.get(title) ?? 0) > 1,
  );
  if (duplicated.length > 0) {
    throw new Error(
      `Generator contract view requires unique projected sections; duplicated: ${duplicated.join(", ")}`,
    );
  }
  if (selected.length !== GENERATOR_CONTRACT_SECTIONS.size) return contract;

  return selected
    .map(({ bodyStart, bodyEnd }) => contract.slice(bodyStart, bodyEnd))
    .join("");
}

export function projectGeneratorPatternsAndHarness(context: string): string {
  const section = explorerEvidenceSections(context).find(
    (heading) => heading.title === "Patterns and test harness",
  );
  if (section === undefined) return context;
  return context.slice(section.headingStart, section.bodyEnd);
}

export function assembleGeneratorEnvelope(
  input: GeneratorEnvelopeInput,
): GeneratorEnvelopeResult {
  if (input.mode === "repair" && input.repairSituation === undefined) {
    throw new Error("Generator repair envelope requires a repair situation");
  }

  const fileScope =
    input.acceptanceManifest.fileScope.kind === "paths"
      ? input.acceptanceManifest.fileScope.paths
          .map((path) => `- \`${path}\``)
          .join("\n")
      : "(no repository changes)";
  const failureSet = formatGeneratorFailureSet(input.failureSet);
  const commonArgs = {
    SLICE_DIR: input.sliceDir,
    FILE_SCOPE: fileScope,
    MIGRATION_RESERVATION: input.migrationReservation,
    CONTRACT_VIEW: input.contractView,
    ACCEPTANCE_MANIFEST: JSON.stringify(input.acceptanceManifest, null, 2),
    TEST_COMMAND: input.testCommand,
    PATTERNS_AND_HARNESS: input.patternsAndHarness,
    FAILURE_SET: failureSet,
  };
  const prompt =
    input.mode === "repair"
      ? renderPrompt("generator-repair", {
          ...commonArgs,
          REPAIR_SITUATION: input.repairSituation!,
        })
      : renderPrompt("generator", commonArgs);
  const assembledByteSize = Buffer.byteLength(prompt, "utf-8");
  const allowedByteSize =
    input.inlineSizeBudgetBytes ??
    GENERATOR_CONTEXT_MANIFEST.inlineSizeBudgetBytes;
  if (assembledByteSize > allowedByteSize) {
    throw new Error(
      `Generator prompt exceeds inline-size budget: actual ${assembledByteSize} bytes, allowed ${allowedByteSize} bytes`,
    );
  }
  const failureArtifactIds = [
    ...input.failureSet.findings.flatMap(
      (finding) => finding.artifactReferences,
    ),
    ...input.failureSet.gates.flatMap((gate) => gate.evidence),
  ];

  return {
    prompt,
    evidence: {
      assembledByteSize,
      includedArtifactIds: [
        `${input.sliceDir}/contract.md`,
        `${input.sliceDir}/acceptance-manifest.json`,
        ...(input.patternsAndHarnessArtifactId === null
          ? []
          : [
              input.patternsAndHarnessArtifactId ??
                `${input.sliceDir}/context.md`,
            ]),
        ...(input.additionalArtifactIds ?? []),
        ...new Set(failureArtifactIds),
      ],
      omittedArtifactClasses: [
        ...GENERATOR_CONTEXT_MANIFEST.omittedArtifactClasses,
      ],
      contextManifestVersion: GENERATOR_CONTEXT_MANIFEST.version,
    },
  };
}

export function formatGeneratorFailureSet(
  failureSet: GeneratorFailureSet,
): string {
  if (failureSet.findings.length === 0 && failureSet.gates.length === 0) {
    return "(none)";
  }

  return [
    ...failureSet.findings.map((finding) =>
      [
        `- Finding ID: \`${finding.id}\``,
        `  Clear condition: ${finding.clearCondition}`,
        "  Artifact references:",
        ...finding.artifactReferences.map((path) => `  - \`${path}\``),
      ].join("\n"),
    ),
    ...failureSet.gates.map((gate) =>
      [
        `- Gate ID: \`${gate.id}\``,
        "  Evidence:",
        ...gate.evidence.map((path) => `  - \`${path}\``),
      ].join("\n"),
    ),
  ].join("\n");
}

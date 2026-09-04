import type {
  AcceptanceManifest,
  AcceptanceManifestV2,
} from "./acceptance-manifest.js";
import {
  formatContractReviewFindings,
  openContractReviewFindings,
  type ContractResponse,
  type ContractRevisionArtifacts,
  type ContractReviewFinding,
} from "./contract-review.js";
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
  acceptedInputArtifactClasses: [
    "slice-request",
    "repository-adr",
    "repository-architecture",
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
  evidence: RoleEnvelopeEvidence & { role: "explorer" };
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
    "file-scope",
    "patterns-and-harness",
    "verification-command",
    "migration-reservation",
    "failure-set",
    "repair-situation",
    "repair-context",
    "finding-evidence",
    "gate-evidence",
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
  role: "generator";
  assembledByteSize: number;
  includedArtifactClasses: string[];
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
  const repositoryContext = buildExplorerRepositoryContext(input.repoRoot);
  const prompt = renderPrompt("explorer", {
    GH_ISSUE: input.ghIssue,
    TITLE: input.title,
    SLICE_DIR: input.sliceDir,
    RELEVANT_FILES: input.relevantFiles,
    SLICE_BODY: input.sliceBody,
    REPOSITORY_CONTEXT: repositoryContext.content,
    INLINE_SIZE_BUDGET_BYTES:
      input.inlineSizeBudgetBytes ??
      EXPLORER_CONTEXT_MANIFEST.inlineSizeBudgetBytes,
  });
  return assembleContextEnvelope({
    prompt,
    manifest: EXPLORER_CONTEXT_MANIFEST,
    includedArtifacts: [
      {
        artifactClass: "slice-request",
        artifactId: `issue:${input.ghIssue}`,
      },
      ...repositoryContext.includedArtifactIds.map((artifactId) => ({
        artifactClass: artifactId.startsWith("docs/adr/")
          ? "repository-adr"
          : "repository-architecture",
        artifactId,
      })),
    ],
    inlineSizeBudgetBytes: input.inlineSizeBudgetBytes,
    roleLabel: "Explorer",
  }) as ExplorerEnvelopeResult;
}

const ROLE_ENVELOPE_OMISSIONS = [
  "prior-conversation",
  "other-role-conversation",
  "resolved-findings",
  "sibling-handoffs",
  "full-adr-bodies",
] as const;

export const PLANNER_CONTEXT_MANIFEST = {
  version: 1,
  role: "planner",
  objective:
    "Define one executable slice contract and version-2 acceptance manifest.",
  nonGoals: [
    "Implementing the slice",
    "Running verification commands",
    "Changing unrelated contract sections during a revision",
  ],
  allowedWriteScope: [
    "slice/contract.md",
    "slice/acceptance-manifest.json",
    "slice/contract-response.json on routed review revisions",
  ],
  stopConditions: [
    "The required planner artifacts are rewritten in place",
    "A specification contradiction, load-bearing silence, or declared risk requires escalation",
  ],
  acceptedInputArtifactClasses: [
    "slice-request",
    "explorer-evidence-map",
    "base-gate-catalog",
    "migration-reservation",
    "repository-adr",
    "repository-architecture",
    "current-contract-pair",
    "open-contract-findings",
    "relevant-resolved-contract-findings",
    "control-plane-situation",
  ],
  outputArtifact: "negotiating-contract-pair",
  inputOrder: {
    initial: [
      "slice-request",
      "explorer-evidence-map",
      "base-gate-catalog",
      "migration-reservation",
      "repository-context",
    ],
    revision: [
      "current-contract-pair",
      "open-contract-findings",
      "relevant-resolved-contract-findings",
      "control-plane-situation",
      "base-gate-catalog",
      "migration-reservation",
    ],
  },
  inlineSizeBudgetBytes: 65_536,
  omittedArtifactClasses: ROLE_ENVELOPE_OMISSIONS.filter(
    (artifactClass) => artifactClass !== "resolved-findings",
  ),
} as const;

export const CONTRACT_EVALUATOR_CONTEXT_MANIFEST = {
  version: 1,
  role: "evaluator-contract",
  objective:
    "Accept or reject one proposed slice contract using only declared contract evidence.",
  nonGoals: [
    "Rechecking deterministic manifest validation",
    "Reviewing implementation output",
    "Changing the proposed contract pair",
  ],
  allowedWriteScope: [
    "slice/contract-review.json",
    "slice/feedback-rN.md",
  ],
  stopConditions: [
    "The canonical review and human-readable feedback are written",
    "An unreviewable contract is returned as a blocking REVISE finding",
  ],
  acceptedInputArtifactClasses: [
    "proposed-contract-pair",
    "proposed-contract",
    "acceptance-manifest",
    "base-gate-catalog",
    "explorer-evidence-map",
    "revised-contract",
    "revised-acceptance-manifest",
    "prior-open-contract-findings",
    "planner-response",
    "contract-revision-evidence",
    "control-plane-situation",
  ],
  outputArtifact: "contract-review-pair",
  inputOrder: {
    initial: [
      "proposed-contract",
      "acceptance-manifest",
      "base-gate-catalog",
      "explorer-evidence-map",
    ],
    revision: [
      "revised-contract-pair",
      "prior-open-contract-findings",
      "planner-response",
      "contract-revision-evidence",
      "control-plane-situation",
      "base-gate-catalog",
      "explorer-evidence-map",
    ],
  },
  inlineSizeBudgetBytes: 65_536,
  omittedArtifactClasses: [
    ...ROLE_ENVELOPE_OMISSIONS,
    "generator-output",
    "cleanup-artifacts",
  ],
} as const;

export type PromptAssemblyRole =
  | "explorer"
  | "planner"
  | "evaluator-contract"
  | "generator";

export interface RoleEnvelopeEvidence {
  role: PromptAssemblyRole;
  assembledByteSize: number;
  includedArtifactClasses: string[];
  includedArtifactIds: string[];
  omittedArtifactClasses: string[];
  contextManifestVersion: number;
}

export interface RoleEnvelopeResult {
  prompt: string;
  evidence: RoleEnvelopeEvidence;
}

export interface ContextArtifactReference {
  artifactClass: string;
  artifactId: string;
}

export interface ContextEnvelopeManifest {
  version: number;
  role: PromptAssemblyRole;
  acceptedInputArtifactClasses: readonly string[];
  inlineSizeBudgetBytes: number;
  omittedArtifactClasses: readonly string[];
}

export class ContextEnvelopeConfigurationError extends Error {
  readonly failureKind = "CONFIGURATION";

  constructor(message: string) {
    super(`CONFIGURATION: ${message}`);
    this.name = "ContextEnvelopeConfigurationError";
  }
}

interface PlannerEnvelopeCommonInput {
  ghIssue: string;
  specsDir: string;
  sliceDir: string;
  round: number;
  baseGateCatalog: string;
  migrationReservation: string;
  inlineSizeBudgetBytes?: number;
}

export interface PlannerInitialEnvelopeInput
  extends PlannerEnvelopeCommonInput {
  repoRoot: string;
  sliceBody: string;
  explorerContext: string;
}

export interface PlannerRevisionEnvelopeInput
  extends PlannerEnvelopeCommonInput {
  currentContract: string;
  currentAcceptanceManifest: string;
  findings: readonly ContractReviewFinding[];
  resolvedFindings?: readonly ContractReviewFinding[];
  contractResponseInstructions: string;
  controlSituation?: string;
}

interface ContractEvaluatorEnvelopeCommonInput {
  sliceDir: string;
  round: number;
  contractReviewFile: string;
  proposedContract: string;
  acceptanceManifest: AcceptanceManifest;
  baseGateCatalog: string;
  explorerContext: string;
  inlineSizeBudgetBytes?: number;
}

export type ContractEvaluatorInitialEnvelopeInput =
  ContractEvaluatorEnvelopeCommonInput;

export interface ContractEvaluatorRevisionEnvelopeInput
  extends ContractEvaluatorEnvelopeCommonInput {
  previousFindings: readonly ContractReviewFinding[];
  plannerResponse: ContractResponse | null;
  revisions: ContractRevisionArtifacts;
  controlSituation?: string;
}

export function assertEnvelopeBudget(
  roleLabel: string,
  prompt: string,
  allowedByteSize: number,
): number {
  const assembledByteSize = Buffer.byteLength(prompt, "utf-8");
  if (assembledByteSize > allowedByteSize) {
    throw new ContextEnvelopeConfigurationError(
      `${roleLabel} prompt exceeds inline-size budget: actual ${assembledByteSize} bytes, allowed ${allowedByteSize} bytes`,
    );
  }
  return assembledByteSize;
}

export function assembleContextEnvelope(input: {
  prompt: string;
  manifest: ContextEnvelopeManifest;
  includedArtifacts: readonly ContextArtifactReference[];
  inlineSizeBudgetBytes?: number;
  roleLabel?: string;
}): RoleEnvelopeResult {
  const accepted = new Set(input.manifest.acceptedInputArtifactClasses);
  const undeclared = input.includedArtifacts.find(
    ({ artifactClass }) => !accepted.has(artifactClass),
  );
  if (undeclared !== undefined) {
    throw new ContextEnvelopeConfigurationError(
      `${input.manifest.role} context class "${undeclared.artifactClass}" is not declared by manifest version ${input.manifest.version}`,
    );
  }
  const normalizedPrompt = input.prompt.replace(/\r\n?/g, "\n");
  return {
    prompt: normalizedPrompt,
    evidence: {
      role: input.manifest.role,
      assembledByteSize: assertEnvelopeBudget(
        input.roleLabel ?? input.manifest.role,
        normalizedPrompt,
        input.inlineSizeBudgetBytes ??
          input.manifest.inlineSizeBudgetBytes,
      ),
      includedArtifactClasses: input.includedArtifacts.map(
        ({ artifactClass }) => artifactClass,
      ),
      includedArtifactIds: input.includedArtifacts.map(
        ({ artifactId }) => artifactId,
      ),
      omittedArtifactClasses: [
        ...input.manifest.omittedArtifactClasses,
      ],
      contextManifestVersion: input.manifest.version,
    },
  };
}

function artifactClassFor(
  role: PromptAssemblyRole,
  artifactId: string,
): string {
  if (role === "planner") {
    if (artifactId === "slice-request") return "slice-request";
    if (artifactId.endsWith("/context.md")) {
      return "explorer-evidence-map";
    }
    if (artifactId === "base-gate-catalog") return "base-gate-catalog";
    if (artifactId === "migration-reservation") {
      return "migration-reservation";
    }
    if (artifactId.startsWith("docs/adr/")) return "repository-adr";
    if (artifactId === "ARCHITECTURE.md") {
      return "repository-architecture";
    }
    if (artifactId === "contract-review:open-findings") {
      return "open-contract-findings";
    }
    if (artifactId === "contract-review:relevant-resolved-findings") {
      return "relevant-resolved-contract-findings";
    }
    if (artifactId === "control-plane-situation") {
      return "control-plane-situation";
    }
    return "current-contract-pair";
  }
  if (role === "evaluator-contract") {
    if (artifactId === "base-gate-catalog") return "base-gate-catalog";
    if (artifactId.endsWith("/context.md")) {
      return "explorer-evidence-map";
    }
    if (artifactId === "contract-review:prior-open-findings") {
      return "prior-open-contract-findings";
    }
    if (artifactId.endsWith("/contract-response.json")) {
      return "planner-response";
    }
    if (artifactId === "contract-revision-evidence") {
      return "contract-revision-evidence";
    }
    if (artifactId === "control-plane-situation") {
      return "control-plane-situation";
    }
    return "proposed-contract-pair";
  }
  throw new Error(`No artifact-class mapping for role ${role}`);
}

function roleEnvelopeResult(
  prompt: string,
  role: "planner" | "evaluator-contract",
  includedArtifactIds: string[],
  _omittedArtifactClasses: readonly string[],
  _contextManifestVersion: number,
  allowedByteSize: number,
  roleLabel: string,
): RoleEnvelopeResult {
  const manifest =
    role === "planner"
      ? PLANNER_CONTEXT_MANIFEST
      : CONTRACT_EVALUATOR_CONTEXT_MANIFEST;
  return assembleContextEnvelope({
    prompt,
    manifest,
    includedArtifacts: includedArtifactIds.map((artifactId) => ({
      artifactClass: artifactClassFor(role, artifactId),
      artifactId,
    })),
    inlineSizeBudgetBytes: allowedByteSize,
    roleLabel,
  });
}

export function assemblePlannerInitialEnvelope(
  input: PlannerInitialEnvelopeInput,
): RoleEnvelopeResult {
  const repositoryContext = buildExplorerRepositoryContext(input.repoRoot);
  const prompt = renderPrompt("planner", {
    GH_ISSUE: input.ghIssue,
    SPECS_DIR: input.specsDir,
    SLICE_DIR: input.sliceDir,
    ROUND: input.round,
    SLICE_BODY: input.sliceBody,
    EXPLORER_CONTEXT: input.explorerContext,
    BASE_GATE_CATALOG: input.baseGateCatalog,
    MIGRATION_RESERVATION: input.migrationReservation,
    REPOSITORY_CONTEXT: repositoryContext.content,
  });
  return roleEnvelopeResult(
    prompt,
    "planner",
    [
      "slice-request",
      `${input.sliceDir}/context.md`,
      "base-gate-catalog",
      "migration-reservation",
      ...repositoryContext.includedArtifactIds,
    ],
    PLANNER_CONTEXT_MANIFEST.omittedArtifactClasses,
    PLANNER_CONTEXT_MANIFEST.version,
    input.inlineSizeBudgetBytes ??
      PLANNER_CONTEXT_MANIFEST.inlineSizeBudgetBytes,
    "Planner",
  );
}

export function assemblePlannerRevisionEnvelope(
  input: PlannerRevisionEnvelopeInput,
): RoleEnvelopeResult {
  const openFindings = openContractReviewFindings(input.findings);
  const resolvedFindings = input.resolvedFindings ?? [];
  const prompt = renderPrompt("planner-revision", {
    GH_ISSUE: input.ghIssue,
    SPECS_DIR: input.specsDir,
    SLICE_DIR: input.sliceDir,
    ROUND: input.round,
    CURRENT_CONTRACT: input.currentContract,
    CURRENT_ACCEPTANCE_MANIFEST: input.currentAcceptanceManifest,
    OPEN_FINDINGS: formatContractReviewFindings(openFindings),
    RESOLVED_HISTORY:
      resolvedFindings.length > 0
        ? `Keep this relevant resolved history satisfied to avoid regression:\n\n${formatContractReviewFindings(resolvedFindings)}`
        : "(none)",
    CONTROL_SITUATION: input.controlSituation ?? "(none)",
    CONTRACT_RESPONSE_INSTRUCTIONS: input.contractResponseInstructions,
    BASE_GATE_CATALOG: input.baseGateCatalog,
    MIGRATION_RESERVATION: input.migrationReservation,
  });
  return roleEnvelopeResult(
    prompt,
    "planner",
    [
      `${input.sliceDir}/contract.md`,
      `${input.sliceDir}/acceptance-manifest.json`,
      ...(openFindings.length > 0 ? ["contract-review:open-findings"] : []),
      ...(resolvedFindings.length > 0
        ? ["contract-review:relevant-resolved-findings"]
        : []),
      ...(input.controlSituation !== undefined
        ? ["control-plane-situation"]
        : []),
      "base-gate-catalog",
      "migration-reservation",
    ],
    PLANNER_CONTEXT_MANIFEST.omittedArtifactClasses,
    PLANNER_CONTEXT_MANIFEST.version,
    input.inlineSizeBudgetBytes ??
      PLANNER_CONTEXT_MANIFEST.inlineSizeBudgetBytes,
    "Planner",
  );
}

export function assembleContractEvaluatorInitialEnvelope(
  input: ContractEvaluatorInitialEnvelopeInput,
): RoleEnvelopeResult {
  const prompt = renderPrompt("evaluator-contract", {
    SLICE_DIR: input.sliceDir,
    ROUND: input.round,
    CONTRACT_REVIEW_FILE: input.contractReviewFile,
    PROPOSED_CONTRACT: input.proposedContract,
    ACCEPTANCE_MANIFEST: JSON.stringify(input.acceptanceManifest, null, 2),
    BASE_GATE_CATALOG: input.baseGateCatalog,
    EXPLORER_CONTEXT: input.explorerContext,
  });
  return roleEnvelopeResult(
    prompt,
    "evaluator-contract",
    [
      `${input.sliceDir}/contract.md`,
      `${input.sliceDir}/acceptance-manifest.json`,
      "base-gate-catalog",
      `${input.sliceDir}/context.md`,
    ],
    CONTRACT_EVALUATOR_CONTEXT_MANIFEST.omittedArtifactClasses,
    CONTRACT_EVALUATOR_CONTEXT_MANIFEST.version,
    input.inlineSizeBudgetBytes ??
      CONTRACT_EVALUATOR_CONTEXT_MANIFEST.inlineSizeBudgetBytes,
    "Contract evaluator",
  );
}

export function assembleContractEvaluatorRevisionEnvelope(
  input: ContractEvaluatorRevisionEnvelopeInput,
): RoleEnvelopeResult {
  const openFindings = openContractReviewFindings(input.previousFindings);
  const prompt = renderPrompt("evaluator-contract-revision", {
    SLICE_DIR: input.sliceDir,
    ROUND: input.round,
    CONTRACT_REVIEW_FILE: input.contractReviewFile,
    REVISED_CONTRACT: input.proposedContract,
    REVISED_ACCEPTANCE_MANIFEST: JSON.stringify(
      input.acceptanceManifest,
      null,
      2,
    ),
    PRIOR_OPEN_FINDINGS: formatContractReviewFindings(openFindings),
    PLANNER_RESPONSE:
      input.plannerResponse === null
        ? "(none)"
        : JSON.stringify(input.plannerResponse, null, 2),
    REVISION_CONTEXT: JSON.stringify(input.revisions, null, 2),
    CONTROL_SITUATION: input.controlSituation ?? "(none)",
    BASE_GATE_CATALOG: input.baseGateCatalog,
    EXPLORER_CONTEXT: input.explorerContext,
  });
  return roleEnvelopeResult(
    prompt,
    "evaluator-contract",
    [
      `${input.sliceDir}/contract.md`,
      `${input.sliceDir}/acceptance-manifest.json`,
      ...(openFindings.length > 0
        ? ["contract-review:prior-open-findings"]
        : []),
      ...(input.plannerResponse !== null
        ? [`${input.sliceDir}/contract-response.json`]
        : []),
      "contract-revision-evidence",
      ...(input.controlSituation !== undefined
        ? ["control-plane-situation"]
        : []),
      "base-gate-catalog",
      `${input.sliceDir}/context.md`,
    ],
    CONTRACT_EVALUATOR_CONTEXT_MANIFEST.omittedArtifactClasses,
    CONTRACT_EVALUATOR_CONTEXT_MANIFEST.version,
    input.inlineSizeBudgetBytes ??
      CONTRACT_EVALUATOR_CONTEXT_MANIFEST.inlineSizeBudgetBytes,
    "Contract evaluator",
  );
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
  const includedArtifacts: ContextArtifactReference[] = [
    {
      artifactClass: "contract-view",
      artifactId: `${input.sliceDir}/contract.md`,
    },
    {
      artifactClass: "acceptance-manifest",
      artifactId: `${input.sliceDir}/acceptance-manifest.json`,
    },
    {
      artifactClass: "file-scope",
      artifactId: "acceptance-manifest:file-scope",
    },
    ...(input.patternsAndHarnessArtifactId === null
      ? []
      : [{
          artifactClass: "patterns-and-harness",
          artifactId:
            input.patternsAndHarnessArtifactId ??
            `${input.sliceDir}/context.md`,
        }]),
    {
      artifactClass: "verification-command",
      artifactId: "generator:test-command",
    },
    {
      artifactClass: "migration-reservation",
      artifactId: "migration-reservation",
    },
    {
      artifactClass: "failure-set",
      artifactId: "generator:failure-set",
    },
    ...(input.repairSituation === undefined
      ? []
      : [{
          artifactClass: "repair-situation",
          artifactId: "generator:repair-situation",
        }]),
    ...(input.additionalArtifactIds ?? []).map((artifactId) => ({
      artifactClass: "repair-context",
      artifactId,
    })),
    ...input.failureSet.findings.flatMap((finding) =>
      finding.artifactReferences.map((artifactId) => ({
        artifactClass: "finding-evidence",
        artifactId,
      })),
    ),
    ...input.failureSet.gates.flatMap((gate) =>
      gate.evidence.map((artifactId) => ({
        artifactClass: "gate-evidence",
        artifactId,
      })),
    ),
  ];
  const deduplicatedArtifacts = includedArtifacts.filter(
    (artifact, index) =>
      includedArtifacts.findIndex(
        (candidate) =>
          candidate.artifactClass === artifact.artifactClass &&
          candidate.artifactId === artifact.artifactId,
      ) === index,
  );

  return assembleContextEnvelope({
    prompt,
    manifest: GENERATOR_CONTEXT_MANIFEST,
    includedArtifacts: deduplicatedArtifacts,
    inlineSizeBudgetBytes: input.inlineSizeBudgetBytes,
    roleLabel: "Generator",
  }) as GeneratorEnvelopeResult;
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

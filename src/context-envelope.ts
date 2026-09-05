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
  nonGoals: [
    "Making design recommendations",
    "Editing any file other than the evidence map",
    "Asserting uncited claims instead of recording them as unknowns",
  ],
  allowedWriteScope: "slice/context.md",
  stopConditions: [
    "slice/context.md contains a valid evidence map with the required section structure",
  ],
  escalationConditions: [
    "A factual claim cannot be cited with a path, symbol, or command; it is recorded under Unknowns instead of asserted",
  ],
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
  inputOrderSlots: {
    "slice-request": "slice-inputs",
    "repository-adr": "repository-context",
    "repository-architecture": "repository-context",
  },
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
} as const satisfies ContextEnvelopeManifest;

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
  inlineSizeBudgetBytes: 65_536,
  omittedArtifactClasses: [
    "resolved-findings",
    "passing-logs",
    "prior-conversation",
    "other-role-conversation",
    "sibling-handoffs",
    "full-adr-bodies",
  ],
} as const satisfies ContextEnvelopeManifest;

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
    INLINE_SIZE_BUDGET_BYTES: Math.min(
      input.inlineSizeBudgetBytes ??
        EXPLORER_CONTEXT_MANIFEST.inlineSizeBudgetBytes,
      EXPLORER_CONTEXT_MANIFEST.inlineSizeBudgetBytes,
    ),
  });
  return assembleContextEnvelope({
    prompt,
    manifest: EXPLORER_CONTEXT_MANIFEST,
    includedArtifacts: [
      {
        artifactClass: "slice-request",
        artifactId: `issue:${input.ghIssue}`,
        ...contentLocator(input.sliceBody),
      },
      ...repositoryContext.includedArtifactIds.map((artifactId) => ({
        artifactClass: artifactId.startsWith("docs/adr/")
          ? "repository-adr"
          : "repository-architecture",
        artifactId,
        ...contentLocator(repositoryArtifactLocator(artifactId)),
      })),
    ],
    inlineSizeBudgetBytes: input.inlineSizeBudgetBytes,
    roleLabel: "Explorer",
  }) as ExplorerEnvelopeResult;
}

/**
 * Anchor for a repository-context artifact inside the rendered prompt: the
 * backticked ADR path from the ADR-index line, or the ARCHITECTURE.md block
 * heading.
 */
function repositoryArtifactLocator(artifactId: string): string {
  return artifactId.startsWith("docs/adr/")
    ? `(\`${artifactId}\`)`
    : "## ARCHITECTURE.md";
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
  escalationConditions: [
    "The specification contradicts itself, including a recorded ADR",
    "The specification is silent on a load-bearing decision",
    "The specification declares the decision as a risk",
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
      "control-plane-situation",
      "base-gate-catalog",
      "migration-reservation",
    ],
  },
  inputOrderSlots: {
    "repository-adr": "repository-context",
    "repository-architecture": "repository-context",
  },
  inlineSizeBudgetBytes: 65_536,
  omittedArtifactClasses: ROLE_ENVELOPE_OMISSIONS,
} as const satisfies ContextEnvelopeManifest;

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
  escalationConditions: [
    "The contract pair cannot be reviewed as submitted; it is rejected with a blocking REVISE finding rather than judged on reconstructed evidence",
  ],
  acceptedInputArtifactClasses: [
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
      "revised-contract",
      "revised-acceptance-manifest",
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
} as const satisfies ContextEnvelopeManifest;

/**
 * Candidate-evaluator (deterministic QA) role contract. Manifest-only for
 * now: the candidate QA prompt is still rendered directly by the
 * orchestrator, so nothing assembles an envelope from this entry yet. The
 * manifest exists so the versioned schema carries the complete deferred role
 * contract; it is validated by the same completeness checks as every other
 * registered manifest.
 *
 * Include/exclude contract (guardian round 2, architect A3):
 * - `docs/specs/afk-v2-agent-roles.md` M7 excludes `handoff.md` from every
 *   reviewer input ("judge the tree, not the author's story"), so no
 *   candidate or dependency-sibling handoff class is accepted; both are
 *   deliberate omissions.
 * - `docs/specs/afk-v2-plan.md` §3 item 5 leads the candidate evaluator's
 *   envelope with the slice diff change summary plus the acceptance
 *   manifest.
 * - `docs/specs/afk-v2-agent-roles.md` §1 routes explorer evidence into the
 *   candidate evaluator's include list as sections — evaluators get the
 *   behavior and preservation evidence.
 */
export const CANDIDATE_EVALUATOR_CONTEXT_MANIFEST = {
  version: 1,
  role: "evaluator-qa",
  objective:
    "Independently judge one committed candidate's observable behavior against the locked slice contract and record a canonical verdict.",
  nonGoals: [
    "Implementing or repairing the candidate",
    "Running the project's full test suite instead of the assigned command set",
    "Reconstructing findings from prior reports or the other QA stage",
    "Amending the locked file list directly",
  ],
  allowedWriteScope: [
    "slice/qa-review.json",
    "slice/qa-report.md",
  ],
  stopConditions: [
    "The canonical verdict artifact and the human-readable report are written with exactly one verdict and one failure class",
    "Pass 2 is skipped whenever Pass 1 is not clean",
  ],
  escalationConditions: [
    "Direct evidence shows a failure source changes cannot fix; it is classified INFRASTRUCTURE instead of a code finding",
    "A correct, necessary change is outside the declared file list; it is reported as a SCOPE_AMENDMENT finding for the orchestrator",
  ],
  acceptedInputArtifactClasses: [
    "change-summary",
    "acceptance-manifest",
    "qa-scope",
    "locked-contract",
    "explorer-preservation-evidence",
    "cited-adr",
    "unresolved-qa-findings",
    "sanity-command-set",
    "base-gate-authorization",
  ],
  outputArtifact: "qa-review-pair",
  inputOrder: [
    "change-summary",
    "acceptance-manifest",
    "qa-scope",
    "locked-contract",
    "explorer-preservation-evidence",
    "cited-adr",
    "unresolved-qa-findings",
    "sanity-command-set",
    "base-gate-authorization",
  ],
  inlineSizeBudgetBytes: 65_536,
  omittedArtifactClasses: [
    ...ROLE_ENVELOPE_OMISSIONS,
    "candidate-handoff",
    "dependency-sibling-handoffs",
    "planner-conversation",
    "generator-conversation",
    "other-qa-stage-findings",
  ],
} as const satisfies ContextEnvelopeManifest;

export type PromptAssemblyRole =
  | "explorer"
  | "planner"
  | "evaluator-contract"
  | "generator";

/**
 * Roles that carry a versioned context-envelope manifest. A superset of
 * PromptAssemblyRole: "evaluator-qa" (candidate evaluator) has a
 * manifest-only role contract today — its prompt is still rendered directly
 * by the orchestrator, so no assembly path consumes it yet.
 */
export type ContextEnvelopeRole = PromptAssemblyRole | "evaluator-qa";

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
  /**
   * Exact substring of the rendered prompt that anchors this artifact's
   * block. Assembly verifies the anchors appear in the manifest's declared
   * input order (guardian round 2, architect A3) and fails closed as
   * CONFIGURATION on a mismatch before any evidence is emitted.
   */
  locator?: string;
  /**
   * Explicit reason this artifact's block cannot be located in the rendered
   * prompt (e.g. it travels by reference only). Exemption is deliberate and
   * recorded, never silent; mutually exclusive with `locator`.
   */
  locatorExemption?: string;
}

/**
 * Builds the locator field for an artifact whose rendered block is the given
 * interpolated content. Blank content is exempted explicitly (there is
 * nothing to locate), never silently skipped.
 */
function contentLocator(
  content: string,
): { locator: string } | { locatorExemption: string } {
  return content.trim() === ""
    ? {
        locatorExemption:
          "interpolated content is blank; nothing to locate in the rendered prompt",
      }
    : { locator: content };
}

/**
 * Verifies the rendered prompt presents each located artifact's block in the
 * manifest's declared input order. The scan is sequential: each locator must
 * appear at or after the previous located artifact's anchor position, so a
 * prompt whose blocks are rendered out of manifest order fails closed as
 * CONFIGURATION before the envelope's evidence is emitted (guardian round 2,
 * architect A3).
 */
function validateRenderedBlockOrder(
  role: string,
  normalizedPrompt: string,
  orderedArtifacts: readonly ContextArtifactReference[],
): void {
  let cursor = 0;
  let previous: ContextArtifactReference | undefined;
  for (const artifact of orderedArtifacts) {
    if (
      artifact.locator !== undefined &&
      artifact.locatorExemption !== undefined
    ) {
      throw new ContextEnvelopeConfigurationError(
        `${role} artifact "${artifact.artifactId}" (${artifact.artifactClass}) declares both a locator and a locator exemption`,
      );
    }
    if (artifact.locatorExemption !== undefined) {
      if (artifact.locatorExemption.trim() === "") {
        throw new ContextEnvelopeConfigurationError(
          `${role} artifact "${artifact.artifactId}" (${artifact.artifactClass}) declares a blank locator exemption; exemption must state a reason`,
        );
      }
      continue;
    }
    if (artifact.locator === undefined) continue;
    const locator = artifact.locator.replace(/\r\n?/g, "\n");
    if (locator.trim() === "") {
      throw new ContextEnvelopeConfigurationError(
        `${role} artifact "${artifact.artifactId}" (${artifact.artifactClass}) declares a blank locator; use an explicit locator exemption instead`,
      );
    }
    const index = normalizedPrompt.indexOf(locator, cursor);
    if (index === -1) {
      if (normalizedPrompt.includes(locator)) {
        throw new ContextEnvelopeConfigurationError(
          `${role} rendered prompt places artifact "${artifact.artifactId}" (${artifact.artifactClass}) before "${previous!.artifactId}" (${previous!.artifactClass}), violating the manifest's declared input order`,
        );
      }
      throw new ContextEnvelopeConfigurationError(
        `${role} artifact "${artifact.artifactId}" (${artifact.artifactClass}) locator was not found in the rendered prompt`,
      );
    }
    cursor = index;
    previous = artifact;
  }
}

/**
 * Ordered input slots for the assembled envelope. Either a single ordered
 * list, or one ordered list per assembly variant (e.g. initial vs. repair).
 */
export type ContextEnvelopeInputOrder =
  | readonly string[]
  | Readonly<Record<string, readonly string[]>>;

/**
 * The authoritative, versioned role contract. Every registered role manifest
 * declares the complete contract — objective, non-goals, write scope, stop
 * and escalation conditions, accepted input artifact classes, output
 * contract, input order, and invocation budget — and assembly validates
 * against it rather than against parallel hand-maintained objects.
 */
export interface ContextEnvelopeManifest {
  version: number;
  role: ContextEnvelopeRole;
  /** What the role exists to produce. */
  objective: string;
  /** What the role must not do. */
  nonGoals: readonly string[];
  /** The only paths or scopes the role may write. */
  allowedWriteScope: string | readonly string[];
  /** Conditions under which the role stops. */
  stopConditions: readonly string[];
  /** Conditions the role escalates instead of deciding itself. */
  escalationConditions: readonly string[];
  /** The only artifact classes assembly may include. */
  acceptedInputArtifactClasses: readonly string[];
  /** The output contract: the artifact the role is required to produce. */
  outputArtifact: string;
  /** The declared input order assembly validates included artifacts against. */
  inputOrder: ContextEnvelopeInputOrder;
  /**
   * Maps an accepted artifact class onto the inputOrder slot it occupies when
   * the slot name differs from the class name (e.g. both "repository-adr"
   * and "repository-architecture" occupy the "repository-context" slot).
   */
  inputOrderSlots?: Readonly<Record<string, string>>;
  /** The manifest invocation budget; project overrides may only tighten it. */
  inlineSizeBudgetBytes: number;
  /** Artifact classes deliberately withheld from the role. */
  omittedArtifactClasses: readonly string[];
}

function requireNonBlank(
  role: string,
  field: string,
  value: string,
): void {
  if (value.trim() === "") {
    throw new ContextEnvelopeConfigurationError(
      `${role} manifest field "${field}" must be a nonblank string`,
    );
  }
}

function requireNonEmptyList(
  role: string,
  field: string,
  values: readonly string[],
): void {
  if (values.length === 0) {
    throw new ContextEnvelopeConfigurationError(
      `${role} manifest field "${field}" must declare at least one entry`,
    );
  }
  values.forEach((value, index) =>
    requireNonBlank(role, `${field}[${index}]`, value),
  );
}

function inputOrderLists(
  inputOrder: ContextEnvelopeInputOrder,
): readonly (readonly string[])[] {
  return Array.isArray(inputOrder)
    ? [inputOrder as readonly string[]]
    : Object.values(
        inputOrder as Readonly<Record<string, readonly string[]>>,
      );
}

/**
 * Validates that a role manifest declares the complete role contract.
 * Assembly runs this on every envelope so an incomplete manifest fails
 * closed as CONFIGURATION before dispatch.
 */
export function validateContextEnvelopeManifest(
  manifest: ContextEnvelopeManifest,
): void {
  const role = manifest.role;
  if (!Number.isInteger(manifest.version) || manifest.version < 1) {
    throw new ContextEnvelopeConfigurationError(
      `${role} manifest version must be a positive integer`,
    );
  }
  requireNonBlank(role, "objective", manifest.objective);
  requireNonEmptyList(role, "nonGoals", manifest.nonGoals);
  if (typeof manifest.allowedWriteScope === "string") {
    requireNonBlank(role, "allowedWriteScope", manifest.allowedWriteScope);
  } else {
    requireNonEmptyList(role, "allowedWriteScope", manifest.allowedWriteScope);
  }
  requireNonEmptyList(role, "stopConditions", manifest.stopConditions);
  requireNonEmptyList(
    role,
    "escalationConditions",
    manifest.escalationConditions,
  );
  requireNonEmptyList(
    role,
    "acceptedInputArtifactClasses",
    manifest.acceptedInputArtifactClasses,
  );
  requireNonBlank(role, "outputArtifact", manifest.outputArtifact);
  const orderLists = inputOrderLists(manifest.inputOrder);
  if (orderLists.length === 0) {
    throw new ContextEnvelopeConfigurationError(
      `${role} manifest field "inputOrder" must declare at least one ordered list`,
    );
  }
  orderLists.forEach((list, index) =>
    requireNonEmptyList(role, `inputOrder[${index}]`, list),
  );
  const orderedSlots = new Set(orderLists.flat());
  const accepted = new Set(manifest.acceptedInputArtifactClasses);
  for (const [artifactClass, slot] of Object.entries(
    manifest.inputOrderSlots ?? {},
  )) {
    if (!accepted.has(artifactClass)) {
      throw new ContextEnvelopeConfigurationError(
        `${role} manifest inputOrderSlots maps undeclared class "${artifactClass}"`,
      );
    }
    if (!orderedSlots.has(slot)) {
      throw new ContextEnvelopeConfigurationError(
        `${role} manifest inputOrderSlots maps "${artifactClass}" to slot "${slot}" absent from inputOrder`,
      );
    }
  }
  const slotFor = manifest.inputOrderSlots ?? {};
  for (const artifactClass of manifest.acceptedInputArtifactClasses) {
    if (!orderedSlots.has(slotFor[artifactClass] ?? artifactClass)) {
      throw new ContextEnvelopeConfigurationError(
        `${role} manifest accepted class "${artifactClass}" has no inputOrder slot`,
      );
    }
  }
  if (
    !Number.isInteger(manifest.inlineSizeBudgetBytes) ||
    manifest.inlineSizeBudgetBytes <= 0
  ) {
    throw new ContextEnvelopeConfigurationError(
      `${role} manifest inlineSizeBudgetBytes must be a positive integer`,
    );
  }
  requireNonEmptyList(
    role,
    "omittedArtifactClasses",
    manifest.omittedArtifactClasses,
  );
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

function resolveInputOrder(
  manifest: ContextEnvelopeManifest,
  inputOrderKey: string | undefined,
): readonly string[] {
  if (Array.isArray(manifest.inputOrder)) {
    return manifest.inputOrder as readonly string[];
  }
  const variants = manifest.inputOrder as Readonly<
    Record<string, readonly string[]>
  >;
  if (inputOrderKey === undefined) {
    throw new ContextEnvelopeConfigurationError(
      `${manifest.role} manifest declares input-order variants (${Object.keys(variants).join(", ")}); assembly must name one`,
    );
  }
  const order = variants[inputOrderKey];
  if (order === undefined) {
    throw new ContextEnvelopeConfigurationError(
      `${manifest.role} manifest declares no input-order variant "${inputOrderKey}"`,
    );
  }
  return order;
}

export function assembleContextEnvelope(input: {
  prompt: string;
  /** Only assembly-wired roles; the evaluator-qa manifest is manifest-only. */
  manifest: ContextEnvelopeManifest & { role: PromptAssemblyRole };
  includedArtifacts: readonly ContextArtifactReference[];
  /** Names the manifest input-order variant when the manifest declares more than one. */
  inputOrderKey?: string;
  /**
   * Project byte-budget override. Overrides are stricter-only: the effective
   * budget is min(override, manifest budget), so an override larger than the
   * manifest budget is silently clamped to the manifest budget.
   */
  inlineSizeBudgetBytes?: number;
  roleLabel?: string;
}): RoleEnvelopeResult {
  validateContextEnvelopeManifest(input.manifest);
  const accepted = new Set(input.manifest.acceptedInputArtifactClasses);
  const undeclared = input.includedArtifacts.find(
    ({ artifactClass }) => !accepted.has(artifactClass),
  );
  if (undeclared !== undefined) {
    throw new ContextEnvelopeConfigurationError(
      `${input.manifest.role} context class "${undeclared.artifactClass}" is not declared by manifest version ${input.manifest.version}`,
    );
  }
  const order = resolveInputOrder(input.manifest, input.inputOrderKey);
  const slots = input.manifest.inputOrderSlots ?? {};
  const rank = (artifactClass: string): number =>
    order.indexOf(slots[artifactClass] ?? artifactClass);
  const unordered = input.includedArtifacts.find(
    ({ artifactClass }) => rank(artifactClass) === -1,
  );
  if (unordered !== undefined) {
    throw new ContextEnvelopeConfigurationError(
      `${input.manifest.role} context class "${unordered.artifactClass}" has no slot in the declared input order${input.inputOrderKey === undefined ? "" : ` variant "${input.inputOrderKey}"`}`,
    );
  }
  const orderedArtifacts = input.includedArtifacts
    .map((artifact, index) => ({ artifact, index }))
    .sort(
      (left, right) =>
        rank(left.artifact.artifactClass) -
          rank(right.artifact.artifactClass) || left.index - right.index,
    )
    .map(({ artifact }) => artifact);
  const effectiveBudget = Math.min(
    input.inlineSizeBudgetBytes ?? input.manifest.inlineSizeBudgetBytes,
    input.manifest.inlineSizeBudgetBytes,
  );
  const normalizedPrompt = input.prompt.replace(/\r\n?/g, "\n");
  validateRenderedBlockOrder(
    input.roleLabel ?? input.manifest.role,
    normalizedPrompt,
    orderedArtifacts,
  );
  return {
    prompt: normalizedPrompt,
    evidence: {
      role: input.manifest.role,
      assembledByteSize: assertEnvelopeBudget(
        input.roleLabel ?? input.manifest.role,
        normalizedPrompt,
        effectiveBudget,
      ),
      includedArtifactClasses: orderedArtifacts.map(
        ({ artifactClass }) => artifactClass,
      ),
      includedArtifactIds: orderedArtifacts.map(
        ({ artifactId }) => artifactId,
      ),
      omittedArtifactClasses: [
        ...input.manifest.omittedArtifactClasses,
      ],
      contextManifestVersion: input.manifest.version,
    },
  };
}

function roleEnvelopeResult(
  prompt: string,
  role: "planner" | "evaluator-contract",
  inputOrderKey: "initial" | "revision",
  includedArtifacts: readonly ContextArtifactReference[],
  inlineSizeBudgetBytes: number | undefined,
  roleLabel: string,
): RoleEnvelopeResult {
  const manifest =
    role === "planner"
      ? PLANNER_CONTEXT_MANIFEST
      : CONTRACT_EVALUATOR_CONTEXT_MANIFEST;
  return assembleContextEnvelope({
    prompt,
    manifest,
    includedArtifacts,
    inputOrderKey,
    ...(inlineSizeBudgetBytes === undefined ? {} : { inlineSizeBudgetBytes }),
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
    "initial",
    [
      {
        artifactClass: "slice-request",
        artifactId: "slice-request",
        ...contentLocator(input.sliceBody),
      },
      {
        artifactClass: "explorer-evidence-map",
        artifactId: `${input.sliceDir}/context.md`,
        ...contentLocator(input.explorerContext),
      },
      {
        artifactClass: "base-gate-catalog",
        artifactId: "base-gate-catalog",
        ...contentLocator(input.baseGateCatalog),
      },
      {
        artifactClass: "migration-reservation",
        artifactId: "migration-reservation",
        ...contentLocator(input.migrationReservation),
      },
      ...repositoryContext.includedArtifactIds.map((artifactId) => ({
        artifactClass: artifactId.startsWith("docs/adr/")
          ? "repository-adr"
          : "repository-architecture",
        artifactId,
        ...contentLocator(repositoryArtifactLocator(artifactId)),
      })),
    ],
    input.inlineSizeBudgetBytes,
    "Planner",
  );
}

export function assemblePlannerRevisionEnvelope(
  input: PlannerRevisionEnvelopeInput,
): RoleEnvelopeResult {
  const openFindings = openContractReviewFindings(input.findings);
  const formattedOpenFindings = formatContractReviewFindings(openFindings);
  const prompt = renderPrompt("planner-revision", {
    GH_ISSUE: input.ghIssue,
    SPECS_DIR: input.specsDir,
    SLICE_DIR: input.sliceDir,
    ROUND: input.round,
    CURRENT_CONTRACT: input.currentContract,
    CURRENT_ACCEPTANCE_MANIFEST: input.currentAcceptanceManifest,
    OPEN_FINDINGS: formattedOpenFindings,
    RESOLVED_HISTORY: "(none)",
    CONTROL_SITUATION: input.controlSituation ?? "(none)",
    CONTRACT_RESPONSE_INSTRUCTIONS: input.contractResponseInstructions,
    BASE_GATE_CATALOG: input.baseGateCatalog,
    MIGRATION_RESERVATION: input.migrationReservation,
  });
  return roleEnvelopeResult(
    prompt,
    "planner",
    "revision",
    [
      {
        artifactClass: "current-contract-pair",
        artifactId: `${input.sliceDir}/contract.md`,
        ...contentLocator(input.currentContract),
      },
      {
        artifactClass: "current-contract-pair",
        artifactId: `${input.sliceDir}/acceptance-manifest.json`,
        ...contentLocator(input.currentAcceptanceManifest),
      },
      ...(openFindings.length > 0
        ? [{
            artifactClass: "open-contract-findings",
            artifactId: "contract-review:open-findings",
            ...contentLocator(formattedOpenFindings),
          }]
        : []),
      ...(input.controlSituation !== undefined
        ? [{
            artifactClass: "control-plane-situation",
            artifactId: "control-plane-situation",
            ...contentLocator(input.controlSituation),
          }]
        : []),
      {
        artifactClass: "base-gate-catalog",
        artifactId: "base-gate-catalog",
        ...contentLocator(input.baseGateCatalog),
      },
      {
        artifactClass: "migration-reservation",
        artifactId: "migration-reservation",
        ...contentLocator(input.migrationReservation),
      },
    ],
    input.inlineSizeBudgetBytes,
    "Planner",
  );
}

export function assembleContractEvaluatorInitialEnvelope(
  input: ContractEvaluatorInitialEnvelopeInput,
): RoleEnvelopeResult {
  const renderedAcceptanceManifest = JSON.stringify(
    input.acceptanceManifest,
    null,
    2,
  );
  const prompt = renderPrompt("evaluator-contract", {
    SLICE_DIR: input.sliceDir,
    ROUND: input.round,
    CONTRACT_REVIEW_FILE: input.contractReviewFile,
    PROPOSED_CONTRACT: input.proposedContract,
    ACCEPTANCE_MANIFEST: renderedAcceptanceManifest,
    BASE_GATE_CATALOG: input.baseGateCatalog,
    EXPLORER_CONTEXT: input.explorerContext,
  });
  return roleEnvelopeResult(
    prompt,
    "evaluator-contract",
    "initial",
    [
      {
        artifactClass: "proposed-contract",
        artifactId: `${input.sliceDir}/contract.md`,
        ...contentLocator(input.proposedContract),
      },
      {
        artifactClass: "acceptance-manifest",
        artifactId: `${input.sliceDir}/acceptance-manifest.json`,
        ...contentLocator(renderedAcceptanceManifest),
      },
      {
        artifactClass: "base-gate-catalog",
        artifactId: "base-gate-catalog",
        ...contentLocator(input.baseGateCatalog),
      },
      {
        artifactClass: "explorer-evidence-map",
        artifactId: `${input.sliceDir}/context.md`,
        ...contentLocator(input.explorerContext),
      },
    ],
    input.inlineSizeBudgetBytes,
    "Contract evaluator",
  );
}

export function assembleContractEvaluatorRevisionEnvelope(
  input: ContractEvaluatorRevisionEnvelopeInput,
): RoleEnvelopeResult {
  const openFindings = openContractReviewFindings(input.previousFindings);
  const formattedPriorOpenFindings =
    formatContractReviewFindings(openFindings);
  const renderedAcceptanceManifest = JSON.stringify(
    input.acceptanceManifest,
    null,
    2,
  );
  const renderedPlannerResponse =
    input.plannerResponse === null
      ? "(none)"
      : JSON.stringify(input.plannerResponse, null, 2);
  const renderedRevisionContext = JSON.stringify(input.revisions, null, 2);
  const prompt = renderPrompt("evaluator-contract-revision", {
    SLICE_DIR: input.sliceDir,
    ROUND: input.round,
    CONTRACT_REVIEW_FILE: input.contractReviewFile,
    REVISED_CONTRACT: input.proposedContract,
    REVISED_ACCEPTANCE_MANIFEST: renderedAcceptanceManifest,
    PRIOR_OPEN_FINDINGS: formattedPriorOpenFindings,
    PLANNER_RESPONSE: renderedPlannerResponse,
    REVISION_CONTEXT: renderedRevisionContext,
    CONTROL_SITUATION: input.controlSituation ?? "(none)",
    BASE_GATE_CATALOG: input.baseGateCatalog,
    EXPLORER_CONTEXT: input.explorerContext,
  });
  return roleEnvelopeResult(
    prompt,
    "evaluator-contract",
    "revision",
    [
      {
        artifactClass: "revised-contract",
        artifactId: `${input.sliceDir}/contract.md`,
        ...contentLocator(input.proposedContract),
      },
      {
        artifactClass: "revised-acceptance-manifest",
        artifactId: `${input.sliceDir}/acceptance-manifest.json`,
        ...contentLocator(renderedAcceptanceManifest),
      },
      ...(openFindings.length > 0
        ? [{
            artifactClass: "prior-open-contract-findings",
            artifactId: "contract-review:prior-open-findings",
            ...contentLocator(formattedPriorOpenFindings),
          }]
        : []),
      ...(input.plannerResponse !== null
        ? [{
            artifactClass: "planner-response",
            artifactId: `${input.sliceDir}/contract-response.json`,
            ...contentLocator(renderedPlannerResponse),
          }]
        : []),
      {
        artifactClass: "contract-revision-evidence",
        artifactId: "contract-revision-evidence",
        ...contentLocator(renderedRevisionContext),
      },
      ...(input.controlSituation !== undefined
        ? [{
            artifactClass: "control-plane-situation",
            artifactId: "control-plane-situation",
            ...contentLocator(input.controlSituation),
          }]
        : []),
      {
        artifactClass: "base-gate-catalog",
        artifactId: "base-gate-catalog",
        ...contentLocator(input.baseGateCatalog),
      },
      {
        artifactClass: "explorer-evidence-map",
        artifactId: `${input.sliceDir}/context.md`,
        ...contentLocator(input.explorerContext),
      },
    ],
    input.inlineSizeBudgetBytes,
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
  const renderedAcceptanceManifest = JSON.stringify(
    input.acceptanceManifest,
    null,
    2,
  );
  const commonArgs = {
    SLICE_DIR: input.sliceDir,
    FILE_SCOPE: fileScope,
    MIGRATION_RESERVATION: input.migrationReservation,
    CONTRACT_VIEW: input.contractView,
    ACCEPTANCE_MANIFEST: renderedAcceptanceManifest,
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
      artifactClass: "file-scope",
      artifactId: "acceptance-manifest:file-scope",
      ...contentLocator(fileScope),
    },
    {
      artifactClass: "migration-reservation",
      artifactId: "migration-reservation",
      ...contentLocator(input.migrationReservation),
    },
    ...(input.repairSituation === undefined
      ? []
      : [{
          artifactClass: "repair-situation",
          artifactId: "generator:repair-situation",
          ...contentLocator(input.repairSituation),
        }]),
    ...(input.additionalArtifactIds ?? []).map((artifactId) => ({
      artifactClass: "repair-context",
      artifactId,
      locatorExemption:
        "repair-context artifacts travel by reference; only the repair situation inlines content",
    })),
    {
      artifactClass: "contract-view",
      artifactId: `${input.sliceDir}/contract.md`,
      ...contentLocator(input.contractView),
    },
    {
      artifactClass: "acceptance-manifest",
      artifactId: `${input.sliceDir}/acceptance-manifest.json`,
      ...contentLocator(renderedAcceptanceManifest),
    },
    {
      artifactClass: "verification-command",
      artifactId: "generator:test-command",
      ...contentLocator(input.testCommand),
    },
    ...(input.patternsAndHarnessArtifactId === null
      ? []
      : [{
          artifactClass: "patterns-and-harness",
          artifactId:
            input.patternsAndHarnessArtifactId ??
            `${input.sliceDir}/context.md`,
          ...contentLocator(input.patternsAndHarness),
        }]),
    {
      artifactClass: "failure-set",
      artifactId: "generator:failure-set",
      ...contentLocator(failureSet),
    },
    ...input.failureSet.findings.flatMap((finding) =>
      finding.artifactReferences.map((artifactId) => ({
        artifactClass: "finding-evidence",
        artifactId,
        ...contentLocator(`\`${artifactId}\``),
      })),
    ),
    ...input.failureSet.gates.flatMap((gate) =>
      gate.evidence.map((artifactId) => ({
        artifactClass: "gate-evidence",
        artifactId,
        ...contentLocator(`\`${artifactId}\``),
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
    inputOrderKey: input.mode,
    ...(input.inlineSizeBudgetBytes === undefined
      ? {}
      : { inlineSizeBudgetBytes: input.inlineSizeBudgetBytes }),
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

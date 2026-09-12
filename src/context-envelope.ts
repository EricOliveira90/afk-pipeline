import {
  ACCEPTANCE_MANIFEST_FILENAME,
  type AcceptanceManifest,
  type AcceptanceManifestV2,
} from "./acceptance-manifest.js";
import { renderContractRevisionEvidence } from "./contract-revision-evidence.js";
import {
  activeContractReviewFindings,
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
  allowedWriteScope: [
    "acceptance-manifest.fileScope",
    "slice-dir/handoff.md",
    "slice-dir/escalation.md (only when escalating an undeclared path)",
  ],
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
    "slice/planner-escalation.md instead of the pair when an escalation condition fires",
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
    // `open-contract-findings` appears in the initial order too: a restart
    // renegotiates from base while durable lineage survives, so round 1 can
    // carry open findings the review will be refused for omitting (#178).
    initial: [
      "slice-request",
      "open-contract-findings",
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
      "repository-context",
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
    "explorer-behavior-preservation",
    "revised-contract",
    "revised-acceptance-manifest",
    "prior-open-contract-findings",
    "planner-response",
    "contract-revision-evidence",
    "control-plane-situation",
  ],
  outputArtifact: "contract-review-pair",
  inputOrder: {
    // The initial order carries two classes the first round can still need:
    // durable open findings from an earlier attempt's lineage, which this
    // review must disposition or be refused (#178), and a control-plane
    // situation, which is how a refused artifact's exact validation error
    // reaches the repair pass (ADR 0061).
    initial: [
      "proposed-contract",
      "acceptance-manifest",
      "prior-open-contract-findings",
      "control-plane-situation",
      "base-gate-catalog",
      "explorer-behavior-preservation",
    ],
    revision: [
      "revised-contract",
      "revised-acceptance-manifest",
      "prior-open-contract-findings",
      "planner-response",
      "contract-revision-evidence",
      "control-plane-situation",
      "base-gate-catalog",
      "explorer-behavior-preservation",
    ],
  },
  inlineSizeBudgetBytes: 65_536,
  omittedArtifactClasses: [
    ...ROLE_ENVELOPE_OMISSIONS,
    "generator-output",
    "cleanup-artifacts",
    // docs/specs/afk-v2-agent-roles.md §1: evaluators get the behavior and
    // preservation evidence only. The explorer map's other level-2 sections
    // are deliberately withheld and declared here so the omission is honest.
    "explorer-patterns-and-harness",
    "explorer-data-and-integration",
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
 * Reshaped in place by slice 03 (#91 AC4/AC9) rather than replaced. The role
 * now reads a disposable worktree at the candidate checkpoint instead of the
 * generator's worktree, and `allowedWriteScope` below is the *instruction* it
 * is given there — the enforcement surface is the copy-back allowlist
 * (`QA_WINDOW_ARTIFACT_NAME`), which discards everything else. Four
 * properties are load-bearing and stay put: the role ID, `outputArtifact`
 * (D9 introduces no second candidate verdict artifact name),
 * `allowedWriteScope`'s two canonical artifacts, and `change-summary` first
 * in `inputOrder` — the orchestrator now generates that summary from git
 * before the invocation, so leading with it is a promise the pipeline keeps.
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

/**
 * Final-evaluator role contract (#96 B-06, PRD D9).
 *
 * The third reviewer, and the only one that runs *after* an approval: its
 * subject is not "is this candidate good" — that verdict already exists — but
 * "is the tree about to merge still the tree that was approved". So it is
 * given exactly two questions (`prompts/evaluator-final.md`) and exactly two
 * artifacts to write. `allowedWriteScope` is the instruction; the enforcement
 * surface is the same copy-back allowlist as the other two stages
 * (`QA_WINDOW_ARTIFACT_NAME`, #96 B-07), which discards everything else.
 *
 * `change-summary` leads `inputOrder` for the same reason it does on the
 * candidate evaluator, and here it is load-bearing rather than merely
 * conventional: the baseline → final variant with its per-stage attribution
 * (#96 B-04) *is* the question, so anything read before it would be read
 * without knowing what changed.
 *
 * Manifest-only, like the candidate evaluator: no assembly path consumes it
 * yet, and the completeness checks validate it all the same.
 */
export const FINAL_EVALUATOR_CONTEXT_MANIFEST = {
  version: 1,
  role: "evaluator-final",
  objective:
    "Judge whether the final tree still preserves the approved candidate's behavior, and name any drift no required gate can see.",
  nonGoals: [
    "Re-reviewing the approved candidate's implementation choices",
    "Repairing the tree, restoring bytes, or reverting a post-approval writing stage",
    "Re-running the project's gates or reconstructing their verdicts",
    "Attributing a finding to a particular post-approval role",
  ],
  allowedWriteScope: [
    "slice/final-review.json",
    "slice/final-report.md",
  ],
  stopConditions: [
    "The canonical review artifact and the human-readable report are written with exactly one verdict",
    "Both questions are answered against the baseline → final change summary, and a finding names the repair it admits",
  ],
  escalationConditions: [
    "The approved baseline itself should not merge; it is reported as a BASELINE_IS_WRONG finding that returns the slice to the generator",
    "The change summary and the tree disagree, so no comparison can be made at all",
  ],
  acceptedInputArtifactClasses: [
    "change-summary",
    "approved-baseline",
    "acceptance-manifest",
    "locked-contract",
    "explorer-preservation-evidence",
    "gate-evidence",
    "cited-adr",
  ],
  outputArtifact: "final-review-pair",
  inputOrder: [
    "change-summary",
    "approved-baseline",
    "acceptance-manifest",
    "locked-contract",
    "explorer-preservation-evidence",
    "gate-evidence",
    "cited-adr",
  ],
  inlineSizeBudgetBytes: 65_536,
  omittedArtifactClasses: [
    ...ROLE_ENVELOPE_OMISSIONS,
    "candidate-handoff",
    "dependency-sibling-handoffs",
    "planner-conversation",
    "generator-conversation",
    // The other stages' findings are withheld for the reason M7 withholds the
    // handoff: this role judges the tree, and a prior stage's disposition of
    // its own findings is the author's story about it.
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
 * PromptAssemblyRole: "evaluator-qa" (candidate evaluator) and
 * "evaluator-final" (#96) have manifest-only role contracts today — their
 * prompts are still rendered directly by the orchestrator, so no assembly path
 * consumes them yet.
 */
export type ContextEnvelopeRole =
  | PromptAssemblyRole
  | "evaluator-qa"
  | "evaluator-final";

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
  /**
   * Durable open findings this fresh contract must already address (#178).
   * Absent on a genuine first attempt; present when an earlier attempt's
   * lineage survived a restart.
   */
  carriedFindings?: readonly ContractReviewFinding[];
}

export interface PlannerRevisionEnvelopeInput
  extends PlannerEnvelopeCommonInput {
  /**
   * A revision is a fresh invocation: PRD line 22 / user story 20 promise the
   * planner the ADR index and ARCHITECTURE.md whenever they exist, so the
   * revision envelope derives repository context exactly like the initial one.
   */
  repoRoot: string;
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
  /**
   * The durable-lineage block. The enforcement side of durable lineage —
   * `validateContractReviewAgainstLineage` — refuses a review that drops an
   * open blocker, so the informing side has to reach every round including the
   * first (#178).
   */
  durableLineage?: string;
  /**
   * Out-of-band situation the round must answer: today, the exact validation
   * error behind an artifact repair pass (ADR 0061).
   */
  controlSituation?: string;
  inlineSizeBudgetBytes?: number;
}

export type ContractEvaluatorInitialEnvelopeInput =
  ContractEvaluatorEnvelopeCommonInput;

export interface ContractEvaluatorRevisionEnvelopeInput
  extends ContractEvaluatorEnvelopeCommonInput {
  previousFindings: readonly ContractReviewFinding[];
  plannerResponse: ContractResponse | null;
  revisions: ContractRevisionArtifacts;
}

/**
 * Per-artifact-class inlined byte weight of an assembled prompt, heaviest
 * first, plus whatever the template and unlocated text account for.
 *
 * #196: the overflow throw used to report only the total, and it throws before
 * the `prompt-assembly` event is emitted, so the run's exhaustive artifact log
 * held nothing about the round that failed. Establishing that
 * `contract-revision-evidence` carried 70,899 of slice #195's 151,315 bytes
 * took a hand-built harness against preserved worktree files. The breakdown
 * belongs in the error that reports the overflow.
 */
export function envelopeArtifactByteBreakdown(
  prompt: string,
  artifacts: readonly ContextArtifactReference[],
): string {
  const inlined = new Map<string, number>();
  const byReference = new Set<string>();
  for (const artifact of artifacts) {
    if (artifact.locator === undefined) {
      byReference.add(artifact.artifactClass);
      continue;
    }
    inlined.set(
      artifact.artifactClass,
      (inlined.get(artifact.artifactClass) ?? 0) +
        Buffer.byteLength(artifact.locator, "utf-8"),
    );
  }
  const ranked = [...inlined.entries()].sort(
    ([leftClass, left], [rightClass, right]) =>
      right - left || leftClass.localeCompare(rightClass),
  );
  const accounted = ranked.reduce((total, [, size]) => total + size, 0);
  const remainder = Buffer.byteLength(prompt, "utf-8") - accounted;
  const parts = [
    ranked.length === 0
      ? "no inlined artifact classes"
      : `inlined bytes by artifact class: ${ranked
          .map(([artifactClass, size]) => `${artifactClass} ${size}`)
          .join(", ")}`,
    `template and unlocated text ${remainder}`,
  ];
  if (byReference.size > 0) {
    parts.push(`by reference: ${[...byReference].sort().join(", ")}`);
  }
  return parts.join("; ");
}

export function assertEnvelopeBudget(
  roleLabel: string,
  prompt: string,
  allowedByteSize: number,
  artifacts: readonly ContextArtifactReference[] = [],
): number {
  const assembledByteSize = Buffer.byteLength(prompt, "utf-8");
  if (assembledByteSize > allowedByteSize) {
    throw new ContextEnvelopeConfigurationError(
      `${roleLabel} prompt exceeds inline-size budget: actual ${assembledByteSize} bytes, allowed ${allowedByteSize} bytes ` +
        `(${envelopeArtifactByteBreakdown(prompt, artifacts)})`,
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
        orderedArtifacts,
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
  /**
   * Filtered to the *active* set — the one
   * `validateContractReviewAgainstLineage` enforces, `OPEN` and `CONTESTED`
   * both — and not to `OPEN` alone. Narrowing it further would drop a
   * CONTESTED blocker the review is still refused for omitting, and when that
   * blocker is the only carried finding the block would print "no durable
   * finding lineage" as a fact about a slice that has one (#178). The filter
   * stays because the role manifest declares resolved findings omitted and
   * this is where that promise is kept.
   */
  const carriedFindings = activeContractReviewFindings(
    input.carriedFindings ?? [],
  );
  const formattedCarriedFindings =
    carriedFindings.length > 0
      ? formatContractReviewFindings(carriedFindings)
      : "(none — this slice has no durable finding lineage)";
  const prompt = renderPrompt("planner", {
    GH_ISSUE: input.ghIssue,
    SPECS_DIR: input.specsDir,
    SLICE_DIR: input.sliceDir,
    ROUND: input.round,
    SLICE_BODY: input.sliceBody,
    CARRIED_OPEN_FINDINGS: formattedCarriedFindings,
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
      ...(carriedFindings.length > 0
        ? [{
            artifactClass: "open-contract-findings",
            artifactId: "contract-review:durable-open-findings",
            ...contentLocator(formattedCarriedFindings),
          }]
        : []),
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
  const repositoryContext = buildExplorerRepositoryContext(input.repoRoot);
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
    REPOSITORY_CONTEXT: repositoryContext.content,
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

export function assembleContractEvaluatorInitialEnvelope(
  input: ContractEvaluatorInitialEnvelopeInput,
): RoleEnvelopeResult {
  const evaluatorEvidence = projectContractEvaluatorEvidence(
    input.explorerContext,
  );
  const prompt = renderPrompt("evaluator-contract", {
    SLICE_DIR: input.sliceDir,
    ROUND: input.round,
    CONTRACT_REVIEW_FILE: input.contractReviewFile,
    ACCEPTANCE_MANIFEST_FILE: ACCEPTANCE_MANIFEST_FILENAME,
    DURABLE_FINDING_LINEAGE: input.durableLineage ?? "(none)",
    CONTROL_SITUATION: input.controlSituation ?? "(none)",
    BASE_GATE_CATALOG: input.baseGateCatalog,
    EXPLORER_CONTEXT: evaluatorEvidence,
  });
  return roleEnvelopeResult(
    prompt,
    "evaluator-contract",
    "initial",
    [
      {
        artifactClass: "proposed-contract",
        artifactId: `${input.sliceDir}/contract.md`,
        locatorExemption: CONTRACT_PAIR_BY_REFERENCE,
      },
      {
        artifactClass: "acceptance-manifest",
        artifactId: `${input.sliceDir}/acceptance-manifest.json`,
        locatorExemption: CONTRACT_PAIR_BY_REFERENCE,
      },
      ...durableLineageArtifact(input.durableLineage),
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
        artifactClass: "explorer-behavior-preservation",
        artifactId: `${input.sliceDir}/context.md`,
        ...contentLocator(evaluatorEvidence),
      },
    ],
    input.inlineSizeBudgetBytes,
    "Contract evaluator",
  );
}

/**
 * The durable-lineage block's artifact reference, when one was supplied.
 * It shares the `prior-open-contract-findings` class: durable open findings
 * *are* prior open findings, and reusing the declared class keeps the manifest
 * version honest instead of inventing a class for the same evidence.
 */
function durableLineageArtifact(
  durableLineage: string | undefined,
): ContextArtifactReference[] {
  return durableLineage === undefined
    ? []
    : [{
        artifactClass: "prior-open-contract-findings",
        artifactId: "contract-review:durable-open-findings",
        ...contentLocator(durableLineage),
      }];
}

/**
 * Why evaluator rounds name the pair instead of inlining it (#196).
 *
 * The revised pair is the round's largest term — 39,529 bytes on slice #195 —
 * and inlining it alongside the round's required delta evidence, prior
 * findings, planner response and explorer projection put the floor at ~69,000
 * bytes against a 65,536-byte budget, before a single byte of revision
 * evidence. A revision round therefore could not fit, whatever the evidence
 * block did.
 *
 * The first live #195 retry after that fix produced a larger round-1 pair and
 * failed before evaluator dispatch at 66,818 bytes: the pair was again the
 * dominant 43,179-byte term. Pair size is not bounded by the envelope, so
 * "round 1 fits" is not a safe distinction.
 *
 * Reference rather than omission: the evaluator runs in the slice's worktree,
 * so both files are at the named paths, and the changed regions — the only
 * text a fresh revision finding may cite — are reproduced verbatim in the
 * revision evidence block. No evidence leaves either round; the bulk stops
 * being copied into the prompt.
 */
const CONTRACT_PAIR_BY_REFERENCE =
  "the contract pair travels by reference to its worktree path; evaluator " +
  "rounds must open both files before review (#196)";

export function assembleContractEvaluatorRevisionEnvelope(
  input: ContractEvaluatorRevisionEnvelopeInput,
): RoleEnvelopeResult {
  const openFindings = openContractReviewFindings(input.previousFindings);
  const formattedPriorOpenFindings =
    formatContractReviewFindings(openFindings);
  const renderedPlannerResponse =
    input.plannerResponse === null
      ? "(none)"
      : JSON.stringify(input.plannerResponse, null, 2);
  const evaluatorEvidence = projectContractEvaluatorEvidence(
    input.explorerContext,
  );
  const render = (revisionEvidence: string): string =>
    renderPrompt("evaluator-contract-revision", {
      SLICE_DIR: input.sliceDir,
      ROUND: input.round,
      CONTRACT_REVIEW_FILE: input.contractReviewFile,
      ACCEPTANCE_MANIFEST_FILE: ACCEPTANCE_MANIFEST_FILENAME,
      PRIOR_OPEN_FINDINGS: formattedPriorOpenFindings,
      DURABLE_FINDING_LINEAGE: input.durableLineage ?? "(none)",
      PLANNER_RESPONSE: renderedPlannerResponse,
      REVISION_CONTEXT: revisionEvidence,
      CONTROL_SITUATION: input.controlSituation ?? "(none)",
      BASE_GATE_CATALOG: input.baseGateCatalog,
      EXPLORER_CONTEXT: evaluatorEvidence,
    });
  /**
   * The revision evidence is sized to the room the round's other blocks leave
   * (#196), so a revision can never be refused for carrying too much of its
   * own delta: the block that overflowed is the one that yields. Every other
   * block is required evidence, so measuring the prompt without any evidence
   * is the same as measuring what is left for it.
   */
  const budget = Math.min(
    input.inlineSizeBudgetBytes ??
      CONTRACT_EVALUATOR_CONTEXT_MANIFEST.inlineSizeBudgetBytes,
    CONTRACT_EVALUATOR_CONTEXT_MANIFEST.inlineSizeBudgetBytes,
  );
  const withoutEvidence = render("");
  const renderedRevisionContext = renderContractRevisionEvidence(
    input.revisions,
    budget - Buffer.byteLength(withoutEvidence.replace(/\r\n?/g, "\n"), "utf-8"),
  );
  const prompt = render(renderedRevisionContext);
  return roleEnvelopeResult(
    prompt,
    "evaluator-contract",
    "revision",
    [
      {
        artifactClass: "revised-contract",
        artifactId: `${input.sliceDir}/contract.md`,
        locatorExemption: CONTRACT_PAIR_BY_REFERENCE,
      },
      {
        artifactClass: "revised-acceptance-manifest",
        artifactId: `${input.sliceDir}/${ACCEPTANCE_MANIFEST_FILENAME}`,
        locatorExemption: CONTRACT_PAIR_BY_REFERENCE,
      },
      ...(openFindings.length > 0
        ? [{
            artifactClass: "prior-open-contract-findings",
            artifactId: "contract-review:prior-open-findings",
            ...contentLocator(formattedPriorOpenFindings),
          }]
        : []),
      ...durableLineageArtifact(input.durableLineage),
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
        artifactClass: "explorer-behavior-preservation",
        artifactId: `${input.sliceDir}/context.md`,
        ...contentLocator(evaluatorEvidence),
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

/**
 * Sections of the explorer evidence map routed to the contract evaluators:
 * behavior and preservation evidence plus unresolved facts
 * (docs/specs/afk-v2-agent-roles.md §1 — "planner gets all; generator gets
 * patterns and harness; evaluators get behavior and preservation").
 * "Patterns and test harness" and "Data and integration" are deliberately
 * excluded and declared in the evaluator manifest's omittedArtifactClasses.
 */
const CONTRACT_EVALUATOR_EVIDENCE_SECTIONS = new Set([
  "Files and current behavior",
  "Unknowns",
]);

/**
 * Deterministic section projection of the explorer evidence map for the
 * contract evaluators. Mirrors projectGeneratorPatternsAndHarness: when the
 * map carries none of the expected level-2 sections (legacy or free-form
 * context), the whole map is passed through unchanged rather than dropped.
 */
export function projectContractEvaluatorEvidence(context: string): string {
  const sections = explorerEvidenceSections(context).filter((heading) =>
    CONTRACT_EVALUATOR_EVIDENCE_SECTIONS.has(heading.title),
  );
  if (sections.length === 0) return context;
  return sections
    .map(({ headingStart, bodyEnd }) => context.slice(headingStart, bodyEnd))
    .join("");
}

/**
 * Sections of the assembled repair situation whose body is a verbatim fenced
 * copy of a file the round already carries by reference as `repair-context`,
 * and the filename each duplicates.
 *
 * #230: on PRD 4 slice #193 (`run-20260910-131250`, `--resume-stuck 07`) the
 * repair round refused to dispatch at 73,607 bytes against a 65,536-byte
 * budget, with `repair-situation` the dominant 33,745-byte term. 23,093 of
 * those bytes were fenced copies of `stuck.md` (16,327) and `handoff.md`
 * (6,766) — both simultaneously registered by reference, so the generator was
 * handed two copies of each file it could already open. That is #196's defect
 * on the repair path.
 *
 * The framing prose stays: it is instruction, not duplication, and it tells the
 * generator what the document is and why it matters. Only the fenced copy is
 * replaced, by a pointer to the path the artifact reference already names.
 */
const REPAIR_SITUATION_BY_REFERENCE_SECTIONS = [
  { title: "Preserved STUCK evidence", filename: "stuck.md" },
  { title: "Prior handoff", filename: "handoff.md" },
] as const;

/** Heading of the repair situation section that grows with round count. */
const REPAIR_SITUATION_COMMIT_LOG_SECTION = "Commit log";

/**
 * Heading of the merge-resolution data block (#132 B-02, PRD D15 mechanism M5).
 *
 * A merge-resolution round is a repair round with a different situation, not a
 * new role: the conflict hunks and the already-merged sibling diffs travel in
 * the existing `{{REPAIR_SITUATION}}` slot under this heading, so there is no
 * second generator template to keep in sync. Its membership in
 * {@link REPAIR_SITUATION_SECTION_TITLES} is what keeps the situation's other
 * section extents correct once the block's own fenced diffs are inside it.
 */
export const MERGE_RESOLUTION_SITUATION_SECTION = "Merge conflict to resolve";

/**
 * Every heading the orchestrator emits for the repair situation itself
 * (`orchestrator.ts`, the `repairSituation` assembly).
 *
 * A quoted document carries its own level-1 headings — `stuck.md`'s block opens
 * with "Why you were declared STUCK" — so a section's extent cannot be taken as
 * "up to the next level-1 heading": that would end the wrapper section
 * immediately and leave the quote outside it. The situation's own headings are
 * a closed set, so the extent runs to the next heading in that set.
 */
const REPAIR_SITUATION_SECTION_TITLES = new Set([
  REPAIR_SITUATION_COMMIT_LOG_SECTION,
  "Worktree state",
  "Base refresh",
  "Preserved STUCK evidence",
  "Prior handoff",
  MERGE_RESOLUTION_SITUATION_SECTION,
]);

/**
 * Locates a section of the assembled repair situation by title, with its body
 * running to the next section of the situation itself. Fence-aware via
 * markdownSections, so a `#` line inside a fenced quote is not read as a
 * heading at all.
 */
function repairSituationSection(
  situation: string,
  title: string,
): MarkdownSection | undefined {
  const own = markdownSections(situation).filter(
    (section) =>
      section.level === 1 && REPAIR_SITUATION_SECTION_TITLES.has(section.title),
  );
  const index = own.findIndex((section) => section.title === title);
  if (index === -1) return undefined;
  return {
    ...own[index]!,
    bodyEnd: own[index + 1]?.headingStart ?? situation.length,
  };
}

/**
 * Replaces the quoted document in `body` — the span from its first fence line
 * to its last — with a single `replacement` line, keeping the framing prose on
 * either side.
 *
 * Deliberately *not* fence pairing. The quoted documents carry fences of their
 * own: `stuck.md` embeds JSON and diff blocks, and the note builders in
 * `resume.ts` wrap the whole file in a plain ``` fence, so an inner ``` is
 * indistinguishable from the outer close. Pairing therefore mis-terminates the
 * quote at the document's first inner fence and reads the rest as alternating
 * quote and prose — which leaked fragments of the document back inline,
 * interleaved with a repeated pointer, instead of removing it (three pointers
 * and two leaked passages on a `stuck.md` with two inner fences).
 *
 * A span has no pairing to get wrong: everything between the outer fences is
 * the document, whatever it contains. The cost is that prose *between* two
 * genuinely separate quotes in one section would go too — neither section in
 * REPAIR_SITUATION_BY_REFERENCE_SECTIONS has that shape, since each wraps one
 * file in one fence.
 */
function replaceQuotedDocument(body: string, replacement: string): string {
  const lines = body.split("\n");
  const isFence = (line: string): boolean => {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    // A backtick fence whose info string contains a backtick is not a fence,
    // matching markdownSections.
    return (
      match !== null &&
      !(match[1]![0] === "`" && match[2]!.includes("`"))
    );
  };
  const first = lines.findIndex(isFence);
  if (first === -1) return body;
  let last = lines.length - 1;
  while (!isFence(lines[last]!)) last--;
  // An unterminated fence — the whole tail is document.
  return [...lines.slice(0, first), replacement, ...lines.slice(last + 1)].join(
    "\n",
  );
}

/**
 * Replaces the quoted document in the repair situation's document-quoting
 * sections with a pointer to the path the round already carries by reference.
 *
 * A section is only rewritten when its file is actually in
 * `byReferenceArtifactIds`: the situation may only stop carrying text the
 * generator can still reach, so an unreferenced quote is left inline.
 */
export function projectGeneratorRepairSituation(
  situation: string,
  sliceDir: string,
  byReferenceArtifactIds: readonly string[],
): string {
  const referenced = new Set(byReferenceArtifactIds);
  let projected = situation;
  for (const { title, filename } of REPAIR_SITUATION_BY_REFERENCE_SECTIONS) {
    const artifactId = `${sliceDir}/${filename}`;
    if (!referenced.has(artifactId)) continue;
    const section = repairSituationSection(projected, title);
    if (section === undefined) continue;
    const body = projected.slice(section.bodyStart, section.bodyEnd);
    const pointed = replaceQuotedDocument(
      body,
      `Read it at \`${artifactId}\` in your worktree.`,
    );
    if (pointed === body) continue;
    projected =
      projected.slice(0, section.bodyStart) +
      pointed +
      projected.slice(section.bodyEnd);
  }
  return projected;
}

/**
 * Rewrites the repair situation's commit-log section body.
 *
 * Used both to measure the room the rest of the round leaves the log (body
 * `""`) and to install the bounded log.
 */
function withRepairSituationCommitLog(
  situation: string,
  commitLog: string,
): string {
  const section = repairSituationSection(
    situation,
    REPAIR_SITUATION_COMMIT_LOG_SECTION,
  );
  if (section === undefined) return situation;
  return (
    situation.slice(0, section.bodyStart) +
    (commitLog === "" ? "\n" : `\n\n${commitLog}\n`) +
    situation.slice(section.bodyEnd)
  );
}

/**
 * Truncates the commit log to `budgetBytes`, dropping whole commits from the
 * oldest end and naming the drop.
 *
 * #230: de-duplicating the fenced copies takes the #193-shaped round from
 * 73,607 to ~50,500 bytes, but headroom is a number, not a property. The
 * commit log is `git log <base>..HEAD --stat`, so it grows with every round the
 * slice survives — #193 reached ten. Bounding it is what makes "a repair round
 * fits" independent of round count: the block that would overflow is the one
 * that yields, and every other block in the situation is fixed-size round
 * facts. `git log` is newest-first, so the newest commits are kept.
 */
export function boundRepairSituationCommitLog(
  commitLog: string,
  budgetBytes: number,
): string {
  if (Buffer.byteLength(commitLog, "utf-8") <= budgetBytes) return commitLog;
  // A commit entry starts at a `commit <sha>` line; anything before the first
  // one is not a recognizable log and is truncated as a single unit.
  const entries = commitLog
    .split(/^(?=commit [0-9a-f]{7,40}\b)/m)
    .filter((entry) => entry !== "");
  // The note is reserved at its widest (every entry dropped) so the reservation
  // cannot grow as entries are kept and push the result back over budget.
  const reserved = Buffer.byteLength(
    repairSituationCommitLogDropNote(entries.length),
    "utf-8",
  );
  const kept: string[] = [];
  let used = 0;
  for (const entry of entries) {
    const size = Buffer.byteLength(entry, "utf-8");
    if (used + size + reserved > budgetBytes) break;
    kept.push(entry);
    used += size;
  }
  const dropped = entries.length - kept.length;
  return kept.length === 0
    ? repairSituationCommitLogDropNote(dropped).trimStart()
    : kept.join("").trimEnd() + repairSituationCommitLogDropNote(dropped);
}

function repairSituationCommitLogDropNote(dropped: number): string {
  return `\n\n(${dropped} older commit${dropped === 1 ? "" : "s"} omitted to fit the inline-size budget; run \`git log\` in your worktree for the full history.)`;
}

/**
 * Appends the merge-resolution data block to a repair situation as one level-1
 * section (#132 B-02).
 *
 * The block is data the caller has already bounded — `src/merge-resolution.ts`
 * owns that, because only it knows which files it read the hunks from. This
 * function owns where the block goes and what it is called, so exactly one
 * module decides the situation's section vocabulary.
 */
export function withMergeResolutionSituation(
  situation: string,
  block: string,
): string {
  const facts = situation.trim();
  return (
    (facts === "" ? "" : `${facts}\n\n`) +
    `# ${MERGE_RESOLUTION_SITUATION_SECTION}\n\n${block.trim()}\n`
  );
}

/**
 * Bytes the rest of a repair round leaves the merge-resolution data block.
 *
 * Measured the way the commit log is measured (#230): render the round with an
 * empty block and subtract. Newlines are normalised before measuring for the
 * same reason `assembleGeneratorEnvelope` normalises them — a CRLF checkout
 * must not spend budget the budget check will not count.
 */
export function mergeResolutionBlockRoom(
  input: GeneratorEnvelopeInput & { repairSituation: string },
): number {
  const budget = Math.min(
    input.inlineSizeBudgetBytes ??
      GENERATOR_CONTEXT_MANIFEST.inlineSizeBudgetBytes,
    GENERATOR_CONTEXT_MANIFEST.inlineSizeBudgetBytes,
  );
  const empty = assembleGeneratorEnvelope({
    ...input,
    mode: "repair",
    repairSituation: withMergeResolutionSituation(input.repairSituation, ""),
  }).prompt;
  return budget - Buffer.byteLength(empty.replace(/\r\n?/g, "\n"), "utf-8");
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
  const additionalArtifactIds = input.additionalArtifactIds ?? [];
  /**
   * The repair situation is sized to the room the round's other blocks leave it
   * (#230), so a repair round can never be refused for carrying too much of its
   * own history: the only block that grows with round count is the one that
   * yields. Rendering with an empty commit log measures exactly what is left
   * for it.
   */
  const renderRepair = (situation: string): string =>
    renderPrompt("generator-repair", {
      ...commonArgs,
      REPAIR_SITUATION: situation,
    });
  const repairSituation =
    input.repairSituation === undefined
      ? undefined
      : (() => {
          const projected = projectGeneratorRepairSituation(
            input.repairSituation,
            input.sliceDir,
            additionalArtifactIds,
          );
          const commitLogSection = repairSituationSection(
            projected,
            REPAIR_SITUATION_COMMIT_LOG_SECTION,
          );
          if (commitLogSection === undefined) return projected;
          const commitLog = projected
            .slice(commitLogSection.bodyStart, commitLogSection.bodyEnd)
            .trim();
          const budget = Math.min(
            input.inlineSizeBudgetBytes ??
              GENERATOR_CONTEXT_MANIFEST.inlineSizeBudgetBytes,
            GENERATOR_CONTEXT_MANIFEST.inlineSizeBudgetBytes,
          );
          const withoutCommitLog = renderRepair(
            withRepairSituationCommitLog(projected, ""),
          );
          const room =
            budget -
            Buffer.byteLength(
              withoutCommitLog.replace(/\r\n?/g, "\n"),
              "utf-8",
            );
          return withRepairSituationCommitLog(
            projected,
            boundRepairSituationCommitLog(commitLog, room),
          );
        })();
  const prompt =
    input.mode === "repair"
      ? renderRepair(repairSituation!)
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
    ...(repairSituation === undefined
      ? []
      : [{
          artifactClass: "repair-situation",
          artifactId: "generator:repair-situation",
          ...contentLocator(repairSituation),
        }]),
    ...additionalArtifactIds.map((artifactId) => ({
      artifactClass: "repair-context",
      artifactId,
      locatorExemption:
        "repair-context artifacts travel by reference; the repair situation points at them rather than quoting them (#230)",
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

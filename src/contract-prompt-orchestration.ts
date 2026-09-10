import {
  assembleContractEvaluatorInitialEnvelope,
  assembleContractEvaluatorRevisionEnvelope,
  assemblePlannerInitialEnvelope,
  assemblePlannerRevisionEnvelope,
  type ContractEvaluatorInitialEnvelopeInput,
  type ContractEvaluatorRevisionEnvelopeInput,
  type PlannerInitialEnvelopeInput,
  type PlannerRevisionEnvelopeInput,
  type RoleEnvelopeResult,
} from "./context-envelope.js";
import type { ContextEnvelopeInvocationEvidence } from "./agent-provider.js";
import type { AcceptanceManifest } from "./acceptance-manifest.js";
import type {
  ContractResponse,
  ContractRevisionArtifacts,
  ContractReviewFinding,
} from "./contract-review.js";

export interface PromptAssemblyContext {
  ghIssue: string;
  sliceNumber: string;
  specsDir: string;
  sliceDir: string;
  round: number;
}

export interface PreparedEnvelopePrompt {
  prompt: string;
  contextEnvelope: ContextEnvelopeInvocationEvidence;
}

type WithoutBudget<T> = Omit<T, "inlineSizeBudgetBytes">;

export type PlannerPromptRequest =
  | {
      mode: "initial";
      input: WithoutBudget<PlannerInitialEnvelopeInput>;
    }
  | {
      mode: "revision";
      input: WithoutBudget<PlannerRevisionEnvelopeInput>;
    };

export type ContractEvaluatorPromptRequest =
  | {
      mode: "initial";
      input: WithoutBudget<ContractEvaluatorInitialEnvelopeInput>;
    }
  | {
      mode: "revision";
      input: WithoutBudget<ContractEvaluatorRevisionEnvelopeInput>;
    };

export function promptAssemblyContext(
  _journal: unknown,
  slice: { ghIssue: string; number: string },
  specsDir: string,
  sliceDir: string,
  round: number,
): PromptAssemblyContext {
  return {
    ghIssue: slice.ghIssue,
    sliceNumber: slice.number,
    specsDir,
    sliceDir,
    round,
  };
}

function recordPromptAssembly(
  context: PromptAssemblyContext,
  assembled: RoleEnvelopeResult,
): PreparedEnvelopePrompt {
  return {
    prompt: assembled.prompt,
    contextEnvelope: {
    ghIssue: context.ghIssue,
    sliceNumber: context.sliceNumber,
    round: context.round,
    ...assembled.evidence,
    },
  };
}

export function assemblePlannerPrompt(
  request: PlannerPromptRequest,
  context: PromptAssemblyContext,
  inlineSizeBudgetBytes?: number,
): PreparedEnvelopePrompt {
  const budget =
    inlineSizeBudgetBytes === undefined ? {} : { inlineSizeBudgetBytes };
  const assembled =
    request.mode === "initial"
      ? assemblePlannerInitialEnvelope({ ...request.input, ...budget })
      : assemblePlannerRevisionEnvelope({ ...request.input, ...budget });
  return recordPromptAssembly(context, assembled);
}

export function assembleContractEvaluatorPrompt(
  request: ContractEvaluatorPromptRequest,
  context: PromptAssemblyContext,
  inlineSizeBudgetBytes?: number,
): PreparedEnvelopePrompt {
  const budget =
    inlineSizeBudgetBytes === undefined ? {} : { inlineSizeBudgetBytes };
  const assembled =
    request.mode === "initial"
      ? assembleContractEvaluatorInitialEnvelope({
          ...request.input,
          ...budget,
        })
      : assembleContractEvaluatorRevisionEnvelope({
          ...request.input,
          ...budget,
        });
  return recordPromptAssembly(context, assembled);
}

export function assembleFocusedScopePlannerPrompt(input: {
  context: PromptAssemblyContext;
  repoRoot: string;
  currentContract: string;
  currentAcceptanceManifest: string;
  scopeEvidence: string;
  contractResponseFilename: string;
  migrationReservation: string;
  baseGateCatalog: string;
  inlineSizeBudgetBytes?: number;
}): PreparedEnvelopePrompt {
  const { context } = input;
  return assemblePlannerPrompt(
    {
      mode: "revision",
      input: {
        ghIssue: context.ghIssue,
        specsDir: context.specsDir,
        sliceDir: context.sliceDir,
        round: context.round,
        repoRoot: input.repoRoot,
        currentContract: input.currentContract,
        currentAcceptanceManifest: input.currentAcceptanceManifest,
        findings: [],
        controlSituation:
          `This is a focused revision of the already accepted contract. ` +
          `The generator stopped before an undeclared edit. Revise only the ` +
          `contract and acceptance manifest needed to declare this request:\n` +
          `${input.scopeEvidence}\n\nPreserve every other locked term.`,
        contractResponseInstructions:
          `Do not write ${input.contractResponseFilename} for this focused scope revision.`,
        migrationReservation: input.migrationReservation,
        baseGateCatalog: input.baseGateCatalog,
      },
    },
    context,
    input.inlineSizeBudgetBytes,
  );
}

export function assembleFocusedScopeEvaluatorPrompt(input: {
  context: PromptAssemblyContext;
  contractReviewFile: string;
  proposedContract: string;
  acceptanceManifest: AcceptanceManifest;
  baseGateCatalog: string;
  explorerContext: string;
  inlineSizeBudgetBytes?: number;
}): PreparedEnvelopePrompt {
  return assembleContractEvaluatorPrompt(
    {
      mode: "initial",
      input: {
        sliceDir: input.context.sliceDir,
        round: input.context.round,
        contractReviewFile: input.contractReviewFile,
        proposedContract: input.proposedContract,
        acceptanceManifest: input.acceptanceManifest,
        baseGateCatalog: input.baseGateCatalog,
        explorerContext: input.explorerContext,
      },
    },
    input.context,
    input.inlineSizeBudgetBytes,
  );
}

export function assembleAdjudicationPlannerPrompt(input: {
  context: PromptAssemblyContext;
  repoRoot: string;
  currentContract: string;
  currentAcceptanceManifest: string;
  impasseRecord: string;
  decisions: readonly string[];
  contractResponseFilename: string;
  migrationReservation: string;
  baseGateCatalog: string;
  inlineSizeBudgetBytes?: number;
}): PreparedEnvelopePrompt {
  const { context } = input;
  return assemblePlannerPrompt(
    {
      mode: "revision",
      input: {
        ghIssue: context.ghIssue,
        specsDir: context.specsDir,
        sliceDir: context.sliceDir,
        round: context.round,
        repoRoot: input.repoRoot,
        currentContract: input.currentContract,
        currentAcceptanceManifest: input.currentAcceptanceManifest,
        findings: [],
        controlSituation: [
          "A human has adjudicated the current contract impasse.",
          "Apply every decision below exactly once, and only to the",
          "finding each one names. Do not re-adjudicate any of them.",
          "",
          "Current IMPASSE record (verbatim):",
          input.impasseRecord,
          "Human adjudications (verbatim, one per decided finding):",
          ...input.decisions,
        ].join("\n"),
        contractResponseInstructions:
          `Do not write ${input.contractResponseFilename}; the human adjudication replaces another evaluator round.`,
        migrationReservation: input.migrationReservation,
        baseGateCatalog: input.baseGateCatalog,
      },
    },
    context,
    input.inlineSizeBudgetBytes,
  );
}

/**
 * Compose the one control-plane block a planner revision may carry. A gate
 * objection and an artifact repair pass can coincide — the round that answers
 * the objection is the round whose response artifact was refused — so they are
 * concatenated rather than one silently replacing the other.
 */
function plannerControlSituation(
  pendingObjection: string | null,
  repairInstruction: string | null,
): string | undefined {
  const blocks = [
    pendingObjection === null
      ? null
      : `The pipeline REJECTED the previous contract before ` +
        `any code was generated:\n\n${pendingObjection}\n\n` +
        `Resolve exactly that in this revision.`,
    repairInstruction,
  ].filter((block): block is string => block !== null);
  return blocks.length === 0 ? undefined : blocks.join("\n\n");
}

export function assembleNegotiationPlannerPrompt(input: {
  context: PromptAssemblyContext;
  repoRoot: string;
  useInitialEnvelope: boolean;
  sliceBody: string;
  explorerContext: string;
  currentContract: string;
  currentAcceptanceManifest: string;
  findings: readonly ContractReviewFinding[];
  /** Durable open findings a fresh round 1 must already address (#178). */
  carriedFindings?: readonly ContractReviewFinding[];
  resolvedFindings?: readonly ContractReviewFinding[];
  pendingObjection: string | null;
  /** Exact validation error of a refused artifact this pass must repair. */
  repairInstruction?: string | null;
  contractResponseInstructions: string;
  migrationReservation: string;
  baseGateCatalog: string;
  inlineSizeBudgetBytes?: number;
}): PreparedEnvelopePrompt {
  const { context } = input;
  const controlSituation = plannerControlSituation(
    input.pendingObjection,
    input.repairInstruction ?? null,
  );
  const request: PlannerPromptRequest = input.useInitialEnvelope
    ? {
        mode: "initial",
        input: {
          repoRoot: input.repoRoot,
          ghIssue: context.ghIssue,
          specsDir: context.specsDir,
          sliceDir: context.sliceDir,
          round: context.round,
          sliceBody: input.sliceBody,
          explorerContext: input.explorerContext,
          ...(input.carriedFindings === undefined
            ? {}
            : { carriedFindings: input.carriedFindings }),
          migrationReservation: input.migrationReservation,
          baseGateCatalog: input.baseGateCatalog,
        },
      }
    : {
        mode: "revision",
        input: {
          ghIssue: context.ghIssue,
          specsDir: context.specsDir,
          sliceDir: context.sliceDir,
          round: context.round,
          repoRoot: input.repoRoot,
          currentContract: input.currentContract,
          currentAcceptanceManifest: input.currentAcceptanceManifest,
          findings: input.findings,
          ...(input.resolvedFindings === undefined
            ? {}
            : { resolvedFindings: input.resolvedFindings }),
          ...(controlSituation === undefined ? {} : { controlSituation }),
          contractResponseInstructions: input.contractResponseInstructions,
          migrationReservation: input.migrationReservation,
          baseGateCatalog: input.baseGateCatalog,
        },
      };
  return assemblePlannerPrompt(
    request,
    context,
    input.inlineSizeBudgetBytes,
  );
}

export function assembleNegotiationEvaluatorPrompt(input: {
  context: PromptAssemblyContext;
  useInitialEnvelope: boolean;
  contractReviewFile: string;
  proposedContract: string;
  acceptanceManifest: AcceptanceManifest;
  baseGateCatalog: string;
  explorerContext: string;
  previousFindings: readonly ContractReviewFinding[];
  /**
   * The durable-lineage block, rendered by the round lifecycle. Present
   * whenever lineage carries a revision, initial envelope included (#178).
   */
  durableLineage?: string | null;
  /** Exact validation error of a refused review this pass must repair. */
  repairInstruction?: string | null;
  plannerResponse: ContractResponse | null;
  revisions: ContractRevisionArtifacts | null;
  inlineSizeBudgetBytes?: number;
}): PreparedEnvelopePrompt {
  const common = {
    sliceDir: input.context.sliceDir,
    round: input.context.round,
    contractReviewFile: input.contractReviewFile,
    proposedContract: input.proposedContract,
    acceptanceManifest: input.acceptanceManifest,
    baseGateCatalog: input.baseGateCatalog,
    explorerContext: input.explorerContext,
    ...(input.durableLineage === undefined || input.durableLineage === null
      ? {}
      : { durableLineage: input.durableLineage }),
    ...(input.repairInstruction === undefined ||
    input.repairInstruction === null
      ? {}
      : { controlSituation: input.repairInstruction }),
  };
  return assembleContractEvaluatorPrompt(
    input.useInitialEnvelope
      ? { mode: "initial", input: common }
      : {
          mode: "revision",
          input: {
            ...common,
            previousFindings: input.previousFindings,
            plannerResponse: input.plannerResponse,
            revisions: input.revisions!,
          },
        },
    input.context,
    input.inlineSizeBudgetBytes,
  );
}

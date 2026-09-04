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
import type { RunEventPayload } from "./run-events.js";
import type { AcceptanceManifest } from "./acceptance-manifest.js";
import type {
  ContractResponse,
  ContractRevisionArtifacts,
  ContractReviewFinding,
} from "./contract-review.js";

type PromptAssemblyEvent = Extract<
  RunEventPayload,
  { type: "prompt-assembly" }
>;

interface PromptAssemblyJournal {
  event(payload: PromptAssemblyEvent): void;
}

export interface PromptAssemblyContext {
  journal: PromptAssemblyJournal;
  ghIssue: string;
  sliceNumber: string;
  specsDir: string;
  sliceDir: string;
  round: number;
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
  journal: PromptAssemblyJournal,
  slice: { ghIssue: string; number: string },
  specsDir: string,
  sliceDir: string,
  round: number,
): PromptAssemblyContext {
  return {
    journal,
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
): string {
  context.journal.event({
    type: "prompt-assembly",
    ghIssue: context.ghIssue,
    sliceNumber: context.sliceNumber,
    round: context.round,
    ...assembled.evidence,
  });
  return assembled.prompt;
}

export function assemblePlannerPrompt(
  request: PlannerPromptRequest,
  context: PromptAssemblyContext,
  inlineSizeBudgetBytes?: number,
): string {
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
): string {
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
  currentContract: string;
  currentAcceptanceManifest: string;
  scopeEvidence: string;
  contractResponseFilename: string;
  migrationReservation: string;
  baseGateCatalog: string;
  inlineSizeBudgetBytes?: number;
}): string {
  const { context } = input;
  return assemblePlannerPrompt(
    {
      mode: "revision",
      input: {
        ghIssue: context.ghIssue,
        specsDir: context.specsDir,
        sliceDir: context.sliceDir,
        round: context.round,
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
}): string {
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
  currentContract: string;
  currentAcceptanceManifest: string;
  impasseRecord: string;
  decisions: readonly string[];
  contractResponseFilename: string;
  migrationReservation: string;
  baseGateCatalog: string;
  inlineSizeBudgetBytes?: number;
}): string {
  const { context } = input;
  return assemblePlannerPrompt(
    {
      mode: "revision",
      input: {
        ghIssue: context.ghIssue,
        specsDir: context.specsDir,
        sliceDir: context.sliceDir,
        round: context.round,
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

export function assembleNegotiationPlannerPrompt(input: {
  context: PromptAssemblyContext;
  repoRoot: string;
  useInitialEnvelope: boolean;
  sliceBody: string;
  explorerContext: string;
  currentContract: string;
  currentAcceptanceManifest: string;
  findings: readonly ContractReviewFinding[];
  resolvedFindings?: readonly ContractReviewFinding[];
  pendingObjection: string | null;
  contractResponseInstructions: string;
  migrationReservation: string;
  baseGateCatalog: string;
  inlineSizeBudgetBytes?: number;
}): string {
  const { context } = input;
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
          currentContract: input.currentContract,
          currentAcceptanceManifest: input.currentAcceptanceManifest,
          findings: input.findings,
          ...(input.resolvedFindings === undefined
            ? {}
            : { resolvedFindings: input.resolvedFindings }),
          ...(input.pendingObjection === null
            ? {}
            : {
                controlSituation:
                  `The pipeline REJECTED the previous contract before ` +
                  `any code was generated:\n\n${input.pendingObjection}\n\n` +
                  `Resolve exactly that in this revision.`,
              }),
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
  plannerResponse: ContractResponse | null;
  revisions: ContractRevisionArtifacts | null;
  inlineSizeBudgetBytes?: number;
}): string {
  const common = {
    sliceDir: input.context.sliceDir,
    round: input.context.round,
    contractReviewFile: input.contractReviewFile,
    proposedContract: input.proposedContract,
    acceptanceManifest: input.acceptanceManifest,
    baseGateCatalog: input.baseGateCatalog,
    explorerContext: input.explorerContext,
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

/**
 * The bounded generator self-audit stage (#299, ADR 0069).
 *
 * One extra generator invocation on a candidate that has already cleared its
 * required cheap gates, between the gate-release assertion and the deterministic
 * QA dispatch. The verdict is structural: the stage re-hashes the worktree with
 * the same exact-tree identity the gate cache uses and compares it against the
 * tree the gates released. It never asks the agent whether the audit found
 * anything, because an agent-certified verdict is a claim and a tree id is a
 * fact.
 *
 * Dispatch travels through an injected callback, like `src/cleaner-stage.ts`'s
 * `ctx.dispatch`, so the whole stage is exercised without a provider.
 */
import { join, relative } from "node:path";
import { isTransientProviderError } from "./agent-provider.js";
import type { CandidateGatePhaseResult } from "./candidate-gate-phase.js";
import { assertGateEvidenceReleasesEvaluation } from "./candidate-gate-phase.js";
import {
  assembleSelfAuditEnvelope,
  type RoleEnvelopeEvidence,
} from "./context-envelope.js";
import {
  resolveCandidateTreeId,
  verifyGateEvidence,
  type GateDeclaration,
  type GateEvidence,
  type GateEvidenceArtifact,
  type GateResult,
} from "./gate-runner.js";
import {
  loadRunState,
  recordSelfAuditOutcome,
  selfAuditsFor,
  type PersistedSelfAuditVerdict,
} from "./run-state.js";

/** The three outcomes of one audit invocation (ADR 0069). */
export type SelfAuditVerdict = PersistedSelfAuditVerdict;

/**
 * What the injected dispatch reports back. A boolean rather than an error,
 * because the stage's only question is whether the invocation completed: the
 * failure-cause taxonomy for a dead audit invocation is #301's, governed by
 * ADR 0025.
 */
export interface SelfAuditInvocationResult {
  completed: boolean;
  /** Why it did not complete, when it did not. */
  detail?: string;
}

/** What the injected callback is handed: the assembled envelope, nothing else. */
export interface SelfAuditDispatchInput {
  prompt: string;
  evidence: RoleEnvelopeEvidence<"generator-audit">;
}

export interface SelfAuditClassification {
  verdict: SelfAuditVerdict;
  /** The tree id QA would grade under this verdict. */
  treeId: string;
  reason: string;
}

/**
 * Classify one audit invocation from tree identities alone (#299 B-08).
 *
 * Pure: no filesystem, no run state, no clock. Both uncertain cases — an
 * invocation that did not complete, and one that completed but whose post-audit
 * tree could not be resolved — return `AUDIT_NOT_RUN` on the *pre-audit* tree,
 * because that is the branch that cannot loop (ADR 0041): the candidate proceeds
 * to QA on exactly the tree its gates released, which is what would have
 * happened had the audit never been dispatched.
 *
 * Prior art for the shape: `decideFinalReuse` (`src/final-evaluation.ts:117`).
 */
export function classifySelfAuditVerdict(input: {
  /** The tree the required cheap gates released and the audit was handed. */
  preAuditTreeId: string;
  /** The tree the audit left behind, when it could be resolved. */
  postAuditTreeId?: string;
  invocation: SelfAuditInvocationResult;
}): SelfAuditClassification {
  if (!input.invocation.completed) {
    return {
      verdict: "AUDIT_NOT_RUN",
      treeId: input.preAuditTreeId,
      reason:
        input.invocation.detail === undefined
          ? "the audit invocation did not complete"
          : `the audit invocation did not complete: ${input.invocation.detail}`,
    };
  }
  if (input.postAuditTreeId === undefined) {
    return {
      verdict: "AUDIT_NOT_RUN",
      treeId: input.preAuditTreeId,
      reason:
        "the audit invocation completed but its post-audit tree id could not be resolved",
    };
  }
  if (input.postAuditTreeId === input.preAuditTreeId) {
    return {
      verdict: "AUDIT_UNCHANGED",
      treeId: input.preAuditTreeId,
      reason: `the audit left tree ${input.preAuditTreeId} unchanged`,
    };
  }
  return {
    verdict: "AUDIT_CHANGED",
    treeId: input.postAuditTreeId,
    reason: `the audit rewrote tree ${input.preAuditTreeId} as ${input.postAuditTreeId}`,
  };
}

/* ---------------------------------------------------------------------------
 * The dead-invocation taxonomy (#301, ADR 0025)
 * ------------------------------------------------------------------------- */

/**
 * Why one audit invocation died, under ADR 0025's agent-failure-cause kinds
 * (`docs/adr/0025-agent-failure-causes.md:40-46`).
 *
 * Four of the five kinds, not five: `verdict` and `design-decision` cannot
 * happen here, because an audit writes no review artifact and makes no design
 * decision. An envelope that fails closed as CONFIGURATION is an
 * `internal-error`.
 */
export type SelfAuditFailureKind =
  | "provider-exit"
  | "orchestrator-kill"
  | "transient-exhausted"
  | "internal-error";

/** Which per-invocation bound tripped, on an `orchestrator-kill`. */
export type SelfAuditKillClass =
  | "tool-call-cap"
  | "wall-clock-ceiling"
  | "idle-timeout"
  | "unspecified";

export interface SelfAuditFailureCause {
  kind: SelfAuditFailureKind;
  /** Operator-facing one-liner; narrated with each retry and never blank. */
  summary: string;
  /** `provider-exit` only — the agent provider's exit code. */
  exitCode?: number;
  /** `orchestrator-kill` only — which bound tripped. */
  killClass?: SelfAuditKillClass;
}

/**
 * Kill-class signatures, matched against the provider's rejection message.
 * Dash-agnostic for the reason the hub's own table gives
 * (`src/orchestrator.ts:1850-1856`): `claude.ts`/`kiro.ts` build these strings
 * with an em dash and `codex.ts` with a hyphen.
 */
const AUDIT_KILL_SIGNATURES: ReadonlyArray<
  readonly [RegExp, SelfAuditKillClass]
> = [
  [/exceeded \d+ tool calls/i, "tool-call-cap"],
  [/wall-clock ceiling/i, "wall-clock-ceiling"],
  [/idle for .*killed/i, "idle-timeout"],
  [/was killed/i, "unspecified"],
];

const AUDIT_KILL_CLASS_LABEL: Record<SelfAuditKillClass, string> = {
  "idle-timeout": "idle timeout",
  "wall-clock-ceiling": "wall-clock ceiling",
  "tool-call-cap": "tool-call cap",
  unspecified: "kill class not recorded",
};

/**
 * Classify a rejected audit invocation (#301 B-01).
 *
 * Pure: no filesystem, no run state, no clock. A situation-specific classifier
 * over the same provider messages rather than an import of the hub's private
 * `classifyNegotiateFailure` — which would be an import cycle — exactly as
 * `classifyReviewFailure` (`src/artifacts.ts:135`) already does for guardian
 * reviews, and as the hub's own comment cites as the same approach.
 *
 * The transient check is structural (`isTransientProviderError` matches on
 * `Error.name`), so classification survives a provider bundled as a duplicate
 * module instance. Kill signatures are read before an exit code, because a
 * killed invocation's message may carry both and the bound that tripped is the
 * more specific fact.
 */
export function classifySelfAuditFailure(
  error: unknown,
): SelfAuditFailureCause {
  const message = messageOf(error);
  if (isTransientProviderError(error)) {
    return {
      kind: "transient-exhausted",
      summary: `the audit invocation exhausted its transient-outage retries: ${message}`,
    };
  }
  for (const [pattern, killClass] of AUDIT_KILL_SIGNATURES) {
    if (pattern.test(message)) {
      return {
        kind: "orchestrator-kill",
        killClass,
        summary:
          `the audit invocation was killed ` +
          `(${AUDIT_KILL_CLASS_LABEL[killClass]}): ${message}`,
      };
    }
  }
  const exit = /exited with code (\d+)/i.exec(message);
  if (exit?.[1] !== undefined) {
    return {
      kind: "provider-exit",
      exitCode: Number.parseInt(exit[1], 10),
      summary: `the audit provider exited with code ${exit[1]}: ${message}`,
    };
  }
  return {
    kind: "internal-error",
    summary: `the audit invocation failed inside the pipeline: ${message}`,
  };
}

/**
 * Whether a dead audit invocation is worth re-dispatching (#301 B-02).
 *
 * Mirrors `isInfrastructureCause` (`src/orchestrator.ts:1841-1848`) and its
 * reason: a `tool-call-cap` kill is excluded even though it is an
 * `orchestrator-kill`, because the cap only exists when a caller opted in
 * (ADR 0036), so tripping it is the configured bound doing its job rather than
 * infrastructure flaking — and a verbatim retry would spend another full budget
 * re-hitting it. An `internal-error` is a pipeline-internal throw, whose blast
 * radius a retry cannot change.
 */
export function isInfrastructureSelfAuditCause(
  cause: SelfAuditFailureCause,
): boolean {
  if (cause.killClass === "tool-call-cap") return false;
  return (
    cause.kind === "provider-exit" ||
    cause.kind === "orchestrator-kill" ||
    cause.kind === "transient-exhausted"
  );
}

/**
 * Attempts this stage may spend: `infrastructureRetries + 1`.
 *
 * A degenerate budget — absent, negative, fractional, `NaN`, `Infinity` or a
 * non-number — reads as `0` retries rather than throwing, because this stage may
 * never block a run by its own failure, its own input validation included
 * (ADR 0069 Consequences). One dispatch is always attempted.
 */
function auditAttemptBudget(retries: unknown): number {
  const usable =
    typeof retries === "number" && Number.isSafeInteger(retries) && retries >= 0
      ? retries
      : 0;
  return usable + 1;
}

export interface SelfAuditStageInput {
  /** Repo root owning the run-state file the outcome is recorded in. */
  repoRoot: string;
  prdSlug: string;
  /** The slice's GitHub issue — the key the outcome is recorded under. */
  ghIssue: string;
  /**
   * The run that is spending this invocation — `runIdFor(logger.runDir)` at the
   * hub's one call site (#301 B-06). Passed in rather than derived here, so the
   * stage never invents run identity.
   */
  runId: string;
  /** The slice's own worktree: what the audit may write, and what is re-hashed. */
  worktreeDir: string;
  /** Repo-relative slice artifact directory holding the locked pair and handoff. */
  sliceDir: string;
  /** True only on a run launched with `--self-audit` (B-01). */
  selfAudit?: boolean;
  /**
   * The released base-gate evidence. Read for its candidate tree id and never
   * mutated: the orchestrator goes on to hand this very object to the QA
   * dispatch (B-09). The tree id is optional on the caller's own type, and
   * absent counts as disagreement — an audit of a tree no evidence names is an
   * audit of the wrong thing.
   */
  qaBaseGate: { readonly candidateTreeId?: string | undefined };
  /** The candidate checkpoint the required cheap gates released. Never mutated. */
  checkpoint: { readonly treeId: string };
  /**
   * The candidate's change summary — the one envelope input not present in the
   * audit's own worktree, so the only one the hub has to supply.
   *
   * A supplier rather than a string because deriving it costs the hub a `git
   * log`, and a declined audit must cost the run nothing: with `--self-audit`
   * absent the gates-passed branch does exactly what it did before this stage
   * existed. Called once, and only on the dispatching path.
   */
  changeSummary: () => string;
  dispatch: (input: SelfAuditDispatchInput) => Promise<void>;
  /** Optional narration sink; the stage logs its decision, never its own throw. */
  log?: (message: string) => void;
  /** Project byte-budget override; stricter-only (B-06). */
  inlineSizeBudgetBytes?: number;
  /**
   * The run's `--infrastructure-retries` budget (#301 B-03). Attempts are
   * `infrastructureRetries + 1`; absent, and every degenerate value, reads as
   * `0` — one dispatch, no retry. Passed by the hub as
   * `config.infrastructureRetries ?? DEFAULT_INFRASTRUCTURE_RETRIES` so the
   * audit honours the same operator budget as ADR 0025's other retries without
   * this module importing the hub's constant.
   */
  infrastructureRetries?: number;
}

export type SelfAuditStageResult =
  /**
   * No audit happened. `spent` is present only on the resume short-circuit
   * (#301 B-07), naming the verdict a persisted outcome already recorded for the
   * tree in hand; the two declines carry no such member.
   */
  | { ran: false; spent?: SelfAuditVerdict }
  | { ran: true; verdict: SelfAuditVerdict; treeId: string };

/**
 * Run at most one audit invocation on the released candidate (#299 B-02, B-09).
 *
 * Declines — `{ ran: false }`, zero dispatches, no run-state write, no throw —
 * when the run did not opt in, and when the base-gate evidence it was handed
 * disagrees with the checkpoint it was handed. Declining rather than throwing is
 * the whole disposition of this stage: it may add scrutiny and may never block a
 * run by its own failure, so even a configuration fault inside the envelope
 * degrades to `AUDIT_NOT_RUN` on the tree the gates released instead of ending
 * the slice.
 *
 * Exactly one *completed* invocation per QA submission (#301 B-03): a dead
 * invocation whose cause classifies as infrastructure is re-dispatched under the
 * run's `--infrastructure-retries` budget and the loop exits on the first
 * attempt that completes, so a retry replaces a dead invocation rather than
 * adding a second completed one, and a tree the audit rewrote still receives no
 * second challenge.
 */
export async function runSelfAuditStage(
  input: SelfAuditStageInput,
): Promise<SelfAuditStageResult> {
  if (input.selfAudit !== true) return { ran: false };
  const releasedTreeId = input.checkpoint.treeId;
  if (input.qaBaseGate.candidateTreeId !== releasedTreeId) {
    // Not this stage's disagreement to resolve: the base-gate authorization
    // already refuses evidence whose tree is not the tree under review (ADR
    // 0012), and auditing a tree nothing released would audit the wrong thing.
    input.log?.(
      `self-audit: declined — released base-gate evidence names tree ${input.qaBaseGate.candidateTreeId ?? "(none)"}, checkpoint names ${releasedTreeId}`,
    );
    return { ran: false };
  }

  // A persisted outcome naming the tree in hand is a spent invocation (#301
  // B-07). Derived from the run-state file rather than re-derived from the tree,
  // the way `ResumeFacts.resumeAttempts` derives its count: a run killed after
  // the audit dispatched must not buy a second one on resume. Both id fields are
  // matched because a run resumed after an `AUDIT_CHANGED` re-hashes the audited
  // tree as its released tree, so the pre-audit id is no longer the id in hand.
  const spent = selfAuditsFor(
    loadRunState(input.repoRoot, input.prdSlug),
    input.ghIssue,
  ).find(
    (entry) =>
      entry.candidateTreeId === releasedTreeId ||
      entry.auditedTreeId === releasedTreeId,
  );
  if (spent !== undefined) {
    input.log?.(
      `self-audit: spent — a persisted ${spent.verdict} outcome already names tree ${releasedTreeId}`,
    );
    return { ran: false, spent: spent.verdict };
  }

  const attemptLimit = auditAttemptBudget(input.infrastructureRetries);
  let invocation = await dispatchAudit(input, releasedTreeId);
  for (let attempt = 1; attempt < attemptLimit; attempt += 1) {
    if (invocation.result.completed) break;
    const cause = classifySelfAuditFailure(invocation.error);
    if (!isInfrastructureSelfAuditCause(cause)) break;
    // The shared retry vocabulary the other retry sites use (cf.
    // `src/orchestrator.ts:5312-5322`), through this stage's existing narration
    // sink: no new typed warn event and no new warn reason (#301 non-goal).
    input.log?.(
      `self-audit: infrastructure retry ${attempt}/${attemptLimit - 1} — ${cause.summary}`,
    );
    invocation = await dispatchAudit(input, releasedTreeId);
  }
  const classification = classifySelfAuditVerdict({
    preAuditTreeId: releasedTreeId,
    ...(invocation.postAuditTreeId === undefined
      ? {}
      : { postAuditTreeId: invocation.postAuditTreeId }),
    invocation: invocation.result,
  });
  input.log?.(`self-audit: ${classification.verdict} — ${classification.reason}`);

  // Every verdict a dispatching stage reaches is recorded (#301 B-04), the two
  // graded ones (#300 B-01) and `AUDIT_NOT_RUN` alike: the verdict is a fact
  // about the audit, not about whatever the changed tree's gate re-run later
  // decides, so it is written before this function returns and whatever
  // `verifyAuditedTree` goes on to conclude. `auditedTreeId` rides only on the
  // graded verdicts — after a dead or unresolvable invocation there is nothing
  // honest to name there — and `runId` names the run that spent the invocation,
  // which is what makes the entry spent on resume rather than merely present.
  recordSelfAuditOutcome(input.repoRoot, input.prdSlug, input.ghIssue, {
    candidateTreeId: releasedTreeId,
    ...(classification.verdict === "AUDIT_NOT_RUN"
      ? {}
      : { auditedTreeId: classification.treeId }),
    verdict: classification.verdict,
    runId: input.runId,
  });
  return {
    ran: true,
    verdict: classification.verdict,
    treeId: classification.treeId,
  };
}

/**
 * Assemble, dispatch one attempt, and re-hash — reporting what happened rather than
 * throwing it. An envelope that fails closed as CONFIGURATION is reported as an
 * invocation that did not complete, so a manifest bug costs the run its audit
 * and nothing more.
 *
 * The rejection itself rides back beside the report, unwrapped: the retry
 * decision is `classifySelfAuditFailure`'s to make and a message string alone
 * would lose the structural `TransientProviderError` check (#301 B-01).
 */
async function dispatchAudit(
  input: SelfAuditStageInput,
  releasedTreeId: string,
): Promise<{
  result: SelfAuditInvocationResult;
  postAuditTreeId?: string;
  /** The rejection, when the invocation did not complete. */
  error?: unknown;
}> {
  try {
    const envelope = assembleSelfAuditEnvelope({
      sliceDir: input.sliceDir,
      candidateTreeId: releasedTreeId,
      changeSummary: input.changeSummary(),
      ...(input.inlineSizeBudgetBytes === undefined
        ? {}
        : { inlineSizeBudgetBytes: input.inlineSizeBudgetBytes }),
    });
    await input.dispatch({
      prompt: envelope.prompt,
      evidence: envelope.evidence,
    });
  } catch (error) {
    return {
      result: { completed: false, detail: messageOf(error) },
      error,
    };
  }
  try {
    return {
      result: { completed: true },
      postAuditTreeId: resolveCandidateTreeId(input.worktreeDir),
    };
  } catch {
    // The invocation completed but the tree it left cannot be named. Reported
    // as unresolved rather than as equal: guessing "unchanged" here would
    // release an audited tree nothing hashed.
    return { result: { completed: true } };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* ---------------------------------------------------------------------------
 * The changed-tree path (#300, ADR 0069)
 *
 * A tree the audit rewrote has not been through the required cheap gates, so it
 * is not a candidate anyone may grade yet. What follows re-runs exactly the
 * gates that released the pre-audit tree on the audited one and, on a pass,
 * mints the *one* graded-candidate identity every pass-path consumer reads.
 * Orchestration lives here behind injected callbacks — one call site in the hub
 * (ARCHITECTURE.md "Hubs — do not grow these") — for the same reason
 * `runSelfAuditStage` takes an injected dispatch: the whole path is exercised
 * without a git process, a provider or a spawned pipeline.
 * ------------------------------------------------------------------------- */

/**
 * The base-gate evidence an audited gate re-run produces, declared
 * **structurally** rather than by importing `QABaseGateEvidence` from
 * `src/orchestrator.ts`: the hub imports this module, so importing its type back
 * would be a cycle. `pnpm run typecheck` proves the two shapes agree at the
 * assignment in the hub, which is the check that matters.
 *
 * `candidateTreeId` is required here, not optional: an audited authorization
 * that names no tree would authorize a skip for nothing (ADR 0012).
 */
export interface AuditedBaseGateEvidence {
  evidence: GateEvidence;
  /** Repo-relative path of the re-run's own verified evidence artifact. */
  evidenceArtifactId: string;
  /** The selected subset that actually re-ran — never the full pre-QA set. */
  declarations: readonly GateDeclaration[];
  candidateTreeId: string;
}

/**
 * The tree QA grades, the commit holding it, and the base-gate evidence that
 * released it — one value rather than three, because the risk this shape exists
 * to close is a divergence between consumers and a single value cannot diverge
 * from itself (#300 settled decision, 2026-09-15).
 */
export interface GradedCandidateIdentity<TBaseGate> {
  treeId: string;
  commitSha: string;
  baseGate: TBaseGate;
}

/** What an injected checkpoint mint hands back; `createCandidateCheckpoint`'s shape. */
export interface AuditedCheckpoint {
  readonly treeId: string;
  readonly commitSha: string;
  /** Present when the checkpoint was materialized, as the gate cwd. */
  readonly worktreeDir?: string | undefined;
}

/**
 * Everything the audited gate re-run needs, and deliberately no way to dispatch
 * an agent (#300 B-07): this input declares no such callback, so a changed tree
 * cannot be challenged a second time by construction rather than by a counter.
 */
export interface AuditedTreeVerificationInput {
  /** Root the evidence artifact id is made relative to. */
  repoRoot: string;
  /**
   * Where the audited checkpoint is materialized. Must differ from the round's
   * own `checkpointDir`: `createCandidateCheckpoint` throws when its target
   * already exists.
   */
  checkpointDir: string;
  /** The round's gate evidence directory, reused unchanged. */
  evidenceDir: string;
  /** The selected declarations, from {@link selectAuditedGateDeclarations}. */
  declarations: readonly GateDeclaration[];
  createCheckpoint: (dir: string) => AuditedCheckpoint;
  /** Registers the minted tree as the attempt's current candidate (B-10). */
  onCandidateTree: (treeId: string) => void;
  runGates: (input: {
    treeId: string;
    cwd: string;
    declarations: readonly GateDeclaration[];
  }) => Promise<CandidateGatePhaseResult>;
}

export type AuditedTreeVerification =
  | {
      outcome: "PASS";
      graded: GradedCandidateIdentity<AuditedBaseGateEvidence>;
      artifacts: readonly GateEvidenceArtifact[];
    }
  | {
      outcome: "REPAIR";
      auditedTreeId: string;
      failedGateIds: string[];
      evidenceReferences: string[];
      artifacts: readonly GateEvidenceArtifact[];
    };

/**
 * The re-run set: the round's own pre-QA declarations whose id the cheap gate
 * catalog names `required` (#300 B-03).
 *
 * Pure — the catalog is a parameter, not a filesystem read — and the elements are
 * the *same declaration objects*, so the commands, args and required flags that
 * re-run are byte-identical to the ones that released the pre-audit tree. A
 * declaration the catalog does not name is excluded: the acceptance gate declares
 * no `expectedCostMs`, and a gate whose price is undeclared cannot be asserted
 * cheap.
 */
export function selectAuditedGateDeclarations(
  declarations: readonly GateDeclaration[],
  cheapGateCatalog: readonly { id: string; required: boolean }[],
): readonly GateDeclaration[] {
  const requiredCheapIds = new Set(
    cheapGateCatalog.filter((gate) => gate.required).map((gate) => gate.id),
  );
  return declarations.filter((declaration) =>
    requiredCheapIds.has(declaration.id),
  );
}

/**
 * Re-run the selected cheap gates on the tree the audit left behind (#300 B-02,
 * B-04, B-10).
 *
 * A `PASS` carries the one graded-candidate identity; a `REPAIR` carries what the
 * existing bounded repair loop needs and spends no new counter. The audited tree
 * is registered as the attempt's candidate before the gates run, so it is named
 * on both branches.
 */
export async function verifyAuditedTree(
  input: AuditedTreeVerificationInput,
): Promise<AuditedTreeVerification> {
  const audited = input.createCheckpoint(input.checkpointDir);
  input.onCandidateTree(audited.treeId);
  const run = await input.runGates({
    treeId: audited.treeId,
    cwd: audited.worktreeDir ?? input.checkpointDir,
    declarations: input.declarations,
  });
  const failures = requiredAuditedGateFailures(run, input.declarations);
  if (failures.length > 0) {
    return {
      outcome: "REPAIR",
      auditedTreeId: audited.treeId,
      failedGateIds: [...new Set(failures.map(({ result }) => result.gateId))],
      evidenceReferences: [
        ...new Set(failures.map(({ evidencePath }) => displayPath(evidencePath))),
        ...failures.map(({ result }) =>
          displayPath(join(input.evidenceDir, result.logArtifactId)),
        ),
      ],
      artifacts: run.artifacts,
    };
  }
  // Additive, on the audited tree: the pre-audit release sequence keeps its own
  // text and order (P-06), and this asserts the same two things again over the
  // re-run's evidence and the audited tree id.
  assertGateEvidenceReleasesEvaluation(
    run.evidence,
    input.declarations,
    audited.treeId,
  );
  for (const artifact of run.artifacts) verifyGateEvidence(artifact);
  return {
    outcome: "PASS",
    graded: {
      treeId: audited.treeId,
      commitSha: audited.commitSha,
      // Built fresh from the re-run's own evidence. Never a spread of the
      // pre-audit base-gate object, which silently drops ADR 0012's skip
      // authorization, and never that object passed through, which authorizes a
      // skip for a tree QA is not grading. The declarations it vouches for are
      // the selected subset, so the evaluator still runs everything else.
      baseGate: {
        evidence: run.evidence,
        evidenceArtifactId: displayPath(
          relative(input.repoRoot, run.evidencePath),
        ),
        declarations: input.declarations,
        candidateTreeId: audited.treeId,
      },
    },
    artifacts: run.artifacts,
  };
}

/**
 * The one graded-candidate binding (#300 B-08).
 *
 * An audited `PASS` resolves to the audited triple; `AUDIT_UNCHANGED`,
 * `AUDIT_NOT_RUN`, a declined stage and an audited `REPAIR` all resolve to the
 * released pair and the released base-gate object *by reference*, so every
 * non-changed path does exactly what it does today. Pure: no filesystem, no run
 * state, no clock.
 */
export function resolveGradedCandidate<TBaseGate>(input: {
  released: { readonly treeId: string; readonly commitSha: string };
  releasedBaseGate: TBaseGate;
  audited?: GradedCandidateIdentity<TBaseGate> | undefined;
}): GradedCandidateIdentity<TBaseGate> {
  if (input.audited !== undefined) return input.audited;
  return {
    treeId: input.released.treeId,
    commitSha: input.released.commitSha,
    baseGate: input.releasedBaseGate,
  };
}

/**
 * The audited re-run's own pass/fail evaluation, in the shape
 * `collectRequiredGateFailures` (`src/orchestrator.ts`) uses for the pre-audit
 * run. Read from every attempt, not only the last, for the same reason: an
 * infrastructure retry's earlier attempt still names evidence the generator has
 * to read.
 */
function requiredAuditedGateFailures(
  run: CandidateGatePhaseResult,
  declarations: readonly GateDeclaration[],
): Array<{ evidencePath: string; result: GateResult }> {
  const requiredIds = new Set(
    declarations
      .filter((declaration) => declaration.required)
      .map((declaration) => declaration.id),
  );
  return run.attempts.flatMap(({ evidence, evidencePath }) =>
    evidence.results
      .filter(
        (result) => requiredIds.has(result.gateId) && result.status === "FAIL",
      )
      .map((result) => ({ evidencePath, result })),
  );
}

function displayPath(path: string): string {
  return path.replace(/\\/g, "/");
}

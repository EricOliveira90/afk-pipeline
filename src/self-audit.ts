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
import {
  assembleSelfAuditEnvelope,
  type RoleEnvelopeEvidence,
} from "./context-envelope.js";
import { resolveCandidateTreeId } from "./gate-runner.js";
import {
  recordSelfAuditOutcome,
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

export interface SelfAuditStageInput {
  /** Repo root owning the run-state file the outcome is recorded in. */
  repoRoot: string;
  prdSlug: string;
  /** The slice's GitHub issue — the key the outcome is recorded under. */
  ghIssue: string;
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
}

export type SelfAuditStageResult =
  | { ran: false }
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
 * Exactly one dispatch per QA submission, bounded by construction: there is no
 * loop here, no retry, and no second challenge for a tree the audit rewrote.
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

  const invocation = await dispatchAudit(input, releasedTreeId);
  const classification = classifySelfAuditVerdict({
    preAuditTreeId: releasedTreeId,
    ...(invocation.postAuditTreeId === undefined
      ? {}
      : { postAuditTreeId: invocation.postAuditTreeId }),
    invocation: invocation.result,
  });
  input.log?.(`self-audit: ${classification.verdict} — ${classification.reason}`);

  // Only `AUDIT_UNCHANGED` is recorded here: this slice lands the persisted
  // shape for all three verdicts so neither sibling slice needs a second
  // version bump, but the changed-tree path is #300's and the dead-invocation
  // taxonomy is #301's.
  if (classification.verdict === "AUDIT_UNCHANGED") {
    recordSelfAuditOutcome(input.repoRoot, input.prdSlug, input.ghIssue, {
      candidateTreeId: releasedTreeId,
      auditedTreeId: classification.treeId,
      verdict: "AUDIT_UNCHANGED",
    });
  }
  return {
    ran: true,
    verdict: classification.verdict,
    treeId: classification.treeId,
  };
}

/**
 * Assemble, dispatch once, and re-hash — reporting what happened rather than
 * throwing it. An envelope that fails closed as CONFIGURATION is reported as an
 * invocation that did not complete, so a manifest bug costs the run its audit
 * and nothing more.
 */
async function dispatchAudit(
  input: SelfAuditStageInput,
  releasedTreeId: string,
): Promise<{
  result: SelfAuditInvocationResult;
  postAuditTreeId?: string;
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

/**
 * One bounded repair pass for a refused negotiation artifact (ADR 0061).
 *
 * The negotiation validators are deliberately strict and every rejection is
 * terminal for the invocation (ADR 0017): there is no default verdict, so a
 * malformed `contract-review.json` or `contract-response.json` ends the slice
 * in ERROR. Field evidence from PRD 072 (#188 defect 1) is that the strictness
 * is right and the *exit* is premature — three separate invocations died on
 * three different single-field defects (`severity: "MINOR"`, a stale
 * `revisionCitation.after`, a response declaring the wrong round), none of
 * which the agent had been told about.
 *
 * A repair pass hands the agent the exact validation error and asks for the
 * same artifact again. It is a pass, not a round: the negotiation round number,
 * the routed finding set and the durable lineage are all unchanged, so a repair
 * cannot buy the planner another revision or launder a finding away. When the
 * budget is spent the original terminal exit is taken, with the last defect
 * named exactly as before.
 */

/**
 * Repair passes allowed per artifact per round. One: a second identical
 * failure is evidence the prompt and the validator disagree about the schema,
 * which is a defect to fix here rather than to retry at an agent.
 */
export const DEFAULT_NEGOTIATION_ARTIFACT_REPAIRS = 1;

export type NegotiationArtifactRepairDecision =
  | { action: "repair"; instruction: string }
  | { action: "stop"; reason: string };

export interface NegotiationArtifactRepairRequest {
  /** The artifact filename the agent must rewrite, e.g. `contract-review.json`. */
  artifact: string;
  /** The validation error verbatim. Never paraphrased: it is the whole value. */
  defect: string;
  /**
   * Whether the refused artifact is on disk. A repair pass answers an agent
   * that did the work and got a field wrong; an absent artifact means the
   * agent's whole output is missing, which is the ADR 0017 case and stays
   * terminal — there is no validation error to feed back, only "it is
   * missing", and the invocation retry policy has already had its say about
   * an attempt that produced nothing.
   */
  artifactWritten: boolean;
  /**
   * Repair passes already spent on this artifact in this round. Loop state in
   * the caller, not persisted: the budget is per round per *process*, and a
   * crash mid-round grants the rerun a fresh pass (ADR 0061).
   */
  repairsUsed: number;
  /**
   * Override the budget. No production caller sets it and none is expected to
   * — the seam exists so a test can pin the boundary without depending on the
   * default's value. If a flag ever needs to raise it, that flag is the change,
   * not this field.
   */
  repairLimit?: number;
}

/**
 * The control-plane block a repair pass adds to the agent's envelope. It says
 * three things and no more: what was refused, the exact reason, and that this
 * is not a new round.
 */
export function formatNegotiationArtifactRepairInstruction(input: {
  artifact: string;
  defect: string;
}): string {
  return [
    `Your ${input.artifact} was refused by deterministic validation, so this ` +
      `round recorded no result. This is a repair pass, not a new round: the ` +
      `round number, the findings routed to it, and every other artifact stay ` +
      `exactly as they are.`,
    "",
    "Exact validation error:",
    "",
    input.defect,
    "",
    `Rewrite ${input.artifact} so that error cannot recur, and change nothing ` +
      `else — no new findings, no renamed IDs, no revised judgment beyond what ` +
      `the error names. The corrected artifact is the whole answer; do not ` +
      `explain the error in prose.`,
    "",
    `Every other artifact this round produced is already on disk and is ` +
      `already accepted. Leave those files exactly as they are: rewriting ` +
      `them is the "something else" this pass forbids, and deleting one ` +
      `would spend the round the pass exists not to spend.`,
  ].join("\n");
}

/**
 * Decide whether a refused negotiation artifact earns another attempt.
 *
 * Pure policy: the caller owns the invocation, the archive and the terminal
 * exit. A blank defect stops — an empty error message gives the agent nothing
 * to repair, and re-prompting on it would spend a dispatch to learn nothing.
 * Neither production call site can currently produce a blank defect; that arm
 * guards future callers, and it is cheaper than an invariant comment nobody
 * checks.
 */
export function decideNegotiationArtifactRepair(
  input: NegotiationArtifactRepairRequest,
): NegotiationArtifactRepairDecision {
  const limit = input.repairLimit ?? DEFAULT_NEGOTIATION_ARTIFACT_REPAIRS;
  if (input.repairsUsed >= limit) {
    return {
      action: "stop",
      reason:
        `the ${limit} repair pass(es) allowed for ${input.artifact} in this ` +
        `round were already spent`,
    };
  }
  if (!input.artifactWritten) {
    return {
      action: "stop",
      reason: `${input.artifact} was never written, so there is no artifact to repair`,
    };
  }
  if (input.defect.trim() === "") {
    return {
      action: "stop",
      reason: `the ${input.artifact} refusal carried no validation error to repair`,
    };
  }
  return {
    action: "repair",
    instruction: formatNegotiationArtifactRepairInstruction({
      artifact: input.artifact,
      defect: input.defect,
    }),
  };
}

import type {
  GuardianFindingDisposition,
  GuardianKind,
} from "./artifacts.js";

export interface GuardianBlockingAuthorityInput {
  guardian: GuardianKind;
  round: number;
  hasPriorLineage: boolean;
  class: string;
  disposition: GuardianFindingDisposition;
  reachableTrigger: string | null;
  introducedByReviewedDiff: boolean | null;
}

const LATER_NEW_BLOCKING_CLASSES = new Set(["INTEGRITY", "DATA_LOSS"]);

/**
 * Decide whether one structured finding may contribute blocking authority.
 *
 * PM keeps its existing verdict authority. Architect authority is narrower:
 * round-1 findings must be reachable and attributed to the reviewed diff;
 * later findings with prior lineage may remain blocking while uncleared; and
 * later-new findings additionally require an integrity or data-loss class.
 */
export function guardianFindingMayBlock(
  input: GuardianBlockingAuthorityInput,
): boolean {
  if (input.guardian === "pm") return true;
  if (
    input.disposition === "RESOLVED" ||
    input.reachableTrigger === null ||
    input.reachableTrigger.trim() === ""
  ) {
    return false;
  }
  if (input.round === 1) {
    return input.introducedByReviewedDiff === true;
  }
  if (input.hasPriorLineage) return true;
  return (
    input.introducedByReviewedDiff === true &&
    LATER_NEW_BLOCKING_CLASSES.has(input.class)
  );
}

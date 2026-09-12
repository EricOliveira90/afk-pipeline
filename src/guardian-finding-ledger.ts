import { type GuardianKind } from "./artifacts.js";
import { guardianFindingMayBlock } from "./guardian-blocking-authority.js";
import type {
  PersistedGuardianFinding,
  PersistedGuardianReviewRound,
} from "./guardian-round-records.js";

export type { GuardianKind } from "./artifacts.js";

/**
 * One finding as the ledger last recorded it, with the two facts the filing
 * and cap decisions need: whether it carried blocking authority in that round,
 * and the identity to file it under.
 */
export interface LedgerFinding {
  guardian: GuardianKind;
  /** The round this entry was last reported in. */
  round: number;
  finding: PersistedGuardianFinding;
  /**
   * Whether this finding blocked the gate in that round. `false` makes it a
   * note — the distinction slice #174 files on, and the one that keeps a PM
   * ACCEPT-WITH-NOTES finding out of the cap's blocker list.
   */
  blocking: boolean;
  /** Normalized class + clear condition: the ledger's content identity. */
  fingerprint: string;
}

/**
 * The content half of a ledger identity, normalized the same way
 * `advanceGuardianFindingLineage` normalizes it so the two agree on what
 * "the same finding, renamed" means.
 */
export function guardianFindingFingerprint(finding: {
  class: string;
  clearCondition: string;
}): string {
  const normalize = (value: string) =>
    value.trim().replace(/\s+/g, " ").toLowerCase();
  return JSON.stringify([
    normalize(finding.class),
    normalize(finding.clearCondition),
  ]);
}

/**
 * Fold the whole guardian ledger to the latest entry per stable identity,
 * classified blocker-or-note.
 *
 * A finding blocks only inside a round the guardian actually blocked on: a
 * `FIX-BEFORE-SHIP` record, and — for the architect — a finding that satisfies
 * its branch of the round-aware rubric (ADR 0057 decision 3, #172). Under an
 * `ACCEPT-WITH-NOTES` verdict every finding is a note, which is what makes the
 * PM path work: `guardianFindingMayBlock` grants the PM unconditional
 * authority because ADR 0057 leaves its *verdict* rules alone, so the verdict
 * is the only thing that separates a PM blocker from a PM note.
 *
 * Only `INVOKED` records are folded. A `CACHE` record is a verbatim copy of an
 * earlier round's findings (`sanitizeGuardianRounds` enforces `sameFindings`
 * against its origin) whose outcome is always favorable, so folding it would
 * re-observe entries this fold already holds and attribute them to a round
 * that never re-read the tree. Its findings still count as prior lineage,
 * exactly as `runShipGate` and `sanitizeGuardianRounds` count them when they
 * ask the same authority question.
 *
 * A finding a later round omitted keeps its last recorded entry, so an
 * obligation nobody dispositioned survives to be filed rather than vanishing.
 */
export function foldGuardianLedger(
  rounds: readonly PersistedGuardianReviewRound[],
): LedgerFinding[] {
  const latest = new Map<string, LedgerFinding>();
  for (const guardian of ["architect", "pm"] as const) {
    const priorStableIds = new Set<string>();
    for (const round of rounds) {
      const record = round[guardian];
      if (record.source === "INVOKED") {
        for (const finding of record.findings) {
          const blocking =
            record.outcome === "FIX-BEFORE-SHIP" &&
            guardianFindingMayBlock({
              guardian,
              round: round.round,
              hasPriorLineage: priorStableIds.has(finding.stableId),
              class: finding.class,
              disposition: finding.disposition,
              reachableTrigger: finding.reachableTrigger,
              introducedByReviewedDiff: finding.introducedByReviewedDiff,
            });
          latest.set(`${guardian} ${finding.stableId}`, {
            guardian,
            round: round.round,
            finding,
            blocking,
            fingerprint: guardianFindingFingerprint(finding),
          });
        }
      }
      for (const finding of record.findings) {
        priorStableIds.add(finding.stableId);
      }
    }
  }
  return [...latest.values()];
}

/** Findings that still block and that no round has cleared. */
export function unresolvedBlockingFindings(
  folded: readonly LedgerFinding[],
): LedgerFinding[] {
  return folded.filter(
    (entry) => entry.blocking && entry.finding.disposition !== "RESOLVED",
  );
}

/**
 * Notes that would ship unfixed: non-blocking and never cleared. These are
 * what slice #174 files exactly once, keyed by ledger identity.
 */
export function unresolvedNoteFindings(
  folded: readonly LedgerFinding[],
): LedgerFinding[] {
  return folded.filter(
    (entry) => !entry.blocking && entry.finding.disposition !== "RESOLVED",
  );
}

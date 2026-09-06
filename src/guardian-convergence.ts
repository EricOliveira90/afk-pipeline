import type { GuardianReviewFinding } from "./artifacts.js";
import type {
  PersistedGuardianFinding,
  PersistedGuardianReviewRound,
} from "./run-state.js";

export type GuardianKind = "architect" | "pm";

function normalizedFingerprint(finding: {
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

function priorFindings(
  rounds: readonly PersistedGuardianReviewRound[],
  guardian: GuardianKind,
): PersistedGuardianFinding[] {
  return [...rounds]
    .reverse()
    .flatMap((round) => [...round[guardian].findings].reverse());
}

/**
 * Assign stable identities to one guardian's newly parsed findings.
 *
 * IDs are authoritative even when the finding's fingerprint changed. Only an
 * ID miss permits the normalized class + clear-condition fallback.
 */
export function advanceGuardianFindingLineage(
  rounds: readonly PersistedGuardianReviewRound[],
  guardian: GuardianKind,
  findings: readonly GuardianReviewFinding[],
): PersistedGuardianFinding[] {
  const prior = priorFindings(rounds, guardian);
  // Matching is one-to-one within a round: a prior stable identity can be
  // claimed by exactly one current finding. Two findings sharing a fingerprint
  // used to claim the same prior stableId, and `sanitizeReviewPhase` drops a
  // whole ledger whose stable IDs repeat — the round became non-durable (QA-05).
  const claimed = new Set<string>();
  const resolved = new Array<string | null>(findings.length).fill(null);
  // ID matches resolve first, across all findings, so the ID-first precedence
  // holds even when another finding's fingerprint points at the same entry.
  findings.forEach((finding, index) => {
    const idMatch = prior.find(
      (entry) =>
        entry.currentId === finding.id || entry.stableId === finding.id,
    );
    if (idMatch && !claimed.has(idMatch.stableId)) {
      claimed.add(idMatch.stableId);
      resolved[index] = idMatch.stableId;
    }
  });
  findings.forEach((finding, index) => {
    if (resolved[index] !== null) return;
    const fingerprintMatch = prior.find(
      (entry) =>
        !claimed.has(entry.stableId) &&
        normalizedFingerprint(entry) === normalizedFingerprint(finding),
    );
    if (fingerprintMatch) {
      claimed.add(fingerprintMatch.stableId);
      resolved[index] = fingerprintMatch.stableId;
    }
  });
  return findings.map((finding, index) => {
    // No match, or every candidate already claimed: the finding keeps its own
    // ID as a new stable identity. It cannot collide with a claimed one — a
    // finding whose ID equals a prior stable identity resolves in the ID pass.
    const stableId = resolved[index] ?? finding.id;
    claimed.add(stableId);
    return {
      stableId,
      currentId: finding.id,
      title: finding.title,
      class: finding.class,
      clearCondition: finding.clearCondition,
      disposition: finding.disposition,
    };
  });
}

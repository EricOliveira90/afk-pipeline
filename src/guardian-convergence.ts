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
  return findings.map((finding) => {
    const idMatch = prior.find(
      (entry) =>
        entry.currentId === finding.id || entry.stableId === finding.id,
    );
    const fingerprintMatch =
      idMatch ??
      prior.find(
        (entry) =>
          normalizedFingerprint(entry) === normalizedFingerprint(finding),
      );
    return {
      stableId: fingerprintMatch?.stableId ?? finding.id,
      currentId: finding.id,
      title: finding.title,
      class: finding.class,
      clearCondition: finding.clearCondition,
      disposition: finding.disposition,
    };
  });
}

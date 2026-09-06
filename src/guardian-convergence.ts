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
 * ID miss permits the normalized class + clear-condition fallback. Distinct
 * findings that name one prior entry through its stable and current aliases
 * remain distinct records while sharing that prior stable identity.
 */
export function advanceGuardianFindingLineage(
  rounds: readonly PersistedGuardianReviewRound[],
  guardian: GuardianKind,
  findings: readonly GuardianReviewFinding[],
): PersistedGuardianFinding[] {
  const prior = priorFindings(rounds, guardian);
  // ID matches may share a prior stable identity when distinct known aliases
  // name it. Fingerprint fallback remains one-to-one: once any ID claims an
  // identity, a fingerprint-only finding cannot take it (QA-05).
  const claimed = new Set<string>();
  const resolved = new Array<string | null>(findings.length).fill(null);
  // ID matches resolve first, across all findings, so the ID-first precedence
  // holds even when another finding's fingerprint points at the same entry.
  // Stable aliases resolve before current aliases when prior entries overlap.
  for (const aliasOf of [
    (entry: PersistedGuardianFinding) => entry.stableId,
    (entry: PersistedGuardianFinding) => entry.currentId,
  ]) {
    findings.forEach((finding, index) => {
      if (resolved[index] !== null) return;
      const idMatch = prior.find((entry) => aliasOf(entry) === finding.id);
      if (idMatch) {
        claimed.add(idMatch.stableId);
        resolved[index] = idMatch.stableId;
      }
    });
  }
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
    // No match at all: the finding's own ID becomes its new stable identity.
    // It cannot collide with a claimed one because a known ID resolves above.
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

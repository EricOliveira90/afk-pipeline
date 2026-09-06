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
  // The canonical alias resolves before the current alias: when two findings
  // name one prior entry through its two aliases, the `stableId` claimant is
  // the one that keeps it, whatever order they arrived in.
  for (const aliasOf of [
    (entry: PersistedGuardianFinding) => entry.stableId,
    (entry: PersistedGuardianFinding) => entry.currentId,
  ]) {
    findings.forEach((finding, index) => {
      if (resolved[index] !== null) return;
      const idMatch = prior.find((entry) => aliasOf(entry) === finding.id);
      if (idMatch && !claimed.has(idMatch.stableId)) {
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
  // A finding whose ID names a prior entry whose identity another finding
  // already claimed is that same finding reported twice under its two aliases.
  // It is folded into the entry that holds the identity: minting a new stable
  // ID for a known alias would contradict the locked identity rule (QA-07),
  // and repeating the claimed one drops the whole ledger at sanitization.
  const aliasDuplicate = (finding: GuardianReviewFinding, index: number) => {
    if (resolved[index] !== null) return false;
    const idMatch = prior.find(
      (entry) =>
        entry.currentId === finding.id || entry.stableId === finding.id,
    );
    return idMatch !== undefined && claimed.has(idMatch.stableId);
  };
  return findings.flatMap((finding, index) => {
    if (aliasDuplicate(finding, index)) return [];
    // No match at all: the finding's own ID becomes its new stable identity.
    // It cannot collide with a claimed one — a finding whose ID names a prior
    // identity is either its claimant or folded away as an alias duplicate.
    const stableId = resolved[index] ?? finding.id;
    claimed.add(stableId);
    return [{
      stableId,
      currentId: finding.id,
      title: finding.title,
      class: finding.class,
      clearCondition: finding.clearCondition,
      disposition: finding.disposition,
    }];
  });
}

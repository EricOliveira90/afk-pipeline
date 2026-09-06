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
 *
 * Returns `undefined` when the result cannot be represented as a durable
 * round: two findings whose IDs name one prior entry through its `stableId`
 * and its `currentId`. All three alternatives contradict something the
 * contract locks — minting a new identity for a known alias breaks the
 * ID-first rule, repeating the claimed identity makes the whole ledger
 * non-durable at sanitization, and folding one away omits a parsed finding.
 * So the findings block is treated as malformed, which B-04 already answers:
 * the guardian's outcome becomes `UNPARSEABLE`, the round is still recorded,
 * and nothing is silently dropped.
 */
export function advanceGuardianFindingLineage(
  rounds: readonly PersistedGuardianReviewRound[],
  guardian: GuardianKind,
  findings: readonly GuardianReviewFinding[],
): PersistedGuardianFinding[] | undefined {
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
  // An unresolved finding whose ID still names a prior entry lost that entry
  // to another finding: the two are aliases of one identity, and no durable
  // representation of both exists. Refuse the block rather than pick a rule to
  // break.
  const aliasCollision = findings.some((finding, index) => {
    if (resolved[index] !== null) return false;
    const idMatch = prior.find(
      (entry) =>
        entry.currentId === finding.id || entry.stableId === finding.id,
    );
    return idMatch !== undefined && claimed.has(idMatch.stableId);
  });
  if (aliasCollision) return undefined;
  return findings.map((finding, index) => {
    // No match at all: the finding's own ID becomes its new stable identity.
    // It cannot collide with a claimed one — a finding whose ID names a prior
    // identity either claims it or triggers the refusal above.
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

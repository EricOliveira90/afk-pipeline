import type {
  GuardianKind,
  GuardianReviewFinding,
} from "./artifacts.js";
import type {
  PersistedGuardianFinding,
  PersistedGuardianReviewRound,
} from "./run-state.js";

export type { GuardianKind } from "./artifacts.js";

type GuardianFindingLineageInput = Omit<
  GuardianReviewFinding,
  "reachableTrigger" | "introducedByReviewedDiff"
> &
  Partial<
    Pick<
      GuardianReviewFinding,
      "reachableTrigger" | "introducedByReviewedDiff"
    >
  >;

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

/**
 * Whether an ID match may resolve a finding onto a prior identity.
 *
 * The single statement of the rule #240 and #247 are two expressions of. Every
 * lineage in this codebase resolved identity ID-first and treated the
 * fingerprint as a fallback for "same obligation, renamed ID". Nothing guarded
 * the inverse — "same ID, different obligation" — which is what a fresh round
 * or a restart-from-base produces the moment the low IDs it numbers from are
 * already spent. An ID alone is therefore not identity: it must be
 * corroborated, either by the fingerprint agreeing (the same obligation,
 * stated the same way) or by `priorIsLive` — the prior identity is still an
 * open obligation in the *same* numbering, where one reviewer's IDs are
 * authoritative and its wording legitimately drifts round to round.
 *
 * Callers that have no liveness signal pass `priorIsLive: false`, which reduces
 * the rule to "the fingerprint must agree". That is the right reading for a
 * guardian: a guardian closes a note by ceasing to report it rather than by
 * recording a terminal disposition, so a live prior disposition proves nothing.
 */
export function idMatchIsCorroborated(args: {
  fingerprintAgrees: boolean;
  priorIsLive: boolean;
}): boolean {
  return args.fingerprintAgrees || args.priorIsLive;
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
 * An ID match is authoritative only when the normalized class +
 * clear-condition fingerprint agrees ({@link idMatchIsCorroborated}); an ID
 * whose fingerprint disagrees names a different obligation and mints a fresh
 * identity (#247). An ID miss still permits the fingerprint fallback, which
 * searches every prior occurrence, so an identity whose wording drifted for one
 * round and reverted rejoins its own lineage.
 *
 * Identity resolution is one-to-one within a round (ADR 0057 decision 1,
 * amendment 2026-09-06): one prior entry's stable identity goes to at most
 * one of this round's findings. When two findings both reach one prior
 * identity — possible because an identity is matched through both its
 * `stableId` and its `currentId` — the prior `stableId` goes to the claimant
 * whose normalized class + clear-condition fingerprint also matches; when
 * neither fingerprint matches, to the claimant whose ID equals the prior
 * `stableId`. Every other claimant receives a new stable identity and keeps
 * its guardian-provided ID as `currentId`, so `stableId` stays unique within
 * the record and cross-round matching stays order-independent.
 */
export function advanceGuardianFindingLineage(
  rounds: readonly PersistedGuardianReviewRound[],
  guardian: GuardianKind,
  findings: readonly GuardianFindingLineageInput[],
): PersistedGuardianFinding[] {
  const prior = priorFindings(rounds, guardian);
  const claimed = new Set<string>();
  const resolved = new Array<string | null>(findings.length).fill(null);
  // A tiebreak loser may not take another identity by fingerprint: the
  // amendment sends every losing claimant straight to a new identity.
  const mustMint = new Set<number>();

  // ID matches resolve first, across all findings, so the ID-first precedence
  // holds even when another finding's fingerprint points at the same entry.
  // Each finding names at most one prior identity; the stable alias outranks
  // the current alias when one ID could name two identities.
  const claimants = new Map<
    string,
    { index: number; entry: PersistedGuardianFinding }[]
  >();
  findings.forEach((finding, index) => {
    const entry =
      prior.find((candidate) => candidate.stableId === finding.id) ??
      prior.find((candidate) => candidate.currentId === finding.id);
    if (!entry) return;
    // An uncontested ID match used to win with no fingerprint comparison at
    // all — the tiebreak below only ran for two or more claimants — so a round
    // reusing a spent ID absorbed the prior identity and overwrote its title
    // and clear condition (#247). Corroborate every claim, so a reused ID that
    // carries a different obligation never reaches the tiebreak and mints a
    // fresh identity instead.
    if (
      !idMatchIsCorroborated({
        fingerprintAgrees:
          normalizedFingerprint(finding) === normalizedFingerprint(entry),
        priorIsLive: false,
      })
    ) {
      return;
    }
    const list = claimants.get(entry.stableId) ?? [];
    list.push({ index, entry });
    claimants.set(entry.stableId, list);
  });
  for (const [stableId, group] of claimants) {
    // Contested identity: the fingerprint-matching claimant wins; with no
    // (or no unique) fingerprint match, the `stableId` claimant wins; as a
    // last resort the claimant of the most recent alias wins. `group` holds
    // at most one claimant per alias, so every rule is order-independent.
    const fingerprintMatches = group.filter(
      ({ index, entry }) =>
        normalizedFingerprint(findings[index]!) === normalizedFingerprint(entry),
    );
    const pool = fingerprintMatches.length > 0 ? fingerprintMatches : group;
    const winner =
      (fingerprintMatches.length === 1 ? fingerprintMatches[0] : undefined) ??
      pool.find(({ index }) => findings[index]!.id === stableId) ??
      pool.reduce((best, claim) =>
        prior.indexOf(claim.entry) < prior.indexOf(best.entry) ? claim : best,
      );
    claimed.add(stableId);
    resolved[winner.index] = stableId;
    for (const { index } of group) {
      if (index !== winner.index) mustMint.add(index);
    }
  }

  // Fingerprint fallback stays one-to-one: once any ID claims an identity, a
  // fingerprint-only finding cannot take it (QA-05).
  findings.forEach((finding, index) => {
    if (resolved[index] !== null || mustMint.has(index)) return;
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

  // A new identity starts from the finding's own ID, which collides with a
  // claimed identity for a tiebreak loser whose ID equals the contested
  // `stableId`, and with an unclaimed *prior* identity for a finding that
  // reused a spent ID; a deterministic suffix keeps that identity genuinely
  // new. Minting the bare ID in the second case would hand the fresh
  // obligation the prior one's identity, which is the #247 overwrite by
  // another route.
  const mintStableId = (id: string): string => {
    if (!claimed.has(id) && !prior.some((entry) => entry.stableId === id)) {
      return id;
    }
    for (let n = 2; ; n++) {
      const candidate = `${id}-${n}`;
      if (
        !claimed.has(candidate) &&
        !prior.some((entry) => entry.stableId === candidate)
      ) {
        return candidate;
      }
    }
  };
  return findings.map((finding, index) => {
    const stableId = resolved[index] ?? mintStableId(finding.id);
    claimed.add(stableId);
    return {
      stableId,
      currentId: finding.id,
      title: finding.title,
      class: finding.class,
      clearCondition: finding.clearCondition,
      disposition: finding.disposition,
      reachableTrigger: finding.reachableTrigger ?? null,
      introducedByReviewedDiff:
        finding.introducedByReviewedDiff ?? null,
    };
  });
}

import type { ReviewOutcome } from "./artifacts.js";
import { isOperationalReviewOutcome } from "./artifacts.js";
import type { PersistedGuardianReviewRound } from "./guardian-round-records.js";

/**
 * Unfavorable guardian rounds the gate spends before it stops fixing.
 *
 * 3 matches ADR 0014's implementation cap, and ADR 0057 decision 4 adopts that
 * number deliberately: the measured runs that motivated the ADR produced their
 * last genuinely new blocking finding well inside three rounds and then
 * resampled indefinitely.
 */
export const DEFAULT_GUARDIAN_ROUND_CAP = 3;

/**
 * Count the rounds that spent the gate's budget.
 *
 * A round counts once when *either* guardian returned `FIX-BEFORE-SHIP`, and
 * only then: the operational outcomes (`UNPARSEABLE`, `NEVER_RAN`,
 * `DIED_MID_RUN`) carry no judgment, so a round whose only unfavorable signal
 * is operational leaves the count where it was (ADR 0057 decision 4,
 * amendment 2026-09-06). This settles the PRD's narrower "unfavorable
 * architect rounds" in the ADR's favor — either guardian's block counts.
 */
export function countUnfavorableGuardianRounds(
  rounds: readonly PersistedGuardianReviewRound[],
): number {
  return rounds.filter(
    (round) =>
      round.architect.outcome === "FIX-BEFORE-SHIP" ||
      round.pm.outcome === "FIX-BEFORE-SHIP",
  ).length;
}

export interface GuardianRoundCapDecision {
  /** Whether this round may take the recorded cap exit. */
  capReached: boolean;
  cap: number;
  unfavorableRounds: number;
  /** Present when `capReached` is false: which condition was not met. */
  reason?: string;
}

/**
 * Decide whether this round takes the cap exit (ADR 0057 decision 4).
 *
 * Four conditions, all necessary:
 *
 * 1. The draft PR would not otherwise open. A run the guardians cleared, or one
 *    `--open-pr-on-override` already carries, needs no cap exit.
 * 2. This round is itself unfavorable. The cap exit reports success on a
 *    *recorded disagreement*; without a block this round there is nothing to
 *    acknowledge.
 * 3. Neither guardian's outcome is operational. The exit signal extends ADR
 *    0015's override carve-out, and that carve-out never replaced a missing
 *    verdict — an operational outcome "cannot trigger a cap exit".
 * 4. The unfavorable-round count has reached the cap.
 *
 * Filing is the fifth condition and lives at the call site, because it has a
 * side effect: filing the unresolved blockers as issues is mandatory, so a run
 * that cannot file does not take the exit.
 */
export function decideGuardianRoundCapExit(args: {
  rounds: readonly PersistedGuardianReviewRound[];
  architect: ReviewOutcome;
  pm: ReviewOutcome;
  prWouldOpen: boolean;
  cap: number;
}): GuardianRoundCapDecision {
  const unfavorableRounds = countUnfavorableGuardianRounds(args.rounds);
  const base = { cap: args.cap, unfavorableRounds };
  if (args.cap < 1) {
    return { ...base, capReached: false, reason: "the round cap is disabled" };
  }
  if (args.prWouldOpen) {
    return {
      ...base,
      capReached: false,
      reason: "the draft PR opens without a cap exit",
    };
  }
  if (
    isOperationalReviewOutcome(args.architect) ||
    isOperationalReviewOutcome(args.pm)
  ) {
    return {
      ...base,
      capReached: false,
      reason:
        `an operational outcome cannot trigger a cap exit ` +
        `(architect: ${args.architect}, PM: ${args.pm})`,
    };
  }
  if (
    args.architect !== "FIX-BEFORE-SHIP" &&
    args.pm !== "FIX-BEFORE-SHIP"
  ) {
    return {
      ...base,
      capReached: false,
      reason: "neither guardian blocked this round",
    };
  }
  if (unfavorableRounds < args.cap) {
    return {
      ...base,
      capReached: false,
      reason: `${unfavorableRounds} unfavorable round(s) of ${args.cap}`,
    };
  }
  return { ...base, capReached: true };
}

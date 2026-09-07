import { isOperationalReviewOutcome, type GuardianKind } from "./artifacts.js";
import type {
  PersistedGuardianFinding,
  PersistedGuardianReviewRound,
} from "./run-state.js";

export type { GuardianKind } from "./artifacts.js";

/** Dispositions that leave a finding for the next round to verify. */
const OPEN_DISPOSITIONS = new Set([
  "OPEN",
  "REPEATED",
  "REOPENED",
  "REGRESSED",
]);

/**
 * One prior finding as the next round sees it: the ledger entry plus the round
 * it was last reported in, so the prompt can cite when the obligation arose.
 */
export interface PriorGuardianFinding {
  round: number;
  finding: PersistedGuardianFinding;
}

/** The three round-dependent blocks one guardian's prompt is rendered with. */
export interface GuardianRoundScope {
  round: number;
  /** `null` in round 1: there is no fix diff yet, only the branch. */
  deltaBaseSha: string | null;
  roundScope: string;
  openFindings: string;
  resolvedHistory: string;
}

/**
 * Fold one guardian's ledger down to the latest entry per stable identity.
 *
 * Only `INVOKED` records carry new evidence. A `CACHE` record is a verbatim
 * copy of an earlier round's findings (`sanitizeGuardianRounds` enforces
 * `sameFindings` against its origin), so folding it would re-observe entries
 * this fold already holds and move their round number to a round that never
 * re-read the tree.
 *
 * A finding a later round simply omitted keeps its last reported entry: the
 * ledger's job is to not lose an obligation nobody dispositioned.
 */
export function foldGuardianFindings(
  rounds: readonly PersistedGuardianReviewRound[],
  guardian: GuardianKind,
): PriorGuardianFinding[] {
  const latest = new Map<string, PriorGuardianFinding>();
  for (const round of rounds) {
    const record = round[guardian];
    if (record.source !== "INVOKED") continue;
    for (const finding of record.findings) {
      latest.set(finding.stableId, { round: round.round, finding });
    }
  }
  return [...latest.values()];
}

/** Findings the next round must disposition. */
export function openGuardianFindings(
  folded: readonly PriorGuardianFinding[],
): PriorGuardianFinding[] {
  return folded.filter((entry) =>
    OPEN_DISPOSITIONS.has(entry.finding.disposition),
  );
}

/** Findings an earlier round already cleared. */
export function resolvedGuardianFindings(
  folded: readonly PriorGuardianFinding[],
): PriorGuardianFinding[] {
  return folded.filter((entry) => entry.finding.disposition === "RESOLVED");
}

function formatFinding(entry: PriorGuardianFinding): string {
  const { finding } = entry;
  const alias =
    finding.currentId === finding.stableId
      ? ""
      : `, numbered ${finding.currentId} in that round`;
  return [
    `- [${finding.stableId}] ${finding.class} ${finding.disposition}` +
      ` — last reported in round ${entry.round}${alias}`,
    `  - Finding: ${finding.title}`,
    `  - Clear when: ${finding.clearCondition}`,
    `  - Reachable trigger: ${finding.reachableTrigger ?? "(none recorded)"}`,
    `  - Introduced by the reviewed diff: ${
      finding.introducedByReviewedDiff === null
        ? "(not recorded)"
        : String(finding.introducedByReviewedDiff)
    }`,
  ].join("\n");
}

function formatFindings(entries: readonly PriorGuardianFinding[]): string {
  return entries.map(formatFinding).join("\n");
}

const ROUND_ONE_SCOPE = (defaultBranch: string): string =>
  [
    "**This is review round 1.** Read the whole feature branch:",
    "",
    `- \`git diff ${defaultBranch}...HEAD\` — the full diff of this branch`,
    "  against the base branch.",
    "",
    "No earlier round has reviewed this branch, so this is the one round that",
    "reads all of it. Number your findings freely; the ledger assigns each a",
    "stable identity that later rounds will show back to you.",
  ].join("\n");

const laterRoundScope = (round: number, baseSha: string): string =>
  [
    `**This is review round ${round}, a verification round.** Round 1 already`,
    "reviewed the whole branch. Your job is to disposition the open findings",
    "below against the fix, not to re-review the branch.",
    "",
    `- \`git diff ${baseSha}..HEAD\` — the fix diff, i.e. everything that`,
    "  changed since the round this branch was last reviewed in.",
    "",
    "Read that diff and the open findings below. Do not resample the rest of",
    "the branch for new findings: earlier rounds already read it, and a finding",
    "you raise fresh now carries blocking authority only under the narrow",
    "later-new branch of the rubric above.",
    "",
    "**Reuse the stable IDs.** Every open finding below is listed by its stable",
    "ID. When you report a finding that is one of them — resolved, still open,",
    "or regressed — use that exact stable ID as its `id`. Number only genuinely",
    "new findings, and never reuse a stable ID for a different finding. A fresh",
    "`A-01` for something unrelated collides with an existing identity and makes",
    "the ledger guess which lineage you meant.",
  ].join("\n");

/**
 * Build the round-dependent prompt blocks for one guardian (ADR 0057
 * decision 2).
 *
 * The ledger's absence is the round-1 signal — no new flag. "Absence" is read
 * per guardian: a round in which this guardian produced no judgment — a reused
 * cache, or one of the operational outcomes (`UNPARSEABLE`, `NEVER_RAN`,
 * `DIED_MID_RUN`) — left no findings and no reviewed evidence, so it cannot be
 * the round that read the branch. Scoping round 2 to a fix diff on the strength
 * of such a round would hand a guardian a delta against a branch nobody had
 * read. Once this guardian has completed one review, the delta base is the
 * prior round's `headSha`
 * exactly as issue #171's added scope specifies — `sanitizeGuardianRounds`
 * chains `prior.headSha === round.reviewedHeadSha`, so the prior round's
 * `headSha` and this round's `reviewedHeadSha` name the same commit.
 */
export function buildGuardianRoundScope(args: {
  rounds: readonly PersistedGuardianReviewRound[];
  guardian: GuardianKind;
  defaultBranch: string;
}): GuardianRoundScope {
  const { rounds, guardian, defaultBranch } = args;
  const round = rounds.length + 1;
  const reviewed = rounds.some(
    (prior) =>
      prior[guardian].source === "INVOKED" &&
      !isOperationalReviewOutcome(prior[guardian].outcome),
  );
  const deltaBaseSha = reviewed
    ? (rounds[rounds.length - 1]?.headSha ?? null)
    : null;

  if (deltaBaseSha === null) {
    return {
      round,
      deltaBaseSha: null,
      roundScope: ROUND_ONE_SCOPE(defaultBranch),
      openFindings:
        "(none — no earlier round of this review has recorded a finding)",
      resolvedHistory:
        "(none — no earlier round of this review has resolved a finding)",
    };
  }

  const folded = foldGuardianFindings(rounds, guardian);
  const open = openGuardianFindings(folded);
  const resolved = resolvedGuardianFindings(folded);
  return {
    round,
    deltaBaseSha,
    roundScope: laterRoundScope(round, deltaBaseSha),
    openFindings:
      open.length > 0
        ? [
            "Verify each of these against the fix diff and report it back with",
            "the disposition the evidence supports (`RESOLVED` when its clear",
            "condition is met, `REPEATED` when it is not, `REOPENED` or",
            "`REGRESSED` when it had been cleared and is not any more):",
            "",
            formatFindings(open),
          ].join("\n")
        : "(none — every finding an earlier round raised is already resolved)",
    resolvedHistory:
      resolved.length > 0
        ? [
            "An earlier round accepted each of these as resolved. **Do not",
            "re-raise them.** If you believe one regressed, report it under its",
            "stable ID with disposition `REGRESSED` and cite the fix-diff hunk",
            "that regressed it — do not file it as a new finding:",
            "",
            formatFindings(resolved),
          ].join("\n")
        : "(none — no earlier round of this review has resolved a finding)",
  };
}

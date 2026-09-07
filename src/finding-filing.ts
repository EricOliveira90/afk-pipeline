import type { LedgerFinding } from "./guardian-finding-ledger.js";
import type { PersistedFiledFinding } from "./run-state.js";

/** What a filed issue is: an unresolved blocker at the cap, or a note. */
export type FiledFindingKind = "BLOCKER" | "NOTE";

/** One issue this run intends to open, with the identity it files under. */
export interface FindingIssueDraft {
  guardian: PersistedFiledFinding["guardian"];
  stableId: string;
  fingerprint: string;
  kind: FiledFindingKind;
  round: number;
  title: string;
  body: string;
}

export interface FindingFilingFailure {
  draft: FindingIssueDraft;
  error: string;
}

export interface FindingFilingOutcome {
  /** Newly opened this pass — the records to persist. */
  filed: PersistedFiledFinding[];
  /** Already durably filed by an earlier round; not filed again. */
  skipped: PersistedFiledFinding[];
  failed: FindingFilingFailure[];
}

const GUARDIAN_LABEL: Record<PersistedFiledFinding["guardian"], string> = {
  architect: "architect",
  pm: "PM",
};

/** One issue body per finding, carrying everything a human needs to act. */
export function buildFindingIssueDrafts(args: {
  prdSlug: string;
  specsDir: string;
  featureBranch: string;
  kind: FiledFindingKind;
  findings: readonly LedgerFinding[];
}): FindingIssueDraft[] {
  const specsPath = args.specsDir.replace(/\\/g, "/");
  return args.findings.map((entry) => {
    const { finding, guardian, round } = entry;
    const reviewFile = `${specsPath}/review-${guardian === "pm" ? "pm" : "architect"}.md`;
    const heading =
      args.kind === "BLOCKER"
        ? "unresolved at the guardian round cap"
        : "note shipped unfixed";
    return {
      guardian,
      stableId: finding.stableId,
      fingerprint: entry.fingerprint,
      kind: args.kind,
      round,
      title: `[afk][${args.prdSlug}] ${finding.title}`,
      body: [
        `Filed by the AFK ship gate: ${GUARDIAN_LABEL[guardian]} guardian finding ` +
          `\`${finding.stableId}\`, ${heading}.`,
        "",
        `- PRD: \`${args.prdSlug}\``,
        `- Branch: \`${args.featureBranch}\``,
        `- Guardian: ${GUARDIAN_LABEL[guardian]}`,
        `- Ledger identity: \`${finding.stableId}\`` +
          (finding.currentId === finding.stableId
            ? ""
            : ` (reported as \`${finding.currentId}\`)`),
        `- Class: \`${finding.class}\``,
        `- Last reported in review round ${round}, disposition \`${finding.disposition}\``,
        `- Reachable trigger: ${finding.reachableTrigger ?? "(none recorded)"}`,
        "",
        "## Clear condition",
        "",
        finding.clearCondition,
        "",
        "## Full review",
        "",
        `See \`${reviewFile}\` on \`${args.featureBranch}\` for the guardian's own words, ` +
          "and the draft PR body for the exit that filed this.",
      ].join("\n"),
    };
  });
}

/**
 * Find the durable record that already covers a draft, if any.
 *
 * Identity is resolved stable-ID-first and fingerprint-second, mirroring
 * `advanceGuardianFindingLineage`: the stable ID is the durable key #170 built,
 * and the fingerprint catches the case where the lineage minted a fresh
 * identity for what is textually the same obligation. The fingerprint match is
 * withheld when the matched record's own stable ID is still being filed in this
 * pass — two live identities sharing a fingerprint are two findings the ledger
 * decided to keep apart, and collapsing them would drop one.
 */
function alreadyFiledRecord(
  draft: FindingIssueDraft,
  alreadyFiled: readonly PersistedFiledFinding[],
  draftStableIds: ReadonlySet<string>,
): PersistedFiledFinding | undefined {
  const byStableId = alreadyFiled.find(
    (record) =>
      record.guardian === draft.guardian && record.stableId === draft.stableId,
  );
  if (byStableId) return byStableId;
  return alreadyFiled.find(
    (record) =>
      record.guardian === draft.guardian &&
      record.fingerprint === draft.fingerprint &&
      !draftStableIds.has(`${record.guardian} ${record.stableId}`),
  );
}

/**
 * Open one issue per draft that is not already filed, retrying each
 * independently.
 *
 * Never throws: filing is data, because ADR 0057 decision 4's amendment makes
 * a filing failure block the cap exit rather than crash the gate — the caller
 * needs the failures to decide, and a note-filing failure must not lose a clean
 * ship. Retries do not sleep: `create` is one `gh` subprocess, the same shape
 * as the guardian review's infrastructure retry, and a sleeping retry would
 * make every test pay for it.
 */
export function fileFindingIssues(args: {
  drafts: readonly FindingIssueDraft[];
  alreadyFiled: readonly PersistedFiledFinding[];
  create: (draft: FindingIssueDraft) => string;
  retries: number;
  onRetry?: (draft: FindingIssueDraft, attempt: number, error: string) => void;
}): FindingFilingOutcome {
  const outcome: FindingFilingOutcome = {
    filed: [],
    skipped: [],
    failed: [],
  };
  const draftStableIds = new Set(
    args.drafts.map((draft) => `${draft.guardian} ${draft.stableId}`),
  );
  // Records filed earlier plus records filed in this pass, so two drafts can
  // never open two issues for one identity.
  const filedSoFar: PersistedFiledFinding[] = [...args.alreadyFiled];
  for (const draft of args.drafts) {
    const existing = alreadyFiledRecord(draft, filedSoFar, draftStableIds);
    if (existing) {
      outcome.skipped.push(existing);
      continue;
    }
    let lastError = "filing was never attempted";
    let filed = false;
    for (let attempt = 1; attempt <= args.retries + 1; attempt++) {
      try {
        const issue = args.create(draft).trim();
        if (issue === "") throw new Error("the issue tracker returned no issue reference");
        const record: PersistedFiledFinding = {
          guardian: draft.guardian,
          stableId: draft.stableId,
          fingerprint: draft.fingerprint,
          kind: draft.kind,
          round: draft.round,
          issue,
        };
        outcome.filed.push(record);
        filedSoFar.push(record);
        filed = true;
        break;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (attempt <= args.retries) {
          args.onRetry?.(draft, attempt, lastError);
        }
      }
    }
    if (!filed) outcome.failed.push({ draft, error: lastError });
  }
  return outcome;
}

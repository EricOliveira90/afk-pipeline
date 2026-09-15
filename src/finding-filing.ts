import { idMatchIsCorroborated } from "./guardian-convergence.js";
import {
  guardianFindingFingerprint,
  type LedgerFinding,
} from "./guardian-finding-ledger.js";
import type {
  PersistedFiledFinding,
  PersistedFindingReconciliation,
} from "./guardian-round-records.js";

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
  /** The PRD this draft is filed under — persisted with the record (#320). */
  prdSlug: string;
  /** The run directory that filed it (`run-<timestamp>`, ADR 0017). */
  runId: string;
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
  /** This run's log directory name (ADR 0017) — the filing run's identity. */
  runId: string;
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
      prdSlug: args.prdSlug,
      runId: args.runId,
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
 *
 * Neither match accepts a stable ID on its own ({@link idMatchIsCorroborated}).
 * A guardian numbers each round's findings from `P-01` on the diff it was given,
 * so once the early notes clear, the next round's fresh notes land on exactly
 * the IDs already filed — and an unguarded ID match reported them as
 * already-filed and dropped them. Five notes shipped unfixed and unfiled that
 * way, against #174's "filed exactly once" (#247). A drifted fingerprint on a
 * genuinely repeated obligation now files a second issue instead; that is the
 * cheaper error, because a duplicate issue is visible and a dropped note is not.
 */
function alreadyFiledRecord(
  draft: FindingIssueDraft,
  alreadyFiled: readonly PersistedFiledFinding[],
  draftStableIds: ReadonlySet<string>,
): PersistedFiledFinding | undefined {
  const byStableId = alreadyFiled.find(
    (record) =>
      record.guardian === draft.guardian &&
      record.stableId === draft.stableId &&
      idMatchIsCorroborated({
        fingerprintAgrees: record.fingerprint === draft.fingerprint,
        priorIsLive: false,
      }),
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
          prdSlug: draft.prdSlug,
          runId: draft.runId,
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

/**
 * Why a reconciliation left an issue alone. Every value is a statement about
 * identity or evidence, never about the tracker: a `gh` failure is a
 * {@link FindingIssueReconciliationFailure}, not a refusal.
 */
export type FindingIssueRefusal =
  /** The record names no issue a tracker call could address. */
  | "unusable-issue-reference"
  /** The record was filed under another PRD, so it is not this run's to touch. */
  | "prd-mismatch"
  /** No ledger entry corroborates the record's identity at all. */
  | "no-ledger-entry"
  /** An entry shares the stable ID but states a different obligation (#247). */
  | "stable-id-collision"
  /** Two live entries could be this record; nothing says which. */
  | "ambiguous-identity"
  /** The ledger's latest word on the identity predates the round that filed it. */
  | "stale-evidence";

/**
 * What reconciliation decided to do about one filed issue.
 *
 * `UPDATE`, `CLOSE` and `REOPEN` carry a `comment`; `REFUSE` carries a
 * `refusal`; `UNCHANGED` carries neither, because the round's evidence has
 * already been applied to this issue.
 */
export type FindingIssueAction =
  | "UPDATE"
  | "CLOSE"
  | "REOPEN"
  | "REFUSE"
  | "UNCHANGED";

export interface FindingIssueDecision {
  action: FindingIssueAction;
  /** The durable filing record this decision is about. */
  record: PersistedFiledFinding;
  /** The ledger entry that corroborated the record, when one did. */
  matched?: LedgerFinding;
  /** One line for the operator: what was decided and on what evidence. */
  reason: string;
  /** The comment body to post. Present on `UPDATE`, `CLOSE` and `REOPEN`. */
  comment?: string;
  /** Present on `REFUSE`, and only there. */
  refusal?: FindingIssueRefusal;
}

/** Decisions grouped by what the tracker is asked to do, plus the two no-ops. */
export interface FindingIssueReconciliation {
  /** Still-live findings: comment with the latest evidence, leave open. */
  update: FindingIssueDecision[];
  /** Explicitly resolved by later evidence: comment, then close. */
  close: FindingIssueDecision[];
  /** Live again after an earlier reconciliation closed the issue. */
  reopen: FindingIssueDecision[];
  /** Identity or evidence is ambiguous: leave the issue exactly as it is. */
  refuse: FindingIssueDecision[];
  /** This round's evidence is already on the issue. */
  unchanged: FindingIssueDecision[];
}

/** A tracker call that would not go through, reported as data. */
export interface FindingIssueReconciliationFailure {
  decision: FindingIssueDecision;
  error: string;
}

/** One issue whose state now matches the ledger, and the memory to persist. */
export interface FindingIssueReconciliationApplied {
  decision: FindingIssueDecision;
  reconciled: PersistedFindingReconciliation;
}

export interface FindingIssueReconciliationOutcome {
  applied: FindingIssueReconciliationApplied[];
  failed: FindingIssueReconciliationFailure[];
}

/** Everything a reconciliation comment cites, gathered once per pass. */
export interface FindingIssueEvidence {
  prdSlug: string;
  /** This run's log directory name (ADR 0017). */
  runId: string;
  featureBranch: string;
  specsDir: string;
  /** The commit the latest guardian round read, when the caller knows it. */
  reviewedHeadSha?: string;
}

function issueReferenceIsAddressable(issue: string): boolean {
  const value = issue.trim();
  return /^https?:\/\/\S+$/.test(value) || /^#?\d+$/.test(value);
}

function evidenceLines(
  record: PersistedFiledFinding,
  entry: LedgerFinding,
  evidence: FindingIssueEvidence,
): string[] {
  const { finding } = entry;
  const reviewFile =
    `${evidence.specsDir.replace(/\\/g, "/")}/` +
    `review-${entry.guardian === "pm" ? "pm" : "architect"}.md`;
  return [
    `- PRD: \`${evidence.prdSlug}\``,
    `- Run: \`${evidence.runId}\``,
    `- Branch: \`${evidence.featureBranch}\``,
    `- Guardian: ${GUARDIAN_LABEL[entry.guardian]}`,
    `- Ledger identity: \`${finding.stableId}\`` +
      (finding.currentId === finding.stableId
        ? ""
        : ` (reported as \`${finding.currentId}\`)`),
    `- Filed from review round ${record.round} as a ${record.kind.toLowerCase()}`,
    `- Latest review round ${entry.round}, disposition \`${finding.disposition}\``,
    `- Reviewed commit: ${
      evidence.reviewedHeadSha
        ? `\`${evidence.reviewedHeadSha}\``
        : "(not recorded)"
    }`,
    "",
    "## Clear condition",
    "",
    finding.clearCondition,
    "",
    `Read \`${reviewFile}\` on \`${evidence.featureBranch}\` for the guardian's own words.`,
  ];
}

function reconciliationComment(
  action: "UPDATE" | "CLOSE" | "REOPEN",
  record: PersistedFiledFinding,
  entry: LedgerFinding,
  evidence: FindingIssueEvidence,
): string {
  const opening =
    action === "CLOSE"
      ? `Resolved by a later AFK guardian round: round ${entry.round} recorded ` +
        "disposition `RESOLVED` for this finding, so the ship gate is closing " +
        "this issue."
      : action === "REOPEN"
        ? `Live again: round ${entry.round} reported this finding as ` +
          `\`${entry.finding.disposition}\` after an earlier round resolved it, ` +
          "so the ship gate is reopening this issue."
        : `Still open after AFK guardian round ${entry.round}, which reported ` +
          `it as \`${entry.finding.disposition}\`.`;
  return [opening, "", ...evidenceLines(record, entry, evidence)].join("\n");
}

/**
 * Resolve one filed record onto the ledger entry that is the same finding.
 *
 * The mirror image of {@link alreadyFiledRecord}, and deliberately the same
 * rule read from the other side: stable ID first, fingerprint second, and an ID
 * match on its own is never identity ({@link idMatchIsCorroborated} with no
 * liveness signal, so the fingerprint must agree). Filing errs toward a
 * duplicate issue when it cannot tell; reconciliation errs toward leaving the
 * issue alone, because the mistake available here is closing somebody else's
 * ticket.
 *
 * The fingerprint fallback may not take an entry another record already owns —
 * the same guard `alreadyFiledRecord` applies with `draftStableIds` — and two
 * unclaimed candidates are a refusal rather than a coin flip.
 */
function matchLedgerEntry(
  record: PersistedFiledFinding,
  ledger: readonly LedgerFinding[],
  claimedStableIds: ReadonlySet<string>,
): { entry: LedgerFinding } | { refusal: FindingIssueRefusal; reason: string } {
  const mine = ledger.filter((entry) => entry.guardian === record.guardian);
  // Computed from the finding, not read off the fold's field, so identity here
  // depends on the content and not on what a caller filled in.
  const fingerprintOf = (entry: LedgerFinding) =>
    guardianFindingFingerprint(entry.finding);
  const byStableId = mine.find(
    (entry) => entry.finding.stableId === record.stableId,
  );
  if (
    byStableId &&
    idMatchIsCorroborated({
      fingerprintAgrees: fingerprintOf(byStableId) === record.fingerprint,
      priorIsLive: false,
    })
  ) {
    return { entry: byStableId };
  }
  const byFingerprint = mine.filter(
    (entry) =>
      fingerprintOf(entry) === record.fingerprint &&
      !claimedStableIds.has(`${entry.guardian} ${entry.finding.stableId}`),
  );
  if (byFingerprint.length === 1) return { entry: byFingerprint[0]! };
  if (byFingerprint.length > 1) {
    return {
      refusal: "ambiguous-identity",
      reason:
        `${byFingerprint.length} live ledger findings share this issue's ` +
        `fingerprint (${byFingerprint
          .map((entry) => entry.finding.stableId)
          .join(", ")}) — nothing says which one this issue is.`,
    };
  }
  if (byStableId) {
    return {
      refusal: "stable-id-collision",
      reason:
        `ledger finding \`${byStableId.finding.stableId}\` reuses this issue's ` +
        "stable ID for a different obligation (#247), and no other finding " +
        "matches its fingerprint — an ID alone is not identity.",
    };
  }
  return {
    refusal: "no-ledger-entry",
    reason:
      "no ledger finding carries this issue's identity, so this round says " +
      "nothing about it.",
  };
}

/**
 * Decide what each already-filed issue's later rounds have made of it (#320).
 *
 * Pure, and the whole judgment of the reconciliation lifecycle: the caller
 * performs the tracker calls and persists the memory, but every question of
 * *whether* an issue may be touched is answered here, from the folded ledger
 * and the durable filing records alone.
 *
 * The rules, in the order they are applied per record:
 *
 * - **The record must name an issue.** A reference no tracker call could
 *   address is a refusal, not a silently skipped row.
 * - **The record must belong to this PRD.** A record naming another PRD is
 *   another run's, and this gate does not touch it. A record naming *no* PRD is
 *   pre-#320 and is read as this run's own — it was loaded from this run's own
 *   state file — because the alternative strands exactly the issues #320 was
 *   filed about.
 * - **Identity must be corroborated** ({@link matchLedgerEntry}). A bare
 *   stable-ID match never resolves, so it can never close anything.
 * - **Only an explicit `RESOLVED` closes**, and only on evidence no older than
 *   the round that filed the issue. Every other disposition — `OPEN`,
 *   `REPEATED`, `REOPENED`, `REGRESSED` — leaves the issue open with the latest
 *   evidence commented onto it, and reopens it when an earlier reconciliation
 *   had closed it.
 * - **A round is applied once.** A record whose memory already names this round
 *   and this action is `UNCHANGED`, which is what makes a replayed pass — a
 *   resume, or a crash between the tracker call and the state write — cost
 *   nothing and say nothing twice.
 */
export function reconcileFindingIssues(args: {
  /** The folded ledger, RESOLVED entries included — they are the close evidence. */
  ledger: readonly LedgerFinding[];
  alreadyFiled: readonly PersistedFiledFinding[];
  evidence: FindingIssueEvidence;
}): FindingIssueReconciliation {
  const reconciliation: FindingIssueReconciliation = {
    update: [],
    close: [],
    reopen: [],
    refuse: [],
    unchanged: [],
  };
  const push = (decision: FindingIssueDecision) => {
    if (decision.action === "UPDATE") reconciliation.update.push(decision);
    else if (decision.action === "CLOSE") reconciliation.close.push(decision);
    else if (decision.action === "REOPEN") reconciliation.reopen.push(decision);
    else if (decision.action === "REFUSE") reconciliation.refuse.push(decision);
    else reconciliation.unchanged.push(decision);
  };
  for (const record of args.alreadyFiled) {
    if (!issueReferenceIsAddressable(record.issue)) {
      push({
        action: "REFUSE",
        record,
        refusal: "unusable-issue-reference",
        reason:
          `the filing record names \`${record.issue}\`, which is neither an ` +
          "issue URL nor an issue number, so there is nothing to reconcile.",
      });
      continue;
    }
    if (
      record.prdSlug !== undefined &&
      record.prdSlug !== args.evidence.prdSlug
    ) {
      push({
        action: "REFUSE",
        record,
        refusal: "prd-mismatch",
        reason:
          `the issue was filed under PRD \`${record.prdSlug}\`, not ` +
          `\`${args.evidence.prdSlug}\` — this run does not own it.`,
      });
      continue;
    }
    // Every other record's identity, so the fingerprint fallback cannot take an
    // entry that is demonstrably another issue's.
    const claimedStableIds = new Set(
      args.alreadyFiled
        .filter((other) => other !== record)
        .map((other) => `${other.guardian} ${other.stableId}`),
    );
    const match = matchLedgerEntry(record, args.ledger, claimedStableIds);
    if ("refusal" in match) {
      push({
        action: "REFUSE",
        record,
        refusal: match.refusal,
        reason: match.reason,
      });
      continue;
    }
    const entry = match.entry;
    const resolved = entry.finding.disposition === "RESOLVED";
    if (resolved && entry.round < record.round) {
      push({
        action: "REFUSE",
        record,
        matched: entry,
        refusal: "stale-evidence",
        reason:
          `the ledger's latest word on this identity is round ${entry.round}, ` +
          `older than the round ${record.round} that filed the issue — the two ` +
          "are not describing the same history, so the `RESOLVED` is not later " +
          "evidence.",
      });
      continue;
    }
    const action: "UPDATE" | "CLOSE" | "REOPEN" = resolved
      ? "CLOSE"
      : record.reconciled?.action === "CLOSED"
        ? "REOPEN"
        : "UPDATE";
    const memory = record.reconciled;
    const alreadyApplied =
      memory !== undefined &&
      memory.round >= entry.round &&
      memory.action === (action === "CLOSE" ? "CLOSED" : "UPDATED");
    if (alreadyApplied) {
      push({
        action: "UNCHANGED",
        record,
        matched: entry,
        reason:
          `round ${memory.round}'s evidence is already on the issue ` +
          `(${memory.action.toLowerCase()}).`,
      });
      continue;
    }
    push({
      action,
      record,
      matched: entry,
      comment: reconciliationComment(action, record, entry, args.evidence),
      reason:
        action === "CLOSE"
          ? `round ${entry.round} recorded \`RESOLVED\`, so the issue is closed.`
          : action === "REOPEN"
            ? `round ${entry.round} reported it \`${entry.finding.disposition}\` ` +
              "after an earlier round closed the issue, so the issue is reopened."
            : `round ${entry.round} reported it \`${entry.finding.disposition}\`, ` +
              "so the issue stays open with the latest evidence.",
    });
  }
  return reconciliation;
}

/**
 * Perform the decisions {@link reconcileFindingIssues} took, one issue at a
 * time.
 *
 * Never throws, for the same reason filing never throws: an issue tracker is
 * not part of the gate's verdict, and a `gh` outage must not lose a completed
 * run. Every call that will not go through comes back as a failure the caller
 * reports.
 *
 * A decision is atomic from the memory's point of view: `reconciled` comes back
 * only when every call that decision needed succeeded. A comment that landed
 * before a failing close therefore records nothing, so the next pass retries the
 * whole decision and may comment twice. That is the cheaper error — a duplicate
 * comment is visible on the issue, while a `CLOSED` memory written over a close
 * that never happened leaves the issue open with nobody left to retry it, which
 * is the exact miscount #320 is about.
 *
 * Retries do not sleep: each callback is one `gh` subprocess, the same shape as
 * {@link fileFindingIssues}'s.
 */
export function applyFindingIssueReconciliation(args: {
  reconciliation: FindingIssueReconciliation;
  comment: (decision: FindingIssueDecision, body: string) => void;
  close: (decision: FindingIssueDecision) => void;
  reopen: (decision: FindingIssueDecision) => void;
  retries: number;
  onRetry?: (
    decision: FindingIssueDecision,
    attempt: number,
    error: string,
  ) => void;
}): FindingIssueReconciliationOutcome {
  const outcome: FindingIssueReconciliationOutcome = {
    applied: [],
    failed: [],
  };
  const { reconciliation } = args;
  const ordered = [
    ...reconciliation.update,
    ...reconciliation.reopen,
    ...reconciliation.close,
  ];
  for (const decision of ordered) {
    const round = decision.matched?.round ?? decision.record.round;
    let lastError = "the reconciliation was never attempted";
    let applied = false;
    for (let attempt = 1; attempt <= args.retries + 1; attempt++) {
      try {
        args.comment(decision, decision.comment ?? decision.reason);
        if (decision.action === "CLOSE") args.close(decision);
        if (decision.action === "REOPEN") args.reopen(decision);
        outcome.applied.push({
          decision,
          reconciled: {
            round,
            action: decision.action === "CLOSE" ? "CLOSED" : "UPDATED",
          },
        });
        applied = true;
        break;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (attempt <= args.retries) {
          args.onRetry?.(decision, attempt, lastError);
        }
      }
    }
    if (!applied) outcome.failed.push({ decision, error: lastError });
  }
  return outcome;
}

/**
 * The guardian issues this run leaves behind open.
 *
 * The projection the terminal handoff and the run summary both report: an issue
 * this pass closed is done, and everything else — updated, reopened, refused, or
 * already carrying this round's evidence — is live work an operator must still
 * count. Reopened issues come first because they are the ones a reader expected
 * to be finished.
 */
export function unresolvedGuardianIssueDecisions(
  reconciliation: FindingIssueReconciliation,
): FindingIssueDecision[] {
  return [
    ...reconciliation.reopen,
    ...reconciliation.update,
    ...reconciliation.refuse,
    ...reconciliation.unchanged,
  ];
}

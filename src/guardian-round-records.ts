/**
 * The persisted shape of the guardian layer's review evidence, and the one
 * normalizer that decides what a loaded file is allowed to claim (#221).
 *
 * Half of the guardian round persistence module; `guardian-round-persistence.ts`
 * is the other half — the adapter that reads and writes. The split is a load
 * order, not a second owner: `run-state.ts` must normalize the guardian fields
 * while it adapts a loaded file, and the adapter writes *through* `run-state.ts`,
 * so the rules live here where the hub can reach them without depending on a
 * writer that depends on the hub.
 *
 * Every rule below is a claim about evidence, so each one refuses rather than
 * repairs. The complete invariant:
 *
 * - **The verdict cache is favorable-only** (ADR 0015). A cached `SHIP` /
 *   `ACCEPT-WITH-NOTES` against a reviewed HEAD is a cheap re-entry; an
 *   unfavorable verdict is not cacheable, because the next pass has to re-read
 *   the fix.
 * - **Which outcomes may carry findings.** An `INVOKED` `SHIP` carries none, an
 *   `ACCEPT-WITH-NOTES` / `FIX-BEFORE-SHIP` carries at least one, and the
 *   operational outcomes (`UNPARSEABLE`, `NEVER_RAN`, `DIED_MID_RUN`) carry
 *   none: no reviewer spoke.
 * - **Findings-origin provenance.** A record that names a `findingsOriginRound`
 *   must carry that round's findings byte-for-byte, and the named round must be
 *   the `INVOKED` one that produced them. A `CACHE` record's origin and findings
 *   come from the round that reviewed the same HEAD; if that round named no
 *   origin, the cache carries no findings either.
 * - **A blocking round must have blocking authority.** An `INVOKED`
 *   `FIX-BEFORE-SHIP` from the architect needs at least one finding that
 *   `guardianFindingMayBlock` admits for its round (ADR 0057 decision 3).
 * - **The ledger is all-or-nothing; the filed-findings record is not.** One bad
 *   round discards the whole ledger, because a ledger with a hole misreports
 *   which round resolved what. One bad filed-finding row is dropped alone,
 *   because every row discarded is an issue the next round may file twice.
 */
import type {
  GuardianFindingDisposition,
  GuardianKind,
  ReviewOutcome,
} from "./artifacts.js";
import { guardianFindingMayBlock } from "./guardian-blocking-authority.js";

/** A favorable guardian verdict recorded against the reviewed HEAD. */
export interface PersistedReviewResult {
  headSha: string;
  verdict: "SHIP" | "ACCEPT-WITH-NOTES";
}

export interface PersistedGuardianFinding {
  stableId: string;
  currentId: string;
  title: string;
  class: string;
  clearCondition: string;
  disposition: GuardianFindingDisposition;
  reachableTrigger: string | null;
  introducedByReviewedDiff: boolean | null;
}

export interface PersistedGuardianReviewRecord {
  source: "INVOKED" | "CACHE";
  outcome: ReviewOutcome;
  findings: PersistedGuardianFinding[];
  findingsOriginRound: number | null;
}

export interface PersistedGuardianReviewRound {
  round: number;
  reviewedHeadSha: string;
  headSha: string;
  architect: PersistedGuardianReviewRecord;
  pm: PersistedGuardianReviewRecord;
}

/**
 * One guardian finding this run has opened an issue for.
 *
 * The durable half of "filed exactly once" (ADR 0057 decision 4, last
 * sentence): a note that rides two consecutive rounds is filed on the first and
 * skipped on the second because its ledger identity is already in here.
 */
export interface PersistedFiledFinding {
  guardian: GuardianKind;
  stableId: string;
  /** Normalized class + clear condition — the content half of the identity. */
  fingerprint: string;
  kind: "BLOCKER" | "NOTE";
  /** The round whose entry was filed. */
  round: number;
  /** Whatever the tracker returned to name the issue, usually a URL. */
  issue: string;
}

/**
 * The guardian-owned fields of a persisted review phase: the two verdict
 * caches, the round ledger, and the filed-issue memory.
 *
 * The sanity-gate cache beside them on disk is not guardian evidence, so it is
 * not in here — `run-state.ts` keeps that one field and composes this record
 * around it.
 */
export interface PersistedGuardianReviewFields {
  architect?: PersistedReviewResult;
  pm?: PersistedReviewResult;
  rounds?: PersistedGuardianReviewRound[];
  filedFindings?: PersistedFiledFinding[];
}

const FAVORABLE_VERDICTS = new Set(["SHIP", "ACCEPT-WITH-NOTES"]);
const REVIEW_OUTCOMES = new Set<ReviewOutcome>([
  "SHIP",
  "ACCEPT-WITH-NOTES",
  "FIX-BEFORE-SHIP",
  "UNPARSEABLE",
  "NEVER_RAN",
  "DIED_MID_RUN",
]);
const FINDING_DISPOSITIONS = new Set<GuardianFindingDisposition>([
  "OPEN",
  "RESOLVED",
  "REPEATED",
  "REOPENED",
  "REGRESSED",
]);

function sanitizeReviewResult(value: unknown): PersistedReviewResult | undefined {
  const v = (value ?? {}) as { headSha?: unknown; verdict?: unknown };
  if (
    typeof v.headSha === "string" &&
    v.headSha.length > 0 &&
    typeof v.verdict === "string" &&
    FAVORABLE_VERDICTS.has(v.verdict)
  ) {
    return { headSha: v.headSha, verdict: v.verdict as "SHIP" | "ACCEPT-WITH-NOTES" };
  }
  return undefined;
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function sanitizeGuardianFinding(
  value: unknown,
): PersistedGuardianFinding | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const finding = value as Record<string, unknown>;
  if (
    !nonBlank(finding.stableId) ||
    !nonBlank(finding.currentId) ||
    !nonBlank(finding.title) ||
    !nonBlank(finding.class) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(finding.class.trim()) ||
    !nonBlank(finding.clearCondition) ||
    typeof finding.disposition !== "string" ||
    !FINDING_DISPOSITIONS.has(
      finding.disposition as GuardianFindingDisposition,
    )
  ) {
    return undefined;
  }
  const reachableTrigger =
    finding.reachableTrigger === undefined ||
    finding.reachableTrigger === null
      ? null
      : nonBlank(finding.reachableTrigger)
        ? finding.reachableTrigger.trim()
        : undefined;
  const introducedByReviewedDiff =
    finding.introducedByReviewedDiff === undefined ||
    finding.introducedByReviewedDiff === null
      ? null
      : typeof finding.introducedByReviewedDiff === "boolean"
        ? finding.introducedByReviewedDiff
        : undefined;
  if (
    reachableTrigger === undefined ||
    introducedByReviewedDiff === undefined
  ) {
    return undefined;
  }
  return {
    stableId: finding.stableId.trim(),
    currentId: finding.currentId.trim(),
    title: finding.title.trim(),
    class: finding.class.trim(),
    clearCondition: finding.clearCondition.trim(),
    disposition: finding.disposition as GuardianFindingDisposition,
    reachableTrigger,
    introducedByReviewedDiff,
  };
}

function sanitizeGuardianRecord(
  value: unknown,
  round: number,
): PersistedGuardianReviewRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    (record.source !== "INVOKED" && record.source !== "CACHE") ||
    typeof record.outcome !== "string" ||
    !REVIEW_OUTCOMES.has(record.outcome as ReviewOutcome) ||
    !Array.isArray(record.findings) ||
    !(
      record.findingsOriginRound === null ||
      (Number.isSafeInteger(record.findingsOriginRound) &&
        (record.findingsOriginRound as number) > 0)
    )
  ) {
    return undefined;
  }
  if (
    record.source === "CACHE" &&
    !FAVORABLE_VERDICTS.has(record.outcome)
  ) {
    return undefined;
  }
  const findings = record.findings.map(sanitizeGuardianFinding);
  if (findings.some((finding) => finding === undefined)) return undefined;
  const validFindings = findings as PersistedGuardianFinding[];
  // Both IDs stay unique within a record: current IDs because the block
  // parsed distinct rows, stable IDs because identity resolution is
  // one-to-one within a round (ADR 0057 decision 1, amendment 2026-09-06) —
  // `stableId` names one lineage, keeping cross-round matching
  // order-independent.
  if (
    new Set(validFindings.map((finding) => finding.currentId)).size !==
      validFindings.length ||
    new Set(validFindings.map((finding) => finding.stableId)).size !==
      validFindings.length
  ) {
    return undefined;
  }
  const findingsOriginRound = record.findingsOriginRound as number | null;
  if (record.source === "INVOKED" && findingsOriginRound !== round) {
    return undefined;
  }
  if (
    record.source === "INVOKED" &&
    (
      (record.outcome === "SHIP" && validFindings.length !== 0) ||
      (
        (record.outcome === "ACCEPT-WITH-NOTES" ||
          record.outcome === "FIX-BEFORE-SHIP") &&
        validFindings.length === 0
      ) ||
      (
        (record.outcome === "UNPARSEABLE" ||
          record.outcome === "NEVER_RAN" ||
          record.outcome === "DIED_MID_RUN") &&
        validFindings.length !== 0
      )
    )
  ) {
    return undefined;
  }
  return {
    source: record.source,
    outcome: record.outcome as ReviewOutcome,
    findings: validFindings,
    findingsOriginRound,
  };
}

function sameFindings(
  left: readonly PersistedGuardianFinding[],
  right: readonly PersistedGuardianFinding[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sanitizeGuardianRounds(
  value: unknown,
): PersistedGuardianReviewRound[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rounds: PersistedGuardianReviewRound[] = [];
  for (let index = 0; index < value.length; index++) {
    const expectedRound = index + 1;
    const input = value[index];
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return undefined;
    }
    const round = input as Record<string, unknown>;
    const architect = sanitizeGuardianRecord(round.architect, expectedRound);
    const pm = sanitizeGuardianRecord(round.pm, expectedRound);
    if (
      round.round !== expectedRound ||
      !nonBlank(round.reviewedHeadSha) ||
      !nonBlank(round.headSha) ||
      architect === undefined ||
      pm === undefined
    ) {
      return undefined;
    }
    rounds.push({
      round: expectedRound,
      reviewedHeadSha: round.reviewedHeadSha.trim(),
      headSha: round.headSha.trim(),
      architect,
      pm,
    });
  }

  for (let index = 0; index < rounds.length; index++) {
    const round = rounds[index]!;
    for (const guardian of ["architect", "pm"] as const) {
      const record = round[guardian];
      if (record.findingsOriginRound !== null) {
        const origin = rounds[record.findingsOriginRound - 1]?.[guardian];
        if (
          origin?.source !== "INVOKED" ||
          !sameFindings(record.findings, origin.findings)
        ) {
          return undefined;
        }
      }
      if (record.source !== "CACHE") continue;
      const sourceRound = rounds
        .slice(0, index)
        .reverse()
        .find((prior) => prior.headSha === round.reviewedHeadSha);
      const sourceRecord = sourceRound?.[guardian];
      if (sourceRecord?.findingsOriginRound != null) {
        if (
          record.findingsOriginRound !==
            sourceRecord.findingsOriginRound ||
          !sameFindings(record.findings, sourceRecord.findings)
        ) {
          return undefined;
        }
      } else if (
        record.findingsOriginRound !== null ||
        record.findings.length !== 0
      ) {
        return undefined;
      }
    }
    if (
      round.architect.source === "INVOKED" &&
      round.architect.outcome === "FIX-BEFORE-SHIP"
    ) {
      const priorStableIds = new Set(
        rounds
          .slice(0, index)
          .flatMap((prior) =>
            prior.architect.findings.map((finding) => finding.stableId),
          ),
      );
      if (
        !round.architect.findings.some((finding) =>
          guardianFindingMayBlock({
            guardian: "architect",
            round: round.round,
            hasPriorLineage: priorStableIds.has(finding.stableId),
            class: finding.class,
            disposition: finding.disposition,
            reachableTrigger: finding.reachableTrigger,
            introducedByReviewedDiff: finding.introducedByReviewedDiff,
          }),
        )
      ) {
        return undefined;
      }
    }
  }
  return rounds;
}

/**
 * Validate the filed-issue record, entry by entry.
 *
 * Unlike the ledger this is *not* all-or-nothing. Every record dropped is one
 * finding the next round may file a second issue for, so keeping the valid
 * majority minimizes duplicates instead of discarding the whole memory over one
 * bad row. A missing or unreadable record degrades to "nothing filed yet",
 * never blocks resumption — the same tolerance the verdict cache gets.
 *
 * Identity is `guardian` + `stableId`, the same key
 * {@link recordFiledGuardianFindings} dedups writes by, so a file that somehow
 * carries the identity twice reads back as the one filing it records.
 */
function sanitizeFiledFindings(
  value: unknown,
): PersistedFiledFinding[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const records: PersistedFiledFinding[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (
      (record.guardian !== "architect" && record.guardian !== "pm") ||
      !nonBlank(record.stableId) ||
      !nonBlank(record.fingerprint) ||
      (record.kind !== "BLOCKER" && record.kind !== "NOTE") ||
      !Number.isSafeInteger(record.round) ||
      (record.round as number) < 1 ||
      !nonBlank(record.issue)
    ) {
      continue;
    }
    const key = `${record.guardian} ${record.stableId.trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    records.push({
      guardian: record.guardian as GuardianKind,
      stableId: record.stableId.trim(),
      fingerprint: record.fingerprint,
      kind: record.kind,
      round: record.round as number,
      issue: record.issue.trim(),
    });
  }
  return records.length > 0 ? records : undefined;
}

/**
 * Normalize the guardian-owned fields of a loaded `reviewPhase`, dropping
 * malformed or unfavorable cache entries independently from the
 * all-or-nothing round ledger.
 *
 * Field order is part of the contract: the returned keys are inserted in the
 * on-disk order (`architect`, `pm`, `rounds`, `filedFindings`), so a state file
 * re-written after a load keeps the byte layout it was read with.
 */
export function sanitizeGuardianReviewFields(
  value: unknown,
): PersistedGuardianReviewFields {
  if (typeof value !== "object" || value === null) return {};
  const v = value as {
    architect?: unknown;
    pm?: unknown;
    rounds?: unknown;
    filedFindings?: unknown;
  };
  const out: PersistedGuardianReviewFields = {};
  const architect = sanitizeReviewResult(v.architect);
  if (architect) out.architect = architect;
  const pm = sanitizeReviewResult(v.pm);
  if (pm) out.pm = pm;
  if (v.rounds !== undefined) {
    const rounds = sanitizeGuardianRounds(v.rounds);
    if (rounds && rounds.length > 0) out.rounds = rounds;
  }
  if (v.filedFindings !== undefined) {
    const filed = sanitizeFiledFindings(v.filedFindings);
    if (filed) out.filedFindings = filed;
  }
  return out;
}

import {
  findDuplicateJsonKey,
  requireExactKeys,
  requireNonBlankString,
  type ContractFindingSeverity,
} from "./contract-review.js";
import type { BaseGateSkipCitation } from "./qa-gate-authorization.js";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const QA_REVIEW_FILENAME = "qa-review.json";
export const UAT_REVIEW_FILENAME = "uat-review.json";

export type QAReviewVerdict = "PASS" | "FAIL";
export type QAReviewFailureClass =
  | "NONE"
  | "IMPLEMENTATION"
  | "INFRASTRUCTURE";
export type QAReviewFindingState = "OPEN" | "RESOLVED";

/**
 * Who can clear the finding, and by doing what (#112).
 *
 * - `SOURCE_CHANGE` — the change under review is wrong. The generator
 *   clears it by changing (or reverting) source. This is every ordinary
 *   finding.
 * - `SCOPE_AMENDMENT` — the change under review is right, but it touches
 *   a file the locked contract never declared. The generator has no
 *   authority over the locked file list, so routing this to the
 *   generator leaves it one remedy it should never take: destroying its
 *   own correct work to comply. The orchestrator owns the contract
 *   (ADR 0008), so the orchestrator performs the amendment.
 */
export type QAReviewFindingRemedy = "SOURCE_CHANGE" | "SCOPE_AMENDMENT";

export interface QAReviewFinding {
  id: string;
  severity: ContractFindingSeverity;
  behaviorIds: string[];
  summary: string;
  evidence: string;
  expected: string;
  observed: string;
  clearCondition: string;
  state: QAReviewFindingState;
  remedy: QAReviewFindingRemedy;
  /**
   * Repo-relative paths to add to the locked file scope — non-empty for
   * `SCOPE_AMENDMENT` and empty for `SOURCE_CHANGE`. The paths carry the
   * per-file judgment: one finding may cover three undeclared files of
   * which only two belong in scope, and only the evaluator can say which.
   */
  amendmentPaths: string[];
}

export interface QAReview {
  version: 2;
  verdict: QAReviewVerdict;
  failureClass: QAReviewFailureClass;
  infrastructureEvidence: string | null;
  findings: QAReviewFinding[];
}

export type QAReviewStage = "deterministic" | "shared-preview";

export interface QAReviewAttemptFinding {
  id: string;
  severity: ContractFindingSeverity;
  state: QAReviewFindingState;
  unresolved: boolean;
  summary: string;
  clearCondition: string;
  artifactReferences: string[];
  /**
   * Carried into the record so a resumed run can tell an amendment
   * request apart from an ordinary finding without re-reading the raw
   * artifact (#112). Version-1 records predate the field; they are read
   * as `SOURCE_CHANGE`, which is what every finding written before this
   * existed was.
   */
  remedy: QAReviewFindingRemedy;
}

export interface QAReviewAttemptRecord {
  version: 2;
  stage: QAReviewStage;
  round: number;
  attempt: number;
  verdict: QAReviewVerdict;
  failureClass: QAReviewFailureClass;
  findings: QAReviewAttemptFinding[];
  /**
   * The base-gate skip authorization the orchestrator issued for this
   * attempt, present only when one was issued (ADR 0012's 2026-08-28
   * amendment). Absent means the evaluator was told to run the whole sanity
   * list, which is what every record written before the amendment says by
   * omission — hence optional rather than nullable: a record from an older
   * archive still parses on resume.
   *
   * This records what the orchestrator *authorized*, on which tree, which is
   * the fact the orchestrator can actually assert. Whether the evaluator took
   * the skip is visible in its report's command log, next to this citation.
   */
  baseGateCitation?: BaseGateSkipCitation;
}

export interface QAReviewLifecycleFinding {
  id: string;
  state: QAReviewFindingState;
}

export interface QAReviewStageResumeState {
  history: readonly QAReviewLifecycleFinding[];
  unresolved: readonly QAReviewAttemptFinding[];
  lastImplementationRound: number | null;
}

export interface QAReviewResumeState {
  nextRound: number;
  retryStage: QAReviewStage | null;
  deterministic: QAReviewStageResumeState;
  sharedPreview: QAReviewStageResumeState;
}

const REVIEW_KEYS = [
  "version",
  "verdict",
  "failureClass",
  "infrastructureEvidence",
  "findings",
] as const;
const FINDING_KEYS = [
  "id",
  "severity",
  "behaviorIds",
  "summary",
  "evidence",
  "expected",
  "observed",
  "clearCondition",
  "state",
  "remedy",
  "amendmentPaths",
] as const;
const FINDING_STRING_FIELDS = [
  "id",
  "summary",
  "evidence",
  "expected",
  "observed",
  "clearCondition",
] as const;
const RECORD_KEYS = [
  "version",
  "stage",
  "round",
  "attempt",
  "verdict",
  "failureClass",
  "findings",
] as const;
const RECORD_KEYS_WITH_CITATION = [
  ...RECORD_KEYS,
  "baseGateCitation",
] as const;
const CITATION_KEYS = [
  "evidenceArtifactId",
  "attemptId",
  "treeId",
  "gateIds",
] as const;
const RECORD_FINDING_KEYS_V1 = [
  "id",
  "severity",
  "state",
  "unresolved",
  "summary",
  "clearCondition",
  "artifactReferences",
] as const;
const RECORD_FINDING_KEYS_V2 = [...RECORD_FINDING_KEYS_V1, "remedy"] as const;
const VERDICTS: readonly string[] = ["PASS", "FAIL"];
const FAILURE_CLASSES: readonly string[] = [
  "NONE",
  "IMPLEMENTATION",
  "INFRASTRUCTURE",
];
const SEVERITIES: readonly string[] = ["BLOCKING", "ADVISORY"];
const STATES: readonly string[] = ["OPEN", "RESOLVED"];
const REMEDIES: readonly string[] = ["SOURCE_CHANGE", "SCOPE_AMENDMENT"];

function parseFindings(value: unknown, source: string): QAReviewFinding[] {
  if (!Array.isArray(value)) {
    throw new Error(`${source} findings must be an array`);
  }

  const findings = value.map((raw, index) => {
    const field = `findings[${index}] finding`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`${source} ${field} must be an object`);
    }
    const finding = raw as Record<string, unknown>;
    requireExactKeys(finding, FINDING_KEYS, field, source);

    if (
      typeof finding.severity !== "string" ||
      !SEVERITIES.includes(finding.severity)
    ) {
      throw new Error(
        `${source} ${field} severity must be BLOCKING or ADVISORY`,
      );
    }
    if (
      typeof finding.state !== "string" ||
      !STATES.includes(finding.state)
    ) {
      throw new Error(`${source} ${field} state must be OPEN or RESOLVED`);
    }
    if (!Array.isArray(finding.behaviorIds)) {
      throw new Error(`${source} ${field} behaviorIds must be an array`);
    }
    if (finding.behaviorIds.some((id) => typeof id !== "string")) {
      throw new Error(
        `${source} ${field} behaviorIds must contain only strings`,
      );
    }
    const behaviorIds = finding.behaviorIds as string[];
    if (behaviorIds.some((id) => id.trim() === "")) {
      throw new Error(
        `${source} ${field} behaviorIds must contain only non-blank strings`,
      );
    }
    const duplicateBehaviorId = behaviorIds.find(
      (id, position) => behaviorIds.indexOf(id) !== position,
    );
    if (duplicateBehaviorId !== undefined) {
      throw new Error(
        `${source} ${field} behaviorIds must be unique; duplicate "${duplicateBehaviorId}"`,
      );
    }

    const strings: Record<string, string> = {};
    for (const name of FINDING_STRING_FIELDS) {
      strings[name] = requireNonBlankString(
        finding[name],
        `${field} ${name}`,
        source,
      );
    }

    if (
      typeof finding.remedy !== "string" ||
      !REMEDIES.includes(finding.remedy)
    ) {
      throw new Error(
        `${source} ${field} remedy must be ${REMEDIES.join(" or ")}`,
      );
    }
    const remedy = finding.remedy as QAReviewFindingRemedy;
    if (!Array.isArray(finding.amendmentPaths)) {
      throw new Error(`${source} ${field} amendmentPaths must be an array`);
    }
    if (
      finding.amendmentPaths.some(
        (path) => typeof path !== "string" || path.trim() === "",
      )
    ) {
      throw new Error(
        `${source} ${field} amendmentPaths must contain only non-blank strings`,
      );
    }
    const amendmentPaths = finding.amendmentPaths as string[];
    const duplicatePath = amendmentPaths.find(
      (path, position) => amendmentPaths.indexOf(path) !== position,
    );
    if (duplicatePath !== undefined) {
      throw new Error(
        `${source} ${field} amendmentPaths must be unique; duplicate "${duplicatePath}"`,
      );
    }
    // The remedy and the paths are one statement, so a contradiction
    // between them is refused rather than resolved by precedence: a
    // SOURCE_CHANGE carrying paths would leave it unsaid whether the
    // orchestrator is meant to amend, and an empty SCOPE_AMENDMENT names
    // no remedy anybody can perform.
    if (remedy === "SCOPE_AMENDMENT" && amendmentPaths.length === 0) {
      throw new Error(
        `${source} ${field} remedy SCOPE_AMENDMENT requires at least one amendmentPaths entry`,
      );
    }
    if (remedy === "SOURCE_CHANGE" && amendmentPaths.length > 0) {
      throw new Error(
        `${source} ${field} remedy SOURCE_CHANGE requires empty amendmentPaths`,
      );
    }
    return {
      id: strings.id!,
      severity: finding.severity as ContractFindingSeverity,
      behaviorIds: [...behaviorIds],
      summary: strings.summary!,
      evidence: strings.evidence!,
      expected: strings.expected!,
      observed: strings.observed!,
      clearCondition: strings.clearCondition!,
      state: finding.state as QAReviewFindingState,
      remedy,
      amendmentPaths: [...amendmentPaths],
    };
  });

  const duplicateFindingId = findings
    .map(({ id }) => id)
    .find((id, index, ids) => ids.indexOf(id) !== index);
  if (duplicateFindingId !== undefined) {
    throw new Error(
      `${source} finding IDs must be unique; duplicate "${duplicateFindingId}"`,
    );
  }
  return findings;
}

export function parseQAReview(
  text: string,
  source = QA_REVIEW_FILENAME,
): QAReview {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${source} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const duplicateKey = findDuplicateJsonKey(text);
  if (duplicateKey !== null) {
    throw new Error(
      `${source} declares the key "${duplicateKey}" more than once in one object`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${source} must contain a JSON object`);
  }

  const input = parsed as Record<string, unknown>;
  requireExactKeys(input, REVIEW_KEYS, "root object", source);
  if (input.version !== 2) {
    throw new Error(`${source} must declare version 2`);
  }
  if (typeof input.verdict !== "string" || !VERDICTS.includes(input.verdict)) {
    throw new Error(`${source} verdict must be PASS or FAIL`);
  }
  if (
    typeof input.failureClass !== "string" ||
    !FAILURE_CLASSES.includes(input.failureClass)
  ) {
    throw new Error(
      `${source} failureClass must be NONE, IMPLEMENTATION, or INFRASTRUCTURE`,
    );
  }
  if (
    input.infrastructureEvidence !== null &&
    (typeof input.infrastructureEvidence !== "string" ||
      input.infrastructureEvidence.trim() === "")
  ) {
    throw new Error(
      `${source} infrastructureEvidence must be a non-blank string or null`,
    );
  }

  const verdict = input.verdict as QAReviewVerdict;
  const failureClass = input.failureClass as QAReviewFailureClass;
  const infrastructureEvidence = input.infrastructureEvidence as string | null;
  const findings = parseFindings(input.findings, source);
  const hasOpenBlocking = findings.some(
    (finding) =>
      finding.severity === "BLOCKING" && finding.state === "OPEN",
  );
  const validPass =
    verdict === "PASS" &&
    failureClass === "NONE" &&
    infrastructureEvidence === null &&
    !hasOpenBlocking;
  const validImplementation =
    verdict === "FAIL" &&
    failureClass === "IMPLEMENTATION" &&
    infrastructureEvidence === null &&
    hasOpenBlocking;
  const validInfrastructure =
    verdict === "FAIL" &&
    failureClass === "INFRASTRUCTURE" &&
    infrastructureEvidence !== null &&
    findings.length === 0;
  if (!validPass && !validImplementation && !validInfrastructure) {
    throw new Error(
      `${source} must be one of PASS/NONE, FAIL/IMPLEMENTATION, or FAIL/INFRASTRUCTURE`,
    );
  }

  return {
    version: 2,
    verdict,
    failureClass,
    infrastructureEvidence,
    findings,
  };
}

export function qaReviewFilename(stage: QAReviewStage): string {
  return stage === "deterministic"
    ? QA_REVIEW_FILENAME
    : UAT_REVIEW_FILENAME;
}

export function loadQAReview(
  sliceDir: string,
  stage: QAReviewStage,
): QAReview {
  const filename = qaReviewFilename(stage);
  const path = join(sliceDir, filename);
  if (!existsSync(path)) {
    throw new Error(`${filename} is missing`);
  }
  return parseQAReview(readFileSync(path, "utf-8"), filename);
}

export function advanceQAReviewHistory(
  history: readonly QAReviewLifecycleFinding[],
  review: QAReview,
): readonly QAReviewLifecycleFinding[] {
  return advanceQAReviewLifecycle(
    history,
    review.failureClass,
    review.findings,
  );
}

function advanceQAReviewLifecycle(
  history: readonly QAReviewLifecycleFinding[],
  failureClass: QAReviewFailureClass,
  findings: readonly Pick<QAReviewFinding, "id" | "state">[],
): readonly QAReviewLifecycleFinding[] {
  if (failureClass === "INFRASTRUCTURE") return history;

  const previousById = new Map(history.map((finding) => [finding.id, finding]));
  const currentCounts = new Map<string, number>();
  for (const finding of findings) {
    currentCounts.set(finding.id, (currentCounts.get(finding.id) ?? 0) + 1);
  }

  for (const previous of history) {
    if (previous.state !== "OPEN") continue;
    const count = currentCounts.get(previous.id) ?? 0;
    if (count !== 1) {
      throw new Error(
        `QA review must repeat open finding ${previous.id} exactly once; received ${count}`,
      );
    }
  }

  for (const finding of findings) {
    const previous = previousById.get(finding.id);
    if (previous?.state === "RESOLVED") {
      throw new Error(`QA review resolved finding ${finding.id} cannot return`);
    }
    if (!previous && finding.state !== "OPEN") {
      throw new Error(
        history.length === 0
          ? `QA review first non-infrastructure attempt must start finding ${finding.id} as OPEN`
          : `QA review fresh finding ${finding.id} must start as OPEN`,
      );
    }
  }

  return [
    ...history.filter((finding) => finding.state === "RESOLVED"),
    ...findings.map(({ id, state }) => ({ id, state })),
  ];
}

function parseQAReviewAttemptRecord(
  text: string,
  source: string,
): QAReviewAttemptRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${source} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const duplicateKey = findDuplicateJsonKey(text);
  if (duplicateKey !== null) {
    throw new Error(
      `${source} declares the key "${duplicateKey}" more than once in one object`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${source} must contain a JSON object`);
  }

  const input = parsed as Record<string, unknown>;
  // The citation is optional in either version (ADR 0012's 2026-08-28
  // amendment): absent means the evaluator was told to run the whole
  // sanity list, which is what every record written before the amendment
  // says by omission.
  requireExactKeys(
    input,
    "baseGateCitation" in input ? RECORD_KEYS_WITH_CITATION : RECORD_KEYS,
    "root object",
    source,
  );
  const baseGateCitation =
    "baseGateCitation" in input
      ? parseBaseGateCitation(input.baseGateCitation, source)
      : undefined;
  // Version 1 records were written before findings carried a remedy
  // (#112) and are still the only evidence a run interrupted before this
  // change has. Refusing them would turn a schema addition into a
  // resume-breaking change, so they are read with the remedy every
  // finding then had: SOURCE_CHANGE.
  if (input.version !== 1 && input.version !== 2) {
    throw new Error(`${source} must declare version 1 or 2`);
  }
  const recordVersion = input.version as 1 | 2;
  if (input.stage !== "deterministic" && input.stage !== "shared-preview") {
    throw new Error(
      `${source} stage must be deterministic or shared-preview`,
    );
  }
  for (const field of ["round", "attempt"] as const) {
    if (
      !Number.isSafeInteger(input[field]) ||
      (input[field] as number) < 1
    ) {
      throw new Error(`${source} ${field} must be a positive integer`);
    }
  }
  if (typeof input.verdict !== "string" || !VERDICTS.includes(input.verdict)) {
    throw new Error(`${source} verdict must be PASS or FAIL`);
  }
  if (
    typeof input.failureClass !== "string" ||
    !FAILURE_CLASSES.includes(input.failureClass)
  ) {
    throw new Error(
      `${source} failureClass must be NONE, IMPLEMENTATION, or INFRASTRUCTURE`,
    );
  }
  if (!Array.isArray(input.findings)) {
    throw new Error(`${source} findings must be an array`);
  }

  const findings = input.findings.map((raw, index) => {
    const field = `findings[${index}] finding`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`${source} ${field} must be an object`);
    }
    const finding = raw as Record<string, unknown>;
    requireExactKeys(
      finding,
      recordVersion === 2 ? RECORD_FINDING_KEYS_V2 : RECORD_FINDING_KEYS_V1,
      field,
      source,
    );
    if (
      recordVersion === 2 &&
      (typeof finding.remedy !== "string" ||
        !REMEDIES.includes(finding.remedy))
    ) {
      throw new Error(
        `${source} ${field} remedy must be ${REMEDIES.join(" or ")}`,
      );
    }
    const id = requireNonBlankString(finding.id, `${field} id`, source);
    const summary = requireNonBlankString(
      finding.summary,
      `${field} summary`,
      source,
    );
    const clearCondition = requireNonBlankString(
      finding.clearCondition,
      `${field} clearCondition`,
      source,
    );
    if (
      typeof finding.severity !== "string" ||
      !SEVERITIES.includes(finding.severity)
    ) {
      throw new Error(
        `${source} ${field} severity must be BLOCKING or ADVISORY`,
      );
    }
    if (typeof finding.state !== "string" || !STATES.includes(finding.state)) {
      throw new Error(`${source} ${field} state must be OPEN or RESOLVED`);
    }
    if (finding.unresolved !== (finding.state === "OPEN")) {
      throw new Error(
        `${source} ${field} unresolved must equal state === OPEN`,
      );
    }
    if (
      !Array.isArray(finding.artifactReferences) ||
      finding.artifactReferences.length !== 2 ||
      finding.artifactReferences.some(
        (reference) =>
          typeof reference !== "string" || reference.trim() === "",
      )
    ) {
      throw new Error(
        `${source} ${field} artifactReferences must contain two non-blank strings`,
      );
    }
    return {
      id,
      severity: finding.severity as ContractFindingSeverity,
      state: finding.state as QAReviewFindingState,
      unresolved: finding.unresolved as boolean,
      summary,
      clearCondition,
      artifactReferences: [...finding.artifactReferences] as string[],
      remedy:
        recordVersion === 2
          ? (finding.remedy as QAReviewFindingRemedy)
          : "SOURCE_CHANGE",
    };
  });

  const duplicateId = findings
    .map(({ id }) => id)
    .find((id, index, ids) => ids.indexOf(id) !== index);
  if (duplicateId !== undefined) {
    throw new Error(
      `${source} finding IDs must be unique; duplicate "${duplicateId}"`,
    );
  }

  const verdict = input.verdict as QAReviewVerdict;
  const failureClass = input.failureClass as QAReviewFailureClass;
  const hasOpenBlocking = findings.some(
    (finding) =>
      finding.severity === "BLOCKING" && finding.state === "OPEN",
  );
  const validPass =
    verdict === "PASS" && failureClass === "NONE" && !hasOpenBlocking;
  const validImplementation =
    verdict === "FAIL" &&
    failureClass === "IMPLEMENTATION" &&
    hasOpenBlocking;
  const validInfrastructure =
    verdict === "FAIL" &&
    failureClass === "INFRASTRUCTURE" &&
    findings.length === 0;
  if (!validPass && !validImplementation && !validInfrastructure) {
    throw new Error(
      `${source} must be one of PASS/NONE, FAIL/IMPLEMENTATION, or FAIL/INFRASTRUCTURE`,
    );
  }

  return {
    version: 2,
    stage: input.stage,
    round: input.round as number,
    attempt: input.attempt as number,
    verdict,
    failureClass,
    findings,
    ...(baseGateCitation ? { baseGateCitation } : {}),
  };
}

function parseBaseGateCitation(
  value: unknown,
  source: string,
): BaseGateSkipCitation {
  const field = "baseGateCitation";
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${source} ${field} must be an object`);
  }
  const citation = value as Record<string, unknown>;
  requireExactKeys(citation, CITATION_KEYS, field, source);
  const evidenceArtifactId = requireNonBlankString(
    citation.evidenceArtifactId,
    `${field} evidenceArtifactId`,
    source,
  );
  const attemptId = requireNonBlankString(
    citation.attemptId,
    `${field} attemptId`,
    source,
  );
  const treeId = requireNonBlankString(
    citation.treeId,
    `${field} treeId`,
    source,
  );
  if (
    !Array.isArray(citation.gateIds) ||
    citation.gateIds.length === 0 ||
    citation.gateIds.some(
      (gateId) => typeof gateId !== "string" || gateId.trim() === "",
    )
  ) {
    throw new Error(
      `${source} ${field} gateIds must contain at least one non-blank string`,
    );
  }
  return {
    evidenceArtifactId,
    attemptId,
    treeId,
    gateIds: [...(citation.gateIds as string[])],
  };
}

const RECORD_FILENAME =
  /^(qa|uat)-review-r(\d+)-a(\d+)-record\.json$/;
const REVIEW_EVIDENCE_FILENAME =
  /^(?:qa|uat)-review-r(\d+)-a\d+(?:\.json|-record\.json|-validation\.txt)$/;
const REPORT_EVIDENCE_FILENAME = /^(?:qa|uat)-report-r(\d+)-a\d+\.md$/;

function restoreQAReviewStage(
  records: readonly QAReviewAttemptRecord[],
): QAReviewStageResumeState {
  let history: readonly QAReviewLifecycleFinding[] = [];
  let unresolved: readonly QAReviewAttemptFinding[] = [];
  let lastImplementationRound: number | null = null;

  for (const record of records) {
    if (record.failureClass !== "INFRASTRUCTURE") {
      const currentIds = new Set(record.findings.map(({ id }) => id));
      history = [
        ...history.filter(
          (finding) =>
            finding.state === "RESOLVED" && !currentIds.has(finding.id),
        ),
        ...record.findings.map(({ id, state }) => ({ id, state })),
      ];
    }
    if (record.failureClass === "INFRASTRUCTURE") continue;
    unresolved = record.findings.filter((finding) => finding.unresolved);
    lastImplementationRound =
      record.failureClass === "IMPLEMENTATION" ? record.round : null;
  }

  // An amendment request is dropped from the state a resumed run
  // inherits (#112). It is not the generator's to clear — routing it
  // would hand the generator a finding whose only available remedy is
  // deleting correct work — and the amendment it asked for either
  // already landed on disk, in which case the finding is stale, or it
  // did not, in which case the next QA pass re-raises it against the
  // contract as it actually stands. Dropped only after the replay:
  // removing an ID mid-replay would make a later attempt's disposition
  // of it read as a fresh finding.
  const amended = new Set(
    history
      .filter((entry) =>
        records.some(
          (record) =>
            record.findings.some(
              (finding) =>
                finding.id === entry.id &&
                finding.remedy === "SCOPE_AMENDMENT",
            ),
        ),
      )
      .map((entry) => entry.id),
  );
  return {
    history: history.filter((entry) => !amended.has(entry.id)),
    unresolved: unresolved.filter((finding) => !amended.has(finding.id)),
    lastImplementationRound,
  };
}

/**
 * Highest implementation round already evidenced on this tree — i.e. the
 * rounds a resume has spent against the global cap (ADR 0014).
 *
 * Filenames only: no record is parsed and nothing throws on a malformed
 * one, which is what makes it safe to call for the dispatch-time bounds
 * line as well as from `loadQAReviewResumeState` (whose `nextRound` is
 * this plus one). Both callers therefore report the same number.
 */
export function spentImplementationRounds(
  reviewArchiveDir: string,
  sliceDir: string,
): number {
  let maxRound = 0;
  const scan = (dir: string, pattern: RegExp) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const match = pattern.exec(name);
      if (match) maxRound = Math.max(maxRound, Number(match[1]));
    }
  };
  scan(reviewArchiveDir, REVIEW_EVIDENCE_FILENAME);
  scan(sliceDir, REPORT_EVIDENCE_FILENAME);
  return maxRound;
}

export function loadQAReviewResumeState(
  reviewArchiveDir: string,
  sliceDir: string,
): QAReviewResumeState {
  const reviewNames = existsSync(reviewArchiveDir)
    ? readdirSync(reviewArchiveDir)
    : [];
  const maxRound = spentImplementationRounds(reviewArchiveDir, sliceDir);

  const records = reviewNames
    .map((name) => ({ name, match: RECORD_FILENAME.exec(name) }))
    .filter(
      (
        entry,
      ): entry is { name: string; match: RegExpExecArray } =>
        entry.match !== null,
    )
    .map(({ name, match }) => {
      const record = parseQAReviewAttemptRecord(
        readFileSync(join(reviewArchiveDir, name), "utf-8"),
        name,
      );
      const expectedStage =
        match[1] === "qa" ? "deterministic" : "shared-preview";
      if (
        record.stage !== expectedStage ||
        record.round !== Number(match[2]) ||
        record.attempt !== Number(match[3])
      ) {
        throw new Error(
          `${name} contents must match its stage, round, and attempt filename`,
        );
      }
      return record;
    })
    .sort((left, right) =>
      left.round - right.round || left.attempt - right.attempt
    );

  const deterministic = restoreQAReviewStage(
    records.filter((record) => record.stage === "deterministic"),
  );
  const sharedPreview = restoreQAReviewStage(
    records.filter((record) => record.stage === "shared-preview"),
  );
  const retryStage =
    (sharedPreview.lastImplementationRound ?? -1) >
      (deterministic.lastImplementationRound ?? -1)
      ? "shared-preview"
      : deterministic.lastImplementationRound !== null
        ? "deterministic"
        : sharedPreview.lastImplementationRound !== null
          ? "shared-preview"
          : null;

  return {
    nextRound: maxRound + 1,
    retryStage,
    deterministic,
    sharedPreview,
  };
}

export function openQAReviewFindings(
  findings: readonly QAReviewFinding[],
): QAReviewFinding[] {
  return findings.filter((finding) => finding.state === "OPEN");
}

/**
 * The review's outstanding scope-amendment requests, in evaluator order
 * (#112). Only `OPEN` ones: a routed amendment finding the evaluator
 * re-checked against the amended contract and marked `RESOLVED` keeps its
 * remedy and paths as the record of what cleared it, and asking for that
 * amendment a second time would only be refused as already declared.
 *
 * An INFRASTRUCTURE review disposition holds no findings at all, so there
 * is nothing to read there — the parser refuses one that carries them.
 */
export function scopeAmendmentRequests(
  review: QAReview,
): { findingId: string; paths: string[] }[] {
  return review.findings
    .filter(
      (finding) =>
        finding.remedy === "SCOPE_AMENDMENT" && finding.state === "OPEN",
    )
    .map((finding) => ({
      findingId: finding.id,
      paths: [...finding.amendmentPaths],
    }));
}

export function buildQAReviewAttemptRecord(details: {
  stage: QAReviewStage;
  round: number;
  attempt: number;
  review: QAReview;
  canonicalArchivePath: string;
  markdownArchivePath: string;
  /**
   * The skip authorization issued for this attempt, or `null` when none was.
   * Recording it here is what makes the skip auditable: the record already
   * carries the verdict, so citation and verdict cannot be separated later.
   */
  baseGateCitation?: BaseGateSkipCitation | null;
}): QAReviewAttemptRecord {
  const {
    stage,
    round,
    attempt,
    review,
    canonicalArchivePath,
    markdownArchivePath,
    baseGateCitation,
  } = details;
  const artifactReferences = [
    canonicalArchivePath.replace(/\\/g, "/"),
    markdownArchivePath.replace(/\\/g, "/"),
  ];
  return {
    version: 2,
    stage,
    round,
    attempt,
    verdict: review.verdict,
    failureClass: review.failureClass,
    ...(baseGateCitation
      ? {
          baseGateCitation: {
            ...baseGateCitation,
            gateIds: [...baseGateCitation.gateIds],
          },
        }
      : {}),
    findings: review.findings.map((finding) => ({
      id: finding.id,
      severity: finding.severity,
      state: finding.state,
      unresolved: finding.state === "OPEN",
      summary: finding.summary,
      clearCondition: finding.clearCondition,
      artifactReferences: [...artifactReferences],
      remedy: finding.remedy,
    })),
  };
}

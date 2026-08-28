import {
  findDuplicateJsonKey,
  requireExactKeys,
  requireNonBlankString,
  type ContractFindingSeverity,
} from "./contract-review.js";
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
}

export interface QAReview {
  version: 1;
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
}

export interface QAReviewAttemptRecord {
  version: 1;
  stage: QAReviewStage;
  round: number;
  attempt: number;
  verdict: QAReviewVerdict;
  failureClass: QAReviewFailureClass;
  findings: QAReviewAttemptFinding[];
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
const RECORD_FINDING_KEYS = [
  "id",
  "severity",
  "state",
  "unresolved",
  "summary",
  "clearCondition",
  "artifactReferences",
] as const;
const VERDICTS: readonly string[] = ["PASS", "FAIL"];
const FAILURE_CLASSES: readonly string[] = [
  "NONE",
  "IMPLEMENTATION",
  "INFRASTRUCTURE",
];
const SEVERITIES: readonly string[] = ["BLOCKING", "ADVISORY"];
const STATES: readonly string[] = ["OPEN", "RESOLVED"];

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
  if (input.version !== 1) {
    throw new Error(`${source} must declare version 1`);
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
    version: 1,
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
  requireExactKeys(input, RECORD_KEYS, "root object", source);
  if (input.version !== 1) {
    throw new Error(`${source} must declare version 1`);
  }
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
    requireExactKeys(finding, RECORD_FINDING_KEYS, field, source);
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
    version: 1,
    stage: input.stage,
    round: input.round as number,
    attempt: input.attempt as number,
    verdict,
    failureClass,
    findings,
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
    history = advanceQAReviewLifecycle(
      history,
      record.failureClass,
      record.findings,
    );
    if (record.failureClass === "INFRASTRUCTURE") continue;
    unresolved = record.findings.filter((finding) => finding.unresolved);
    lastImplementationRound =
      record.failureClass === "IMPLEMENTATION" ? record.round : null;
  }
  return { history, unresolved, lastImplementationRound };
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

export function buildQAReviewAttemptRecord(details: {
  stage: QAReviewStage;
  round: number;
  attempt: number;
  review: QAReview;
  canonicalArchivePath: string;
  markdownArchivePath: string;
}): QAReviewAttemptRecord {
  const {
    stage,
    round,
    attempt,
    review,
    canonicalArchivePath,
    markdownArchivePath,
  } = details;
  const artifactReferences = [
    canonicalArchivePath.replace(/\\/g, "/"),
    markdownArchivePath.replace(/\\/g, "/"),
  ];
  return {
    version: 1,
    stage,
    round,
    attempt,
    verdict: review.verdict,
    failureClass: review.failureClass,
    findings: review.findings.map((finding) => ({
      id: finding.id,
      severity: finding.severity,
      state: finding.state,
      unresolved: finding.state === "OPEN",
      summary: finding.summary,
      clearCondition: finding.clearCondition,
      artifactReferences: [...artifactReferences],
    })),
  };
}

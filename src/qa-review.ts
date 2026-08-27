import {
  findDuplicateJsonKey,
  requireExactKeys,
  requireNonBlankString,
  type ContractFindingSeverity,
} from "./contract-review.js";
import { existsSync, readFileSync } from "node:fs";
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
  history: readonly QAReviewFinding[],
  review: QAReview,
): readonly QAReviewFinding[] {
  if (review.failureClass === "INFRASTRUCTURE") return history;

  const previousById = new Map(history.map((finding) => [finding.id, finding]));
  const currentCounts = new Map<string, number>();
  for (const finding of review.findings) {
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

  for (const finding of review.findings) {
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
    ...review.findings,
  ];
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

import {
  findDuplicateJsonKey,
  requireExactKeys,
  requireNonBlankString,
  type ContractFindingSeverity,
} from "./contract-review.js";

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

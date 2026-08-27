import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const CONTRACT_REVIEW_FILENAME = "contract-review.json";

/**
 * The only verdicts the contract review can carry. `ESCALATE` is gone:
 * an evaluator that cannot decide writes a REVISE finding saying so, and
 * an artifact that carries anything else is refused outright rather than
 * mapped onto a third outcome.
 */
export type ContractReviewVerdict = "ACCEPT" | "REVISE";

/**
 * A recorded contract verdict, or `NONE` when negotiation ended before
 * any review artifact produced one (no round ran, or the acceptance
 * manifest was refused before the evaluator was invoked).
 */
export type RecordedContractVerdict = ContractReviewVerdict | "NONE";

/**
 * `BLOCKING` findings are the ones that decide the verdict: a contract
 * cannot lock while one stands. `ADVISORY` findings are recorded and
 * routed to the planner but do not by themselves force a REVISE.
 */
export type ContractFindingSeverity = "BLOCKING" | "ADVISORY";

export interface ContractReviewFinding {
  /**
   * Stable identifier for this gap. The evaluator reuses the same ID in
   * a later round when the same gap still stands — that reuse, not an
   * agent-reported count, is how the orchestrator measures re-raised
   * gaps.
   */
  id: string;
  severity: ContractFindingSeverity;
  /**
   * Manifest behavior IDs the finding is about. May be empty: a finding
   * against the contract as a whole (a missing non-goal, an infeasible
   * scope) belongs to no single behavior, and forcing one would make the
   * evaluator invent an attribution.
   */
  behaviorIds: string[];
  /** Quoted text from the contract or manifest the finding is about. */
  evidence: string;
  /** What the contract should say or do. */
  expected: string;
  /** What it says or does instead. */
  observed: string;
  /** The observable change that resolves the finding. */
  clearCondition: string;
}

export interface ContractReview {
  version: 1;
  verdict: ContractReviewVerdict;
  findings: ContractReviewFinding[];
}

/** Root keys the artifact must carry, and nothing else. */
const REVIEW_KEYS = ["version", "verdict", "findings"] as const;

/** Finding keys the artifact must carry, and nothing else. */
const FINDING_KEYS = [
  "id",
  "severity",
  "behaviorIds",
  "evidence",
  "expected",
  "observed",
  "clearCondition",
] as const;

/**
 * Finding fields that must each be a non-blank string. Enumerated rather
 * than derived so that adding a field to `FINDING_KEYS` without deciding
 * its type is a compile-time omission, not a silently unchecked field.
 */
const FINDING_STRING_FIELDS = [
  "id",
  "evidence",
  "expected",
  "observed",
  "clearCondition",
] as const;

const VERDICTS: readonly string[] = ["ACCEPT", "REVISE"];
const SEVERITIES: readonly string[] = ["BLOCKING", "ADVISORY"];

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  field: string,
  source: string,
): void {
  const expectedKeys = new Set(expected);
  const unexpected = Object.keys(value).filter((key) => !expectedKeys.has(key));
  const missing = expected.filter((key) => !(key in value));
  if (unexpected.length > 0 || missing.length > 0) {
    throw new Error(
      `${source} ${field} must contain exactly ${expected.join(", ")}`,
    );
  }
}

function requireNonBlankString(
  value: unknown,
  field: string,
  source: string,
): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${source} ${field} must be a non-blank string`);
  }
  return value;
}

type JsonScope = { kind: "object"; keys: Set<string> } | { kind: "array" };

/**
 * First key that appears twice in the same JSON object, or `null`.
 *
 * `JSON.parse` silently keeps the last of a repeated key, so
 * `{"verdict": "ACCEPT", "verdict": "REVISE"}` parses to a single
 * verdict and reads as a clean artifact. Two verdicts in one review is
 * exactly the contradiction this slice must refuse, so the raw bytes are
 * scanned before the parsed object is trusted. That is why
 * {@link parseContractReview} takes text and not an already-parsed
 * value.
 *
 * Only well-formed JSON reaches this scanner — callers parse first — so
 * it does not need to validate syntax, only to walk strings correctly so
 * a `":"` inside a string value is never mistaken for a key separator.
 */
function findDuplicateJsonKey(text: string): string | null {
  const scopes: JsonScope[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === "{") {
      scopes.push({ kind: "object", keys: new Set() });
      index++;
      continue;
    }
    if (char === "[") {
      scopes.push({ kind: "array" });
      index++;
      continue;
    }
    if (char === "}" || char === "]") {
      scopes.pop();
      index++;
      continue;
    }
    if (char !== '"') {
      index++;
      continue;
    }

    const start = index;
    index++;
    while (index < text.length) {
      if (text[index] === "\\") {
        index += 2;
        continue;
      }
      if (text[index] === '"') {
        index++;
        break;
      }
      index++;
    }
    const literal = text.slice(start, index);

    // A string is a key only when the next non-whitespace character is a
    // colon and the enclosing scope is an object.
    let after = index;
    while (after < text.length && /\s/.test(text[after]!)) after++;
    const scope = scopes[scopes.length - 1];
    if (text[after] !== ":" || scope?.kind !== "object") continue;

    let key: unknown;
    try {
      key = JSON.parse(literal);
    } catch {
      continue;
    }
    if (typeof key !== "string") continue;
    if (scope.keys.has(key)) return key;
    scope.keys.add(key);
  }
  return null;
}

function parseFindings(
  value: unknown,
  source: string,
): ContractReviewFinding[] {
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
        `${source} ${field} severity must be ${SEVERITIES.join(" or ")}`,
      );
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
      evidence: strings.evidence!,
      expected: strings.expected!,
      observed: strings.observed!,
      clearCondition: strings.clearCondition!,
    };
  });

  const duplicateFindingId = findings
    .map((finding) => finding.id)
    .find((id, index, ids) => ids.indexOf(id) !== index);
  if (duplicateFindingId !== undefined) {
    throw new Error(
      `${source} finding IDs must be unique; duplicate "${duplicateFindingId}"`,
    );
  }
  return findings;
}

/**
 * Parse the canonical contract review artifact, or throw naming the
 * artifact and the defect. Every rejection is terminal for the slice:
 * the orchestrator never falls back to a default verdict, so the only
 * way to reach a verdict is a schema-valid, self-consistent artifact.
 *
 * Takes the raw text rather than a parsed value on purpose — see
 * {@link findDuplicateJsonKey}.
 */
export function parseContractReview(
  text: string,
  source = CONTRACT_REVIEW_FILENAME,
): ContractReview {
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
  if (input.version !== 1) {
    throw new Error(`${source} must declare version 1`);
  }
  requireExactKeys(input, REVIEW_KEYS, "root object", source);

  if (typeof input.verdict !== "string" || !VERDICTS.includes(input.verdict)) {
    throw new Error(`${source} verdict must be ${VERDICTS.join(" or ")}`);
  }
  const verdict = input.verdict as ContractReviewVerdict;
  const findings = parseFindings(input.findings, source);

  const blocking = findings.filter(
    (finding) => finding.severity === "BLOCKING",
  );
  if (verdict === "ACCEPT" && blocking.length > 0) {
    throw new Error(
      `${source} verdict ACCEPT contradicts ${blocking.length} BLOCKING finding(s): ` +
        blocking.map((finding) => finding.id).join(", "),
    );
  }
  if (verdict === "REVISE" && blocking.length === 0) {
    throw new Error(
      `${source} verdict REVISE requires at least one BLOCKING finding`,
    );
  }

  return { version: 1, verdict, findings };
}

export function contractReviewPath(sliceDir: string): string {
  return join(sliceDir, CONTRACT_REVIEW_FILENAME);
}

/**
 * Read and validate the review the evaluator just wrote. A missing file
 * is a defect like any other: there is no "the agent probably meant
 * ACCEPT" path.
 */
export function loadContractReview(sliceDir: string): ContractReview {
  const path = contractReviewPath(sliceDir);
  if (!existsSync(path)) {
    throw new Error(`${path} is missing`);
  }
  return parseContractReview(readFileSync(path, "utf-8"), path);
}

export interface ContractReviewGapMetrics {
  /**
   * Blocking findings in this round. Advisory findings are excluded: the
   * round cap exists to judge progress towards a lockable contract, and
   * an advisory finding never stood in the way of a lock.
   */
  gapCount: number;
  /**
   * Blocking findings whose ID the previous round's review also raised
   * as blocking. `null` when there is no previous round.
   */
  reRaisedGapCount: number | null;
}

/**
 * Derive the round-cap metrics from the artifacts, replacing the
 * evaluator's self-reported `GAPS:`/`RE_RAISED_GAPS:` counts. An agent
 * cannot understate its own gaps to earn an extension it did not earn.
 */
export function contractReviewGapMetrics(
  current: ContractReview,
  previous: ContractReview | null,
): ContractReviewGapMetrics {
  const blockingIds = (review: ContractReview): string[] =>
    review.findings
      .filter((finding) => finding.severity === "BLOCKING")
      .map((finding) => finding.id);
  const currentIds = blockingIds(current);
  if (previous === null) {
    return { gapCount: currentIds.length, reRaisedGapCount: null };
  }
  const previousIds = new Set(blockingIds(previous));
  return {
    gapCount: currentIds.length,
    reRaisedGapCount: currentIds.filter((id) => previousIds.has(id)).length,
  };
}

/**
 * Render the review's findings for a planner prompt or a `stuck.md`
 * section. Every finding carries its clear-condition, which is the whole
 * point of routing the structured artifact rather than a prose summary:
 * the planner is told the observable change that resolves each gap.
 */
export function formatContractReviewFindings(
  findings: readonly ContractReviewFinding[],
): string {
  if (findings.length === 0) return "(no findings were recorded)";
  return findings
    .map((finding) =>
      [
        `- [${finding.id}] ${finding.severity}` +
          (finding.behaviorIds.length > 0
            ? ` — behaviors: ${finding.behaviorIds.join(", ")}`
            : " — no single behavior"),
        `  - Evidence: ${finding.evidence}`,
        `  - Expected: ${finding.expected}`,
        `  - Observed: ${finding.observed}`,
        `  - Clear when: ${finding.clearCondition}`,
      ].join("\n"),
    )
    .join("\n");
}

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { findDuplicateJsonKey } from "./json-scan.js";

// Re-exported so the review parsers' existing importers keep one import
// site while the scanner itself lives where every artifact on the
// decision boundary can reach it (see `json-scan.ts`).
export { findDuplicateJsonKey };

export const CONTRACT_REVIEW_FILENAME = "contract-review.json";
export const CONTRACT_RESPONSE_FILENAME = "contract-response.json";
export const CONTRACT_NEGOTIATION_OUTCOME_FILENAME =
  "contract-negotiation-outcome.json";

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
export type ContractFindingState =
  | "OPEN"
  | "RESOLVED"
  | "CONTESTED"
  | "WITHDRAWN";

export interface ContractRevisionCitation {
  artifact: "contract.md" | "acceptance-manifest.json";
  before: string;
  after: string;
}

export type ContractRevisionArtifacts = Record<
  ContractRevisionCitation["artifact"],
  { before: string; after: string }
>;

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
  state: ContractFindingState;
  /**
   * Only fresh round-2 findings carry a citation. Familiar IDs use null;
   * the round validator checks fresh citations against the actual
   * previous and current artifacts.
   */
  revisionCitation: ContractRevisionCitation | null;
}

export interface ContractReview {
  version: 2;
  verdict: ContractReviewVerdict;
  findings: ContractReviewFinding[];
}

export type ContractResponsePosition =
  | "UNRESOLVED"
  | "CONDITION_MET"
  | "CONTESTED";

export interface ContractResponseEntry {
  findingId: string;
  position: ContractResponsePosition;
  evidence: string;
}

export interface ContractResponse {
  version: 1;
  round: number;
  responses: ContractResponseEntry[];
}

export interface ContractReviewAttemptFinding {
  id: string;
  severity: ContractFindingSeverity;
  state: ContractFindingState;
  unresolved: boolean;
  plannerPosition: ContractResponsePosition | null;
  plannerEvidence: string | null;
  evaluatorEvidence: string;
}

export interface ContractReviewAttemptRecord {
  version: 1;
  round: number;
  attempt: number;
  verdict: ContractReviewVerdict;
  findings: ContractReviewAttemptFinding[];
}

export interface ContractNegotiationOutcome {
  version: 1;
  classification: "IMPASSE" | "NON_CONVERGENCE";
  round: number;
  attempt: number;
  findings: ContractReviewAttemptFinding[];
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
  "state",
  "revisionCitation",
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
const STATES: readonly string[] = [
  "OPEN",
  "RESOLVED",
  "CONTESTED",
  "WITHDRAWN",
];
const CITATION_ARTIFACTS: readonly string[] = [
  "contract.md",
  "acceptance-manifest.json",
];
const CITATION_KEYS = ["artifact", "before", "after"] as const;
const RESPONSE_KEYS = ["version", "round", "responses"] as const;
const RESPONSE_ENTRY_KEYS = ["findingId", "position", "evidence"] as const;
const RESPONSE_POSITIONS: readonly string[] = [
  "UNRESOLVED",
  "CONDITION_MET",
  "CONTESTED",
];

export function requireExactKeys(
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

export function requireNonBlankString(
  value: unknown,
  field: string,
  source: string,
): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${source} ${field} must be a non-blank string`);
  }
  return value;
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
    if (
      typeof finding.state !== "string" ||
      !STATES.includes(finding.state)
    ) {
      throw new Error(
        `${source} ${field} state must be ${STATES.join(", ")}`,
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

    let revisionCitation: ContractRevisionCitation | null = null;
    if (finding.revisionCitation !== null) {
      if (
        !finding.revisionCitation ||
        typeof finding.revisionCitation !== "object" ||
        Array.isArray(finding.revisionCitation)
      ) {
        throw new Error(
          `${source} ${field} revisionCitation must be null or an object`,
        );
      }
      const citation = finding.revisionCitation as Record<string, unknown>;
      requireExactKeys(
        citation,
        CITATION_KEYS,
        `${field} revisionCitation`,
        source,
      );
      if (
        typeof citation.artifact !== "string" ||
        !CITATION_ARTIFACTS.includes(citation.artifact)
      ) {
        throw new Error(
          `${source} ${field} revisionCitation artifact must be ${CITATION_ARTIFACTS.join(" or ")}`,
        );
      }
      revisionCitation = {
        artifact: citation.artifact as ContractRevisionCitation["artifact"],
        before: requireNonBlankString(
          citation.before,
          `${field} revisionCitation before`,
          source,
        ),
        after: requireNonBlankString(
          citation.after,
          `${field} revisionCitation after`,
          source,
        ),
      };
    }

    return {
      id: strings.id!,
      severity: finding.severity as ContractFindingSeverity,
      behaviorIds: [...behaviorIds],
      evidence: strings.evidence!,
      expected: strings.expected!,
      observed: strings.observed!,
      clearCondition: strings.clearCondition!,
      state: finding.state as ContractFindingState,
      revisionCitation,
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
  if (input.version !== 2) {
    throw new Error(`${source} must declare version 2`);
  }
  requireExactKeys(input, REVIEW_KEYS, "root object", source);

  if (typeof input.verdict !== "string" || !VERDICTS.includes(input.verdict)) {
    throw new Error(`${source} verdict must be ${VERDICTS.join(" or ")}`);
  }
  const verdict = input.verdict as ContractReviewVerdict;
  const findings = parseFindings(input.findings, source);

  const blocking = findings.filter(
    (finding) =>
      finding.severity === "BLOCKING" &&
      (finding.state === "OPEN" || finding.state === "CONTESTED"),
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

  return { version: 2, verdict, findings };
}

/**
 * Parse the planner's round-2 positions and verify that their IDs equal
 * the routed OPEN set. Response order is presentation; identity is the
 * control boundary.
 */
export function parseContractResponse(
  text: string,
  routedFindingIds: readonly string[],
  expectedRound = 2,
  source = CONTRACT_RESPONSE_FILENAME,
): ContractResponse {
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
  requireExactKeys(input, RESPONSE_KEYS, "root object", source);
  if (input.version !== 1) {
    throw new Error(`${source} must declare version 1`);
  }
  if (input.round !== expectedRound) {
    throw new Error(`${source} must declare round ${expectedRound}`);
  }
  if (!Array.isArray(input.responses)) {
    throw new Error(`${source} responses must be an array`);
  }

  const responses = input.responses.map((raw, index) => {
    const field = `responses[${index}] response`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`${source} ${field} must be an object`);
    }
    const response = raw as Record<string, unknown>;
    requireExactKeys(response, RESPONSE_ENTRY_KEYS, field, source);
    const findingId = requireNonBlankString(
      response.findingId,
      `${field} findingId`,
      source,
    );
    if (
      typeof response.position !== "string" ||
      !RESPONSE_POSITIONS.includes(response.position)
    ) {
      throw new Error(
        `${source} ${field} position must be ${RESPONSE_POSITIONS.join(", ")}`,
      );
    }
    if (typeof response.evidence !== "string") {
      throw new Error(`${source} ${field} evidence must be a string`);
    }
    if (
      response.position !== "UNRESOLVED" &&
      response.evidence.trim() === ""
    ) {
      throw new Error(
        `${source} ${field} evidence must be non-blank for ${response.position}`,
      );
    }
    return {
      findingId,
      position: response.position as ContractResponsePosition,
      evidence: response.evidence,
    };
  });

  const responseIds = responses.map((response) => response.findingId);
  const duplicate = responseIds.find(
    (id, index) => responseIds.indexOf(id) !== index,
  );
  if (duplicate !== undefined) {
    throw new Error(
      `${source} response IDs must be unique; duplicate "${duplicate}"`,
    );
  }
  const routed = new Set(routedFindingIds);
  const actual = new Set(responseIds);
  const missing = routedFindingIds.filter((id) => !actual.has(id));
  const unexpected = responseIds.filter((id) => !routed.has(id));
  if (missing.length > 0 || unexpected.length > 0) {
    const details = [
      missing.length > 0 ? `missing ${missing.join(", ")}` : "",
      unexpected.length > 0 ? `unexpected ${unexpected.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("; ");
    throw new Error(
      `${source} response IDs must equal routed finding IDs (${details})`,
    );
  }
  return { version: 1, round: expectedRound, responses };
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

export function loadContractResponse(
  sliceDir: string,
  routedFindingIds: readonly string[],
  expectedRound = 2,
): ContractResponse {
  const path = join(sliceDir, CONTRACT_RESPONSE_FILENAME);
  if (!existsSync(path)) {
    throw new Error(`${path} is missing`);
  }
  return parseContractResponse(
    readFileSync(path, "utf-8"),
    routedFindingIds,
    expectedRound,
    path,
  );
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
      .filter(
        (finding) =>
          finding.severity === "BLOCKING" &&
          (finding.state === "OPEN" || finding.state === "CONTESTED"),
      )
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
        `- [${finding.id}] ${finding.severity} ${finding.state}` +
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

/** Findings the next planner round may act on, in evaluator order. */
export function openContractReviewFindings(
  findings: readonly ContractReviewFinding[],
): ContractReviewFinding[] {
  return findings.filter((finding) => finding.state === "OPEN");
}

/** Build the code-derived audit record for one valid evaluator attempt. */
export function buildContractReviewAttemptRecord(
  round: number,
  attempt: number,
  review: ContractReview,
  response: ContractResponse | null,
): ContractReviewAttemptRecord {
  const plannerByFindingId = new Map(
    response?.responses.map((entry) => [entry.findingId, entry]),
  );
  return {
    version: 1,
    round,
    attempt,
    verdict: review.verdict,
    findings: review.findings.map((finding) => {
      const planner = plannerByFindingId.get(finding.id);
      return {
        id: finding.id,
        severity: finding.severity,
        state: finding.state,
        unresolved:
          finding.state === "OPEN" || finding.state === "CONTESTED",
        plannerPosition: planner?.position ?? null,
        plannerEvidence: planner?.evidence ?? null,
        evaluatorEvidence: finding.evidence,
      };
    }),
  };
}

/**
 * Classify final unresolved BLOCKING records at negotiation exhaustion.
 *
 * Adjudicability decides the classification (ADR 0055 §1): an `IMPASSE` is
 * an exhaustion a human can settle, so **every** unresolved blocker must be
 * `CONTESTED` — two held positions to choose between. A single unresolved
 * `OPEN` blocker makes it `NON_CONVERGENCE`, because no decision a human
 * can record resolves an open finding: a park containing one satisfies no
 * honest completion predicate and would park forever. ADR 0041 settles the
 * choice between "park that cannot unlock" and "non-convergence that routes
 * to the operator" — take the branch that cannot loop. The resumed slice
 * renegotiates; if the open findings clear and the contests survive, that
 * fresh exhaustion is a pure impasse and parks adjudicably.
 *
 * The record keeps every unresolved blocker either way: it is the audit of
 * what the exhaustion contained, not only of what a human could decide.
 */
export function buildContractNegotiationOutcome(
  record: ContractReviewAttemptRecord,
): ContractNegotiationOutcome | undefined {
  const findings = record.findings.filter(
    (finding) => finding.severity === "BLOCKING" && finding.unresolved,
  );
  if (findings.length === 0) return undefined;

  return {
    version: 1,
    classification: findings.every((finding) => finding.state === "CONTESTED")
      ? "IMPASSE"
      : "NON_CONVERGENCE",
    round: record.round,
    attempt: record.attempt,
    findings,
  };
}

/** Round 1 establishes finding identity; no finding is terminal yet. */
export function validateRound1ContractReview(review: ContractReview): void {
  const nonOpen = review.findings.filter((finding) => finding.state !== "OPEN");
  if (nonOpen.length > 0) {
    throw new Error(
      `${CONTRACT_REVIEW_FILENAME} round 1 findings must be OPEN: ` +
        nonOpen.map(({ id }) => id).join(", "),
    );
  }
}

/**
 * Validate the evaluator's disposition of each routed planner position.
 * Fresh later-round IDs are validated separately against revision citations.
 */
export function validateRound2ContractReview(
  previous: ContractReview,
  response: ContractResponse,
  current: ContractReview,
  revisions?: ContractRevisionArtifacts,
  lifecyclePrevious: ContractReview = previous,
): void {
  const previousById = new Map(
    previous.findings.map((finding) => [finding.id, finding]),
  );
  const currentById = new Map(
    current.findings.map((finding) => [finding.id, finding]),
  );
  const legalStates: Record<
    ContractResponsePosition,
    readonly ContractFindingState[]
  > = {
    UNRESOLVED: ["OPEN"],
    CONDITION_MET: ["OPEN", "RESOLVED"],
    CONTESTED: ["CONTESTED", "WITHDRAWN"],
  };

  for (const plannerPosition of response.responses) {
    const previousFinding = previousById.get(plannerPosition.findingId);
    if (previousFinding?.state !== "OPEN") {
      throw new Error(
        `${CONTRACT_RESPONSE_FILENAME} routed ID ${plannerPosition.findingId} must identify a previous OPEN finding`,
      );
    }
    const disposition = currentById.get(plannerPosition.findingId);
    if (!disposition) {
      throw new Error(
        `${CONTRACT_REVIEW_FILENAME} round 2 omitted routed finding ${plannerPosition.findingId}`,
      );
    }
    const allowed = legalStates[plannerPosition.position];
    if (!allowed.includes(disposition.state)) {
      throw new Error(
        `${CONTRACT_REVIEW_FILENAME} finding ${plannerPosition.findingId} with planner position ` +
          `${plannerPosition.position} must be ${allowed.join(" or ")}, not ${disposition.state}`,
      );
    }
  }

  for (const finding of current.findings) {
    const previousFinding = previousById.get(finding.id);
    if (previousFinding) {
      if (finding.revisionCitation !== null) {
        throw new Error(
          `${CONTRACT_REVIEW_FILENAME} familiar finding ${finding.id} must use revisionCitation null`,
        );
      }
      // A durable finding may legitimately reopen under the same stable ID.
      // Its structured evidence is then compared by convergence policy,
      // which classifies unchanged evidence as non-progress. Rejecting the
      // transition here made that policy unreachable and turned a bounded
      // intervention into a malformed-artifact ERROR.
      continue;
    }

    if (finding.state !== "OPEN") {
      throw new Error(
        `${CONTRACT_REVIEW_FILENAME} fresh finding ${finding.id} must be OPEN`,
      );
    }
    const citation = finding.revisionCitation;
    if (!citation) {
      throw new Error(
        `${CONTRACT_REVIEW_FILENAME} fresh finding ${finding.id} requires a revisionCitation`,
      );
    }
    if (citation.before === citation.after) {
      throw new Error(
        `${CONTRACT_REVIEW_FILENAME} fresh finding ${finding.id} revisionCitation before and after must differ`,
      );
    }
    const artifact = revisions?.[citation.artifact];
    if (!artifact) {
      throw new Error(
        `${CONTRACT_REVIEW_FILENAME} fresh finding ${finding.id} cannot validate revisionCitation without revision artifacts`,
      );
    }
    if (!artifact.before.includes(citation.before)) {
      throw new Error(
        `${CONTRACT_REVIEW_FILENAME} fresh finding ${finding.id} revisionCitation before does not match prior ${citation.artifact}`,
      );
    }
    if (!artifact.after.includes(citation.after)) {
      throw new Error(
        `${CONTRACT_REVIEW_FILENAME} fresh finding ${finding.id} revisionCitation after does not match current ${citation.artifact}`,
      );
    }
    if (
      artifact.after.includes(citation.before) ||
      artifact.before.includes(citation.after)
    ) {
      throw new Error(
        `${CONTRACT_REVIEW_FILENAME} fresh finding ${finding.id} revisionCitation does not identify changed ${citation.artifact} text`,
      );
    }
  }
}

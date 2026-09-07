import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseJsonWithUniqueKeys } from "./json-scan.js";

/**
 * The planner's deliberate-stop sentinel.
 *
 * `.md` holding JSON is this repo's established shape for a
 * one-decision agent-authored control artifact — `escalation.md`
 * (`escalation.ts`) and `adjudication.md` (`adjudication.ts`) are both
 * exactly that. The sentinel follows them rather than inventing a third
 * dialect.
 */
export const PLANNER_ESCALATION_FILENAME = "planner-escalation.md";

/**
 * Which of `docs/specs/afk-v2-plan.md` §3c policy 1's three escalation
 * tests fired. The planner may not escalate without naming one: the whole
 * point of the rule is that mechanical and reversible ambiguity is decided
 * and recorded, so an escalation has to say which test lifted this decision
 * out of that class.
 */
export type PlannerEscalationCriterion =
  | "SPEC_CONTRADICTION"
  | "LOAD_BEARING_SILENCE"
  | "DECLARED_RISK_CLASS";

const CRITERIA: readonly PlannerEscalationCriterion[] = [
  "SPEC_CONTRADICTION",
  "LOAD_BEARING_SILENCE",
  "DECLARED_RISK_CLASS",
];

const CRITERION_LABEL: Record<PlannerEscalationCriterion, string> = {
  SPEC_CONTRADICTION: "the specification contradicts itself",
  LOAD_BEARING_SILENCE: "the specification is silent on a load-bearing decision",
  DECLARED_RISK_CLASS: "the decision is in a declared risk class",
};

export interface PlannerEscalation {
  version: 1;
  criterion: PlannerEscalationCriterion;
  /** The decision the human has to make, in one line. */
  decision: string;
  /**
   * At least two candidate answers. Required, because a request with no
   * candidates is a report that something is wrong rather than a decision a
   * human can make in one reading — and §3c policy 1 escalates precisely so
   * that a *decision* gets recorded.
   */
  options: string[];
  /** Where the contradiction, silence, or risk class is — PRD line, ADR ID, risk class. */
  citation: string;
}

/**
 * What was on disk. A sentinel that does not parse is `malformed`, never
 * absent: the planner stopped on purpose either way, and reading a broken
 * record as "no sentinel" would put the run straight back into the failure
 * this file exists to remove — a deliberate stop reported as a missing
 * `acceptance-manifest.json` and a second, unchanged round spent on it.
 */
export type PlannerEscalationRecord =
  | { kind: "escalation"; escalation: PlannerEscalation }
  | { kind: "malformed"; defect: string };

export function parsePlannerEscalation(
  value: string,
  source = PLANNER_ESCALATION_FILENAME,
): PlannerEscalation {
  // Duplicate keys are refused rather than resolved, for the reason
  // `adjudication.md` refuses them (PM blocker 1, fifth adjudication gate
  // round): a record claiming two criteria or two citations has not made a
  // request, and `JSON.parse` would silently keep whichever came last.
  const parsed = parseJsonWithUniqueKeys(value, source);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${source} must contain a JSON object`);
  }
  const input = parsed as Record<string, unknown>;
  const expected = ["version", "criterion", "decision", "options", "citation"];
  const keys = Object.keys(input);
  if (
    keys.some((key) => !expected.includes(key)) ||
    expected.some((key) => !(key in input))
  ) {
    throw new Error(
      `${source} root object must contain exactly ${expected.join(", ")}`,
    );
  }
  if (input.version !== 1) {
    throw new Error(`${source} must declare version 1`);
  }
  if (!CRITERIA.includes(input.criterion as PlannerEscalationCriterion)) {
    throw new Error(
      `${source} criterion must be one of ${CRITERIA.join(", ")}`,
    );
  }
  for (const field of ["decision", "citation"] as const) {
    const raw = input[field];
    if (typeof raw !== "string" || raw.trim() === "") {
      throw new Error(`${source} ${field} must be a non-blank string`);
    }
  }
  const options = input.options;
  if (!Array.isArray(options) || options.length < 2) {
    throw new Error(
      `${source} options must list at least two candidate answers`,
    );
  }
  if (
    options.some((option) => typeof option !== "string" || option.trim() === "")
  ) {
    throw new Error(`${source} options must contain only non-blank strings`);
  }
  return {
    version: 1,
    criterion: input.criterion as PlannerEscalationCriterion,
    decision: (input.decision as string).trim(),
    options: (options as string[]).map((option) => option.trim()),
    citation: (input.citation as string).trim(),
  };
}

/** `null` when the planner wrote no sentinel — the ordinary case. */
export function readPlannerEscalation(
  sliceDir: string,
): PlannerEscalationRecord | null {
  const path = join(sliceDir, PLANNER_ESCALATION_FILENAME);
  if (!existsSync(path)) return null;
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "malformed", defect: `${PLANNER_ESCALATION_FILENAME} is unreadable: ${message}` };
  }
  try {
    return { kind: "escalation", escalation: parsePlannerEscalation(text) };
  } catch (error) {
    return {
      kind: "malformed",
      defect: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Delete any sentinel before a planner invocation, so a record on disk can
 * only ever be the one the invocation that just ran wrote. Called at every
 * planner call site: the sentinel's whole value is that its presence means
 * "this planner stopped on purpose", and a survivor from an earlier round,
 * an earlier phase, or an earlier run would make it mean nothing.
 */
export function clearPlannerEscalation(sliceDir: string): void {
  rmSync(join(sliceDir, PLANNER_ESCALATION_FILENAME), { force: true });
}

/**
 * The operator-facing sentence. Says "design decision requested" in those
 * words, because the failure this replaces reported the same event as a
 * missing `acceptance-manifest.json` and sent the reader looking for a
 * broken planner instead of an unsettled decision.
 */
export function plannerEscalationRequest(
  record: PlannerEscalationRecord,
): string {
  if (record.kind === "malformed") {
    return (
      `the planner stopped to request a design decision, but its ` +
      `${PLANNER_ESCALATION_FILENAME} record cannot be read — ${record.defect}`
    );
  }
  const { criterion, decision, options, citation } = record.escalation;
  return (
    `design decision requested: ${decision} — ` +
    `${CRITERION_LABEL[criterion]} (${criterion}), cited ${citation}; ` +
    `candidates: ${options.join(" | ")}`
  );
}

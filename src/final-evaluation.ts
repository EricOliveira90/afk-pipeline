/**
 * Final evaluation and reuse (#96, PRD decisions D9/D19/D20).
 *
 * After a candidate is approved and a post-approval writing stage has had its
 * turn, the orchestrator asks one question: is the tree about to merge the
 * same tree the approved baseline recorded? If it is, there is nothing for a
 * final evaluator to look at and the run reuses the approval. If it is not —
 * by so much as one byte — the changed tree is evaluated.
 *
 * Everything here is pure. The decision takes tree IDs and a persisted
 * baseline locator and returns a decision; the schema functions take text and
 * return values or throw. No git, no filesystem, no run state: the call sites
 * in `src/orchestrator.ts` own all three, which is what lets the decision
 * table be unit-tested without spawning a pipeline.
 *
 * D20 is deliberately unforgiving: exact string equality on the tree ID, with
 * no cosmetic-change exception. A "harmless" reformat is exactly the class of
 * change a preservation review exists to catch, so a summary that reads
 * "only whitespace moved" is a claim to check, not a reason to skip checking.
 */
import {
  findDuplicateJsonKey,
  requireExactKeys,
  requireNonBlankString,
} from "./contract-review.js";

/** The final evaluator's two artifacts, by canonical name. */
export const FINAL_REVIEW_FILENAME = "final-review.json";
export const FINAL_REPORT_FILENAME = "final-report.md";

/**
 * The single post-approval writing stage (#96 B-03).
 *
 * One id, because there is exactly one stage today — a production no-op until
 * PRD 5 gives it a cleaner and a hardener. It is a string constant rather than
 * an exported stage interface so that adding the second stage is a change to
 * this list and its `byStage` keys, not a new cross-module contract.
 */
export const POST_APPROVAL_WRITING_STAGE_ID = "post-approval-writing";

/** What the slice's `approved-baseline.json` record contributes to the decision. */
export interface FinalReuseBaseline {
  /** The tree ID the approval was graded against (D10: artifacts are keyed by tree). */
  treeId: string;
  /**
   * The tree this baseline's approval actually authorizes at the accept seam,
   * when that is not `treeId` itself.
   *
   * #91 records the baseline at the *QA checkpoint* — the tree the evaluator
   * graded, captured before the evaluator wrote `qa-report.md` and
   * `qa-review.json`. Those two artifacts are then committed inside the QA
   * window, and `reviewArtifactViolations` is what decides they are the only
   * difference. So the tree the run is about to merge is never string-equal to
   * `treeId`, and comparing against `treeId` alone could only ever answer
   * `evaluate`.
   *
   * The caller therefore supplies the accepted tree here, and only after
   * proving the QA window explains every path by which it differs from
   * `treeId`. Absent (`undefined`) is the fail-closed reading: the approval
   * authorizes no tree beyond the one it graded, so an unproven accepted tree
   * gets a final evaluation rather than a reuse.
   */
  approvedTreeId?: string;
}

export type FinalReuseDecision = "reuse" | "evaluate";

export interface FinalReuseOutcome {
  decision: FinalReuseDecision;
  /** Why, in one sentence, for the run log and the reuse event. */
  reason: string;
}

/**
 * Compare the final checkpoint tree against the approved baseline.
 *
 * `reuse` requires all three of: a baseline exists, the tree it authorizes
 * (`approvedTreeId` when the caller proved one, otherwise `treeId`) equals the
 * final tree ID as a string, and neither tree ID has been invalidated by a
 * baseline-is-wrong finding (#96 B-09). Anything else evaluates — including
 * an absent baseline, which is the fail-closed reading: no recorded approval
 * is not the same as an approval to reuse.
 *
 * This is the *only* comparison that decides whether a final evaluator is
 * dispatched. There is deliberately no second "did the writing stage write?"
 * test beside it: two comparisons of the same subject can disagree, and the one
 * the contract declares is this one.
 */
export function decideFinalReuse(input: {
  finalTreeId: string;
  baseline: FinalReuseBaseline | null;
  /**
   * Candidate tree IDs a previous final evaluation rejected as
   * baseline-is-wrong. Equality against one of these is not reuse-worthy: the
   * approval it would reuse is the approval the finding disputed.
   */
  invalidatedCandidateTreeIds?: readonly string[];
}): FinalReuseOutcome {
  const invalidated = input.invalidatedCandidateTreeIds ?? [];
  if (input.baseline === null) {
    return {
      decision: "evaluate",
      reason:
        `No approved baseline is recorded for this slice, so the final tree ` +
        `${input.finalTreeId} has nothing to be identical to.`,
    };
  }
  const approvedTreeId = input.baseline.approvedTreeId ?? input.baseline.treeId;
  if (approvedTreeId !== input.finalTreeId) {
    return {
      decision: "evaluate",
      reason:
        `The final tree ${input.finalTreeId} differs from the tree the ` +
        `approved baseline ${input.baseline.treeId} authorizes ` +
        `(${approvedTreeId}).`,
    };
  }
  if (
    invalidated.includes(input.finalTreeId) ||
    invalidated.includes(input.baseline.treeId)
  ) {
    return {
      decision: "evaluate",
      reason:
        `The final tree ${input.finalTreeId} is the tree the approved ` +
        `baseline authorizes, but a final evaluation invalidated that ` +
        `candidate as baseline-is-wrong, so its approval cannot be reused.`,
    };
  }
  return {
    decision: "reuse",
    reason:
      `The final tree ${input.finalTreeId} is the tree the approved ` +
      `baseline ${input.baseline.treeId} authorizes, so the existing ` +
      `approval stands and no final evaluator runs.`,
  };
}

export type FinalReviewVerdict = "PASS" | "FAIL";

/**
 * What kind of problem the final evaluator found, which is what decides where
 * it goes (ADR 0048: a finding names its remedy).
 *
 * - `PRESERVATION` — the post-approval writing stage changed behavior the
 *   approved candidate had. The stage that wrote it restores it.
 * - `GATE_INVISIBLE_DRIFT` — the tree drifted in a way no required gate can
 *   see. Either the writing stage restores it or the generator owns it.
 * - `BASELINE_IS_WRONG` — the approved candidate itself should not merge. The
 *   generator loop takes it back (#96 B-09).
 */
export type FinalReviewFindingClass =
  | "PRESERVATION"
  | "GATE_INVISIBLE_DRIFT"
  | "BASELINE_IS_WRONG";

/**
 * The repair vocabulary. Typed and closed: a repair this module does not
 * recognise is refused at parse time rather than routed somewhere by default.
 */
export type FinalReviewRepair = "RESTORE" | "RETURN_TO_GENERATOR";

export interface FinalReviewFinding {
  id: string;
  class: FinalReviewFindingClass;
  summary: string;
  evidence: string;
  expected: string;
  observed: string;
  repair: FinalReviewRepair;
}

export interface FinalReview {
  version: 1;
  verdict: FinalReviewVerdict;
  /** The approved baseline tree this review compared against. */
  baselineTreeId: string;
  /** The final checkpoint tree it read. */
  finalTreeId: string;
  findings: FinalReviewFinding[];
}

const REVIEW_KEYS = [
  "version",
  "verdict",
  "baselineTreeId",
  "finalTreeId",
  "findings",
] as const;
const FINDING_KEYS = [
  "id",
  "class",
  "summary",
  "evidence",
  "expected",
  "observed",
  "repair",
] as const;
const FINDING_STRING_FIELDS = [
  "id",
  "summary",
  "evidence",
  "expected",
  "observed",
] as const;
const VERDICTS: readonly string[] = ["PASS", "FAIL"];
const FINDING_CLASSES: readonly string[] = [
  "PRESERVATION",
  "GATE_INVISIBLE_DRIFT",
  "BASELINE_IS_WRONG",
];
const REPAIRS: readonly string[] = ["RESTORE", "RETURN_TO_GENERATOR"];

/**
 * Which repairs each class admits.
 *
 * A preservation finding admits `RESTORE` and nothing else: the stage that
 * wrote over preserved behavior is the stage that undoes it, and sending it
 * back to the generator would ask the generator to re-defend work it already
 * got approved. A baseline-is-wrong finding admits only the return, because
 * restoring the baseline is precisely what it says must not happen.
 */
const REPAIRS_BY_CLASS: Readonly<
  Record<FinalReviewFindingClass, readonly FinalReviewRepair[]>
> = {
  PRESERVATION: ["RESTORE"],
  GATE_INVISIBLE_DRIFT: ["RESTORE", "RETURN_TO_GENERATOR"],
  BASELINE_IS_WRONG: ["RETURN_TO_GENERATOR"],
};

function parseFindings(value: unknown, source: string): FinalReviewFinding[] {
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
      typeof finding.class !== "string" ||
      !FINDING_CLASSES.includes(finding.class)
    ) {
      throw new Error(
        `${source} ${field} class must be ${FINDING_CLASSES.join(" or ")}`,
      );
    }
    if (
      typeof finding.repair !== "string" ||
      !REPAIRS.includes(finding.repair)
    ) {
      throw new Error(
        `${source} ${field} repair must be ${REPAIRS.join(" or ")}`,
      );
    }
    const findingClass = finding.class as FinalReviewFindingClass;
    const repair = finding.repair as FinalReviewRepair;
    const admitted = REPAIRS_BY_CLASS[findingClass];
    if (!admitted.includes(repair)) {
      throw new Error(
        `${source} ${field} class ${findingClass} admits only ` +
          `${admitted.join(" or ")}, not ${repair}`,
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
      class: findingClass,
      summary: strings.summary!,
      evidence: strings.evidence!,
      expected: strings.expected!,
      observed: strings.observed!,
      repair,
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
  return findings;
}

/**
 * Canonical validation of `final-review.json`, in the same shape
 * {@link parseQAReview} uses: explicit literal key arrays, a duplicate-key
 * scan the JSON parser silently forgives, and a refusal for anything not
 * understood.
 */
export function parseFinalReview(
  text: string,
  source = FINAL_REVIEW_FILENAME,
): FinalReview {
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
  const baselineTreeId = requireNonBlankString(
    input.baselineTreeId,
    "baselineTreeId",
    source,
  );
  const finalTreeId = requireNonBlankString(
    input.finalTreeId,
    "finalTreeId",
    source,
  );
  const verdict = input.verdict as FinalReviewVerdict;
  const findings = parseFindings(input.findings, source);
  // The verdict and the findings are one statement; a PASS carrying a finding
  // leaves it unsaid which of the two the orchestrator should act on.
  if (verdict === "PASS" && findings.length > 0) {
    throw new Error(`${source} verdict PASS requires an empty findings array`);
  }
  if (verdict === "FAIL" && findings.length === 0) {
    throw new Error(`${source} verdict FAIL requires at least one finding`);
  }
  return { version: 1, verdict, baselineTreeId, finalTreeId, findings };
}

/**
 * A single canonical validation of `final-review.json` whose parsed value the
 * caller can keep.
 *
 * The verdict needs two facts from the same bytes: whether they validate, and
 * the `finalTreeId` they claim. Parsing twice — once for the validation result
 * and once for the tree ID — can hand the verdict a tree ID from a document its
 * own validation result never described (the file can be rewritten between the
 * two reads, and a second read of a missing file throws where the first
 * produced a blocker). So validation returns the review it validated, and
 * `decideFinalVerdict` is given a `finalArtifactTreeId` taken from that value.
 *
 * `null` text means the artifact is absent, which is a validation failure with
 * a named reason rather than a throw: the final verdict fails closed on it.
 */
export type FinalReviewValidation =
  | { ok: true; review: FinalReview }
  | { ok: false; error: string };

export function validateFinalReview(
  text: string | null,
  source = FINAL_REVIEW_FILENAME,
): FinalReviewValidation {
  if (text === null) {
    return { ok: false, error: `${source} was not written` };
  }
  try {
    return { ok: true, review: parseFinalReview(text, source) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Where one finding goes.
 *
 * `writing-stage` names the single post-approval writing stage by its id.
 * `generator-loop` carries the candidate tree ID to invalidate and states
 * both budgets explicitly: D19 spends exactly one *generator* round on a
 * return and never a final-evaluation attempt.
 */
export type FinalReviewRoute =
  | { target: "writing-stage"; stageId: string; repair: "RESTORE" }
  | {
      target: "generator-loop";
      invalidateCandidateTreeId: string;
      generatorRoundsConsumed: 1;
      finalEvaluationAttemptsConsumed: 0;
    };

export function routeFinalReviewFinding(
  finding: FinalReviewFinding,
  context: { candidateTreeId: string },
): FinalReviewRoute {
  if (finding.repair === "RESTORE") {
    return {
      target: "writing-stage",
      stageId: POST_APPROVAL_WRITING_STAGE_ID,
      repair: "RESTORE",
    };
  }
  return {
    target: "generator-loop",
    invalidateCandidateTreeId: context.candidateTreeId,
    generatorRoundsConsumed: 1,
    finalEvaluationAttemptsConsumed: 0,
  };
}

/** One required gate's outcome, as the final verdict needs to read it. */
export interface FinalVerdictGate {
  gateId: string;
  required: boolean;
  status: string;
}

export interface FinalVerdictOutcome {
  verdict: FinalReviewVerdict;
  /** Every condition that was not met, named. Empty exactly when PASS. */
  blockers: string[];
}

/**
 * The final verdict (#96 B-11).
 *
 * `PASS` requires every one of: all required gates green, the candidate and
 * final artifacts keyed to their exact checkpoint tree IDs, canonical
 * validation of `final-review.json` succeeding, and a green scope gate on the
 * final candidate. Each condition is checked independently and each failure
 * is named, because a verdict that says only "failed" sends the next round
 * looking for the reason this function already knows.
 *
 * Anything unknown fails closed: a `null` artifact key, an absent scope gate
 * status, and an unparsed review are all blockers, not defaults.
 */
export function decideFinalVerdict(input: {
  gates: readonly FinalVerdictGate[];
  candidateTreeId: string;
  finalTreeId: string;
  /** The tree ID the candidate artifacts are keyed to, `null` when unknown. */
  candidateArtifactTreeId: string | null;
  /** The tree ID the final artifacts are keyed to, `null` when unknown. */
  finalArtifactTreeId: string | null;
  /** Result of {@link parseFinalReview} on the artifact's bytes. */
  reviewValidation: { ok: true } | { ok: false; error: string };
  /** The scope gate's status on the final candidate, `null` when it did not run. */
  scopeGateStatus: string | null;
}): FinalVerdictOutcome {
  const blockers: string[] = [];
  const required = input.gates.filter((gate) => gate.required);
  if (required.length === 0) {
    blockers.push(
      "no required gate outcomes were supplied, so no gate can be called green",
    );
  }
  for (const gate of required) {
    if (gate.status !== "PASS") {
      blockers.push(`required gate ${gate.gateId} is ${gate.status}, not PASS`);
    }
  }
  if (input.candidateArtifactTreeId !== input.candidateTreeId) {
    blockers.push(
      `the candidate artifacts are keyed to ` +
        `${input.candidateArtifactTreeId ?? "no tree"} rather than the ` +
        `candidate tree ${input.candidateTreeId}`,
    );
  }
  if (input.finalArtifactTreeId !== input.finalTreeId) {
    blockers.push(
      `the final artifacts are keyed to ` +
        `${input.finalArtifactTreeId ?? "no tree"} rather than the final tree ` +
        `${input.finalTreeId}`,
    );
  }
  if (!input.reviewValidation.ok) {
    blockers.push(
      `${FINAL_REVIEW_FILENAME} did not validate: ${input.reviewValidation.error}`,
    );
  }
  if (input.scopeGateStatus !== "PASS") {
    blockers.push(
      `the scope gate on the final candidate is ` +
        `${input.scopeGateStatus ?? "absent"}, not PASS`,
    );
  }
  return {
    verdict: blockers.length === 0 ? "PASS" : "FAIL",
    blockers,
  };
}

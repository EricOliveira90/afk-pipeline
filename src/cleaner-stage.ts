/**
 * The cleaner stage: bounded post-approval rounds that make the project's
 * declared *clean* gates green without changing what the approved tree does
 * (#87, PRD D2/D4).
 *
 * One module with one orchestrator call site, the way every other new behavior
 * in this repository lands (`ARCHITECTURE.md`, "Hubs"). What lives here is the
 * round loop and its exit paths; what does not live here is anything the
 * orchestrator already owns — the dispatch, the gate declarations that need run
 * policy, the journal, the archives and the run state all arrive as seams, so
 * the loop is callable directly against a fixture worktree and every one of its
 * decisions is observable without spawning a pipeline.
 *
 * Three properties are worth reading before the code, because each is a defect
 * this shape exists to refuse:
 *
 * - **Every round that wrote is reset on the way out, not only the regressing
 *   one** (ADR 0051: restoring on the success path only was the original
 *   defect). Each exit path below has exactly one reset target and records
 *   exactly one outcome, so no discarded checkpoint is afterwards gated.
 * - **The loop's continuation is a comparison against
 *   {@link cleanerRoundsRemaining}, never an incremented counter** (ADR 0050 /
 *   ADR 0041: choose the branch that cannot loop). A resumed run reads its
 *   spent rounds out of `RunState`, so the bound holds across processes.
 * - **The orchestrator gates the checkpoint; the cleaner does not verify
 *   itself** (ADR 0038). That is why `prompts/cleaner.md` carries no
 *   `{{TEST_COMMAND}}`: the verification command belongs to the role that
 *   iterates on it, and this role does not.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { runCandidateGatePhase } from "./candidate-gate-phase.js";
import { cleanerRoundsRemaining, MAX_CLEANER_ROUNDS } from "./bounds.js";
import {
  findDuplicateJsonKey,
  requireExactKeys,
  requireNonBlankString,
} from "./contract-review.js";
import { CLEANER_ESCALATION_ARTIFACT_NAME } from "./escalation.js";
import { feedbackIntegrityGateDeclaration } from "./feedback-integrity-gate.js";
import type { FinalReviewFinding } from "./final-evaluation.js";
import { CHANGED_FILES_TOKEN } from "./gate-policy.js";
import type {
  GatePolicy,
  GatePolicyClean,
  GatePolicyCleanGate,
} from "./gate-policy.js";
import {
  createCandidateCheckpoint,
  resolveCandidateTreeId,
  type GateDeclaration,
  type GateResult,
  type GateStatus,
} from "./gate-runner.js";
import { commitAll, diffTreePaths, hasUncommittedChanges } from "./git.js";
import type { LaneResourceOptions } from "./lanes.js";
import { scopeGateDeclaration } from "./scope-gate.js";
import { skipGateDeclaration } from "./skip-gate.js";
import { suppressionGateDeclaration } from "./suppression-gate.js";

/**
 * The cleaner's escalation artifact, in the slice directory (#87 B-13).
 *
 * `src/escalation.ts` re-declares this literal privately for its own
 * `"declared-only"` carve-out — a classifier must not import the stage it
 * classifies for — and `src/escalation.test.ts` pins the two together.
 */
export const CLEANER_ESCALATION_FILENAME = CLEANER_ESCALATION_ARTIFACT_NAME;

/** The gate stage every declared clean gate reports under (PRD D1). */
export const CLEAN_GATE_STAGE = "clean";

/** The detail a clean gate records when `{changedFiles}` expanded to nothing. */
export const NO_CHANGED_FILES_DETAIL = "no changed files";

/** How the whole stage ended. Persisted as `PersistedQualityStage.outcome`. */
export type CleanerStageOutcome =
  /** No `gatePolicy.clean`, so the stage does not exist for this run. */
  | "DISABLED"
  /** Every required clean gate released the tree — at round 0 or later. */
  | "PASS"
  /** The rounds ran out with a required clean gate still red. */
  | "EXHAUSTED"
  /** A round raised a valid `BASELINE_IS_WRONG` escalation. */
  | "ESCALATED";

/** How one round ended. Persisted as `PersistedQualityStageRound.outcome`. */
export type CleanerRoundOutcome =
  | "PASS"
  | "FAIL"
  | "REVERTED"
  | "EXHAUSTED"
  | "ESCALATED"
  | "ESCALATION_MALFORMED";

/** One gate this stage is still waiting on, named the way ADR 0048 requires. */
export interface CleanerGateFailure {
  gateId: string;
  status: GateStatus;
  detail: string;
  /** The gate log, repo-relative, so the prompt and `stuck.md` can cite it. */
  logArtifactId: string;
  /** Whether the declaration that produced it was required. */
  required: boolean;
}

/** One recorded round, in the shape `recordQualityStageRound` persists. */
export interface CleanerRoundRecord {
  round: number;
  attempt: number;
  inputTreeId: string;
  outputTreeId?: string;
  gateIds: readonly string[];
  outcome: CleanerRoundOutcome;
}

/** The `BASELINE_IS_WRONG` escalation a round may raise (#87 B-13). */
export interface CleanerEscalation {
  version: 1;
  class: "BASELINE_IS_WRONG";
  id: string;
  summary: string;
  evidence: string;
  expected: string;
  observed: string;
}

export interface CleanerStageResult {
  /** False only for a run with no `gatePolicy.clean` (P-01). */
  ran: boolean;
  outcome: CleanerStageOutcome;
  /**
   * The tree *this dispatch* started from: the accepted tree on the stage's
   * first run, and the cleaner's own newest committed tree on a restore
   * re-dispatch (#97 B-03), which is what the worktree carried when the restore
   * was asked for. The orchestrator keeps the accepted tree as the stage's
   * standing input across dispatches, so "did the cleaner write?" stays a
   * question about the whole range rather than about the last round.
   */
  inputTreeId: string;
  /**
   * The tree the stage leaves behind. Equal to {@link inputTreeId} whenever no
   * round's checkpoint survived — a disabled stage, a round-0 pass, an
   * escalation, and an exhaustion whose last round was reverted.
   */
  outputTreeId: string;
  roundsSpent: number;
  /**
   * Every round, in order, for the caller's journal. Absent — not an empty
   * array — when no round ran, so a stage that spent nothing returns exactly the
   * five fields that describe it and nothing a reader has to interpret.
   */
  rounds?: readonly CleanerRoundRecord[];
  /** Gates still red when the stage ended (`EXHAUSTED`), with their logs. */
  remainingFailures?: readonly CleanerGateFailure[];
  /** The parsed escalation (`ESCALATED`). */
  escalation?: CleanerEscalation;
  /** The archived escalation, repo-relative, for `artifactReferences`. */
  escalationArtifactId?: string;
}

/** What one round hands the dispatch seam; the caller renders the prompt. */
export interface CleanerDispatchInput {
  round: number;
  roundLimit: number;
  inputTreeId: string;
  baselineTreeId: string;
  /** The clean gates this round has to clear, with their logs. */
  qualityFailures: readonly CleanerGateFailure[];
  /**
   * The previous round's reverted regression, or `""` when the previous round
   * did not regress. Rendered as `{{REGRESSION_NOTE}}` (#87 B-07).
   */
  regressionNote: string;
  /**
   * The restore this dispatch is, when it is one (#97 B-05).
   *
   * Present exactly when the final evaluation routed a `RESTORE` at this stage:
   * the round's job is then to put the named preserved behaviors back, not to
   * clear a red clean gate — which is why `qualityFailures` is empty on a repair
   * round and why the prompt substitution takes the restore form.
   */
  repair?: { findings: readonly FinalReviewFinding[] };
}

/**
 * One cleaner round as the ROI evidence stream needs to read it (#97 B-07).
 *
 * A separate seam from {@link CleanerStageContext.recordRound}, because that
 * record is persisted verbatim by `recordQualityStageRound` and cannot carry
 * timing or cache facts without changing the persisted shape. The stage
 * measures — it does not decide anything on these numbers (ADR 0063).
 */
export interface CleanerRoundAttempt {
  /** The cleaner round: `0` for a round-0 release, `1..limit` otherwise. */
  round: number;
  inputTreeId: string;
  /** Absent when no checkpoint of this round survived to be named. */
  outputTreeId?: string;
  gateIds: readonly string[];
  /** The gates this round did not re-run, from their own results' `cacheReused`. */
  cacheReusedGateIds: readonly string[];
  outcome: string;
  /** ISO 8601, the round's wall clock — the dispatch *and* its gates. */
  startedAt: string;
  endedAt: string;
  durationMs: number;
}

export interface CleanerStageContext {
  repoRoot: string;
  /** The slice worktree, at the accepted commit. Rounds dispatch here. */
  worktreeDir: string;
  ghIssue: string;
  sliceNumber: string;
  /** Repo-relative slice artifact directory (never `""`, #87 B-11 / P-10). */
  relSliceDir: string;
  absSliceDir: string;
  /** The feature branch the regression gates measure this tree against. */
  featureRef: string;
  /** Dispatch the cleaner and return when it has finished writing. */
  dispatch: (input: CleanerDispatchInput) => Promise<void>;
  /**
   * Archive one round's artifacts (#87 B-09), returning the archived
   * escalation's repo-relative path when the round wrote one. Optional: a
   * caller that archives nothing still runs and gates rounds.
   */
  archiveRound?: (input: {
    round: number;
    hasEscalation: boolean;
  }) => { escalationArtifactId?: string } | void;
  /** Persist one round the moment it ends (#87 B-14), as `persistAttempts` does. */
  recordRound?: (record: CleanerRoundRecord) => void;
  /** Persist the stage's outcome (#87 B-14). */
  recordOutcome?: (outcome: CleanerStageOutcome, rounds: number) => void;
  /**
   * One round's measured attempt, the moment it ends (#97 B-07). Optional: a
   * caller that measures nothing still runs and gates rounds.
   */
  observeRoundAttempt?: (attempt: CleanerRoundAttempt) => void;
  /** Rounds already spent for this issue, read from `RunState` on resume. */
  roundsAlreadySpent?: number;
  log?: (message: string, level?: "error") => void;
  signal?: AbortSignal;
}

/**
 * Everything `runCandidateGatePhase` needs except what one round computes:
 * the tree, the working directory, the declarations and the label. The same
 * split `src/merge-resolution.ts` uses, and for the same reason — the
 * orchestrator already builds these, and a second copy could disagree.
 */
export type CleanerGatePhaseInput = Omit<
  Parameters<typeof runCandidateGatePhase>[0],
  "treeId" | "cwd" | "declarations" | "label"
>;

export interface CleanerStageInput {
  /** `gatePolicy.clean`, or `undefined` for a run that declares none (P-01). */
  clean?: GatePolicyClean;
  /** The accepted tree the stage gates first (round 0). */
  acceptedTreeId: string;
  /** The run's gate-policy snapshot, never a read of the candidate worktree. */
  runPolicy: GatePolicy | null;
  /** `gatePolicy.cost.skipDetectors`, resolved by `resolveTestCostPlan`. */
  skipDetectors: Parameters<typeof skipGateDeclaration>[0]["detectors"];
  /** `gatePolicy.protectedPaths.testGlobs`, resolved the same way. */
  testFileGlobs: readonly string[];
  /** The launch manifest's waivers, and only those. */
  waivers: Parameters<typeof skipGateDeclaration>[0]["waivers"];
  /**
   * The orchestrator's proven accepted-pair integrity verdict, forwarded to the
   * round's `feedback-integrity` gate. Required rather than defaulted, because a
   * default is a caller-side literal wearing a different hat.
   */
  acceptedPairIntact: boolean;
  /**
   * The regression bundle the approval rested on, in the order the
   * orchestrator built it: `resolvePreQAGateDeclarations` +
   * `acceptance:behaviors` + `resolveFullSuiteGateDeclarations` (#87 B-06).
   * Assembled by the caller, because only it can resolve an acceptance plan
   * against a manifest.
   */
  regressionDeclarations: readonly GateDeclaration[];
  gatePhase: CleanerGatePhaseInput;
  /** Dependency install for the materialized checkpoint, as `runGates` needs. */
  prepare?: GateDeclaration;
  options?: LaneResourceOptions;
  /** Where a round's checkpoint worktree is materialized. */
  checkpointDirFor: (round: number) => string;
  /** Cleanup for that directory; the orchestrator warns rather than throws. */
  disposeCheckpoint?: (checkpointWorktreeDir: string) => Promise<void> | void;
  /** Overrides `MAX_CLEANER_ROUNDS`, for tests and for nothing else. */
  roundLimit?: number;
  /**
   * The restore this whole stage run is, when the final evaluation routed one
   * back here (#97 B-03/B-05).
   *
   * Its presence changes one thing about the loop: round 0 is skipped. On a
   * re-dispatch the worktree already carries the cleaner's own committed tree,
   * which cleared the clean gates when it was made — so round 0 would release
   * it again, return `PASS` with zero dispatches, and the restore would never
   * be asked for. The round's gates still run, so a restore that regresses the
   * approval is reverted exactly as any other round is.
   */
  repair?: { findings: readonly FinalReviewFinding[] };
}

/**
 * `git reset --hard <commit>` plus the untracked sweep, exported for the one
 * caller that has to undo a whole cleaner range rather than one round (#97
 * B-04): the orchestrator, when a restore is routed here with no round left to
 * spend. Exported from this module rather than added to `src/git.ts` because
 * resetting a cleaner range is this stage's concern and nobody else's.
 */
export function resetCleanerRangeTo(cwd: string, commit: string): void {
  resetHardTo(cwd, commit);
}

/**
 * The `{{QUALITY_FAILURES}}` substitution, in both of its forms (#97 B-05).
 *
 * Pure, and here rather than at the call site, so the two forms are one
 * decision: a normal round lists the red clean gates with their logs, a repair
 * round lists the preserved behaviors the final evaluator found missing and
 * says what to do about them. No new placeholder, because `renderPrompt` is
 * strict in both directions — an extra template variable would be a second
 * thing to keep in sync for no gain.
 */
export function renderCleanerQualityFailures(input: {
  qualityFailures: readonly CleanerGateFailure[];
  repair?: { findings: readonly FinalReviewFinding[] };
}): string {
  if (input.repair) {
    return [
      `This round is a **restore**, not a clean-up. The final evaluation`,
      `found that this stage's own commits dropped behavior the approved`,
      `candidate had. Put each of the following back, changing nothing else,`,
      `and do not undo the clean-gate work that is still green:`,
      "",
      ...input.repair.findings.map(
        (finding) =>
          `- \`${finding.id}\` (${finding.class}): ${finding.summary}\n` +
          `  Expected: ${finding.expected}\n` +
          `  Observed: ${finding.observed}`,
      ),
    ].join("\n");
  }
  return input.qualityFailures
    .map(
      (failure) =>
        `- \`${failure.gateId}\` (${failure.status}): ${failure.detail}\n` +
        `  Log: \`${failure.logArtifactId}\``,
    )
    .join("\n");
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

/** `git reset --hard <commit>` plus the untracked sweep a revert has to make. */
function resetHardTo(cwd: string, commit: string): void {
  git(cwd, ["reset", "--hard", commit]);
  git(cwd, ["clean", "-fd"]);
}

/**
 * The declarations for the round's clean gates, with `{changedFiles}` expanded
 * at declaration time (#87 B-02).
 *
 * An entry equal to the token expands to one repo-relative forward-slash
 * argument per changed path, mirroring `{behaviorId}`; an entry that merely
 * contains it is left alone, because a half-substituted argument is a lie about
 * its own extent. An empty expansion makes the gate `SKIPPED` rather than
 * `PASS`: a gate that read nothing has not released the tree, and PRD D4's
 * 2026-09-12 ruling is that such a `SKIPPED` releases it exactly as a `PASS`
 * does — which is a decision for the caller of this function, not a verdict to
 * fake here.
 */
export function cleanGateDeclarations(input: {
  gates: readonly GatePolicyCleanGate[];
  changedFiles: readonly string[];
}): GateDeclaration[] {
  return input.gates.map((gate) => {
    const usesToken = gate.args.some((arg) => arg === CHANGED_FILES_TOKEN);
    if (usesToken && input.changedFiles.length === 0) {
      return {
        id: gate.id,
        stage: CLEAN_GATE_STAGE,
        required: gate.required,
        expectedCostMs: gate.expectedCostMs,
        run: () => ({
          status: "SKIPPED" as const,
          failureKind: null,
          detail: NO_CHANGED_FILES_DETAIL,
        }),
      };
    }
    return {
      id: gate.id,
      stage: CLEAN_GATE_STAGE,
      required: gate.required,
      expectedCostMs: gate.expectedCostMs,
      command: gate.command,
      args: gate.args.flatMap((arg) =>
        arg === CHANGED_FILES_TOKEN ? [...input.changedFiles] : [arg],
      ),
    };
  });
}

/**
 * The paths a tree changed against the feature base, repo-relative with
 * forward slashes — the expansion `{changedFiles}` gets.
 */
export function changedFilesForExpansion(input: {
  cwd: string;
  featureRef: string;
  treeIsh?: string;
}): string[] {
  const from = git(input.cwd, ["rev-parse", `${input.featureRef}^{tree}`]);
  const to = git(input.cwd, [
    "rev-parse",
    `${input.treeIsh ?? "HEAD"}^{tree}`,
  ]);
  return diffTreePaths(input.cwd, from, to);
}

/**
 * Parse `cleaner-escalation.json` (#87 B-13). Pure, and strict in the
 * `FinalReviewFinding` vocabulary: an unknown key, the wrong class, a blank
 * field or a duplicate key is a malformed escalation and never a lenient read,
 * because the one thing this document does is send a slice back through the
 * generator loop.
 */
export function parseCleanerEscalation(
  value: string | unknown,
  source = CLEANER_ESCALATION_FILENAME,
): CleanerEscalation {
  const raw =
    typeof value === "string"
      ? (() => {
          const duplicate = findDuplicateJsonKey(value);
          if (duplicate) {
            throw new Error(
              `${source} declares the key "${duplicate}" twice`,
            );
          }
          try {
            return JSON.parse(value) as unknown;
          } catch (error) {
            throw new Error(
              `${source} is not valid JSON: ` +
                `${error instanceof Error ? error.message : String(error)}`,
            );
          }
        })()
      : value;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${source} must be a JSON object`);
  }
  const record = raw as Record<string, unknown>;
  requireExactKeys(
    record,
    ["version", "class", "id", "summary", "evidence", "expected", "observed"],
    "the escalation",
    source,
  );
  if (record.version !== 1) {
    throw new Error(`${source} must declare "version": 1`);
  }
  if (record.class !== "BASELINE_IS_WRONG") {
    throw new Error(
      `${source} must declare "class": "BASELINE_IS_WRONG" — the cleaner ` +
        `raises no other class (#87 B-13)`,
    );
  }
  return {
    version: 1,
    class: "BASELINE_IS_WRONG",
    id: requireNonBlankString(record.id, "id", source),
    summary: requireNonBlankString(record.summary, "summary", source),
    evidence: requireNonBlankString(record.evidence, "evidence", source),
    expected: requireNonBlankString(record.expected, "expected", source),
    observed: requireNonBlankString(record.observed, "observed", source),
  };
}

/** The failures a gate run leaves behind, restricted to one declaration set. */
function failuresIn(
  results: readonly GateResult[],
  declarations: readonly GateDeclaration[],
  evidenceDir: string,
  repoRoot: string,
): CleanerGateFailure[] {
  const failures: CleanerGateFailure[] = [];
  for (const declaration of declarations) {
    const result = results.find((entry) => entry.gateId === declaration.id);
    if (!result) continue;
    // A `SKIPPED` releases the tree exactly as a `PASS` does (PRD D4): a clean
    // gate with nothing to read has nothing to complain about.
    if (result.status === "PASS" || result.status === "SKIPPED") continue;
    failures.push({
      gateId: result.gateId,
      status: result.status,
      detail: result.detail ?? "(the gate recorded no detail)",
      logArtifactId: relative(
        repoRoot,
        join(evidenceDir, result.logArtifactId),
      ).replace(/\\/g, "/"),
      required: declaration.required,
    });
  }
  return failures;
}

/**
 * The gates a phase did not re-run, by id (#97 B-07).
 *
 * `cacheReused` is present only when true (`GateResult`), so this is a filter
 * and never a comparison against `false`.
 */
function cacheReusedIn(results: readonly GateResult[]): string[] {
  return results
    .filter((result) => result.cacheReused === true)
    .map((result) => result.gateId);
}

/**
 * Hand one measured round to the caller, stamping the clock here so a round's
 * end is the moment the stage finished with it rather than the moment the
 * caller got around to reading it.
 */
function observeAttempt(
  ctx: CleanerStageContext,
  attempt: Omit<CleanerRoundAttempt, "startedAt" | "endedAt" | "durationMs"> & {
    startedAt: number;
  },
): void {
  if (!ctx.observeRoundAttempt) return;
  const endedAt = Date.now();
  const { startedAt, ...rest } = attempt;
  ctx.observeRoundAttempt({
    ...rest,
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    durationMs: endedAt - startedAt,
  });
}

/**
 * Run the cleaner stage for one approved candidate.
 *
 * `round` is the generator round the approval happened in: it stamps the
 * round's archives and journal entries, exactly as the final evaluator's
 * `round` does. The cleaner's own round number is the `1..limit` counter this
 * function owns.
 */
export async function runCleanerStage(
  ctx: CleanerStageContext,
  round: number,
  input: CleanerStageInput,
): Promise<CleanerStageResult> {
  const log = ctx.log ?? (() => {});
  const acceptedTreeId = input.acceptedTreeId;
  const disabled: CleanerStageResult = {
    ran: false,
    outcome: "DISABLED",
    inputTreeId: acceptedTreeId,
    outputTreeId: acceptedTreeId,
    roundsSpent: 0,
  };
  if (!input.clean) return disabled;

  const limit = input.roundLimit ?? MAX_CLEANER_ROUNDS;
  const clean = input.clean;
  const rounds: CleanerRoundRecord[] = [];
  // The commit this stage run starts from: the reset target for a valid
  // escalation, and its first round's input checkpoint (#87 B-07). On the
  // stage's first dispatch it is the commit the accepted tree sits on; on a
  // restore re-dispatch (#97 B-03) it is the cleaner's own newest commit,
  // because that is what the worktree carries and what the restore round is
  // being asked to repair.
  const startCommit = git(ctx.worktreeDir, ["rev-parse", "HEAD"]);
  /**
   * The tree this stage run was actually handed (#97 B-07, QA-04).
   *
   * `input.acceptedTreeId` is the *baseline* — the tree the approval was given
   * on — and on the stage's first dispatch the two are the same. A restore
   * re-dispatch is handed the tree the cleaner's earlier rounds committed, so
   * reporting the accepted tree as the round's input would break the per-round
   * tree chain on the stream: the round would claim to have read a tree no
   * round of it ever saw, and `inputTreeId === outputTreeId` — the event's own
   * "this attempt changed nothing" reading — would stop meaning that.
   *
   * Hashed with the same `resolveCandidateTreeId` every other tree id in the
   * pipeline comes from — tracked plus untracked — so this names what the round
   * genuinely reads and no second hashing can disagree with the first. On a
   * restore that is the graded tree, because the caller clears the attempt's own
   * loose review artifacts before re-dispatching; if it ever stops doing so the
   * chain visibly breaks here rather than quietly gating the evaluator's bytes
   * as the cleaner's work.
   */
  const startTreeId = input.repair
    ? resolveCandidateTreeId(ctx.worktreeDir)
    : acceptedTreeId;

  const runGatePhase = async (
    declarations: readonly GateDeclaration[],
    treeId: string,
    cwd: string,
    label: string,
  ) =>
    runCandidateGatePhase({
      ...input.gatePhase,
      treeId,
      cwd,
      declarations,
      label,
    });

  const cleanDeclarationsFor = (treeIsh?: string) =>
    cleanGateDeclarations({
      gates: clean.gates,
      changedFiles: changedFilesForExpansion({
        cwd: ctx.worktreeDir,
        featureRef: ctx.featureRef,
        ...(treeIsh ? { treeIsh } : {}),
      }),
    });

  /**
   * Round 0: the accepted tree, the clean gates and nothing else (#87 B-04).
   * Zero invocations when they release it, which is the case this stage is
   * cheap in — the common one, for a project whose gates were already green.
   *
   * Skipped entirely for a repair run (#97 B-03): see
   * {@link CleanerStageInput.repair}. A restore has no red gate to read, so it
   * enters the loop with no failures rather than with a verdict that would end
   * the stage before the round it exists to spend.
   */
  let failures: CleanerGateFailure[] = [];
  let blocking: CleanerGateFailure[] = [];
  if (!input.repair) {
    const round0Declarations = cleanDeclarationsFor();
    const round0StartedAt = Date.now();
    const round0 = await runGatePhase(
      round0Declarations,
      acceptedTreeId,
      ctx.worktreeDir,
      "cleaner round 0",
    );
    failures = failuresIn(
      round0.evidence.results,
      round0Declarations,
      input.gatePhase.evidenceDir,
      ctx.repoRoot,
    );
    blocking = failures.filter((failure) => failure.required);
    if (blocking.length === 0) {
      log(
        `cleaner: every required clean gate released the accepted tree ` +
          `${acceptedTreeId} — no round was spent`,
      );
      // The cheapest possible stage is still measured (#97 B-07): input and
      // output are the same tree, because nothing wrote.
      observeAttempt(ctx, {
        round: 0,
        inputTreeId: acceptedTreeId,
        outputTreeId: acceptedTreeId,
        gateIds: round0Declarations.map((declaration) => declaration.id),
        cacheReusedGateIds: cacheReusedIn(round0.evidence.results),
        outcome: "PASS",
        startedAt: round0StartedAt,
      });
      ctx.recordOutcome?.("PASS", 0);
      return {
        ran: true,
        outcome: "PASS",
        inputTreeId: acceptedTreeId,
        outputTreeId: acceptedTreeId,
        roundsSpent: 0,
      };
    }
  }

  let spent = ctx.roundsAlreadySpent ?? 0;
  let inputCommit = startCommit;
  let inputTreeId = startTreeId;
  let outputTreeId = startTreeId;
  let regressionNote = "";

  const finish = (
    outcome: CleanerStageOutcome,
    extra: Partial<CleanerStageResult> = {},
  ): CleanerStageResult => {
    ctx.recordOutcome?.(outcome, spent);
    return {
      ran: true,
      outcome,
      // The tree *this run* was handed, not the baseline: on a restore
      // re-dispatch they differ, and the caller composes the stage's standing
      // input/output pair from the first dispatch's input and this output.
      inputTreeId: startTreeId,
      outputTreeId,
      roundsSpent: spent,
      ...(rounds.length > 0 ? { rounds } : {}),
      ...(blocking.length > 0 ? { remainingFailures: blocking } : {}),
      ...extra,
    };
  };

  const recordRound = (record: CleanerRoundRecord) => {
    rounds.push(record);
    ctx.recordRound?.(record);
  };

  // The continuation is the remainder, not a counter (#87 B-05, ADR 0050).
  while (cleanerRoundsRemaining({ spent, limit }) > 0) {
    const roundNumber = spent + 1;
    const roundStartedAt = Date.now();
    const dispatchInput: CleanerDispatchInput = {
      round: roundNumber,
      roundLimit: limit,
      inputTreeId,
      baselineTreeId: acceptedTreeId,
      qualityFailures: failures,
      regressionNote,
      ...(input.repair ? { repair: input.repair } : {}),
    };
    log(
      `cleaner round ${roundNumber}/${limit} on ${inputTreeId}: ` +
        (input.repair
          ? `restoring ${input.repair.findings
              .map((finding) => finding.id)
              .join(", ")}`
          : blocking.map((failure) => failure.gateId).join(", ")),
    );
    let dispatchFailure: string | null = null;
    try {
      await ctx.dispatch(dispatchInput);
    } catch (error) {
      dispatchFailure = error instanceof Error ? error.message : String(error);
    }
    if (dispatchFailure !== null || ctx.signal?.aborted) {
      // Exit path 2: a dispatch that died spends its round (#87 B-05), and the
      // round's writes go back — a half-finished round is not a candidate.
      resetHardTo(ctx.worktreeDir, inputCommit);
      spent++;
      recordRound({
        round: roundNumber,
        attempt: round,
        inputTreeId,
        gateIds: [],
        outcome: "FAIL",
      });
      observeAttempt(ctx, {
        round: roundNumber,
        inputTreeId,
        gateIds: [],
        cacheReusedGateIds: [],
        outcome: "FAIL",
        startedAt: roundStartedAt,
      });
      log(
        `cleaner round ${roundNumber} failed and was reset to ${inputCommit}: ` +
          `${dispatchFailure ?? "cancelled"}`,
        "error",
      );
      if (ctx.signal?.aborted) break;
      regressionNote = "";
      continue;
    }

    const escalationPath = join(
      ctx.absSliceDir,
      CLEANER_ESCALATION_FILENAME,
    );
    if (existsSync(escalationPath)) {
      let escalation: CleanerEscalation | null = null;
      let malformed = "";
      try {
        escalation = parseCleanerEscalation(
          readFileSync(escalationPath, "utf-8"),
        );
      } catch (error) {
        malformed = error instanceof Error ? error.message : String(error);
      }
      const archived = ctx.archiveRound?.({
        round: roundNumber,
        hasEscalation: true,
      });
      if (escalation === null) {
        // Exit path 3: the round's checkpoint is discarded by this reset and is
        // therefore never gated, so `ESCALATION_MALFORMED` is the round's whole
        // outcome (#87 B-07, B-13).
        resetHardTo(ctx.worktreeDir, inputCommit);
        spent++;
        recordRound({
          round: roundNumber,
          attempt: round,
          inputTreeId,
          gateIds: [],
          outcome: "ESCALATION_MALFORMED",
        });
        observeAttempt(ctx, {
          round: roundNumber,
          inputTreeId,
          gateIds: [],
          cacheReusedGateIds: [],
          outcome: "ESCALATION_MALFORMED",
          startedAt: roundStartedAt,
        });
        log(
          `cleaner round ${roundNumber} wrote a malformed escalation and was ` +
            `reset to ${inputCommit}: ${malformed}`,
          "error",
        );
        regressionNote = "";
        continue;
      }
      // Exit path 4: the one documented exception to the input-checkpoint
      // target. An escalation invalidates the accepted tree's baseline
      // citation, so every cleaner commit this stage run made goes — not just
      // this round's (#87 B-07, B-13). On a restore re-dispatch that is every
      // commit the restore made; the earlier rounds' range is the
      // orchestrator's to undo, and it owns the one reset that can
      // (`resetCleanerRangeTo`, #97 B-04).
      resetHardTo(ctx.worktreeDir, startCommit);
      spent++;
      outputTreeId = startTreeId;
      recordRound({
        round: roundNumber,
        attempt: round,
        inputTreeId,
        gateIds: [],
        outcome: "ESCALATED",
      });
      observeAttempt(ctx, {
        round: roundNumber,
        inputTreeId,
        gateIds: [],
        cacheReusedGateIds: [],
        outcome: "ESCALATED",
        startedAt: roundStartedAt,
      });
      log(
        `cleaner round ${roundNumber} escalated ${escalation.id} and reset ` +
          `the worktree to ${startTreeId}`,
        "error",
      );
      return finish("ESCALATED", {
        escalation,
        ...(archived && archived.escalationArtifactId
          ? { escalationArtifactId: archived.escalationArtifactId }
          : {}),
      });
    }
    ctx.archiveRound?.({ round: roundNumber, hasEscalation: false });

    // The sweep, then the checkpoint: the gate has to be about a committed
    // tree, and `{changedFiles}` is expanded from that same `HEAD` (#87 B-02).
    if (hasUncommittedChanges(ctx.worktreeDir)) {
      commitAll(
        ctx.worktreeDir,
        `chore(#${ctx.ghIssue}): cleaner round ${roundNumber}`,
      );
    }
    const checkpointDir = input.checkpointDirFor(roundNumber);
    const checkpoint = createCandidateCheckpoint(
      ctx.worktreeDir,
      checkpointDir,
    );
    const roundDeclarations: GateDeclaration[] = [
      ...cleanDeclarationsFor(),
      scopeGateDeclaration({
        source: {
          kind: "role",
          cwd: ctx.worktreeDir,
          inputCheckpointTree: inputTreeId,
          outputCheckpointTree: checkpoint.treeId,
        },
        absSliceDir: ctx.absSliceDir,
        sliceArtifactDir: ctx.relSliceDir,
        // Nothing between a round's two checkpoints may legitimately rewrite
        // the accepted pair, so a cleaner that touched it is named through the
        // existing unwaivable carve-out (#87 B-11).
        acceptedPairIntact: false,
        artifactDirPolicy: "declared-only",
        additionalWriteScope: clean.additionalWriteScope,
        ...(input.options ? { options: input.options } : {}),
      }),
      feedbackIntegrityGateDeclaration({
        worktreeDir: ctx.worktreeDir,
        featureRef: ctx.featureRef,
        waivers: input.waivers ?? [],
        runPolicy: input.runPolicy,
        // The orchestrator's *proven* verdict, threaded — never a literal, for
        // the reason `src/merge-resolution.ts` was made to thread it too. Here a
        // literal `false` would fail this gate closed and unwaivably on every
        // round, so no clean-up could ever be released; a literal `true` would
        // assert an integrity check this stage never ran. The scope gate above
        // takes `false` because it is answering a different question — whether
        // the pair's own paths are exempt from the round's write scope, which
        // they are not.
        acceptedPairIntact: input.acceptedPairIntact,
      }),
      skipGateDeclaration({
        worktreeDir: ctx.worktreeDir,
        featureRef: ctx.featureRef,
        detectors: input.skipDetectors,
        testFileGlobs: input.testFileGlobs,
        ...(input.waivers ? { waivers: input.waivers } : {}),
      }),
      suppressionGateDeclaration({
        cwd: ctx.worktreeDir,
        inputCheckpointTree: inputTreeId,
        outputCheckpointTree: checkpoint.treeId,
        detectors: clean.suppressionDetectors,
      }),
      ...input.regressionDeclarations,
    ];
    let phase;
    try {
      phase = await runGatePhase(
        roundDeclarations,
        checkpoint.treeId,
        checkpoint.worktreeDir ?? checkpointDir,
        `cleaner round ${roundNumber}`,
      );
    } finally {
      if (checkpoint.worktreeDir) {
        await input.disposeCheckpoint?.(checkpoint.worktreeDir);
      }
    }
    spent++;
    const gateIds = roundDeclarations.map((declaration) => declaration.id);
    const cleanIds = new Set(clean.gates.map((gate) => gate.id));
    const roundFailures = failuresIn(
      phase.evidence.results,
      roundDeclarations,
      input.gatePhase.evidenceDir,
      ctx.repoRoot,
    );
    const regressions = roundFailures.filter(
      (failure) => failure.required && !cleanIds.has(failure.gateId),
    );
    if (regressions.length > 0) {
      // Exit path 1: a required gate outside the clean set went red, so the
      // round is reverted and nothing re-baselines (#87 B-07).
      resetHardTo(ctx.worktreeDir, inputCommit);
      recordRound({
        round: roundNumber,
        attempt: round,
        inputTreeId,
        outputTreeId: checkpoint.treeId,
        gateIds,
        outcome: "REVERTED",
      });
      observeAttempt(ctx, {
        round: roundNumber,
        inputTreeId,
        outputTreeId: checkpoint.treeId,
        gateIds,
        cacheReusedGateIds: cacheReusedIn(phase.evidence.results),
        outcome: "REVERTED",
        startedAt: roundStartedAt,
      });
      regressionNote =
        `Round ${roundNumber} was reverted with \`git reset --hard\`: it ` +
        `reddened ${regressions.length} required gate(s) the approval rested ` +
        `on. ${regressions
          .map(
            (failure) =>
              `${failure.gateId} (${failure.status}): ${failure.detail} ` +
              `[log: ${failure.logArtifactId}]`,
          )
          .join(" ")} Your edit is gone; the tree is back at ${inputTreeId}. ` +
        `Clear the clean gate without touching what those gates check.`;
      log(
        `cleaner round ${roundNumber} regressed ` +
          `${regressions.map((failure) => failure.gateId).join(", ")} and was ` +
          `reset to ${inputCommit}`,
        "error",
      );
      continue;
    }

    // The regression bundle is green, so the checkpoint stands whatever the
    // clean gates say — the next round runs from it (#87 B-08).
    failures = roundFailures.filter((failure) => cleanIds.has(failure.gateId));
    blocking = failures.filter((failure) => failure.required);
    inputCommit = checkpoint.commitSha;
    inputTreeId = checkpoint.treeId;
    outputTreeId = checkpoint.treeId;
    regressionNote = "";
    if (blocking.length === 0) {
      recordRound({
        round: roundNumber,
        attempt: round,
        inputTreeId: dispatchInput.inputTreeId,
        outputTreeId: checkpoint.treeId,
        gateIds,
        outcome: "PASS",
      });
      observeAttempt(ctx, {
        round: roundNumber,
        inputTreeId: dispatchInput.inputTreeId,
        outputTreeId: checkpoint.treeId,
        gateIds,
        cacheReusedGateIds: cacheReusedIn(phase.evidence.results),
        outcome: "PASS",
        startedAt: roundStartedAt,
      });
      log(
        `cleaner round ${roundNumber} passed: ${checkpoint.treeId} releases ` +
          `every required clean gate`,
      );
      return finish("PASS");
    }
    const exhausted = cleanerRoundsRemaining({ spent, limit }) === 0;
    recordRound({
      round: roundNumber,
      attempt: round,
      inputTreeId: dispatchInput.inputTreeId,
      outputTreeId: checkpoint.treeId,
      gateIds,
      outcome: exhausted ? "EXHAUSTED" : "FAIL",
    });
    observeAttempt(ctx, {
      round: roundNumber,
      inputTreeId: dispatchInput.inputTreeId,
      outputTreeId: checkpoint.treeId,
      gateIds,
      cacheReusedGateIds: cacheReusedIn(phase.evidence.results),
      outcome: exhausted ? "EXHAUSTED" : "FAIL",
      startedAt: roundStartedAt,
    });
    log(
      `cleaner round ${roundNumber} left ` +
        `${blocking.map((failure) => failure.gateId).join(", ")} red`,
      "error",
    );
  }

  log(
    `cleaner: ${spent} round(s) spent and ` +
      `${blocking.map((failure) => failure.gateId).join(", ")} still red`,
    "error",
  );
  return finish("EXHAUSTED");
}

/**
 * The `stuck.md` reason for an exhausted stage (#87 B-08): every remaining red
 * gate with its detail and its log artifact id, because that list is the whole
 * diagnosis an operator gets.
 */
export function cleanerExhaustionReason(input: {
  ghIssue: string;
  roundsSpent: number;
  failures: readonly CleanerGateFailure[];
  treeId: string;
}): string {
  return (
    `The cleaner stage for slice #${input.ghIssue} spent all ` +
    `${input.roundsSpent} round(s) with required clean gate(s) still red on ` +
    `${input.treeId}: ` +
    `${input.failures
      .map(
        (failure) =>
          `${failure.gateId} (${failure.status}): ${failure.detail} ` +
          `[log: ${failure.logArtifactId}]`,
      )
      .join(" ")} The last checkpoint is preserved.`
  );
}

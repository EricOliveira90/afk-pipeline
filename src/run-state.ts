import {
  readFileSync,
  readdirSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import {
  ALL_PHASES,
  traitsFor,
  type SliceAdoption,
  type SliceLifecycle,
  type SlicePhase,
} from "./slice-lifecycle.js";
import type {
  PersistedRunScope,
  PersistedScopeSlice,
} from "./slice-scope.js";
import { withFileLock } from "./file-lock.js";
import {
  sanitizeGuardianReviewFields,
  type PersistedFiledFinding,
  type PersistedGuardianReviewRound,
  type PersistedReviewResult,
} from "./guardian-round-records.js";

/** Phases that get persisted. RUNNING / PENDING never touch disk. */
export type PersistedPhase = Exclude<SlicePhase, "RUNNING" | "PENDING">;

const PERSISTED_PHASES = new Set<string>(
  ALL_PHASES.filter((phase) => traitsFor(phase).persisted),
);

export interface PersistedSliceState {
  phase: PersistedPhase;
  branch?: string;
  /** Only meaningful when `phase === "PASS"`. */
  mergedToFeature?: boolean;
  /** Free-text reason for failure phases; useful for postmortem after load. */
  error?: string;
  /**
   * Only meaningful when `phase === "MERGE-PENDING"`: the numeric
   * migration prefixes that refused the merge. Persisted so the next
   * run's merge-only recovery can report them without re-deriving
   * anything (ADR 0029).
   */
  collidingPrefixes?: string[];
  /** Audit trail for a slice completed outside the pipeline and adopted. */
  adoption?: SliceAdoption;
}

/**
 * The schema version every writer emits. v4 carries two independent additions,
 * both keyed by GitHub issue and both optional: the per-slice approved baseline
 * locator below (#91) and `appliedWaivers` (#193). v5 adds a third of the same
 * shape, `finalEvaluations` (#96 B-02/B-09). v6 adds a fourth, `qualityStages`
 * (#87 B-14). v7 adds a fifth, `recoveryLineage` (#277 B-10): the append-only
 * preserved-work recovery attempt events, keyed by GitHub issue — additive for
 * the same reason the four before it were, and absent on every file written
 * before a recovery attempt was ever admitted.
 * `adaptLoadedState` normalizes a v3, v4, v5 or v6 file to it in memory,
 * so a resumed run reads one shape, and `writeRunState` stamps it on every write
 * so a stale caller literal can never reach disk.
 *
 * The v7 bump is unconditional for the same reason: "no recovery attempt was
 * admitted" and "this file predates recovery lineage" are the same fact to every
 * reader, so a run that never renegotiates a stale pair still persists `7` with
 * no `recoveryLineage` member (#277 B-10, P-03).
 *
 * The v6 bump is unconditional: a run that declares no `gatePolicy.clean`
 * persists version `6` with no `qualityStages` member, because "no stage ran"
 * and "this file predates quality stages" are the same fact to every reader and
 * a version conditional on a policy member is a version two runs disagree about
 * (#87 P-01).
 *
 * Exported because it is the one number a reader has to compare against, and a
 * duplicated literal is how two modules disagree about what "current" means.
 */
export const RUN_STATE_VERSION = 7;

/**
 * Where one slice's approved baseline artifact is, and which candidate it
 * describes (#91 AC5, PRD D10).
 *
 * A locator, not an authority: `approved-baseline.json` itself is canonical,
 * because D20 compares the final tree against that file. This record exists
 * so a resumed run can *find* it without re-deriving the checkpoint, and
 * nothing has two authorities for the same fact.
 */
export interface PersistedApprovedBaseline {
  /** Candidate checkpoint tree object ID — not a commit. */
  treeId: string;
  /** Candidate checkpoint commit. */
  commit: string;
  /** Repo-relative path of the canonical `approved-baseline.json`. */
  artifactPath: string;
}

/**
 * What one slice's final evaluation decided, and what it invalidated (#96
 * B-02/B-09).
 *
 * A marker and a memory, not an authority. The `decision` is the fact that a
 * final evaluator either ran or did not: `reuse` is one of the three places
 * (with the `final-evaluation-reuse` run event and the slice's own
 * `run-summary.md` section) that record a zero-invocation final stage, and it
 * is deliberately *not* a `GateEvidence` field — D17's gate-cache `reused` flag
 * answers a different question about a different subject and the two must not
 * be read as one.
 *
 * `baselineTreeId`/`baselineArtifactPath` are a citation of the baseline this
 * evaluation compared against. A baseline-is-wrong finding drops that citation
 * and appends the rejected tree to `invalidatedCandidateTreeIds`; it never
 * rewrites or deletes the `approved-baseline.json` artifact itself, which
 * remains the only record of what was once approved (#96 P-03).
 */
/**
 * One final-evaluation attempt, keyed to the tree it graded (#96 B-09/B-10).
 *
 * The entries are per attempt rather than a count because the two questions a
 * reader has are different questions: "how many attempts are left" is answered
 * by counting `GRADED` entries, while "which attempt looked at the tree a
 * finding later rejected" needs the tree ID the attempt read. A count can only
 * answer the first, which is why the invalidation of a baseline used to be
 * invisible at the attempt level.
 *
 * `RETURNED_TO_GENERATOR` entries exist and spend nothing: D19 charges a return
 * to the generator budget, so the entry records that the attempt happened
 * without letting it count against {@link MAX_FINAL_EVALUATION_ATTEMPTS}.
 */
export interface PersistedFinalEvaluationAttempt {
  /** 1-based attempt number within the slice's final evaluation. */
  attempt: number;
  /** The candidate tree this attempt graded (D10: artifacts keyed by tree). */
  candidateTreeId: string;
  verdict: "PASS" | "FAIL";
  outcome: "GRADED" | "RETURNED_TO_GENERATOR";
}

export interface PersistedFinalEvaluation {
  decision: "reuse" | "evaluate";
  /** Final checkpoint tree object ID the decision was made about. */
  finalTreeId: string;
  /** The baseline tree cited, absent once a finding invalidated it. */
  baselineTreeId?: string;
  /** Repo-relative path of the cited `approved-baseline.json`, dropped with it. */
  baselineArtifactPath?: string;
  /**
   * Per-attempt entries, in attempt order. Attempts spent against
   * {@link MAX_FINAL_EVALUATION_ATTEMPTS} are the `GRADED` ones —
   * {@link finalEvaluationAttemptsSpent} is the one reader of that rule.
   */
  attempts: PersistedFinalEvaluationAttempt[];
  /**
   * Candidate trees a baseline-is-wrong finding rejected. `decideFinalReuse`
   * refuses `reuse` against one of these even on exact tree equality.
   */
  invalidatedCandidateTreeIds: string[];
}

/**
 * An attempt entry with the invalidation of its tree resolved (#96 B-09).
 *
 * Derived on read rather than stored: `invalidatedCandidateTreeIds` is the one
 * authority for which trees a finding rejected, and a second stored copy per
 * attempt could disagree with it.
 */
export interface FinalEvaluationAttemptView
  extends PersistedFinalEvaluationAttempt {
  /** True when this attempt graded a tree a later finding invalidated. */
  invalidated: boolean;
}

export interface FinalEvaluationView
  extends Omit<PersistedFinalEvaluation, "attempts"> {
  attempts: FinalEvaluationAttemptView[];
}

/**
 * How many final-evaluation attempts a slice has spent, for
 * {@link finalEvaluationAttemptsRemaining}. A return to the generator is not a
 * spent attempt (D19), so only `GRADED` entries count.
 */
export function finalEvaluationAttemptsSpent(
  record:
    | { attempts: readonly Pick<PersistedFinalEvaluationAttempt, "outcome">[] }
    | undefined,
): number {
  return (record?.attempts ?? []).filter(
    (entry) => entry.outcome === "GRADED",
  ).length;
}

/**
 * One post-approval quality-stage round as persisted (#87 B-14).
 *
 * Per round rather than a count, for the same reason
 * {@link PersistedFinalEvaluationAttempt} is per attempt: "how many rounds are
 * left" and "which tree did the round that reverted read" are different
 * questions, and a count answers only the first. `outputTreeId` is absent for a
 * round that produced no gated checkpoint — a failed dispatch, or a malformed
 * escalation whose checkpoint was discarded before any gate ran.
 */
export interface PersistedQualityStageRound {
  /** 1-based round number within the stage. */
  round: number;
  /** The generator round the approval this stage cleans happened in. */
  attempt: number;
  /** The tree the round started from: the accepted tree, or a prior round's. */
  inputTreeId: string;
  /** The checkpoint the round produced, when one was gated. */
  outputTreeId?: string;
  /** Every gate id the round ran, in declaration order. */
  gateIds: string[];
  outcome:
    | "PASS"
    | "FAIL"
    | "REVERTED"
    | "EXHAUSTED"
    | "ESCALATED"
    | "ESCALATION_MALFORMED";
}

/**
 * One run of one post-approval quality stage for one slice (#87 B-14).
 *
 * A list per issue rather than a single record: a `BASELINE_IS_WRONG`
 * escalation sends the slice back through the generator, and the next approval
 * appends a **fresh** entry. Tree ids are content-addressed and a generator can
 * answer an escalation without changing tracked content, so a single record
 * keyed by tree would charge the escalating round to the re-approved
 * candidate's budget whenever the two trees are identical (#87 B-13).
 */
export interface PersistedQualityStage {
  stage: "cleaner";
  /** Whether the stage's policy member was declared for this run. */
  enabled: boolean;
  rounds: PersistedQualityStageRound[];
  outcome: "DISABLED" | "PASS" | "EXHAUSTED" | "ESCALATED";
}

/**
 * How many cleaner rounds one stage entry spent, for
 * `cleanerRoundsRemaining` (#87 B-14).
 *
 * Counts recorded rounds with `round >= 1` — every recorded round is a spent
 * one, including a reverted and a malformed-escalation round, which is what
 * stops a resumed run from buying a fourth.
 */
export function cleanerRoundsSpent(
  record:
    | { rounds: readonly Pick<PersistedQualityStageRound, "round">[] }
    | undefined,
): number {
  return (record?.rounds ?? []).filter((entry) => entry.round >= 1).length;
}

/**
 * The four states one preserved-work recovery attempt can be in (#277 B-10/B-11).
 *
 * Declared here rather than in `src/preserve-work-recovery.ts` because this is
 * the persisted shape and run state is what persists it; the *transition* rule
 * over these states is the recovery module's, so the two never disagree about
 * which direction is legal by owning the same fact twice.
 */
export type RecoveryLineageState =
  | "PENDING"
  | "COMPLETED"
  | "ROLLED_BACK"
  | "ROLLBACK_FAILED";

/**
 * One recovery-attempt lineage event as persisted (#277 B-09/B-10).
 *
 * Append-only per event rather than a mutable per-target summary, for the reason
 * {@link PersistedQualityStageRound} is per round: "is an attempt open" and
 * "what did the attempt that opened claim about the tree" are different
 * questions, and a summary field can only answer the first. Every terminal event
 * is a *new* record citing the same `attemptId`; nothing edits or deletes an
 * earlier one, so a retry is always a fresh attempt ID (#277 B-11).
 *
 * Every member is a fact the admitting process verified under the run-state lock
 * immediately before the append, so a later reconciliation can tell "the tree is
 * still what was admitted" from "something moved underneath it" without
 * re-deriving anything.
 */
export interface PersistedRecoveryLineageEvent {
  /** Opaque per-attempt identity; a retry never reuses one. */
  attemptId: string;
  state: RecoveryLineageState;
  /** The canonical `{number, ghIssue}` pair the request resolved to. */
  target: { number: string; ghIssue: string };
  /** The operator's `--recovery-reason`, trimmed and otherwise verbatim. */
  reason: string;
  /**
   * Scope identities this attempt admitted into the run's scope of record
   * (`--extend-scope`, #278 B-04), canonical and duplicate-free.
   *
   * Full `{number, ghIssue}` pairs rather than the bare selector strings #277
   * reserved, for the reason {@link target} carries a pair: a digits-only
   * selector is ambiguous between a slice number and a GH issue id, so a
   * persisted selector would leave a later reader re-resolving an identity
   * against an `issues.md` that may have moved. Widened without a
   * {@link RUN_STATE_VERSION} bump and with no migration, on the
   * {@link rollbackError} precedent: every writer that could have produced a v7
   * file before #278 emitted the literal `[]`, which is a valid pair array, so
   * no document on disk needs rewriting. Empty stays the "this attempt admitted
   * no extensions" reading it always was — never "this record predates
   * extensions".
   */
  extensions: PersistedScopeSlice[];
  /** Provider name from the caller's run identity; run state persists no other. */
  provider: string;
  sliceBranch: string;
  /** Slice-branch tip at admission. */
  sliceHead: string;
  /** Feature-branch tip at admission. */
  featureHead: string;
  /** SHA-256 of the canonical scope encoding (#277 B-04). */
  scopeFingerprint: string;
  /** Repo-relative directory holding the byte-verified accepted-pair snapshot. */
  snapshotPath: string;
  /** SHA-256 of the original `contract.md` bytes. */
  contractFingerprint: string;
  /** SHA-256 of the original `acceptance-manifest.json` bytes. */
  manifestFingerprint: string;
  /** ISO-8601 instant the event was appended. */
  recordedAt: string;
  /**
   * Why a rollback did not prove out — the failure message the restore-and-verify
   * routine reported, verbatim (#333 B-06).
   *
   * One of three fields that exist only on a `ROLLBACK_FAILED` event, and are
   * *required* there: {@link sanitizeRecoveryLineage} demands all three non-blank
   * when `state` is `ROLLBACK_FAILED` and demands all three absent on every other
   * state. Optional in the type and purely additive on disk, with no
   * {@link RUN_STATE_VERSION} bump, on the {@link RunState.specsDir} precedent: a
   * v7 file written before #333 simply has none of them and adapts in memory
   * unchanged. The per-state rule is what keeps those older events round-tripping
   * through a gate that otherwise requires every member.
   */
  rollbackError?: string;
  /**
   * The `contract.md` fingerprint actually observed in the slice directory when
   * the rollback failed — {@link RECOVERY_FINGERPRINT_ABSENT} when the file could
   * not be read at all (#333 B-06).
   *
   * Recorded beside the original {@link contractFingerprint} rather than instead
   * of it: "what should be there" and "what is there" are the two halves of the
   * hold a human has to resolve, and one field can only carry one of them.
   */
  observedContractFingerprint?: string;
  /** The `acceptance-manifest.json` half of {@link observedContractFingerprint}. */
  observedManifestFingerprint?: string;
  /**
   * SHA-256 of the renegotiated `contract.md` the completed attempt accepted in
   * place of the original {@link contractFingerprint} (#335 B-12).
   *
   * One of three fields that exist only on a `COMPLETED` event, and are
   * *required* there, under the same per-state rule and for the same reason the
   * three rollback-failure members carry theirs: {@link sanitizeRecoveryLineage}
   * demands all three non-blank when `state` is `COMPLETED` and demands all
   * three absent on every other state. Recorded beside the original fingerprints
   * rather than instead of them, because "what the attempt started from" and
   * "what it ended on" are the two facts a later dispatch has to compare to tell
   * an untouched replacement from a drifted one (#335 B-04).
   */
  replacementContractFingerprint?: string;
  /** The `acceptance-manifest.json` half of {@link replacementContractFingerprint}. */
  replacementManifestFingerprint?: string;
  /**
   * The lock exit's provenance stamp for the completion, verbatim (#335 B-12).
   *
   * One opaque non-blank string: run state neither formats nor parses it, so the
   * stamp's owner stays free to change its wording without a schema change here.
   * Persisted because ADR 0055 §4 asks every lock exit to stamp, and a completion
   * that appends the terminal event of a renegotiation is one.
   */
  lockProvenance?: string;
}

/**
 * The value an observed-fingerprint field carries when there were no bytes to
 * fingerprint (#333 B-06).
 *
 * An explicit marker rather than a blank or an omitted field, because both of
 * those read as "nobody looked" while this says "somebody looked and the file was
 * not readable" — which is the difference between a rollback that never ran and
 * one that ran and found the pair gone. Declared here, beside the persisted shape
 * that carries it, for the reason {@link RecoveryLineageState} is.
 */
export const RECOVERY_FINGERPRINT_ABSENT = "absent";

/** The three members {@link PersistedRecoveryLineageEvent} carries only on `ROLLBACK_FAILED`. */
const ROLLBACK_FAILURE_FIELDS = [
  "rollbackError",
  "observedContractFingerprint",
  "observedManifestFingerprint",
] as const;

/** The three members {@link PersistedRecoveryLineageEvent} carries only on `COMPLETED` (#335 B-12). */
const COMPLETION_FIELDS = [
  "replacementContractFingerprint",
  "replacementManifestFingerprint",
  "lockProvenance",
] as const;

export interface RunState {
  /**
   * Schema version. Writers emit {@link RUN_STATE_VERSION} and
   * `adaptLoadedState` returns it for every accepted file; the literals `3`,
   * `4`, `5` and `6` stay assignable so callers and fixtures holding an older
   * record keep compiling, and nothing reads a `3`, `4`, `5` or `6` back out of
   * a loaded state.
   */
  version: 3 | 4 | 5 | 6 | 7;
  prdSlug: string;
  featureBranch: string;
  /**
   * Repo-relative specs directory this run was launched against (e.g.
   * `.kiro/specs/<prd-slug>`), recorded so a later command can *resolve*
   * where a slice's artifacts live instead of searching for them.
   *
   * `--prd-dir` is arbitrary, so the estate probe used to guess with a
   * depth-bounded walk and reported "no estate" for any layout deeper than
   * the default — after which `clean-failed` deleted the worktree and
   * `adopt` overwrote the park (architect blocker 2, fifth adjudication gate
   * round). The run is the one party that knows this without guessing, so it
   * writes it down. Optional because state files predating the field must
   * stay loadable: `probeAdjudicationEstate` falls back to a complete walk,
   * which is slower but still never infers absence.
   */
  specsDir?: string;
  /** Immutable executable slice identities resolved at the first run. */
  scope?: PersistedRunScope;
  slices: Record<string, PersistedSliceState>;
  /** Cached post-merge review-phase results for cheap re-entry (ADR 0015). */
  reviewPhase?: PersistedReviewPhase;
  /**
   * Per-slice resume-attempt counters + last retry decision (spec #33 /
   * #36). Kept beside `slices` rather than inside `PersistedSliceState`
   * because a slice that died mid-generator may have NO slice record at
   * all (RUNNING is never persisted, ADR 0018) yet still needs its
   * resume counted on the next retry. Absent entries read as zero, so
   * state files that predate the field stay loadable unchanged.
   */
  resume?: Record<string, SliceResumeState>;
  /**
   * Per-slice exact-stage checkpoints. The focused checkpoint module owns
   * the value schema and validation; run-state preserves the raw value so a
   * malformed checkpoint can fail closed with an honest reason instead of
   * being silently dropped during load.
   */
  stageCheckpoints?: unknown;
  /**
   * Per-slice compact contract finding lineage. The convergence module owns
   * this raw schema and policy; run-state only preserves it beside, but
   * independently from, exact-stage checkpoints.
   */
  contractConvergence?: unknown;
  /**
   * Per-slice compact candidate-QA finding lineage. The QA convergence
   * module owns this raw schema and the one progress-qualified extension.
   */
  qaConvergence?: unknown;
  /**
   * Compact provider-independent observations used to stop repeated,
   * oscillating, or regressing semantic work before another dispatch.
   * The focused non-progress module owns validation and policy.
   */
  nonProgress?: unknown;
  /** Manifest-owned pool and issue-owned allocations, persisted across retries. */
  migrations?: MigrationClaimState;
  /**
   * Per-slice approved-baseline locators, keyed by GitHub issue — one of v4's
   * two additions (#91). Absent entries read as "no baseline recorded", so a v3
   * file loads unchanged.
   */
  approvedBaselines?: Record<string, PersistedApprovedBaseline>;
  /**
   * Protected-change waivers a gate actually applied, keyed by GH issue — v4's
   * other addition (#193). Kept beside `slices` rather than inside
   * `PersistedSliceState` for the same reason `resume` is: a RUNNING slice has
   * no persisted record at all (ADR 0018), and the waiver is written at gate
   * time, mid-slice. Absent entries read as none, so state files predating the
   * field stay loadable.
   */
  appliedWaivers?: Record<string, PersistedAppliedWaiver[]>;
  /**
   * Per-slice final-evaluation records, keyed by GitHub issue — v5's single
   * addition (#96). Absent entries read as "no final evaluation happened", so a
   * v3 or v4 file loads unchanged.
   */
  finalEvaluations?: Record<string, PersistedFinalEvaluation>;
  /**
   * Per-slice post-approval quality-stage runs, keyed by GitHub issue — v6's
   * single addition (#87). Absent entries read as "no stage ran", so a v3, v4 or
   * v5 file loads unchanged.
   */
  qualityStages?: Record<string, PersistedQualityStage[]>;
  /**
   * Per-slice preserved-work recovery lineage, keyed by GitHub issue — v7's
   * single addition (#277 B-10). Absent entries read as "no recovery attempt was
   * ever admitted", so a v3-through-v6 file loads unchanged.
   *
   * Read with {@link recoveryLineageFor} and written with
   * {@link appendRecoveryLineageEvent}; there is deliberately no whole-map
   * setter, because an event that reached disk outside a locked recheck would be
   * an admission nothing verified.
   */
  recoveryLineage?: Record<string, PersistedRecoveryLineageEvent[]>;
}

/**
 * One applied waiver as persisted — D5's four fields, so a resumed run can see
 * which authorizations were already spent without re-reading gate evidence.
 */
export interface PersistedAppliedWaiver {
  riskClass: string;
  path: string;
  author: string;
  reason: string;
}

export interface MigrationClaimState {
  pool: string[];
  claims: Record<string, string[]>;
}

/** Resume bookkeeping for one slice — see `RunState.resume`. */
export interface SliceResumeState {
  /** Resumes so far on the current tree. Reset to 0 on restart-from-base. */
  attempts: number;
  /** Human-readable last retry decision, for post-run audits. */
  lastDecision?: string;
}

/**
 * Pre-ship sanity gate result cached by the reviewed tree's SHA. Only
 * passing results are cached: a FAIL could be an environment flake, and
 * fixing a real failure changes the tree anyway.
 */
export interface PersistedSanityResult {
  treeSha: string;
  ok: true;
}

export interface PersistedReviewPhase {
  sanity?: PersistedSanityResult;
  architect?: PersistedReviewResult;
  pm?: PersistedReviewResult;
  rounds?: PersistedGuardianReviewRound[];
  filedFindings?: PersistedFiledFinding[];
}

/**
 * Validate a loaded `reviewPhase`, dropping malformed or unfavorable
 * cache entries independently from the all-or-nothing guardian ledger.
 *
 * The pre-ship sanity cache is the one entry this hub still owns. Every
 * guardian field beside it — the two verdict caches, the round ledger, the
 * filed-issue memory — is normalized by the guardian round persistence module,
 * which owns what a round record is allowed to claim (#221). Key order follows
 * the on-disk order, so a file re-written after a load keeps the byte layout it
 * was read with.
 */
export function sanitizeReviewPhase(value: unknown): PersistedReviewPhase | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as { sanity?: unknown };
  const sanity = (v.sanity ?? {}) as { treeSha?: unknown; ok?: unknown };
  const out: PersistedReviewPhase = {
    ...(typeof sanity.treeSha === "string" &&
    sanity.treeSha.length > 0 &&
    sanity.ok === true
      ? { sanity: { treeSha: sanity.treeSha, ok: true as const } }
      : {}),
    ...sanitizeGuardianReviewFields(value),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Validate a loaded `resume` map, dropping malformed entries instead of
 * throwing — bad bookkeeping must degrade to "zero attempts", never
 * block resumption.
 */
export function sanitizeResumeMap(
  value: unknown,
): Record<string, SliceResumeState> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const out: Record<string, SliceResumeState> = {};
  for (const [id, entry] of Object.entries(value as Record<string, unknown>)) {
    const e = (entry ?? {}) as { attempts?: unknown; lastDecision?: unknown };
    if (typeof e.attempts !== "number" || !Number.isSafeInteger(e.attempts) || e.attempts < 0) {
      continue;
    }
    out[id] = {
      attempts: e.attempts,
      ...(typeof e.lastDecision === "string" ? { lastDecision: e.lastDecision } : {}),
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Structural half of migration-claim validation: the pool is a
 * duplicate-free string array and claims map issue keys to string
 * arrays. Shared by load-time sanitising below and by
 * `validateClaimState` in migration-claims.ts, which layers
 * pool-membership and single-owner checks on top.
 */
export function assertMigrationClaimShape(value: {
  pool?: unknown;
  claims?: unknown;
}): asserts value is MigrationClaimState {
  if (
    !Array.isArray(value.pool) ||
    value.pool.some((prefix) => typeof prefix !== "string") ||
    new Set(value.pool).size !== value.pool.length
  ) {
    throw new Error("Run state contains an invalid migration prefix pool");
  }
  if (
    typeof value.claims !== "object" ||
    value.claims === null ||
    Array.isArray(value.claims)
  ) {
    throw new Error("Run state contains invalid migration claims");
  }
  for (const [issue, prefixes] of Object.entries(value.claims)) {
    if (
      !Array.isArray(prefixes) ||
      prefixes.some((prefix) => typeof prefix !== "string")
    ) {
      throw new Error(`Run state contains invalid migration claims for #${issue}`);
    }
  }
}

function sanitizeMigrationClaims(value: unknown): MigrationClaimState | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null) {
    throw new Error("Run state contains invalid migration claims");
  }
  const input = value as { pool?: unknown; claims?: unknown };
  assertMigrationClaimShape(input);
  const claims: Record<string, string[]> = {};
  for (const [issue, prefixes] of Object.entries(input.claims)) {
    claims[issue] = [...prefixes];
  }
  return { pool: [...input.pool], claims };
}

/**
 * Keep only well-formed applied-waiver records (#193). A malformed entry
 * degrades to absent rather than throwing, for the same reason
 * `prefixesOf` does: this record is an audit note the summary reads, and a
 * broken field must not wedge a re-run of the pipeline that wrote it.
 */
function sanitizeAppliedWaivers(
  value: unknown,
): Record<string, PersistedAppliedWaiver[]> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const out: Record<string, PersistedAppliedWaiver[]> = {};
  for (const [issue, entries] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (!Array.isArray(entries)) continue;
    const kept = entries.filter((entry): entry is PersistedAppliedWaiver => {
      if (typeof entry !== "object" || entry === null) return false;
      const record = entry as Record<string, unknown>;
      return (["riskClass", "path", "author", "reason"] as const).every(
        (field) =>
          typeof record[field] === "string" &&
          (record[field] as string).trim() !== "",
      );
    });
    if (kept.length > 0) out[issue] = kept.map((entry) => ({ ...entry }));
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function statePath(repoRoot: string, prdSlug: string): string {
  return join(repoRoot, ".afk", "state", `${prdSlug}.json`);
}

export function withRunStateLock<T>(
  repoRoot: string,
  prdSlug: string,
  action: () => T,
): T {
  return withFileLock(statePath(repoRoot, prdSlug), action);
}

function writeRunState(path: string, state: RunState): void {
  // The version on disk is the writer's schema, not whatever literal the
  // caller's in-memory object happened to carry: a v3 literal written back
  // beside a v4 field would describe a file that does not exist.
  writeFileSync(
    path,
    JSON.stringify(
      { ...state, version: RUN_STATE_VERSION },
      null,
      2,
    ),
  );
}

/**
 * The shared read-modify-write transaction for run state.
 *
 * Every caller loads, compares or mutates, and commits while holding the
 * same per-file cross-process lock. `changed: false` supports conditional
 * operations without rewriting bytes after a refused comparison.
 */
export function transactRunState<T>(
  repoRoot: string,
  prdSlug: string,
  transaction: (state: RunState) => { changed: boolean; result: T },
): T {
  const p = statePath(repoRoot, prdSlug);
  return withRunStateLock(repoRoot, prdSlug, () => {
    const state = loadRunState(repoRoot, prdSlug);
    const outcome = transaction(state);
    if (outcome.changed) writeRunState(p, state);
    return outcome.result;
  });
}

export function updateRunState<T>(
  repoRoot: string,
  prdSlug: string,
  update: (state: RunState) => T,
): T {
  return transactRunState(repoRoot, prdSlug, (state) => ({
    changed: true,
    result: update(state),
  }));
}

/**
 * Every run-state key with a file on disk.
 *
 * The key is a *run slug*, not a PRD slug: `pipelineRunSlug` appends the
 * provider name for every non-kiro provider, so one PRD can have several.
 * Callers that only know the PRD slug (`afk adopt`) need to discover which
 * ones exist rather than assume the bare name. Sorted for a stable
 * refusal message.
 */
export function listRunStateSlugs(repoRoot: string): string[] {
  const dir = join(repoRoot, ".afk", "state");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .sort();
}

/**
 * Keep only well-formed baseline locators. A malformed entry degrades to
 * absent rather than throwing: the artifact file is canonical, so a broken
 * locator costs a re-derivation, never the run.
 */
function sanitizeApprovedBaselines(
  value: unknown,
): Record<string, PersistedApprovedBaseline> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const out: Record<string, PersistedApprovedBaseline> = {};
  for (const [ghIssue, raw] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (typeof raw !== "object" || raw === null) continue;
    const record = raw as Partial<
      Record<keyof PersistedApprovedBaseline, unknown>
    >;
    const nonblank = (field: unknown): field is string =>
      typeof field === "string" && field.trim() !== "";
    if (
      !nonblank(record.treeId) ||
      !nonblank(record.commit) ||
      !nonblank(record.artifactPath)
    ) {
      continue;
    }
    out[ghIssue] = {
      treeId: record.treeId,
      commit: record.commit,
      artifactPath: record.artifactPath,
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The recorded baseline locator for one slice, or `undefined`. */
export function approvedBaselineFor(
  state: RunState,
  ghIssue: string,
): PersistedApprovedBaseline | undefined {
  return state.approvedBaselines?.[ghIssue];
}

/**
 * Record where one slice's approved baseline artifact is. Called by the
 * orchestrator on a deterministic PASS, immediately after the artifact is
 * written, so the locator never points at a file that does not exist.
 */
export function recordApprovedBaseline(
  repoRoot: string,
  prdSlug: string,
  ghIssue: string,
  record: PersistedApprovedBaseline,
): void {
  updateRunState(repoRoot, prdSlug, (state) => {
    state.version = RUN_STATE_VERSION;
    state.approvedBaselines = {
      ...(state.approvedBaselines ?? {}),
      [ghIssue]: record,
    };
  });
}

/**
 * Keep only well-formed final-evaluation records, in the same style as
 * {@link sanitizeApprovedBaselines}: a malformed entry degrades to absent
 * rather than throwing. The archived attempts and the `approved-baseline.json`
 * artifact are canonical, so a broken record costs a re-derivation, never the
 * run.
 */
function sanitizeFinalEvaluations(
  value: unknown,
): Record<string, PersistedFinalEvaluation> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const out: Record<string, PersistedFinalEvaluation> = {};
  for (const [ghIssue, raw] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (typeof raw !== "object" || raw === null) continue;
    const record = raw as Partial<
      Record<keyof PersistedFinalEvaluation, unknown>
    >;
    const nonblank = (field: unknown): field is string =>
      typeof field === "string" && field.trim() !== "";
    if (record.decision !== "reuse" && record.decision !== "evaluate") continue;
    if (!nonblank(record.finalTreeId)) continue;
    if (!Array.isArray(record.attempts)) continue;
    const attempts = record.attempts.filter(
      (entry): entry is PersistedFinalEvaluationAttempt =>
        typeof entry === "object" &&
        entry !== null &&
        Number.isSafeInteger((entry as PersistedFinalEvaluationAttempt).attempt) &&
        (entry as PersistedFinalEvaluationAttempt).attempt > 0 &&
        nonblank((entry as PersistedFinalEvaluationAttempt).candidateTreeId) &&
        ((entry as PersistedFinalEvaluationAttempt).verdict === "PASS" ||
          (entry as PersistedFinalEvaluationAttempt).verdict === "FAIL") &&
        ((entry as PersistedFinalEvaluationAttempt).outcome === "GRADED" ||
          (entry as PersistedFinalEvaluationAttempt).outcome ===
            "RETURNED_TO_GENERATOR"),
    );
    // A dropped attempt entry would understate the spent budget and buy a free
    // extra dispatch, so a malformed entry degrades the whole record to absent
    // rather than only itself.
    if (attempts.length !== record.attempts.length) continue;
    if (!Array.isArray(record.invalidatedCandidateTreeIds)) continue;
    const invalidated = record.invalidatedCandidateTreeIds.filter(nonblank);
    // The citation travels as a pair or not at all: half a citation names a
    // baseline nobody can open, which is worse than naming none.
    const cited =
      nonblank(record.baselineTreeId) && nonblank(record.baselineArtifactPath);
    out[ghIssue] = {
      decision: record.decision,
      finalTreeId: record.finalTreeId,
      ...(cited
        ? {
            baselineTreeId: record.baselineTreeId as string,
            baselineArtifactPath: record.baselineArtifactPath as string,
          }
        : {}),
      attempts: attempts.map((entry) => ({
        attempt: entry.attempt,
        candidateTreeId: entry.candidateTreeId,
        verdict: entry.verdict,
        outcome: entry.outcome,
      })),
      invalidatedCandidateTreeIds: invalidated,
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The recorded final evaluation for one slice, or `undefined` — the reader
 * `decideFinalReuse`'s call site goes through, in the style of
 * {@link approvedBaselineFor} (#96 B-02).
 *
 * Each attempt entry comes back with `invalidated` resolved against the
 * record's own `invalidatedCandidateTreeIds`, so "which attempts graded a tree
 * a baseline-is-wrong finding rejected" is a read, not a join the caller has to
 * remember to perform (#96 B-09).
 */
export function finalEvaluationFor(
  state: RunState,
  ghIssue: string,
): FinalEvaluationView | undefined {
  const record = state.finalEvaluations?.[ghIssue];
  if (record === undefined) return undefined;
  return {
    ...record,
    attempts: record.attempts.map((entry) => ({
      ...entry,
      invalidated: record.invalidatedCandidateTreeIds.includes(
        entry.candidateTreeId,
      ),
    })),
  };
}

/**
 * Record one slice's final-evaluation decision. Called by the orchestrator
 * immediately after the decision is made, so the marker and the decision
 * cannot disagree.
 */
export function recordFinalEvaluation(
  repoRoot: string,
  prdSlug: string,
  ghIssue: string,
  record: PersistedFinalEvaluation,
): void {
  updateRunState(repoRoot, prdSlug, (state) => {
    state.version = RUN_STATE_VERSION;
    state.finalEvaluations = {
      ...(state.finalEvaluations ?? {}),
      [ghIssue]: record,
    };
  });
}

/**
 * Append a rejected candidate tree to one slice's invalidation list and drop
 * the baseline citation that tree stood behind (#96 B-09).
 *
 * The `approved-baseline.json` artifact and every
 * `gateEvidenceArtifactIds` value it names are left exactly as written: this
 * run-state record is a citation, and withdrawing a citation is not the same
 * act as erasing what was cited (#96 P-03).
 */
export function invalidateFinalEvaluationBaseline(
  repoRoot: string,
  prdSlug: string,
  ghIssue: string,
  candidateTreeId: string,
): PersistedFinalEvaluation {
  return updateRunState(repoRoot, prdSlug, (state) => {
    state.version = RUN_STATE_VERSION;
    const existing = state.finalEvaluations?.[ghIssue];
    const invalidated = existing?.invalidatedCandidateTreeIds ?? [];
    const record: PersistedFinalEvaluation = {
      decision: "evaluate",
      finalTreeId: existing?.finalTreeId ?? candidateTreeId,
      // The entries survive the invalidation: they are the record of what was
      // graded, and a return to the generator changes what the trees mean, not
      // whether the attempts happened.
      attempts: [...(existing?.attempts ?? [])],
      invalidatedCandidateTreeIds: invalidated.includes(candidateTreeId)
        ? [...invalidated]
        : [...invalidated, candidateTreeId],
    };
    state.finalEvaluations = {
      ...(state.finalEvaluations ?? {}),
      [ghIssue]: record,
    };
    return record;
  });
}

/**
 * Keep only well-formed quality-stage records (#87 B-14), in the same style as
 * {@link sanitizeFinalEvaluations}.
 *
 * A malformed round degrades the whole entry to absent rather than only itself,
 * for the reason the attempt sanitizer gives: a dropped round would understate
 * the spent budget and buy a free extra dispatch.
 */
function sanitizeQualityStages(
  value: unknown,
): Record<string, PersistedQualityStage[]> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const nonblank = (field: unknown): field is string =>
    typeof field === "string" && field.trim() !== "";
  const ROUND_OUTCOMES = new Set([
    "PASS",
    "FAIL",
    "REVERTED",
    "EXHAUSTED",
    "ESCALATED",
    "ESCALATION_MALFORMED",
  ]);
  const STAGE_OUTCOMES = new Set([
    "DISABLED",
    "PASS",
    "EXHAUSTED",
    "ESCALATED",
  ]);
  const out: Record<string, PersistedQualityStage[]> = {};
  for (const [ghIssue, raw] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (!Array.isArray(raw)) continue;
    const entries: PersistedQualityStage[] = [];
    let dropped = false;
    for (const candidate of raw) {
      if (typeof candidate !== "object" || candidate === null) {
        dropped = true;
        break;
      }
      const entry = candidate as Partial<
        Record<keyof PersistedQualityStage, unknown>
      >;
      if (entry.stage !== "cleaner") {
        dropped = true;
        break;
      }
      if (typeof entry.enabled !== "boolean") {
        dropped = true;
        break;
      }
      if (!STAGE_OUTCOMES.has(entry.outcome as string)) {
        dropped = true;
        break;
      }
      if (!Array.isArray(entry.rounds)) {
        dropped = true;
        break;
      }
      const rounds: PersistedQualityStageRound[] = [];
      for (const roundRaw of entry.rounds) {
        if (typeof roundRaw !== "object" || roundRaw === null) {
          dropped = true;
          break;
        }
        const round = roundRaw as Partial<
          Record<keyof PersistedQualityStageRound, unknown>
        >;
        if (
          !Number.isSafeInteger(round.round) ||
          (round.round as number) < 1 ||
          !Number.isSafeInteger(round.attempt) ||
          !nonblank(round.inputTreeId) ||
          !Array.isArray(round.gateIds) ||
          !round.gateIds.every(nonblank) ||
          !ROUND_OUTCOMES.has(round.outcome as string) ||
          (round.outputTreeId !== undefined && !nonblank(round.outputTreeId))
        ) {
          dropped = true;
          break;
        }
        rounds.push({
          round: round.round as number,
          attempt: round.attempt as number,
          inputTreeId: round.inputTreeId,
          ...(round.outputTreeId !== undefined
            ? { outputTreeId: round.outputTreeId as string }
            : {}),
          gateIds: [...(round.gateIds as string[])],
          outcome: round.outcome as PersistedQualityStageRound["outcome"],
        });
      }
      if (dropped) break;
      entries.push({
        stage: "cleaner",
        enabled: entry.enabled,
        rounds,
        outcome: entry.outcome as PersistedQualityStage["outcome"],
      });
    }
    if (dropped || entries.length === 0) continue;
    out[ghIssue] = entries;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * One slice's quality-stage entries, oldest first (#87 B-14). The current run's
 * entry is the last one: a fresh entry is appended per approval, so the earlier
 * ones are the escalated attempts that came before it.
 */
export function qualityStagesFor(
  state: RunState,
  ghIssue: string,
): readonly PersistedQualityStage[] {
  return state.qualityStages?.[ghIssue] ?? [];
}

/**
 * Record one cleaner round the moment it ends — persist-per-round, exactly as
 * `persistAttempts` persists per attempt (#87 B-14), so a run killed mid-stage
 * resumes having spent the rounds it actually spent.
 *
 * `startNewEntry` appends a fresh {@link PersistedQualityStage}; every later
 * round of the same stage run amends the last entry. That is what keeps an
 * escalated run's rounds off the re-approved candidate's budget (#87 B-13).
 */
export function recordQualityStageRound(
  repoRoot: string,
  prdSlug: string,
  ghIssue: string,
  round: PersistedQualityStageRound,
  options: { startNewEntry?: boolean } = {},
): void {
  updateRunState(repoRoot, prdSlug, (state) => {
    state.version = RUN_STATE_VERSION;
    const existing = [...(state.qualityStages?.[ghIssue] ?? [])];
    const last = existing[existing.length - 1];
    if (options.startNewEntry || last === undefined) {
      existing.push({
        stage: "cleaner",
        enabled: true,
        rounds: [round],
        // The stage is still running; the outcome is stamped by
        // `recordQualityStageOutcome` when it ends.
        outcome: "EXHAUSTED",
      });
    } else {
      existing[existing.length - 1] = {
        ...last,
        rounds: [...last.rounds, round],
      };
    }
    state.qualityStages = {
      ...(state.qualityStages ?? {}),
      [ghIssue]: existing,
    };
  });
}

/**
 * Stamp the stage's outcome on its current entry (#87 B-14). Called once, when
 * the stage ends — including for a `DISABLED` stage, which records the fact that
 * the run had no `gatePolicy.clean` without pretending a round ran.
 */
export function recordQualityStageOutcome(
  repoRoot: string,
  prdSlug: string,
  ghIssue: string,
  outcome: PersistedQualityStage["outcome"],
  options: { enabled?: boolean } = {},
): void {
  updateRunState(repoRoot, prdSlug, (state) => {
    state.version = RUN_STATE_VERSION;
    const existing = [...(state.qualityStages?.[ghIssue] ?? [])];
    const last = existing[existing.length - 1];
    const enabled = options.enabled ?? outcome !== "DISABLED";
    if (last === undefined) {
      existing.push({ stage: "cleaner", enabled, rounds: [], outcome });
    } else {
      existing[existing.length - 1] = { ...last, enabled, outcome };
    }
    state.qualityStages = {
      ...(state.qualityStages ?? {}),
      [ghIssue]: existing,
    };
  });
}

const RECOVERY_LINEAGE_STATE_VALUES: ReadonlySet<string> = new Set([
  "PENDING",
  "COMPLETED",
  "ROLLED_BACK",
  "ROLLBACK_FAILED",
]);

/**
 * Keep only well-formed recovery-lineage events (#277 B-10).
 *
 * A malformed event degrades the whole target's list to absent rather than only
 * itself, for the reason {@link sanitizeQualityStages} drops a whole entry: a
 * dropped `PENDING` would read as "no attempt is open" and let a second
 * admission through, which is the one outcome this record exists to prevent.
 * Absence is safe in the other direction — it refuses nothing and loses no
 * commits, because the snapshot on disk is what an unreferenced attempt leaves
 * behind and it grants no authority on its own.
 *
 * The three rollback-failure members are validated *per state* (#333 B-06):
 * required non-blank when `state` is `ROLLBACK_FAILED`, required absent
 * otherwise. Both directions are enforced here rather than only the first,
 * because a `PENDING` event carrying a `rollbackError` describes an event that
 * never happened, and a validator that accepts it would let a reader conclude a
 * rollback was attempted on an open attempt. A rejection takes the same
 * consequence every other malformation takes — the target's whole list degrades
 * to absent — so this is extra branches in that gate, not a second failure mode.
 *
 * The three completion members are validated the same way (#335 B-12): required
 * non-blank when `state` is `COMPLETED`, required absent otherwise. Both
 * directions again, because a `COMPLETED` event without a replacement fingerprint
 * is an event no dispatch can check the pair against, and a `PENDING` one
 * carrying a replacement fingerprint claims a completion that has not happened.
 *
 * `extensions` must be an array of `{number, ghIssue}` pairs with non-blank
 * members (#278 B-04). An empty array is well-formed and always was; a bare
 * selector string, or a pair with a blank member, drops the event's whole list
 * for the reason above — a half-read extension set would let a scope identity
 * this run admitted disappear from the record that proves it was admitted.
 */
function sanitizeRecoveryLineage(
  value: unknown,
): Record<string, PersistedRecoveryLineageEvent[]> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const nonblank = (field: unknown): field is string =>
    typeof field === "string" && field.trim() !== "";
  // A scope extension is the same shape `target` is, held to the same
  // non-blank rule (#278 B-04). A bare selector string — the shape #277
  // reserved — is not a pair, so an event still carrying one degrades the
  // slice's lineage rather than loading half-resolved.
  const isScopePair = (field: unknown): field is PersistedScopeSlice => {
    if (typeof field !== "object" || field === null || Array.isArray(field)) {
      return false;
    }
    const pair = field as Partial<Record<"number" | "ghIssue", unknown>>;
    return nonblank(pair.number) && nonblank(pair.ghIssue);
  };
  const out: Record<string, PersistedRecoveryLineageEvent[]> = {};
  for (const [ghIssue, raw] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (!Array.isArray(raw)) continue;
    const events: PersistedRecoveryLineageEvent[] = [];
    let dropped = false;
    for (const candidate of raw) {
      if (typeof candidate !== "object" || candidate === null) {
        dropped = true;
        break;
      }
      const event = candidate as Partial<
        Record<keyof PersistedRecoveryLineageEvent, unknown>
      >;
      const target = event.target as
        | Partial<Record<"number" | "ghIssue", unknown>>
        | undefined;
      if (
        !nonblank(event.attemptId) ||
        !RECOVERY_LINEAGE_STATE_VALUES.has(event.state as string) ||
        typeof target !== "object" ||
        target === null ||
        !nonblank(target.number) ||
        !nonblank(target.ghIssue) ||
        typeof event.reason !== "string" ||
        event.reason.trim() === "" ||
        !Array.isArray(event.extensions) ||
        !event.extensions.every(isScopePair) ||
        !nonblank(event.provider) ||
        !nonblank(event.sliceBranch) ||
        !nonblank(event.sliceHead) ||
        !nonblank(event.featureHead) ||
        !nonblank(event.scopeFingerprint) ||
        !nonblank(event.snapshotPath) ||
        !nonblank(event.contractFingerprint) ||
        !nonblank(event.manifestFingerprint) ||
        !nonblank(event.recordedAt)
      ) {
        dropped = true;
        break;
      }
      const state = event.state as RecoveryLineageState;
      const rollbackFailure =
        state === "ROLLBACK_FAILED"
          ? ROLLBACK_FAILURE_FIELDS.every((field) => nonblank(event[field]))
          : ROLLBACK_FAILURE_FIELDS.every(
              (field) => event[field] === undefined,
            );
      if (!rollbackFailure) {
        dropped = true;
        break;
      }
      const completion =
        state === "COMPLETED"
          ? COMPLETION_FIELDS.every((field) => nonblank(event[field]))
          : COMPLETION_FIELDS.every((field) => event[field] === undefined);
      if (!completion) {
        dropped = true;
        break;
      }
      events.push({
        attemptId: event.attemptId,
        state,
        target: { number: target.number, ghIssue: target.ghIssue },
        reason: event.reason,
        extensions: (event.extensions as PersistedScopeSlice[]).map(
          ({ number, ghIssue }) => ({ number, ghIssue }),
        ),
        provider: event.provider,
        sliceBranch: event.sliceBranch,
        sliceHead: event.sliceHead,
        featureHead: event.featureHead,
        scopeFingerprint: event.scopeFingerprint,
        snapshotPath: event.snapshotPath,
        contractFingerprint: event.contractFingerprint,
        manifestFingerprint: event.manifestFingerprint,
        recordedAt: event.recordedAt,
        ...(state === "ROLLBACK_FAILED"
          ? {
              rollbackError: event.rollbackError as string,
              observedContractFingerprint:
                event.observedContractFingerprint as string,
              observedManifestFingerprint:
                event.observedManifestFingerprint as string,
            }
          : {}),
        ...(state === "COMPLETED"
          ? {
              replacementContractFingerprint:
                event.replacementContractFingerprint as string,
              replacementManifestFingerprint:
                event.replacementManifestFingerprint as string,
              lockProvenance: event.lockProvenance as string,
            }
          : {}),
      });
    }
    if (dropped || events.length === 0) continue;
    out[ghIssue] = events;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * One slice's recovery-lineage events, oldest first (#277 B-10). The last event
 * is the attempt's current state: a trailing `PENDING` is an unresolved attempt,
 * which is what refuses a second admission for the same target (#277 B-09).
 */
export function recoveryLineageFor(
  state: RunState,
  ghIssue: string,
): readonly PersistedRecoveryLineageEvent[] {
  return state.recoveryLineage?.[ghIssue] ?? [];
}

/**
 * Append one recovery-lineage event to a **loaded** run state (#277 B-09/B-10).
 *
 * Takes the state rather than a repo root on purpose: the only legal moment to
 * append is inside a {@link transactRunState} body that has already reloaded the
 * file under the ADR 0056 lock and rechecked the facts the caller decided on. A
 * `repoRoot`-shaped convenience writer would be a second path that appends
 * without that recheck — exactly the unverified admission the protocol forbids.
 *
 * Append-only: existing events are copied forward untouched, so no writer can
 * shorten or rewrite the list (#277 B-11).
 */
export function appendRecoveryLineageEvent(
  state: RunState,
  ghIssue: string,
  event: PersistedRecoveryLineageEvent,
): void {
  state.version = RUN_STATE_VERSION;
  state.recoveryLineage = {
    ...(state.recoveryLineage ?? {}),
    [ghIssue]: [...(state.recoveryLineage?.[ghIssue] ?? []), event],
  };
}

/**
 * Load run state, adapting unversioned (v0), v1, and v2 files in memory. v0 files
 * used a per-slice `status` field whose values were a strict subset of v1's
 * `phase` enum, so that migration is a field rename. v2 adds raw exact-stage
 * checkpoint storage whose focused reader owns validation. v3 adds adoption
 * provenance to terminal slice records. v4 adds two purely additive fields: the
 * per-slice approved baseline locator (#91) and applied protected-change waivers
 * (#193). A v3 file simply has neither — it adapts to v4 in memory with no
 * locator, no waivers and no write. v5 adds `finalEvaluations` (#96) the same
 * way: a v4 file keeps its locator and its waivers and gains no final
 * evaluation, because it had none. v6 adds `qualityStages` (#87) the same way
 * again: a v5 file with no such member reads as "no stage ran" and the adapter
 * writes nothing. v7 adds `recoveryLineage` (#277) the same way once more: a v6
 * file with no such member reads as "no recovery attempt was admitted".
 * Throws on unknown status strings rather than
 * silently producing an invalid record.
 */
export function loadRunState(repoRoot: string, prdSlug: string): RunState {
  const p = statePath(repoRoot, prdSlug);
  if (!existsSync(p)) {
    return {
      version: RUN_STATE_VERSION,
      prdSlug,
      featureBranch: `feat/${prdSlug}`,
      slices: {},
    };
  }
  const raw = JSON.parse(readFileSync(p, "utf-8")) as unknown;
  return adaptLoadedState(raw, prdSlug);
}

export function adaptLoadedState(raw: unknown, prdSlug: string): RunState {
  const r = (raw ?? {}) as {
    version?: unknown;
    prdSlug?: string;
    featureBranch?: string;
    specsDir?: unknown;
    scope?: PersistedRunScope;
    slices?: Record<string, unknown>;
    reviewPhase?: unknown;
    resume?: unknown;
    stageCheckpoints?: unknown;
    contractConvergence?: unknown;
    qaConvergence?: unknown;
    nonProgress?: unknown;
    migrations?: unknown;
    approvedBaselines?: unknown;
    appliedWaivers?: unknown;
    finalEvaluations?: unknown;
    qualityStages?: unknown;
    recoveryLineage?: unknown;
  };
  const featureBranch = r.featureBranch ?? `feat/${prdSlug}`;
  const slicesIn = r.slices ?? {};
  // A blank or non-string value degrades to absent, which selects the
  // complete-walk fallback in `probeAdjudicationEstate`. It never degrades
  // to a guessed path: the whole point of the field is that it is resolved.
  const specsDir =
    typeof r.specsDir === "string" && r.specsDir.trim() !== ""
      ? r.specsDir
      : undefined;

  if (
    r.version === 1 ||
    r.version === 2 ||
    r.version === 3 ||
    r.version === 4 ||
    r.version === 5 ||
    r.version === 6 ||
    r.version === 7
  ) {
    const slices: Record<string, PersistedSliceState> = {};
    for (const [id, val] of Object.entries(slicesIn)) {
      slices[id] = validateV1Slice(id, val);
    }
    const reviewPhase = sanitizeReviewPhase(r.reviewPhase);
    const resume = sanitizeResumeMap(r.resume);
    const migrations = sanitizeMigrationClaims(r.migrations);
    // A v3 file has neither field at all, which is exactly "no baseline
    // recorded" and "no waiver applied" — the adapter adds nothing and
    // writes nothing.
    const approvedBaselines = sanitizeApprovedBaselines(r.approvedBaselines);
    const appliedWaivers = sanitizeAppliedWaivers(r.appliedWaivers);
    const finalEvaluations = sanitizeFinalEvaluations(r.finalEvaluations);
    const qualityStages = sanitizeQualityStages(r.qualityStages);
    const recoveryLineage = sanitizeRecoveryLineage(r.recoveryLineage);
    return {
      version: RUN_STATE_VERSION,
      prdSlug,
      featureBranch,
      ...(specsDir !== undefined ? { specsDir } : {}),
      ...(r.scope !== undefined ? { scope: r.scope } : {}),
      slices,
      ...(reviewPhase !== undefined ? { reviewPhase } : {}),
      ...(resume !== undefined ? { resume } : {}),
      ...(r.version !== 1 && r.stageCheckpoints !== undefined
        ? { stageCheckpoints: r.stageCheckpoints }
        : {}),
      ...(r.version !== 1 && r.contractConvergence !== undefined
        ? { contractConvergence: r.contractConvergence }
        : {}),
      ...(r.version !== 1 && r.qaConvergence !== undefined
        ? { qaConvergence: r.qaConvergence }
        : {}),
      ...(r.version !== 1 && r.nonProgress !== undefined
        ? { nonProgress: r.nonProgress }
        : {}),
      ...(migrations !== undefined ? { migrations } : {}),
      ...(approvedBaselines !== undefined ? { approvedBaselines } : {}),
      // v1–v3 files have no such field at all, so the upgrade leaves it
      // absent: "no waiver was applied" and "this file predates waivers"
      // are the same fact to every reader.
      ...(appliedWaivers !== undefined ? { appliedWaivers } : {}),
      // v1–v4 files have no such field, so the upgrade leaves it absent: "no
      // final evaluation happened" and "this file predates final evaluation"
      // are the same fact to every reader.
      ...(finalEvaluations !== undefined ? { finalEvaluations } : {}),
      // v1–v5 files have no such field, so the upgrade leaves it absent and
      // writes nothing: "no quality stage ran" and "this file predates quality
      // stages" are the same fact to every reader (#87 B-14).
      ...(qualityStages !== undefined ? { qualityStages } : {}),
      // v1–v6 files have no such field, so the upgrade leaves it absent and
      // writes nothing: "no recovery attempt was admitted" and "this file
      // predates recovery lineage" are the same fact to every reader
      // (#277 B-10, P-03).
      ...(recoveryLineage !== undefined ? { recoveryLineage } : {}),
    };
  }

  // v0: per-slice `status` instead of `phase`. Rename and validate.
  const slices: Record<string, PersistedSliceState> = {};
  for (const [id, val] of Object.entries(slicesIn)) {
    const v = (val ?? {}) as {
      status?: string;
      branch?: string;
      mergedToFeature?: boolean;
      error?: string;
      collidingPrefixes?: unknown;
      adoption?: unknown;
    };
    if (typeof v.status !== "string" || !PERSISTED_PHASES.has(v.status)) {
      throw new Error(
        `Unknown phase "${v.status}" while loading v0 run-state for slice ${id}`,
      );
    }
    slices[id] = {
      phase: v.status as PersistedPhase,
      ...(v.branch !== undefined ? { branch: v.branch } : {}),
      ...(v.mergedToFeature !== undefined
        ? { mergedToFeature: v.mergedToFeature }
        : {}),
      ...(v.error !== undefined ? { error: v.error } : {}),
      ...prefixesOf(v.collidingPrefixes),
      ...adoptionOf(v.adoption),
    };
  }
  return {
    version: RUN_STATE_VERSION,
    prdSlug,
    featureBranch,
    ...(specsDir !== undefined ? { specsDir } : {}),
    ...(r.scope !== undefined ? { scope: r.scope } : {}),
    slices,
  };
}

/**
 * Keep only a well-formed string array. A malformed list degrades to
 * absent rather than throwing: the phase and the reason text still carry
 * the operator-visible facts, so a broken field must not wedge a re-run.
 */
function prefixesOf(value: unknown): { collidingPrefixes?: string[] } {
  if (!Array.isArray(value)) return {};
  const prefixes = value.filter((p): p is string => typeof p === "string");
  return prefixes.length > 0 ? { collidingPrefixes: prefixes } : {};
}

function adoptionOf(value: unknown): { adoption?: SliceAdoption } {
  if (typeof value !== "object" || value === null) return {};
  const adoption = value as Partial<Record<keyof SliceAdoption, unknown>>;
  if (
    typeof adoption.adopter !== "string" ||
    adoption.adopter.trim() === "" ||
    typeof adoption.reason !== "string" ||
    adoption.reason.trim() === "" ||
    typeof adoption.branch !== "string" ||
    adoption.branch.trim() === "" ||
    typeof adoption.commit !== "string" ||
    adoption.commit.trim() === ""
  ) {
    return {};
  }
  return {
    adoption: {
      adopter: adoption.adopter,
      reason: adoption.reason,
      branch: adoption.branch,
      commit: adoption.commit,
    },
  };
}

function validateV1Slice(id: string, val: unknown): PersistedSliceState {
  const v = (val ?? {}) as {
    phase?: string;
    branch?: string;
    mergedToFeature?: boolean;
    error?: string;
    collidingPrefixes?: unknown;
    adoption?: unknown;
  };
  if (typeof v.phase !== "string" || !PERSISTED_PHASES.has(v.phase)) {
    throw new Error(
      `Unknown phase "${v.phase}" in run-state for slice ${id}`,
    );
  }
  return {
    phase: v.phase as PersistedPhase,
    ...(v.branch !== undefined ? { branch: v.branch } : {}),
    ...(v.mergedToFeature !== undefined
      ? { mergedToFeature: v.mergedToFeature }
      : {}),
    ...(v.error !== undefined ? { error: v.error } : {}),
    ...prefixesOf(v.collidingPrefixes),
    ...adoptionOf(v.adoption),
  };
}

/**
 * Project an in-memory `SliceLifecycle` to its persisted form. Returns
 * `null` for non-terminal phases that don't belong on disk.
 */
export function projectForPersistence(
  s: SliceLifecycle,
): PersistedSliceState | null {
  switch (s.phase) {
    case "PENDING":
    case "RUNNING":
      return null;
    case "PASS":
      return {
        phase: "PASS",
        ...(s.branch ? { branch: s.branch } : {}),
        mergedToFeature: s.mergedToFeature,
        ...(s.adoption ? { adoption: s.adoption } : {}),
      };
    case "SKIPPED":
      return {
        phase: "SKIPPED",
        ...(s.branch ? { branch: s.branch } : {}),
      };
    case "MERGE-PENDING":
      return {
        phase: "MERGE-PENDING",
        ...(s.branch ? { branch: s.branch } : {}),
        error: s.error,
        collidingPrefixes: s.collidingPrefixes,
      };
    case "STUCK":
    case "ESCALATE":
    case "AWAITING-ADJUDICATION":
    case "ADJUDICATION-LOCK-REFUSED":
    case "ERROR":
    case "CONFLICT":
    case "CANCELLED":
    case "LANE-CANCELLED":
      return {
        phase: s.phase,
        ...(s.branch ? { branch: s.branch } : {}),
        error: s.error,
      };
  }
}

/**
 * Atomically update a single slice in the run state.
 * Re-reads the file before writing to avoid clobbering parallel updates.
 * Auto-upgrades older files to the current schema on next save.
 */
export function saveSliceState(
  repoRoot: string,
  prdSlug: string,
  ghIssue: string,
  result: PersistedSliceState,
) {
  updateRunState(repoRoot, prdSlug, (current) => {
    current.slices[ghIssue] = result;
  });
}

export function saveSliceStateIfUnchanged(
  repoRoot: string,
  prdSlug: string,
  ghIssue: string,
  result: PersistedSliceState,
  expected: PersistedSliceState | undefined,
  hooks: {
    /** Test seam: the expected record matched and the run-state lock is held. */
    afterComparison?: () => void;
  } = {},
): { ok: true } | { ok: false; found: PersistedSliceState | undefined } {
  type Result =
    | { ok: true }
    | { ok: false; found: PersistedSliceState | undefined };
  return transactRunState<Result>(repoRoot, prdSlug, (current) => {
    const found = current.slices[ghIssue];
    if (!sameSliceRecord(found, expected)) {
      return { changed: false, result: { ok: false as const, found } };
    }
    hooks.afterComparison?.();
    current.slices[ghIssue] = result;
    return { changed: true, result: { ok: true as const } };
  });
}

export function sameSliceRecord(
  a: PersistedSliceState | undefined,
  b: PersistedSliceState | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    JSON.stringify(canonicalSliceRecord(a)) ===
    JSON.stringify(canonicalSliceRecord(b))
  );
}

function canonicalSliceRecord(record: PersistedSliceState): unknown {
  return Object.entries(record as unknown as Record<string, unknown>).sort(
    ([x], [y]) => (x < y ? -1 : x > y ? 1 : 0),
  );
}

/**
 * Drop a slice's persisted record because this run is dispatching it
 * again (#111). Returns the record that was removed, or `null` when
 * there was nothing to remove — the file is then left untouched, so a
 * first run does not create a state file just to prove it had nothing
 * to clear.
 *
 * Every field of `PersistedSliceState` is a claim about a *decided*
 * outcome of a previous attempt: the phase, the branch it was decided
 * on, the failure reason, `mergedToFeature`, and the prefixes that
 * refused a merge. The moment the slice is dispatched again none of them
 * describes anything true, and nothing in the file says so. After run
 * 6's crash, #79's persisted `error` still named a typecheck failure
 * from two runs earlier — already fixed — and the next run's retry
 * announcement pointed the operator at the wrong defect.
 *
 * So the whole record goes, not only the error text. ADR 0018 already
 * makes absence mean "no decided outcome" (RUNNING is never persisted),
 * so removal is the one state that is honest for a slice in flight, and
 * `--only-failed` reads "not complete" rather than "recorded failed", so
 * a cleared slice stays eligible for the next run exactly as before.
 *
 * Deliberately NOT cleared: `resume` bookkeeping — its `attempts` is the
 * count of resumed generator dispatches this tree has already absorbed, and
 * it survives a dispatch precisely because a dispatch that never reaches the
 * generator must not change it (#188 defect 4). Only a from-base restart
 * resets it, because that is a new tree; only `chargeResumeAttempt`, called
 * immediately before the generator, raises it. Also not cleared: exact-stage
 * checkpoints (the resumed dispatch must inspect one before any agent runs),
 * contract and QA convergence lineage (fresh attempts must retain prior
 * findings), `scope`, `migrations`, and `reviewPhase`. None of those is a
 * per-attempt terminal outcome claim.
 */
export function clearSliceStateForDispatch(
  repoRoot: string,
  prdSlug: string,
  ghIssue: string,
): PersistedSliceState | null {
  return transactRunState(repoRoot, prdSlug, (current) => {
    const previous = current.slices[ghIssue];
    if (!previous) return { changed: false, result: null };
    delete current.slices[ghIssue];
    return { changed: true, result: previous };
  });
}

export function saveRunState(repoRoot: string, state: RunState) {
  const p = statePath(repoRoot, state.prdSlug);
  withRunStateLock(repoRoot, state.prdSlug, () => {
    if (existsSync(p)) {
      throw new Error(
        `Refusing to replace existing run state ${p} from a whole-file snapshot; ` +
          `use transactRunState or a focused writer`,
      );
    }
    writeRunState(p, state);
  });
}

/**
 * Append the protected-change waivers a gate actually applied for one slice,
 * ignoring a `riskClass` + `path` pair already recorded (#193).
 *
 * Modelled on `recordFiledGuardianFindings`
 * (`src/guardian-round-persistence.ts`) and for the same reason: the write happens
 * mid-slice, at gate time, when the slice has no persisted terminal record to
 * attach to (ADR 0018). Re-reads state inside the lock so a waiver survives
 * whatever a parallel slice wrote in between, and de-duplicates because two
 * gates can each apply the same launch authorization — `feedback-integrity`
 * and the skipped-test gate both report a `skipped-test` waiver they honored,
 * and that is one human decision, not two.
 */
export function saveAppliedWaivers(
  repoRoot: string,
  runSlug: string,
  ghIssue: string,
  waivers: readonly PersistedAppliedWaiver[],
) {
  if (waivers.length === 0) return;
  updateRunState(repoRoot, runSlug, (current) => {
    const records = [...(current.appliedWaivers?.[ghIssue] ?? [])];
    for (const waiver of waivers) {
      const duplicate = records.some(
        (existing) =>
          existing.riskClass === waiver.riskClass &&
          existing.path === waiver.path,
      );
      if (duplicate) continue;
      records.push({ ...waiver });
    }
    current.appliedWaivers = { ...current.appliedWaivers, [ghIssue]: records };
  });
}

export function markSliceComplete(
  state: RunState,
  ghIssue: string,
  result: PersistedSliceState,
) {
  state.slices[ghIssue] = result;
}

export function isSliceComplete(state: RunState, ghIssue: string): boolean {
  const s = state.slices[ghIssue];
  return s?.phase === "PASS" && s.mergedToFeature === true;
}

/** Resume attempts recorded for a slice; absent reads as zero (#36). */
export function getResumeAttempts(state: RunState, ghIssue: string): number {
  return state.resume?.[ghIssue]?.attempts ?? 0;
}

/**
 * Atomically record a slice's retry decision (resume-attempt count +
 * human-readable decision). Same read-modify-write pattern as
 * `saveSliceState` so parallel per-slice outcome writes are never
 * clobbered — and vice versa.
 */
export function recordRetryDecision(
  repoRoot: string,
  prdSlug: string,
  ghIssue: string,
  decision: SliceResumeState,
) {
  updateRunState(repoRoot, prdSlug, (current) => {
    current.resume = { ...current.resume, [ghIssue]: decision };
  });
}

/**
 * Spend one resume attempt, read-modify-write inside the state lock, and
 * return the new count (#188 defect 4).
 *
 * Separate from `recordRetryDecision` because the two happen at different
 * moments and mean different things: the decision is recorded when
 * `prepareSliceWorktree` re-attaches to a surviving tree, the charge when a
 * generator is actually dispatched onto it. The increment reads the persisted
 * value rather than taking one from the caller, so a decision written earlier
 * in the same invocation — or by a parallel writer — cannot be clobbered by a
 * stale `priorAttempts` captured before negotiation ran.
 *
 * `describe` receives the new count so the audit trail can name it
 * ("attempt 2/2 charged at generator dispatch") without a second read.
 */
export function chargeResumeAttempt(
  repoRoot: string,
  prdSlug: string,
  ghIssue: string,
  describe: (attempts: number) => string,
): number {
  let charged = 0;
  updateRunState(repoRoot, prdSlug, (current) => {
    charged = (current.resume?.[ghIssue]?.attempts ?? 0) + 1;
    current.resume = {
      ...current.resume,
      [ghIssue]: { attempts: charged, lastDecision: describe(charged) },
    };
  });
  return charged;
}

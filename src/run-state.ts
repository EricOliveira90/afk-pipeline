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
import type { PersistedRunScope } from "./slice-scope.js";
import { withFileLock } from "./file-lock.js";
import type {
  GuardianFindingDisposition,
  GuardianKind,
  ReviewOutcome,
} from "./artifacts.js";
import { guardianFindingMayBlock } from "./guardian-blocking-authority.js";

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
 * The schema version every writer emits. v4 adds the per-slice approved
 * baseline locator below; `adaptLoadedState` normalizes a v3 file to it in
 * memory, so a resumed run reads one shape.
 */
export const RUN_STATE_VERSION = 4;

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

export interface RunState {
  /**
   * Schema version. Writers emit {@link RUN_STATE_VERSION} and
   * `adaptLoadedState` returns it for every accepted file; the literal `3`
   * stays assignable so callers and fixtures holding a v3 record keep
   * compiling, and nothing reads a `3` back out of a loaded state.
   */
  version: 3 | 4;
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
   * Per-slice approved-baseline locators, keyed by GitHub issue — the v4
   * addition. Absent entries read as "no baseline recorded", so a v3 file
   * loads unchanged.
   */
  approvedBaselines?: Record<string, PersistedApprovedBaseline>;
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

/** A favorable guardian verdict recorded against the reviewed HEAD. */
export interface PersistedReviewResult {
  headSha: string;
  verdict: "SHIP" | "ACCEPT-WITH-NOTES";
}

export interface PersistedGuardianFinding {
  stableId: string;
  currentId: string;
  title: string;
  class: string;
  clearCondition: string;
  disposition: GuardianFindingDisposition;
  reachableTrigger: string | null;
  introducedByReviewedDiff: boolean | null;
}

export interface PersistedGuardianReviewRecord {
  source: "INVOKED" | "CACHE";
  outcome: ReviewOutcome;
  findings: PersistedGuardianFinding[];
  findingsOriginRound: number | null;
}

export interface PersistedGuardianReviewRound {
  round: number;
  reviewedHeadSha: string;
  headSha: string;
  architect: PersistedGuardianReviewRecord;
  pm: PersistedGuardianReviewRecord;
}

/**
 * One guardian finding this run has opened an issue for.
 *
 * The durable half of "filed exactly once" (ADR 0057 decision 4, last
 * sentence): a note that rides two consecutive rounds is filed on the first and
 * skipped on the second because its ledger identity is already in here.
 */
export interface PersistedFiledFinding {
  guardian: GuardianKind;
  stableId: string;
  /** Normalized class + clear condition — the content half of the identity. */
  fingerprint: string;
  kind: "BLOCKER" | "NOTE";
  /** The round whose entry was filed. */
  round: number;
  /** Whatever the tracker returned to name the issue, usually a URL. */
  issue: string;
}

export interface PersistedReviewPhase {
  sanity?: PersistedSanityResult;
  architect?: PersistedReviewResult;
  pm?: PersistedReviewResult;
  rounds?: PersistedGuardianReviewRound[];
  filedFindings?: PersistedFiledFinding[];
}

const FAVORABLE_VERDICTS = new Set(["SHIP", "ACCEPT-WITH-NOTES"]);
const REVIEW_OUTCOMES = new Set<ReviewOutcome>([
  "SHIP",
  "ACCEPT-WITH-NOTES",
  "FIX-BEFORE-SHIP",
  "UNPARSEABLE",
  "NEVER_RAN",
  "DIED_MID_RUN",
]);
const FINDING_DISPOSITIONS = new Set<GuardianFindingDisposition>([
  "OPEN",
  "RESOLVED",
  "REPEATED",
  "REOPENED",
  "REGRESSED",
]);

function sanitizeReviewResult(value: unknown): PersistedReviewResult | undefined {
  const v = (value ?? {}) as { headSha?: unknown; verdict?: unknown };
  if (
    typeof v.headSha === "string" &&
    v.headSha.length > 0 &&
    typeof v.verdict === "string" &&
    FAVORABLE_VERDICTS.has(v.verdict)
  ) {
    return { headSha: v.headSha, verdict: v.verdict as "SHIP" | "ACCEPT-WITH-NOTES" };
  }
  return undefined;
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function sanitizeGuardianFinding(
  value: unknown,
): PersistedGuardianFinding | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const finding = value as Record<string, unknown>;
  if (
    !nonBlank(finding.stableId) ||
    !nonBlank(finding.currentId) ||
    !nonBlank(finding.title) ||
    !nonBlank(finding.class) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(finding.class.trim()) ||
    !nonBlank(finding.clearCondition) ||
    typeof finding.disposition !== "string" ||
    !FINDING_DISPOSITIONS.has(
      finding.disposition as GuardianFindingDisposition,
    )
  ) {
    return undefined;
  }
  const reachableTrigger =
    finding.reachableTrigger === undefined ||
    finding.reachableTrigger === null
      ? null
      : nonBlank(finding.reachableTrigger)
        ? finding.reachableTrigger.trim()
        : undefined;
  const introducedByReviewedDiff =
    finding.introducedByReviewedDiff === undefined ||
    finding.introducedByReviewedDiff === null
      ? null
      : typeof finding.introducedByReviewedDiff === "boolean"
        ? finding.introducedByReviewedDiff
        : undefined;
  if (
    reachableTrigger === undefined ||
    introducedByReviewedDiff === undefined
  ) {
    return undefined;
  }
  return {
    stableId: finding.stableId.trim(),
    currentId: finding.currentId.trim(),
    title: finding.title.trim(),
    class: finding.class.trim(),
    clearCondition: finding.clearCondition.trim(),
    disposition: finding.disposition as GuardianFindingDisposition,
    reachableTrigger,
    introducedByReviewedDiff,
  };
}

function sanitizeGuardianRecord(
  value: unknown,
  round: number,
): PersistedGuardianReviewRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    (record.source !== "INVOKED" && record.source !== "CACHE") ||
    typeof record.outcome !== "string" ||
    !REVIEW_OUTCOMES.has(record.outcome as ReviewOutcome) ||
    !Array.isArray(record.findings) ||
    !(
      record.findingsOriginRound === null ||
      (Number.isSafeInteger(record.findingsOriginRound) &&
        (record.findingsOriginRound as number) > 0)
    )
  ) {
    return undefined;
  }
  if (
    record.source === "CACHE" &&
    !FAVORABLE_VERDICTS.has(record.outcome)
  ) {
    return undefined;
  }
  const findings = record.findings.map(sanitizeGuardianFinding);
  if (findings.some((finding) => finding === undefined)) return undefined;
  const validFindings = findings as PersistedGuardianFinding[];
  // Both IDs stay unique within a record: current IDs because the block
  // parsed distinct rows, stable IDs because identity resolution is
  // one-to-one within a round (ADR 0057 decision 1, amendment 2026-09-06) —
  // `stableId` names one lineage, keeping cross-round matching
  // order-independent.
  if (
    new Set(validFindings.map((finding) => finding.currentId)).size !==
      validFindings.length ||
    new Set(validFindings.map((finding) => finding.stableId)).size !==
      validFindings.length
  ) {
    return undefined;
  }
  const findingsOriginRound = record.findingsOriginRound as number | null;
  if (record.source === "INVOKED" && findingsOriginRound !== round) {
    return undefined;
  }
  if (
    record.source === "INVOKED" &&
    (
      (record.outcome === "SHIP" && validFindings.length !== 0) ||
      (
        (record.outcome === "ACCEPT-WITH-NOTES" ||
          record.outcome === "FIX-BEFORE-SHIP") &&
        validFindings.length === 0
      ) ||
      (
        (record.outcome === "UNPARSEABLE" ||
          record.outcome === "NEVER_RAN" ||
          record.outcome === "DIED_MID_RUN") &&
        validFindings.length !== 0
      )
    )
  ) {
    return undefined;
  }
  return {
    source: record.source,
    outcome: record.outcome as ReviewOutcome,
    findings: validFindings,
    findingsOriginRound,
  };
}

function sameFindings(
  left: readonly PersistedGuardianFinding[],
  right: readonly PersistedGuardianFinding[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sanitizeGuardianRounds(
  value: unknown,
): PersistedGuardianReviewRound[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rounds: PersistedGuardianReviewRound[] = [];
  for (let index = 0; index < value.length; index++) {
    const expectedRound = index + 1;
    const input = value[index];
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return undefined;
    }
    const round = input as Record<string, unknown>;
    const architect = sanitizeGuardianRecord(round.architect, expectedRound);
    const pm = sanitizeGuardianRecord(round.pm, expectedRound);
    if (
      round.round !== expectedRound ||
      !nonBlank(round.reviewedHeadSha) ||
      !nonBlank(round.headSha) ||
      architect === undefined ||
      pm === undefined
    ) {
      return undefined;
    }
    rounds.push({
      round: expectedRound,
      reviewedHeadSha: round.reviewedHeadSha.trim(),
      headSha: round.headSha.trim(),
      architect,
      pm,
    });
  }

  for (let index = 0; index < rounds.length; index++) {
    const round = rounds[index]!;
    for (const guardian of ["architect", "pm"] as const) {
      const record = round[guardian];
      if (record.findingsOriginRound !== null) {
        const origin = rounds[record.findingsOriginRound - 1]?.[guardian];
        if (
          origin?.source !== "INVOKED" ||
          !sameFindings(record.findings, origin.findings)
        ) {
          return undefined;
        }
      }
      if (record.source !== "CACHE") continue;
      const sourceRound = rounds
        .slice(0, index)
        .reverse()
        .find((prior) => prior.headSha === round.reviewedHeadSha);
      const sourceRecord = sourceRound?.[guardian];
      if (sourceRecord?.findingsOriginRound != null) {
        if (
          record.findingsOriginRound !==
            sourceRecord.findingsOriginRound ||
          !sameFindings(record.findings, sourceRecord.findings)
        ) {
          return undefined;
        }
      } else if (
        record.findingsOriginRound !== null ||
        record.findings.length !== 0
      ) {
        return undefined;
      }
    }
    if (
      round.architect.source === "INVOKED" &&
      round.architect.outcome === "FIX-BEFORE-SHIP"
    ) {
      const priorStableIds = new Set(
        rounds
          .slice(0, index)
          .flatMap((prior) =>
            prior.architect.findings.map((finding) => finding.stableId),
          ),
      );
      if (
        !round.architect.findings.some((finding) =>
          guardianFindingMayBlock({
            guardian: "architect",
            round: round.round,
            hasPriorLineage: priorStableIds.has(finding.stableId),
            class: finding.class,
            disposition: finding.disposition,
            reachableTrigger: finding.reachableTrigger,
            introducedByReviewedDiff: finding.introducedByReviewedDiff,
          }),
        )
      ) {
        return undefined;
      }
    }
  }
  return rounds;
}

/**
 * Validate the filed-issue record, entry by entry.
 *
 * Unlike the ledger this is *not* all-or-nothing. Every record dropped is one
 * finding the next round may file a second issue for, so keeping the valid
 * majority minimizes duplicates instead of discarding the whole memory over one
 * bad row. A missing or unreadable record degrades to "nothing filed yet",
 * never blocks resumption — the same tolerance the verdict cache gets.
 */
function sanitizeFiledFindings(
  value: unknown,
): PersistedFiledFinding[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const records: PersistedFiledFinding[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (
      (record.guardian !== "architect" && record.guardian !== "pm") ||
      !nonBlank(record.stableId) ||
      !nonBlank(record.fingerprint) ||
      (record.kind !== "BLOCKER" && record.kind !== "NOTE") ||
      !Number.isSafeInteger(record.round) ||
      (record.round as number) < 1 ||
      !nonBlank(record.issue)
    ) {
      continue;
    }
    const key = `${record.guardian} ${record.stableId.trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    records.push({
      guardian: record.guardian as GuardianKind,
      stableId: record.stableId.trim(),
      fingerprint: record.fingerprint,
      kind: record.kind,
      round: record.round as number,
      issue: record.issue.trim(),
    });
  }
  return records.length > 0 ? records : undefined;
}

/**
 * Validate a loaded `reviewPhase`, dropping malformed or unfavorable
 * cache entries independently from the all-or-nothing guardian ledger.
 */
export function sanitizeReviewPhase(value: unknown): PersistedReviewPhase | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as {
    sanity?: unknown;
    architect?: unknown;
    pm?: unknown;
    rounds?: unknown;
    filedFindings?: unknown;
  };
  const out: PersistedReviewPhase = {};
  const sanity = (v.sanity ?? {}) as { treeSha?: unknown; ok?: unknown };
  if (typeof sanity.treeSha === "string" && sanity.treeSha.length > 0 && sanity.ok === true) {
    out.sanity = { treeSha: sanity.treeSha, ok: true };
  }
  const architect = sanitizeReviewResult(v.architect);
  if (architect) out.architect = architect;
  const pm = sanitizeReviewResult(v.pm);
  if (pm) out.pm = pm;
  if (v.rounds !== undefined) {
    const rounds = sanitizeGuardianRounds(v.rounds);
    if (rounds && rounds.length > 0) out.rounds = rounds;
  }
  if (v.filedFindings !== undefined) {
    const filed = sanitizeFiledFindings(v.filedFindings);
    if (filed) out.filedFindings = filed;
  }
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
  writeFileSync(path, JSON.stringify(state, null, 2));
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
 * Load run state, adapting unversioned (v0), v1, and v2 files in memory. v0 files
 * used a per-slice `status` field whose values were a strict subset of v1's
 * `phase` enum, so that migration is a field rename. v2 adds raw exact-stage
 * checkpoint storage whose focused reader owns validation. v3 adds adoption
 * provenance to terminal slice records. v4 adds the per-slice approved
 * baseline locator, which a v3 file simply does not have — it adapts to v4 in
 * memory with no locator and no write. Throws on unknown status strings
 * rather than silently producing an invalid record.
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
    r.version === 4
  ) {
    const slices: Record<string, PersistedSliceState> = {};
    for (const [id, val] of Object.entries(slicesIn)) {
      slices[id] = validateV1Slice(id, val);
    }
    const reviewPhase = sanitizeReviewPhase(r.reviewPhase);
    const resume = sanitizeResumeMap(r.resume);
    const migrations = sanitizeMigrationClaims(r.migrations);
    // A v3 file has no locator at all, which is exactly "no baseline
    // recorded" — the adapter adds nothing and writes nothing.
    const approvedBaselines = sanitizeApprovedBaselines(r.approvedBaselines);
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
 * Atomically replace cache fields and append completed guardian rounds.
 * Re-reads the file first so parallel slice updates and earlier valid rounds
 * are never clobbered. Pass `undefined` to clear the complete review phase.
 *
 * `filedFindings` is carried forward like `rounds` rather than replaced like the
 * caches. It is an append-only memory of issues that exist in the tracker, so
 * dropping it would make the next round file every note a second time — and the
 * round write that would drop it happens on every pass, before the filing
 * decision has even run.
 */
export function saveReviewPhase(
  repoRoot: string,
  prdSlug: string,
  reviewPhase: PersistedReviewPhase | undefined,
) {
  updateRunState(repoRoot, prdSlug, (current) => {
    if (reviewPhase === undefined) {
      delete current.reviewPhase;
    } else {
      const earlierRounds = current.reviewPhase?.rounds ?? [];
      const appendedRounds = reviewPhase.rounds ?? [];
      const filedFindings =
        reviewPhase.filedFindings ?? current.reviewPhase?.filedFindings;
      current.reviewPhase = {
        ...reviewPhase,
        ...(
          earlierRounds.length + appendedRounds.length > 0
            ? { rounds: [...earlierRounds, ...appendedRounds] }
            : {}
        ),
        ...(filedFindings ? { filedFindings } : {}),
      };
    }
  });
}

/**
 * Append filed-issue records, ignoring identities already recorded.
 *
 * A dedicated writer rather than a `saveReviewPhase` field, because filing
 * happens *after* the round has been persisted and the caches recomputed:
 * routing it through `saveReviewPhase` would re-enter the round-append path for
 * a write that has no round to add. Re-reads the file first, so a record
 * survives whatever else the ship gate wrote in between.
 */
export function saveFiledFindings(
  repoRoot: string,
  prdSlug: string,
  filed: readonly PersistedFiledFinding[],
) {
  if (filed.length === 0) return;
  updateRunState(repoRoot, prdSlug, (current) => {
    const reviewPhase = current.reviewPhase ?? {};
    const records = [...(reviewPhase.filedFindings ?? [])];
    for (const record of filed) {
      const duplicate = records.some(
        (existing) =>
          existing.guardian === record.guardian &&
          existing.stableId === record.stableId,
      );
      if (duplicate) continue;
      records.push(record);
    }
    current.reviewPhase = { ...reviewPhase, filedFindings: records };
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

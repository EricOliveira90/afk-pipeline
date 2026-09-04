import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { probeAdjudicationEstate } from "./adjudication-estate.js";
import type {
  GateDeclaration,
  GateResult,
  RunGatesOptions,
} from "./gate-runner.js";
import { runGates } from "./gate-runner.js";
import {
  createCandidateMerge,
  formatWorktreeSurvivorWarning,
  listWorktrees,
  removeWorktree,
  type RemoveWorktreeResult,
  resolveCommit,
  updateBranchIfUnchanged,
} from "./git.js";
import type { Slice } from "./issues-parser.js";
import { parseIssuesMd } from "./issues-parser.js";
import { resolveBaseGateDeclarations } from "./orchestrator.js";
import {
  featureBranchForProviderName,
  providerNameFromRunSlug,
  runSlugForProviderName,
  sliceWorktreeDirForProviderName,
} from "./run-identity.js";
import { resolveSanityPlan } from "./preship.js";
import { matchesSliceSelector } from "./resume.js";
import {
  listRunStateSlugs,
  loadRunState,
  sameSliceRecord,
  saveSliceStateIfUnchanged,
  type PersistedSliceState,
} from "./run-state.js";
import { traitsFor } from "./slice-lifecycle.js";

const DEFAULT_COMMAND_TIMEOUT_MS = 600_000;
const DEFAULT_GATE_WALL_CLOCK_TIMEOUT_MS = 7_200_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

interface GatePlan {
  declarations: readonly GateDeclaration[];
  prepare?: GateDeclaration;
}

interface BaseGateRun {
  cwd: string;
  treeId: string;
  evidenceDir: string;
  declarations: readonly GateDeclaration[];
  prepare?: GateDeclaration;
  onOutput?: (gateId: string, text: string) => void;
}

interface CandidateFinalization {
  repoRoot: string;
  featureBranch: string;
  candidateCommit: string;
  expectedFeatureCommit: string;
}

export interface AdoptDependencies {
  resolveGatePlan(cwd: string): GatePlan;
  /**
   * Worktree enumeration. Seam for the failure path: a lister that throws
   * must produce refusal 6, not a guess (ADR 0055 seam 2 decision 8).
   */
  listWorktrees?(repoRoot: string): ReturnType<typeof listWorktrees>;
  runBaseGates(options: BaseGateRun): Promise<readonly GateResult[]>;
  finalizeCandidate?(options: CandidateFinalization): boolean;
  /** Candidate teardown. Seam for the survivor path (ADR 0035). */
  removeWorktree?(
    repoRoot: string,
    worktreeDir: string,
  ): Promise<RemoveWorktreeResult>;
  /**
   * The second half of the finalization transaction. Keyed on the *run*
   * slug (`resolveRunSlug`), which is provider-qualified — not the PRD
   * slug the operator typed.
   *
   * Conditional, not a blind write: it takes the record adoption observed
   * before verification and refuses when the record on disk is no longer
   * that one (architect blocker 3). Implementations must not replace a
   * record they were not shown.
   */
  persistSliceState?(
    repoRoot: string,
    runSlug: string,
    ghIssue: string,
    result: Parameters<typeof saveSliceStateIfUnchanged>[3],
    expected: PersistedSliceState | undefined,
  ): ReturnType<typeof saveSliceStateIfUnchanged>;
}

export interface AdoptCliResult {
  output: string;
  exitCode: number;
}

interface ParsedAdoptArgs {
  prdSlug: string;
  slice: string;
  branch: string;
  adopter?: string;
  reason: string;
  provider?: string;
}

const USAGE =
  "Usage: afk adopt <prd-slug> <slice> --branch <branch> " +
  "--reason <reason> [--adopter <name>] [--provider <name>]";

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value?.startsWith("--") ? undefined : value;
}

function parseArgs(args: readonly string[]): ParsedAdoptArgs | null {
  const prdSlug = args[0];
  const slice = args[1]?.replace(/^#/, "");
  const branch = option(args, "--branch");
  const reason = option(args, "--reason");
  if (
    !prdSlug ||
    !slice ||
    !branch ||
    reason === undefined ||
    reason.trim() === ""
  ) {
    return null;
  }
  const adopter = option(args, "--adopter");
  const provider = option(args, "--provider");
  return {
    prdSlug,
    slice,
    branch,
    reason,
    ...(adopter !== undefined ? { adopter } : {}),
    ...(provider !== undefined ? { provider } : {}),
  };
}

/**
 * Which run state this adoption writes into.
 *
 * `pipelineRunSlug` keys a non-kiro run's state and feature branch on
 * `<prd-slug>-<provider>` / `feat-<provider>/<prd-slug>`, and adoption used
 * the bare PRD slug for both. `loadRunState` on a missing file returns a
 * fresh record defaulting to `feat/<prd-slug>`, so adopting a Codex or
 * Claude run refused with `Feature branch not found: feat/<prd-slug>` —
 * unusable for exactly the runs most likely to need the bypass valve, and
 * unable to write provenance into the state the pipeline later reads.
 *
 * So the run is *discovered* rather than assumed. `--provider` names it
 * outright; otherwise the state directory is matched the way
 * `logSlugMatches` matches log directories — the slug itself (kiro keeps
 * the bare name) or the slug plus a suffix. One candidate is the answer,
 * several is a refusal naming them, none is a refusal too: adoption needs
 * a real feature branch to move, and inventing `feat/<prd-slug>` for a run
 * that never existed only defers the failure to a worse place.
 *
 * ## Ownership is proved, never inferred from the filename
 *
 * The bare prefix match was not a caveat, it was a defect (PM blocker 2,
 * fifth adjudication gate round). `afk adopt api` in a repo with no
 * `api.json` but an unrelated `api-v2.json` accepted `api-v2` as "PRD `api`,
 * provider `v2`", exited 0, moved `feat/api-v2` and wrote the slice into
 * another PRD's run state. One candidate is not proof of anything; it is one
 * guess.
 *
 * So every candidate — from `--provider` too, which is only a spelling of
 * the same guess — has to prove it belongs to the PRD the operator named,
 * and the recorded feature branch is the proof. The run wrote it from its own
 * PRD slug and provider, so PRD `api` with provider `codex` records
 * `feat-codex/api`; the `api-v2` run records `feat/api-v2`, which is not the
 * branch `api` + `v2` would ever produce. A candidate whose branch does not
 * match is not this PRD's run and is refused by name rather than dropped
 * silently, because "I found a run I will not use" is information the
 * operator needs.
 */
function resolveRunSlug(
  repoRoot: string,
  prdSlug: string,
  provider: string | undefined,
): { runSlug: string } | { refusal: string } {
  const present = listRunStateSlugs(repoRoot);

  /**
   * Does this state file record the feature branch this PRD and provider
   * would have produced? An unreadable or unparseable state file proves
   * nothing, so it is a mismatch — adoption may not mutate a run it cannot
   * read.
   */
  const ownership = (
    runSlug: string,
  ): { ok: true } | { ok: false; because: string } => {
    const providerName = providerNameFromRunSlug(prdSlug, runSlug);
    const expected = featureBranchForProviderName(prdSlug, providerName);
    let recorded: string;
    try {
      recorded = loadRunState(repoRoot, runSlug).featureBranch;
    } catch (error) {
      return {
        ok: false,
        because: `.afk/state/${runSlug}.json could not be read — ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    if (recorded !== expected) {
      return {
        ok: false,
        because:
          `.afk/state/${runSlug}.json records feature branch '${recorded}', ` +
          `but PRD '${prdSlug}' with provider '${providerName}' uses ` +
          `'${expected}' — that state belongs to a different run`,
      };
    }
    return { ok: true };
  };

  if (provider !== undefined) {
    const runSlug = runSlugForProviderName(prdSlug, provider);
    if (!present.includes(runSlug)) {
      return {
        refusal:
          `no run state for provider '${provider}': expected ` +
          `.afk/state/${runSlug}.json` +
          (present.length > 0
            ? `. Run state present: ${present.join(", ")}`
            : ` and .afk/state holds no run state at all`),
      };
    }
    const owned = ownership(runSlug);
    if (!owned.ok) {
      return {
        refusal:
          `run state '${runSlug}' cannot be proved to belong to PRD ` +
          `'${prdSlug}': ${owned.because}. Adoption moves a feature branch ` +
          `and rewrites a slice record, so it will not act on a run whose ` +
          `ownership is only a name match.`,
      };
    }
    return { runSlug };
  }

  const named = present.filter(
    (slug) => slug === prdSlug || slug.startsWith(`${prdSlug}-`),
  );
  const owned: string[] = [];
  const rejected: string[] = [];
  for (const slug of named) {
    const result = ownership(slug);
    if (result.ok) owned.push(slug);
    else rejected.push(result.because);
  }

  if (owned.length === 0) {
    return {
      refusal:
        `no run state for '${prdSlug}' under .afk/state` +
        (present.length > 0
          ? `. Run state present: ${present.join(", ")}`
          : "") +
        (rejected.length > 0
          ? `. Name-matching state that is NOT this PRD's run: ${rejected.join("; ")}`
          : "") +
        `. Adoption moves an existing run's feature branch, so the run it ` +
        `adopts into must have state on disk.`,
    };
  }
  if (owned.length > 1) {
    return {
      refusal:
        `'${prdSlug}' has more than one run state: ${owned.join(", ")}. ` +
        `Pass --provider <name> to name the run being adopted into.`,
    };
  }
  return { runSlug: owned[0]! };
}

/**
 * Resolve whatever the operator typed for `<slice>` to the identity the
 * pipeline is keyed on.
 *
 * `saveSliceState` and `isSliceComplete` key on the GitHub issue ID, but
 * `afk adopt <prd-slug> <slice>` invites a manifest slice number — and
 * the two differ for every PRD whose slices are not numbered by issue.
 * A PASS written under `06` leaves `#129` incomplete, so a later run
 * re-dispatches an already-adopted slice and its provenance names a
 * slice number no issue tracker knows. Resolution happens before any
 * mutation: an identifier the manifest does not declare is refused with
 * every ref and the state file untouched.
 */
function resolveSliceIdentity(
  repoRoot: string,
  prdSlug: string,
  entered: string,
): { slice: Slice } | { refusal: string } {
  const issuesPath = join(repoRoot, ".kiro", "specs", prdSlug, "issues.md");
  if (!existsSync(issuesPath)) {
    return {
      refusal:
        `cannot resolve slice ${entered} to a GitHub issue: ${issuesPath} ` +
        `not found. Adoption writes run state under the issue ID the ` +
        `pipeline is keyed on, so the slice manifest must be readable.`,
    };
  }
  let slices: Slice[];
  try {
    slices = parseIssuesMd(issuesPath);
  } catch (error) {
    return {
      refusal: `cannot read ${issuesPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  const matches = slices.filter((slice) =>
    matchesSliceSelector([entered], slice),
  );
  if (matches.length === 0) {
    return {
      refusal:
        `slice ${entered} is not declared in ${issuesPath}. Pass a slice ` +
        `number or GitHub issue ID from its slice table.`,
    };
  }
  if (matches.length > 1) {
    return {
      refusal:
        `slice ${entered} is ambiguous in ${issuesPath}: it names ` +
        matches
          .map((slice) => `${slice.number} (#${slice.ghIssue})`)
          .join(", ") +
        `. Pass the GitHub issue ID.`,
    };
  }
  return { slice: matches[0]! };
}

/**
 * Registered worktrees that have `branch` checked out.
 *
 * `updateBranchIfUnchanged` moves a ref, and a ref is only half of a
 * checked-out branch's identity: advancing it behind a worktree leaves
 * that worktree's index and files at the old tree while `git status`
 * reports the whole difference as staged work (ADR 0010). Adoption
 * refuses rather than guessing which of the two the operator meant.
 *
 * Enumeration failure is its own refusal, not an empty list: `[]` said
 * "no worktree holds this branch", so a git that could not answer read
 * as a proof of absence and let the `update-ref` through — the one
 * mutation that can corrupt a checked-out worktree. Fail closed
 * instead (ADR 0055 seam 2 decision 8; refusal 6 in ADR 0053).
 */
function enumerateWorktrees(
  repoRoot: string,
  list: (repoRoot: string) => ReturnType<typeof listWorktrees>,
): { worktrees: ReturnType<typeof listWorktrees> } | { refusal: string } {
  try {
    return { worktrees: list(repoRoot) };
  } catch (error) {
    return {
      refusal: `could not enumerate worktrees — ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

function worktreesHolding(
  worktrees: ReturnType<typeof listWorktrees>,
  branch: string,
): string[] {
  const name = branch.replace(/^refs\/heads\//, "");
  return worktrees
    .filter((worktree) => worktree.branch === name)
    .map((worktree) => worktree.path);
}

function normalisePath(p: string): string {
  const n = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? n.toLowerCase() : n;
}

/**
 * Refuse an adoption that would strand a parked slice's adjudication
 * estate (ADR 0055 Seam 2; refusal 7 in ADR 0053's list).
 *
 * A successful adoption overwrites the slice's persisted record with `PASS`
 * and moves the feature ref — but it is not a dispatch, and Seam 2's
 * invariant says only the slice's own re-dispatch replaces a park. Nothing
 * here reconciles the estate, so the park's registered worktree survives
 * with no live slice owning it: the next launch excludes completed slices
 * from both `intended` and `retained`, preflight classifies that worktree
 * as a leftover, and the run refuses (`leftover-worktree`). The operator's
 * bypass valve would have bricked their next launch.
 *
 * So the check is a refusal, not a reconciliation. Quiescing the estate
 * *for* the operator would mean deleting a human's pending adjudication
 * worktree inside a command that never mentions it — the same
 * "disposability inferred, not proved" mistake `clean-failed` made. The
 * refusal names the estate and the two ways forward, and the park stays
 * byte-for-byte intact.
 *
 * Ownership is read off **disk**, not off the phase (ADR 0055 Seam 2 §6/§8,
 * fourth adjudication gate round). Two independent leaks made the earlier
 * phase-keyed form miss estates it existed to protect:
 *
 * - The estate can be left behind by any post-decision apply exit — a
 *   planner failure, a feature-refresh conflict, a cancellation mid-apply —
 *   and those end in ordinary `ERROR`/`CONFLICT`, not in a `preserve-all`
 *   phase. `probeAdjudicationEstate` asks the worktree instead, so it does
 *   not matter which exit was taken.
 * - Holders were matched by branch alone, and `listWorktrees` reports a
 *   detached worktree with `branch: null`. A registered worktree at the
 *   slice's expected path therefore slipped past the guard entirely. It is
 *   now matched by expected path as well, and a detached or
 *   wrong-branch worktree there fails closed rather than reading as
 *   absence.
 */
function adjudicationEstateRefusal(
  record: PersistedSliceState | undefined,
  ghIssue: string,
  worktrees: ReturnType<typeof listWorktrees>,
  expectedWorktreeDir: string,
  specsDir: string | undefined,
): string | null {
  const expected = normalisePath(expectedWorktreeDir);
  const registeredAtExpected = worktrees.filter(
    (worktree) => normalisePath(worktree.path) === expected,
  );
  const byBranch = record?.branch
    ? worktreesHolding(worktrees, record.branch)
    : [];
  // Registered paths first: git's own spelling is what `git worktree
  // remove` takes, and the refusal is meant to be pasteable.
  const candidatePaths = [
    ...new Set([
      ...registeredAtExpected.map((w) => w.path),
      ...byBranch,
      expectedWorktreeDir,
    ]),
  ];

  // 1. The disk fact, independent of both the phase and the branch: does
  //    any candidate worktree still hold the impasse record or the decision
  //    log? This is the term that covers every apply exit.
  for (const path of candidatePaths) {
    const probe = probeAdjudicationEstate(path, { specsDir });
    // An unfinished probe is not proof that the estate is gone (ADR 0055
    // Seam 2 §8; architect blocker 2, fifth round). Adoption overwrites the
    // slice record and moves a ref, so it refuses by name instead.
    if (probe.status === "indeterminate") {
      return (
        `whether slice #${ghIssue} still owns a live adjudication estate in ` +
        `${path} could not be established (${probe.reason})` +
        (record ? `; the run recorded ${record.phase}` : "") +
        `. Adoption would replace that estate with PASS without a dispatch, ` +
        `and absence may not be inferred from a probe that did not finish ` +
        `(ADR 0055 Seam 2 §8) — fix the cause, or inspect the directory and ` +
        `remove it yourself, then run adopt again.`
      );
    }
    if (probe.status === "absent") continue;
    const estate = probe.estate;
    return (
      `slice #${ghIssue} still owns a live adjudication estate in ` +
      `${path} (${estate.evidence})` +
      (record ? `; the run recorded ${record.phase}` : "") +
      (record?.branch ? ` on ${record.branch}` : "") +
      `. Adoption would replace that estate with PASS without a dispatch, ` +
      `and the next launch then refuses the worktree as a leftover no live ` +
      `slice owns. Only the slice's own re-dispatch replaces it (ADR 0055 ` +
      `Seam 2): either ${forwardPath(record)}, or remove the worktree ` +
      `yourself (\`git worktree remove\`) — its branch and recorded ` +
      `decisions survive that — and run adopt again.`
    );
  }

  if (!record || traitsFor(record.phase).debris !== "preserve-all") return null;

  // 2. The record says a human owes input but the disk showed nothing.
  //    Absence has to be proved, so anything ambiguous refuses.
  if (!record.branch) {
    return (
      `slice #${ghIssue} is recorded ${record.phase} in run state with no ` +
      `branch, so which worktree its parked estate holds cannot be proved. ` +
      `A park's estate survives every lifecycle operation but its own ` +
      `re-dispatch (ADR 0055 Seam 2), and adoption is not one — inspect ` +
      `.afk/worktrees and the slice directory, then re-run adopt once the ` +
      `record names its branch.`
    );
  }
  const ambiguous = registeredAtExpected.filter(
    (worktree) => worktree.branch !== record.branch!.replace(/^refs\/heads\//, ""),
  );
  if (ambiguous.length > 0) {
    return (
      `slice #${ghIssue} is recorded ${record.phase} and a worktree is ` +
      `registered at its expected path ${ambiguous[0]!.path} with ` +
      `${ambiguous[0]!.branch === null ? "a detached HEAD" : `${ambiguous[0]!.branch} checked out`} ` +
      `instead of ${record.branch}. Whether that worktree is the park's ` +
      `estate cannot be proved, and adoption may not infer absence (ADR ` +
      `0055 Seam 2 §8) — inspect it, then either let the slice's own ` +
      `re-dispatch reconcile it or remove it yourself and run adopt again.`
    );
  }
  if (byBranch.length === 0) return null;
  return (
    `slice #${ghIssue} is recorded ${record.phase} and its adjudication ` +
    `estate is still live: ${byBranch.join(", ")} ${
      byBranch.length === 1 ? "is a" : "are"
    } registered worktree${byBranch.length === 1 ? "" : "s"} on ` +
    `${record.branch}. Adoption would replace that estate with PASS without ` +
    `a dispatch, and the next launch then refuses the worktree as a leftover ` +
    `no live slice owns. Only the slice's own re-dispatch replaces it ` +
    `(ADR 0055 Seam 2): either ${forwardPath(record)}, or remove the parked ` +
    `worktree yourself (\`git worktree remove\`) — its branch and recorded ` +
    `decisions survive that — and run adopt again.`
  );
}

/**
 * What the operator does next. A park still needs a human decision; a
 * refused lock already has its decisions and needs the base fixed; any
 * other phase holding an estate got there by an apply exit, so the
 * decisions are recorded and a re-dispatch retries them.
 */
function forwardPath(record: PersistedSliceState | undefined): string {
  if (record?.phase === "AWAITING-ADJUDICATION") {
    return (
      `write the pending decision into adjudication.md and let the ` +
      `pipeline finish the slice`
    );
  }
  if (record?.phase === "ADJUDICATION-LOCK-REFUSED") {
    return (
      `fix the base the lock gate objected to (typically renumber the ` +
      `colliding migration prefix) and let the slice's own re-dispatch ` +
      `re-run the gate`
    );
  }
  return (
    `let the slice's own re-dispatch retry the recorded decisions from ` +
    `where the apply stopped`
  );
}

function resolveAdopter(repoRoot: string, explicit: string | undefined): string {
  const candidates = [explicit, process.env.GITHUB_ACTOR];
  try {
    candidates.push(
      execFileSync("git", ["config", "user.name"], {
        cwd: repoRoot,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
  } catch {
    // The validation below reports the missing identity.
  }
  const adopter = candidates.find((candidate) => candidate?.trim());
  if (!adopter) {
    throw new Error(
      "No adopter identity resolved; pass --adopter or configure git user.name",
    );
  }
  return adopter.trim();
}

function defaultGatePlan(cwd: string): GatePlan {
  const sanity = resolveSanityPlan(cwd);
  return {
    declarations: resolveBaseGateDeclarations(cwd),
    ...(sanity.prepare
      ? {
          prepare: {
            id: sanity.prepare.name,
            stage: "base",
            required: true,
            command: sanity.prepare.command,
            args: [...sanity.prepare.args],
          },
        }
      : {}),
  };
}

async function defaultRunBaseGates(
  options: BaseGateRun,
): Promise<readonly GateResult[]> {
  const runOptions: RunGatesOptions = {
    ...options,
    inactivityTimeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
    wallClockTimeoutMs: DEFAULT_GATE_WALL_CLOCK_TIMEOUT_MS,
    heartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
  };
  return (await runGates(runOptions)).evidence.results;
}

const DEFAULT_DEPS: AdoptDependencies = {
  resolveGatePlan: defaultGatePlan,
  listWorktrees,
  runBaseGates: defaultRunBaseGates,
  finalizeCandidate: (options) => defaultFinalizeCandidate(options),
  removeWorktree: (repoRoot, worktreeDir) =>
    removeWorktree(repoRoot, worktreeDir),
  persistSliceState: saveSliceStateIfUnchanged,
};

/** How a slice record reads in a refusal: the phase, or that there was none. */
function describeRecord(record: PersistedSliceState | undefined): string {
  if (!record) return "absent (no recorded outcome)";
  return record.phase + (record.branch ? ` on ${record.branch}` : "");
}

function defaultFinalizeCandidate({
  repoRoot,
  featureBranch,
  candidateCommit,
  expectedFeatureCommit,
}: CandidateFinalization): boolean {
  return updateBranchIfUnchanged(
    repoRoot,
    featureBranch,
    candidateCommit,
    expectedFeatureCommit,
  );
}

function firstFailedGate(
  declarations: readonly GateDeclaration[],
  results: readonly GateResult[],
): { declaration: GateDeclaration; result?: GateResult } | undefined {
  for (const declaration of declarations) {
    const result = results.find(
      (candidate) => candidate.gateId === declaration.id,
    );
    const passed =
      result?.status === "PASS" ||
      (!declaration.required && result?.status === "SKIPPED");
    if (!passed) return { declaration, ...(result ? { result } : {}) };
  }
  return undefined;
}

export async function runAdoptCli(
  args: readonly string[],
  repoRoot: string,
  dependencies: AdoptDependencies = DEFAULT_DEPS,
): Promise<AdoptCliResult> {
  const parsed = parseArgs(args);
  if (!parsed) return { output: USAGE, exitCode: 2 };

  let adopter: string;
  try {
    adopter = resolveAdopter(repoRoot, parsed.adopter);
  } catch (error) {
    return {
      output: `Adoption refused: ${
        error instanceof Error ? error.message : String(error)
      }`,
      exitCode: 1,
    };
  }

  const identity = resolveSliceIdentity(repoRoot, parsed.prdSlug, parsed.slice);
  if ("refusal" in identity) {
    return { output: `Adoption refused: ${identity.refusal}`, exitCode: 1 };
  }
  const { slice } = identity;

  const run = resolveRunSlug(repoRoot, parsed.prdSlug, parsed.provider);
  if ("refusal" in run) {
    return { output: `Adoption refused: ${run.refusal}`, exitCode: 1 };
  }
  const { runSlug } = run;

  const state = loadRunState(repoRoot, runSlug);
  const expectedWorktreeDir = sliceWorktreeDirForProviderName(
    repoRoot,
    parsed.prdSlug,
    slice.number,
    providerNameFromRunSlug(parsed.prdSlug, runSlug),
  );

  /**
   * Everything that can change while base gates run, asked once.
   *
   * Base gate verification takes minutes, and the pre-verification answers
   * used to be the only ones adoption ever had: worktrees were enumerated
   * once, the estate refusal ran once, and the slice record was read once.
   * A concurrent run can park this very slice inside that window without
   * moving the feature branch — so the feature-ref CAS still succeeds and
   * the unconditional state write turns `AWAITING-ADJUDICATION` into `PASS`,
   * stranding a live estate (architect blocker 3, fifth adjudication gate
   * round). Every one of these checks is therefore re-run immediately before
   * finalization, against freshly read state and a fresh enumeration.
   */
  const inspect = ():
    | { ok: true; record: PersistedSliceState | undefined }
    | { ok: false; refusal: string } => {
    const enumeration = enumerateWorktrees(
      repoRoot,
      dependencies.listWorktrees ?? listWorktrees,
    );
    if ("refusal" in enumeration) {
      return { ok: false, refusal: enumeration.refusal };
    }
    const { worktrees } = enumeration;
    let current: ReturnType<typeof loadRunState>;
    try {
      current = loadRunState(repoRoot, runSlug);
    } catch (error) {
      return {
        ok: false,
        refusal: `run state ${runSlug} could not be re-read — ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    const record = current.slices[slice.ghIssue];

    // Before candidate creation or any ref mutation, like every other
    // adoption refusal: a slice that still owns an adjudication estate.
    const parked = adjudicationEstateRefusal(
      record,
      slice.ghIssue,
      worktrees,
      expectedWorktreeDir,
      current.specsDir,
    );
    if (parked) return { ok: false, refusal: parked };

    const holders = worktreesHolding(worktrees, state.featureBranch);
    if (holders.length > 0) {
      return {
        ok: false,
        refusal:
          `${state.featureBranch} is checked out in ${holders.join(", ")}. ` +
          `Advancing the ref would leave that worktree's index and files at ` +
          `the old tree. Check out another branch there, then run adopt again.`,
      };
    }
    return { ok: true, record };
  };

  const before = inspect();
  if (!before.ok) {
    return { output: `Adoption refused: ${before.refusal}`, exitCode: 1 };
  }
  /** The record the whole adoption is conditional on. */
  const observedRecord = before.record;

  const attemptId = randomUUID();
  const candidateDir = join(repoRoot, ".afk", "adopt", attemptId, "candidate");
  // Under the run slug, alongside the pipeline's own log directory for the
  // same run — provider-qualified, so two providers' adoptions of one PRD
  // do not land in the same tree.
  const evidenceDir = join(
    repoRoot,
    ".afk",
    "logs",
    runSlug,
    "adoptions",
    attemptId,
  );

  let candidate;
  try {
    candidate = await createCandidateMerge(
      repoRoot,
      parsed.branch,
      state.featureBranch,
      candidateDir,
    );
  } catch (error) {
    return {
      output: `Adoption refused: ${
        error instanceof Error ? error.message : String(error)
      }`,
      exitCode: 1,
    };
  }
  if (candidate.status === "conflict") {
    return {
      output: `Adoption refused: merge conflict: ${candidate.details}`,
      exitCode: 1,
    };
  }

  // The candidate worktree's lifetime is this block, so teardown runs on
  // every exit — including a `resolveGatePlan` throw, which used to
  // escape before any cleanup and leave the detached worktree registered
  // (ADR 0035 decision 5, ADR 0042 decision 1). The teardown *result* is
  // then inspected: a surviving directory is residue that refuses the
  // next launch, so adoption reports it and stops rather than moving the
  // feature ref behind a host that still needs cleaning.
  let gatePlan: GatePlan | undefined;
  let gateResults: readonly GateResult[] | undefined;
  let verificationError: string | undefined;
  let survivor: string | undefined;
  try {
    gatePlan = dependencies.resolveGatePlan(candidate.worktreeDir);
    gateResults = await dependencies.runBaseGates({
      cwd: candidate.worktreeDir,
      treeId: candidate.treeId,
      evidenceDir,
      declarations: gatePlan.declarations,
      ...(gatePlan.prepare ? { prepare: gatePlan.prepare } : {}),
      onOutput: (_gateId, text) => process.stderr.write(text),
    });
  } catch (error) {
    verificationError =
      error instanceof Error ? error.message : String(error);
  } finally {
    const teardown = await (dependencies.removeWorktree ?? removeWorktree)(
      repoRoot,
      candidate.worktreeDir,
    );
    if (!teardown.removed) {
      survivor = formatWorktreeSurvivorWarning(
        "candidate merge worktree",
        candidate.worktreeDir,
        teardown,
      );
    }
  }
  if (verificationError !== undefined || survivor !== undefined) {
    const parts = [verificationError, survivor].filter(
      (part): part is string => part !== undefined,
    );
    return { output: `Adoption refused: ${parts.join("; ")}`, exitCode: 1 };
  }

  if (gatePlan === undefined || gateResults === undefined) {
    return {
      output: "Adoption refused: base gate verification produced no result.",
      exitCode: 1,
    };
  }

  const failedGate = firstFailedGate(gatePlan.declarations, gateResults);
  if (failedGate) {
    return {
      output:
        `Adoption refused: base gate ${failedGate.declaration.id} failed` +
        `${failedGate.result ? ` (${failedGate.result.status})` : " (no result)"}.`,
      exitCode: 1,
    };
  }

  if (resolveCommit(repoRoot, parsed.branch) !== candidate.sliceCommit) {
    return {
      output: "Adoption refused: a branch changed during verification.",
      exitCode: 1,
    };
  }

  // Re-ask everything that could have changed while the gates ran, before
  // the ref moves (architect blocker 3). A refusal here costs nothing: no
  // ref has been touched and no state written.
  const after = inspect();
  if (!after.ok) {
    return {
      output:
        `Adoption refused: ${after.refusal} (detected on the re-check ` +
        `immediately before finalization; nothing was adopted).`,
      exitCode: 1,
    };
  }
  if (!sameSliceRecord(after.record, observedRecord)) {
    return {
      output:
        `Adoption refused: slice #${slice.ghIssue}'s run-state record changed ` +
        `while base gates ran — it was ` +
        `${describeRecord(observedRecord)} and is now ` +
        `${describeRecord(after.record)}. Another run owns this slice's ` +
        `outcome now, and only the slice's own re-dispatch replaces it (ADR ` +
        `0055 Seam 2); ${state.featureBranch} was not moved and nothing was ` +
        `adopted. Re-run adopt once that run has finished with it.`,
      exitCode: 1,
    };
  }

  const finalized = (
    dependencies.finalizeCandidate ?? defaultFinalizeCandidate
  )({
    repoRoot,
    featureBranch: state.featureBranch,
    candidateCommit: candidate.candidateCommit,
    expectedFeatureCommit: candidate.featureCommit,
  });
  if (!finalized) {
    return {
      output: "Adoption refused: a branch changed during verification.",
      exitCode: 1,
    };
  }

  // The ref has moved; the state write is the other half of the same
  // transaction (ADR 0042 puts the state<->branch invariant here, at
  // write time). A throw between them would record merged code as
  // incomplete with no reconciliation path, so the ref is put back with
  // a guarded CAS and the refusal names both outcomes.
  // Conditional on the record observed before verification, not
  // unconditional: the re-check above narrows the race window to the ref
  // update, and this closes it. A lost CAS rolls the ref back, exactly like
  // a throw does — the two failures leave the same inconsistency, so they
  // get the same repair.
  const rollBack = () =>
    updateBranchIfUnchanged(
      repoRoot,
      state.featureBranch,
      candidate.featureCommit,
      candidate.candidateCommit,
    );
  const rollbackNote = (rolledBack: boolean) =>
    rolledBack
      ? `${state.featureBranch} was rolled back to ` +
        `${candidate.featureCommit}; nothing was adopted.`
      : `${state.featureBranch} could NOT be rolled back from ` +
        `${candidate.candidateCommit} to ${candidate.featureCommit} ` +
        `— the merge is on the branch but no state records it; ` +
        `reset the branch or re-run adopt once the state file is ` +
        `writable.`;

  try {
    const persisted = (
      dependencies.persistSliceState ?? saveSliceStateIfUnchanged
    )(
      repoRoot,
      runSlug,
      slice.ghIssue,
      {
        phase: "PASS",
        mergedToFeature: true,
        branch: parsed.branch,
        adoption: {
          adopter,
          reason: parsed.reason,
          branch: parsed.branch,
          commit: candidate.sliceCommit,
        },
      },
      observedRecord,
    );
    if (!persisted.ok) {
      const rolledBack = rollBack();
      return {
        output:
          `Adoption refused: slice #${slice.ghIssue}'s run-state record ` +
          `changed between the pre-finalization re-check and the state ` +
          `write — it was ${describeRecord(observedRecord)} and is now ` +
          `${describeRecord(persisted.found)}. Only the slice's own ` +
          `re-dispatch replaces that record (ADR 0055 Seam 2). ` +
          rollbackNote(rolledBack),
        exitCode: 1,
      };
    }
  } catch (error) {
    const rolledBack = rollBack();
    return {
      output:
        `Adoption refused: recording slice #${slice.ghIssue} failed: ${
          error instanceof Error ? error.message : String(error)
        }. ` + rollbackNote(rolledBack),
      exitCode: 1,
    };
  }
  return {
    output:
      `Adopted slice #${slice.ghIssue} from ${parsed.branch} into ` +
      `${state.featureBranch} (verified commit ${candidate.sliceCommit}).`,
    exitCode: 0,
  };
}

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
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
import {
  resolveBaseGateDeclarations,
  runSlugForProviderName,
} from "./orchestrator.js";
import { resolveSanityPlan } from "./preship.js";
import { matchesSliceSelector } from "./resume.js";
import {
  listRunStateSlugs,
  loadRunState,
  saveSliceState,
} from "./run-state.js";

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
   */
  persistSliceState?(
    repoRoot: string,
    runSlug: string,
    ghIssue: string,
    result: Parameters<typeof saveSliceState>[3],
  ): void;
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
 * The prefix match can also catch a PRD slug that starts with this one —
 * the same caveat `afk stop` carries. That surfaces as the ambiguity
 * refusal, which names every candidate, rather than as a silent wrong pick.
 */
function resolveRunSlug(
  repoRoot: string,
  prdSlug: string,
  provider: string | undefined,
): { runSlug: string } | { refusal: string } {
  const present = listRunStateSlugs(repoRoot);
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
    return { runSlug };
  }

  const candidates = present.filter(
    (slug) => slug === prdSlug || slug.startsWith(`${prdSlug}-`),
  );
  if (candidates.length === 0) {
    return {
      refusal:
        `no run state for '${prdSlug}' under .afk/state` +
        (present.length > 0
          ? `. Run state present: ${present.join(", ")}`
          : "") +
        `. Adoption moves an existing run's feature branch, so the run it ` +
        `adopts into must have state on disk.`,
    };
  }
  if (candidates.length > 1) {
    return {
      refusal:
        `'${prdSlug}' has more than one run state: ${candidates.join(", ")}. ` +
        `Pass --provider <name> to name the run being adopted into.`,
    };
  }
  return { runSlug: candidates[0]! };
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
 */
function worktreesHolding(repoRoot: string, branch: string): string[] {
  const name = branch.replace(/^refs\/heads\//, "");
  try {
    return listWorktrees(repoRoot)
      .filter((worktree) => worktree.branch === name)
      .map((worktree) => worktree.path);
  } catch {
    // A repo git cannot enumerate cannot be adopted into either; the
    // candidate merge below reports the underlying problem.
    return [];
  }
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
  runBaseGates: defaultRunBaseGates,
  finalizeCandidate: (options) => defaultFinalizeCandidate(options),
  removeWorktree: (repoRoot, worktreeDir) =>
    removeWorktree(repoRoot, worktreeDir),
  persistSliceState: saveSliceState,
};

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

  const holders = worktreesHolding(repoRoot, state.featureBranch);
  if (holders.length > 0) {
    return {
      output:
        `Adoption refused: ${state.featureBranch} is checked out in ` +
        `${holders.join(", ")}. Advancing the ref would leave that ` +
        `worktree's index and files at the old tree. Check out another ` +
        `branch there, then run adopt again.`,
      exitCode: 1,
    };
  }

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
  try {
    (dependencies.persistSliceState ?? saveSliceState)(
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
    );
  } catch (error) {
    const rolledBack = updateBranchIfUnchanged(
      repoRoot,
      state.featureBranch,
      candidate.featureCommit,
      candidate.candidateCommit,
    );
    return {
      output:
        `Adoption refused: recording slice #${slice.ghIssue} failed: ${
          error instanceof Error ? error.message : String(error)
        }. ` +
        (rolledBack
          ? `${state.featureBranch} was rolled back to ` +
            `${candidate.featureCommit}; nothing was adopted.`
          : `${state.featureBranch} could NOT be rolled back from ` +
            `${candidate.candidateCommit} to ${candidate.featureCommit} ` +
            `— the merge is on the branch but no state records it; ` +
            `reset the branch or re-run adopt once the state file is ` +
            `writable.`),
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

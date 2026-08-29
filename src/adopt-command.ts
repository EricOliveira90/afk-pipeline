import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
  GateDeclaration,
  GateResult,
  RunGatesOptions,
} from "./gate-runner.js";
import { runGates } from "./gate-runner.js";
import {
  createCandidateMerge,
  mergeSliceBranch,
  removeWorktree,
  resolveCommit,
  resolveTree,
} from "./git.js";
import { resolveBaseGateDeclarations } from "./orchestrator.js";
import { resolveSanityPlan } from "./preship.js";
import { loadRunState, saveSliceState } from "./run-state.js";

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

export interface AdoptDependencies {
  resolveGatePlan(cwd: string): GatePlan;
  runBaseGates(options: BaseGateRun): Promise<readonly GateResult[]>;
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
}

const USAGE =
  "Usage: afk adopt <prd-slug> <slice> --branch <branch> " +
  "--reason <reason> [--adopter <name>]";

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
  return {
    prdSlug,
    slice,
    branch,
    reason,
    ...(adopter !== undefined ? { adopter } : {}),
  };
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
};

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

  const state = loadRunState(repoRoot, parsed.prdSlug);
  const attemptId = randomUUID();
  const candidateDir = join(repoRoot, ".afk", "adopt", attemptId, "candidate");
  const scratchMergeDir = join(repoRoot, ".afk", "adopt", attemptId, "merge");
  const evidenceDir = join(
    repoRoot,
    ".afk",
    "logs",
    parsed.prdSlug,
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

  const gatePlan = dependencies.resolveGatePlan(candidate.worktreeDir);
  let gateResults: readonly GateResult[];
  try {
    gateResults = await dependencies.runBaseGates({
      cwd: candidate.worktreeDir,
      treeId: candidate.treeId,
      evidenceDir,
      declarations: gatePlan.declarations,
      ...(gatePlan.prepare ? { prepare: gatePlan.prepare } : {}),
      onOutput: (_gateId, text) => process.stderr.write(text),
    });
  } catch (error) {
    await removeWorktree(repoRoot, candidate.worktreeDir);
    return {
      output: `Adoption refused: ${
        error instanceof Error ? error.message : String(error)
      }`,
      exitCode: 1,
    };
  }
  await removeWorktree(repoRoot, candidate.worktreeDir);

  const failedGate = firstFailedGate(gatePlan.declarations, gateResults);
  if (failedGate) {
    return {
      output:
        `Adoption refused: base gate ${failedGate.declaration.id} failed` +
        `${failedGate.result ? ` (${failedGate.result.status})` : " (no result)"}.`,
      exitCode: 1,
    };
  }

  if (
    resolveCommit(repoRoot, state.featureBranch) !== candidate.featureCommit ||
    resolveCommit(repoRoot, parsed.branch) !== candidate.sliceCommit
  ) {
    return {
      output: "Adoption refused: a branch changed during verification.",
      exitCode: 1,
    };
  }

  const merge = await mergeSliceBranch(
    repoRoot,
    candidate.sliceCommit,
    state.featureBranch,
    scratchMergeDir,
  );
  if (merge.status === "conflict") {
    return {
      output: `Adoption refused: merge conflict: ${merge.details}`,
      exitCode: 1,
    };
  }
  if (resolveTree(repoRoot, state.featureBranch) !== candidate.treeId) {
    return {
      output:
        "Adoption refused: merged tree differs from the verified candidate.",
      exitCode: 1,
    };
  }

  saveSliceState(repoRoot, parsed.prdSlug, parsed.slice, {
    phase: "PASS",
    mergedToFeature: true,
    branch: parsed.branch,
    adoption: {
      adopter,
      reason: parsed.reason,
      branch: parsed.branch,
      commit: candidate.sliceCommit,
    },
  });
  return {
    output:
      `Adopted slice #${parsed.slice} from ${parsed.branch} into ` +
      `${state.featureBranch} (verified commit ${candidate.sliceCommit}).`,
    exitCode: 0,
  };
}

import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { type Slice, type DAG } from "./issues-parser.js";
import * as git from "./git.js";
import type { AgentProvider } from "./agent-provider.js";
import * as artifacts from "./artifacts.js";
import { Logger } from "./logger.js";
import { partitionLanes } from "./lanes.js";
import type { PipelineConfig } from "./orchestrator.js";
import {
  makeSliceContext,
  runSliceNegotiate,
  runSliceExecute,
  sliceBranch,
  sliceBranchPrefix,
  isCancelled,
} from "./orchestrator.js";
import { kiroProvider } from "./kiro.js";

export type WaveOutcomePhase =
  | "PASS"
  | "STUCK"
  | "ESCALATE"
  | "ERROR"
  | "CANCELLED"
  | "CONFLICT"
  | "LANE-CANCELLED";

export type WaveOutcome =
  | { phase: "PASS" }
  | {
      phase: Exclude<WaveOutcomePhase, "PASS">;
      error: string;
    };

export interface WaveInput {
  waveNumber: number;
  readyIds: string[];
  config: PipelineConfig;
  dag: DAG;
  logger: Logger;
  featBranch: string;
  relevantFilesBlock: string;
  testCommand: string;
  mergeMutex: <T>(fn: () => Promise<T>) => Promise<T>;
}

export interface WaveResult {
  outcomes: Map<string, WaveOutcome>;
}

const PASS: WaveOutcome = { phase: "PASS" };

export async function runWave(input: WaveInput): Promise<WaveResult> {
  const {
    waveNumber,
    readyIds,
    config,
    dag,
    logger,
    featBranch,
    relevantFilesBlock,
    testCommand,
    mergeMutex,
  } = input;
  const { repoRoot, prdSlug, signal } = config;
  const provider = config.provider ?? kiroProvider;
  const outcomes = new Map<string, WaveOutcome>();

  console.error(
    `[afk] Wave ${waveNumber}: dispatching ${readyIds.length} slice(s) [${readyIds.join(", ")}]`,
  );

  // Build a SliceContext per slice.
  const ctxById = new Map<string, ReturnType<typeof makeSliceContext>>();
  for (const id of readyIds) {
    const slice = dag.slices.get(id)!;
    ctxById.set(
      id,
      makeSliceContext(
        config,
        slice,
        logger,
        featBranch,
        relevantFilesBlock,
        testCommand,
      ),
    );
  }

  // --- Phase A: negotiate in parallel. ---
  const negotiateOutcomes = await Promise.allSettled(
    readyIds.map(async (id) => {
      const ctx = ctxById.get(id)!;
      const result = await runSliceNegotiate(ctx);
      return { id, result };
    }),
  );

  // Collect slices that landed at LOCKED. Mark the rest in outcomes.
  const lockedIds: string[] = [];
  for (let i = 0; i < negotiateOutcomes.length; i++) {
    const r = negotiateOutcomes[i]!;
    const id = readyIds[i]!;

    if (r.status === "rejected") {
      if (isCancelled(r.reason, signal)) {
        outcomes.set(id, { phase: "CANCELLED", error: "Cancelled by user" });
      } else {
        outcomes.set(id, {
          phase: "ERROR",
          error: `Unhandled rejection in negotiate: ${r.reason}`,
        });
      }
      continue;
    }

    const { result } = r.value;
    if (result === "LOCKED") {
      lockedIds.push(id);
      continue;
    }

    // Phase A returns ESCALATE / STUCK / ERROR / CANCELLED on non-LOCKED.
    if (result === "CANCELLED") {
      outcomes.set(id, { phase: "CANCELLED", error: "Cancelled by user" });
    } else if (result === "ESCALATE") {
      outcomes.set(id, {
        phase: "ESCALATE",
        error: "Contract negotiation escalated after max rounds",
      });
    } else if (result === "STUCK") {
      outcomes.set(id, {
        phase: "STUCK",
        error: "Contract not locked after negotiation",
      });
    } else {
      outcomes.set(id, {
        phase: "ERROR",
        error: "Negotiation returned ERROR",
      });
    }
  }

  // Cancellation short-circuit between phases.
  if (signal?.aborted) {
    for (const id of readyIds) {
      if (!outcomes.has(id)) {
        outcomes.set(id, { phase: "CANCELLED", error: "Cancelled by user" });
      }
    }
    return { outcomes };
  }

  // --- Read each LOCKED slice's "Files expected to change" list. ---
  const readyForLanes: Slice[] = [];
  for (const id of lockedIds) {
    const slice = dag.slices.get(id)!;
    const ctx = ctxById.get(id)!;
    const contractPath = join(ctx.absSliceDir, "contract.md");
    slice.files = artifacts.readContractFiles(contractPath);
    readyForLanes.push(slice);
  }

  // --- Partition into lanes. ---
  const lanes = partitionLanes(readyForLanes);
  if (lanes.length > 0) {
    console.error(
      `[afk] Wave ${waveNumber}: ${lanes.length} lane(s) — ${lanes
        .map((l) => `[${l.map((s) => `#${s.ghIssue}`).join(", ")}]`)
        .join(" ")}`,
    );
  }

  // --- Run each lane. Lanes are independent; slices within a lane
  // are serial. The mutex around merge + worktree-remove serialises
  // those operations across lanes. ---
  await Promise.all(
    lanes.map(async (lane) => {
      for (let i = 0; i < lane.length; i++) {
        const slice = lane[i]!;
        const id = slice.ghIssue;
        const branch = sliceBranch(prdSlug, slice, provider);
        const ctx = ctxById.get(id)!;

        // Lane successor refresh: predecessor has merged into featBranch.
        if (i > 0) {
          try {
            console.error(
              `[afk] Refreshing slice #${id} for lane successor on new base`,
            );
            git.recreateWorktreeFromBase(
              repoRoot,
              ctx.branch,
              ctx.worktreeDir,
              featBranch,
            );
            mkdirSync(ctx.absSliceDir, { recursive: true });
            for (const f of ["context.md", "contract.md"]) {
              try {
                rmSync(join(ctx.absSliceDir, f), { force: true });
              } catch {
                // best effort
              }
            }
            const negotiate = await runSliceNegotiate(ctx);
            if (negotiate !== "LOCKED") {
              outcomes.set(id, negotiateRefreshOutcome(negotiate));
              cancelLaneSuccessors(outcomes, lane, i);
              return;
            }
          } catch (err) {
            if (isCancelled(err, signal)) {
              outcomes.set(id, {
                phase: "CANCELLED",
                error: "Cancelled by user",
              });
            } else {
              const msg = err instanceof Error ? err.message : String(err);
              logger.markError(id, msg);
              outcomes.set(id, { phase: "ERROR", error: msg });
            }
            cancelLaneSuccessors(outcomes, lane, i);
            return;
          }
        }

        // Run Phase B.
        let outcome: WaveOutcome;
        try {
          const phaseB = await runSliceExecute(ctx);
          outcome =
            phaseB === "PASS"
              ? PASS
              : phaseB === "CANCELLED"
                ? { phase: "CANCELLED", error: "Cancelled by user" }
                : phaseB === "STUCK"
                  ? {
                      phase: "STUCK",
                      error: "Phase B returned STUCK",
                    }
                  : { phase: "ERROR", error: "Phase B returned ERROR" };
        } catch (err) {
          if (isCancelled(err, signal)) {
            outcome = { phase: "CANCELLED", error: "Cancelled by user" };
          } else {
            const msg = err instanceof Error ? err.message : String(err);
            logger.markError(id, msg);
            outcome = { phase: "ERROR", error: msg };
          }
        }

        if (outcome.phase !== "PASS") {
          outcomes.set(id, outcome);
          cancelLaneSuccessors(outcomes, lane, i);
          return;
        }

        // PASS — merge under the mutex.
        if (!git.hasCommitsAhead(repoRoot, branch, featBranch)) {
          outcomes.set(id, {
            phase: "ERROR",
            error: `Branch ${branch} has no commits ahead of ${featBranch} — generator produced no output`,
          });
          cancelLaneSuccessors(outcomes, lane, i);
          return;
        }

        const scratchMergeDir = join(
          repoRoot,
          ".afk",
          `merge-${sliceBranchPrefix(provider)}-${prdSlug}-s${slice.number}`,
        );
        const merged = await mergeMutex(() =>
          Promise.resolve(
            git.mergeSliceBranch(
              repoRoot,
              branch,
              featBranch,
              scratchMergeDir,
            ),
          ),
        );
        if (!merged) {
          outcomes.set(id, {
            phase: "CONFLICT",
            error: `Merge conflict merging ${branch} into ${featBranch}`,
          });
          cancelLaneSuccessors(outcomes, lane, i);
          return;
        }

        await mergeMutex(() =>
          Promise.resolve(git.removeWorktree(repoRoot, ctx.worktreeDir)),
        );

        outcomes.set(id, PASS);
      }
    }),
  );

  return { outcomes };
}

function negotiateRefreshOutcome(
  result: "STUCK" | "ESCALATE" | "ERROR" | "CANCELLED",
): WaveOutcome {
  switch (result) {
    case "CANCELLED":
      return { phase: "CANCELLED", error: "Cancelled by user" };
    case "ESCALATE":
      return {
        phase: "ESCALATE",
        error: "Contract negotiation escalated after max rounds",
      };
    case "STUCK":
      return {
        phase: "STUCK",
        error: "Contract not locked after negotiation",
      };
    case "ERROR":
      return { phase: "ERROR", error: "Negotiation refresh returned ERROR" };
  }
}

function cancelLaneSuccessors(
  outcomes: Map<string, WaveOutcome>,
  lane: Slice[],
  failedIndex: number,
) {
  for (let k = failedIndex + 1; k < lane.length; k++) {
    outcomes.set(lane[k]!.ghIssue, {
      phase: "LANE-CANCELLED",
      error:
        "Lane predecessor failed; rerun the pipeline after fixing the predecessor",
    });
  }
}

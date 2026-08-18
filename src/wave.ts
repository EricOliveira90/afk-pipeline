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
  /**
   * Called the moment a slice's outcome becomes terminal — PASS right
   * after its merge + worktree removal, failures as soon as they are
   * decided — so the orchestrator can persist it to disk immediately
   * instead of waiting for the wave to finish. A long serial lane can
   * keep a wave open for hours; without immediate persistence, a
   * hard-kill in that window loses the record of already-merged work
   * and a re-run re-attempts it against its own output. See ADR 0018.
   *
   * Errors thrown by the callback are contained (logged, not
   * propagated): a failed state write must not abort the lane. The
   * orchestrator's post-wave reconciliation retries any outcome whose
   * immediate persistence failed.
   */
  onOutcome?: (ghIssue: string, outcome: WaveOutcome) => void;
}

export interface WaveResult {
  outcomes: Map<string, WaveOutcome>;
}

const PASS: WaveOutcome = { phase: "PASS" };

export function executionLanes(
  lanes: Slice[][],
  serialLanes: boolean | undefined,
): Slice[][] {
  return serialLanes ? [lanes.flat()] : lanes;
}

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
    onOutcome,
  } = input;
  const { repoRoot, prdSlug, signal } = config;
  const provider = config.provider ?? kiroProvider;
  const outcomes = new Map<string, WaveOutcome>();

  // Single funnel for terminal outcomes: update the in-memory map and
  // notify the orchestrator so it can persist immediately. Containment:
  // a throwing callback (e.g. state-file write failure) must not take
  // down the lane — the in-memory outcome still stands and the
  // post-wave reconciliation loop will retry persistence.
  const record = (ghIssue: string, outcome: WaveOutcome) => {
    outcomes.set(ghIssue, outcome);
    if (!onOutcome) return;
    try {
      onOutcome(ghIssue, outcome);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.phase(
        `[afk] Warning: failed to persist outcome for slice #${ghIssue} mid-wave (${msg}); will retry after the wave`,
        "warn",
      );
    }
  };

  logger.phase(
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
        record(id, { phase: "CANCELLED", error: "Cancelled by user" });
      } else {
        record(id, {
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
      record(id, { phase: "CANCELLED", error: "Cancelled by user" });
    } else if (result === "ESCALATE") {
      record(id, {
        phase: "ESCALATE",
        error: "Contract negotiation escalated after max rounds",
      });
    } else if (result === "STUCK") {
      record(id, {
        phase: "STUCK",
        error: "Contract not locked after negotiation",
      });
    } else {
      record(id, {
        phase: "ERROR",
        error: "Negotiation returned ERROR",
      });
    }
  }

  // Cancellation short-circuit between phases.
  if (signal?.aborted) {
    for (const id of readyIds) {
      if (!outcomes.has(id)) {
        record(id, { phase: "CANCELLED", error: "Cancelled by user" });
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
  const lanesToRun = executionLanes(lanes, config.serialLanes);
  if (lanes.length > 0) {
    logger.phase(
      `[afk] Wave ${waveNumber}: ${lanesToRun.length} lane(s)${config.serialLanes ? " (serial)" : ""} — ${lanesToRun
        .map((l) => `[${l.map((s) => `#${s.ghIssue}`).join(", ")}]`)
        .join(" ")}`,
    );
    // Make lane queueing explicit: a successor's artifacts (context.md,
    // contract.md) will be DELETED and re-negotiated after its
    // predecessor merges. Without this line, a successor sitting at
    // `**Status:** NEGOTIATING` is indistinguishable from a slice the
    // pipeline dropped. See ADR 0017.
    for (const lane of lanesToRun) {
      for (let i = 1; i < lane.length; i++) {
        logger.phase(
          `[afk] Slice #${lane[i]!.ghIssue} queued behind #${lane[i - 1]!.ghIssue} in its lane — ` +
            `waiting to re-negotiate on the refreshed base after the predecessor completes (not dropped)`,
        );
      }
    }
  }

  // --- Run each lane. Lanes are independent; slices within a lane
  // are serial. The mutex around merge + worktree-remove serialises
  // those operations across lanes.
  //
  // A lane member's failure no longer takes its successors with it
  // (ADR 0024): lane order exists for file-overlap merge safety
  // (ADR 0005), not dependency ordering — DAG dependents of a failed
  // slice are already held back by the orchestrator's readiness check.
  // Each successor refreshes onto the current featBranch tip and
  // re-negotiates regardless of the predecessor's outcome, so running
  // it after a predecessor failure is exactly as merge-safe as running
  // it after a predecessor PASS. Two exceptions still stop the lane:
  // user cancellation, and the ADR 0010 worktree-corruption signature
  // (compounding a corrupted git state needs an operator first). ---
  await Promise.all(
    lanesToRun.map(async (lane) => {
      // Announce that the lane survives a member's failure — the exact
      // collateral-cancel spot pre-ADR 0024.
      const continueLane = (failedIndex: number, phase: string) => {
        const rest = lane.slice(failedIndex + 1).map((s) => `#${s.ghIssue}`);
        if (rest.length === 0) return;
        logger.phase(
          `[afk] Slice #${lane[failedIndex]!.ghIssue} failed (${phase}) — ` +
            `its lane continues with ${rest.join(", ")} on the current ` +
            `${featBranch} tip (DAG-independent; see ADR 0024)`,
        );
      };

      for (let i = 0; i < lane.length; i++) {
        const slice = lane[i]!;
        const id = slice.ghIssue;
        const branch = sliceBranch(prdSlug, slice, provider);
        const ctx = ctxById.get(id)!;

        // Lane successor refresh: predecessor has merged into featBranch.
        if (i > 0) {
          try {
            logger.phase(
              `[afk] Refreshing slice #${id} for lane successor on new base`,
            );
            git.recreateWorktreeFromBase(
              repoRoot,
              ctx.branch,
              ctx.worktreeDir,
              featBranch,
            );
            git.assertWorktreeRegistered(
              repoRoot,
              ctx.branch,
              ctx.worktreeDir,
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
              const outcome = negotiateRefreshOutcome(negotiate);
              record(id, outcome);
              if (outcome.phase === "CANCELLED") return;
              continueLane(i, outcome.phase);
              continue;
            }
          } catch (err) {
            if (isCancelled(err, signal)) {
              record(id, {
                phase: "CANCELLED",
                error: "Cancelled by user",
              });
              return;
            }
            const msg = err instanceof Error ? err.message : String(err);
            logger.markError(id, msg);
            record(id, { phase: "ERROR", error: msg });
            continueLane(i, "ERROR");
            continue;
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
          record(id, outcome);
          if (outcome.phase === "CANCELLED") return;
          continueLane(i, outcome.phase);
          continue;
        }

        // PASS — merge under the mutex.
        //
        // The post-merge block is wrapped so a thrown git error
        // (missing branch, locked index, anything) becomes this
        // slice's ERROR outcome instead of rejecting the wave's
        // outer Promise.all and aborting sibling lanes still in
        // flight. See ADR 0009.
        try {
          // Distinguish "branch missing" from "0 commits ahead". A
          // missing slice branch after a successful generator run is
          // the signature of the silent-corruption bug (worktree was
          // not registered with git, agent's commits leaked to the
          // parent repo's HEAD branch). Surface it loudly so the
          // operator investigates the corruption rather than chasing
          // a phantom no-output run. See ADR 0010.
          if (!git.branchExists(repoRoot, branch)) {
            record(id, {
              phase: "ERROR",
              error:
                `Slice branch ${branch} does not exist after generator completed. ` +
                `The slice's worktree may have been corrupted: commits may have leaked ` +
                `to the parent repo's currently checked-out branch. ` +
                `Inspect 'git reflog --all' and 'git worktree list --porcelain' before re-running.`,
            });
            // Corruption is the one failure that still stops the lane
            // (ADR 0024 exception): dispatching more agents against a
            // repo whose worktree registration already failed silently
            // risks compounding the damage. Operator first.
            cancelLaneSuccessors(record, lane, i);
            return;
          }
          if (!git.hasCommitsAhead(repoRoot, branch, featBranch)) {
            record(id, {
              phase: "ERROR",
              error: `Branch ${branch} has no commits ahead of ${featBranch} — generator produced no output`,
            });
            continueLane(i, "ERROR");
            continue;
          }

          const scratchMergeDir = join(
            repoRoot,
            ".afk",
            `merge-${sliceBranchPrefix(provider)}-${prdSlug}-s${slice.number}`,
          );
          // Collision check + merge share one critical section: checking
          // against the feature-branch tip and then merging must be atomic,
          // or a sibling lane could merge a colliding prefix in between.
          const mergeResult = await mergeMutex(() => {
            const collisions = git.migrationPrefixCollisions(
              repoRoot,
              branch,
              featBranch,
            );
            if (collisions.length > 0) {
              return Promise.resolve<git.MergeResult>({
                status: "conflict",
                details:
                  `Migration prefix collision: ${collisions.join(", ")} already exists on ${featBranch} ` +
                  `under a different filename. Renumber this slice's migration(s) to the next free prefix and re-run.`,
              });
            }
            return Promise.resolve(
              git.mergeSliceBranch(repoRoot, branch, featBranch, scratchMergeDir),
            );
          });
          if (mergeResult.status === "conflict") {
            record(id, {
              phase: "CONFLICT",
              error: mergeResult.details,
            });
            continueLane(i, "CONFLICT");
            continue;
          }
          if (mergeResult.cleanupWarning) {
            logger.phase(`[afk] Warning: ${mergeResult.cleanupWarning}`);
          }

          await mergeMutex(() =>
            Promise.resolve(git.removeWorktree(repoRoot, ctx.worktreeDir)),
          );

          record(id, PASS);
        } catch (err) {
          if (isCancelled(err, signal)) {
            record(id, {
              phase: "CANCELLED",
              error: "Cancelled by user",
            });
            return;
          }
          const msg = err instanceof Error ? err.message : String(err);
          logger.markError(id, msg);
          record(id, { phase: "ERROR", error: msg });
          continueLane(i, "ERROR");
          continue;
        }
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

/**
 * Mark every lane member behind `failedIndex` as LANE-CANCELLED.
 *
 * Since ADR 0024 this fires only for the ADR 0010 worktree-corruption
 * signature — ordinary member failures let the lane continue. The
 * status keeps its ADR 0005 semantics: deferred pending human
 * attention this run, naturally retried on the next invocation.
 */
function cancelLaneSuccessors(
  record: (ghIssue: string, outcome: WaveOutcome) => void,
  lane: Slice[],
  failedIndex: number,
) {
  for (let k = failedIndex + 1; k < lane.length; k++) {
    record(lane[k]!.ghIssue, {
      phase: "LANE-CANCELLED",
      error:
        "Lane halted: a predecessor hit the worktree-corruption signature (ADR 0010); " +
        "investigate the repository state, then rerun the pipeline",
    });
  }
}

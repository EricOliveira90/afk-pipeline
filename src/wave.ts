import { join, posix } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { type Slice, type DAG } from "./issues-parser.js";
import * as git from "./git.js";
import type { AgentProvider } from "./agent-provider.js";
import * as artifacts from "./artifacts.js";
import { RunJournal, type TerminalOutcome } from "./run-journal.js";
import {
  laneResourceGroups,
  migrationPathsIn,
  partitionLanes,
} from "./lanes.js";
import type { NegotiateOutcome, PipelineConfig } from "./orchestrator.js";
import {
  makeSliceContext,
  type SliceContext,
  runSliceNegotiate,
  runSliceExecute,
  sliceBranch,
  sliceScratchMergeDir,
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
  | "MERGE-PENDING"
  | "LANE-CANCELLED";

export type WaveOutcome = TerminalOutcome;

export interface WaveInput {
  waveNumber: number;
  readyIds: string[];
  config: PipelineConfig;
  dag: DAG;
  logger: RunJournal;
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

/**
 * The wave's contract-lock migration gate (ADR 0028).
 *
 * A contract names its migration file at lock time, seconds after the
 * planner drafts it. If that filename's numeric prefix already exists on
 * the feature branch under a different name, the merge mutex will refuse
 * the merge — but not until the slice has explored, planned, generated,
 * and passed QA. In the PRD 076 session that was four hours and seven
 * commits, thrown away over a filename.
 *
 * So the wave inspects the locked contract's "Files expected to change"
 * list the moment it locks, and refuses a lock that collides. The
 * objection names the colliding prefix and the next free one, so the
 * planner has a mechanical correction to make rather than a puzzle.
 *
 * This does not replace the merge-mutex check, which is unchanged and
 * remains the authority: only a check atomic with the merge itself can
 * rule out a sibling lane merging a colliding prefix in between (see
 * `git.migrationPrefixCollisions`). This is a cheap early filter running
 * against the tip as it stands, and it is deliberately the *only*
 * feature-branch gate — sibling collisions within a wave need none,
 * because migration-bearing slices now share a lane (ADR 0027) and the
 * successor re-negotiates against a tip that already holds its
 * predecessor's migration.
 */
function migrationPrefixGate(
  config: PipelineConfig,
  featBranch: string,
): (contractPath: string) => string | null {
  const laneOptions = { migrationPathPattern: config.migrationPathPattern };
  // `migrationPathsIn` normalises to forward slashes, so the POSIX
  // flavour is the exact one on every platform. Wrapped rather than
  // passed to `map` directly: `basename` takes an optional second
  // argument, which `map` would fill with the array index.
  const basename = (p: string) => posix.basename(p);

  return (contractPath) => {
    const declared = artifacts.readContractFiles(contractPath);
    // `undefined` (no such section) and `[]` (nothing usable declared)
    // both mean the contract names no migration to check.
    if (declared === undefined || declared.length === 0) return null;
    const declaredMigrations = migrationPathsIn(declared, laneOptions);
    if (declaredMigrations.length === 0) return null;

    const featMigrations = migrationPathsIn(
      git.listFilesOnRef(config.repoRoot, featBranch),
      laneOptions,
    ).map(basename);
    const collisions = git.findMigrationPrefixCollisions(
      featMigrations,
      declaredMigrations.map(basename),
    );
    if (collisions.length === 0) return null;

    const free = git.nextFreeMigrationPrefix(featMigrations);
    const subject =
      collisions.length === 1
        ? `Migration prefix ${collisions[0]} already exists`
        : `Migration prefixes ${collisions.join(", ")} already exist`;
    return (
      `${subject} on ${featBranch} under a different filename, so this slice's ` +
      `migration(s) cannot be merged. The next free prefix on ${featBranch} is ${free}. ` +
      `Renumber this slice's colliding migration file(s) from ${free} upwards, keeping the ` +
      `rest of each filename, and list the corrected path(s) under "Files expected to change".`
    );
  };
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
    "error",
    { type: "wave-dispatched", wave: waveNumber, slices: [...readyIds] },
  );

  // Build a SliceContext per slice, each carrying the contract-lock
  // migration gate. Attached here rather than inside `makeSliceContext`
  // because the gate is the wave's business: reading a locked contract's
  // declared file list is what the wave does next anyway, and the gate
  // is that read moved to the moment the contract locks.
  const contractGate = migrationPrefixGate(config, featBranch);
  const ctxById = new Map<string, SliceContext>();
  for (const id of readyIds) {
    const slice = dag.slices.get(id)!;
    ctxById.set(id, {
      ...makeSliceContext(
        config,
        slice,
        logger,
        featBranch,
        relevantFilesBlock,
        testCommand,
      ),
      onContractLocked: contractGate,
    });
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
    if (result.phase === "LOCKED") {
      lockedIds.push(id);
      continue;
    }
    record(id, negotiateOutcome(result));
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
  const laneOptions = { migrationPathPattern: config.migrationPathPattern };
  const lanes = partitionLanes(readyForLanes, laneOptions);
  const lanesToRun = executionLanes(lanes, config.serialLanes);

  // Which slices were serialised because they contend for a shared
  // resource rather than a shared file (ADR 0027) — reported so the
  // grouping is legible in the log and in the event stream.
  const sharedResourceEntries = [
    ...laneResourceGroups(readyForLanes, laneOptions),
  ];
  const sharedResources = Object.fromEntries(sharedResourceEntries);

  if (lanes.length > 0) {
    logger.phase(
      `[afk] Wave ${waveNumber}: ${lanesToRun.length} lane(s)${config.serialLanes ? " (serial)" : ""} — ${lanesToRun
        .map((l) => `[${l.map((s) => `#${s.ghIssue}`).join(", ")}]`)
        .join(" ")}` +
        sharedResourceEntries
          .map(
            ([key, members]) =>
              ` — shared ${key}: ${members.map((id) => `#${id}`).join(", ")} (serialised into one lane)`,
          )
          .join(""),
      "error",
      {
        type: "lanes-partitioned",
        wave: waveNumber,
        lanes: lanesToRun.map((l) => l.map((s) => s.ghIssue)),
        sharedResources:
          sharedResourceEntries.length > 0 ? sharedResources : undefined,
        serial: config.serialLanes ? true : undefined,
      },
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
      const continueLane = (
        failedIndex: number,
        phase: Exclude<WaveOutcomePhase, "PASS">,
      ) => {
        const rest = lane.slice(failedIndex + 1).map((s) => `#${s.ghIssue}`);
        if (rest.length === 0) return;
        // A deferred merge is not a failure — say so, or the operator
        // reads "failed (MERGE-PENDING)" and goes looking for a break.
        const verb =
          phase === "MERGE-PENDING" ? "deferred its merge" : "failed";
        logger.phase(
          `[afk] Slice #${lane[failedIndex]!.ghIssue} ${verb} (${phase}) — ` +
            `its lane continues with ${rest.join(", ")} on the current ` +
            `${featBranch} tip (DAG-independent; see ADR 0024)`,
          "error",
          {
            type: "warn",
            reason: "lane-continuation",
            ghIssue: lane[failedIndex]!.ghIssue,
            message: `${verb} (${phase}) — its lane continues with ${rest.join(", ")}`,
          },
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
            if (negotiate.phase !== "LOCKED") {
              const outcome = negotiateOutcome(negotiate);
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
            record(id, { phase: "ERROR", error: msg });
            continueLane(i, "ERROR");
            continue;
          }
        }

        // Run Phase B.
        let outcome: WaveOutcome;
        try {
          outcome = await runSliceExecute(ctx);
        } catch (err) {
          if (isCancelled(err, signal)) {
            outcome = { phase: "CANCELLED", error: "Cancelled by user" };
          } else {
            const msg = err instanceof Error ? err.message : String(err);
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

          const scratchMergeDir = sliceScratchMergeDir(
            repoRoot,
            prdSlug,
            slice,
            provider,
          );
          // Collision check + merge share one critical section: checking
          // against the feature-branch tip and then merging must be atomic,
          // or a sibling lane could merge a colliding prefix in between.
          // See ADR 0029 — the check stays here; only the refusal changed
          // from terminal to deferred.
          const attempt = await mergeMutex(() =>
            Promise.resolve(
              git.attemptMerge(repoRoot, branch, featBranch, scratchMergeDir),
            ),
          );
          if (attempt.kind === "collision") {
            // Deferred merge, not a conflict: the work is committed on the
            // slice branch and QA passed. The next run retries the merge.
            record(id, {
              phase: "MERGE-PENDING",
              error: git.mergePendingReason(attempt.prefixes, featBranch),
              collidingPrefixes: attempt.prefixes,
            });
            continueLane(i, "MERGE-PENDING");
            continue;
          }
          const mergeResult = attempt.result;
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
          record(id, { phase: "ERROR", error: msg });
          continueLane(i, "ERROR");
          continue;
        }
      }
    }),
  );

  return { outcomes };
}

/**
 * Turn a non-LOCKED negotiate result into the slice's outcome, keeping
 * the classified cause as the outcome's reason. That reason is what the
 * run state persists, what the next run's retry announcement quotes,
 * and what `afk status` renders — so an operator can tell "the agent
 * provider hung up with exit code 1" from "the evaluator wrote
 * ESCALATE" without opening an agent log. It replaces the fixed
 * "Negotiation returned ERROR" text. See ADR 0025.
 */
function negotiateOutcome(
  result: Exclude<NegotiateOutcome, { phase: "LOCKED" }>,
): Exclude<WaveOutcome, { phase: "PASS" }> {
  return result.phase === "CANCELLED"
    ? { phase: "CANCELLED", error: "Cancelled by user" }
    : { phase: result.phase, error: result.cause.summary };
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

import { existsSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { findAdjudicationEstate } from "./adjudication-estate.js";
import type { AgentProvider } from "./agent-provider.js";
import * as git from "./git.js";
import { kiroProvider } from "./kiro.js";
import {
  pipelineRunSlug,
  scratchMergeNamePattern,
  sliceBranchPrefix,
  sliceWorktreeNamePattern,
} from "./orchestrator.js";
import { loadRunState } from "./run-state.js";
import { traitsFor, type SlicePhase } from "./slice-lifecycle.js";

/**
 * `afk clean-failed` — one command for the manual, Windows-hostile
 * cleanup sequence every re-run after a failure used to require per
 * dead slice: `git worktree remove --force` (fails "Directory not
 * empty" on pnpm's node_modules), `Remove-Item -Recurse -Force`,
 * `git worktree prune`, `git branch -D afk/<slug>-slice-*`. See
 * issue #19 and ADR 0023.
 *
 * Scope guarantees:
 * - Targets are the slices whose phase declares its debris disposable and
 *   whose worktree does not hold an adjudication estate. ADR 0055 Seam 2
 *   §6 narrows ADR 0023's "every slice in a failure phase" to exactly
 *   that: an adjudication estate is a human's pending input, so the slice
 *   is skipped and named in the report whatever phase it ended in — the
 *   fact is read off disk, not off the phase. Everything below is
 *   unchanged.
 * - Only targets identified by this PRD's run state, plus on-disk
 *   leftovers matching this PRD's exact worktree/scratch naming
 *   (`<prefix>-<prdSlug>-s<NN>`) — other PRDs' and other providers'
 *   worktrees are untouchable by construction.
 * - A slice branch is deleted only when it has no commits ahead of the
 *   feature branch — committed work (a STUCK slice's partial
 *   implementation, a CONFLICT branch awaiting manual resolution) is
 *   never lost; the branch is kept and reported.
 * - A MERGE-PENDING slice is not debris awaiting operator repair: its
 *   branch is never a deletion candidate, because the next run's
 *   merge-only recovery needs exactly that branch (ADR 0029). Its
 *   worktree is still removable — recovery works from the branch alone.
 * - Registered worktrees whose slice is not in a failure phase are
 *   never removed (a concurrently-running pipeline's live worktrees
 *   stay safe), though running clean-failed during a live run is
 *   still not supported.
 *
 * Directory deletion goes through `git.removeWorktree`, whose on-disk
 * fallback is Node's `rmSync` — which unlinks junctions instead of
 * traversing them, avoiding the PowerShell `Remove-Item -Recurse`
 * junction hazard from the babysit-afk notes.
 */

/**
 * Every question this command asks about a phase comes off one trait —
 * the lifecycle's cleanup-disposition axis (ADR 0055 Seam 2 §6) — and not
 * off the presentation bucket, which is about rendering. A phase that
 * declares its debris undisposable is undisposable here by construction,
 * so a new preserved phase never has to be remembered in two places.
 */
const isCleanupTarget = (phase: SlicePhase): boolean =>
  traitsFor(phase).debris !== "out-of-scope";

/** Worktree is debris, branch is the next run's input (MERGE-PENDING). */
const mustPreserveBranch = (phase: SlicePhase): boolean =>
  traitsFor(phase).debris === "preserve-branch";

/**
 * Nothing is debris — the estate belongs to a human's pending decision.
 *
 * Two independent sources, and the *disk* one is the authority (ADR 0055
 * Seam 2 §6, fourth adjudication gate round). `findAdjudicationEstate`
 * asks the only question that matters — does this worktree still hold the
 * impasse record or the decision log? — and so covers every terminal phase
 * a post-decision apply can exit through, including the ordinary `ERROR`
 * and `CONFLICT` a planner failure, a feature-refresh conflict, a
 * cancellation mid-apply, or a flattened bookkeeping throw produce. The
 * phase trait remains as a second, weaker term: it catches an
 * `AWAITING-ADJUDICATION` record whose worktree an operator has already
 * removed by hand, where there is no disk to read.
 */
const mustPreserveEstate = (
  phase: SlicePhase,
  dir: string | undefined,
): { reason: string } | null => {
  const estate = dir ? findAdjudicationEstate(dir) : null;
  if (estate) {
    return {
      reason:
        `${phase} — preserving the adjudication estate this worktree still ` +
        `holds (${estate.evidence}): it is the operator's pending input, and ` +
        `only this slice's own re-dispatch replaces it`,
    };
  }
  if (traitsFor(phase).debris === "preserve-all") {
    return {
      reason:
        `${phase} — preserving the adjudication estate (impasse record, ` +
        `decision log, worktree, branch): it is the operator's pending input, ` +
        `and only this slice's own re-dispatch replaces it`,
    };
  }
  return null;
};

export interface CleanFailedOptions {
  repoRoot: string;
  prdSlug: string;
  provider?: AgentProvider;
  /** Report what would happen without touching anything. */
  dryRun?: boolean;
  log?: (line: string) => void;
}

export interface CleanFailedReport {
  /** Worktree directories removed (or that would be, under dry-run). */
  removedWorktrees: string[];
  /** Slice branches deleted (no commits beyond the feature branch). */
  deletedBranches: string[];
  /** Branches kept, with the reason (typically unmerged commits). */
  keptBranches: Array<{ branch: string; reason: string }>;
  /** Leftover scratch merge dirs removed. */
  removedScratchDirs: string[];
  /** Targets skipped, with the reason. */
  skipped: Array<{ target: string; reason: string }>;
}

function normalise(p: string): string {
  const n = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? n.toLowerCase() : n;
}

export async function runCleanFailed(
  options: CleanFailedOptions,
): Promise<CleanFailedReport> {
  const { repoRoot, prdSlug, dryRun = false } = options;
  const provider = options.provider ?? kiroProvider;
  const log = options.log ?? ((line: string) => console.log(line));
  const runSlug = pipelineRunSlug(prdSlug, provider);
  const prefix = sliceBranchPrefix(provider);

  const report: CleanFailedReport = {
    removedWorktrees: [],
    deletedBranches: [],
    keptBranches: [],
    removedScratchDirs: [],
    skipped: [],
  };

  const state = loadRunState(repoRoot, runSlug);
  const featureBranch = state.featureBranch;
  const featureExists = git.branchExists(repoRoot, featureBranch);

  // ghIssue -> manifest slice number, for computing worktree dirs when
  // the branch name is absent or unparseable.
  const numberByIssue = new Map<string, string>(
    (state.scope?.slices ?? []).map((s) => [s.ghIssue, s.number]),
  );

  const worktreeDirFor = (ghIssue: string, branch: string | undefined) => {
    // Prefer the manifest number; fall back to the `-slice-NN-` segment
    // of the branch name (same digits, different source).
    const number =
      numberByIssue.get(ghIssue) ??
      (branch ? /-slice-(\d+)-/.exec(branch)?.[1] : undefined);
    return number !== undefined
      ? join(repoRoot, ".afk", "worktrees", `${prefix}-${prdSlug}-s${number}`)
      : undefined;
  };

  const registered = git.listWorktrees(repoRoot);
  const registeredPaths = new Set(registered.map((w) => normalise(w.path)));

  const removeDir = async (dir: string, bucket: "worktree" | "scratch") => {
    const key = bucket === "worktree" ? "removedWorktrees" : "removedScratchDirs";
    if (dryRun) {
      report[key].push(dir);
      log(`[dry-run] would remove ${dir}`);
      return;
    }
    // Read the structured result, like every other teardown call site —
    // not a post-hoc existsSync (issue #102).
    const removal = await git.removeWorktree(repoRoot, dir);
    if (!removal.removed) {
      report.skipped.push({
        target: dir,
        reason: git.formatWorktreeSurvivorWarning("directory", dir, removal),
      });
      log(`  ! could not fully remove ${dir} — see report`);
    } else {
      report[key].push(dir);
      log(`  removed ${dir}`);
    }
  };

  // --- Pass 1: slices recorded in a failure phase, plus the recoverable
  // phases whose worktree is debris but whose branch is not. ---
  const handledDirs = new Set<string>();
  for (const [ghIssue, slice] of Object.entries(state.slices)) {
    if (!isCleanupTarget(slice.phase)) continue;
    log(`Slice #${ghIssue} (${slice.phase}):`);

    // Worktree: the registered location wins when git knows one for the
    // branch; the naming formula covers unregistered leftovers. When
    // both agree (git reports forward slashes), keep the native form.
    const computed = worktreeDirFor(ghIssue, slice.branch);
    const registeredDir = slice.branch
      ? git.findWorktreeForBranch(repoRoot, slice.branch)
      : null;
    const dir =
      registeredDir && computed && normalise(registeredDir) === normalise(computed)
        ? computed
        : (registeredDir ?? computed);

    // A slice that owns an adjudication estate has no debris: the impasse
    // record, the decision log, the in-flight adjudication.md, the worktree
    // they live in and the branch under it are a human's pending input, and
    // only the slice's own re-dispatch replaces them (ADR 0055 Seam 2). Say
    // so — an operator who ran clean-failed to clear the way for a re-run
    // has to be able to tell a deliberate skip from a command that missed
    // one.
    const preserve = mustPreserveEstate(slice.phase, dir);
    if (preserve) {
      if (dir) handledDirs.add(normalise(dir));
      report.skipped.push({
        target: dir ?? slice.branch ?? `#${ghIssue}`,
        reason: preserve.reason,
      });
      log(
        `  kept the whole estate — ${slice.phase}, an adjudication the operator still owns`,
      );
      continue;
    }

    if (dir) {
      // Refuse anything outside this PRD's worktree namespace — a
      // registered worktree at an unexpected path is operator territory.
      const expectedParent = normalise(join(repoRoot, ".afk", "worktrees"));
      if (normalise(dir).startsWith(expectedParent)) {
        if (existsSync(dir) || registeredPaths.has(normalise(dir))) {
          await removeDir(dir, "worktree");
        }
        handledDirs.add(normalise(dir));
      } else {
        report.skipped.push({
          target: dir,
          reason: `worktree registered outside .afk/worktrees — refusing to touch`,
        });
      }
    }

    // Branch: delete only when nothing would be lost.
    const branch = slice.branch;
    if (!branch || !git.branchExists(repoRoot, branch)) continue;
    if (mustPreserveBranch(slice.phase)) {
      // Never a deletion candidate, whatever the commit comparison says:
      // the next run's merge-only recovery merges this exact branch.
      report.keptBranches.push({
        branch,
        reason: `${slice.phase} — the next run retries the merge; the branch holds the slice's committed work`,
      });
      log(`  kept branch ${branch} (${slice.phase} — merge retried next run)`);
      continue;
    }
    if (!featureExists) {
      report.keptBranches.push({
        branch,
        reason: `feature branch ${featureBranch} not found — cannot verify the slice branch is fully merged`,
      });
      log(`  kept branch ${branch} (cannot verify against ${featureBranch})`);
      continue;
    }
    if (git.hasCommitsAhead(repoRoot, branch, featureBranch)) {
      report.keptBranches.push({
        branch,
        reason: `has commits ahead of ${featureBranch} — delete manually once you are sure they are disposable`,
      });
      log(`  kept branch ${branch} (unmerged commits)`);
      continue;
    }
    if (dryRun) {
      report.deletedBranches.push(branch);
      log(`[dry-run] would delete branch ${branch}`);
    } else {
      git.deleteBranch(repoRoot, branch);
      report.deletedBranches.push(branch);
      log(`  deleted branch ${branch}`);
    }
  }

  // --- Pass 2: unregistered on-disk leftovers in this PRD's namespace
  // (state deleted by hand, crash before state write, PASS cleanup that
  // failed on a file lock). Registered worktrees not in a failure phase
  // are left alone. ---
  const worktreesRoot = join(repoRoot, ".afk", "worktrees");
  const namePattern = sliceWorktreeNamePattern(prdSlug, provider);
  if (existsSync(worktreesRoot)) {
    for (const entry of readdirSync(worktreesRoot)) {
      if (!namePattern.test(entry)) continue;
      const dir = join(worktreesRoot, entry);
      if (handledDirs.has(normalise(dir))) continue;
      if (registeredPaths.has(normalise(dir))) {
        report.skipped.push({
          target: dir,
          reason:
            "registered worktree whose slice is not in a failure phase — not touching",
        });
        continue;
      }
      // The same disk fact pass 1 consults, asked of a directory no run
      // state claims: state deleted by hand, a crash before the state
      // write, a slice record that never named its branch. Ownership is a
      // property of the worktree, so it holds here too — and this is the
      // one pass that would otherwise delete an estate precisely because
      // nothing recorded it.
      const orphanEstate = findAdjudicationEstate(dir);
      if (orphanEstate) {
        report.skipped.push({
          target: dir,
          reason:
            `unregistered leftover that still holds an adjudication estate ` +
            `(${orphanEstate.evidence}) — the operator's input outlives the ` +
            `run state that lost track of it`,
        });
        continue;
      }
      await removeDir(dir, "worktree");
    }
  }

  // --- Pass 3: leftover scratch merge dirs (.afk/merge-<prefix>-<slug>-sNN). ---
  const afkRoot = join(repoRoot, ".afk");
  const scratchPattern = scratchMergeNamePattern(prdSlug, provider);
  if (existsSync(afkRoot)) {
    for (const entry of readdirSync(afkRoot)) {
      if (!scratchPattern.test(entry)) continue;
      await removeDir(join(afkRoot, entry), "scratch");
    }
  }

  if (!dryRun) git.pruneWorktrees(repoRoot);

  return report;
}

/** Shared CLI entry for the `clean-failed` subcommand of all three bins. */
export async function runCleanFailedCli(
  args: readonly string[],
  provider?: AgentProvider,
): Promise<number> {
  let prdDirArg: string | undefined;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--prd-dir" && args[i + 1]) prdDirArg = args[++i];
    else if (args[i] === "--dry-run") dryRun = true;
  }
  if (!prdDirArg) {
    console.error(
      "Usage: afk clean-failed --prd-dir <path-to-prd-folder> [--dry-run]",
    );
    return 2;
  }

  const prdDir = resolve(prdDirArg);
  const repoRoot = resolve(".");
  const prdSlug = basename(prdDir);

  console.log(
    `Cleaning failed-slice debris for ${prdSlug}${dryRun ? " (dry run)" : ""}...`,
  );
  const report = await runCleanFailed({ repoRoot, prdSlug, provider, dryRun });

  console.log("");
  console.log(
    `Worktrees ${dryRun ? "to remove" : "removed"}: ${report.removedWorktrees.length}`,
  );
  console.log(
    `Branches ${dryRun ? "to delete" : "deleted"}: ${report.deletedBranches.length}`,
  );
  if (report.removedScratchDirs.length > 0) {
    console.log(
      `Scratch merge dirs ${dryRun ? "to remove" : "removed"}: ${report.removedScratchDirs.length}`,
    );
  }
  for (const kept of report.keptBranches) {
    console.log(`Kept: ${kept.branch} — ${kept.reason}`);
  }
  for (const s of report.skipped) {
    console.log(`Skipped: ${s.target} — ${s.reason}`);
  }
  return 0;
}

import { existsSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
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
 * Phases whose worktree is disposable but whose branch is not. Read off
 * the lifecycle's own bucketing rather than a second list here, so a new
 * deferred phase never has to be remembered in two places. Distinct from
 * `FAILURE_PHASES`: nothing deferred awaits operator repair, so its
 * branch is reported as deliberately preserved rather than assessed for
 * deletion.
 */
const isCleanupTarget = (phase: SlicePhase): boolean => {
  const bucket = traitsFor(phase).bucket;
  return bucket === "failed" || bucket === "cancelled" || bucket === "deferred";
};

const mustPreserveBranch = (phase: SlicePhase): boolean =>
  traitsFor(phase).bucket === "deferred";

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

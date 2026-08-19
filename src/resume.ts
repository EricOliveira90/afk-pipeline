import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as git from "./git.js";

/**
 * Resume-a-dead-slice eligibility (spec #33, design note on issue #15).
 *
 * When a slice's generator dies mid-run (idle-kill, model outage,
 * machine sleep), its worktree can hold hours of committed work. On
 * retry, the launcher classifies the slice by its surviving *git
 * state* — never by a recorded death cause, because a slice that dies
 * mid-generator has no state-file entry at all (RUNNING is never
 * persisted, ADR 0018). The tree is always inspectable; the cause is
 * often unknowable.
 *
 * `decideResume` is deliberately a pure function: git-state facts in,
 * resume/restart plan + reason out. Later guards (stuck.md, the
 * resume-attempt cap, --force-restart) only add inputs to it.
 */

/** Git-state facts about a slice's surviving branch + worktree. */
export interface ResumeFacts {
  /** The slice branch exists locally. */
  branchExists: boolean;
  /** The expected worktree dir is git-registered for the slice branch. */
  worktreeRegistered: boolean;
  /** Commits on the slice branch beyond the feature-branch base. */
  commitsAheadOfBase: number;
  /** A stuck.md sits in the slice's artifact dir — terminal by design (#36). */
  stuckFilePresent: boolean;
  /** Resumes already spent on this tree, from the run-state file (#36). */
  resumeAttempts: number;
  /** The operator named this slice in --force-restart (#37). */
  forceRestart: boolean;
}

/**
 * Resumes allowed per slice tree before the next retry restarts from
 * base — repeated death on the same tree is itself evidence of poison.
 * The counter resets on restart, so a fresh tree earns a fresh budget.
 */
export const MAX_RESUME_ATTEMPTS = 2;

export type ResumePlan =
  /** Re-attach to the surviving branch tip and hand the generator a resume prompt. */
  | { action: "resume"; commitsAhead: number }
  /** Deliberately recreate the worktree from base; `reason` is logged and audited. */
  | { action: "restart"; reason: string }
  /** No evidence of a prior attempt — the normal first-run creation path. */
  | { action: "fresh" };

/** Pure eligibility decision. See module doc. */
export function decideResume(facts: ResumeFacts): ResumePlan {
  if (!facts.branchExists && !facts.worktreeRegistered) {
    return { action: "fresh" };
  }
  if (facts.forceRestart) {
    return { action: "restart", reason: "--force-restart" };
  }
  if (!facts.branchExists) {
    return { action: "restart", reason: "slice branch missing" };
  }
  if (!facts.worktreeRegistered) {
    return { action: "restart", reason: "worktree missing or unregistered" };
  }
  if (facts.stuckFilePresent) {
    return { action: "restart", reason: "stuck.md present (terminal diagnosis)" };
  }
  if (facts.commitsAheadOfBase <= 0) {
    return { action: "restart", reason: "no commits beyond base" };
  }
  if (facts.resumeAttempts >= MAX_RESUME_ATTEMPTS) {
    return {
      action: "restart",
      reason: `resume attempt cap (${MAX_RESUME_ATTEMPTS}) reached`,
    };
  }
  return { action: "resume", commitsAhead: facts.commitsAheadOfBase };
}

/**
 * Inspect the repo for the git-state facts `decideResume` consumes.
 * Read-only — no worktree mutation happens here. The two non-git facts
 * (stuck marker, attempt count) come from the caller's context: the
 * slice artifact dir and the run-state file.
 */
export function collectResumeFacts(
  repoRoot: string,
  branch: string,
  worktreeDir: string,
  baseBranch: string,
  context: { sliceDir: string; resumeAttempts: number; forceRestart: boolean },
): ResumeFacts {
  const branchExists = git.branchExists(repoRoot, branch);
  const worktreeRegistered =
    existsSync(worktreeDir) &&
    git.isWorktreeRegistered(repoRoot, branch, worktreeDir);
  return {
    branchExists,
    worktreeRegistered,
    commitsAheadOfBase: branchExists
      ? git.countCommitsAhead(repoRoot, branch, baseBranch)
      : 0,
    stuckFilePresent: existsSync(join(context.sliceDir, "stuck.md")),
    resumeAttempts: context.resumeAttempts,
    forceRestart: context.forceRestart,
  };
}

/**
 * True when the operator's `--force-restart` values name this slice —
 * by slice number (zero padding optional: `5` matches `05`) or by GH
 * issue id. Pure; unit-tested alongside the decision function.
 */
export function isForceRestarted(
  forceRestart: readonly string[] | undefined,
  slice: { number: string; ghIssue: string },
): boolean {
  if (!forceRestart) return false;
  return forceRestart.some(
    (v) =>
      v === slice.ghIssue ||
      v === slice.number ||
      Number(v) === Number(slice.number),
  );
}


/**
 * Prompt block for the prior per-slice handoff.md, or `""` (#38).
 *
 * Included only when the handoff's mtime is NEWER than the last
 * commit's timestamp: a handoff written before the dead generator's
 * last commit describes an earlier state of the work and actively
 * misleads — it is omitted entirely, never included with a caveat.
 * An unknown last-commit time also omits (never mislead by default).
 */
export function buildResumeHandoffNote(
  handoffPath: string,
  lastCommitEpochSeconds: number | null,
): string {
  if (lastCommitEpochSeconds === null) return "";
  if (!existsSync(handoffPath)) return "";
  const mtimeSeconds = statSync(handoffPath).mtimeMs / 1000;
  if (mtimeSeconds <= lastCommitEpochSeconds) return "";
  const content = readFileSync(handoffPath, "utf-8");
  return [
    "# Your prior handoff",
    "",
    "You wrote this handoff after your last commit — it is fresher than",
    "the tree and describes where you believed you stopped:",
    "",
    "```",
    content.trim(),
    "```",
  ].join("\n");
}

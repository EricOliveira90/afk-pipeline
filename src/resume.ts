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
 * resume-attempt cap, --force-restart, --resume-stuck) only add inputs
 * to it.
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
  /**
   * The operator named this slice in `--resume-stuck` (#49): an
   * explicit, per-run instruction to grant a STUCK slice one more
   * implementation/QA attempt on its preserved tree instead of
   * restarting from base. Opt-in only — absent, a stuck.md stays
   * terminal exactly as before.
   */
  resumeStuck: boolean;
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
  /**
   * Re-attach to a STUCK slice's preserved tip *without* resetting or
   * cleaning it, keeping its stuck.md diagnosis, and grant one more
   * implementation/QA attempt. Only ever returned when the operator
   * named the slice in `--resume-stuck` (#49).
   */
  | { action: "resume-stuck"; commitsAhead: number }
  /** Deliberately recreate the worktree from base; `reason` is logged and audited. */
  | { action: "restart"; reason: string }
  /** No evidence of a prior attempt — the normal first-run creation path. */
  | { action: "fresh" };

/** Pure eligibility decision. See module doc. */
export function decideResume(facts: ResumeFacts): ResumePlan {
  if (!facts.branchExists && !facts.worktreeRegistered) {
    return { action: "fresh" };
  }
  // `--force-restart` outranks `--resume-stuck`: it is the operator
  // saying "this tree is bad", which is strictly the more destructive
  // and therefore the more deliberate instruction. The CLI rejects a
  // slice named in both flags, so this only settles the precedence for
  // programmatic callers.
  if (facts.forceRestart) {
    return { action: "restart", reason: "--force-restart" };
  }
  // A resume of any kind needs a branch, a registered worktree, and
  // committed work — these three guards are what "the preserved tree is
  // real" means, and `--resume-stuck` does not relax any of them.
  if (!facts.branchExists) {
    return { action: "restart", reason: "slice branch missing" };
  }
  if (!facts.worktreeRegistered) {
    return { action: "restart", reason: "worktree missing or unregistered" };
  }
  if (facts.stuckFilePresent) {
    if (!facts.resumeStuck) {
      return { action: "restart", reason: "stuck.md present (terminal diagnosis)" };
    }
    if (facts.commitsAheadOfBase <= 0) {
      return {
        action: "restart",
        reason: "--resume-stuck named this slice but it has no commits beyond base",
      };
    }
    // Deliberately NOT subject to MAX_RESUME_ATTEMPTS. That cap exists
    // to stop an unattended launcher from resuming a poisoned tree
    // forever; `--resume-stuck` must be re-supplied on every run, so the
    // operator *is* the cap. Honouring it here would silently restart
    // from base — destroying the very commits and diagnosis the operator
    // asked to keep — which is the failure this flag exists to prevent.
    return { action: "resume-stuck", commitsAhead: facts.commitsAheadOfBase };
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
  context: {
    sliceDir: string;
    resumeAttempts: number;
    forceRestart: boolean;
    resumeStuck: boolean;
  },
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
    resumeStuck: context.resumeStuck,
  };
}

/**
 * True when a list of operator-supplied slice selectors names this
 * slice — by slice number (zero padding optional: `5` matches `05`) or
 * by GH issue id. Shared by `--force-restart` (#37) and
 * `--resume-stuck` (#49) so the two flags cannot drift apart in what
 * "naming a slice" means.
 */
export function matchesSliceSelector(
  selectors: readonly string[] | undefined,
  slice: { number: string; ghIssue: string },
): boolean {
  if (!selectors) return false;
  return selectors.some(
    (v) =>
      v === slice.ghIssue ||
      v === slice.number ||
      Number(v) === Number(slice.number),
  );
}

/**
 * True when the operator's `--force-restart` values name this slice.
 * Pure; unit-tested alongside the decision function.
 */
export function isForceRestarted(
  forceRestart: readonly string[] | undefined,
  slice: { number: string; ghIssue: string },
): boolean {
  return matchesSliceSelector(forceRestart, slice);
}

/** True when the operator's `--resume-stuck` values name this slice (#49). */
export function isResumeStuckRequested(
  resumeStuck: readonly string[] | undefined,
  slice: { number: string; ghIssue: string },
): boolean {
  return matchesSliceSelector(resumeStuck, slice);
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
/**
 * Prompt block for the preserved STUCK diagnosis, or `""` when absent (#49).
 *
 * Included verbatim and unconditionally — no staleness check, unlike
 * `buildResumeHandoffNote`. A stuck.md is written by the pipeline at the
 * moment the slice was declared STUCK, after its last commit, so it
 * always describes the tip the resumed generator is standing on. It is
 * also the reason the operator opted in: dropping it would hand the
 * generator the same tree with none of the accumulated knowledge of why
 * it failed.
 */
export function buildStuckDiagnosisNote(stuckPath: string): string {
  if (!existsSync(stuckPath)) return "";
  const content = readFileSync(stuckPath, "utf-8").trim();
  if (content === "") return "";
  return [
    "# Why you were declared STUCK",
    "",
    "Your previous run exhausted its implementation rounds and the",
    "pipeline wrote this diagnosis. It is preserved, not discarded —",
    "the unresolved findings below are what you must now clear:",
    "",
    "```",
    content,
    "```",
  ].join("\n");
}

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

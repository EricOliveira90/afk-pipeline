import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as git from "./git.js";
import { matchesSliceSelector } from "./slice-selector.js";

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
 *
 * One invariant outranks every guard here (#113): a from-base restart
 * force-resets the branch and recreates the worktree, so it must never
 * run on a branch that still holds unmerged commits unless the operator
 * named the slice in `--force-restart`. Every guard that would otherwise
 * restart such a branch returns `refuse` instead — see
 * {@link restartOrRefuse}.
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
 * Resumes allowed per slice tree before the next retry stops resuming it
 * — repeated death on the same tree is itself evidence of poison. The
 * counter resets on restart, so a fresh tree earns a fresh budget.
 *
 * Reaching the cap does **not** license destroying the tree: with commits
 * on the branch the slice refuses and reports (#113). Only a branch
 * already at base restarts silently, because there is nothing to lose.
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
  /**
   * The slice cannot run this attempt: it is not resumable *and* a
   * from-base restart would force-reset a branch that still holds
   * unmerged commits. Refuse and report instead of destroying (#113).
   * `reason` is the restart reason that would otherwise have applied.
   */
  | { action: "refuse"; reason: string; commitsAhead: number }
  /** No evidence of a prior attempt — the normal first-run creation path. */
  | { action: "fresh" };

/** The one restart reason that carries explicit operator intent to discard. */
export const FORCE_RESTART_REASON = "--force-restart";

/**
 * The core #113 invariant, in one place: **the pipeline never
 * force-resets a slice branch that still holds unmerged commits unless
 * the operator asked for it by name.**
 *
 * A from-base restart resets the branch to base and recreates the
 * worktree, so every commit not yet merged into the feature branch and
 * every untracked slice artifact under it is gone. When the branch is
 * already at base there is nothing to lose and the restart proceeds
 * exactly as before — that is the ordinary case (death before the first
 * commit, a lane-successor refresh).
 *
 * This mirrors `clean-failed`, which keeps and reports a branch with
 * commits ahead of the feature branch rather than deleting it
 * (ADR 0023), and the `--resume-stuck` guard below, which already
 * refuses to let a cap silently restart a preserved tree.
 */
export function restartOrRefuse(
  reason: string,
  commitsAheadOfBase: number,
): ResumePlan {
  if (commitsAheadOfBase > 0) {
    return { action: "refuse", reason, commitsAhead: commitsAheadOfBase };
  }
  return { action: "restart", reason };
}

/**
 * Operator-facing explanation of a refused restart: what was about to be
 * destroyed, and the two ways forward. Shared by the decision-time
 * refusal and the base-refresh-conflict refusal so both read the same.
 */
export function formatRestartRefusal(details: {
  reason: string;
  commitsAhead: number;
  branch: string;
  /** What the operator would pass to `--force-restart` (the GH issue id). */
  selector: string;
  /** Where the untracked slice artifacts were archived, repo-relative. */
  archiveDir?: string;
}): string {
  const { reason, commitsAhead, branch, selector, archiveDir } = details;
  const stuckHint = /stuck\.md/.test(reason)
    ? ` To keep the tree and its diagnosis instead, re-run with \`--resume-stuck ${selector}\`.`
    : "";
  return (
    `refusing to restart ${branch} from base (${reason}): the branch holds ` +
    `${commitsAhead} unmerged commit(s), and a from-base restart would ` +
    `force-reset them away. Inspect the branch, then merge or cherry-pick ` +
    `what is worth keeping, or re-run with \`${FORCE_RESTART_REASON} ` +
    `${selector}\` to discard it deliberately.${stuckHint}` +
    (archiveDir ? ` Slice artifacts were archived to ${archiveDir}.` : "")
  );
}

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
  // The only restart that may destroy unmerged commits: the operator
  // named this slice, so the discard is deliberate (#113).
  if (facts.forceRestart) {
    return { action: "restart", reason: FORCE_RESTART_REASON };
  }
  // A resume of any kind needs a branch, a registered worktree, and
  // committed work — these three guards are what "the preserved tree is
  // real" means, and `--resume-stuck` does not relax any of them.
  if (!facts.branchExists) {
    return { action: "restart", reason: "slice branch missing" };
  }
  if (!facts.worktreeRegistered) {
    return restartOrRefuse(
      "worktree missing or unregistered",
      facts.commitsAheadOfBase,
    );
  }
  if (facts.stuckFilePresent) {
    if (!facts.resumeStuck) {
      // A stuck.md stays terminal — but terminal means "do not resume",
      // not "destroy". With commits on the branch the operator is told to
      // choose between `--resume-stuck` and `--force-restart` (#113).
      return restartOrRefuse(
        "stuck.md present (terminal diagnosis)",
        facts.commitsAheadOfBase,
      );
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
    // The cap's job is to stop an unattended launcher resuming a poisoned
    // tree forever. It does that by refusing to *resume*; converting the
    // refusal into a from-base restart is what destroyed a LOCKED
    // contract and 11 commits in the PRD 1 run (#113). Past the
    // zero-commits check above this branch always has commits, so this is
    // always the refusal — `restartOrRefuse` keeps the invariant in one
    // place rather than restating it.
    return restartOrRefuse(
      `resume attempt cap (${MAX_RESUME_ATTEMPTS}) reached`,
      facts.commitsAheadOfBase,
    );
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

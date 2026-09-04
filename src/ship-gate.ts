import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import type {
  InvokeOptions,
  InvokeResult,
} from "./agent-provider.js";
import { CancelledError } from "./agent-provider.js";
import * as artifacts from "./artifacts.js";
import * as git from "./git.js";
import { parseDraftPrNumber } from "./handoff.js";
import {
  runPreShipSanity,
  type SanityCommandRunner,
  type SanityGateResult,
} from "./preship.js";
import { renderPrompt } from "./prompt-template.js";
import type { RunJournal } from "./run-journal.js";
import {
  saveReviewPhase,
  type PersistedReviewPhase,
} from "./run-state.js";
import type { ResolvedRunScope } from "./slice-scope.js";
import type { SliceAdoption } from "./slice-lifecycle.js";

/**
 * The review artifact a guardian left behind, read the moment its invocation
 * returned. See `restoreCapturedReviewArtifacts` for why this is captured
 * rather than re-read at commit time.
 */
export interface CapturedReviewArtifact {
  label: string;
  path: string;
  /** `null` when the agent wrote no file at all. */
  content: string | null;
}

/** Outcome of one guardian review run, with failure detail when it died. */
export interface ReviewRunResult {
  outcome: artifacts.ReviewOutcome;
  detail?: string;
  /** Absent for a cached verdict and for an infrastructure failure. */
  captured?: CapturedReviewArtifact;
}

/** File seam so the restore step is unit-testable without a worktree. */
export interface ReviewArtifactIo {
  read(path: string): string | null;
  write(path: string, content: string): void;
}

const defaultReviewArtifactIo: ReviewArtifactIo = {
  read(path) {
    try {
      return readFileSync(path, "utf-8");
    } catch {
      return null;
    }
  },
  write(path, content) {
    writeFileSync(path, content, "utf-8");
  },
};

/** One review path this run rewrote, or tried to and could not. */
export interface ReviewArtifactRestoreEntry {
  label: string;
  path: string;
  /** Present only on `failed` entries: why the write did not happen. */
  error?: string;
}

/** What `restoreCapturedReviewArtifacts` did, per artifact. */
export interface ReviewArtifactRestoreReport {
  restored: ReviewArtifactRestoreEntry[];
  failed: ReviewArtifactRestoreEntry[];
}

/**
 * Put each guardian's own output back at its review path before the artifact
 * commit.
 *
 * Both guardians run concurrently in one shared review worktree, and each is a
 * general-purpose agent with a shell. In issue #136 the PM guardian's editor
 * deleted and re-wrote `review-architect.md` — and then, separately, ran
 * `git checkout-index --force` over it while investigating a line-ending
 * warning. Either way the architect's freshly written review was replaced by
 * the *previous* round's committed content, the commit shipped a byte-identical
 * stale review, and a FIX-BEFORE-SHIP verdict was attributed to code that no
 * longer existed at the cited lines. This step is deliberately
 * mechanism-agnostic: it compares content, so it does not care which write
 * clobbered the file.
 *
 * The verdict is already classified from the captured string, so this restores
 * the *content* backing that verdict: a committed `review-<role>.md` is always
 * the artifact this run's agent authored against this tree.
 *
 * Never throws. The i/o here is one write into a worktree a shell-holding agent
 * has just been running in — the path can be gone (`git clean -fd`), read-only,
 * or on a full disk. A restore that cannot happen is an anomaly to shout about,
 * not a reason to lose a three-hour gate's reviews, so each artifact is
 * attempted independently and failures come back as data.
 */
export function restoreCapturedReviewArtifacts(
  captured: readonly (CapturedReviewArtifact | undefined)[],
  io: ReviewArtifactIo = defaultReviewArtifactIo,
): ReviewArtifactRestoreReport {
  const report: ReviewArtifactRestoreReport = { restored: [], failed: [] };
  for (const artifact of captured) {
    if (!artifact || artifact.content === null) continue;
    const { label, path } = artifact;
    try {
      if (io.read(path) === artifact.content) continue;
      io.write(path, artifact.content);
      report.restored.push({ label, path });
    } catch (error) {
      report.failed.push({
        label,
        path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return report;
}

/** A review worktree that moved under the gate between review and commit. */
export interface ReviewWorktreeDrift {
  /** Set when HEAD is not the commit the reviews were written against. */
  headMoved?: { before: string; after: string };
  /** Tracked paths dirty at commit time that are not this run's reviews. */
  changedPaths: string[];
  /** Untracked paths outside the review artifacts — reported, not fatal. */
  untrackedPaths: string[];
}

function parseStatusEntry(line: string): { code: string; path: string } | null {
  if (line.length < 4) return null;
  const code = line.slice(0, 2);
  // `XY orig -> new` for a rename/copy; the destination is the live path.
  const rest = line.slice(3);
  const arrow = rest.lastIndexOf(" -> ");
  const raw = arrow === -1 ? rest : rest.slice(arrow + 4);
  return { code, path: raw.replace(/^"|"$/g, "").replace(/\\/g, "/") };
}

/**
 * Residual insurance for the shared review worktree (#136 review follow-up).
 *
 * `restoreCapturedReviewArtifacts` covers the two review files by content, but
 * a guardian's shell reaches the whole worktree. Immediately before the
 * artifact commit the gate re-reads HEAD and the porcelain status: the only
 * things allowed to have moved since the reviews started are the two
 * `review-<role>.md` artifacts. A moved HEAD (`git reset`, a branch checkout)
 * or a dirty tracked source file means the tree being committed — and the tree
 * the guardians reviewed — is not the tree the wave produced, and the gate must
 * say so rather than commit over it.
 *
 * Untracked additions are separated out and never fatal: guardian scratch
 * output has always been swept into the review commit by `git add -A`, and
 * blocking on a stray log file would trade a silent-staleness bug for a
 * spurious three-hour loss.
 *
 * @returns `null` when nothing beyond the review artifacts moved.
 */
export function detectReviewWorktreeDrift(args: {
  headShaBefore: string | null;
  headShaNow: string | null;
  statusPorcelain: string;
  specsDir: string;
}): ReviewWorktreeDrift | null {
  const specsPath = args.specsDir.replace(/\\/g, "/").replace(/\/+$/, "");
  const allowed = new Set([
    `${specsPath}/review-architect.md`,
    `${specsPath}/review-pm.md`,
  ]);
  const changedPaths: string[] = [];
  const untrackedPaths: string[] = [];
  for (const line of args.statusPorcelain.split("\n")) {
    if (line.trim() === "") continue;
    const entry = parseStatusEntry(line);
    if (!entry || allowed.has(entry.path)) continue;
    if (entry.code === "??") untrackedPaths.push(entry.path);
    else changedPaths.push(`${entry.code.trim()} ${entry.path}`);
  }
  const headMoved =
    args.headShaBefore && args.headShaNow && args.headShaBefore !== args.headShaNow
      ? { before: args.headShaBefore, after: args.headShaNow }
      : undefined;
  if (!headMoved && changedPaths.length === 0 && untrackedPaths.length === 0) {
    return null;
  }
  return { headMoved, changedPaths, untrackedPaths };
}

/** One line naming everything the drift check saw move. */
export function formatReviewWorktreeDrift(drift: ReviewWorktreeDrift): string {
  const parts: string[] = [];
  if (drift.headMoved) {
    parts.push(
      `HEAD moved ${drift.headMoved.before.slice(0, 12)} → ${drift.headMoved.after.slice(0, 12)}`,
    );
  }
  if (drift.changedPaths.length > 0) {
    parts.push(`tracked changes outside the reviews: ${drift.changedPaths.join(", ")}`);
  }
  if (drift.untrackedPaths.length > 0) {
    parts.push(`untracked: ${drift.untrackedPaths.join(", ")}`);
  }
  return parts.join("; ");
}

/**
 * Render the invocation's slice scope for the PM reviewer. The reviewer must
 * separate blockers in selected slices from PRD-level gaps outside the
 * invocation (ADR 0015).
 */
export function buildReviewScopeBlock(scope: ResolvedRunScope): string {
  const lines: string[] = [];
  lines.push("This run implemented ONLY the following slices:");
  lines.push("");
  for (const slice of scope.selected) {
    lines.push(`- ${slice.number} (#${slice.ghIssue}) ${slice.title}`);
  }
  if (scope.skipped.some(({ reason }) => reason === "narrowed")) {
    lines.push("");
    lines.push(
      "This invocation was narrowed to a subset of the run's scope of record. " +
        "Judge only the slices listed above: the narrowed-out slices below may " +
        "have been implemented by an earlier invocation on this branch, or not " +
        "at all — either way they are not this invocation's work.",
    );
  }
  if (scope.skipped.length > 0) {
    lines.push("");
    lines.push(
      "The following manifest slices were NOT executed by this run and are out of scope for this branch:",
    );
    lines.push("");
    for (const { slice, reason } of scope.skipped) {
      const label =
        reason === "hitl"
          ? "HITL — reserved for a human; AFK never runs it"
          : reason === "narrowed"
            ? "in this run's scope of record but not run by this invocation"
            : "not selected for this run";
      lines.push(`- ${slice.number} (#${slice.ghIssue}) ${slice.title} (${label})`);
    }
  } else {
    lines.push("");
    lines.push("No manifest slices were skipped — the full manifest ran.");
  }
  return lines.join("\n");
}

/** Draft-PR decision for the post-review gate. See ADR 0015. */
export interface PrCreationPlan {
  open: boolean;
  overridden: boolean;
  title: string;
  body: string;
  overrideNote?: string;
}

export interface AdoptedSlice extends SliceAdoption {
  ghIssue: string;
}

/**
 * Decide whether the draft PR opens and build its content. An override records
 * disagreement with one real guardian judgment; it never replaces a missing
 * verdict or clears two blocking judgments.
 */
export function buildPrCreationPlan(args: {
  prdSlug: string;
  specsDir: string;
  architect: artifacts.ReviewOutcome;
  pm: artifacts.ReviewOutcome;
  openPrOnOverride: boolean;
  closesIssues: readonly string[];
  adoptions?: readonly AdoptedSlice[];
}): PrCreationPlan {
  const architectOk = artifacts.isFavorableReviewOutcome(args.architect);
  const pmOk = artifacts.isFavorableReviewOutcome(args.pm);
  const architectBlocked = args.architect === "FIX-BEFORE-SHIP";
  const pmBlocked = args.pm === "FIX-BEFORE-SHIP";
  const overridden =
    args.openPrOnOverride &&
    ((architectBlocked && pmOk) || (pmBlocked && architectOk));
  const open = (architectOk && pmOk) || overridden;
  const overriddenGuardian = architectBlocked ? "architect" : "PM";
  const specsPath = args.specsDir.replace(/\\/g, "/");

  const sections: string[] = [
    `Automated implementation of ${args.prdSlug}.`,
    `See ${specsPath}/ for artifacts (including review-architect.md and review-pm.md).`,
  ];
  if (overridden) {
    sections.push(
      [
        "## Human override (--open-pr-on-override)",
        "",
        `This draft PR was opened by explicit operator override despite an unfavorable ${overriddenGuardian} verdict.`,
        "",
        `- Architect review: **${args.architect}**${architectBlocked ? " (overridden)" : ""}`,
        `- PM review: **${args.pm}**${pmBlocked ? " (overridden)" : ""}`,
        "",
        `Read ${specsPath}/review-${overriddenGuardian.toLowerCase()}.md for the blocking findings before merging.`,
      ].join("\n"),
    );
  }
  if (args.adoptions && args.adoptions.length > 0) {
    sections.push(
      [
        "## Adopted Slices",
        "",
        ...args.adoptions.map((adoption) =>
          [
            `### #${adoption.ghIssue}`,
            "",
            `- Adopter: ${inlineMarkdown(adoption.adopter)}`,
            `- Reason: ${inlineMarkdown(adoption.reason)}`,
            `- Branch: ${inlineMarkdown(adoption.branch)}`,
            `- Commit: ${inlineMarkdown(adoption.commit)}`,
          ].join("\n"),
        ),
      ].join("\n\n"),
    );
  }
  sections.push(
    args.closesIssues.map((issue) => `Closes #${issue}`).join("\n"),
  );

  return {
    open,
    overridden,
    title: `feat: ${args.prdSlug}`,
    body: sections.join("\n\n"),
    overrideNote: overridden
      ? `PR opened via --open-pr-on-override despite ${overriddenGuardian} verdict FIX-BEFORE-SHIP (architect: ${args.architect}, PM: ${args.pm}).`
      : undefined,
  };
}

export type ShipGateJournal = Pick<
  RunJournal,
  | "agentLog"
  | "event"
  | "phase"
  | "setPrOverrideNote"
  | "setPrUrl"
  | "setReviewOutcomes"
  | "setSanityGate"
>;

export interface ShipGateOptions {
  reviewRetries: number;
  reviewIdleTimeoutMs: number;
  reviewIdleWarningIntervalMs: number;
  maxAgentDurationMs?: number;
  serialReviews: boolean;
  openPrOnOverride: boolean;
}

export interface ShipGatePrOutcome {
  requested: boolean;
  overridden: boolean;
  url: string | null;
  number: number | null;
}

export interface ShipGateResult {
  verdict: "SHIP" | "BLOCKED";
  failureReason?: string;
  pr: ShipGatePrOutcome;
}

export type ShipGateInvoke = (
  options: InvokeOptions,
) => Promise<InvokeResult>;

export type ShipCommandRunner = (
  command: string,
  args: readonly string[],
  options: { cwd: string; encoding: "utf-8" },
) => string;

export interface RunShipGateArgs {
  repoRoot: string;
  reviewDir: string;
  featureBranch: string;
  defaultBranch: string;
  prdSlug: string;
  runSlug: string;
  specsDir: string;
  relevantFilesBlock: string;
  reviewScope: string;
  closesIssues: readonly string[];
  adoptions?: readonly AdoptedSlice[];
  cachedReviewPhase?: PersistedReviewPhase;
  invoke: ShipGateInvoke;
  journal: ShipGateJournal;
  options: ShipGateOptions;
  signal?: AbortSignal;
  /** Internal command seam used by direct tests for push/gh behavior. */
  runCommand?: ShipCommandRunner;
  /**
   * Internal command seam used by direct tests for the pre-ship sanity
   * subprocesses, so no suite pays a real dependency install.
   */
  sanityRunCommand?: SanityCommandRunner;
}

function blocked(
  failureReason: string,
  pr: Partial<ShipGatePrOutcome> = {},
): ShipGateResult {
  return {
    verdict: "BLOCKED",
    failureReason,
    pr: {
      requested: pr.requested ?? false,
      overridden: pr.overridden ?? false,
      url: pr.url ?? null,
      number: pr.number ?? null,
    },
  };
}

async function closeAgentLog(log: WriteStream): Promise<void> {
  log.end();
  try {
    await finished(log);
  } catch {
    // Agent logs are best-effort and must not mask the review outcome.
  }
}

function isCancelled(error: unknown, signal?: AbortSignal): boolean {
  return error instanceof CancelledError || signal?.aborted === true;
}

const defaultRunCommand: ShipCommandRunner = (command, args, options) =>
  execFileSync(command, [...args], options);

function inlineMarkdown(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Run every post-wave shipping decision through one interface: sanity,
 * guardian reviews, review caching, artifact commit, and draft PR handling.
 */
export async function runShipGate(
  args: RunShipGateArgs,
): Promise<ShipGateResult> {
  const {
    repoRoot,
    reviewDir,
    featureBranch,
    defaultBranch,
    prdSlug,
    runSlug,
    specsDir,
    relevantFilesBlock,
    reviewScope,
    closesIssues,
    adoptions,
    cachedReviewPhase,
    invoke,
    journal,
    options,
    signal,
  } = args;
  const runCommand = args.runCommand ?? defaultRunCommand;
  const sanityRunCommand = args.sanityRunCommand;

  if (signal?.aborted) {
    return blocked(
      "cancelled before the pre-ship sanity gate and guardian reviews ran",
    );
  }

  const relativeSpecsDir = specsDir.replace(/\\/g, "/");

  journal.phase("Running pre-ship sanity gate...", "log");
  // Cache the gate by the reviewed tree's SHA (ADR 0015): a re-entry
  // against the same content — e.g. after a review infrastructure
  // failure, or when only docs/review commits landed — must not pay
  // the full typecheck+lint+tests cost again. Only PASS is cached.
  const treeShaBefore = git.resolveTree(reviewDir);
  const cachedSanity = cachedReviewPhase?.sanity;
  const usesCachedSanity =
    !!treeShaBefore && cachedSanity?.treeSha === treeShaBefore;
  let sanity: SanityGateResult;
  if (usesCachedSanity) {
    journal.event({
      type: "run-phase-started",
      phase: "sanity",
      cached: true,
    });
    sanity = { ok: true, failures: [], failureKind: null };
    journal.phase(
      `  ↩️  Reusing cached pre-ship sanity PASS for unchanged tree ${treeShaBefore.slice(0, 12)}.`,
      "log",
    );
  } else {
    journal.event({ type: "run-phase-started", phase: "sanity" });
    sanity = runPreShipSanity(reviewDir, sanityRunCommand);
  }
  journal.event({
    type: "run-phase-ended",
    phase: "sanity",
    cached: usesCachedSanity ? true : undefined,
    verdict: sanity.ok ? "PASS" : "FAIL",
    failureKind: sanity.ok ? undefined : sanity.failureKind ?? undefined,
  });
  journal.setSanityGate(sanity);
  if (!sanity.ok) {
    const failedSteps = sanity.failures.join(", ");
    // A CONFIGURATION failure means the commands never really ran, so the
    // block belongs to the environment, not to the reviewed tree (#101).
    // Written once, for both the run-log line and the blocker reason.
    const reason =
      sanity.failureKind === "CONFIGURATION"
        ? `sanity gate failed (CONFIGURATION: ${failedSteps}) — ` +
          "a configuration failure of the environment, not a code failure" +
          `${sanity.detail ? `: ${sanity.detail}` : ""}`
        : `sanity gate failed (${failedSteps})`;
    journal.phase(
      `  ❌ Pre-ship ${reason}. Skipping guardian reviews and PR creation.`,
    );
    return blocked(
      `pre-ship ${reason} — guardian reviews and PR creation were skipped`,
    );
  }
  journal.phase("  ✅ Pre-ship sanity gate passed.", "log");

  const headShaBefore = git.resolveCommit(reviewDir, "HEAD");

  const runGuardianReview = async (
    kind: "architect" | "pm",
  ): Promise<ReviewRunResult> => {
    const role = kind === "architect" ? "architect-review" : "pm-review";
    const label = kind === "architect" ? "Architect" : "PM";
    const reviewFileName =
      kind === "architect" ? "review-architect.md" : "review-pm.md";
    const prompt =
      kind === "architect"
        ? renderPrompt("architect-review", {
            SPECS_DIR: relativeSpecsDir,
            RELEVANT_FILES: relevantFilesBlock,
          })
        : renderPrompt("pm-review", {
            SPECS_DIR: relativeSpecsDir,
            RELEVANT_FILES: relevantFilesBlock,
            RUN_SCOPE: reviewScope,
          });
    let lastFailure: ReviewRunResult = { outcome: "NEVER_RAN" };
    for (let attempt = 1; attempt <= options.reviewRetries + 1; attempt++) {
      journal.event({
        type: "run-phase-started",
        phase: role,
        attempt,
      });
      const log = journal.agentLog(
        "all",
        role,
        attempt > 1 ? attempt : undefined,
      );
      let sawOutput = false;
      try {
        await invoke({
          role,
          agent: role,
          bare: true,
          prompt,
          cwd: reviewDir,
          logStream: log,
          idleTimeoutMs: options.reviewIdleTimeoutMs,
          idleWarningIntervalMs: options.reviewIdleWarningIntervalMs,
          maxDurationMs: options.maxAgentDurationMs,
          onStreamEvent: () => {
            sawOutput = true;
          },
        });
      } catch (error) {
        if (isCancelled(error, signal)) throw error;
        const failureClass = artifacts.classifyReviewFailure(
          error,
          sawOutput,
        );
        const message =
          error instanceof Error ? error.message : String(error);
        lastFailure = { outcome: failureClass, detail: message };
        journal.event({
          type: "run-phase-ended",
          phase: role,
          attempt,
          verdict: failureClass,
        });
        if (attempt <= options.reviewRetries) {
          journal.phase(
            `  ⚠️  ${label} review ${failureClass}: ${message}. Infrastructure retry ${attempt}/${options.reviewRetries}.`,
          );
          continue;
        }
        journal.phase(
          `  ⚠️  ${label} review ${failureClass} after ${attempt} attempt(s): ${message}. No PR will be opened.`,
        );
        return lastFailure;
      } finally {
        await closeAgentLog(log);
      }
      const reviewPath = join(reviewDir, specsDir, reviewFileName);
      // Capture the artifact now, while it is still exactly what this agent
      // wrote. The other guardian shares this worktree and is still running
      // (issue #136), so both the verdict and the committed content come from
      // this snapshot rather than from a later re-read of the path.
      const captured: CapturedReviewArtifact = {
        label,
        path: reviewPath,
        content: defaultReviewArtifactIo.read(reviewPath),
      };
      const verdict = artifacts.parseReviewVerdict(captured.content);
      if (verdict === "UNPARSEABLE") {
        journal.phase(
          `  ⚠️  Could not parse ${label} review verdict from ${reviewPath} — expected a "**Verdict:** SHIP | ACCEPT-WITH-NOTES | FIX-BEFORE-SHIP" line. Treating as UNPARSEABLE (no PR will be opened).`,
          "warn",
        );
      }
      journal.event({
        type: "run-phase-ended",
        phase: role,
        attempt,
        verdict,
      });
      return { outcome: verdict, captured };
    }
    return lastFailure;
  };

  const reuseCachedReview = (
    cached:
      | { headSha: string; verdict: "SHIP" | "ACCEPT-WITH-NOTES" }
      | undefined,
    label: string,
  ): ReviewRunResult | undefined => {
    if (cached && headShaBefore && cached.headSha === headShaBefore) {
      journal.phase(
        `  ↩️  Reusing cached ${label} review verdict ${cached.verdict} for unchanged HEAD ${headShaBefore.slice(0, 12)}.`,
        "log",
      );
      return { outcome: cached.verdict };
    }
    return undefined;
  };
  const cachedArchitect = reuseCachedReview(
    cachedReviewPhase?.architect,
    "architect",
  );
  const cachedPm = reuseCachedReview(cachedReviewPhase?.pm, "PM");
  for (const [phase, cached] of [
    ["architect-review", cachedArchitect],
    ["pm-review", cachedPm],
  ] as const) {
    if (!cached) continue;
    journal.event({
      type: "run-phase-started",
      phase,
      cached: true,
    });
    journal.event({
      type: "run-phase-ended",
      phase,
      cached: true,
      verdict: cached.outcome,
    });
  }

  let architectResult: ReviewRunResult;
  let pmResult: ReviewRunResult;
  if (options.serialReviews) {
    architectResult =
      cachedArchitect ?? (await runGuardianReview("architect"));
    pmResult = cachedPm ?? (await runGuardianReview("pm"));
  } else {
    const [architectSettled, pmSettled] = await Promise.allSettled([
      cachedArchitect
        ? Promise.resolve(cachedArchitect)
        : runGuardianReview("architect"),
      cachedPm ? Promise.resolve(cachedPm) : runGuardianReview("pm"),
    ]);
    if (architectSettled.status === "rejected") {
      throw architectSettled.reason;
    }
    if (pmSettled.status === "rejected") throw pmSettled.reason;
    architectResult = architectSettled.value;
    pmResult = pmSettled.value;
  }

  journal.setReviewOutcomes(architectResult, pmResult);

  const restore = restoreCapturedReviewArtifacts([
    architectResult.captured,
    pmResult.captured,
  ]);
  for (const { label, path } of restore.restored) {
    const message =
      `${label} review artifact was changed in the review worktree after the ` +
      `agent finished — restored the agent's own output before committing: ${path} (#136).`;
    journal.phase(`  ⚠️  ${message}`, "warn");
    journal.event({
      type: "warn",
      reason: "review-artifact-restored",
      message,
    });
  }
  for (const { label, path, error } of restore.failed) {
    const message =
      `${label} review artifact could not be restored at ${path}: ${error}. ` +
      "The committed review may not be the artifact this run's agent wrote — " +
      "read it before trusting its verdict (#136).";
    journal.phase(`  ⚠️  ${message}`, "warn");
    journal.event({
      type: "warn",
      reason: "review-artifact-restore-failed",
      message,
    });
  }

  // Residual insurance: the restore above covers the two review files by
  // content, but a guardian's shell reaches the whole worktree. Nothing else
  // is allowed to have moved since the reviews started (#136 follow-up).
  // One `git status --porcelain` serves both this check and the
  // is-there-anything-to-commit question below: `hasUncommittedChanges` runs
  // the identical command, so re-reading it would spawn a second git for an
  // answer already in hand.
  const statusBeforeCommit = git.statusPorcelain(reviewDir);
  const drift = detectReviewWorktreeDrift({
    headShaBefore,
    headShaNow: git.resolveCommit(reviewDir, "HEAD"),
    statusPorcelain: statusBeforeCommit,
    specsDir,
  });
  if (drift) {
    const detail = formatReviewWorktreeDrift(drift);
    if (drift.headMoved || drift.changedPaths.length > 0) {
      const message =
        "review worktree moved between the guardian reviews and the artifact " +
        `commit — ${detail}. Refusing to commit over it: the reviewed tree is ` +
        "not the tree the wave produced (#136).";
      journal.phase(`  ❌ ${message}`, "warn");
      journal.event({
        type: "warn",
        reason: "review-worktree-drift",
        message,
      });
      return blocked(message);
    }
    journal.phase(
      `  ⚠️  Review worktree holds files outside this run's reviews — ${detail}. Committing them with the reviews.`,
      "warn",
    );
    journal.event({
      type: "warn",
      reason: "review-worktree-drift",
      message: `untracked files beside the review artifacts — ${detail}`,
    });
  }

  if (statusBeforeCommit !== "") {
    try {
      git.commitAll(
        reviewDir,
        `docs(${prdSlug}): add post-impl guardian reviews`,
      );
    } catch (error) {
      if (git.hasUncommittedChanges(reviewDir)) throw error;
    }
  }

  const headShaAfter = git.resolveCommit(reviewDir, "HEAD");
  const treeShaAfter = git.resolveTree(reviewDir);
  const nextReviewPhase: PersistedReviewPhase = {};
  // Only PASS is cached (ADR 0015). Sanity failure returns BLOCKED before
  // reaching this point, but the guard keeps the invariant enforced at the
  // write site rather than by control flow alone.
  if (sanity.ok && treeShaAfter) {
    nextReviewPhase.sanity = { treeSha: treeShaAfter, ok: true };
  }
  if (headShaAfter) {
    if (artifacts.isFavorableReviewOutcome(architectResult.outcome)) {
      nextReviewPhase.architect = {
        headSha: headShaAfter,
        verdict: architectResult.outcome,
      };
    }
    if (artifacts.isFavorableReviewOutcome(pmResult.outcome)) {
      nextReviewPhase.pm = {
        headSha: headShaAfter,
        verdict: pmResult.outcome,
      };
    }
  }
  saveReviewPhase(
    repoRoot,
    runSlug,
    Object.keys(nextReviewPhase).length > 0
      ? nextReviewPhase
      : undefined,
  );

  const prPlan = buildPrCreationPlan({
    prdSlug,
    specsDir,
    architect: architectResult.outcome,
    pm: pmResult.outcome,
    openPrOnOverride: options.openPrOnOverride,
    closesIssues,
    adoptions,
  });
  journal.event({ type: "run-phase-started", phase: "draft-pr" });
  let prUrl: string | null = null;
  let prNumber: number | null = null;
  if (!prPlan.open) {
    journal.event({
      type: "run-phase-ended",
      phase: "draft-pr",
      verdict: "SKIPPED",
    });
    return blocked(
      `guardian verdicts kept the draft PR closed (architect: ${architectResult.outcome}, PM: ${pmResult.outcome})`,
    );
  }

  if (prPlan.overridden) {
    journal.phase(`  ⚠️  ${prPlan.overrideNote}`, "warn");
    journal.setPrOverrideNote(prPlan.overrideNote!);
  }
  try {
    runCommand("git", ["push", "-u", "origin", featureBranch], {
      cwd: repoRoot,
      encoding: "utf-8",
    });
    prUrl = runCommand(
      "gh",
      [
        "pr",
        "create",
        "--draft",
        "--base",
        defaultBranch,
        "--head",
        featureBranch,
        "--title",
        prPlan.title,
        "--body",
        prPlan.body,
      ],
      { cwd: repoRoot, encoding: "utf-8" },
    ).trim();
    prNumber = parseDraftPrNumber(prUrl);
    journal.setPrUrl(prUrl);
  } catch {
    try {
      const existing = JSON.parse(
        runCommand(
          "gh",
          ["pr", "view", featureBranch, "--json", "number,url"],
          { cwd: repoRoot, encoding: "utf-8" },
        ),
      ) as { number?: number; url?: string };
      if (existing.url) {
        prUrl = existing.url;
        prNumber =
          existing.number ?? parseDraftPrNumber(existing.url);
        journal.setPrUrl(existing.url);
      }
    } catch {
      // PR creation and lookup are best-effort.
    }
  }
  journal.event({
    type: "run-phase-ended",
    phase: "draft-pr",
    verdict: prUrl ? "READY" : "FAILED",
  });

  return {
    verdict: "SHIP",
    pr: {
      requested: true,
      overridden: prPlan.overridden,
      url: prUrl,
      number: prNumber,
    },
  };
}

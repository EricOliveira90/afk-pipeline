import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import {
  CONTRACT_REVIEW_FILENAME,
  formatContractReviewFindings,
  type ContractReviewFinding,
  type RecordedContractVerdict,
} from "./contract-review.js";

export type ContractStatus = "DRAFT" | "NEGOTIATING" | "LOCKED" | "UNKNOWN";
export type QAVerdict = "PASS" | "FAIL" | "UNKNOWN";
export type QAFailureClass = "NONE" | "IMPLEMENTATION" | "INFRASTRUCTURE";
/**
 * Verdict parsed from a guardian review file. `UNPARSEABLE` means the
 * agent finished but the review file is missing or carries no
 * recognizable verdict marker. Terminal: the agent had its chance and
 * produced an ambiguous result — re-running would grade a fresh
 * opinion, not recover a lost one. See ADR 0015.
 */
export type ReviewVerdict =
  | "SHIP"
  | "ACCEPT-WITH-NOTES"
  | "FIX-BEFORE-SHIP"
  | "UNPARSEABLE";

/**
 * Full outcome of one guardian review, extending real verdicts with the
 * infrastructure failure classes of ADR 0015 (mirroring ADR 0014's QA
 * failure classes):
 *
 * - `NEVER_RAN`    — the agent process died before producing any
 *                    structured output (spawn/wrapper failures, e.g. an
 *                    AWS-config persist race). Infrastructure-class:
 *                    retried within the run.
 * - `DIED_MID_RUN` — the agent showed real activity and was then killed
 *                    (idle watcher, tool cap) or exited nonzero.
 *                    Infrastructure-class: retried within the run.
 *
 * Only `UNPARSEABLE` and the three real verdicts are terminal.
 */
export type ReviewOutcome = ReviewVerdict | "NEVER_RAN" | "DIED_MID_RUN";

export type ReviewFailureClass = "NEVER_RAN" | "DIED_MID_RUN";

/** Outcomes that allow the draft PR to open. */
export function isFavorableReviewOutcome(
  outcome: ReviewOutcome,
): outcome is "SHIP" | "ACCEPT-WITH-NOTES" {
  return outcome === "SHIP" || outcome === "ACCEPT-WITH-NOTES";
}

/** Infrastructure-class review outcomes retry within the run (ADR 0015). */
export function isReviewInfrastructureFailure(
  outcome: ReviewOutcome,
): outcome is ReviewFailureClass {
  return outcome === "NEVER_RAN" || outcome === "DIED_MID_RUN";
}

/**
 * Classify a rejected guardian review invocation.
 *
 * - An idle-watcher or tool-cap kill always means the agent was doing
 *   real work before dying: `DIED_MID_RUN`.
 * - Otherwise the class hinges on whether the invocation produced any
 *   parsed stream activity before failing (`sawOutput`, fed by the
 *   provider's `onStreamEvent`). A wrapper that dies at spawn — e.g.
 *   `codex-wrapper: error: failed to persist AWS config file` — never
 *   emits a structured event, so it classifies as `NEVER_RAN`.
 *
 * Providers without stream parsing never report activity; their exit
 * failures conservatively classify as `NEVER_RAN`. That is safe because
 * both classes share identical retry semantics — only reporting differs.
 */
export function classifyReviewFailure(
  error: unknown,
  sawOutput: boolean,
): ReviewFailureClass {
  const message = error instanceof Error ? error.message : String(error);
  if (/idle for .+killed/i.test(message)) return "DIED_MID_RUN";
  if (/exceeded \d+ tool calls/i.test(message)) return "DIED_MID_RUN";
  return sawOutput ? "DIED_MID_RUN" : "NEVER_RAN";
}

function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf-8") : null;
}

function matchField(content: string, pattern: RegExp): string | null {
  const m = content.match(pattern);
  return m?.[1]?.trim() ?? null;
}

export function readContractStatus(contractPath: string): ContractStatus {
  const content = readIfExists(contractPath);
  if (!content) return "UNKNOWN";

  const status = matchField(content, /\*\*Status:\*\*\s*(\S+)/i);
  if (!status) return "NEGOTIATING";

  const upper = status.toUpperCase();
  if (upper === "LOCKED") return "LOCKED";
  if (upper === "DRAFT") return "DRAFT";
  return "NEGOTIATING";
}

export function readQAVerdict(qaReportPath: string): QAVerdict {
  const content = readIfExists(qaReportPath);
  if (!content) return "UNKNOWN";
  // Find all Verdict fields and use the last one (evaluator may write
  // intermediate verdicts in summary tables before the final one).
  const matches = content.match(/\*\*Verdict:\*\*\s*(\S+)/gi);
  if (!matches || matches.length === 0) return "UNKNOWN";
  const last = matches[matches.length - 1]!;
  const v = last.match(/\*\*Verdict:\*\*\s*(\S+)/i)?.[1]?.toUpperCase();
  if (v === "PASS") return "PASS";
  if (v === "FAIL") return "FAIL";
  return "UNKNOWN";
}

export function readQAFailureClass(qaReportPath: string): QAFailureClass {
  const content = readIfExists(qaReportPath);
  if (!content) return "IMPLEMENTATION";
  const value = matchField(
    content,
    /\*\*Failure class:\*\*\s*(NONE|IMPLEMENTATION|INFRASTRUCTURE)/i,
  )?.toUpperCase();
  if (value === "NONE" || value === "INFRASTRUCTURE") return value;
  // Backwards-compatible and fail-closed: an unclassified FAIL remains an
  // implementation failure and still consumes one of the three QA rounds.
  return "IMPLEMENTATION";
}

export function archiveQAReport(
  reportPath: string,
  archivePath: string,
): boolean {
  if (!existsSync(reportPath)) return false;
  cpSync(reportPath, archivePath);
  return true;
}

export function readQARound(qaReportPath: string): number {
  const content = readIfExists(qaReportPath);
  if (!content) return 0;
  const round = matchField(content, /\*\*Round:\*\*\s*(\d+)/i);
  return round ? parseInt(round, 10) : 0;
}

export function readReviewVerdict(reviewPath: string): ReviewVerdict {
  const content = readIfExists(reviewPath);
  if (!content) return "UNPARSEABLE";
  // Accept several formats seen in the wild from guardian agents:
  //   **Verdict:** SHIP
  //   *Verdict:* SHIP
  //   ## Verdict: SHIP     (markdown header)
  //   ### Verdict SHIP     (header, no colon)
  //   Verdict: SHIP        (plain)
  // The pinned format in the prompt is `**Verdict:** <value>`; the loose
  // match is defence-in-depth against agents formatting it differently.
  const pattern = /^\s*#{0,6}\s*\*{0,3}\s*Verdict\s*:?\s*\*{0,3}\s*([^\n]+)/im;
  const m = content.match(pattern);
  const captured = m?.[1]?.trim() ?? null;
  if (!captured) return "UNPARSEABLE";
  // Strip any leftover markdown emphasis (e.g. "**SHIP**") and normalize.
  const upper = captured.replace(/\*+/g, "").trim().toUpperCase();
  if (upper === "SHIP") return "SHIP";
  if (
    upper.startsWith("ACCEPT-WITH-NOTES") ||
    upper.startsWith("ACCEPT WITH NOTES")
  )
    return "ACCEPT-WITH-NOTES";
  if (
    upper.startsWith("FIX-BEFORE-SHIP") ||
    upper.startsWith("FIX BEFORE SHIP")
  )
    return "FIX-BEFORE-SHIP";
  return "UNPARSEABLE";
}

/**
 * Read the planner's declared file list from `## Files expected to change`
 * in `contract.md`. Used by the lane partitioner to detect file-overlap
 * between sibling slices in a wave.
 *
 * Return semantics:
 * - `undefined` — the contract file is missing OR the section heading is
 *   absent. The partitioner treats this as "conflicts with everything"
 *   (worst-case fold into the shared undeclared lane).
 * - `[]` — section is present but produced no usable paths (empty,
 *   `<rough list>` placeholder, `<unknown>` opt-out). The partitioner
 *   treats this as "no overlap with anything" — slice runs alone.
 *
 * Path extraction handles bullets `- path` and `* path`, optional backtick
 * wrapping, and trailing prose annotations:
 *   - `src/cli.py (rename to support recipe group)` → `src/cli.py`
 *   - `` `src/lanes.ts` (new) `` → `src/lanes.ts`
 * Lines whose extracted token is itself an angle-bracket placeholder
 * (`<unknown>`, `<rough list>`) are skipped.
 */
export function readContractFiles(contractPath: string): string[] | undefined {
  const content = readIfExists(contractPath);
  if (content === null) return undefined;

  const headingRe = /^##\s+Files expected to change\s*$/im;
  const headingMatch = content.match(headingRe);
  if (!headingMatch || headingMatch.index === undefined) return undefined;

  const after = content.slice(headingMatch.index + headingMatch[0].length);
  const nextHeading = after.match(/^##\s+/m);
  const body =
    nextHeading && nextHeading.index !== undefined
      ? after.slice(0, nextHeading.index)
      : after;

  const files: string[] = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const bullet = rawLine.match(/^\s*[-*]\s+(.+?)\s*$/);
    if (!bullet) continue;
    const item = bullet[1]!.trim();

    // Skip placeholders like <rough list>, <unknown>.
    if (/^<[^>]*>$/.test(item)) continue;

    let path: string;
    if (item.startsWith("`")) {
      const close = item.indexOf("`", 1);
      if (close < 0) continue;
      path = item.slice(1, close).trim();
    } else {
      const stopIdx = item.search(/[\s(]/);
      path = (stopIdx < 0 ? item : item.slice(0, stopIdx)).trim();
    }

    if (path && !/^<[^>]*>$/.test(path)) files.push(path);
  }

  return files;
}

export interface NegotiationFailureDetails {
  repoRoot: string;
  runSlug: string;
  sliceDir: string;
  sliceNumber: string;
  ghIssue: string;
  title: string;
  round: number;
  outcome: "ESCALATE" | "STUCK";
  verdict: RecordedContractVerdict;
  feedbackPath: string;
  contractPath: string;
  contextPath: string;
  capDecision?: string;
  /**
   * Findings from the last review artifact that parsed. Rendered into
   * `stuck.md` verbatim so the operator reads the same structured gaps
   * the planner was given, rather than a scrape of the markdown
   * companion.
   */
  findings?: readonly ContractReviewFinding[];
}

export interface NegotiationArchiveResult {
  archiveDir: string;
  archived: boolean;
  error?: string;
}

export function negotiationArchiveDir(
  repoRoot: string,
  runSlug: string,
  sliceNumber: string,
): string {
  return join(repoRoot, ".afk", "artifacts", runSlug, `slice-${sliceNumber}`);
}

/**
 * Where every contract review attempt is kept. Under the repo root, not
 * the slice worktree: the worktree is torn down, and the audit trail of
 * what each evaluator attempt actually wrote has to outlive it.
 */
export function contractReviewArchiveDir(
  repoRoot: string,
  runSlug: string,
  sliceNumber: string,
): string {
  return join(
    negotiationArchiveDir(repoRoot, runSlug, sliceNumber),
    "reviews",
  );
}

/**
 * Archive one contract review attempt — the canonical JSON artifact and
 * its markdown companion — under names stamped with both the round and
 * the attempt within that round.
 *
 * Every attempt is kept, including the ones that produced a malformed or
 * missing artifact: those are precisely the attempts an operator needs to
 * read. Because the working artifact has a fixed name and is deleted
 * before each attempt, the archive is the only record of an earlier
 * attempt, so the copy refuses to overwrite an existing file rather than
 * losing one silently.
 *
 * Returns the archived file names. Best-effort by contract: callers warn
 * on failure rather than failing a negotiation over an audit copy.
 */
export function archiveContractReviewAttempt(details: {
  sliceDir: string;
  archiveDir: string;
  round: number;
  attempt: number;
}): string[] {
  const { sliceDir, archiveDir, round, attempt } = details;
  const suffix = `r${round}-a${attempt}`;
  const copies: Array<[source: string, target: string]> = [
    [CONTRACT_REVIEW_FILENAME, `contract-review-${suffix}.json`],
    [`feedback-r${round}.md`, `feedback-${suffix}.md`],
  ];
  const archived: string[] = [];
  for (const [sourceName, targetName] of copies) {
    const source = join(sliceDir, sourceName);
    if (!existsSync(source)) continue;
    mkdirSync(archiveDir, { recursive: true });
    cpSync(source, join(archiveDir, targetName), { errorOnExist: true, force: false });
    archived.push(targetName);
  }
  return archived;
}

/**
 * Untracked slice spec artifacts, in archive order: the fixed set plus
 * every round-numbered file the slice actually produced.
 *
 * These files live inside the slice worktree and are never committed, so
 * they exist in exactly one place until something copies them out. That
 * is why both archive callers — the ESCALATE/STUCK preserve path and the
 * pre-restart archive (#113) — take the list from here rather than each
 * naming its own subset and drifting.
 */
export function sliceArtifactNames(sliceDir: string): string[] {
  const rounds = existsSync(sliceDir)
    ? readdirSync(sliceDir)
        .filter((name) =>
          /^(feedback-r\d+|qa-report(-r\d+)?|uat-report(-r\d+)?)\.md$/i.test(
            name,
          ),
        )
        .sort()
    : [];
  return ["contract.md", "context.md", ...rounds, "handoff.md", "stuck.md"];
}

export function archiveNegotiationArtifacts(
  sliceDir: string,
  archiveDir: string,
): void {
  mkdirSync(archiveDir, { recursive: true });
  for (const name of sliceArtifactNames(sliceDir)) {
    const source = join(sliceDir, name);
    if (existsSync(source)) cpSync(source, join(archiveDir, name));
  }
}

/**
 * Copy a slice's untracked spec artifacts out of its worktree before a
 * from-base restart force-resets the branch and recreates the worktree
 * (#113). Returns the archive directory, or `null` when the slice dir
 * held nothing worth keeping.
 *
 * Archives land in a numbered `pre-restart-<n>` subdirectory of the
 * slice's usual archive dir, so a second restart cannot overwrite the
 * first one's copies and neither can clobber an ESCALATE/STUCK archive
 * sitting alongside them. The index is the next free one on disk — no
 * clock, so the path is reproducible in tests.
 */
export function archiveArtifactsBeforeRestart(
  repoRoot: string,
  runSlug: string,
  sliceNumber: string,
  sliceDir: string,
): string | null {
  const present = sliceArtifactNames(sliceDir).filter((name) =>
    existsSync(join(sliceDir, name)),
  );
  if (present.length === 0) return null;

  const parent = negotiationArchiveDir(repoRoot, runSlug, sliceNumber);
  let index = 1;
  while (existsSync(join(parent, `pre-restart-${index}`))) index++;
  const archiveDir = join(parent, `pre-restart-${index}`);
  mkdirSync(archiveDir, { recursive: true });
  for (const name of present) {
    cpSync(join(sliceDir, name), join(archiveDir, name));
  }
  return archiveDir;
}

function displayPath(repoRoot: string, path: string): string {
  return relative(repoRoot, path).replace(/\\/g, "/");
}

/**
 * The gaps that ended negotiation. Structured findings win when the last
 * review artifact parsed; otherwise the markdown companion is quoted
 * whole, which is all that is left when negotiation died before any
 * artifact was validated.
 */
function unresolvedGaps(
  findings: readonly ContractReviewFinding[] | undefined,
  feedback: string | null,
): string {
  if (findings && findings.length > 0) {
    return formatContractReviewFindings(findings);
  }
  if (!feedback) {
    return "(No feedback file was produced; inspect the evaluator log.)";
  }
  return feedback.trim();
}

export function preserveNegotiationFailure(
  details: NegotiationFailureDetails,
  warn: (message: string) => void = (message) => console.error(message),
): NegotiationArchiveResult {
  const {
    repoRoot,
    runSlug,
    sliceDir,
    sliceNumber,
    ghIssue,
    title,
    round,
    outcome,
    verdict,
    feedbackPath,
    contractPath,
    contextPath,
    capDecision,
    findings,
  } = details;
  const archiveDir = negotiationArchiveDir(repoRoot, runSlug, sliceNumber);
  const feedback = readIfExists(feedbackPath);
  const stuckPath = join(sliceDir, "stuck.md");
  const archiveContract = join(archiveDir, "contract.md");
  const archiveContext = join(archiveDir, "context.md");
  const archiveFeedback = join(archiveDir, `feedback-r${round}.md`);
  const stuck = [
    "# Contract negotiation stuck",
    "",
    `- Slice: #${ghIssue} ${title}`,
    `- Outcome: ${outcome}`,
    `- Round: ${round}`,
    `- Final verdict: VERDICT: ${verdict}`,
    `- Round-cap decision: ${capDecision ?? "No extension decision was recorded."}`,
    "",
    "## Unresolved gaps",
    "",
    unresolvedGaps(findings, feedback),
    "",
    "## Next action",
    "",
    "Update the source issue body (the local issue manifest when present, otherwise the GitHub issue) to close the unresolved acceptance and test-plan gaps above, then rerun the slice.",
    "",
    "## Artifact locations",
    "",
    `- Working contract: ${displayPath(repoRoot, contractPath)}`,
    `- Working context: ${displayPath(repoRoot, contextPath)}`,
    `- Working feedback: ${displayPath(repoRoot, feedbackPath)}`,
    `- Archive directory: ${displayPath(repoRoot, archiveDir)}`,
    `- Archived contract: ${displayPath(repoRoot, archiveContract)}`,
    `- Archived context: ${displayPath(repoRoot, archiveContext)}`,
    `- Archived feedback: ${displayPath(repoRoot, archiveFeedback)}`,
    "",
  ].join("\n");
  writeFileSync(stuckPath, stuck, "utf-8");

  try {
    archiveNegotiationArtifacts(sliceDir, archiveDir);
    return { archiveDir, archived: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    warn(
      `[afk] Warning: failed to archive negotiation artifacts to ${displayPath(repoRoot, archiveDir)}: ${error}`,
    );
    return { archiveDir, archived: false, error };
  }
}

export function hasStuckFile(sliceDir: string): boolean {
  return existsSync(`${sliceDir}/stuck.md`);
}

export function hasPassingQA(sliceDir: string): boolean {
  return readQAVerdict(`${sliceDir}/qa-report.md`) === "PASS";
}

/**
 * Write `**Status:** LOCKED` into `contract.md`. Replaces the first
 * matching `**Status:**` line in document order — including one nested
 * in a fenced code block, though contracts in production format have
 * exactly one Status line at the top. Inserts a Status line after the
 * H1 heading if none is present.
 *
 * Owned by the orchestrator: callers run this after the contract
 * evaluator returns `ACCEPT`. Agents do not edit Status. See ADR 0008.
 */
export function lockContract(contractPath: string): void {
  writeContractStatus(contractPath, "LOCKED");
}

/**
 * Write `**Status:** NEGOTIATING` into `contract.md` — the counterpart
 * to {@link lockContract}, for the one case where the orchestrator locks
 * a contract and then takes the lock back: a gate outside the
 * negotiation loop refuses the locked contract and sends it to the
 * planner for another round (ADR 0028).
 *
 * The file must not keep claiming `LOCKED` while it is being revised.
 * The generator enforces its own Status invariant ("if Status is not
 * LOCKED, stop"), so a stale LOCKED is exactly the disk-versus-
 * orchestrator divergence ADR 0008 exists to prevent — and it would let
 * a contract the pipeline already rejected reach generation.
 */
export function reopenContract(contractPath: string): void {
  writeContractStatus(contractPath, "NEGOTIATING");
}

/**
 * Set the contract's Status line. Replaces the first matching
 * `**Status:**` line in document order — including one nested in a
 * fenced code block, though contracts in production format have exactly
 * one Status line at the top. Inserts a Status line after the H1
 * heading if none is present.
 *
 * Owned by the orchestrator; agents do not edit Status. See ADR 0008.
 */
function writeContractStatus(
  contractPath: string,
  status: "LOCKED" | "NEGOTIATING",
): void {
  const content = existsSync(contractPath)
    ? readFileSync(contractPath, "utf-8")
    : "";

  const statusRe = /^\*\*Status:\*\*[ \t]*\S+[ \t]*$/im;
  const line = `**Status:** ${status}`;
  let next: string;

  if (statusRe.test(content)) {
    next = content.replace(statusRe, line);
  } else if (content.length > 0) {
    // Insert after the first H1, or prepend if no H1.
    const h1 = content.match(/^#\s+.+$/m);
    if (h1 && h1.index !== undefined) {
      const at = h1.index + h1[0].length;
      next = content.slice(0, at) + `\n\n${line}` + content.slice(at);
    } else {
      next = `${line}\n\n` + content;
    }
  } else {
    next = `${line}\n`;
  }

  writeFileSync(contractPath, next, "utf-8");
}

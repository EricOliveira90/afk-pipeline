import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";

export type ContractStatus = "DRAFT" | "NEGOTIATING" | "LOCKED" | "UNKNOWN";
export type EvaluatorVerdict = "ACCEPT" | "REVISE" | "ESCALATE" | "UNKNOWN";
export type QAVerdict = "PASS" | "FAIL" | "UNKNOWN";
export type ReviewVerdict =
  | "SHIP"
  | "ACCEPT-WITH-NOTES"
  | "FIX-BEFORE-SHIP"
  | "UNKNOWN";

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

export function readEvaluatorVerdict(
  feedbackPath: string,
): EvaluatorVerdict {
  const content = readIfExists(feedbackPath);
  if (!content) return "UNKNOWN";
  const match = content.match(
    /\bVERDICT(?:\s*:\s*|\s+)\*{0,2}\s*(ACCEPT|REVISE|ESCALATE)\b/i,
  );
  const v = match?.[1]?.toUpperCase();
  if (v === "ACCEPT") return "ACCEPT";
  if (v === "REVISE") return "REVISE";
  if (v === "ESCALATE") return "ESCALATE";
  return "UNKNOWN";
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

export function readQARound(qaReportPath: string): number {
  const content = readIfExists(qaReportPath);
  if (!content) return 0;
  const round = matchField(content, /\*\*Round:\*\*\s*(\d+)/i);
  return round ? parseInt(round, 10) : 0;
}

export function readReviewVerdict(reviewPath: string): ReviewVerdict {
  const content = readIfExists(reviewPath);
  if (!content) return "UNKNOWN";
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
  if (!captured) return "UNKNOWN";
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
  return "UNKNOWN";
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
  verdict: EvaluatorVerdict;
  feedbackPath: string;
  contractPath: string;
  contextPath: string;
  capDecision?: string;
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

export function archiveNegotiationArtifacts(
  sliceDir: string,
  archiveDir: string,
): void {
  mkdirSync(archiveDir, { recursive: true });
  const feedbackFiles = existsSync(sliceDir)
    ? readdirSync(sliceDir)
        .filter((name) => /^feedback-r\d+\.md$/i.test(name))
        .sort()
    : [];
  const names = ["contract.md", "context.md", ...feedbackFiles, "stuck.md"];
  for (const name of names) {
    const source = join(sliceDir, name);
    if (existsSync(source)) cpSync(source, join(archiveDir, name));
  }
}

function displayPath(repoRoot: string, path: string): string {
  return relative(repoRoot, path).replace(/\\/g, "/");
}

function unresolvedGaps(feedback: string | null): string {
  if (!feedback) {
    return "(No feedback file was produced; inspect the evaluator log.)";
  }
  const section = feedback.match(
    /### If REVISE, specific gaps:\s*([\s\S]*?)(?=\n### |$)/i,
  )?.[1]?.trim();
  return section || feedback.trim();
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
  } = details;
  const archiveDir = negotiationArchiveDir(repoRoot, runSlug, sliceNumber);
  const feedback = readIfExists(feedbackPath);
  const verdictText =
    feedback?.split(/\r?\n/).find((line) => /\bVERDICT\b/i.test(line))?.trim() ??
    `VERDICT: ${verdict}`;
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
    `- Final verdict: ${verdictText}`,
    `- Round-cap decision: ${capDecision ?? "No extension decision was recorded."}`,
    "",
    "## Unresolved gaps",
    "",
    unresolvedGaps(feedback),
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
  const content = existsSync(contractPath)
    ? readFileSync(contractPath, "utf-8")
    : "";

  const statusRe = /^\*\*Status:\*\*[ \t]*\S+[ \t]*$/im;
  let next: string;

  if (statusRe.test(content)) {
    next = content.replace(statusRe, "**Status:** LOCKED");
  } else if (content.length > 0) {
    // Insert after the first H1, or prepend if no H1.
    const h1 = content.match(/^#\s+.+$/m);
    if (h1 && h1.index !== undefined) {
      const at = h1.index + h1[0].length;
      next = content.slice(0, at) + "\n\n**Status:** LOCKED" + content.slice(at);
    } else {
      next = "**Status:** LOCKED\n\n" + content;
    }
  } else {
    next = "**Status:** LOCKED\n";
  }

  writeFileSync(contractPath, next, "utf-8");
}

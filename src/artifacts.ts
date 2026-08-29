import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import {
  CONTRACT_NEGOTIATION_OUTCOME_FILENAME,
  CONTRACT_REVIEW_FILENAME,
  formatContractReviewFindings,
  type ContractNegotiationOutcome,
  type ContractReviewAttemptRecord,
  type ContractReviewFinding,
  type RecordedContractVerdict,
} from "./contract-review.js";
import {
  QA_REVIEW_FILENAME,
  UAT_REVIEW_FILENAME,
  type QAReviewAttemptFinding,
  type QAReviewAttemptRecord,
  type QAReviewStage,
} from "./qa-review.js";
import type { ScopeEscalation } from "./escalation.js";
import type { ScopeAmendmentRecord } from "./scope-amendment.js";

export type ContractStatus = "DRAFT" | "NEGOTIATING" | "LOCKED" | "UNKNOWN";
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
  negotiationOutcome?: ContractNegotiationOutcome;
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
 * One slice life's review archives, inside its slice archive dir. Named
 * here because a restart has to move the whole directory aside (#123).
 */
const REVIEW_ARCHIVE_DIRNAME = "reviews";

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
    REVIEW_ARCHIVE_DIRNAME,
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

/** Preserve one generator scope-escalation artifact under its attempt stamp. */
export function archiveScopeEscalationAttempt(details: {
  sliceDir: string;
  archiveDir: string;
  round: number;
  attempt: number;
}): string | null {
  const { sliceDir, archiveDir, round, attempt } = details;
  const source = join(sliceDir, "escalation.md");
  if (!existsSync(source)) return null;

  const name = `escalation-r${round}-a${attempt}.md`;
  mkdirSync(archiveDir, { recursive: true });
  cpSync(source, join(archiveDir, name), {
    errorOnExist: true,
    force: false,
  });
  return name;
}

/** The next unused contract-review round in a slice's shared review archive. */
export function nextContractReviewRound(archiveDir: string): number {
  if (!existsSync(archiveDir)) return 1;
  const rounds = readdirSync(archiveDir).flatMap((name) => {
    const match = /^contract-review-r(\d+)-a\d+\.json$/.exec(name);
    return match ? [Number(match[1])] : [];
  });
  return (rounds.length > 0 ? Math.max(...rounds) : 0) + 1;
}

/** Archive the code-derived lifecycle record beside its raw attempt. */
export function archiveContractReviewRecord(details: {
  archiveDir: string;
  record: ContractReviewAttemptRecord;
}): string {
  const { archiveDir, record } = details;
  const name =
    `contract-review-r${record.round}-a${record.attempt}-record.json`;
  mkdirSync(archiveDir, { recursive: true });
  writeFileSync(join(archiveDir, name), `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf-8",
    flag: "wx",
  });
  return name;
}

function qaArchivePrefix(stage: QAReviewStage): "qa" | "uat" {
  return stage === "deterministic" ? "qa" : "uat";
}

/** Preserve one evaluator's raw canonical artifact when it exists. */
export function archiveQAReviewAttempt(details: {
  sliceDir: string;
  archiveDir: string;
  stage: QAReviewStage;
  round: number;
  attempt: number;
}): string | null {
  const { sliceDir, archiveDir, stage, round, attempt } = details;
  const prefix = qaArchivePrefix(stage);
  const sourceName =
    stage === "deterministic" ? QA_REVIEW_FILENAME : UAT_REVIEW_FILENAME;
  const source = join(sliceDir, sourceName);
  if (!existsSync(source)) return null;

  const name = `${prefix}-review-r${round}-a${attempt}.json`;
  mkdirSync(archiveDir, { recursive: true });
  cpSync(source, join(archiveDir, name), {
    errorOnExist: true,
    force: false,
  });
  return name;
}

/** Preserve named evidence for a missing or refused canonical artifact. */
export function archiveQAReviewValidation(details: {
  archiveDir: string;
  stage: QAReviewStage;
  round: number;
  attempt: number;
  evidence: string;
}): string {
  const { archiveDir, stage, round, attempt, evidence } = details;
  const name =
    `${qaArchivePrefix(stage)}-review-r${round}-a${attempt}-validation.txt`;
  mkdirSync(archiveDir, { recursive: true });
  writeFileSync(join(archiveDir, name), `${evidence.trimEnd()}\n`, {
    encoding: "utf-8",
    flag: "wx",
  });
  return name;
}

/** Archive the code-derived lifecycle record beside the raw QA attempt. */
export function archiveQAReviewRecord(details: {
  archiveDir: string;
  record: QAReviewAttemptRecord;
}): string {
  const { archiveDir, record } = details;
  const name =
    `${qaArchivePrefix(record.stage)}-review-r${record.round}-a${record.attempt}-record.json`;
  mkdirSync(archiveDir, { recursive: true });
  writeFileSync(join(archiveDir, name), `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf-8",
    flag: "wx",
  });
  return name;
}

/**
 * Record one applied scope amendment beside the QA attempt that asked
 * for it (#112). The amendment edits the locked contract, so the record
 * is the only place the run says who widened the file scope and on which
 * finding's evidence.
 */
export function archiveScopeAmendment(details: {
  archiveDir: string;
  record: ScopeAmendmentRecord;
}): string {
  const { archiveDir, record } = details;
  const name =
    `${qaArchivePrefix(record.stage)}-scope-amendment-r${record.round}-a${record.attempt}.json`;
  mkdirSync(archiveDir, { recursive: true });
  writeFileSync(join(archiveDir, name), `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf-8",
    flag: "wx",
  });
  return name;
}

interface ArchivedQAReviewRecord {
  name: string;
  record: QAReviewAttemptRecord;
}

interface ValidArchivedScopeEscalation {
  round: number;
  attempt: number;
  name: string;
  escalation: ScopeEscalation;
}

interface InvalidArchivedScopeEscalation {
  round: number;
  attempt: number;
  name: string;
  invalid: true;
}

type ArchivedScopeEscalation =
  | ValidArchivedScopeEscalation
  | InvalidArchivedScopeEscalation;

export interface StuckDiagnosisDetails {
  reviewArchiveDir: string;
  additionalArtifactReferences?: readonly string[];
  commitLog: string;
}

const QA_RECORD_NAME =
  /^(qa|uat)-review-r(\d+)-a(\d+)-record\.json$/;
const ESCALATION_RECORD_NAME = /^escalation-r(\d+)-a(\d+)\.md$/;
const ADDITIONAL_ARTIFACT_LINE =
  /^- Additional artifact: `([^`\r\n]+)`$/gm;

function compareAttempt(
  left: { round: number; attempt: number },
  right: { round: number; attempt: number },
): number {
  return left.round - right.round || left.attempt - right.attempt;
}

function archivedQAReviewRecords(
  reviewArchiveDir: string,
): ArchivedQAReviewRecord[] {
  if (!existsSync(reviewArchiveDir)) return [];
  return readdirSync(reviewArchiveDir)
    .flatMap((name): ArchivedQAReviewRecord[] => {
      const match = QA_RECORD_NAME.exec(name);
      if (!match) return [];
      const record = JSON.parse(
        readFileSync(join(reviewArchiveDir, name), "utf-8"),
      ) as QAReviewAttemptRecord;
      if (
        !record ||
        typeof record !== "object" ||
        !Array.isArray(record.findings)
      ) {
        throw new Error(`${name} is not a valid archived QA lifecycle record`);
      }
      const expectedStage =
        match[1] === "qa" ? "deterministic" : "shared-preview";
      if (
        record.stage !== expectedStage ||
        record.round !== Number(match[2]) ||
        record.attempt !== Number(match[3])
      ) {
        throw new Error(
          `${name} contents must match its stage, round, and attempt filename`,
        );
      }
      return [{ name, record }];
    })
    .sort(
      (left, right) =>
        compareAttempt(left.record, right.record) ||
        left.record.stage.localeCompare(right.record.stage),
    );
}

function archivedScopeEscalations(
  reviewArchiveDir: string,
): ArchivedScopeEscalation[] {
  if (!existsSync(reviewArchiveDir)) return [];
  return readdirSync(reviewArchiveDir)
    .flatMap((name): ArchivedScopeEscalation[] => {
      const match = ESCALATION_RECORD_NAME.exec(name);
      if (!match) return [];
      const attempt = {
        round: Number(match[1]),
        attempt: Number(match[2]),
        name,
      };
      try {
        const parsed = JSON.parse(
          readFileSync(join(reviewArchiveDir, name), "utf-8"),
        ) as ScopeEscalation;
        if (
          !parsed ||
          typeof parsed !== "object" ||
          parsed.version !== 1 ||
          !Array.isArray(parsed.findingIds) ||
          !Array.isArray(parsed.paths) ||
          typeof parsed.reason !== "string"
        ) {
          return [{ ...attempt, invalid: true }];
        }
        return [{ ...attempt, escalation: parsed }];
      } catch {
        // Story 13 retains malformed generator bytes as evidence. A later
        // STUCK diagnosis must isolate that invalid artifact rather than
        // letting one failed parse erase the rest of the diagnosis.
        return [{ ...attempt, invalid: true }];
      }
    })
    .sort(compareAttempt);
}

function latestFindings(
  records: readonly ArchivedQAReviewRecord[],
): Array<QAReviewAttemptFinding & { stage: QAReviewStage }> {
  const latest = new Map<
    string,
    QAReviewAttemptFinding & { stage: QAReviewStage }
  >();
  for (const { record } of records) {
    for (const finding of record.findings) {
      latest.set(`${record.stage}:${finding.id}`, {
        ...finding,
        artifactReferences: [...finding.artifactReferences],
        stage: record.stage,
      });
    }
  }
  return [...latest.values()].sort(
    (left, right) =>
      left.id.localeCompare(right.id) ||
      left.stage.localeCompare(right.stage),
  );
}

function renderFinding(
  finding: QAReviewAttemptFinding & { stage: QAReviewStage },
): string {
  return [
    `- [${finding.id}] ${finding.severity} ${finding.state}`,
    `  - Stage: ${finding.stage}`,
    `  - Summary: ${finding.summary}`,
    `  - Clear condition: ${finding.clearCondition}`,
    "  - Artifact references:",
    ...finding.artifactReferences.map((path) => `    - \`${path}\``),
  ].join("\n");
}

function renderFindingSection(
  findings: readonly (QAReviewAttemptFinding & { stage: QAReviewStage })[],
): string {
  return findings.length === 0
    ? "(none)"
    : findings.map(renderFinding).join("\n");
}

export function readStuckDiagnosisAdditionalArtifactReferences(
  sliceDir: string,
): string[] {
  const stuckPath = join(sliceDir, "stuck.md");
  if (!existsSync(stuckPath)) return [];
  return [
    ...new Set(
      [...readFileSync(stuckPath, "utf-8").matchAll(ADDITIONAL_ARTIFACT_LINE)]
        .map((match) => match[1])
        .filter((path): path is string => path !== undefined),
    ),
  ].sort();
}

/**
 * Assemble the terminal implementation diagnosis from archived evidence.
 * File discovery is never presentation order: attempts and findings are
 * sorted explicitly so identical archives always produce identical bytes.
 */
export function renderStuckDiagnosis(details: StuckDiagnosisDetails): string {
  const records = archivedQAReviewRecords(details.reviewArchiveDir);
  const escalations = archivedScopeEscalations(details.reviewArchiveDir);
  const findings = latestFindings(records);
  const resolvedFindings = findings.filter(
    (finding) => finding.state === "RESOLVED",
  );
  const openFindings = findings.filter((finding) => finding.state === "OPEN");
  const escalationBlock =
    escalations.length === 0
      ? "(none)"
      : escalations
          .map((record) => {
            if ("invalid" in record) {
              return [
                `- Round ${record.round} attempt ${record.attempt}`,
                `  - Invalid artifact: \`${record.name}\` is not a valid version 1 scope escalation`,
              ].join("\n");
            }
            return [
              `- Round ${record.round} attempt ${record.attempt}`,
              `  - Finding IDs: ${record.escalation.findingIds.map((id) => `\`${id}\``).join(", ")}`,
              `  - Paths: ${record.escalation.paths.map((path) => `\`${path}\``).join(", ")}`,
              `  - Reason: ${record.escalation.reason}`,
            ].join("\n");
          })
          .join("\n");
  const roundEvidence = records.map(({ name, record }) => {
    const references = [
      ...new Set(
        record.findings.flatMap(
          (finding) => finding.artifactReferences,
        ),
      ),
    ].sort();
    return [
      `- Round ${record.round} attempt ${record.attempt} (${record.stage}): ${record.verdict} / ${record.failureClass}`,
      `  - Lifecycle record: \`${name}\``,
      "  - Artifact references:",
      ...(references.length === 0
        ? ["    - (none)"]
        : references.map((path) => `    - \`${path}\``)),
    ].join("\n");
  });
  const recordedArtifactReferences = new Set(
    records.flatMap(({ record }) =>
      record.findings.flatMap((finding) => finding.artifactReferences),
    ),
  );
  for (const path of [...new Set(details.additionalArtifactReferences ?? [])]
    .filter((path) => !recordedArtifactReferences.has(path))
    .sort()) {
    roundEvidence.push(`- Additional artifact: \`${path}\``);
  }
  if (roundEvidence.length === 0) roundEvidence.push("(none)");
  const commitEvidence = details.commitLog.trim()
    ? `\`\`\`text\n${details.commitLog.trimEnd()}\n\`\`\``
    : "(none)";

  return [
    "# Stuck diagnosis",
    "",
    "## Finding lifecycle",
    "",
    "### RESOLVED",
    "",
    renderFindingSection(resolvedFindings),
    "",
    "### OPEN",
    "",
    renderFindingSection(openFindings),
    "",
    "## Scope escalations",
    "",
    escalationBlock,
    "",
    "## Round evidence",
    "",
    ...roundEvidence,
    "",
    "## Commit evidence",
    "",
    commitEvidence,
    "",
  ].join("\n");
}

export function writeStuckDiagnosis(
  sliceDir: string,
  details: StuckDiagnosisDetails,
): string {
  const diagnosis = renderStuckDiagnosis(details);
  writeFileSync(join(sliceDir, "stuck.md"), diagnosis, "utf-8");
  return diagnosis;
}

/** The stuck diagnosis exactly as it sits on disk, or `null` when absent. */
export function readStuckDiagnosis(sliceDir: string): string | null {
  const stuckPath = join(sliceDir, "stuck.md");
  if (!existsSync(stuckPath)) return null;
  return readFileSync(stuckPath, "utf-8");
}

/**
 * Put a captured diagnosis back byte-for-byte, and report whether that
 * changed anything. Used to hold `stuck.md` stable across a STUCK
 * resume's granted attempt (#82 AC3): the file is the operator's audit
 * record of why the attempt was granted, and a generator that deletes or
 * edits it destroys evidence the run is supposed to keep.
 */
export function restoreStuckDiagnosis(
  sliceDir: string,
  contents: string,
): boolean {
  if (readStuckDiagnosis(sliceDir) === contents) return false;
  writeFileSync(join(sliceDir, "stuck.md"), contents, "utf-8");
  return true;
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
  return [
    "contract.md",
    "context.md",
    ...rounds,
    "handoff.md",
    CONTRACT_NEGOTIATION_OUTCOME_FILENAME,
    "stuck.md",
  ];
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
 * Move a directory, falling back to copy-then-delete when the rename is
 * refused — on Windows an open handle from an indexer or an editor is
 * enough for EPERM/EBUSY. A failure here propagates: both callers of the
 * pre-restart archive treat it as best-effort and warn.
 */
function moveDirectory(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch {
    cpSync(from, to, { recursive: true });
    rmSync(from, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  }
}

/**
 * Put a slice's previous life's artifacts out of the next life's way
 * before it starts from base. Returns the archive directory, or `null`
 * when the slice had nothing to move aside.
 *
 * Two kinds of artifact, for two reasons:
 *
 * - The untracked spec artifacts (contract.md, context.md, feedback-r*,
 *   qa-report*, handoff.md, stuck.md) are **copied** out of the worktree,
 *   because a from-base restart recreates the worktree and they are the
 *   only copy (#113).
 * - The `reviews/` archive dir is **moved**, because the next life's
 *   round-1 evidence writes target the same `r1-a1` names and fail closed
 *   on a collision (#79/#123). Copying would not free the slots. The
 *   whole directory travels together, so the prior life's records and the
 *   raw artifacts they reference stay side by side — only their prefix
 *   changes.
 *
 * Archives land in a numbered `pre-restart-<n>` subdirectory of the
 * slice's usual archive dir, so a second restart cannot overwrite the
 * first one's copies and neither can clobber an ESCALATE/STUCK archive
 * sitting alongside them. The index is the next free one on disk — no
 * clock, so the path is reproducible in tests.
 *
 * Callers are the two paths that begin a slice life at round 1 with no
 * resume state: the from-base restart, and a launch that finds no branch
 * and no worktree at all (`clean-failed` and manual branch deletion never
 * touch `.afk/artifacts`, so a stale `reviews/` outlives them). The
 * resume paths must never call it — their round arithmetic reads exactly
 * the evidence this moves.
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
  const parent = negotiationArchiveDir(repoRoot, runSlug, sliceNumber);
  const staleReviews = join(parent, REVIEW_ARCHIVE_DIRNAME);
  const hasStaleReviews =
    existsSync(staleReviews) && readdirSync(staleReviews).length > 0;
  if (present.length === 0 && !hasStaleReviews) return null;

  let index = 1;
  while (existsSync(join(parent, `pre-restart-${index}`))) index++;
  const archiveDir = join(parent, `pre-restart-${index}`);
  mkdirSync(archiveDir, { recursive: true });
  for (const name of present) {
    cpSync(join(sliceDir, name), join(archiveDir, name));
  }
  if (hasStaleReviews) {
    moveDirectory(staleReviews, join(archiveDir, REVIEW_ARCHIVE_DIRNAME));
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

function formatNegotiationOutcome(
  outcome: ContractNegotiationOutcome,
): string {
  return outcome.findings
    .map((finding) =>
      [
        `- [${finding.id}] ${finding.severity} ${finding.state}`,
        `  - Planner position: ${finding.plannerPosition ?? "(none)"}`,
        `  - Planner evidence: ${finding.plannerEvidence ?? "(none)"}`,
        `  - Evaluator evidence: ${finding.evaluatorEvidence}`,
      ].join("\n"),
    )
    .join("\n");
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
    negotiationOutcome,
  } = details;
  const archiveDir = negotiationArchiveDir(repoRoot, runSlug, sliceNumber);
  const feedback = readIfExists(feedbackPath);
  const stuckPath = join(sliceDir, "stuck.md");
  const archiveContract = join(archiveDir, "contract.md");
  const archiveContext = join(archiveDir, "context.md");
  const archiveFeedback = join(archiveDir, `feedback-r${round}.md`);
  const outcomePath = join(sliceDir, CONTRACT_NEGOTIATION_OUTCOME_FILENAME);
  const archiveOutcome = join(
    archiveDir,
    CONTRACT_NEGOTIATION_OUTCOME_FILENAME,
  );
  if (negotiationOutcome) {
    writeFileSync(
      outcomePath,
      `${JSON.stringify(negotiationOutcome, null, 2)}\n`,
      "utf-8",
    );
  }
  const stuck = [
    "# Contract negotiation stuck",
    "",
    `- Slice: #${ghIssue} ${title}`,
    `- Outcome: ${outcome}`,
    ...(negotiationOutcome
      ? [
          `- Exhaustion classification: ${negotiationOutcome.classification}`,
        ]
      : []),
    `- Round: ${round}`,
    `- Final verdict: VERDICT: ${verdict}`,
    `- Round-cap decision: ${capDecision ?? "No extension decision was recorded."}`,
    "",
    ...(negotiationOutcome
      ? [
          "## Exhaustion record",
          "",
          formatNegotiationOutcome(negotiationOutcome),
          "",
        ]
      : []),
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
    ...(negotiationOutcome
      ? [
          `- Working exhaustion outcome: ${displayPath(repoRoot, outcomePath)}`,
          `- Archived exhaustion outcome: ${displayPath(repoRoot, archiveOutcome)}`,
        ]
      : []),
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

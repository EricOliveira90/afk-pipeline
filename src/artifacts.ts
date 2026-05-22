import { readFileSync, existsSync } from "node:fs";

export type ContractStatus = "DRAFT" | "NEGOTIATING" | "LOCKED" | "UNKNOWN";
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

  // Check explicit Status field
  const status = matchField(content, /\*\*Status:\*\*\s*(\S+)/i);
  if (status?.toUpperCase() === "LOCKED") return "LOCKED";

  // If contract exists, check if evaluator accepted (overrides NEGOTIATING/DRAFT)
  if (content.length > 0) {
    const verdict = readEvaluatorVerdict(contractPath);
    if (verdict === "ACCEPT") return "LOCKED";
  }

  // Return explicit status if present
  if (status) {
    const upper = status.toUpperCase();
    if (upper === "NEGOTIATING") return "NEGOTIATING";
    if (upper === "DRAFT") return "DRAFT";
  }

  // Contract exists but no status and no accept → needs review
  if (content.length > 0) return "NEGOTIATING";

  return "UNKNOWN";
}

export function readEvaluatorVerdict(
  contractPath: string,
): "ACCEPT" | "REVISE" | "ESCALATE" | "UNKNOWN" {
  const content = readIfExists(contractPath);
  if (!content) return "UNKNOWN";
  // Look for VERDICT or Verdict in evaluator feedback sections
  const verdictMatches = content.match(
    /(?:VERDICT|Verdict)[:\s]*\*?\*?\s*(ACCEPT|REVISE|ESCALATE)/gi,
  );
  if (!verdictMatches || verdictMatches.length === 0) return "UNKNOWN";
  // Use the last verdict found
  const last = verdictMatches[verdictMatches.length - 1]!;
  const v = last.match(/(ACCEPT|REVISE|ESCALATE)/i)?.[1]?.toUpperCase();
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

export function hasStuckFile(sliceDir: string): boolean {
  return existsSync(`${sliceDir}/stuck.md`);
}

export function hasPassingQA(sliceDir: string): boolean {
  return readQAVerdict(`${sliceDir}/qa-report.md`) === "PASS";
}

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Matches an explicit hold declaration in prd.md, in either frontmatter
 * ("Status: On Hold") or body ("**Status:** On Hold") form. Prose mentions
 * such as "the PRD was previously on hold" do not match.
 */
export const ON_HOLD_STATUS_PATTERN = /^\s*\*{0,2}Status:?\*{0,2}:?\s*On Hold\b/im;

export interface PrdHoldCheck {
  onHold: boolean;
  reasons: string[];
}

/**
 * Detect whether a PRD directory is deliberately parked.
 *
 * Two independent signals, either one holds the PRD:
 * - an `afk.on-hold.json` marker file (its optional `blockedBy` issue
 *   numbers are surfaced in the reason);
 * - a `Status: On Hold` declaration in `prd.md`.
 *
 * An unreadable marker file still counts as a hold: a PRD owner wrote it
 * to stop launches, so a parse error must fail closed.
 */
export function checkPrdHold(prdDir: string): PrdHoldCheck {
  const reasons: string[] = [];

  const markerPath = join(prdDir, "afk.on-hold.json");
  if (existsSync(markerPath)) {
    let gate = "";
    try {
      const marker = JSON.parse(readFileSync(markerPath, "utf-8")) as {
        blockedBy?: unknown;
      };
      if (Array.isArray(marker.blockedBy) && marker.blockedBy.length > 0) {
        gate = ` (blocked by ${marker.blockedBy.map((n) => `#${n}`).join(", ")})`;
      }
    } catch {
      gate = " (marker unreadable — still a hold)";
    }
    reasons.push(`${markerPath} exists${gate}`);
  }

  const prdPath = join(prdDir, "prd.md");
  if (existsSync(prdPath) && ON_HOLD_STATUS_PATTERN.test(readFileSync(prdPath, "utf-8"))) {
    reasons.push(`${prdPath} declares Status: On Hold`);
  }

  return { onHold: reasons.length > 0, reasons };
}

/**
 * CLI guard: print every hold reason and exit(2) when the PRD is on hold.
 * Labels and prose alone must not be the only thing standing between an
 * operator command and a held PRD.
 */
export function assertPrdNotOnHold(prdDir: string): void {
  const check = checkPrdHold(prdDir);
  if (!check.onHold) return;
  for (const reason of check.reasons) {
    console.error(`Error: ${reason}`);
  }
  console.error(
    "\nThis PRD is on hold. Resolve its gate, re-triage, regenerate afk.json"
      + " with fresh migration prefixes, and remove the on-hold marker before"
      + " launching AFK.",
  );
  process.exit(2);
}

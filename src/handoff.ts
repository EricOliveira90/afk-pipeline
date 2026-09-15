import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Slice } from "./issues-parser.js";
import type { RunEvent } from "./run-events.js";
import type { SlicePhase } from "./slice-lifecycle.js";
import type { SkippedSlice } from "./slice-scope.js";

export type RunStatus = "SUCCEEDED" | "FAILED" | "ABORTED";

export interface HandoffSelectedSlice {
  number: string;
  ghIssue: string;
  title: string;
  type: "AFK";
  status: SlicePhase | "NOT-RUN";
}

export interface HandoffSkippedSlice {
  number: string;
  ghIssue: string;
  title: string;
  type: Slice["type"];
  reason: SkippedSlice["reason"];
}

/**
 * One guardian finding issue this run left open (#320).
 *
 * The counterpart of `githubIssuesToClose`: that field is the slice work this
 * run finished, and this one is the defect work it did not. A reader counting
 * remaining defects needs both, and before #320 the second list did not exist —
 * so a run that resolved four architecture findings still reported seven open
 * tickets and nothing said which four were done.
 */
export interface HandoffGuardianIssue {
  issue: string;
  guardian: "architect" | "pm";
  stableId: string;
  kind: "BLOCKER" | "NOTE";
  /** What the last reconciliation pass did (`RunEvent`'s own vocabulary). */
  action: "UPDATED" | "REOPENED" | "REFUSED" | "UNCHANGED" | "FAILED";
  /** Why it is still open, in the reconciliation's own words. */
  detail: string;
}

export interface TerminalHandoff {
  version: 1;
  runStatus: RunStatus;
  selectedSlices: HandoffSelectedSlice[];
  skippedSlices: HandoffSkippedSlice[];
  featureBranch: string;
  finalCommitSha: string | null;
  migrationFilesCreated: string[];
  githubIssuesToClose: string[];
  /**
   * Guardian finding issues still open, in reconciliation order. Always
   * written — an empty array is the claim "nothing left", which a reader must be
   * able to tell from a run that never reconciled anything.
   */
  unresolvedGuardianIssues: HandoffGuardianIssue[];
  draftPr: {
    number: number | null;
    url: string | null;
  };
}

/**
 * Project the guardian issues still open out of this run's own event stream.
 *
 * Reads the `guardian-issue-reconciliation` events and nothing else, so this
 * list and `run-summary.md`'s `## Guardian Finding Issues` section are two
 * renderings of one record rather than two derivations that can drift. One entry
 * per issue with the last event winning, for the same reason the summary
 * collapses them: an issue updated in round 2 and closed in round 3 is one
 * ticket, and it is closed.
 */
export function unresolvedGuardianIssues(
  events: readonly RunEvent[],
): HandoffGuardianIssue[] {
  const latest = new Map<string, HandoffGuardianIssue | null>();
  for (const event of events) {
    if (event.type !== "guardian-issue-reconciliation") continue;
    latest.set(
      event.issue,
      event.action === "CLOSED"
        ? null
        : {
            issue: event.issue,
            guardian: event.guardian,
            stableId: event.stableId,
            kind: event.kind,
            action: event.action,
            detail: event.detail,
          },
    );
  }
  return [...latest.values()].filter(
    (entry): entry is HandoffGuardianIssue => entry !== null,
  );
}

export function parseDraftPrNumber(url: string | null): number | null {
  if (!url) return null;
  const match = /\/pull\/(\d+)(?:\/)?$/.exec(url);
  return match ? Number(match[1]) : null;
}

export function serializeTerminalHandoff(handoff: TerminalHandoff): string {
  return JSON.stringify(handoff, null, 2) + "\n";
}

export function writeTerminalHandoff(
  repoRoot: string,
  runSlug: string,
  handoff: TerminalHandoff,
): string {
  const path = join(repoRoot, ".afk", "logs", runSlug, "handoff.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeTerminalHandoff(handoff), "utf-8");
  return path;
}

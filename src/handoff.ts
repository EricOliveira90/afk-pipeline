import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Slice } from "./issues-parser.js";
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

export interface TerminalHandoff {
  version: 1;
  runStatus: RunStatus;
  selectedSlices: HandoffSelectedSlice[];
  skippedSlices: HandoffSkippedSlice[];
  featureBranch: string;
  finalCommitSha: string | null;
  migrationFilesCreated: string[];
  githubIssuesToClose: string[];
  draftPr: {
    number: number | null;
    url: string | null;
  };
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

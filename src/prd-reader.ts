import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Parse the "## Relevant Files" section from prd.md.
 * Returns the raw markdown lines (e.g. "- `path/to/file` — description").
 */
export function readRelevantFiles(prdDir: string): string[] {
  const prdPath = join(prdDir, "prd.md");
  const content = readFileSync(prdPath, "utf-8");
  const lines = content.split("\n");

  let inSection = false;
  const result: string[] = [];

  for (const line of lines) {
    if (/^##\s+Relevant Files/i.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^##\s/.test(line)) {
      break;
    }
    if (inSection && line.trim().startsWith("- ")) {
      result.push(line.trim());
    }
  }

  return result;
}

/**
 * Format relevant files as a markdown block for prompt interpolation.
 */
export function formatRelevantFiles(files: string[]): string {
  if (files.length === 0) return "(No relevant files listed in PRD)";
  return files.join("\n");
}

/**
 * Attempt to read a local slice .md file from the issues/ subfolder.
 * Tries matching by slice number prefix (e.g. "01-*.md").
 * Returns file content or null if not found.
 */
export function readSliceFile(
  prdDir: string,
  sliceNumber: string,
): string | null {
  const issuesDir = join(prdDir, "issues");
  if (!existsSync(issuesDir)) return null;

  const files = readdirSync(issuesDir);
  const match = files.find((f) => f.startsWith(`${sliceNumber}-`) && f.endsWith(".md"));
  if (!match) return null;

  return readFileSync(join(issuesDir, match), "utf-8");
}

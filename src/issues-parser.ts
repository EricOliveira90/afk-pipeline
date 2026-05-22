import { readFileSync } from "node:fs";

export interface Slice {
  number: string;
  ghIssue: string;
  title: string;
  type: "HITL" | "AFK";
  blockedBy: string[];
  userStories: string;
}

export interface DAG {
  slices: Map<string, Slice>;
  /** Returns slice numbers that have no unmet dependencies. */
  ready(completed: Set<string>): string[];
}

/**
 * Parse an issues.md file into a list of slices.
 *
 * Expected table format:
 * | Slice | GH Issue | Title | Type | Blocked by | User stories covered |
 * |-------|----------|-------|------|------------|----------------------|
 * | 01    | #41      | ...   | AFK  | —          | ...                  |
 * | 02    | #42      | ...   | AFK  | #41        | ...                  |
 */
export function parseIssuesMd(path: string): Slice[] {
  const content = readFileSync(path, "utf-8");
  const lines = content.split("\n");

  // Find the table header row
  const headerIdx = lines.findIndex(
    (l) => l.includes("Slice") && l.includes("GH Issue") && l.includes("|"),
  );
  if (headerIdx === -1) throw new Error(`No slice table found in ${path}`);

  // Skip the separator row (|---|---|...)
  const dataStart = headerIdx + 2;
  const slices: Slice[] = [];

  for (let i = dataStart; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line.startsWith("|")) break;

    const cells = line
      .split("|")
      .map((c) => c.trim())
      .filter((c) => c.length > 0);

    if (cells.length < 5) continue;

    const blockedByRaw = cells[4]!;
    const blockedBy =
      blockedByRaw === "—" || blockedByRaw === "-" || blockedByRaw === "None"
        ? []
        : blockedByRaw
            .split(",")
            .map((s) => s.trim().replace("#", ""))
            .filter(Boolean);

    slices.push({
      number: cells[0]!.trim(),
      ghIssue: cells[1]!.trim().replace("#", ""),
      title: cells[2]!.trim(),
      type: cells[3]!.trim().toUpperCase() as "HITL" | "AFK",
      blockedBy,
      userStories: cells[5]?.trim() ?? "",
    });
  }

  if (slices.length === 0) throw new Error(`No slices found in ${path}`);
  return slices;
}

export function buildDAG(slices: Slice[]): DAG {
  const map = new Map<string, Slice>();
  for (const s of slices) map.set(s.ghIssue, s);

  return {
    slices: map,
    ready(completed: Set<string>): string[] {
      const result: string[] = [];
      for (const [id, slice] of map) {
        if (completed.has(id)) continue;
        if (slice.type === "HITL") continue;
        if (slice.blockedBy.every((dep) => completed.has(dep))) {
          result.push(id);
        }
      }
      return result;
    },
  };
}

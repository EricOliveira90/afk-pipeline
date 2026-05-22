import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseIssuesMd, buildDAG } from "./issues-parser.js";

/**
 * Regression tests for the DAG semantics used by the AFK orchestrator.
 *
 * Specifically guards against the PRD 012 run-1 failure mode where the
 * orchestrator called `dag.ready(completed ∪ failed)`, causing a failed
 * slice to incorrectly unblock its dependents. The DAG itself has always
 * had the right contract — only `completed` unblocks — but this test
 * pins that contract so the orchestrator can't regress against it.
 */

function withIssuesFile(content: string, fn: (path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "afk-dag-"));
  const path = join(dir, "issues.md");
  try {
    writeFileSync(path, content, "utf-8");
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const FOUR_SLICE_MANIFEST = `# Issues

| Slice | GH Issue | Title | Type | Blocked by | User stories covered |
|-------|----------|-------|------|------------|----------------------|
| 01 | #100 | Foundation | AFK | — | 1, 2 |
| 02 | #101 | Widget on foundation | AFK | #100 | 3 |
| 03 | #102 | Mobile gestures on widget | AFK | #101 | 4 |
| 04 | #103 | Cron on foundation | AFK | #100 | 5 |
`;

describe("DAG.ready() — regression for PRD 012 run-1", () => {
  it("slice 01 is ready from an empty completed set (no deps)", () => {
    withIssuesFile(FOUR_SLICE_MANIFEST, (p) => {
      const dag = buildDAG(parseIssuesMd(p));
      expect(dag.ready(new Set())).toEqual(["100"]);
    });
  });

  it("slices 02 and 04 become ready only after 01 completes", () => {
    withIssuesFile(FOUR_SLICE_MANIFEST, (p) => {
      const dag = buildDAG(parseIssuesMd(p));
      expect(dag.ready(new Set(["100"])).sort()).toEqual(["101", "103"]);
    });
  });

  it("slice 03 waits for 02 even after 01 completes", () => {
    withIssuesFile(FOUR_SLICE_MANIFEST, (p) => {
      const dag = buildDAG(parseIssuesMd(p));
      expect(dag.ready(new Set(["100"]))).not.toContain("102");
      expect(dag.ready(new Set(["100", "101"]))).toContain("102");
    });
  });

  it("CRITICAL: a failed slice MUST NOT unblock its dependents", () => {
    // This is the exact orchestrator bug from PRD 012 run-1.
    // If slice 01 fails, slices 02/04 must stay unready — they depend
    // on slice 01's foundation. The orchestrator is responsible for
    // only passing `completed` to `ready()`, never `completed ∪ failed`.
    withIssuesFile(FOUR_SLICE_MANIFEST, (p) => {
      const dag = buildDAG(parseIssuesMd(p));
      // Simulate the buggy call site: merging a failed slice 01 into the
      // "done" set the DAG sees.
      const completedOnly = new Set<string>(); // 01 failed, not completed
      const ready = dag.ready(completedOnly);
      expect(ready).not.toContain("101"); // was the PRD 012 run-1 bug
      expect(ready).not.toContain("103"); // was the PRD 012 run-1 bug
      expect(ready).not.toContain("102");
    });
  });

  it("HITL slices are never returned by ready()", () => {
    withIssuesFile(
      `# Issues

| Slice | GH Issue | Title | Type | Blocked by | User stories covered |
|-------|----------|-------|------|------------|----------------------|
| 01 | #200 | Manual setup | HITL | — | setup |
| 02 | #201 | Automated follow-up | AFK | #200 | 1 |
`,
      (p) => {
        const dag = buildDAG(parseIssuesMd(p));
        expect(dag.ready(new Set())).not.toContain("200");
      },
    );
  });
});

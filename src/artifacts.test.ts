import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readContractFiles, readReviewVerdict } from "./artifacts.js";

/**
 * Regression tests for the review-verdict parser.
 *
 * All three wire formats below were observed in real AFK runs under
 * `.afk/logs/<prd>/slice-all-{architect,pm}-review.log` where the summary
 * ended up as "UNKNOWN" because the original regex only accepted a single
 * markdown emphasis style.
 */

function withTempFile(content: string, fn: (path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "afk-artifacts-"));
  const path = join(dir, "review.md");
  try {
    writeFileSync(path, content, "utf-8");
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("readReviewVerdict", () => {
  let cleanup: Array<() => void> = [];
  afterEach(() => {
    for (const fn of cleanup) fn();
    cleanup = [];
  });

  describe("real-world formats observed in AFK runs", () => {
    it("parses bold format: **Verdict:** SHIP (bug-fixes-round-2 architect)", () => {
      withTempFile(
        `# Architect Review\n\n**Date:** 2026-05-05\n**Verdict:** SHIP\n\nAll good.\n`,
        (p) => expect(readReviewVerdict(p)).toBe("SHIP"),
      );
    });

    it("parses markdown header: ## Verdict: SHIP (architecture-deepening both, bug-fixes-round-2 PM)", () => {
      withTempFile(
        `# PM Review\n\nSome prose.\n\n## Verdict: SHIP\n\nBoth slices are minimal bug fixes.\n`,
        (p) => expect(readReviewVerdict(p)).toBe("SHIP"),
      );
    });

    it("returns UNKNOWN when no Verdict line is present (bug-fixes-tiers-1-3 both)", () => {
      withTempFile(
        `# Architect Review\n\nCritical finding: slice 01 has 5 of 8 requirements completely unimplemented.\n\nThe two blockers must be fixed before the client demo.\n`,
        (p) => expect(readReviewVerdict(p)).toBe("UNKNOWN"),
      );
    });
  });

  describe("accepted format variations", () => {
    it("parses ACCEPT-WITH-NOTES under bold format", () => {
      withTempFile(`**Verdict:** ACCEPT-WITH-NOTES\n`, (p) =>
        expect(readReviewVerdict(p)).toBe("ACCEPT-WITH-NOTES"),
      );
    });

    it("parses ACCEPT WITH NOTES (spaces) under header format", () => {
      withTempFile(`## Verdict: ACCEPT WITH NOTES\n`, (p) =>
        expect(readReviewVerdict(p)).toBe("ACCEPT-WITH-NOTES"),
      );
    });

    it("parses FIX-BEFORE-SHIP under header format", () => {
      withTempFile(`### Verdict: FIX-BEFORE-SHIP\n`, (p) =>
        expect(readReviewVerdict(p)).toBe("FIX-BEFORE-SHIP"),
      );
    });

    it("parses FIX BEFORE SHIP (spaces) under bold format", () => {
      withTempFile(`**Verdict:** FIX BEFORE SHIP\n`, (p) =>
        expect(readReviewVerdict(p)).toBe("FIX-BEFORE-SHIP"),
      );
    });

    it("parses plain format: Verdict: SHIP", () => {
      withTempFile(`Verdict: SHIP\n`, (p) =>
        expect(readReviewVerdict(p)).toBe("SHIP"),
      );
    });

    it("parses single-asterisk italic: *Verdict:* SHIP", () => {
      withTempFile(`*Verdict:* SHIP\n`, (p) =>
        expect(readReviewVerdict(p)).toBe("SHIP"),
      );
    });

    it("is case-insensitive on the 'Verdict' key", () => {
      withTempFile(`**verdict:** ship\n`, (p) =>
        expect(readReviewVerdict(p)).toBe("SHIP"),
      );
    });

    it("tolerates trailing whitespace after the value", () => {
      withTempFile(`**Verdict:** SHIP   \n`, (p) =>
        expect(readReviewVerdict(p)).toBe("SHIP"),
      );
    });

    it("strips trailing bold markers on the value itself", () => {
      withTempFile(`**Verdict: SHIP**\n`, (p) =>
        expect(readReviewVerdict(p)).toBe("SHIP"),
      );
    });
  });

  describe("negative cases", () => {
    it("returns UNKNOWN when the file does not exist", () => {
      expect(readReviewVerdict("/nonexistent/path/review.md")).toBe("UNKNOWN");
    });

    it("returns UNKNOWN when the verdict value is unrecognized", () => {
      withTempFile(`**Verdict:** MAYBE\n`, (p) =>
        expect(readReviewVerdict(p)).toBe("UNKNOWN"),
      );
    });

    it("returns UNKNOWN for a file with only prose", () => {
      withTempFile(`# Review\n\nLooks fine to me.\n`, (p) =>
        expect(readReviewVerdict(p)).toBe("UNKNOWN"),
      );
    });
  });
});

/**
 * Tests for `readContractFiles`, the planner's declared "Files expected
 * to change" extractor used by the lane partitioner.
 *
 * Section semantics: undefined when the file or section is missing;
 * empty array when the section exists but yielded no usable paths.
 */
function withContractFile(
  content: string,
  fn: (path: string) => void,
) {
  const dir = mkdtempSync(join(tmpdir(), "afk-contract-"));
  const path = join(dir, "contract.md");
  try {
    writeFileSync(path, content, "utf-8");
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("readContractFiles", () => {
  it("returns undefined when the contract file is missing", () => {
    expect(readContractFiles("/nonexistent/path/contract.md")).toBeUndefined();
  });

  it("returns undefined when the section heading is absent", () => {
    withContractFile(
      `# Slice Contract\n\n## Scope lock\nDo a thing.\n`,
      (p) => expect(readContractFiles(p)).toBeUndefined(),
    );
  });

  it("returns [] when the section exists but is empty", () => {
    withContractFile(
      `# Slice Contract\n\n## Files expected to change\n\n## Test plan\n- a test\n`,
      (p) => expect(readContractFiles(p)).toEqual([]),
    );
  });

  it("returns [] for the <rough list> placeholder", () => {
    withContractFile(
      `## Files expected to change\n- <rough list>\n\n## Test plan\n- a test\n`,
      (p) => expect(readContractFiles(p)).toEqual([]),
    );
  });

  it("returns [] for the <unknown> opt-out", () => {
    withContractFile(
      `## Files expected to change\n- <unknown>\n\n## Test plan\n- a test\n`,
      (p) => expect(readContractFiles(p)).toEqual([]),
    );
  });

  it("strips trailing prose annotation: '- src/cli.py (rename) ' → 'src/cli.py'", () => {
    withContractFile(
      `## Files expected to change\n- src/cli.py (rename to support recipe group)\n`,
      (p) => expect(readContractFiles(p)).toEqual(["src/cli.py"]),
    );
  });

  it("unwraps a backticked path: '- `src/lanes.ts`' → 'src/lanes.ts'", () => {
    withContractFile(
      "## Files expected to change\n- `src/lanes.ts` (new)\n",
      (p) => expect(readContractFiles(p)).toEqual(["src/lanes.ts"]),
    );
  });

  it("collects multiple bullets and stops at the next heading", () => {
    withContractFile(
      `## Files expected to change
- src/cli.py
- src/lanes.ts
- \`src/orchestrator.ts\` (touch wave loop)

## New patterns
- src/should-not-appear.ts
`,
      (p) =>
        expect(readContractFiles(p)).toEqual([
          "src/cli.py",
          "src/lanes.ts",
          "src/orchestrator.ts",
        ]),
    );
  });

  it("supports asterisk bullets as well as dashes", () => {
    withContractFile(
      `## Files expected to change\n* src/cli.py\n* src/lanes.ts\n`,
      (p) => expect(readContractFiles(p)).toEqual(["src/cli.py", "src/lanes.ts"]),
    );
  });
});

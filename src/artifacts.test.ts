import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readReviewVerdict } from "./artifacts.js";

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

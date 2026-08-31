import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findAdjudicationEstate,
  holdsAdjudicationEstate,
} from "./adjudication-estate.js";

/**
 * The disk fact behind estate ownership (ADR 0055 Seam 2 §6, fourth
 * adjudication gate round). Every consumer — `clean-failed`, `afk adopt` —
 * asks this one question, so the edges belong here as unit tests and not in
 * a spawned pipeline (AGENTS.md, "where a new assertion goes").
 */

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Best effort.
    }
  }
});

/** A worktree with a slice directory at the depth the pipeline uses. */
function makeWorktree(): { worktree: string; sliceDir: string } {
  const worktree = mkdtempSync(join(tmpdir(), "afk-estate-"));
  tempDirs.push(worktree);
  const sliceDir = join(
    worktree,
    ".kiro",
    "specs",
    "some-prd",
    "slices",
    "02-parks",
  );
  mkdirSync(sliceDir, { recursive: true });
  return { worktree, sliceDir };
}

describe("findAdjudicationEstate", () => {
  it("finds a recorded decision log wherever the slice directory sits", () => {
    const { worktree, sliceDir } = makeWorktree();
    const log = join(sliceDir, "adjudication-decisions.json");
    writeFileSync(log, JSON.stringify({ version: 1, decisions: [] }), "utf-8");

    const estate = findAdjudicationEstate(worktree);
    expect(estate).not.toBeNull();
    expect(estate!.files).toEqual([log]);
    expect(estate!.sliceDirs).toEqual([sliceDir]);
    expect(estate!.evidence).toContain("adjudication-decisions.json");
    expect(estate!.evidence).toContain("recorded human decisions");
    // The evidence is worktree-relative and forward-slashed, so the same
    // estate reads identically in a report on either platform.
    expect(estate!.evidence).not.toContain("\\");
    expect(holdsAdjudicationEstate(worktree)).toBe(true);
  });

  it("owns the estate for an IMPASSE record and not for a NON_CONVERGENCE one", () => {
    const impasse = makeWorktree();
    writeFileSync(
      join(impasse.sliceDir, "contract-negotiation-outcome.json"),
      JSON.stringify({ version: 1, classification: "IMPASSE", findings: [] }),
      "utf-8",
    );
    const nonConvergence = makeWorktree();
    writeFileSync(
      join(nonConvergence.sliceDir, "contract-negotiation-outcome.json"),
      JSON.stringify({
        version: 1,
        classification: "NON_CONVERGENCE",
        findings: [],
      }),
      "utf-8",
    );

    // The impasse record *is* the retry path: `negotiate()` re-enters
    // adjudication iff this file says IMPASSE.
    expect(findAdjudicationEstate(impasse.worktree)?.evidence).toContain(
      "impasse record",
    );
    // A non-convergent exhaustion is ordinary debris — no human decision is
    // pending, so clean-failed must still be able to clear it. Reading mere
    // presence of the outcome file would have preserved every escalated
    // slice in the run.
    expect(findAdjudicationEstate(nonConvergence.worktree)).toBeNull();
  });

  it("fails closed on an unreadable impasse record rather than reporting absence", () => {
    const { worktree, sliceDir } = makeWorktree();
    writeFileSync(
      join(sliceDir, "contract-negotiation-outcome.json"),
      "{ this is not json",
      "utf-8",
    );

    // ADR 0055 Seam 2 §8: absence is proved, not inferred. A truncated
    // record is exactly the case where deleting the worktree destroys the
    // evidence needed to tell what it was.
    const estate = findAdjudicationEstate(worktree);
    expect(estate).not.toBeNull();
    expect(estate!.evidence).toContain("could not be read");
  });

  it("proves absence for a worktree with no estate, and for one that is gone", () => {
    const { worktree, sliceDir } = makeWorktree();
    writeFileSync(join(sliceDir, "contract.md"), "# contract\n", "utf-8");
    // A decision log parked deep inside dependencies is not this slice's
    // estate, and walking there on every clean-failed call would be the
    // command's whole cost.
    const buried = join(worktree, "node_modules", "pkg", "slices", "02-x");
    mkdirSync(buried, { recursive: true });
    writeFileSync(
      join(buried, "adjudication-decisions.json"),
      JSON.stringify({ version: 1 }),
      "utf-8",
    );

    expect(findAdjudicationEstate(worktree)).toBeNull();
    expect(findAdjudicationEstate(join(worktree, "not-there"))).toBeNull();
  });
});

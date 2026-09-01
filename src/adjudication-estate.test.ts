import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeAdjudicationEstate } from "./adjudication-estate.js";

/**
 * The disk fact behind estate ownership (ADR 0055 Seam 2 §6, fourth
 * adjudication gate round). Every consumer — `clean-failed` today — asks
 * this one question, so the edges belong here as unit tests and not in
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

const DEFAULT_SPECS_DIR = ".kiro/specs/some-prd";

/** A worktree with a slice directory at the depth the pipeline uses. */
function makeWorktree(specsDir = DEFAULT_SPECS_DIR): {
  worktree: string;
  sliceDir: string;
  specsDir: string;
} {
  const worktree = mkdtempSync(join(tmpdir(), "afk-estate-"));
  tempDirs.push(worktree);
  const sliceDir = join(worktree, ...specsDir.split("/"), "slices", "02-parks");
  mkdirSync(sliceDir, { recursive: true });
  return { worktree, sliceDir, specsDir };
}

describe("probeAdjudicationEstate", () => {
  it("finds a recorded decision log wherever the slice directory sits", () => {
    const { worktree, sliceDir, specsDir } = makeWorktree();
    const log = join(sliceDir, "adjudication-decisions.json");
    writeFileSync(log, JSON.stringify({ version: 1, decisions: [] }), "utf-8");

    for (const options of [{}, { specsDir }]) {
      const probe = probeAdjudicationEstate(worktree, options);
      expect(probe.status).toBe("present");
      const estate = (probe as { estate: { files: string[]; sliceDirs: string[]; evidence: string } }).estate;
      expect(estate.files).toEqual([log]);
      expect(estate.sliceDirs).toEqual([sliceDir]);
      expect(estate.evidence).toContain("adjudication-decisions.json");
      expect(estate.evidence).toContain("recorded human decisions");
      // The evidence is worktree-relative and forward-slashed, so the same
      // estate reads identically in a report on either platform.
      expect(estate.evidence).not.toContain("\\");
    }
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
    const found = probeAdjudicationEstate(impasse.worktree);
    expect(found.status).toBe("present");
    expect((found as { estate: { evidence: string } }).estate.evidence).toContain(
      "impasse record",
    );
    // A non-convergent exhaustion is ordinary debris — no human decision is
    // pending, so clean-failed must still be able to clear it. Reading mere
    // presence of the outcome file would have preserved every escalated
    // slice in the run.
    expect(probeAdjudicationEstate(nonConvergence.worktree).status).toBe(
      "absent",
    );
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
    const probe = probeAdjudicationEstate(worktree);
    expect(probe.status).toBe("present");
    expect((probe as { estate: { evidence: string } }).estate.evidence).toContain(
      "could not be read",
    );
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

    expect(probeAdjudicationEstate(worktree).status).toBe("absent");
    expect(probeAdjudicationEstate(join(worktree, "not-there")).status).toBe(
      "absent",
    );
  });

  /**
   * Architect blocker 2, fifth adjudication gate round. The round-4 probe
   * bounded its walk at six levels — just enough for the *default*
   * `.kiro/specs/<slug>/slices/<NN>-<slug>/` layout — and `--prd-dir` takes
   * any path. A deeper one returned `null`, which `clean-failed` spent as
   * "nothing to lose".
   */
  it("finds an estate under a deep configurable specs path, resolved and walked", () => {
    const deep = "docs/internal/programs/2026/specs/demo";
    const { worktree, sliceDir, specsDir } = makeWorktree(deep);
    writeFileSync(
      join(sliceDir, "adjudication-decisions.json"),
      JSON.stringify({ version: 1, decisions: [] }),
      "utf-8",
    );

    // Resolved from the run's own recorded specs dir: depth is not a
    // variable at all.
    expect(probeAdjudicationEstate(worktree, { specsDir }).status).toBe(
      "present",
    );
    // And the no-specsDir fallback (legacy state, orphan worktree) now walks
    // the whole tree rather than six levels of it.
    expect(probeAdjudicationEstate(worktree).status).toBe("present");
  });

  /**
   * Found by the fifth round's own self-probe pass. A resolved probe that
   * finds nothing has proved absence only at the *recorded* location, and the
   * record can be wrong — relaunching the same PRD slug with a different
   * `--prd-dir` overwrites `specsDir`, and a hand-edited state file can say
   * anything. Trusting it would be inferring absence from an input, which is
   * the mistake the tri-state exists to stop. So `absent` still has to be
   * earned by the complete walk; only `present` short-circuits.
   */
  it("does not spend a stale recorded specs dir as proved absence", () => {
    const { worktree, sliceDir } = makeWorktree();
    writeFileSync(
      join(sliceDir, "adjudication-decisions.json"),
      JSON.stringify({ version: 1, decisions: [] }),
      "utf-8",
    );
    // A perfectly valid, existing directory that is simply not where this
    // worktree's estate lives.
    mkdirSync(join(worktree, "other", "specs", "slices"), { recursive: true });

    const probe = probeAdjudicationEstate(worktree, {
      specsDir: "other/specs",
    });
    expect(probe.status).toBe("present");
    expect((probe as { estate: { evidence: string } }).estate.evidence).toContain(
      "adjudication-decisions.json",
    );
  });

  it("reports indeterminate, never absent, when the recorded specs path is not a directory", () => {
    const { worktree } = makeWorktree();
    // The enumeration cannot complete, and the failure must not read as
    // absence. This is also why the probe asks `existsSync`/`statSync`
    // rather than classifying the `readdir` errno: Windows reports ENOENT
    // for a read under a plain file, so an errno-only rule would call this
    // proved absence and let clean-failed delete the worktree.
    writeFileSync(join(worktree, "specs-file"), "not a directory", "utf-8");

    const probe = probeAdjudicationEstate(worktree, {
      specsDir: "specs-file",
    });
    expect(probe.status).toBe("indeterminate");
    expect((probe as { reason: string }).reason).toMatch(/not a directory/);
  });

  it("reports indeterminate when the slices directory itself is not a directory", () => {
    const { worktree, specsDir } = makeWorktree();
    rmSync(join(worktree, ...specsDir.split("/"), "slices"), {
      recursive: true,
      force: true,
    });
    writeFileSync(
      join(worktree, ...specsDir.split("/"), "slices"),
      "clobbered",
      "utf-8",
    );

    const probe = probeAdjudicationEstate(worktree, { specsDir });
    expect(probe.status).toBe("indeterminate");
  });

  it("refuses a recorded specs dir that is absolute or escapes the worktree", () => {
    const { worktree } = makeWorktree();
    for (const specsDir of ["C:/elsewhere/specs", "/etc/specs", "../outside"]) {
      const probe = probeAdjudicationEstate(worktree, { specsDir });
      expect(probe.status).toBe("indeterminate");
    }
  });

  it("treats a missing slices directory as proved absence, not as a failed probe", () => {
    const worktree = mkdtempSync(join(tmpdir(), "afk-estate-"));
    tempDirs.push(worktree);
    // ENOENT is proof: git checked this tree out from a commit, so there are
    // no slice artifacts to find. Every other enumeration error is the probe
    // failing, not the tree being empty.
    expect(
      probeAdjudicationEstate(worktree, { specsDir: ".kiro/specs/absent" })
        .status,
    ).toBe("absent");
  });
});

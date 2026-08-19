import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildResumeHandoffNote,
  decideResume,
  isForceRestarted,
  type ResumeFacts,
} from "./resume.js";
import { renderPrompt } from "./prompt-template.js";

/**
 * Unit tests for the pure resume-eligibility decision (spec #33,
 * design note on #15). Git-state facts in, resume/restart plan +
 * reason out — no repo needed. Later tickets only add inputs.
 */

/** A slice whose surviving git state proves resume is safe. */
function resumableFacts(overrides: Partial<ResumeFacts> = {}): ResumeFacts {
  return {
    branchExists: true,
    worktreeRegistered: true,
    commitsAheadOfBase: 3,
    stuckFilePresent: false,
    resumeAttempts: 0,
    forceRestart: false,
    ...overrides,
  };
}

describe("decideResume", () => {
  it("resumes when the branch survives with commits beyond base in a registered worktree", () => {
    expect(decideResume(resumableFacts())).toEqual({
      action: "resume",
      commitsAhead: 3,
    });
  });

  it("treats a slice with no branch and no worktree as a fresh first run", () => {
    // No evidence of a prior attempt — this is not a restart decision,
    // it is the normal first-run creation path (no resume logging).
    expect(
      decideResume(
        resumableFacts({
          branchExists: false,
          worktreeRegistered: false,
          commitsAheadOfBase: 0,
        }),
      ),
    ).toEqual({ action: "fresh" });
  });

  it("restarts from base when the branch is missing but a worktree survives", () => {
    expect(
      decideResume(
        resumableFacts({ branchExists: false, commitsAheadOfBase: 0 }),
      ),
    ).toEqual({ action: "restart", reason: "slice branch missing" });
  });

  it("restarts from base when the worktree is missing or unregistered (ADR 0010)", () => {
    expect(
      decideResume(resumableFacts({ worktreeRegistered: false })),
    ).toEqual({
      action: "restart",
      reason: "worktree missing or unregistered",
    });
  });

  it("restarts from base when the branch has zero commits beyond base", () => {
    expect(decideResume(resumableFacts({ commitsAheadOfBase: 0 }))).toEqual({
      action: "restart",
      reason: "no commits beyond base",
    });
  });

  it("never resumes a slice that went STUCK with a stuck.md (#36)", () => {
    // Terminal diagnoses keep their meaning — even a branch with
    // commits ahead restarts when the stuck marker is present.
    expect(decideResume(resumableFacts({ stuckFilePresent: true }))).toEqual({
      action: "restart",
      reason: "stuck.md present (terminal diagnosis)",
    });
  });

  it("restarts once the resume-attempt cap of 2 is reached (#36)", () => {
    // Repeated death on the same tree is evidence of poison.
    expect(decideResume(resumableFacts({ resumeAttempts: 2 }))).toEqual({
      action: "restart",
      reason: "resume attempt cap (2) reached",
    });
  });

  it("still resumes below the cap", () => {
    expect(decideResume(resumableFacts({ resumeAttempts: 1 }))).toEqual({
      action: "resume",
      commitsAhead: 3,
    });
  });

  it("restarts an otherwise-resumable slice when the operator forced it (#37)", () => {
    expect(decideResume(resumableFacts({ forceRestart: true }))).toEqual({
      action: "restart",
      reason: "--force-restart",
    });
  });

  it("a forced slice with no prior attempt still runs fresh (flag is a no-op)", () => {
    expect(
      decideResume(
        resumableFacts({
          branchExists: false,
          worktreeRegistered: false,
          commitsAheadOfBase: 0,
          forceRestart: true,
        }),
      ),
    ).toEqual({ action: "fresh" });
  });
});


describe("isForceRestarted", () => {
  const slice = { number: "05", ghIssue: "4001" };

  it("is false when no flag was given", () => {
    expect(isForceRestarted(undefined, slice)).toBe(false);
  });

  it("matches by GH issue id", () => {
    expect(isForceRestarted(["4001"], slice)).toBe(true);
  });

  it("matches by slice number, zero padding optional", () => {
    expect(isForceRestarted(["05"], slice)).toBe(true);
    expect(isForceRestarted(["5"], slice)).toBe(true);
  });

  it("leaves unnamed slices unaffected", () => {
    expect(isForceRestarted(["07", "4002"], slice)).toBe(false);
  });
});


/**
 * Resume prompt completeness (#38): the prior handoff.md is included
 * only when it is FRESHER than the last commit — a handoff written
 * before the dead generator's last commit describes an earlier state
 * of the work and actively misleads. Stale handoffs are omitted
 * entirely, not included with a caveat.
 */
describe("buildResumeHandoffNote", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "afk-handoff-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("includes a handoff whose mtime is newer than the last commit", () => {
    const handoffPath = join(dir, "handoff.md");
    writeFileSync(handoffPath, "## Status\nSlice nearly done.\n", "utf-8");
    const mtime = new Date("2026-08-18T12:00:00Z");
    utimesSync(handoffPath, mtime, mtime);
    const lastCommitEpoch = Date.parse("2026-08-18T11:00:00Z") / 1000;

    const note = buildResumeHandoffNote(handoffPath, lastCommitEpoch);

    expect(note).toContain("Slice nearly done.");
    expect(note).toMatch(/handoff/i);
  });

  it("omits a handoff older than the last commit entirely", () => {
    const handoffPath = join(dir, "handoff.md");
    writeFileSync(handoffPath, "## Status\nOutdated claim.\n", "utf-8");
    const mtime = new Date("2026-08-18T10:00:00Z");
    utimesSync(handoffPath, mtime, mtime);
    const lastCommitEpoch = Date.parse("2026-08-18T11:00:00Z") / 1000;

    expect(buildResumeHandoffNote(handoffPath, lastCommitEpoch)).toBe("");
  });

  it("omits a missing handoff", () => {
    expect(
      buildResumeHandoffNote(join(dir, "handoff.md"), Date.now() / 1000),
    ).toBe("");
  });

  it("treats an unknown last-commit time as stale (never mislead)", () => {
    const handoffPath = join(dir, "handoff.md");
    writeFileSync(handoffPath, "content", "utf-8");
    expect(buildResumeHandoffNote(handoffPath, null)).toBe("");
  });
});

/**
 * The rendered resume prompt must carry the tree-wins and
 * migration-prefix rules verbatim (#38), with every placeholder
 * filled — renderPrompt throws on missing AND unused args, so a clean
 * render with exactly this arg set locks full placeholder coverage.
 */
describe("generator-resume prompt rendering", () => {
  function render(handoffNote = ""): string {
    return renderPrompt("generator-resume", {
      SLICE_DIR: ".kiro/specs/demo/slices/01-x",
      RELEVANT_FILES: "- README.md",
      SIBLING_HANDOFFS: "(none)",
      TEST_COMMAND: "pnpm test:run",
      COMMITS_AHEAD: 3,
      COMMIT_LOG: "abc123 feat: work",
      FEAT_BRANCH: "feat/demo",
      HANDOFF_NOTE: handoffNote,
    });
  }

  it("contains the tree-wins-over-contract rule verbatim", () => {
    const prompt = render();
    expect(prompt).toContain(
      "the contract predates merges from other slices",
    );
    expect(prompt).toContain("the current tree wins over the contract");
  });

  it("contains the migration-prefix renumber rule verbatim", () => {
    expect(render()).toContain("renumber yours to the next free prefix");
  });

  it("splices the handoff note through, or renders cleanly without one", () => {
    expect(render("## Prior handoff\nFresh notes.")).toContain("Fresh notes.");
    expect(render("")).not.toContain("undefined");
  });
});

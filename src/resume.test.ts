import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildResumeHandoffNote,
  buildStuckDiagnosisNote,
  decideResume,
  formatRestartRefusal,
  isForceRestarted,
  isResumeStuckRequested,
  restartOrRefuse,
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
    resumeStuck: false,
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

  it("restarts from base when the worktree is missing and nothing is committed (ADR 0010)", () => {
    expect(
      decideResume(
        resumableFacts({ worktreeRegistered: false, commitsAheadOfBase: 0 }),
      ),
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
    // Terminal diagnoses keep their meaning — the tree is not resumed.
    // With nothing committed the restart is free; with commits it refuses
    // instead (see the #113 block below).
    expect(
      decideResume(
        resumableFacts({ stuckFilePresent: true, commitsAheadOfBase: 0 }),
      ),
    ).toEqual({
      action: "restart",
      reason: "stuck.md present (terminal diagnosis)",
    });
  });

  it("stops resuming once the resume-attempt cap of 2 is reached (#36)", () => {
    // Repeated death on the same tree is evidence of poison — but the cap
    // only ever fires with commits on the branch (the zero-commits guard
    // runs first), so what it does is refuse, not restart (#113).
    expect(decideResume(resumableFacts({ resumeAttempts: 2 }))).toEqual({
      action: "refuse",
      reason: "resume attempt cap (2) reached",
      commitsAhead: 3,
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

/**
 * Opt-in resume of a STUCK slice's preserved tree (#49). The default in
 * every case below is the unchanged `restart` decision above — these
 * tests only describe what the operator's explicit `--resume-stuck`
 * buys, and where it deliberately buys nothing.
 */
describe("decideResume with --resume-stuck (#49)", () => {
  const stuck = (overrides: Partial<ResumeFacts> = {}): ResumeFacts =>
    resumableFacts({ stuckFilePresent: true, resumeStuck: true, ...overrides });

  it("resumes a STUCK slice's preserved tree when the operator opted in", () => {
    expect(decideResume(stuck())).toEqual({
      action: "resume-stuck",
      commitsAhead: 3,
    });
  });

  it("still declines to resume a STUCK slice the operator did NOT name", () => {
    // The reason is byte-identical to pre-#49 behavior; since #113 a
    // stuck branch holding commits refuses rather than restarting.
    expect(decideResume(stuck({ resumeStuck: false }))).toEqual({
      action: "refuse",
      reason: "stuck.md present (terminal diagnosis)",
      commitsAhead: 3,
    });
  });

  it("requires a preserved branch", () => {
    expect(
      decideResume(stuck({ branchExists: false, commitsAheadOfBase: 0 })),
    ).toEqual({ action: "restart", reason: "slice branch missing" });
  });

  it("requires a registered worktree (ADR 0010)", () => {
    expect(
      decideResume(stuck({ worktreeRegistered: false, commitsAheadOfBase: 0 })),
    ).toEqual({
      action: "restart",
      reason: "worktree missing or unregistered",
    });
  });

  it("requires commits ahead of base, and says the opt-in did not apply", () => {
    // Restarting silently here would look like the flag was ignored.
    expect(decideResume(stuck({ commitsAheadOfBase: 0 }))).toEqual({
      action: "restart",
      reason: "--resume-stuck named this slice but it has no commits beyond base",
    });
  });

  it("refuses rather than restarts when its worktree vanished but commits survive (#113)", () => {
    // The branch still holds the work; only the checkout is gone.
    expect(decideResume(stuck({ worktreeRegistered: false }))).toEqual({
      action: "refuse",
      reason: "worktree missing or unregistered",
      commitsAhead: 3,
    });
  });

  it("is not capped by MAX_RESUME_ATTEMPTS — the operator is the cap", () => {
    // Honouring the cap here would restart from base and destroy the
    // very commits and diagnosis the operator asked to keep.
    expect(decideResume(stuck({ resumeAttempts: 5 }))).toEqual({
      action: "resume-stuck",
      commitsAhead: 3,
    });
  });

  it("yields to --force-restart on the same slice", () => {
    expect(decideResume(stuck({ forceRestart: true }))).toEqual({
      action: "restart",
      reason: "--force-restart",
    });
  });

  it("is a no-op on a slice with no stuck.md — the ordinary resume still applies", () => {
    expect(decideResume(resumableFacts({ resumeStuck: true }))).toEqual({
      action: "resume",
      commitsAhead: 3,
    });
  });

  it("is a no-op on a slice with no prior attempt at all", () => {
    expect(
      decideResume(
        resumableFacts({
          branchExists: false,
          worktreeRegistered: false,
          commitsAheadOfBase: 0,
          resumeStuck: true,
        }),
      ),
    ).toEqual({ action: "fresh" });
  });
});


/**
 * The #113 invariant: a from-base restart force-resets the branch and
 * recreates the worktree, so it must never run on a branch that still
 * holds unmerged commits unless the operator named the slice in
 * `--force-restart`. The incident: a resume-attempt cap converted into a
 * restart, destroying 11 commits and a LOCKED contract.
 */
describe("decideResume never destroys unmerged commits (#113)", () => {
  const cases: Array<[string, Partial<ResumeFacts>, string]> = [
    ["the resume-attempt cap", { resumeAttempts: 2 }, "resume attempt cap (2) reached"],
    [
      "a vanished worktree",
      { worktreeRegistered: false },
      "worktree missing or unregistered",
    ],
    [
      "a terminal stuck.md",
      { stuckFilePresent: true },
      "stuck.md present (terminal diagnosis)",
    ],
  ];

  for (const [label, overrides, reason] of cases) {
    it(`refuses on ${label}, keeping the reason it would have restarted with`, () => {
      expect(decideResume(resumableFacts(overrides))).toEqual({
        action: "refuse",
        reason,
        commitsAhead: 3,
      });
    });

    it(`still restarts plainly on ${label} when the branch is at base`, () => {
      // The cap's purpose survives: nothing is resumed. There is simply
      // nothing to lose, so the restart needs no operator decision.
      expect(
        decideResume(resumableFacts({ ...overrides, commitsAheadOfBase: 0 })),
      ).toMatchObject({ action: "restart" });
    });
  }

  it("lets --force-restart through, commits and all — the operator asked", () => {
    expect(
      decideResume(resumableFacts({ resumeAttempts: 2, forceRestart: true })),
    ).toEqual({ action: "restart", reason: "--force-restart" });
  });

  it("restartOrRefuse is the single place the invariant lives", () => {
    expect(restartOrRefuse("any reason", 0)).toEqual({
      action: "restart",
      reason: "any reason",
    });
    expect(restartOrRefuse("any reason", 1)).toEqual({
      action: "refuse",
      reason: "any reason",
      commitsAhead: 1,
    });
  });
});

/**
 * The refusal is only useful if the operator can act on it, so the
 * message must name the count, the branch, and the flag that resolves it.
 */
describe("formatRestartRefusal (#113)", () => {
  const base = {
    reason: "resume attempt cap (2) reached",
    commitsAhead: 11,
    branch: "afk/prd-1-slice-05-thing",
    selector: "75",
  };

  it("names the commits at risk, the branch, and --force-restart", () => {
    const message = formatRestartRefusal(base);
    expect(message).toContain("11 unmerged commit(s)");
    expect(message).toContain("afk/prd-1-slice-05-thing");
    expect(message).toContain("--force-restart 75");
    expect(message).toContain("resume attempt cap (2) reached");
  });

  it("points a stuck slice at --resume-stuck as well", () => {
    const message = formatRestartRefusal({
      ...base,
      reason: "stuck.md present (terminal diagnosis)",
    });
    expect(message).toContain("--resume-stuck 75");
    // The cap refusal has no preserved diagnosis to offer, so it must not
    // suggest a flag that would be rejected.
    expect(formatRestartRefusal(base)).not.toContain("--resume-stuck");
  });

  it("names the archive location when artifacts were copied out", () => {
    expect(
      formatRestartRefusal({ ...base, archiveDir: ".afk/artifacts/x/slice-05" }),
    ).toContain(".afk/artifacts/x/slice-05");
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


describe("isResumeStuckRequested", () => {
  const slice = { number: "20", ghIssue: "49" };

  it("is false when no flag was given", () => {
    expect(isResumeStuckRequested(undefined, slice)).toBe(false);
  });

  it("matches by GH issue id", () => {
    expect(isResumeStuckRequested(["49"], slice)).toBe(true);
  });

  it("matches by slice number, zero padding optional", () => {
    expect(isResumeStuckRequested(["20"], slice)).toBe(true);
    expect(isResumeStuckRequested(["020"], slice)).toBe(true);
  });

  it("leaves unnamed slices unaffected", () => {
    expect(isResumeStuckRequested(["21", "50"], slice)).toBe(false);
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
 * The rendered resume prompt must carry the exact migration claim rule,
 * with every placeholder
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
      UNRESOLVED_FINDINGS:
        "- Finding ID: `QA-01`\n  Summary: The behavior fails",
      HANDOFF_NOTE: handoffNote,
      MIGRATION_RESERVATION: "This slice owns exactly: 144.",
    });
  }

  it("makes AFK's migration claim authoritative", () => {
    const prompt = render();
    expect(prompt).toContain("Migration instructions are authoritative");
    expect(prompt).toContain("This slice owns exactly: 144.");
    expect(prompt).not.toContain("renumber yours to the next free prefix");
  });

  it("splices the handoff note through, or renders cleanly without one", () => {
    expect(render("## Prior handoff\nFresh notes.")).toContain("Fresh notes.");
    expect(render("")).not.toContain("undefined");
  });

  it("routes the code-derived unresolved findings", () => {
    expect(render()).toContain("QA-01");
  });
});

/**
 * The preserved STUCK diagnosis (#49) rides into the prompt verbatim and
 * unconditionally — no staleness check. A stuck.md is written after the
 * slice's last commit, and it is the reason the operator opted in.
 */
describe("buildStuckDiagnosisNote", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "afk-stuck-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("includes the diagnosis verbatim, however old the file is", () => {
    const stuckPath = join(dir, "stuck.md");
    writeFileSync(
      stuckPath,
      "# Stuck Handoff\n\n## What the evaluator wants\nFinding 1 — precedence is wrong.\n",
      "utf-8",
    );
    const ancient = new Date("2020-01-01T00:00:00Z");
    utimesSync(stuckPath, ancient, ancient);

    const note = buildStuckDiagnosisNote(stuckPath);

    expect(note).toContain("Finding 1 — precedence is wrong.");
    expect(note).toMatch(/declared STUCK/i);
  });

  it("omits a missing stuck.md", () => {
    expect(buildStuckDiagnosisNote(join(dir, "stuck.md"))).toBe("");
  });

  it("omits an empty stuck.md rather than emitting an empty block", () => {
    const stuckPath = join(dir, "stuck.md");
    writeFileSync(stuckPath, "   \n\n", "utf-8");
    expect(buildStuckDiagnosisNote(stuckPath)).toBe("");
  });
});

/**
 * The stuck-resume prompt (#49) must state the OPPOSITE worktree facts
 * from `generator-resume`: nothing reset, nothing cleaned, diagnosis
 * kept. renderPrompt throws on missing AND unused args, so a clean
 * render with exactly this arg set locks full placeholder coverage.
 */
describe("generator-resume-stuck prompt rendering", () => {
  function render(
    overrides: { stuckNote?: string; handoffNote?: string; baseNote?: string } = {},
  ): string {
    return renderPrompt("generator-resume-stuck", {
      SLICE_DIR: ".kiro/specs/demo/slices/20-x",
      RELEVANT_FILES: "- README.md",
      SIBLING_HANDOFFS: "(none)",
      TEST_COMMAND: "pnpm test:run",
      COMMITS_AHEAD: 14,
      COMMIT_LOG: "71066cc feat: round 3",
      BASE_REFRESH_NOTE: overrides.baseNote ?? "The feature branch was merged in.",
      STUCK_NOTE: overrides.stuckNote ?? "",
      UNRESOLVED_FINDINGS:
        "- Finding ID: `QA-01`\n  Summary: The behavior fails",
      HANDOFF_NOTE: overrides.handoffNote ?? "",
      MIGRATION_RESERVATION: "This slice owns exactly: 144.",
    });
  }

  it("tells the generator its worktree was NOT reset or cleaned", () => {
    const prompt = render();
    expect(prompt).toContain("Your worktree was not touched.");
    // The #33 template's post-reset warning must NOT leak in here.
    expect(prompt).not.toMatch(/anything after your last commit is gone/i);
  });

  it("forbids deleting the preserved diagnosis", () => {
    expect(render()).toMatch(/Never delete `.*stuck\.md`/);
  });

  it("carries the exact migration claim rule", () => {
    const prompt = render();
    expect(prompt).toContain("Migration instructions are authoritative");
    expect(prompt).toContain("This slice owns exactly: 144.");
    expect(prompt).not.toContain("renumber yours to the next free prefix");
  });

  it("splices the diagnosis and handoff notes through, or renders cleanly without them", () => {
    expect(render({ stuckNote: "Finding 1 — precedence." })).toContain(
      "Finding 1 — precedence.",
    );
    expect(render({ handoffNote: "## Prior handoff\nNotes." })).toContain("Notes.");
    expect(render()).not.toContain("undefined");
  });

  it("carries whichever base-refresh fact actually happened", () => {
    expect(render({ baseNote: "could **not** be merged" })).toContain(
      "could **not** be merged",
    );
  });

  it("routes code-derived unresolved findings without requiring prior reports", () => {
    const prompt = render();
    expect(prompt).toContain("Finding ID: `QA-01`");
    expect(prompt).not.toContain("Every preserved QA report");
  });
});

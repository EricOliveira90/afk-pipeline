import { describe, it, expect, afterAll, afterEach, beforeAll } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPipeline, makeSliceContext, prepareSliceWorktree } from "./orchestrator.js";
import { RunJournal as Logger } from "./run-journal.js";
import { buildDAG, type Slice } from "./issues-parser.js";
import type { AgentProvider, InvokeOptions, InvokeResult } from "./agent-provider.js";

/**
 * Retry integration for the resume-a-dead-slice feature (spec #33,
 * design note on #15), at the outermost seam: two `runPipeline` runs
 * against the same real repo. Run 1's generator dies mid-slice; run 2
 * retries. Assertions are external behavior only — worktree/branch
 * state, prompt inputs at the prompt-assembly seam, run.log lines —
 * never internal call sequences.
 */

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

/**
 * A throwaway git repo. By default the per-test `afterEach` removes it;
 * pass `{ lifetime: "describe" }` when a block spawns its runs once in
 * `beforeAll` and splits the assertions across `it` cases — those cases
 * still need the repo on disk, so the caller owns cleanup in `afterAll`.
 */
function makeRepo(opts: { lifetime?: "test" | "describe" } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "afk-resume-int-"));
  if (opts.lifetime !== "describe") tempDirs.push(dir);
  git(dir, ["init", "--initial-branch=main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  writeFileSync(join(dir, "README.md"), "test\n", "utf-8");
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "-m", "root"]);
  return dir;
}

function writePrdFixture(repoDir: string, slug: string): { prdDir: string; specsDir: string } {
  const specsDir = join(".kiro", "specs", slug);
  const prdDir = join(repoDir, specsDir);
  mkdirSync(prdDir, { recursive: true });
  writeFileSync(
    join(prdDir, "prd.md"),
    `# ${slug}\n\n## Relevant Files\n- README.md — root readme\n`,
    "utf-8",
  );
  return { prdDir, specsDir };
}

function makeSlice(): Slice {
  return {
    number: "01",
    ghIssue: "4001",
    title: "Resumable",
    type: "AFK",
    blockedBy: [],
    userStories: "",
  };
}

/** Locate the slice artifact dir inside a worktree (same walk as orchestrator tests). */
function findSliceArtifactDir(cwd: string, sliceNumber: string): string | null {
  const specsRoot = join(cwd, ".kiro", "specs");
  if (!existsSync(specsRoot)) return null;
  for (const slug of readdirSync(specsRoot)) {
    const slicesDir = join(specsRoot, slug, "slices");
    if (!existsSync(slicesDir)) continue;
    for (const entry of readdirSync(slicesDir)) {
      if (entry.startsWith(`${sliceNumber}-`)) return join(slicesDir, entry);
    }
  }
  return null;
}

/**
 * Slice number the invocation's worktree belongs to — worktrees live at
 * `.afk/worktrees/<prefix>-<slug>-s<NN>` (see `sliceWorktreeDir`). Empty
 * for the post-merge review worktree, which belongs to no slice.
 */
function sliceNumberFromCwd(cwd: string): string {
  return /-s(\d+)$/.exec(cwd.replace(/\\/g, "/"))?.[1] ?? "";
}

interface PromptRecord {
  role: string;
  /** Slice the invocation ran for, so merged multi-slice runs stay assertable. */
  sliceNumber: string;
  prompt: string;
  /** Whether run 1's uncommitted casualty file was visible at invocation time. */
  dirtyFilePresent: boolean;
  /** Whether the sibling commit that advanced the feature branch was visible. */
  featureFilePresent: boolean;
  /** Whether BOTH colliding migration files (slice's + feature's) were visible. */
  migrationCollisionPresent: boolean;
  /** Whether the previous run's UNCOMMITTED in-flight edit survived (#49). */
  inFlightPresent: boolean;
  /** Whether the preserved stuck.md diagnosis survived into this run (#49). */
  stuckFilePresent: boolean;
}

/**
 * Stub provider. Explorer/planner/evaluator behave like the standard
 * fixture stub; the generator behavior is injected per run.
 */
function buildProvider(opts: {
  generator: (
    cwd: string,
    options: InvokeOptions,
    sliceNumber: string,
  ) => Promise<void> | void;
  records?: PromptRecord[];
  /** Deterministic QA verdict for every evaluator-qa invocation. */
  qaVerdict?: "PASS" | "FAIL";
}): AgentProvider {
  return {
    name: "stub",
    async invoke(options: InvokeOptions): Promise<InvokeResult> {
      const { role, cwd } = options;
      const sliceNumber = sliceNumberFromCwd(cwd);
      opts.records?.push({
        role,
        sliceNumber,
        prompt: options.prompt,
        dirtyFilePresent: existsSync(join(cwd, "src", "half-written.ts")),
        featureFilePresent: existsSync(join(cwd, "src", "sibling.ts")),
        migrationCollisionPresent:
          existsSync(join(cwd, "supabase", "migrations", "125_slice_work.sql")) &&
          existsSync(join(cwd, "supabase", "migrations", "125_sibling.sql")),
        inFlightPresent: existsSync(join(cwd, "src", "in-flight.ts")),
        stuckFilePresent: (() => {
          const dir = findSliceArtifactDir(cwd, sliceNumber);
          return dir !== null && existsSync(join(dir, "stuck.md"));
        })(),
      });
      const artifactDir = findSliceArtifactDir(cwd, sliceNumber);
      if (role === "explorer" && artifactDir) {
        writeFileSync(join(artifactDir, "context.md"), "# Context\n", "utf-8");
      } else if (role === "planner" && artifactDir) {
        writeFileSync(
          join(artifactDir, "contract.md"),
          // Per-slice declared file, so a merged multi-slice run gets
          // disjoint lanes and its slices really do overlap.
          `# Slice Contract\n\n**Status:** LOCKED\n\n## Files expected to change\n- src/work-${sliceNumber}.ts\n`,
          "utf-8",
        );
      } else if (role === "evaluator-contract" && artifactDir) {
        writeFileSync(
          join(artifactDir, "feedback-r1.md"),
          "## Evaluator feedback — round 1\n\n**Verdict:** ACCEPT\n",
          "utf-8",
        );
      } else if (role === "generator") {
        await opts.generator(cwd, options, sliceNumber);
      } else if (role === "evaluator-qa" && artifactDir) {
        writeFileSync(
          join(artifactDir, "qa-report.md"),
          `# QA Report\n\n**Verdict:** ${opts.qaVerdict ?? "PASS"}\n`,
          "utf-8",
        );
      } else if (role === "generator-stuck" && artifactDir) {
        writeFileSync(join(artifactDir, "stuck.md"), "# Stuck\n", "utf-8");
      }
      return { exitCode: 0, stdout: "", stats: {} };
    },
  };
}

/** Concatenated run.log content across every run directory for the slug. */
function allRunLogs(repo: string, loggerSlug: string): string {
  const logsRoot = join(repo, ".afk", "logs", loggerSlug);
  if (!existsSync(logsRoot)) return "";
  let out = "";
  for (const entry of readdirSync(logsRoot)) {
    const logPath = join(logsRoot, entry, "run.log");
    if (existsSync(logPath)) out += readFileSync(logPath, "utf-8");
  }
  return out;
}

/**
 * The run.log lines belonging to one slice. Every per-slice line carries
 * the slice's tag (`[afk] Slice #<id> (<title>)`), so a merged run stays
 * as assertable as a single-slice one.
 */
function sliceLogLines(repo: string, loggerSlug: string, ghIssue: string): string {
  return allRunLogs(repo, loggerSlug)
    .split(/\r?\n/)
    .filter((line) => line.includes(`Slice #${ghIssue}`))
    .join("\n");
}

describe("retried slice resume (spec #33)", () => {
  /**
   * One death, four verdicts. Every slice here dies mid-run with the
   * launcher seeing ERROR; what separates them is what the retry is
   * allowed to keep — a clean resume (#33/#35/#38), the conflict
   * fallback (#35), the operator's `--force-restart` (#37), and a branch
   * with nothing on it. They share the fixture and the pair of runs
   * because the *decision* is per slice: one invocation makes four
   * different calls, which is what the retry logic claims to do.
   */
  describe("what a retry keeps after a mid-slice death (#33, #35, #37, #38)", () => {
    const slug = "resume-deaths";
    const slice = (number: string, ghIssue: string, title: string): Slice => ({
      number, ghIssue, title, type: "AFK", blockedBy: [], userStories: "",
    });
    /** 01 resumes, 02 hits the conflict fallback, 03 is forced, 04 has no commits. */
    const slices = [
      slice("01", "4001", "Resumable"),
      slice("02", "4002", "Conflicting"),
      slice("03", "4003", "Forced"),
      slice("04", "4004", "Empty"),
    ];
    const records: PromptRecord[] = [];
    let repo: string;
    let statePath: string;
    /** State after run 1, before run 2 overwrote it. */
    let deathPhases: Record<string, string>;

    const generatorRecord = (sliceNumber: string): PromptRecord =>
      records.find((r) => r.role === "generator" && r.sliceNumber === sliceNumber)!;
    const rolesFor = (sliceNumber: string): string[] =>
      records.filter((r) => r.sliceNumber === sliceNumber).map((r) => r.role);
    const logFor = (ghIssue: string): string =>
      sliceLogLines(repo, `${slug}-stub`, ghIssue);

    beforeAll(async () => {
      repo = makeRepo({ lifetime: "describe" });
      const { prdDir, specsDir } = writePrdFixture(repo, slug);
      statePath = join(repo, ".afk", "state", `${slug}-stub.json`);
      const runConfig = { repoRoot: repo, prdSlug: slug, prdDir, specsDir };
      const dag = buildDAG(slices);

      // --- Run 1: every generator dies. Slice 01 commits real work and
      // writes a handoff AFTER the commit (fresher than the tree — must
      // survive to the resume prompt, #38) and leaves a half-written
      // uncommitted file. Slice 02 commits an edit to README.md, which
      // the feature branch will then contradict. Slice 03 commits work
      // that is resumable on its own merits. Slice 04 dies first.
      await runPipeline({
        ...runConfig,
        dag,
        provider: buildProvider({
          generator: (cwd, _options, sliceNumber) => {
            mkdirSync(join(cwd, "src"), { recursive: true });
            if (sliceNumber === "01") {
              writeFileSync(join(cwd, "src", "work-01.ts"), "export const done = 1;\n", "utf-8");
              // The slice claims migration prefix 125 before dying (#38 AC4).
              mkdirSync(join(cwd, "supabase", "migrations"), { recursive: true });
              writeFileSync(
                join(cwd, "supabase", "migrations", "125_slice_work.sql"),
                "select 1;\n",
                "utf-8",
              );
              git(cwd, ["add", "src/work-01.ts", "supabase/migrations/125_slice_work.sql"]);
              git(cwd, ["commit", "-m", "feat(#4001): committed before death"]);
              const artifactDir = findSliceArtifactDir(cwd, "01")!;
              writeFileSync(
                join(artifactDir, "handoff.md"),
                "## Status\nCheckpoint: behavior A done, starting behavior B.\n",
                "utf-8",
              );
              writeFileSync(
                join(cwd, "src", "half-written.ts"),
                "export const halfApplied =", // mid-edit death
                "utf-8",
              );
              throw new Error("model outage: generator killed mid-run");
            }
            if (sliceNumber === "02") {
              writeFileSync(join(cwd, "README.md"), "slice version\n", "utf-8");
              git(cwd, ["add", "README.md"]);
              git(cwd, ["commit", "-m", "feat(#4002): slice edit"]);
              throw new Error("killed after committing");
            }
            if (sliceNumber === "03") {
              writeFileSync(join(cwd, "src", "work-03.ts"), "export const done = 1;\n", "utf-8");
              git(cwd, ["add", "-A"]);
              git(cwd, ["commit", "-m", "feat(#4003): committed before death"]);
              throw new Error("killed");
            }
            throw new Error("killed before any commit");
          },
        }),
      });

      const afterRun1 = JSON.parse(readFileSync(statePath, "utf-8"));
      deathPhases = Object.fromEntries(
        slices.map((s) => [s.ghIssue, afterRun1.slices[s.ghIssue].phase]),
      );

      // The feature branch advances after the fork — sibling slices
      // merged while these slices were dead (#35 base refresh). One of
      // them claimed the SAME migration prefix under a different
      // filename (#38 AC4), and one contradicts slice 02's README edit.
      git(repo, ["checkout", `feat-stub/${slug}`]);
      mkdirSync(join(repo, "src"), { recursive: true });
      writeFileSync(join(repo, "src", "sibling.ts"), "export const sibling = 1;\n", "utf-8");
      mkdirSync(join(repo, "supabase", "migrations"), { recursive: true });
      writeFileSync(join(repo, "supabase", "migrations", "125_sibling.sql"), "select 2;\n", "utf-8");
      writeFileSync(join(repo, "README.md"), "feature version\n", "utf-8");
      // Named paths only: `add -A` here would sweep the still-untracked
      // PRD fixture and `.afk/` run state onto the feature branch, and
      // the checkout back to main would then delete them.
      git(repo, [
        "add",
        "README.md",
        "src/sibling.ts",
        "supabase/migrations/125_sibling.sql",
      ]);
      git(repo, ["commit", "-m", "feat: sibling slice merged while dead"]);
      git(repo, ["checkout", "main"]);

      // --- Run 2: the retry. The operator judged slice 03's worktree bad.
      await runPipeline({
        ...runConfig,
        dag,
        forceRestart: ["03"],
        provider: buildProvider({
          records,
          generator: (cwd, _options, sliceNumber) => {
            if (sliceNumber === "01") {
              // Follow the prompt's migration-prefix rule: renumber to
              // the next free prefix so the slice can merge cleanly.
              git(cwd, [
                "mv",
                "supabase/migrations/125_slice_work.sql",
                "supabase/migrations/126_slice_work.sql",
              ]);
              writeFileSync(join(cwd, "src", "finish.ts"), "export const finished = 1;\n", "utf-8");
              git(cwd, ["add", "src/finish.ts"]);
              git(cwd, ["commit", "-m", "feat(#4001): finished after resume"]);
              return;
            }
            mkdirSync(join(cwd, "src"), { recursive: true });
            writeFileSync(
              join(cwd, "src", `redo-${sliceNumber}.ts`),
              "export const redo = 1;\n",
              "utf-8",
            );
            git(cwd, ["add", "-A"]);
            git(cwd, ["commit", "-m", `feat: redone from base (slice ${sliceNumber})`]);
          },
        }),
      });
    }, 240_000);

    afterAll(() => {
      try {
        rmSync(repo, { recursive: true, force: true });
      } catch {
        // best effort
      }
    });

    it("leaves every dead slice in ERROR after the first run", () => {
      expect(deathPhases).toEqual({
        "4001": "ERROR", "4002": "ERROR", "4003": "ERROR", "4004": "ERROR",
      });
    });

    it("every retried slice reaches PASS", () => {
      const state = JSON.parse(readFileSync(statePath, "utf-8"));
      for (const s of slices) expect(state.slices[s.ghIssue].phase).toBe("PASS");
    });

    it("resumes slice 01 from its surviving tip without renegotiating", () => {
      // Explorer and planner stay skipped — their artifacts survived.
      expect(rolesFor("01")).not.toContain("explorer");
      expect(rolesFor("01")).not.toContain("planner");
      expect(logFor("4001")).toMatch(/resuming from 1 commit/);
    });

    it("hands slice 01 the resume prompt over its own commit log (#33)", () => {
      const prompt = generatorRecord("01").prompt;
      // Original contract reference.
      expect(prompt).toContain("contract.md");
      // Its own commit log with stats.
      expect(prompt).toContain("feat(#4001): committed before death");
      expect(prompt).toContain("src/work-01.ts");
      // Post-reset warning + verify-then-continue instruction.
      expect(prompt).toMatch(/anything after (your|the) last commit is gone/i);
      expect(prompt).toMatch(/typecheck/i);
      expect(prompt).toMatch(/do not re-run the full/i);
      // The half-written casualty was discarded before the generator ran.
      expect(generatorRecord("01").dirtyFilePresent).toBe(false);
    });

    it("refreshes slice 01's base from the advanced feature branch (#35)", () => {
      const prompt = generatorRecord("01").prompt;
      expect(generatorRecord("01").featureFilePresent).toBe(true);
      expect(prompt).toMatch(/feature branch .*was merged in/i);
      // The commit log stays the slice's OWN work — the sibling commit
      // merged during refresh must not appear as the generator's history.
      expect(prompt).not.toContain("sibling slice merged while dead");
    });

    it("splices slice 01's fresh handoff and the reconciliation rules in (#38)", () => {
      const prompt = generatorRecord("01").prompt;
      // The worktree really holds a migration-prefix collision (its own
      // 125_* plus the sibling's 125_* merged in), and the prompt names
      // the renumber rule (#38 AC4).
      expect(generatorRecord("01").migrationCollisionPresent).toBe(true);
      expect(prompt).toContain("Checkpoint: behavior A done, starting behavior B.");
      expect(prompt).toContain("the current tree wins over the contract");
      expect(prompt).toContain("renumber yours to the next free prefix");
    });

    it("falls back to a restart when slice 02's feature merge conflicts (#35)", () => {
      // No agent resolves merges it has no context for.
      expect(rolesFor("02")).toContain("explorer");
      expect(rolesFor("02")).toContain("planner");
      expect(generatorRecord("02").prompt).toContain("Implement the locked contract");
      expect(logFor("4002")).toMatch(/restarting from base \(feature merge conflict\)/);
    });

    it("restarts slice 03 because the operator named it in --force-restart (#37)", () => {
      // Resumable on its own merits — the flag is the only reason.
      expect(rolesFor("03")).toContain("explorer");
      expect(generatorRecord("03").prompt).toContain("Implement the locked contract");
      expect(logFor("4003")).toMatch(/restarting from base \(--force-restart\)/);
    });

    it("restarts slice 04 because its branch has no commits beyond base", () => {
      expect(rolesFor("04")).toContain("explorer");
      expect(rolesFor("04")).toContain("planner");
      const prompt = generatorRecord("04").prompt;
      expect(prompt).toContain("Implement the locked contract");
      expect(prompt).not.toContain("Verify, then continue");
      expect(logFor("4004")).toMatch(/restarting from base \(no commits beyond base\)/);
    });

    it("lands the surviving work of both of slice 01's lives, and no casualty", () => {
      const tracked = git(repo, ["ls-tree", "-r", "--name-only", `feat-stub/${slug}`]);
      expect(tracked).toContain("src/work-01.ts");
      expect(tracked).toContain("src/finish.ts");
      expect(tracked).not.toContain("src/half-written.ts");
      // The renumbered migration, not the colliding prefix.
      expect(tracked).toContain("supabase/migrations/126_slice_work.sql");
      // And nothing from the discarded lives of the restarted slices.
      expect(tracked).not.toContain("src/work-03.ts");
    });
  });

  /**
   * STUCK re-entry, both halves of it. `--resume-stuck` is a per-slice
   * opt-in (#49) and its absence is the #36 rule: a stuck.md is a
   * terminal diagnosis that restarts from base however many commits sit
   * ahead. The two outcomes differ only by whether the operator named
   * the slice, so one pair of runs carries both — two slices go STUCK,
   * then the retry names slice 01 and leaves slice 02 out. That the flag
   * discriminates *within a single invocation* is stronger evidence than
   * two separate runs could give.
   */
  describe("STUCK re-entry, named and unnamed in --resume-stuck (#36, #49)", () => {
    const slug = "resume-stuck-scope";
    const named: Slice = {
      number: "01", ghIssue: "4001", title: "Named",
      type: "AFK", blockedBy: [], userStories: "",
    };
    const unnamed: Slice = {
      number: "02", ghIssue: "4002", title: "Unnamed",
      type: "AFK", blockedBy: [], userStories: "",
    };
    const namedBranch = `afk-stub/${slug}-slice-01-named`;
    const records: PromptRecord[] = [];
    let repo: string;
    let statePath: string;
    let stuckTip: string;
    /** State after run 1, captured before run 2 overwrote it. */
    let stuckPhases: Record<string, string>;

    const generatorRecord = (sliceNumber: string): PromptRecord =>
      records.find((r) => r.role === "generator" && r.sliceNumber === sliceNumber)!;

    beforeAll(async () => {
      repo = makeRepo({ lifetime: "describe" });
      const { prdDir, specsDir } = writePrdFixture(repo, slug);
      statePath = join(repo, ".afk", "state", `${slug}-stub.json`);
      const runConfig = { repoRoot: repo, prdSlug: slug, prdDir, specsDir };
      const dag = buildDAG([named, unnamed]);
      const ghIssueOf = (n: string) => (n === "01" ? named.ghIssue : unnamed.ghIssue);

      // --- Run 1: both generators commit work every round but QA always
      // fails — each slice ends STUCK with a generator-stuck stuck.md.
      // On its LAST round the named slice also leaves an uncommitted
      // in-flight edit that nothing afterwards commits: run 2 must still
      // see it, which is what "the preserved tree is not reset" means.
      const rounds = new Map<string, number>();
      await runPipeline({
        ...runConfig,
        dag,
        provider: buildProvider({
          qaVerdict: "FAIL",
          generator: (cwd, _options, sliceNumber) => {
            const round = (rounds.get(sliceNumber) ?? 0) + 1;
            rounds.set(sliceNumber, round);
            mkdirSync(join(cwd, "src"), { recursive: true });
            writeFileSync(
              join(cwd, "src", `round-${round}.ts`),
              `export const r = ${round};\n`,
              "utf-8",
            );
            git(cwd, ["add", "-A"]);
            git(cwd, [
              "commit",
              "-m",
              `feat(#${ghIssueOf(sliceNumber)}): round ${round}`,
            ]);
            if (sliceNumber === "01" && round === 3) {
              writeFileSync(
                join(cwd, "src", "in-flight.ts"),
                "export const inFlight =",
                "utf-8",
              );
            }
          },
        }),
      });

      const afterRun1 = JSON.parse(readFileSync(statePath, "utf-8"));
      stuckPhases = {
        "4001": afterRun1.slices["4001"].phase,
        "4002": afterRun1.slices["4002"].phase,
      };
      stuckTip = git(repo, ["rev-parse", namedBranch]);

      // --- Run 2: the operator read slice 01's diagnosis and granted it
      // one more attempt on the same tree. Slice 02 they left alone. QA
      // now passes for both.
      await runPipeline({
        ...runConfig,
        dag,
        resumeStuck: ["01"],
        provider: buildProvider({
          records,
          generator: (cwd, _options, sliceNumber) => {
            if (sliceNumber === "01") {
              // Resumed onto the preserved tree: finish the in-flight edit.
              writeFileSync(
                join(cwd, "src", "in-flight.ts"),
                "export const inFlight = 1;\n",
                "utf-8",
              );
              writeFileSync(
                join(cwd, "src", "cleared.ts"),
                "export const cleared = 1;\n",
                "utf-8",
              );
              git(cwd, ["add", "-A"]);
              git(cwd, ["commit", "-m", "feat(#4001): cleared the stuck findings"]);
              return;
            }
            // Restarted from base: nothing from the STUCK life is here.
            mkdirSync(join(cwd, "src"), { recursive: true });
            writeFileSync(
              join(cwd, "src", "fresh.ts"),
              "export const fresh = 1;\n",
              "utf-8",
            );
            git(cwd, ["add", "-A"]);
            git(cwd, ["commit", "-m", "feat(#4002): fresh after stuck"]);
          },
        }),
      });
    }, 240_000);

    afterAll(() => {
      try {
        rmSync(repo, { recursive: true, force: true });
      } catch {
        // best effort
      }
    });

    it("drives both slices to STUCK in the first run", () => {
      expect(stuckPhases).toEqual({ "4001": "STUCK", "4002": "STUCK" });
    });

    it("resumes the named slice without renegotiating its locked contract", () => {
      const roles = records.filter((r) => r.sliceNumber === "01").map((r) => r.role);
      expect(roles).not.toContain("explorer");
      expect(roles).not.toContain("planner");
    });

    it("hands the named slice the STUCK-resume prompt, not the #33 one", () => {
      const prompt = generatorRecord("01").prompt;
      expect(prompt).toContain("Your worktree was not touched.");
      expect(prompt).not.toMatch(/anything after your last commit is gone/i);
      // Its own commit log across all three dead rounds.
      expect(prompt).toContain("feat(#4001): round 1");
      expect(prompt).toContain("feat(#4001): round 3");
      // The preserved diagnosis rode into the prompt.
      expect(prompt).toMatch(/declared STUCK/i);
    });

    it("leaves the named slice's uncommitted edit and stuck.md untouched", () => {
      expect(generatorRecord("01").inFlightPresent).toBe(true);
      expect(generatorRecord("01").stuckFilePresent).toBe(true);
      // Every commit from the STUCK life is still an ancestor — nothing
      // was reset away, and the branch was never recreated from base.
      expect(git(repo, ["merge-base", "--is-ancestor", stuckTip, namedBranch])).toBe("");
    });

    it("records the named slice's resume distinctly from an ordinary one", () => {
      const state = JSON.parse(readFileSync(statePath, "utf-8"));
      expect(state.slices["4001"].phase).toBe("PASS");
      expect(state.resume["4001"].attempts).toBe(1);
      expect(state.resume["4001"].lastDecision).toMatch(/--resume-stuck/);
    });

    it("audits the named slice's resume and never logs a restart for it", () => {
      const logs = sliceLogLines(repo, `${slug}-stub`, "4001");
      expect(logs).toMatch(/resuming STUCK slice from 3 commit\(s\)/);
      expect(logs).toMatch(/tree not reset, diagnosis preserved/);
      expect(logs).not.toMatch(/restarting from base \(stuck\.md present/);
    });

    it("restarts the unnamed slice from base on its terminal diagnosis", () => {
      const roles = records.filter((r) => r.sliceNumber === "02").map((r) => r.role);
      expect(roles).toContain("explorer");
      expect(roles).toContain("planner");
      expect(sliceLogLines(repo, `${slug}-stub`, "4002")).toMatch(
        /restarting from base \(stuck\.md present \(terminal diagnosis\)\)/,
      );
      const state = JSON.parse(readFileSync(statePath, "utf-8"));
      expect(state.slices["4002"].phase).toBe("PASS");
    });

    it("lands both slices' surviving work on the feature branch", () => {
      const tracked = git(repo, ["ls-tree", "-r", "--name-only", `feat-stub/${slug}`]);
      // The named slice kept its STUCK-life commits and the finished edit.
      for (const file of ["round-1.ts", "round-3.ts", "cleared.ts", "in-flight.ts"]) {
        expect(tracked).toContain(`src/${file}`);
      }
      // The unnamed slice contributed only its post-restart work.
      expect(tracked).toContain("src/fresh.ts");
    });
  });

  it("caps resumes at 2: die-resume-die-resume-die-restart (#36)", async () => {
    const repo = makeRepo();
    const slug = "resume-cap";
    const { prdDir, specsDir } = writePrdFixture(repo, slug);
    const slice = makeSlice();
    const statePath = join(repo, ".afk", "state", `${slug}-stub.json`);
    const runConfig = { repoRoot: repo, prdSlug: slug, prdDir, specsDir };

    let death = 0;
    const dyingProvider = buildProvider({
      generator: (cwd) => {
        death++;
        mkdirSync(join(cwd, "src"), { recursive: true });
        writeFileSync(join(cwd, "src", `death-${death}.ts`), `export const d = ${death};\n`, "utf-8");
        git(cwd, ["add", "-A"]);
        git(cwd, ["commit", "-m", `feat(#4001): work before death ${death}`]);
        throw new Error(`death #${death}`);
      },
    });

    // Run 1: first death — no resume yet (fresh worktree).
    await runPipeline({ ...runConfig, dag: buildDAG([slice]), provider: dyingProvider });
    expect(JSON.parse(readFileSync(statePath, "utf-8")).resume?.["4001"]).toBeUndefined();

    // Run 2: resume #1, dies again. Counter survives the launcher restart.
    await runPipeline({ ...runConfig, dag: buildDAG([slice]), provider: dyingProvider });
    expect(JSON.parse(readFileSync(statePath, "utf-8")).resume["4001"].attempts).toBe(1);

    // Run 3: resume #2, dies again.
    await runPipeline({ ...runConfig, dag: buildDAG([slice]), provider: dyingProvider });
    expect(JSON.parse(readFileSync(statePath, "utf-8")).resume["4001"].attempts).toBe(2);

    // Run 4: cap reached — deliberate restart from base (counter resets
    // for the fresh tree), full renegotiation, then PASS.
    const records: PromptRecord[] = [];
    const succeedingProvider = buildProvider({
      records,
      generator: (cwd) => {
        mkdirSync(join(cwd, "src"), { recursive: true });
        writeFileSync(join(cwd, "src", "healthy.ts"), "export const ok = 1;\n", "utf-8");
        git(cwd, ["add", "-A"]);
        git(cwd, ["commit", "-m", "feat(#4001): healthy restart"]);
      },
    });
    await runPipeline({ ...runConfig, dag: buildDAG([slice]), provider: succeedingProvider });

    expect(records.map((r) => r.role)).toContain("explorer");
    expect(allRunLogs(repo, `${slug}-stub`)).toMatch(
      /restarting from base \(resume attempt cap \(2\) reached\)/,
    );
    const finalState = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(finalState.slices["4001"].phase).toBe("PASS");
    expect(finalState.resume["4001"].attempts).toBe(0);
  }, 240_000);

});


/**
 * Cheaper checks at the worktree-preparation seam: `prepareSliceWorktree`
 * is the exported orchestrator unit that inspects git state, decides,
 * and mutates the worktree. No agent invocations needed.
 */
describe("prepareSliceWorktree", () => {
  const stubProvider: AgentProvider = {
    name: "stub",
    invoke: async () => ({ exitCode: 0, stdout: "", stats: {} }),
  };

  function makeCtx(
    repo: string,
    slug: string,
    slice: Slice,
    flags: { forceRestart?: string[]; resumeStuck?: string[] } = {},
  ) {
    return makeSliceContext(
      {
        repoRoot: repo,
        prdSlug: slug,
        prdDir: join(repo, ".kiro", "specs", slug),
        specsDir: join(".kiro", "specs", slug),
        dag: buildDAG([slice]),
        provider: stubProvider,
        ...(flags.forceRestart ? { forceRestart: flags.forceRestart } : {}),
        ...(flags.resumeStuck ? { resumeStuck: flags.resumeStuck } : {}),
      },
      slice,
      new Logger(repo, `${slug}-stub`),
      `feat-stub/${slug}`,
      "- README.md",
      "pnpm test",
    );
  }

  function sliceAt(number: string, ghIssue: string): Slice {
    return { number, ghIssue, title: `S${number}`, type: "AFK", blockedBy: [], userStories: "" };
  }

  /** Create the feature branch, the slice worktree, and one commit in it. */
  function seedResumableSlice(repo: string, ctx: ReturnType<typeof makeCtx>) {
    git(repo, ["branch", ctx.featBranch]);
    execFileSync("git", ["worktree", "add", "-b", ctx.branch, ctx.worktreeDir, ctx.featBranch], {
      cwd: repo, encoding: "utf-8",
    });
    mkdirSync(join(ctx.worktreeDir, "src"), { recursive: true });
    writeFileSync(join(ctx.worktreeDir, "src", `work-${ctx.slice.number}.ts`), "export {};\n", "utf-8");
    git(ctx.worktreeDir, ["add", "-A"]);
    git(ctx.worktreeDir, ["commit", "-m", `feat(#${ctx.slice.ghIssue}): work`]);
  }

  it("a feature branch that has not moved is a no-op refresh and still resumes (#35)", async () => {
    const repo = makeRepo();
    const ctx = makeCtx(repo, "noop-refresh", sliceAt("01", "4001"));
    seedResumableSlice(repo, ctx);
    const tipBefore = git(ctx.worktreeDir, ["rev-parse", "HEAD"]);

    await prepareSliceWorktree(ctx);

    // Resumed — and the no-op merge added no commit.
    expect(ctx.resume).toBeDefined();
    expect(ctx.resume!.commitsAhead).toBe(1);
    expect(git(ctx.worktreeDir, ["rev-parse", "HEAD"])).toBe(tipBefore);
  }, 240_000);

  it("multiple slices forced in one invocation restart; unnamed slices resume normally (#37)", async () => {
    const repo = makeRepo();
    const slug = "multi-force";
    const forced = ["01", "4003"]; // slice 01 by number, slice 03 by GH issue
    const contexts = [
      makeCtx(repo, slug, sliceAt("01", "4001"), { forceRestart: forced }),
      makeCtx(repo, slug, sliceAt("02", "4002"), { forceRestart: forced }),
      makeCtx(repo, slug, sliceAt("03", "4003"), { forceRestart: forced }),
    ];
    git(repo, ["branch", contexts[0]!.featBranch]);
    for (const ctx of contexts) {
      execFileSync("git", ["worktree", "add", "-b", ctx.branch, ctx.worktreeDir, ctx.featBranch], {
        cwd: repo, encoding: "utf-8",
      });
      mkdirSync(join(ctx.worktreeDir, "src"), { recursive: true });
      writeFileSync(join(ctx.worktreeDir, "src", `work-${ctx.slice.number}.ts`), "export {};\n", "utf-8");
      git(ctx.worktreeDir, ["add", "-A"]);
      git(ctx.worktreeDir, ["commit", "-m", `feat(#${ctx.slice.ghIssue}): work`]);
    }

    for (const ctx of contexts) await prepareSliceWorktree(ctx);

    expect(contexts[0]!.resume).toBeUndefined(); // forced by slice number
    expect(contexts[1]!.resume).toBeDefined(); // unnamed — resumes
    expect(contexts[2]!.resume).toBeUndefined(); // forced by GH issue id
    // Forced slices really went back to base.
    expect(git(repo, ["rev-parse", contexts[0]!.branch])).toBe(
      git(repo, ["rev-parse", contexts[0]!.featBranch]),
    );
  }, 240_000);

  /**
   * Mark a seeded slice STUCK the way the pipeline does — a stuck.md in
   * the slice artifact dir — and leave an uncommitted edit behind.
   */
  function markStuckWithDirtyTree(ctx: ReturnType<typeof makeCtx>) {
    mkdirSync(ctx.absSliceDir, { recursive: true });
    writeFileSync(join(ctx.absSliceDir, "stuck.md"), "# Stuck Handoff\nFinding 1.\n", "utf-8");
    writeFileSync(join(ctx.worktreeDir, "src", "in-flight.ts"), "export const x =", "utf-8");
  }

  it("--resume-stuck keeps the preserved tip, the dirty tree, and stuck.md (#49)", async () => {
    const repo = makeRepo();
    const ctx = makeCtx(repo, "stuck-optin", sliceAt("20", "49"), { resumeStuck: ["49"] });
    seedResumableSlice(repo, ctx);
    markStuckWithDirtyTree(ctx);
    const tipBefore = git(ctx.worktreeDir, ["rev-parse", "HEAD"]);

    await prepareSliceWorktree(ctx);

    expect(ctx.resume).toEqual({
      mode: "stuck",
      commitsAhead: 1,
      commitLog: expect.stringContaining("work"),
      handoffNote: "",
      stuckNote: expect.stringContaining("Finding 1."),
      baseRefreshed: true,
    });
    // Nothing was reset, cleaned, or recreated.
    expect(git(ctx.worktreeDir, ["rev-parse", "HEAD"])).toBe(tipBefore);
    expect(existsSync(join(ctx.worktreeDir, "src", "in-flight.ts"))).toBe(true);
    expect(existsSync(join(ctx.absSliceDir, "stuck.md"))).toBe(true);
  }, 240_000);

  it("--resume-stuck on an unnamed slice leaves the terminal restart alone (#49)", async () => {
    const repo = makeRepo();
    const ctx = makeCtx(repo, "stuck-unnamed", sliceAt("20", "49"), { resumeStuck: ["21"] });
    seedResumableSlice(repo, ctx);
    markStuckWithDirtyTree(ctx);

    await prepareSliceWorktree(ctx);

    expect(ctx.resume).toBeUndefined();
    expect(git(repo, ["rev-parse", ctx.branch])).toBe(
      git(repo, ["rev-parse", ctx.featBranch]),
    );
  }, 240_000);

  it("--force-restart beats --resume-stuck on the same slice (#49)", async () => {
    const repo = makeRepo();
    const ctx = makeCtx(repo, "stuck-contested", sliceAt("20", "49"), {
      forceRestart: ["20"],
      resumeStuck: ["49"],
    });
    seedResumableSlice(repo, ctx);
    markStuckWithDirtyTree(ctx);

    await prepareSliceWorktree(ctx);

    expect(ctx.resume).toBeUndefined();
    expect(git(repo, ["rev-parse", ctx.branch])).toBe(
      git(repo, ["rev-parse", ctx.featBranch]),
    );
  }, 240_000);
});

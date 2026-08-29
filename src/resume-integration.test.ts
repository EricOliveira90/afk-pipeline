/**
 * Retry integration for the resume-a-dead-slice feature (spec #33,
 * design note on #15), at the outermost seam: two `runPipeline` runs
 * against the same real repo. Run 1's generator dies mid-slice; run 2
 * retries. Assertions are external behavior only — worktree/branch
 * state, prompt inputs at the prompt-assembly seam, run.log lines —
 * never internal call sequences.
 *
 * The `prepareSliceWorktree` block lives in `resume-worktree.test.ts`;
 * two files exist so one `vitest run` schedules the suite across both
 * workers (`maxWorkers: 2`) instead of pinning it to one. Shared
 * helpers are in `resume-integration.fixtures.ts`. When adding a
 * `describe`, keep the halves balanced by measured block time
 * (`--reporter=./scripts/describe-times.reporter.mjs`), not test count.
 */
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
import {
  allRunLogs,
  buildProvider,
  cleanupResumeTempDirs,
  findSliceArtifactDir,
  git,
  makeRepo,
  makeSlice,
  sliceLogLines,
  sliceNumberFromCwd,
  writePrdFixture,
  type PromptRecord,
} from "./resume-integration.fixtures.js";

afterEach(() => {
  cleanupResumeTempDirs();
});

describe("retried slice resume (spec #33)", () => {
  /**
   * One death, four verdicts. Every slice here dies mid-run with the
   * launcher seeing ERROR; what separates them is what the retry is
   * allowed to keep — a clean resume (#33/#35/#38), the conflict
   * refusal (#35 + #113), the operator's `--force-restart` (#37), and a
   * branch with nothing on it. They share the fixture and the pair of runs
   * because the *decision* is per slice: one invocation makes four
   * different calls, which is what the retry logic claims to do.
   */
  describe("what a retry keeps after a mid-slice death (#33, #35, #37, #38)", () => {
    const slug = "resume-deaths";
    const slice = (number: string, ghIssue: string, title: string): Slice => ({
      number, ghIssue, title, type: "AFK", blockedBy: [], userStories: "",
    });
    /**
     * 01 resumes, 02 hits the conflict refusal, 03 is forced, 04 has no
     * commits, and 05 resumes after completing its first QA round.
     */
    const slices = [
      slice("01", "4001", "Resumable"),
      slice("02", "4002", "Conflicting"),
      slice("03", "4003", "Forced"),
      slice("04", "4004", "Empty"),
      slice("05", "4005", "QA resume"),
    ];
    const records: PromptRecord[] = [];
    let repo: string;
    let statePath: string;
    /** State after run 1, before run 2 overwrote it. */
    let deathPhases: Record<string, string>;
    let resumedQAAttempts = 0;

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
          qaResult: (sliceNumber) =>
            sliceNumber === "05"
              ? { verdict: "FAIL", findingState: "OPEN" }
              : undefined,
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
            if (sliceNumber === "05") {
              const path = join(cwd, "src", "work-05.ts");
              if (!existsSync(path)) {
                writeFileSync(path, "export const firstRound = 1;\n", "utf-8");
                git(cwd, ["add", "src/work-05.ts"]);
                git(cwd, ["commit", "-m", "feat(#4005): complete QA round one"]);
                return;
              }
              throw new Error("killed during generator round two");
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
          qaResult: (sliceNumber) =>
            sliceNumber === "05"
              ? ++resumedQAAttempts === 1
                ? {
                    verdict: "FAIL",
                    findingState: "RESOLVED",
                    additionalFindingState: "OPEN",
                    error: "provider disconnected after canonical output",
                  }
                : {
                    verdict: "PASS",
                    additionalFindingState: "RESOLVED",
                  }
              : undefined,
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
            if (sliceNumber === "05") {
              writeFileSync(
                join(cwd, "src", "finish-05.ts"),
                "export const resumed = 1;\n",
                "utf-8",
              );
              git(cwd, ["add", "src/finish-05.ts"]);
              git(cwd, ["commit", "-m", "feat(#4005): finish after QA resume"]);
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
        "4001": "ERROR",
        "4002": "ERROR",
        "4003": "ERROR",
        "4004": "ERROR",
        "4005": "ERROR",
      });
    });

    it("every retried slice reaches PASS, except the one the retry refuses", () => {
      const state = JSON.parse(readFileSync(statePath, "utf-8"));
      for (const s of slices) {
        // Slice 02's commits conflict with the advanced feature branch, so
        // the retry refuses it rather than restarting over them (#113).
        expect(state.slices[s.ghIssue].phase).toBe(
          s.ghIssue === "4002" ? "ERROR" : "PASS",
        );
      }
    });

    /**
     * Bounds visibility (wave item 14). Riding this fixture rather than
     * spawning: it is the only scenario that already dispatches the same
     * slices twice with a resume, a restart and a refusal between the
     * runs, which is exactly what makes the reported numbers move.
     */
    it("reports each dispatch's remaining budgets once, in the numbers that dispatch runs on", () => {
      const boundsFor = (ghIssue: string) =>
        logFor(ghIssue)
          .split(/\r?\n/)
          .filter((line) => line.includes("bounds:"))
          .map((line) => line.slice(line.indexOf("bounds:")));

      // One line per dispatch: run 1 dispatched everything fresh, run 2
      // re-dispatched everything it did not refuse.
      expect(boundsFor("4001")).toEqual([
        "bounds: 2/2 resume attempts left · 3/3 implementation rounds left · " +
          "2/2 contract rounds left · 2 infrastructure retries per invocation",
        // The resume spent one attempt; no QA round completed before the
        // death, so the implementation cap is untouched.
        "bounds: 1/2 resume attempts left · 3/3 implementation rounds left · " +
          "2/2 contract rounds left · 2 infrastructure retries per invocation",
      ]);
      // Slice 05 completed a QA round in run 1, so its resume is charged
      // for it against the global cap (ADR 0014).
      expect(boundsFor("4005")[1]).toBe(
        "bounds: 1/2 resume attempts left · 2/3 implementation rounds left · " +
          "2/2 contract rounds left · 2 infrastructure retries per invocation",
      );
      // A from-base restart earns a fresh resume budget (#36), so the
      // forced slice 03 and the empty slice 04 report full headroom again.
      expect(boundsFor("4003")[1]).toContain("2/2 resume attempts left");
      expect(boundsFor("4004")[1]).toContain("2/2 resume attempts left");
      // Slice 02's retry was refused before any agent ran — a dispatch
      // that never happened reports no bounds.
      expect(boundsFor("4002")).toHaveLength(1);
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

    it("continues QA lifecycle and evidence numbering after an ordinary resume", () => {
      const generatorPrompt = generatorRecord("05").prompt;
      expect(generatorPrompt).toContain("QA-01");
      expect(generatorPrompt).toContain("Fixture implementation finding");
      expect(generatorPrompt).toContain(
        "The fixture evaluator observes the behavior passing",
      );
      expect(generatorPrompt).toContain("qa-review-r1-a1.json");
      expect(generatorPrompt).toContain("qa-report-r1-a1.md");

      const evaluatorPrompts = records.filter(
        (record) =>
          record.role === "evaluator-qa" && record.sliceNumber === "05",
      ).map((record) => record.prompt);
      expect(evaluatorPrompts[0]).toContain("QA-01");
      expect(evaluatorPrompts[0]).toContain("qa-review-r1-a1.json");
      expect(evaluatorPrompts[0]).toContain("qa-report-r1-a1.md");
      expect(evaluatorPrompts[1]).toContain("QA-02");
      expect(evaluatorPrompts[1]).toContain(
        "Fresh fixture implementation finding",
      );
      expect(evaluatorPrompts[1]).toContain("qa-review-r2-a1.json");
      expect(evaluatorPrompts[1]).toContain("qa-report-r2-a1.md");

      const reviewDir = join(
        repo,
        ".afk",
        "artifacts",
        `${slug}-stub`,
        "slice-05",
        "reviews",
      );
      expect(existsSync(join(reviewDir, "qa-review-r1-a1.json"))).toBe(true);
      expect(existsSync(join(reviewDir, "qa-review-r1-a1-record.json"))).toBe(
        true,
      );
      expect(existsSync(join(reviewDir, "qa-review-r2-a1.json"))).toBe(true);
      const failedAttemptRecord = JSON.parse(
        readFileSync(
          join(reviewDir, "qa-review-r2-a1-record.json"),
          "utf-8",
        ),
      );
      expect(failedAttemptRecord).toMatchObject({
        round: 2,
        attempt: 1,
        verdict: "FAIL",
        findings: [
          { id: "QA-01", state: "RESOLVED", unresolved: false },
          { id: "QA-02", state: "OPEN", unresolved: true },
        ],
      });
      const resumedRecord = JSON.parse(
        readFileSync(
          join(reviewDir, "qa-review-r2-a2-record.json"),
          "utf-8",
        ),
      );
      expect(resumedRecord).toMatchObject({
        round: 2,
        attempt: 2,
        verdict: "PASS",
        findings: [
          { id: "QA-02", state: "RESOLVED", unresolved: false },
        ],
      });
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

    it("refuses slice 02 when its feature merge conflicts, keeping the commits (#35, #113)", () => {
      // No agent resolves merges it has no context for — and the old
      // fallback's from-base restart threw away exactly the commits that
      // conflicted. The slice never starts, and its branch is untouched.
      expect(rolesFor("02")).toEqual([]);
      expect(logFor("4002")).toMatch(/refusing to restart .* \(feature merge conflict\)/);
      expect(logFor("4002")).toMatch(/1 unmerged commit\(s\)/);
      expect(git(repo, ["log", "-1", "--format=%s", `afk-stub/${slug}-slice-02-conflicting`]))
        .toBe("feat(#4002): slice edit");
      // The refusal, not a generic internal error, is what the next
      // operator reads as the slice's outcome.
      const state = JSON.parse(readFileSync(statePath, "utf-8"));
      expect(state.slices["4002"].error).toMatch(/refusing to restart/);
      expect(state.slices["4002"].error).toMatch(/--force-restart 4002/);
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
      expect(tracked).toContain("src/work-05.ts");
      expect(tracked).toContain("src/finish-05.ts");
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
   * terminal diagnosis, so the slice is not resumed. Terminal does not
   * mean destroyed — with commits ahead the unnamed slice refuses rather
   * than restarting over them (#113). The two outcomes differ only by
   * whether the operator named
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
    const failing: Slice = {
      number: "03", ghIssue: "4003", title: "Still failing",
      type: "AFK", blockedBy: [], userStories: "",
    };
    const priorAdditionalArtifact = ".afk/gates/s03/ROUND-3-GATE.json";
    const namedBranch = `afk-stub/${slug}-slice-01-named`;
    const firstRunRecords: PromptRecord[] = [];
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
      const dag = buildDAG([named, unnamed, failing]);
      const ghIssueOf = (n: string) =>
        n === "01" ? named.ghIssue : n === "02" ? unnamed.ghIssue : failing.ghIssue;

      // --- Run 1: both generators commit work every round but QA always
      // fails — each slice ends STUCK with a code-assembled diagnosis.
      // On its LAST round the named slice also leaves an uncommitted
      // in-flight edit that nothing afterwards commits: run 2 must still
      // see it, which is what "the preserved tree is not reset" means.
      const rounds = new Map<string, number>();
      await runPipeline({
        ...runConfig,
        dag,
        provider: buildProvider({
          records: firstRunRecords,
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
        "4003": afterRun1.slices["4003"].phase,
      };
      stuckTip = git(repo, ["rev-parse", namedBranch]);

      const failingArtifactDir = firstRunRecords.find(
        (record) =>
          record.role === "generator" && record.sliceNumber === "03",
      )!.sliceArtifactDir;
      const failingDiagnosisPath = join(failingArtifactDir, "stuck.md");
      const failingDiagnosis = readFileSync(failingDiagnosisPath, "utf-8");
      writeFileSync(
        failingDiagnosisPath,
        failingDiagnosis.replace(
          "\n## Commit evidence",
          `- Additional artifact: \`${priorAdditionalArtifact}\`\n\n## Commit evidence`,
        ),
        "utf-8",
      );

      // --- Run 2: the operator read slice 01's diagnosis and granted it
      // one more attempt on the same tree. Slice 02 they left alone. QA
      // now passes for both.
      await runPipeline({
        ...runConfig,
        dag,
        resumeStuck: ["01", "03"],
        provider: buildProvider({
          records,
          qaResult: (sliceNumber) =>
            sliceNumber === "01"
              ? { verdict: "PASS", findingState: "RESOLVED" }
              : sliceNumber === "03"
                ? { verdict: "FAIL", findingState: "OPEN" }
                : undefined,
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
            if (sliceNumber === "03") {
              const attempt = records.filter(
                (record) =>
                  record.role === "generator" &&
                  record.sliceNumber === "03",
              ).length;
              writeFileSync(
                join(cwd, "src", `still-failing-${attempt}.ts`),
                `export const attempt = ${attempt};\n`,
                "utf-8",
              );
              git(cwd, ["add", "-A"]);
              git(cwd, [
                "commit",
                "-m",
                `feat(#4003): resumed attempt ${attempt}`,
              ]);
              return;
            }
            // The unnamed slice must never get here: its branch holds
            // three STUCK-life commits, so worktree preparation refuses
            // before any agent is dispatched (#113).
            throw new Error("slice 02 reached the generator — the refusal did not hold");
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
      expect(stuckPhases).toEqual({
        "4001": "STUCK",
        "4002": "STUCK",
        "4003": "STUCK",
      });
    });

    it("resumes the named slice without renegotiating its locked contract", () => {
      const roles = records.filter((r) => r.sliceNumber === "01").map((r) => r.role);
      expect(roles).not.toContain("explorer");
      expect(roles).not.toContain("planner");
    });

    it("hands the named slice the STUCK-resume prompt, not the #33 one", () => {
      const prompt = generatorRecord("01").prompt;
      const unresolvedFindings = prompt.match(
        /# Current unresolved findings\r?\n\r?\n([\s\S]*?)\r?\n# Reconciling the contract/,
      )?.[1];
      expect(prompt).toContain("Your worktree was not touched.");
      expect(prompt).not.toMatch(/anything after your last commit is gone/i);
      // Its own commit log across all three dead rounds.
      expect(prompt).toContain("feat(#4001): round 1");
      expect(prompt).toContain("feat(#4001): round 3");
      // The preserved diagnosis rode into the prompt.
      expect(prompt).toMatch(/declared STUCK/i);
      expect(prompt).toContain("QA-01");
      expect(prompt).toContain("Fixture implementation finding");
      expect(prompt).toContain(
        "The fixture evaluator observes the behavior passing",
      );
      expect(prompt).toContain("qa-review-r3-a1.json");
      expect(prompt).toContain("qa-report-r3-a1.md");
      expect(unresolvedFindings).toBeDefined();
      expect(unresolvedFindings).toContain("QA-01");
      expect(unresolvedFindings).toContain("Fixture implementation finding");
      expect(unresolvedFindings).toContain(
        "The fixture evaluator observes the behavior passing",
      );
      expect(unresolvedFindings).toContain("qa-review-r3-a1.json");
      expect(unresolvedFindings).toContain("qa-report-r3-a1.md");
      expect(unresolvedFindings).not.toContain("qa-review-r1-a1.json");
      expect(unresolvedFindings).not.toContain("`qa-report-r2-a1.md`");
    });

    it("continues the deterministic lifecycle in the resumed evaluator", () => {
      const prompt = records.find(
        (record) =>
          record.role === "evaluator-qa" && record.sliceNumber === "01",
      )!.prompt;
      expect(prompt).toContain("QA-01");
      expect(prompt).toContain("qa-review-r3-a1.json");
      expect(prompt).toContain("qa-report-r3-a1.md");
      expect(prompt).not.toContain("qa-review-r1-a1.json");
    });

    it("preserves prior QA evidence and archives the resumed attempt as round 4", () => {
      const reportPath = `.kiro/specs/${slug}/slices/01-named`;
      const reviewDir = join(
        repo,
        ".afk",
        "artifacts",
        `${slug}-stub`,
        "slice-01",
        "reviews",
      );
      expect(
        git(repo, [
          "show",
          `feat-stub/${slug}:${reportPath}/qa-report-r1-a1.md`,
        ]),
      ).toContain("FAIL");
      expect(
        git(repo, [
          "show",
          `feat-stub/${slug}:${reportPath}/qa-report-r4-a1.md`,
        ]),
      ).toContain("PASS");
      expect(existsSync(join(reviewDir, "qa-review-r4-a1.json"))).toBe(true);
      const resumedRecord = JSON.parse(
        readFileSync(
          join(reviewDir, "qa-review-r4-a1-record.json"),
          "utf-8",
        ),
      );
      expect(resumedRecord).toMatchObject({
        stage: "deterministic",
        round: 4,
        attempt: 1,
        verdict: "PASS",
        findings: [{ id: "QA-01", state: "RESOLVED", unresolved: false }],
      });
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

    it("grants a failing STUCK resume exactly one implementation attempt", () => {
      const failingRecords = records.filter(
        (record) => record.sliceNumber === "03",
      );
      const roles = failingRecords.map((record) => record.role);
      expect(roles.filter((role) => role === "generator")).toHaveLength(1);
      expect(roles.filter((role) => role === "evaluator-qa")).toHaveLength(1);
      expect(roles.at(-1)).toBe("evaluator-qa");

      const state = JSON.parse(readFileSync(statePath, "utf-8"));
      expect(state.slices["4003"].phase).toBe("STUCK");
      const reviewDir = join(
        repo,
        ".afk",
        "artifacts",
        `${slug}-stub`,
        "slice-03",
        "reviews",
      );
      expect(existsSync(join(reviewDir, "qa-review-r4-a1-record.json"))).toBe(
        true,
      );
      expect(existsSync(join(reviewDir, "qa-review-r5-a1-record.json"))).toBe(
        false,
      );
      const resumedGenerator = failingRecords.find(
        (record) => record.role === "generator",
      )!;
      const rewrittenDiagnosis = readFileSync(
        join(resumedGenerator.sliceArtifactDir, "stuck.md"),
        "utf-8",
      );
      expect(rewrittenDiagnosis).not.toBe(
        resumedGenerator.stuckContentsAtInvocation,
      );
      expect(resumedGenerator.stuckContentsAtInvocation).toContain(
        priorAdditionalArtifact,
      );
      expect(rewrittenDiagnosis).toContain(priorAdditionalArtifact);
      expect(rewrittenDiagnosis).toContain(
        "Round 4 attempt 1 (deterministic): FAIL / IMPLEMENTATION",
      );
      expect(rewrittenDiagnosis).toContain(
        "qa-review-r4-a1-record.json",
      );
      expect(rewrittenDiagnosis).toContain("qa-report-r4-a1.md");
      const roundEvidence = rewrittenDiagnosis
        .split("## Round evidence\n\n")[1]!
        .split("\n\n## Commit evidence")[0]!;
      expect(roundEvidence).not.toContain("(none)");
    });

    it("audits the named slice's resume and never logs a restart for it", () => {
      const logs = sliceLogLines(repo, `${slug}-stub`, "4001");
      expect(logs).toMatch(/resuming STUCK slice from 3 commit\(s\)/);
      expect(logs).toMatch(/tree not reset, diagnosis preserved/);
      expect(logs).not.toMatch(/restarting from base \(stuck\.md present/);
    });

    it("refuses the unnamed slice rather than discarding its STUCK-life commits (#113)", () => {
      // Terminal still means "not resumed" — no agent ran for it at all.
      const roles = records.filter((r) => r.sliceNumber === "02").map((r) => r.role);
      expect(roles).toEqual([]);
      const logs = sliceLogLines(repo, `${slug}-stub`, "4002");
      expect(logs).toMatch(
        /refusing to restart .* \(stuck\.md present \(terminal diagnosis\)\)/,
      );
      // Both ways out are named, and the branch still holds its 3 commits.
      expect(logs).toMatch(/--force-restart 4002/);
      expect(logs).toMatch(/--resume-stuck 4002/);
      expect(git(repo, ["rev-list", "--count", `feat-stub/${slug}..afk-stub/${slug}-slice-02-unnamed`]))
        .toBe("3");
      const state = JSON.parse(readFileSync(statePath, "utf-8"));
      expect(state.slices["4002"].phase).toBe("ERROR");
    });

    it("lands the named slice's surviving work, and nothing from the refused one", () => {
      const tracked = git(repo, ["ls-tree", "-r", "--name-only", `feat-stub/${slug}`]);
      // The named slice kept its STUCK-life commits and the finished edit.
      for (const file of ["round-1.ts", "round-3.ts", "cleared.ts", "in-flight.ts"]) {
        expect(tracked).toContain(`src/${file}`);
      }
      // The refused slice never merged — its work sits on its own branch,
      // waiting for the operator's decision rather than being gone.
      expect(tracked).not.toContain("src/fresh.ts");
    });
  });

  /**
   * The cap at the outermost seam, and the way out of it. Run 4 is the
   * PRD 1 incident in miniature: three deaths, three commits on the
   * branch, a locked contract in the worktree, and a cap that used to
   * convert into a from-base restart. It must refuse instead — and the
   * refusal has to be an impasse the operator can clear, which is what
   * run 5 proves. Run 5 is a fifth spawned `runPipeline` in one test
   * (~3s): worth it because a refusal with no verified exit would be a
   * worse defect than the one being fixed (#113).
   */
  it("caps resumes at 2: die-resume-die-resume-die-refuse, then --force-restart (#36, #113)", async () => {
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

    // Run 4: cap reached. The three deaths each committed, so the branch
    // holds work the old from-base restart would have force-reset away.
    const branch = `afk-stub/${slug}-slice-01-resumable`;
    const tipAtCap = git(repo, ["rev-parse", branch]);
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

    // Refused, not restarted: no agent ran, the tip is where it was, and
    // the counter stays spent so the next unattended run refuses again.
    expect(records).toEqual([]);
    expect(allRunLogs(repo, `${slug}-stub`)).toMatch(
      /refusing to restart .* \(resume attempt cap \(2\) reached\)/,
    );
    expect(git(repo, ["rev-parse", branch])).toBe(tipAtCap);
    const cappedState = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(cappedState.slices["4001"].phase).toBe("ERROR");
    expect(cappedState.resume["4001"].attempts).toBe(2);

    // Run 5: the operator inspects the branch, judges it disposable, and
    // says so. The restart is deliberate — and the slice's untracked
    // artifacts are archived on the way out rather than vanishing.
    await runPipeline({
      ...runConfig,
      dag: buildDAG([slice]),
      forceRestart: ["4001"],
      provider: succeedingProvider,
    });

    expect(records.map((r) => r.role)).toContain("explorer");
    expect(allRunLogs(repo, `${slug}-stub`)).toMatch(
      /restarting from base \(--force-restart\)/,
    );
    const finalState = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(finalState.slices["4001"].phase).toBe("PASS");
    expect(finalState.resume["4001"].attempts).toBe(0);
    expect(
      readFileSync(
        join(repo, ".afk", "artifacts", `${slug}-stub`, "slice-01", "pre-restart-1", "contract.md"),
        "utf-8",
      ),
    ).toContain("**Status:** LOCKED");
  }, 240_000);

});

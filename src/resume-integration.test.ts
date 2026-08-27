import { describe, it, expect, afterEach } from "vitest";
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
import { writeContractReview } from "./test-support.js";
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

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "afk-resume-int-"));
  tempDirs.push(dir);
  git(dir, ["init", "--initial-branch=main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  writeFileSync(join(dir, "README.md"), "test\n", "utf-8");
  // A behavior's gate IDs must name a baseline gate backed by a
  // discovered command, so the fixture repo needs the one sanity script
  // the derived catalog reads (`resolveSanityPlan`). Without it no
  // manifest could bind, and every negotiation here would refuse.
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "resume-fixture",
      private: true,
      scripts: { "test:run": "node -e \"process.exit(0)\"" },
    }),
    "utf-8",
  );
  git(dir, ["add", "README.md", "package.json"]);
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

interface PromptRecord {
  role: string;
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
  generator: (cwd: string, options: InvokeOptions) => Promise<void> | void;
  records?: PromptRecord[];
  /** Deterministic QA verdict for every evaluator-qa invocation. */
  qaVerdict?: "PASS" | "FAIL";
}): AgentProvider {
  return {
    name: "stub",
    async invoke(options: InvokeOptions): Promise<InvokeResult> {
      const { role, cwd } = options;
      opts.records?.push({
        role,
        prompt: options.prompt,
        dirtyFilePresent: existsSync(join(cwd, "src", "half-written.ts")),
        featureFilePresent: existsSync(join(cwd, "src", "sibling.ts")),
        migrationCollisionPresent:
          existsSync(join(cwd, "supabase", "migrations", "125_slice_work.sql")) &&
          existsSync(join(cwd, "supabase", "migrations", "125_sibling.sql")),
        inFlightPresent: existsSync(join(cwd, "src", "in-flight.ts")),
        stuckFilePresent: (() => {
          const dir = findSliceArtifactDir(cwd, "01");
          return dir !== null && existsSync(join(dir, "stuck.md"));
        })(),
      });
      const artifactDir = findSliceArtifactDir(cwd, "01");
      if (role === "explorer" && artifactDir) {
        writeFileSync(join(artifactDir, "context.md"), "# Context\n", "utf-8");
      } else if (role === "planner" && artifactDir) {
        writeFileSync(
          join(artifactDir, "contract.md"),
          "# Slice Contract\n\n**Status:** LOCKED\n\n## Files expected to change\n- src/work.ts\n",
          "utf-8",
        );
        writeFileSync(
          join(artifactDir, "acceptance-manifest.json"),
          JSON.stringify({
            version: 2,
            fileScope: { kind: "paths", paths: ["src/work.ts"] },
            migrationCount: 0,
            behaviors: [
              {
                id: "B-01",
                source: "resume fixture",
                given: "a resumable slice",
                when: "its contract is negotiated",
                then: "the behavior lock passes",
                observableResult: "the slice reaches its own assertions",
                preservation: false,
                gateIds: ["tests"],
              },
            ],
          }),
          "utf-8",
        );
      } else if (role === "evaluator-contract" && artifactDir) {
        writeFileSync(
          join(artifactDir, "feedback-r1.md"),
          "## Evaluator feedback — round 1\n\nThe contract is testable.\n",
          "utf-8",
        );
        writeContractReview(artifactDir, "ACCEPT");
      } else if (role === "generator") {
        await opts.generator(cwd, options);
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

describe("retried slice resume (spec #33)", () => {
  it("resumes from the surviving branch tip with a resume prompt after a mid-slice death", async () => {
    const repo = makeRepo();
    const slug = "resume-happy";
    const { prdDir, specsDir } = writePrdFixture(repo, slug);
    const slice = makeSlice();

    // --- Run 1: the generator commits real work, writes a handoff
    // AFTER the commit (fresher than the tree — must survive to the
    // resume prompt, #38), leaves a half-written uncommitted file,
    // then dies (throws — the launcher sees ERROR).
    const dyingProvider = buildProvider({
      generator: (cwd) => {
        mkdirSync(join(cwd, "src"), { recursive: true });
        writeFileSync(join(cwd, "src", "work.ts"), "export const done = 1;\n", "utf-8");
        // The slice claims migration prefix 125 before dying (#38 AC4).
        mkdirSync(join(cwd, "supabase", "migrations"), { recursive: true });
        writeFileSync(
          join(cwd, "supabase", "migrations", "125_slice_work.sql"),
          "select 1;\n",
          "utf-8",
        );
        git(cwd, ["add", "src/work.ts", "supabase/migrations/125_slice_work.sql"]);
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
      },
    });
    await runPipeline({
      repoRoot: repo,
      prdSlug: slug,
      prdDir,
      specsDir,
      dag: buildDAG([slice]),
      provider: dyingProvider,
    });

    const statePath = join(repo, ".afk", "state", `${slug}-stub.json`);
    expect(JSON.parse(readFileSync(statePath, "utf-8")).slices["4001"].phase).toBe("ERROR");

    // The feature branch advances after the fork — a sibling slice
    // merged while this slice was dead (#35 base refresh).
    git(repo, ["checkout", `feat-stub/${slug}`]);
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "sibling.ts"), "export const sibling = 1;\n", "utf-8");
    // A sibling slice claimed the SAME migration prefix under a
    // different filename while this slice was dead (#38 AC4).
    mkdirSync(join(repo, "supabase", "migrations"), { recursive: true });
    writeFileSync(join(repo, "supabase", "migrations", "125_sibling.sql"), "select 2;\n", "utf-8");
    git(repo, ["add", "src/sibling.ts", "supabase/migrations/125_sibling.sql"]);
    git(repo, ["commit", "-m", "feat: sibling slice merged while dead"]);
    git(repo, ["checkout", "main"]);

    // --- Run 2: retry. The slice must resume — no explorer/planner,
    // generator handed the resume prompt, dirty file cleaned.
    const records: PromptRecord[] = [];
    const resumingProvider = buildProvider({
      records,
      generator: (cwd) => {
        // Follow the prompt's migration-prefix rule: renumber to the
        // next free prefix so the slice can merge cleanly.
        git(cwd, [
          "mv",
          "supabase/migrations/125_slice_work.sql",
          "supabase/migrations/126_slice_work.sql",
        ]);
        writeFileSync(join(cwd, "src", "finish.ts"), "export const finished = 1;\n", "utf-8");
        git(cwd, ["add", "src/finish.ts"]);
        git(cwd, ["commit", "-m", "feat(#4001): finished after resume"]);
      },
    });
    await runPipeline({
      repoRoot: repo,
      prdSlug: slug,
      prdDir,
      specsDir,
      dag: buildDAG([slice]),
      provider: resumingProvider,
    });

    // Explorer and planner stay skipped — their artifacts survived.
    const roles = records.map((r) => r.role);
    expect(roles).not.toContain("explorer");
    expect(roles).not.toContain("planner");

    // Prompt-assembly seam: the generator received the resume prompt.
    const generatorRecord = records.find((r) => r.role === "generator");
    expect(generatorRecord).toBeDefined();
    const prompt = generatorRecord!.prompt;
    // Original contract reference.
    expect(prompt).toContain("contract.md");
    // Its own commit log with stats.
    expect(prompt).toContain("feat(#4001): committed before death");
    expect(prompt).toContain("src/work.ts");
    // Post-reset warning + verify-then-continue instruction.
    expect(prompt).toMatch(/anything after (your|the) last commit is gone/i);
    expect(prompt).toMatch(/typecheck/i);
    expect(prompt).toMatch(/do not re-run the full/i);

    // The half-written casualty was discarded before the generator ran.
    expect(generatorRecord!.dirtyFilePresent).toBe(false);

    // Base refresh (#35): the advanced feature branch was merged into
    // the resumed branch before the generator started, and the prompt
    // says so.
    expect(generatorRecord!.featureFilePresent).toBe(true);
    expect(prompt).toMatch(/feature branch .*was merged in/i);
    // The commit log stays the slice's OWN work — the sibling commit
    // merged during refresh must not appear as the generator's history.
    expect(prompt).not.toContain("sibling slice merged while dead");

    // #38: the fresh handoff (written after the last commit) is spliced
    // in, and the reconciliation rules are present verbatim.
    // #38 AC4: the worktree really holds a migration-prefix collision
    // (its own 125_* plus the sibling's 125_* merged in), and the
    // prompt names the renumber rule.
    expect(generatorRecord!.migrationCollisionPresent).toBe(true);
    expect(prompt).toContain("Checkpoint: behavior A done, starting behavior B.");
    expect(prompt).toContain("the current tree wins over the contract");
    expect(prompt).toContain("renumber yours to the next free prefix");

    // Committed work from BOTH lives survived onto the feature branch.
    git(repo, ["checkout", "feat-stub/" + slug]);
    expect(existsSync(join(repo, "src", "work.ts"))).toBe(true);
    expect(existsSync(join(repo, "src", "finish.ts"))).toBe(true);
    expect(existsSync(join(repo, "src", "half-written.ts"))).toBe(false);

    // The slice ends PASS, and the decision is auditable in the run log.
    expect(JSON.parse(readFileSync(statePath, "utf-8")).slices["4001"].phase).toBe("PASS");
    expect(allRunLogs(repo, `${slug}-stub`)).toMatch(/resuming from 1 commit/);
  }, 240_000);

  it("falls back to restart from base when the feature merge conflicts (#35)", async () => {
    const repo = makeRepo();
    const slug = "resume-conflict";
    const { prdDir, specsDir } = writePrdFixture(repo, slug);
    const slice = makeSlice();

    // --- Run 1: generator commits an edit to README.md, then dies.
    const dyingProvider = buildProvider({
      generator: (cwd) => {
        writeFileSync(join(cwd, "README.md"), "slice version\n", "utf-8");
        git(cwd, ["add", "README.md"]);
        git(cwd, ["commit", "-m", "feat(#4001): slice edit"]);
        throw new Error("killed after committing");
      },
    });
    await runPipeline({
      repoRoot: repo,
      prdSlug: slug,
      prdDir,
      specsDir,
      dag: buildDAG([slice]),
      provider: dyingProvider,
    });

    // The feature branch takes a CONFLICTING edit to the same file.
    git(repo, ["checkout", `feat-stub/${slug}`]);
    writeFileSync(join(repo, "README.md"), "feature version\n", "utf-8");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "feat: conflicting sibling edit"]);
    git(repo, ["checkout", "main"]);

    // --- Run 2: resume is eligible, but the refresh merge conflicts —
    // fall back to a clean restart from base (no agent resolves merges
    // it has no context for).
    const records: PromptRecord[] = [];
    const freshProvider = buildProvider({
      records,
      generator: (cwd) => {
        mkdirSync(join(cwd, "src"), { recursive: true });
        writeFileSync(join(cwd, "src", "redo.ts"), "export const redo = 1;\n", "utf-8");
        git(cwd, ["add", "src/redo.ts"]);
        git(cwd, ["commit", "-m", "feat(#4001): redone from base"]);
      },
    });
    await runPipeline({
      repoRoot: repo,
      prdSlug: slug,
      prdDir,
      specsDir,
      dag: buildDAG([slice]),
      provider: freshProvider,
    });

    // Full restart: explorer/planner re-ran, generator got the normal prompt.
    const roles = records.map((r) => r.role);
    expect(roles).toContain("explorer");
    expect(roles).toContain("planner");
    const generatorRecord = records.find((r) => r.role === "generator");
    expect(generatorRecord!.prompt).toContain("Implement the locked contract");

    const statePath = join(repo, ".afk", "state", `${slug}-stub.json`);
    expect(JSON.parse(readFileSync(statePath, "utf-8")).slices["4001"].phase).toBe("PASS");
    expect(allRunLogs(repo, `${slug}-stub`)).toMatch(
      /restarting from base \(feature merge conflict\)/,
    );
  }, 240_000);

  it("never resumes a STUCK slice with a stuck.md, even with commits ahead (#36)", async () => {
    const repo = makeRepo();
    const slug = "resume-stuck";
    const { prdDir, specsDir } = writePrdFixture(repo, slug);
    const slice = makeSlice();

    // --- Run 1: the generator commits work every round but QA always
    // fails — the slice ends STUCK and generator-stuck writes stuck.md.
    let round = 0;
    const stuckProvider = buildProvider({
      qaVerdict: "FAIL",
      generator: (cwd) => {
        round++;
        mkdirSync(join(cwd, "src"), { recursive: true });
        writeFileSync(join(cwd, "src", `round-${round}.ts`), `export const r = ${round};\n`, "utf-8");
        git(cwd, ["add", "-A"]);
        git(cwd, ["commit", "-m", `feat(#4001): round ${round}`]);
      },
    });
    await runPipeline({
      repoRoot: repo,
      prdSlug: slug,
      prdDir,
      specsDir,
      dag: buildDAG([slice]),
      provider: stuckProvider,
    });
    const statePath = join(repo, ".afk", "state", `${slug}-stub.json`);
    expect(JSON.parse(readFileSync(statePath, "utf-8")).slices["4001"].phase).toBe("STUCK");

    // --- Run 2: commits ahead exist, but the terminal diagnosis wins.
    const records: PromptRecord[] = [];
    const retryProvider = buildProvider({
      records,
      generator: (cwd) => {
        mkdirSync(join(cwd, "src"), { recursive: true });
        writeFileSync(join(cwd, "src", "fresh.ts"), "export const fresh = 1;\n", "utf-8");
        git(cwd, ["add", "-A"]);
        git(cwd, ["commit", "-m", "feat(#4001): fresh after stuck"]);
      },
    });
    await runPipeline({
      repoRoot: repo,
      prdSlug: slug,
      prdDir,
      specsDir,
      dag: buildDAG([slice]),
      provider: retryProvider,
    });

    expect(records.map((r) => r.role)).toContain("explorer");
    expect(allRunLogs(repo, `${slug}-stub`)).toMatch(
      /restarting from base \(stuck\.md present \(terminal diagnosis\)\)/,
    );
    expect(JSON.parse(readFileSync(statePath, "utf-8")).slices["4001"].phase).toBe("PASS");
  }, 240_000);

  it("resumes a STUCK slice's preserved tree when the operator opts in with --resume-stuck (#49)", async () => {
    const repo = makeRepo();
    const slug = "resume-stuck-optin";
    const { prdDir, specsDir } = writePrdFixture(repo, slug);
    const slice = makeSlice();

    // --- Run 1: the generator commits work every round but QA always
    // fails — the slice ends STUCK and generator-stuck writes stuck.md.
    // On the LAST round it also leaves an uncommitted in-flight edit
    // that nothing afterwards commits: run 2 must still see it, which is
    // what "the preserved worktree is not reset or cleaned" means.
    let round = 0;
    const stuckProvider = buildProvider({
      qaVerdict: "FAIL",
      generator: (cwd) => {
        round++;
        mkdirSync(join(cwd, "src"), { recursive: true });
        writeFileSync(join(cwd, "src", `round-${round}.ts`), `export const r = ${round};\n`, "utf-8");
        git(cwd, ["add", "-A"]);
        git(cwd, ["commit", "-m", `feat(#4001): round ${round}`]);
        if (round === 3) {
          writeFileSync(join(cwd, "src", "in-flight.ts"), "export const inFlight =", "utf-8");
        }
      },
    });
    await runPipeline({
      repoRoot: repo,
      prdSlug: slug,
      prdDir,
      specsDir,
      dag: buildDAG([slice]),
      provider: stuckProvider,
    });

    const statePath = join(repo, ".afk", "state", `${slug}-stub.json`);
    expect(JSON.parse(readFileSync(statePath, "utf-8")).slices["4001"].phase).toBe("STUCK");
    const branch = `afk-stub/${slug}-slice-01-resumable`;
    const stuckTip = git(repo, ["rev-parse", branch]);

    // --- Run 2: the operator read the diagnosis and granted one more
    // attempt on the same tree. QA now passes.
    const records: PromptRecord[] = [];
    const resumingProvider = buildProvider({
      records,
      generator: (cwd) => {
        writeFileSync(join(cwd, "src", "in-flight.ts"), "export const inFlight = 1;\n", "utf-8");
        writeFileSync(join(cwd, "src", "cleared.ts"), "export const cleared = 1;\n", "utf-8");
        git(cwd, ["add", "-A"]);
        git(cwd, ["commit", "-m", "feat(#4001): cleared the stuck findings"]);
      },
    });
    await runPipeline({
      repoRoot: repo,
      prdSlug: slug,
      prdDir,
      specsDir,
      dag: buildDAG([slice]),
      provider: resumingProvider,
      resumeStuck: ["01"],
    });

    // The locked contract survived: no renegotiation.
    const roles = records.map((r) => r.role);
    expect(roles).not.toContain("explorer");
    expect(roles).not.toContain("planner");

    const generatorRecord = records.find((r) => r.role === "generator");
    expect(generatorRecord).toBeDefined();
    const prompt = generatorRecord!.prompt;

    // Prompt-assembly seam: the STUCK-resume template, not the #33 one.
    expect(prompt).toContain("Your worktree was not touched.");
    expect(prompt).not.toMatch(/anything after your last commit is gone/i);
    // Its own commit log across all three dead rounds.
    expect(prompt).toContain("feat(#4001): round 1");
    expect(prompt).toContain("feat(#4001): round 3");
    // The preserved diagnosis rode into the prompt.
    expect(prompt).toMatch(/declared STUCK/i);

    // The tree really was preserved: the uncommitted in-flight edit and
    // the stuck.md diagnosis were both still there when the generator ran.
    expect(generatorRecord!.inFlightPresent).toBe(true);
    expect(generatorRecord!.stuckFilePresent).toBe(true);

    // Every commit from the STUCK life is still an ancestor — nothing
    // was reset away, and the branch was never recreated from base.
    expect(git(repo, ["merge-base", "--is-ancestor", stuckTip, branch])).toBe("");

    // Retry state records the decision distinctly from an ordinary resume.
    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(state.slices["4001"].phase).toBe("PASS");
    expect(state.resume["4001"].attempts).toBe(1);
    expect(state.resume["4001"].lastDecision).toMatch(/--resume-stuck/);

    // Auditable in the run log — and no restart line for this slice.
    const logs = allRunLogs(repo, `${slug}-stub`);
    expect(logs).toMatch(/resuming STUCK slice from 3 commit\(s\)/);
    expect(logs).toMatch(/tree not reset, diagnosis preserved/);
    expect(logs).not.toMatch(/restarting from base \(stuck\.md present/);

    // The work from both lives reached the feature branch.
    git(repo, ["checkout", `feat-stub/${slug}`]);
    for (const file of ["round-1.ts", "round-3.ts", "cleared.ts"]) {
      expect(existsSync(join(repo, "src", file))).toBe(true);
    }
  }, 240_000);

  it("leaves a STUCK slice the operator did NOT name restarting from base (#49)", async () => {
    const repo = makeRepo();
    const slug = "resume-stuck-unnamed";
    const { prdDir, specsDir } = writePrdFixture(repo, slug);
    const slice = makeSlice();

    let round = 0;
    const stuckProvider = buildProvider({
      qaVerdict: "FAIL",
      generator: (cwd) => {
        round++;
        mkdirSync(join(cwd, "src"), { recursive: true });
        writeFileSync(join(cwd, "src", `round-${round}.ts`), `export const r = ${round};\n`, "utf-8");
        git(cwd, ["add", "-A"]);
        git(cwd, ["commit", "-m", `feat(#4001): round ${round}`]);
      },
    });
    await runPipeline({
      repoRoot: repo, prdSlug: slug, prdDir, specsDir,
      dag: buildDAG([slice]), provider: stuckProvider,
    });

    // --- Run 2: --resume-stuck names a DIFFERENT slice. The stuck
    // slice's default terminal behavior must be untouched.
    const records: PromptRecord[] = [];
    const retryProvider = buildProvider({
      records,
      generator: (cwd) => {
        mkdirSync(join(cwd, "src"), { recursive: true });
        writeFileSync(join(cwd, "src", "fresh.ts"), "export const fresh = 1;\n", "utf-8");
        git(cwd, ["add", "-A"]);
        git(cwd, ["commit", "-m", "feat(#4001): fresh after stuck"]);
      },
    });
    await runPipeline({
      repoRoot: repo, prdSlug: slug, prdDir, specsDir,
      dag: buildDAG([slice]), provider: retryProvider,
      resumeStuck: ["02", "9999"],
    });

    expect(records.map((r) => r.role)).toContain("explorer");
    expect(allRunLogs(repo, `${slug}-stub`)).toMatch(
      /restarting from base \(stuck\.md present \(terminal diagnosis\)\)/,
    );
  }, 240_000);

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

  it("restarts an otherwise-resumable slice named in --force-restart (#37)", async () => {
    const repo = makeRepo();
    const slug = "resume-forced";
    const { prdDir, specsDir } = writePrdFixture(repo, slug);
    const slice = makeSlice();

    // --- Run 1: dies with committed work — resumable on its own merits.
    const dyingProvider = buildProvider({
      generator: (cwd) => {
        mkdirSync(join(cwd, "src"), { recursive: true });
        writeFileSync(join(cwd, "src", "work.ts"), "export const done = 1;\n", "utf-8");
        git(cwd, ["add", "-A"]);
        git(cwd, ["commit", "-m", "feat(#4001): committed before death"]);
        throw new Error("killed");
      },
    });
    await runPipeline({
      repoRoot: repo,
      prdSlug: slug,
      prdDir,
      specsDir,
      dag: buildDAG([slice]),
      provider: dyingProvider,
    });

    // --- Run 2: the operator judged the worktree bad.
    const records: PromptRecord[] = [];
    const freshProvider = buildProvider({
      records,
      generator: (cwd) => {
        mkdirSync(join(cwd, "src"), { recursive: true });
        writeFileSync(join(cwd, "src", "redo.ts"), "export const redo = 1;\n", "utf-8");
        git(cwd, ["add", "-A"]);
        git(cwd, ["commit", "-m", "feat(#4001): redone"]);
      },
    });
    await runPipeline({
      repoRoot: repo,
      prdSlug: slug,
      prdDir,
      specsDir,
      dag: buildDAG([slice]),
      provider: freshProvider,
      forceRestart: ["01"],
    });

    expect(records.map((r) => r.role)).toContain("explorer");
    const generatorRecord = records.find((r) => r.role === "generator");
    expect(generatorRecord!.prompt).toContain("Implement the locked contract");
    expect(allRunLogs(repo, `${slug}-stub`)).toMatch(
      /restarting from base \(--force-restart\)/,
    );
    const state = JSON.parse(
      readFileSync(join(repo, ".afk", "state", `${slug}-stub.json`), "utf-8"),
    );
    expect(state.slices["4001"].phase).toBe("PASS");
  }, 240_000);

  it("restarts from base when the surviving branch has zero commits beyond base", async () => {
    const repo = makeRepo();
    const slug = "resume-empty";
    const { prdDir, specsDir } = writePrdFixture(repo, slug);
    const slice = makeSlice();

    // --- Run 1: generator dies before committing anything.
    const dyingProvider = buildProvider({
      generator: () => {
        throw new Error("killed before any commit");
      },
    });
    await runPipeline({
      repoRoot: repo,
      prdSlug: slug,
      prdDir,
      specsDir,
      dag: buildDAG([slice]),
      provider: dyingProvider,
    });

    // --- Run 2: zero commits beyond base → deliberate restart.
    const records: PromptRecord[] = [];
    const freshProvider = buildProvider({
      records,
      generator: (cwd) => {
        mkdirSync(join(cwd, "src"), { recursive: true });
        writeFileSync(join(cwd, "src", "fresh.ts"), "export const fresh = 1;\n", "utf-8");
        git(cwd, ["add", "src/fresh.ts"]);
        git(cwd, ["commit", "-m", "feat(#4001): fresh start"]);
      },
    });
    await runPipeline({
      repoRoot: repo,
      prdSlug: slug,
      prdDir,
      specsDir,
      dag: buildDAG([slice]),
      provider: freshProvider,
    });

    // Full restart: explorer and planner run again, generator gets the
    // NORMAL prompt (no resume framing).
    const roles = records.map((r) => r.role);
    expect(roles).toContain("explorer");
    expect(roles).toContain("planner");
    const generatorRecord = records.find((r) => r.role === "generator");
    expect(generatorRecord!.prompt).toContain("Implement the locked contract");
    expect(generatorRecord!.prompt).not.toContain("Verify, then continue");

    const statePath = join(repo, ".afk", "state", `${slug}-stub.json`);
    expect(JSON.parse(readFileSync(statePath, "utf-8")).slices["4001"].phase).toBe("PASS");
    expect(allRunLogs(repo, `${slug}-stub`)).toMatch(
      /restarting from base \(no commits beyond base\)/,
    );
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

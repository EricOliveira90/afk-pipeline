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
import { runPipeline } from "./orchestrator.js";
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

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "afk-resume-int-"));
  tempDirs.push(dir);
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

interface PromptRecord {
  role: string;
  prompt: string;
  /** Whether run 1's uncommitted casualty file was visible at invocation time. */
  dirtyFilePresent: boolean;
  /** Whether the sibling commit that advanced the feature branch was visible. */
  featureFilePresent: boolean;
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
      } else if (role === "evaluator-contract" && artifactDir) {
        writeFileSync(
          join(artifactDir, "feedback-r1.md"),
          "## Evaluator feedback — round 1\n\n**Verdict:** ACCEPT\n",
          "utf-8",
        );
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
        git(cwd, ["add", "src/work.ts"]);
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
    git(repo, ["add", "src/sibling.ts"]);
    git(repo, ["commit", "-m", "feat: sibling slice merged while dead"]);
    git(repo, ["checkout", "main"]);

    // --- Run 2: retry. The slice must resume — no explorer/planner,
    // generator handed the resume prompt, dirty file cleaned.
    const records: PromptRecord[] = [];
    const resumingProvider = buildProvider({
      records,
      generator: (cwd) => {
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
  }, 120_000);

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
  }, 120_000);

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
  }, 180_000);

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
  }, 180_000);

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
  }, 120_000);
});

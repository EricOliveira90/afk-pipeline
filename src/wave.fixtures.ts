/**
 * Shared fixtures for the `runWave` integration suites.
 *
 * The wave tests live in two files — `wave.test.ts` and
 * `wave-migrations.test.ts` — so one `vitest run` schedules them across
 * both workers (`maxWorkers: 2`); a single file always ran on one. The
 * split is between `describe` blocks, balanced by measured block time,
 * and this module is the top-level helper section both halves used to
 * share. Not a test file itself: the `.fixtures.ts` suffix keeps it out
 * of the `src/**\/*.test.ts` include.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  statSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmDirWithRetry } from "./test-support.js";
import { buildDAG, type Slice } from "./issues-parser.js";
import { RunJournal as Logger } from "./run-journal.js";
import type {
  AgentProvider,
  InvokeOptions,
  InvokeResult,
} from "./agent-provider.js";
import { TransientProviderError } from "./agent-provider.js";
import type { PipelineConfig } from "./orchestrator.js";

const tempDirs: string[] = [];

/**
 * Removes every repo `makeRepo` created since the last call. Each test
 * file registers this in its own `afterEach` — a hook registered here at
 * module scope would depend on vitest's per-file module isolation, which
 * is one refactor away from silently not running.
 */
export function cleanupWaveTempDirs(): void {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      rmDirWithRetry(dir);
    } catch {
      // best effort
    }
  }
}

export function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

export function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "afk-wave-"));
  tempDirs.push(dir);
  git(dir, ["init", "--initial-branch=main"]);
  writeFileSync(join(dir, "README.md"), "test\n", "utf-8");
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "-m", "root"]);
  return dir;
}

export interface SliceFixture {
  files: string[];
  qaPasses: boolean;
  outputFile: string;
  outputContent: string;
  /**
   * Verdict the contract evaluator writes. Defaults to ACCEPT; ESCALATE
   * drives the "genuine verdict" negotiate failure — the evaluator lived
   * and decided, so nothing about it is an infrastructure death.
   */
  contractVerdict?: "ACCEPT" | "ESCALATE";
}

/**
 * How the fake provider should die on a role's invocation, so the wave
 * tests can drive each agent-failure cause (ADR 0025) at the same seam
 * a real provider produces it: a rejected `invoke` whose message is the
 * only record of the exit code or the kill class.
 *
 * `times` bounds how many consecutive invocations of that role die;
 * later ones behave normally, which is how an infrastructure retry is
 * observed to recover. Omit it to die every time.
 */
export interface ProviderDeath {
  role: string;
  kind: "exit" | "idle-kill" | "ceiling-kill" | "tool-cap-kill" | "transient";
  /** `kind: "exit"` only. */
  exitCode?: number;
  times?: number;
}

/**
 * Build the rejection a real provider would produce. The message shapes
 * are copied from `claude.ts` / `kiro.ts` verbatim — they are the wire
 * format the classifier reads.
 */
export function deathError(death: ProviderDeath, role: string): Error {
  switch (death.kind) {
    case "exit":
      return new Error(`Agent ${role} exited with code ${death.exitCode ?? 1}`);
    case "idle-kill":
      return new Error(`Agent ${role} idle for 600s — killed`);
    case "ceiling-kill":
      return new Error(
        `Agent ${role} exceeded 7200s wall-clock ceiling — killed`,
      );
    case "tool-cap-kill":
      return new Error(`Agent ${role} exceeded 100 tool calls — killed`);
    case "transient":
      return new TransientProviderError(
        `Agent ${role} exited with code 1 — model temporarily unavailable`,
      );
  }
}

export function findSliceArtifactDir(cwd: string, sliceNumber: string): string | null {
  const specsRoot = join(cwd, ".kiro", "specs");
  if (!existsSync(specsRoot)) return null;
  for (const slug of readdirSync(specsRoot)) {
    const slicesDir = join(specsRoot, slug, "slices");
    if (!existsSync(slicesDir)) continue;
    for (const entry of readdirSync(slicesDir)) {
      if (entry.startsWith(`${sliceNumber}-`)) {
        const full = join(slicesDir, entry);
        if (statSync(full).isDirectory()) return full;
      }
    }
  }
  return null;
}

export function sliceFromCwd(cwd: string, slices: Slice[]): Slice | null {
  const norm = cwd.replace(/\\/g, "/").toLowerCase();
  for (const s of slices) {
    const re = new RegExp(`-s${s.number}(?:$|/)`);
    if (re.test(norm)) return s;
  }
  return null;
}

export function buildStubProvider(opts: {
  fixtures: Map<string, SliceFixture>;
  slices: Slice[];
  deaths?: ProviderDeath[];
  /** `role:ghIssue` per invocation, in call order. */
  records?: string[];
}): AgentProvider {
  const { fixtures, slices, deaths = [], records } = opts;
  const generatorRounds = new Map<string, number>();
  const roleAttempts = new Map<string, number>();

  return {
    name: "stub",
    async invoke(options: InvokeOptions): Promise<InvokeResult> {
      const { role, cwd } = options;
      const slice = sliceFromCwd(cwd, slices);
      const ghIssue = slice?.ghIssue ?? "";
      const fixture = fixtures.get(ghIssue);
      records?.push(`${role}:${ghIssue}`);
      await new Promise((r) => setTimeout(r, 5));

      const attempts = (roleAttempts.get(`${role}:${ghIssue}`) ?? 0) + 1;
      roleAttempts.set(`${role}:${ghIssue}`, attempts);
      const death = deaths.find(
        (d) => d.role === role && attempts <= (d.times ?? Infinity),
      );
      if (death) {
        // Real providers tee stdout into the agent log before dying, and
        // that tail is what the failure reason must carry.
        options.logStream?.write(
          `stub ${role} output line\nabout to die: ${death.kind}\n`,
        );
        throw deathError(death, role);
      }

      const sliceArtifactDir = slice
        ? findSliceArtifactDir(cwd, slice.number)
        : null;

      if (role === "explorer" && sliceArtifactDir) {
        writeFileSync(
          join(sliceArtifactDir, "context.md"),
          `# Context for ${ghIssue}\n`,
          "utf-8",
        );
      } else if (role === "planner" && sliceArtifactDir && fixture) {
        const filesBlock = fixture.files.map((f) => `- ${f}`).join("\n");
        // The planner leaves the contract in DRAFT: the orchestrator owns
        // the LOCKED transition (ADR 0008), and a planner that pre-locked
        // it would hide the round loop from any test that re-enters
        // negotiation on a contract already on disk.
        writeFileSync(
          join(sliceArtifactDir, "contract.md"),
          `# Slice Contract\n\n**Status:** DRAFT\n\n## Files expected to change\n${filesBlock}\n`,
          "utf-8",
        );
      } else if (role === "evaluator-contract" && sliceArtifactDir) {
        const verdict = fixture?.contractVerdict ?? "ACCEPT";
        writeFileSync(
          join(sliceArtifactDir, "feedback-r1.md"),
          `## Evaluator feedback — round 1\n\n**Verdict:** ${verdict}\n`,
          "utf-8",
        );
      } else if (role === "generator" && sliceArtifactDir && fixture) {
        const round = (generatorRounds.get(ghIssue) ?? 0) + 1;
        generatorRounds.set(ghIssue, round);
        const outPath = join(cwd, fixture.outputFile);
        mkdirSync(join(outPath, ".."), { recursive: true });
        writeFileSync(
          outPath,
          `${fixture.outputContent}\n// round ${round}\n`,
          "utf-8",
        );
      } else if (role === "evaluator-qa" && sliceArtifactDir && fixture) {
        const verdict = fixture.qaPasses ? "PASS" : "FAIL";
        writeFileSync(
          join(sliceArtifactDir, "qa-report.md"),
          `# QA Report\n\n**Verdict:** ${verdict}\n`,
          "utf-8",
        );
      } else if (role === "generator-stuck" && sliceArtifactDir) {
        writeFileSync(
          join(sliceArtifactDir, "stuck.md"),
          "# Stuck\n",
          "utf-8",
        );
      }

      return { exitCode: 0, stdout: "", stats: {} };
    },
  };
}

export function setupWave(
  repo: string,
  slug: string,
  slices: Slice[],
  fixtures: Map<string, SliceFixture>,
  opts?: { signal?: AbortSignal; deaths?: ProviderDeath[] },
) {
  const specsDir = join(".kiro", "specs", slug);
  const prdDir = join(repo, specsDir);
  mkdirSync(prdDir, { recursive: true });
  writeFileSync(
    join(prdDir, "prd.md"),
    `# ${slug}\n\n## Relevant Files\n- README.md\n`,
    "utf-8",
  );

  const records: string[] = [];
  const provider = buildStubProvider({
    fixtures,
    slices,
    deaths: opts?.deaths,
    records,
  });
  const dag = buildDAG(slices);
  const featBranch = `feat-stub/${slug}`;

  // Create the feature branch
  git(repo, ["branch", featBranch]);

  const loggerSlug = `${slug}-stub`;
  const logger = new Logger(repo, loggerSlug);

  const config: PipelineConfig = {
    repoRoot: repo,
    prdSlug: slug,
    prdDir,
    specsDir,
    dag,
    provider,
    signal: opts?.signal,
  };

  return { config, dag, logger, featBranch, provider, records };
}

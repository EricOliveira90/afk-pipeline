/**
 * Shared fixtures for the `runPipeline` integration suites.
 *
 * The orchestrator tests live in two files — `orchestrator.test.ts` and
 * `orchestrator-runs.test.ts` — so one `vitest run` schedules them
 * across both workers (`maxWorkers: 2`); a single file always ran on
 * one. The split is between `describe` blocks, balanced by measured
 * block time, and this module is the top-level integration-helper
 * section both halves used to share. Not a test file itself: the
 * `.fixtures.ts` suffix keeps it out of the `src/**\/*.test.ts` include.
 *
 * These spin up a real git repo per test and inject a stub
 * `AgentProvider` that writes deterministic artifacts. The stub
 * provider is the source of truth for what each agent role "did";
 * per-slice behaviour is threaded via per-test maps.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Slice } from "./issues-parser.js";
import { resolveBaseGateDeclarations } from "./orchestrator.js";
import {
  writeContractResponse,
  writeContractReview,
  writeQAReview,
} from "./test-support.js";
import type {
  AgentProvider,
  InvokeOptions,
  InvokeResult,
} from "./agent-provider.js";

const integrationTempDirs: string[] = [];

/**
 * Removes every test-lifetime repo `makeRepo` created since the last
 * call. Each test file registers this in its own `afterEach` — a hook
 * registered here at module scope would depend on vitest's per-file
 * module isolation, which is one refactor away from silently not
 * running.
 */
export function cleanupIntegrationTempDirs(): void {
  while (integrationTempDirs.length > 0) {
    const dir = integrationTempDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

export interface SliceFixture {
  /** Files the planner declares in `contract.md`'s "Files expected to change". */
  files: string[];
  /** Files emitted by a focused second planner invocation, when present. */
  revisedFiles?: string[];
  /**
   * Whether the QA evaluator should pass on the first generator round.
   * If `false`, the qa-report verdict is "FAIL" for all rounds, and the
   * slice should end up STUCK after MAX_GENERATOR_ROUNDS.
   */
  qaPasses: boolean;
  /** Number of implementation QA failures before `qaPasses` takes effect. */
  qaFailuresBeforePass?: number;
  /**
   * Number of leading evaluator-qa invocations that report FAIL with
   * `**Failure class:** INFRASTRUCTURE` before behaving per `qaPasses`.
   * Drives the infrastructure-retry warn path without consuming rounds.
   */
  qaInfraAttempts?: number;
  /**
   * When true, the stub generator invocation reports one idle-kill
   * deferral through `onIdleDeferral` — simulating a busy probe that
   * found live spawned processes (ADR 0021).
   */
  simulateIdleDeferral?: boolean;
  /** File the generator should create in the worktree (so commits have content). */
  outputFile: string;
  outputContent: string;
  /** Raw scope-escalation artifact emitted after generator work, when set. */
  escalation?: string;
  /** One-based generator invocation that emits `escalation`. Defaults to 1. */
  escalationGeneratorInvocation?: number;
  /**
   * Raw escalation artifacts for successive generator invocations from
   * `escalationGeneratorInvocation` onward, so a test can drive a
   * generator that keeps escalating (#132). Each must name a path the
   * locked scope does not have yet — an escalation for an already
   * declared path is refused by validation, not by the round bound.
   * Takes precedence over `escalation`.
   */
  escalations?: string[];
  /**
   * File scope the planner writes on revision rounds 2, 3, ... Lets a
   * test widen the contract one escalation at a time. Falls back to
   * `revisedFiles`.
   */
  revisionFileScopes?: string[][];
  /** Exhaust contract negotiation in round two with a contested finding. */
  contractImpasse?: boolean;
}

export interface InvocationRecord {
  role: string;
  prompt?: string;
  cwd: string;
  startedAt: number;
  finishedAt: number;
  /** ghIssue parsed from cwd (worktree directory contains the slice number) */
  ghIssue: string;
}

export function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

/**
 * A throwaway git repo. By default the per-test `afterEach` removes it;
 * pass `{ lifetime: "describe" }` when a block spawns its pipelines once
 * in `beforeAll` and splits the assertions across `it` cases — those
 * cases still read the repo, so the caller owns cleanup in `afterAll`.
 */
export function makeRepo(opts: { lifetime?: "test" | "describe" } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "afk-orch-"));
  if (opts.lifetime !== "describe") integrationTempDirs.push(dir);
  git(dir, ["init", "--initial-branch=main"]);
  // Need at least one commit before we can branch.
  writeFileSync(join(dir, "README.md"), "test\n", "utf-8");
  // A behavior's gate IDs must name a baseline gate backed by a
  // discovered command, so the fixture repo needs the one sanity script
  // the derived catalog reads (`resolveSanityPlan`). Without it no
  // manifest could bind, and every negotiation here would refuse (#76).
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "consumer-fixture",
      private: true,
      scripts: { "test:run": "node -e \"process.exit(0)\"" },
    }),
    "utf-8",
  );
  git(dir, ["add", "README.md", "package.json"]);
  git(dir, ["commit", "-m", "root"]);
  return dir;
}

/**
 * Version-2 acceptance manifest for a planner stub (#76): one behavior
 * bound to a gate the fixture repo's derived catalog resolves, unless
 * the caller declares its own behaviors.
 */
export function writeAcceptanceManifest(
  artifactDir: string,
  paths: string[] = ["src/example.ts"],
  behaviors?: Array<{
    id: string;
    source: string;
    given: string;
    when: string;
    then: string;
    observableResult: string;
    preservation: boolean;
    gateIds: string[];
  }>,
): void {
  const migrationCount = paths.filter((path) =>
    /(^|[\\/])migrations[\\/].*\.sql$/i.test(path),
  ).length;
  const fileScope =
    paths.length > 0
      ? { kind: "paths", paths }
      : { kind: "no-repository-changes" };
  let repoRoot = artifactDir;
  while (!existsSync(join(repoRoot, ".git"))) {
    const parent = dirname(repoRoot);
    if (parent === repoRoot) throw new Error("fixture repository root missing");
    repoRoot = parent;
  }
  const gateId =
    resolveBaseGateDeclarations(repoRoot).find((gate) => gate.command)?.id ??
    "tests";
  const behaviorDeclarations = behaviors ?? [
    {
      id: "B-01",
      source: "test fixture",
      given: "a contract",
      when: "it is negotiated",
      then: "it reaches review",
      observableResult: "the evaluator receives the contract",
      preservation: false,
      gateIds: [gateId],
    },
  ];
  writeFileSync(
    join(artifactDir, "acceptance-manifest.json"),
    JSON.stringify({
      version: 2,
      fileScope,
      migrationCount,
      behaviors: behaviorDeclarations,
    }),
    "utf-8",
  );
}

export function writePrdFixture(repoDir: string, slug: string): { prdDir: string; specsDir: string } {
  const specsDir = join(".kiro", "specs", slug);
  const prdDir = join(repoDir, specsDir);
  mkdirSync(prdDir, { recursive: true });
  writeFileSync(
    join(prdDir, "prd.md"),
    `# ${slug}\n\n## Relevant Files\n- README.md — root readme\n`,
    "utf-8",
  );
  // Issues file is parsed externally; we build the DAG manually below.
  return { prdDir, specsDir };
}

/**
 * Extract the slice's gh issue id from a worktree path. Worktrees live
 * at `.afk/worktrees/<prefix>-<prd-slug>-s<NN>/` (truncated form, see
 * `makeSliceContext`); we match the trailing `-s<NN>` segment.
 */
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
  records: InvocationRecord[];
}): AgentProvider {
  const { fixtures, slices, records } = opts;
  // Track per-slice generator round so the stub can write fresh content
  // and decide PASS vs FAIL based on the round.
  const generatorRounds = new Map<string, number>();
  const plannerRounds = new Map<string, number>();
  // Per-slice count of evaluator-qa invocations, for qaInfraAttempts.
  const qaAttempts = new Map<string, number>();

  return {
    name: "stub",
    async invoke(options: InvokeOptions): Promise<InvokeResult> {
      const { role, cwd } = options;
      const slice = sliceFromCwd(cwd, slices);
      const ghIssue = slice?.ghIssue ?? "";
      const fixture = fixtures.get(ghIssue);
      const startedAt = Date.now();
      // Force a small delay so concurrent invocations can interleave
      // observably in timestamps.
      await new Promise((r) => setTimeout(r, 10));

      // The slice artifact dir lives under the worktree. We need the
      // slice's relative path to write contract.md / qa-report.md.
      // Tests pass slug-derived dirs, so we walk the tree to find the
      // unique slice subdir.
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
        const plannerRound = (plannerRounds.get(ghIssue) ?? 0) + 1;
        plannerRounds.set(ghIssue, plannerRound);
        const files =
          plannerRound > 1
            ? (fixture.revisionFileScopes?.[plannerRound - 2] ??
              fixture.revisedFiles ??
              fixture.files)
            : fixture.files;
        const filesBlock = files.map((f) => `- ${f}`).join("\n");
        writeFileSync(
          join(sliceArtifactDir, "contract.md"),
          `# Slice Contract\n\n**Status:** ${fixture.contractImpasse ? "DRAFT" : "LOCKED"}\n\n## Files expected to change\n${filesBlock}\n`,
          "utf-8",
        );
        writeAcceptanceManifest(sliceArtifactDir, files);
        if (fixture.contractImpasse && plannerRound === 2) {
          writeContractResponse(sliceArtifactDir, ["F-IMPASSE"], "CONTESTED");
        }
      } else if (
        role === "evaluator-contract" &&
        sliceArtifactDir &&
        fixture
      ) {
        const feedbackRound =
          /feedback-r(\d+)\.md/.exec(options.prompt)?.[1] ?? "1";
        const impasse = fixture.contractImpasse === true;
        writeFileSync(
          join(sliceArtifactDir, `feedback-r${feedbackRound}.md`),
          `## Evaluator feedback — round ${feedbackRound}\n\n${
            impasse ? "The contract interpretation remains disputed." : "The contract is testable."
          }\n`,
          "utf-8",
        );
        writeContractReview(
          sliceArtifactDir,
          impasse ? "REVISE" : "ACCEPT",
          impasse
            ? [
                {
                  id: "F-IMPASSE",
                  severity: "BLOCKING",
                  behaviorIds: ["B-01"],
                  evidence: '"the evaluator-held interpretation"',
                  expected: "one agreed interpretation",
                  observed: "the planner contests the evaluator interpretation",
                  clearCondition: "a human adjudicates the finding",
                  state:
                    plannerRounds.get(ghIssue) === 2
                      ? "CONTESTED"
                      : "OPEN",
                },
              ]
            : undefined,
        );
      } else if (role === "generator" && sliceArtifactDir && fixture) {
        if (fixture.simulateIdleDeferral) {
          options.onIdleDeferral?.({ silentSeconds: 600, busyProcesses: 2 });
        }
        const round = (generatorRounds.get(ghIssue) ?? 0) + 1;
        generatorRounds.set(ghIssue, round);
        // Write the fixture's output file into the worktree so the
        // commit has real content.
        const outPath = join(cwd, fixture.outputFile);
        mkdirSync(join(outPath, ".."), { recursive: true });
        writeFileSync(
          outPath,
          `${fixture.outputContent}\n// generator round ${round} for #${ghIssue}\n`,
          "utf-8",
        );
        const firstEscalation = fixture.escalationGeneratorInvocation ?? 1;
        const escalations =
          fixture.escalations ??
          (fixture.escalation !== undefined ? [fixture.escalation] : []);
        const raw = escalations[round - firstEscalation];
        if (round >= firstEscalation && raw !== undefined) {
          writeFileSync(
            join(sliceArtifactDir, "escalation.md"),
            raw,
            "utf-8",
          );
        }
      } else if (role === "evaluator-qa" && sliceArtifactDir && fixture) {
        const attempt = (qaAttempts.get(ghIssue) ?? 0) + 1;
        qaAttempts.set(ghIssue, attempt);
        if (attempt <= (fixture.qaInfraAttempts ?? 0)) {
          writeFileSync(
            join(sliceArtifactDir, "qa-report.md"),
            "# QA Report\n\n**Verdict:** FAIL\n\n**Failure class:** INFRASTRUCTURE\n",
            "utf-8",
          );
          writeQAReview(sliceArtifactDir, "deterministic", {
            verdict: "FAIL",
            failureClass: "INFRASTRUCTURE",
          });
        } else {
          const verdict =
            attempt > (fixture.qaFailuresBeforePass ?? 0) && fixture.qaPasses
              ? "PASS"
              : "FAIL";
          const resolvedFixtureFinding =
            verdict === "PASS" && (fixture.qaFailuresBeforePass ?? 0) > 0
              ? [
                  {
                    id: "QA-01",
                    severity: "BLOCKING" as const,
                    behaviorIds: [],
                    summary: "Fixture implementation finding",
                    evidence:
                      "The fixture evaluator observed a passing behavior",
                    expected: "The behavior passes",
                    observed: "The behavior passes",
                    clearCondition:
                      "The fixture evaluator observes the behavior passing",
                    state: "RESOLVED" as const,
                  },
                ]
              : undefined;
          writeFileSync(
            join(sliceArtifactDir, "qa-report.md"),
            `# QA Report\n\n**Verdict:** ${verdict}\n`,
            "utf-8",
          );
          writeQAReview(sliceArtifactDir, "deterministic", {
            verdict,
            findings: resolvedFixtureFinding,
          });
        }
      }
      // architect-review / pm-review are no-ops; verdicts will be
      // UNKNOWN, blocking PR creation. That path is fine for our tests.

      const finishedAt = Date.now();
      records.push({
        role,
        prompt: options.prompt,
        cwd,
        startedAt,
        finishedAt,
        ghIssue,
      });
      return { exitCode: 0, stdout: "", stats: {} };
    },
  };
}

/**
 * Locate the slice artifact directory inside a worktree by scanning
 * `.kiro/specs/<slug>/slices/<number>-<slug>`. We don't know the slug
 * here, but each slice has a single artifact dir whose name starts
 * with `<sliceNumber>-`, so we walk the slices folder.
 */
export function findSliceArtifactDir(cwd: string, sliceNumber: string): string | null {
  // Walk `.kiro/specs/*/slices/<number>-*` for the slice's artifact dir.
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

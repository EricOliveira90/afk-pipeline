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
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { validExplorerContext } from "./explorer-test-fixtures.js";
import type { Slice } from "./issues-parser.js";
import { resolveBaseGateDeclarations } from "./base-gates.js";
import { PLANNER_ESCALATION_FILENAME } from "./planner-escalation.js";
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

/** The request the `revisionPlannerEscalates` fixture writes. Asserted, so it lives here. */
export const REVISION_PLANNER_ESCALATION = {
  version: 1,
  criterion: "SPEC_CONTRADICTION",
  decision: "Whether the widened scope may change the public return type",
  options: ["keep the type and adapt", "change the type"],
  citation: "ADR 0051",
} as const;

/** Message the `revisionPlannerThrows` fixture fails with. */
export const REVISION_PLANNER_FAILURE =
  "stub planner refused the focused revision";

/** Finding ID the `revisionRejected` fixture's REVISE verdict carries. */
export const REVISION_REJECTION_FINDING = "F-REVISION";

/**
 * Whether a planner or contract-evaluator prompt is the focused
 * scope-revision one. Read off the notes `runFocusedScopeRevision`
 * interpolates rather than an invocation counter: a lane successor
 * re-negotiates from scratch, which bumps every counter without a
 * revision having happened.
 */
function isFocusedRevision(prompt: string): boolean {
  return (
    prompt.includes("This is a focused revision of the already accepted") ||
    prompt.includes(
      "This is a fresh evaluation of one focused generator scope revision",
    )
  );
}

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
  /** A PASS explicitly dispositions durable fixture finding QA-01 as resolved. */
  qaResolvesPriorFindingOnPass?: boolean;
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
   * Worktree-relative paths the generator writes *before* emitting its
   * escalation, none of them on the locked file scope — the protocol
   * violation the grant guard exists to refuse (architect blocker 1, fifth
   * adjudication gate round). A generator that edits an undeclared path and
   * then names it in a valid escalation would otherwise have the focused
   * revision legitimize the edit after the fact.
   */
  undeclaredEdits?: string[];
  /**
   * Extra file names the generator writes into its own slice artifact
   * directory alongside the escalation. The grant guard exempts that
   * directory by prefix, so an honest escalation keeps its grant with more
   * than just `escalation.md` dirty — a filename-list exemption would not.
   */
  sliceArtifactEdits?: string[];
  /**
   * Worktree-relative path the generator smuggles into *both*
   * orchestrator-owned slice files — `contract.md` and
   * `acceptance-manifest.json` — before emitting its escalation, widening
   * its own lock (architect A1, seventh gate round). The escalation itself
   * names some other path, so the refusal cannot be mistaken for the
   * requested-path check doing the work.
   */
  ownedContractWidening?: string;
  /**
   * File scope the planner writes on revision rounds 2, 3, ... Lets a
   * test widen the contract one escalation at a time. Falls back to
   * `revisedFiles`.
   */
  revisionFileScopes?: string[][];
  /**
   * Throw from the second (revision) planner invocation instead of
   * writing a revised contract — the provider-exception half of the
   * focused-revision rollback (ADR 0051). The message is asserted, so it
   * is fixed here rather than per test.
   */
  revisionPlannerThrows?: boolean;
  /**
   * Write `planner-escalation.md` instead of the revised pair from the
   * focused-revision planner — the deliberate-stop half of the rollback.
   * `planner-revision.md` is this path's template too, so a planner can hit
   * a §3c escalation test here and stop, and the run must report the design
   * decision rather than the missing manifest the stop implies.
   */
  revisionPlannerEscalates?: boolean;
  /**
   * Make the *revision* contract evaluator return REVISE, so the focused
   * revision is planned and then rejected — the other half of ADR 0051's
   * rollback. Distinct from `contractImpasse`, which rejects during
   * ordinary negotiation before any revision exists.
   */
  revisionRejected?: boolean;
  /** Exhaust contract negotiation in round two with a contested finding. */
  contractImpasse?: boolean;
  /**
   * The contested finding IDs a `contractImpasse` exhaustion carries.
   * Defaults to the single `F-IMPASSE`.
   *
   * More than one is the shape ADR 0054's "one adjudication decides one
   * finding" rule is about: the slice re-parks after each recorded decision
   * until every contested finding has one, so a multi-finding impasse is the
   * only way to observe a *non-empty* decision log surviving a re-dispatch.
   * Each finding's evidence names its own ID, so a decision log that lost or
   * duplicated an entry is distinguishable from one that carried them all.
   */
  contractImpasseFindings?: string[];
}

/** The contested findings a `contractImpasse` fixture exhausts on. */
export function impasseFindingIds(fixture: {
  contractImpasseFindings?: string[];
}): string[] {
  return fixture.contractImpasseFindings ?? ["F-IMPASSE"];
}

export interface InvocationRecord {
  role: string;
  prompt?: string;
  cwd: string;
  startedAt: number;
  finishedAt: number;
  /** ghIssue parsed from cwd (worktree directory contains the slice number) */
  ghIssue: string;
  /**
   * The last `events.jsonl` entry at provider invocation entry, captured
   * only for scoped invocations (those dispatched with a context
   * envelope). Slice #83 requires the matching `prompt-assembly` event to
   * be journaled before dispatch (guardian round 2, PM 4) — this is the
   * stub-side proof.
   */
  journalTailAtEntry?: Record<string, unknown> | null;
}

export { validExplorerContext } from "./explorer-test-fixtures.js";

/**
 * The last parsed `events.jsonl` entry of the run owning `cwd`, or `null`
 * when no journal exists yet. Walks up from the invocation worktree to the
 * repo root's `.afk/logs` and picks the newest run directory. Used by the
 * stub provider to prove, at invocation entry, that assembly evidence was
 * journaled before dispatch (slice #83; guardian round 2, PM 4).
 */
export function lastJournalEventAtEntry(
  cwd: string,
): Record<string, unknown> | null {
  let dir = cwd;
  for (;;) {
    const logsRoot = join(dir, ".afk", "logs");
    if (existsSync(logsRoot)) {
      const runDirs = readdirSync(logsRoot)
        .map((slugName) => join(logsRoot, slugName))
        .filter((path) => statSync(path).isDirectory())
        .flatMap((slugDir) =>
          readdirSync(slugDir)
            .map((name) => join(slugDir, name))
            .filter((path) => statSync(path).isDirectory()),
        )
        .sort(
          (left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs,
        );
      for (const runDir of runDirs) {
        const eventsPath = join(runDir, "events.jsonl");
        if (!existsSync(eventsPath)) continue;
        const lines = readFileSync(eventsPath, "utf-8").trim().split(/\r?\n/);
        const last = lines.at(-1);
        if (!last) return null;
        return JSON.parse(last) as Record<string, unknown>;
      }
      return null;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
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
      // Captured at entry, before any stub work: the journal must already
      // hold the matching prompt-assembly event for scoped invocations
      // (slice #83; guardian round 2, PM 4).
      const journalTailAtEntry =
        options.contextEnvelope !== undefined
          ? lastJournalEventAtEntry(cwd)
          : undefined;
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
          validExplorerContext(`Context for ${ghIssue}`),
          "utf-8",
        );
      } else if (role === "planner" && sliceArtifactDir && fixture) {
        const plannerRound = (plannerRounds.get(ghIssue) ?? 0) + 1;
        plannerRounds.set(ghIssue, plannerRound);
        if (fixture.revisionPlannerThrows && isFocusedRevision(options.prompt)) {
          records.push({
            role,
            prompt: options.prompt,
            cwd,
            startedAt,
            finishedAt: Date.now(),
            ghIssue,
            ...(journalTailAtEntry !== undefined
              ? { journalTailAtEntry }
              : {}),
          });
          throw new Error(REVISION_PLANNER_FAILURE);
        }
        if (
          fixture.revisionPlannerEscalates &&
          isFocusedRevision(options.prompt)
        ) {
          writeFileSync(
            join(sliceArtifactDir, PLANNER_ESCALATION_FILENAME),
            JSON.stringify(REVISION_PLANNER_ESCALATION),
            "utf-8",
          );
          records.push({
            role,
            prompt: options.prompt,
            cwd,
            startedAt,
            finishedAt: Date.now(),
            ghIssue,
            ...(journalTailAtEntry !== undefined
              ? { journalTailAtEntry }
              : {}),
          });
          return { exitCode: 0, stdout: "", stats: {} };
        }
        const declared =
          plannerRound > 1
            ? (fixture.revisionFileScopes?.[plannerRound - 2] ??
              fixture.revisedFiles ??
              fixture.files)
            : fixture.files;
        // The generator stub always writes `fixture.outputFile`, so a fixture
        // whose declared list omits it is now red at the post-QA file-scope
        // gate (#195) — correctly, but for a reason its scenario is not about.
        // Declared here rather than in every fixture, because the deliberate
        // out-of-scope cases go through `undeclaredEdits`, which stays
        // undeclared on purpose. Migration outputs are skipped: the gate
        // exempts them by pattern, and declaring one would move this
        // manifest's `migrationCount` out from under the prefix-claim
        // fixtures that assert on it.
        //
        // Whether to add it is decided from the *first* round's list and then
        // held for every later one, so this stays invisible to the additive
        // revision guard: a fixture that drops a locked path on revision still
        // drops it, and one that gained the output path in round 1 still
        // carries it in round 2.
        const augment =
          !fixture.files.includes(fixture.outputFile) &&
          !/(^|[\\/])migrations[\\/].*\.sql$/i.test(fixture.outputFile);
        const files =
          augment && !declared.includes(fixture.outputFile)
            ? [...declared, fixture.outputFile]
            : declared;
        const filesBlock = files.map((f) => `- ${f}`).join("\n");
        writeFileSync(
          join(sliceArtifactDir, "contract.md"),
          `# Slice Contract\n\n**Status:** ${fixture.contractImpasse ? "DRAFT" : "LOCKED"}\n\n## Files expected to change\n${filesBlock}\n`,
          "utf-8",
        );
        writeAcceptanceManifest(sliceArtifactDir, files);
        if (fixture.contractImpasse && plannerRound === 2) {
          writeContractResponse(
            sliceArtifactDir,
            impasseFindingIds(fixture),
            "CONTESTED",
          );
        }
      } else if (
        role === "evaluator-contract" &&
        sliceArtifactDir &&
        fixture
      ) {
        const feedbackRound =
          /feedback-r(\d+)\.md/.exec(options.prompt)?.[1] ?? "1";
        const rejectRevision =
          fixture.revisionRejected === true &&
          isFocusedRevision(options.prompt);
        const impasse = fixture.contractImpasse === true;
        writeFileSync(
          join(sliceArtifactDir, `feedback-r${feedbackRound}.md`),
          `## Evaluator feedback — round ${feedbackRound}\n\n${
            impasse || rejectRevision
              ? "The contract interpretation remains disputed."
              : "The contract is testable."
          }\n`,
          "utf-8",
        );
        if (rejectRevision) {
          writeContractReview(sliceArtifactDir, "REVISE", [
            {
              id: REVISION_REJECTION_FINDING,
              severity: "BLOCKING",
              behaviorIds: ["B-01"],
              evidence: '"the revised file scope"',
              expected: "a revision that keeps every locked term",
              observed: "the revision changes an accepted behavior",
              clearCondition: "the planner re-revises the contract",
              state: "OPEN",
            },
          ]);
        } else {
          writeContractReview(
            sliceArtifactDir,
            impasse ? "REVISE" : "ACCEPT",
            impasse
              ? impasseFindingIds(fixture).map((findingId) => ({
                  id: findingId,
                  severity: "BLOCKING" as const,
                  behaviorIds: ["B-01"],
                  // Each finding's evidence names its own ID so a decision
                  // log that lost one entry is distinguishable from one that
                  // carried both (issue #144).
                  evidence: `"the evaluator-held interpretation of ${findingId}"`,
                  expected: `one agreed interpretation of ${findingId}`,
                  observed: `the planner contests the evaluator interpretation of ${findingId}`,
                  clearCondition: `a human adjudicates ${findingId}`,
                  state: (plannerRounds.get(ghIssue) === 2
                    ? "CONTESTED"
                    : "OPEN") as "CONTESTED" | "OPEN",
                }))
              : undefined,
          );
        }
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
          for (const path of fixture.undeclaredEdits ?? []) {
            const abs = join(cwd, path);
            mkdirSync(join(abs, ".."), { recursive: true });
            writeFileSync(abs, `undeclared edit for #${ghIssue}\n`, "utf-8");
          }
          if (fixture.ownedContractWidening !== undefined) {
            // Both files, because widening only the manifest leaves the
            // contract disagreeing with it and widening only the contract
            // leaves the manifest the orchestrator actually reads. The
            // laundering that reaches a grant is the one that rewrites the
            // pair consistently.
            const contractPath = join(sliceArtifactDir, "contract.md");
            writeFileSync(
              contractPath,
              `${readFileSync(contractPath, "utf-8")}- ${fixture.ownedContractWidening}\n`,
              "utf-8",
            );
            const manifestPath = join(
              sliceArtifactDir,
              "acceptance-manifest.json",
            );
            const manifest = JSON.parse(
              readFileSync(manifestPath, "utf-8"),
            ) as { fileScope: { paths: string[] } };
            manifest.fileScope.paths = [
              ...manifest.fileScope.paths,
              fixture.ownedContractWidening,
            ];
            writeFileSync(
              manifestPath,
              `${JSON.stringify(manifest, null, 2)}\n`,
              "utf-8",
            );
          }
          for (const name of fixture.sliceArtifactEdits ?? []) {
            writeFileSync(
              join(sliceArtifactDir, name),
              `# ${name} written in generator round ${round}\n`,
              "utf-8",
            );
          }
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
            verdict === "PASS" &&
            ((fixture.qaFailuresBeforePass ?? 0) > 0 ||
              fixture.qaResolvesPriorFindingOnPass === true)
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
        ...(journalTailAtEntry !== undefined ? { journalTailAtEntry } : {}),
      });
      const tokenCounts: Record<string, number> | undefined =
        role === "planner"
          ? { input_tokens: 10 }
          : role === "evaluator-contract"
            ? { input_tokens: 7, output_tokens: 3 }
            : role === "generator"
              ? { output_tokens: 5, cache_read_input_tokens: 2 }
              : undefined;
      // The first evaluator-qa invocation per slice reports a measured
      // reading time; later attempts report nothing — so one shared
      // spawned scenario covers both the durable evaluator completion
      // event and the unmeasured-omission rule (guardian round 6).
      const nonCommandTimeMs =
        role === "evaluator-qa" && qaAttempts.get(ghIssue) === 1
          ? 777
          : undefined;
      return {
        exitCode: 0,
        stdout: "",
        stats: {
          ...(tokenCounts === undefined ? {} : { tokenCounts }),
          ...(nonCommandTimeMs === undefined ? {} : { nonCommandTimeMs }),
        },
      };
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

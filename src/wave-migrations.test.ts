/**
 * Wave integration tests, part 2 of 2: the migration-flavoured blocks —
 * lane grouping (ADR 0027), the contract-lock prefix gate (ADR 0028)
 * and the prefix-collision MERGE-PENDING deferral (ADR 0029). The rest
 * of the `runWave` suite lives in `wave.test.ts`.
 *
 * Two files exist so one `vitest run` schedules the suite across both
 * workers (`maxWorkers: 2`) — a single file always pinned it to one.
 * Shared helpers are in `wave.fixtures.ts`. When adding a `describe`,
 * keep the halves balanced by measured block time
 * (`--reporter=./scripts/describe-times.reporter.mjs`), not test count.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executionLanes, runWave, type WaveOutcome } from "./wave.js";
import { makeAsyncMutex, sliceBranch } from "./orchestrator.js";
import { buildDAG, type Slice } from "./issues-parser.js";
import { RunJournal as Logger } from "./run-journal.js";
import * as gitModule from "./git.js";
import type {
  AgentProvider,
  InvokeOptions,
  InvokeResult,
} from "./agent-provider.js";
import { CancelledError, TransientProviderError } from "./agent-provider.js";
import { readRunEvents, type RunEvent } from "./run-events.js";
import type { PipelineConfig } from "./orchestrator.js";
import {
  buildStubProvider,
  cleanupWaveTempDirs,
  deathError,
  findSliceArtifactDir,
  git,
  makeRepo,
  setupWave,
  sliceFromCwd,
  writeAcceptanceManifest,
  type ProviderDeath,
  type SliceFixture,
} from "./wave.fixtures.js";
import {
  writeContractResponse,
  writeContractReview,
  writeQAReview,
} from "./test-support.js";

afterEach(() => {
  cleanupWaveTempDirs();
});

/**
 * Migrations as a lane-shared resource (ADR 0027). Two slices that each
 * declare their own migration file share no path, so they used to run
 * concurrently from an identical base, compute the same "next free
 * prefix", and collide hours later at the merge mutex. They must now
 * land in one lane, which serialises them and gives the successor a
 * base that already contains its predecessor's merged migration.
 */
describe("runWave — migration lane grouping", () => {
  function readEvents(runDir: string): Array<Record<string, unknown>> {
    const raw = readFileSync(join(runDir, "events.jsonl"), "utf-8");
    return raw
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  it("serialises two migration-bearing slices and re-negotiates the successor on the merged base", async () => {
    const repo = makeRepo();
    const slices: Slice[] = [
      { number: "01", ghIssue: "1001", title: "First migration", type: "AFK", blockedBy: [], userStories: "" },
      { number: "02", ghIssue: "1002", title: "Second migration", type: "AFK", blockedBy: [], userStories: "" },
    ];
    // Deliberately different directories: the grouping is driven by the
    // `migrations` segment, not by one project's layout, and the two
    // slices share no declared path.
    const first = "supabase/migrations/20240101000000_first.sql";
    const second = "db/migrations/20240202000000_second.sql";
    const fixtures = new Map<string, SliceFixture>([
      ["1001", {
        files: ["src/first-prose.ts"],
        manifestFiles: [first],
        qaPasses: true,
        outputFile: first,
        outputContent: "-- first",
      }],
      ["1002", {
        files: ["src/second-prose.ts"],
        manifestFiles: [second],
        qaPasses: true,
        outputFile: second,
        outputContent: "-- second",
      }],
    ]);
    const { config, dag, logger, featBranch, provider } = setupWave(
      repo,
      "wave-migrations",
      slices,
      fixtures,
    );

    // Record, for each invocation, whether the predecessor's migration
    // was already visible in the invoking worktree.
    const events: string[] = [];
    const predecessorVisible: boolean[] = [];
    config.provider = {
      name: "stub",
      async invoke(options: InvokeOptions): Promise<InvokeResult> {
        const slice = sliceFromCwd(options.cwd, slices);
        events.push(`invoke:${options.role}:${slice?.ghIssue ?? "?"}`);
        if (slice?.ghIssue === "1002" && options.role === "explorer") {
          predecessorVisible.push(existsSync(join(options.cwd, first)));
        }
        return provider.invoke(options);
      },
    };

    const { outcomes } = await runWave({
      waveNumber: 1,
      readyIds: ["1001", "1002"],
      config,
      dag,
      logger,
      featBranch,
      relevantFilesBlock: "- README.md",
      testCommand: "pnpm test",
      mergeMutex: makeAsyncMutex(),
      onOutcome: (id, outcome) => events.push(`outcome:${outcome.phase}:${id}`),
    });

    expect(outcomes.get("1001")?.phase).toBe("PASS");
    expect(outcomes.get("1002")?.phase).toBe("PASS");

    // One lane, and the structured event says so.
    const partitioned = readEvents(logger.runDir).find(
      (e) => e.type === "lanes-partitioned",
    );
    expect(partitioned?.lanes).toEqual([["1001", "1002"]]);
    expect(partitioned?.sharedResources).toEqual({
      migrations: ["1001", "1002"],
    });

    // Serialised: 1002's lane-successor re-negotiation (its second
    // explorer) starts only after 1001's PASS is reported.
    const passIdx = events.indexOf("outcome:PASS:1001");
    const explorers = events
      .map((e, i) => (e === "invoke:explorer:1002" ? i : -1))
      .filter((i) => i >= 0);
    expect(explorers.length).toBeGreaterThanOrEqual(2);
    expect(passIdx).toBeGreaterThanOrEqual(0);
    expect(passIdx).toBeLessThan(explorers[1]!);

    // The successor re-negotiated against a base that already contained
    // the predecessor's migration — the whole point of the grouping.
    expect(predecessorVisible[0]).toBe(false); // wave-start base
    expect(predecessorVisible[1]).toBe(true); // refreshed base
  }, 240_000);

  it("leaves non-migration slices in their own parallel lanes", async () => {
    const repo = makeRepo();
    const slices: Slice[] = [
      { number: "01", ghIssue: "1011", title: "Migration", type: "AFK", blockedBy: [], userStories: "" },
      { number: "02", ghIssue: "1012", title: "No migration", type: "AFK", blockedBy: [], userStories: "" },
    ];
    const migration = "supabase/migrations/20240101000000_only.sql";
    const fixtures = new Map<string, SliceFixture>([
      ["1011", { files: [migration], qaPasses: true, outputFile: migration, outputContent: "-- only" }],
      ["1012", { files: ["src/app.ts"], qaPasses: true, outputFile: "src/app.ts", outputContent: "app" }],
    ]);
    const { config, dag, logger, featBranch } = setupWave(
      repo,
      "wave-migrations-mixed",
      slices,
      fixtures,
    );

    const { outcomes } = await runWave({
      waveNumber: 1,
      readyIds: ["1011", "1012"],
      config,
      dag,
      logger,
      featBranch,
      relevantFilesBlock: "- README.md",
      testCommand: "pnpm test",
      mergeMutex: makeAsyncMutex(),
    });

    expect(outcomes.get("1011")?.phase).toBe("PASS");
    expect(outcomes.get("1012")?.phase).toBe("PASS");

    const partitioned = readEvents(logger.runDir).find(
      (e) => e.type === "lanes-partitioned",
    );
    expect(partitioned?.lanes).toEqual([["1011"], ["1012"]]);
    // A lone migration slice is contending with nobody, so the event
    // carries no shared-resource grouping.
    expect(partitioned?.sharedResources).toBeUndefined();
  }, 240_000);

  it("honours a configured pattern instead of the default", async () => {
    const repo = makeRepo();
    const slices: Slice[] = [
      { number: "01", ghIssue: "1021", title: "Changeset one", type: "AFK", blockedBy: [], userStories: "" },
      { number: "02", ghIssue: "1022", title: "Changeset two", type: "AFK", blockedBy: [], userStories: "" },
    ];
    const one = "db/changesets/001_one.xml";
    const two = "db/changesets/002_two.xml";
    const fixtures = new Map<string, SliceFixture>([
      ["1021", { files: [one], qaPasses: true, outputFile: one, outputContent: "<one/>" }],
      ["1022", { files: [two], qaPasses: true, outputFile: two, outputContent: "<two/>" }],
    ]);
    const { config, dag, logger, featBranch } = setupWave(
      repo,
      "wave-migrations-configured",
      slices,
      fixtures,
    );
    config.migrationPathPattern = /(^|\/)changesets\/.*\.xml$/;

    const { outcomes } = await runWave({
      waveNumber: 1,
      readyIds: ["1021", "1022"],
      config,
      dag,
      logger,
      featBranch,
      relevantFilesBlock: "- README.md",
      testCommand: "pnpm test",
      mergeMutex: makeAsyncMutex(),
    });

    expect(outcomes.get("1021")?.phase).toBe("PASS");
    expect(outcomes.get("1022")?.phase).toBe("PASS");
    const partitioned = readEvents(logger.runDir).find(
      (e) => e.type === "lanes-partitioned",
    );
    expect(partitioned?.lanes).toEqual([["1021", "1022"]]);
  }, 240_000);

  it("still collapses the whole wave under --serial-lanes", async () => {
    const repo = makeRepo();
    const slices: Slice[] = [
      { number: "01", ghIssue: "1031", title: "Migration", type: "AFK", blockedBy: [], userStories: "" },
      { number: "02", ghIssue: "1032", title: "Unrelated", type: "AFK", blockedBy: [], userStories: "" },
    ];
    const migration = "supabase/migrations/20240101000000_serial.sql";
    const fixtures = new Map<string, SliceFixture>([
      ["1031", { files: [migration], qaPasses: true, outputFile: migration, outputContent: "-- serial" }],
      ["1032", { files: ["src/unrelated.ts"], qaPasses: true, outputFile: "src/unrelated.ts", outputContent: "u" }],
    ]);
    const { config, dag, logger, featBranch } = setupWave(
      repo,
      "wave-migrations-serial",
      slices,
      fixtures,
    );
    config.serialLanes = true;

    const { outcomes } = await runWave({
      waveNumber: 1,
      readyIds: ["1031", "1032"],
      config,
      dag,
      logger,
      featBranch,
      relevantFilesBlock: "- README.md",
      testCommand: "pnpm test",
      mergeMutex: makeAsyncMutex(),
    });

    expect(outcomes.get("1031")?.phase).toBe("PASS");
    expect(outcomes.get("1032")?.phase).toBe("PASS");
    const partitioned = readEvents(logger.runDir).find(
      (e) => e.type === "lanes-partitioned",
    );
    expect(partitioned?.lanes).toEqual([["1031", "1032"]]);
    expect(partitioned?.serial).toBe(true);
  }, 240_000);
});

/**
 * The contract-lock migration prefix gate (ADR 0028).
 *
 * The contract names its migration file at lock time. When that
 * filename's prefix already exists on the feature branch under another
 * name, the merge mutex refuses the merge — in the PRD 076 session, four
 * hours and seven commits later. The wave inspects each contract the
 * moment it locks and sends a colliding one straight back to the
 * planner, which costs one contract round and no generation at all.
 */
describe("runWave — contract-lock migration prefix gate", () => {
  function readEvents(runDir: string): Array<Record<string, unknown>> {
    const raw = readFileSync(join(runDir, "events.jsonl"), "utf-8");
    return raw
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  /**
   * Commit the given repo-relative files onto the feature branch, without
   * disturbing HEAD. Each path is staged by name — `add -A` here would
   * sweep the run's untracked `.afk/logs` and `.kiro/specs` onto the
   * branch, and checking HEAD back out would then delete them mid-run.
   */
  function commitToFeatBranch(
    repo: string,
    featBranch: string,
    files: Record<string, string>,
  ) {
    const head = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
    git(repo, ["checkout", featBranch]);
    for (const [relPath, content] of Object.entries(files)) {
      const abs = join(repo, relPath);
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, content, "utf-8");
      git(repo, ["add", "--", relPath]);
    }
    git(repo, ["commit", "-m", `add ${Object.keys(files).join(", ")}`]);
    git(repo, ["checkout", head]);
  }

  function addMigrationToFeatBranch(
    repo: string,
    featBranch: string,
    relPath: string,
  ) {
    commitToFeatBranch(repo, featBranch, { [relPath]: "-- existing\n" });
  }

  /**
   * Provider whose planner declares — and whose generator writes — a
   * migration path chosen per planner round, so a test can make the
   * planner obey the gate's objection or ignore it.
   */
  function buildPlannerProvider(opts: {
    slices: Slice[];
    /** Prose path this slice's planner declares on the given round. */
    pathForRound: (ghIssue: string, round: number) => string;
    /** Machine path; defaults to the prose path. */
    manifestPathForRound?: (ghIssue: string, round: number) => string;
    /** Overrides what the generator writes; defaults to the declared path. */
    generatorPath?: (ghIssue: string) => string;
    /** Every planner prompt, in invocation order. */
    plannerPrompts?: string[];
    /** Skip the fresh round-2 response to exercise fail-closed handling. */
    writeRound2Response?: boolean;
    /** Leave a round-1 response behind to prove round-2 freshness. */
    writeStaleResponseAfterRound1?: boolean;
    /** Every evaluator prompt, in invocation order. */
    evaluatorPrompts?: string[];
  }): AgentProvider {
    const {
      slices,
      pathForRound,
      manifestPathForRound,
      generatorPath,
      plannerPrompts,
      writeRound2Response = true,
      writeStaleResponseAfterRound1 = false,
      evaluatorPrompts,
    } = opts;
    const plannerRounds = new Map<string, number>();
    const declaredNow = new Map<string, string>();

    return {
      name: "stub",
      async invoke(options: InvokeOptions): Promise<InvokeResult> {
        const { role, cwd, prompt } = options;
        const slice = sliceFromCwd(cwd, slices);
        const ghIssue = slice?.ghIssue ?? "";
        const dir = slice ? findSliceArtifactDir(cwd, slice.number) : null;
        await new Promise((r) => setTimeout(r, 5));

        if (role === "explorer" && dir) {
          writeFileSync(join(dir, "context.md"), "# Context\n", "utf-8");
        } else if (role === "planner" && dir) {
          const round = (plannerRounds.get(ghIssue) ?? 0) + 1;
          plannerRounds.set(ghIssue, round);
          plannerPrompts?.push(prompt);
          const path = pathForRound(ghIssue, round);
          const manifestPath =
            manifestPathForRound?.(ghIssue, round) ?? path;
          declaredNow.set(ghIssue, path);
          writeFileSync(
            join(dir, "contract.md"),
            `# Slice Contract\n\n**Status:** NEGOTIATING\n\n## Files expected to change\n- ${path}\n`,
            "utf-8",
          );
          writeAcceptanceManifest(dir, [manifestPath]);
          if (round === 2 && writeRound2Response) {
            writeContractResponse(dir, []);
          }
        } else if (role === "evaluator-contract" && dir) {
          // Always ACCEPT. The evaluator has no idea what is on the
          // feature branch, which is exactly why the gate has to exist.
          const round = plannerRounds.get(ghIssue) ?? 1;
          evaluatorPrompts?.push(prompt);
          writeFileSync(
            join(dir, `feedback-r${round}.md`),
            `## Evaluator feedback — round ${round}\n\nThe contract is testable.\n`,
            "utf-8",
          );
          writeContractReview(dir, "ACCEPT");
          if (round === 1 && writeStaleResponseAfterRound1) {
            writeContractResponse(dir, []);
          }
        } else if (role === "generator" && dir) {
          const path =
            generatorPath?.(ghIssue) ?? declaredNow.get(ghIssue) ?? "src/x.txt";
          const abs = join(cwd, path);
          mkdirSync(join(abs, ".."), { recursive: true });
          writeFileSync(abs, `-- ${ghIssue}\n`, "utf-8");
        } else if (role === "evaluator-qa" && dir) {
          writeFileSync(
            join(dir, "qa-report.md"),
            "# QA Report\n\n**Verdict:** PASS\n",
            "utf-8",
          );
          writeQAReview(dir, "deterministic");
        }

        return { exitCode: 0, stdout: "", stats: {} };
      },
    };
  }

  function buildManifestProvider(
    slices: Slice[],
    observedPrompts: string[],
  ): AgentProvider {
    const plannerRounds = new Map<string, number>();
    const assignedPaths = new Map<string, string>();

    return {
      name: "stub",
      async invoke(options: InvokeOptions): Promise<InvokeResult> {
        const { role, cwd, prompt } = options;
        const slice = sliceFromCwd(cwd, slices);
        const ghIssue = slice?.ghIssue ?? "";
        const dir = slice ? findSliceArtifactDir(cwd, slice.number) : null;
        await new Promise((resolve) => setTimeout(resolve, 5));

        if (role === "explorer" && dir) {
          writeFileSync(join(dir, "context.md"), "# Context\n", "utf-8");
        } else if (role === "planner" && dir) {
          observedPrompts.push(prompt);
          const round = (plannerRounds.get(ghIssue) ?? 0) + 1;
          plannerRounds.set(ghIssue, round);
          const assigned = /owns exactly:\s*(\d+)/i.exec(prompt)?.[1];
          const path = assigned
            ? `supabase/migrations/${assigned}_issue_${ghIssue}.sql`
            : `supabase/migrations/RESERVED_PREFIX_issue_${ghIssue}.sql`;
          if (assigned) assignedPaths.set(ghIssue, path);
          writeFileSync(
            join(dir, "contract.md"),
            [
              "# Slice Contract",
              "",
              "**Status:** NEGOTIATING",
              "",
              "## Files expected to change",
              `- ${path}`,
              "",
              "## Migration requirements",
              "- New migration files: 1",
              "",
            ].join("\n"),
            "utf-8",
          );
          writeAcceptanceManifest(dir, [path]);
          if (round === 2) {
            writeContractResponse(dir, []);
          }
        } else if (role === "evaluator-contract" && dir) {
          const round = plannerRounds.get(ghIssue) ?? 1;
          writeFileSync(
            join(dir, `feedback-r${round}.md`),
            `## Evaluator feedback - round ${round}\n\nThe contract is testable.\n`,
            "utf-8",
          );
          writeContractReview(dir, "ACCEPT");
        } else if (role === "generator" && dir) {
          observedPrompts.push(prompt);
          const path = assignedPaths.get(ghIssue);
          if (!path) throw new Error(`Generator for #${ghIssue} received no assigned migration`);
          const abs = join(cwd, path);
          mkdirSync(join(abs, ".."), { recursive: true });
          writeFileSync(abs, `-- ${ghIssue}\n`, "utf-8");
          git(cwd, ["add", "--", path]);
          git(cwd, ["commit", "-m", `feat: add reserved migration ${ghIssue}`]);
        } else if (role === "evaluator-qa" && dir) {
          writeFileSync(
            join(dir, "qa-report.md"),
            "# QA Report\n\n**Verdict:** PASS\n",
            "utf-8",
          );
          writeQAReview(dir, "deterministic");
        }

        return { exitCode: 0, stdout: "", stats: {} };
      },
    };
  }

  it("keeps concurrent PRD runs inside their separate reserved pools", async () => {
    async function runReservedPrd(slug: string, ghIssue: string, prefix: string) {
      const repo = makeRepo();
      const slices: Slice[] = [
        { number: "01", ghIssue, title: "Reserved migration", type: "AFK", blockedBy: [], userStories: "" },
      ];
      const setup = setupWave(repo, slug, slices, new Map<string, SliceFixture>());
      const prompts: string[] = [];
      setup.config.provider = buildManifestProvider(slices, prompts);
      setup.config.manifest = {
        version: 1,
        selectedSlices: ["01"],
        migrationPrefixes: [prefix],
        protectedIssues: [],
      };

      const { outcomes } = await runWave({
        waveNumber: 1,
        readyIds: [ghIssue],
        config: setup.config,
        dag: setup.dag,
        logger: setup.logger,
        featBranch: setup.featBranch,
        relevantFilesBlock: "- README.md",
        testCommand: "pnpm test",
        mergeMutex: makeAsyncMutex(),
      });

      return { ...setup, outcomes, prompts, repo };
    }

    const [first, second] = await Promise.all([
      runReservedPrd("reserved-prd-a", "2101", "144"),
      runReservedPrd("reserved-prd-b", "2201", "200"),
    ]);

    expect(first.outcomes.get("2101")?.phase).toBe("PASS");
    expect(second.outcomes.get("2201")?.phase).toBe("PASS");
    expect(first.prompts[0]).toContain("RESERVED_PREFIX");
    expect(second.prompts[0]).toContain("RESERVED_PREFIX");
    expect(first.prompts.some((prompt) => prompt.includes("owns exactly: 144"))).toBe(true);
    expect(second.prompts.some((prompt) => prompt.includes("owns exactly: 200"))).toBe(true);

    git(first.repo, ["checkout", first.featBranch]);
    git(second.repo, ["checkout", second.featBranch]);
    expect(existsSync(join(first.repo, "supabase", "migrations", "144_issue_2101.sql"))).toBe(true);
    expect(existsSync(join(first.repo, "supabase", "migrations", "200_issue_2101.sql"))).toBe(false);
    expect(existsSync(join(second.repo, "supabase", "migrations", "200_issue_2201.sql"))).toBe(true);
    expect(existsSync(join(second.repo, "supabase", "migrations", "144_issue_2201.sql"))).toBe(false);
  }, 90_000);

  it("sends a colliding contract back to the planner with the free prefix, then passes", async () => {
    const repo = makeRepo();
    const slices: Slice[] = [
      { number: "01", ghIssue: "2001", title: "Adds a migration", type: "AFK", blockedBy: [], userStories: "" },
    ];
    const { config, dag, logger, featBranch } = setupWave(
      repo,
      "wave-gate-collision",
      slices,
      new Map<string, SliceFixture>(),
    );
    // The feature branch already owns prefix 003 under another name.
    addMigrationToFeatBranch(
      repo,
      featBranch,
      "supabase/migrations/003_users.sql",
    );

    const plannerPrompts: string[] = [];
    config.provider = buildPlannerProvider({
      slices,
      plannerPrompts,
      // Round 1 collides on 003; the planner then obeys the objection.
      pathForRound: (_id, round) =>
        round === 1
          ? "supabase/migrations/003_orders.sql"
          : "supabase/migrations/004_orders.sql",
    });

    const { outcomes } = await runWave({
      waveNumber: 1,
      readyIds: ["2001"],
      config,
      dag,
      logger,
      featBranch,
      relevantFilesBlock: "- README.md",
      testCommand: "pnpm test",
      mergeMutex: makeAsyncMutex(),
    });

    // The renumbered slice merged normally: one contract round bought
    // the correction and no generation was wasted.
    expect(outcomes.get("2001")?.phase).toBe("PASS");

    // The gate refused round 1, so the planner ran again.
    expect(plannerPrompts).toHaveLength(2);
    // The second prompt named the colliding prefix and the next free
    // one — a mechanical correction rather than a puzzle.
    expect(plannerPrompts[1]).toContain("003");
    expect(plannerPrompts[1]).toContain("004");
    expect(plannerPrompts[1]).toMatch(/pipeline REJECTED/i);

    // Observable in the event stream, under one warn reason.
    const refusals = readEvents(logger.runDir).filter(
      (e) => e.type === "warn" && e.reason === "contract-lock-refused",
    );
    expect(refusals).toHaveLength(1);
    expect(refusals[0]!.ghIssue).toBe("2001");
    expect(String(refusals[0]!.message)).toContain("004");

    // The renumbered migration is what landed on the feature branch.
    git(repo, ["checkout", featBranch]);
    expect(
      existsSync(join(repo, "supabase", "migrations", "004_orders.sql")),
    ).toBe(true);
    expect(
      existsSync(join(repo, "supabase", "migrations", "003_orders.sql")),
    ).toBe(false);
  }, 240_000);

  it("requires a fresh planner response after an acceptance-manifest lock refusal", async () => {
    const repo = makeRepo();
    const slices: Slice[] = [
      { number: "01", ghIssue: "2002", title: "Machine-declared migration", type: "AFK", blockedBy: [], userStories: "" },
    ];
    const { config, dag, logger, featBranch } = setupWave(
      repo,
      "wave-gate-manifest-source",
      slices,
      new Map<string, SliceFixture>(),
    );
    addMigrationToFeatBranch(
      repo,
      featBranch,
      "db/migrations/003_users.sql",
    );
    config.maxContractRounds = 2;

    const plannerPrompts: string[] = [];
    const evaluatorPrompts: string[] = [];
    config.provider = buildPlannerProvider({
      slices,
      plannerPrompts,
      evaluatorPrompts,
      writeRound2Response: false,
      writeStaleResponseAfterRound1: true,
      pathForRound: () => "src/prose-only.ts",
      manifestPathForRound: () => "db/migrations/003_orders.sql",
    });

    const { outcomes } = await runWave({
      waveNumber: 1,
      readyIds: ["2002"],
      config,
      dag,
      logger,
      featBranch,
      relevantFilesBlock: "- README.md",
      testCommand: "pnpm test",
      mergeMutex: makeAsyncMutex(),
    });

    const outcome = outcomes.get("2002");
    expect(outcome?.phase).toBe("ERROR");
    expect(outcome?.phase === "ERROR" ? outcome.error : "").toMatch(
      /contract-response\.json is missing/,
    );
    expect(plannerPrompts).toHaveLength(2);
    expect(plannerPrompts[1]).toContain("003");
    expect(evaluatorPrompts).toHaveLength(1);
    expect(existsSync(join(repo, "src", "prose-only.ts"))).toBe(false);
  }, 240_000);

  it("does not flag a contract re-touching a migration it already owns", async () => {
    const repo = makeRepo();
    const slices: Slice[] = [
      { number: "01", ghIssue: "2011", title: "Edits its own migration", type: "AFK", blockedBy: [], userStories: "" },
    ];
    const { config, dag, logger, featBranch } = setupWave(
      repo,
      "wave-gate-same-file",
      slices,
      new Map<string, SliceFixture>(),
    );
    const owned = "supabase/migrations/003_users.sql";
    addMigrationToFeatBranch(repo, featBranch, owned);

    const plannerPrompts: string[] = [];
    config.provider = buildPlannerProvider({
      slices,
      plannerPrompts,
      // Same prefix and same filename: the slice is editing the
      // migration already there, which collides with nothing.
      pathForRound: () => owned,
    });

    const { outcomes } = await runWave({
      waveNumber: 1,
      readyIds: ["2011"],
      config,
      dag,
      logger,
      featBranch,
      relevantFilesBlock: "- README.md",
      testCommand: "pnpm test",
      mergeMutex: makeAsyncMutex(),
    });

    expect(outcomes.get("2011")?.phase).toBe("PASS");
    // One planner round: the gate never fired.
    expect(plannerPrompts).toHaveLength(1);
    expect(
      readEvents(logger.runDir).filter(
        (e) => e.type === "warn" && e.reason === "contract-lock-refused",
      ),
    ).toEqual([]);
  }, 240_000);

  it("leaves a slice declaring no migration files alone", async () => {
    const repo = makeRepo();
    const slices: Slice[] = [
      { number: "01", ghIssue: "2021", title: "No migrations", type: "AFK", blockedBy: [], userStories: "" },
    ];
    const { config, dag, logger, featBranch } = setupWave(
      repo,
      "wave-gate-no-migrations",
      slices,
      new Map<string, SliceFixture>(),
    );
    // A migration exists on the tip; this slice just does not declare one.
    addMigrationToFeatBranch(
      repo,
      featBranch,
      "supabase/migrations/003_users.sql",
    );

    const plannerPrompts: string[] = [];
    config.provider = buildPlannerProvider({
      slices,
      plannerPrompts,
      pathForRound: () => "src/app.ts",
    });

    const { outcomes } = await runWave({
      waveNumber: 1,
      readyIds: ["2021"],
      config,
      dag,
      logger,
      featBranch,
      relevantFilesBlock: "- README.md",
      testCommand: "pnpm test",
      mergeMutex: makeAsyncMutex(),
    });

    expect(outcomes.get("2021")?.phase).toBe("PASS");
    expect(plannerPrompts).toHaveLength(1);
  }, 240_000);

  it("escalates when the contract rounds run out on an unresolved collision", async () => {
    const repo = makeRepo();
    const slices: Slice[] = [
      { number: "01", ghIssue: "2031", title: "Will not renumber", type: "AFK", blockedBy: [], userStories: "" },
    ];
    const { config, dag, logger, featBranch } = setupWave(
      repo,
      "wave-gate-escalate",
      slices,
      new Map<string, SliceFixture>(),
    );
    addMigrationToFeatBranch(
      repo,
      featBranch,
      "supabase/migrations/003_users.sql",
    );
    config.maxContractRounds = 2;

    const plannerPrompts: string[] = [];
    config.provider = buildPlannerProvider({
      slices,
      plannerPrompts,
      // The planner never takes the correction.
      pathForRound: () => "supabase/migrations/003_orders.sql",
    });

    const { outcomes } = await runWave({
      waveNumber: 1,
      readyIds: ["2031"],
      config,
      dag,
      logger,
      featBranch,
      relevantFilesBlock: "- README.md",
      testCommand: "pnpm test",
      mergeMutex: makeAsyncMutex(),
    });

    // Escalation through the ordinary unresolvable-contract path, not a
    // new outcome: a gate refusal spends rounds like any other revision,
    // and earns no cap extension for a correction it declined twice.
    expect(outcomes.get("2031")?.phase).toBe("ESCALATE");
    expect(plannerPrompts).toHaveLength(2);
    // Nothing was generated: the slice never reached Phase B.
    expect(
      existsSync(join(repo, "supabase", "migrations", "003_orders.sql")),
    ).toBe(false);

    // The escalated slice says why. Without the objection in stuck.md the
    // operator sees a contract that the evaluator ACCEPTed twice and no
    // trace of what refused it.
    const stuck = readFileSync(
      join(repo, ".afk", "artifacts", "wave-gate-escalate-stub", "slice-01", "stuck.md"),
      "utf-8",
    );
    expect(stuck).toContain("contract-lock gate");
    expect(stuck).toContain("003");
    expect(stuck).toContain("004");
    expect(stuck).not.toContain("Exhaustion classification:");
    expect(
      existsSync(
        join(
          repo,
          ".afk",
          "artifacts",
          "wave-gate-escalate-stub",
          "slice-01",
          "contract-negotiation-outcome.json",
        ),
      ),
    ).toBe(false);
  }, 240_000);

  it("still refuses at the merge mutex when the generator collides but the contract did not", async () => {
    const repo = makeRepo();
    const slices: Slice[] = [
      { number: "01", ghIssue: "2041", title: "Generator went off-contract", type: "AFK", blockedBy: [], userStories: "" },
    ];
    const { config, dag, logger, featBranch } = setupWave(
      repo,
      "wave-gate-merge-authority",
      slices,
      new Map<string, SliceFixture>(),
    );
    addMigrationToFeatBranch(
      repo,
      featBranch,
      "supabase/migrations/003_users.sql",
    );

    const plannerPrompts: string[] = [];
    config.provider = buildPlannerProvider({
      slices,
      plannerPrompts,
      // The contract is clean, so the contract-lock gate has nothing to say.
      pathForRound: () => "supabase/migrations/004_orders.sql",
      // The generator writes a colliding file anyway. Only a check
      // atomic with the merge can catch that, which is why the
      // merge-mutex check stays exactly where it is.
      generatorPath: () => "supabase/migrations/003_orders.sql",
    });

    const { outcomes } = await runWave({
      waveNumber: 1,
      readyIds: ["2041"],
      config,
      dag,
      logger,
      featBranch,
      relevantFilesBlock: "- README.md",
      testCommand: "pnpm test",
      mergeMutex: makeAsyncMutex(),
    });

    expect(plannerPrompts).toHaveLength(1);
    const outcome = outcomes.get("2041");
    expect(outcome?.phase).toBe("MERGE-PENDING");
    if (outcome?.phase === "MERGE-PENDING") {
      expect(outcome.collidingPrefixes).toEqual(["003"]);
      expect(outcome.error).toMatch(/Migration prefix collision: 003/);
    }
  }, 240_000);

  it("gates a contract left LOCKED on disk by an earlier run", async () => {
    const repo = makeRepo();
    const slices: Slice[] = [
      { number: "01", ghIssue: "2051", title: "Preseeded contract", type: "AFK", blockedBy: [], userStories: "" },
    ];
    const slug = "wave-gate-prior-lock";
    const { config, dag, logger, featBranch } = setupWave(
      repo,
      slug,
      slices,
      new Map<string, SliceFixture>(),
    );

    // A LOCKED contract naming prefix 003, plus the 003 the feature
    // branch already owns. Committing the contract onto the feature
    // branch is how it reaches the slice worktree: the worktree is cut
    // from that branch, so negotiation starts with the contract already
    // on disk — exactly the state an interrupted earlier run leaves.
    const sliceDir = `.kiro/specs/${slug}/slices/01-preseeded-contract`;
    commitToFeatBranch(repo, featBranch, {
      "supabase/migrations/003_users.sql": "-- existing\n",
      [`${sliceDir}/contract.md`]:
        "# Slice Contract\n\n**Status:** LOCKED\n\n## Files expected to change\n- supabase/migrations/003_orders.sql\n",
      [`${sliceDir}/acceptance-manifest.json`]: JSON.stringify({
        version: 2,
        fileScope: {
          kind: "paths",
          paths: ["supabase/migrations/003_orders.sql"],
        },
        migrationCount: 1,
        behaviors: [
          {
            id: "B-01",
            source: "wave fixture",
            given: "a contract left LOCKED by an earlier run",
            when: "this run negotiates the slice",
            then: "the prefix gate, not the behavior lock, decides",
            observableResult: "negotiation reopens on the collision",
            preservation: false,
            gateIds: ["tests"],
          },
        ],
      }),
    });

    const plannerPrompts: string[] = [];
    config.provider = buildPlannerProvider({
      slices,
      plannerPrompts,
      pathForRound: () => "supabase/migrations/004_orders.sql",
    });

    const { outcomes } = await runWave({
      waveNumber: 1,
      readyIds: ["2051"],
      config,
      dag,
      logger,
      featBranch,
      relevantFilesBlock: "- README.md",
      testCommand: "pnpm test",
      mergeMutex: makeAsyncMutex(),
    });

    expect(outcomes.get("2051")?.phase).toBe("PASS");

    // The whole point: negotiation would otherwise have skipped the
    // planner entirely and carried the stale colliding contract into
    // generation. The gate reopened it, so the planner ran once.
    expect(plannerPrompts).toHaveLength(1);
    expect(plannerPrompts[0]).toMatch(/pipeline REJECTED/i);

    // Announced as a refusal by a previous run's lock, not by a round
    // this run never ran.
    const refusals = readEvents(logger.runDir).filter(
      (e) => e.type === "warn" && e.reason === "contract-lock-refused",
    );
    expect(refusals).toHaveLength(1);

    // The renumbered migration is what landed; the stale one never existed.
    git(repo, ["checkout", featBranch]);
    expect(
      existsSync(join(repo, "supabase", "migrations", "004_orders.sql")),
    ).toBe(true);
    expect(
      existsSync(join(repo, "supabase", "migrations", "003_orders.sql")),
    ).toBe(false);
  }, 240_000);

  it.each([
    ["missing", null, /acceptance-manifest\.json is missing/],
    ["malformed", "{", /not valid JSON/],
  ])(
    "reopens a prior LOCKED contract with a %s companion manifest before evaluation",
    async (_case, manifestContent, expectedDefect) => {
      const repo = makeRepo();
      const slices: Slice[] = [
        { number: "01", ghIssue: "2052", title: "Invalid prior lock", type: "AFK", blockedBy: [], userStories: "" },
      ];
      const slug = `wave-prior-lock-${_case}`;
      const { config, dag, logger, featBranch } = setupWave(
        repo,
        slug,
        slices,
        new Map<string, SliceFixture>(),
      );
      config.maxContractRounds = 2;
      const sliceDir = `.kiro/specs/${slug}/slices/01-invalid-prior-lock`;
      const seeded: Record<string, string> = {
        [`${sliceDir}/contract.md`]:
          "# Slice Contract\n\n**Status:** LOCKED\n\n## Files expected to change\n- src/x.ts\n",
      };
      if (manifestContent !== null) {
        seeded[`${sliceDir}/acceptance-manifest.json`] = manifestContent;
      }
      commitToFeatBranch(repo, featBranch, seeded);

      const plannerPrompts: string[] = [];
      let evaluatorInvocations = 0;
      let generatorInvocations = 0;
      config.provider = {
        name: "stub",
        async invoke(options: InvokeOptions): Promise<InvokeResult> {
          const dir = findSliceArtifactDir(options.cwd, "01");
          if (options.role === "explorer" && dir) {
            writeFileSync(join(dir, "context.md"), "# Context\n", "utf-8");
          } else if (options.role === "planner") {
            plannerPrompts.push(options.prompt);
          } else if (options.role === "evaluator-contract") {
            evaluatorInvocations++;
          } else if (options.role === "generator") {
            generatorInvocations++;
          }
          return { exitCode: 0, stdout: "", stats: {} };
        },
      };

      const { outcomes } = await runWave({
        waveNumber: 1,
        readyIds: ["2052"],
        config,
        dag,
        logger,
        featBranch,
        relevantFilesBlock: "- README.md",
        testCommand: "pnpm test",
        mergeMutex: makeAsyncMutex(),
      });

      expect(outcomes.get("2052")?.phase).toBe("ESCALATE");
      expect(plannerPrompts).toHaveLength(2);
      expect(plannerPrompts[0]).toMatch(expectedDefect);
      expect(evaluatorInvocations).toBe(0);
      expect(generatorInvocations).toBe(0);
      const archivedContract = readFileSync(
        join(
          repo,
          ".afk",
          "artifacts",
          `${slug}-stub`,
          "slice-01",
          "contract.md",
        ),
        "utf-8",
      );
      expect(archivedContract).toMatch(/^\*\*Status:\*\*\s*NEGOTIATING$/m);
    },
    240_000,
  );
});

/**
 * Deferred merge (ADR 0029). The merge-mutex migration-prefix check is
 * unchanged and stays where it is; what changed is that its refusal is no
 * longer terminal. These drive `runWave` the way the rest of this file
 * does — a real temporary git repo plus per-slice fixtures — and assert
 * the outcome an operator sees.
 */
describe("runWave migration prefix collision → MERGE-PENDING", () => {
  /** Put a migration on `main` so the feature branch inherits it. */
  function seedMigrationOnMain(repo: string, filename: string) {
    mkdirSync(join(repo, "supabase", "migrations"), { recursive: true });
    writeFileSync(
      join(repo, "supabase", "migrations", filename),
      "-- seeded\n",
      "utf-8",
    );
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", `add ${filename}`]);
  }

  it("records MERGE-PENDING with the colliding prefixes and preserves the slice branch", async () => {
    const repo = makeRepo();
    seedMigrationOnMain(repo, "042_users.sql");
    const slices: Slice[] = [
      { number: "01", ghIssue: "601", title: "Adds orders", type: "AFK", blockedBy: [], userStories: "" },
    ];
    // Same numeric prefix, different filename — the integration-time
    // schema-ordering collision, detected against the feature-branch tip.
    const fixtures = new Map<string, SliceFixture>([
      ["601", {
        files: ["supabase/migrations/043_orders.sql"],
        qaPasses: true,
        outputFile: "supabase/migrations/042_orders.sql",
        outputContent: "-- orders",
      }],
    ]);
    const { config, dag, logger, featBranch, provider } = setupWave(
      repo,
      "wave-merge-pending",
      slices,
      fixtures,
    );

    const { outcomes } = await runWave({
      waveNumber: 1,
      readyIds: ["601"],
      config,
      dag,
      logger,
      featBranch,
      relevantFilesBlock: "- README.md",
      testCommand: "pnpm test",
      mergeMutex: makeAsyncMutex(),
    });

    const outcome = outcomes.get("601");
    expect(outcome?.phase).toBe("MERGE-PENDING");
    if (outcome?.phase !== "MERGE-PENDING") throw new Error("expected MERGE-PENDING");
    expect(outcome.collidingPrefixes).toEqual(["042"]);
    expect(outcome.error).toContain("042");
    expect(outcome.error).toContain("retries the merge");

    // The whole point: the work survived. The branch still exists and
    // still carries the commits the merge refused.
    const branch = sliceBranch("wave-merge-pending", slices[0]!, provider);
    expect(gitModule.branchExists(repo, branch)).toBe(true);
    expect(gitModule.hasCommitsAhead(repo, branch, featBranch)).toBe(true);
    // …and nothing landed on the feature branch.
    expect(
      gitModule.listMigrationFiles(repo, featBranch),
    ).toEqual(["042_users.sql"]);
  }, 240_000);

  it("still records CONFLICT for a real git merge conflict", async () => {
    const repo = makeRepo();
    const slices: Slice[] = [
      { number: "01", ghIssue: "611", title: "Alpha", type: "AFK", blockedBy: [], userStories: "" },
      { number: "02", ghIssue: "612", title: "Beta", type: "AFK", blockedBy: [], userStories: "" },
    ];
    // Disjoint declared files → separate lanes → both generate from the
    // same base; both add the same untracked path with different content,
    // so whichever merges second hits a real add/add conflict. No
    // migrations anywhere near it.
    const fixtures = new Map<string, SliceFixture>([
      ["611", { files: ["src/alpha.txt"], qaPasses: true, outputFile: "src/clash.txt", outputContent: "from alpha" }],
      ["612", { files: ["src/beta.txt"], qaPasses: true, outputFile: "src/clash.txt", outputContent: "from beta" }],
    ]);
    const { config, dag, logger, featBranch } = setupWave(
      repo,
      "wave-real-conflict",
      slices,
      fixtures,
    );

    const { outcomes } = await runWave({
      waveNumber: 1,
      readyIds: ["611", "612"],
      config,
      dag,
      logger,
      featBranch,
      relevantFilesBlock: "- README.md",
      testCommand: "pnpm test",
      mergeMutex: makeAsyncMutex(),
    });

    const phases = ["611", "612"].map((id) => outcomes.get(id)?.phase).sort();
    expect(phases).toEqual(["CONFLICT", "PASS"]);
  }, 240_000);

  it("continues the lane past a MERGE-PENDING member", async () => {
    const repo = makeRepo();
    seedMigrationOnMain(repo, "042_users.sql");
    const slices: Slice[] = [
      { number: "01", ghIssue: "621", title: "Collides", type: "AFK", blockedBy: [], userStories: "" },
      { number: "02", ghIssue: "622", title: "Lane mate", type: "AFK", blockedBy: [], userStories: "" },
    ];
    // Shared declared file → one lane, 621 ahead of 622.
    const fixtures = new Map<string, SliceFixture>([
      ["621", {
        files: ["src/lane.txt", "supabase/migrations/043_orders.sql"],
        qaPasses: true,
        outputFile: "supabase/migrations/042_orders.sql",
        outputContent: "-- orders",
      }],
      ["622", { files: ["src/lane.txt"], qaPasses: true, outputFile: "src/lane.txt", outputContent: "lane mate" }],
    ]);
    const { config, dag, logger, featBranch } = setupWave(
      repo,
      "wave-merge-pending-lane",
      slices,
      fixtures,
    );

    const { outcomes } = await runWave({
      waveNumber: 1,
      readyIds: ["621", "622"],
      config,
      dag,
      logger,
      featBranch,
      relevantFilesBlock: "- README.md",
      testCommand: "pnpm test",
      mergeMutex: makeAsyncMutex(),
    });

    expect(outcomes.get("621")?.phase).toBe("MERGE-PENDING");
    expect(outcomes.get("622")?.phase).toBe("PASS");
  }, 240_000);
});

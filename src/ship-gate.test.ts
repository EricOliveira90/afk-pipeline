import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmDirWithRetry } from "./test-support.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InvokeOptions, InvokeResult } from "./agent-provider.js";
import type { SanityCommandRunner } from "./preship.js";
import type { RunEventPayload } from "./run-events.js";
import { loadRunState } from "./run-state.js";
import {
  appendCompletedGuardianRound,
} from "./guardian-round-persistence.js";
import {
  buildPrCreationPlan,
  detectReviewWorktreeDrift,
  formatReviewWorktreeDrift,
  restoreCapturedReviewArtifacts,
  runShipGate,
  type RunShipGateArgs,
  type ShipCommandRunner,
  type ShipGateJournal,
} from "./ship-gate.js";
import { readMutationStepOutcome } from "./logger.js";
import {
  formatMutationReportLines,
  MUTATION_REPORT_HEADING,
  MUTATION_STEP_BOUND_MS,
} from "./mutation-report.js";
import { quiesceWorktree } from "./worktree-processes.js";

/**
 * The one termination path the mutation step uses (#303 B-11/B-12) calls
 * through to the real implementation; the spy exists only so a test can see
 * *that* it was called, and on which worktree. Every other export stays real,
 * so no other test in this file changes behavior.
 */
vi.mock("./worktree-processes.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./worktree-processes.js")>();
  return { ...actual, quiesceWorktree: vi.fn(actual.quiesceWorktree) };
});

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmDirWithRetry(tempDirs.pop()!);
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "afk-ship-gate-"));
  tempDirs.push(repo);
  git(repo, ["init", "-b", "main"]);
  writeFileSync(join(repo, ".gitignore"), ".afk/\n", "utf-8");
  writeFileSync(join(repo, "README.md"), "fixture\n", "utf-8");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "fixture"]);
  return repo;
}

interface JournalFixture {
  journal: ShipGateJournal;
  event: ReturnType<typeof vi.fn>;
  phase: ReturnType<typeof vi.fn>;
  setReviewOutcomes: ReturnType<typeof vi.fn>;
  setPrOverrideNote: ReturnType<typeof vi.fn>;
  setPrUrl: ReturnType<typeof vi.fn>;
}

function makeJournal(): JournalFixture {
  const logDir = mkdtempSync(join(tmpdir(), "afk-ship-logs-"));
  tempDirs.push(logDir);
  const event = vi.fn();
  const phase = vi.fn();
  const setReviewOutcomes = vi.fn();
  const setPrOverrideNote = vi.fn();
  const setPrUrl = vi.fn();
  return {
    event,
    phase,
    setReviewOutcomes,
    setPrOverrideNote,
    setPrUrl,
    journal: {
      // The gate reads this run's `events.jsonl` for advisory gate outcomes
      // (#86 B-02); this fixture writes none, so the block stays absent.
      runDir: logDir,
      agentLog(sliceId, agent, round) {
        const suffix = round == null ? "" : `-${round}`;
        return createWriteStream(
          join(logDir, `${sliceId}-${agent}${suffix}.log`),
        );
      },
      event,
      phase,
      setPrOverrideNote,
      setPrUrl,
      setReviewOutcomes,
      setSanityGate: vi.fn(),
    },
  };
}

function writeReview(
  options: InvokeOptions,
  slug: string,
  kind: "architect" | "pm",
  verdict: string,
  architectAuthority: {
    reachableTrigger: string | null;
    introducedByReviewedDiff: boolean;
  } = {
    reachableTrigger:
      "A normal pipeline retry consumes the invalid state.",
    introducedByReviewedDiff: true,
  },
): void {
  const dir = join(options.cwd, ".kiro", "specs", slug);
  mkdirSync(dir, { recursive: true });
  const findings =
    verdict === "SHIP"
      ? []
      : [
          {
            id: kind === "architect" ? "A-01" : "P-01",
            title: `${kind} finding`,
            class: kind === "architect" ? "INTEGRITY" : "PRODUCT",
            clearCondition: `Clear the ${kind} finding.`,
            disposition: "OPEN",
            ...(kind === "architect"
              ? architectAuthority
              : {}),
          },
        ];
  writeFileSync(
    join(dir, `review-${kind}.md`),
    [
      "# Guardian Review",
      "",
      `**Verdict:** ${verdict}`,
      "",
      `## Structured findings (v${kind === "architect" ? 2 : 1})`,
      JSON.stringify({
        version: kind === "architect" ? 2 : 1,
        findings,
      }),
      "",
    ].join("\n"),
    "utf-8",
  );
}

function invokeResult(): InvokeResult {
  return { exitCode: 0, stdout: "", stats: {} };
}

function makeArgs(
  repo: string,
  slug: string,
  journal: ShipGateJournal,
  invoke: RunShipGateArgs["invoke"],
  runCommand: ShipCommandRunner,
): RunShipGateArgs {
  return {
    repoRoot: repo,
    reviewDir: repo,
    featureBranch: `feat/${slug}`,
    defaultBranch: "main",
    prdSlug: slug,
    runSlug: slug,
    specsDir: `.kiro/specs/${slug}`,
    relevantFilesBlock: "(none)",
    reviewScope: "Selected slices only.",
    closesIssues: ["42"],
    invoke,
    journal,
    options: {
      reviewRetries: 1,
      reviewIdleTimeoutMs: 600_000,
      reviewIdleWarningIntervalMs: 30_000,
      serialReviews: true,
      openPrOnOverride: false,
    },
    runCommand,
  };
}

describe("buildPrCreationPlan adoption provenance", () => {
  it("identifies each adopted slice and records its full provenance", () => {
    const plan = buildPrCreationPlan({
      prdSlug: "demo",
      specsDir: ".kiro/specs/demo",
      architect: "SHIP",
      pm: "SHIP",
      openPrOnOverride: false,
      closesIssues: ["129", "130"],
      adoptions: [
        {
          ghIssue: "129",
          adopter: "Ada Lovelace",
          reason: "finished the slice manually",
          branch: "manual/demo-01",
          commit: "abc123",
        },
      ],
    });

    expect(plan.body).toContain("## Adopted Slices");
    expect(plan.body).toContain("#129");
    expect(plan.body).toContain("Ada Lovelace");
    expect(plan.body).toContain("finished the slice manually");
    expect(plan.body).toContain("manual/demo-01");
    expect(plan.body).toContain("abc123");
    expect(plan.body).not.toContain("#130\n- Adopter:");
  });

  it("[behavior:B-02] reports advisory gates in the PR body, above the closes list, and omits the section when none ran", () => {
    const withAdvisory = buildPrCreationPlan({
      prdSlug: "demo",
      specsDir: ".kiro/specs/demo",
      architect: "SHIP",
      pm: "SHIP",
      openPrOnOverride: false,
      closesIssues: ["86"],
      adoptions: [],
      advisoryGates: [
        {
          ghIssue: "86",
          sliceNumber: "05",
          round: 2,
          gateId: "test:budgets",
          status: "FAIL (COMMAND)",
          durationMs: 300,
        },
      ],
    });

    expect(withAdvisory.body).toContain(
      "## Advisory gates (reported, never blocking)",
    );
    // The row is reported with its real red status: hiding it would defeat the
    // point of running the gate, and blocking on it would defeat ADR 0063.
    expect(withAdvisory.body).toContain(
      "| #86 | 2 | test:budgets | FAIL (COMMAND) | 300ms |",
    );
    expect(withAdvisory.body).toContain("ADR 0063");
    expect(
      withAdvisory.body.indexOf("## Advisory gates (reported, never blocking)"),
    ).toBeLessThan(withAdvisory.body.indexOf("Closes #86"));

    // A run with no advisory gate has no such section, so an opted-out
    // project's PR body is byte-for-byte today's.
    const without = buildPrCreationPlan({
      prdSlug: "demo",
      specsDir: ".kiro/specs/demo",
      architect: "SHIP",
      pm: "SHIP",
      openPrOnOverride: false,
      closesIssues: ["86"],
      adoptions: [],
      advisoryGates: [],
    });
    expect(without.body).not.toContain("Advisory gates");
    expect(without.body).toBe(
      buildPrCreationPlan({
        prdSlug: "demo",
        specsDir: ".kiro/specs/demo",
        architect: "SHIP",
        pm: "SHIP",
        openPrOnOverride: false,
        closesIssues: ["86"],
        adoptions: [],
      }).body,
    );
  });

  it("[behavior:#97:B-11] reports what each post-approval quality stage cost, above the closes list", () => {
    const withStages = buildPrCreationPlan({
      prdSlug: "demo",
      specsDir: ".kiro/specs/demo",
      architect: "SHIP",
      pm: "SHIP",
      openPrOnOverride: false,
      closesIssues: ["97"],
      adoptions: [],
      qualityStages: [
        {
          ghIssue: "97",
          sliceNumber: "03",
          stage: "cleaner",
          enabled: true,
          outcome: "PASS",
          roundsUsed: 2,
          roundLimit: 3,
          elapsedMs: 4_200,
          modelMs: 1_800,
          gateIds: ["clean:format", "scope"],
          cacheReusedGateIds: ["scope"],
          finalDecision: "evaluate",
        },
      ],
    });

    expect(withStages.body).toContain(
      "## Post-approval quality stages (reported, never blocking)",
    );
    expect(withStages.body).toContain(
      "| #97 | cleaner | yes | PASS | 2/3 | 4200ms | 1800ms | " +
        "clean:format, scope | scope | evaluate |",
    );
    // Reported, never a gate: the section says so, for the same reason the
    // advisory-gate block above does.
    expect(withStages.body).toContain("ADR 0063");
    expect(
      withStages.body.indexOf("## Post-approval quality stages"),
    ).toBeLessThan(withStages.body.indexOf("Closes #97"));
  });

  it("[behavior:#97:B-11] renders the section even when every stage is disabled, and none when the field is absent", () => {
    // An empty array is a measured run that recorded no attempt — a PR that
    // said nothing about the cleaner could not be read as evidence of either
    // state (PRD D10 item 3).
    const disabled = buildPrCreationPlan({
      prdSlug: "demo",
      specsDir: ".kiro/specs/demo",
      architect: "SHIP",
      pm: "SHIP",
      openPrOnOverride: false,
      closesIssues: ["97"],
      adoptions: [],
      qualityStages: [],
    });
    expect(disabled.body).toContain(
      "`cleaner`: disabled (no `gatePolicy.clean`)",
    );

    // The field being *absent* is the different claim — this caller measures
    // nothing — so a project that declares no policy keeps its PR body.
    const without = buildPrCreationPlan({
      prdSlug: "demo",
      specsDir: ".kiro/specs/demo",
      architect: "SHIP",
      pm: "SHIP",
      openPrOnOverride: false,
      closesIssues: ["97"],
      adoptions: [],
    });
    expect(without.body).not.toContain("Post-approval quality stages");
  });
});

describe("runShipGate", () => {
  it("B-04 downgrades an unauthorized architect blocker and retains its finding", async () => {
    const repo = makeRepo();
    const slug = "architect-authority-floor";
    const fixture = makeJournal();
    const invoke = vi.fn(async (options: InvokeOptions) => {
      const kind = options.role === "architect-review" ? "architect" : "pm";
      writeReview(
        options,
        slug,
        kind,
        kind === "architect" ? "FIX-BEFORE-SHIP" : "SHIP",
        {
          reachableTrigger: null,
          introducedByReviewedDiff: false,
        },
      );
      return invokeResult();
    });
    const runCommand = vi.fn<ShipCommandRunner>((command, args) =>
      command === "gh" && args[1] === "create"
        ? "https://github.com/acme/repo/pull/42\n"
        : "",
    );

    const result = await runShipGate(
      makeArgs(repo, slug, fixture.journal, invoke, runCommand),
    );

    expect(result.verdict).toBe("SHIP");
    expect(fixture.setReviewOutcomes).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "ACCEPT-WITH-NOTES",
        findings: [
          expect.objectContaining({
            id: "A-01",
            reachableTrigger: null,
            introducedByReviewedDiff: false,
          }),
        ],
      }),
      expect.objectContaining({ outcome: "SHIP" }),
    );
    expect(
      loadRunState(repo, slug).reviewPhase?.rounds?.[0]?.architect,
    ).toMatchObject({
      source: "INVOKED",
      outcome: "ACCEPT-WITH-NOTES",
      findings: [
        {
          stableId: "A-01",
          currentId: "A-01",
          title: "architect finding",
          class: "INTEGRITY",
          clearCondition: "Clear the architect finding.",
          disposition: "OPEN",
          reachableTrigger: null,
          introducedByReviewedDiff: false,
        },
      ],
    });
    // Slice #171: with no ledger this is round 1, so the architect still reads
    // the whole branch against the base.
    const architectPrompt = invoke.mock.calls
      .map(([options]) => options)
      .find((options) => options.role === "architect-review")!.prompt;
    expect(architectPrompt).toContain("review round 1");
    expect(architectPrompt).toContain("git diff main...HEAD");
    expect(architectPrompt).not.toContain("verification round");
  });

  it("P-01 reuses favorable cache entries and records the no-ledger findings fallback", async () => {
    const repo = makeRepo();
    const slug = "cache-hit";
    const fixture = makeJournal();
    const invoke = vi.fn(async () => {
      throw new Error("cached reviews must not invoke guardians");
    });
    const runCommand = vi.fn<ShipCommandRunner>((command, args) => {
      if (command === "gh" && args[1] === "create") {
        return "https://github.com/acme/repo/pull/41\n";
      }
      return "";
    });
    const headSha = git(repo, ["rev-parse", "HEAD"]);
    const treeSha = git(repo, ["rev-parse", "HEAD^{tree}"]);

    const result = await runShipGate({
      ...makeArgs(repo, slug, fixture.journal, invoke, runCommand),
      cachedReviewPhase: {
        sanity: { treeSha, ok: true },
        architect: { headSha, verdict: "SHIP" },
        pm: { headSha, verdict: "ACCEPT-WITH-NOTES" },
      },
    });

    expect(result).toMatchObject({
      verdict: "SHIP",
      pr: {
        requested: true,
        overridden: false,
        url: "https://github.com/acme/repo/pull/41",
        number: 41,
      },
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(
      fixture.phase.mock.calls.some(([message]) =>
        String(message).includes("Reusing cached pre-ship sanity PASS"),
      ),
    ).toBe(true);
    expect(
      fixture.phase.mock.calls.some(([message]) =>
        String(message).includes("Reusing cached architect review verdict SHIP"),
      ),
    ).toBe(true);
    const round = loadRunState(repo, slug).reviewPhase?.rounds?.[0];
    expect(round?.architect).toEqual({
      source: "CACHE",
      outcome: "SHIP",
      findings: [],
      findingsOriginRound: null,
    });
    expect(round?.pm).toEqual({
      source: "CACHE",
      outcome: "ACCEPT-WITH-NOTES",
      findings: [],
      findingsOriginRound: null,
    });
    expect(loadRunState(repo, slug).reviewPhase?.architect).toEqual({
      headSha: round?.headSha,
      verdict: "SHIP",
    });
  });

  it("P-01 copies cache-sourced findings only from matching ledger evidence", async () => {
    const repo = makeRepo();
    const slug = "cache-backed";
    const fixture = makeJournal();
    const invoke = vi.fn(async () => {
      throw new Error("cached reviews must not invoke guardians");
    });
    const runCommand = vi.fn<ShipCommandRunner>((command, args) =>
      command === "gh" && args[1] === "create"
        ? "https://github.com/acme/repo/pull/42\n"
        : "",
    );
    const headSha = git(repo, ["rev-parse", "HEAD"]);
    const treeSha = git(repo, ["rev-parse", "HEAD^{tree}"]);
    const priorFinding = {
      stableId: "A-01",
      currentId: "A-02",
      title: "Backed note",
      class: "INTEGRITY",
      clearCondition: "Retain the evidence.",
      disposition: "OPEN" as const,
      reachableTrigger: null,
      introducedByReviewedDiff: null,
    };
    const cachedReviewPhase = {
      sanity: { treeSha, ok: true as const },
      architect: {
        headSha,
        verdict: "ACCEPT-WITH-NOTES" as const,
      },
      pm: { headSha, verdict: "SHIP" as const },
      rounds: [
        {
          round: 1,
          reviewedHeadSha: "pre-review",
          headSha,
          architect: {
            source: "INVOKED" as const,
            outcome: "ACCEPT-WITH-NOTES" as const,
            findings: [priorFinding],
            findingsOriginRound: 1,
          },
          pm: {
            source: "INVOKED" as const,
            outcome: "SHIP" as const,
            findings: [],
            findingsOriginRound: 1,
          },
        },
      ],
    };
    appendCompletedGuardianRound(repo, slug, cachedReviewPhase);

    await runShipGate({
      ...makeArgs(repo, slug, fixture.journal, invoke, runCommand),
      cachedReviewPhase,
    });

    expect(invoke).not.toHaveBeenCalled();
    const rounds = loadRunState(repo, slug).reviewPhase?.rounds;
    expect(rounds).toHaveLength(2);
    expect(rounds?.[1]?.architect).toEqual({
      source: "CACHE",
      outcome: "ACCEPT-WITH-NOTES",
      findings: [priorFinding],
      findingsOriginRound: 1,
    });
    expect(rounds?.[1]?.pm).toEqual({
      source: "CACHE",
      outcome: "SHIP",
      findings: [],
      findingsOriginRound: 1,
    });
  });

  it("B-02 P-02 persists only final outcomes after infrastructure retry semantics", async () => {
    const repo = makeRepo();
    const slug = "infra-retry";
    const fixture = makeJournal();
    let architectAttempts = 0;
    const invoke = vi.fn(async (options: InvokeOptions) => {
      if (options.role === "architect-review") {
        architectAttempts++;
        if (architectAttempts === 1) {
          throw new Error("wrapper failed before producing output");
        }
        writeReview(options, slug, "architect", "SHIP");
      } else {
        writeReview(options, slug, "pm", "FIX-BEFORE-SHIP");
      }
      return invokeResult();
    });
    const runCommand = vi.fn<ShipCommandRunner>(() => "");

    const result = await runShipGate(
      makeArgs(repo, slug, fixture.journal, invoke, runCommand),
    );

    expect(result.verdict).toBe("BLOCKED");
    expect(architectAttempts).toBe(2);
    expect(runCommand).not.toHaveBeenCalled();
    expect(fixture.setReviewOutcomes).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "SHIP" }),
      expect.objectContaining({ outcome: "FIX-BEFORE-SHIP" }),
    );
    expect(
      fixture.phase.mock.calls.some(([message]) =>
        String(message).includes("Infrastructure retry 1/1"),
      ),
    ).toBe(true);
    const round = loadRunState(repo, slug).reviewPhase?.rounds?.[0];
    expect(round).toMatchObject({
      round: 1,
      architect: {
        source: "INVOKED",
        outcome: "SHIP",
        findings: [],
        findingsOriginRound: 1,
      },
      pm: {
        source: "INVOKED",
        outcome: "FIX-BEFORE-SHIP",
        findingsOriginRound: 1,
      },
    });
    expect(round?.pm.findings).toHaveLength(1);
  });

  it("P-05 opens an override PR without changing the existing decision policy", async () => {
    const repo = makeRepo();
    const slug = "override";
    const fixture = makeJournal();
    const invoke = vi.fn(async (options: InvokeOptions) => {
      writeReview(
        options,
        slug,
        options.role === "architect-review" ? "architect" : "pm",
        options.role === "architect-review" ? "SHIP" : "FIX-BEFORE-SHIP",
      );
      return invokeResult();
    });
    let createBody = "";
    const runCommand = vi.fn<ShipCommandRunner>((command, args) => {
      if (command === "gh" && args[1] === "create") {
        createBody = args[args.indexOf("--body") + 1] ?? "";
        return "https://github.com/acme/repo/pull/52\n";
      }
      return "";
    });
    const args = makeArgs(
      repo,
      slug,
      fixture.journal,
      invoke,
      runCommand,
    );
    args.options.openPrOnOverride = true;

    const result = await runShipGate(args);

    expect(result).toMatchObject({
      verdict: "SHIP",
      pr: {
        requested: true,
        overridden: true,
        url: "https://github.com/acme/repo/pull/52",
        number: 52,
      },
    });
    expect(createBody).toContain("## Human override (--open-pr-on-override)");
    expect(createBody).toContain("PM review: **FIX-BEFORE-SHIP** (overridden)");
    expect(fixture.setPrOverrideNote).toHaveBeenCalledOnce();
  });

  it("opens an override PR for an architect block with a favorable PM", async () => {
    const repo = makeRepo();
    const slug = "architect-override";
    const fixture = makeJournal();
    const invoke = vi.fn(async (options: InvokeOptions) => {
      writeReview(
        options,
        slug,
        options.role === "architect-review" ? "architect" : "pm",
        options.role === "architect-review"
          ? "FIX-BEFORE-SHIP"
          : "ACCEPT-WITH-NOTES",
      );
      return invokeResult();
    });
    let createBody = "";
    const runCommand = vi.fn<ShipCommandRunner>((command, args) => {
      if (command === "gh" && args[1] === "create") {
        createBody = args[args.indexOf("--body") + 1] ?? "";
        return "https://github.com/acme/repo/pull/53\n";
      }
      return "";
    });
    const args = makeArgs(
      repo,
      slug,
      fixture.journal,
      invoke,
      runCommand,
    );
    args.options.openPrOnOverride = true;

    const result = await runShipGate(args);

    expect(result).toMatchObject({
      verdict: "SHIP",
      pr: {
        requested: true,
        overridden: true,
        url: "https://github.com/acme/repo/pull/53",
        number: 53,
      },
    });
    expect(createBody).toContain(
      "Architect review: **FIX-BEFORE-SHIP** (overridden)",
    );
    expect(createBody).toContain("PM review: **ACCEPT-WITH-NOTES**");
    expect(createBody).toContain("review-architect.md");
    expect(fixture.setPrOverrideNote).toHaveBeenCalledOnce();
  });

  it("keeps the PR closed when both guardians block under either override setting", async () => {
    for (const openPrOnOverride of [false, true]) {
      const repo = makeRepo();
      const slug = `both-block-${openPrOnOverride}`;
      const fixture = makeJournal();
      const invoke = vi.fn(async (options: InvokeOptions) => {
        writeReview(
          options,
          slug,
          options.role === "architect-review" ? "architect" : "pm",
          "FIX-BEFORE-SHIP",
        );
        return invokeResult();
      });
      const runCommand = vi.fn<ShipCommandRunner>(() => "");
      const args = makeArgs(
        repo,
        slug,
        fixture.journal,
        invoke,
        runCommand,
      );
      args.options.openPrOnOverride = openPrOnOverride;

      const result = await runShipGate(args);

      expect(result.verdict).toBe("BLOCKED");
      // Slice #173: one unfavorable round is not the cap, so nothing is filed
      // and no exit is taken — `runCommand` never ran means no `gh` at all.
      expect(runCommand).not.toHaveBeenCalled();
      expect(fixture.setPrOverrideNote).not.toHaveBeenCalled();
      expect(result.pr.cappedExit).toBe(false);
      expect(
        loadRunState(repo, slug).reviewPhase?.filedFindings,
      ).toBeUndefined();
      expect(fixture.phase).toHaveBeenCalledWith(
        expect.stringContaining(
          "Guardian round cap not reached — 1 unfavorable round(s) of 3",
        ),
        "log",
      );
    }
  });

  it("recovers an existing PR when draft creation fails", async () => {
    const repo = makeRepo();
    const slug = "existing-pr";
    const fixture = makeJournal();
    const invoke = vi.fn(async (options: InvokeOptions) => {
      writeReview(
        options,
        slug,
        options.role === "architect-review" ? "architect" : "pm",
        "SHIP",
      );
      return invokeResult();
    });
    const runCommand = vi.fn<ShipCommandRunner>((command, args) => {
      if (command === "gh" && args[1] === "create") {
        throw new Error("a pull request already exists");
      }
      if (command === "gh" && args[1] === "view") {
        return JSON.stringify({
          number: 63,
          url: "https://github.com/acme/repo/pull/63",
        });
      }
      return "";
    });

    const result = await runShipGate(
      makeArgs(repo, slug, fixture.journal, invoke, runCommand),
    );

    expect(result).toMatchObject({
      verdict: "SHIP",
      pr: {
        requested: true,
        overridden: false,
        url: "https://github.com/acme/repo/pull/63",
        number: 63,
      },
    });
    expect(fixture.setPrUrl).toHaveBeenCalledWith(
      "https://github.com/acme/repo/pull/63",
    );
  });

  /**
   * Commits a pnpm project whose typecheck script only passes once the
   * dependency install has run — the incident's dependency on `node_modules`,
   * without a registry install.
   */
  function commitSanityProject(repo: string): void {
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({
        name: "fixture",
        scripts: {
          typecheck:
            "node -e \"require('node:fs').accessSync('node_modules/afk-marker')\"",
        },
      }),
      "utf-8",
    );
    writeFileSync(
      join(repo, "pnpm-lock.yaml"),
      "lockfileVersion: '9.0'\n",
      "utf-8",
    );
    writeFileSync(join(repo, ".gitignore"), ".afk/\nnode_modules/\n", "utf-8");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "add sanity scripts"]);
  }

  /**
   * Sanity subprocess seam: the install is stubbed (its effect, or its
   * failure), the steps run for real. No suite pays a registry install
   * (AGENTS.md test loop discipline; ADR 0033).
   */
  function stubSanityRunner(
    ran: string[],
    install: (cwd: string) => { exitCode: number; output?: string },
  ): SanityCommandRunner {
    return (command, args, options) => {
      ran.push([command, ...args].join(" "));
      if (args[0] === "install") {
        const outcome = install(options.cwd);
        return {
          outcome: "EXITED",
          exitCode: outcome.exitCode,
          output: outcome.output,
        };
      }
      try {
        execFileSync(command, [...args], { cwd: options.cwd, stdio: "pipe" });
        return { outcome: "EXITED", exitCode: 0 };
      } catch (error) {
        return {
          outcome: "EXITED",
          exitCode: 1,
          output: error instanceof Error ? error.message : String(error),
        };
      }
    };
  }

  // Regression for #101: the orchestrator hands the ship gate a scratch
  // review worktree (`git worktree add`, fresh checkout, no node_modules).
  // Every sanity command failed instantly and the gate blocked the ship as
  // a code failure on a green branch, skipping guardians and the draft PR.
  it("ships from an uninstalled review worktree by installing dependencies before sanity (#101)", async () => {
    const repo = makeRepo();
    const slug = "uninstalled-worktree";
    commitSanityProject(repo);
    // The exact incident shape: a fresh worktree of the feature branch with
    // no node_modules.
    const reviewDir = mkdtempSync(join(tmpdir(), "afk-review-wt-"));
    tempDirs.push(reviewDir);
    git(repo, ["worktree", "add", "--force", reviewDir, "-b", `feat/${slug}`]);
    expect(existsSync(join(reviewDir, "node_modules"))).toBe(false);

    const fixture = makeJournal();
    const invoke = vi.fn(async (options: InvokeOptions) => {
      writeReview(
        options,
        slug,
        options.role === "architect-review" ? "architect" : "pm",
        options.role === "architect-review" ? "SHIP" : "ACCEPT-WITH-NOTES",
      );
      return invokeResult();
    });
    const runCommand = vi.fn<ShipCommandRunner>((command, args) => {
      if (command === "gh" && args[1] === "create") {
        return "https://github.com/acme/repo/pull/101\n";
      }
      return "";
    });
    const ran: string[] = [];
    const sanityRunCommand = stubSanityRunner(ran, (cwd) => {
      mkdirSync(join(cwd, "node_modules", "afk-marker"), { recursive: true });
      return { exitCode: 0 };
    });

    const result = await runShipGate({
      ...makeArgs(repo, slug, fixture.journal, invoke, runCommand),
      reviewDir,
      sanityRunCommand,
    });

    expect(result.verdict).toBe("SHIP");
    // The install ran first, in the review worktree, and the step that needs
    // it then passed for real.
    expect(ran).toEqual([
      "pnpm install --frozen-lockfile",
      "pnpm run typecheck",
    ]);
    expect(existsSync(join(reviewDir, "node_modules", "afk-marker"))).toBe(
      true,
    );
    expect(
      fixture.phase.mock.calls.some(([message]) =>
        String(message).includes("Pre-ship sanity gate passed"),
      ),
    ).toBe(true);
  });

  it("blocks with a CONFIGURATION failure — not a code failure — when the sanity install fails (#101)", async () => {
    const repo = makeRepo();
    const slug = "install-config-failure";
    commitSanityProject(repo);

    const fixture = makeJournal();
    const invoke = vi.fn(async () => {
      throw new Error("a configuration failure must not reach guardians");
    });
    const runCommand = vi.fn<ShipCommandRunner>(() => "");
    const ran: string[] = [];
    const sanityRunCommand = stubSanityRunner(ran, () => ({
      exitCode: 1,
      output: "  ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with frozen-lockfile\n",
    }));

    const result = await runShipGate({
      ...makeArgs(repo, slug, fixture.journal, invoke, runCommand),
      sanityRunCommand,
    });

    expect(result.verdict).toBe("BLOCKED");
    // Named in the base-gate vocabulary, with pnpm's own diagnostic — an
    // operator can tell a broken environment from a red suite.
    expect(result.failureReason).toContain("CONFIGURATION: install");
    expect(result.failureReason).toContain(
      "configuration failure of the environment, not a code failure",
    );
    expect(result.failureReason).toContain("ERR_PNPM_OUTDATED_LOCKFILE");
    // The sanity steps never ran, so they are not reported as failures.
    expect(ran).toEqual(["pnpm install --frozen-lockfile"]);
    expect(invoke).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("records the CONFIGURATION kind on the sanity phase event and in the summary", async () => {
    const repo = makeRepo();
    const slug = "install-config-event";
    commitSanityProject(repo);

    const fixture = makeJournal();
    const setSanityGate = vi.fn();
    const event = vi.fn();
    const journal: ShipGateJournal = {
      ...fixture.journal,
      event,
      setSanityGate,
    };
    const sanityRunCommand = stubSanityRunner([], () => ({
      exitCode: 1,
      output: "ERR_PNPM_OUTDATED_LOCKFILE",
    }));

    await runShipGate({
      ...makeArgs(
        repo,
        slug,
        journal,
        vi.fn(async () => invokeResult()),
        vi.fn<ShipCommandRunner>(() => ""),
      ),
      sanityRunCommand,
    });

    expect(event).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "run-phase-ended",
        phase: "sanity",
        verdict: "FAIL",
        failureKind: "CONFIGURATION",
      }),
    );
    expect(setSanityGate).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        failures: ["install"],
        failureKind: "CONFIGURATION",
      }),
    );
  });

  // Issue #136: both guardians share one review worktree, so one agent's
  // shell can revert the other's freshly written review to the version
  // committed by the previous gate round. A new spawned scenario is
  // deliberate here — no existing fixture commits a prior round's review.
  //
  // Deliberately `serialReviews: false`, the production default
  // (`serialLanes === true` is off in every shipped config), so the half of
  // the fix that classifies the verdict from the snapshot is exercised on the
  // path runs actually take. The PM's revert is gated on the architect's
  // `run-phase-ended` event, which fires *after* the capture read — that is
  // the boundary the fix claims, and the ordering has to be pinned rather
  // than raced or the test would be flaky about which invariant it proves.
  it("P-03 commits and parses each captured guardian artifact despite a concurrent sibling rewrite (#136)", async () => {
    const repo = makeRepo();
    const slug = "stale-review";
    const specsDir = join(repo, ".kiro", "specs", slug);
    const architectPath = join(specsDir, "review-architect.md");
    const stale = [
      "# Architecture Guardian Review",
      "",
      "**Verdict:** FIX-BEFORE-SHIP",
      "",
      "## Structured findings (v2)",
      '{"version":2,"findings":[{"id":"A-01","title":"Stale blocker","class":"INTEGRITY","clearCondition":"Fix stale flow","disposition":"OPEN","reachableTrigger":"A retry consumes stale state.","introducedByReviewedDiff":true}]}',
      "",
      "lockAdjudicatedContract at lines 2065-2185.",
      "",
    ].join("\n");
    const fresh = [
      "# Architecture Guardian Review",
      "",
      "**Verdict:** SHIP",
      "",
      "## Structured findings (v2)",
      '{"version":2,"findings":[]}',
      "",
      "runImpasseAdjudication at line 2237.",
      "",
    ].join("\n");
    // The previous gate round's review, already on the branch.
    mkdirSync(specsDir, { recursive: true });
    writeFileSync(architectPath, stale, "utf-8");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "round 3 reviews"]);

    const fixture = makeJournal();
    let architectCaptured!: () => void;
    const architectSettled = new Promise<void>((resolve) => {
      architectCaptured = resolve;
    });
    const journal: ShipGateJournal = {
      ...fixture.journal,
      event: (payload: RunEventPayload) => {
        fixture.event(payload);
        if (
          payload.type === "run-phase-ended" &&
          payload.phase === "architect-review"
        ) {
          architectCaptured();
        }
      },
    };
    const invoke = vi.fn(async (options: InvokeOptions) => {
      if (options.role === "architect-review") {
        writeFileSync(architectPath, fresh, "utf-8");
      } else {
        await architectSettled;
        writeReview(options, slug, "pm", "SHIP");
        // What the PM guardian actually ran in run-20260829-161928 (item_70);
        // its editor's delete-and-re-add of the same file, four minutes after
        // the architect finished, had the identical effect.
        git(repo, [
          "checkout-index",
          "--force",
          "--",
          `.kiro/specs/${slug}/review-architect.md`,
        ]);
      }
      return invokeResult();
    });
    const runCommand = vi.fn<ShipCommandRunner>((command, args) =>
      command === "gh" && args[1] === "create"
        ? "https://github.com/acme/repo/pull/136\n"
        : "",
    );

    const args = makeArgs(repo, slug, journal, invoke, runCommand);
    const result = await runShipGate({
      ...args,
      options: { ...args.options, serialReviews: false },
    });

    expect(result).toMatchObject({ verdict: "SHIP" });
    expect(
      git(repo, ["show", `HEAD:.kiro/specs/${slug}/review-architect.md`]),
    ).toContain("runImpasseAdjudication at line 2237");
    expect(readFileSync(architectPath, "utf-8")).toBe(fresh);
    // The verdict came from the snapshot, not from the reverted file — the
    // stale blob says FIX-BEFORE-SHIP, which would have kept the PR closed.
    expect(fixture.setReviewOutcomes).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "SHIP" }),
      expect.objectContaining({ outcome: "SHIP" }),
    );
    const restoreWarning = fixture.phase.mock.calls.find(([message]) =>
      String(message).includes(
        "Architect review artifact was changed in the review worktree",
      ),
    );
    expect(restoreWarning).toBeDefined();
    // F6: the warning names the file, not just the role.
    expect(String(restoreWarning![0])).toContain("review-architect.md");
    expect(fixture.event).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "warn",
        reason: "review-artifact-restored",
      }),
    );
  });

  // Residual insurance (#136 review follow-up): the restore step covers the
  // two review files, so a guardian shell that moves anything else has to be
  // caught by the pre-commit HEAD/status check instead.
  it("B-01 QA-01 blocks worktree HEAD drift and persists the completed guardian round", async () => {
    const repo = makeRepo();
    const slug = "drift-head";
    const reviewedHeadSha = git(repo, ["rev-parse", "HEAD"]);
    let driftedHeadSha = "";
    const fixture = makeJournal();
    const invoke = vi.fn(async (options: InvokeOptions) => {
      const kind = options.role === "architect-review" ? "architect" : "pm";
      writeReview(options, slug, kind, "SHIP");
      if (kind === "pm") {
        // A rogue commit in the shared worktree: HEAD is no longer the tree
        // the guardians reviewed.
        writeFileSync(join(repo, "README.md"), "rogue\n", "utf-8");
        git(repo, ["commit", "-am", "rogue guardian commit"]);
        driftedHeadSha = git(repo, ["rev-parse", "HEAD"]);
      }
      return invokeResult();
    });
    const runCommand = vi.fn<ShipCommandRunner>(() => "");

    const result = await runShipGate(
      makeArgs(repo, slug, fixture.journal, invoke, runCommand),
    );

    expect(result.verdict).toBe("BLOCKED");
    expect(result.failureReason).toContain("HEAD moved");
    expect(result.pr.requested).toBe(false);
    expect(runCommand).not.toHaveBeenCalled();
    expect(fixture.event).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "warn",
        reason: "review-worktree-drift",
      }),
    );
    expect(loadRunState(repo, slug).reviewPhase?.rounds).toEqual([
      {
        round: 1,
        reviewedHeadSha,
        headSha: driftedHeadSha,
        architect: {
          source: "INVOKED",
          outcome: "SHIP",
          findings: [],
          findingsOriginRound: 1,
        },
        pm: {
          source: "INVOKED",
          outcome: "SHIP",
          findings: [],
          findingsOriginRound: 1,
        },
      },
    ]);
  });

  it("B-01 QA-02 persists the completed guardian round when the artifact commit fails", async () => {
    const repo = makeRepo();
    const slug = "artifact-commit-failure";
    const reviewedHeadSha = git(repo, ["rev-parse", "HEAD"]);
    const fixture = makeJournal();
    const invoke = vi.fn(async (options: InvokeOptions) => {
      const kind = options.role === "architect-review" ? "architect" : "pm";
      writeReview(options, slug, kind, "SHIP");
      if (kind === "pm") {
        writeFileSync(join(repo, ".git", "index.lock"), "locked\n", "utf-8");
      }
      return invokeResult();
    });
    const runCommand = vi.fn<ShipCommandRunner>(() => "");

    await expect(
      runShipGate(makeArgs(repo, slug, fixture.journal, invoke, runCommand)),
    ).rejects.toThrow();

    expect(runCommand).not.toHaveBeenCalled();
    expect(fixture.event).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: "run-phase-started",
        phase: "draft-pr",
      }),
    );
    expect(loadRunState(repo, slug).reviewPhase?.rounds).toEqual([
      {
        round: 1,
        reviewedHeadSha,
        headSha: reviewedHeadSha,
        architect: {
          source: "INVOKED",
          outcome: "SHIP",
          findings: [],
          findingsOriginRound: 1,
        },
        pm: {
          source: "INVOKED",
          outcome: "SHIP",
          findings: [],
          findingsOriginRound: 1,
        },
      },
    ]);
  });

  it("B-01 QA-03 retries one failed round-state write and persists exactly one round", async () => {
    const repo = makeRepo();
    const slug = "round-write-retry";
    const reviewedHeadSha = git(repo, ["rev-parse", "HEAD"]);
    const fixture = makeJournal();
    const invoke = vi.fn(async (options: InvokeOptions) => {
      const kind = options.role === "architect-review" ? "architect" : "pm";
      writeReview(options, slug, kind, "SHIP");
      return invokeResult();
    });
    const runCommand = vi.fn<ShipCommandRunner>(() => "");
    const args = makeArgs(
      repo,
      slug,
      fixture.journal,
      invoke,
      runCommand,
    );
    let writeAttempts = 0;
    args.guardianPersistence = {
      appendCompletedGuardianRound: (repoRoot, runSlug, reviewPhase) => {
        writeAttempts++;
        if (writeAttempts === 1) {
          throw new Error("injected round-state write failure");
        }
        appendCompletedGuardianRound(repoRoot, runSlug, reviewPhase);
      },
    };

    await expect(runShipGate(args)).rejects.toThrow(
      "injected round-state write failure",
    );

    expect(writeAttempts).toBe(2);
    expect(runCommand).not.toHaveBeenCalled();
    expect(fixture.event).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: "run-phase-started",
        phase: "draft-pr",
      }),
    );
    const rounds = loadRunState(repo, slug).reviewPhase?.rounds;
    expect(rounds).toHaveLength(1);
    expect(rounds?.[0]).toEqual({
      round: 1,
      reviewedHeadSha,
      headSha: git(repo, ["rev-parse", "HEAD"]),
      architect: {
        source: "INVOKED",
        outcome: "SHIP",
        findings: [],
        findingsOriginRound: 1,
      },
      pm: {
        source: "INVOKED",
        outcome: "SHIP",
        findings: [],
        findingsOriginRound: 1,
      },
    });
  });

  it("B-01 QA-04 keeps the reusable caches when the round write is retried", async () => {
    const repo = makeRepo();
    const slug = "round-write-retry-cache";
    const fixture = makeJournal();
    const invoke = vi.fn(async (options: InvokeOptions) => {
      const kind = options.role === "architect-review" ? "architect" : "pm";
      writeReview(options, slug, kind, "SHIP");
      return invokeResult();
    });
    const runCommand = vi.fn<ShipCommandRunner>(() => "");
    const args = makeArgs(repo, slug, fixture.journal, invoke, runCommand);
    let writeAttempts = 0;
    args.guardianPersistence = {
      appendCompletedGuardianRound: (repoRoot, runSlug, reviewPhase) => {
        writeAttempts++;
        if (writeAttempts === 1) {
          throw new Error("injected round-state write failure");
        }
        appendCompletedGuardianRound(repoRoot, runSlug, reviewPhase);
      },
    };

    await expect(runShipGate(args)).rejects.toThrow(
      "injected round-state write failure",
    );

    expect(writeAttempts).toBe(2);
    const reviewPhase = loadRunState(repo, slug).reviewPhase;
    expect(reviewPhase?.rounds).toHaveLength(1);
    // The retry must carry the same cache payload the failed write carried:
    // a transient failure that erased these entries would force the next run
    // to re-run the sanity gate and both favorable guardians for nothing.
    const headSha = git(repo, ["rev-parse", "HEAD"]);
    expect(reviewPhase?.architect).toEqual({ headSha, verdict: "SHIP" });
    expect(reviewPhase?.pm).toEqual({ headSha, verdict: "SHIP" });
    expect(reviewPhase?.sanity).toEqual({
      treeSha: git(repo, ["rev-parse", "HEAD^{tree}"]),
      ok: true,
    });
  });

  it("B-02 QA-01 persists both findings distinctly when two known aliases contest one prior identity", async () => {
    const repo = makeRepo();
    const slug = "alias-collision";
    const headSha = git(repo, ["rev-parse", "HEAD"]);
    const fixture = makeJournal();
    const invoke = vi.fn(async (options: InvokeOptions) => {
      const kind = options.role === "architect-review" ? "architect" : "pm";
      if (kind === "pm") {
        writeReview(options, slug, "pm", "SHIP");
        return invokeResult();
      }
      // Two findings naming the one prior entry through both of its aliases.
      const dir = join(options.cwd, ".kiro", "specs", slug);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "review-architect.md"),
        [
          "# Guardian Review",
          "",
          "**Verdict:** FIX-BEFORE-SHIP",
          "",
          "## Structured findings (v2)",
          JSON.stringify({
            version: 2,
            findings: [
              {
                id: "A-05",
                title: "Current-alias claimant",
                class: "INTEGRITY",
                clearCondition: "Commit the durable evidence.",
                disposition: "REPEATED",
                reachableTrigger: "A retry reaches the current alias.",
                introducedByReviewedDiff: false,
              },
              {
                id: "A-01",
                title: "Stable-alias claimant",
                class: " Integrity ",
                clearCondition: "  Commit   the durable evidence. ",
                disposition: "OPEN",
                reachableTrigger: "A retry reaches the stable alias.",
                introducedByReviewedDiff: false,
              },
            ],
          }),
          "",
        ].join("\n"),
        "utf-8",
      );
      return invokeResult();
    });
    const runCommand = vi.fn<ShipCommandRunner>(() => "");
    const cachedReviewPhase = {
      rounds: [
        {
          round: 1,
          reviewedHeadSha: "pre-review",
          headSha: "prior-head",
          architect: {
            source: "INVOKED" as const,
            outcome: "FIX-BEFORE-SHIP" as const,
            findings: [
              {
                stableId: "A-01",
                currentId: "A-05",
                title: "The one prior finding",
                class: "INTEGRITY",
                clearCondition: "Commit the durable evidence.",
                disposition: "OPEN" as const,
                reachableTrigger:
                  "A retry consumes the incomplete durable record.",
                introducedByReviewedDiff: true,
              },
            ],
            findingsOriginRound: 1,
          },
          pm: {
            source: "INVOKED" as const,
            outcome: "SHIP" as const,
            findings: [],
            findingsOriginRound: 1,
          },
        },
      ],
    };
    appendCompletedGuardianRound(repo, slug, cachedReviewPhase);

    await runShipGate({
      ...makeArgs(repo, slug, fixture.journal, invoke, runCommand),
      cachedReviewPhase,
    });

    const rounds = loadRunState(repo, slug).reviewPhase?.rounds;
    // Both parsed findings persist distinctly: both claim the one prior
    // identity, both fingerprints match it so no single fingerprint singles out
    // a winner, and the stableId claimant keeps A-01 while the current-alias
    // claimant mints a new identity (ADR 0057 decision 1 amendment). The
    // fingerprints have to match for either alias to claim the identity at all
    // (#247), which is why they restate the prior clear condition here.
    expect(rounds).toHaveLength(2);
    expect(rounds?.[1]?.architect).toEqual({
      source: "INVOKED",
      outcome: "FIX-BEFORE-SHIP",
      findings: [
        {
          stableId: "A-05",
          currentId: "A-05",
          title: "Current-alias claimant",
          class: "INTEGRITY",
          clearCondition: "Commit the durable evidence.",
          disposition: "REPEATED",
          reachableTrigger: "A retry reaches the current alias.",
          introducedByReviewedDiff: false,
        },
        {
          stableId: "A-01",
          currentId: "A-01",
          title: "Stable-alias claimant",
          // The parser trims; only the internal spacing survives, and the
          // fingerprint normalizes it away.
          class: "Integrity",
          clearCondition: "Commit   the durable evidence.",
          disposition: "OPEN",
          reachableTrigger: "A retry reaches the stable alias.",
          introducedByReviewedDiff: false,
        },
      ],
      findingsOriginRound: 2,
    });
    // A blocking architect result is unfavorable, so it is never cached.
    expect(loadRunState(repo, slug).reviewPhase?.architect).toBeUndefined();
    expect(headSha).toBeTruthy();

    // Slice #171: this same second round read the ledger the first wrote — its
    // prompt is scoped to the fix diff from round 1's headSha and lists the
    // prior finding by the stable ID the guardian must reuse (ADR 0057
    // decision 2). Asserted here rather than in a new spawned scenario.
    const architectPrompt = invoke.mock.calls
      .map(([options]) => options)
      .find((options) => options.role === "architect-review")!.prompt;
    expect(architectPrompt).toContain("review round 2, a verification round");
    expect(architectPrompt).toContain("git diff prior-head..HEAD");
    expect(architectPrompt).not.toContain("git diff main...HEAD");
    expect(architectPrompt).toContain("[A-01]");
    expect(architectPrompt).toContain("Commit the durable evidence.");
    expect(architectPrompt).toContain("Reuse the stable IDs");
    expect(fixture.phase).toHaveBeenCalledWith(
      expect.stringContaining(
        "Architect review round 2: verifying the fix diff prior-head..HEAD",
      ),
      "log",
    );
  });

  // One spawned scenario, deliberately: the cap exit's wiring is what the unit
  // tests cannot reach — the ordering of file-then-decide, the durable
  // filed-issue record, the PR body, and the note dedupe *across* ship-gate
  // entries. It runs the gate twice against one repo so the second entry pays
  // no second setup and proves the once-across-rounds rule end to end
  // (slices #173 and #174).
  it("takes the recorded cap exit, files each finding once across rounds, and ships", async () => {
    const repo = makeRepo();
    const slug = "guardian-round-cap";
    const fixture = makeJournal();
    const writeCappedArchitectReview = (options: InvokeOptions) => {
      const dir = join(options.cwd, ".kiro", "specs", slug);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "review-architect.md"),
        [
          "# Guardian Review",
          "",
          "**Verdict:** FIX-BEFORE-SHIP",
          "",
          "## Structured findings (v2)",
          JSON.stringify({
            version: 2,
            findings: [
              {
                id: "A-01",
                title: "Durable record is written incomplete",
                class: "INTEGRITY",
                clearCondition: "The round persists before the early return.",
                disposition: "REPEATED",
                reachableTrigger: "A retry consumes the incomplete record.",
                introducedByReviewedDiff: true,
              },
              {
                id: "A-02",
                title: "Helper name drifts from the module's convention",
                class: "CONVENTION",
                clearCondition: "The helper follows the module's naming.",
                disposition: "REPEATED",
                reachableTrigger: null,
                introducedByReviewedDiff: false,
              },
            ],
          }),
          "",
        ].join("\n"),
        "utf-8",
      );
    };
    const invoke = vi.fn(async (options: InvokeOptions) => {
      if (options.role === "architect-review") {
        writeCappedArchitectReview(options);
      } else {
        writeReview(options, slug, "pm", "SHIP");
      }
      return invokeResult();
    });
    let nextIssue = 100;
    const runCommand = vi.fn<ShipCommandRunner>((command, args) => {
      if (command === "gh" && args[0] === "issue" && args[1] === "create") {
        return `https://github.com/acme/repo/issues/${nextIssue++}\n`;
      }
      if (command === "gh" && args[1] === "create") {
        return "https://github.com/acme/repo/pull/77\n";
      }
      return "";
    });

    const priorFindings = [
      {
        stableId: "A-01",
        currentId: "A-01",
        title: "Durable record is written incomplete",
        class: "INTEGRITY",
        clearCondition: "The round persists before the early return.",
        disposition: "OPEN" as const,
        reachableTrigger: "A retry consumes the incomplete record.",
        introducedByReviewedDiff: true,
      },
      {
        stableId: "A-02",
        currentId: "A-02",
        title: "Helper name drifts from the module's convention",
        class: "CONVENTION",
        clearCondition: "The helper follows the module's naming.",
        disposition: "OPEN" as const,
        reachableTrigger: null,
        introducedByReviewedDiff: false,
      },
    ];
    // Two unfavorable rounds already spent; this pass is the third.
    const cachedReviewPhase = {
      rounds: [1, 2].map((round) => ({
        round,
        reviewedHeadSha: round === 1 ? "pre-review" : `head-${round - 1}`,
        headSha: `head-${round}`,
        architect: {
          source: "INVOKED" as const,
          outcome: "FIX-BEFORE-SHIP" as const,
          findings: priorFindings.map((finding) => ({ ...finding })),
          findingsOriginRound: round,
        },
        pm: {
          source: "INVOKED" as const,
          outcome: "SHIP" as const,
          findings: [],
          findingsOriginRound: round,
        },
      })),
    };
    appendCompletedGuardianRound(repo, slug, cachedReviewPhase);

    const capped = await runShipGate({
      ...makeArgs(repo, slug, fixture.journal, invoke, runCommand),
      cachedReviewPhase,
    });

    // The gate stops fixing and ships: a capped run is successful, like an
    // override (ADR 0057 decision 4, extending ADR 0015's carve-out).
    expect(capped.verdict).toBe("SHIP");
    expect(capped.pr).toMatchObject({
      requested: true,
      overridden: false,
      cappedExit: true,
      url: "https://github.com/acme/repo/pull/77",
    });

    // The blocker and the note are each filed exactly once, blocker first.
    const issueCalls = runCommand.mock.calls.filter(
      ([command, args]) =>
        command === "gh" && args[0] === "issue" && args[1] === "create",
    );
    expect(issueCalls).toHaveLength(2);
    const issueBodies = issueCalls.map(([, args]) => args[5]!);
    expect(issueBodies[0]).toContain("unresolved at the guardian round cap");
    expect(issueBodies[0]).toContain("`A-01`");
    expect(issueBodies[1]).toContain("note shipped unfixed");
    expect(issueBodies[1]).toContain("`A-02`");

    // The filed issues are durable, so a later round cannot file them again.
    expect(loadRunState(repo, slug).reviewPhase?.filedFindings).toEqual([
      expect.objectContaining({
        guardian: "architect",
        stableId: "A-01",
        kind: "BLOCKER",
        round: 3,
        issue: "https://github.com/acme/repo/issues/100",
      }),
      expect.objectContaining({
        guardian: "architect",
        stableId: "A-02",
        kind: "NOTE",
        round: 3,
        issue: "https://github.com/acme/repo/issues/101",
      }),
    ]);

    // The PR body and the run summary both record the exit, through the same
    // plumbing the override uses.
    const prCreateBodies = () =>
      runCommand.mock.calls
        .filter(
          ([command, args]) =>
            command === "gh" && args[0] === "pr" && args[1] === "create",
        )
        .map(([, args]) => args[args.indexOf("--body") + 1]!);
    const prBody = prCreateBodies()[0]!;
    expect(prBody).toContain("## Guardian round cap reached");
    expect(prBody).toContain("3 unfavorable round(s), reaching its cap of 3");
    expect(prBody).toContain("https://github.com/acme/repo/issues/100");
    expect(prBody).not.toContain("https://github.com/acme/repo/issues/101");
    expect(fixture.setPrOverrideNote).toHaveBeenCalledWith(
      expect.stringContaining("PR opened at the guardian round cap after 3"),
    );

    // Round 4, same disagreement: nothing is filed a second time.
    const secondFixture = makeJournal();
    const carried = loadRunState(repo, slug).reviewPhase!;
    const again = await runShipGate({
      ...makeArgs(repo, slug, secondFixture.journal, invoke, runCommand),
      cachedReviewPhase: carried,
    });

    expect(again.verdict).toBe("SHIP");
    expect(again.pr.cappedExit).toBe(true);
    expect(
      runCommand.mock.calls.filter(
        ([command, args]) =>
          command === "gh" && args[0] === "issue" && args[1] === "create",
      ),
    ).toHaveLength(2);
    expect(loadRunState(repo, slug).reviewPhase?.filedFindings).toHaveLength(2);
    // The round-4 PR body still names the issues the earlier round filed.
    expect(prCreateBodies().at(-1)!).toContain(
      "https://github.com/acme/repo/issues/100",
    );
  });

  it("refuses the cap exit when an unresolved blocker cannot be filed", async () => {
    const repo = makeRepo();
    const slug = "guardian-cap-filing-failure";
    const fixture = makeJournal();
    const invoke = vi.fn(async (options: InvokeOptions) => {
      const kind = options.role === "architect-review" ? "architect" : "pm";
      writeReview(
        options,
        slug,
        kind,
        kind === "architect" ? "FIX-BEFORE-SHIP" : "SHIP",
      );
      return invokeResult();
    });
    const runCommand = vi.fn<ShipCommandRunner>((command, args) => {
      if (command === "gh" && args[0] === "issue" && args[1] === "create") {
        throw new Error("gh: could not create issue (403)");
      }
      return "";
    });

    const result = await runShipGate({
      ...makeArgs(repo, slug, fixture.journal, invoke, runCommand),
      options: {
        ...makeArgs(repo, slug, fixture.journal, invoke, runCommand).options,
        // Cap 1, so this single blocking round reaches it.
        guardianRoundCap: 1,
        reviewRetries: 1,
      },
    });

    // Filing is mandatory for a cap exit, not best-effort: no PR, no success.
    expect(result.verdict).toBe("BLOCKED");
    expect(result.failureReason).toContain("guardian round cap reached");
    expect(result.failureReason).toContain("could not be filed as issues");
    expect(result.pr.requested).toBe(false);
    expect(fixture.setPrOverrideNote).not.toHaveBeenCalled();
    expect(loadRunState(repo, slug).reviewPhase?.filedFindings).toBeUndefined();
    // Two attempts per draft with one retry, and the retry is announced.
    expect(
      runCommand.mock.calls.filter(
        ([command, args]) =>
          command === "gh" && args[0] === "issue" && args[1] === "create",
      ),
    ).toHaveLength(2);
    expect(fixture.event).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "guardian-cap-filing-failed" }),
    );
    // The round itself still persists: the ledger records every round.
    expect(loadRunState(repo, slug).reviewPhase?.rounds).toHaveLength(1);
  });

  // Slice #174, at the seam the unit tests cannot reach: notes ride the clean
  // ship path, both guardians', and the durable record survives the round write
  // that happens in between. Two gate entries on one repo, so the
  // once-across-rounds rule is proven rather than inferred.
  it("files both guardians' unfixed notes exactly once across rounds on a clean ship", async () => {
    const repo = makeRepo();
    const slug = "notes-filed-once";
    const fixture = makeJournal();
    const invoke = vi.fn(async (options: InvokeOptions) => {
      const kind = options.role === "architect-review" ? "architect" : "pm";
      writeReview(options, slug, kind, "ACCEPT-WITH-NOTES");
      return invokeResult();
    });
    let nextIssue = 200;
    const runCommand = vi.fn<ShipCommandRunner>((command, args) => {
      if (command === "gh" && args[0] === "issue" && args[1] === "create") {
        return `https://github.com/acme/repo/issues/${nextIssue++}\n`;
      }
      if (command === "gh" && args[0] === "pr" && args[1] === "create") {
        return "https://github.com/acme/repo/pull/88\n";
      }
      return "";
    });
    const issueCalls = () =>
      runCommand.mock.calls.filter(
        ([command, args]) =>
          command === "gh" && args[0] === "issue" && args[1] === "create",
      );

    const first = await runShipGate(
      makeArgs(repo, slug, fixture.journal, invoke, runCommand),
    );

    expect(first.verdict).toBe("SHIP");
    // A clean ship needs no exit note: nothing was overridden or capped.
    expect(first.pr).toMatchObject({ overridden: false, cappedExit: false });
    expect(fixture.setPrOverrideNote).not.toHaveBeenCalled();
    expect(issueCalls()).toHaveLength(2);
    expect(issueCalls().map(([, args]) => args[3])).toEqual([
      "[afk][notes-filed-once] architect finding",
      "[afk][notes-filed-once] pm finding",
    ]);
    for (const [, args] of issueCalls()) {
      expect(args[5]).toContain("note shipped unfixed");
    }
    expect(loadRunState(repo, slug).reviewPhase?.filedFindings).toEqual([
      expect.objectContaining({
        guardian: "architect",
        stableId: "A-01",
        kind: "NOTE",
        issue: "https://github.com/acme/repo/issues/200",
      }),
      expect.objectContaining({
        guardian: "pm",
        stableId: "P-01",
        kind: "NOTE",
        issue: "https://github.com/acme/repo/issues/201",
      }),
    ]);

    // Round 2: both notes ride again — the regression this guards is filing
    // them a second time.
    const second = await runShipGate({
      ...makeArgs(repo, slug, makeJournal().journal, invoke, runCommand),
      cachedReviewPhase: loadRunState(repo, slug).reviewPhase,
    });

    expect(second.verdict).toBe("SHIP");
    expect(issueCalls()).toHaveLength(2);
    expect(loadRunState(repo, slug).reviewPhase?.filedFindings).toHaveLength(2);
  });

  it("refuses the cap exit when the filed-issue record cannot be persisted", async () => {
    const repo = makeRepo();
    const slug = "cap-record-write-failure";
    const fixture = makeJournal();
    const invoke = vi.fn(async (options: InvokeOptions) => {
      const kind = options.role === "architect-review" ? "architect" : "pm";
      writeReview(
        options,
        slug,
        kind,
        kind === "architect" ? "FIX-BEFORE-SHIP" : "SHIP",
      );
      return invokeResult();
    });
    const runCommand = vi.fn<ShipCommandRunner>((command, args) =>
      command === "gh" && args[0] === "issue" && args[1] === "create"
        ? "https://github.com/acme/repo/issues/300\n"
        : "",
    );
    const base = makeArgs(repo, slug, fixture.journal, invoke, runCommand);

    const result = await runShipGate({
      ...base,
      options: { ...base.options, guardianRoundCap: 1 },
      guardianPersistence: {
        recordFiledGuardianFindings: () => {
          throw new Error("EPERM: state file is locked");
        },
      },
    });

    // The issue exists in the tracker but not in run state, so the run is not
    // durably filed — and "durably filed" is the exit's precondition.
    expect(result.verdict).toBe("BLOCKED");
    expect(result.failureReason).toContain("could not be filed as issues");
    expect(result.failureReason).toContain("could not be persisted");
    expect(result.pr.requested).toBe(false);
    // The already-opened issue is named, so a human can find it.
    expect(fixture.phase).toHaveBeenCalledWith(
      expect.stringContaining("https://github.com/acme/repo/issues/300"),
      "warn",
    );
  });

  it("keeps a clean ship when a note cannot be filed", async () => {
    const repo = makeRepo();
    const slug = "note-filing-failure";
    const fixture = makeJournal();
    const invoke = vi.fn(async (options: InvokeOptions) => {
      const kind = options.role === "architect-review" ? "architect" : "pm";
      writeReview(options, slug, kind, "ACCEPT-WITH-NOTES");
      return invokeResult();
    });
    const runCommand = vi.fn<ShipCommandRunner>((command, args) => {
      if (command === "gh" && args[0] === "issue" && args[1] === "create") {
        throw new Error("gh: could not create issue (403)");
      }
      if (command === "gh" && args[1] === "create") {
        return "https://github.com/acme/repo/pull/78\n";
      }
      return "";
    });

    const result = await runShipGate({
      ...makeArgs(repo, slug, fixture.journal, invoke, runCommand),
    });

    // A note nobody could file must not sink a ship both guardians cleared.
    expect(result.verdict).toBe("SHIP");
    expect(result.pr.cappedExit).toBe(false);
    expect(result.pr.overridden).toBe(false);
    expect(fixture.event).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "guardian-note-filing-failed" }),
    );
    // Nothing was recorded as filed, so a later round retries it.
    expect(loadRunState(repo, slug).reviewPhase?.filedFindings).toBeUndefined();
  });

  it("B-01 QA-06 keeps the reused caches when the artifact commit fails", async () => {
    const repo = makeRepo();
    const slug = "artifact-commit-failure-cache";
    const headSha = git(repo, ["rev-parse", "HEAD"]);
    const treeSha = git(repo, ["rev-parse", "HEAD^{tree}"]);
    const fixture = makeJournal();
    // Only PM is invoked: the architect verdict and the sanity gate are reused
    // from cache, so both must survive the failing exit below.
    const invoke = vi.fn(async (options: InvokeOptions) => {
      writeReview(options, slug, "pm", "SHIP");
      writeFileSync(join(repo, ".git", "index.lock"), "locked\n", "utf-8");
      return invokeResult();
    });
    const runCommand = vi.fn<ShipCommandRunner>(() => "");
    const cachedReviewPhase = {
      sanity: { treeSha, ok: true as const },
      architect: { headSha, verdict: "SHIP" as const },
    };
    appendCompletedGuardianRound(repo, slug, cachedReviewPhase);

    await expect(
      runShipGate({
        ...makeArgs(repo, slug, fixture.journal, invoke, runCommand),
        cachedReviewPhase,
      }),
    ).rejects.toThrow();

    const reviewPhase = loadRunState(repo, slug).reviewPhase;
    expect(reviewPhase?.rounds).toHaveLength(1);
    expect(reviewPhase?.architect).toEqual({ headSha, verdict: "SHIP" });
    expect(reviewPhase?.sanity).toEqual({ treeSha, ok: true });
  });
});

describe("detectReviewWorktreeDrift", () => {
  const specsDir = ".kiro/specs/slug";

  it("passes a worktree dirty only with this run's review artifacts", () => {
    expect(
      detectReviewWorktreeDrift({
        headShaBefore: "abc",
        headShaNow: "abc",
        statusPorcelain: [
          ` M ${specsDir}/review-architect.md`,
          `A  ${specsDir}/review-pm.md`,
        ].join("\n"),
        specsDir,
      }),
    ).toBeNull();
  });

  it("separates tracked source changes from untracked scratch", () => {
    const drift = detectReviewWorktreeDrift({
      headShaBefore: "abc",
      headShaNow: "abc",
      statusPorcelain: [
        ` M ${specsDir}/review-pm.md`,
        " M src/orchestrator.ts",
        " D src/git.ts",
        "R  src/old.ts -> src/new.ts",
        "?? guardian-scratch.log",
      ].join("\n"),
      specsDir,
    });

    expect(drift).toEqual({
      headMoved: undefined,
      changedPaths: ["M src/orchestrator.ts", "D src/git.ts", "R src/new.ts"],
      untrackedPaths: ["guardian-scratch.log"],
    });
    expect(formatReviewWorktreeDrift(drift!)).toContain("src/orchestrator.ts");
  });

  it("reports a moved HEAD even with a clean tree", () => {
    const drift = detectReviewWorktreeDrift({
      headShaBefore: "a".repeat(40),
      headShaNow: "b".repeat(40),
      statusPorcelain: "",
      specsDir,
    });

    expect(drift?.headMoved).toEqual({
      before: "a".repeat(40),
      after: "b".repeat(40),
    });
    expect(formatReviewWorktreeDrift(drift!)).toContain("HEAD moved");
  });

  it("stays silent when HEAD could not be resolved on either side", () => {
    expect(
      detectReviewWorktreeDrift({
        headShaBefore: null,
        headShaNow: "b".repeat(40),
        statusPorcelain: "",
        specsDir,
      }),
    ).toBeNull();
  });
});

describe("restoreCapturedReviewArtifacts", () => {
  it("rewrites only the artifacts that diverged since capture", () => {
    const disk = new Map<string, string>([
      ["a.md", "reverted"],
      ["b.md", "untouched"],
    ]);
    const io = {
      read: (path: string) => disk.get(path) ?? null,
      write: (path: string, content: string) => void disk.set(path, content),
    };

    const report = restoreCapturedReviewArtifacts(
      [
        { label: "Architect", path: "a.md", content: "authored" },
        { label: "PM", path: "b.md", content: "untouched" },
      ],
      io,
    );

    expect(report).toEqual({
      restored: [{ label: "Architect", path: "a.md" }],
      failed: [],
    });
    expect(disk.get("a.md")).toBe("authored");
  });

  // The review worktree still belongs to a shell-holding agent when this
  // runs: the path can be gone, read-only, or on a full disk. Losing a
  // three-hour gate to a failed one-file write is the worse outcome.
  it("reports a throwing io as a failure instead of crashing the gate", () => {
    const writes: string[] = [];
    const io = {
      read: (path: string) => (path === "a.md" ? null : "on disk"),
      write: (path: string, content: string) => {
        if (path === "a.md") {
          throw Object.assign(new Error("ENOENT: no such file or directory"), {
            code: "ENOENT",
          });
        }
        writes.push(`${path}:${content}`);
      },
    };

    const report = restoreCapturedReviewArtifacts(
      [
        { label: "Architect", path: "a.md", content: "authored" },
        { label: "PM", path: "b.md", content: "pm authored" },
      ],
      io,
    );

    expect(report.restored).toEqual([{ label: "PM", path: "b.md" }]);
    expect(report.failed).toEqual([
      {
        label: "Architect",
        path: "a.md",
        error: "ENOENT: no such file or directory",
      },
    ]);
    // The sibling artifact is still restored: one failure is not a bail-out.
    expect(writes).toEqual(["b.md:pm authored"]);
  });

  it("reports a throwing read as a failure", () => {
    const report = restoreCapturedReviewArtifacts(
      [{ label: "PM", path: "b.md", content: "authored" }],
      {
        read: () => {
          throw new Error("EACCES: permission denied");
        },
        write: () => {
          throw new Error("write must not be attempted after a failed read");
        },
      },
    );

    expect(report.restored).toEqual([]);
    expect(report.failed).toEqual([
      { label: "PM", path: "b.md", error: "EACCES: permission denied" },
    ]);
  });

  it("leaves the path alone when the agent wrote no file and skips cached verdicts", () => {
    const writes: string[] = [];
    const io = {
      read: () => null,
      write: (path: string) => void writes.push(path),
    };

    expect(
      restoreCapturedReviewArtifacts(
        [undefined, { label: "PM", path: "b.md", content: null }],
        io,
      ),
    ).toEqual({ restored: [], failed: [] });
    expect(writes).toEqual([]);
  });
});

/**
 * The report-only mutation step at the ship gate (#303 B-11/B-12/B-15/B-16,
 * P-01, P-03).
 *
 * The step runs against injected seams — `mutationRun` for the command,
 * `mutationScope` for the derived file list, `mutationNow` for the clock — so no
 * suite invokes a real mutation tool and no test waits real minutes on the
 * bound. The gate itself is the real one, on a real fixture repo, so the
 * concurrency and the exits are exercised rather than described.
 */
describe("runShipGate — the report-only mutation step", () => {
  const REPORT_PATH = "reports/mutation.json";
  const CONFIG = { command: "pnpm run mutate", reportPath: REPORT_PATH };
  const SURVIVOR_JSON = {
    files: {
      "src/cart.ts": {
        mutants: [
          {
            id: "42",
            mutatorName: "ArithmeticOperator",
            status: "Survived",
            location: {
              start: { line: 3, column: 11 },
              end: { line: 3, column: 16 },
            },
          },
          {
            id: "43",
            mutatorName: "BlockStatement",
            status: "Killed",
            location: {
              start: { line: 1, column: 1 },
              end: { line: 4, column: 1 },
            },
          },
        ],
      },
    },
  };
  const SURVIVORS = [
    {
      id: "42",
      file: "src/cart.ts",
      mutator: "ArithmeticOperator",
      position: { startLine: 3, startColumn: 11, endLine: 3, endColumn: 16 },
    },
  ];

  /** A fixture whose feature tip really changed source files (B-10). */
  function makeChangedRepo(slug: string): string {
    const repo = makeRepo();
    git(repo, ["checkout", "-b", `feat/${slug}`]);
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "cart.ts"), "export const t = 2;\n", "utf-8");
    writeFileSync(join(repo, "src", "cart.test.ts"), "// covers cart\n", "utf-8");
    writeFileSync(join(repo, "NOTES.md"), "notes\n", "utf-8");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "change source"]);
    return repo;
  }

  function writeReportInto(repo: string): void {
    mkdirSync(join(repo, "reports"), { recursive: true });
    writeFileSync(join(repo, REPORT_PATH), JSON.stringify(SURVIVOR_JSON), "utf-8");
  }

  function shipInvoke(slug: string) {
    return vi.fn(async (options: InvokeOptions) => {
      const kind = options.role === "architect-review" ? "architect" : "pm";
      writeReview(options, slug, kind, "SHIP");
      return invokeResult();
    });
  }

  function prBody(runCommand: ReturnType<typeof vi.fn>): string | undefined {
    const call = runCommand.mock.calls.find(
      ([command, args]) => command === "gh" && (args as string[])[1] === "create",
    );
    if (!call) return undefined;
    const args = call[1] as string[];
    return args[args.indexOf("--body") + 1];
  }

  function ghRunCommand() {
    return vi.fn<ShipCommandRunner>((command, args) =>
      command === "gh" && args[1] === "create"
        ? "https://github.com/acme/repo/pull/42\n"
        : "",
    );
  }

  /** A clock that jumps a whole bound after handing out its first reading. */
  function spentClock(): () => number {
    let readings = 0;
    return () => (readings++ === 0 ? 0 : MUTATION_STEP_BOUND_MS + 1);
  }

  const flush = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };

  /**
   * The shared fixture journal records events on a mock only; the real one also
   * tees every event to `events.jsonl`, and that file is what the run summary
   * and the draft PR body both read the step's outcome from (B-14/B-15). These
   * tests need the tee to see the published text, so they add it — the tee's own
   * shape is pinned on the real Logger in `logger.test.ts`.
   */
  function teeing(fixture: ReturnType<typeof makeJournal>): ShipGateJournal {
    return {
      ...fixture.journal,
      event: (payload: RunEventPayload) => {
        fixture.journal.event(payload);
        appendFileSync(
          join(fixture.journal.runDir, "events.jsonl"),
          `${JSON.stringify(payload)}\n`,
          "utf-8",
        );
      },
    };
  }

  function mutationEvents(fixture: ReturnType<typeof makeJournal>) {
    return fixture.event.mock.calls
      .map(([payload]) => payload as RunEventPayload)
      .filter((payload) => payload.type === "mutation-step");
  }

  /** The phases whose events are this gate's gate identity and gate result. */
  const GATE_PHASES = new Set(["sanity"]);

  /**
   * Every gate identity and gate result a run reported, read back out of the
   * teed `events.jsonl`: any `gateId`/`gateIds` a payload carries, plus the
   * gate-phase entries the ship gate emits for its pre-ship sanity gate. This
   * is the surface B-11 and B-16 require to be identical with the declaration
   * present and absent — the projection a promoted mutation gate would have to
   * appear in (ADR 0063: reported, never a gate).
   */
  function gateSurface(
    fixture: ReturnType<typeof makeJournal>,
  ): Record<string, unknown>[] {
    return readFileSync(join(fixture.journal.runDir, "events.jsonl"), "utf-8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter(
        (payload) =>
          "gateId" in payload ||
          "gateIds" in payload ||
          GATE_PHASES.has(payload["phase"] as string),
      )
      .map((payload) =>
        Object.fromEntries(
          ["type", "phase", "gateId", "gateIds", "verdict", "cached", "failureKind"]
            .filter((key) => key in payload)
            .map((key) => [key, payload[key]]),
        ),
      );
  }

  /**
   * A clock the guardians move, so spawn, each guardian's completion and the
   * rejoin are three distinguishable readings rather than one repeated number.
   * Reading it never advances it: only `guardianFinished` does, which is what
   * makes *where* the gate reads it observable.
   */
  function guardianDrivenClock(costPerGuardian: number) {
    let elapsed = 0;
    const readings: number[] = [];
    return {
      readings,
      at: (): number => elapsed,
      guardianFinished: (): void => {
        elapsed += costPerGuardian;
      },
      now: (): number => {
        readings.push(elapsed);
        return elapsed;
      },
    };
  }

  it("[behavior:#303:B-11] starts the declared command on the review worktree before the first guardian resolves", async () => {
    vi.mocked(quiesceWorktree).mockClear();
    const slug = "mutation-concurrent";
    const repo = makeChangedRepo(slug);
    const fixture = makeJournal();
    const mutationRun = vi.fn(
      async (
        _command: string,
        _files: readonly string[],
        options: { cwd: string },
      ) => {
        writeReportInto(options.cwd);
        return "stryker: 47% mutation score\n";
      },
    );
    let callsWhenFirstGuardianRan = -1;
    const invoke = vi.fn(async (options: InvokeOptions) => {
      if (callsWhenFirstGuardianRan < 0) {
        callsWhenFirstGuardianRan = mutationRun.mock.calls.length;
      }
      const kind = options.role === "architect-review" ? "architect" : "pm";
      writeReview(options, slug, kind, "SHIP");
      return invokeResult();
    });
    const runCommand = ghRunCommand();
    const args = makeArgs(repo, slug, teeing(fixture), invoke, runCommand);
    args.mutationReport = CONFIG;
    args.mutationRun = mutationRun;

    const result = await runShipGate(args);

    // Concurrent, not sequential: the command was already invoked by the time
    // the first guardian review ran, so the step costs no extra wall clock.
    expect(callsWhenFirstGuardianRan).toBe(1);
    expect(mutationRun.mock.calls[0]![0]).toBe("pnpm run mutate");
    // Scope derived from the one change-summary builder over base and tip, then
    // filtered: the test file and the markdown are out (B-10).
    expect(mutationRun.mock.calls[0]![1]).toEqual(["src/cart.ts"]);
    expect(mutationRun.mock.calls[0]![2]).toEqual({ cwd: repo, encoding: "utf-8" });
    expect(result.verdict).toBe("SHIP");
  });

  it("[behavior:#303:B-11] reports what the report file says, not what the command printed", async () => {
    vi.mocked(quiesceWorktree).mockClear();
    const slug = "mutation-report-file";
    const repo = makeChangedRepo(slug);
    const fixture = makeJournal();
    const runCommand = ghRunCommand();
    const args = makeArgs(repo, slug, teeing(fixture), shipInvoke(slug), runCommand);
    args.mutationReport = CONFIG;
    args.mutationScope = async () => ["src/cart.ts"];
    args.mutationRun = async (_command, _files, options) => {
      writeReportInto(options.cwd);
      // Differently shaped from the report on purpose: a step that scraped
      // stdout would publish this, and every tool spells its log its own way.
      return "Ran 2 mutants; 1 survived (id 99 in src/nowhere.ts)\n";
    };

    const result = await runShipGate(args);

    expect(loadRunState(repo, slug).mutationStep).toEqual({
      runSlug: slug,
      status: "MUTATION_REPORTED",
      survivors: SURVIVORS,
    });
    expect(mutationEvents(fixture)).toEqual([
      {
        type: "mutation-step",
        runSlug: slug,
        status: "MUTATION_REPORTED",
        survivors: SURVIVORS,
      },
    ]);
    // B-15: the same derivation reaches the draft PR body, and the PR opens.
    const body = prBody(runCommand)!;
    expect(body).toContain(MUTATION_REPORT_HEADING);
    expect(body).toContain("- `42` src/cart.ts:3:11 — ArithmeticOperator");
    expect(body).not.toContain("id 99");
    expect(body).not.toContain("47%");
    // B-16: neither the verdict nor the PR decision moved.
    expect(result.verdict).toBe("SHIP");
    expect(result.pr).toMatchObject({ requested: true, overridden: false });
  });

  it("[behavior:#303:B-11] holds the gate until the step it started has been awaited", async () => {
    vi.mocked(quiesceWorktree).mockClear();
    const slug = "mutation-awaited";
    const repo = makeChangedRepo(slug);
    const fixture = makeJournal();
    let release: (() => void) | undefined;
    const runCommand = ghRunCommand();
    const args = makeArgs(repo, slug, teeing(fixture), shipInvoke(slug), runCommand);
    args.mutationReport = CONFIG;
    args.mutationScope = async () => ["src/cart.ts"];
    args.mutationRun = (_command, _files, options) =>
      new Promise<string>((resolve) => {
        release = () => {
          writeReportInto(options.cwd);
          resolve("done");
        };
      });

    let settled = false;
    const gate = runShipGate(args).then((value) => {
      settled = true;
      return value;
    });
    await flush();

    // The guardians are long done; the only thing left is the step. A gate that
    // returned here would publish a summary and a PR body with no answer in
    // them while a process was still live inside the review worktree.
    expect(settled).toBe(false);
    expect(prBody(runCommand)).toBeUndefined();
    release!();
    const result = await gate;

    expect(result.verdict).toBe("SHIP");
    expect(prBody(runCommand)).toContain("- `42` src/cart.ts:3:11");
    // The step's event lands before the draft PR starts, so the body derives
    // from a stream that already holds it.
    const payloads = fixture.event.mock.calls.map(
      ([payload]) => payload as RunEventPayload & { phase?: string },
    );
    const mutationAt = payloads.findIndex((p) => p.type === "mutation-step");
    const prAt = payloads.findIndex(
      (p) => p.type === "run-phase-started" && p.phase === "draft-pr",
    );
    expect(mutationAt).toBeGreaterThan(-1);
    expect(prAt).toBeGreaterThan(mutationAt);
  });

  it("[behavior:#303:B-12] terminates the step and reports BOUND_REACHED once the bound is spent", async () => {
    vi.mocked(quiesceWorktree).mockClear();
    const slug = "mutation-bound";
    const repo = makeChangedRepo(slug);
    const fixture = makeJournal();
    const runCommand = ghRunCommand();
    const args = makeArgs(repo, slug, teeing(fixture), shipInvoke(slug), runCommand);
    args.mutationReport = CONFIG;
    args.mutationScope = async () => ["src/cart.ts"];
    // Never settles: only the bound can end this run's step.
    args.mutationRun = () => new Promise<string>(() => {});
    // The rejoin origin is read first; by the time the helper asks again the
    // whole bound is spent, which is the deadline arithmetic under test.
    args.mutationNow = spentClock();

    const result = await runShipGate(args);

    expect(loadRunState(repo, slug).mutationStep).toEqual({
      runSlug: slug,
      status: "MUTATION_NOT_RUN",
      reason: "BOUND_REACHED",
      survivors: [],
    });
    // Terminated through the one quiesce path, on the review worktree; the seam
    // registered no process, which is what the empty report says.
    expect(vi.mocked(quiesceWorktree)).toHaveBeenCalledWith(repo);
    await expect(
      vi.mocked(quiesceWorktree).mock.results[0]!.value as Promise<unknown>,
    ).resolves.toMatchObject({ observed: [], terminated: [] });
    // B-15/B-16: the reason is published under this outcome too, the draft PR
    // still opens, and the ship verdict is untouched.
    const body = prBody(runCommand)!;
    expect(body).toContain(MUTATION_REPORT_HEADING);
    expect(body).toContain("BOUND_REACHED");
    expect(result.verdict).toBe("SHIP");
    expect(result.pr?.requested).toBe(true);
  });

  it("[behavior:#303:B-12] never spawns a step still deriving its scope once the bound is spent", async () => {
    vi.mocked(quiesceWorktree).mockClear();
    const slug = "mutation-bound-unspawned";
    const repo = makeChangedRepo(slug);
    const fixture = makeJournal();
    const runCommand = ghRunCommand();
    const args = makeArgs(repo, slug, teeing(fixture), shipInvoke(slug), runCommand);
    args.mutationReport = CONFIG;
    const mutationRun = vi.fn(async () => "");
    args.mutationRun = mutationRun;
    // Held ahead of the runner, so the bound is reached while the step is still
    // pre-spawn — the state the rejoin exit has to close as tightly as a
    // guardian rejection does.
    let releaseScope: (() => void) | undefined;
    args.mutationScope = () =>
      new Promise<readonly string[]>((resolve) => {
        releaseScope = () => resolve(["src/cart.ts"]);
      });
    args.mutationNow = spentClock();

    const result = await runShipGate(args);
    // Released only after the gate has gone and its quiesce has run: a step
    // that could still spawn here would put a command into a worktree the run
    // has already torn down.
    releaseScope!();
    await flush();

    expect(mutationRun).toHaveBeenCalledTimes(0);
    expect(vi.mocked(quiesceWorktree)).toHaveBeenCalledWith(repo);
    expect(loadRunState(repo, slug).mutationStep).toEqual({
      runSlug: slug,
      status: "MUTATION_NOT_RUN",
      reason: "BOUND_REACHED",
      survivors: [],
    });
    expect(result.verdict).toBe("SHIP");
  });

  it("[behavior:#303:B-12] takes the bounded wait's origin after both guardian results are in hand", async () => {
    vi.mocked(quiesceWorktree).mockClear();
    const slug = "mutation-rejoin-origin";
    const repo = makeChangedRepo(slug);
    const fixture = makeJournal();
    const runCommand = ghRunCommand();
    // Each guardian burns a whole bound, so the pre-fork instant and the
    // post-fork instant are more than one bound apart. An origin captured
    // before the fork therefore leaves a negative window and reports
    // BOUND_REACHED; only the post-fork instant leaves the step its window.
    const clock = guardianDrivenClock(MUTATION_STEP_BOUND_MS);
    const invoke = vi.fn(async (options: InvokeOptions) => {
      const kind = options.role === "architect-review" ? "architect" : "pm";
      writeReview(options, slug, kind, "SHIP");
      clock.guardianFinished();
      return invokeResult();
    });
    const args = makeArgs(repo, slug, teeing(fixture), invoke, runCommand);
    args.mutationReport = CONFIG;
    args.mutationScope = async () => ["src/cart.ts"];
    args.mutationRun = async (_command, _files, options) => {
      writeReportInto(options.cwd);
      return "";
    };
    args.mutationNow = clock.now;

    const spawnInstant = clock.at();
    const result = await runShipGate(args);
    const rejoinInstant = clock.at();

    // The guardians really did consume time on this clock, so the two candidate
    // origins are different numbers and the assertion below discriminates.
    expect(rejoinInstant).toBeGreaterThan(spawnInstant);
    // The origin is the first reading the gate takes, and it is the rejoin
    // instant — not the instant the step was spawned. Moving the capture above
    // the guardian mode fork makes this reading `spawnInstant` and fails here.
    expect(clock.readings[0]).toBe(rejoinInstant);
    expect(clock.readings[0]).not.toBe(spawnInstant);
    // And the consequence: the step keeps the whole flat bound measured from
    // that instant, so guardians that ran long do not spend the step's window.
    expect(loadRunState(repo, slug).mutationStep).toEqual({
      runSlug: slug,
      status: "MUTATION_REPORTED",
      survivors: SURVIVORS,
    });
    expect(result.verdict).toBe("SHIP");
  });

  it("[behavior:#303:B-11] reports the same gate ids and gate results with the declaration as without it", async () => {
    async function runOnce(declared: boolean) {
      vi.mocked(quiesceWorktree).mockClear();
      const slug = `mutation-gate-ids-${declared ? "declared" : "absent"}`;
      const repo = makeChangedRepo(slug);
      const fixture = makeJournal();
      const args = makeArgs(
        repo,
        slug,
        teeing(fixture),
        shipInvoke(slug),
        ghRunCommand(),
      );
      // Both runs are wired identically; only the declaration differs, which is
      // exactly what a run with and without `--mutation-report` differ by.
      args.mutationScope = async () => ["src/cart.ts"];
      args.mutationRun = async (_command, _files, options) => {
        writeReportInto(options.cwd);
        return "";
      };
      if (declared) args.mutationReport = CONFIG;
      const result = await runShipGate(args);
      return { surface: gateSurface(fixture), fixture, result };
    }

    const declared = await runOnce(true);
    const absent = await runOnce(false);

    // The declared run really ran the step, so this compares a run that
    // reported an outcome against one that had nothing to report.
    expect(mutationEvents(declared.fixture)).toHaveLength(1);
    expect(mutationEvents(absent.fixture)).toEqual([]);

    // Set-for-set identical: the step holds no gate id and builds no
    // `GateDeclaration`, so promoting it to a declared gate — the regression
    // ADR 0063's "reported, never a gate" rule exists to prevent — fails here.
    expect(declared.surface.length).toBeGreaterThan(0);
    expect(declared.surface).toEqual(absent.surface);
    expect(JSON.stringify(declared.surface)).not.toMatch(/mutation/i);
    expect(declared.result.verdict).toBe(absent.result.verdict);
  });

  it("[behavior:#303:P-01] runs nothing, publishes nothing and terminates nothing without the declaration", async () => {
    vi.mocked(quiesceWorktree).mockClear();
    const slug = "mutation-flag-absent";
    const repo = makeChangedRepo(slug);
    const fixture = makeJournal();
    const runCommand = ghRunCommand();
    const mutationRun = vi.fn(async () => "");
    const args = makeArgs(repo, slug, teeing(fixture), shipInvoke(slug), runCommand);
    // The seams are wired but the declaration is absent, which is what a run
    // without `--mutation-report` looks like from in here.
    args.mutationRun = mutationRun;
    args.mutationScope = async () => ["src/cart.ts"];

    const result = await runShipGate(args);

    expect(mutationRun).not.toHaveBeenCalled();
    expect(vi.mocked(quiesceWorktree)).not.toHaveBeenCalled();
    expect(mutationEvents(fixture)).toEqual([]);
    expect(loadRunState(repo, slug).mutationStep).toBeUndefined();
    expect(prBody(runCommand)).not.toContain(MUTATION_REPORT_HEADING);
    expect(result.verdict).toBe("SHIP");
    expect(result.pr).toMatchObject({ requested: true });
  });

  describe.each([
    ["serial", true],
    ["parallel", false],
  ])("[behavior:#303:P-03] a rejecting guardian in %s mode", (_mode, serial) => {
    /**
     * A guardian review that throws before any invocation: the one rejection
     * `runGuardianReview` propagates rather than classifying, so the fork region
     * really is left by a throw in both modes.
     */
    function rejectingArgs(slug: string, repo: string, sentinel: Error) {
      const fixture = makeJournal();
      const journal: ShipGateJournal = {
        ...teeing(fixture),
        agentLog: (sliceId, agent, round) => {
          if (agent === "pm-review") throw sentinel;
          return fixture.journal.agentLog(sliceId, agent, round);
        },
      };
      const runCommand = vi.fn<ShipCommandRunner>(() => "");
      const args = makeArgs(repo, slug, journal, shipInvoke(slug), runCommand);
      args.options = { ...args.options, serialReviews: serial };
      args.mutationReport = CONFIG;
      args.mutationNow = spentClock();
      return { args, fixture, runCommand };
    }

    it("[behavior:#303:P-03] abandons an already-started step, terminates it, and rethrows the guardian's own reason", async () => {
      vi.mocked(quiesceWorktree).mockClear();
      const slug = `mutation-reject-spawned-${serial ? "serial" : "parallel"}`;
      const repo = makeChangedRepo(slug);
      const sentinel = new Error("guardian log stream unavailable");
      const { args, fixture, runCommand } = rejectingArgs(slug, repo, sentinel);
      const mutationRun = vi.fn(() => new Promise<string>(() => {}));
      args.mutationScope = async () => ["src/cart.ts"];
      args.mutationRun = mutationRun;

      await expect(runShipGate(args)).rejects.toBe(sentinel);

      expect(mutationRun).toHaveBeenCalledTimes(1);
      expect(vi.mocked(quiesceWorktree)).toHaveBeenCalledWith(repo);
      await expect(
        vi.mocked(quiesceWorktree).mock.results[0]!.value as Promise<unknown>,
      ).resolves.toMatchObject({ observed: [], terminated: [] });
      // This exit publishes nothing: no event, no run-state record, no PR.
      expect(mutationEvents(fixture)).toEqual([]);
      expect(loadRunState(repo, slug).mutationStep).toBeUndefined();
      expect(prBody(runCommand)).toBeUndefined();
    });

    it("[behavior:#303:P-03] never starts a step still deriving its scope when the guardian rejects", async () => {
      vi.mocked(quiesceWorktree).mockClear();
      const slug = `mutation-reject-unspawned-${serial ? "serial" : "parallel"}`;
      const repo = makeChangedRepo(slug);
      const sentinel = new Error("guardian log stream unavailable");
      const { args, fixture, runCommand } = rejectingArgs(slug, repo, sentinel);
      const mutationRun = vi.fn(async () => "");
      let releaseScope: (() => void) | undefined;
      args.mutationScope = () =>
        new Promise<readonly string[]>((resolve) => {
          releaseScope = () => resolve(["src/cart.ts"]);
        });
      args.mutationRun = mutationRun;

      await expect(runShipGate(args)).rejects.toBe(sentinel);
      // Released only once the gate has gone: the abandonment flag is read with
      // no await before the invocation, so a step held here can never spawn a
      // process into a worktree the exit has already quiesced.
      releaseScope!();
      await flush();

      expect(mutationRun).toHaveBeenCalledTimes(0);
      expect(vi.mocked(quiesceWorktree)).toHaveBeenCalledWith(repo);
      expect(mutationEvents(fixture)).toEqual([]);
      expect(loadRunState(repo, slug).mutationStep).toBeUndefined();
      expect(prBody(runCommand)).toBeUndefined();
    });

    it("[behavior:#303:P-03] still rethrows the guardian's reason when termination itself fails", async () => {
      vi.mocked(quiesceWorktree).mockClear();
      const slug = `mutation-reject-quiesce-${serial ? "serial" : "parallel"}`;
      const repo = makeChangedRepo(slug);
      const sentinel = new Error("guardian log stream unavailable");
      const { args } = rejectingArgs(slug, repo, sentinel);
      args.mutationScope = async () => ["src/cart.ts"];
      args.mutationRun = () => new Promise<string>(() => {});
      vi.mocked(quiesceWorktree).mockRejectedValueOnce(new Error("quiesce failed"));

      // A failed quiesce is the worktree teardown's report to make; replacing
      // the guardian's reason with it would lose why the run stopped.
      await expect(runShipGate(args)).rejects.toBe(sentinel);
    });
  });
});

/**
 * The draft PR body's mutation section (#303 B-15).
 *
 * The body renders no second version of what survived: it takes
 * `readMutationStepOutcome`'s value through `formatMutationReportLines` — the
 * same reader and the same formatter `run-summary.md` renders its own section
 * from (B-14) — and it does so at both `buildPrCreationPlan` sites, the
 * ordinary one and the guardian cap exit's (src/ship-gate.ts:1461, :1526).
 * Asserted over hand-written event streams that are really read back, so a
 * divergence between the two renderings fails here rather than in a spawned run.
 */
describe("[behavior:#303:B-15] the draft PR body's mutation section", () => {
  const base = {
    prdSlug: "demo",
    specsDir: ".kiro/specs/demo",
    architect: "SHIP" as const,
    pm: "SHIP" as const,
    openPrOnOverride: false,
    closesIssues: ["303"],
  };
  /**
   * The cap exit's plan site: a blocked round that spent the cap opens the same
   * draft PR (ADR 0057 decision 4), so it must publish the same section.
   */
  const CAP_EXIT = {
    architect: "FIX-BEFORE-SHIP" as const,
    capExit: { cap: 3, unfavorableRounds: 3, filed: [] },
  };
  const SURVIVOR = {
    id: "42",
    file: "src/cart.ts",
    mutator: "ArithmeticOperator",
    position: { startLine: 3, startColumn: 11, endLine: 3, endColumn: 16 },
  };

  /** A real `events.jsonl` the reader parses, not an outcome handed in directly. */
  function readerOver(
    payload: Extract<RunEventPayload, { type: "mutation-step" }>,
  ) {
    const runDir = mkdtempSync(join(tmpdir(), "afk-mutation-pr-"));
    tempDirs.push(runDir);
    writeFileSync(
      join(runDir, "events.jsonl"),
      `${JSON.stringify(payload)}\n`,
      "utf-8",
    );
    return readMutationStepOutcome(runDir);
  }

  /**
   * The section's list block: the body's sections are joined by a blank line,
   * so the third block under the heading is exactly the formatter's lines.
   */
  function reportedLinesIn(body: string): string {
    const section = body.slice(body.indexOf(MUTATION_REPORT_HEADING));
    return section.split("\n\n")[2]!;
  }

  it.each([
    [
      "survivors",
      {
        type: "mutation-step" as const,
        runSlug: "demo",
        status: "MUTATION_REPORTED" as const,
        survivors: [
          SURVIVOR,
          {
            id: "43",
            file: "src/checkout.ts",
            mutator: "StringLiteral",
            position: { startLine: 4, startColumn: 20, endLine: 4, endColumn: 21 },
          },
        ],
      },
    ],
    [
      "no survivors",
      {
        type: "mutation-step" as const,
        runSlug: "demo",
        status: "MUTATION_REPORTED" as const,
        survivors: [],
      },
    ],
    [
      "a not-run reason",
      {
        type: "mutation-step" as const,
        runSlug: "demo",
        status: "MUTATION_NOT_RUN" as const,
        reason: "REPORT_MALFORMED" as const,
        survivors: [],
      },
    ],
  ])(
    "[behavior:#303:B-15] publishes the reader's own text at both plan sites and still opens the draft PR for %s",
    (_label, payload) => {
      const report = readerOver(payload);
      expect(report).toBeDefined();
      const expected = formatMutationReportLines(report!).join("\n");

      const plan = buildPrCreationPlan({ ...base, mutationStep: report });
      const capped = buildPrCreationPlan({
        ...base,
        ...CAP_EXIT,
        mutationStep: report,
      });

      // The same derivation, not a paraphrase of it: whatever the summary's
      // reader says is what the body carries, character for character.
      expect(reportedLinesIn(plan.body)).toBe(expected);
      expect(reportedLinesIn(capped.body)).toBe(expected);
      expect(plan.body).toContain(MUTATION_REPORT_HEADING);
      expect(capped.body).toContain(MUTATION_REPORT_HEADING);
      // Reported, never a gate (ADR 0063): every case still opens a draft PR,
      // and the cap exit is still the cap exit.
      expect(plan.open).toBe(true);
      expect(capped.open).toBe(true);
      expect(capped.cappedExit).toBe(true);
    },
  );
});

describe("[behavior:#303:B-16] the mutation outcome decides nothing", () => {
  const base = {
    prdSlug: "demo",
    specsDir: ".kiro/specs/demo",
    architect: "SHIP" as const,
    pm: "SHIP" as const,
    openPrOnOverride: false,
    closesIssues: ["303"],
  };

  it.each([
    [
      "survivors",
      {
        runSlug: "demo",
        status: "MUTATION_REPORTED" as const,
        survivors: [
          {
            id: "42",
            file: "src/cart.ts",
            mutator: "ArithmeticOperator",
            position: { startLine: 3, startColumn: 11, endLine: 3, endColumn: 16 },
          },
        ],
      },
    ],
    [
      "no survivors",
      { runSlug: "demo", status: "MUTATION_REPORTED" as const, survivors: [] },
    ],
    [
      "a step that never ran",
      {
        runSlug: "demo",
        status: "MUTATION_NOT_RUN" as const,
        reason: "COMMAND_FAILED" as const,
        survivors: [],
      },
    ],
  ])(
    "[behavior:#303:B-16] changes only the body text, never the decision, for %s",
    (_label, mutationStep) => {
      const without = buildPrCreationPlan(base);
      const withStep = buildPrCreationPlan({ ...base, mutationStep });

      expect(withStep.open).toBe(without.open);
      expect(withStep.overridden).toBe(without.overridden);
      expect(withStep.cappedExit).toBe(without.cappedExit);
      expect(withStep.title).toBe(without.title);
      // Additive: everything the body already said is still there, and the
      // section sits above the closes list like every other reported block.
      expect(withStep.body).toContain(MUTATION_REPORT_HEADING);
      expect(withStep.body.indexOf(MUTATION_REPORT_HEADING)).toBeLessThan(
        withStep.body.indexOf("Closes #303"),
      );
      expect(without.body).not.toContain(MUTATION_REPORT_HEADING);
    },
  );
});

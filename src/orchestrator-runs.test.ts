/**
 * Orchestrator tests, part 2 of 2: the run-state half — per-slice state
 * persistence (ADR 0018), the wall-clock ceiling (ADR 0019), the
 * generator verification command (ADR 0038), the events.jsonl tee
 * (spec #26), re-run visibility (#17), the narrowed re-run (#41),
 * merge-only recovery for MERGE-PENDING and the feature-branch launch
 * guard. The unit gates, lane scheduling, guardian reviews and run.log
 * blocks live in `orchestrator.test.ts`.
 *
 * Two files exist so one `vitest run` schedules the suite across both
 * workers (`maxWorkers: 2`) — a single file always pinned it to one.
 * Shared integration helpers are in `orchestrator.fixtures.ts`. When
 * adding a `describe`, keep the halves balanced by measured block time
 * (`--reporter=./scripts/describe-times.reporter.mjs`), not test count.
 */
import { describe, it, expect, afterAll, afterEach, beforeAll, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  collectRequiredGateFailures,
  isCancelled,
  makeAsyncMutex,
  makeSliceContext,
  resolveBaseGateDeclarations,
  runPipeline,
  runSliceNegotiate,
} from "./orchestrator.js";
import {
  buildPrCreationPlan,
  buildReviewScopeBlock,
} from "./ship-gate.js";
import {
  resolveGeneratorTestCommand,
  resolveSanityCommands,
  resolveTestCommand,
  runPreShipSanity,
  type SanityCommandOutcome,
  type SanityGateResult,
} from "./preship.js";
import { buildDAG, parseIssuesMd, type Slice } from "./issues-parser.js";
import { RunJournal as Logger } from "./run-journal.js";
import type {
  AgentProvider,
  InvokeOptions,
  InvokeResult,
} from "./agent-provider.js";
import { TransientProviderError } from "./agent-provider.js";
import {
  ProcessTreeTerminationError,
  runBoundedCommand,
} from "./command-runtime.js";
import type { GateDeclaration, GateEvidence } from "./gate-runner.js";
import { terminateProcessTree } from "./kill-tree.js";
import {
  installCancellationSignals,
  type SignalHost,
} from "./cancellation.js";
import { readRunEvents } from "./run-events.js";
import { readStopAck, writeStopRequest } from "./stop-sentinel.js";
import { runStatus } from "./status.js";
import { readContractStatus } from "./artifacts.js";
import {
  buildStubProvider,
  cleanupIntegrationTempDirs,
  findSliceArtifactDir,
  git,
  makeRepo,
  sliceFromCwd,
  writePrdFixture,
  type InvocationRecord,
  type SliceFixture,
} from "./orchestrator.fixtures.js";

afterEach(() => {
  cleanupIntegrationTempDirs();
});

describe("an impasse parks its slice and holds only DAG dependents", () => {
  it("resumes from a decision written while a sibling runs, then dispatches its dependent", async () => {
    // This fixture state cannot be reached by an existing pipeline run:
    // negotiation itself parks while a sibling passes and a dependent
    // remains undispatched.
    const repo = makeRepo();
    const slug = "impasse-dependency";
    const { prdDir, specsDir } = writePrdFixture(repo, slug);
    const slices: Slice[] = [
      {
        number: "01",
        ghIssue: "8181",
        title: "Parked foundation",
        type: "AFK",
        blockedBy: [],
        userStories: "",
      },
      {
        number: "02",
        ghIssue: "8182",
        title: "Independent sibling",
        type: "AFK",
        blockedBy: [],
        userStories: "",
      },
      {
        number: "03",
        ghIssue: "8183",
        title: "Dependent",
        type: "AFK",
        blockedBy: ["8181"],
        userStories: "",
      },
      {
        number: "04",
        ghIssue: "8184",
        title: "Preserved park",
        type: "AFK",
        blockedBy: [],
        userStories: "",
      },
      {
        number: "05",
        ghIssue: "8185",
        title: "Preserved dependent",
        type: "AFK",
        blockedBy: ["8184"],
        userStories: "",
      },
      {
        number: "06",
        ghIssue: "8186",
        title: "Planner lock refusal",
        type: "AFK",
        blockedBy: [],
        userStories: "",
      },
      {
        number: "07",
        ghIssue: "8187",
        title: "Applied lock refusal",
        type: "AFK",
        blockedBy: [],
        userStories: "",
      },
      {
        number: "08",
        ghIssue: "8188",
        title: "Applied stability refusal",
        type: "AFK",
        blockedBy: [],
        userStories: "",
      },
      // The two successful apply routes. Both are lanes of this wave
      // rather than runs of their own: the state they need — a parked
      // slice with a valid decision — is exactly what this fixture
      // already builds, and only the decision form differs.
      {
        number: "09",
        ghIssue: "8189",
        title: "Evaluator winner applied",
        type: "AFK",
        blockedBy: [],
        userStories: "",
      },
      {
        number: "10",
        ghIssue: "8190",
        title: "Third instruction applied",
        type: "AFK",
        blockedBy: [],
        userStories: "",
      },
    ];
    const fixtures = new Map<string, SliceFixture>([
      [
        "8181",
        {
          files: ["src/shared.txt"],
          contractImpasse: true,
          qaPasses: true,
          outputFile: "src/shared.txt",
          outputContent: "parked",
        },
      ],
      [
        "8182",
        {
          files: ["src/shared.txt"],
          qaPasses: true,
          outputFile: "src/shared.txt",
          outputContent: "continued",
        },
      ],
      [
        "8183",
        {
          files: ["src/dependent.txt"],
          qaPasses: true,
          outputFile: "src/dependent.txt",
          outputContent: "dependent",
        },
      ],
      [
        "8184",
        {
          files: ["src/preserved-park.txt"],
          contractImpasse: true,
          qaPasses: true,
          outputFile: "src/preserved-park.txt",
          outputContent: "preserved park",
        },
      ],
      [
        "8185",
        {
          files: ["src/preserved-dependent.txt"],
          qaPasses: true,
          outputFile: "src/preserved-dependent.txt",
          outputContent: "preserved dependent",
        },
      ],
      [
        "8186",
        {
          files: ["src/planner-lock-refusal.txt"],
          contractImpasse: true,
          qaPasses: true,
          outputFile: "src/planner-lock-refusal.txt",
          outputContent: "must not generate",
        },
      ],
      [
        "8187",
        {
          files: ["src/applied-lock-refusal.txt"],
          contractImpasse: true,
          qaPasses: true,
          outputFile: "src/applied-lock-refusal.txt",
          outputContent: "must not generate",
        },
      ],
      [
        "8188",
        {
          files: ["src/applied-stability-refusal.txt"],
          contractImpasse: true,
          qaPasses: true,
          outputFile: "src/applied-stability-refusal.txt",
          outputContent: "must not generate",
        },
      ],
      // `revisedFiles` differs from `files`, so the apply round's
      // contract and manifest are observably the revised ones and not
      // the pre-apply proposal carried through.
      [
        "8189",
        {
          files: ["src/evaluator-winner.txt"],
          revisedFiles: [
            "src/evaluator-winner.txt",
            "src/evaluator-winner-applied.txt",
          ],
          contractImpasse: true,
          qaPasses: true,
          outputFile: "src/evaluator-winner.txt",
          outputContent: "evaluator winner",
        },
      ],
      [
        "8190",
        {
          files: ["src/third-instruction.txt"],
          revisedFiles: [
            "src/third-instruction.txt",
            "src/third-instruction-applied.txt",
          ],
          contractImpasse: true,
          qaPasses: true,
          outputFile: "src/third-instruction.txt",
          outputContent: "third instruction",
        },
      ],
    ]);
    const records: InvocationRecord[] = [];
    /** Decision bytes the fixture wrote, per slice, for verbatim checks. */
    const writtenDecisions = new Map<string, string>();
    const stub = buildStubProvider({ fixtures, slices, records });
    const contractLockRefusals = new Map([
      ["8186", "injected adjudication lock-gate refusal"],
      ["8187", "injected planner-apply lock-gate refusal"],
    ]);
    const renumberAppliedManifestBehavior = (artifactDir: string) => {
      const manifestPath = join(artifactDir, "acceptance-manifest.json");
      const manifest = JSON.parse(
        readFileSync(manifestPath, "utf-8"),
      ) as {
        behaviors: Array<{ id: string }>;
      };
      manifest.behaviors[0]!.id = "B-02";
      writeFileSync(manifestPath, JSON.stringify(manifest), "utf-8");
    };
    const provider: AgentProvider = {
      name: stub.name,
      async invoke(options) {
        if (
          options.role === "generator" &&
          /-s02$/.test(options.cwd.replace(/\\/g, "/"))
        ) {
          for (const decision of [
            {
              ghIssue: "8181",
              number: "01",
              winningPosition: "PLANNER",
            },
            {
              ghIssue: "8186",
              number: "06",
              winningPosition: "PLANNER",
            },
            {
              ghIssue: "8187",
              number: "07",
              winningPosition: "EVALUATOR",
            },
            {
              ghIssue: "8188",
              number: "08",
              winningPosition: "EVALUATOR",
            },
            {
              ghIssue: "8189",
              number: "09",
              winningPosition: "EVALUATOR",
            },
            {
              ghIssue: "8190",
              number: "10",
              thirdInstruction:
                "Neither position stands: split the disputed behavior in two.",
            },
          ]) {
            const parkedCwd = records.find(
              (record) => record.ghIssue === decision.ghIssue,
            )?.cwd;
            if (!parkedCwd) {
              throw new Error(
                `parked worktree #${decision.ghIssue} was not invoked`,
              );
            }
            const parkedDir = findSliceArtifactDir(
              parkedCwd,
              decision.number,
            );
            if (!parkedDir) {
              throw new Error(
                `parked artifact directory #${decision.ghIssue} missing`,
              );
            }
            const raw = JSON.stringify({
              version: 1,
              findingId: "F-IMPASSE",
              ...("winningPosition" in decision
                ? { winningPosition: decision.winningPosition }
                : { thirdInstruction: decision.thirdInstruction }),
              author: "operator",
            });
            writtenDecisions.set(decision.ghIssue, raw);
            writeFileSync(join(parkedDir, "adjudication.md"), raw, "utf-8");
          }
        }
        const result = await stub.invoke(options);
        const invokedSlice = sliceFromCwd(options.cwd, slices);
        if (
          options.role === "planner" &&
          invokedSlice?.ghIssue === "8188"
        ) {
          const artifactDir = findSliceArtifactDir(
            options.cwd,
            invokedSlice.number,
          );
          if (!artifactDir) {
            throw new Error(
              `lock-refusal artifact directory #${invokedSlice.ghIssue} missing`,
            );
          }
          if (existsSync(join(artifactDir, "adjudication.md"))) {
            renumberAppliedManifestBehavior(artifactDir);
          }
        }
        return result;
      },
    };

    const result = await runPipeline({
      repoRoot: repo,
      prdSlug: slug,
      prdDir,
      specsDir,
      dag: buildDAG(slices),
      provider,
      adjudicationWaitMs: 5_000,
      adjudicationPollMs: 10,
      onContractLocked(ghIssue, contractPath) {
        if (!existsSync(join(dirname(contractPath), "adjudication.md"))) {
          return null;
        }
        return contractLockRefusals.get(ghIssue) ?? null;
      },
    });

    for (const id of ["8181", "8182", "8183"]) {
      expect(
        records.some(
          (record) => record.ghIssue === id && record.role === "generator",
        ),
      ).toBe(true);
    }
    const state = JSON.parse(
      readFileSync(
        join(repo, ".afk", "state", `${slug}-stub.json`),
        "utf-8",
      ),
    );
    expect(state.slices["8181"]?.phase).toBe("PASS");
    expect(state.slices["8182"]?.phase).toBe("PASS");
    expect(state.slices["8183"]?.phase).toBe("PASS");
    const preservedBranch =
      "afk-stub/impasse-dependency-slice-04-preserved-park";
    expect(state.slices["8184"]).toMatchObject({
      phase: "AWAITING-ADJUDICATION",
      branch: preservedBranch,
    });
    expect(state.slices["8185"]).toBeUndefined();
    expect(
      records.some((record) => record.ghIssue === "8185"),
    ).toBe(false);
    expect(result.summary).toMatch(
      new RegExp(
        String.raw`\| 8184 Preserved park \| [^|]*AWAITING-ADJUDICATION[^|]*\| [^|]*\| ${preservedBranch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \|`,
      ),
    );
    expect(result.summary).toContain(
      "| #8185 Preserved dependent | #8184 (AWAITING-ADJUDICATION) |",
    );
    const status = runStatus([], repo);
    expect(status.exitCode).toBe(0);
    expect(status.output).toContain(
      `#8184 Preserved park: AWAITING-ADJUDICATION — branch preserved: ${preservedBranch}`,
    );
    expect(status.output).toContain(
      "#8185 — explorer → planner → evaluator-contract → generator → evaluator-qa — waits on #8184 (AWAITING-ADJUDICATION)",
    );

    const lockRefusals = [
      {
        ghIssue: "8186",
        number: "06",
        text: "injected adjudication lock-gate refusal",
        plannerInvocations: 2,
      },
      {
        ghIssue: "8187",
        number: "07",
        text: "injected planner-apply lock-gate refusal",
        plannerInvocations: 3,
      },
      {
        ghIssue: "8188",
        number: "08",
        text: "behavior ID stability refused: unchanged behavior renumbered B-01 -> B-02",
        plannerInvocations: 3,
      },
    ];
    const runParent = join(repo, ".afk", "logs", `${slug}-stub`);
    const latestRunDir = readdirSync(runParent)
      .filter((entry) => /^run-\d{8}-\d{6}/.test(entry))
      .sort()
      .at(-1)!;
    const runLog = readFileSync(
      join(runParent, latestRunDir, "run.log"),
      "utf-8",
    );
    for (const refusal of lockRefusals) {
      expect(
        records.some(
          (record) =>
            record.ghIssue === refusal.ghIssue &&
            record.role === "generator",
        ),
      ).toBe(false);
      expect(
        records.filter(
          (record) =>
            record.ghIssue === refusal.ghIssue &&
            record.role === "planner",
        ),
      ).toHaveLength(refusal.plannerInvocations);
      const worktree = records.find(
        (record) => record.ghIssue === refusal.ghIssue,
      )?.cwd;
      if (!worktree) {
        throw new Error(`lock-refusal worktree #${refusal.ghIssue} missing`);
      }
      const artifactDir = findSliceArtifactDir(worktree, refusal.number);
      if (!artifactDir) {
        throw new Error(
          `lock-refusal artifact directory #${refusal.ghIssue} missing`,
        );
      }
      expect(
        readContractStatus(join(artifactDir, "contract.md")),
      ).not.toBe("LOCKED");
      expect(state.slices[refusal.ghIssue]).toMatchObject({
        phase: "ESCALATE",
        error: expect.stringContaining(refusal.text),
      });
      expect(runLog).toContain(refusal.text);
    }

    // The two successful apply routes. The refusal lanes above prove the
    // gates can stop generation; these prove the same code path reaches
    // generation once the gates pass — which is the half B-03 asks for
    // and the half a refusal case cannot show.
    const featBranch = `feat-stub/${slug}`;
    const trackedPaths = git(repo, [
      "ls-tree",
      "-r",
      "--name-only",
      featBranch,
    ]).split(/\r?\n/);
    const committedArtifact = (sliceNumber: string, name: string): string => {
      const path = trackedPaths.find(
        (entry) =>
          entry.includes(`/slices/${sliceNumber}-`) &&
          entry.endsWith(`/${name}`),
      );
      if (!path) {
        throw new Error(`${name} for slice ${sliceNumber} is not on ${featBranch}`);
      }
      return git(repo, ["show", `${featBranch}:${path}`]);
    };
    for (const applied of [
      {
        ghIssue: "8189",
        number: "09",
        revisedFiles: [
          "src/evaluator-winner.txt",
          "src/evaluator-winner-applied.txt",
        ],
      },
      {
        ghIssue: "8190",
        number: "10",
        revisedFiles: [
          "src/third-instruction.txt",
          "src/third-instruction-applied.txt",
        ],
      },
    ]) {
      const sliceRecords = records.filter(
        (record) => record.ghIssue === applied.ghIssue,
      );
      // Exactly one apply invocation: rounds 1 and 2 are the ordinary
      // negotiation that deadlocked, the third is the apply.
      const plannerRecords = sliceRecords.filter(
        (record) => record.role === "planner",
      );
      expect(plannerRecords).toHaveLength(3);
      // ...and the human never goes back to the contract evaluator.
      expect(
        sliceRecords.filter(
          (record) => record.role === "evaluator-contract",
        ),
      ).toHaveLength(2);

      // The decision and the contested finding reach the apply planner
      // byte-for-byte, not paraphrased.
      const applyPlanner = plannerRecords.at(-1)!;
      expect(applyPlanner.prompt).toContain(
        writtenDecisions.get(applied.ghIssue)!,
      );
      expect(applyPlanner.prompt).toContain("F-IMPASSE");
      expect(applyPlanner.prompt).toContain(
        '"plannerEvidence": "planner evidence for F-IMPASSE"',
      );
      expect(applyPlanner.prompt).toContain(
        '"evaluatorEvidence": "\\"the evaluator-held interpretation\\""',
      );
      expect(applyPlanner.prompt).toContain(
        "Apply this decision exactly once. Do not re-adjudicate it.",
      );

      // The revised artifacts are what shipped — the post-apply scope,
      // not the pre-apply proposal carried through.
      expect(committedArtifact(applied.number, "contract.md")).toBe(
        [
          "# Slice Contract",
          "",
          "**Status:** LOCKED",
          "",
          "## Files expected to change",
          ...applied.revisedFiles.map((file) => `- ${file}`),
        ].join("\n"),
      );
      expect(
        JSON.parse(committedArtifact(applied.number, "acceptance-manifest.json")),
      ).toMatchObject({
        version: 2,
        fileScope: { kind: "paths", paths: applied.revisedFiles },
        behaviors: [{ id: "B-01" }],
      });

      // Generation happened, and only after the lock gates passed.
      const generatorRecords = sliceRecords.filter(
        (record) => record.role === "generator",
      );
      expect(generatorRecords).toHaveLength(1);
      expect(generatorRecords[0]!.startedAt).toBeGreaterThanOrEqual(
        applyPlanner.finishedAt,
      );
      expect(state.slices[applied.ghIssue]?.phase).toBe("PASS");
      const sliceLog = runLog
        .split(/\r?\n/)
        .filter((line) => line.includes(`#${applied.ghIssue}`));
      const lockedAt = sliceLog.findIndex((line) =>
        line.includes("accepted adjudication for F-IMPASSE; contract LOCKED"),
      );
      const implementingAt = sliceLog.findIndex((line) =>
        line.includes("implementing (round 1"),
      );
      expect(lockedAt).toBeGreaterThanOrEqual(0);
      expect(implementingAt).toBeGreaterThan(lockedAt);
    }
  }, 240_000);
});

describe("adjudication expiry and next-run pickup", () => {
  it("re-parks without agents, then consumes a pre-existing decision before ordinary negotiation", async () => {
    // No existing scenario carries one parked worktree through expiry,
    // a no-file retry, and a later decision, so this needs its own run.
    const repo = makeRepo();
    const slug = "adjudication-next-run";
    const { prdDir, specsDir } = writePrdFixture(repo, slug);
    const slice: Slice = {
      number: "01",
      ghIssue: "8191",
      title: "Parked across runs",
      type: "AFK",
      blockedBy: [],
      userStories: "",
    };
    const slices = [slice];
    const fixtures = new Map<string, SliceFixture>([
      [
        slice.ghIssue,
        {
          files: ["src/resumed.txt"],
          contractImpasse: true,
          qaPasses: true,
          outputFile: "src/resumed.txt",
          outputContent: "resumed",
        },
      ],
    ]);
    const records: InvocationRecord[] = [];
    const provider = buildStubProvider({ fixtures, slices, records });
    const config = {
      repoRoot: repo,
      prdSlug: slug,
      prdDir,
      specsDir,
      dag: buildDAG(slices),
      provider,
      adjudicationWaitMs: 0,
      adjudicationPollMs: 10,
    };

    await runPipeline(config);
    const afterInitialNegotiation = records.length;
    let state = JSON.parse(
      readFileSync(
        join(repo, ".afk", "state", `${slug}-stub.json`),
        "utf-8",
      ),
    );
    expect(state.slices[slice.ghIssue]?.phase).toBe(
      "AWAITING-ADJUDICATION",
    );

    const parkedCwd = records.find(
      (record) => record.ghIssue === slice.ghIssue,
    )?.cwd;
    if (!parkedCwd) throw new Error("parked worktree was not invoked");
    const parkedDir = findSliceArtifactDir(parkedCwd, slice.number);
    if (!parkedDir) throw new Error("parked artifact directory missing");
    const decisionPath = join(parkedDir, "adjudication.md");
    const malformedDecision = '{"version":1,\r\n';
    writeFileSync(decisionPath, malformedDecision, "utf-8");

    await runPipeline(config);
    expect(records).toHaveLength(afterInitialNegotiation);
    state = JSON.parse(
      readFileSync(
        join(repo, ".afk", "state", `${slug}-stub.json`),
        "utf-8",
      ),
    );
    expect(state.slices[slice.ghIssue]?.phase).toBe(
      "AWAITING-ADJUDICATION",
    );
    expect(state.slices[slice.ghIssue]?.error).toContain(
      "adjudication.md is not valid JSON",
    );
    expect(readFileSync(decisionPath, "utf-8")).toBe(malformedDecision);

    rmSync(decisionPath);
    await runPipeline(config);
    expect(records).toHaveLength(afterInitialNegotiation);
    state = JSON.parse(
      readFileSync(
        join(repo, ".afk", "state", `${slug}-stub.json`),
        "utf-8",
      ),
    );
    expect(state.slices[slice.ghIssue]?.phase).toBe(
      "AWAITING-ADJUDICATION",
    );

    writeFileSync(
      decisionPath,
      JSON.stringify({
        version: 1,
        findingId: "F-IMPASSE",
        winningPosition: "PLANNER",
        author: "operator",
      }),
      "utf-8",
    );
    const ordinaryNegotiationBefore = records.filter((record) =>
      ["explorer", "planner", "evaluator-contract"].includes(record.role),
    ).length;

    await runPipeline(config);

    const ordinaryNegotiationAfter = records.filter((record) =>
      ["explorer", "planner", "evaluator-contract"].includes(record.role),
    ).length;
    expect(ordinaryNegotiationAfter).toBe(ordinaryNegotiationBefore);
    expect(
      records.some(
        (record) =>
          record.ghIssue === slice.ghIssue && record.role === "generator",
      ),
    ).toBe(true);
    state = JSON.parse(
      readFileSync(
        join(repo, ".afk", "state", `${slug}-stub.json`),
        "utf-8",
      ),
    );
    expect(state.slices[slice.ghIssue]?.phase).toBe("PASS");
  }, 240_000);
});

describe("cancellation after an impasse park", () => {
  it("cancels only unsettled work and leaves the parked state and artifacts byte-stable", async () => {
    // This state differs from every existing cancellation fixture: one
    // slice is terminally parked while its sibling is still active.
    const repo = makeRepo();
    const slug = "cancel-after-impasse";
    const { prdDir, specsDir } = writePrdFixture(repo, slug);
    const slices: Slice[] = [
      {
        number: "01",
        ghIssue: "8281",
        title: "Parked",
        type: "AFK",
        blockedBy: [],
        userStories: "",
      },
      {
        number: "02",
        ghIssue: "8282",
        title: "Active sibling",
        type: "AFK",
        blockedBy: [],
        userStories: "",
      },
    ];
    const fixtures = new Map<string, SliceFixture>([
      [
        "8281",
        {
          files: ["src/parked.txt"],
          contractImpasse: true,
          qaPasses: true,
          outputFile: "src/parked.txt",
          outputContent: "parked",
        },
      ],
      [
        "8282",
        {
          files: ["src/active.txt"],
          qaPasses: true,
          outputFile: "src/active.txt",
          outputContent: "active",
        },
      ],
    ]);
    const records: InvocationRecord[] = [];
    const stub = buildStubProvider({ fixtures, slices, records });
    const controller = new AbortController();
    let before:
      | {
          parkedState: Record<string, unknown>;
          files: Array<{ path: string; contents: string }>;
        }
      | undefined;
    const provider: AgentProvider = {
      name: stub.name,
      async invoke(options) {
        const result = await stub.invoke(options);
        if (
          options.role === "generator" &&
          /-s02$/.test(options.cwd.replace(/\\/g, "/"))
        ) {
          const parkedCwd = records.find(
            (record) => record.ghIssue === "8281",
          )?.cwd;
          if (!parkedCwd) throw new Error("parked worktree was not invoked");
          const parkedDir = findSliceArtifactDir(parkedCwd, "01");
          if (!parkedDir) throw new Error("parked artifact directory missing");
          const archiveDir = join(
            repo,
            ".afk",
            "artifacts",
            `${slug}-stub`,
            "slice-01",
          );
          const adjudicationPath = join(parkedDir, "adjudication.md");
          writeFileSync(
            adjudicationPath,
            '{"version":1,"findingId":"F-IMPASSE"}\r\n',
            "utf-8",
          );
          const evidencePaths = [
            join(parkedDir, "contract.md"),
            join(parkedDir, "contract-negotiation-outcome.json"),
            join(parkedDir, "stuck.md"),
            adjudicationPath,
            join(archiveDir, "contract.md"),
            join(archiveDir, "contract-negotiation-outcome.json"),
            join(archiveDir, "stuck.md"),
          ];
          const state = JSON.parse(
            readFileSync(
              join(repo, ".afk", "state", `${slug}-stub.json`),
              "utf-8",
            ),
          );
          before = {
            parkedState: state.slices["8281"],
            files: evidencePaths.map((path) => ({
              path,
              contents: readFileSync(path, "utf-8"),
            })),
          };
          controller.abort();
        }
        return result;
      },
    };

    await runPipeline({
      repoRoot: repo,
      prdSlug: slug,
      prdDir,
      specsDir,
      dag: buildDAG(slices),
      provider,
      signal: controller.signal,
      adjudicationWaitMs: 10_000,
      adjudicationPollMs: 10_000,
    });

    expect(before).toBeDefined();
    const finalState = JSON.parse(
      readFileSync(
        join(repo, ".afk", "state", `${slug}-stub.json`),
        "utf-8",
      ),
    );
    expect(finalState.slices["8281"]).toEqual(before!.parkedState);
    expect(finalState.slices["8281"]).toMatchObject({
      phase: "AWAITING-ADJUDICATION",
      branch: expect.any(String),
    });
    expect(finalState.slices["8282"]?.phase).toBe("CANCELLED");
    for (const file of before!.files) {
      expect(readFileSync(file.path, "utf-8"), file.path).toBe(file.contents);
    }
    expect(
      records.some(
        (record) =>
          record.ghIssue === "8281" && record.role === "generator",
      ),
    ).toBe(false);
  }, 240_000);
});


/**
 * Per-slice state persistence (ADR 0018). A slice's terminal outcome
 * must be on disk the moment it lands — for PASS, right after its merge
 * — not when its wave finishes. Observed failure mode this guards: a
 * slice merged mid-wave, the process was hard-killed hours later while
 * its serial lane was still running, and the re-run re-attempted the
 * already-merged slice against its own output.
 */
describe("runPipeline per-slice state persistence", () => {
  it("persists a mid-wave PASS before the lane successor starts; a crash there resumes skipping exactly that slice", async () => {
    const repo = makeRepo();
    const slug = "midwave-persist";
    const { prdDir, specsDir } = writePrdFixture(repo, slug);

    const slices: Slice[] = [
      { number: "01", ghIssue: "7001", title: "First", type: "AFK", blockedBy: [], userStories: "" },
      { number: "02", ghIssue: "7002", title: "Second", type: "AFK", blockedBy: [], userStories: "" },
    ];
    // Shared file → one serial lane → 7002 starts only after 7001 merged.
    const fixtures = new Map<string, SliceFixture>([
      ["7001", { files: ["src/lane.txt"], qaPasses: true, outputFile: "src/lane.txt", outputContent: "first slice content" }],
      ["7002", { files: ["src/lane.txt"], qaPasses: true, outputFile: "src/lane.txt", outputContent: "second slice content" }],
    ]);

    const statePath = join(repo, ".afk", "state", `${slug}-stub.json`);

    // --- Run 1: "crash" while the lane successor is running. ---
    // The wrapped provider snapshots the state file at 7002's
    // lane-refresh explorer (its second explorer invocation — the first
    // ran during parallel Phase A). That snapshot is byte-for-byte the
    // disk state a hard kill at that moment would leave. It then keeps
    // throwing so 7002 cannot complete in this run.
    let snapshot: string | null = null;
    const records1: InvocationRecord[] = [];
    const inner1 = buildStubProvider({ fixtures, slices, records: records1 });
    let explorer7002Count = 0;
    const crashingProvider: AgentProvider = {
      name: "stub",
      async invoke(options: InvokeOptions): Promise<InvokeResult> {
        const slice = sliceFromCwd(options.cwd, slices);
        if (slice?.ghIssue === "7002" && options.role === "explorer") {
          explorer7002Count++;
          if (explorer7002Count >= 2) {
            if (snapshot === null && existsSync(statePath)) {
              snapshot = readFileSync(statePath, "utf-8");
            }
            throw new Error("simulated hard crash");
          }
        }
        return inner1.invoke(options);
      },
    };

    await runPipeline({
      repoRoot: repo,
      prdSlug: slug,
      prdDir,
      specsDir,
      dag: buildDAG(slices),
      provider: crashingProvider,
    });

    // The core guarantee: while the wave was still open, 7001's PASS
    // (with mergedToFeature) was already on disk.
    expect(snapshot).not.toBeNull();
    const midWaveState = JSON.parse(snapshot!);
    expect(midWaveState.slices["7001"]).toMatchObject({
      phase: "PASS",
      mergedToFeature: true,
    });
    expect(midWaveState.slices["7002"]).toBeUndefined();

    // --- Simulate the hard kill: restore the state file to exactly what
    // disk held mid-wave (7001 PASS, 7002 absent). Run 1 exited
    // gracefully and wrote 7002's ERROR; a kill would not have. ---
    writeFileSync(statePath, snapshot!);

    // --- Run 2: everything passes. ---
    const records2: InvocationRecord[] = [];
    const provider2 = buildStubProvider({ fixtures, slices, records: records2 });
    const result = await runPipeline({
      repoRoot: repo,
      prdSlug: slug,
      prdDir,
      specsDir,
      dag: buildDAG(slices),
      provider: provider2,
    });

    // Unsuccessful only because the stub's no-op guardian reviews leave
    // no verdict to ship on (issue #43); both slices are PASS below.
    expect(result.success).toBe(false);
    // The re-run skipped exactly the already-merged slice — zero agent
    // invocations for 7001 — and ran the crashed slice to completion.
    expect(records2.some((r) => r.ghIssue === "7001")).toBe(false);
    expect(records2.some((r) => r.ghIssue === "7002")).toBe(true);

    const finalState = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(finalState.slices["7001"]).toMatchObject({
      phase: "PASS",
      mergedToFeature: true,
    });
    expect(finalState.slices["7002"]).toMatchObject({
      phase: "PASS",
      mergedToFeature: true,
    });

    // The feature branch ends with the successor's content on top —
    // built on 7001's merge from run 1, which was not re-attempted.
    git(repo, ["checkout", `feat-stub/${slug}`]);
    const lane = readFileSync(join(repo, "src", "lane.txt"), "utf-8");
    expect(lane).toContain("second slice content");
  }, 240_000);
});



/**
 * Configurable wall-clock ceiling (ADR 0019). The 60 min provider
 * default killed a healthy generator mid-slice; generator and
 * evaluator-qa now get a role-aware 120 min default and
 * `--max-agent-duration-ms` overrides every role uniformly. A ceiling
 * kill during slice execution is terminal (no infrastructure retry) and
 * the persisted error points the operator at the remedy.
 */
/**
 * Cancellation bookkeeping, written when the stop is *requested* (issue
 * #114). Observed failure: only CTRL_BREAK_EVENT stopped a live Windows
 * run, and that exit skipped the abort path — no stop line in run.log and
 * no run-state entry at all for the slice that was mid-generator. A later
 * `--only-failed` then saw an unmerged slice branch with no state, which
 * reads as "never ran" (#113).
 *
 * This is a new spawned scenario on purpose (AGENTS.md, "Where a new
 * assertion goes", case 4): no existing fixture stops mid-slice. The
 * closest one, "cancellation landed after the last merge but before the
 * ship gates" in orchestrator.test.ts, cancels when every slice is
 * already PASS — the state it asserts is the state this bug leaves
 * empty. The spawn is short: the run stops during the first slice's first
 * generator round, so no QA, merge or ship gate runs.
 *
 * The stop is delivered through the `afk stop` **sentinel** (ADR 0043)
 * rather than by calling `abort()` directly, and the wiring under test is
 * the CLI's own: a real `installCancellationSignals` handle whose
 * `requestStop` the pipeline reaches through `requestCancellation`. That
 * is the claim worth a spawn — the delivery that could not be trusted was
 * the delivery, so proving the file reaches ADR 0040's records is proving
 * the thing. The raw-signal path keeps its own coverage in
 * `cancellation.test.ts` and in the ship-gate cancellation case. Every
 * assertion below is the same assertion this block already made; only the
 * button pressed to reach them changed.
 */
describe("a cancellation requested mid-slice by the stop sentinel", () => {
  const slug = "cancel-midslice";
  let repo: string;
  let statePath: string;
  let runDir: string;
  /** Run state as it stood the instant the run acknowledged the stop. */
  let atAbort: {
    slices: Record<string, { phase?: string; branch?: string; error?: string }>;
  };
  let finalState: {
    slices: Record<string, { phase?: string; error?: string }>;
  };
  let runLog: string;
  let ack: ReturnType<typeof readStopAck>;
  /** Read in `beforeAll`: `afterEach` deletes the fixture repo. */
  let stopWarnEvents: unknown[];
  let result: Awaited<ReturnType<typeof runPipeline>>;

  beforeAll(async () => {
    repo = makeRepo();
    const { prdDir, specsDir } = writePrdFixture(repo, slug);
    const slices: Slice[] = [
      { number: "01", ghIssue: "8101", title: "In flight", type: "AFK", blockedBy: [], userStories: "" },
      { number: "02", ghIssue: "8102", title: "Never started", type: "AFK", blockedBy: ["8101"], userStories: "" },
    ];
    const fixtures = new Map<string, SliceFixture>([
      ["8101", { files: ["src/a.txt"], qaPasses: true, outputFile: "src/a.txt", outputContent: "a" }],
      ["8102", { files: ["src/b.txt"], qaPasses: true, outputFile: "src/b.txt", outputContent: "b" }],
    ]);
    statePath = join(repo, ".afk", "state", `${slug}-stub.json`);
    const logsDir = join(repo, ".afk", "logs", `${slug}-stub`);

    // The CLI's composition, with a fake `process` so the test never
    // registers real signal handlers: signals and the sentinel share one
    // AbortController and one escalation counter.
    const host: SignalHost = {
      platform: "win32",
      on: () => host,
      off: () => host,
      exit: () => undefined,
    };
    const cancellation = installCancellationSignals({ host, log: () => {} });

    // Stop the run the way an operator does with `afk stop`: drop the
    // sentinel in the run's log directory while 8101's generator is the
    // in-flight work, before anything of its own has landed.
    const inner = buildStubProvider({ fixtures, slices, records: [] });
    let snapshot: string | null = null;
    const provider: AgentProvider = {
      name: "stub",
      async invoke(options: InvokeOptions): Promise<InvokeResult> {
        if (options.role === "generator" && snapshot === null) {
          runDir = join(
            logsDir,
            readdirSync(logsDir).find((d) => /^run-\d{8}-\d{6}/.test(d))!,
          );
          writeStopRequest(runDir, {
            requestedAt: new Date().toISOString(),
            source: "afk stop",
          });
          // Wait for the run's own acknowledgement rather than for a
          // duration: the ack is written after the abort path returns, so
          // whatever is on disk here is what a process killed the instant
          // the stop landed would leave behind.
          const deadline = Date.now() + 30_000;
          while (readStopAck(runDir) === null && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 20));
          }
          snapshot = existsSync(statePath)
            ? readFileSync(statePath, "utf-8")
            : "{}";
        }
        return inner.invoke(options);
      },
    };

    result = await runPipeline({
      repoRoot: repo,
      prdSlug: slug,
      prdDir,
      specsDir,
      dag: buildDAG(slices),
      provider,
      signal: cancellation.signal,
      requestCancellation: () => cancellation.requestStop("stop sentinel"),
      // Poll faster than the 2s production default so the fixture does
      // not spend two seconds waiting for a tick.
      stopSentinelIntervalMs: 25,
    });
    cancellation.dispose();

    atAbort = JSON.parse(snapshot ?? "{}");
    finalState = JSON.parse(readFileSync(statePath, "utf-8"));
    ack = readStopAck(runDir);
    runLog = readFileSync(join(runDir, "run.log"), "utf-8");
    stopWarnEvents = readRunEvents(runDir)!.events.filter(
      (event) => event.type === "warn" && event.reason === "stop-requested",
    );
  }, 240_000);

  it("has the in-flight slice CANCELLED in run state before the wave unwinds", () => {
    expect(atAbort.slices["8101"]).toMatchObject({
      phase: "CANCELLED",
      error: "Cancelled by user",
    });
    // With the branch, so the next run can find the preserved work.
    expect(atAbort.slices["8101"]?.branch).toBe(
      `afk-stub/${slug}-slice-01-in-flight`,
    );
  });

  it("marks the slice that never started too", () => {
    expect(atAbort.slices["8102"]?.phase).toBe("CANCELLED");
  });

  it("writes a stop line to run.log naming what it recorded", () => {
    expect(runLog).toContain("Cancellation requested");
    expect(runLog).toMatch(/Cancellation requested — marked CANCELLED[^\n]*#8101/);
  });

  it("keeps both slices CANCELLED once the run unwinds", () => {
    expect(finalState.slices["8101"]?.phase).toBe("CANCELLED");
    expect(finalState.slices["8102"]?.phase).toBe("CANCELLED");
    expect(result.success).toBe(false);
  });

  it("says in run.log that the stop came from the sentinel, and who asked", () => {
    // Two lines, in this order: the sentinel was seen, then the abort
    // path it pressed recorded what it recorded. An operator reading
    // run.log after the fact can tell a file-delivered stop from a
    // Ctrl-Break without consulting their shell history.
    expect(runLog).toContain("Stop requested via sentinel");
    expect(runLog).toContain("requested by afk stop");
    expect(runLog.indexOf("Stop requested via sentinel")).toBeLessThan(
      runLog.indexOf("Cancellation requested"),
    );
  });

  it("acknowledges with the run ID and the slices it marked — the ack `afk stop` reports", () => {
    // The ack is the whole contract with the writer: it exists only after
    // the CANCELLED records are on disk, and it names them. That is what
    // `GenerateConsoleCtrlEvent` returning TRUE never told anyone.
    expect(ack?.runId).toBe(basename(runDir));
    expect(ack?.cancelledSlices.sort()).toEqual(["8101", "8102"]);
    expect(Object.keys(atAbort.slices).sort()).toEqual(
      ack!.cancelledSlices.sort(),
    );
  });

  it("tees the sentinel stop as a typed warn event for `afk status`", () => {
    expect(stopWarnEvents).toHaveLength(1);
  });
});

describe("wall-clock ceiling configuration (ADR 0019)", () => {
  function makeSingleSliceSetup(slug: string, ghIssue: string) {
    const repo = makeRepo();
    const { prdDir, specsDir } = writePrdFixture(repo, slug);
    const slices: Slice[] = [
      {
        number: "01",
        ghIssue,
        title: "Ceiling slice",
        type: "AFK",
        blockedBy: [],
        userStories: "",
      },
    ];
    const fixtures = new Map<string, SliceFixture>([
      [
        ghIssue,
        {
          files: ["src/ceiling.txt"],
          qaPasses: true,
          outputFile: "src/ceiling.txt",
          outputContent: "ceiling",
        },
      ],
    ]);
    const records: InvocationRecord[] = [];
    const baseProvider = buildStubProvider({ fixtures, slices, records });
    return { repo, prdDir, specsDir, slices, baseProvider };
  }

  /** Wrap the stub to record the maxDurationMs each role received. */
  function recordingProvider(
    baseProvider: AgentProvider,
    seen: Map<string, Array<number | undefined>>,
  ): AgentProvider {
    return {
      name: baseProvider.name,
      async invoke(options) {
        const list = seen.get(options.role) ?? [];
        list.push(options.maxDurationMs);
        seen.set(options.role, list);
        return baseProvider.invoke(options);
      },
    };
  }

  it("gives generator and evaluator-qa the slow-agent 120 min ceiling and leaves fast roles on the provider default", async () => {
    const slug = "ceiling-defaults";
    const { repo, prdDir, specsDir, slices, baseProvider } =
      makeSingleSliceSetup(slug, "9301");
    const seen = new Map<string, Array<number | undefined>>();

    const result = await runPipeline({
      repoRoot: repo,
      prdSlug: slug,
      prdDir,
      specsDir,
      dag: buildDAG(slices),
      provider: recordingProvider(baseProvider, seen),
    });

    // The stub's no-op guardian reviews block shipping (issue #43); the
    // slice ran to completion, which is what the ceilings below describe.
    expect(result.success).toBe(false);
    // Slow roles: measured generator durations on a consuming project
    // ranged ~41–60+ min, so the 60 min provider default sat directly
    // on the real distribution. These two get double the budget.
    expect(seen.get("generator")).toEqual([7_200_000]);
    expect(seen.get("evaluator-qa")).toEqual([7_200_000]);
    // Fast roles pass no override → the provider's 60 min default applies.
    for (const role of ["explorer", "planner", "evaluator-contract"]) {
      expect(seen.get(role), role).toBeDefined();
      for (const value of seen.get(role)!) expect(value, role).toBeUndefined();
    }
  }, 240_000);

  it("applies --max-agent-duration-ms uniformly to every invocation", async () => {
    const slug = "ceiling-override";
    const { repo, prdDir, specsDir, slices, baseProvider } =
      makeSingleSliceSetup(slug, "9302");
    const seen = new Map<string, Array<number | undefined>>();

    const result = await runPipeline({
      repoRoot: repo,
      prdSlug: slug,
      prdDir,
      specsDir,
      dag: buildDAG(slices),
      provider: recordingProvider(baseProvider, seen),
      maxAgentDurationMs: 5_400_000,
    });

    // As above: the stub's no-op reviews block shipping (issue #43).
    expect(result.success).toBe(false);
    // Every role that ran — slice roles and guardian reviews alike —
    // received the uniform override.
    expect(seen.size).toBeGreaterThanOrEqual(5);
    for (const [role, values] of seen) {
      for (const value of values) expect(value, role).toBe(5_400_000);
    }
    expect(seen.has("generator")).toBe(true);
    expect(seen.has("architect-review")).toBe(true);
  }, 240_000);

  it("treats a generator ceiling kill as terminal — no retry — and records the remedy in the persisted error", async () => {
    const slug = "ceiling-terminal";
    const { repo, prdDir, specsDir, slices, baseProvider } =
      makeSingleSliceSetup(slug, "9303");

    let generatorAttempts = 0;
    const provider: AgentProvider = {
      name: baseProvider.name,
      async invoke(options) {
        if (options.role === "generator") {
          generatorAttempts++;
          throw new Error(
            "Agent generator exceeded 7200s wall-clock ceiling — killed",
          );
        }
        return baseProvider.invoke(options);
      },
    };

    const result = await runPipeline({
      repoRoot: repo,
      prdSlug: slug,
      prdDir,
      specsDir,
      dag: buildDAG(slices),
      provider,
      infrastructureRetries: 2,
    });

    expect(result.success).toBe(false);
    // Terminal by design: a retry would restart the round from scratch
    // against the same ceiling. The infrastructure-retries budget must
    // not apply to the generator's ceiling kill.
    expect(generatorAttempts).toBe(1);
    // Persisted state keeps the ERROR distinction and carries the
    // operator-facing remedy; the summary collapses ERROR to STUCK.
    const state = JSON.parse(
      readFileSync(join(repo, ".afk", "state", `${slug}-stub.json`), "utf-8"),
    );
    expect(state.slices["9303"].phase).toBe("ERROR");
    expect(state.slices["9303"].error).toContain("wall-clock ceiling");
    expect(state.slices["9303"].error).toContain("--max-agent-duration-ms");
    expect(result.consoleSummary).toContain("[STUCK]");
  }, 240_000);
});

/**
 * Generator verification command (ADR 0038). An operator narrows what the
 * generator runs between edits; nothing else may narrow with it. The risk
 * this pins is a run-time one — `config.testCommand` leaking into the
 * block QA is handed or into what the gate executes — so it is asserted
 * through `runPipeline` against a real repo, reading the prompts the
 * provider actually received.
 */
describe("generator verification command (ADR 0038)", () => {
  /** Repo whose own test script differs from the override below. */
  function makeSetup(slug: string, ghIssue: string) {
    const repo = makeRepo();
    const { prdDir, specsDir } = writePrdFixture(repo, slug);
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify(
        {
          name: "consumer-fixture",
          private: true,
          scripts: { "test:run": `node -e "0"` },
        },
        null,
        2,
      ),
      "utf-8",
    );
    git(repo, ["add", "package.json"]);
    git(repo, ["commit", "-m", "add test script"]);

    const slices: Slice[] = [
      {
        number: "01",
        ghIssue,
        title: "Verification slice",
        type: "AFK",
        blockedBy: [],
        userStories: "",
      },
    ];
    const fixtures = new Map<string, SliceFixture>([
      [
        ghIssue,
        {
          files: ["src/verify.txt"],
          qaPasses: true,
          outputFile: "src/verify.txt",
          outputContent: "verify",
        },
      ],
    ]);
    const records: InvocationRecord[] = [];
    return {
      repo,
      prdDir,
      specsDir,
      slices,
      baseProvider: buildStubProvider({ fixtures, slices, records }),
    };
  }

  /** Wrap the stub to keep the prompt text each role received. */
  function promptCapturingProvider(
    baseProvider: AgentProvider,
    prompts: Map<string, string[]>,
  ): AgentProvider {
    return {
      name: baseProvider.name,
      async invoke(options) {
        const list = prompts.get(options.role) ?? [];
        list.push(options.prompt);
        prompts.set(options.role, list);
        return baseProvider.invoke(options);
      },
    };
  }

  it("hands the override to the generator and the full sanity set to QA", async () => {
    const slug = "generator-test-command";
    const { repo, prdDir, specsDir, slices, baseProvider } = makeSetup(
      slug,
      "9501",
    );
    const prompts = new Map<string, string[]>();

    // The stub's no-op guardian reviews block shipping (issue #43); the
    // slice ran to completion, which is what the prompts below describe.
    const result = await runPipeline({
      repoRoot: repo,
      prdSlug: slug,
      prdDir,
      specsDir,
      dag: buildDAG(slices),
      provider: promptCapturingProvider(baseProvider, prompts),
      testCommand: "pnpm test:fast",
    });
    expect(result.success).toBe(false);

    const generatorPrompt = prompts.get("generator")?.[0];
    expect(generatorPrompt).toBeDefined();
    expect(generatorPrompt!).toContain("pnpm test:fast");

    // QA is told the gate's command set and is never shown the override.
    const qaPrompt = prompts.get("evaluator-qa")?.[0];
    expect(qaPrompt).toBeDefined();
    expect(qaPrompt!).toContain("pnpm run test:run");
    expect(qaPrompt!).not.toContain("test:fast");
  }, 240_000);

  it("leaves the generator on the project's test script when no override is given", async () => {
    const slug = "generator-test-command-default";
    const { repo, prdDir, specsDir, slices, baseProvider } = makeSetup(
      slug,
      "9502",
    );
    const prompts = new Map<string, string[]>();

    const result = await runPipeline({
      repoRoot: repo,
      prdSlug: slug,
      prdDir,
      specsDir,
      dag: buildDAG(slices),
      provider: promptCapturingProvider(baseProvider, prompts),
    });
    expect(result.success).toBe(false);

    const generatorPrompt = prompts.get("generator")?.[0];
    expect(generatorPrompt).toBeDefined();
    expect(generatorPrompt!).toContain("pnpm test:run");
  }, 240_000);
});


/**
 * Structured events tee (spec #26, slice #27): a pipeline run leaves
 * `events.jsonl` beside `run.log` in the per-run directory — header
 * first, then `run-started`, then one `slice-outcome` per terminal
 * outcome carrying the serialized SliceLifecycle (including the
 * failure reason). Asserted at the same integration seam as the
 * run.log tests: real temp repo, stub provider, files on disk.
 */
describe("events.jsonl tee (spec #26)", () => {
  function runDirsOf(repo: string, slug: string): string[] {
    const parent = join(repo, ".afk", "logs", `${slug}-stub`);
    return readdirSync(parent)
      .filter((d) => /^run-\d{8}-\d{6}/.test(d))
      .map((d) => join(parent, d));
  }

  /** The run's event stream, one parsed object per line. */
  function eventsOf(runDir: string): any[] {
    return readFileSync(join(runDir, "events.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
  }

  /**
   * Every event type the tee emits, from one wave. The stream is a
   * projection of a run, so one run with the right shape carries all of
   * it: a lane whose lead fails and whose mate continues (ADR 0024), a
   * DAG-held slice that never runs, and a slice carrying all three
   * retry/deferral injections at once. Only the prior-run-state warn
   * needs a second run, because it reports what the first one left.
   *
   * A new event type belongs here, on this fixture, before it earns a
   * spawn of its own (AGENTS.md).
   */
  describe("one wave's event stream", () => {
    const slug = "events";
    const LEAD = "9601";
    const MATE = "9602";
    const HELD = "9603";
    const RETRIED = "9701";
    let repo: string;
    let lines: any[];
    let warns: any[];
    let priorWarns: any[];
    let firstSummary: string;

    beforeAll(async () => {
      repo = makeRepo({ lifetime: "describe" });
      const { prdDir, specsDir } = writePrdFixture(repo, slug);
      const slices: Slice[] = [
        { number: "01", ghIssue: LEAD, title: "LaneLead", type: "AFK", blockedBy: [], userStories: "" },
        { number: "02", ghIssue: MATE, title: "LaneMate", type: "AFK", blockedBy: [], userStories: "" },
        { number: "03", ghIssue: HELD, title: "Dependent", type: "AFK", blockedBy: [LEAD], userStories: "" },
        { number: "04", ghIssue: RETRIED, title: "Retried", type: "AFK", blockedBy: [], userStories: "" },
      ];
      // The lead fails QA every round and lands STUCK, so the tee carries
      // a real failure reason; the mate shares its file (same lane) and
      // passes; the dependent is DAG-blocked by the lead and never runs.
      // The fourth slice is deliberately loaded with every recoverable
      // interruption at once — an infrastructure QA verdict, an idle
      // deferral, and a transient outage — and still passes.
      const fixtures = new Map<string, SliceFixture>([
        [LEAD, { files: ["src/shared.txt"], qaPasses: false, outputFile: "src/shared.txt", outputContent: "lead" }],
        [MATE, { files: ["src/shared.txt"], qaPasses: true, outputFile: "src/shared.txt", outputContent: "mate" }],
        [HELD, { files: ["src/dep.txt"], qaPasses: true, outputFile: "src/dep.txt", outputContent: "dep" }],
        [RETRIED, {
          files: ["src/retried.txt"],
          qaPasses: true,
          qaInfraAttempts: 1,
          simulateIdleDeferral: true,
          outputFile: "src/retried.txt",
          outputContent: "retried",
        }],
      ]);
      const stub = buildStubProvider({ fixtures, slices, records: [] });
      // The retried slice's first generator invocation dies with a
      // provider-classified transient outage; the orchestrator retries
      // with backoff.
      let outageThrown = false;
      const provider: AgentProvider = {
        name: stub.name,
        async invoke(options) {
          if (
            options.role === "generator" &&
            !outageThrown &&
            /-s04$/.test(options.cwd.replace(/\\/g, "/"))
          ) {
            outageThrown = true;
            throw new TransientProviderError("model temporarily unavailable");
          }
          return stub.invoke(options);
        },
      };
      const config = {
        repoRoot: repo,
        prdSlug: slug,
        prdDir,
        specsDir,
        provider,
        // Test seam: skip the real 30s backoff sleep.
        transientRetrySleep: async () => {},
      };

      const firstResult = await runPipeline({
        ...config,
        dag: buildDAG(slices),
      });
      firstSummary = firstResult.summary;
      const [firstDir] = runDirsOf(repo, slug);
      lines = eventsOf(firstDir!);
      warns = lines.filter((l) => l.type === "warn");

      // A second run, for the one event that reports the previous run.
      await runPipeline({ ...config, dag: buildDAG(slices) });
      const secondDir = runDirsOf(repo, slug).find((d) => d !== firstDir)!;
      priorWarns = eventsOf(secondDir).filter(
        (l) => l.type === "warn" && l.reason === "prior-run-state",
      );
    }, 240_000);

    afterAll(() => {
      try {
        rmSync(repo, { recursive: true, force: true });
      } catch {
        // best effort
      }
    });

    it("opens with the header and run-started, beside run.log", () => {
      // events.jsonl sits beside run.log in the run directory.
      expect(existsSync(join(runDirsOf(repo, slug)[0]!, "run.log"))).toBe(true);
      // Header first (version gate), then run-started.
      expect(lines[0]).toMatchObject({ type: "header", version: 1 });
      expect(lines[1]).toMatchObject({ type: "run-started", provider: "stub" });
    });

    it("timestamps every event", () => {
      for (const line of lines) {
        expect(line.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      }
    });

    it("writes one slice-outcome per terminal outcome, and none for a held slice", () => {
      const outcomes = lines.filter((l) => l.type === "slice-outcome");
      expect(outcomes.map((o) => o.slice.ghIssue).sort()).toEqual([
        LEAD, MATE, RETRIED,
      ]);
      expect(outcomes.find((o) => o.slice.ghIssue === MATE)!.slice).toMatchObject({
        phase: "PASS",
        title: "LaneMate",
        mergedToFeature: true,
      });
      const stuck = outcomes.find((o) => o.slice.ghIssue === LEAD)!;
      expect(stuck.slice.phase).toBe("STUCK");
      expect(stuck.slice.error).toBeTruthy();
    });

    it("emits wave-dispatched and lanes-partitioned per wave (#30)", () => {
      const waves = lines.filter((l) => l.type === "wave-dispatched");
      expect(waves).toHaveLength(1);
      expect(waves[0]!.wave).toBe(1);
      // The DAG-held slice is not in the dispatched wave.
      expect(waves[0]!.slices.sort()).toEqual([LEAD, MATE, RETRIED]);

      const lanes = lines.filter((l) => l.type === "lanes-partitioned");
      expect(lanes).toHaveLength(1);
      expect(lanes[0]!.wave).toBe(1);
      // The shared file put the lead and its mate in one lane; the
      // retried slice declares its own file, so it gets its own.
      expect(lanes[0]!.lanes).toEqual(
        expect.arrayContaining([[LEAD, MATE], [RETRIED]]),
      );
    });

    it("pairs phase-started with phase-ended per invocation, with round and verdict", () => {
      const pairFor = (agent: string, round?: number) => {
        const started = lines.findIndex(
          (l) =>
            l.type === "phase-started" &&
            l.ghIssue === MATE &&
            l.agent === agent &&
            l.round === round,
        );
        const ended = lines.findIndex(
          (l) =>
            l.type === "phase-ended" &&
            l.ghIssue === MATE &&
            l.agent === agent &&
            l.round === round,
        );
        expect(started, `${agent} phase-started`).toBeGreaterThan(-1);
        expect(ended, `${agent} phase-ended`).toBeGreaterThan(started);
        return lines[ended]!;
      };

      pairFor("explorer", undefined);
      pairFor("planner", 1);
      // The contract evaluator's phase-ended carries the verdict.
      expect(pairFor("evaluator-contract", 1).verdict).toBe("ACCEPT");
      pairFor("generator", 1);
      // The QA evaluator's phase-ended carries the outcome verdict.
      expect(pairFor("evaluator-qa", 1).verdict).toBe("PASS");
    });

    it("warns on a lane continuation and on a NOT-RUN hold (#29)", () => {
      // Lane continuation is a typed warn with its reason (ADR 0024).
      const laneWarn = warns.find((w) => w.reason === "lane-continuation");
      expect(laneWarn).toBeDefined();
      expect(laneWarn!.ghIssue).toBe(LEAD);
      expect(laneWarn!.message).toContain(MATE);

      // The DAG-held slice surfaces as a NOT-RUN hold naming its blocker.
      const holdWarn = warns.find((w) => w.reason === "not-run-hold");
      expect(holdWarn).toBeDefined();
      expect(holdWarn!.ghIssue).toBe(HELD);
      expect(holdWarn!.blockedBy).toContain(LEAD);
    });

    it("does not add dependency-hold summary rows for ordinary failures", () => {
      expect(firstSummary).not.toContain("## Dependency Holds");
      expect(firstSummary).not.toContain(`#${HELD} Dependent`);
    });

    it("warns on an infrastructure QA retry that consumed no round (#29)", () => {
      const infraWarn = warns.find((w) => w.reason === "infrastructure-retry");
      expect(infraWarn).toBeDefined();
      expect(infraWarn!.ghIssue).toBe(RETRIED);
    });

    it("warns when the busy probe defers an idle kill (#29 / ADR 0021)", () => {
      const deferral = warns.find((w) => w.reason === "idle-deferral");
      expect(deferral).toBeDefined();
      expect(deferral!.ghIssue).toBe(RETRIED);
      expect(deferral!.message).toContain("deferring idle kill");
      expect(deferral!.message).toContain("2 spawned process(es)");
    });

    it("warns when a transient model outage is retried with backoff (#29 / ADR 0022)", () => {
      const backoff = warns.find((w) => w.reason === "backoff-retry");
      expect(backoff).toBeDefined();
      expect(backoff!.ghIssue).toBe(RETRIED);
      expect(backoff!.message).toContain("transient model outage");
      expect(backoff!.message).toContain("retry 1");
    });

    it("leaves the thrice-interrupted slice passing anyway", () => {
      // Every one of those three is recoverable, so none of them may
      // change the outcome.
      const outcome = lines.find(
        (l) => l.type === "slice-outcome" && l.slice.ghIssue === RETRIED,
      );
      expect(outcome!.slice.phase).toBe("PASS");
    });

    it("reports each slice's prior-run state on the next run (#29)", () => {
      const stuckPrior = priorWarns.find((w) => w.ghIssue === LEAD);
      expect(stuckPrior).toBeDefined();
      expect(stuckPrior!.previousPhase).toBe("STUCK");
      expect(stuckPrior!.previousError).toContain("QA failed");
      const passPrior = priorWarns.find((w) => w.ghIssue === MATE);
      expect(passPrior).toBeDefined();
      expect(passPrior!.previousPhase).toBe("PASS");
    });
  });
});


/**
 * Issue #17 — re-runs must never silently omit slices. Two gaps are
 * pinned here: (1) a slice with a persisted failure phase is announced
 * as a retry (with the prior phase + reason) before any wave runs, and
 * (2) a slice held back because its dependency never completed gets an
 * explicit NOT-RUN line naming the blocker. Before this, both cases
 * were only inferable by diffing the wave composition against the
 * manifest — the "silent retry cap" mirage from the PRD 075 run.
 */
describe("re-run visibility for previously failed and held-back slices (issue #17)", () => {
  function runLogOf(repo: string, slug: string): string {
    const parent = join(repo, ".afk", "logs", `${slug}-stub`);
    const dirs = readdirSync(parent).filter((d) =>
      /^run-\d{8}-\d{6}/.test(d),
    );
    // Latest run dir — tests below only ever need the most recent one.
    const latest = dirs.sort().at(-1)!;
    return readFileSync(join(parent, latest, "run.log"), "utf-8");
  }

  it("announces a retried slice with its prior phase and failure reason", async () => {
    const repo = makeRepo();
    const slug = "retry-announce";
    const { prdDir, specsDir } = writePrdFixture(repo, slug);

    const slices: Slice[] = [
      {
        number: "01",
        ghIssue: "9401",
        title: "Retried",
        type: "AFK",
        blockedBy: [],
        userStories: "",
      },
    ];
    const fixtures = new Map<string, SliceFixture>([
      [
        "9401",
        {
          files: ["src/retry.txt"],
          qaPasses: true,
          outputFile: "src/retry.txt",
          outputContent: "retry",
        },
      ],
    ]);

    // Seed persisted state from a "previous run" that ERRORed. The
    // state file is keyed by the pipeline run slug (provider-suffixed).
    const stateDir = join(repo, ".afk", "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, `${slug}-stub.json`),
      JSON.stringify({
        version: 1,
        prdSlug: `${slug}-stub`,
        featureBranch: `feat-stub/${slug}`,
        slices: {
          "9401": {
            phase: "ERROR",
            branch: "afk-stub/retry-announce-slice-01-retried",
            error: "Agent generator idle for 600s — killed",
          },
        },
      }),
      "utf-8",
    );

    await runPipeline({
      repoRoot: repo,
      prdSlug: slug,
      prdDir,
      specsDir,
      dag: buildDAG(slices),
      provider: buildStubProvider({ fixtures, slices, records: [] }),
    });

    const runLog = runLogOf(repo, slug);
    expect(runLog).toContain(
      "Retrying #9401 Retried (previous run: ERROR — Agent generator idle for 600s — killed)",
    );
    // And the retry actually ran to completion.
    expect(runLog).toContain("Slice #9401 (Retried): PASS");
  }, 240_000);

  /**
   * Issue #40: the cause a negotiate failure was classified with has to
   * survive the whole way out — into the run state, and back out of it
   * into the next run's retry announcement. Before this, a dead contract
   * evaluator persisted the fixed text "Negotiation returned ERROR", so
   * the next run announced a retry that explained nothing.
   *
   * Two real pipeline runs against one repo: the first kills the contract
   * evaluator, the second is healthy.
   */
  it("persists a negotiate failure cause and quotes it in the next run's retry announcement", async () => {
    const repo = makeRepo();
    const slug = "negotiate-cause";
    const { prdDir, specsDir } = writePrdFixture(repo, slug);

    const slices: Slice[] = [
      {
        number: "01",
        ghIssue: "9501",
        title: "Negotiator",
        type: "AFK",
        blockedBy: [],
        userStories: "",
      },
    ];
    const fixtures = new Map<string, SliceFixture>([
      [
        "9501",
        {
          files: ["src/neg.txt"],
          qaPasses: true,
          outputFile: "src/neg.txt",
          outputContent: "neg",
        },
      ],
    ]);
    const healthy = buildStubProvider({ fixtures, slices, records: [] });
    const doomed: AgentProvider = {
      name: healthy.name,
      async invoke(options) {
        if (options.role === "evaluator-contract") {
          options.logStream?.write("evaluator-contract: reading contract.md\n");
          throw new Error("Agent evaluator-contract exited with code 1");
        }
        return healthy.invoke(options);
      },
    };

    const first = await runPipeline({
      repoRoot: repo,
      prdSlug: slug,
      prdDir,
      specsDir,
      dag: buildDAG(slices),
      provider: doomed,
      infrastructureRetries: 0,
    });
    expect(first.success).toBe(false);

    const statePath = join(repo, ".afk", "state", `${slug}-stub.json`);
    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(state.slices["9501"].phase).toBe("ERROR");
    const persisted: string = state.slices["9501"].error;
    expect(persisted).toContain("exit code 1");
    expect(persisted).toContain("evaluator-contract");
    expect(persisted).toContain("last output:");
    expect(persisted).not.toContain("Negotiation returned ERROR");
    // The reason has to stay one line: the retry announcement below
    // embeds it, and run.log is line-oriented.
    expect(persisted).not.toContain("\n");

    const second = await runPipeline({
      repoRoot: repo,
      prdSlug: slug,
      prdDir,
      specsDir,
      dag: buildDAG(slices),
      provider: healthy,
    });
    // The slice recovered, but the stub guardians left no shippable verdict.
    expect(second.success).toBe(false);

    // Second run's run.log — runLogOf reads the newest run directory.
    const runLog = runLogOf(repo, slug);
    expect(runLog).toContain(
      `Retrying #9501 Negotiator (previous run: ERROR — ${persisted})`,
    );
  }, 240_000);

  it("emits an explicit NOT-RUN line naming the unresolved blocker for held-back slices", async () => {
    const repo = makeRepo();
    const slug = "heldback";
    const { prdDir, specsDir } = writePrdFixture(repo, slug);

    const slices: Slice[] = [
      {
        number: "01",
        ghIssue: "9501",
        title: "Blocker",
        type: "AFK",
        blockedBy: [],
        userStories: "",
      },
      {
        number: "02",
        ghIssue: "9502",
        title: "Dependent",
        type: "AFK",
        blockedBy: ["9501"],
        userStories: "",
      },
    ];
    const fixtures = new Map<string, SliceFixture>([
      [
        "9501",
        {
          files: ["src/blocker.txt"],
          qaPasses: true,
          outputFile: "src/blocker.txt",
          outputContent: "blocker",
        },
      ],
      [
        "9502",
        {
          files: ["src/dependent.txt"],
          qaPasses: true,
          outputFile: "src/dependent.txt",
          outputContent: "dependent",
        },
      ],
    ]);
    const records: InvocationRecord[] = [];
    const stub = buildStubProvider({ fixtures, slices, records });
    // The blocker's explorer invocation dies → negotiate rejects →
    // slice 9501 ERRORs fast, and 9502 must be reported as held back.
    const provider: AgentProvider = {
      name: stub.name,
      async invoke(options) {
        if (options.role === "explorer" && /-s01(?:$|[\\/])/.test(options.cwd)) {
          throw new Error("boom: explorer died");
        }
        return stub.invoke(options);
      },
    };

    await runPipeline({
      repoRoot: repo,
      prdSlug: slug,
      prdDir,
      specsDir,
      dag: buildDAG(slices),
      provider,
    });

    const runLog = runLogOf(repo, slug);
    expect(runLog).toContain("Slice #9501 (Blocker): ERROR");
    expect(runLog).toContain(
      "Slice #9502 (Dependent): NOT-RUN — held back by unresolved dependency [#9501]; fix the blocker(s) and re-run",
    );
  }, 240_000);
});

/**
 * Re-running only the failed slices (#41).
 *
 * Two mechanisms have to hold together for the operator journey to work.
 * Dependency satisfaction must read the run state, so a prerequisite
 * recorded PASS and merged unblocks its dependents even when this
 * invocation did not select it — otherwise a narrow re-run dispatches
 * nothing and still exits "completed". And the run scope must accept a
 * strict subset of the persisted scope, so "re-run only what failed" is
 * expressible at all. `--only-failed` is sugar over the same subset rule
 * and must produce an identical run.
 */
describe("narrowed re-run of the failed slices (#41)", () => {
  const NARROW_SLICES: Slice[] = [
    { number: "01", ghIssue: "4101", title: "Foundation", type: "AFK", blockedBy: [], userStories: "" },
    { number: "02", ghIssue: "4102", title: "Dependent", type: "AFK", blockedBy: ["4101"], userStories: "" },
  ];

  function fixturesWith(dependentPasses: boolean): Map<string, SliceFixture> {
    return new Map<string, SliceFixture>([
      ["4101", { files: ["src/foundation.txt"], qaPasses: true, outputFile: "src/foundation.txt", outputContent: "foundation" }],
      ["4102", { files: ["src/dependent.txt"], qaPasses: dependentPasses, outputFile: "src/dependent.txt", outputContent: "dependent" }],
    ]);
  }

  function latestRunDir(repo: string, slug: string): string {
    const parent = join(repo, ".afk", "logs", `${slug}-stub`);
    const dirs = readdirSync(parent)
      .filter((d) => /^run-\d{8}-\d{6}/.test(d))
      .sort();
    return join(parent, dirs[dirs.length - 1]!);
  }

  /** First run: the foundation passes and merges, the dependent lands STUCK. */
  async function runUntilDependentFails(slug: string) {
    const repo = makeRepo();
    const { prdDir, specsDir } = writePrdFixture(repo, slug);
    const result = await runPipeline({
      repoRoot: repo,
      prdSlug: slug,
      prdDir,
      specsDir,
      dag: buildDAG(NARROW_SLICES),
      provider: buildStubProvider({
        fixtures: fixturesWith(false),
        slices: NARROW_SLICES,
        records: [],
      }),
    });
    expect(result.success).toBe(false);
    const statePath = join(repo, ".afk", "state", `${slug}-stub.json`);
    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(state.slices["4101"]).toMatchObject({ phase: "PASS", mergedToFeature: true });
    expect(state.slices["4102"].phase).toBe("STUCK");
    return { repo, prdDir, specsDir, statePath, slug };
  }

  type FailedRun = Awaited<ReturnType<typeof runUntilDependentFails>>;

  /** Re-run the same PRD with a narrowing config, and observe the result. */
  async function narrowRerun(
    env: FailedRun,
    narrowing: { selectedSliceNumbers?: string[] },
  ) {
    const records: InvocationRecord[] = [];
    const result = await runPipeline({
      repoRoot: env.repo,
      prdSlug: env.slug,
      prdDir: env.prdDir,
      specsDir: env.specsDir,
      dag: buildDAG(NARROW_SLICES),
      provider: buildStubProvider({
        fixtures: fixturesWith(true),
        slices: NARROW_SLICES,
        records,
      }),
      ...narrowing,
    });
    const state = JSON.parse(readFileSync(env.statePath, "utf-8"));
    const handoff = JSON.parse(
      readFileSync(
        join(env.repo, ".afk", "logs", `${env.slug}-stub`, "handoff.json"),
        "utf-8",
      ),
    );
    const events = readFileSync(
      join(latestRunDir(env.repo, env.slug), "events.jsonl"),
      "utf-8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    return {
      success: result.success,
      // Slice-scoped invocations only: the post-merge review agents run
      // for the whole branch and carry no slice id.
      dispatched: [
        ...new Set(records.map((r) => r.ghIssue).filter((id) => id !== "")),
      ].sort(),
      scope: state.scope,
      phases: {
        "4101": state.slices["4101"].phase,
        "4102": state.slices["4102"].phase,
      },
      selectedSlices: handoff.selectedSlices,
      skippedSlices: handoff.skippedSlices,
      events,
    };
  }

  it("dispatches the selected slice whose prerequisite is a merged PASS outside the selection", async () => {
    const env = await runUntilDependentFails("narrow-subset");

    const observed = await narrowRerun(env, { selectedSliceNumbers: ["02"] });

    // The whole point: the run actually ran the slice it was narrowed to.
    expect(observed.dispatched).toEqual(["4102"]);
    // Slice work passed; the stub guardian verdicts still block shipping.
    expect(observed.success).toBe(false);
    expect(observed.phases).toEqual({ "4101": "PASS", "4102": "PASS" });

    // The scope of record is untouched by the narrowing, so a later full
    // re-run still knows the original scope.
    expect(observed.scope).toEqual({
      mode: "all-afk",
      slices: [
        { number: "01", ghIssue: "4101" },
        { number: "02", ghIssue: "4102" },
      ],
    });

    // The excluded member is reported skipped under its own reason —
    // it did not read as a slice the pipeline dropped.
    expect(observed.skippedSlices).toMatchObject([
      { number: "01", ghIssue: "4101", reason: "narrowed" },
    ]);
    expect(observed.selectedSlices).toMatchObject([
      { number: "02", ghIssue: "4102", status: "PASS" },
    ]);

    // The dependency satisfied from prior run state is announced.
    const warn = observed.events.find(
      (e) => e.type === "warn" && e.reason === "dependency-from-prior-run",
    );
    expect(warn).toBeDefined();
    expect(warn!.ghIssue).toBe("4101");
    expect(warn!.previousPhase).toBe("PASS");
  }, 240_000);

  it("rejects a re-run that adds work outside the persisted scope", async () => {
    const env = await runUntilDependentFails("narrow-superset");
    // Lock an explicit single-slice scope first, then try to gain work.
    const extended: Slice[] = [
      ...NARROW_SLICES,
      { number: "03", ghIssue: "4103", title: "New work", type: "AFK", blockedBy: [], userStories: "" },
    ];

    await expect(
      runPipeline({
        repoRoot: env.repo,
        prdSlug: env.slug,
        prdDir: env.prdDir,
        specsDir: env.specsDir,
        dag: buildDAG(extended),
        selectedSliceNumbers: ["02", "03"],
        provider: buildStubProvider({
          fixtures: fixturesWith(true),
          slices: extended,
          records: [],
        }),
      }),
    ).rejects.toThrow(/do not match the persisted run scope/);
  }, 240_000);

});

/**
 * Merge-only recovery for MERGE-PENDING slices (ADR 0029). Driven through
 * a two-run `runPipeline` shape — run, mutate state, run again — because
 * that is exactly what recovery is: a
 * later invocation acting on what an earlier one persisted.
 *
 * Run 1 always ends the same way: a migration whose numeric prefix is
 * already taken on the feature branch, so the merge mutex refuses and the
 * slice is recorded MERGE-PENDING with its work intact.
 */
describe("runPipeline merge-only recovery for MERGE-PENDING", () => {
  const BLOCKED = "8001";
  const DEPENDENT = "8002";

  function slicesWithDependent(): Slice[] {
    return [
      { number: "01", ghIssue: BLOCKED, title: "Adds orders", type: "AFK", blockedBy: [], userStories: "" },
      { number: "02", ghIssue: DEPENDENT, title: "Uses orders", type: "AFK", blockedBy: [BLOCKED], userStories: "" },
    ];
  }

  function fixturesWithDependent(): Map<string, SliceFixture> {
    return new Map<string, SliceFixture>([
      [BLOCKED, {
        files: ["supabase/migrations/043_orders.sql"],
        qaPasses: true,
        outputFile: "supabase/migrations/042_orders.sql",
        outputContent: "-- orders",
      }],
      [DEPENDENT, {
        files: ["src/uses-orders.txt"],
        qaPasses: true,
        outputFile: "src/uses-orders.txt",
        outputContent: "uses orders",
      }],
    ]);
  }

  /** Occupy prefix 042 on `main`, so the feature branch inherits it. */
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

  interface StateSlice {
    phase: string;
    branch?: string;
    mergedToFeature?: boolean;
    error?: string;
    collidingPrefixes?: string[];
  }

  function stateOf(repo: string, slug: string): Record<string, StateSlice> {
    const raw = JSON.parse(
      readFileSync(join(repo, ".afk", "state", `${slug}-stub.json`), "utf-8"),
    ) as { slices: Record<string, StateSlice> };
    return raw.slices;
  }

  function latestRunLog(repo: string, slug: string): string {
    const parent = join(repo, ".afk", "logs", `${slug}-stub`);
    const latest = readdirSync(parent)
      .filter((d) => /^run-\d{8}-\d{6}/.test(d))
      .sort()
      .at(-1)!;
    return readFileSync(join(parent, latest, "run.log"), "utf-8");
  }

  async function createDeferredRun(
    slug: string,
    repoOpts: { lifetime?: "test" | "describe" } = {},
  ) {
    const repo = makeRepo(repoOpts);
    seedMigrationOnMain(repo, "042_users.sql");
    const { prdDir, specsDir } = writePrdFixture(repo, slug);
    const slices = slicesWithDependent();
    const config = { repoRoot: repo, prdSlug: slug, prdDir, specsDir };
    await runPipeline({
      ...config,
      dag: buildDAG(slices),
      provider: buildStubProvider({
        fixtures: fixturesWithDependent(),
        slices,
        records: [],
      }),
    });
    expect(stateOf(repo, slug)[BLOCKED]!.phase).toBe("MERGE-PENDING");
    return { repo, slug, slices, config, featBranch: `feat-stub/${slug}` };
  }

  /**
   * One deferred slice, four successive runs, one fixture. The collision
   * is refused (run 1), survives a narrowed re-entry (run 2) and an
   * ordinary one (run 3), and finally merges once the operator frees the
   * prefix (run 4). Each of these cases used to re-pay for its own run 1,
   * which is the expensive part; and since what is under test is a state
   * machine, re-entering one fixture repeatedly is also closer to what an
   * operator actually does than four independent first runs.
   */
  describe("a deferred slice across successive runs", () => {
    const slug = "merge-pending-reentry";
    let repo: string;
    let featBranch: string;
    let worktree: string;
    /** Snapshots taken between runs, before the next one overwrote state. */
    let afterRefusedMerge: StateSlice;
    let dependentAfterRefusedMerge: StateSlice | undefined;
    let branchName: string;
    let worktreeAfterRefusedMerge = false;
    let narrowedRecheck: { state: Record<string, StateSlice>; records: InvocationRecord[] };
    let ordinaryRecheck: { state: Record<string, StateSlice>; records: InvocationRecord[] };
    let recovered: { state: Record<string, StateSlice>; records: InvocationRecord[] };
    let worktreeAfterRecovery = true;
    let featureTreeAfterRecovery = "";

    /** Re-enter the same fixture; returns what that run did. */
    async function reenter(
      env: Awaited<ReturnType<typeof createDeferredRun>>,
      selectedSliceNumbers?: string[],
    ) {
      const records: InvocationRecord[] = [];
      await runPipeline({
        ...env.config,
        dag: buildDAG(env.slices),
        ...(selectedSliceNumbers ? { selectedSliceNumbers } : {}),
        provider: buildStubProvider({
          fixtures: fixturesWithDependent(),
          slices: env.slices,
          records,
        }),
      });
      return { state: stateOf(env.repo, env.slug), records };
    }

    beforeAll(async () => {
      // --- Run 1: the merge is refused; nothing is discarded. ---
      const env = await createDeferredRun(slug, { lifetime: "describe" });
      repo = env.repo;
      featBranch = env.featBranch;
      worktree = join(repo, ".afk", "worktrees", `afk-stub-${slug}-s01`);
      afterRefusedMerge = stateOf(repo, slug)[BLOCKED]!;
      branchName = afterRefusedMerge.branch!;
      worktreeAfterRefusedMerge = existsSync(worktree);
      dependentAfterRefusedMerge = stateOf(repo, slug)[DEPENDENT];

      // --- Runs 2 and 3: nothing changed, so the collision is still
      // there — first for a re-run narrowed to the dependent, then for an
      // ordinary one.
      narrowedRecheck = await reenter(env, ["02"]);
      ordinaryRecheck = await reenter(env);

      // --- Mutate: free prefix 042 on the feature branch. ---
      git(repo, ["checkout", featBranch]);
      git(repo, [
        "mv",
        "supabase/migrations/042_users.sql",
        "supabase/migrations/041_users.sql",
      ]);
      git(repo, ["commit", "-m", "renumber users migration to 041"]);
      git(repo, ["checkout", "main"]);

      // --- Run 4: recovery merges before any agent is dispatched, and
      // the excluded member is recovered even though the invocation was
      // narrowed to its dependent.
      recovered = await reenter(env, ["02"]);
      worktreeAfterRecovery = existsSync(worktree);
      featureTreeAfterRecovery = git(repo, [
        "ls-tree",
        "-r",
        "--name-only",
        featBranch,
      ]);
    }, 240_000);

    afterAll(() => {
      try {
        rmSync(repo, { recursive: true, force: true });
      } catch {
        // best effort
      }
    });

    it("refuses the merge without discarding the slice's work", () => {
      expect(afterRefusedMerge.phase).toBe("MERGE-PENDING");
      expect(afterRefusedMerge.collidingPrefixes).toEqual(["042"]);
      expect(afterRefusedMerge.error).toContain("retries the merge");
      expect(git(repo, ["rev-parse", "--verify", branchName])).toMatch(/\w/);
      expect(worktreeAfterRefusedMerge).toBe(true);
    });

    it("holds the dependent back — MERGE-PENDING unblocks nothing", () => {
      expect(dependentAfterRefusedMerge).toBeUndefined();
    });

    it("rechecks the excluded member on a narrowed re-run without dispatching it", () => {
      expect(narrowedRecheck.state[BLOCKED]!.phase).toBe("MERGE-PENDING");
      expect(narrowedRecheck.records.some((r) => r.ghIssue === BLOCKED)).toBe(false);
      // Its dependent is still blocked, so the narrowed run has no work.
      expect(narrowedRecheck.records.some((r) => r.ghIssue === DEPENDENT)).toBe(false);
    });

    it("keeps a still-colliding slice MERGE-PENDING with a refreshed reason", () => {
      const after = ordinaryRecheck.state[BLOCKED]!;
      expect(after.phase).toBe("MERGE-PENDING");
      expect(after.collidingPrefixes).toEqual(["042"]);
      expect(after.error).toContain("042");
      // A repeated retry must not escalate into a regeneration nobody
      // asked for: no agent ran against the slice in that run at all.
      expect(ordinaryRecheck.records.filter((r) => r.ghIssue === BLOCKED)).toEqual([]);
      // Its branch is still there, ready for the run after this one.
      expect(git(repo, ["rev-parse", "--verify", after.branch!])).toMatch(/\w/);
    });

    it("merges the freed slice with no agent, even outside the dispatch set", () => {
      expect(recovered.state[BLOCKED]!.phase).toBe("PASS");
      expect(recovered.state[BLOCKED]!.mergedToFeature).toBe(true);
      // Not one agent invocation was spent on the recovered slice.
      expect(recovered.records.filter((r) => r.ghIssue === BLOCKED)).toEqual([]);
      // Its worktree is gone, as it would be after any successful merge.
      expect(worktreeAfterRecovery).toBe(false);
      // The work actually landed on the feature branch.
      expect(featureTreeAfterRecovery).toContain(
        "supabase/migrations/042_orders.sql",
      );
    });

    it("unblocks the dependent it had held back for three runs", () => {
      expect(recovered.state[DEPENDENT]!.phase).toBe("PASS");
      expect(recovered.records.some((r) => r.ghIssue === DEPENDENT)).toBe(true);
    });
  });

  it("does not report zero dispatch when merge-only recovery is the only slice work", async () => {
    const repo = makeRepo();
    const slug = "merge-pending-only-work";
    seedMigrationOnMain(repo, "042_users.sql");
    const { prdDir, specsDir } = writePrdFixture(repo, slug);
    const slices = [slicesWithDependent()[0]!];
    const fixtures = fixturesWithDependent();
    fixtures.delete(DEPENDENT);
    const featBranch = `feat-stub/${slug}`;
    const config = { repoRoot: repo, prdSlug: slug, prdDir, specsDir };

    await runPipeline({
      ...config,
      dag: buildDAG(slices),
      provider: buildStubProvider({ fixtures, slices, records: [] }),
    });
    expect(stateOf(repo, slug)[BLOCKED]!.phase).toBe("MERGE-PENDING");

    git(repo, ["checkout", featBranch]);
    git(repo, [
      "mv",
      "supabase/migrations/042_users.sql",
      "supabase/migrations/041_users.sql",
    ]);
    git(repo, ["commit", "-m", "renumber users migration to 041"]);
    git(repo, ["checkout", "main"]);

    const records: InvocationRecord[] = [];
    const baseProvider = buildStubProvider({ fixtures, slices, records });
    const provider: AgentProvider = {
      name: baseProvider.name,
      async invoke(options) {
        const result = await baseProvider.invoke(options);
        if (
          options.role === "architect-review" ||
          options.role === "pm-review"
        ) {
          const specs = join(options.cwd, ".kiro", "specs", slug);
          mkdirSync(specs, { recursive: true });
          const fileName =
            options.role === "architect-review"
              ? "review-architect.md"
              : "review-pm.md";
          writeFileSync(
            join(specs, fileName),
            "# Guardian Review\n\n**Verdict:** SHIP\n",
            "utf-8",
          );
        }
        return result;
      },
    };

    const result = await runPipeline({
      ...config,
      dag: buildDAG(slices),
      provider,
    });

    expect(result.success).toBe(true);
    expect(result.failureReason).toBeUndefined();
    expect(stateOf(repo, slug)[BLOCKED]!.phase).toBe("PASS");
    expect(records.some((record) => record.ghIssue === BLOCKED)).toBe(false);
    expect(records.every((record) => record.role.endsWith("-review"))).toBe(true);
  }, 180_000);

  /**
   * The same deferred slice after its branch is destroyed, re-entered
   * twice: once narrowed away from it, once dispatching it. Both re-runs
   * read the same broken claim, so they share the run that created it.
   */
  describe("a deferred slice whose branch is gone", () => {
    const slug = "merge-pending-lost-branch";
    let repo: string;
    let narrowed: { records: InvocationRecord[]; log: string; state: Record<string, StateSlice> };
    let dispatched: { records: InvocationRecord[]; log: string };

    beforeAll(async () => {
      const env = await createDeferredRun(slug, { lifetime: "describe" });
      repo = env.repo;

      // --- Mutate: destroy the recoverable claim. ---
      const worktree = join(repo, ".afk", "worktrees", `afk-stub-${slug}-s01`);
      const branch = stateOf(repo, slug)[BLOCKED]!.branch!;
      git(repo, ["worktree", "remove", worktree, "--force"]);
      git(repo, ["branch", "-D", branch]);

      const run = async (selectedSliceNumbers?: string[]) => {
        const records: InvocationRecord[] = [];
        await runPipeline({
          ...env.config,
          dag: buildDAG(env.slices),
          ...(selectedSliceNumbers ? { selectedSliceNumbers } : {}),
          provider: buildStubProvider({
            fixtures: fixturesWithDependent(),
            slices: env.slices,
            records,
          }),
        });
        return { records, log: latestRunLog(repo, slug), state: stateOf(repo, slug) };
      };

      narrowed = await run(["02"]);
      dispatched = await run();
    }, 240_000);

    afterAll(() => {
      try {
        rmSync(repo, { recursive: true, force: true });
      } catch {
        // best effort
      }
    });

    it("checks the excluded member but does not dispatch it", () => {
      expect(narrowed.records.some((r) => r.ghIssue === BLOCKED)).toBe(false);
      expect(narrowed.log).toContain(
        "slice is outside this invocation's dispatch set",
      );
      // Still pending: a narrowed run cannot resolve it either way.
      expect(narrowed.state[BLOCKED]!.phase).toBe("MERGE-PENDING");
    });

    it("falls through to ordinary dispatch once the slice is in scope", () => {
      // Nothing to merge, so the slice is dispatched like any other —
      // recovery does not invent an outcome from a claim that is false.
      expect(dispatched.records.some((r) => r.ghIssue === BLOCKED)).toBe(true);
      expect(dispatched.log).toContain("nothing to recover; dispatching normally");
    });
  });
});


/**
 * Launch guard: the feature branch must contain the host worktree's
 * HEAD before any slice worktree branches from it (recovery plan
 * Phase A step 2). Slice worktrees branch from the feature branch
 * while prompts and dist/ resolve from the host checkout, so a stale
 * feature branch hands agents source files older than the code
 * orchestrating them. The guard keys on host HEAD, not main — hosts
 * legitimately run from prep branches ahead of main.
 */
describe("feature-branch launch guard", () => {
  function runDirsOf(repo: string, slug: string): string[] {
    const parent = join(repo, ".afk", "logs", `${slug}-stub`);
    return readdirSync(parent)
      .filter((d) => /^run-\d{8}-\d{6}/.test(d))
      .map((d) => join(parent, d));
  }

  function readEventLines(repo: string, slug: string): Array<Record<string, unknown>> {
    const [runDir] = runDirsOf(repo, slug);
    return readFileSync(join(runDir!, "events.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
  }

  const singleSlice = (ghIssue: string): Slice[] => [
    {
      number: "01",
      ghIssue,
      title: "Guarded",
      type: "AFK",
      blockedBy: [],
      userStories: "",
    },
  ];

  it("fast-forwards a stale feature branch that is a plain ancestor of the host HEAD", async () => {
    const repo = makeRepo();
    const slug = "guard-ff";
    const { prdDir, specsDir } = writePrdFixture(repo, slug);
    const featBranch = `feat-stub/${slug}`;

    // Feature branch left behind by a previous run, then the host
    // moved ahead (e.g. a prep-chain PR landed).
    git(repo, ["branch", featBranch]);
    const staleTip = git(repo, ["rev-parse", featBranch]);
    writeFileSync(join(repo, "HOST.md"), "host moved ahead\n", "utf-8");
    git(repo, ["add", "HOST.md"]);
    git(repo, ["commit", "-m", "host: prep commit after feature branch fork"]);
    const hostHead = git(repo, ["rev-parse", "HEAD"]);

    const slices = singleSlice("8801");
    const fixtures = new Map<string, SliceFixture>([
      ["8801", { files: ["src/g.txt"], qaPasses: true, outputFile: "src/g.txt", outputContent: "g" }],
    ]);

    const result = await runPipeline({
      repoRoot: repo,
      prdSlug: slug,
      prdDir,
      specsDir,
      dag: buildDAG(slices),
      provider: buildStubProvider({ fixtures, slices, records: [] }),
    });

    // The slice ran to PASS on the refreshed base. (`result.success`
    // stays false here only because the stub's no-op reviews leave no
    // verdict to ship on — issue #43.)
    const events = readEventLines(repo, slug);
    const outcome = events.find((l) => l.type === "slice-outcome") as
      | { slice: { phase: string } }
      | undefined;
    expect(outcome?.slice.phase).toBe("PASS");
    expect(result.failureReason ?? "").not.toContain("Refusing to launch");
    // The branch was fast-forwarded before any worktree branched from
    // it: the host's prep commit is part of the shipped feature branch.
    expect(git(repo, ["merge-base", "--is-ancestor", hostHead, featBranch])).toBe("");
    expect(git(repo, ["show", `${featBranch}:HOST.md`])).toContain("host moved ahead");

    const warn = readEventLines(repo, slug).find(
      (l) => l.type === "warn" && l.reason === "feature-branch-fast-forward",
    ) as { message: string } | undefined;
    expect(warn).toBeDefined();
    expect(warn!.message).toContain(staleTip);
    expect(warn!.message).toContain(hostHead);
  }, 240_000);

  it("refuses to launch when the feature branch and the host HEAD have diverged", async () => {
    const repo = makeRepo();
    const slug = "guard-diverge";
    const { prdDir, specsDir } = writePrdFixture(repo, slug);
    const featBranch = `feat-stub/${slug}`;

    // Feature branch with its own commit, host with a different one:
    // neither contains the other.
    git(repo, ["checkout", "-b", featBranch]);
    writeFileSync(join(repo, "FEAT.md"), "feature-only work\n", "utf-8");
    git(repo, ["add", "FEAT.md"]);
    git(repo, ["commit", "-m", "feat: feature-only commit"]);
    const featureTip = git(repo, ["rev-parse", featBranch]);
    git(repo, ["checkout", "main"]);
    writeFileSync(join(repo, "HOST.md"), "host-only work\n", "utf-8");
    git(repo, ["add", "HOST.md"]);
    git(repo, ["commit", "-m", "host: host-only commit"]);
    const hostHead = git(repo, ["rev-parse", "HEAD"]);

    const slices = singleSlice("8802");
    const fixtures = new Map<string, SliceFixture>([
      ["8802", { files: ["src/g.txt"], qaPasses: true, outputFile: "src/g.txt", outputContent: "g" }],
    ]);
    const records: InvocationRecord[] = [];

    await expect(
      runPipeline({
        repoRoot: repo,
        prdSlug: slug,
        prdDir,
        specsDir,
        dag: buildDAG(slices),
        provider: buildStubProvider({ fixtures, slices, records }),
      }),
    ).rejects.toThrow(
      new RegExp(`Refusing to launch.*${featureTip}.*${hostHead}`, "s"),
    );

    // Refusal happened before any agent was dispatched, and mutated
    // neither branch.
    expect(records).toHaveLength(0);
    expect(git(repo, ["rev-parse", featBranch])).toBe(featureTip);
    expect(git(repo, ["rev-parse", "main"])).toBe(hostHead);
  }, 240_000);
});

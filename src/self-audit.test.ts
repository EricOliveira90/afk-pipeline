import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCandidateGatePhase } from "./candidate-gate-phase.js";
import {
  resolveCandidateTreeId,
  type GateDeclaration,
} from "./gate-runner.js";
import { renderPrompt } from "./prompt-template.js";
import { TransientProviderError } from "./agent-provider.js";
import { buildSelfAuditOutcomeEvent } from "./run-events.js";
import {
  RUN_STATE_VERSION,
  loadRunState,
  recordSelfAuditOutcome,
  saveRunState,
  selfAuditsFor,
  type PersistedSelfAuditVerdict,
} from "./run-state.js";
import {
  classifySelfAuditFailure,
  classifySelfAuditVerdict,
  isInfrastructureSelfAuditCause,
  resolveGradedCandidate,
  runSelfAuditStage,
  selectAuditedGateDeclarations,
  verifyAuditedTree,
  type SelfAuditDispatchInput,
} from "./self-audit.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

const PRD_SLUG = "generator-self-audit-gate";
const GH_ISSUE = "299";
const SLICE_DIR = `.kiro/specs/${PRD_SLUG}/slices/01-audit-invocation`;
/** A run directory's name (ADR 0017) — the provenance a v8 outcome carries. */
const RUN_ID = "20260915-120000-abcdef";

/**
 * The stage's own boundary (#299 B-02, B-09, ADR 0069).
 *
 * Dispatch is an injected callback (`src/cleaner-stage.ts`'s `ctx.dispatch`
 * pattern), so the whole stage runs here without a provider and without a
 * spawned pipeline. The one thing that is real is the tree: the worktree is a
 * genuine git repository, hashed by the same `resolveCandidateTreeId` the gate
 * cache and ADR 0012's base-gate authorization use, because the verdict is that
 * comparison and nothing else.
 */
describe("runSelfAuditStage", () => {
  let worktree: string;
  let stateRoot: string;
  /** The tree the required cheap gates released, hashed from the real repo. */
  let releasedTree: string;

  beforeEach(() => {
    worktree = mkdtempSync(join(tmpdir(), "afk-self-audit-tree-"));
    stateRoot = mkdtempSync(join(tmpdir(), "afk-self-audit-state-"));
    git(worktree, ["init", "--initial-branch=main"]);
    git(worktree, ["config", "user.email", "t@t"]);
    git(worktree, ["config", "user.name", "t"]);
    mkdirSync(join(worktree, "src"), { recursive: true });
    writeFileSync(join(worktree, "src", "work.ts"), "export const v = 1;\n");
    git(worktree, ["add", "-A"]);
    git(worktree, ["commit", "-m", "feat: candidate (#299)"]);
    releasedTree = resolveCandidateTreeId(worktree);
    saveRunState(stateRoot, {
      version: RUN_STATE_VERSION,
      prdSlug: PRD_SLUG,
      featureBranch: `feat/${PRD_SLUG}`,
      slices: {},
    });
  });

  afterEach(() => {
    for (const dir of [worktree, stateRoot]) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function stageInput(overrides: {
    selfAudit?: boolean;
    candidateTreeId?: string;
    dispatch: (input: SelfAuditDispatchInput) => Promise<void>;
    changeSummary?: () => string;
    /** #301 B-03: `unknown` so a degenerate budget can be driven through. */
    infrastructureRetries?: unknown;
  }) {
    return {
      repoRoot: stateRoot,
      prdSlug: PRD_SLUG,
      ghIssue: GH_ISSUE,
      runId: RUN_ID,
      worktreeDir: worktree,
      sliceDir: SLICE_DIR,
      ...(overrides.selfAudit === undefined
        ? {}
        : { selfAudit: overrides.selfAudit }),
      qaBaseGate: {
        candidateTreeId: overrides.candidateTreeId ?? releasedTree,
      },
      checkpoint: { treeId: releasedTree },
      changeSummary: overrides.changeSummary ?? (() => "COMMIT-LOG"),
      dispatch: overrides.dispatch,
      ...(overrides.infrastructureRetries === undefined
        ? {}
        : {
            // A cast, deliberately: `-1`, `1.5`, `NaN` and a non-number all have
            // to reach the stage, because the claim under test is that it
            // degrades each to "no retry" instead of throwing.
            infrastructureRetries:
              overrides.infrastructureRetries as number,
          }),
    };
  }

  it("[behavior:#299:B-02] dispatches nothing when the run did not opt in", async () => {
    const dispatch = vi.fn(async () => {});
    const summary = vi.fn(() => "COMMIT-LOG");
    const statePath = join(stateRoot, ".afk", "state", `${PRD_SLUG}.json`);
    const before = readFileSync(statePath, "utf-8");

    // `--self-audit` absent is the default, and the gates-passed branch must
    // behave exactly as it did before this stage existed.
    await expect(
      runSelfAuditStage(stageInput({ dispatch, changeSummary: summary })),
    ).resolves.toEqual({ ran: false });

    expect(dispatch).toHaveBeenCalledTimes(0);
    // Not even the change summary is derived: a declined audit costs the run
    // nothing, which is why the hub passes a supplier rather than a string.
    expect(summary).toHaveBeenCalledTimes(0);
    expect(selfAuditsFor(loadRunState(stateRoot, PRD_SLUG), GH_ISSUE)).toEqual(
      [],
    );
    expect(readFileSync(statePath, "utf-8")).toBe(before);
  });

  it("[behavior:#299:B-02] dispatches nothing when the released evidence names another tree", async () => {
    const dispatch = vi.fn(async () => {});
    const statePath = join(stateRoot, ".afk", "state", `${PRD_SLUG}.json`);
    const before = readFileSync(statePath, "utf-8");

    // An audit of a tree the base-gate evidence does not name is an audit of
    // the wrong thing, so the stage declines rather than throws: it may add
    // scrutiny and may never block a run by its own failure.
    await expect(
      runSelfAuditStage(
        stageInput({
          selfAudit: true,
          candidateTreeId: "f".repeat(40),
          dispatch,
        }),
      ),
    ).resolves.toEqual({ ran: false });

    expect(dispatch).toHaveBeenCalledTimes(0);
    expect(selfAuditsFor(loadRunState(stateRoot, PRD_SLUG), GH_ISSUE)).toEqual(
      [],
    );
    expect(readFileSync(statePath, "utf-8")).toBe(before);
  });

  it("[behavior:#299:B-09] audits once and records AUDIT_UNCHANGED for an untouched tree", async () => {
    const dispatch = vi.fn(async (input: SelfAuditDispatchInput) => {
      // A real audit that found nothing: it reads, it writes nothing, and the
      // tree it hands back is the tree it was given.
      expect(input.prompt).toContain(`${SLICE_DIR}/contract.md`);
      expect(input.prompt).toContain(releasedTree);
      expect(input.evidence.role).toBe("generator-audit");
    });
    const input = stageInput({ selfAudit: true, dispatch });
    const baseGateBefore = structuredClone(input.qaBaseGate);
    const checkpointBefore = structuredClone(input.checkpoint);

    const result = await runSelfAuditStage(input);

    expect(result).toEqual({
      ran: true,
      verdict: "AUDIT_UNCHANGED",
      treeId: releasedTree,
    });
    // Exactly one invocation per QA submission: no retry, and no second
    // challenge for the tree the audit handed back.
    expect(dispatch).toHaveBeenCalledTimes(1);

    // The stage's own obligation, not the writer's: a stage that classified the
    // verdict and never called the writer fails here.
    const recorded = selfAuditsFor(loadRunState(stateRoot, PRD_SLUG), GH_ISSUE);
    expect(recorded).toEqual([
      {
        candidateTreeId: releasedTree,
        auditedTreeId: releasedTree,
        verdict: "AUDIT_UNCHANGED",
        runId: RUN_ID,
      },
    ]);

    // The orchestrator goes on to hand these very objects to the deterministic
    // QA dispatch, so the stage may read them and must not rewrite them.
    expect(input.qaBaseGate).toEqual(baseGateBefore);
    expect(input.checkpoint).toEqual(checkpointBefore);
  });

  it("[behavior:#299:B-09] reports AUDIT_NOT_RUN on the released tree when the dispatch throws", async () => {
    const logged: string[] = [];
    const result = await runSelfAuditStage({
      ...stageInput({
        selfAudit: true,
        dispatch: async () => {
          throw new Error("provider died mid-audit");
        },
      }),
      log: (message) => logged.push(message),
    });

    // The uncertain case takes the branch that cannot loop (ADR 0041): QA
    // grades exactly the tree the gates released, as if no audit had run.
    expect(result).toEqual({
      ran: true,
      verdict: "AUDIT_NOT_RUN",
      treeId: releasedTree,
    });
    expect(logged.join("\n")).toContain("provider died mid-audit");
    // #301 B-04 made the recording unconditional: the invocation was spent
    // whatever it produced, so the outcome is persisted with no `auditedTreeId`
    // (there is no audited tree to name) rather than dropped.
    expect(selfAuditsFor(loadRunState(stateRoot, PRD_SLUG), GH_ISSUE)).toEqual([
      {
        candidateTreeId: releasedTree,
        verdict: "AUDIT_NOT_RUN",
        runId: RUN_ID,
      },
    ]);
  });

  it("[behavior:#299:B-09] [behavior:#300:B-01] records AUDIT_CHANGED naming both trees when the audit rewrote the tree", async () => {
    const dispatch = vi.fn(async () => {
      writeFileSync(join(worktree, "src", "work.ts"), "export const v = 2;\n");
      git(worktree, ["add", "-A"]);
      git(worktree, ["commit", "-m", "fix: the audit found a gap (#300)"]);
    });

    const result = await runSelfAuditStage(
      stageInput({ selfAudit: true, dispatch }),
    );

    expect(result.ran).toBe(true);
    expect(result).toMatchObject({ verdict: "AUDIT_CHANGED" });
    expect(result).not.toMatchObject({ treeId: releasedTree });
    const auditedTree = (result as { treeId: string }).treeId;
    // Still exactly one invocation per QA submission: the changed tree is never
    // challenged a second time (#300 B-07).
    expect(dispatch).toHaveBeenCalledTimes(1);

    // Recording is the stage's own obligation and happens whatever the audited
    // tree's gate re-run later concludes: the verdict is a fact about the audit,
    // not about the gates. `candidateTreeId` is the tree the gates released and
    // `auditedTreeId` the tree the audit left, so the two differ here — which is
    // exactly what distinguishes this entry from an `AUDIT_UNCHANGED` one.
    const recorded = selfAuditsFor(loadRunState(stateRoot, PRD_SLUG), GH_ISSUE);
    expect(recorded).toEqual([
      {
        candidateTreeId: releasedTree,
        auditedTreeId: auditedTree,
        verdict: "AUDIT_CHANGED",
        runId: RUN_ID,
      },
    ]);
    expect(recorded[0]!.candidateTreeId).not.toBe(recorded[0]!.auditedTreeId);
  });

  it("[behavior:#300:P-01] leaves the declined and unchanged paths exactly as they are", async () => {
    const declinedDispatch = vi.fn(async () => {});

    await expect(
      runSelfAuditStage(stageInput({ dispatch: declinedDispatch })),
    ).resolves.toEqual({ ran: false });
    expect(declinedDispatch).toHaveBeenCalledTimes(0);
    expect(selfAuditsFor(loadRunState(stateRoot, PRD_SLUG), GH_ISSUE)).toEqual(
      [],
    );

    const unchangedDispatch = vi.fn(async () => {});
    await expect(
      runSelfAuditStage(
        stageInput({ selfAudit: true, dispatch: unchangedDispatch }),
      ),
    ).resolves.toEqual({
      ran: true,
      verdict: "AUDIT_UNCHANGED",
      treeId: releasedTree,
    });
    expect(unchangedDispatch).toHaveBeenCalledTimes(1);
    expect(selfAuditsFor(loadRunState(stateRoot, PRD_SLUG), GH_ISSUE)).toEqual([
      {
        candidateTreeId: releasedTree,
        auditedTreeId: releasedTree,
        verdict: "AUDIT_UNCHANGED",
        runId: RUN_ID,
      },
    ]);
    // Neither path mints an audited checkpoint or runs an extra gate. That is
    // not observable here — `SelfAuditStageInput` declares no `createCheckpoint`
    // and this stage never reaches the minting seam — so it is asserted where it
    // can fail: the B-05 scan pins the single `verifyAuditedTree(` call site
    // behind its `AUDIT_CHANGED` guard. What is observable here is the
    // consequence: with no audited value, the graded candidate *is* the
    // pre-audit pair, base-gate object included, by reference.
    const released = { treeId: releasedTree, commitSha: "c".repeat(40) };
    const releasedBaseGate = { candidateTreeId: releasedTree };
    const graded = resolveGradedCandidate({ released, releasedBaseGate });
    expect(graded).toEqual({ ...released, baseGate: releasedBaseGate });
    expect(graded.baseGate).toBe(releasedBaseGate);
  });

  it("[behavior:#300:P-03] records the changed verdict with no field of the changed-tree path's own", async () => {
    // The changed-tree path still adds no member of its own. The schema did move
    // to 8, but for one reason that is not this path's: #301 B-06 widened every
    // entry with `runId`, whatever verdict wrote it. So the shape asserted below
    // is slice 1's three members plus that one, and nothing else.
    expect(RUN_STATE_VERSION).toBe(8);

    await runSelfAuditStage(
      stageInput({
        selfAudit: true,
        dispatch: async () => {
          writeFileSync(
            join(worktree, "src", "work.ts"),
            "export const v = 3;\n",
          );
          git(worktree, ["add", "-A"]);
          git(worktree, ["commit", "-m", "fix: audited (#300)"]);
        },
      }),
    );

    const state = loadRunState(stateRoot, PRD_SLUG);
    expect(state.version).toBe(8);
    const recorded = selfAuditsFor(state, GH_ISSUE);
    expect(recorded).toHaveLength(1);
    expect(Object.keys(recorded[0]!).sort()).toEqual([
      "auditedTreeId",
      "candidateTreeId",
      "runId",
      "verdict",
    ]);
  });

  /* -------------------------------------------------------------------------
   * The completed-invocation bound (#301)
   * ----------------------------------------------------------------------- */

  /** A rejection the classifier reads as `provider-exit`, i.e. infrastructure. */
  const EXIT_1 = "Agent generator exited with code 1";
  /** A rejection the classifier reads as an opted-in bound doing its job. */
  const TOOL_CAP = "Agent generator exceeded 40 tool calls and was killed";

  /** Reset the run-state file, so an earlier entry cannot read as spent. */
  function resetRunState(): void {
    // `saveRunState` refuses to replace an existing file from a whole-file
    // snapshot, which is the guard working: the file goes first.
    rmSync(join(stateRoot, ".afk", "state", `${PRD_SLUG}.json`), {
      force: true,
    });
    saveRunState(stateRoot, {
      version: RUN_STATE_VERSION,
      prdSlug: PRD_SLUG,
      featureBranch: `feat/${PRD_SLUG}`,
      slices: {},
    });
  }

  /** Persist one outcome for this issue, as an interrupted earlier run would. */
  function seedOutcome(entry: {
    candidateTreeId: string;
    auditedTreeId?: string;
    verdict: PersistedSelfAuditVerdict;
  }): void {
    recordSelfAuditOutcome(stateRoot, PRD_SLUG, GH_ISSUE, {
      ...entry,
      runId: "20260914-090000-earlier",
    });
  }

  it("[behavior:#301:B-03] retries an infrastructure-classified dead invocation under the run's budget and stops on the first completed one", async () => {
    const logged: string[] = [];
    let attempts = 0;
    const dispatch = vi.fn(async () => {
      attempts += 1;
      // Two dead invocations, then one that completes leaving the tree alone.
      if (attempts <= 2) throw new Error(EXIT_1);
    });

    const result = await runSelfAuditStage({
      ...stageInput({ selfAudit: true, dispatch, infrastructureRetries: 2 }),
      log: (message) => logged.push(message),
    });

    // `infrastructureRetries + 1` attempts, and the loop exits on the first
    // completed one: a retry replaces a dead invocation rather than buying a
    // second completed challenge.
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(result).toEqual({
      ran: true,
      verdict: "AUDIT_UNCHANGED",
      treeId: releasedTree,
    });
    // One completed invocation, so one entry — not one per attempt.
    expect(selfAuditsFor(loadRunState(stateRoot, PRD_SLUG), GH_ISSUE)).toEqual([
      {
        candidateTreeId: releasedTree,
        auditedTreeId: releasedTree,
        verdict: "AUDIT_UNCHANGED",
        runId: RUN_ID,
      },
    ]);

    // Narrated through the existing sink, in the shared retry vocabulary: no new
    // typed warn event and no new warn reason.
    const retries = logged.filter((line) =>
      line.startsWith("self-audit: infrastructure retry"),
    );
    expect(retries).toHaveLength(2);
    expect(retries[0]).toContain("retry 1/2 — ");
    expect(retries[1]).toContain("retry 2/2 — ");
    // The cause summary rides along, so an operator reading the log knows why.
    for (const line of retries) expect(line).toContain("exited with code 1");
  });

  it("[behavior:#301:B-03] [behavior:#301:B-02] never retries a non-infrastructure cause", async () => {
    const logged: string[] = [];
    const capped = vi.fn(async () => {
      throw new Error(TOOL_CAP);
    });

    // A tool-call cap only exists because a caller opted in (ADR 0036), so
    // tripping it is the bound working, not infrastructure flaking — a verbatim
    // retry would spend another full budget re-hitting it.
    await expect(
      runSelfAuditStage({
        ...stageInput({ selfAudit: true, dispatch: capped, infrastructureRetries: 2 }),
        log: (message) => logged.push(message),
      }),
    ).resolves.toEqual({
      ran: true,
      verdict: "AUDIT_NOT_RUN",
      treeId: releasedTree,
    });
    expect(capped).toHaveBeenCalledTimes(1);

    resetRunState();

    // An envelope that fails closed is an `internal-error`: a pipeline-internal
    // throw whose blast radius a retry cannot change. Assembly happens before
    // the callback, so the attempt is counted by the change-summary supplier the
    // envelope pulls — the dispatch spy is never reached at all.
    const unreached = vi.fn(async () => {});
    const changeSummary = vi.fn(() => {
      throw new Error("manifest is unreadable");
    });
    await expect(
      runSelfAuditStage({
        ...stageInput({
          selfAudit: true,
          dispatch: unreached,
          changeSummary,
          infrastructureRetries: 2,
        }),
        log: (message) => logged.push(message),
      }),
    ).resolves.toEqual({
      ran: true,
      verdict: "AUDIT_NOT_RUN",
      treeId: releasedTree,
    });
    expect(changeSummary).toHaveBeenCalledTimes(1);
    expect(unreached).toHaveBeenCalledTimes(0);

    expect(
      logged.filter((line) =>
        line.startsWith("self-audit: infrastructure retry"),
      ),
    ).toEqual([]);
  });

  it("[behavior:#301:B-03] reads every degenerate retry budget as zero rather than throwing", async () => {
    // This stage may never block a run by its own failure, its own input
    // validation included: an operator-supplied budget that makes no sense costs
    // the run its audit, never the slice. `undefined` must not read as unbounded.
    const budgets: unknown[] = [undefined, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "2"];

    for (const budget of budgets) {
      resetRunState();
      const logged: string[] = [];
      const dispatch = vi.fn(async () => {
        throw new Error(EXIT_1);
      });

      await expect(
        runSelfAuditStage({
          ...stageInput({
            selfAudit: true,
            dispatch,
            ...(budget === undefined ? {} : { infrastructureRetries: budget }),
          }),
          log: (message) => logged.push(message),
        }),
        String(budget),
      ).resolves.toEqual({
        ran: true,
        verdict: "AUDIT_NOT_RUN",
        treeId: releasedTree,
      });
      expect(dispatch, String(budget)).toHaveBeenCalledTimes(1);
      expect(
        logged.filter((line) =>
          line.startsWith("self-audit: infrastructure retry"),
        ),
        String(budget),
      ).toEqual([]);
    }
  });

  it("[behavior:#301:B-04] records AUDIT_NOT_RUN with the run's id and no audited tree when the budget is exhausted", async () => {
    const dispatch = vi.fn(async () => {
      throw new Error(EXIT_1);
    });

    await runSelfAuditStage(
      stageInput({ selfAudit: true, dispatch, infrastructureRetries: 1 }),
    );

    // `infrastructureRetries: 1` buys one retry: two attempts, both dead.
    expect(dispatch).toHaveBeenCalledTimes(2);
    const recorded = selfAuditsFor(loadRunState(stateRoot, PRD_SLUG), GH_ISSUE);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toEqual({
      candidateTreeId: releasedTree,
      verdict: "AUDIT_NOT_RUN",
      runId: RUN_ID,
    });
    // Absent rather than blank or equal to the released id: after a dead
    // invocation there is no audited tree to name honestly.
    expect("auditedTreeId" in recorded[0]!).toBe(false);
  });

  it("[behavior:#301:B-04] records AUDIT_NOT_RUN when the invocation completed but its tree cannot be resolved", async () => {
    const dispatch = vi.fn(async () => {
      // Completed, and left behind a worktree nothing can hash.
      rmSync(join(worktree, ".git"), { recursive: true, force: true });
    });

    await expect(
      runSelfAuditStage(stageInput({ selfAudit: true, dispatch })),
    ).resolves.toEqual({
      ran: true,
      verdict: "AUDIT_NOT_RUN",
      treeId: releasedTree,
    });

    expect(dispatch).toHaveBeenCalledTimes(1);
    const recorded = selfAuditsFor(loadRunState(stateRoot, PRD_SLUG), GH_ISSUE);
    expect(recorded).toEqual([
      {
        candidateTreeId: releasedTree,
        verdict: "AUDIT_NOT_RUN",
        runId: RUN_ID,
      },
    ]);
    expect("auditedTreeId" in recorded[0]!).toBe(false);
  });

  it("[behavior:#301:B-05] proceeds to QA on the released tree whatever killed the audit", async () => {
    for (const [label, message] of [
      ["infrastructure", EXIT_1],
      ["non-infrastructure", "something broke inside the pipeline"],
    ] as const) {
      resetRunState();
      // Neither await rejects: the audit's own death is not the run's death.
      await expect(
        runSelfAuditStage(
          stageInput({
            selfAudit: true,
            infrastructureRetries: 1,
            dispatch: async () => {
              throw new Error(message);
            },
          }),
        ),
        label,
      ).resolves.toEqual({
        ran: true,
        verdict: "AUDIT_NOT_RUN",
        treeId: releasedTree,
      });
    }

    // And with no audited value the graded candidate is the released pair, the
    // base-gate object included by identity — so the hub's changed-tree branch
    // cannot be entered off an AUDIT_NOT_RUN.
    const released = { treeId: releasedTree, commitSha: "a".repeat(40) };
    const releasedBaseGate = { candidateTreeId: releasedTree };
    const graded = resolveGradedCandidate({ released, releasedBaseGate });
    expect(graded).toEqual({ ...released, baseGate: releasedBaseGate });
    expect(graded.baseGate).toBe(releasedBaseGate);
  });

  it("[behavior:#301:B-07] dispatches nothing when a persisted outcome already names the tree in hand", async () => {
    const spentCases: Array<{
      label: string;
      entry: {
        candidateTreeId: string;
        auditedTreeId?: string;
        verdict: PersistedSelfAuditVerdict;
      };
    }> = [
      {
        label: "AUDIT_UNCHANGED on this tree",
        entry: {
          candidateTreeId: releasedTree,
          auditedTreeId: releasedTree,
          verdict: "AUDIT_UNCHANGED",
        },
      },
      {
        // A run resumed after AUDIT_CHANGED re-hashes the *audited* tree as its
        // released tree, so the pre-audit id is no longer the id in hand.
        label: "AUDIT_CHANGED whose audited tree is this one",
        entry: {
          candidateTreeId: "b".repeat(40),
          auditedTreeId: releasedTree,
          verdict: "AUDIT_CHANGED",
        },
      },
      {
        label: "AUDIT_NOT_RUN on this tree",
        entry: {
          candidateTreeId: releasedTree,
          verdict: "AUDIT_NOT_RUN",
        },
      },
    ];

    for (const { label, entry } of spentCases) {
      resetRunState();
      seedOutcome(entry);
      const dispatch = vi.fn(async () => {});

      await expect(
        runSelfAuditStage(stageInput({ selfAudit: true, dispatch })),
        label,
      ).resolves.toEqual({ ran: false, spent: entry.verdict });

      expect(dispatch, label).toHaveBeenCalledTimes(0);
      // Nothing recorded either: a spent invocation is not re-spent and not
      // double-counted in the totals the summary reports.
      expect(
        selfAuditsFor(loadRunState(stateRoot, PRD_SLUG), GH_ISSUE),
        label,
      ).toHaveLength(1);
    }

    // An entry naming some other tree in both fields is somebody else's
    // invocation, so this tree still gets its one audit.
    resetRunState();
    seedOutcome({
      candidateTreeId: "c".repeat(40),
      auditedTreeId: "d".repeat(40),
      verdict: "AUDIT_UNCHANGED",
    });
    const dispatch = vi.fn(async () => {});

    await expect(
      runSelfAuditStage(stageInput({ selfAudit: true, dispatch })),
    ).resolves.toEqual({
      ran: true,
      verdict: "AUDIT_UNCHANGED",
      treeId: releasedTree,
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(selfAuditsFor(loadRunState(stateRoot, PRD_SLUG), GH_ISSUE)).toHaveLength(
      2,
    );
  });

  it("[behavior:#301:B-08] builds the outcome event from a stage result, with the audited tree only when there is one", async () => {
    const unchanged = await runSelfAuditStage(
      stageInput({ selfAudit: true, dispatch: async () => {} }),
    );
    expect(unchanged.ran).toBe(true);

    const graded = buildSelfAuditOutcomeEvent({
      ghIssue: GH_ISSUE,
      sliceNumber: "03",
      round: 2,
      runId: RUN_ID,
      candidateTreeId: releasedTree,
      auditedTreeId: (unchanged as { treeId: string }).treeId,
      verdict: "AUDIT_UNCHANGED",
    });
    expect(graded).toEqual({
      type: "self-audit-outcome",
      ghIssue: GH_ISSUE,
      sliceNumber: "03",
      round: 2,
      runId: RUN_ID,
      candidateTreeId: releasedTree,
      auditedTreeId: releasedTree,
      verdict: "AUDIT_UNCHANGED",
    });

    // The AUDIT_NOT_RUN shape omits the key rather than carrying it undefined,
    // so a reader cannot mistake "no audited tree" for "audited tree unknown".
    const notRun = buildSelfAuditOutcomeEvent({
      ghIssue: GH_ISSUE,
      sliceNumber: "03",
      round: 2,
      runId: RUN_ID,
      candidateTreeId: releasedTree,
      verdict: "AUDIT_NOT_RUN",
    });
    expect("auditedTreeId" in notRun).toBe(false);
    expect(notRun.verdict).toBe("AUDIT_NOT_RUN");
  });

  it("[behavior:#301:P-01] declines with no spent member, no entry and nothing dispatched", async () => {
    const declines: Array<[string, Parameters<typeof stageInput>[0]]> = [
      ["not opted in", { dispatch: vi.fn(async () => {}) }],
      [
        "released evidence names another tree",
        {
          selfAudit: true,
          candidateTreeId: "e".repeat(40),
          dispatch: vi.fn(async () => {}),
        },
      ],
    ];

    for (const [label, overrides] of declines) {
      resetRunState();
      const result = await runSelfAuditStage(stageInput(overrides));

      expect(result, label).toEqual({ ran: false });
      // `spent` distinguishes the resume short-circuit from these two, so its
      // absence here is the load-bearing part of the shape.
      expect("spent" in result, label).toBe(false);
      expect(overrides.dispatch, label).toHaveBeenCalledTimes(0);
      const state = loadRunState(stateRoot, PRD_SLUG);
      expect(selfAuditsFor(state, GH_ISSUE), label).toEqual([]);
      expect(state.selfAudits, label).toBeUndefined();
    }
  });

  it("[behavior:#301:P-02] still grades the two structural verdicts from the tree comparison alone", async () => {
    const unchangedDispatch = vi.fn(async () => {});
    await expect(
      runSelfAuditStage(
        stageInput({ selfAudit: true, dispatch: unchangedDispatch }),
      ),
    ).resolves.toEqual({
      ran: true,
      verdict: "AUDIT_UNCHANGED",
      treeId: releasedTree,
    });
    expect(unchangedDispatch).toHaveBeenCalledTimes(1);
    const unchangedEntry = selfAuditsFor(
      loadRunState(stateRoot, PRD_SLUG),
      GH_ISSUE,
    )[0]!;
    expect(unchangedEntry.candidateTreeId).toBe(releasedTree);
    expect(unchangedEntry.auditedTreeId).toBe(releasedTree);

    resetRunState();
    const changedDispatch = vi.fn(async () => {
      writeFileSync(join(worktree, "src", "work.ts"), "export const v = 9;\n");
      git(worktree, ["add", "-A"]);
      git(worktree, ["commit", "-m", "fix: the audit found a gap (#301)"]);
    });
    const changed = await runSelfAuditStage(
      stageInput({ selfAudit: true, dispatch: changedDispatch }),
    );

    expect(changed).toMatchObject({ ran: true, verdict: "AUDIT_CHANGED" });
    expect(changedDispatch).toHaveBeenCalledTimes(1);
    const changedEntry = selfAuditsFor(
      loadRunState(stateRoot, PRD_SLUG),
      GH_ISSUE,
    )[0]!;
    // Recorded before the stage returned, and the pair differs — which is the
    // whole content of the verdict.
    expect(changedEntry.candidateTreeId).toBe(releasedTree);
    expect(changedEntry.auditedTreeId).toBe((changed as { treeId: string }).treeId);
    expect(changedEntry.auditedTreeId).not.toBe(changedEntry.candidateTreeId);
  });

  it("[behavior:#301:P-03] spends one invocation when the first attempt completes, and keeps the audited path dispatch-free", async () => {
    const dispatch = vi.fn(async () => {});

    await runSelfAuditStage(
      stageInput({ selfAudit: true, dispatch, infrastructureRetries: 2 }),
    );

    // A budget is not a quota: an invocation that completed is the one this
    // submission gets, whatever the budget allowed.
    expect(dispatch).toHaveBeenCalledTimes(1);

    // And the changed-tree path still cannot re-challenge: it declares no way to
    // dispatch, so the bound is structural rather than a counter.
    const source = readFileSync("src/self-audit.ts", "utf-8");
    const inputDecl = source.slice(
      source.indexOf("export interface AuditedTreeVerificationInput"),
    );
    expect(inputDecl.slice(0, inputDecl.indexOf("\n}"))).not.toMatch(
      /\bdispatch\b\s*[?:]/,
    );
    const body = source.slice(
      source.indexOf("export async function verifyAuditedTree"),
    );
    const verifyBody = body.slice(0, body.indexOf("\n}\n"));
    expect(verifyBody).not.toContain("runSelfAuditStage(");
    expect(verifyBody).not.toMatch(/\bdispatch\(/);
  });
});

/**
 * The dead-invocation taxonomy (#301 B-01, B-02, ADR 0025).
 *
 * Pure, so no repository and no worktree: the classifier reads a rejection and
 * returns a cause, and the retry predicate reads a cause and returns a boolean.
 */
describe("classifySelfAuditFailure", () => {
  it("[behavior:#301:B-01] classifies each rejection under ADR 0025's kinds", () => {
    const cases: Array<{
      label: string;
      error: unknown;
      kind: string;
      killClass?: string;
      exitCode?: number;
    }> = [
      {
        label: "transient",
        error: new TransientProviderError("model temporarily unavailable"),
        kind: "transient-exhausted",
      },
      {
        label: "tool-call cap",
        error: new Error("Agent generator exceeded 40 tool calls and was killed"),
        kind: "orchestrator-kill",
        killClass: "tool-call-cap",
      },
      {
        label: "wall-clock ceiling",
        error: new Error(
          "Agent generator hit the wall-clock ceiling of 1800s and was killed",
        ),
        kind: "orchestrator-kill",
        killClass: "wall-clock-ceiling",
      },
      {
        label: "idle timeout",
        error: new Error("Agent generator idle for 600s — killed"),
        kind: "orchestrator-kill",
        killClass: "idle-timeout",
      },
      {
        label: "provider exit",
        error: new Error("Agent generator exited with code 1"),
        kind: "provider-exit",
        exitCode: 1,
      },
      {
        label: "internal",
        error: new Error("manifest is unreadable"),
        kind: "internal-error",
      },
    ];

    for (const { label, error, kind, killClass, exitCode } of cases) {
      const cause = classifySelfAuditFailure(error);
      expect(cause.kind, label).toBe(kind);
      expect(cause.killClass, label).toBe(killClass);
      expect(cause.exitCode, label).toBe(exitCode);
      // The summary is narrated with every retry, so a blank one is a bug.
      expect(cause.summary.trim(), label).not.toBe("");
    }

    // The transient check has to survive a provider bundled as a duplicate
    // module instance, which is why it matches on `Error.name` rather than on
    // `instanceof` — an impostor carrying the name classifies the same way.
    const impostor = new Error("outage");
    impostor.name = "TransientProviderError";
    expect(classifySelfAuditFailure(impostor).kind).toBe("transient-exhausted");
    // A non-Error rejection still classifies rather than throwing.
    expect(classifySelfAuditFailure("just a string").kind).toBe("internal-error");

    // And the classifier is local by necessity: the hub imports this module, so
    // importing the hub's own classifier back would be a cycle.
    const source = readFileSync("src/self-audit.ts", "utf-8");
    expect(source).toContain(
      'import { isTransientProviderError } from "./agent-provider.js";',
    );
    expect(
      [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]),
    ).not.toContain("./orchestrator.js");
  });

  it("[behavior:#301:B-02] treats three kinds as worth re-dispatching and two as not", () => {
    const infrastructure = [
      { kind: "provider-exit", summary: "s", exitCode: 1 },
      { kind: "orchestrator-kill", summary: "s", killClass: "wall-clock-ceiling" },
      { kind: "orchestrator-kill", summary: "s", killClass: "idle-timeout" },
      { kind: "orchestrator-kill", summary: "s", killClass: "unspecified" },
      { kind: "transient-exhausted", summary: "s" },
    ] as const;
    for (const cause of infrastructure) {
      expect(isInfrastructureSelfAuditCause(cause), cause.kind).toBe(true);
    }

    // A cap is an opted-in bound doing its job (ADR 0036), not flakiness; an
    // internal error's blast radius a retry cannot change.
    expect(
      isInfrastructureSelfAuditCause({
        kind: "orchestrator-kill",
        summary: "s",
        killClass: "tool-call-cap",
      }),
    ).toBe(false);
    expect(
      isInfrastructureSelfAuditCause({ kind: "internal-error", summary: "s" }),
    ).toBe(false);
  });
});

/**
 * The re-run set (#300 B-03).
 *
 * Pure and literal: the catalog is a parameter rather than a filesystem read, so
 * the claim under test — *which* declarations re-run, and that they are the very
 * objects that released the pre-audit tree — is decidable without a repository.
 */
describe("selectAuditedGateDeclarations", () => {
  it("[behavior:#300:B-03] returns the catalog-named required declarations, as the same objects", () => {
    const typecheck: GateDeclaration = {
      id: "typecheck",
      stage: "base",
      required: true,
      command: "pnpm",
      args: ["run", "typecheck"],
    };
    const lint: GateDeclaration = {
      id: "lint",
      stage: "base",
      required: true,
      command: "pnpm",
      args: ["run", "lint"],
    };
    // A catalog gate the catalog does not call required — the
    // environment-sensitive shape, which is always emitted `required: false`.
    const budgets: GateDeclaration = {
      id: "test:budgets",
      stage: "base",
      required: false,
      command: "pnpm",
      args: ["run", "test:budgets"],
      environmentSensitive: true,
    };
    // The acceptance gate: no `expectedCostMs`, so the cheap gate catalog never
    // names it and a gate whose price is undeclared cannot be asserted cheap.
    const acceptance: GateDeclaration = {
      id: "acceptance:behaviors",
      stage: "base",
      required: true,
      run: () => ({ status: "PASS" }),
    };
    const preQaDeclarations = [typecheck, budgets, lint, acceptance];

    const selected = selectAuditedGateDeclarations(preQaDeclarations, [
      { id: "typecheck", required: true },
      { id: "lint", required: true },
      { id: "test:budgets", required: false },
    ]);

    // Declaration order, and the same objects — so the commands, args and
    // required flags that re-run are byte-identical to the ones that released
    // the pre-audit tree, not a second list that can drift from them.
    expect(selected.map((declaration) => declaration.id)).toEqual([
      "typecheck",
      "lint",
    ]);
    expect(selected[0]).toBe(typecheck);
    expect(selected[1]).toBe(lint);
    expect(selected).not.toContain(budgets);
    expect(selected).not.toContain(acceptance);
  });
});

/**
 * The audited gate re-run (#300 B-02, B-04, B-07, B-10).
 *
 * Three injected callbacks and no git process: the checkpoint is a literal, the
 * candidate registration is a spy, and the gate run is a real
 * `runCandidateGatePhase` over in-process declarations — real enough that the
 * pass path's `assertGateEvidenceReleasesEvaluation` and `verifyGateEvidence`
 * run against genuine evidence artifacts, which is the whole point of asserting
 * them additively on the audited tree.
 */
describe("verifyAuditedTree", () => {
  const AUDITED_TREE = "c".repeat(40);
  const AUDITED_COMMIT = "d".repeat(40);
  let evidenceRoot: string;

  beforeEach(() => {
    evidenceRoot = mkdtempSync(join(tmpdir(), "afk-audited-gates-"));
  });

  afterEach(() => {
    rmSync(evidenceRoot, { recursive: true, force: true });
  });

  function harness(statuses: readonly [string, "PASS" | "FAIL"][]) {
    const declarations: GateDeclaration[] = statuses.map(([id, status]) => ({
      id,
      stage: "base",
      required: true,
      run: () =>
        status === "FAIL"
          ? { status, failureKind: "COMMAND" as const }
          : { status },
    }));
    const order: string[] = [];
    const createCheckpoint = vi.fn((dir: string) => {
      order.push(`createCheckpoint:${dir}`);
      return { treeId: AUDITED_TREE, commitSha: AUDITED_COMMIT };
    });
    const onCandidateTree = vi.fn((treeId: string) => {
      order.push(`onCandidateTree:${treeId}`);
    });
    const runGates = vi.fn(
      async (input: {
        treeId: string;
        cwd: string;
        declarations: readonly GateDeclaration[];
      }) => {
        order.push("runGates");
        return runCandidateGatePhase({
          repoRoot: evidenceRoot,
          ghIssue: GH_ISSUE,
          sliceNumber: "02",
          tag: "s02",
          round: 1,
          treeId: input.treeId,
          cwd: input.cwd,
          evidenceDir: join(evidenceRoot, "gates"),
          declarations: input.declarations,
          label: "audited-tree cheap gates",
          infrastructureRetries: 0,
          inactivityTimeoutMs: 5_000,
          wallClockTimeoutMs: 10_000,
          heartbeatIntervalMs: 5_000,
          onGateOutcome: () => {},
          onInfrastructureRetry: () => {},
        });
      },
    );
    return {
      declarations,
      order,
      createCheckpoint,
      onCandidateTree,
      runGates,
      input: {
        repoRoot: evidenceRoot,
        checkpointDir: join(evidenceRoot, "checkpoint-audited"),
        evidenceDir: join(evidenceRoot, "gates"),
        declarations,
        createCheckpoint,
        onCandidateTree,
        runGates,
      },
    };
  }

  it("[behavior:#300:B-02] [behavior:#300:B-04] [behavior:#300:B-10] mints, registers, re-runs and grades the audited tree on a pass", async () => {
    const h = harness([
      ["typecheck", "PASS"],
      ["lint", "PASS"],
    ]);
    // The pre-audit object the audited one must not be built out of.
    const preAuditBaseGate = {
      evidence: {
        version: 3 as const,
        attemptId: "pre-audit",
        treeId: "a".repeat(40),
        results: [],
      },
      evidenceArtifactId: "gates/pre-audit.json",
      declarations: h.declarations,
      candidateTreeId: "a".repeat(40),
    };

    const result = await verifyAuditedTree(h.input);

    // Minted once, at the directory it was handed and nowhere else. Whether
    // *that* directory differs from the round's own is decided at the hub's call
    // site, not here — `createCandidateCheckpoint` throws when its target
    // already exists and the round's checkpoint stays registered until the
    // attempt's `finally` — so the distinctness is asserted where it can fail,
    // by the `[behavior:#300:B-02]` call-site scan in `src/orchestrator.test.ts`.
    expect(h.createCheckpoint).toHaveBeenCalledTimes(1);
    expect(h.createCheckpoint.mock.calls[0]![0]).toBe(h.input.checkpointDir);
    // Registered before the gates run, so the tree under grading is named on
    // this branch and on the failure branch alike (B-10).
    expect(h.onCandidateTree).toHaveBeenCalledTimes(1);
    expect(h.onCandidateTree).toHaveBeenCalledWith(AUDITED_TREE);
    expect(h.order.indexOf(`onCandidateTree:${AUDITED_TREE}`)).toBeLessThan(
      h.order.indexOf("runGates"),
    );
    // Exactly the selected declarations, by reference.
    expect(h.runGates).toHaveBeenCalledTimes(1);
    expect(h.runGates.mock.calls[0]![0]!.declarations).toBe(h.declarations);
    expect(h.runGates.mock.calls[0]![0]!.treeId).toBe(AUDITED_TREE);

    expect(result.outcome).toBe("PASS");
    if (result.outcome !== "PASS") throw new Error("expected PASS");
    expect(result.graded.treeId).toBe(AUDITED_TREE);
    expect(result.graded.commitSha).toBe(AUDITED_COMMIT);
    // Built fresh and naming the audited tree: never a spread of the pre-audit
    // object, which silently drops ADR 0012's skip authorization, and never that
    // object passed through, which would authorize a skip for a tree QA is not
    // grading.
    expect(result.graded.baseGate.candidateTreeId).toBe(AUDITED_TREE);
    expect(result.graded.baseGate.declarations).toBe(h.declarations);
    expect(result.graded.baseGate).not.toBe(preAuditBaseGate);
    expect(result.graded.baseGate.evidence).not.toBe(preAuditBaseGate.evidence);
    expect(result.graded.baseGate.evidenceArtifactId).not.toBe(
      preAuditBaseGate.evidenceArtifactId,
    );
    // Its own evidence, about its own tree.
    expect(result.graded.baseGate.evidence.treeId).toBe(AUDITED_TREE);
    expect(result.graded.baseGate.evidenceArtifactId).not.toContain("\\");
    expect(result.artifacts.length).toBeGreaterThan(0);
  });

  it("[behavior:#300:B-02] [behavior:#300:B-10] returns REPAIR naming the failed gate, having registered the audited tree", async () => {
    const h = harness([
      ["typecheck", "PASS"],
      ["lint", "FAIL"],
    ]);

    const result = await verifyAuditedTree(h.input);

    expect(result.outcome).toBe("REPAIR");
    if (result.outcome !== "REPAIR") throw new Error("expected REPAIR");
    expect(result.auditedTreeId).toBe(AUDITED_TREE);
    expect(result.failedGateIds).toEqual(["lint"]);
    expect(result.evidenceReferences.length).toBeGreaterThan(0);
    for (const reference of result.evidenceReferences) {
      expect(reference).not.toContain("\\");
    }
    // The audited tree is the attempt's current candidate on this branch too:
    // the terminal exit's `attemptTreeIds` and the post-QA gate phase's
    // `.slice(0, -1)` both assume the last entry is the tree under grading.
    expect(h.onCandidateTree).toHaveBeenCalledTimes(1);
    expect(h.onCandidateTree).toHaveBeenCalledWith(AUDITED_TREE);
    expect(h.order.indexOf(`onCandidateTree:${AUDITED_TREE}`)).toBeLessThan(
      h.order.indexOf("runGates"),
    );
  });

  it("[behavior:#300:B-07] takes no dispatch and cannot challenge the audited tree again", () => {
    // Line endings normalized, so the top-level closing brace is the same token
    // on Windows and on CI.
    const source = readFileSync(
      fileURLToPath(new URL("./self-audit.ts", import.meta.url)),
      "utf-8",
    ).replace(/\r\n/g, "\n");
    const bodyOf = (start: string) => {
      const at = source.indexOf(start);
      expect(at, start).toBeGreaterThan(-1);
      const end = source.indexOf("\n}\n", at);
      expect(end, `${start} close`).toBeGreaterThan(at);
      return source.slice(at, end);
    };

    // Bounded by construction rather than by a counter: there is no callback to
    // dispatch an agent with, so a second challenge is not something the type
    // permits — and `pnpm run typecheck` refuses one.
    const declaredInput = bodyOf(
      "export interface AuditedTreeVerificationInput {",
    );
    expect(declaredInput).not.toContain("dispatch");

    const body = bodyOf("export async function verifyAuditedTree(");
    expect(body).not.toContain("runSelfAuditStage(");
    expect(body).not.toContain("dispatch(");
  });
});

/**
 * The one graded-candidate binding (#300 B-08).
 *
 * A single value rather than four independent expressions, because the declared
 * risk is a divergence between consumers and a single value cannot diverge from
 * itself. Pure, so it is decided from literals.
 */
describe("resolveGradedCandidate", () => {
  const released = { treeId: "a".repeat(40), commitSha: "b".repeat(40) };
  const releasedBaseGate = { candidateTreeId: released.treeId, tag: "pre" };

  it("[behavior:#300:B-08] returns the audited triple on a pass and the released pair otherwise", () => {
    const audited = {
      treeId: "c".repeat(40),
      commitSha: "d".repeat(40),
      baseGate: { candidateTreeId: "c".repeat(40), tag: "audited" },
    };

    expect(
      resolveGradedCandidate({ released, releasedBaseGate, audited }),
    ).toEqual(audited);

    // `AUDIT_UNCHANGED`, `AUDIT_NOT_RUN`, a declined stage and an audited
    // `REPAIR` are four situations upstream but one input here — no audited
    // value — and they get the pre-audit pair with the pre-audit base-gate object
    // *by reference*, so nothing downstream can tell this apart from the run it
    // would have had before #300.
    const resolved = resolveGradedCandidate({
      released,
      releasedBaseGate,
      audited: undefined,
    });
    expect(resolved.treeId).toBe(released.treeId);
    expect(resolved.commitSha).toBe(released.commitSha);
    expect(resolved.baseGate).toBe(releasedBaseGate);
    // And an omitted member is the same input as an explicit `undefined`, which
    // is the shape the hub's non-changed paths actually pass.
    expect(resolveGradedCandidate({ released, releasedBaseGate })).toEqual(
      resolved,
    );
  });
});

/**
 * The verdict is a comparison of two tree identities, so it is decidable
 * without a repository — the shape of `decideFinalReuse`
 * (`src/final-evaluation.ts`).
 */
describe("classifySelfAuditVerdict", () => {
  const pre = "a".repeat(40);
  const post = "b".repeat(40);

  it("[behavior:#299:B-08] decides all three verdicts from tree identities alone", () => {
    expect(
      classifySelfAuditVerdict({
        preAuditTreeId: pre,
        postAuditTreeId: pre,
        invocation: { completed: true },
      }),
    ).toMatchObject({ verdict: "AUDIT_UNCHANGED", treeId: pre });

    // The audited tree id is the released one only here: this is the only case
    // in which the tree QA would grade is not the tree the gates released.
    expect(
      classifySelfAuditVerdict({
        preAuditTreeId: pre,
        postAuditTreeId: post,
        invocation: { completed: true },
      }),
    ).toMatchObject({ verdict: "AUDIT_CHANGED", treeId: post });

    // Both uncertain cases fall back on the pre-audit tree — the branch that
    // cannot loop (ADR 0041) — rather than on a guess about what the audit did.
    expect(
      classifySelfAuditVerdict({
        preAuditTreeId: pre,
        postAuditTreeId: post,
        invocation: { completed: false, detail: "idle timeout" },
      }),
    ).toMatchObject({ verdict: "AUDIT_NOT_RUN", treeId: pre });
    expect(
      classifySelfAuditVerdict({
        preAuditTreeId: pre,
        invocation: { completed: true },
      }),
    ).toMatchObject({ verdict: "AUDIT_NOT_RUN", treeId: pre });

    // The reason travels with the verdict, so a log line names which of the two
    // uncertain cases happened.
    expect(
      classifySelfAuditVerdict({
        preAuditTreeId: pre,
        invocation: { completed: false, detail: "idle timeout" },
      }).reason,
    ).toContain("idle timeout");
  });
});

describe("prompts/generator-audit.md", () => {
  const PROMPT_ARGS = {
    SLICE_DIR: SLICE_DIR,
    ACCEPTANCE_MANIFEST_FILE: "acceptance-manifest.json",
    CANDIDATE_TREE_ID: "e".repeat(40),
    CHANGE_SUMMARY: "commit 1234567 feat(self-audit): the stage (#299)",
  };

  it("[behavior:#299:B-07] states the four obligations and that an unchanged resubmission is legitimate", () => {
    const prompt = renderPrompt("generator-audit", PROMPT_ARGS);

    // The whole point of the separate invocation: the round is not pressured
    // into cosmetic churn to look diligent.
    expect(prompt).toContain(
      "Resubmitting this candidate unchanged is a legitimate",
    );
    expect(prompt).toContain("An audit that finds nothing has done its job");
    // The four obligations, in order.
    for (const obligation of [
      "Re-read the locked contract.",
      "Trace every done-criterion to code.",
      "Trace every done-criterion to test evidence.",
      "Examine the boundaries and the failure cases.",
    ]) {
      expect(prompt, obligation).toContain(obligation);
    }
    // A commit is the exception, not the deliverable.
    expect(prompt).toContain("Commit only if the audit found a gap");
    expect(prompt).toContain("write nothing and commit nothing");
    // Writes are confined to the audit's own worktree.
    expect(prompt).toContain("You are in the slice's own worktree");
    expect(prompt).toContain("and nowhere else");
    expect(prompt).toContain("do not widen the boundary on your own authority");

    // Every substitution reached the output and nothing was left unrendered.
    for (const [key, value] of Object.entries(PROMPT_ARGS)) {
      expect(prompt, key).toContain(value);
      expect(prompt, key).not.toContain(`{{${key}}}`);
    }
    expect(prompt).not.toMatch(/\{\{[A-Za-z_]/);
    // The audit re-runs the verification the candidate already ran; it is not
    // handed a command to run, so the generator templates' one placeholder is
    // absent here by design.
    expect(prompt).not.toContain("TEST_COMMAND");
  });
});

describe("docs/adr/0069-bounded-generator-self-audit-before-qa-dispatch.md", () => {
  it("[behavior:#299:B-11] records the mechanism, its provenance and the one-invocation bound", () => {
    const adr = readFileSync(
      fileURLToPath(
        new URL(
          "../docs/adr/0069-bounded-generator-self-audit-before-qa-dispatch.md",
          import.meta.url,
        ),
      ),
      "utf-8",
    );

    // The repository's ADR structure.
    expect(adr).toMatch(/^# 0069 — /);
    expect(adr).toContain("**Status:** Accepted");
    expect(adr).toContain("**Date:**");
    expect(adr).toContain("## Decision");
    expect(adr).toContain("## Consequences");

    // Provenance: the idea of a second dispatch is SwarmForge's.
    expect(adr).toContain("swarm-forge");
    expect(adr).toContain("swarm_handoff.sh");

    // The mechanism is a tree comparison across one re-dispatch, not an
    // agent-certified claim.
    expect(adr).toContain("resolveCandidateTreeId");
    expect(adr).toContain("AUDIT_UNCHANGED");
    expect(adr).toContain("AUDIT_CHANGED");
    expect(adr).toContain("AUDIT_NOT_RUN");
    expect(adr).toMatch(/exactly one\*{0,2} generator re-dispatch/);

    // And the bound is the standing argument against an audit-of-the-audit.
    // #301 B-12 amended what the bound counts — completed invocations, so an
    // infrastructure retry replaces a dead one — and the bound itself, one per
    // QA submission, is the part that has to survive that amendment.
    expect(adr).toContain("One **completed** invocation per QA submission");
    expect(adr).toContain("audit-of-the-audit");
  });

  it("[behavior:#300:B-11] records the changed-tree mechanism, the single graded candidate and its ADR 0012 reason", () => {
    const adr = readFileSync(
      fileURLToPath(
        new URL(
          "../docs/adr/0069-bounded-generator-self-audit-before-qa-dispatch.md",
          import.meta.url,
        ),
      ),
      "utf-8",
    );

    // Amended in place: the decision, its narrative, its provenance and its
    // one-invocation bound keep their present text.
    expect(adr).toContain("## Decision");
    expect(adr).toContain("## Consequences");
    expect(adr).toContain("swarm_handoff.sh");
    // The bound survives #301 B-12's amendment of what it counts.
    expect(adr).toContain("invocation per QA submission");
    expect(adr).toMatch(/exactly one\*{0,2} generator re-dispatch/);

    // The changed-tree mechanism: a catalog-derived cheap-gate re-run on the
    // audited tree.
    expect(adr).toContain("cheap gate catalog");
    expect(adr).toContain("run a second time, on the audited tree");
    // One graded-candidate identity, and the tree-authority reason it is one
    // value rather than four expressions.
    expect(adr).toContain("graded-candidate identity");
    expect(adr).toContain("qaApprovedTreeId");
    expect(adr).toContain("ADR 0012");
    expect(adr).toContain("a single value cannot diverge from itself");
    // And an audited failure is an ordinary repair round, not a new path.
    expect(adr).toContain("ordinary repair round");

    // The superseded sentence is gone: an `AUDIT_CHANGED` verdict now decides
    // which tree QA grades.
    expect(adr).not.toContain("changes nothing downstream");
  });
});

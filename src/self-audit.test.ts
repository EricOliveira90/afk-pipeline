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
import {
  RUN_STATE_VERSION,
  loadRunState,
  saveRunState,
  selfAuditsFor,
} from "./run-state.js";
import {
  classifySelfAuditVerdict,
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
  }) {
    return {
      repoRoot: stateRoot,
      prdSlug: PRD_SLUG,
      ghIssue: GH_ISSUE,
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
    // Only AUDIT_UNCHANGED is persisted in this slice; the dead-invocation
    // taxonomy is #301's.
    expect(selfAuditsFor(loadRunState(stateRoot, PRD_SLUG), GH_ISSUE)).toEqual(
      [],
    );
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
      },
    ]);
    expect(recorded[0]!.candidateTreeId).not.toBe(recorded[0]!.auditedTreeId);
  });

  it("[behavior:#300:P-01] leaves the declined and unchanged paths exactly as they are", async () => {
    const declinedDispatch = vi.fn(async () => {});
    // A `createCheckpoint` of the shape `verifyAuditedTree` is handed: no
    // audited checkpoint is minted on either of these paths, so the changed-tree
    // machinery costs a default run nothing.
    const createCheckpoint = vi.fn((dir: string) => ({
      treeId: dir,
      commitSha: dir,
    }));

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
      },
    ]);
    // Neither path mints an audited checkpoint or runs an extra gate, so
    // `resolveGradedCandidate` is handed no audited value and yields the
    // pre-audit pair.
    expect(createCheckpoint).toHaveBeenCalledTimes(0);
    const released = { treeId: releasedTree, commitSha: "c".repeat(40) };
    const releasedBaseGate = { candidateTreeId: releasedTree };
    expect(
      resolveGradedCandidate({ released, releasedBaseGate }),
    ).toEqual({ ...released, baseGate: releasedBaseGate });
  });

  it("[behavior:#300:P-03] records the changed verdict at schema v7 with no new field", async () => {
    // No schema change, no migration, no version bump: the entry the changed
    // tree writes uses the shape slice 1 landed, and nothing else.
    expect(RUN_STATE_VERSION).toBe(7);

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
    expect(state.version).toBe(7);
    const recorded = selfAuditsFor(state, GH_ISSUE);
    expect(recorded).toHaveLength(1);
    expect(Object.keys(recorded[0]!).sort()).toEqual([
      "auditedTreeId",
      "candidateTreeId",
      "verdict",
    ]);
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
  /** The round's own checkpoint directory: the audited mint may not reuse it. */
  const ROUND_CHECKPOINT_DIR = "/afk/checkpoints/round-1";
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

    // A path of its own: `createCandidateCheckpoint` throws when its target
    // already exists, and the round's checkpoint is still registered.
    expect(h.createCheckpoint).toHaveBeenCalledTimes(1);
    expect(h.createCheckpoint.mock.calls[0]![0]).not.toBe(ROUND_CHECKPOINT_DIR);
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
    // `REPAIR` are all this case, and all of them get the pre-audit pair — and
    // the pre-audit base-gate object *by reference*, so nothing downstream can
    // tell this apart from the run it would have had before #300.
    for (const value of [undefined]) {
      const resolved = resolveGradedCandidate({
        released,
        releasedBaseGate,
        audited: value,
      });
      expect(resolved.treeId).toBe(released.treeId);
      expect(resolved.commitSha).toBe(released.commitSha);
      expect(resolved.baseGate).toBe(releasedBaseGate);
    }
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
    expect(adr).toContain("One invocation per QA submission");
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
    expect(adr).toContain("One invocation per QA submission");
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

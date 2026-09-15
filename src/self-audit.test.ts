import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveCandidateTreeId } from "./gate-runner.js";
import { renderPrompt } from "./prompt-template.js";
import {
  RUN_STATE_VERSION,
  loadRunState,
  saveRunState,
  selfAuditsFor,
} from "./run-state.js";
import {
  classifySelfAuditVerdict,
  runSelfAuditStage,
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

  it("[behavior:#299:B-09] reports AUDIT_CHANGED when the audit rewrote the tree", async () => {
    const result = await runSelfAuditStage(
      stageInput({
        selfAudit: true,
        dispatch: async () => {
          writeFileSync(
            join(worktree, "src", "work.ts"),
            "export const v = 2;\n",
          );
          git(worktree, ["add", "-A"]);
          git(worktree, ["commit", "-m", "fix: the audit found a gap (#299)"]);
        },
      }),
    );

    expect(result.ran).toBe(true);
    expect(result).toMatchObject({ verdict: "AUDIT_CHANGED" });
    expect(result).not.toMatchObject({ treeId: releasedTree });
    // A tree the audit rewrote has not been through the required cheap gates,
    // so nothing downstream changes in this slice and nothing is persisted for
    // it either (#300 owns the changed-tree path).
    expect(selfAuditsFor(loadRunState(stateRoot, PRD_SLUG), GH_ISSUE)).toEqual(
      [],
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
    expect(adr).toContain("One invocation per QA submission");
    expect(adr).toContain("audit-of-the-audit");
  });
});

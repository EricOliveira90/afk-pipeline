/**
 * The `feedback-integrity` gate, as a unit against real git trees. No pipeline
 * is spawned: the gate's whole verdict is a comparison of a worktree against a
 * ref, so a fixture repo with one commit and one working-tree edit exercises
 * every branch it has (`CLAUDE.md`, "Where a new assertion goes").
 */
import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ProtectedChangeWaiver } from "./afk-manifest.js";
import type { GatePolicy } from "./gate-policy.js";
import type { GateEvidence } from "./gate-runner.js";
import {
  appliedWaiversFrom,
  feedbackIntegrityGateDeclaration,
  runFeedbackIntegrityGate,
  FEEDBACK_INTEGRITY_GATE_ID,
  FEEDBACK_INTEGRITY_GATE_STAGE,
} from "./feedback-integrity-gate.js";

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

function write(repo: string, path: string, contents: string): void {
  const absolute = join(repo, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents, "utf-8");
}

/** A repo whose base commit carries a gate-policy file and one test file. */
function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "afk-feedback-integrity-"));
  tempDirs.push(repo);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "afk@example.com"]);
  git(repo, ["config", "user.name", "AFK"]);
  write(repo, "afk.config.json", `${JSON.stringify({}, null, 2)}\n`);
  write(repo, "src/foo.ts", "export const foo = 1;\n");
  write(
    repo,
    "src/foo.test.ts",
    'import { it, expect } from "vitest";\nit("foo", () => expect(1).toBe(1));\n',
  );
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "base"]);
  return repo;
}

function runOn(
  repo: string,
  overrides: {
    waivers?: readonly ProtectedChangeWaiver[];
    policy?: GatePolicy | null;
    acceptedPairIntact?: boolean;
    featureRef?: string;
  } = {},
) {
  return runFeedbackIntegrityGate({
    worktreeDir: repo,
    featureRef: overrides.featureRef ?? "main",
    waivers: overrides.waivers ?? [],
    policy: overrides.policy ?? null,
    acceptedPairIntact: overrides.acceptedPairIntact ?? true,
  });
}

function policyWith(riskClasses: GatePolicy["riskClasses"]): GatePolicy {
  return {
    version: 1,
    protectedPaths: {
      gatePolicyPaths: ["afk.config.json", "suite-budgets.json"],
      testGlobs: ["**/*.test.ts"],
    },
    riskClasses,
  };
}

describe("feedback-integrity gate", () => {
  it("[behavior:B-03] declares itself through the in-process run seam", () => {
    const repo = makeRepo();
    const declaration = feedbackIntegrityGateDeclaration({
      worktreeDir: repo,
      featureRef: "main",
      waivers: [],
      policy: null,
      acceptedPairIntact: true,
    });
    expect(declaration.id).toBe(FEEDBACK_INTEGRITY_GATE_ID);
    expect(FEEDBACK_INTEGRITY_GATE_ID).toBe("feedback-integrity");
    expect(declaration.stage).toBe(FEEDBACK_INTEGRITY_GATE_STAGE);
    expect(FEEDBACK_INTEGRITY_GATE_STAGE).toBe("deterministic");
    expect(declaration.required).toBe(true);
    // A content-derived status cannot come from `classifyExecution`, so this
    // declaration carries `run` and no command at all (D22).
    expect(declaration.command).toBeUndefined();
    expect(declaration.run).toBeTypeOf("function");
    expect(declaration.run!({ treeId: "unused", cwd: repo })).toMatchObject({
      status: "PASS",
    });
  });

  it("[behavior:B-03] fails on a changed gate-policy path, naming the four waiver fields", () => {
    const repo = makeRepo();
    write(repo, "afk.config.json", `${JSON.stringify({ note: "widened" })}\n`);

    const outcome = runOn(repo);

    expect(outcome).toMatchObject({ status: "FAIL", failureKind: "COMMAND" });
    expect(outcome.findings?.protectedChanges).toEqual(["afk.config.json"]);
    expect(outcome.detail).toContain("gate-policy");
    for (const field of ["riskClass", "path", "author", "reason"]) {
      expect(outcome.detail).toContain(field);
    }
    expect(outcome.detail).toContain("afk.json");
  });

  it("[behavior:B-03] treats a declared fileScope as no authorization at all", () => {
    // The gate never reads the contract: a file scope is what an agent
    // negotiated, and this is the change a human has to sign off on.
    const repo = makeRepo();
    write(
      repo,
      ".kiro/specs/demo/slices/01/acceptance-manifest.json",
      JSON.stringify({
        version: 2,
        fileScope: { kind: "paths", paths: ["afk.config.json"] },
        migrationCount: 0,
        behaviors: [],
      }),
    );
    write(repo, "afk.config.json", `${JSON.stringify({ note: "widened" })}\n`);

    const outcome = runOn(repo);

    expect(outcome.status).toBe("FAIL");
    expect(outcome.findings?.protectedChanges).toContain("afk.config.json");
    expect(outcome.detail).toContain("fileScope is not authorization");
  });

  it("[behavior:B-03] reports INFRASTRUCTURE when the changed-set probe cannot answer", () => {
    const repo = makeRepo();
    write(repo, "afk.config.json", `${JSON.stringify({ note: "widened" })}\n`);

    const outcome = runOn(repo, { featureRef: "refs/heads/no-such-branch" });

    // Never an empty violation list: the tree really did change a protected
    // path, and a green verdict here would hide it.
    expect(outcome).toMatchObject({ status: "INFRASTRUCTURE" });
    expect(outcome.findings?.protectedChanges).toBeUndefined();
  });

  it("[behavior:B-04] fails on a deleted test file, and not on a deleted source file", () => {
    const repo = makeRepo();
    rmSync(join(repo, "src/foo.test.ts"));

    const outcome = runOn(repo);

    expect(outcome).toMatchObject({ status: "FAIL", failureKind: "COMMAND" });
    expect(outcome.findings?.deletedTests).toEqual(["src/foo.test.ts"]);

    // A deleted non-test file is ordinary work; only the file-scope gate has
    // anything to say about it.
    const other = makeRepo();
    rmSync(join(other, "src/foo.ts"));
    expect(runOn(other)).toMatchObject({ status: "PASS", failureKind: null });
  });

  it("[behavior:B-05] applies a covering launch waiver and passes, recording its four fields", () => {
    const repo = makeRepo();
    rmSync(join(repo, "src/foo.test.ts"));
    const waiver: ProtectedChangeWaiver = {
      riskClass: "deleted-test",
      path: "src/foo.test.ts",
      author: "eric",
      reason: "the module it covered was deleted with it",
    };

    const outcome = runOn(repo, { waivers: [waiver] });

    expect(outcome).toMatchObject({ status: "PASS", failureKind: null });
    expect(outcome.findings?.appliedWaivers).toEqual([waiver]);
    expect(outcome.findings?.deletedTests).toBeUndefined();
  });

  it("[behavior:B-05] does not let a waiver for one risk class cover another", () => {
    const repo = makeRepo();
    rmSync(join(repo, "src/foo.test.ts"));

    const outcome = runOn(repo, {
      waivers: [
        {
          riskClass: "gate-policy",
          path: "src/foo.test.ts",
          author: "eric",
          reason: "wrong class for this detection",
        },
      ],
    });

    expect(outcome.status).toBe("FAIL");
    expect(outcome.findings?.deletedTests).toEqual(["src/foo.test.ts"]);
    expect(outcome.findings?.appliedWaivers).toBeUndefined();
  });

  it("[behavior:B-06] ignores a waiver the candidate worktree authored for itself", () => {
    const repo = makeRepo();
    rmSync(join(repo, "src/foo.test.ts"));
    // The candidate writes itself an exemption. The gate is handed the launch
    // manifest's waivers, which hold none, so this file is just a file.
    write(
      repo,
      "afk.json",
      JSON.stringify({
        version: 1,
        selectedSlices: ["01"],
        protectedChangeWaivers: [
          {
            riskClass: "deleted-test",
            path: "src/foo.test.ts",
            author: "the candidate",
            reason: "self-authorized",
          },
        ],
      }),
    );

    const outcome = runOn(repo, { waivers: [] });

    expect(outcome.status).toBe("FAIL");
    expect(outcome.findings?.deletedTests).toEqual(["src/foo.test.ts"]);
    expect(outcome.findings?.appliedWaivers ?? []).toEqual([]);
  });

  it("[behavior:B-07] enforces only the risk classes gatePolicy.riskClasses declares", () => {
    const repo = makeRepo();
    rmSync(join(repo, "src/foo.test.ts"));

    const omitted = runOn(repo, { policy: policyWith(["gate-policy"]) });
    expect(omitted).toMatchObject({ status: "PASS", failureKind: null });
    expect(omitted.detail).toContain("Not enforced by policy");
    expect(omitted.detail).toContain("deleted-test");

    const declared = runOn(repo, {
      policy: policyWith(["gate-policy", "deleted-test", "skipped-test"]),
    });
    expect(declared.status).toBe("FAIL");
    expect(declared.findings?.deletedTests).toEqual(["src/foo.test.ts"]);
  });

  it("[behavior:B-08] fails closed on a mutated accepted pair, which no waiver exempts", () => {
    const repo = makeRepo();

    const bare = runOn(repo, { acceptedPairIntact: false });
    expect(bare).toMatchObject({ status: "FAIL", failureKind: "COMMAND" });
    expect(bare.findings?.protectedChanges).toEqual([
      "contract.md",
      "acceptance-manifest.json",
    ]);

    // A waiver naming the lock itself changes nothing: an agent-authored lock
    // change is the posture D5 refuses outright.
    const waived = runOn(repo, {
      acceptedPairIntact: false,
      waivers: [
        {
          riskClass: "gate-policy",
          path: "contract.md",
          author: "eric",
          reason: "tried to waive the lock",
        },
        {
          riskClass: "gate-policy",
          path: "acceptance-manifest.json",
          author: "eric",
          reason: "tried to waive the lock",
        },
      ],
    });
    expect(waived.status).toBe("FAIL");
    expect(waived.findings?.protectedChanges).toEqual([
      "contract.md",
      "acceptance-manifest.json",
    ]);
    expect(waived.findings?.appliedWaivers).toBeUndefined();
    expect(waived.detail).toContain("no waiver may exempt it");
  });

  it("[behavior:B-12] collects every applied waiver from written gate evidence once", () => {
    const waiver = {
      riskClass: "deleted-test" as const,
      path: "src/foo.test.ts",
      author: "eric",
      reason: "the module it covered was deleted with it",
    };
    const evidence = {
      version: 3,
      attemptId: "a1",
      treeId: "t1",
      results: [
        {
          gateId: "scope",
          stage: "deterministic",
          status: "PASS",
          failureKind: null,
          startedAt: "2026-09-09T00:00:00.000Z",
          endedAt: "2026-09-09T00:00:00.000Z",
          durationMs: 0,
          exitCode: null,
          treeId: "t1",
          logArtifactId: "gate-logs/scope.log",
        },
        {
          gateId: "feedback-integrity",
          stage: "deterministic",
          status: "PASS",
          failureKind: null,
          startedAt: "2026-09-09T00:00:00.000Z",
          endedAt: "2026-09-09T00:00:00.000Z",
          durationMs: 0,
          exitCode: null,
          treeId: "t1",
          logArtifactId: "gate-logs/feedback-integrity.log",
          findings: { appliedWaivers: [waiver] },
        },
        {
          // The same waiver reported by a second gate is one applied waiver,
          // not two: `tests:skipped` records the same launch authorization.
          gateId: "tests:skipped",
          stage: "deterministic",
          status: "PASS",
          failureKind: null,
          startedAt: "2026-09-09T00:00:00.000Z",
          endedAt: "2026-09-09T00:00:00.000Z",
          durationMs: 0,
          exitCode: null,
          treeId: "t1",
          logArtifactId: "gate-logs/tests-skipped.log",
          findings: { appliedWaivers: [waiver] },
        },
      ],
    } as unknown as GateEvidence;

    expect(appliedWaiversFrom(evidence)).toEqual([waiver]);
    // Evidence with no findings at all is not an error; it is a run nobody
    // waived anything for.
    expect(
      appliedWaiversFrom({
        version: 3,
        attemptId: "a1",
        treeId: "t1",
        results: [],
      } as unknown as GateEvidence),
    ).toEqual([]);
  });
});

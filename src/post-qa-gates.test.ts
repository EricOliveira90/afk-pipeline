import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveCandidateTreeId } from "./gate-runner.js";
import { reviewArtifactViolations, runPostQAGates } from "./post-qa-gates.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

/**
 * Unit-level proof of the A1 tree-authority allowlist (guardian round 2):
 * the QA verdict authorizes exactly one captured tree, and the only drift a
 * later step may accept is inside the slice's review-artifact directory.
 */
describe("reviewArtifactViolations (architect A1 tree authority)", () => {
  let repo: string;
  const sliceDir = "specs/demo/slices/01-fixture";
  /** Directories outside the worktree, so nothing a run writes drifts its tree. */
  const hosts: string[] = [];

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "afk-tree-authority-"));
    git(repo, ["init", "--initial-branch=main"]);
    git(repo, ["config", "user.email", "t@t"]);
    git(repo, ["config", "user.name", "t"]);
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(join(repo, sliceDir), { recursive: true });
    writeFileSync(join(repo, "src", "work.ts"), "export const v = 1;\n");
    writeFileSync(join(repo, sliceDir, "contract.md"), "# Contract\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", "base"]);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    for (const host of hosts.splice(0)) {
      rmSync(host, { recursive: true, force: true });
    }
  });

  it("returns nothing for the identical tree", () => {
    const tree = resolveCandidateTreeId(repo);
    expect(
      reviewArtifactViolations({
        cwd: repo,
        fromTree: tree,
        toTree: tree,
        reviewArtifactDir: sliceDir,
      }),
    ).toEqual([]);
  });

  it("accepts drift confined to the expected QA-window artifacts", () => {
    const qaApproved = resolveCandidateTreeId(repo);
    // The evaluator legitimately writes its canonical report and review;
    // the orchestrator archives round-stamped reports and restores the
    // operator's diagnosis.
    writeFileSync(join(repo, sliceDir, "qa-report.md"), "PASS\n");
    writeFileSync(join(repo, sliceDir, "qa-review.json"), "{}\n");
    writeFileSync(join(repo, sliceDir, "uat-report-r2-a1.md"), "PASS\n");
    writeFileSync(join(repo, sliceDir, "qa-report-r1-a1.md"), "PASS\n");
    writeFileSync(join(repo, sliceDir, "stuck.md"), "# restored\n");
    const postQa = resolveCandidateTreeId(repo);
    expect(postQa).not.toBe(qaApproved);
    expect(
      reviewArtifactViolations({
        cwd: repo,
        fromTree: qaApproved,
        toTree: postQa,
        reviewArtifactDir: sliceDir,
      }),
    ).toEqual([]);
  });

  it("rejects an edit to the locked contract or manifest inside the slice dir", () => {
    // Guardian round 3, architect A1: the slice directory holds
    // authority-bearing inputs, so the allowlist is exact artifacts,
    // not the directory.
    const qaApproved = resolveCandidateTreeId(repo);
    writeFileSync(join(repo, sliceDir, "qa-report.md"), "PASS\n");
    writeFileSync(join(repo, sliceDir, "contract.md"), "# Tampered\n");
    writeFileSync(join(repo, sliceDir, "acceptance-manifest.json"), "{}\n");
    writeFileSync(join(repo, sliceDir, "handoff.md"), "planted\n");
    mkdirSync(join(repo, sliceDir, "nested"), { recursive: true });
    writeFileSync(join(repo, sliceDir, "nested", "qa-report.md"), "x\n");
    const postQa = resolveCandidateTreeId(repo);
    expect(
      reviewArtifactViolations({
        cwd: repo,
        fromTree: qaApproved,
        toTree: postQa,
        reviewArtifactDir: sliceDir,
      }),
    ).toEqual([
      `${sliceDir}/acceptance-manifest.json`,
      `${sliceDir}/contract.md`,
      `${sliceDir}/handoff.md`,
      `${sliceDir}/nested/qa-report.md`,
    ]);
  });

  it("admits the accepted pair only at the exact orchestrator-recorded bytes", () => {
    // An applied scope amendment is the one audited orchestrator write
    // that changes the accepted pair inside the QA window — and the
    // authority is byte provenance, not a path waiver: the guard admits
    // the recorded blob and nothing else (guardian round 4, architect A1).
    const qaApproved = resolveCandidateTreeId(repo);
    writeFileSync(join(repo, sliceDir, "contract.md"), "# Amended\n");
    writeFileSync(
      join(repo, sliceDir, "acceptance-manifest.json"),
      '{"amended":true}\n',
    );
    // The orchestrator records the blob IDs immediately after its write.
    const recordedBlobs = Object.fromEntries(
      ["contract.md", "acceptance-manifest.json"].map((name) => [
        `${sliceDir}/${name}`,
        git(repo, [
          "hash-object",
          "--path",
          `${sliceDir}/${name}`,
          "--",
          `${sliceDir}/${name}`,
        ]),
      ]),
    );
    const postQa = resolveCandidateTreeId(repo);
    expect(
      reviewArtifactViolations({
        cwd: repo,
        fromTree: qaApproved,
        toTree: postQa,
        reviewArtifactDir: sliceDir,
        orchestratorAuthorizedBlobs: recordedBlobs,
      }),
    ).toEqual([]);

    // A later edit — e.g. an evaluator rewriting the contract during the
    // post-amendment re-grade — no longer matches the recorded blob and
    // voids the authority.
    writeFileSync(
      join(repo, sliceDir, "contract.md"),
      "# Amended, then tampered\n",
    );
    const tampered = resolveCandidateTreeId(repo);
    expect(
      reviewArtifactViolations({
        cwd: repo,
        fromTree: qaApproved,
        toTree: tampered,
        reviewArtifactDir: sliceDir,
        orchestratorAuthorizedBlobs: recordedBlobs,
      }),
    ).toEqual([`${sliceDir}/contract.md`]);
  });

  it("names every path drifting outside the slice directory, fail-closed input", () => {
    const qaApproved = resolveCandidateTreeId(repo);
    // An evaluator source edit alongside a legitimate review artifact.
    writeFileSync(join(repo, sliceDir, "qa-report-r1-a1.md"), "PASS\n");
    writeFileSync(join(repo, "src", "work.ts"), "export const v = 2;\n");
    writeFileSync(join(repo, "src", "evil.ts"), "export const e = 1;\n");
    const postQa = resolveCandidateTreeId(repo);
    expect(
      reviewArtifactViolations({
        cwd: repo,
        fromTree: qaApproved,
        toTree: postQa,
        reviewArtifactDir: sliceDir,
      }),
    ).toEqual(["src/evil.ts", "src/work.ts"]);
  });

  it("does not let a sibling directory sharing the prefix string pass", () => {
    const qaApproved = resolveCandidateTreeId(repo);
    mkdirSync(join(repo, `${sliceDir}-evil`), { recursive: true });
    writeFileSync(join(repo, `${sliceDir}-evil`, "x.ts"), "1\n");
    const postQa = resolveCandidateTreeId(repo);
    expect(
      reviewArtifactViolations({
        cwd: repo,
        fromTree: qaApproved,
        toTree: postQa,
        reviewArtifactDir: sliceDir,
      }),
    ).toEqual([`${sliceDir}-evil/x.ts`]);
  });

  it("[behavior:B-03] forwards the gate cache to the full-suite phase, which reuses a PASS for the same tree", async () => {
    // The post-QA phase is where reuse pays: the pre-QA phase already ran the
    // cheap gates on this exact tree, so the suite is the one gate whose
    // second run can be skipped. The pass-through is asserted end to end
    // because a forwarded-or-not argument is exactly the kind of wiring a unit
    // stub cannot prove.
    // Everything this run writes lives outside the worktree: a marker or an
    // evidence file inside it would itself be post-QA tree drift.
    const host = mkdtempSync(join(tmpdir(), "afk-post-qa-cache-"));
    hosts.push(host);
    const marker = join(host, "ran.txt");
    const cache = { path: join(host, "gate-cache.json"), enabled: true };
    const qaApprovedTreeId = resolveCandidateTreeId(repo);
    const outcomes: { gateId: string; cacheReused?: boolean }[] = [];
    async function run(round: number) {
      return runPostQAGates({
        repoRoot: host,
        worktreeDir: repo,
        prdSlug: "demo",
        ghIssue: "86",
        sliceNumber: "05",
        tag: "s05",
        round,
        evidenceDir: join(host, "evidence", String(round)),
        declarations: [
          {
            id: "tests",
            stage: "base",
            required: true,
            command: process.execPath,
            args: [
              "-e",
              `require("fs").appendFileSync(${JSON.stringify(marker)}, "x")`,
            ],
          },
        ],
        cache,
        infrastructureRetries: 0,
        inactivityTimeoutMs: 15_000,
        wallClockTimeoutMs: 30_000,
        heartbeatIntervalMs: 20,
        priorAttemptTreeIds: [],
        priorArtifacts: [],
        qaApprovedTreeId,
        reviewArtifactDir: sliceDir,
        onGateOutcome: (outcome) => outcomes.push(outcome),
        onInfrastructureRetry: () => {},
        onCleanupWarning: () => {},
      });
    }

    const first = await run(1);
    expect(first.action).toBe("PASS");
    expect(outcomes.at(-1)?.cacheReused).toBeUndefined();
    expect(readFileSync(marker, "utf-8")).toBe("x");

    const second = await run(2);
    expect(second.action).toBe("PASS");
    expect(outcomes.at(-1)).toMatchObject({
      gateId: "tests",
      cacheReused: true,
    });
    // The suite command never ran a second time.
    expect(readFileSync(marker, "utf-8")).toBe("x");
  }, 60_000);
});

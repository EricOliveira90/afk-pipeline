import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TransientProviderError } from "./agent-provider.js";
import {
  DEFAULT_EVAL_DEPS,
  type EvalCliDeps,
  runEvalCli,
} from "./eval-command.js";
import { EVAL_ROLES, type EvalRole } from "./eval-pack.js";
import { readEvalReport } from "./eval-report.js";
import {
  EVAL_ROLE_EXPECTED,
  EVAL_ROLE_MATCHING_ARTIFACT,
  type EvalStubBehavior,
  buildEvalStubProvider,
  evalCaseDocument,
  writeEvalContractReview,
  writeEvalPackDir,
  writeEvalQAReview,
} from "./eval.fixtures.js";
import { rmDirWithRetry } from "./test-support.js";

/** A fixed clock, so the run directory name and the report timestamps are
 * deterministic: `eval-20260912-100000`. */
const FROZEN = new Date("2026-09-12T10:00:00.000Z");
const RUN_DIR_NAME = "eval-20260912-100000";

describe("runEvalCli", () => {
  const tempDirs: string[] = [];
  const scratchDirs: string[] = [];

  /** A repo root of its own, so the default `--out` writes nowhere real. */
  const repoRoot = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "afk-eval-repo-"));
    tempDirs.push(dir);
    return dir;
  };
  const pack = (files: Record<string, unknown>): string => {
    const dir = writeEvalPackDir(files);
    tempDirs.push(dir);
    return dir;
  };
  /** The production seams, with every scratch directory tracked for cleanup. */
  const deps = (overrides: Partial<EvalCliDeps> = {}): EvalCliDeps & {
    lines: string[];
  } => {
    const lines: string[] = [];
    return {
      lines,
      now: () => FROZEN,
      mkScratchDir: (id) => {
        const dir = DEFAULT_EVAL_DEPS.mkScratchDir(id);
        scratchDirs.push(dir);
        return dir;
      },
      stdout: (line) => {
        lines.push(line);
      },
      ...overrides,
    };
  };

  afterEach(() => {
    for (const dir of scratchDirs.splice(0)) rmDirWithRetry(dir);
    for (const dir of tempDirs.splice(0)) rmDirWithRetry(dir);
  });

  const rolePack = (role: EvalRole): string =>
    pack({
      "01-case.json": evalCaseDocument({
        id: `${role}-case`,
        role,
        expected: EVAL_ROLE_EXPECTED[role],
      }),
    });

  it("B-26 defaults --out to <repoRoot>/.afk/eval and creates one eval-<timestamp> directory per run", async () => {
    const root = repoRoot();
    const { provider } = buildEvalStubProvider([
      { write: EVAL_ROLE_MATCHING_ARTIFACT["evaluator-contract"] },
    ]);

    const result = await runEvalCli(
      ["--pack", rolePack("evaluator-contract")],
      root,
      provider,
      deps(),
    );

    expect(result.exitCode).toBe(0);
    const runDir = join(root, ".afk", "eval", RUN_DIR_NAME);
    expect(existsSync(join(runDir, "report.json"))).toBe(true);
    expect(result.output).toContain(join(runDir, "report.json"));
  });

  it("B-26 honours an explicit --out directory", async () => {
    const out = repoRoot();
    const { provider } = buildEvalStubProvider([
      { write: EVAL_ROLE_MATCHING_ARTIFACT["evaluator-contract"] },
    ]);

    const result = await runEvalCli(
      ["--pack", rolePack("evaluator-contract"), "--out", out],
      repoRoot(),
      provider,
      deps(),
    );

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(out, RUN_DIR_NAME, "report.json"))).toBe(true);
  });

  it("B-09 dispatches each role with the D9 InvokeOptions, a prompt, a cwd and a log stream", async () => {
    for (const role of EVAL_ROLES) {
      const root = repoRoot();
      const { provider, calls } = buildEvalStubProvider([
        { write: EVAL_ROLE_MATCHING_ARTIFACT[role] },
      ]);

      const result = await runEvalCli(
        ["--pack", rolePack(role)],
        root,
        provider,
        deps(),
      );

      expect(result.exitCode).toBe(0);
      const call = calls[0];
      expect(call).toBeDefined();
      const options = call?.options as unknown as Record<string, unknown>;
      const guardian = role === "pm" || role === "architect";
      expect(options.role).toBe(guardian ? `${role}-review` : role);
      expect(options.agent).toBe(guardian ? `${role}-review` : undefined);
      expect(options.bare).toBe(guardian ? true : undefined);
      expect(options.prompt).toBe(
        "Review the locked contract and write contract-review.json.",
      );
      expect(options.cwd).toBe(call?.cwd);
      expect(options.logStream).toBeDefined();
      // One `<case-id>.log` per dispatched case, in the run directory.
      const runDir = join(root, ".afk", "eval", RUN_DIR_NAME);
      expect(readdirSync(runDir).sort()).toEqual([
        `${role}-case.log`,
        "report.json",
      ]);
    }
  });

  it("B-08 seeds the scratch directory from files only, and B-17 keeps it after a MISMATCH", async () => {
    const packDir = pack({
      "01-case.json": evalCaseDocument({
        id: "seeded-case",
        // Deliberately contradicts what the stub writes, so the outcome is a
        // MISMATCH and the directory survives for these assertions.
        expected: { verdict: "REVISE" },
        files: {
          "contract.md": "# Contract\n\nInline bytes, unchanged.\n",
          "reviews/feedback.md": { fromFile: "fixtures/feedback.md" },
        },
      }),
      "fixtures/feedback.md": "copied byte-for-byte\n",
    });
    const { provider, calls } = buildEvalStubProvider([
      { write: (cwd) => writeEvalContractReview(cwd, "ACCEPT") },
    ]);

    const result = await runEvalCli(
      ["--pack", packDir],
      repoRoot(),
      provider,
      deps(),
    );

    const call = calls[0];
    expect(call).toBeDefined();
    // The listing at invoke entry is the only moment "nothing else present"
    // is a fact about the directory: the stub writes its artifact after.
    expect(call?.seededEntries).toEqual(["contract.md", "reviews/feedback.md"]);
    expect(call?.seededBytes).toEqual({
      "contract.md": "# Contract\n\nInline bytes, unchanged.\n",
      "reviews/feedback.md": "copied byte-for-byte\n",
    });
    expect(basename(call?.cwd ?? "").startsWith("afk-eval-seeded-case-")).toBe(
      true,
    );
    expect(call?.cwd.startsWith(tmpdir())).toBe(true);

    const report = readEvalReport(reportPathOf(result.output));
    const entry = report.cases[0];
    expect(entry?.outcome).toBe("MISMATCH");
    expect(entry?.scratchDir).toBe(call?.cwd);
    // Kept, and the seeded bytes are still there to be read.
    expect(existsSync(entry?.scratchDir ?? "")).toBe(true);
    expect(
      readFileSync(join(entry?.scratchDir ?? "", "contract.md"), "utf-8"),
    ).toBe("# Contract\n\nInline bytes, unchanged.\n");
  });

  it("B-17 removes the scratch directory after a MATCH", async () => {
    const { provider, calls } = buildEvalStubProvider([
      { write: EVAL_ROLE_MATCHING_ARTIFACT["evaluator-contract"] },
    ]);

    const result = await runEvalCli(
      ["--pack", rolePack("evaluator-contract")],
      repoRoot(),
      provider,
      deps(),
    );

    const report = readEvalReport(reportPathOf(result.output));
    expect(report.cases[0]?.outcome).toBe("MATCH");
    expect(report.cases[0]?.scratchDir).toBeUndefined();
    expect(existsSync(calls[0]?.cwd ?? "")).toBe(false);
  });

  it("B-13 records a per-case ERROR for a missing, ambiguous, unparseable or non-zero-exit artifact, and still exits 0", async () => {
    const packDir = pack({
      "01-none.json": evalCaseDocument({ id: "wrote-nothing" }),
      "02-two.json": evalCaseDocument({ id: "wrote-two" }),
      "03-bad.json": evalCaseDocument({ id: "wrote-garbage" }),
      "04-exit.json": evalCaseDocument({ id: "exited-non-zero" }),
    });
    const behaviors: EvalStubBehavior[] = [
      {},
      {
        write: (cwd) => {
          writeEvalContractReview(cwd, "ACCEPT");
          const nested = join(cwd, "second");
          mkdirSync(nested, { recursive: true });
          writeEvalContractReview(nested, "ACCEPT");
        },
      },
      {
        write: (cwd) => {
          writeFileSync(
            join(cwd, "contract-review.json"),
            "{ not json",
            "utf-8",
          );
        },
      },
      { exitCode: 7, write: (cwd) => writeEvalContractReview(cwd, "ACCEPT") },
    ];
    const { provider } = buildEvalStubProvider(behaviors);

    const result = await runEvalCli(
      ["--pack", packDir],
      repoRoot(),
      provider,
      deps(),
    );

    expect(result.exitCode).toBe(0);
    const report = readEvalReport(reportPathOf(result.output));
    expect(report.cases.map((entry) => entry.outcome)).toEqual([
      "ERROR",
      "ERROR",
      "ERROR",
      "ERROR",
    ]);
    expect(report.cases[0]?.error).toMatch(/role wrote no contract-review\.json/);
    expect(report.cases[1]?.error).toMatch(
      /role wrote 2 contract-review\.json files: /,
    );
    expect(report.cases[2]?.error).toMatch(/is not valid JSON/);
    expect(report.cases[3]?.error).toBe("role exited 7");
    expect(report.counts).toEqual({
      MATCH: 0,
      MISMATCH: 0,
      "NOT-RUN": 0,
      ERROR: 4,
    });
    // Every case is ERROR and the run still exits 0, because a report exists.
    expect(report.status).toBe("COMPLETE");
  });

  it("B-14 records a rejected invoke as ERROR, counts it as one call and never retries", async () => {
    const { provider, calls } = buildEvalStubProvider([
      { reject: new TransientProviderError("provider stream died") },
    ]);

    const result = await runEvalCli(
      ["--pack", rolePack("evaluator-contract")],
      repoRoot(),
      provider,
      deps(),
    );

    expect(result.exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    const report = readEvalReport(reportPathOf(result.output));
    expect(report.cases[0]?.outcome).toBe("ERROR");
    expect(report.cases[0]?.error).toBe("provider stream died");
    expect(report.cases[0]?.callsUsed).toBe(1);
    expect(report.callsUsed).toBe(1);
  });

  it("B-15 stops at the whole-run budget: --max-calls 2 over three cases leaves the third NOT-RUN", async () => {
    const packDir = pack({
      "01-a.json": evalCaseDocument({ id: "first" }),
      "02-b.json": evalCaseDocument({ id: "second" }),
      "03-c.json": evalCaseDocument({ id: "third" }),
    });
    const { provider, calls } = buildEvalStubProvider([
      { write: (cwd) => writeEvalContractReview(cwd, "ACCEPT") },
    ]);
    const injected = deps();

    const result = await runEvalCli(
      ["--pack", packDir, "--max-calls", "2"],
      repoRoot(),
      provider,
      injected,
    );

    expect(result.exitCode).toBe(0);
    expect(calls).toHaveLength(2);
    const report = readEvalReport(reportPathOf(result.output));
    expect(report.cases.map((entry) => entry.outcome)).toEqual([
      "MATCH",
      "MATCH",
      "NOT-RUN",
    ]);
    expect(report.cases[2]?.callsUsed).toBe(0);
    expect(report.callsUsed).toBe(2);
    expect(report.maxCalls).toBe(2);
    expect(report.status).toBe("INCOMPLETE");
    expect(injected.lines).toEqual([
      "[1/3] first (evaluator-contract) MATCH",
      "[2/3] second (evaluator-contract) MATCH",
      "[3/3] third (evaluator-contract) NOT-RUN",
    ]);
  });

  it("B-15 defaults the budget to 50 with no flag", async () => {
    const { provider } = buildEvalStubProvider([
      { write: (cwd) => writeEvalContractReview(cwd, "ACCEPT") },
    ]);

    const result = await runEvalCli(
      ["--pack", rolePack("evaluator-contract")],
      repoRoot(),
      provider,
      deps(),
    );

    expect(readEvalReport(reportPathOf(result.output)).maxCalls).toBe(50);
  });

  it("B-16 refuses --max-calls 0, a non-integer --max-calls and a missing --pack with exit 2, the usage text and no report", async () => {
    const root = repoRoot();
    const { provider, calls } = buildEvalStubProvider([{}]);
    const packDir = rolePack("evaluator-contract");

    for (const args of [
      ["--pack", packDir, "--max-calls", "0"],
      ["--pack", packDir, "--max-calls", "1.5"],
      ["--max-calls", "2"],
    ]) {
      const result = await runEvalCli(args, root, provider, deps());

      expect(result.exitCode).toBe(2);
      expect(result.output).toContain(
        "afk eval --pack <dir> [--max-calls <n>] [--out <dir>] [--dry-run]",
      );
      expect(existsSync(join(root, ".afk"))).toBe(false);
    }
    expect(calls).toHaveLength(0);
  });

  it("B-19 and B-20 write a per-case key set from a real run, with costUsd only where the provider reported it", async () => {
    const packDir = pack({
      "01-a.json": evalCaseDocument({ id: "matched" }),
      "02-b.json": evalCaseDocument({
        id: "mismatched",
        expected: { verdict: "REVISE" },
      }),
    });
    const { provider } = buildEvalStubProvider([
      {
        write: (cwd) => writeEvalContractReview(cwd, "ACCEPT"),
        stats: { costUsd: 0.25, toolCallCount: 3 },
      },
    ]);

    const result = await runEvalCli(
      ["--pack", packDir],
      repoRoot(),
      provider,
      deps(),
    );

    const document = JSON.parse(
      readFileSync(reportPathOf(result.output), "utf-8"),
    ) as { costUsd?: number; cases: Array<Record<string, unknown>> };
    expect(document.costUsd).toBe(0.5);
    expect(Object.keys(document.cases[0] ?? {}).sort()).toEqual([
      "actual",
      "callsUsed",
      "costUsd",
      "durationMs",
      "expected",
      "id",
      "outcome",
      "role",
      "source",
      "toolCallCount",
    ]);
    expect(Object.keys(document.cases[1] ?? {})).toContain("scratchDir");
  });

  it("B-20 omits the top-level costUsd when a dispatched case reported none", async () => {
    const packDir = pack({
      "01-a.json": evalCaseDocument({ id: "with-cost" }),
      "02-b.json": evalCaseDocument({ id: "without-cost" }),
    });
    const { provider } = buildEvalStubProvider([
      {
        write: (cwd) => writeEvalContractReview(cwd, "ACCEPT"),
        stats: { costUsd: 0.25 },
      },
      { write: (cwd) => writeEvalContractReview(cwd, "ACCEPT"), stats: {} },
    ]);

    const result = await runEvalCli(
      ["--pack", packDir],
      repoRoot(),
      provider,
      deps(),
    );

    const document = JSON.parse(
      readFileSync(reportPathOf(result.output), "utf-8"),
    ) as Record<string, unknown>;
    expect("costUsd" in document).toBe(false);
  });

  it("B-21 and B-22 stream only the per-case lines and return only the summary line, with no rate anywhere", async () => {
    const packDir = pack({
      "01-a.json": evalCaseDocument({ id: "first" }),
      "02-b.json": evalCaseDocument({
        id: "second",
        role: "evaluator-qa",
        expected: { verdict: "PASS", failureClass: "NONE" },
      }),
    });
    const { provider } = buildEvalStubProvider([
      { write: (cwd) => writeEvalContractReview(cwd, "ACCEPT") },
      { write: (cwd) => writeEvalQAReview(cwd, "PASS", "NONE") },
    ]);
    const injected = deps();

    const result = await runEvalCli(
      ["--pack", packDir],
      repoRoot(),
      provider,
      injected,
    );

    expect(injected.lines).toEqual([
      "[1/2] first (evaluator-contract) MATCH",
      "[2/2] second (evaluator-qa) MATCH",
    ]);
    expect(result.output).toBe(
      `afk eval COMPLETE: MATCH 2 / MISMATCH 0 / NOT-RUN 0 / ERROR 0 — calls 2/50 — ${reportPathOf(result.output)}`,
    );
    // No line appears in both, and nothing emitted carries a rate.
    expect(injected.lines).not.toContain(result.output);
    for (const line of [...injected.lines, result.output]) {
      expect(line).not.toMatch(/%|rate|ratio|percent/i);
    }
    // Whole words, because `durationMs` legitimately contains "ratio".
    expect(readFileSync(reportPathOf(result.output), "utf-8")).not.toMatch(
      /%|\brate\b|\bratio\b|percent|\bscore\b/i,
    );
  });

  it("B-23 exits 0 for a run whose every case is MISMATCH", async () => {
    const packDir = pack({
      "01-a.json": evalCaseDocument({ id: "first", expected: { verdict: "REVISE" } }),
      "02-b.json": evalCaseDocument({ id: "second", expected: { verdict: "REVISE" } }),
    });
    const { provider } = buildEvalStubProvider([
      { write: (cwd) => writeEvalContractReview(cwd, "ACCEPT") },
    ]);

    const result = await runEvalCli(
      ["--pack", packDir],
      repoRoot(),
      provider,
      deps(),
    );

    expect(result.exitCode).toBe(0);
    const report = readEvalReport(reportPathOf(result.output));
    expect(report.counts.MISMATCH).toBe(2);
    expect(report.status).toBe("COMPLETE");
  });

  it("B-23 exits 0 with an INCOMPLETE report when the cap stopped the run", async () => {
    const packDir = pack({
      "01-a.json": evalCaseDocument({ id: "first" }),
      "02-b.json": evalCaseDocument({ id: "second" }),
    });
    const { provider } = buildEvalStubProvider([
      { write: (cwd) => writeEvalContractReview(cwd, "ACCEPT") },
    ]);

    const result = await runEvalCli(
      ["--pack", packDir, "--max-calls", "1"],
      repoRoot(),
      provider,
      deps(),
    );

    expect(result.exitCode).toBe(0);
    expect(readEvalReport(reportPathOf(result.output)).status).toBe(
      "INCOMPLETE",
    );
  });

  it("B-24 exits 2 for a refused pack, naming the file and the member, with no report", async () => {
    const root = repoRoot();
    const packDir = pack({
      "01-case.json": evalCaseDocument({ notes: "surplus" }),
    });
    const { provider, calls } = buildEvalStubProvider([{}]);

    const result = await runEvalCli(
      ["--pack", packDir],
      root,
      provider,
      deps(),
    );

    expect(result.exitCode).toBe(2);
    expect(result.output).toMatch(
      /01-case\.json declares the unknown top-level member "notes"/,
    );
    expect(calls).toHaveLength(0);
    expect(existsSync(join(root, ".afk"))).toBe(false);
  });

  it("B-24 exits 2 when the --out directory cannot be created, with no report", async () => {
    const root = repoRoot();
    // A file where the output directory would go: creating it must fail.
    const blocked = join(root, "blocked");
    writeFileSync(blocked, "not a directory", "utf-8");
    const { provider, calls } = buildEvalStubProvider([{}]);

    const result = await runEvalCli(
      ["--pack", rolePack("evaluator-contract"), "--out", blocked],
      root,
      provider,
      deps(),
    );

    expect(result.exitCode).toBe(2);
    expect(calls).toHaveLength(0);
    expect(existsSync(join(blocked, RUN_DIR_NAME))).toBe(false);
  });

  it("B-24 exits 1 when a runner seam throws after dispatch began, with no report", async () => {
    const root = repoRoot();
    const packDir = pack({
      "01-a.json": evalCaseDocument({ id: "first" }),
      "02-b.json": evalCaseDocument({ id: "second" }),
    });
    const { provider, calls } = buildEvalStubProvider([
      { write: (cwd) => writeEvalContractReview(cwd, "ACCEPT") },
    ]);

    const result = await runEvalCli(
      ["--pack", packDir],
      root,
      provider,
      deps({
        stdout: () => {
          throw new Error("stdout sink closed");
        },
      }),
    );

    // A model call was already spent, which is what separates 1 from 2.
    expect(result.exitCode).toBe(1);
    expect(result.output).toBe("stdout sink closed");
    expect(calls).toHaveLength(1);
    expect(
      existsSync(join(root, ".afk", "eval", RUN_DIR_NAME, "report.json")),
    ).toBe(false);
  });

  it("B-25 --dry-run lists the cases, dispatches nothing, creates no output directory and exits 0", async () => {
    const root = repoRoot();
    const packDir = pack({
      "01-a.json": evalCaseDocument({ id: "first", source: "#194" }),
      "02-b.json": evalCaseDocument({
        id: "second",
        role: "planner",
        source: "#192",
        expected: { artifact: "ESCALATION" },
      }),
    });
    const { provider, calls } = buildEvalStubProvider([{}]);
    const injected = deps();

    const result = await runEvalCli(
      ["--pack", packDir, "--dry-run"],
      root,
      provider,
      injected,
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toBe(
      "first (evaluator-contract) — #194\nsecond (planner) — #192",
    );
    expect(calls).toHaveLength(0);
    expect(injected.lines).toEqual([]);
    expect(existsSync(join(root, ".afk"))).toBe(false);
  });

  it("B-25 --dry-run exits 2 for a refused pack", async () => {
    const packDir = pack({
      "01-case.json": evalCaseDocument({ role: "generator" }),
    });
    const { provider } = buildEvalStubProvider([{}]);

    const result = await runEvalCli(
      ["--pack", packDir, "--dry-run"],
      repoRoot(),
      provider,
      deps(),
    );

    expect(result.exitCode).toBe(2);
    expect(result.output).toMatch(/is not an eval role/);
  });

  it("P-04 resolves the default --out under the gitignored .afk/ directory", async () => {
    const root = repoRoot();
    const { provider } = buildEvalStubProvider([
      { write: (cwd) => writeEvalContractReview(cwd, "ACCEPT") },
    ]);

    const result = await runEvalCli(
      ["--pack", rolePack("evaluator-contract")],
      root,
      provider,
      deps(),
    );

    expect(reportPathOf(result.output)).toBe(
      join(root, ".afk", "eval", RUN_DIR_NAME, "report.json"),
    );
    // The repository's own ignore rule is what keeps a report out of a diff.
    expect(readFileSync(".gitignore", "utf-8").split(/\r?\n/)).toContain(
      ".afk/",
    );
  });
});

/** The summary line's last ` — `-separated field is the report path (B-21). */
function reportPathOf(output: string): string {
  const path = output.split(" — ").pop();
  if (path === undefined) throw new Error(`no report path in "${output}"`);
  return path;
}

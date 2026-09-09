import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  acceptanceGateDeclaration,
  matchVitestJson,
  runAcceptanceGate,
  type AcceptanceRunner,
  type BehaviorCoverageRecord,
} from "./acceptance-gate.js";
import {
  BEHAVIOR_ID_TOKEN,
  resolveAcceptancePlan,
  resolveBaseGateDeclarations,
  resolveBindableGateCatalog,
  type AcceptancePlan,
} from "./base-gates.js";
import { validateAcceptanceManifestBindings } from "./acceptance-manifest.js";
import {
  ACCEPTANCE_GATE_ID,
  ACCEPTANCE_GATE_STAGE,
  GATE_EVIDENCE_VERSION,
} from "./gate-runner.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const PLAN: AcceptancePlan = {
  command: "pnpm",
  args: [
    "exec",
    "vitest",
    "run",
    "--reporter=json",
    "--testNamePattern",
    BEHAVIOR_ID_TOKEN,
  ],
  matcher: "vitest-json",
};

/**
 * Three reporter documents transcribed verbatim from real filtered runs of this
 * repo's own suite (vitest 3.2.4, node 22.15.1), recorded once while
 * implementing #85 so the suite itself spawns no vitest. `testResults` and
 * `snapshot` are elided — the matcher reads only the counts, and pinning
 * hundreds of lines of per-test payload would pin vitest's internals instead of
 * the rule.
 *
 * The `numPendingTests` values are the whole reason this slice does not read
 * `numTotalTests`: a filtered run leaves every non-matching test collected and
 * counted there.
 */
const MATCHED_AND_PASSED = {
  numTotalTestSuites: 7,
  numPassedTestSuites: 7,
  numFailedTestSuites: 0,
  numPendingTestSuites: 0,
  numTotalTests: 18,
  numPassedTests: 1,
  numFailedTests: 0,
  numPendingTests: 17,
  numTodoTests: 0,
  startTime: 1757000000000,
  success: true,
} as const;

/** Pattern matched nothing. Note `success: true` and exit code 0. */
const MATCHED_NOTHING = {
  numTotalTestSuites: 7,
  numPassedTestSuites: 7,
  numFailedTestSuites: 0,
  numPendingTestSuites: 0,
  numTotalTests: 18,
  numPassedTests: 0,
  numFailedTests: 0,
  numPendingTests: 18,
  numTodoTests: 0,
  startTime: 1757000000000,
  success: true,
} as const;

const MATCHED_AND_FAILED = {
  numTotalTestSuites: 2,
  numPassedTestSuites: 0,
  numFailedTestSuites: 2,
  numPendingTestSuites: 0,
  numTotalTests: 2,
  numPassedTests: 1,
  numFailedTests: 1,
  numPendingTests: 0,
  numTodoTests: 0,
  startTime: 1757000000000,
  success: false,
} as const;

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function behavior(id: string, gateIds: string[]) {
  return {
    id,
    source: "contract.md",
    given: "a candidate",
    when: "the gate runs",
    then: "coverage is decided",
    observableResult: `a test named ${id}`,
    preservation: false,
    gateIds,
  };
}

/** A slice directory holding a v2 manifest, or none when `manifest` is null. */
function sliceDir(manifest: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "acceptance-gate-"));
  roots.push(root);
  if (manifest !== null) {
    writeFileSync(
      join(root, "acceptance-manifest.json"),
      typeof manifest === "string" ? manifest : JSON.stringify(manifest),
      "utf-8",
    );
  }
  return root;
}

function manifestBinding(...ids: string[]) {
  return {
    version: 2,
    fileScope: { kind: "paths", paths: ["src/a.ts"] },
    migrationCount: 0,
    behaviors: ids.map((id) => behavior(id, [ACCEPTANCE_GATE_ID])),
  };
}

/** A runner that answers from a per-behavior document table. */
function runnerFor(
  documents: Record<string, unknown>,
  calls?: { command: string; args: readonly string[]; cwd: string }[],
): AcceptanceRunner {
  return async (input) => {
    calls?.push({ command: input.command, args: input.args, cwd: input.cwd });
    const behaviorId = input.args[input.args.length - 1]!;
    const document = documents[behaviorId];
    return {
      output:
        document === undefined
          ? "no document here"
          : typeof document === "string"
            ? document
            : JSON.stringify(document),
    };
  };
}

/** A project root with the given `package.json` scripts and optional policy. */
function projectRoot(
  scripts: Record<string, string>,
  gatePolicy?: unknown,
): string {
  const root = mkdtempSync(join(tmpdir(), "acceptance-plan-"));
  roots.push(root);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "p", scripts }),
    "utf-8",
  );
  if (gatePolicy !== undefined) {
    writeFileSync(
      join(root, "afk.config.json"),
      JSON.stringify({ version: 1, gatePolicy }),
      "utf-8",
    );
  }
  return root;
}

const DECLARED_POLICY = {
  version: 1,
  acceptance: {
    command: "npx",
    args: ["vitest", "--reporter=json", "-t", BEHAVIOR_ID_TOKEN],
    matcher: "vitest-json",
  },
};

describe("resolveAcceptancePlan", () => {
  it("B-02 prefers a declared gatePolicy.acceptance and needs no tests script", () => {
    expect(resolveAcceptancePlan(projectRoot({}, DECLARED_POLICY))).toEqual({
      command: "npx",
      args: ["vitest", "--reporter=json", "-t", BEHAVIOR_ID_TOKEN],
      matcher: "vitest-json",
    });
    // Declared wins even where a derived baseline was available, so the two
    // sources can never both be live.
    expect(
      resolveAcceptancePlan(projectRoot({ test: "vitest" }, DECLARED_POLICY))
        ?.command,
    ).toBe("npx");
  });

  it("B-02 derives the baseline only when a tests step exists, else no plan", () => {
    expect(resolveAcceptancePlan(projectRoot({ test: "vitest run" }))).toEqual(
      PLAN,
    );
    // `test:run` is the other script `resolveSanityPlan` accepts for the step.
    expect(
      resolveAcceptancePlan(projectRoot({ "test:run": "vitest run" }))?.args,
    ).toEqual(PLAN.args);

    // Typecheck and lint are not a test runner.
    expect(
      resolveAcceptancePlan(projectRoot({ typecheck: "tsc", lint: "eslint" })),
    ).toBeNull();
    expect(resolveAcceptancePlan(projectRoot({}))).toBeNull();
  });

  it("B-02 refuses a malformed policy rather than falling back to the baseline", () => {
    const root = projectRoot(
      { test: "vitest" },
      { version: 1, acceptance: { command: "pnpm", args: [], matcher: "x" } },
    );
    expect(() => resolveAcceptancePlan(root)).toThrow(
      /gatePolicy\.acceptance/,
    );
  });
});

describe("resolveBindableGateCatalog", () => {
  it("B-02 appends the acceptance entry with the resolved plan's command", () => {
    const catalog = resolveBindableGateCatalog(
      projectRoot({ typecheck: "tsc", lint: "eslint", test: "vitest" }),
    );
    expect(catalog.map((gate) => gate.id)).toEqual([
      "typecheck",
      "lint",
      "tests",
      ACCEPTANCE_GATE_ID,
    ]);
    const acceptance = catalog.at(-1)!;
    expect(acceptance.command).toBe("pnpm");
    expect(acceptance.args).toEqual(PLAN.args);
  });

  it("B-02 declares no acceptance entry when no plan resolved", () => {
    const catalog = resolveBindableGateCatalog(projectRoot({ lint: "eslint" }));
    expect(catalog.map((gate) => gate.id)).toEqual([
      "typecheck",
      "lint",
      "tests",
    ]);
  });

  it("B-02 lets a bound behavior pass lock-time validation under either plan source", () => {
    const manifest = manifestBinding("B-01");
    for (const root of [
      projectRoot({ test: "vitest" }),
      projectRoot({}, DECLARED_POLICY),
    ]) {
      expect(() =>
        validateAcceptanceManifestBindings(
          manifest as never,
          resolveBindableGateCatalog(root),
        ),
      ).not.toThrow();
    }
  });

  it("B-02 still refuses an id the catalog does not declare", () => {
    const root = projectRoot({ test: "vitest" });
    // No plan: the acceptance id itself is unknown, not nonExecutable.
    expect(
      messageOf(() =>
        validateAcceptanceManifestBindings(
          manifestBinding("B-01") as never,
          resolveBindableGateCatalog(projectRoot({})),
        ),
      ),
    ).toContain(ACCEPTANCE_GATE_ID);
    expect(
      messageOf(() =>
        validateAcceptanceManifestBindings(
          {
            ...manifestBinding("B-01"),
            behaviors: [behavior("B-01", ["acceptance"])],
          } as never,
          resolveBindableGateCatalog(root),
        ),
      ),
    ).toContain("acceptance");
  });

  it("P-02 leaves the three base resolvers and nonExecutable's meaning alone", () => {
    // The acceptance entry lives only in the bindable catalog: the base
    // resolvers still yield exactly the three sanity gates, `required` still
    // tracks script presence, and a scriptless gate still carries no command —
    // which is what keeps `nonExecutable` meaning "nothing would run".
    const root = projectRoot({ test: "vitest" });
    expect(resolveBaseGateDeclarations(root)).toEqual([
      { id: "typecheck", stage: "base", required: false },
      { id: "lint", stage: "base", required: false },
      {
        id: "tests",
        stage: "base",
        required: true,
        command: "pnpm",
        args: ["run", "test"],
      },
    ]);
    expect(
      messageOf(() =>
        validateAcceptanceManifestBindings(
          {
            ...manifestBinding("B-01"),
            behaviors: [behavior("B-01", ["typecheck"])],
          } as never,
          resolveBindableGateCatalog(root),
        ),
      ),
    ).toContain("typecheck");
    expect(GATE_EVIDENCE_VERSION).toBe(2);
  });
});

describe("matchVitestJson", () => {
  it("B-03 reads matched as numPassedTests + numFailedTests, never numTotalTests", () => {
    expect(matchVitestJson(MATCHED_AND_PASSED)).toEqual({
      status: "covered",
      matched: 1,
      passed: 1,
      failed: 0,
    });
    // The whole point: `numTotalTests` is 18 on a run that matched one test.
    expect(MATCHED_AND_PASSED.numTotalTests).toBe(18);

    expect(matchVitestJson(MATCHED_NOTHING)).toEqual({
      status: "untested",
      matched: 0,
      passed: 0,
      failed: 0,
    });
    // ...and 18 again on a run that matched nothing and still exited 0.
    expect(MATCHED_NOTHING.numTotalTests).toBe(18);
    expect(MATCHED_NOTHING.success).toBe(true);

    expect(matchVitestJson(MATCHED_AND_FAILED)).toEqual({
      status: "failed",
      matched: 2,
      passed: 1,
      failed: 1,
    });
  });

  it("B-03 counts a skipped- or todo-only match as untested, not covered", () => {
    expect(
      matchVitestJson({
        ...MATCHED_NOTHING,
        numTotalTests: 4,
        numPendingTests: 3,
        numTodoTests: 1,
      })?.status,
    ).toBe("untested");
  });

  it("B-03 returns null for anything that is not a reporter document", () => {
    for (const value of [
      null,
      undefined,
      7,
      "numPassedTests",
      [MATCHED_AND_PASSED],
      {},
      { numPassedTests: 1 },
      { numPassedTests: "1", numFailedTests: 0 },
      { numPassedTests: Number.NaN, numFailedTests: 0 },
      // `success` alone is not enough: it is true on a zero-match run.
      { success: true },
    ]) {
      expect(matchVitestJson(value)).toBeNull();
    }
  });
});

describe("acceptanceGateDeclaration", () => {
  it("B-04 declares one aggregate required gate with D8's id and stage", () => {
    const declaration = acceptanceGateDeclaration({
      absSliceDir: sliceDir(manifestBinding("B-01", "B-02")),
      plan: PLAN,
    })!;
    expect(declaration.id).toBe("acceptance:behaviors");
    expect(declaration.id).toBe(ACCEPTANCE_GATE_ID);
    expect(declaration.stage).toBe(ACCEPTANCE_GATE_STAGE);
    expect(declaration.required).toBe(true);
    // P-02's exactly-one-of rule: the declaration carries `run`, never a
    // `command` the runner would classify from an exit code.
    expect(declaration.run).toBeTypeOf("function");
    expect(declaration.command).toBeUndefined();
  });

  it("B-04 declares nothing when the manifest binds no behavior to it", () => {
    expect(
      acceptanceGateDeclaration({
        absSliceDir: sliceDir({
          ...manifestBinding("B-01"),
          behaviors: [behavior("B-01", ["typecheck", "tests"])],
        }),
        plan: PLAN,
      }),
    ).toBeUndefined();
    // A v1 manifest has no behaviors at all.
    expect(
      acceptanceGateDeclaration({
        absSliceDir: sliceDir({
          version: 1,
          fileScope: { kind: "paths", paths: ["src/a.ts"] },
          migrationCount: 0,
        }),
        plan: PLAN,
      }),
    ).toBeUndefined();
    // Build time tolerates a missing or unreadable manifest — nothing to
    // prove — while `run` below does not.
    expect(
      acceptanceGateDeclaration({ absSliceDir: sliceDir(null), plan: PLAN }),
    ).toBeUndefined();
    expect(
      acceptanceGateDeclaration({
        absSliceDir: sliceDir("{ not json"),
        plan: PLAN,
      }),
    ).toBeUndefined();
  });

  it("B-04 substitutes the behavior id into every token occurrence, once per behavior", () => {
    const calls: { command: string; args: readonly string[]; cwd: string }[] =
      [];
    const declaration = acceptanceGateDeclaration({
      absSliceDir: sliceDir(manifestBinding("B-01", "B-02")),
      plan: {
        command: "pnpm",
        args: ["exec", "vitest", `--reporter=json`, `-t=^${BEHAVIOR_ID_TOKEN}$`, BEHAVIOR_ID_TOKEN],
        matcher: "vitest-json",
      },
      runner: runnerFor(
        { "B-01": MATCHED_AND_PASSED, "B-02": MATCHED_AND_PASSED },
        calls,
      ),
    })!;

    return Promise.resolve(
      declaration.run!({ treeId: "t1", cwd: "/candidate" }),
    ).then((outcome) => {
      expect(outcome.status).toBe("PASS");
      expect(calls).toEqual([
        {
          command: "pnpm",
          args: ["exec", "vitest", "--reporter=json", "-t=^B-01$", "B-01"],
          cwd: "/candidate",
        },
        {
          command: "pnpm",
          args: ["exec", "vitest", "--reporter=json", "-t=^B-02$", "B-02"],
          cwd: "/candidate",
        },
      ]);
    });
  });

  it("B-04 reads the manifest at run time, not at declaration time", async () => {
    const absSliceDir = sliceDir(manifestBinding("B-01"));
    const declaration = acceptanceGateDeclaration({
      absSliceDir,
      plan: PLAN,
      runner: runnerFor({
        "B-01": MATCHED_AND_PASSED,
        "B-09": MATCHED_NOTHING,
      }),
    })!;
    // An amendment landing between build and run is the manifest the gate
    // honours (the rule `src/scope-gate.ts` states).
    writeFileSync(
      join(absSliceDir, "acceptance-manifest.json"),
      JSON.stringify(manifestBinding("B-01", "B-09")),
      "utf-8",
    );
    const outcome = await declaration.run!({ treeId: "t1", cwd: "/candidate" });
    expect(outcome.status).toBe("FAIL");
    expect(outcome.detail).toContain("B-09");
  });

  it("B-04 stops the loop on cancellation and never reports PASS from a partial run", async () => {
    const controller = new AbortController();
    const seen: string[] = [];
    const declaration = acceptanceGateDeclaration({
      absSliceDir: sliceDir(manifestBinding("B-01", "B-02", "B-03")),
      plan: PLAN,
      runner: async (input) => {
        const behaviorId = input.args[input.args.length - 1]!;
        seen.push(behaviorId);
        if (behaviorId === "B-01") controller.abort();
        return { output: JSON.stringify(MATCHED_AND_PASSED) };
      },
    })!;

    const outcome = await declaration.run!({
      treeId: "t1",
      cwd: "/candidate",
      signal: controller.signal,
    });
    expect(seen).toEqual(["B-01"]);
    expect(outcome.status).not.toBe("PASS");
    expect(outcome.status).toBe("INFRASTRUCTURE");
    expect(outcome.detail).toContain("B-02");
    // The signal reaches the child too, so a cancelled run does not wait out
    // the suite it already started (ADR 0003).
    expect(
      await new Promise<AbortSignal | undefined>((resolve) => {
        acceptanceGateDeclaration({
          absSliceDir: sliceDir(manifestBinding("B-01")),
          plan: PLAN,
          runner: async (input) => {
            resolve(input.signal);
            return { output: JSON.stringify(MATCHED_AND_PASSED) };
          },
        })!.run!({ treeId: "t1", cwd: "/c", signal: new AbortController().signal });
      }),
    ).toBeInstanceOf(AbortSignal);
  });
});

describe("runAcceptanceGate verdicts", () => {
  const ctx = { cwd: "/candidate" };

  it("B-05 passes only when every bound behavior is covered", async () => {
    const outcome = await runAcceptanceGate(
      {
        absSliceDir: sliceDir(manifestBinding("B-01", "B-02")),
        plan: PLAN,
        runner: runnerFor({
          "B-01": MATCHED_AND_PASSED,
          "B-02": MATCHED_AND_FAILED,
        }),
      },
      ctx,
    );
    expect(outcome).toMatchObject({ status: "FAIL", failureKind: "COMMAND" });

    const green = await runAcceptanceGate(
      {
        absSliceDir: sliceDir(manifestBinding("B-01", "B-02")),
        plan: PLAN,
        runner: runnerFor({
          "B-01": MATCHED_AND_PASSED,
          "B-02": MATCHED_AND_PASSED,
        }),
      },
      ctx,
    );
    expect(green).toMatchObject({ status: "PASS", failureKind: null });
  });

  it("B-05 names every failing id with its counts and its untested-versus-failed reason", async () => {
    const outcome = await runAcceptanceGate(
      {
        absSliceDir: sliceDir(manifestBinding("B-01", "B-02", "B-03", "B-04")),
        plan: PLAN,
        runner: runnerFor({
          "B-01": MATCHED_AND_PASSED,
          "B-02": MATCHED_NOTHING,
          "B-03": MATCHED_AND_FAILED,
          "B-04": MATCHED_NOTHING,
        }),
      },
      ctx,
    );

    expect(outcome).toMatchObject({ status: "FAIL", failureKind: "COMMAND" });
    const detail = outcome.detail!;
    // Every failing id in one detail, so one repair round sees the whole red
    // set (#85 AC5) — and the passing one is not blamed.
    expect(detail).toContain("B-02 (matched 0, passed 0, failed 0)");
    expect(detail).toContain("B-04 (matched 0, passed 0, failed 0)");
    expect(detail).toContain("B-03 (matched 2, passed 1, failed 1)");
    expect(detail).not.toContain("B-01 (");
    expect(detail).toContain("No test names");
    expect(detail).toContain("Matched tests fail for");
    expect(detail).toContain("3 of 4");
  });

  it("B-05 reports a no-match run as an untested COMMAND failure, not a configuration error", async () => {
    const outcome = await runAcceptanceGate(
      {
        absSliceDir: sliceDir(manifestBinding("B-01")),
        plan: PLAN,
        runner: runnerFor({ "B-01": MATCHED_NOTHING }),
      },
      ctx,
    );
    // The run emitted a document, so this is evidence about the tree: the
    // generator can fix it by naming the id in a test.
    expect(outcome).toMatchObject({ status: "FAIL", failureKind: "COMMAND" });
    expect(outcome.detail).toContain("No test names B-01");
  });

  it("B-05 reports CONFIGURATION for output with no reporter document, naming the ids and matcher", async () => {
    const outcome = await runAcceptanceGate(
      {
        absSliceDir: sliceDir(manifestBinding("B-01", "B-02")),
        plan: PLAN,
        runner: runnerFor({
          "B-01": MATCHED_AND_PASSED,
          "B-02": "ERR_PNPM_NO_SCRIPT  Command \"vitest\" not found",
        }),
      },
      ctx,
    );
    expect(outcome).toMatchObject({
      status: "FAIL",
      failureKind: "CONFIGURATION",
    });
    expect(outcome.detail).toContain("B-02");
    expect(outcome.detail).toContain("vitest-json");
    expect(outcome.detail).not.toContain("B-01");
  });

  it("B-05 reports CONFIGURATION for an unsupported matcher, naming the ids and matcher", async () => {
    const outcome = await runAcceptanceGate(
      {
        absSliceDir: sliceDir(manifestBinding("B-01")),
        plan: { ...PLAN, matcher: "jest-json" as never },
        runner: runnerFor({ "B-01": MATCHED_AND_PASSED }),
      },
      ctx,
    );
    expect(outcome).toMatchObject({
      status: "FAIL",
      failureKind: "CONFIGURATION",
    });
    expect(outcome.detail).toContain("jest-json");
    expect(outcome.detail).toContain("B-01");
  });

  it("B-05 reports CONFIGURATION when behaviors are bound but no plan resolved", async () => {
    const outcome = await runAcceptanceGate(
      {
        absSliceDir: sliceDir(manifestBinding("B-01", "B-02")),
        plan: null,
      },
      ctx,
    );
    // A silent PASS here would be the hole this gate exists to close.
    expect(outcome).toMatchObject({
      status: "FAIL",
      failureKind: "CONFIGURATION",
    });
    expect(outcome.detail).toContain("B-01");
    expect(outcome.detail).toContain("B-02");
  });

  it("B-05 throws on an unreadable manifest, which runGates records as INFRASTRUCTURE", async () => {
    await expect(
      runAcceptanceGate(
        { absSliceDir: sliceDir("{ not json"), plan: PLAN },
        ctx,
      ),
    ).rejects.toThrow();
    await expect(
      runAcceptanceGate({ absSliceDir: sliceDir(null), plan: PLAN }, ctx),
    ).rejects.toThrow();
  });

  it("B-05 passes a manifest binding nothing, saying so", async () => {
    const outcome = await runAcceptanceGate(
      {
        absSliceDir: sliceDir({
          ...manifestBinding("B-01"),
          behaviors: [behavior("B-01", ["tests"])],
        }),
        plan: PLAN,
      },
      ctx,
    );
    // PASS and not SKIPPED: a required SKIPPED would block evaluation.
    expect(outcome).toMatchObject({ status: "PASS", failureKind: null });
    expect(outcome.detail).toContain(ACCEPTANCE_GATE_ID);
  });

  it("B-05 finds the reporter document on the last line, behind package-manager noise", async () => {
    const outcome = await runAcceptanceGate(
      {
        absSliceDir: sliceDir(manifestBinding("B-01", "B-02")),
        plan: PLAN,
        runner: runnerFor({
          // Merged stdout/stderr: a progress line, and an unterminated stderr
          // write prefixing the JSON line.
          "B-01": `> vitest run\n{"not":"a document"}\n${JSON.stringify(MATCHED_AND_PASSED)}`,
          "B-02": `stderr noise ${JSON.stringify(MATCHED_AND_PASSED)}`,
        }),
      },
      ctx,
    );
    expect(outcome.status).toBe("PASS");
  });

  it("B-06 reports one record per behavior as each run settles", async () => {
    const records: BehaviorCoverageRecord[] = [];
    await runAcceptanceGate(
      {
        absSliceDir: sliceDir(manifestBinding("B-01", "B-02", "B-03")),
        plan: PLAN,
        runner: runnerFor({
          "B-01": MATCHED_AND_PASSED,
          "B-02": MATCHED_NOTHING,
          "B-03": "no document",
        }),
        onBehaviorResult: (record) => records.push(record),
      },
      ctx,
    );
    expect(records).toEqual([
      { behaviorId: "B-01", status: "covered", matched: 1, passed: 1, failed: 0 },
      { behaviorId: "B-02", status: "untested", matched: 0, passed: 0, failed: 0 },
      {
        behaviorId: "B-03",
        status: "unparsable",
        matched: 0,
        passed: 0,
        failed: 0,
      },
    ]);
  });
});

describe("this repository as the gate's own project", () => {
  it("B-07 resolves a plan whose command is the declared runner", () => {
    const plan = resolveAcceptancePlan(REPO_ROOT)!;
    expect(plan.matcher).toBe("vitest-json");
    expect(plan.args.some((arg) => arg.includes(BEHAVIOR_ID_TOKEN))).toBe(true);
    expect(
      resolveBindableGateCatalog(REPO_ROOT).find(
        (gate) => gate.id === ACCEPTANCE_GATE_ID,
      )?.command,
    ).toBe(plan.command);
  });
});

function messageOf(call: () => unknown): string {
  try {
    call();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the call to throw");
}

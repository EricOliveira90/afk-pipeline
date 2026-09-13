import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  acceptanceGateDeclaration,
  behaviorTag,
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
const ISSUE_NUMBER = 85;

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

type TestStatus = "passed" | "failed" | "pending" | "todo";

function assertion(fullName: string, status: TestStatus) {
  return { ancestorTitles: [], fullName, status, title: fullName };
}

function report(...assertions: ReturnType<typeof assertion>[]) {
  return {
    numTotalTests: assertions.length,
    numPassedTests: assertions.filter((entry) => entry.status === "passed")
      .length,
    numFailedTests: assertions.filter((entry) => entry.status === "failed")
      .length,
    success: assertions.every((entry) => entry.status !== "failed"),
    testResults: [{ assertionResults: assertions }],
  };
}

function qualified(id: string, status: TestStatus = "passed") {
  return assertion(`${behaviorTag(ISSUE_NUMBER, id)} proves ${id}`, status);
}

function legacy(id: string, status: TestStatus = "passed") {
  return assertion(`[behavior:${id}] belongs to another PRD`, status);
}

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

/** A runner that returns one shared reporter document. */
function runnerFor(
  document: unknown,
  calls?: { command: string; args: readonly string[]; cwd: string }[],
): AcceptanceRunner {
  return async (input) => {
    calls?.push({ command: input.command, args: input.args, cwd: input.cwd });
    return {
      output:
        typeof document === "string" ? document : JSON.stringify(document),
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
    // 3 since #86: version 3 added the optional cache/prerequisite/advisory
    // markers. The `version: 2` fixture above is an acceptance *manifest*, a
    // different document with its own version line, and stays 2.
    //
    // 4 since #87: version 4 added the optional `GateFindings.suppressions`
    // field the in-process `suppressions` gate reports its
    // `{ path, line, detectorId }` triples through. Readers still accept 1-3
    // (P-06), so this pin is the shipped writer's version, not the minimum a
    // reader admits — and it is not bumped again for a field that already
    // exists.
    expect(GATE_EVIDENCE_VERSION).toBe(4);
  });
});

describe("matchVitestJson", () => {
  it("[behavior:#85:B-03] applies the qualified assertion evidence policy", () => {
    expect(
      matchVitestJson(
        report(
          qualified("B-01"),
          qualified("B-01", "pending"),
          qualified("B-01", "todo"),
          legacy("B-01"),
          qualified("B-02"),
          qualified("B-02", "failed"),
          assertion("[behavior:#777:B-01] unrelated PRD", "passed"),
        ),
        ISSUE_NUMBER,
        ["B-01", "B-02", "B-03"],
      ),
    ).toEqual({
      records: [
        {
          behaviorId: "B-01",
          status: "covered",
          matched: 1,
          passed: 1,
          failed: 0,
        },
        {
          behaviorId: "B-02",
          status: "failed",
          matched: 2,
          passed: 1,
          failed: 1,
        },
        {
          behaviorId: "B-03",
          status: "untested",
          matched: 0,
          passed: 0,
          failed: 0,
        },
      ],
      ambiguousLegacyIds: [],
    });
  });

  it("[behavior:#85:B-03] reports legacy-only and skipped qualified tags as untested", () => {
    expect(
      matchVitestJson(
        report(
          legacy("B-01"),
          qualified("B-02", "pending"),
          qualified("B-02", "todo"),
        ),
        ISSUE_NUMBER,
        ["B-01", "B-02"],
      ),
    ).toEqual({
      records: [
        {
          behaviorId: "B-01",
          status: "untested",
          matched: 0,
          passed: 0,
          failed: 0,
        },
        {
          behaviorId: "B-02",
          status: "untested",
          matched: 0,
          passed: 0,
          failed: 0,
        },
      ],
      ambiguousLegacyIds: ["B-01"],
    });
  });

  it("[behavior:#85:B-03] returns null for anything that is not a reporter document", () => {
    for (const value of [
      null,
      undefined,
      7,
      "testResults",
      [report()],
      {},
      { testResults: {} },
      { testResults: [null] },
      { testResults: [{}] },
      { testResults: [{ assertionResults: [null] }] },
      { testResults: [{ assertionResults: [{ fullName: "x" }] }] },
    ]) {
      expect(matchVitestJson(value, ISSUE_NUMBER, ["B-01"])).toBeNull();
    }
  });
});

describe("acceptanceGateDeclaration", () => {
  it("[behavior:#85:B-04] declares one aggregate required gate with D8's id and stage", () => {
    const declaration = acceptanceGateDeclaration({
      absSliceDir: sliceDir(manifestBinding("B-01", "B-02")),
      issueNumber: ISSUE_NUMBER,
      plan: PLAN,
    })!;
    expect(declaration.id).toBe(ACCEPTANCE_GATE_ID);
    expect(declaration.stage).toBe(ACCEPTANCE_GATE_STAGE);
    expect(declaration.required).toBe(true);
    expect(declaration.run).toBeTypeOf("function");
    expect(declaration.command).toBeUndefined();
  });

  it("[behavior:#85:B-04] declares nothing when the manifest binds no behavior to it", () => {
    expect(
      acceptanceGateDeclaration({
        absSliceDir: sliceDir({
          ...manifestBinding("B-01"),
          behaviors: [behavior("B-01", ["typecheck", "tests"])],
        }),
        issueNumber: ISSUE_NUMBER,
        plan: PLAN,
      }),
    ).toBeUndefined();
    expect(
      acceptanceGateDeclaration({
        absSliceDir: sliceDir({
          version: 1,
          fileScope: { kind: "paths", paths: ["src/a.ts"] },
          migrationCount: 0,
        }),
        issueNumber: ISSUE_NUMBER,
        plan: PLAN,
      }),
    ).toBeUndefined();
    expect(
      acceptanceGateDeclaration({
        absSliceDir: sliceDir(null),
        issueNumber: ISSUE_NUMBER,
        plan: PLAN,
      }),
    ).toBeUndefined();
    expect(
      acceptanceGateDeclaration({
        absSliceDir: sliceDir("{ not json"),
        issueNumber: ISSUE_NUMBER,
        plan: PLAN,
      }),
    ).toBeUndefined();
  });

  it("[behavior:#85:B-04] invokes the runner once with one selector for every required tag", async () => {
    const calls: { command: string; args: readonly string[]; cwd: string }[] =
      [];
    const declaration = acceptanceGateDeclaration({
      absSliceDir: sliceDir(manifestBinding("B-01", "B-02")),
      issueNumber: ISSUE_NUMBER,
      plan: {
        command: "pnpm",
        args: [
          "exec",
          "vitest",
          "--reporter=json",
          `-t=^${BEHAVIOR_ID_TOKEN}$`,
          BEHAVIOR_ID_TOKEN,
        ],
        matcher: "vitest-json",
      },
      runner: runnerFor(report(qualified("B-01"), qualified("B-02")), calls),
    })!;

    const outcome = await declaration.run!({
      treeId: "t1",
      cwd: "/candidate",
    });
    expect(outcome.status).toBe("PASS");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ command: "pnpm", cwd: "/candidate" });
    for (const arg of calls[0]!.args.slice(-2)) {
      expect(arg).toContain("\\[behavior:#85:B-01\\]");
      expect(arg).toContain("\\[behavior:#85:B-02\\]");
      expect(arg).toContain("\\[behavior:B-01\\]");
    }
  });

  it("[behavior:#85:B-04] reads the manifest at run time, not declaration time", async () => {
    const absSliceDir = sliceDir(manifestBinding("B-01"));
    const declaration = acceptanceGateDeclaration({
      absSliceDir,
      issueNumber: ISSUE_NUMBER,
      plan: PLAN,
      runner: runnerFor(report(qualified("B-01"))),
    })!;
    writeFileSync(
      join(absSliceDir, "acceptance-manifest.json"),
      JSON.stringify(manifestBinding("B-01", "B-09")),
      "utf-8",
    );
    const outcome = await declaration.run!({ treeId: "t1", cwd: "/candidate" });
    expect(outcome.status).toBe("FAIL");
    expect(outcome.detail).toContain("B-09");
  });

  it("[behavior:#85:B-04] forwards cancellation and never reports a partial run PASS", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const declaration = acceptanceGateDeclaration({
      absSliceDir: sliceDir(manifestBinding("B-01", "B-02")),
      issueNumber: ISSUE_NUMBER,
      plan: PLAN,
      runner: async (input) => {
        receivedSignal = input.signal;
        controller.abort();
        return { output: JSON.stringify(report(qualified("B-01"))) };
      },
    })!;
    const outcome = await declaration.run!({
      treeId: "t1",
      cwd: "/candidate",
      signal: controller.signal,
    });
    expect(receivedSignal).toBe(controller.signal);
    expect(outcome.status).toBe("INFRASTRUCTURE");
    expect(outcome.detail).toContain("B-02");
  });
});

describe("runAcceptanceGate verdicts", () => {
  const ctx = { cwd: "/candidate" };

  it("[behavior:#85:B-05] passes only when every bound qualified behavior is covered", async () => {
    const red = await runAcceptanceGate(
      {
        absSliceDir: sliceDir(manifestBinding("B-01", "B-02")),
        issueNumber: ISSUE_NUMBER,
        plan: PLAN,
        runner: runnerFor(
          report(qualified("B-01"), qualified("B-02", "failed")),
        ),
      },
      ctx,
    );
    expect(red).toMatchObject({ status: "FAIL", failureKind: "COMMAND" });

    const green = await runAcceptanceGate(
      {
        absSliceDir: sliceDir(manifestBinding("B-01", "B-02")),
        issueNumber: ISSUE_NUMBER,
        plan: PLAN,
        runner: runnerFor(
          report(
            qualified("B-01"),
            qualified("B-01", "pending"),
            qualified("B-01", "todo"),
            legacy("B-01"),
            qualified("B-02"),
          ),
        ),
      },
      ctx,
    );
    expect(green).toMatchObject({ status: "PASS", failureKind: null });
  });

  it("[behavior:#85:B-05] rejects unrelated and ambiguous legacy evidence in one combined verdict", async () => {
    const outcome = await runAcceptanceGate(
      {
        absSliceDir: sliceDir(
          manifestBinding("B-01", "B-02", "B-03", "B-04"),
        ),
        issueNumber: ISSUE_NUMBER,
        plan: PLAN,
        runner: runnerFor(
          report(
            qualified("B-01"),
            legacy("B-02"),
            qualified("B-03"),
            qualified("B-03", "failed"),
            assertion("[behavior:#777:B-04] unrelated PRD", "passed"),
          ),
        ),
      },
      ctx,
    );

    expect(outcome).toMatchObject({ status: "FAIL", failureKind: "COMMAND" });
    const detail = outcome.detail!;
    expect(detail).toContain("B-02 (matched 0, passed 0, failed 0)");
    expect(detail).toContain("B-04 (matched 0, passed 0, failed 0)");
    expect(detail).toContain("B-03 (matched 2, passed 1, failed 1)");
    expect(detail).not.toContain("B-01 (");
    expect(detail).toContain("Legacy-only tags are ambiguous");
    expect(detail).toContain("[behavior:#85:B-01]");
    expect(detail).toContain("3 of 4");
  });

  it("[behavior:#85:B-05] reports CONFIGURATION for an unreadable shared report", async () => {
    const outcome = await runAcceptanceGate(
      {
        absSliceDir: sliceDir(manifestBinding("B-01", "B-02")),
        issueNumber: ISSUE_NUMBER,
        plan: PLAN,
        runner: runnerFor('ERR_PNPM_NO_SCRIPT Command "vitest" not found'),
      },
      ctx,
    );
    expect(outcome).toMatchObject({
      status: "FAIL",
      failureKind: "CONFIGURATION",
    });
    expect(outcome.detail).toContain("B-01");
    expect(outcome.detail).toContain("B-02");
    expect(outcome.detail).toContain("vitest-json");
  });

  it("[behavior:#85:B-05] fails closed for unsupported matcher, missing plan, or missing issue identity", async () => {
    const absSliceDir = sliceDir(manifestBinding("B-01"));
    const unsupported = await runAcceptanceGate(
      {
        absSliceDir,
        issueNumber: ISSUE_NUMBER,
        plan: { ...PLAN, matcher: "jest-json" as never },
        runner: runnerFor(report(qualified("B-01"))),
      },
      ctx,
    );
    expect(unsupported.detail).toContain("jest-json");

    const noPlan = await runAcceptanceGate(
      { absSliceDir, issueNumber: ISSUE_NUMBER, plan: null },
      ctx,
    );
    expect(noPlan).toMatchObject({
      status: "FAIL",
      failureKind: "CONFIGURATION",
    });

    const noIssue = await runAcceptanceGate(
      {
        absSliceDir,
        plan: PLAN,
        runner: runnerFor(report(qualified("B-01"))),
      },
      ctx,
    );
    expect(noIssue).toMatchObject({
      status: "FAIL",
      failureKind: "CONFIGURATION",
    });
    expect(noIssue.detail).toContain("GitHub issue number");
  });

  it("[behavior:#85:B-05] throws on an unreadable manifest and passes one binding nothing", async () => {
    await expect(
      runAcceptanceGate(
        {
          absSliceDir: sliceDir("{ not json"),
          issueNumber: ISSUE_NUMBER,
          plan: PLAN,
        },
        ctx,
      ),
    ).rejects.toThrow();
    await expect(
      runAcceptanceGate(
        {
          absSliceDir: sliceDir(null),
          issueNumber: ISSUE_NUMBER,
          plan: PLAN,
        },
        ctx,
      ),
    ).rejects.toThrow();

    const outcome = await runAcceptanceGate(
      {
        absSliceDir: sliceDir({
          ...manifestBinding("B-01"),
          behaviors: [behavior("B-01", ["tests"])],
        }),
        issueNumber: ISSUE_NUMBER,
        plan: PLAN,
      },
      ctx,
    );
    expect(outcome).toMatchObject({ status: "PASS", failureKind: null });
  });

  it("[behavior:#85:B-05] finds the shared reporter document behind package-manager noise", async () => {
    const document = report(qualified("B-01"), qualified("B-02"));
    const outcome = await runAcceptanceGate(
      {
        absSliceDir: sliceDir(manifestBinding("B-01", "B-02")),
        issueNumber: ISSUE_NUMBER,
        plan: PLAN,
        runner: async () => ({
          output:
            `> vitest run\n{"not":"a document"}\n` +
            `stderr noise ${JSON.stringify(document)}`,
        }),
      },
      ctx,
    );
    expect(outcome.status).toBe("PASS");
  });

  it("[behavior:#85:B-06] reports one record per behavior from the one execution", async () => {
    const records: BehaviorCoverageRecord[] = [];
    let invocations = 0;
    await runAcceptanceGate(
      {
        absSliceDir: sliceDir(manifestBinding("B-01", "B-02", "B-03")),
        issueNumber: ISSUE_NUMBER,
        plan: PLAN,
        runner: async () => {
          invocations += 1;
          return {
            output: JSON.stringify(
              report(qualified("B-01"), qualified("B-03", "failed")),
            ),
          };
        },
        onBehaviorResult: (record) => records.push(record),
      },
      ctx,
    );
    expect(invocations).toBe(1);
    expect(records).toEqual([
      { behaviorId: "B-01", status: "covered", matched: 1, passed: 1, failed: 0 },
      { behaviorId: "B-02", status: "untested", matched: 0, passed: 0, failed: 0 },
      { behaviorId: "B-03", status: "failed", matched: 1, passed: 0, failed: 1 },
    ]);
  });
});

describe("this repository as the gate's own project", () => {
  it("[behavior:#85:B-07] resolves a plan whose command is the declared runner", () => {
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

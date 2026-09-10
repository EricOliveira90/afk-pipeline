/**
 * The test-cost half of the gate catalog: `resolveTestCostPlan` (the only
 * production reader of `gatePolicy.cost`), the cheap-gate catalog derived from
 * it, and the environment-sensitive declaration that is deliberately assembled
 * *outside* the sanity plan.
 *
 * Every case here is a directory with a `package.json` and maybe a policy file
 * — no pipeline, no spawned command.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveAcceptancePlan,
  resolveBaseGateDeclarations,
  resolveBindableGateCatalog,
  resolveCheapGateCatalog,
  resolveFullSuiteGateDeclarations,
  resolvePreQAGateDeclarations,
  resolveTestCostPlan,
} from "./base-gates.js";
import {
  DEFAULT_CACHE_ENABLED,
  DEFAULT_CHEAP_THRESHOLD_MS,
  DEFAULT_SKIP_DETECTORS,
  DEFAULT_TEST_GLOBS,
  loadGatePolicy,
} from "./gate-policy.js";
import { ACCEPTANCE_GATE_ID } from "./gate-runner.js";
import {
  resolveCandidateQACommands,
  resolveSanityCommands,
} from "./preship.js";

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** This repo's own script set, which is what the self-run reasoning is about. */
const AFK_SCRIPTS = {
  typecheck: "tsc --noEmit",
  test: "vitest run",
  "test:budgets": "node scripts/check-suite-budgets.mjs",
};

function makeProject(
  scripts: Record<string, string>,
  policy?: unknown,
): string {
  const dir = mkdtempSync(join(tmpdir(), "afk-base-gates-"));
  tempDirs.push(dir);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "fixture", scripts }, null, 2),
    "utf-8",
  );
  if (policy !== undefined) {
    writeFileSync(
      join(dir, "afk.config.json"),
      JSON.stringify({ gatePolicy: policy }, null, 2),
      "utf-8",
    );
  }
  return dir;
}

describe("resolveTestCostPlan", () => {
  it("[behavior:B-01] applies every default when the project declares no cost block", () => {
    const dir = makeProject(AFK_SCRIPTS);
    expect(resolveTestCostPlan(dir)).toEqual({
      cheapThresholdMs: DEFAULT_CHEAP_THRESHOLD_MS,
      environmentSensitive: [],
      cacheEnabled: DEFAULT_CACHE_ENABLED,
      skipDetectors: DEFAULT_SKIP_DETECTORS,
      testFileGlobs: DEFAULT_TEST_GLOBS,
    });
    expect(DEFAULT_CHEAP_THRESHOLD_MS).toBe(120_000);
    expect(DEFAULT_CACHE_ENABLED).toBe(true);
    // AFK ships the vitest detector, so a TypeScript project that declares
    // nothing still gets a working skip gate.
    expect(DEFAULT_SKIP_DETECTORS.map((detector) => detector.id)).toEqual([
      "vitest-ts",
    ]);
  });

  it("[behavior:P-01] keeps today's behavior with no policy file at all", () => {
    const dir = makeProject(AFK_SCRIPTS);
    expect(loadGatePolicy(dir)).toBe(null);
    const plan = resolveTestCostPlan(dir);
    expect(plan.cacheEnabled).toBe(true);
    expect(plan.environmentSensitive).toEqual([]);
    // Nothing declared means no advisory gate, so the full-suite phase is
    // exactly what it was before this slice.
    expect(
      resolveFullSuiteGateDeclarations(dir).map((gate) => gate.id),
    ).toEqual(["tests"]);
  });

  it("[behavior:B-01] threads every declared cost member from one read", () => {
    const dir = makeProject(AFK_SCRIPTS, {
      version: 1,
      cost: {
        cheapThresholdMs: 30_000,
        environmentSensitive: ["test:budgets"],
        cacheEnabled: false,
        relatedTests: { command: "pnpm", args: ["vitest", "related"] },
        skipDetectors: [
          {
            id: "rspec",
            testGlobs: ["spec/**/*_spec.rb"],
            patterns: ["xit ", "pending "],
          },
        ],
      },
      protectedPaths: { testGlobs: ["spec/**/*_spec.rb"] },
    });
    expect(resolveTestCostPlan(dir)).toEqual({
      cheapThresholdMs: 30_000,
      environmentSensitive: ["test:budgets"],
      cacheEnabled: false,
      relatedTests: { command: "pnpm", args: ["vitest", "related"] },
      skipDetectors: [
        {
          id: "rspec",
          testGlobs: ["spec/**/*_spec.rb"],
          patterns: ["xit ", "pending "],
        },
      ],
      testFileGlobs: ["spec/**/*_spec.rb"],
    });
  });

  it("[behavior:B-01] stamps expected cost and prerequisites on the phase declarations only", () => {
    const dir = makeProject(AFK_SCRIPTS);
    expect(resolvePreQAGateDeclarations(dir)).toEqual([
      {
        id: "typecheck",
        stage: "base",
        required: true,
        command: "pnpm",
        args: ["run", "typecheck"],
        expectedCostMs: 20_000,
      },
      { id: "lint", stage: "base", required: false, expectedCostMs: 20_000 },
    ]);
    // `tests` declares `typecheck` as its prerequisite: a tree that does not
    // compile cannot produce a meaningful suite result (B-07).
    expect(resolveFullSuiteGateDeclarations(dir)).toEqual([
      {
        id: "tests",
        stage: "base",
        required: true,
        command: "pnpm",
        args: ["run", "test"],
        expectedCostMs: 420_000,
        prerequisiteGateIds: ["typecheck"],
      },
    ]);
    // And not on the base declarations, whose other consumer is the bindable
    // catalog a locked manifest compares against.
    for (const declaration of resolveBaseGateDeclarations(dir)) {
      expect(declaration.expectedCostMs).toBeUndefined();
      expect(declaration.prerequisiteGateIds).toBeUndefined();
    }
  });

  it("[behavior:B-05] derives the cheap-gate catalog by cost, excluding the full suite by identity", () => {
    const dir = makeProject(AFK_SCRIPTS);
    expect(resolveCheapGateCatalog(dir)).toEqual([
      {
        id: "typecheck",
        required: true,
        command: "pnpm",
        args: ["run", "typecheck"],
      },
      { id: "lint", required: false },
    ]);
    // A threshold below every gate's expected cost empties the catalog rather
    // than falling back to the suite.
    const strict = makeProject(AFK_SCRIPTS, {
      version: 1,
      cost: { cheapThresholdMs: 1 },
    });
    expect(resolveCheapGateCatalog(strict)).toEqual([]);
  });

  it("[behavior:B-02] declares test:budgets outside the sanity plan, advisory and after the suite", () => {
    const dir = makeProject(AFK_SCRIPTS, {
      version: 1,
      cost: { environmentSensitive: ["test:budgets"] },
    });
    const declarations = resolveFullSuiteGateDeclarations(dir);
    expect(declarations.map((gate) => gate.id)).toEqual([
      "tests",
      "test:budgets",
    ]);
    expect(declarations[1]).toEqual({
      id: "test:budgets",
      stage: "base",
      required: false,
      environmentSensitive: true,
      command: "pnpm",
      args: ["run", "test:budgets"],
      expectedCostMs: 5_000,
      prerequisiteGateIds: ["tests"],
    });

    // ADR 0063: a budget overage can never fail a gate. `required: false` is
    // the whole mechanism, and the three readers that know nothing about
    // `GateDeclaration` never see the command at all.
    expect(resolveSanityCommands(dir)).toEqual([
      "pnpm run typecheck",
      "pnpm run test",
    ]);
    expect(resolveCandidateQACommands(dir)).toEqual(["pnpm run typecheck"]);
    for (const list of [resolveSanityCommands(dir), resolveCandidateQACommands(dir)]) {
      expect(list.join(" ")).not.toContain("test:budgets");
    }
    // Nor can a manifest behavior bind its proof to it.
    expect(resolveBindableGateCatalog(dir).map((gate) => gate.id)).not.toContain(
      "test:budgets",
    );
    expect(resolveCheapGateCatalog(dir).map((gate) => gate.id)).not.toContain(
      "test:budgets",
    );
    // Declared but with no such script: no declaration rather than a
    // commandless one, so `package.json` needs no change to opt out.
    const scriptless = makeProject(
      { typecheck: "tsc --noEmit", test: "vitest run" },
      { version: 1, cost: { environmentSensitive: ["test:budgets"] } },
    );
    expect(
      resolveFullSuiteGateDeclarations(scriptless).map((gate) => gate.id),
    ).toEqual(["tests"]);
  });

  it("[behavior:P-02] leaves the sanity plan's step names and order alone", () => {
    const dir = makeProject(AFK_SCRIPTS, {
      version: 1,
      cost: { environmentSensitive: ["test:budgets"] },
    });
    // ADR 0012's single source is untouched: three steps, same names, same
    // order, whatever the cost policy says.
    expect(resolveBaseGateDeclarations(dir).map((gate) => gate.id)).toEqual([
      "typecheck",
      "lint",
      "tests",
    ]);
    expect(resolvePreQAGateDeclarations(dir).map((gate) => gate.id)).toEqual([
      "typecheck",
      "lint",
    ]);
  });

  it("[behavior:P-04] keeps the acceptance plan and bindable catalog answering as they did, and still throws on a malformed policy", () => {
    const dir = makeProject(AFK_SCRIPTS, {
      version: 1,
      cost: { environmentSensitive: ["test:budgets"], cacheEnabled: false },
    });
    expect(resolveAcceptancePlan(dir)).toEqual({
      command: "pnpm",
      args: [
        "exec",
        "vitest",
        "run",
        "--reporter=json",
        "--testNamePattern",
        "{behaviorId}",
      ],
      matcher: "vitest-json",
    });
    expect(resolveBindableGateCatalog(dir).map((gate) => gate.id)).toEqual([
      "typecheck",
      "lint",
      "tests",
      ACCEPTANCE_GATE_ID,
    ]);

    const malformed = makeProject(AFK_SCRIPTS, {
      version: 1,
      cost: { cheapThresholdMs: "fast" },
    });
    expect(() => resolveTestCostPlan(malformed)).toThrow(/cheapThresholdMs/);
    expect(() => resolveAcceptancePlan(malformed)).toThrow(/cheapThresholdMs/);
  });
});

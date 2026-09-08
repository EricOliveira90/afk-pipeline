import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resolveBaseGateDeclarations } from "./base-gates.js";
import * as gatePolicyModule from "./gate-policy.js";
import {
  DEFAULT_GATE_POLICY_PATHS,
  DEFAULT_TEST_GLOBS,
  GATE_RISK_CLASSES,
  loadGatePolicy,
  matchesGlob,
  parseGatePolicy,
} from "./gate-policy.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const MODULE_SOURCE_PATH = fileURLToPath(
  new URL("./gate-policy.ts", import.meta.url),
);

/** prd.md D1's example policy, the shape this repo's own config carries. */
const EXAMPLE_POLICY = {
  version: 1,
  protectedPaths: {
    gatePolicyPaths: ["afk.config.json", "suite-budgets.json"],
    testGlobs: ["**/*.test.ts"],
  },
  riskClasses: ["gate-policy", "deleted-test", "skipped-test"],
} as const;

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(config?: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "gate-policy-"));
  roots.push(root);
  if (config !== undefined) {
    writeFileSync(
      join(root, "afk.config.json"),
      `${JSON.stringify(config, null, 2)}\n`,
      "utf-8",
    );
  }
  return root;
}

function messageOf(call: () => unknown): string {
  try {
    call();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the call to throw");
}

describe("gate-policy module surface", () => {
  it("B-01 exports exactly the pinned runtime surface", () => {
    expect(Object.keys(gatePolicyModule).sort()).toEqual([
      "DEFAULT_GATE_POLICY_PATHS",
      "DEFAULT_TEST_GLOBS",
      "GATE_RISK_CLASSES",
      "loadGatePolicy",
      "matchesGlob",
      "parseGatePolicy",
    ]);
  });
});

describe("parseGatePolicy", () => {
  it("B-02 accepts the documented example policy unchanged", () => {
    expect(parseGatePolicy(structuredClone(EXAMPLE_POLICY))).toEqual({
      version: 1,
      protectedPaths: {
        gatePolicyPaths: ["afk.config.json", "suite-budgets.json"],
        testGlobs: ["**/*.test.ts"],
      },
      riskClasses: ["gate-policy", "deleted-test", "skipped-test"],
    });
  });

  it("B-03 fills omitted members with the documented baselines", () => {
    const baseline = {
      version: 1,
      protectedPaths: {
        gatePolicyPaths: ["afk.config.json", "suite-budgets.json"],
        testGlobs: ["**/*.test.ts"],
      },
      riskClasses: ["gate-policy", "deleted-test", "skipped-test"],
    };

    expect(parseGatePolicy({ version: 1 })).toEqual(baseline);
    expect(
      parseGatePolicy({
        version: 1,
        riskClasses: ["gate-policy", "deleted-test", "skipped-test"],
      }),
    ).toEqual(baseline);
    expect(
      parseGatePolicy({
        version: 1,
        protectedPaths: {
          gatePolicyPaths: ["afk.config.json", "suite-budgets.json"],
          testGlobs: ["**/*.test.ts"],
        },
      }),
    ).toEqual(baseline);
    expect(
      parseGatePolicy({
        version: 1,
        protectedPaths: {
          gatePolicyPaths: ["afk.config.json", "suite-budgets.json"],
        },
      }),
    ).toEqual(baseline);
  });

  it("B-03 returns copies, so a mutating caller cannot reach the constants", () => {
    const policy = parseGatePolicy({ version: 1 });
    policy.protectedPaths.gatePolicyPaths.push("mutated.json");
    policy.protectedPaths.testGlobs.push("**/*.spec.ts");
    policy.riskClasses.length = 0;

    expect(DEFAULT_GATE_POLICY_PATHS).toEqual([
      "afk.config.json",
      "suite-budgets.json",
    ]);
    expect(DEFAULT_TEST_GLOBS).toEqual(["**/*.test.ts"]);
    expect(GATE_RISK_CLASSES).toEqual([
      "gate-policy",
      "deleted-test",
      "skipped-test",
    ]);
  });

  it("B-04 refuses a malformed policy naming the offending key", () => {
    expect(() => parseGatePolicy(null)).toThrow(/gatePolicy/);
    expect(() => parseGatePolicy("policy")).toThrow(/gatePolicy/);
    expect(() =>
      parseGatePolicy({ version: 1, protectedPaths: [] }),
    ).toThrow(/protectedPaths/);
    expect(() =>
      parseGatePolicy({ version: 1, protectedPaths: "afk.config.json" }),
    ).toThrow(/protectedPaths/);
    expect(() =>
      parseGatePolicy({
        version: 1,
        protectedPaths: { gatePolicyPaths: [7] },
      }),
    ).toThrow(/gatePolicyPaths/);
    expect(() =>
      parseGatePolicy({ version: 1, riskClasses: {} }),
    ).toThrow(/riskClasses/);
  });

  it("B-05 refuses an unknown member naming it", () => {
    expect(
      messageOf(() =>
        parseGatePolicy({ ...structuredClone(EXAMPLE_POLICY), cost: {} }),
      ),
    ).toContain("cost");
    expect(
      messageOf(() =>
        parseGatePolicy({ ...structuredClone(EXAMPLE_POLICY), acceptance: {} }),
      ),
    ).toContain("acceptance");
    expect(
      messageOf(() =>
        parseGatePolicy({ ...structuredClone(EXAMPLE_POLICY), typo: 1 }),
      ),
    ).toContain("typo");
    expect(
      messageOf(() =>
        parseGatePolicy({
          version: 1,
          protectedPaths: { testGlob: ["**/*.test.ts"] },
        }),
      ),
    ).toContain('"testGlob"');
  });

  it("B-06 refuses a gatePolicy.version that is absent, 2 or a string", () => {
    expect(() => parseGatePolicy({ protectedPaths: {} })).toThrow(/version/);
    expect(() => parseGatePolicy({ version: 2 })).toThrow(/version/);
    expect(() => parseGatePolicy({ version: "1" })).toThrow(/version/);
  });

  it("B-06 checks gatePolicy.version independently of the file's own version", () => {
    const root = tempRoot({
      version: 1,
      resourceKeys: {},
      gatePolicy: { version: 2 },
    });
    expect(() => loadGatePolicy(root)).toThrow(/version/);
  });

  it("B-07 refuses an unrecognised risk class naming it", () => {
    expect(
      messageOf(() =>
        parseGatePolicy({
          version: 1,
          riskClasses: ["gate-policy", "gatePolicy"],
        }),
      ),
    ).toContain("gatePolicy");
    expect(
      messageOf(() =>
        parseGatePolicy({ version: 1, riskClasses: ["deleted-tests"] }),
      ),
    ).toContain("deleted-tests");
    expect(GATE_RISK_CLASSES).toEqual([
      "gate-policy",
      "deleted-test",
      "skipped-test",
    ]);
  });
});

describe("loadGatePolicy", () => {
  it("B-08 returns the validated policy, null for no policy, and throws on a malformed one", () => {
    const withPolicy = tempRoot({
      version: 1,
      gatePolicy: structuredClone(EXAMPLE_POLICY),
    });
    expect(loadGatePolicy(withPolicy)).toEqual({
      version: 1,
      protectedPaths: {
        gatePolicyPaths: ["afk.config.json", "suite-budgets.json"],
        testGlobs: ["**/*.test.ts"],
      },
      riskClasses: ["gate-policy", "deleted-test", "skipped-test"],
    });

    expect(loadGatePolicy(tempRoot())).toBeNull();
    expect(
      loadGatePolicy(tempRoot({ version: 1, architectureDoc: "ARCHITECTURE.md" })),
    ).toBeNull();

    const malformed = tempRoot({
      version: 1,
      gatePolicy: { ...structuredClone(EXAMPLE_POLICY), cost: {} },
    });
    expect(messageOf(() => loadGatePolicy(malformed))).toContain("cost");
  });
});

describe("matchesGlob", () => {
  it("B-09 implements the D6 dialect over segments", () => {
    expect(matchesGlob("**/*.test.ts", "src/deep/nested/a.test.ts")).toBe(true);
    expect(matchesGlob("**/*.test.ts", "a.test.ts")).toBe(true);
    expect(matchesGlob("**/*.test.ts", "src/gate-policy.ts")).toBe(false);
    expect(matchesGlob("**/*.test.ts", "src\\deep\\a.test.ts")).toBe(true);

    expect(matchesGlob("src/*.test.ts", "src/a.test.ts")).toBe(true);
    expect(matchesGlob("src/*.test.ts", "src/deep/a.test.ts")).toBe(false);
  });

  it("B-10 compares case-sensitively on every platform", () => {
    expect(matchesGlob("**/*.test.ts", "src/a.Test.ts")).toBe(false);
    expect(matchesGlob("**/*.test.ts", "SRC/a.test.ts")).toBe(true);
    expect(matchesGlob("src/Gate.ts", "src/gate.ts")).toBe(false);
  });

  it("B-10 folds no case, so the rule cannot become platform-dependent", () => {
    const source = readFileSync(MODULE_SOURCE_PATH, "utf-8");
    expect(source).not.toContain("toLowerCase");
    expect(source).not.toContain("toUpperCase");
  });

  it("B-11 refuses every glob outside the dialect from both entry points", () => {
    const rejections: [glob: string, named: string][] = [
      ["src/?.ts", "?"],
      ["src/[ab].ts", "["],
      ["src/a].ts", "]"],
      ["src/{a,b}.ts", "{"],
      ["src/a}.ts", "}"],
      ["src/(a).ts", "("],
      ["src/a).ts", ")"],
      ["src/!a.ts", "!"],
      ["src/a+.ts", "+"],
      ["src/a@.ts", "@"],
      ["src\\a.ts", "\\"],
      ["src/***.ts", "***.ts"],
      ["a**/b.ts", "a**"],
    ];

    for (const [glob, named] of rejections) {
      expect(messageOf(() => matchesGlob(glob, "src/a.ts"))).toContain(named);
      expect(
        messageOf(() =>
          parseGatePolicy({
            version: 1,
            protectedPaths: { testGlobs: [glob] },
          }),
        ),
      ).toContain(named);
    }
  });
});

describe("this repository's own afk.config.json", () => {
  it("B-12 carries prd.md D1's example gatePolicy, which loads validated", () => {
    expect(loadGatePolicy(REPO_ROOT)).toEqual({
      version: 1,
      protectedPaths: {
        gatePolicyPaths: ["afk.config.json", "suite-budgets.json"],
        testGlobs: ["**/*.test.ts"],
      },
      riskClasses: ["gate-policy", "deleted-test", "skipped-test"],
    });
  });

  it("P-02 leaves version, resourceKeys and architectureDoc untouched", () => {
    const config = JSON.parse(
      readFileSync(join(REPO_ROOT, "afk.config.json"), "utf-8"),
    ) as Record<string, unknown>;

    expect(config.version).toBe(1);
    expect(config.architectureDoc).toBe("ARCHITECTURE.md");
    expect(config.resourceKeys).toEqual({
      "orchestrator-core": "^src/(orchestrator|wave)\\.ts$",
    });
    expect(Object.keys(config).sort()).toEqual([
      "architectureDoc",
      "gatePolicy",
      "resourceKeys",
      "version",
    ]);
  });
});

describe("the policy-less fallback", () => {
  it("P-01 keeps today's derived baseline catalog when no policy exists", () => {
    const root = tempRoot();
    expect(resolveBaseGateDeclarations(root).map((d) => d.id)).toEqual([
      "typecheck",
      "lint",
      "tests",
    ]);
    expect(loadGatePolicy(root)).toBeNull();
  });

  it("P-03 keeps the two case rules two implementations", () => {
    const source = readFileSync(MODULE_SOURCE_PATH, "utf-8");
    expect(source).not.toContain('from "./acceptance-manifest.js"');
    expect(source).not.toContain("toLowerCase");
  });
});

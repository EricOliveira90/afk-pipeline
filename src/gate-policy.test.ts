import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  BEHAVIOR_ID_TOKEN,
  resolveAcceptancePlan,
  resolveBaseGateDeclarations,
} from "./base-gates.js";
import * as gatePolicyModule from "./gate-policy.js";
import {
  DEFAULT_CACHE_ENABLED,
  DEFAULT_CHEAP_THRESHOLD_MS,
  DEFAULT_GATE_POLICY_PATHS,
  DEFAULT_SKIP_DETECTORS,
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
    // The three `DEFAULT_*` cost baselines joined the surface with #86's
    // `cost` member: `resolveTestCostPlan` needs them by name to fill an
    // omitted block, and the tests that assert a default read the constant
    // rather than restating the number.
    expect(Object.keys(gatePolicyModule).sort()).toEqual([
      "DEFAULT_CACHE_ENABLED",
      "DEFAULT_CHEAP_THRESHOLD_MS",
      "DEFAULT_GATE_POLICY_PATHS",
      "DEFAULT_SKIP_DETECTORS",
      "DEFAULT_TEST_GLOBS",
      // `GATE_POLICY_CONFIG_FILENAME` joined the surface with #251: the
      // feedback-integrity gate names the candidate's own copy of the policy
      // when it diverges from the run's, and the filename is this module's fact.
      "GATE_POLICY_CONFIG_FILENAME",
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

  /**
   * `acceptance: {}` used to live in B-05 below as an unknown key. Slice 02
   * (#85) widened `POLICY_KEYS`, so it is now a *known* member refused for its
   * missing sub-members — the assertion moved here rather than disappearing.
   * Slice 05 (#86) did the same to `cost`, whose own cases live in
   * "parseGatePolicy's cost member" below.
   */
  it("B-05 refuses an unknown member naming it", () => {
    expect(
      messageOf(() =>
        parseGatePolicy({ ...structuredClone(EXAMPLE_POLICY), costs: {} }),
      ),
    ).toContain("costs");
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

  it("B-01 accepts the anchors file's acceptance member, and leaves it absent when omitted", () => {
    const acceptance = {
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
    };
    expect(
      parseGatePolicy({ ...structuredClone(EXAMPLE_POLICY), acceptance }),
    ).toEqual({ ...structuredClone(EXAMPLE_POLICY), acceptance });

    // Omission is the signal `src/base-gates.ts` reads as "derive the
    // baseline", so it must not arrive as an explicit `undefined` key.
    const withoutMember = parseGatePolicy(structuredClone(EXAMPLE_POLICY));
    expect("acceptance" in withoutMember).toBe(false);
  });

  it("B-01 refuses a non-object, missing, unknown or blank acceptance member naming the offender", () => {
    const wellFormed = {
      command: "pnpm",
      args: ["exec", "vitest", "--testNamePattern", "{behaviorId}"],
      matcher: "vitest-json",
    };
    const refuse = (acceptance: unknown): string =>
      messageOf(() =>
        parseGatePolicy({ ...structuredClone(EXAMPLE_POLICY), acceptance }),
      );

    for (const notAnObject of [null, 7, "pnpm test", ["pnpm"], true]) {
      expect(refuse(notAnObject)).toContain("acceptance");
    }
    // Every member is mandatory: there is nothing to default a runner to.
    expect(refuse({})).toContain('"command"');
    expect(refuse({})).toContain('"args"');
    expect(refuse({})).toContain('"matcher"');
    const { command: _command, ...noCommand } = wellFormed;
    expect(refuse(noCommand)).toContain('"command"');
    expect(refuse({ ...wellFormed, runner: "vitest" })).toContain('"runner"');

    expect(refuse({ ...wellFormed, command: "" })).toContain("command");
    expect(refuse({ ...wellFormed, command: "  " })).toContain("command");
    expect(refuse({ ...wellFormed, command: 7 })).toContain("command");
    expect(refuse({ ...wellFormed, args: "exec vitest" })).toContain("args");
    expect(refuse({ ...wellFormed, args: [] })).toContain("args");
    expect(refuse({ ...wellFormed, args: ["exec", " "] })).toContain("args");
  });

  it("B-01 refuses args with no literal {behaviorId} token, naming the key", () => {
    const refuse = (args: string[]): string =>
      messageOf(() =>
        parseGatePolicy({
          ...structuredClone(EXAMPLE_POLICY),
          acceptance: { command: "pnpm", args, matcher: "vitest-json" },
        }),
      );

    // Without the token every behavior would run the same unfiltered suite and
    // all of them would report as covered.
    expect(refuse(["exec", "vitest", "run"])).toContain(
      "gatePolicy.acceptance.args",
    );
    expect(refuse(["exec", "vitest", "run"])).toContain("{behaviorId}");
    expect(refuse(["--testNamePattern", "{behaviourId}"])).toContain(
      "{behaviorId}",
    );
    expect(refuse(["--testNamePattern", "behaviorId"])).toContain(
      "{behaviorId}",
    );

    // The token is literal, not the D6 glob dialect that refuses `{` and `}`:
    // a substring occurrence is enough, and no glob check runs over it.
    expect(
      parseGatePolicy({
        ...structuredClone(EXAMPLE_POLICY),
        acceptance: {
          command: "pnpm",
          args: ["exec", "vitest", "--testNamePattern=^{behaviorId}$"],
          matcher: "vitest-json",
        },
      }).acceptance?.args,
    ).toEqual(["exec", "vitest", "--testNamePattern=^{behaviorId}$"]);
  });

  it("B-01 refuses a matcher other than vitest-json, naming it", () => {
    const refuse = (matcher: unknown): string =>
      messageOf(() =>
        parseGatePolicy({
          ...structuredClone(EXAMPLE_POLICY),
          acceptance: {
            command: "pnpm",
            args: ["--testNamePattern", "{behaviorId}"],
            matcher,
          },
        }),
      );

    expect(refuse("jest-json")).toContain("jest-json");
    expect(refuse("vitest")).toContain("vitest-json");
    expect(refuse("VITEST-JSON")).toContain("VITEST-JSON");
    expect(refuse(7)).toContain("matcher");
  });

  it("B-01 spells {behaviorId} the same way src/base-gates.ts substitutes it", () => {
    // The token is declared in both modules — the config reader must not
    // import the gate modules it configures — so the two spellings are pinned
    // together rather than trusted to stay in sync.
    expect(readFileSync(MODULE_SOURCE_PATH, "utf-8")).toContain(
      `const BEHAVIOR_ID_TOKEN = "${BEHAVIOR_ID_TOKEN}"`,
    );
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

/**
 * `gatePolicy.cost` (#86 B-01). The reader is the only place these members are
 * validated, so every wrong type is asserted here as a named message rather
 * than through a gate that would have to run first to discover it.
 */
describe("parseGatePolicy's cost member", () => {
  it("[behavior:B-01] fills every omitted cost member with the documented default", () => {
    // `cost: {}` is legal and means exactly the defaults, so a project can
    // declare the block to hold one member without restating the rest.
    expect(parseGatePolicy({ version: 1, cost: {} }).cost).toEqual({
      cheapThresholdMs: DEFAULT_CHEAP_THRESHOLD_MS,
      environmentSensitive: [],
      cacheEnabled: DEFAULT_CACHE_ENABLED,
      skipDetectors: DEFAULT_SKIP_DETECTORS.map((detector) => ({
        id: detector.id,
        testGlobs: [...detector.testGlobs],
        patterns: [...detector.patterns],
      })),
    });
    // `relatedTests` has no default: an absent member means the feature is off,
    // which a fabricated command could not express.
    expect(parseGatePolicy({ version: 1, cost: {} }).cost?.relatedTests).toBe(
      undefined,
    );
    // Omitting the block entirely leaves it absent, so the policy-less and
    // cost-less paths stay one path in every consumer.
    expect(parseGatePolicy({ version: 1 }).cost).toBe(undefined);
  });

  it("[behavior:B-01] returns copies, so a caller mutating the plan cannot reach the baselines", () => {
    const parsed = parseGatePolicy({ version: 1, cost: {} });
    parsed.cost!.skipDetectors[0]!.patterns.push("mutated");
    parsed.cost!.skipDetectors.push({
      id: "extra",
      testGlobs: ["**/*.x"],
      patterns: ["y"],
    });
    expect(DEFAULT_SKIP_DETECTORS).toHaveLength(1);
    expect(DEFAULT_SKIP_DETECTORS[0]!.patterns).not.toContain("mutated");
  });

  it("[behavior:B-01] accepts a fully declared cost block verbatim", () => {
    expect(
      parseGatePolicy({
        version: 1,
        cost: {
          cheapThresholdMs: 0,
          environmentSensitive: ["test:budgets"],
          cacheEnabled: false,
          relatedTests: { command: "pnpm", args: ["vitest", "related"] },
          skipDetectors: [
            {
              id: "rspec",
              testGlobs: ["spec/**/*_spec.rb"],
              patterns: ["xit ", "\\bpending\\b"],
            },
          ],
        },
      }).cost,
    ).toEqual({
      // Zero is a legal threshold: it means "no gate is cheap enough".
      cheapThresholdMs: 0,
      environmentSensitive: ["test:budgets"],
      cacheEnabled: false,
      relatedTests: { command: "pnpm", args: ["vitest", "related"] },
      skipDetectors: [
        {
          id: "rspec",
          testGlobs: ["spec/**/*_spec.rb"],
          patterns: ["xit ", "\\bpending\\b"],
        },
      ],
    });
  });

  it("[behavior:B-01] refuses an unknown cost sub-key naming it", () => {
    expect(
      messageOf(() =>
        parseGatePolicy({ version: 1, cost: { cacheEnable: true } }),
      ),
    ).toContain("cacheEnable");
    expect(
      messageOf(() =>
        parseGatePolicy({
          version: 1,
          cost: {
            skipDetectors: [
              { id: "x", testGlobs: ["**/*.test.ts"], pattern: ["it.skip"] },
            ],
          },
        }),
      ),
    ).toContain("pattern");
    expect(
      messageOf(() =>
        parseGatePolicy({
          version: 1,
          cost: { relatedTests: { command: "pnpm", args: [], cwd: "." } },
        }),
      ),
    ).toContain("cwd");
  });

  it("[behavior:B-01] refuses every wrong type naming the offending key", () => {
    const refusals: [unknown, string][] = [
      [{ cost: [] }, "gatePolicy.cost"],
      [{ cost: { cheapThresholdMs: "fast" } }, "cheapThresholdMs"],
      [{ cost: { cheapThresholdMs: -1 } }, "cheapThresholdMs"],
      [{ cost: { cheapThresholdMs: 1.5 } }, "cheapThresholdMs"],
      [{ cost: { cacheEnabled: "yes" } }, "cacheEnabled"],
      [{ cost: { environmentSensitive: "test:budgets" } }, "environmentSensitive"],
      [{ cost: { environmentSensitive: [7] } }, "environmentSensitive"],
      [{ cost: { relatedTests: "pnpm vitest related" } }, "relatedTests"],
      [{ cost: { relatedTests: { command: " ", args: [] } } }, "command"],
      [{ cost: { skipDetectors: {} } }, "skipDetectors"],
      [{ cost: { skipDetectors: [null] } }, "skipDetectors[0]"],
    ];
    for (const [policy, named] of refusals) {
      expect(
        messageOf(() => parseGatePolicy({ version: 1, ...(policy as object) })),
      ).toContain(named);
    }
  });

  it("[behavior:B-01] refuses a detector that can never fire, a bad glob, a bad pattern and a duplicate id", () => {
    function refuse(detector: unknown): string {
      return messageOf(() =>
        parseGatePolicy({ version: 1, cost: { skipDetectors: [detector] } }),
      );
    }
    // No pattern and no glob both mean the detector reports every candidate
    // clean, which is the silent pass this reader exists to refuse.
    expect(refuse({ id: "x", testGlobs: ["**/*.test.ts"], patterns: [] })).toContain(
      "patterns",
    );
    expect(refuse({ id: "x", testGlobs: [], patterns: ["it.skip"] })).toContain(
      "testGlobs",
    );
    expect(refuse({ id: " ", testGlobs: ["**/*.test.ts"], patterns: ["a"] })).toContain(
      "id",
    );
    // Globs go through the same D6 dialect check as every other policy glob.
    expect(
      refuse({ id: "x", testGlobs: ["src/**test.ts"], patterns: ["a"] }),
    ).toContain("src/**test.ts");
    // And a pattern that cannot compile is a configuration defect now, not a
    // thrown regular expression at gate time.
    expect(
      refuse({ id: "x", testGlobs: ["**/*.test.ts"], patterns: ["it.skip("] }),
    ).toContain("it.skip(");

    expect(
      messageOf(() =>
        parseGatePolicy({
          version: 1,
          cost: {
            skipDetectors: [
              { id: "dup", testGlobs: ["**/*.test.ts"], patterns: ["it.skip"] },
              { id: "dup", testGlobs: ["**/*.spec.ts"], patterns: ["it.todo"] },
            ],
          },
        }),
      ),
    ).toContain("dup");
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
      gatePolicy: { ...structuredClone(EXAMPLE_POLICY), costs: {} },
    });
    expect(messageOf(() => loadGatePolicy(malformed))).toContain("costs");
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
      // Added by slice 02 (#85): this repo declares its own acceptance runner,
      // so B-02's declared branch — not its derived baseline — is the live one
      // whenever AFK runs on itself.
      acceptance: {
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
      },
    });
  });

  it("B-07 declares the anchors file's acceptance shape, which resolves as the plan", () => {
    const declared = loadGatePolicy(REPO_ROOT)?.acceptance;
    expect(declared).toBeDefined();
    expect(resolveAcceptancePlan(REPO_ROOT)).toEqual({
      command: declared!.command,
      args: declared!.args,
      matcher: "vitest-json",
    });
    // The declared branch wins over the derived baseline. They happen to agree
    // here, so the proof is that the plan is the *policy's* array: mutating the
    // returned copy must not be able to reach it.
    const plan = resolveAcceptancePlan(REPO_ROOT)!;
    expect(plan.args).not.toBe(declared!.args);
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

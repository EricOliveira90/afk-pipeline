import {
  ACCEPTANCE_GATE_ID,
  type GateDeclaration,
} from "./gate-runner.js";
import {
  loadGatePolicy,
  DEFAULT_CACHE_ENABLED,
  DEFAULT_CHEAP_THRESHOLD_MS,
  DEFAULT_SKIP_DETECTORS,
  DEFAULT_TEST_GLOBS,
  type GateAcceptanceMatcher,
  type GatePolicyRelatedTests,
  type GatePolicySkipDetector,
} from "./gate-policy.js";
import {
  resolveSanityPlan,
  resolveScriptStep,
  type CheapGate,
} from "./preship.js";

const BASE_GATE_IDS = ["typecheck", "lint", "tests"] as const;
const PRE_QA_GATE_IDS = ["typecheck", "lint"] as const;
const FULL_SUITE_GATE_IDS = ["tests"] as const;

/**
 * AFK's own gate metadata, as code rather than config (D1's rule, restated for
 * `cost` in this slice's anchors): a consuming project declares its threshold,
 * not AFK's catalog. The figures are order-of-magnitude budgeting inputs, not
 * timeouts — `wallClockTimeoutMs` is what bounds a gate.
 *
 * `tests` is the measured full-suite cost recorded in `CLAUDE.md` (416s on
 * Windows, 2026-08-26), which is exactly why it is not a cheap gate and why
 * D18 keeps it out of the generator's edit cycle.
 */
const GATE_EXPECTED_COST_MS: Readonly<Record<string, number>> = {
  typecheck: 20_000,
  lint: 20_000,
  tests: 420_000,
  "test:budgets": 5_000,
};

/**
 * Declared gate prerequisites (B-07). A dependent whose prerequisite failed is
 * recorded SKIPPED by `runGates` rather than paid for, and the prerequisite is
 * named in the skip.
 *
 * `tests` depends on `typecheck` because a tree that does not compile cannot
 * produce a meaningful suite result; `test:budgets` depends on `tests` because
 * it reads the `.vitest-reports/*.json` the suite writes. A prerequisite that
 * is not part of the phase being run is not a failure — the post-QA phase
 * declares `tests` without `typecheck`, and that phase still runs the suite.
 */
const GATE_PREREQUISITE_IDS: Readonly<Record<string, readonly string[]>> = {
  tests: ["typecheck"],
  "test:budgets": ["tests"],
};

/**
 * The environment-sensitive gates AFK knows how to declare, each backed by a
 * `package.json` script. A gate becomes declared only when the project's
 * `gatePolicy.cost.environmentSensitive` names it *and* the script exists
 * (B-02) — so `package.json` needs no change and today's undeclared
 * `required: false` path stays untouched for everyone else.
 */
const ENVIRONMENT_SENSITIVE_STEPS: readonly {
  gateId: string;
  script: string;
}[] = [{ gateId: "test:budgets", script: "test:budgets" }];

function costMetadata(id: string): Partial<GateDeclaration> {
  const expectedCostMs = GATE_EXPECTED_COST_MS[id];
  const prerequisiteGateIds = GATE_PREREQUISITE_IDS[id];
  return {
    ...(expectedCostMs === undefined ? {} : { expectedCostMs }),
    ...(prerequisiteGateIds === undefined
      ? {}
      : { prerequisiteGateIds: [...prerequisiteGateIds] }),
  };
}

/**
 * `stampCost` is deliberately opt-in. The two phase resolvers want the cost
 * metadata; {@link resolveBaseGateDeclarations} does not, because its one other
 * consumer is {@link resolveBindableGateCatalog}, and a manifest binding is
 * about which gate proves a behavior — budgeting metadata there would be noise
 * a lock-time comparison has to ignore (#86 P-04).
 */
function projectSanityGateDeclarations(
  cwd: string,
  gateIds: readonly (typeof BASE_GATE_IDS)[number][],
  options: { stampCost?: boolean } = {},
): GateDeclaration[] {
  const stepsByGate = new Map(
    resolveSanityPlan(cwd).steps.map((step) => [step.name, step]),
  );

  return gateIds.map((id) => {
    const step = stepsByGate.get(id);
    return {
      id,
      stage: "base",
      required: step != null,
      ...(step ? { command: step.command, args: [...step.args] } : {}),
      ...(options.stampCost ? costMetadata(id) : {}),
    };
  });
}

/**
 * The test-cost half of the policy, resolved once per call site with every
 * default applied. **This is the only production reader of `gatePolicy.cost`**
 * (#86 B-01): declaration assembly, the cheap-gate catalog, the orchestrator's
 * cache options and the skip-gate declaration each take their part from one
 * plan, so two consumers can never disagree about what the project declared.
 *
 * It shares `loadGatePolicy(cwd)` with {@link resolveAcceptancePlan} below, and
 * like it a malformed policy throws rather than degrading to the defaults.
 */
export interface TestCostPlan {
  cheapThresholdMs: number;
  environmentSensitive: readonly string[];
  cacheEnabled: boolean;
  relatedTests?: GatePolicyRelatedTests;
  skipDetectors: readonly GatePolicySkipDetector[];
  /**
   * The project's own declaration of which files are test files
   * (`protectedPaths.testGlobs`), which is the oracle the skip gate uses to
   * fail closed: a declared test file that no detector's `testGlobs` cover is
   * a file this gate cannot speak for (D7).
   */
  testFileGlobs: readonly string[];
}

export function resolveTestCostPlan(cwd: string): TestCostPlan {
  const policy = loadGatePolicy(cwd);
  const cost = policy?.cost;
  return {
    cheapThresholdMs: cost?.cheapThresholdMs ?? DEFAULT_CHEAP_THRESHOLD_MS,
    environmentSensitive: cost?.environmentSensitive ?? [],
    cacheEnabled: cost?.cacheEnabled ?? DEFAULT_CACHE_ENABLED,
    ...(cost?.relatedTests ? { relatedTests: cost.relatedTests } : {}),
    skipDetectors: cost?.skipDetectors ?? DEFAULT_SKIP_DETECTORS,
    testFileGlobs: policy?.protectedPaths.testGlobs ?? DEFAULT_TEST_GLOBS,
  };
}

/**
 * The gates cheap enough for the generator's own edit cycle: a base gate whose
 * `expectedCostMs` is at or below the plan's `cheapThresholdMs`, minus the
 * full-suite gate, which is excluded by identity rather than by cost (D18).
 * `src/preship.ts` derives the verification command from this catalog and
 * validates a `--test-command` override against its required gate ids.
 */
export function resolveCheapGateCatalog(cwd: string): CheapGate[] {
  const { cheapThresholdMs } = resolveTestCostPlan(cwd);
  return projectSanityGateDeclarations(cwd, BASE_GATE_IDS, {
    stampCost: true,
  })
    .filter(
      (declaration) =>
        !FULL_SUITE_GATE_IDS.includes(
          declaration.id as (typeof FULL_SUITE_GATE_IDS)[number],
        ) &&
        declaration.expectedCostMs !== undefined &&
        declaration.expectedCostMs <= cheapThresholdMs,
    )
    .map((declaration) => ({
      id: declaration.id,
      required: declaration.required,
      ...(declaration.command === undefined
        ? {}
        : { command: declaration.command, args: [...(declaration.args ?? [])] }),
    }));
}

/**
 * The environment-sensitive declarations for a project, assembled **outside the
 * sanity plan** (B-02). `required: false` plus `environmentSensitive: true` is
 * the whole gate-phase mechanism: the gate executes, its real status reaches
 * evidence, and `assertGateEvidenceReleasesEvaluation` /
 * `decideCandidateGatePhase` already ignore a non-required gate — no second
 * exclusion path is added anywhere (D16).
 */
function environmentSensitiveDeclarations(cwd: string): GateDeclaration[] {
  const declared = new Set(resolveTestCostPlan(cwd).environmentSensitive);
  return ENVIRONMENT_SENSITIVE_STEPS.flatMap(({ gateId, script }) => {
    if (!declared.has(gateId)) return [];
    const step = resolveScriptStep(cwd, script);
    if (!step) return [];
    return [
      {
        id: gateId,
        stage: "base",
        required: false,
        environmentSensitive: true,
        command: step.command,
        args: [...step.args],
        ...costMetadata(gateId),
      } satisfies GateDeclaration,
    ];
  });
}

/**
 * Derive the policy-less base gate set shared by every agent provider. Reads
 * the same sanity plan the pre-ship gate executes (ADR 0012), so a gate and
 * the aggregate check cannot disagree about which script backs a step.
 */
export function resolveBaseGateDeclarations(
  cwd: string,
): GateDeclaration[] {
  return projectSanityGateDeclarations(cwd, BASE_GATE_IDS);
}

/** Cheap compile/static checks that must pass before candidate QA starts. */
export function resolvePreQAGateDeclarations(
  cwd: string,
): GateDeclaration[] {
  return projectSanityGateDeclarations(cwd, PRE_QA_GATE_IDS, {
    stampCost: true,
  });
}

/**
 * The full slice suite, paid only after candidate QA accepts, followed by any
 * declared environment-sensitive gate. Appended **after** `tests` because
 * `tests` is its prerequisite (B-07): `test:budgets` reads the reports the
 * suite writes, so it is never worth spawning ahead of it.
 */
export function resolveFullSuiteGateDeclarations(
  cwd: string,
): GateDeclaration[] {
  return [
    ...projectSanityGateDeclarations(cwd, FULL_SUITE_GATE_IDS, {
      stampCost: true,
    }),
    ...environmentSensitiveDeclarations(cwd),
  ];
}

/**
 * The literal token substituted per behavior id, and the one spelling
 * `src/acceptance-gate.ts` imports. `src/gate-policy.ts` declares the same
 * string privately, because the config reader must not import the gate modules
 * it configures; `src/gate-policy.test.ts` pins the two together.
 */
export const BEHAVIOR_ID_TOKEN = "{behaviorId}";

/**
 * How one behavior id is proved: the command to run for it, and the matcher
 * that reads the run's own report. Structurally `GatePolicyAcceptance`, kept as
 * its own type because a derived plan has no policy behind it.
 */
export interface AcceptancePlan {
  command: string;
  args: readonly string[];
  matcher: GateAcceptanceMatcher;
}

/**
 * The baseline when no policy declares one: this repo's own runner, filtered by
 * test name. Not derived from the project's `tests` *script* — that script runs
 * the whole suite, and the gate needs one behavior at a time — but gated on its
 * presence, which is the cheapest honest proxy for "this project runs vitest".
 */
const DERIVED_ACCEPTANCE_ARGS: readonly string[] = [
  "exec",
  "vitest",
  "run",
  "--reporter=json",
  "--testNamePattern",
  BEHAVIOR_ID_TOKEN,
];

/**
 * Resolve the acceptance plan in one order, so there is one answer to "what
 * does this project run for a behavior id":
 *
 * 1. A declared `gatePolicy.acceptance` wins outright and needs no `tests`
 *    script — a project that declares its runner has said what to run.
 * 2. Otherwise the derived baseline, only when {@link resolveSanityPlan}
 *    (ADR 0012's single plan source) yields a `tests` step.
 * 3. Otherwise `null`: no plan, so no catalog entry and no gate.
 *
 * A malformed policy throws here rather than degrading to the baseline —
 * quietly running a different command than the config asked for is the class of
 * defect `src/gate-policy.ts` exists to refuse.
 */
export function resolveAcceptancePlan(cwd: string): AcceptancePlan | null {
  const declared = loadGatePolicy(cwd)?.acceptance;
  if (declared) {
    return {
      command: declared.command,
      args: [...declared.args],
      matcher: declared.matcher,
    };
  }
  const hasTests = resolveSanityPlan(cwd).steps.some(
    (step) => step.name === "tests",
  );
  if (!hasTests) return null;
  return {
    command: "pnpm",
    args: [...DERIVED_ACCEPTANCE_ARGS],
    matcher: "vitest-json",
  };
}

/**
 * One catalog entry a manifest behavior may bind a `gateIds` member to. Not a
 * `GateDeclaration`: `stage` and `required` would have to be invented for the
 * acceptance entry, which is declared through `run` and carries no `command` of
 * its own. `command` here is the runner the gate spawns, which is what keeps
 * `validateAcceptanceManifestBindings`' `nonExecutable` check meaningful.
 */
export interface BindableGate {
  id: string;
  command?: string;
  args?: readonly string[];
}

/**
 * The catalog lock-time validation and the planner prompt both read: the three
 * base declarations, plus the acceptance gate when a plan resolved. Absent a
 * plan there is no entry, so binding a behavior to it is refused as unknown
 * rather than accepted and never run (#85 AC9).
 *
 * Environment-sensitive gates are deliberately absent: it reads
 * {@link resolveBaseGateDeclarations}, which never assembles them. A manifest
 * behavior must not bind its proof to a gate that cannot fail (#86 P-04).
 */
export function resolveBindableGateCatalog(cwd: string): BindableGate[] {
  const plan = resolveAcceptancePlan(cwd);
  return [
    ...resolveBaseGateDeclarations(cwd),
    ...(plan
      ? [
          {
            id: ACCEPTANCE_GATE_ID,
            command: plan.command,
            args: [...plan.args],
          },
        ]
      : []),
  ];
}

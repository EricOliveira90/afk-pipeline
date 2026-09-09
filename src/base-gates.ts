import {
  ACCEPTANCE_GATE_ID,
  type GateDeclaration,
} from "./gate-runner.js";
import {
  loadGatePolicy,
  type GateAcceptanceMatcher,
} from "./gate-policy.js";
import { resolveSanityPlan } from "./preship.js";

const BASE_GATE_IDS = ["typecheck", "lint", "tests"] as const;
const PRE_QA_GATE_IDS = ["typecheck", "lint"] as const;
const FULL_SUITE_GATE_IDS = ["tests"] as const;

function projectSanityGateDeclarations(
  cwd: string,
  gateIds: readonly (typeof BASE_GATE_IDS)[number][],
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
    };
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
  return projectSanityGateDeclarations(cwd, PRE_QA_GATE_IDS);
}

/** The full slice suite, paid only after candidate QA accepts. */
export function resolveFullSuiteGateDeclarations(
  cwd: string,
): GateDeclaration[] {
  return projectSanityGateDeclarations(cwd, FULL_SUITE_GATE_IDS);
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

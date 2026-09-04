import type { GateDeclaration } from "./gate-runner.js";
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

import type { GateDeclaration } from "./gate-runner.js";
import { resolveSanityPlan } from "./preship.js";

const BASE_GATE_IDS = ["typecheck", "lint", "tests"] as const;

/**
 * Derive the policy-less base gate set shared by every agent provider. Reads
 * the same sanity plan the pre-ship gate executes (ADR 0012), so a gate and
 * the aggregate check cannot disagree about which script backs a step.
 */
export function resolveBaseGateDeclarations(
  cwd: string,
): GateDeclaration[] {
  const stepsByGate = new Map(
    resolveSanityPlan(cwd).steps.map((step) => [step.name, step]),
  );

  return BASE_GATE_IDS.map((id) => {
    const step = stepsByGate.get(id);
    return {
      id,
      stage: "base",
      required: step != null,
      ...(step ? { command: step.command, args: [...step.args] } : {}),
    };
  });
}

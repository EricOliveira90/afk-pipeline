/**
 * Bounds visibility (afk-v2 plan §3.9, reliability-wave item 14).
 *
 * Four numbers decide what a struggling slice is still allowed to do:
 * the resume attempts left on its tree ({@link MAX_RESUME_ATTEMPTS}),
 * the implementation rounds left under the global cap (ADR 0014), the
 * contract-negotiation rounds this invocation may spend, and the
 * infrastructure retries each invocation gets. Until now all four were
 * invisible: during the #79 recovery the difference between "one resume
 * attempt left" and "none" changed the recommendation, and the only way
 * to learn which it was involved reading `.afk/state/<run-slug>.json`
 * by hand.
 *
 * So they are reported once per slice dispatch — one `run.log` line and
 * one typed `slice-bounds` event, so `afk status` shows the same numbers
 * without re-deriving them. Both renderings go through
 * {@link formatSliceBounds}, so the human line and the status view
 * cannot drift apart.
 *
 * Nothing here gates, warns, or alarms: these are the budgets, stated.
 * The decisions that consume them stay exactly where they were —
 * `decideResume`, the Phase A round loop, and the Phase B round loop.
 */
import { MAX_RESUME_ATTEMPTS } from "./resume.js";

/** The budgets a single slice dispatch is running under. */
export interface SliceBounds {
  /**
   * Resumes this tree may still earn before the next retry stops
   * resuming it. `--resume-stuck` is deliberately exempt from the cap
   * (see `decideResume`), which is why {@link formatSliceBounds} says so
   * when the dispatch is a stuck resume.
   */
  resumeAttemptsRemaining: number;
  resumeAttemptLimit: number;
  /** Implementation rounds still spendable — see {@link implementationRoundsRemaining}. */
  implementationRoundsRemaining: number;
  implementationRoundLimit: number;
  /** Contract-negotiation rounds this invocation may spend. */
  contractRoundsRemaining: number;
  contractRoundLimit: number;
  /** Retries each individual invocation gets for infrastructure deaths. */
  infrastructureRetriesPerInvocation: number;
  /** Set when this dispatch resumed a preserved tree, naming which kind. */
  resumeMode?: "killed" | "stuck";
}

/**
 * Implementation rounds a dispatch may still spend.
 *
 * The cap is global across a slice's lives (ADR 0014): an ordinary
 * resume restores its round counter from archived evidence and receives
 * only the rounds still unspent, not a fresh budget. A `--resume-stuck`
 * dispatch earns exactly its documented one extra attempt beyond the
 * cap.
 *
 * Phase B and the dispatch bounds line both call this, so the number
 * reported at dispatch is the number the round loop will actually use.
 */
export function implementationRoundsRemaining(input: {
  limit: number;
  /** Rounds already evidenced on this tree; zero for a fresh or restarted slice. */
  spent: number;
  resumeMode?: "killed" | "stuck";
}): number {
  if (input.resumeMode === "stuck") return 1;
  return Math.max(0, input.limit - input.spent);
}

/** Assemble the dispatch-time bounds from the facts a dispatch already holds. */
export function computeSliceBounds(input: {
  /** Resumes recorded against this tree in run state, after the resume decision. */
  resumeAttemptsSpent: number;
  /** Implementation rounds already evidenced on this tree. */
  implementationRoundsSpent: number;
  implementationRoundLimit: number;
  contractRoundLimit: number;
  infrastructureRetries: number;
  resumeMode?: "killed" | "stuck";
}): SliceBounds {
  return {
    resumeAttemptsRemaining: Math.max(
      0,
      MAX_RESUME_ATTEMPTS - input.resumeAttemptsSpent,
    ),
    resumeAttemptLimit: MAX_RESUME_ATTEMPTS,
    implementationRoundsRemaining: implementationRoundsRemaining({
      limit: input.implementationRoundLimit,
      spent: input.implementationRoundsSpent,
      resumeMode: input.resumeMode,
    }),
    implementationRoundLimit: input.implementationRoundLimit,
    // Contract negotiation restarts at round zero on every invocation
    // (an already-LOCKED contract simply spends none of them), so the
    // remaining budget is the whole budget.
    contractRoundsRemaining: input.contractRoundLimit,
    contractRoundLimit: input.contractRoundLimit,
    infrastructureRetriesPerInvocation: input.infrastructureRetries,
    ...(input.resumeMode ? { resumeMode: input.resumeMode } : {}),
  };
}

/**
 * The one rendering of the bounds, shared by the `run.log` dispatch line
 * and `afk status`. No trailing punctuation and no leading slice
 * reference — callers own both.
 */
export function formatSliceBounds(bounds: SliceBounds): string {
  const resume =
    `${bounds.resumeAttemptsRemaining}/${bounds.resumeAttemptLimit} resume attempts left` +
    (bounds.resumeMode === "stuck" ? " (--resume-stuck is not capped)" : "");
  return [
    `bounds: ${resume}`,
    `${bounds.implementationRoundsRemaining}/${bounds.implementationRoundLimit} implementation rounds left`,
    `${bounds.contractRoundsRemaining}/${bounds.contractRoundLimit} contract rounds left`,
    `${bounds.infrastructureRetriesPerInvocation} infrastructure retries per invocation`,
  ].join(" · ");
}

/**
 * The `feedback-integrity` gate: a candidate may not quietly change what the
 * project's feedback is allowed to say.
 *
 * Three detections, all derived from the same candidate-against-`featureRef`
 * comparison the `scope` and `tests:skipped` gates already take (`prd.md` D3):
 *
 * - **A changed gate-policy path.** `gatePolicy.protectedPaths.gatePolicyPaths`
 *   (default `afk.config.json`, `suite-budgets.json`) is where a project
 *   declares what its own gates check and what they cost. A candidate that
 *   edits one is editing the ruler it is measured with.
 * - **A deleted test.** A path matching `gatePolicy.protectedPaths.testGlobs`
 *   that the comparison base has and the candidate does not (D6). Deleting a
 *   test is the cheapest way to make a suite green, and it is invisible in a
 *   pass/fail exit code.
 * - **A mutated accepted contract pair.** `acceptedPairIntact: false` is the
 *   verdict `src/orchestrator.ts` already earned at its accepted-pair integrity
 *   check; this gate never re-derives it, and never lets a waiver exempt it.
 *
 * Only a human can authorize any of them, and only in one place: the launch
 * manifest's `protectedChangeWaivers` (`src/afk-manifest.ts`, D5). The manifest
 * lives in the PRD directory of the host checkout, outside every slice's file
 * scope and read once before any wave dispatches, so the actor being
 * constrained cannot author its own exemption. Declaring a protected path in
 * the contract's `fileScope` is never authorization — a file scope is what an
 * agent negotiated, and this gate exists because that negotiation is exactly
 * what a human has to sign off on here.
 *
 * Glob matching is `matchesGlob` from `src/gate-policy.ts` and nothing else; a
 * waiver's `path` is matched by string equality, because a waiver names one
 * exact file somebody read (D5).
 *
 * ## The rulebook is run-scoped (#251)
 *
 * {@link FeedbackIntegrityGateInput.runPolicy} is the **run's** policy — the
 * snapshot the launch path took from the host checkout before any agent ran —
 * and never `loadGatePolicy(worktreeDir)`. The distinction is the whole gate:
 * the candidate's generator holds write access to its worktree for the entire
 * round, so a policy read from there is a policy the thing being judged can
 * author. It could strike `gate-policy` from `riskClasses`, or narrow
 * `gatePolicyPaths` away from the file it just edited, and this gate would
 * enforce that edit against the very candidate that made it. A gate whose
 * rulebook comes from the artifact under inspection cannot fail closed
 * (`docs/PRODUCT.md` operating principle 6).
 *
 * `worktreeDir` still points at the candidate: inspecting the candidate tree is
 * this gate's job. Only the policy's *source* is run-scoped. Do not "simplify"
 * `runPolicy` back to a read of `worktreeDir`.
 *
 * The candidate's own copy is not ignored, only demoted: when the candidate
 * changed it and what it now declares differs from the run's policy, that is a
 * `gate-policy` detection like any other — evidence about the candidate, routed
 * through the same launch-waiver machinery.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  normalizeWaiverPath,
  type ProtectedChangeWaiver,
} from "./afk-manifest.js";
import {
  DEFAULT_GATE_POLICY_PATHS,
  DEFAULT_TEST_GLOBS,
  GATE_POLICY_CONFIG_FILENAME,
  GATE_RISK_CLASSES,
  loadGatePolicy,
  matchesGlob,
  type GatePolicy,
  type GateRiskClass,
} from "./gate-policy.js";
import type {
  GateDeclaration,
  GateEvidence,
  GateFindings,
  GateRunOutcome,
} from "./gate-runner.js";
import { listChangedFiles } from "./git.js";

/** The declared gate id, so callers and assertions share one spelling. */
export const FEEDBACK_INTEGRITY_GATE_ID = "feedback-integrity";

/** The stage every content-derived gate reports under (`prd.md` D2-D4). */
export const FEEDBACK_INTEGRITY_GATE_STAGE = "deterministic";

/**
 * The two files that carry the accepted contract lock. Named as literals
 * because `acceptedPairIntact: false` says only *that* they moved, and this
 * gate's job is to name what moved.
 */
export const ACCEPTED_PAIR_FILENAMES: readonly string[] = [
  "contract.md",
  "acceptance-manifest.json",
];

export interface FeedbackIntegrityGateInput {
  /**
   * The live slice worktree, not a checkpoint directory: only it carries the
   * working-tree and untracked changes, and at the post-QA call site the
   * candidate is not committed yet — the same pair the `scope` and
   * `tests:skipped` gates take (`prd.md` D3).
   */
  worktreeDir: string;
  /** The feature branch the candidate is measured against. */
  featureRef: string;
  /**
   * The launch manifest's waivers, and only those (B-06). An empty array is a
   * candidate nobody authorized anything for.
   */
  waivers: readonly ProtectedChangeWaiver[];
  /**
   * The **run's** gate policy: the launch-time snapshot, taken from the host
   * checkout before any agent ran, and never a read of {@link worktreeDir}
   * (#251 — see this module's header for why). `null` when the run declares
   * none, in which case every documented default applies.
   */
  runPolicy: GatePolicy | null;
  /**
   * The caller's *proven* attestation that `contract.md` and
   * `acceptance-manifest.json` still hold the bytes the orchestrator accepted
   * — the value the accepted-pair integrity check already produced, never a
   * fresh check (B-08). `false` fails this gate closed.
   */
  acceptedPairIntact: boolean;
}

/** One detection, before waivers are consulted. */
interface Detection {
  riskClass: GateRiskClass;
  path: string;
  /**
   * A detection no waiver may exempt: the accepted contract pair. An
   * agent-authored lock change is the posture D5 refuses outright, so there is
   * no authorization to look for.
   */
  unwaivable?: boolean;
}

function matchesAny(globs: readonly string[], path: string): boolean {
  return globs.some((glob) => matchesGlob(glob, path));
}

/**
 * Collect `findings.appliedWaivers` from every result in one gate evidence
 * document, de-duplicated on `riskClass` + `path`.
 *
 * Pure and separate from the gate on purpose: the orchestrator's producing
 * seam reads the *written* evidence rather than the in-memory outcome (D23),
 * because the PASS path of a post-QA gate phase hands back no result object
 * that carries findings.
 */
export function appliedWaiversFrom(
  evidence: GateEvidence,
): ProtectedChangeWaiver[] {
  const seen = new Set<string>();
  const waivers: ProtectedChangeWaiver[] = [];
  for (const result of evidence.results) {
    for (const waiver of result.findings?.appliedWaivers ?? []) {
      const key = `${waiver.riskClass} ${waiver.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      waivers.push({
        riskClass: waiver.riskClass,
        path: waiver.path,
        author: waiver.author,
        reason: waiver.reason,
      });
    }
  }
  return waivers;
}

function protectedPathsOf(policy: GatePolicy | null): {
  gatePolicyPaths: readonly string[];
  testGlobs: readonly string[];
} {
  return {
    gatePolicyPaths: (
      policy?.protectedPaths.gatePolicyPaths ?? DEFAULT_GATE_POLICY_PATHS
    ).map(normalizeWaiverPath),
    testGlobs: policy?.protectedPaths.testGlobs ?? DEFAULT_TEST_GLOBS,
  };
}

function enforcedClassesOf(policy: GatePolicy | null): Set<GateRiskClass> {
  return new Set(policy?.riskClasses ?? GATE_RISK_CLASSES);
}

/**
 * The candidate's own copy of the gate policy, read as *evidence* and never as
 * the rulebook (#251). Returns the config path to report when the candidate
 * changed that file and what it now declares is not what the run declares;
 * `null` when there is nothing to report.
 *
 * Gated on the changed set on purpose. A run whose host checkout has since
 * moved on, or a wave whose feature branch already carries a human-waived
 * policy change, is not a candidate mutating anything — and the detection this
 * function exists for is exactly "this candidate rewrote the rulebook".
 *
 * Deliberately outside `gatePolicy.riskClasses` and outside
 * `protectedPaths.gatePolicyPaths`, for the reason the accepted pair is: those
 * are a project's declarations about its *own* files, while this file is the
 * declaration itself. A policy that narrowed either one away from
 * `afk.config.json` would otherwise let the edit go unmentioned. It stays
 * waivable, because a human may legitimately authorize a policy change and the
 * launch manifest is where they say so.
 *
 * An unparseable candidate copy is divergent by definition. Before #251 it
 * threw out of declaration assembly, taking the round down over a file the
 * candidate wrote; now the gate names it instead.
 */
function divergentPolicyPath(
  input: FeedbackIntegrityGateInput,
  changedPaths: readonly string[],
): string | null {
  const configPath = normalizeWaiverPath(GATE_POLICY_CONFIG_FILENAME);
  if (!changedPaths.some((path) => normalizeWaiverPath(path) === configPath)) {
    return null;
  }
  let candidate: GatePolicy | null;
  try {
    candidate = loadGatePolicy(input.worktreeDir);
  } catch {
    return configPath;
  }
  // Structural equality by serialization: every policy on both sides came out
  // of `parseGatePolicy`, which builds its keys in one fixed order, so the
  // strings differ exactly when the declarations do. A candidate edit that only
  // reorders a member's array compares as divergent, which is correct enough —
  // it is still the candidate editing the rulebook, and it is still waivable.
  return JSON.stringify(candidate) === JSON.stringify(input.runPolicy)
    ? null
    : configPath;
}

/**
 * Run the comparison. Exported for direct unit coverage; the pipeline reaches
 * it through {@link feedbackIntegrityGateDeclaration}.
 */
export function runFeedbackIntegrityGate(
  input: FeedbackIntegrityGateInput,
): GateRunOutcome {
  const probe = listChangedFiles(input.worktreeDir, input.featureRef);
  if (!probe.ok) {
    // Never an empty violation list: "git could not tell me" is the opposite
    // of "this candidate changed nothing protected" (`prd.md` D2).
    return {
      status: "INFRASTRUCTURE",
      failureKind: null,
      detail:
        `The set of files this candidate changed could not be determined, so ` +
        `its protected changes could not be checked: ${probe.failure}`,
    };
  }

  const { gatePolicyPaths, testGlobs } = protectedPathsOf(input.runPolicy);
  const enforced = enforcedClassesOf(input.runPolicy);
  const omitted = GATE_RISK_CLASSES.filter(
    (riskClass) => !enforced.has(riskClass),
  );

  const detections: Detection[] = [];
  if (enforced.has("gate-policy")) {
    for (const path of probe.paths) {
      const normalized = normalizeWaiverPath(path);
      if (gatePolicyPaths.includes(normalized)) {
        detections.push({ riskClass: "gate-policy", path: normalized });
      }
    }
  }
  const divergent = divergentPolicyPath(input, probe.paths);
  if (divergent !== null) {
    detections.push({ riskClass: "gate-policy", path: divergent });
  }
  if (enforced.has("deleted-test")) {
    for (const path of probe.paths) {
      const normalized = normalizeWaiverPath(path);
      // In the changed set, matching the project's own answer to "which files
      // are test files", and gone from the worktree: a deletion.
      if (
        matchesAny(testGlobs, normalized) &&
        !existsSync(join(input.worktreeDir, normalized))
      ) {
        detections.push({ riskClass: "deleted-test", path: normalized });
      }
    }
  }
  if (!input.acceptedPairIntact) {
    // Unconditional, and deliberately not filtered by `gatePolicy.riskClasses`:
    // the risk classes are a project's declaration about its own files, while
    // the accepted pair is the orchestrator's lock. A policy that switched this
    // off would let an agent rewrite the contract it is judged against.
    for (const path of ACCEPTED_PAIR_FILENAMES) {
      detections.push({ riskClass: "gate-policy", path, unwaivable: true });
    }
  }

  // One offender is one detection. Two branches can now name the same file —
  // an edited `afk.config.json` is both a changed gate-policy path and, if it
  // diverges from the run's policy, a rewritten rulebook — and reporting it
  // twice would only make the repair round read the same path twice.
  const distinct: Detection[] = [];
  for (const detection of detections) {
    const seen = distinct.find(
      (other) =>
        other.riskClass === detection.riskClass &&
        other.path === detection.path,
    );
    if (!seen) distinct.push(detection);
    else if (detection.unwaivable) seen.unwaivable = true;
  }

  const applied: ProtectedChangeWaiver[] = [];
  const unwaived: Detection[] = [];
  for (const detection of distinct) {
    const waiver = detection.unwaivable
      ? undefined
      : input.waivers.find(
          (candidate) =>
            candidate.riskClass === detection.riskClass &&
            candidate.path === detection.path,
        );
    if (waiver) applied.push(waiver);
    else unwaived.push(detection);
  }

  const omissionClause =
    omitted.length === 0
      ? ""
      : ` Not enforced by policy: ${omitted.join(", ")} — ` +
        `gatePolicy.riskClasses declares what this gate checks.`;
  const findings: GateFindings =
    applied.length === 0 ? {} : { appliedWaivers: applied };

  if (unwaived.length === 0) {
    return {
      status: "PASS",
      failureKind: null,
      detail:
        `No unwaived protected change in ${probe.paths.length} changed ` +
        `path(s)` +
        (applied.length === 0
          ? "."
          : `, with ${applied.length} launch waiver(s) applied: ` +
            `${applied
              .map((waiver) => `${waiver.riskClass} ${waiver.path}`)
              .join(", ")}.`) +
        omissionClause,
      ...(applied.length === 0 ? {} : { findings }),
    };
  }

  const protectedChanges = unwaived
    .filter((detection) => detection.riskClass === "gate-policy")
    .map((detection) => detection.path);
  const deletedTests = unwaived
    .filter((detection) => detection.riskClass === "deleted-test")
    .map((detection) => detection.path);

  return {
    status: "FAIL",
    failureKind: "COMMAND",
    // Each offender named exactly, with the authorization recipe beside it,
    // because this text is what the repair round and the operator read out of
    // the gate log.
    detail:
      `${unwaived.length} protected change(s) this candidate made are not ` +
      `authorized: ` +
      `${unwaived
        .map((detection) => `${detection.riskClass} ${detection.path}`)
        .join(", ")}. ` +
      `Declaring a path in the contract's fileScope is not authorization. ` +
      `Either revert the change, or have a human add an entry to the PRD ` +
      `directory's afk.json protectedChangeWaivers with riskClass, path, ` +
      `author and reason.` +
      (input.acceptedPairIntact
        ? ""
        : ` The accepted contract pair (${ACCEPTED_PAIR_FILENAMES.join(
            ", ",
          )}) moved under the lock, and no waiver may exempt it.`) +
      omissionClause,
    findings: {
      ...findings,
      ...(protectedChanges.length === 0 ? {} : { protectedChanges }),
      ...(deletedTests.length === 0 ? {} : { deletedTests }),
    },
  };
}

/**
 * The declaration. Required and in-process: no toolchain, no working
 * directory, and therefore nothing that can make it skippable — a check on
 * whether the feedback itself was edited must not depend on the suite running.
 */
export function feedbackIntegrityGateDeclaration(
  input: FeedbackIntegrityGateInput,
): GateDeclaration {
  return {
    id: FEEDBACK_INTEGRITY_GATE_ID,
    stage: FEEDBACK_INTEGRITY_GATE_STAGE,
    required: true,
    // The comparison lives inside the closure, so the bytes compared are the
    // bytes on disk at gate time.
    run: () => runFeedbackIntegrityGate(input),
  };
}

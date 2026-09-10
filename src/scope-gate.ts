/**
 * The file-scope gate: the accepted `fileScope` compared against what a tree
 * actually changed, as one required in-process gate declaration.
 *
 * Both halves of the comparison already existed and neither is
 * re-implemented here — `outOfScopeChangedPaths` (`src/escalation.ts`) owns
 * classification and its exemptions, `listChangedFiles` / `diffTreePaths`
 * (`src/git.ts`) own the changed set. What this module adds is the seam:
 * a `GateDeclaration` with evidence, so an undeclared change is a red gate the
 * next generator round can read rather than a check buried in a call site
 * (`ARCHITECTURE.md`, "a new check is a declared gate with evidence").
 *
 * It is a second door, not a replacement. The pre-build escalation guard
 * (`src/orchestrator.ts`, ADR 0052) still refuses a focused scope revision on
 * a tree that already holds undeclared changes; this gate runs much later, on
 * the final candidate, and catches the tree that never escalated at all
 * (ADR 0048: "Do not 'reconcile' them").
 */
import { loadAcceptanceManifest } from "./acceptance-manifest.js";
import { outOfScopeChangedPaths } from "./escalation.js";
import type { GateDeclaration, GateRunOutcome } from "./gate-runner.js";
import { diffTreePaths, listChangedFiles } from "./git.js";
import type { LaneResourceOptions } from "./lanes.js";

/** The declared gate id, so callers and assertions share one spelling. */
export const SCOPE_GATE_ID = "scope";

/** The stage every content-derived gate reports under (`prd.md` D2-D4). */
export const SCOPE_GATE_STAGE = "deterministic";

/**
 * Where the changed set comes from. The two sources are not
 * interchangeable, and picking the wrong one is a silent hole rather than an
 * error, so the caller names which comparison it is asking for.
 */
export type ScopeComparisonSource =
  /**
   * The live slice worktree against the feature branch. Committed diff since
   * the merge base, plus working-tree modifications, plus untracked files:
   * only the worktree carries the uncommitted two-thirds, and at the post-QA
   * call site the candidate is not committed yet (`prd.md` D3).
   *
   * `featureRef` is used verbatim as git's three-dot base, because
   * `<base>...HEAD` already means `merge-base(<base>, HEAD)..HEAD` — D3's
   * re-resolved base needs no second `merge-base` call. That is also what
   * makes a slice tree with the feature branch merged into it behave: the
   * merge base is the merged tip, so an already-merged sibling's paths are not
   * in this slice's changed set.
   */
  | { kind: "candidate"; worktreeDir: string; featureRef: string }
  /**
   * One role's write scope, checkpoint tree to checkpoint tree — never a
   * working-tree probe (`prd.md` D4). The checkpoints are what later evidence
   * cites, so they are what the comparison has to be about.
   */
  | {
      kind: "role";
      cwd: string;
      inputCheckpointTree: string;
      outputCheckpointTree: string;
    };

export interface ScopeGateInput {
  source: ScopeComparisonSource;
  /**
   * Absolute slice directory. The manifest is read from it *when the gate
   * runs*, not when the declaration is built: a `fileScope` that an ADR 0048
   * scope amendment widened during the QA window is the scope this gate has
   * to compare against, and the newly declared path must not be a violation.
   */
  absSliceDir: string;
  /** Repo-relative slice artifact directory, exempt with everything under it. */
  sliceArtifactDir: string;
  /**
   * The caller's *proven* attestation that `contract.md` and
   * `acceptance-manifest.json` still hold the bytes the orchestrator accepted.
   * No default, by design (`src/escalation.ts`): a negotiated slice tree
   * always shows both files as changed against the feature branch, so a
   * caller that cannot prove them says `false` and gets both named — the gate
   * fails closed rather than exempting a lock the generator may have widened.
   */
  acceptedPairIntact: boolean;
  options?: LaneResourceOptions;
}

/**
 * The changed set for one comparison source, or the reason there is none.
 *
 * A probe that could not answer is never flattened into an empty list: an
 * empty violation list reads as "this tree is clean", which is the opposite of
 * "git could not tell me" (`prd.md` D2, and the same rule
 * {@link listChangedFiles} was built for).
 */
function changedPathsFor(
  source: ScopeComparisonSource,
): { ok: true; paths: readonly string[] } | { ok: false; failure: string } {
  if (source.kind === "candidate") {
    const probe = listChangedFiles(source.worktreeDir, source.featureRef);
    return probe.ok ? { ok: true, paths: probe.paths } : probe;
  }
  // A tree that cannot be diffed throws by design, and the caller in
  // `runGates` records that as INFRASTRUCTURE. Never an empty set.
  return {
    ok: true,
    paths: diffTreePaths(
      source.cwd,
      source.inputCheckpointTree,
      source.outputCheckpointTree,
    ),
  };
}

/**
 * Run the comparison. Exported for direct unit coverage; the pipeline reaches
 * it through {@link scopeGateDeclaration}.
 */
export function runScopeGate(input: ScopeGateInput): GateRunOutcome {
  const changed = changedPathsFor(input.source);
  if (!changed.ok) {
    return {
      status: "INFRASTRUCTURE",
      failureKind: null,
      detail:
        `The set of files this candidate changed could not be determined, ` +
        `so its file scope could not be checked: ${changed.failure}`,
    };
  }

  const manifest = loadAcceptanceManifest(input.absSliceDir);
  const offenders = outOfScopeChangedPaths({
    changedFiles: changed.paths,
    manifest,
    sliceArtifactDir: input.sliceArtifactDir,
    acceptedPairIntact: input.acceptedPairIntact,
    ...(input.options ? { options: input.options } : {}),
  });
  if (offenders.length === 0) {
    return {
      status: "PASS",
      failureKind: null,
      detail:
        `Every one of the ${changed.paths.length} changed path(s) is on the ` +
        `accepted file scope or exempt from it.`,
    };
  }
  return {
    status: "FAIL",
    failureKind: "COMMAND",
    // Each offender named exactly, because this text is what the repair round
    // reads out of the gate log.
    detail:
      `${offenders.length} changed path(s) are outside the accepted file ` +
      `scope: ${offenders.join(", ")}. Either revert them or declare them ` +
      `through a scope escalation before the next candidate.`,
    findings: { outOfScopePaths: offenders },
  };
}

/**
 * The declaration. Required and in-process: no toolchain, no working
 * directory, and therefore nothing that can make it skippable — a scope check
 * that only runs when the suite runs is not a gate.
 */
export function scopeGateDeclaration(input: ScopeGateInput): GateDeclaration {
  return {
    id: SCOPE_GATE_ID,
    stage: SCOPE_GATE_STAGE,
    required: true,
    // The manifest read lives inside the closure, so the bytes compared are
    // the bytes on disk at gate time.
    run: () => runScopeGate(input),
  };
}

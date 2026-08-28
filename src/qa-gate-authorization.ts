import type { GateDeclaration, GateEvidence } from "./gate-runner.js";

/**
 * QA-dedup (ADR 0012, amendment 2026-08-28).
 *
 * The orchestrator runs the base gates — typecheck, lint, tests — on a
 * checkpoint of the candidate immediately before it dispatches deterministic
 * QA, and the evaluator's Pass 1 then ran the same commands again on the same
 * tree. Measured on `run-20260827`: a base gate at 739.3s followed by a QA
 * round that spent 772.5s reproducing it.
 *
 * This module turns the gate run the orchestrator already performed into an
 * explicit authorization the evaluator may cite instead of re-running those
 * commands. It is deliberately **not** agent self-certification: the facts in
 * the citation are the orchestrator's own — it declared the gates, executed
 * them, verified their evidence artifact against its recorded digest, and
 * hashed the tree itself. The evaluator is handed a conclusion, not asked for
 * one.
 *
 * Everything here fails closed. The authorization exists only when every
 * executable base gate PASSed on a tree sha that exactly equals the tree the
 * evaluator is about to review; any other state — a sha that moved, a missing
 * result, a gate that could not run, a tree that could not be hashed — refuses
 * with a reason and the evaluator runs the full sanity list, which is the
 * behaviour that shipped before this amendment. A refusal is never worse than
 * the status quo; it *is* the status quo.
 */

/** One base gate the authorization vouches for. */
export interface CoveredBaseGate {
  gateId: string;
  /** The command as an operator would type it, matching `{{SANITY_COMMANDS}}`. */
  command: string;
  /** ISO timestamp the gate finished, so "when" is citable, not implied. */
  endedAt: string;
  durationMs: number;
}

/**
 * The auditable half, recorded in the QA attempt record. Evidence ID plus sha
 * is enough for a reader to re-open the gate artifact and confirm what the
 * orchestrator asserted, on which tree, over which gates.
 */
export interface BaseGateSkipCitation {
  /** Repo-relative path of the verified gate evidence artifact. */
  evidenceArtifactId: string;
  /** The gate run's attempt ID, as recorded in that artifact. */
  attemptId: string;
  /** The tree sha the gates ran on, equal to the tree under review. */
  treeId: string;
  /** Gate IDs the authorization covers, in declaration order. */
  gateIds: string[];
}

export type BaseGateSkipAuthorization =
  | {
      authorized: true;
      citation: BaseGateSkipCitation;
      gates: readonly CoveredBaseGate[];
    }
  | { authorized: false; reason: string };

export interface BaseGateSkipInput {
  /** Verified evidence from the round's last gate attempt, if there was one. */
  evidence: GateEvidence | null;
  /** Repo-relative path of that evidence artifact. */
  evidenceArtifactId: string;
  /** The declarations the gate run was given. */
  declarations: readonly GateDeclaration[];
  /**
   * Tree sha of the worktree the evaluator will review, hashed the same way
   * the checkpoint was. `null` when it could not be resolved at all.
   */
  reviewTreeId: string | null;
}

/**
 * Decide whether the base gates the orchestrator just ran authorize the
 * evaluator to skip re-running them.
 */
export function authorizeBaseGateSkip(
  input: BaseGateSkipInput,
): BaseGateSkipAuthorization {
  const { evidence, evidenceArtifactId, declarations, reviewTreeId } = input;

  if (reviewTreeId == null || reviewTreeId.trim() === "") {
    return {
      authorized: false,
      reason:
        "the tree under review could not be hashed, so no sha comparison is possible",
    };
  }
  if (evidence == null) {
    return {
      authorized: false,
      reason: "this round produced no base-gate evidence",
    };
  }
  if (evidenceArtifactId.trim() === "") {
    return {
      authorized: false,
      reason: "the base-gate evidence artifact has no citable path",
    };
  }
  if (evidence.treeId !== reviewTreeId) {
    return {
      authorized: false,
      reason:
        `the base gates ran on tree ${evidence.treeId}, but the tree under ` +
        `review is ${reviewTreeId} — the trees are not the same, so the ` +
        "gate run proves nothing about this one",
    };
  }

  const executable = declarations.filter(
    (declaration) => declaration.command != null,
  );
  if (executable.length === 0) {
    return {
      authorized: false,
      reason: "no base gate had an executable command on this project",
    };
  }

  const resultsByGateId = new Map(
    evidence.results.map((result) => [result.gateId, result]),
  );
  const gates: CoveredBaseGate[] = [];
  for (const declaration of executable) {
    const result = resultsByGateId.get(declaration.id);
    if (!result) {
      return {
        authorized: false,
        reason: `base gate ${declaration.id} has no result in the evidence`,
      };
    }
    if (result.treeId !== reviewTreeId) {
      return {
        authorized: false,
        reason:
          `base gate ${declaration.id} recorded tree ${result.treeId}, not ` +
          `the tree under review ${reviewTreeId}`,
      };
    }
    if (result.status !== "PASS") {
      return {
        authorized: false,
        reason: `base gate ${declaration.id} is ${result.status}, not PASS`,
      };
    }
    gates.push({
      gateId: declaration.id,
      command: [declaration.command, ...(declaration.args ?? [])].join(" "),
      endedAt: result.endedAt,
      durationMs: result.durationMs,
    });
  }

  return {
    authorized: true,
    citation: {
      evidenceArtifactId,
      attemptId: evidence.attemptId,
      treeId: reviewTreeId,
      gateIds: gates.map((gate) => gate.gateId),
    },
    gates,
  };
}

function formatSeconds(durationMs: number): string {
  return `${(durationMs / 1_000).toFixed(1)}s`;
}

/**
 * Render the authorization for `{{BASE_GATE_AUTHORIZATION}}`.
 *
 * The refusal wording matters as much as the grant: an evaluator handed a
 * reason it can read is an evaluator that does not have to guess whether
 * silence means "no authorization" or "the block failed to render".
 */
export function formatBaseGateSkipAuthorization(
  authorization: BaseGateSkipAuthorization,
): string {
  if (!authorization.authorized) {
    return [
      `No skip authorization is in force: ${authorization.reason}.`,
      "",
      "Run every sanity command above yourself, in order.",
    ].join("\n");
  }

  const { citation, gates } = authorization;
  return [
    "**Skip authorization — you may cite this instead of re-running the commands it names.**",
    "",
    "The orchestrator ran these gates itself, on a checkpoint of the exact",
    "tree you are reviewing, and verified the evidence artifact below against",
    "its recorded digest. These are the orchestrator's own measurements, not",
    "another agent's report:",
    "",
    ...gates.map(
      (gate) =>
        `- ${gate.gateId} — \`${gate.command}\` — PASS at ${gate.endedAt} ` +
        `(${formatSeconds(gate.durationMs)})`,
    ),
    "",
    `- Evidence artifact: \`${citation.evidenceArtifactId}\``,
    `- Gate attempt ID: \`${citation.attemptId}\``,
    `- Tree sha under review: \`${citation.treeId}\``,
    "",
    "In Pass 1 you may skip exactly those commands and cite the evidence",
    "artifact and tree sha above as your evidence that they pass. Every other",
    "sanity command — including the dependency install, which ran in a",
    "different checkout and did not populate yours — you must still run.",
    "",
    "The authorization covers the tree as handed to you. If you modify any",
    "file under review, it is void: run the full sanity list yourself.",
  ].join("\n");
}

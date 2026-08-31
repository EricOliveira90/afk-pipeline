import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { ADJUDICATION_DECISIONS_FILENAME } from "./adjudication.js";
import { CONTRACT_NEGOTIATION_OUTCOME_FILENAME } from "./contract-review.js";

/**
 * Does this worktree hold a live adjudication estate?
 *
 * Estate ownership is a **fact about the worktree**, not about the phase
 * the run last recorded (ADR 0055 Seam 2 §6, amended in the fourth
 * adjudication gate round). The files a human's pending or completed
 * adjudication depends on live in the slice directory *inside* the
 * worktree, and they are there or they are not — a single `existsSync`
 * away from any caller. The terminal phase is a lossy proxy for that
 * fact: every post-decision apply exit that is not a lock refusal
 * (planner/provider failure, feature-refresh conflict, cancellation
 * mid-apply, a post-lock bookkeeping throw the wave flattens) lands in an
 * ordinary failure phase while the estate is still on disk. Encoding
 * ownership in the phase means re-encoding it once per exit, forever;
 * reading it off disk covers every exit at once, including the ones
 * nobody has written yet.
 *
 * Two files carry ownership, matching the two ways the pipeline re-enters
 * the adjudication branch on the next dispatch:
 *
 * - `contract-negotiation-outcome.json` classified `IMPASSE` — the impasse
 *   record. `negotiate()` re-enters `runImpasseAdjudication` iff this file
 *   says `IMPASSE`, so its presence *is* the retry path. A record
 *   classified anything else (`NON_CONVERGENCE`) is an ordinary exhausted
 *   negotiation and owns nothing.
 * - `adjudication-decisions.json` — the durable decision log (ADR 0054).
 *   Human input outlives a mechanical refusal, so any recorded decision
 *   makes the estate the operator's, applied or not.
 *
 * Absence is proved, not inferred (ADR 0055 Seam 2 §8): an impasse record
 * that cannot be read or parsed counts as owning, and says so in
 * `evidence`, so a corrupt file never reads as "nothing here".
 */

/** Directories a slice's estate never lives under; skipping them keeps the probe cheap. */
const SKIP_DIRS = new Set([
  ".git",
  ".afk",
  "node_modules",
  "dist",
  "coverage",
  ".vitest-reports",
]);

/**
 * How deep the probe looks. A slice directory is
 * `<specsDir>/slices/<NN>-<slug>/`, and `specsDir` is configurable
 * (`.kiro/specs/<prd-slug>` by default), so the deepest estate file sits
 * five levels below the worktree root. One level of headroom, and no
 * caller has to hand the probe a `specsDir` it does not have — neither
 * `clean-failed` nor `afk adopt` reads one from run state.
 */
const MAX_DEPTH = 6;

export interface AdjudicationEstate {
  /** The worktree the estate was found in. */
  worktreeDir: string;
  /** Slice directories holding estate files, in discovery order. */
  sliceDirs: string[];
  /** Absolute paths of the estate files found, in discovery order. */
  files: string[];
  /** Worktree-relative evidence, for the operator-facing skip or refusal. */
  evidence: string;
}

function ownershipEvidence(
  sliceDir: string,
): { file: string; note: string } | null {
  const decisionLog = join(sliceDir, ADJUDICATION_DECISIONS_FILENAME);
  if (existsSync(decisionLog)) {
    return { file: decisionLog, note: "recorded human decisions" };
  }
  const outcome = join(sliceDir, CONTRACT_NEGOTIATION_OUTCOME_FILENAME);
  if (!existsSync(outcome)) return null;
  try {
    const parsed = JSON.parse(readFileSync(outcome, "utf-8")) as {
      classification?: unknown;
    };
    if (parsed.classification !== "IMPASSE") return null;
    return { file: outcome, note: "impasse record awaiting a decision" };
  } catch {
    // Fail closed: an unreadable record is not proof of absence.
    return {
      file: outcome,
      note: "negotiation outcome record that could not be read — absence of an impasse cannot be proved",
    };
  }
}

/**
 * The disk fact. Returns `null` only when the probe walked the worktree
 * and found no estate file — the one thing that counts as proof of
 * absence.
 */
export function findAdjudicationEstate(
  worktreeDir: string,
): AdjudicationEstate | null {
  if (!existsSync(worktreeDir)) return null;

  const sliceDirs: string[] = [];
  const files: string[] = [];
  const notes: string[] = [];

  const walk = (dir: string, depth: number): void => {
    const found = ownershipEvidence(dir);
    if (found) {
      sliceDirs.push(dir);
      files.push(found.file);
      notes.push(
        `${relative(worktreeDir, found.file).replace(/\\/g, "/")} (${found.note})`,
      );
    }
    if (depth >= MAX_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name), depth + 1);
    }
  };
  walk(worktreeDir, 0);

  if (files.length === 0) return null;
  return { worktreeDir, sliceDirs, files, evidence: notes.join(", ") };
}

/** `findAdjudicationEstate` for a caller that only needs the yes/no. */
export function holdsAdjudicationEstate(worktreeDir: string): boolean {
  return findAdjudicationEstate(worktreeDir) !== null;
}

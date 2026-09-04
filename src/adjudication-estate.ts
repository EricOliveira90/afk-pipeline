import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
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
 *
 * ## Why the probe is a tri-state (architect blocker 2, fifth round)
 *
 * The fourth round's fix read ownership off disk but returned `null` for
 * two different facts: "I walked the worktree and there is no estate" and
 * "I could not complete the walk". A `--prd-dir` deeper than the assumed
 * default layout blew the depth bound, and an unreadable directory was
 * swallowed — and both then read as *proved absence*, after which
 * `clean-failed` deletes the worktree and `adopt` overwrites the park.
 * Inferring absence from an incomplete probe is precisely what Seam 2 §8
 * forbids, and the defect was introduced by the code that exists to honour
 * it.
 *
 * So there are two independent repairs, and both matter:
 *
 * 1. **Resolve, don't guess.** The run knows its own `specsDir` — it is a
 *    launch input — so it is persisted in run state (`RunState.specsDir`)
 *    and handed to the probe. With it, the estate's location is computed
 *    (`<worktree>/<specsDir>/slices/*`), and no walk happens at all: layout
 *    depth stops being a variable.
 * 2. **Never collapse `absent` into `indeterminate`.** The no-`specsDir`
 *    fallback (legacy run state, a worktree no state claims) still walks,
 *    but it walks the whole worktree rather than six levels, and any
 *    enumeration failure — or the safety bound below being reached with
 *    directories still to descend — returns `indeterminate` with the reason.
 *    Every caller refuses by name on `indeterminate`.
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
 * A safety valve on the fallback walk, not a model of any real layout.
 *
 * The old bound was six, chosen to just fit the default
 * `.kiro/specs/<prd-slug>/slices/<NN>-<slug>/` — which meant any deeper
 * configurable `specsDir` silently fell off the end. Nothing about a
 * repository tree is bounded, so the fallback walks all of it; this only
 * stops a pathological or cyclic tree from running forever, and reaching it
 * is reported as `indeterminate` rather than as absence.
 */
const MAX_DEPTH = 40;

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

/**
 * The disk fact, or the admission that it could not be established.
 *
 * `absent` is a claim the probe has earned: it looked everywhere it was
 * asked to look and every enumeration succeeded. `indeterminate` carries
 * the reason, which every caller puts in its refusal — an operator who is
 * told "adoption refused: the estate probe could not read X" can fix X,
 * where a silent deletion left them nothing.
 */
export type AdjudicationEstateProbe =
  | { status: "present"; estate: AdjudicationEstate }
  | { status: "absent" }
  | { status: "indeterminate"; reason: string };

export interface AdjudicationEstateProbeOptions {
  /**
   * Repo-relative specs directory for the run that owns this worktree
   * (`RunState.specsDir`, e.g. `.kiro/specs/<prd-slug>`). When present the
   * estate location is *resolved* rather than searched for. Absent only for
   * run state written before the field existed, or for a worktree no run
   * state claims.
   */
  specsDir?: string | undefined;
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

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class Found {
  readonly sliceDirs: string[] = [];
  readonly files: string[] = [];
  private readonly notes: string[] = [];

  constructor(private readonly worktreeDir: string) {}

  consider(dir: string): void {
    const found = ownershipEvidence(dir);
    if (!found) return;
    this.sliceDirs.push(dir);
    this.files.push(found.file);
    this.notes.push(
      `${relative(this.worktreeDir, found.file).replace(/\\/g, "/")} (${found.note})`,
    );
  }

  probe(): AdjudicationEstateProbe {
    if (this.files.length === 0) return { status: "absent" };
    return {
      status: "present",
      estate: {
        worktreeDir: this.worktreeDir,
        sliceDirs: this.sliceDirs,
        files: this.files,
        evidence: this.notes.join(", "),
      },
    };
  }
}

/**
 * The resolved probe: the run's own `specsDir` says where slice directories
 * live, so exactly one directory is enumerated and depth is not a variable.
 *
 * A `specsDir` that does not resolve inside the worktree is refused rather
 * than silently ignored: a run state naming an absolute or escaping path is
 * a fact about the run nobody here may reinterpret.
 */
function resolvedProbe(
  worktreeDir: string,
  specsDir: string,
): AdjudicationEstateProbe {
  const rel = specsDir.trim().replace(/\\/g, "/");
  if (rel === "" || isAbsolute(rel) || /^[a-z]:/i.test(rel)) {
    return {
      status: "indeterminate",
      reason:
        `the run's recorded specs directory "${specsDir}" is not a ` +
        `repo-relative path, so the slice directories inside ${worktreeDir} ` +
        `cannot be resolved`,
    };
  }
  if (rel.split("/").some((segment) => segment === "..")) {
    return {
      status: "indeterminate",
      reason:
        `the run's recorded specs directory "${specsDir}" escapes the ` +
        `worktree, so the slice directories inside ${worktreeDir} cannot be ` +
        `resolved`,
    };
  }

  const found = new Found(worktreeDir);
  const specsRoot = join(worktreeDir, rel);
  const slicesRoot = join(specsRoot, "slices");

  /**
   * Absence is *proved* only by a path that is not there. A path that is
   * there but is not a directory, or cannot be inspected, is the probe
   * failing — and the two are told apart by asking, not by reading an errno:
   * Windows reports ENOENT for `readdir` under a plain file, so the errno
   * alone would turn "the run's specs dir is a file" into proved absence.
   */
  const directoryState = (
    path: string,
  ): "missing" | "directory" | { indeterminate: string } => {
    if (!existsSync(path)) return "missing";
    try {
      return statSync(path).isDirectory()
        ? "directory"
        : {
            indeterminate:
              `${path} exists but is not a directory, so the slice ` +
              `directories the run recorded cannot be enumerated`,
          };
    } catch (error) {
      return {
        indeterminate: `${path} could not be inspected — ${describe(error)}`,
      };
    }
  };

  const specsState = directoryState(specsRoot);
  if (typeof specsState !== "string") {
    return { status: "indeterminate", reason: specsState.indeterminate };
  }
  // A specs directory that is not in this worktree is proved absence: git
  // checked the tree out from a commit, so there are no slice artifacts.
  if (specsState === "missing") return found.probe();

  // Estate files have been written directly into a specs directory by
  // hand before now, so the specs dir itself is considered too.
  found.consider(specsRoot);

  const slicesState = directoryState(slicesRoot);
  if (typeof slicesState !== "string") {
    return { status: "indeterminate", reason: slicesState.indeterminate };
  }
  if (slicesState === "missing") return found.probe();

  let entries;
  try {
    entries = readdirSync(slicesRoot, { withFileTypes: true });
  } catch (error) {
    return {
      status: "indeterminate",
      reason:
        `the slice directories under ${slicesRoot} could not be ` +
        `enumerated — ${describe(error)}`,
    };
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    found.consider(join(slicesRoot, entry.name));
  }
  return found.probe();
}

/**
 * The fallback probe, for a worktree whose run never recorded a `specsDir`.
 *
 * Walks the entire worktree minus `SKIP_DIRS` — the whole tree, because a
 * bounded walk is what made the fourth round's fix report absence it had
 * not established. Symlinked and junctioned directories are not descended:
 * a reparse point can point anywhere, including back at an ancestor, and a
 * slice's own estate is always a real directory in the checkout.
 */
function fallbackProbe(worktreeDir: string): AdjudicationEstateProbe {
  const found = new Found(worktreeDir);
  let indeterminate: string | null = null;

  const walk = (dir: string, depth: number): void => {
    if (indeterminate !== null) return;
    found.consider(dir);

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      indeterminate =
        `${dir} could not be enumerated — ${describe(error)}; whether it ` +
        `holds an adjudication estate cannot be established`;
      return;
    }
    const subdirs = entries.filter(
      (entry) => entry.isDirectory() && !SKIP_DIRS.has(entry.name),
    );
    if (subdirs.length > 0 && depth >= MAX_DEPTH) {
      indeterminate =
        `the worktree walk hit its ${MAX_DEPTH}-level safety bound at ` +
        `${dir}, which still has subdirectories; the probe is incomplete`;
      return;
    }
    for (const entry of subdirs) {
      if (indeterminate !== null) return;
      walk(join(dir, entry.name), depth + 1);
    }
  };

  walk(worktreeDir, 0);
  if (indeterminate !== null) return { status: "indeterminate", reason: indeterminate };
  return found.probe();
}

/**
 * The disk fact. `absent` is returned only when the probe completed.
 *
 * A missing `worktreeDir` is proved absence — nothing is there to hold an
 * estate. A `worktreeDir` that exists but cannot be stat'd or read is
 * `indeterminate`, not absence.
 */
export function probeAdjudicationEstate(
  worktreeDir: string,
  options: AdjudicationEstateProbeOptions = {},
): AdjudicationEstateProbe {
  if (!existsSync(worktreeDir)) return { status: "absent" };
  try {
    if (!statSync(worktreeDir).isDirectory()) return { status: "absent" };
  } catch (error) {
    return {
      status: "indeterminate",
      reason:
        `${worktreeDir} exists but could not be inspected — ` +
        `${describe(error)}`,
    };
  }
  const specsDir = options.specsDir;
  if (specsDir === undefined || specsDir.trim() === "") {
    return fallbackProbe(worktreeDir);
  }

  const resolved = resolvedProbe(worktreeDir, specsDir);
  // `present` and `indeterminate` are both answers, and both stand: the
  // estate is there, or the place the run said to look could not be read.
  if (resolved.status !== "absent") return resolved;

  // `absent` from the resolved probe is NOT. It proves only that the
  // *recorded* location holds no estate, and the record can be wrong — a
  // relaunch with a different `--prd-dir` overwrites `specsDir` for the same
  // PRD slug, and a hand-edited state file can say anything. Trusting it
  // would be inferring absence from an input rather than proving it, which
  // is the exact mistake this probe was rewritten to stop making (ADR 0055
  // Seam 2 §8; found by the fifth round's own self-probe pass, not by a
  // gate). So the claim has to be earned by the complete walk. The resolved
  // path is still worth having: it answers `present` without walking at all,
  // which is the case where being wrong destroys something.
  return fallbackProbe(worktreeDir);
}

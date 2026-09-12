/**
 * The `suppressions` gate: a cleaner may not silence a gate to make it green.
 *
 * Declared through the in-process `GateDeclaration.run` seam and modelled on
 * `src/skip-gate.ts` (#195, #87 B-10), because the verdict is derived from file
 * *content* and `classifyExecution` can only read an exit code. Nothing spawns
 * a tool here — the comparison is textual, on two trees.
 *
 * Two properties do the work, and they are the skip gate's two:
 *
 * - **Only an increase fails.** The same detector counts on the round's input
 *   tree and on its output tree, so a pragma that was already there is not this
 *   round's finding. A gate that failed on pre-existing occurrences would fire
 *   on the first cleaner round of every repository that has one legacy
 *   `@ts-expect-error`, and would be turned off.
 * - **It reports the occurrence, not a number.** Findings are exact
 *   `{ path, line, detectorId }` triples, because the remedy is to remove *that*
 *   pragma and satisfy the gate it silenced — a finding names its remedy
 *   (ADR 0048).
 *
 * Unlike the skip gate it does **not** fail closed on a changed file no
 * detector covers. A suppression is a pragma in a language the detectors know;
 * a file outside their globs (a fixture, a markdown table, a lockfile) is not a
 * file that can hold one, and refusing the tree over it would make the cleaner
 * stage unusable on any repository with mixed content. And unlike the skip gate
 * it counts over *raw* content: a suppression **is** a comment, so blanking
 * comments would read every tree as clean.
 */
import { execFileSync } from "node:child_process";
import {
  matchesGlob,
  type GatePolicySuppressionDetector,
} from "./gate-policy.js";
import type { GateDeclaration, GateFindings, GateRunOutcome } from "./gate-runner.js";
import { diffTreePaths } from "./git.js";

/** The declared gate id, so callers and assertions share one spelling. */
export const SUPPRESSION_GATE_ID = "suppressions";

/** The stage every content-derived gate reports under (`prd.md` D2-D4). */
export const SUPPRESSION_GATE_STAGE = "deterministic";

export interface SuppressionGateInput {
  /**
   * The repository the two trees live in. Trees, not a worktree probe: the
   * checkpoints are what the round's evidence cites, so they are what the
   * comparison has to be about (`prd.md` D4) — the same rule the file-scope
   * gate's `role` source follows.
   */
  cwd: string;
  inputCheckpointTree: string;
  outputCheckpointTree: string;
  /** `gatePolicy.clean.suppressionDetectors`, resolved by the policy reader. */
  detectors: readonly GatePolicySuppressionDetector[];
}

type Occurrence = NonNullable<GateFindings["suppressions"]>[number];

function matchesAny(globs: readonly string[], path: string): boolean {
  return globs.some((glob) => matchesGlob(glob, path));
}

/**
 * One blob's content at one tree, or `undefined` when the path is absent from
 * it. `git cat-file` refuses rather than inventing, and an added file simply has
 * no occurrences on the input side.
 */
function readAtTree(
  cwd: string,
  tree: string,
  path: string,
): string | undefined {
  try {
    return execFileSync("git", ["cat-file", "-p", `${tree}:${path}`], {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return undefined;
  }
}

/**
 * Every occurrence of every pattern of every detector whose globs cover the
 * path, with the 1-based line each sits on. Counted per line rather than by a
 * global `match` so the finding can name the line, which is what makes it
 * actionable.
 */
function occurrencesIn(
  detectors: readonly GatePolicySuppressionDetector[],
  path: string,
  content: string,
): Occurrence[] {
  const lines = content.split(/\r?\n/);
  const found: Occurrence[] = [];
  for (const detector of detectors) {
    if (!matchesAny(detector.globs, path)) continue;
    for (const pattern of detector.patterns) {
      lines.forEach((line, index) => {
        const matches = line.match(new RegExp(pattern, "g"))?.length ?? 0;
        for (let repeat = 0; repeat < matches; repeat++) {
          found.push({ path, line: index + 1, detectorId: detector.id });
        }
      });
    }
  }
  return found;
}

/** How many occurrences one detector accounts for in a list. */
function countFor(occurrences: readonly Occurrence[], detectorId: string): number {
  return occurrences.filter((entry) => entry.detectorId === detectorId).length;
}

/**
 * Run the comparison. Exported for direct unit coverage; the pipeline reaches
 * it through {@link suppressionGateDeclaration}.
 */
export function runSuppressionGate(
  input: SuppressionGateInput,
): GateRunOutcome {
  if (input.detectors.length === 0) {
    return {
      status: "FAIL",
      failureKind: "CONFIGURATION",
      detail:
        `No suppression detector is declared, so this tree's files were never ` +
        `read. Declare gatePolicy.clean.suppressionDetectors with the pragmas ` +
        `your toolchain honours.`,
    };
  }

  // Only the paths that differ can hold a new suppression, and diffing the two
  // trees is also what keeps this gate cheap on a large repository.
  const changed = diffTreePaths(
    input.cwd,
    input.inputCheckpointTree,
    input.outputCheckpointTree,
  );
  const covered = changed.filter((path) =>
    input.detectors.some((detector) => matchesAny(detector.globs, path)),
  );

  const added: Occurrence[] = [];
  for (const path of covered) {
    const before = readAtTree(input.cwd, input.inputCheckpointTree, path);
    const after = readAtTree(input.cwd, input.outputCheckpointTree, path);
    // A deleted file cannot have gained a suppression.
    if (after === undefined) continue;
    const outputOccurrences = occurrencesIn(input.detectors, path, after);
    const inputOccurrences =
      before === undefined
        ? []
        : occurrencesIn(input.detectors, path, before);
    for (const detector of input.detectors) {
      const increase =
        countFor(outputOccurrences, detector.id) -
        countFor(inputOccurrences, detector.id);
      if (increase <= 0) continue;
      // The last `increase` occurrences of that detector in the output are the
      // ones with no counterpart on the input side. Reporting a concrete line
      // matters more than reporting the *right* one when a file both added and
      // moved a pragma: every line named holds a real suppression.
      added.push(
        ...outputOccurrences
          .filter((entry) => entry.detectorId === detector.id)
          .slice(-increase),
      );
    }
  }

  if (added.length === 0) {
    return {
      status: "PASS",
      failureKind: null,
      detail:
        `No detector counts more suppressions on this checkpoint than on ` +
        `${input.inputCheckpointTree} (${input.detectors.length} detector(s) ` +
        `over ${covered.length} of ${changed.length} changed path(s)).`,
    };
  }
  const sorted = [...added].sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.line - right.line ||
      left.detectorId.localeCompare(right.detectorId),
  );
  return {
    status: "FAIL",
    failureKind: "COMMAND",
    // Each occurrence named exactly, because this text is what the next round
    // reads out of the gate log.
    detail:
      `This checkpoint adds ${sorted.length} suppression(s) that ` +
      `${input.inputCheckpointTree} does not have: ` +
      `${sorted
        .slice(0, 20)
        .map((entry) => `${entry.path}:${entry.line} (${entry.detectorId})`)
        .join("; ")}. Remove the pragma and satisfy the gate it silenced.`,
    findings: { suppressions: sorted },
  };
}

/**
 * The declaration. Required and in-process: no toolchain, no working directory,
 * and therefore nothing that can make it skippable — a check on whether the
 * gates were silenced must not itself depend on a gate running.
 */
export function suppressionGateDeclaration(
  input: SuppressionGateInput,
): GateDeclaration {
  return {
    id: SUPPRESSION_GATE_ID,
    stage: SUPPRESSION_GATE_STAGE,
    required: true,
    // The counting lives inside the closure, so the trees compared are the
    // trees that exist at gate time.
    run: () => runSuppressionGate(input),
  };
}
